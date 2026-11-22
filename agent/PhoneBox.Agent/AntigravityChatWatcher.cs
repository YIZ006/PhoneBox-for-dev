using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PhoneBox.Agent;

/// <summary>
/// Watches Antigravity conversation transcripts (%USERPROFILE%\.gemini\antigravity\brain\*\.system_generated\logs\transcript.jsonl)
/// and live voice chats (%USERPROFILE%\.gemini\antigravity\voice_chats\*.json), pushing live updates to PushStore ("ag_chat")
/// and providing one-tap Antigravity Voice mode activation (Ctrl+M) from PhoneBox.
/// </summary>
public sealed partial class AntigravityChatWatcher(PushStore push, ILogger<AntigravityChatWatcher> log) : BackgroundService
{
    public sealed record ChatMessage(string Role, string Time, string Text, int Step);
    public sealed record ChatSnapshot(long UpdatedAt, string ConversationId, bool VoiceActive, List<ChatMessage> Messages, string Title = "", string ProjectName = "");

    public sealed record ConversationSummaryItem(
        string Id,
        string Title,
        string ProjectId,
        string ProjectName,
        string LastModified,
        long StepCount,
        bool IsActive
    );

    public sealed record ConversationsResult(
        string CurrentConvId,
        string CurrentTitle,
        string CurrentProject,
        bool IsAuto,
        List<string> Projects,
        List<ConversationSummaryItem> Conversations
    );

    private readonly object _gate = new();
    private ChatSnapshot _latest = new(0, "", false, []);
    private string? _selectedConvId;
    private string _lastFile = "";
    private long _lastLen = -1;
    private DateTime _lastWrite = DateTime.MinValue;
    private string _lastVoiceFile = "";
    private long _lastVoiceLen = -1;
    private DateTime _lastVoiceWrite = DateTime.MinValue;

    public ChatSnapshot Snapshot()
    {
        lock (_gate) return _latest;
    }

    public object SelectConversation(string? convId)
    {
        string? targetTitle = null;
        lock (_gate)
        {
            if (string.IsNullOrWhiteSpace(convId) || convId.Equals("auto", StringComparison.OrdinalIgnoreCase))
            {
                _selectedConvId = null;
            }
            else
            {
                _selectedConvId = convId.Trim();
            }
            _lastFile = "";
            _lastLen = -1;
            _lastVoiceFile = "";
            _lastVoiceLen = -1;
        }

        var res = ListConversations();
        if (!string.IsNullOrEmpty(_selectedConvId))
        {
            var item = res.Conversations.FirstOrDefault(c => string.Equals(c.Id, _selectedConvId, StringComparison.OrdinalIgnoreCase));
            if (item != null && !string.IsNullOrEmpty(item.Title))
            {
                targetTitle = item.Title;
                TriggerSelectConversation(targetTitle, log, item.ProjectName);
            }
        }

        var brainDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".gemini", "antigravity", "brain");
        try { ScanOnce(brainDir); } catch { }

