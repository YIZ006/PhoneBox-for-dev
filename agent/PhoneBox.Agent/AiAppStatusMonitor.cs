using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text.Json;

namespace PhoneBox.Agent;

/// <summary>
/// Pure-C# background monitor replacing 10-second powershell.exe polling for Antigravity and Codex status widgets.
/// Uses a single Win32 Toolhelp32 snapshot on Windows (&lt; 2 ms) to count active processes and working-set RAM.
/// </summary>
public sealed class AiAppStatusMonitor(PushStore push, ILogger<AiAppStatusMonitor> log) : BackgroundService
{
    private readonly Lock _gate = new();
    private string _lastSig = "";
    private DateTime _lastPushUtc = DateTime.MinValue;

    public void RefreshNow()
    {
        try { ScanAndPublish(force: true); }
        catch (Exception ex) { log.LogDebug("AiAppStatusMonitor refresh: {Message}", ex.Message); }
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        try { ScanAndPublish(force: true); }
        catch (Exception ex) { log.LogDebug("AiAppStatusMonitor startup: {Message}", ex.Message); }

        while (!stoppingToken.IsCancellationRequested)
        {
            try { await Task.Delay(3_000, stoppingToken); }
            catch (OperationCanceledException) { break; }

            try { ScanAndPublish(force: false); }
            catch (Exception ex) { log.LogDebug("AiAppStatusMonitor scan: {Message}", ex.Message); }
        }
    }

    private void ScanAndPublish(bool force)
    {
        lock (_gate)
        {
            var sw = Stopwatch.StartNew();
            var (agCount, agMb, ideCount, ideMb, cxCount, cxMb, cliCount, cliMb) =
                OperatingSystem.IsWindows() ? MeasureAllWindows() : MeasureAllPortable();
            sw.Stop();

            var elapsedMs = Math.Max(0.1, sw.Elapsed.TotalMilliseconds);
            var agOn = agCount > 0;
            var ideOn = ideCount > 0;
            var cxOn = cxCount > 0;
            var cliOn = cliCount > 0;

            var agText = agOn ? $"ON ({agCount}p · {agMb} MB)" : "OFF";
            var ideText = ideOn ? $"ON ({ideCount}p · {ideMb} MB)" : "OFF";
            var cxText = cxOn ? $"ON ({cxCount}p · {cxMb} MB)" : "OFF";
            var cliText = cliOn ? $"ON ({cliCount}p · {cliMb} MB)" : "OFF";

            // Quantize RAM by 4 MB unless running/count changed so idle ticks don't rewrite PushStore constantly.
            var sig = $"{agCount}:{agMb / 4}|{ideCount}:{ideMb / 4}|{cxCount}:{cxMb / 4}|{cliCount}:{cliMb / 4}";
            var now = DateTime.UtcNow;
            if (!force && sig == _lastSig && (now - _lastPushUtc) < TimeSpan.FromSeconds(15))
                return;

            _lastSig = sig;
            _lastPushUtc = now;

            SetBoolPush("antigravity_running", "Antigravity", agOn, agText);
            SetBoolPush("antigravity_ide_running", "Antigravity IDE", ideOn, ideText);
            SetBoolPush("codex_running", "Codex", cxOn, cxText);

            var speedText = $"{elapsedMs:0.0} ms";

            push.Set("ag_app_status", JsonSerializer.SerializeToElement(new
            {
                title = "Antigravity",
                items = new object[]
                {
                    new { label = "App", value = agText, level = agOn ? "ok" : "" },
                    new { label = "IDE", value = ideText, level = ideOn ? "ok" : "" },
                    new { label = "C# Native", value = speedText, level = "info" },
                }
            }), 60);

            push.Set("codex_app_status", JsonSerializer.SerializeToElement(new
            {
                title = "Codex",
                items = new object[]
                {
                    new { label = "App", value = cxText, level = cxOn ? "ok" : "" },
                    new { label = "CLI", value = cliText, level = cliOn ? "ok" : "" },
                    new { label = "C# Native", value = speedText, level = "info" },
                }
            }), 60);
        }
    }

    private void SetBoolPush(string key, string title, bool isRunning, string text)
    {
        push.Set(key, JsonSerializer.SerializeToElement(new
        {
            value = isRunning,
            title,
            text
        }), 60);
    }

    private static (int agC, long agM, int ideC, long ideM, int cxC, long cxM, int cliC, long cliM) MeasureAllPortable()
    {
        var (agC, agM) = MeasureByName("Antigravity");
        var (ideC, ideM) = MeasureByName("Antigravity IDE");
        var (cxC, cxM) = MeasureByName("ChatGPT");
        var (cliC, cliM) = MeasureByName("codex");
        return (agC, agM, ideC, ideM, cxC, cxM, cliC, cliM);
    }

