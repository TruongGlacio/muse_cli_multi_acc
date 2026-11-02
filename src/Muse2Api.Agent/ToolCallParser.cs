using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;

namespace Muse2Api.Agent;

/// <summary>Local protocol, independent of a web renderer's code-fence language label.</summary>
public static class ToolCallParser
{
    private static readonly Regex Fences = new(@"(?m)^[ \t]*(?:```|~~~)(?<language>[^\r\n]*)\r?\n(?<body>[\s\S]*?)(?:^[ \t]*(?:```|~~~)[ \t]*$|\z)", RegexOptions.Compiled);
    private static readonly Dictionary<string, string> Aliases = new(StringComparer.OrdinalIgnoreCase)
    {
        ["readFile"] = "read_file", ["writeFile"] = "write_file", ["editFile"] = "edit_file",
        ["list_directory"] = "list_files", ["listFiles"] = "list_files", ["searchFiles"] = "search_files",
        ["execute_command"] = "run_command", ["run_terminal_cmd"] = "run_command", ["runCommand"] = "run_command",
        ["run_cmd"] = "run_command", ["run_powershell"] = "run_command",
        ["replace_in_file"] = "edit_file", ["search_replace"] = "edit_file",
    };
    private static readonly HashSet<string> Names = new(StringComparer.Ordinal)
        { "read_file", "read_files", "list_files", "search_files", "write_file", "edit_file", "run_command", "process_status", "process_input", "process_stop", "git_status", "git_diff",
          "computer_list_windows", "computer_inspect", "computer_screenshot", "computer_click", "computer_type", "computer_key", "computer_scroll", "computer_invoke", "computer_set_value", "computer_focus", "computer_assert", "computer_toggle", "computer_select", "computer_expand", "send_file" };

    public static ToolCall Normalize(ToolCall call)
    {
        var name = Aliases.GetValueOrDefault(call.Name, call.Name);
        if (Names.Contains(name.ToLowerInvariant())) name = name.ToLowerInvariant();
        var args = (JsonObject)call.Args.DeepClone();
        if (!args.ContainsKey("shell") && call.Name.Equals("run_cmd", StringComparison.OrdinalIgnoreCase)) args["shell"] = "cmd";
        if (!args.ContainsKey("shell") && call.Name.Equals("run_powershell", StringComparison.OrdinalIgnoreCase)) args["shell"] = "powershell";
        foreach (var (source, target) in new[] { ("file_path", "path"), ("directory", "path"), ("cmd", "command"), ("working_directory", "workdir"), ("cwd", "workdir"), ("search", "old_text"), ("old_string", "old_text"), ("replace", "new_text"), ("new_string", "new_text"), ("new_content", "content"), ("expected_sha256", "expected_hash") })
            if (!args.ContainsKey(target) && args[source] is { } value) args[target] = value.DeepClone();
        return new(name, args);
    }

    public static ToolCall Validate(ToolCall call)
    {
        if (call.Name == "__parse_error__") return call;
        var normalized = Normalize(call);
        return Names.Contains(normalized.Name) ? normalized
            : ParseError("Unknown local tool: " + normalized.Name + ". No actions were executed.");
    }

