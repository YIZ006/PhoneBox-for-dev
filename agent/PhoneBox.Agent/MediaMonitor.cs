using System.Buffers.Binary;
using System.Collections.Concurrent;
using System.Text.Json;
using System.Text.RegularExpressions;
using Windows.Media.Control;

namespace PhoneBox.Agent;

/// <summary>Watches and controls the current Windows media session (Spotify, browsers, ...).</summary>
public sealed partial class MediaMonitor(ILogger<MediaMonitor> log) : BackgroundService
{
    private GlobalSystemMediaTransportControlsSessionManager? _mgr;
    private volatile MediaSnapshot? _snap;
    private readonly MediaArtworkCache _art = new();
    private readonly SemaphoreSlim _pollGate = new(1, 1);
    private GlobalSystemMediaTransportControlsSession? _observed;
    private long _revision;

    // HD artwork upgrade cache for low-res browser SMTC thumbnails (e.g., 150x83 from YouTube in Chromium/CocCoc)
    private static readonly HttpClient HdHttp = new() { Timeout = TimeSpan.FromSeconds(4.5) };
    private readonly ConcurrentDictionary<string, AlbumArt?> _hdCache = new();
    private readonly ConcurrentDictionary<string, byte> _hdInFlight = new();

    static MediaMonitor()
    {
        HdHttp.DefaultRequestHeaders.TryAddWithoutValidation("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36");
        HdHttp.DefaultRequestHeaders.TryAddWithoutValidation("Accept-Language", "en-US,en;q=0.9");
    }

    [GeneratedRegex("\"videoId\":\"([a-zA-Z0-9_-]{11})\"")]
    private static partial Regex VideoIdRx();

    public AlbumArt? Art => _art.Current;
    public MediaSnapshot? Snapshot() => _snap;

    protected override async Task ExecuteAsync(CancellationToken ct)
    {
        try
        {
            while (!ct.IsCancellationRequested)
            {
                try
                {
                    if (_mgr is null)
                    {
                        _mgr = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
                        _mgr.CurrentSessionChanged += SessionChanged;
                    }
                    await Poll(ct);
                }
                catch (OperationCanceledException) when (ct.IsCancellationRequested) { break; }
                catch (Exception ex)
                {
                    log.LogDebug("media: {Msg}", ex.Message);
                    _snap = null;
                }
                await Task.Delay(1000, ct);
            }
        }
        finally
        {
            if (_mgr is not null) _mgr.CurrentSessionChanged -= SessionChanged;
            Observe(null);
            _art.Clear();
        }
    }

    private void SessionChanged(GlobalSystemMediaTransportControlsSessionManager sender, CurrentSessionChangedEventArgs args) => Interlocked.Increment(ref _revision);
    private void PropertiesChanged(GlobalSystemMediaTransportControlsSession sender, MediaPropertiesChangedEventArgs args) => Interlocked.Increment(ref _revision);
    private void Observe(GlobalSystemMediaTransportControlsSession? session)
    {
        if (ReferenceEquals(session, _observed)) return;
        if (_observed is not null) _observed.MediaPropertiesChanged -= PropertiesChanged;
        _observed = session;
        if (_observed is not null) _observed.MediaPropertiesChanged += PropertiesChanged;
    }

    private async Task Poll(CancellationToken ct = default)
    {
        await _pollGate.WaitAsync(ct);
        try { await PollCore(ct); }
        finally { _pollGate.Release(); }
    }

