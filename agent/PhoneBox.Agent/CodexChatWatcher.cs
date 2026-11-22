using System.Diagnostics;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;

namespace PhoneBox.Agent;

/// <summary>
/// Projects locally stored Codex rollout sessions into a clean, phone-friendly conversation view.
/// Nothing is sent to a remote service: the panel receives the selected session over the existing
/// authenticated PhoneBox connection only.
/// </summary>
public sealed class CodexChatWatcher(PushStore push, ILogger<CodexChatWatcher> log) : BackgroundService
{
    public sealed record ChatMessage(string Role, string Time, string Text);
    public sealed record ChatSnapshot(long UpdatedAt, string ConversationId, bool Active, List<ChatMessage> Messages,
        string Title = "", string ProjectName = "General");
    public sealed record Conversation(string Id, string Title, string ProjectName, string LastModified, int StepCount, bool IsActive, string ThreadId = "");
    public sealed record ConversationsResult(string CurrentConvId, string CurrentTitle, string CurrentProject, bool IsAuto,
        List<string> Projects, List<Conversation> Conversations, bool OpenedDesktop = false);

    private const int MaxMessages = 40;
    private const int MaxMessageChars = 1_600;
    private static readonly Regex UuidTailRegex = new(@"([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$", RegexOptions.IgnoreCase | RegexOptions.Compiled);

    private readonly object _gate = new();
    private ChatSnapshot _latest = new(0, "", false, []);
    private string? _selectedId;
    private string _lastPath = "";
    private long _lastLength = -1;
    private DateTime _lastWrite = DateTime.MinValue;

