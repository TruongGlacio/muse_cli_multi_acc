using System.Net;
using System.Text;
using System.Text.Json.Nodes;

namespace Muse2Api.Tests;

/// <summary>
/// v0.8.15: OpenAI tools translation layer for Kilo Code. Pure-function tests
/// run against the real gateway DLL; the integration tests below run real
/// HTTP requests against a scripted driver (no real account, no muse.ai).
/// The gateway NEVER executes tools: these tests assert translation only.
/// </summary>
public class OpenAiToolsTests
{
    private static List<OpenAiToolSpec> Specs(params (string Name, string Desc, string Params)[] tools)
        => tools.Select(t => new OpenAiToolSpec(t.Name, t.Desc, t.Params)).ToList();

    private static JsonObject ToolsBody(JsonArray messages, JsonArray tools, string? toolChoice = null, bool? parallel = null, bool stream = false)
    {
        var body = new JsonObject
        {
            ["model"] = "muse-chat",
            ["messages"] = messages,
            ["tools"] = tools,
            ["stream"] = stream,
        };
        if (toolChoice is not null) body["tool_choice"] = toolChoice;
        if (parallel is not null) body["parallel_tool_calls"] = parallel.Value;
        return body;
    }

    private static JsonArray OneTool(string name = "read_file", string parameters = """{"type":"object","properties":{"path":{"type":"string"}}}""")
        => new(new JsonObject
        {
            ["type"] = "function",
            ["function"] = new JsonObject
            {
                ["name"] = name,
                ["description"] = "Read a file",
                ["parameters"] = JsonNode.Parse(parameters),
            },
        });

    // ---------- pure: ParseToolSpecs ----------

    [Fact]
    public void ParseToolSpecs_NullOrEmpty_IsNotToolsMode()
    {
        Assert.Null(OpenAiTools.ParseToolSpecs(null));
        Assert.Null(OpenAiTools.ParseToolSpecs(new JsonArray()));
    }

    [Fact]
    public void ParseToolSpecs_SkipsMalformedEntriesButKeepsValidOnes()
    {
        var specs = OpenAiTools.ParseToolSpecs(new JsonArray(
            new JsonObject { ["type"] = "function", ["function"] = new JsonObject { ["name"] = "read_file" } },
            new JsonObject { ["type"] = "function" },
            new JsonObject { ["type"] = "other", ["function"] = new JsonObject { ["name"] = "nope" } },
            "not-an-object"));
        Assert.Equal(new[] { "read_file" }, specs!.Select(s => s.Name));
    }

    [Fact]
    public void ParseToolSpecs_AllMalformed_IsNotToolsMode()
    {
        Assert.Null(OpenAiTools.ParseToolSpecs(new JsonArray(
            new JsonObject { ["type"] = "function" })));
    }

    // ---------- pure: RenderCatalog ----------

    [Fact]
    public void RenderCatalog_ListsEveryToolWithDescriptionAndParameters()
    {
        var catalog = OpenAiTools.RenderCatalog(Specs(
            ("read_file", "Read a file", """{"type":"object"}"""),
            ("write_file", "", """{"type":"object"}""")));
        Assert.Contains("read_file", catalog);
        Assert.Contains("Read a file", catalog);
        Assert.Contains("write_file", catalog);
        Assert.Contains("tool_calls", catalog);
    }

    // ---------- pure: TryExtractCalls ----------

    [Fact]
    public void Extract_FencedJson_ReturnsCallsWithStringArguments()
    {
        var reply = "```json\n{\"tool_calls\":[{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.txt\"}}]}\n```";
        var calls = OpenAiTools.TryExtractCalls(reply, Specs(("read_file", "", "{}")),
            new OpenAiToolChoice(OpenAiToolChoiceKind.Auto), true);
        var call = Assert.Single(calls!);
        Assert.Equal("read_file", call.Name);
        Assert.Equal("{\"path\":\"a.txt\"}", call.ArgumentsJson);
    }

    [Fact]
    public void Extract_RawJson_AndOpenAiNestedShape_AreAccepted()
    {
        var raw = OpenAiTools.TryExtractCalls(
            "here: {\"tool_calls\":[{\"name\":\"read_file\",\"arguments\":\"{\\\"path\\\":\\\"b.txt\\\"}\"}]}",
            Specs(("read_file", "", "{}")),
            new OpenAiToolChoice(OpenAiToolChoiceKind.Auto), true);
        Assert.Equal("{\"path\":\"b.txt\"}", Assert.Single(raw!).ArgumentsJson);

        var nested = OpenAiTools.TryExtractCalls(
            "```json\n{\"tool_calls\":[{\"id\":\"x\",\"type\":\"function\",\"function\":{\"name\":\"read_file\",\"arguments\":\"{}\"}}]}\n```",
            Specs(("read_file", "", "{}")),
            new OpenAiToolChoice(OpenAiToolChoiceKind.Auto), true);
        Assert.Equal("{}", Assert.Single(nested!).ArgumentsJson);
    }

