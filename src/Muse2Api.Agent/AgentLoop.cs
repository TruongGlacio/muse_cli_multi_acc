using System.Text.Json.Nodes;

namespace Muse2Api.Agent;

public sealed record AgentEvent(string Kind, string Text, string? Tool = null, string? Path = null);

/// <summary>Shared, cancellable chat/tool loop for the desktop and terminal.</summary>
public sealed class AgentLoop
{
    private readonly ToolExecutor _tools;
    private readonly Func<List<JsonObject>, CancellationToken, Task<(string Text, List<ToolCall> Calls)>> _chat;
    private readonly Func<ToolApproval, CancellationToken, Task<bool>> _confirm;
    private readonly Action<AgentEvent> _observe;
    private readonly int? _maxSteps;
    private int _running;
    public List<JsonObject> History { get; } = new();

    public AgentLoop(ToolExecutor tools, Func<List<JsonObject>, Task<(string, List<ToolCall>)>> chat,
        Func<ToolCall, bool> confirm, Action<string> output, int? maxSteps = null)
        : this(tools, (messages, _) => chat(messages), (approval, _) => Task.FromResult(confirm(approval.Call)),
            e => { if (e.Kind is not ("assistant_start" or "command_output")) output(e.Kind == "assistant" ? $"agent> {e.Text}" : e.Text); }, maxSteps)
    { }

    public AgentLoop(ToolExecutor tools,
        Func<List<JsonObject>, CancellationToken, Task<(string Text, List<ToolCall> Calls)>> chat,
        Func<ToolApproval, CancellationToken, Task<bool>> confirm, Action<AgentEvent> observe, int? maxSteps = null)
    {
        if (maxSteps is < 1) throw new ArgumentOutOfRangeException(nameof(maxSteps));
        _tools = tools; _chat = chat; _confirm = confirm; _observe = observe; _maxSteps = maxSteps;
    }

