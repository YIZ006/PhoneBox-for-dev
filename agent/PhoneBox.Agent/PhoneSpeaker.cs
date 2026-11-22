using System.Collections.Concurrent;
using System.Net.WebSockets;
using System.Runtime.InteropServices;
using System.Threading.Channels;

namespace PhoneBox.Agent;

#if WINDOWS
using NAudio.CoreAudioApi;
using NAudio.Wave;

/// <summary>
/// Captures Windows PC playback audio via WASAPI Loopback (e.g. Antigravity Voice / system speaker)
/// and streams 24 kHz 16-bit mono PCM frames to connected phones over WebSocket (/api/speaker/ws).
/// Automatically routes Windows output to a silent virtual/digital sink while streaming so the PC's
/// physical speakers stay silent, and restores the original speakers as soon as the phone stops listening.
/// </summary>
public sealed class PhoneSpeaker(AudioControl audio, ILogger<PhoneSpeaker> log) : IDisposable
{
    public const int TargetSampleRate = 24000;
    private const int ChunkSamples = 480; // 20 ms at 24 kHz = 960 bytes

    private readonly object _gate = new();
    private readonly ConcurrentDictionary<Guid, Channel<byte[]>> _clients = new();
    private WasapiLoopbackCapture? _capture;
    private string _deviceName = "";
    private string? _savedDefaultDeviceId;
    private volatile bool _active;
    private volatile int _level;
    private volatile bool _pcSilenced;
    private volatile int _streamVolume = 85;
    private volatile bool _streamMuted;
    private float _smoothedGain = 0.77f;

    public bool Active => _active;
    public AudioSnapshot StreamAudioSnapshot() => new(_streamVolume, _streamMuted);
    public bool SetStreamVolume(int level)
    {
        _streamVolume = Math.Clamp(level, 0, 100);
        if (_streamVolume > 0) _streamMuted = false;
        return true;
    }
    public bool StepStreamVolume(int delta) => SetStreamVolume(_streamVolume + delta);
    public bool ToggleStreamMute() { _streamMuted = !_streamMuted; return true; }

    // Resampler & chunk accumulator state (only touched on WASAPI capture thread)
    private double _srcPos;
    private float _prevSample;
    private readonly byte[] _chunkBuf = new byte[ChunkSamples * 2];
    private int _chunkOffset;

    public object Status() => new
    {
        supported = true,
        active = _active,
        pcSilenced = _pcSilenced,
        clients = _clients.Count,
        level = _active ? _level : 0,
        sampleRate = TargetSampleRate,
        deviceName = string.IsNullOrEmpty(_deviceName) ? ResolveDeviceName() : _deviceName,
    };

    private static bool IsMicCable(string name) =>
        name.Contains("CABLE Input", StringComparison.OrdinalIgnoreCase)
        || name.Contains("CABLE In ", StringComparison.OrdinalIgnoreCase)
        || name.Contains("VB-Audio", StringComparison.OrdinalIgnoreCase);

    private static bool IsSilentSink(string name) =>
        !IsMicCable(name) && (
            name.Contains("Virtual Speaker", StringComparison.OrdinalIgnoreCase)
            || name.Contains("AudioRelay", StringComparison.OrdinalIgnoreCase)
            || name.Contains("Digital Output", StringComparison.OrdinalIgnoreCase)
            || name.Contains("S/PDIF", StringComparison.OrdinalIgnoreCase)
            || name.Contains("SPDIF", StringComparison.OrdinalIgnoreCase)
        );

    private static int SilentSinkPriority(string name)
    {
        if (name.Contains("Virtual Speaker", StringComparison.OrdinalIgnoreCase)
            || name.Contains("AudioRelay", StringComparison.OrdinalIgnoreCase)) return 0;
        if (name.Contains("Digital Output", StringComparison.OrdinalIgnoreCase)
            || name.Contains("S/PDIF", StringComparison.OrdinalIgnoreCase)
            || name.Contains("SPDIF", StringComparison.OrdinalIgnoreCase)) return 1;
        return 2;
    }

