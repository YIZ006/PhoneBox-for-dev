using System.Net.WebSockets;
using System.Runtime.InteropServices;

namespace PhoneBox.Agent;

#if WINDOWS
#pragma warning disable CS0618 // WasapiOut works cleanly with BufferedWaveProvider on Windows 10/11
using NAudio.CoreAudioApi;
using NAudio.Wave;

/// <summary>
/// Receives live 48 kHz 16-bit mono PCM audio frames from the phone over WebSocket (/api/mic/ws)
/// and plays them into a Windows audio render device (ideally VB-Audio Virtual Cable "CABLE Input",
/// which Windows exposes as the "CABLE Output" microphone to Discord, Zoom, OBS and games).
/// </summary>
public sealed class PhoneMic(ILogger<PhoneMic> log) : IDisposable
{
    public sealed record AudioDevice(string Id, string Name, bool IsVirtual);

    private readonly object _gate = new();
    private WasapiOut? _out;
    private BufferedWaveProvider? _buffer;
    private VolumeWaveProvider16? _vol;
    private string? _selectedDeviceId;
    private string? _activeDeviceName;
    private float _gain = 1.0f;
    private volatile bool _active;
    private volatile int _level;
    private CancellationTokenSource? _activeSession;

    public object Status()
    {
        var devices = ListDevices();
        var chosen = ResolveDevice(devices);
        return new
        {
            supported = true,
            active = _active,
            level = _active ? _level : 0,
            gain = Math.Round(_gain, 2),
            deviceId = _selectedDeviceId ?? chosen?.Id ?? "",
            deviceName = _activeDeviceName ?? chosen?.Name ?? "No output device",
            hasVirtualCable = devices.Any(d => d.IsVirtual),
            devices,
        };
    }

    public List<AudioDevice> ListDevices()
    {
        var list = new List<AudioDevice>();
        try
        {
            using var enumerator = new MMDeviceEnumerator();
            foreach (var d in enumerator.EnumerateAudioEndPoints(DataFlow.Render, DeviceState.Active))
            {
                using (d)
                {
                    var name = d.FriendlyName ?? d.ID;
                    var isVirtual = name.Contains("CABLE Input", StringComparison.OrdinalIgnoreCase)
                        || name.Contains("VB-Audio", StringComparison.OrdinalIgnoreCase)
                        || name.Contains("VoiceMeeter", StringComparison.OrdinalIgnoreCase)
                        || name.Contains("Virtual", StringComparison.OrdinalIgnoreCase);
                    list.Add(new AudioDevice(d.ID, name, isVirtual));
                }
            }
        }
        catch (Exception ex)
        {
            log.LogWarning("PhoneMic: failed to list devices: {Msg}", ex.Message);
        }
        // Put VB-Cable first, then other virtual cables, then regular speakers
        return list
            .OrderByDescending(d => d.Name.Contains("CABLE Input", StringComparison.OrdinalIgnoreCase))
            .ThenByDescending(d => d.IsVirtual)
            .ThenBy(d => d.Name, StringComparer.OrdinalIgnoreCase)
            .ToList();
    }

    public void Configure(string? deviceId, float? gain)
    {
        bool deviceChanged = false;
        lock (_gate)
        {
            if (gain is { } g && float.IsFinite(g))
            {
                _gain = Math.Clamp(g, 0f, 3.0f);
                if (_vol is not null) _vol.Volume = _gain;
            }
            if (deviceId is not null)
            {
                var norm = string.IsNullOrWhiteSpace(deviceId) ? null : deviceId.Trim();
                if (!string.Equals(_selectedDeviceId, norm, StringComparison.Ordinal))
                {
                    _selectedDeviceId = norm;
                    deviceChanged = true;
                }
            }
            if (deviceChanged && _active)
            {
                try { ReopenPlaybackLocked(); }
                catch (Exception ex) { log.LogWarning("PhoneMic: switch device failed: {Msg}", ex.Message); }
            }
        }
    }

    private AudioDevice? ResolveDevice(List<AudioDevice> devices)
    {
        if (!string.IsNullOrEmpty(_selectedDeviceId))
        {
            var exact = devices.FirstOrDefault(d => d.Id == _selectedDeviceId);
            if (exact is not null) return exact;
        }
        return devices.FirstOrDefault(d => d.Name.Contains("CABLE Input", StringComparison.OrdinalIgnoreCase))
            ?? devices.FirstOrDefault(d => d.IsVirtual)
            ?? devices.FirstOrDefault();
    }