    private async Task PollCore(CancellationToken ct)
    {
        var s = _mgr!.GetCurrentSession();
        Observe(s);
        if (s is null) { _snap = null; _art.Clear(); return; }
        var revision = Interlocked.Read(ref _revision);

        var props = await s.TryGetMediaPropertiesAsync();
        var pb = s.GetPlaybackInfo();
        var tl = s.GetTimelineProperties();
        var playing = pb.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;

        var key = $"{s.SourceAppUserModelId}|{props.Title}|{props.Artist}";
        var title = props.Title ?? "";
        var artist = props.Artist ?? "";
        // Refresh after metadata events and while a new track's thumbnail is still settling.
        try
        {
            await _art.UpdateAsync(key, revision, (props.Thumbnail is not null || !string.IsNullOrWhiteSpace(title)) ? async token =>
            {
                if (_hdCache.TryGetValue(key, out var cachedHd) && cachedHd is not null)
                    return cachedHd;

                AlbumArt? smtcArt = null;
                if (props.Thumbnail is { } thumb)
                {
                    using var stream = await thumb.OpenReadAsync();
                    if (stream.Size <= 8 * 1024 * 1024)
                    {
                        using var ms = new MemoryStream();
                        await stream.AsStreamForRead().CopyToAsync(ms, token);
                        if (ms.Length > 0)
                            smtcArt = new AlbumArt(ms.ToArray(), string.IsNullOrEmpty(stream.ContentType) ? "image/png" : stream.ContentType);
                    }
                }

                // If SMTC gave a tiny thumbnail (e.g. 150x83 from Chromium/CocCoc) or none, fetch HD artwork in background
                bool needsHd = smtcArt is null || IsLowRes(smtcArt.Bytes);
                if (needsHd && !string.IsNullOrWhiteSpace(title) && !_hdCache.ContainsKey(key))
                    TriggerHdArtFetch(key, title, artist);

                return smtcArt;
            } : null, ct);
        }
        catch (OperationCanceledException) when (ct.IsCancellationRequested) { throw; }
        catch (Exception ex) { log.LogDebug("cover art: {Msg}", ex.Message); }

        var pos = tl.Position;
        if (playing && tl.LastUpdatedTime.Year > 2000)
            pos += DateTimeOffset.Now - tl.LastUpdatedTime;
        var dur = tl.EndTime - tl.StartTime;
        if (dur > TimeSpan.Zero && pos > dur) pos = dur;
        if (pos < TimeSpan.Zero) pos = TimeSpan.Zero;

        _snap = new MediaSnapshot(
            App: FriendlyApp(s.SourceAppUserModelId),
            Title: props.Title ?? "",
            Artist: props.Artist ?? "",
            Album: props.AlbumTitle ?? "",
            Playing: playing,
            PosMs: (long)pos.TotalMilliseconds,
            DurMs: (long)Math.Max(0, dur.TotalMilliseconds),
            ArtId: Art is null ? 0 : _art.Id,
            CanSeek: pb.Controls.IsPlaybackPositionEnabled);
    }

    public async Task<bool> Control(string action, long? ms)
    {
        var s = _mgr?.GetCurrentSession();
        if (s is null)
        {
            // No session: send the media key instead (wakes up Spotify, for example).
            if (action == "playpause") { Keys.Tap(Keys.VK_MEDIA_PLAY_PAUSE); return true; }
            return false;
        }
        var ok = action switch
        {
            "playpause" => await s.TryTogglePlayPauseAsync(),
            "next" => await s.TrySkipNextAsync(),
            "prev" => await s.TrySkipPreviousAsync(),
            "seek" when ms is { } m => await s.TryChangePlaybackPositionAsync(TimeSpan.FromMilliseconds(m).Ticks),
            _ => false,
        };
        try { await Poll(); } catch { }
        return ok;
    }

    public async Task<bool> PauseAsync()
    {
        var s = _mgr?.GetCurrentSession();
        if (s is null || s.GetPlaybackInfo().PlaybackStatus != GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing)
            return false;
        var ok = await s.TryPauseAsync();
        try { await Poll(); } catch { }
        return ok;
    }

    private static string FriendlyApp(string id)
    {
        var l = id.ToLowerInvariant();
        if (l.Contains("spotify")) return "Spotify";
        if (l.Contains("chrome")) return "Chrome";
        if (l.Contains("firefox") || l.Contains("308046b0af4a39cb")) return "Firefox";
        if (l.Contains("msedge")) return "Edge";
        if (l.Contains("zune") || l.Contains("media")) return "Media Player";
        if (l.Contains("vlc")) return "VLC";
        return Path.GetFileNameWithoutExtension(id.Split('!')[0]);
    }

    private void TriggerHdArtFetch(string key, string title, string artist)
    {
        if (!_hdInFlight.TryAdd(key, 0)) return;
        _ = Task.Run(async () =>
        {
            try
            {
                var hd = await FetchHdArtAsync(title, artist);
                if (_hdCache.Count > 50) _hdCache.Clear();
                _hdCache[key] = hd;
                if (hd is not null)
                    Interlocked.Increment(ref _revision);
            }
            catch (Exception ex)
            {
                log.LogDebug("hd cover art: {Msg}", ex.Message);
                _hdCache[key] = null;
            }
            finally
            {
                _hdInFlight.TryRemove(key, out _);
            }
        });
    }

