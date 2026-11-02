using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;

namespace Muse2Api;

/// <summary>
/// Translation layer between OpenAI-style tool calling (Kilo Code and other
/// OpenAI-compatible clients) and the muse.ai web agent, which only produces
/// plain text.
///
/// The gateway NEVER executes tools itself. It appends a tool catalog to the
/// prompt, asks the web agent to emit a tool_calls JSON block when it wants
/// to act, validates that block strictly, and returns standard OpenAI
/// tool_calls so the CLIENT executes them under its own approval flow.
/// Anything that fails validation degrades to a plain-text reply: a wrong
/// tool name or broken arguments is never forwarded to the client.
/// </summary>
public sealed record OpenAiToolSpec(string Name, string Description, string ParametersJson);

public sealed record OpenAiToolCall(string Name, string ArgumentsJson);

public enum OpenAiToolChoiceKind { Auto, None, Specific }

public sealed record OpenAiToolChoice(OpenAiToolChoiceKind Kind, string? FunctionName = null);

public static class OpenAiTools
{
    /// <summary>
    /// Parses the OpenAI <c>tools</c> array of a chat request. Returns null
    /// when there is no usable function tool (missing, empty, or only
    /// malformed entries), in which case the caller stays in plain-chat mode.
    /// </summary>
    public static List<OpenAiToolSpec>? ParseToolSpecs(JsonNode? toolsNode)
    {
        if (toolsNode is not JsonArray arr || arr.Count == 0) return null;
        var specs = new List<OpenAiToolSpec>();
        foreach (var item in arr)
        {
            if (item is not JsonObject obj) continue;
            var type = JsonHelp.Str(obj["type"]);
            if (type is not null && type != "function") continue;
            if (obj["function"] is not JsonObject fn) continue;
            var name = JsonHelp.Str(fn["name"]);
            if (string.IsNullOrWhiteSpace(name)) continue;
            var description = JsonHelp.Str(fn["description"]) ?? "";
            var parameters = fn["parameters"]?.ToJsonString() ?? "{}";
            specs.Add(new OpenAiToolSpec(name, description, parameters));
        }
        return specs.Count == 0 ? null : specs;
    }

    /// <summary>
    /// Renders the tool catalog as a prompt appendix. It is appended AFTER
    /// <see cref="Prompt.Flatten"/> output, so it only ever reaches the web
    /// agent on requests that actually declared tools.
    /// </summary>
    public static string RenderCatalog(IReadOnlyList<OpenAiToolSpec> specs)
    {
        var sb = new StringBuilder();
        sb.AppendLine("You have the following tools available. Use them when they help answer the request.");
        foreach (var spec in specs)
        {
            sb.Append("- ").Append(spec.Name);
            if (spec.Description.Length > 0) sb.Append(": ").Append(spec.Description);
            sb.AppendLine();
            sb.AppendLine("  Parameters (JSON Schema): " + spec.ParametersJson);
        }
        sb.AppendLine("When you need to perform an action, output ONLY a ```json code block containing exactly {\"tool_calls\":[{\"name\":\"<tool name>\",\"arguments\":{...}}]} and nothing else: no explanation, no prose, no markdown outside the block.");
        sb.AppendLine("Use only the tool names listed above, with arguments as a JSON object matching the tool's parameters. You may list several tool calls in one block when they are independent.");
        sb.Append("When no action is needed, reply with plain text as usual.");
        return sb.ToString();
    }

    public static OpenAiToolChoice ParseToolChoice(JsonNode? node)
    {
        if (node is JsonValue v && v.TryGetValue<string>(out var s))
            return s switch
            {
                "none" => new OpenAiToolChoice(OpenAiToolChoiceKind.None),
                _ => new OpenAiToolChoice(OpenAiToolChoiceKind.Auto),
            };
        if (node is JsonObject obj
            && obj["function"] is JsonObject fn
            && JsonHelp.Str(fn["name"]) is string name
            && name.Length > 0)
            return new OpenAiToolChoice(OpenAiToolChoiceKind.Specific, name);
        return new OpenAiToolChoice(OpenAiToolChoiceKind.Auto);
    }