    public static List<ToolCall> Parse(string text)
    {
        var calls = new List<ToolCall>();
        foreach (Match fence in Fences.Matches(text))
        {
            var language = fence.Groups["language"].Value.Trim().ToLowerInvariant();
            if (language is not ("tool" or "json" or "")) continue;
            var body = fence.Groups["body"].Value.Trim();
            try { Extract(JsonNode.Parse(body), calls, explicitTool: language == "tool"); }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException)
            {
                if (language == "tool" || LooksLikePlan(body)) calls.Add(JsonError(ex));
            }
        }
        if (calls.Count > 0) return Validated(calls);
        var raw = text.Trim();
        if (raw.StartsWith('{') || raw.StartsWith('['))
        {
            try { Extract(JsonNode.Parse(raw), calls, explicitTool: false); }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException or FormatException)
            { if (LooksLikePlan(raw)) calls.Add(JsonError(ex)); }
        }
        if (calls.Count == 0 && Regex.IsMatch(text, @"(?m)^\s*```tool\s*$")) calls.Add(ParseError("Incomplete local tool block"));
        return Validated(calls);
    }

    // Reject the entire response if any block/action is invalid. A valid prefix
    // is not permission to execute part of a malformed batch.
    private static List<ToolCall> Validated(List<ToolCall> calls)
        => calls.Any(c => c.Name == "__parse_error__") ? calls.Where(c => c.Name == "__parse_error__").ToList() : calls;

    private static bool LooksLikePlan(string text)
        => text.Contains("\"tool_calls\"", StringComparison.Ordinal) || text.Contains("\"actions\"", StringComparison.Ordinal)
            || Regex.IsMatch(text, "\"(?:name|tool)\"\\s*:\\s*\"(?:" + string.Join('|', Names.Concat(Aliases.Keys).Select(Regex.Escape)) + ")\"", RegexOptions.IgnoreCase)
            || text.Contains("\"arguments\"", StringComparison.Ordinal) && Regex.IsMatch(text, "\"(?:name|tool|function)\"\\s*:");

    private static ToolCall JsonError(Exception ex) => ParseError(
        "Invalid local plan JSON: " + ex.Message + " No actions from this response were executed. "
        + "Return ONE action inside a ```json code fence. JSON-escape source-code quotes (\\\"), backslashes (\\\\), and newlines (\\n); "
        + "raw JSON outside a code fence can lose escapes during Markdown rendering. Use cwd=\".\" and relative paths or forward slashes.");

    private static ToolCall ParseError(string error) => new("__parse_error__", new() { ["error"] = error });

    public static string PlannerReply(string text)
    {
        var candidates = Fences.Matches(text).Select(m => m.Groups["body"].Value).Prepend(text.Trim());
        foreach (var candidate in candidates)
        {
            try
            {
                if (JsonNode.Parse(candidate) is JsonObject obj && obj["status"]?.ToString() is "completed" or "done" or "needs_input"
                    && (obj["reply"] ?? obj["summary"]) is JsonValue value && value.TryGetValue<string>(out var reply)) return reply;
            }
            catch (Exception ex) when (ex is JsonException or InvalidOperationException) { }
        }
        return text;
    }

    private static void Extract(JsonNode? node, List<ToolCall> calls, bool explicitTool)
    {
        if (node is JsonArray array)
        {
            foreach (var item in array) Extract(item, calls, explicitTool);
            return;
        }
        if (node is not JsonObject obj) { if (explicitTool) calls.Add(ParseError("Tool must be a JSON object")); return; }
        if (obj.ContainsKey("actions") && obj.ContainsKey("tool_calls"))
        { calls.Add(ParseError("Use one actions or tool_calls envelope, not both. No actions were executed.")); return; }
        if (obj.ContainsKey("actions") && obj["actions"] is not JsonArray
            || obj.ContainsKey("tool_calls") && obj["tool_calls"] is not JsonArray)
        { calls.Add(ParseError("actions/tool_calls must be JSON arrays. No actions were executed.")); return; }
        if (obj["actions"] is JsonArray plan)
        {
            foreach (var item in plan)
            {
                if (item is not JsonObject step) { calls.Add(ParseError("Application action must be an object")); continue; }
                var operation = step["action"]?.GetValue<string>() ?? "";
                var actionTool = operation switch
                {
                    "scan" => "list_files", "inspect_text" => "read_file", "inspect_texts" => "read_files", "find_text" => "search_files",
                    "replace_text" => "edit_file", "save_text" => "write_file", "terminal" => "run_command", "poll_process" => "process_status",
                    "send_process_input" => "process_input", "stop_process" => "process_stop", "ui_tree" => "computer_inspect", "ui_image" => "computer_screenshot",
                    "ui_press" => "computer_invoke", "ui_fill" => "computer_set_value", "ui_type" => "computer_type", "ui_key" => "computer_key",
                    "ui_click" => "computer_click", "ui_scroll" => "computer_scroll", "ui_assert" => "computer_assert", "ui_toggle" => "computer_toggle",
                    "ui_select" => "computer_select", "ui_expand" => "computer_expand", "send_file" => "send_file", _ => "__unknown_action__",
                };
                if (actionTool == "__unknown_action__") { calls.Add(ParseError("Unknown application action: " + operation)); continue; }
                var actionArgs = (JsonObject)step.DeepClone(); actionArgs.Remove("action");
                if (operation == "replace_text" && actionArgs["find"] is { } find) actionArgs["old_text"] = find.DeepClone();
                if (operation == "save_text" && actionArgs["text"] is { } content) actionArgs["content"] = content.DeepClone();
                if (operation == "terminal" && actionArgs["script"] is { } script) actionArgs["command"] = script.DeepClone();
                calls.Add(Normalize(new(actionTool,actionArgs)));
            }
            return;
        }
        if (obj["tool_calls"] is JsonArray envelope) { foreach (var item in envelope) Extract(item, calls, true); return; }
        var function = obj["function"] as JsonObject;
        var name = (function?["name"] ?? obj["name"] ?? obj["tool"])?.GetValue<string>();
        if (string.IsNullOrWhiteSpace(name)) { if (explicitTool) calls.Add(ParseError("Tool name is required")); return; }
        var arguments = function?["arguments"] ?? obj["arguments"] ?? obj["parameters"];
        JsonObject args;
        if (arguments is JsonValue value && value.TryGetValue<string>(out var encoded))
            args = JsonNode.Parse(encoded) as JsonObject ?? throw new InvalidOperationException("Tool arguments must be an object");
        else if (arguments is JsonObject map) args = (JsonObject)map.DeepClone();
        else if (arguments is not null || obj.ContainsKey("arguments") || obj.ContainsKey("parameters") || function?.ContainsKey("arguments") == true)
        { calls.Add(ParseError("Tool arguments must be a JSON object or an encoded JSON object. No actions were executed.")); return; }
        else
        {
            args = (JsonObject)obj.DeepClone();
            args.Remove("name"); args.Remove("tool"); args.Remove("id");
        }
        var call = Normalize(new(name, args));
        if (!Names.Contains(call.Name) && (explicitTool || arguments is not null || function is not null)) calls.Add(Validate(call));
        else if (explicitTool || Names.Contains(call.Name)) calls.Add(call);
    }

    public static string StripToolBlocks(string text)
    {
        var visible = Fences.Replace(text, match =>
        {
            var language = match.Groups["language"].Value.Trim().ToLowerInvariant();
            if (language == "tool") return "";
            if (language is "json" or "")
            {
                var closed = Regex.IsMatch(match.Value, @"\r?\n[ \t]*(?:```|~~~)[ \t]*$");
                if (!closed && language == "json") return "";
                try
                {
                    var content = match.Groups["body"].Value;
                    if (Parse("```json\n" + content + "\n```").Count > 0) return "";
                }
                catch (JsonException) { }
            }
            return match.Value;
        });
        // During streaming, never render an incomplete protocol block as prose.
        var raw = visible.Trim();
        if (Parse(text).Count > 0)
            raw = Regex.Replace(raw, @"(?im)^[ \t]*(?:json|tool)[ \t]*(?:\r?\n|$)", "").Trim();
        if ((raw.StartsWith('{') || raw.StartsWith('[')) && Parse(raw).Count > 0) return "";
        return raw;
    }
}