    [Fact]
    public void Extract_MissingArguments_DefaultsToEmptyObject()
    {
        var calls = OpenAiTools.TryExtractCalls(
            "```json\n{\"tool_calls\":[{\"name\":\"read_file\"}]}\n```",
            Specs(("read_file", "", "{}")),
            new OpenAiToolChoice(OpenAiToolChoiceKind.Auto), true);
        Assert.Equal("{}", Assert.Single(calls!).ArgumentsJson);
    }

    [Theory]
    [InlineData("```json\n{\"tool_calls\":[{\"name\":\"unknown_tool\",\"arguments\":{}}]}\n```")]
    [InlineData("```json\n{\"tool_calls\":[{\"name\":\"read_file\",\"arguments\":\"not json\"}]}\n```")]
    [InlineData("```json\n{\"tool_calls\":[{\"name\":\"read_file\",\"arguments\":[1,2]}]}\n```")]
    [InlineData("```json\n{\"tool_calls\":[{\"name\":\"read_file\",\"arguments\":{}},{\"name\":\"unknown_tool\",\"arguments\":{}}]}\n```")]
    [InlineData("plain text, no block at all")]
    public void Extract_InvalidBlockOrUnknownName_FallsBackToText(string reply)
    {
        Assert.Null(OpenAiTools.TryExtractCalls(reply, Specs(("read_file", "", "{}")),
            new OpenAiToolChoice(OpenAiToolChoiceKind.Auto), true));
    }

    [Fact]
    public void Extract_ParallelFalse_KeepsOnlyFirstValidCall()
    {
        var reply = "```json\n{\"tool_calls\":[{\"name\":\"read_file\",\"arguments\":{}},{\"name\":\"write_file\",\"arguments\":{}}]}\n```";
        var calls = OpenAiTools.TryExtractCalls(reply, Specs(("read_file", "", "{}"), ("write_file", "", "{}")),
            new OpenAiToolChoice(OpenAiToolChoiceKind.Auto), false);
        Assert.Equal(new[] { "read_file" }, calls!.Select(c => c.Name));
    }

    [Fact]
    public void Extract_ToolChoiceNone_NeverReturnsCalls()
    {
        var reply = "```json\n{\"tool_calls\":[{\"name\":\"read_file\",\"arguments\":{}}]}\n```";
        Assert.Null(OpenAiTools.TryExtractCalls(reply, Specs(("read_file", "", "{}")),
            new OpenAiToolChoice(OpenAiToolChoiceKind.None), true));
    }

    [Fact]
    public void Extract_ToolChoiceSpecific_KeepsOnlyThatTool()
    {
        var reply = "```json\n{\"tool_calls\":[{\"name\":\"read_file\",\"arguments\":{}},{\"name\":\"write_file\",\"arguments\":{}}]}\n```";
        var specs = Specs(("read_file", "", "{}"), ("write_file", "", "{}"));
        var kept = OpenAiTools.TryExtractCalls(reply, specs,
            new OpenAiToolChoice(OpenAiToolChoiceKind.Specific, "write_file"), true);
        Assert.Equal(new[] { "write_file" }, kept!.Select(c => c.Name));
        Assert.Null(OpenAiTools.TryExtractCalls(reply, specs,
            new OpenAiToolChoice(OpenAiToolChoiceKind.Specific, "other_tool"), true));
    }

    [Fact]
    public void ParseToolChoice_MapsStringAndObjectForms()
    {
        Assert.Equal(OpenAiToolChoiceKind.None,
            OpenAiTools.ParseToolChoice(JsonNode.Parse("\"none\""))!.Kind);
        Assert.Equal(OpenAiToolChoiceKind.Auto,
            OpenAiTools.ParseToolChoice(JsonNode.Parse("\"auto\""))!.Kind);
        Assert.Equal(OpenAiToolChoiceKind.Auto,
            OpenAiTools.ParseToolChoice(null).Kind);
        var specific = OpenAiTools.ParseToolChoice(JsonNode.Parse(
            "{\"type\":\"function\",\"function\":{\"name\":\"read_file\"}}"))!;
        Assert.Equal(OpenAiToolChoiceKind.Specific, specific.Kind);
        Assert.Equal("read_file", specific.FunctionName);
    }

    [Fact]
    public void BuildCallId_HasOpenAiShape()
    {
        var id = OpenAiTools.BuildCallId();
        Assert.StartsWith("call_", id);
        Assert.Equal(29, id.Length);
        Assert.All(id["call_".Length..], c => Assert.True(char.IsAsciiHexDigit(c)));
    }