    public async Task<bool> RunAsync(string prompt, CancellationToken cancel = default, List<string>? images = null)
    {
        if (string.IsNullOrWhiteSpace(prompt) && images is not { Count: > 0 }) throw new ArgumentException("Nội dung không được để trống.");
        if (prompt.Length > 32000) throw new ArgumentException("Yêu cầu quá dài (tối đa 32000 ký tự).");
        if (Interlocked.CompareExchange(ref _running, 1, 0) != 0) throw new InvalidOperationException("Agent is already running");
        _tools.BeginAgentTurn();
        var messages = new List<JsonObject>();
        string? pendingTool = null;
        try
        {
            var context = await _tools.WorkspaceContextAsync(cancel);
            messages.Add(new() { ["role"] = "system", ["content"] = AgentClient.SystemPrompt + "\n\n" + context + "\n\nCURRENT LOCAL TASK (keep working on this):\n" + prompt });
            messages.AddRange(History.Select(m =>
            {
                var copy = (JsonObject)m.DeepClone();
                if (copy["role"]?.ToString() == "assistant")
                {
                    var previous = copy["content"]?.ToString() ?? "";
                    if (ToolCallParser.Parse(previous).Any(c => c.Name == "__parse_error__"))
                        copy["content"] = "[Invalid plan: rejected before execution.]";
                    else if (LocalTaskIntent.IsEnvironmentConfusion(previous))
                        copy["content"] = "[Previous reply confused the web VM with the local desktop. It is not evidence about this workspace. Use the local executor receipts.]";
                }
                return copy;
            }));
            JsonNode userMessageContent = JsonValue.Create(prompt)!;
            if (images is { Count: > 0 })
            {
                var imageBatch = Guid.NewGuid().ToString("N");
                var parts = new JsonArray();
                parts.Add(new JsonObject { ["type"] = "text", ["text"] = prompt });
                foreach (var url in images) parts.Add(new JsonObject { ["type"] = "image_url", ["attachment_id"] = imageBatch, ["image_url"] = new JsonObject { ["url"] = url } });
                userMessageContent = parts;
            }
            messages.Add(new() { ["role"] = "user", ["content"] = userMessageContent });
            var failures = new Dictionary<string, int>();
            var required = LocalTaskIntent.Required(prompt);
            var evidence = LocalWork.None;
            var protocolRetries = 0;
            var malformedReplies = 0;
            var declined = false;
            var verifiedNoChange = false;
            string? previousObservation = null;
            var repeatedObservations = 0;
            for (long step = 0; !_maxSteps.HasValue || step < _maxSteps.Value; step++)
            {
                cancel.ThrowIfCancellationRequested();
                // Long tasks keep a bounded local transcript as well as a
                // bounded request. The current goal remains in the system turn.
                if (messages.Count > 201) messages.RemoveRange(1, messages.Count - 201);
                _observe(new("assistant_start", "Đang suy nghĩ…"));
                var request = FitContext(messages);
                // This is a live desktop request, not a request to discuss a
                // pasted transcript. Keep the next action explicit after file data.
                request.Add(new()
                {
                    ["role"] = "user",
                    ["content"] = "APP_STATE:\n" + new JsonObject
                    {
                        ["goal"] = prompt, ["workspace"] = _tools.Root, ["observed_operations"] = evidence.ToString(),
                        ["remaining"] = (required & ~evidence).ToString(), ["computer_scope"] = _tools.Computer?.Context ?? "unavailable",
                        ["next"] = "Generate the next operation as JSON data for the app. Continue after reading; ask only for information genuinely missing. Do not claim native execution of supplied observations.",
                    }.ToJsonString(),
                });
                var (text, calls) = await _chat(request, cancel);
                cancel.ThrowIfCancellationRequested();
                calls = calls.Select(ToolCallParser.Validate).ToList();
                messages.Add(new() { ["role"] = "assistant", ["content"] = text });
                if (calls.Any(call => call.Name == "__parse_error__"))
                {
                    // Formatting errors are not failed OS operations. Never run a
                    // valid prefix, and never feed the broken code back as a plan.
                    messages[^1]["content"] = "[Invalid plan: rejected before execution.]\n" + text;
                    var errors = string.Join("\n", calls.Where(c => c.Name == "__parse_error__").Select(c => c.Args["error"]?.ToString()));
                    _observe(new("protocol_error", errors));
                    if (++malformedReplies >= 3)
                    {
                        _observe(new("incomplete", "Muse chưa gửi được thao tác đúng định dạng sau 3 lần phản hồi. Không thực hiện thao tác nào từ các phản hồi lỗi; những bước đã thành công trước đó vẫn được giữ lại."));
                        return false;
                    }
                    messages.Add(new()
                    {
                        ["role"] = "user", ["content"] = "APP_PROTOCOL_REPAIR:\n" + new JsonObject
                        {
                            ["error"] = errors, ["max_actions"] = 1, ["executed_from_rejected_reply"] = false,
                            ["instruction"] = "Resend only ONE small action in a json code fence. JSON-escape code quotes, backslashes and newlines. Do not repeat the rejected batch. No source code has been inferred or repaired by the app.",
                        }.ToJsonString(),
                    });
                    _observe(new("protocol_retry", "Muse đang gửi lại thao tác đúng định dạng. Chưa thực hiện thay đổi từ phản hồi lỗi…"));
                    continue;
                }
                malformedReplies = 0;
                var visible = ToolCallParser.StripToolBlocks(text);
                if (calls.Count == 0)
                {
                    if (string.IsNullOrWhiteSpace(text)) throw new InvalidOperationException("Model trả về câu trả lời rỗng.");
                    var missing = required & ~evidence;
                    if (missing == LocalWork.Edit && verifiedNoChange && LocalTaskIntent.ExplainsNoChange(text)) missing = LocalWork.None;
                    if (!declined && (missing != LocalWork.None && !LocalTaskIntent.IsClarification(text)
                        || required != LocalWork.None && LocalTaskIntent.IsEnvironmentConfusion(text)))
                    {
                        messages[^1]["content"] = "[Unverified reply: the required local operations did not run.]\n" + text;
                        _observe(new("assistant", ""));
                        if (protocolRetries++ >= 2)
                        {
                            _observe(new("incomplete", "Muse chưa thực hiện đủ thao tác trên dự án này. Chưa thể xác nhận hoàn tất; xem Terminal để biết các bước đã chạy."));
                            return false;
                        }
                        _observe(new("protocol_retry", "Đang yêu cầu Muse chuyển câu trả lời thành thao tác trên dự án…"));
                        messages.Add(new()
                        {
                            ["role"] = "user",
                            ["content"] = $"LOCAL EXECUTOR: The requested local work is still pending ({missing}). Your built-in VM is not the user's machine. Do not claim completion or ask for uploaded files. "
                                + (missing.HasFlag(LocalWork.Edit) && evidence.HasFlag(LocalWork.Read)
                                    ? "You have read local files. Now emit edit_file/write_file requests for the actual requested changes; do not stop at a plan. "
                                    : (missing & (LocalWork.Command | LocalWork.CommandVerified)) != 0 ? "Emit run_command for the required check, or process_status until an already started check exits successfully. "
                                    : (missing & LocalTaskIntent.ComputerWork) != 0 ? "Complete the remaining UI operations: enter the requested text, invoke/click the requested button, then computer_assert the requested resulting label/value. An inspect or input alone does not complete a UI test. Inspect again if element IDs expired. "
                                    : "Emit read_file/list_files to inspect the actual project, or summarize verified receipts if all requested work is already done. ")
                                + $"Use a JSON code block with tool_calls and name/arguments. Wait for the external local result. Current task: {prompt}",
                        });
                        continue;
                    }
                    _observe(new("assistant", visible));
                    if (LocalTaskIntent.IsClarification(text)) { _observe(new("waiting_input", "Muse cần thêm thông tin. Bạn có thể trả lời ngay trong ô chat.")); return false; }
                    _observe(new("completed", "Hoàn thành lượt chat."));
                    return true;
                }
                _observe(new("assistant", visible));
                if (calls.Count > 16) throw new InvalidOperationException("Model requested too many tool calls in one step (limit 16)");
                foreach (var call in calls)
                {
                    cancel.ThrowIfCancellationRequested();
                    pendingTool = call.Name;
                    var path = call.Args["path"] is JsonValue value && value.TryGetValue<string>(out var filePath) ? filePath : null;
                    _observe(new("tool_start", _tools.Describe(call), call.Name, path));
                    string result;
                    try
                    {
                        var prepared = await _tools.PrepareForAgentAsync(call, cancel);
                        if (_tools.NeedsConfirmation(call) && !await _confirm(prepared, cancel))
                        {
                            declined = true;
                            result = "error: user declined this step. Do not retry this action unless the user explicitly requests it.";
                        }
                        else result = await _tools.ExecutePreparedAsync(prepared, cancel,
                            output => _observe(new("command_output", output, call.Name)));
                    }
                    catch (OperationCanceledException) { throw; }
                    catch (Exception ex) { result = "error: " + ex.Message; }
                    var receipt = $"Tool result for {call.Name}:\n{result}";
                    // v0.8.22: a successful send_file rides to the gateway as
                    // a file part on this tool-result user message, exactly
                    // the path the extension's send_file uses (gateway Chat
                    // gathers file parts from ALL messages via Flatten, so
                    // no gateway change is needed). The part is attached
                    // once, here: History strips it (WithoutImage) so later
                    // turns do not re-attach, and re-sends inside this turn
                    // are deduped by the gateway's FileHash.
                    JsonNode resultContent = call.Name.StartsWith("computer_") && _tools.LastComputerImage is { } image
                        ? new JsonArray(new JsonObject { ["type"] = "text", ["text"] = receipt }, new JsonObject { ["type"] = "image_url", ["attachment_id"] = Guid.NewGuid().ToString("N"), ["image_url"] = new JsonObject { ["url"] = image } })
                        : call.Name == "send_file" && _tools.LastSentFile is { } sent
                        ? new JsonArray(new JsonObject { ["type"] = "text", ["text"] = receipt },
                            new JsonObject { ["type"] = "file", ["file"] = new JsonObject { ["filename"] = sent.Filename, ["mime"] = sent.Mime, ["data_url"] = sent.DataUrl } })
                        : JsonValue.Create(receipt);
                    messages.Add(new() { ["role"] = "user", ["content"] = resultContent });
                    _observe(new("tool_result", result, call.Name, path));
                    // Stop a repeated observation loop, not productive long tasks
                    // or a running command that legitimately has no new output.
                    var observation = call.Name + call.Args.ToJsonString() + result;
                    repeatedObservations = observation == previousObservation ? repeatedObservations + 1 : 1;
                    previousObservation = observation;
                    if (!ToolOutcome.IsFailure(result) && !ToolOutcome.IsRunning(result) && repeatedObservations >= 3)
                    {
                        _observe(new("incomplete", "Đã dừng vì Muse lặp lại cùng thao tác và kết quả, không có tiến triển. Những thay đổi đã thực hiện vẫn được giữ lại; xem Terminal để biết chi tiết."));
                        return false;
                    }
                    if (result.StartsWith("error: user declined", StringComparison.OrdinalIgnoreCase))
                    {
                        _observe(new("declined", "Đã dừng phần việc bạn chưa cho phép. Những thao tác đã hoàn tất trước đó vẫn được giữ lại."));
                        return false;
                    }
                    if (!ToolOutcome.IsFailure(result))
                    {
                        if (call.Name is "write_file" or "edit_file" && result.StartsWith("unchanged:")) verifiedNoChange = true;
                        var previousEvidence = evidence;
                        var operationEvidence = LocalTaskIntent.Evidence(call.Name);
                        if (operationEvidence.HasFlag(LocalWork.ComputerInteract)) evidence &= ~(LocalWork.ComputerAssert | LocalWork.ComputerScreenshot);
                        if (call.Name is "edit_file" or "write_file" && _tools.LastFileChangeApplied) evidence &= ~LocalWork.CommandVerified;
                        if (call.Name is not ("edit_file" or "write_file") || _tools.LastFileChangeApplied)
                            evidence |= operationEvidence;
                        if (ToolOutcome.ExitedSuccessfully(result)) evidence |= LocalWork.CommandVerified;
                        if (call.Name == "run_command" && _tools.LastCommandChangedFiles.Count > 0) evidence |= LocalWork.Edit;
                        if (evidence != previousEvidence) protocolRetries = 0;
                    }
                    pendingTool = null;
                    if (ToolOutcome.IsFailure(result))
                    {
                        var key = call.Name + call.Args.ToJsonString();
                        failures[key] = failures.GetValueOrDefault(key) + 1;
                        if (failures.Count > 256) failures.Remove(failures.Keys.First());
                        if (failures[key] >= 2)
                        {
                            _observe(new("incomplete", "Đã dừng vì cùng một thao tác thất bại hai lần. Hãy xem kết quả và điều chỉnh yêu cầu."));
                            return false;
                        }
                    }
                }
            }
            _observe(new("incomplete", $"Đã hết {_maxSteps} bước; nhiệm vụ chưa hoàn thành."));
            return false;
        }
        catch (OperationCanceledException)
        {
            messages.Add(new() { ["role"] = "user", ["content"] = pendingTool is null ? "The user stopped this turn." : $"Tool result for {pendingTool}: cancelled by user; inspect the current workspace before continuing." });
            _observe(new("cancelled", "Đã dừng theo yêu cầu."));
            throw;
        }
        finally
        {
            if (messages.Count > 1)
            {
                History.Clear();
                History.AddRange(messages.Skip(1).TakeLast(200).Select(m => WithoutImage(m)));
            }
            Interlocked.Exchange(ref _running, 0);
        }
    }