    private static string CodexHome => Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.UserProfile), ".codex");
    private static string Root => Path.Combine(CodexHome, "sessions");

    public ChatSnapshot Snapshot() { lock (_gate) return _latest; }

    public static bool OpenThreadInDesktop(string? idOrPath, ILogger? log = null)
    {
        if (string.IsNullOrWhiteSpace(idOrPath)) return false;
        var threadId = ExtractThreadId(idOrPath.Trim());
        if (string.IsNullOrEmpty(threadId)) return false;
        if (!OperatingSystem.IsWindows()) return false;
        try
        {
            var uri = $"codex://threads/{Uri.EscapeDataString(threadId)}";
            Process.Start(new ProcessStartInfo(uri) { UseShellExecute = true });
            log?.LogInformation("Opened Codex thread via protocol: {Uri}", uri);
            return true;
        }
        catch (Exception ex)
        {
            log?.LogWarning("OpenThreadInDesktop failed: {Message}", ex.Message);
            return false;
        }
    }

    public object SelectConversation(string? id)
    {
        lock (_gate)
        {
            _selectedId = string.IsNullOrWhiteSpace(id) || id.Equals("auto", StringComparison.OrdinalIgnoreCase) ? null : id.Trim();
            _lastPath = "";
            _lastLength = -1;
        }
        var opened = !string.IsNullOrEmpty(_selectedId) && OpenThreadInDesktop(_selectedId, log);
        ScanOnce();
        return ListConversations() with { OpenedDesktop = opened };
    }

    public ConversationsResult ListConversations()
    {
        var files = Rollouts().Take(60).ToList();
        var titles = LoadThreadTitles();
        var projMap = LoadProjectMappings();
        string? selected;
        string activeId;
        lock (_gate) { selected = _selectedId; activeId = _latest.ConversationId; }
        var currentId = selected ?? activeId;
        var projectSet = new HashSet<string>(StringComparer.OrdinalIgnoreCase) { "Tất cả", "General" };
        var rows = new List<Conversation>();
        foreach (var f in files)
        {
            try
            {
                var id = ToId(f.FullName);
                var threadId = ExtractThreadId(f.FullName) ?? "";
                var info = ReadInfo(f.FullName, includeMessages: true, titles, projMap);
                projectSet.Add(info.Project);
                rows.Add(new Conversation(id, info.Title, info.Project, f.LastWriteTimeUtc.ToString("O"), info.MessageCount,
                    string.Equals(id, currentId, StringComparison.Ordinal), threadId));
            }
            catch { }
        }
        var current = rows.FirstOrDefault(c => c.IsActive) ?? rows.FirstOrDefault();
        return new ConversationsResult(currentId, current?.Title ?? "", current?.ProjectName ?? "General",
            selected is null, projectSet.ToList(), rows);
    }

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try { ScanOnce(); }
            catch (Exception ex) { log.LogDebug("CodexChatWatcher: {Message}", ex.Message); }
            try { await Task.Delay(1_000, stoppingToken); }
            catch (OperationCanceledException) { break; }
        }
    }

    private void ScanOnce()
    {
        var files = Rollouts().ToList();
        if (files.Count == 0) return;
        string? selected;
        lock (_gate) selected = _selectedId;
        var file = selected is null ? files[0] : files.FirstOrDefault(f => string.Equals(ToId(f.FullName), selected, StringComparison.Ordinal));
        if (file is null) return;
        if (file.FullName == _lastPath && file.Length == _lastLength && file.LastWriteTimeUtc == _lastWrite) return;

        var titles = LoadThreadTitles();
        var projMap = LoadProjectMappings();
        var info = ReadInfo(file.FullName, includeMessages: true, titles, projMap);
        var id = ToId(file.FullName);
        var updatedAt = new DateTimeOffset(file.LastWriteTimeUtc).ToUnixTimeMilliseconds();
        var snap = new ChatSnapshot(updatedAt, id, DateTime.UtcNow - file.LastWriteTimeUtc < TimeSpan.FromMinutes(3),
            info.Messages, info.Title, info.Project);
        lock (_gate)
        {
            _latest = snap;
            _lastPath = file.FullName;
            _lastLength = file.Length;
            _lastWrite = file.LastWriteTimeUtc;
        }
        push.Set("codex_chat", JsonSerializer.SerializeToElement(new
        {
            updatedAt = snap.UpdatedAt, convId = snap.ConversationId, active = snap.Active,
            title = snap.Title, projectName = snap.ProjectName, messages = snap.Messages,
        }), null);
    }

    private static IEnumerable<FileInfo> Rollouts()
    {
        if (!Directory.Exists(Root)) return [];
        try
        {
            return new DirectoryInfo(Root).EnumerateFiles("rollout-*.jsonl", SearchOption.AllDirectories)
                .OrderByDescending(f => f.LastWriteTimeUtc).ToArray();
        }
        catch { return []; }
    }

    private static string ToId(string path) => Path.GetRelativePath(Root, path).Replace('\\', '/');

    private static string? ExtractThreadId(string path)
    {
        var m = UuidTailRegex.Match(path);
        return m.Success ? m.Groups[1].Value : null;
    }

    private static Dictionary<string, string> LoadThreadTitles()
    {
        var map = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var idxPath = Path.Combine(CodexHome, "session_index.jsonl");
        if (!File.Exists(idxPath)) return map;
        try
        {
            using var fs = new FileStream(idxPath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var reader = new StreamReader(fs, Encoding.UTF8);
            string? line;
            while ((line = reader.ReadLine()) is not null)
            {
                if (string.IsNullOrWhiteSpace(line) || !TryJson(line, out var root)) continue;
                var id = Text(root, "id");
                var name = Text(root, "thread_name");
                if (!string.IsNullOrWhiteSpace(id) && !string.IsNullOrWhiteSpace(name))
                    map[id] = name.Trim();
            }
        }
        catch { }
        return map;
    }

    private static Dictionary<string, string> LoadProjectMappings()
    {
        var threadToProject = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var statePath = Path.Combine(CodexHome, ".codex-global-state.json");
        if (!File.Exists(statePath)) return threadToProject;
        try
        {
            using var fs = new FileStream(statePath, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);
            using var doc = JsonDocument.Parse(fs);
            var root = doc.RootElement;
            var projects = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
            if (root.TryGetProperty("local-projects", out var lp) && lp.ValueKind == JsonValueKind.Object)
            {
                foreach (var prop in lp.EnumerateObject())
                {
                    var name = Text(prop.Value, "name");
                    if (!string.IsNullOrWhiteSpace(name)) projects[prop.Name] = name.Trim();
                }
            }
            if (root.TryGetProperty("thread-project-assignments", out var tpa) && tpa.ValueKind == JsonValueKind.Object)
            {
                foreach (var prop in tpa.EnumerateObject())
                {
                    var projId = Text(prop.Value, "projectId");
                    if (!string.IsNullOrWhiteSpace(projId) && projects.TryGetValue(projId, out var projName))
                        threadToProject[prop.Name] = projName;
                }
            }
        }
        catch { }
        return threadToProject;
    }

    private static bool IsSystemInjectedText(string text)
    {
        var t = text.TrimStart();
        return t.StartsWith("<environment_context>", StringComparison.OrdinalIgnoreCase)
            || t.StartsWith("<permissions", StringComparison.OrdinalIgnoreCase)
            || t.StartsWith("<collaboration_mode>", StringComparison.OrdinalIgnoreCase)
            || t.StartsWith("<user_instructions>", StringComparison.OrdinalIgnoreCase)
            || t.StartsWith("<INSTRUCTIONS>", StringComparison.OrdinalIgnoreCase)
            || t.StartsWith("# AGENTS.md", StringComparison.OrdinalIgnoreCase)
            || t.StartsWith("<turn_aborted>", StringComparison.OrdinalIgnoreCase);
    }

    private sealed record Parsed(string Title, string Project, int MessageCount, List<ChatMessage> Messages);

    private static Parsed ReadInfo(string path, bool includeMessages, Dictionary<string, string> titles, Dictionary<string, string> projMap)
    {
        var project = "General";
        var threadId = ExtractThreadId(path);
        var messages = new List<ChatMessage>();
        using var fs = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete);

        using (var firstReader = new StreamReader(fs, Encoding.UTF8, leaveOpen: true))
        {
            var first = firstReader.ReadLine();
            if (first is not null && TryJson(first, out var root) && root.TryGetProperty("payload", out var p))
            {
                var cwd = Text(p, "cwd") ?? "";
                if (!cwd.Contains(@"\Documents\Codex\", StringComparison.OrdinalIgnoreCase))
                {
                    var leaf = string.IsNullOrWhiteSpace(cwd) ? "" : Path.GetFileName(cwd.TrimEnd('\\', '/'));
                    if (!string.IsNullOrWhiteSpace(leaf)) project = leaf;
                }
            }
        }
        if (threadId is not null && projMap.TryGetValue(threadId, out var assignedProj))
            project = assignedProj;

        fs.Seek(Math.Max(0, fs.Length - 768 * 1024), SeekOrigin.Begin);
        if (fs.Position > 0) while (fs.ReadByte() is var b && b != -1 && b != '\n') { }
        using var reader = new StreamReader(fs, Encoding.UTF8, detectEncodingFromByteOrderMarks: true, leaveOpen: false);
        string? line;
        while ((line = reader.ReadLine()) is not null)
        {
            if (!includeMessages || !line.Contains("\"message\"", StringComparison.Ordinal)) continue;
            if (!TryJson(line, out var root) || !root.TryGetProperty("payload", out var payload)) continue;
            var type = Text(payload, "type");
            string? role = null;
            string? text = null;
            if (type == "user_message") { role = "user"; text = Text(payload, "message") ?? Content(payload); }
            else if (type == "message")
            {
                role = Text(payload, "role");
                text = Content(payload);
            }
            if (role is not ("user" or "assistant") || string.IsNullOrWhiteSpace(text)) continue;
            if (IsSystemInjectedText(text)) continue;
            text = Clean(text);
            if (text.Length == 0) continue;
            var time = DateTimeOffset.TryParse(Text(root, "timestamp"), out var ts) ? ts.ToLocalTime().ToString("HH:mm") : "";
            var normRole = role == "assistant" ? "ai" : "user";
            if (messages.Count > 0 && messages[^1].Role == normRole && messages[^1].Text == text) continue;
            messages.Add(new ChatMessage(normRole, time, text));
        }
        if (messages.Count > MaxMessages) messages = messages.Skip(messages.Count - MaxMessages).ToList();

        string? title = threadId is not null && titles.TryGetValue(threadId, out var indexedName) ? indexedName : null;
        if (string.IsNullOrWhiteSpace(title))
            title = messages.FirstOrDefault(m => m.Role == "user")?.Text ?? Path.GetFileNameWithoutExtension(path);
        title = title.Replace('\n', ' ').Replace('\r', ' ').Trim();
        if (title.Length > 72) title = title[..72] + "…";
        return new Parsed(title, project, messages.Count, messages);
    }

    private static string? Content(JsonElement payload)
    {
        if (payload.TryGetProperty("content", out var content)) return ContentValue(content);
        return Text(payload, "message");
    }

    private static string? ContentValue(JsonElement value)
    {
        if (value.ValueKind == JsonValueKind.String) return value.GetString();
        if (value.ValueKind != JsonValueKind.Array) return null;
        var parts = new List<string>();
        foreach (var item in value.EnumerateArray())
        {
            var text = Text(item, "text") ?? Text(item, "input_text") ?? Text(item, "output_text");
            if (!string.IsNullOrWhiteSpace(text)) parts.Add(text);
        }
        return parts.Count == 0 ? null : string.Join("\n", parts);
    }

    private static string Clean(string value)
    {
        value = value.Trim();
        if (value.Length > MaxMessageChars) value = value[..MaxMessageChars] + "…";
        return value;
    }

    private static string? Text(JsonElement value, string property) => value.ValueKind == JsonValueKind.Object
        && value.TryGetProperty(property, out var v) && v.ValueKind == JsonValueKind.String ? v.GetString() : null;

    private static bool TryJson(string text, out JsonElement root)
    {
        try { using var doc = JsonDocument.Parse(text); root = doc.RootElement.Clone(); return true; }
        catch (JsonException) { root = default; return false; }
    }
}