    /// <summary>
    /// Extracts and validates tool calls from a web-agent reply. Returns null
    /// when the reply carries no tool_calls block, when tool_choice forbids
    /// calls, or when ANY call in the block fails validation; the caller
    /// then returns the reply as plain text (graceful degradation).
    /// </summary>
    public static List<OpenAiToolCall>? TryExtractCalls(
        string reply,
        IReadOnlyList<OpenAiToolSpec> specs,
        OpenAiToolChoice choice,
        bool parallelToolCalls)
    {
        if (choice.Kind == OpenAiToolChoiceKind.None) return null;
        var declared = specs.Select(s => s.Name).ToHashSet(StringComparer.Ordinal);
        var block = FindToolCallsJson(reply);
        if (block is null) return null;
        if (block["tool_calls"] is not JsonArray callsNode || callsNode.Count == 0) return null;
        var calls = new List<OpenAiToolCall>();
        foreach (var item in callsNode)
        {
            if (item is not JsonObject callObj) return null;
            // Accept both the flat shape this catalog requests
            // ({"name","arguments"}) and the OpenAI shape
            // ({"function":{"name","arguments"}}) in case the web agent
            // emits the latter anyway.
            var src = callObj["function"] as JsonObject ?? callObj;
            var name = JsonHelp.Str(src["name"]);
            if (string.IsNullOrWhiteSpace(name) || !declared.Contains(name)) return null;
            string argsJson;
            var args = src["arguments"];
            if (args is null) argsJson = "{}";
            else if (args is JsonObject argsObj) argsJson = argsObj.ToJsonString();
            else if (args is JsonValue av && av.TryGetValue<string>(out var argsStr))
            {
                JsonNode? parsed;
                try { parsed = JsonNode.Parse(argsStr); }
                catch (System.Text.Json.JsonException) { return null; }
                if (parsed is not JsonObject) return null;
                argsJson = parsed.ToJsonString();
            }
            else return null;
            calls.Add(new OpenAiToolCall(name, argsJson));
        }
        if (choice.Kind == OpenAiToolChoiceKind.Specific)
        {
            calls = calls.Where(c => c.Name == choice.FunctionName).ToList();
            if (calls.Count == 0) return null;
        }
        if (!parallelToolCalls && calls.Count > 1) calls = calls.Take(1).ToList();
        return calls;
    }

    /// <summary>OpenAI tool-call id: "call_" + 24 lowercase hex chars.</summary>
    public static string BuildCallId()
    {
        Span<byte> bytes = stackalloc byte[12];
        RandomNumberGenerator.Fill(bytes);
        return "call_" + Convert.ToHexString(bytes).ToLowerInvariant();
    }

    private static JsonObject? TryParseToolCallsObject(string text)
    {
        JsonNode? parsed;
        try { parsed = JsonNode.Parse(text); }
        catch (System.Text.Json.JsonException) { return null; }
        if (parsed is JsonObject obj && obj["tool_calls"] is JsonArray) return obj;
        return null;
    }

    private static JsonObject? FindToolCallsJson(string reply)
    {
        // 1. ```json fenced blocks, in order.
        var idx = 0;
        while (true)
        {
            var start = reply.IndexOf("```json", idx, StringComparison.OrdinalIgnoreCase);
            if (start < 0) break;
            var contentStart = start + "```json".Length;
            var end = reply.IndexOf("```", contentStart, StringComparison.Ordinal);
            if (end < 0) break;
            var candidate = TryParseToolCallsObject(reply[contentStart..end]);
            if (candidate is not null) return candidate;
            idx = end + 3;
        }
        // 2. Bare ``` fenced blocks, in order.
        idx = 0;
        while (true)
        {
            var start = reply.IndexOf("```", idx, StringComparison.Ordinal);
            if (start < 0) break;
            var contentStart = start + 3;
            var end = reply.IndexOf("```", contentStart, StringComparison.Ordinal);
            if (end < 0) break;
            var candidate = TryParseToolCallsObject(reply[contentStart..end]);
            if (candidate is not null) return candidate;
            idx = end + 3;
        }
        // 3. Raw JSON object anywhere in the reply (brace matching with
        // string awareness, so braces inside quoted strings do not confuse
        // the scan).
        for (var i = 0; i < reply.Length; i++)
        {
            if (reply[i] != '{') continue;
            var depth = 0;
            var inString = false;
            var escaped = false;
            var j = i;
            for (; j < reply.Length; j++)
            {
                var ch = reply[j];
                if (inString)
                {
                    if (escaped) escaped = false;
                    else if (ch == '\\') escaped = true;
                    else if (ch == '"') inString = false;
                    continue;
                }
                if (ch == '"') inString = true;
                else if (ch == '{') depth++;
                else if (ch == '}')
                {
                    depth--;
                    if (depth == 0) break;
                }
            }
            if (depth == 0 && j < reply.Length)
            {
                var candidate = TryParseToolCallsObject(reply[i..(j + 1)]);
                if (candidate is not null) return candidate;
            }
        }
        return null;
    }
}