    private static List<JsonObject> FitContext(List<JsonObject> messages)
    {
        var selected = new List<JsonObject>();
        var size = messages[0].ToJsonString().Length;
        var keptImage = false;
        foreach (var original in messages.Skip(1).Reverse())
        {
            var hasImage = original["content"] is JsonArray parts && parts.OfType<JsonObject>().Any(p => p["type"]?.ToString() == "image_url");
            var message = hasImage && keptImage ? WithoutImage(original) : original;
            var length = hasImage ? WithoutImage(message).ToJsonString().Length + 2048 : message.ToJsonString().Length;
            if (size + length > 96000 && selected.Count > 0) break;
            size += length;
            selected.Add(message);
            if (hasImage) keptImage = true;
        }
        selected.Reverse();
        selected.Insert(0, (JsonObject)messages[0].DeepClone());
        if (selected.Count < messages.Count)
            selected.Insert(1, new() { ["role"] = "system", ["content"] = "Older messages were omitted for context limits. Re-read project files when needed; do not assume their contents." });
        return selected;
    }

    private static JsonObject WithoutImage(JsonObject message)
    {
        var copy = (JsonObject)message.DeepClone();
        if (copy["content"] is JsonArray parts)
            copy["content"] = string.Join("\n", parts.OfType<JsonObject>().Select(p => p["type"]?.ToString() == "image_url"
                ? "[An image was attached in this turn. Reattach it if the original image is needed again.]" : p["text"]?.ToString() ?? ""));
        return copy;
    }
}
