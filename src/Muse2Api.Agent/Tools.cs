using System.Diagnostics;
using System.Text.Json.Nodes;

namespace Muse2Api.Agent;

/// <summary>One tool call, parsed from a ```tool JSON block or a native
/// OpenAI tool_calls entry. Args are the JSON object minus the "name" field.</summary>
public sealed record ToolCall(string Name, JsonObject Args);

/// <summary>The agent's tools. Every file path is jailed inside the
/// workspace root: "..", absolute paths outside the root and symlinked
/// escapes are all rejected before any read or write happens.</summary>
public sealed partial class ToolExecutor
{
    public string Root { get; }
    public string Shell { get; set; }

    public ToolExecutor(string root, string shell = "auto")
    {
        Root = Path.TrimEndingDirectorySeparator(Path.GetFullPath(root));
        if (!Directory.Exists(Root)) throw new DirectoryNotFoundException($"workspace not found: {Root}");
        RejectLinks(Root);
        Shell = shell;
    }

    private string Resolve(string path)
    {
        // Models may return slash-separated relative paths on Windows or a
        // workspace-qualified path. Treat both consistently before checking links.
        if (OperatingSystem.IsWindows()) path = path.Replace('/', Path.DirectorySeparatorChar);
        var full = Path.GetFullPath(Path.Combine(Root, path));
        var comparison = OperatingSystem.IsWindows() ? StringComparison.OrdinalIgnoreCase : StringComparison.Ordinal;
        var prefix = Path.EndsInDirectorySeparator(Root) ? Root : Root + Path.DirectorySeparatorChar;
        if (!full.Equals(Root, comparison) && !full.StartsWith(prefix, comparison))
            throw new InvalidOperationException($"path is outside the workspace: {path}");
        RejectLinks(full);
        return full;
    }