        return res;
    }

    private static string? FindVoiceTriggerExe()
    {
        string[] searchPaths = [
            Path.Combine(AppContext.BaseDirectory, "AntigravityVoiceTrigger.exe"),
            Path.Combine(AppPaths.InstallDir, "AntigravityVoiceTrigger.exe"),
            Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), "Downloads", "AntigravityVoiceTrigger.exe"),
        ];
        return searchPaths.FirstOrDefault(File.Exists);
    }

    public static bool TriggerSelectConversation(string title, ILogger? log = null, string? projectName = null)
    {
        string? triggerExe = FindVoiceTriggerExe();
        if (triggerExe != null)
        {
            try
            {
                var psi = new ProcessStartInfo(triggerExe)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true
                };
                psi.ArgumentList.Add("select");
                psi.ArgumentList.Add(title);
                if (!string.IsNullOrWhiteSpace(projectName)) psi.ArgumentList.Add(projectName);
                using var p = Process.Start(psi);
                if (p != null)
                {
                    p.WaitForExit(5000);
                    var stdout = p.StandardOutput.ReadToEnd().Trim();
                    log?.LogInformation("AntigravityVoiceTrigger select output: {Out}", stdout);
                    return p.ExitCode == 0;
                }
            }
            catch (Exception ex)
            {
                log?.LogWarning("TriggerSelectConversation failed: {Msg}", ex.Message);
            }
        }
        return false;
    }

    public ConversationsResult ListConversations()
    {
        string currentId;
        bool isAuto;
        lock (_gate)
        {
            isAuto = string.IsNullOrEmpty(_selectedConvId);
            currentId = _selectedConvId ?? _latest.ConversationId;
        }

        var list = new List<ConversationSummaryItem>();
        var projectSet = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Tất cả", "General" };
        string curTitle = "";
        string curProj = "General";

        try
        {
            var dbPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".gemini", "antigravity", "conversation_summaries.db");

            if (File.Exists(dbPath))
            {
                var connStr = new Microsoft.Data.Sqlite.SqliteConnectionStringBuilder
                {
                    DataSource = dbPath,
                    Mode = Microsoft.Data.Sqlite.SqliteOpenMode.ReadOnly
                }.ToString();

                using var conn = new Microsoft.Data.Sqlite.SqliteConnection(connStr);
                conn.Open();

                using var cmd = conn.CreateCommand();
                cmd.CommandText = "SELECT conversation_id, title, project_id, workspace_uris, last_modified_time, step_count FROM conversation_summaries WHERE length(title) > 0 ORDER BY last_modified_time DESC LIMIT 60;";

                using var reader = cmd.ExecuteReader();
                while (reader.Read())
                {
                    string id = reader.GetString(0);
                    string title = reader.GetString(1);
                    string projectId = reader.GetString(2);
                    string wsUris = reader.IsDBNull(3) ? "" : reader.GetString(3);
                    string lastMod = reader.GetString(4);
                    long stepCount = reader.GetInt64(5);

                    string projName = "General";
                    if (!string.IsNullOrWhiteSpace(wsUris))
                    {
                        try
                        {
                            var uris = JsonSerializer.Deserialize<List<string>>(wsUris);
                            if (uris != null && uris.Count > 0)
                            {
                                string u = uris[0];
                                u = Uri.UnescapeDataString(u).TrimEnd('/', '\\');
                                var seg = Path.GetFileName(u);
                                if (!string.IsNullOrWhiteSpace(seg)) projName = seg;
                            }
                        }
                        catch { }
                    }

                    projectSet.Add(projName);
                    bool isActive = string.Equals(id, currentId, StringComparison.OrdinalIgnoreCase);
                    if (isActive)
                    {
                        curTitle = title;
                        curProj = projName;
                    }

                    list.Add(new ConversationSummaryItem(id, title, projectId, projName, lastMod, stepCount, isActive));
                }
            }
        }
        catch (Exception ex)
        {
            log.LogWarning("ListConversations failed: {Msg}", ex.Message);
        }

        if (string.IsNullOrEmpty(curTitle) && list.Count > 0)
        {
            curTitle = list[0].Title;
            curProj = list[0].ProjectName;
        }

        var projects = projectSet.ToList();
        return new ConversationsResult(currentId, curTitle, curProj, isAuto, projects, list);
    }

    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
    [DllImport("user32.dll")] private static extern IntPtr OpenWindowStation(string lpszWinSta, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll")] private static extern bool SetProcessWindowStation(IntPtr hWinSta);
    [DllImport("user32.dll")] private static extern IntPtr OpenDesktop(string lpszDesktop, uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll")] private static extern bool SetThreadDesktop(IntPtr hDesktop);
    [DllImport("user32.dll")] private static extern bool EnumDesktopWindows(IntPtr hDesktop, EnumWindowsProc lpfn, IntPtr lParam);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
    [DllImport("user32.dll")] private static extern int GetWindowText(IntPtr hWnd, StringBuilder lpString, int nMaxCount);
    [DllImport("user32.dll")] private static extern int GetClassName(IntPtr hWnd, StringBuilder lpClassName, int nMaxCount);
    [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] private static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
    [DllImport("user32.dll")] private static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] private static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
    [DllImport("kernel32.dll")] private static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] private static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, int dwExtraInfo);

    /// <summary>
    /// Activates the Antigravity desktop window and starts/stops Live Voice Chat (or falls back to Ctrl+L + Ctrl+M).
    /// </summary>
    public static bool ToggleVoiceMode(ILogger? log = null, string action = "toggle", string? convTitle = null, string? projectName = null)
    {
        try
        {
            if (OperatingSystem.IsWindows())
            {
                // Prefer AntigravityVoiceTrigger.exe which invokes the true Gemini Live Voice Mode button via UI Automation
                string? triggerExe = FindVoiceTriggerExe();
                if (triggerExe != null)
                {
                    try
                    {
                        var psi = new ProcessStartInfo(triggerExe)
                        {
                            UseShellExecute = false,
                            CreateNoWindow = true,
                            RedirectStandardOutput = true
                        };
                        psi.ArgumentList.Add(action);
                        if (!string.IsNullOrEmpty(convTitle))
                        {
                            psi.ArgumentList.Add(convTitle);
                            if (!string.IsNullOrWhiteSpace(projectName)) psi.ArgumentList.Add(projectName);
                        }
                        using var p = Process.Start(psi);
                        if (p != null)
                        {
                            p.WaitForExit(5000);
                            var stdout = p.StandardOutput.ReadToEnd().Trim();
                            log?.LogInformation("AntigravityVoiceTrigger output: {Out}", stdout);
                            if (p.ExitCode == 0) return true;
                        }
                    }
                    catch (Exception ex)
                    {
                        log?.LogWarning("AntigravityVoiceTrigger run failed: {Msg}, falling back to keyboard shortcut", ex.Message);
                    }
                }

                IntPtr hWinsta = OpenWindowStation("WinSta0", false, 0x00020000 | 0x037F);
                if (hWinsta != IntPtr.Zero) SetProcessWindowStation(hWinsta);
                IntPtr hDesk = OpenDesktop("Default", 0, false, 0x01FF);
                if (hDesk != IntPtr.Zero) SetThreadDesktop(hDesk);

                var agPids = new HashSet<int>();
                foreach (var p in Process.GetProcessesByName("Antigravity")) agPids.Add(p.Id);
                foreach (var p in Process.GetProcessesByName("Antigravity IDE")) agPids.Add(p.Id);

                IntPtr targetHwnd = IntPtr.Zero;
                if (hDesk != IntPtr.Zero)
                {
                    EnumDesktopWindows(hDesk, (hWnd, lParam) =>
                    {
                        uint pid = 0;
                        GetWindowThreadProcessId(hWnd, out pid);
                        if (agPids.Contains((int)pid))
                        {
                            var sb = new StringBuilder(256);
                            GetWindowText(hWnd, sb, 256);
                            var cls = new StringBuilder(256);
                            GetClassName(hWnd, cls, 256);
                            if (IsWindowVisible(hWnd) && cls.ToString() == "Chrome_WidgetWin_1" && sb.Length > 0)
                            {
                                targetHwnd = hWnd;
                                return false;
                            }
                        }
                        return true;
                    }, IntPtr.Zero);
                }

                if (targetHwnd != IntPtr.Zero)
                {
                    log?.LogInformation("Antigravity window found: 0x{Hwnd:X}", targetHwnd.ToInt64());

                    IntPtr fg = GetForegroundWindow();
                    uint fgPid = 0;
                    uint fgThread = GetWindowThreadProcessId(fg, out fgPid);
                    uint curThread = GetCurrentThreadId();

                    if (fgThread != 0 && fgThread != curThread)
                        AttachThreadInput(curThread, fgThread, true);

                    ShowWindow(targetHwnd, 9 /* SW_RESTORE */);
                    BringWindowToTop(targetHwnd);
                    SetForegroundWindow(targetHwnd);

                    if (fgThread != 0 && fgThread != curThread)
                        AttachThreadInput(curThread, fgThread, false);

                    Thread.Sleep(150);

                    // Step 1: Send Ctrl+L (mod 0x11 scan 0x1D, 'L' 0x4C scan 0x26) to focus prompt input editor.
                    // This is essential because Antigravity's toggleVoiceRecording canExecute check requires
                    // the active element to be inside the editor container!
                    SendCombo(0x11, 0x1D, 0x4C, 0x26);
                    Thread.Sleep(120);

                    // Step 2: Send Ctrl+M (mod 0x11 scan 0x1D, 'M' 0x4D scan 0x32) to toggle voice recording
                    SendCombo(0x11, 0x1D, 0x4D, 0x32);
                    log?.LogInformation("Dispatched Ctrl+L (focus) then Ctrl+M (voice) to Antigravity");
                    return true;
                }
                else
                {
                    var exe = Path.Combine(
                        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                        "Programs", "antigravity", "Antigravity.exe");
                    if (File.Exists(exe))
                    {
                        try { Process.Start(new ProcessStartInfo(exe) { UseShellExecute = true }); } catch { }
                        Thread.Sleep(500);
                    }
                }

                return false;
            }

            return false;
        }
        catch (Exception ex)
        {
            log?.LogWarning("ToggleVoiceMode failed: {Msg}", ex.Message);
            return false;
        }
    }

    private static void SendCombo(byte modVk, byte modScan, byte keyVk, byte keyScan)
    {
        keybd_event(modVk, modScan, 0, 0); // Mod down
        Thread.Sleep(50);
        keybd_event(keyVk, keyScan, 0, 0); // Key down
        Thread.Sleep(50);
        keybd_event(keyVk, keyScan, 2, 0); // Key up
        Thread.Sleep(50);
        keybd_event(modVk, modScan, 2, 0); // Mod up
        Thread.Sleep(50);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        var brainDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".gemini", "antigravity", "brain");

        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                ScanOnce(brainDir);
            }
            catch (Exception ex)
            {
                log.LogDebug("AntigravityChatWatcher: {Msg}", ex.Message);
            }
            try { await Task.Delay(900, stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    private void ScanOnce(string brainDir)
    {
        if (!Directory.Exists(brainDir)) return;

        string? bestFile = null;
        DateTime bestWrite = DateTime.MinValue;
        long bestLen = -1;
        string bestConv = "";

        lock (_gate)
        {
            if (!string.IsNullOrEmpty(_selectedConvId))
            {
                var targetFile = Path.Combine(brainDir, _selectedConvId, ".system_generated", "logs", "transcript.jsonl");
                if (File.Exists(targetFile))
                {
                    var fi = new FileInfo(targetFile);
                    bestFile = targetFile;
                    bestWrite = fi.LastWriteTimeUtc;
                    bestLen = fi.Length;
                    bestConv = _selectedConvId;
                }
            }
        }

        if (bestFile is null)
        {
            foreach (var dir in Directory.EnumerateDirectories(brainDir))
            {
                var tpath = Path.Combine(dir, ".system_generated", "logs", "transcript.jsonl");
                if (!File.Exists(tpath)) continue;
                var fi = new FileInfo(tpath);
                if (fi.LastWriteTimeUtc > bestWrite)
                {
                    bestWrite = fi.LastWriteTimeUtc;
                    bestLen = fi.Length;
                    bestFile = tpath;
                    bestConv = Path.GetFileName(dir);
                }
            }
        }

        if (bestFile is null) return;

        var voiceDir = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            ".gemini", "antigravity", "voice_chats");
        var voiceFile = Path.Combine(voiceDir, $"{bestConv}.json");
        var voiceFi = File.Exists(voiceFile) ? new FileInfo(voiceFile) : null;
        DateTime vWrite = voiceFi?.LastWriteTimeUtc ?? DateTime.MinValue;
        long vLen = voiceFi?.Length ?? -1;

        if (bestFile == _lastFile && bestLen == _lastLen && bestWrite == _lastWrite
            && voiceFile == _lastVoiceFile && vLen == _lastVoiceLen && vWrite == _lastVoiceWrite)
        {
            return;
        }

        var fullPath = Path.Combine(Path.GetDirectoryName(bestFile)!, "transcript_full.jsonl");
        var messages = ParseRecentMessages(bestFile, fullPath);

        bool voiceActive = false;
        if (voiceFi is not null)
        {
            var (va, vMsgs) = ParseVoiceChat(voiceFile);
            voiceActive = va;
            if (vMsgs.Count > 0 && (voiceActive || vWrite > bestWrite))
            {
                messages = vMsgs;
            }
        }

        string title = "";
        string proj = "General";
        try
        {
            var dbPath = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                ".gemini", "antigravity", "conversation_summaries.db");
            if (File.Exists(dbPath))
            {
                var connStr = new Microsoft.Data.Sqlite.SqliteConnectionStringBuilder
                {
                    DataSource = dbPath,
                    Mode = Microsoft.Data.Sqlite.SqliteOpenMode.ReadOnly
                }.ToString();
                using var conn = new Microsoft.Data.Sqlite.SqliteConnection(connStr);
                conn.Open();
                using var cmd = conn.CreateCommand();
                cmd.CommandText = "SELECT title, workspace_uris FROM conversation_summaries WHERE conversation_id = @id LIMIT 1;";
                cmd.Parameters.AddWithValue("@id", bestConv);
                using var r = cmd.ExecuteReader();
                if (r.Read())
                {
                    title = r.GetString(0);
                    var ws = r.IsDBNull(1) ? "" : r.GetString(1);
                    if (!string.IsNullOrWhiteSpace(ws))
                    {
                        var uris = JsonSerializer.Deserialize<List<string>>(ws);
                        if (uris != null && uris.Count > 0)
                        {
                            var u = Uri.UnescapeDataString(uris[0]).TrimEnd('/', '\\');
                            var s = Path.GetFileName(u);
                            if (!string.IsNullOrWhiteSpace(s)) proj = s;
                        }
                    }
                }
            }
        }
        catch { }

        _lastFile = bestFile;
        _lastLen = bestLen;
        _lastWrite = bestWrite;
        _lastVoiceFile = voiceFile;
        _lastVoiceLen = vLen;
        _lastVoiceWrite = vWrite;

        var snap = new ChatSnapshot(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(), bestConv, voiceActive, messages, title, proj);
        lock (_gate) _latest = snap;

        var payload = JsonSerializer.SerializeToElement(new
        {
            updatedAt = snap.UpdatedAt,
            convId = snap.ConversationId,
            title = snap.Title,
            projectName = snap.ProjectName,
            voiceActive = snap.VoiceActive,
            messages = snap.Messages.Select(m => new { role = m.Role, time = m.Time, text = m.Text, step = m.Step }),
        });
        push.Set("ag_chat", payload, null);
    }

    private static (bool Active, List<ChatMessage> Messages) ParseVoiceChat(string voicePath)
    {
        try
        {
            if (!File.Exists(voicePath)) return (false, []);
            using var fs = new FileStream(voicePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var doc = JsonDocument.Parse(fs);
            var root = doc.RootElement;
            if (!root.TryGetProperty("chats", out var chatsEl) || chatsEl.ValueKind != JsonValueKind.Array)
                return (false, []);

            JsonElement? lastChat = null;
            foreach (var ch in chatsEl.EnumerateArray()) lastChat = ch;
            if (lastChat is null) return (false, []);

            var c = lastChat.Value;
            bool active = !c.TryGetProperty("stoppedAt", out var stEl) || string.IsNullOrEmpty(stEl.GetString());

            var list = new List<ChatMessage>();
            if (c.TryGetProperty("lines", out var linesEl) && linesEl.ValueKind == JsonValueKind.Array)
            {
                foreach (var line in linesEl.EnumerateArray())
                {
                    var roleStr = line.TryGetProperty("role", out var rEl) ? rEl.GetString() : "";
                    var text = line.TryGetProperty("text", out var tEl) ? tEl.GetString() : "";
                    var time = FormatTime(line.TryGetProperty("time", out var tmEl) ? tmEl.GetString() : null);
                    if (string.IsNullOrWhiteSpace(text)) continue;

                    string role = roleStr == "ROLE_USER" ? "user" : "ai";
                    list.Add(new ChatMessage(role, time, text, 0));
                }
            }

            if (list.Count > 10) list = list.Skip(list.Count - 10).ToList();
            return (active, list);
        }
        catch
        {
            return (false, []);
        }
    }

    private static List<ChatMessage> ParseRecentMessages(string transcriptPath, string fullPath)
    {
        var tailLines = ReadTailLines(transcriptPath, 90);
        var rawItems = new List<(string Role, string Time, string Text, int Step, bool Truncated)>();

        foreach (var line in tailLines)
        {
            if (string.IsNullOrWhiteSpace(line)) continue;
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                if (!root.TryGetProperty("type", out var typeEl)) continue;
                var type = typeEl.GetString();
                if (type is not ("PLANNER_RESPONSE" or "USER_INPUT")) continue;

                var content = root.TryGetProperty("content", out var cEl) ? cEl.GetString() ?? "" : "";
                if (string.IsNullOrWhiteSpace(content)) continue;

                int step = root.TryGetProperty("step_index", out var sEl) && sEl.TryGetInt32(out var si) ? si : 0;
                string time = FormatTime(root.TryGetProperty("created_at", out var caEl) ? caEl.GetString() : null);

                bool truncated = false;
                if (root.TryGetProperty("truncated_fields", out var tfEl) && tfEl.ValueKind == JsonValueKind.Array)
                {
                    foreach (var item in tfEl.EnumerateArray())
                        if (item.GetString() == "content") { truncated = true; break; }
                }

                string role = type == "PLANNER_RESPONSE" ? "ai" : "user";
                rawItems.Add((role, time, content, step, truncated));
            }
            catch { }
        }

        // Keep only the last 8 messages to stay compact (< 20 KB)
        var recent = rawItems.Count > 8 ? rawItems.Skip(rawItems.Count - 8).ToList() : rawItems;

        // If any recent AI/user message had content truncated in compact transcript.jsonl, recover full content by step_index
        var needSteps = recent.Where(r => r.Truncated && r.Step > 0).Select(r => r.Step).ToHashSet();
        var fullByStep = needSteps.Count > 0 && File.Exists(fullPath)
            ? LoadStepsFromFull(fullPath, needSteps)
            : new Dictionary<int, string>();

        var result = new List<ChatMessage>(recent.Count);
        foreach (var r in recent)
        {
            var raw = fullByStep.TryGetValue(r.Step, out var fullText) ? fullText : r.Text;
            var clean = r.Role == "user" ? CleanUserContent(raw) : CleanAiContent(raw);
            if (string.IsNullOrWhiteSpace(clean)) continue;
            if (clean.Length > 1400) clean = clean[..1400] + "…";
            result.Add(new ChatMessage(r.Role, r.Time, clean, r.Step));
        }
        return result;
    }

    private static Dictionary<int, string> LoadStepsFromFull(string fullPath, HashSet<int> steps)
    {
        var map = new Dictionary<int, string>();
        try
        {
            foreach (var line in ReadTailLines(fullPath, 120))
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    var root = doc.RootElement;
                    if (!root.TryGetProperty("step_index", out var sEl) || !sEl.TryGetInt32(out var step)) continue;
                    if (!steps.Contains(step)) continue;
                    if (root.TryGetProperty("content", out var cEl))
                    {
                        var c = cEl.GetString();
                        if (!string.IsNullOrEmpty(c)) map[step] = c;
                    }
                }
                catch { }
            }
        }
        catch { }
        return map;
    }

    private static List<string> ReadTailLines(string path, int maxLines)
    {
        var lines = new List<string>();
        try
        {
            using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            // Read up to last 512 KB for speed
            const long maxRead = 512 * 1024;
            if (fs.Length > maxRead)
            {
                fs.Seek(-maxRead, SeekOrigin.End);
                // Skip partial first line
                int b;
                while ((b = fs.ReadByte()) != -1 && b != '\n') { }
            }
            using var sr = new StreamReader(fs, Encoding.UTF8, detectEncodingFromByteOrderMarks: true);
            string? line;
            while ((line = sr.ReadLine()) is not null)
                lines.Add(line);
        }
        catch { }
        return lines.Count > maxLines ? lines.Skip(lines.Count - maxLines).ToList() : lines;
    }

    private static string FormatTime(string? iso)
    {
        if (string.IsNullOrWhiteSpace(iso)) return "";
        return DateTimeOffset.TryParse(iso, out var dto)
            ? dto.ToLocalTime().ToString("HH:mm")
            : "";
    }

    private static string CleanUserContent(string raw)
    {
        // If voice mode (<talker_agent_context>), extract only the spoken user lines
        if (raw.Contains("<talker_agent_context>", StringComparison.Ordinal))
        {
            var spoken = new List<string>();
            foreach (Match m in VoiceUserLineRegex().Matches(raw))
            {
                var t = m.Groups[1].Value.Trim();
                if (!string.IsNullOrWhiteSpace(t)) spoken.Add(t);
            }
            if (spoken.Count > 0) return string.Join(" · ", spoken.TakeLast(4));
        }

        // Strip XML metadata blocks if present
        var s = XmlBlockRegex().Replace(raw, "").Trim();
        s = TagRegex().Replace(s, "").Trim();
        return s;
    }

    private static string CleanAiContent(string raw)
    {
        // Convert markdown file/web links [label](url) -> label
        var s = MdLinkRegex().Replace(raw, "$1");
        // Strip bold/italic markers lightly for clean mobile reading
        s = s.Replace("**", "").Replace("`", "");
        s = MultiBlankRegex().Replace(s, "\n\n").Trim();
        return s;
    }

    [GeneratedRegex(@"\]\s*user:\s*""([^""]+)""")]
    private static partial Regex VoiceUserLineRegex();

    [GeneratedRegex(@"<(voice_instructions|ADDITIONAL_METADATA|CONTEXT_SUMMARY)>[\s\S]*?</\1>", RegexOptions.IgnoreCase)]
    private static partial Regex XmlBlockRegex();

    [GeneratedRegex(@"<[^>]+>")]
    private static partial Regex TagRegex();

    [GeneratedRegex(@"\[([^\]]+)\]\([^)]+\)")]
    private static partial Regex MdLinkRegex();

    [GeneratedRegex(@"\n{3,}")]
    private static partial Regex MultiBlankRegex();
}