    private static bool SetDefaultPlaybackEndpoint(string deviceId)
    {
        try
        {
            var policy = (IPolicyConfig)new PolicyConfig();
            try
            {
                // Role 0=Console, 1=Multimedia, 2=Communications
                foreach (var role in new[] { 0, 1, 2 })
                    Marshal.ThrowExceptionForHR(policy.SetDefaultEndpoint(deviceId, role));
                return true;
            }
            finally { Marshal.ReleaseComObject(policy); }
        }
        catch { return false; }
    }

    [ComImport, Guid("870af99c-171d-4f9e-af0d-e63df40c2bc9")]
    private class PolicyConfig;

    [ComImport, Guid("f8679f50-850a-41cf-9c72-430f290290c8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPolicyConfig
    {
        void GetMixFormat(); void GetDeviceFormat(); void ResetDeviceFormat(); void SetDeviceFormat();
        void GetProcessingPeriod(); void SetProcessingPeriod(); void GetShareMode(); void SetShareMode();
        void GetPropertyValue(); void SetPropertyValue();
        [PreserveSig] int SetDefaultEndpoint([MarshalAs(UnmanagedType.LPWStr)] string id, int role);
    }

    private static string ResolveDeviceName()
    {
        try
        {
            using var dev = PickRenderDevice();
            return dev?.FriendlyName ?? "Default Speaker";
        }
        catch { return "Default Speaker"; }
    }

    private static MMDevice? PickRenderDevice()
    {
        using var enumerator = new MMDeviceEnumerator();
        try
        {
            var def = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
            var name = def.FriendlyName ?? "";
            // Never loop back VB-Cable Input (that carries the phone's own microphone!)
            if (!name.Contains("CABLE Input", StringComparison.OrdinalIgnoreCase)
                && !name.Contains("VB-Audio", StringComparison.OrdinalIgnoreCase))
            {
                return def;
            }
            def.Dispose();
        }
        catch { }

        foreach (var d in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            var name = d.FriendlyName ?? "";
            if (!name.Contains("CABLE Input", StringComparison.OrdinalIgnoreCase)
                && !name.Contains("VB-Audio", StringComparison.OrdinalIgnoreCase))
            {
                return d;
            }
            d.Dispose();
        }
        return enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);
    }

    private MMDevice PickAndRouteRenderDeviceLocked()
    {
        using var enumerator = new MMDeviceEnumerator();
        MMDevice? currentDef = null;
        try { currentDef = enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia); } catch { }

        // Find a silent virtual/digital sink so PC physical speakers go silent while phone plays audio!
        var candidates = new List<(int prio, MMDevice dev)>();
        foreach (var d in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
        {
            var name = d.FriendlyName ?? "";
            if (IsSilentSink(name))
                candidates.Add((SilentSinkPriority(name), d));
            else
                d.Dispose();
        }
        candidates.Sort((a, b) => a.prio.CompareTo(b.prio));

        if (candidates.Count > 0)
        {
            var chosen = candidates[0].dev;
            for (int i = 1; i < candidates.Count; i++) candidates[i].dev.Dispose();

            if (currentDef is not null && currentDef.ID != chosen.ID)
            {
                try
                {
                    if (chosen.AudioEndpointVolume.Mute) chosen.AudioEndpointVolume.Mute = false;
                    if (chosen.AudioEndpointVolume.MasterVolumeLevelScalar < 0.8f)
                        chosen.AudioEndpointVolume.MasterVolumeLevelScalar = 1.0f;
                }
                catch { }
                if (SetDefaultPlaybackEndpoint(chosen.ID))
                {
                    _savedDefaultDeviceId = currentDef.ID;
                    _pcSilenced = true;
                    audio.Invalidate();
                    log.LogInformation("PhoneSpeaker: routed Windows audio to silent sink '{Sink}' (saved '{Prev}')",
                        chosen.FriendlyName, currentDef.FriendlyName);
                    Thread.Sleep(150);
                }
            }
            else if (currentDef is not null && currentDef.ID == chosen.ID)
            {
                _pcSilenced = true;
            }
            currentDef?.Dispose();
            return chosen;
        }

        // No silent virtual/digital sink available — capture current non-VB-Cable default
        if (currentDef is not null && !IsMicCable(currentDef.FriendlyName ?? ""))
            return currentDef;
        currentDef?.Dispose();
        return PickRenderDevice() ?? throw new InvalidOperationException("No playback audio device found");
    }

    private void RestoreDefaultSpeakerLocked()
    {
        var prev = _savedDefaultDeviceId;
        _savedDefaultDeviceId = null;
        _pcSilenced = false;
        if (string.IsNullOrEmpty(prev)) return;
        if (SetDefaultPlaybackEndpoint(prev))
        {
            audio.Invalidate();
            log.LogInformation("PhoneSpeaker: restored Windows default audio device");
        }
    }

    private void EnsureCaptureStartedLocked()
    {
        if (_capture is not null) return;
        var dev = PickAndRouteRenderDeviceLocked();
        _deviceName = dev.FriendlyName ?? "Speaker";
        var cap = new WasapiLoopbackCapture(dev);
        _srcPos = 0;
        _prevSample = 0;
        _chunkOffset = 0;

        var fmt = cap.WaveFormat;
        int srcRate = Math.Max(8000, fmt.SampleRate);
        int channels = Math.Max(1, fmt.Channels);
        bool isFloat = fmt.Encoding == WaveFormatEncoding.IeeeFloat || (fmt.Encoding == WaveFormatEncoding.Extensible && fmt.BitsPerSample == 32);
        int bytesPerSample = fmt.BitsPerSample / 8;
        int blockAlign = Math.Max(1, channels * bytesPerSample);
        double step = (double)srcRate / TargetSampleRate;

        cap.DataAvailable += (_, e) =>
        {
            if (e.BytesRecorded <= 0 || _clients.IsEmpty) return;
            int frames = e.BytesRecorded / blockAlign;
            if (frames <= 0) return;

            var mono = new float[frames];
            double sumSq = 0;
            for (int f = 0; f < frames; f++)
            {
                int baseIdx = f * blockAlign;
                float sum = 0;
                int mixCh = Math.Min(channels, 2);
                for (int c = 0; c < mixCh; c++)
                {
                    int off = baseIdx + c * bytesPerSample;
                    float sample = isFloat && bytesPerSample == 4
                        ? BitConverter.ToSingle(e.Buffer, off)
                        : bytesPerSample == 2
                            ? BitConverter.ToInt16(e.Buffer, off) / 32768f
                            : 0f;
                    sum += sample;
                }
                float m = sum / mixCh;
                mono[f] = m;
                sumSq += (double)m * m;
            }

            var rms = Math.Sqrt(sumSq / frames);
            _level = Math.Clamp((int)Math.Round(rms * 260.0), 0, 100);

            // Resample mono[0..frames-1] to 24 kHz PCM16 with smooth software volume gain
            float targetGain = _streamMuted ? 0f : MathF.Pow(_streamVolume / 100f, 1.55f);
            double pos = _srcPos;
            while (pos < frames)
            {
                int i0 = (int)Math.Floor(pos);
                double frac = pos - i0;
                float s0 = i0 < 0 ? _prevSample : mono[i0];
                float s1 = (i0 + 1) < frames ? mono[i0 + 1] : mono[frames - 1];
                _smoothedGain += (targetGain - _smoothedGain) * 0.004f;
                float val = (float)(s0 + (s1 - s0) * frac) * _smoothedGain;
                short pcm = (short)Math.Clamp((int)Math.Round(val * 32767f), short.MinValue, short.MaxValue);

                _chunkBuf[_chunkOffset++] = (byte)(pcm & 0xFF);
                _chunkBuf[_chunkOffset++] = (byte)((pcm >> 8) & 0xFF);
                if (_chunkOffset >= _chunkBuf.Length)
                {
                    var packet = new byte[_chunkBuf.Length];
                    Buffer.BlockCopy(_chunkBuf, 0, packet, 0, _chunkBuf.Length);
                    _chunkOffset = 0;
                    foreach (var ch in _clients.Values)
                        ch.Writer.TryWrite(packet);
                }
                pos += step;
            }
            _prevSample = mono[frames - 1];
            _srcPos = pos - frames;
        };

        cap.RecordingStopped += (_, args) =>
        {
            if (args.Exception is not null)
                log.LogWarning("PhoneSpeaker: loopback stopped with error: {Msg}", args.Exception.Message);
        };

        cap.StartRecording();
        _capture = cap;
        _active = true;
        log.LogInformation("PhoneSpeaker: loopback started on '{Device}' ({Rate} Hz {Ch}ch -> {OutRate} Hz mono)",
            _deviceName, srcRate, channels, TargetSampleRate);
    }

    private void StopCaptureIfIdleLocked()
    {
        if (!_clients.IsEmpty) return;
        _active = false;
        _level = 0;
        var cap = _capture;
        _capture = null;
        if (cap is not null)
        {
            try { cap.StopRecording(); } catch { }
            try { cap.Dispose(); } catch { }
            log.LogInformation("PhoneSpeaker: loopback stopped (no listeners)");
        }
        RestoreDefaultSpeakerLocked();
    }

    public async Task HandleWebSocketAsync(WebSocket ws, CancellationToken ct)
    {
        var id = Guid.NewGuid();
        var channel = Channel.CreateBounded<byte[]>(new BoundedChannelOptions(6)
        {
            FullMode = BoundedChannelFullMode.DropOldest,
            SingleReader = true,
            SingleWriter = false,
        });

        _clients[id] = channel;
        lock (_gate)
        {
            try { EnsureCaptureStartedLocked(); }
            catch (Exception ex)
            {
                _clients.TryRemove(id, out _);
                log.LogWarning("PhoneSpeaker: failed to start loopback: {Msg}", ex.Message);
                return;
            }
        }

        using var linked = CancellationTokenSource.CreateLinkedTokenSource(ct);
        var token = linked.Token;

        // Read task to detect client close promptly
        var readTask = Task.Run(async () =>
        {
            var rx = new byte[256];
            try
            {
                while (ws.State == WebSocketState.Open && !token.IsCancellationRequested)
                {
                    var res = await ws.ReceiveAsync(rx, token);
                    if (res.MessageType == WebSocketMessageType.Close) break;
                }
            }
            catch { }
            finally { try { linked.Cancel(); } catch { } }
        }, CancellationToken.None);

        try
        {
            await foreach (var packet in channel.Reader.ReadAllAsync(token))
            {
                if (ws.State != WebSocketState.Open) break;
                await ws.SendAsync(packet, WebSocketMessageType.Binary, endOfMessage: true, token);
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { }
        catch (IOException) { }
        finally
        {
            try { linked.Cancel(); } catch { }
            _clients.TryRemove(id, out _);
            channel.Writer.TryComplete();
            lock (_gate) StopCaptureIfIdleLocked();
            try { await readTask; } catch { }
        }
    }

    public void Dispose()
    {
        foreach (var ch in _clients.Values) ch.Writer.TryComplete();
        _clients.Clear();
        lock (_gate) StopCaptureIfIdleLocked();
    }
}
#else
public sealed class PhoneSpeaker(AudioControl audio, ILogger<PhoneSpeaker> log) : IDisposable
{
    public bool Active => false;
    public AudioSnapshot StreamAudioSnapshot() => new(85, false);
    public bool SetStreamVolume(int level) => false;
    public bool StepStreamVolume(int delta) => false;
    public bool ToggleStreamMute() => false;
    public object Status() => new { supported = false, active = false, clients = 0, level = 0, sampleRate = 24000, deviceName = "Windows only" };
    public Task HandleWebSocketAsync(WebSocket ws, CancellationToken ct) => Task.CompletedTask;
    public void Dispose() { }
}
#endif