    // ---------- pure: Flatten with tool history ----------

    [Fact]
    public void Flatten_ToolHistory_RendersNamesAndResults()
    {
        var messages = new List<JsonObject>
        {
            new() { ["role"] = "user", ["content"] = "fix the bug" },
            new()
            {
                ["role"] = "assistant",
                ["content"] = "",
                ["tool_calls"] = new JsonArray(new JsonObject
                {
                    ["id"] = "call_abc",
                    ["type"] = "function",
                    ["function"] = new JsonObject
                    {
                        ["name"] = "read_file",
                        ["arguments"] = "{\"path\":\"a.txt\"}",
                    },
                }),
            },
            new() { ["role"] = "tool", ["tool_call_id"] = "call_abc", ["content"] = "file content here" },
        };
        var flat = Prompt.Flatten(messages);
        Assert.Contains("[Assistant called tool read_file with arguments {\"path\":\"a.txt\"}]", flat.Text);
        Assert.Contains("Tool result for read_file:", flat.Text);
        Assert.Contains("file content here", flat.Text);
    }

    [Fact]
    public void Flatten_ToolMessageWithoutKnownId_FallsBackToIdLabel()
    {
        var messages = new List<JsonObject>
        {
            new() { ["role"] = "user", ["content"] = "go" },
            new() { ["role"] = "tool", ["tool_call_id"] = "call_unknown", ["content"] = "result" },
        };
        Assert.Contains("Tool result for call_unknown:", Prompt.Flatten(messages).Text);
    }

    [Fact]
    public void Flatten_PlainChat_IsUnchanged()
    {
        var single = Prompt.Flatten(new List<JsonObject>
            { new() { ["role"] = "user", ["content"] = "hello" } });
        Assert.Equal("hello", single.Text);
    }

    // ---------- integration: real HTTP + scripted driver ----------

    internal sealed class ScriptedDriver : IMuseDriver
    {
        public string Name => "scripted";
        public bool RequiresAccount => false;
        public DriverCapabilities Capabilities => new(Chat: true);
        public Func<ChatRequest, string> Reply { get; init; } = _ => "";
        public List<string> Prompts { get; } = new();

        public async IAsyncEnumerable<string> ChatStream(Account account, ChatRequest req)
        {
            Prompts.Add(req.Prompt);
            var reply = Reply(req);
            for (var i = 0; i < reply.Length; i += 8)
            {
                req.Cancel.ThrowIfCancellationRequested();
                await Task.Delay(1, req.Cancel);
                yield return reply.Substring(i, Math.Min(8, reply.Length - i));
            }
        }
    }

    private static JsonArray UserMessage(string text)
        => new(new JsonObject { ["role"] = "user", ["content"] = text });

    [Fact]
    public async Task Integration_ToolCallReply_ReturnsOpenAiToolCalls()
    {
        var driver = new ScriptedDriver
        {
            Reply = _ => "```json\n{\"tool_calls\":[{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.txt\"}}]}\n```",
        };
        await using var host = await GatewayHost.Start(driver);
        var body = ToolsBody(UserMessage("read a.txt"), OneTool());
        using var response = await host.Post("/v1/chat/completions", body.ToJsonString());
        response.EnsureSuccessStatusCode();
        var json = JsonNode.Parse(await response.Content.ReadAsStringAsync())!;
        var message = json["choices"]![0]!["message"]!;
        Assert.Equal("tool_calls", json["choices"]![0]!["finish_reason"]!.GetValue<string>());
        Assert.Equal("", message["content"]!.GetValue<string>());
        var fn = message["tool_calls"]![0]!["function"]!;
        Assert.Equal("read_file", fn["name"]!.GetValue<string>());
        Assert.Equal("{\"path\":\"a.txt\"}", fn["arguments"]!.GetValue<string>());
        Assert.StartsWith("call_", message["tool_calls"]![0]!["id"]!.GetValue<string>());
        Assert.Contains("read_file", driver.Prompts[0]);
        Assert.Contains("tool_calls", driver.Prompts[0]);
    }

    [Fact]
    public async Task Integration_PlainReply_WithToolsDeclared_ReturnsText()
    {
        var driver = new ScriptedDriver { Reply = _ => "just an answer" };
        await using var host = await GatewayHost.Start(driver);
        using var response = await host.Post("/v1/chat/completions",
            ToolsBody(UserMessage("hello"), OneTool()).ToJsonString());
        response.EnsureSuccessStatusCode();
        var json = JsonNode.Parse(await response.Content.ReadAsStringAsync())!;
        Assert.Equal("stop", json["choices"]![0]!["finish_reason"]!.GetValue<string>());
        Assert.Equal("just an answer", json["choices"]![0]!["message"]!["content"]!.GetValue<string>());
        Assert.Null(json["choices"]![0]!["message"]!["tool_calls"]);
    }