    private static (int Count, long RamMb) MeasureByName(string procName)
    {
        Process[] procs = [];
        try
        {
            procs = Process.GetProcessesByName(procName);
            int count = 0;
            long bytes = 0;
            foreach (var p in procs)
            {
                try
                {
                    if (p.HasExited) continue;
                    bytes += p.WorkingSet64;
                    count++;
                }
                catch { }
            }
            return (count, (long)Math.Round(bytes / (1024.0 * 1024.0)));
        }
        catch
        {
            return (0, 0);
        }
        finally
        {
            foreach (var p in procs)
                try { p.Dispose(); } catch { }
        }
    }

    private const uint TH32CS_SNAPPROCESS = 0x00000002;
    private const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    private static readonly IntPtr INVALID_HANDLE_VALUE = new(-1);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateToolhelp32Snapshot(uint dwFlags, uint th32ProcessID);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32FirstW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool Process32NextW(IntPtr hSnapshot, ref PROCESSENTRY32W lppe);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr OpenProcess(uint dwDesiredAccess, [MarshalAs(UnmanagedType.Bool)] bool bInheritHandle, uint dwProcessId);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool CloseHandle(IntPtr hObject);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool QueryFullProcessImageNameW(IntPtr hProcess, uint dwFlags, char[] lpExeName, ref uint lpdwSize);

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool K32GetProcessMemoryInfo(IntPtr hProcess, out PROCESS_MEMORY_COUNTERS counters, uint cb);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct PROCESSENTRY32W
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public UIntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        public string szExeFile;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PROCESS_MEMORY_COUNTERS
    {
        public uint cb;
        public uint PageFaultCount;
        public nuint PeakWorkingSetSize;
        public nuint WorkingSetSize;
        public nuint QuotaPeakPagedPoolUsage;
        public nuint QuotaPagedPoolUsage;
        public nuint QuotaPeakNonPagedPoolUsage;
        public nuint QuotaNonPagedPoolUsage;
        public nuint PagefileUsage;
        public nuint PeakPagefileUsage;
    }

    private static (int agC, long agM, int ideC, long ideM, int cxC, long cxM, int cliC, long cliM) MeasureAllWindows()
    {
        int agC = 0, ideC = 0, cxC = 0, cliC = 0;
        ulong agBytes = 0, ideBytes = 0, cxBytes = 0, cliBytes = 0;

        IntPtr snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snap == IntPtr.Zero || snap == INVALID_HANDLE_VALUE)
            return MeasureAllPortable();

        try
        {
            var entry = new PROCESSENTRY32W { dwSize = (uint)Marshal.SizeOf<PROCESSENTRY32W>() };
            if (!Process32FirstW(snap, ref entry))
                return MeasureAllPortable();

            var pathBuf = new char[512];
            uint memSize = (uint)Marshal.SizeOf<PROCESS_MEMORY_COUNTERS>();

            do
            {
                string? exe = entry.szExeFile;
                if (string.IsNullOrEmpty(exe)) continue;

                int kind =
                    exe.Equals("Antigravity.exe", StringComparison.OrdinalIgnoreCase) ? 1 :
                    exe.Equals("Antigravity IDE.exe", StringComparison.OrdinalIgnoreCase) ? 2 :
                    exe.Equals("ChatGPT.exe", StringComparison.OrdinalIgnoreCase) ? 3 :
                    exe.Equals("codex.exe", StringComparison.OrdinalIgnoreCase) ? 4 : 0;

                if (kind == 0) continue;

                IntPtr hProc = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, entry.th32ProcessID);
                if (hProc == IntPtr.Zero) continue;
                try
                {
                    if (kind == 3)
                    {
                        uint len = (uint)pathBuf.Length;
                        if (QueryFullProcessImageNameW(hProc, 0, pathBuf, ref len) && len > 0)
                        {
                            var fullPath = new string(pathBuf, 0, (int)len);
                            if (!fullPath.Contains("OpenAI.Codex", StringComparison.OrdinalIgnoreCase))
                                continue;
                        }
                    }

                    ulong ws = 0;
                    if (K32GetProcessMemoryInfo(hProc, out var pmc, memSize))
                        ws = (ulong)pmc.WorkingSetSize;

                    switch (kind)
                    {
                        case 1: agC++; agBytes += ws; break;
                        case 2: ideC++; ideBytes += ws; break;
                        case 3: cxC++; cxBytes += ws; break;
                        case 4: cliC++; cliBytes += ws; break;
                    }
                }
                finally
                {
                    CloseHandle(hProc);
                }
            }
            while (Process32NextW(snap, ref entry));
        }
        finally
        {
            CloseHandle(snap);
        }

        const double mbDiv = 1024.0 * 1024.0;
        return (
            agC, (long)Math.Round(agBytes / mbDiv),
            ideC, (long)Math.Round(ideBytes / mbDiv),
            cxC, (long)Math.Round(cxBytes / mbDiv),
            cliC, (long)Math.Round(cliBytes / mbDiv)
        );
    }
}