    // Check every existing path component, including dangling links and
    // Windows junctions; lexical '..' checks alone do not contain file access.
    private static void RejectLinks(string full)
    {
        for (var current = full; !string.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
        {
            try
            {
                if ((File.GetAttributes(current) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidOperationException($"symbolic links and junctions are not allowed: {current}");
            }
            catch (FileNotFoundException) { }
            catch (DirectoryNotFoundException) { }
        }
    }

    private static string Str(JsonObject args, string name, string fallback = "")
        => args[name] is JsonValue v && v.TryGetValue<string>(out var s) ? s : fallback;

    private static bool Bool(JsonObject args, string name, bool fallback = false)
        => args[name] is JsonValue v && v.TryGetValue<bool>(out var b) ? b : fallback;

    private static string Truncate(string s, int max = 20000)
        => s.Length <= max ? s : s[..max] + $"\n... [truncated, {s.Length} chars total]";

    public async Task<string> ExecuteAsync(ToolCall call, CancellationToken cancel = default)
    {
        try { return await ExecutePreparedAsync(await PrepareAsync(call, cancel), cancel); }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex) { return $"error: {ex.Message}"; }
    }

    public async Task<string> ExecutePreparedAsync(ToolApproval prepared, CancellationToken cancel = default,
        Action<string>? output = null)
    {
        try
        {
            cancel.ThrowIfCancellationRequested();
            var call = prepared.Call;
            return call.Name switch
            {
                "list_files" => ListFiles(Str(call.Args, "path", "."), Bool(call.Args, "recursive"), Int(call.Args, "offset", 0), Int(call.Args, "limit", 200)),
                "read_file" => await ReadFileAsync(Str(call.Args, "path"), Int(call.Args, "start_line", 1), Int(call.Args, "max_lines", 1000), cancel, Bool(call.Args, "details")),
                "read_files" => await ReadFilesAsync(call.Args, cancel),
                "write_file" or "edit_file" => await ApplyPreparedAsync(prepared, cancel),
                "search_files" => await SearchFilesAsync(call.Args, cancel),
                "send_file" => await SendFileAsync(Str(call.Args, "path"), cancel),
                "git_status" => await GitAsync(new[] { "status", "--short", "--branch" }, cancel),
                "git_diff" => await GitAsync(new[] { "diff", "--no-ext-diff", "--no-textconv", "HEAD", "--", "." }, cancel),
                "run_command" when Bool(call.Args, "background") => await StartProcessAsync(call.Args, cancel),
                "process_status" or "process_input" or "process_stop" => await ProcessToolAsync(call, cancel),
                "run_command" => await RunCommandAsync(Str(call.Args, "command"),
                    Str(call.Args, "shell"), Str(call.Args, "workdir", "."), Int(call.Args, "timeout_seconds", 120), cancel, output),
                _ when call.Name.StartsWith("computer_", StringComparison.Ordinal) => await ComputerAsync(call, cancel),
                "__parse_error__" => "error: " + Str(call.Args, "error"),
                _ => $"error: unknown tool '{call.Name}'. Available tools: list_files, read_file, search_files, write_file, edit_file, run_command, git_status, git_diff.",
            };
        }
        catch (OperationCanceledException) { throw; }
        catch (Exception ex)
        {
            return $"error: {ex.Message}";
        }
    }

    public bool NeedsConfirmation(ToolCall call)
        => call.Name is "write_file" or "edit_file" or "run_command" or "process_input" or "process_stop";

    public string Describe(ToolCall call) => call.Name switch
    {
        "write_file" => $"write_file {Str(call.Args, "path")} ({Str(call.Args, "content").Length} chars)",
        "edit_file" => $"edit_file {Str(call.Args, "path")}",
        "run_command" => $"run_command: {Str(call.Args, "command")}",
        _ => $"{call.Name} {string.Join(", ", call.Args.Select(kv => $"{kv.Key}={kv.Value}"))}",
    };

    private string ListFiles(string path, bool recursive, int offset, int limit)
    {
        var dir = Resolve(path);
        if (!Directory.Exists(dir)) return $"error: directory not found: {path}";
        if (offset < 0 || limit < 1) return "error: offset must be nonnegative and limit must be positive";
        limit = Math.Min(limit, 1000);
        var found = WorkspaceFiles.Enumerate(dir, recursive).Skip(offset).Take(limit + 1).ToArray();
        var entries = found.Take(limit)
            .Select(e => Path.GetRelativePath(Root, e).Replace('\\', '/')
                + (Directory.Exists(e) ? "/" : ""));
        return string.Join('\n', entries) + (found.Length > limit ? $"\n[more entries; next_offset={offset + limit}; use offset]" : "");
    }

    private async Task<string> ReadFileAsync(string path, int start, int maxLines, CancellationToken cancel, bool details = false)
    {
        var full = Resolve(path);
        if (!File.Exists(full)) return $"error: file not found: {path}";
        var text = await ReadTextAsync(full, cancel);
        if (start < 1 || maxLines < 1) return "error: start_line and max_lines must be positive";
        var lines = text.Split('\n');
        if (start > lines.Length) return $"error: start_line {start} exceeds total lines {lines.Length}";
        var output = new System.Text.StringBuilder();
        var next = start;
        foreach (var line in lines.Skip(start - 1).Take(Math.Min(maxLines, 4000)))
        {
            var rendered = details ? $"{next,5}: {line}" : line;
            if (output.Length + rendered.Length > 48000)
            {
                if (next == start) return $"error: line {next} exceeds read page size; use search_files to narrow down the content";
                break;
            }
            if (output.Length > 0) output.Append('\n');
            output.Append(rendered); next++;
        }
        RecordRead(full, text, start, next - 1, lines.Length);
        var header = details ? $"File: {Path.GetRelativePath(Root, full)}\nLines: {start}-{next - 1}/{lines.Length}\ncontent_sha256: {ContentHash(text)}\n\n" : "";
        return header + output + (next <= lines.Length ? $"\n[more lines; total={lines.Length}; next_start_line={next}; use start_line]" : "");
    }

    private async Task<string> ReadFilesAsync(JsonObject args, CancellationToken cancel)
    {
        if (args["paths"] is not JsonArray paths || paths.Count is < 1 or > 8) return "error: paths must contain 1 to 8 files";
        var output = new System.Text.StringBuilder();
        foreach (var path in paths)
        {
            if (path is not JsonValue value || !value.TryGetValue<string>(out var name)) return "error: paths must be strings";
            var content = await ReadFileAsync(name, Int(args, "start_line", 1), Int(args, "max_lines", 300), cancel, details: true);
            if (output.Length + content.Length > 60000) { output.AppendLine("\n[batch limit reached; read remaining files individually]"); break; }
            output.AppendLine(content).AppendLine();
        }
        return output.ToString();
    }

    private (string File, string[] Args) ResolveShell(string requested, string command)
    {
        var want = (string.IsNullOrEmpty(requested) ? Shell : requested).Trim().ToLowerInvariant();
        want = want switch { "cmd.exe" => "cmd", "powershell.exe" => "powershell", "bash.exe" => "bash", _ => want };
        if (want is not ("auto" or "powershell" or "cmd" or "bash")) throw new InvalidOperationException("shell must be auto, powershell, cmd or bash");
        if (OperatingSystem.IsWindows())
        {
            if (want is "cmd" or "cmd.exe") return (Path.Combine(Environment.SystemDirectory, "cmd.exe"), new[] { "/d", "/c", command });
            // Default on Windows: PowerShell, like Codex on Windows.
            if (want == "bash") return ("bash", new[] { "-c", command });
            return (Path.Combine(Environment.SystemDirectory, "WindowsPowerShell", "v1.0", "powershell.exe"), new[] { "-NoProfile", "-NonInteractive", "-Command", command });
        }
        if (want is "powershell" or "cmd") throw new InvalidOperationException($"shell '{want}' is only supported on Windows");
        // Linux/macOS (used to develop and test this agent on this VM).
        return ("/bin/bash", new[] { "-c", command });
    }
}