    private void ReopenPlaybackLocked()
    {
        StopPlaybackLocked();
        using var enumerator = new MMDeviceEnumerator();
        MMDevice? target = null;
        if (!string.IsNullOrEmpty(_selectedDeviceId))
        {
            try { target = enumerator.GetDevice(_selectedDeviceId); }
            catch { target = null; }
        }
        if (target is null)
        {
            var devices = ListDevices();
            var pick = ResolveDevice(devices);
            if (pick is not null)
            {
                try { target = enumerator.GetDevice(pick.Id); }
                catch { target = null; }
            }
        }
        target ??= enumerator.GetDefaultAudioEndpoint(DataFlow.Render, Role.Multimedia);

        var fmt = new WaveFormat(48000, 16, 1);
        var buf = new BufferedWaveProvider(fmt)
        {
            DiscardOnBufferOverflow = true,
            ReadFully = true,
        };
        var vol = new VolumeWaveProvider16(buf) { Volume = _gain };
        var wasapi = new WasapiOut(target, AudioClientShareMode.Shared, useEventSync: true, latency: 35);
        wasapi.Init(vol);
        wasapi.Play();

        _buffer = buf;
        _vol = vol;
        _out = wasapi;
        _activeDeviceName = target.FriendlyName;
        log.LogInformation("PhoneMic: streaming to '{Device}' (48 kHz mono)", _activeDeviceName);

        if (_activeDeviceName != null && (_activeDeviceName.Contains("CABLE", StringComparison.OrdinalIgnoreCase) || _activeDeviceName.Contains("VB-Audio", StringComparison.OrdinalIgnoreCase)))
        {
            try { EnsureCableOutputDefault(); } catch { }
        }
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    private delegate int SetDefaultEndpointDelegate(IntPtr thisPtr, [MarshalAs(UnmanagedType.LPWStr)] string pszDeviceName, int role);

    public static bool EnsureCableOutputDefault()
    {
        try
        {
            using var enumerator = new MMDeviceEnumerator();
            string? cableId = null;
            foreach (var d in enumerator.EnumerateAudioEndPoints(DataFlow.Capture, DeviceState.Active))
            {
                using (d)
                {
                    var name = d.FriendlyName ?? "";
                    if (name.Contains("CABLE Output", StringComparison.OrdinalIgnoreCase) ||
                        name.Contains("VB-Audio Virtual Cable", StringComparison.OrdinalIgnoreCase))
                    {
                        cableId = d.ID;
                        break;
                    }
                }
            }

            if (cableId == null) return false;

            var t = Type.GetTypeFromCLSID(new Guid("294935CE-F637-4E7C-A41B-AB255460B862"));
            if (t == null) return false;
            var obj = Activator.CreateInstance(t);
            var pUnk = Marshal.GetIUnknownForObject(obj!);
            var g = new Guid("568b9108-44bf-40b4-9006-86afe5b5a620");
            IntPtr pIface;
            Marshal.QueryInterface(pUnk, ref g, out pIface);

            var vtable = Marshal.ReadIntPtr(pIface);
            var fn = Marshal.ReadIntPtr(vtable, 12 * IntPtr.Size);
            var setDefault = (SetDefaultEndpointDelegate)Marshal.GetDelegateForFunctionPointer(fn, typeof(SetDefaultEndpointDelegate));

            setDefault(pIface, cableId, 0 /* eConsole */);
            setDefault(pIface, cableId, 1 /* eMultimedia */);
            setDefault(pIface, cableId, 2 /* eCommunications */);

            Marshal.Release(pIface);
            Marshal.Release(pUnk);
            return true;
        }
        catch
        {
            return false;
        }
    }

    private void StopPlaybackLocked()
    {
        try { _out?.Stop(); } catch { }
        try { _out?.Dispose(); } catch { }
        _out = null;
        _buffer = null;
        _vol = null;
    }

    public async Task HandleWebSocketAsync(WebSocket ws, CancellationToken ct)
    {
        CancellationTokenSource sessionCts;
        lock (_gate)
        {
            // Only one phone mic stream at a time; supersede any stale session cleanly
            try { _activeSession?.Cancel(); } catch { }
            sessionCts = CancellationTokenSource.CreateLinkedTokenSource(ct);
            _activeSession = sessionCts;
            ReopenPlaybackLocked();
            _active = true;
            _level = 0;
        }

        var token = sessionCts.Token;
        var rx = new byte[16384];
        try
        {
            while (ws.State == WebSocketState.Open && !token.IsCancellationRequested)
            {
                int total = 0;
                WebSocketReceiveResult? res = null;
                do
                {
                    if (total >= rx.Length) break;
                    res = await ws.ReceiveAsync(new ArraySegment<byte>(rx, total, rx.Length - total), token);
                    if (res.MessageType == WebSocketMessageType.Close) return;
                    total += res.Count;
                } while (!res.EndOfMessage);

                if (res is null || res.MessageType != WebSocketMessageType.Binary || total < 2) continue;
                int evenBytes = total & ~1; // 16-bit PCM alignment

                // Compute peak/RMS level for UI
                double sumSq = 0;
                int samples = evenBytes / 2;
                for (int i = 0; i < evenBytes; i += 2)
                {
                    short s = (short)(rx[i] | (rx[i + 1] << 8));
                    sumSq += (double)s * s;
                }
                var rms = Math.Sqrt(sumSq / Math.Max(1, samples)) / 32768.0;
                _level = Math.Clamp((int)Math.Round(rms * 240.0), 0, 100);

                lock (_gate)
                {
                    if (_buffer is not null)
                    {
                        // Prevent latency drift while tolerating nighttime Wi-Fi/Tailscale jitter bursts
                        if (_buffer.BufferedDuration.TotalMilliseconds > 280)
                            _buffer.ClearBuffer();
                        _buffer.AddSamples(rx, 0, evenBytes);
                    }
                }
            }
        }
        catch (OperationCanceledException) { }
        catch (WebSocketException) { }
        finally
        {
            lock (_gate)
            {
                if (ReferenceEquals(_activeSession, sessionCts))
                {
                    _active = false;
                    _level = 0;
                    StopPlaybackLocked();
                    _activeSession = null;
                    log.LogInformation("PhoneMic: stream closed");
                }
            }
            sessionCts.Dispose();
        }
    }

    public void Dispose()
    {
        lock (_gate)
        {
            try { _activeSession?.Cancel(); } catch { }
            StopPlaybackLocked();
        }
    }
}
#else
public sealed class PhoneMic(ILogger<PhoneMic> log) : IDisposable
{
    public object Status() => new { supported = false, active = false, level = 0, gain = 1.0, deviceId = "", deviceName = "Windows only", hasVirtualCable = false, devices = Array.Empty<object>() };
    public void Configure(string? deviceId, float? gain) { }
    public Task HandleWebSocketAsync(WebSocket ws, CancellationToken ct) => Task.CompletedTask;
    public void Dispose() { }
}
#endif
