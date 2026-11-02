using Muse2Api.Agent;
using System.Text;
using System.Text.Json.Nodes;

namespace Muse2Api.Tests;

public class SendFileTests
{
    [Fact]
    public void ActionsEnvelopeMapsSendFile()
    {
        var call = Assert.Single(ToolCallParser.Parse(
            """{"actions":[{"action":"send_file","path":"clips/shot_0031.mp4"}]}"""));
        Assert.Equal("send_file", call.Name);
        Assert.Equal("clips/shot_0031.mp4", call.Args["path"]?.GetValue<string>());
    }

    [Fact]
    public void ToolCallsEnvelopeAndLegacyBlockMapSendFile()
    {
        var fromEnvelope = Assert.Single(ToolCallParser.Parse(
            """{"tool_calls":[{"name":"send_file","arguments":{"path":"a.mp4"}}]}"""));
        Assert.Equal("send_file", fromEnvelope.Name);
        var fromBlock = Assert.Single(ToolCallParser.Parse(
            "```tool\n{\"name\": \"send_file\", \"path\": \"a.mp4\"}\n```"));
        Assert.Equal("send_file", fromBlock.Name);
    }

    [Fact]
    public async Task ValidFileProducesExactlyOneGatewayFilePart()
    {
        using var dir = new TempDirectory();
        var bytes = Encoding.UTF8.GetBytes("fake-mp4-bytes");
        await File.WriteAllBytesAsync(dir.File("shot_0031.mp4"), bytes);
        var executor = new ToolExecutor(dir.Root);
        var result = await executor.ExecuteAsync(
            new("send_file", new() { ["path"] = "shot_0031.mp4" }));
        Assert.StartsWith("sent file: shot_0031.mp4 (", result);
        var sent = executor.LastSentFile;
        Assert.NotNull(sent);
        Assert.Equal("shot_0031.mp4", sent.Filename);
        Assert.Equal("video/mp4", sent.Mime);
        Assert.StartsWith("data:video/mp4;base64,", sent.DataUrl);
        Assert.Equal(bytes, Convert.FromBase64String(sent.DataUrl["data:video/mp4;base64,".Length..]));
    }

    [Theory]
    [InlineData("doc.pdf", "application/pdf")]
    [InlineData("pic.png", "image/png")]
    [InlineData("pic.webp", "image/webp")]
    [InlineData("arch.zip", "application/zip")]
    [InlineData("weird.xyz", "application/octet-stream")]
    public async Task MimeComesFromExtensionWithSafeDefault(string name, string mime)
    {
        using var dir = new TempDirectory();
        await File.WriteAllTextAsync(dir.File(name), "x");
        var executor = new ToolExecutor(dir.Root);
        await executor.ExecuteAsync(new("send_file", new() { ["path"] = name }));
        var sent = executor.LastSentFile;
        Assert.NotNull(sent);
        Assert.Equal(mime, sent.Mime);
    }

    [Theory]
    [InlineData("../outside.mp4")]
    [InlineData("/tmp/absolutely-outside.mp4")]
    public async Task PathsOutsideWorkspaceAreRejected(string path)
    {
        using var dir = new TempDirectory();
        var executor = new ToolExecutor(dir.Root);
        var result = await executor.ExecuteAsync(new("send_file", new() { ["path"] = path }));
        Assert.StartsWith("error:", result);
        Assert.Null(executor.LastSentFile);
    }

    [Fact]
    public async Task MissingDirectoryAndEmptyFilesReportClearErrors()
    {
        using var dir = new TempDirectory();
        Directory.CreateDirectory(dir.File("sub"));
        await File.WriteAllTextAsync(dir.File("empty.mp4"), "");
        var executor = new ToolExecutor(dir.Root);
        Assert.StartsWith("error: file not found",
            await executor.ExecuteAsync(new("send_file", new() { ["path"] = "nope.mp4" })));
        Assert.StartsWith("error: path is a directory",
            await executor.ExecuteAsync(new("send_file", new() { ["path"] = "sub" })));
        Assert.StartsWith("error: file is empty",
            await executor.ExecuteAsync(new("send_file", new() { ["path"] = "empty.mp4" })));
        Assert.Null(executor.LastSentFile);
    }

    [Fact]
    public async Task SizeLimitIsEnforcedAtExactly25MillionBytes()
    {
        using var dir = new TempDirectory();
        await File.WriteAllBytesAsync(dir.File("at-limit.mp4"), new byte[25_000_000]);
        await File.WriteAllBytesAsync(dir.File("over-limit.mp4"), new byte[25_000_001]);
        var executor = new ToolExecutor(dir.Root);
        Assert.StartsWith("sent file:",
            await executor.ExecuteAsync(new("send_file", new() { ["path"] = "at-limit.mp4" })));
        Assert.StartsWith("error: file exceeds 25 MB",
            await executor.ExecuteAsync(new("send_file", new() { ["path"] = "over-limit.mp4" })));
        Assert.Null(executor.LastSentFile);
    }

    [Fact]
    public void SendFileNeedsNoApprovalLikeOtherReadOnlyTools()
    {
        using var dir = new TempDirectory();
        var executor = new ToolExecutor(dir.Root);
        Assert.False(executor.NeedsConfirmation(new("send_file", new() { ["path"] = "a.mp4" })));
    }

    [Fact]
    public void SystemPromptAndGatewaySchemaListSendFile()
    {
        Assert.Contains("send_file", AgentClient.SystemPrompt);
        var schema = Prompt.ForLocalExecutor(new List<JsonObject>
            { new() { ["role"] = "user", ["content"] = "hello" } });
        Assert.Contains("send_file", schema);
    }

    [Fact]
    public async Task LoopAttachesFilePartToTheToolResultMessageOnly()
    {
        using var dir = new TempDirectory();
        var bytes = Encoding.UTF8.GetBytes("clip-bytes");
        await File.WriteAllBytesAsync(dir.File("shot_0031.mp4"), bytes);
        var requests = new List<List<JsonObject>>();
        var calls = 0;
        var loop = new AgentLoop(new ToolExecutor(dir.Root),
            (messages, _) =>
            {
                requests.Add(messages.Select(m => (JsonObject)m.DeepClone()).ToList());
                return Task.FromResult(calls++ == 0
                    ? ("", new List<ToolCall> { new("send_file", new() { ["path"] = "shot_0031.mp4" }) })
                    : ("hoàn thành", new List<ToolCall>()));
            },
            (_, _) => Task.FromResult(true),
            _ => { });
        Assert.True(await loop.RunAsync("test"));
        Assert.Equal(2, requests.Count);
        var fileParts = requests[1]
            .Where(m => m["role"]?.ToString() == "user" && m["content"] is JsonArray)
            .SelectMany(m => ((JsonArray)m["content"]!).OfType<JsonObject>())
            .Where(p => p["type"]?.ToString() == "file")
            .ToList();
        var part = Assert.Single(fileParts);
        var file = Assert.IsType<JsonObject>(part["file"]);
        Assert.Equal("shot_0031.mp4", file["filename"]?.GetValue<string>());
        Assert.Equal("video/mp4", file["mime"]?.GetValue<string>());
        var dataUrl = file["data_url"]?.GetValue<string>() ?? "";
        Assert.StartsWith("data:video/mp4;base64,", dataUrl);
        Assert.Equal(bytes, Convert.FromBase64String(dataUrl["data:video/mp4;base64,".Length..]));
    }
}