    private static async Task<AlbumArt?> FetchHdArtAsync(string title, string artist)
    {
        var query = string.IsNullOrWhiteSpace(artist) ? title : $"{title} {artist}";
        // 1) Try YouTube HD thumbnail (1280x720 maxresdefault / hq720, zero letterboxing)
        try
        {
            var html = await HdHttp.GetStringAsync($"https://www.youtube.com/results?search_query={Uri.EscapeDataString(query)}");
            var m = VideoIdRx().Match(html);
            if (m.Success)
            {
                var vid = m.Groups[1].Value;
                foreach (var variant in new[] { "maxresdefault.jpg", "hq720.jpg", "sddefault.jpg" })
                {
                    using var resp = await HdHttp.GetAsync($"https://i.ytimg.com/vi/{vid}/{variant}");
                    if (!resp.IsSuccessStatusCode) continue;
                    var bytes = await resp.Content.ReadAsByteArrayAsync();
                    if (bytes.Length >= 8000 && !IsLowRes(bytes))
                        return new AlbumArt(bytes, "image/jpeg");
                }
            }
        }
        catch { }

        // 2) Fallback: iTunes high-res album artwork (600x600)
        try
        {
            var json = await HdHttp.GetStringAsync($"https://itunes.apple.com/search?term={Uri.EscapeDataString(query)}&entity=song&limit=1");
            using var doc = JsonDocument.Parse(json);
            if (doc.RootElement.TryGetProperty("results", out var res) && res.GetArrayLength() > 0 &&
                res[0].TryGetProperty("artworkUrl100", out var urlProp) && urlProp.GetString() is { Length: > 0 } url100)
            {
                var hdUrl = url100.Replace("100x100bb", "600x600bb");
                var bytes = await HdHttp.GetByteArrayAsync(hdUrl);
                if (bytes.Length >= 8000)
                    return new AlbumArt(bytes, "image/jpeg");
            }
        }
        catch { }

        return null;
    }

    private static bool IsLowRes(byte[] b)
    {
        if (!TryReadImageSize(b, out var w, out var h)) return b.Length < 35_000;
        return w < 300 || h < 220;
    }

    private static bool TryReadImageSize(byte[] b, out int w, out int h)
    {
        w = h = 0;
        if (b.Length < 24) return false;
        // PNG
        if (b[0] == 0x89 && b[1] == 0x50 && b[2] == 0x4E && b[3] == 0x47)
        {
            w = BinaryPrimitives.ReadInt32BigEndian(b.AsSpan(16, 4));
            h = BinaryPrimitives.ReadInt32BigEndian(b.AsSpan(20, 4));
            return w > 0 && h > 0;
        }
        // JPEG
        if (b[0] == 0xFF && b[1] == 0xD8)
        {
            int i = 2;
            while (i + 9 < b.Length)
            {
                if (b[i] != 0xFF) { i++; continue; }
                byte marker = b[i + 1];
                if (marker == 0xC0 || marker == 0xC1 || marker == 0xC2)
                {
                    h = BinaryPrimitives.ReadUInt16BigEndian(b.AsSpan(i + 5, 2));
                    w = BinaryPrimitives.ReadUInt16BigEndian(b.AsSpan(i + 7, 2));
                    return w > 0 && h > 0;
                }
                if (marker == 0xD9 || marker == 0xDA) break;
                int len = BinaryPrimitives.ReadUInt16BigEndian(b.AsSpan(i + 2, 2));
                if (len < 2) break;
                i += 2 + len;
            }
            return false;
        }
        // WebP (VP8X / VP8 / VP8L)
        if (b.Length >= 30 && b[0] == 'R' && b[1] == 'I' && b[2] == 'F' && b[3] == 'F' &&
            b[8] == 'W' && b[9] == 'E' && b[10] == 'B' && b[11] == 'P')
        {
            if (b[12] == 'V' && b[13] == 'P' && b[14] == '8' && b[15] == 'X')
            {
                w = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
                h = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
                return true;
            }
            if (b[12] == 'V' && b[13] == 'P' && b[14] == '8' && b[15] == ' ')
            {
                w = BinaryPrimitives.ReadUInt16LittleEndian(b.AsSpan(26, 2)) & 0x3FFF;
                h = BinaryPrimitives.ReadUInt16LittleEndian(b.AsSpan(28, 2)) & 0x3FFF;
                return w > 0 && h > 0;
            }
            if (b[12] == 'V' && b[13] == 'P' && b[14] == '8' && b[15] == 'L')
            {
                uint bits = BinaryPrimitives.ReadUInt32LittleEndian(b.AsSpan(21, 4));
                w = (int)(bits & 0x3FFF) + 1;
                h = (int)((bits >> 14) & 0x3FFF) + 1;
                return true;
            }
        }
        return false;
    }
}