    [Fact]
    public async Task Integration_UnknownToolName_FallsBackToText()
    {
        var reply = "```json\n{\"tool_calls\":[{\"name\":\"delete_everything\",\"arguments\":{}}]}\n```";
        var driver = new ScriptedDriver { Reply = _ => reply };
        await using var host = await GatewayHost.Start(driver);
        using var response = await host.Post("/v1/chat/completions",
            ToolsBody(UserMessage("go"), OneTool()).ToJsonString());
        response.EnsureSuccessStatusCode();
        var json = JsonNode.Parse(await response.Content.ReadAsStringAsync())!;
        Assert.Equal("stop", json["choices"]![0]!["finish_reason"]!.GetValue<string>());
        Assert.Equal(reply, json["choices"]![0]!["message"]!["content"]!.GetValue<string>());
    }

    [Fact]
    public async Task Integration_ToolResultRound_PromptContainsHistory()
    {
        var driver = new ScriptedDriver { Reply = _ => "done" };
        await using var host = await GatewayHost.Start(driver);
        var messages = new JsonArray(
            new JsonObject { ["role"] = "user", ["content"] = "fix the bug" },
            new JsonObject
            {
                ["role"] = "assistant",
                ["content"] = "",
                ["tool_calls"] = new JsonArray(new JsonObject
                {
                    ["id"] = "call_abc",
                    ["type"] = "function",
                    ["function"] = new JsonObject { ["name"] = "read_file", ["arguments"] = "{\"path\":\"a.txt\"}" },
                }),
            },
            new JsonObject { ["role"] = "tool", ["tool_call_id"] = "call_abc", ["content"] = "file content here" });
        using var response = await host.Post("/v1/chat/completions",
            ToolsBody(messages, OneTool()).ToJsonString());
        response.EnsureSuccessStatusCode();
        Assert.Contains("Tool result for read_file:", driver.Prompts[0]);
        Assert.Contains("file content here", driver.Prompts[0]);
        Assert.Contains("[Assistant called tool read_file", driver.Prompts[0]);
    }

    [Fact]
    public async Task Integration_StreamedToolCallReply_EmitsToolCallsSse()
    {
        var driver = new ScriptedDriver
        {
            Reply = _ => "```json\n{\"tool_calls\":[{\"name\":\"read_file\",\"arguments\":{\"path\":\"a.txt\"}}]}\n```",
        };
        await using var host = await GatewayHost.Start(driver);
        var body = ToolsBody(UserMessage("read a.txt"), OneTool(), stream: true);
        using var response = await host.Client.PostAsync("/v1/chat/completions",
            new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"));
        response.EnsureSuccessStatusCode();
        Assert.Equal("text/event-stream", response.Content.Headers.ContentType!.MediaType);
        var sse = await response.Content.ReadAsStringAsync();
        Assert.Contains("\"tool_calls\"", sse);
        Assert.Contains("read_file", sse);
        Assert.Contains("\"finish_reason\":\"tool_calls\"", sse);
        Assert.Contains("data: [DONE]", sse);
    }

    [Fact]
    public async Task Integration_StreamedPlainReply_EmitsContentSse()
    {
        var driver = new ScriptedDriver { Reply = _ => "hello world" };
        await using var host = await GatewayHost.Start(driver);
        var body = ToolsBody(UserMessage("hi"), OneTool(), stream: true);
        using var response = await host.Client.PostAsync("/v1/chat/completions",
            new StringContent(body.ToJsonString(), Encoding.UTF8, "application/json"));
        response.EnsureSuccessStatusCode();
        var sse = await response.Content.ReadAsStringAsync();
        Assert.Contains("hello world", sse);
        Assert.Contains("\"finish_reason\":\"stop\"", sse);
        Assert.Contains("data: [DONE]", sse);
    }

    [Fact]
    public async Task Integration_NoToolsRequest_BehaviourIsUnchanged()
    {
        var driver = new ScriptedDriver { Reply = _ => "plain answer" };
        await using var host = await GatewayHost.Start(driver);
        var body = new JsonObject
        {
            ["model"] = "muse-chat",
            ["messages"] = UserMessage("hello"),
        };
        using var response = await host.Post("/v1/chat/completions", body.ToJsonString());
        response.EnsureSuccessStatusCode();
        var json = JsonNode.Parse(await response.Content.ReadAsStringAsync())!;
        Assert.Equal("plain answer", json["choices"]![0]!["message"]!["content"]!.GetValue<string>());
        Assert.DoesNotContain("tools available", driver.Prompts[0]);
    }
}
