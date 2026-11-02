using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Muse2Api;

public static class Endpoints
{
    public const string Version = "0.8.24";

    public static void Map(WebApplication app, AppState s)
    {
        // ---------- health (public) ----------
        app.MapGet("/healthz", () => Results.Json(new { ok = true, version = Version }));
        app.MapGet("/readyz", async () =>
        {
            var driver = await s.Driver.Health();
            var pool = s.Pool.Stats();
            var ready = driver.GetValueOrDefault("ok") is true
                && (pool["available"] > 0 || !s.Driver.RequiresAccount);
            return Results.Json(new
            {
                ready,
                driver = driver.ToDictionary(kv => kv.Key, kv => kv.Value),
                accounts = pool,
            }, statusCode: ready ? 200 : 503);
        });

        // ---------- models ----------
        app.MapGet("/v1/models", (HttpContext ctx) =>
        {
            RequireApi(ctx, s);
            var data = new JsonArray();
            foreach (var m in ModelRegistry.Models.Values)
                data.Add(new JsonObject
                {
                    ["id"] = m.Id,
                    ["object"] = "model",
                    ["created"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                    ["owned_by"] = m.OwnedBy,
                    ["kind"] = m.Kind,
                });
            foreach (var (alias, target) in ModelRegistry.Aliases)
                data.Add(new JsonObject
                {
                    ["id"] = alias,
                    ["object"] = "model",
                    ["created"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                    ["owned_by"] = "muse",
                    ["kind"] = ModelRegistry.Models[target].Kind,
                    ["alias_of"] = target,
                });
            return Results.Json(new JsonObject { ["object"] = "list", ["data"] = data });
        });

        // ---------- chat ----------
        app.MapPost("/v1/chat/completions", async (HttpContext ctx) =>
            await Chat(ctx, s));
        app.MapPost("/v1/responses", async (HttpContext ctx) =>
            await Responses(ctx, s));

        // ---------- images / videos / media ----------
        app.MapPost("/v1/images/generations", async (HttpContext ctx) =>
            await ImagesGenerate(ctx, s));
        app.MapGet("/v1/images/generations/{taskId}", (HttpContext ctx, string taskId) =>
        {
            RequireApi(ctx, s);
            var task = s.Tasks.Get(taskId);
            if (task is null || task.Kind != "image")
                throw MuseException.NotFound($"image task '{taskId}' not found");
            ctx.Items["model"] = task.Request.GetValueOrDefault("model")?.ToString();
            return Results.Json(ImageTaskView(task));
        });
        app.MapPost("/v1/images/edits", async (HttpContext ctx) =>
            await ImagesEdit(ctx, s));
        app.MapPost("/v1/videos", async (HttpContext ctx) =>
            await VideoCreate(ctx, s));
        app.MapGet("/v1/videos/{taskId}", (HttpContext ctx, string taskId) =>
        {
            RequireApi(ctx, s);
            var task = s.Tasks.Get(taskId);
            if (task is null || task.Kind != "video")
                throw MuseException.NotFound($"video task '{taskId}' not found");
            ctx.Items["model"] = task.Request.GetValueOrDefault("model")?.ToString();
            return Results.Json(VideoTaskView(task));
        });
        app.MapGet("/v1/media/{name}", (HttpContext ctx, string name) =>
        {
            var path = s.Media.PathOf(name);
            ctx.Response.Headers.CacheControl = "public, max-age=86400";
            return Results.File(path, MediaStore.MimeOf(name),
                enableRangeProcessing: true);
        });

        app.MapGet("/dashboard", () => Results.Content(DashboardHtml, "text/html"));

        // ---------- admin ----------
        MapAdmin(app, s);
    }

    // ---------- auth ----------
    public static string Bearer(HttpContext ctx)
    {
        var auth = ctx.Request.Headers.Authorization.ToString();
        if (auth.StartsWith("Bearer ", StringComparison.OrdinalIgnoreCase))
            return auth[7..].Trim();
        return ctx.Request.Headers["X-Api-Key"].ToString().Trim();
    }

    private static (string Id, string Name) RequireApi(HttpContext ctx, AppState s)
    {
        var provided = Bearer(ctx);
        if (string.IsNullOrEmpty(provided)) throw MuseException.Unauthorized();
        if (TimingEquals(provided, s.Settings.EffectiveAdminKey))
            return Identify(ctx, "admin", "admin");
        if (TimingEquals(provided, s.Settings.ApiKey))
            return Identify(ctx, "legacy", "legacy");
        var key = s.Keys.Verify(provided);
        if (key is null) throw MuseException.Unauthorized();
        s.Keys.Touch(key);
        return Identify(ctx, key.Id, key.Name);
    }

    private static void RequireAdmin(HttpContext ctx, AppState s)
    {
        var provided = Bearer(ctx);
        if (string.IsNullOrEmpty(provided) || !TimingEquals(provided, s.Settings.EffectiveAdminKey))
            throw MuseException.Unauthorized();
        ctx.Items["key_id"] = "admin";
        ctx.Items["key_name"] = "admin";
    }

    private static (string, string) Identify(HttpContext ctx, string id, string name)
    {
        ctx.Items["key_id"] = id;
        ctx.Items["key_name"] = name;
        return (id, name);
    }

    private static bool TimingEquals(string a, string b)
    {
        if (string.IsNullOrEmpty(b)) return false;
        var ab = Encoding.UTF8.GetBytes(a);
        var bb = Encoding.UTF8.GetBytes(b);
        if (ab.Length != bb.Length) return false;
        return CryptographicOperations.FixedTimeEquals(ab, bb);
    }

    // ---------- chat ----------
    private static async Task Chat(HttpContext ctx, AppState s)
    {
        RequireApi(ctx, s);
        var body = await JsonHelp.ReadBody(ctx.Request);
        var modelName = JsonHelp.Str(body["model"]);
        ctx.Items["model"] = modelName;
        var spec = ModelRegistry.Resolve(modelName, "chat");
        ctx.Items["model"] = modelName ?? spec.Id;
        var messages = body["messages"] as JsonArray
            ?? throw MuseException.Invalid("messages must be a non-empty list");
        if (messages.Count == 0) throw MuseException.Invalid("messages must be a non-empty list");
        var msgObjs = messages.OfType<JsonObject>().ToList();
        if (msgObjs.Count != messages.Count)
            throw MuseException.Invalid("messages must be objects");
        var flat = Prompt.Flatten(msgObjs);
        if (string.IsNullOrEmpty(flat.Text) && flat.Images.Count == 0 && flat.Files.Count == 0)
            throw MuseException.Invalid("messages contain no text, images or files");
        var images = await JsonHelp.LoadImageRefs(flat.Images, ctx.RequestAborted);
        // v0.8.20: file gửi nguyên (video, pdf, ...) qua cùng đường
        // Attach như ảnh; giới hạn số file/lượt kiểm tra ở đây để
        // lỗi trả về trước khi chạm tới browser.
        var files = JsonHelp.LoadFileRefs(flat.Files);
        if (files.Count > JsonHelp.MaxFilesPerRequest) throw MuseException.Invalid("at most 10 files per request");
        var localTools = JsonHelp.Bool(body["_muse_local_tools"]);
        // v0.8.15 (OpenAI tools mode, e.g. Kilo Code): only when the request
        // declares tools AND the extension's own local-tools flow is off.
        // The local-tools flow is untouched: it keeps using ForLocalExecutor
        // and its own JSON plan protocol, and the gateway still never
        // executes anything itself in tools mode — it only translates.
        var toolSpecs = localTools ? null : OpenAiTools.ParseToolSpecs(body["tools"]);
        var toolsMode = toolSpecs is { Count: > 0 };
        var toolChoice = OpenAiTools.ParseToolChoice(body["tool_choice"]);
        var parallelToolCalls = body["parallel_tool_calls"] is null || JsonHelp.Bool(body["parallel_tool_calls"], true);
        var promptText = toolsMode
            ? flat.Text + "\n\n" + OpenAiTools.RenderCatalog(toolSpecs!)
            : localTools && s.Driver.Name == "browser" ? Prompt.ForLocalExecutor(msgObjs) : flat.Text;
        var req = new ChatRequest(promptText, spec.Id, images,
            JsonHelp.Str(body["user"]), Prompt.MessageTurns(msgObjs), ctx.RequestAborted, localTools, Prompt.ImageBatchId(msgObjs),
            // v0.8.2: extension gửi account_id của session đã chọn.
            // Gateway cũ bỏ qua trường lạ này; gateway mới ép đúng tài
            // khoản đó (xem Gateway.ChatStream + AcquirePinnedAsync).
            AccountId: JsonHelp.Str(body["account_id"]),
            Files: files,
            // v0.8.16: để BrowserDriver ghi log web_prompt đúng chế độ
            // (normal | local | openai-tools) thay vì phải suy từ prompt.
            OpenAiTools: toolsMode);
        var stream = JsonHelp.Bool(body["stream"]);
        ctx.Items["stream"] = stream;
        var completionId = "chatcmpl-" + Guid.NewGuid().ToString("N")[..24];
        var created = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var outModel = modelName ?? spec.Id;

        if (!stream)
        {
            var text = "";
            var chatStream = s.Gateway.ChatStream(req, id => ctx.Items["account_id"] = id);
            await foreach (var d in chatStream) text += d;
            // v0.8.15: in tools mode a valid tool_calls block becomes a real
            // OpenAI tool_calls message (content empty, finish tool_calls);
            // anything else — no block, forbidden choice, or any invalid call
            // — degrades to the plain-text reply, never a half-valid call.
            var message = new JsonObject { ["role"] = "assistant", ["content"] = text };
            var finishReason = "stop";
            var calls = toolsMode ? OpenAiTools.TryExtractCalls(text, toolSpecs!, toolChoice, parallelToolCalls) : null;
            if (calls is { Count: > 0 })
            {
                var toolCalls = new JsonArray();
                foreach (var call in calls)
                    toolCalls.Add(new JsonObject
                    {
                        ["id"] = OpenAiTools.BuildCallId(),
                        ["type"] = "function",
                        ["function"] = new JsonObject { ["name"] = call.Name, ["arguments"] = call.ArgumentsJson },
                    });
                message = new JsonObject { ["role"] = "assistant", ["content"] = "", ["tool_calls"] = toolCalls };
                finishReason = "tool_calls";
            }
            await ctx.Response.WriteAsJsonAsync(new JsonObject
            {
                ["id"] = completionId,
                ["object"] = "chat.completion",
                ["created"] = created,
                ["model"] = outModel,
                ["choices"] = new JsonArray(new JsonObject
                {
                    ["index"] = 0,
                    ["message"] = message,
                    ["finish_reason"] = finishReason,
                }),
                ["usage"] = new JsonObject
                {
                    // Non-tools usage stays on flat.Text exactly as before;
                    // only tools mode counts the catalog-augmented prompt.
                    ["prompt_tokens"] = JsonHelp.ApproxTokens(toolsMode ? promptText : flat.Text),
                    ["completion_tokens"] = JsonHelp.ApproxTokens(text),
                    ["total_tokens"] = JsonHelp.ApproxTokens(toolsMode ? promptText : flat.Text) + JsonHelp.ApproxTokens(text),
                },
            });
            return;
        }

        // v0.8.15: tools-mode streaming must buffer the whole web reply
        // first — tool_calls deltas can only be emitted once the reply is
        // known to be a valid block, otherwise a client would receive text
        // it cannot retract. Plain text in tools mode is re-emitted as
        // content deltas; the wire shape stays standard SSE + [DONE].
        if (toolsMode)
        {
            var fullText = "";
            var bufferedStream = s.Gateway.ChatStream(req, id => ctx.Items["account_id"] = id);
            await foreach (var d in bufferedStream) fullText += d;
            ctx.Response.ContentType = "text/event-stream";
            ctx.Response.Headers.CacheControl = "no-cache";
            ctx.Response.Headers["X-Accel-Buffering"] = "no";
            await using var toolsWriter = new StreamWriter(ctx.Response.Body, leaveOpen: true);
            JsonObject ToolsChunk(JsonObject delta, string? finish) => new()
            {
                ["id"] = completionId,
                ["object"] = "chat.completion.chunk",
                ["created"] = created,
                ["model"] = outModel,
                ["choices"] = new JsonArray(new JsonObject
                {
                    ["index"] = 0,
                    ["delta"] = delta,
                    ["finish_reason"] = finish is null ? null : JsonValue.Create(finish),
                }),
            };
            async Task ToolsSse(JsonNode payload)
                => await toolsWriter.WriteAsync("data: " + payload.ToJsonString() + "\n\n");
            var bufferedCalls = OpenAiTools.TryExtractCalls(fullText, toolSpecs!, toolChoice, parallelToolCalls);
            if (bufferedCalls is { Count: > 0 })
            {
                for (var i = 0; i < bufferedCalls.Count; i++)
                {
                    var call = bufferedCalls[i];
                    var callId = OpenAiTools.BuildCallId();
                    await ToolsSse(ToolsChunk(new JsonObject
                    {
                        ["role"] = "assistant",
                        ["tool_calls"] = new JsonArray(new JsonObject
                        {
                            ["index"] = i,
                            ["id"] = callId,
                            ["type"] = "function",
                            ["function"] = new JsonObject { ["name"] = call.Name, ["arguments"] = "" },
                        }),
                    }, null));
                    await toolsWriter.FlushAsync();
                    await ToolsSse(ToolsChunk(new JsonObject
                    {
                        ["tool_calls"] = new JsonArray(new JsonObject
                        {
                            ["index"] = i,
                            ["function"] = new JsonObject { ["arguments"] = call.ArgumentsJson },
                        }),
                    }, null));
                    await toolsWriter.FlushAsync();
                }
                await ToolsSse(ToolsChunk(new JsonObject(), "tool_calls"));
            }
            else
            {
                await ToolsSse(ToolsChunk(new JsonObject { ["role"] = "assistant", ["content"] = fullText }, null));
                await toolsWriter.FlushAsync();
                await ToolsSse(ToolsChunk(new JsonObject(), "stop"));
            }
            if ((body["stream_options"] as JsonObject)?["include_usage"] is JsonValue toolsUv
                && toolsUv.TryGetValue<bool>(out var toolsInclude) && toolsInclude)
            {
                await ToolsSse(new JsonObject
                {
                    ["id"] = completionId,
                    ["object"] = "chat.completion.chunk",
                    ["created"] = created,
                    ["model"] = outModel,
                    ["choices"] = new JsonArray(),
                    ["usage"] = new JsonObject
                    {
                        ["prompt_tokens"] = JsonHelp.ApproxTokens(promptText),
                        ["completion_tokens"] = JsonHelp.ApproxTokens(fullText),
                        ["total_tokens"] = JsonHelp.ApproxTokens(promptText) + JsonHelp.ApproxTokens(fullText),
                    },
                });
            }
            await toolsWriter.WriteAsync("data: [DONE]\n\n");
            await toolsWriter.FlushAsync();
            return;
        }

        ctx.Response.ContentType = "text/event-stream";
        ctx.Response.Headers.CacheControl = "no-cache";
        ctx.Response.Headers["X-Accel-Buffering"] = "no";
        var chatStream2 = s.Gateway.ChatStream(req, id => ctx.Items["account_id"] = id);
        await using var enumerator = chatStream2.GetAsyncEnumerator(ctx.RequestAborted);
        var first = await FirstDelta(enumerator, ctx, s.Settings.StreamHeartbeatInterval, ctx.RequestAborted);
        await using var writer = new StreamWriter(ctx.Response.Body, leaveOpen: true);
        JsonObject Chunk(JsonObject delta, string? finish) => new()
        {
            ["id"] = completionId,
            ["object"] = "chat.completion.chunk",
            ["created"] = created,
            ["model"] = outModel,
            ["choices"] = new JsonArray(new JsonObject
            {
                ["index"] = 0,
                ["delta"] = delta,
                ["finish_reason"] = finish is null ? null : JsonValue.Create(finish),
            }),
        };
        async Task Sse(JsonNode payload)
            => await writer.WriteAsync("data: " + payload.ToJsonString() + "\n\n");
        var produced = first;
        await Sse(Chunk(new JsonObject { ["role"] = "assistant", ["content"] = produced }, null));
        await writer.FlushAsync();
        while (await enumerator.MoveNextAsync())
        {
            produced += enumerator.Current;
            await Sse(Chunk(new JsonObject { ["content"] = enumerator.Current }, null));
            await writer.FlushAsync();
        }
        await Sse(Chunk(new JsonObject(), "stop"));
        if ((body["stream_options"] as JsonObject)?["include_usage"] is JsonValue uv
            && uv.TryGetValue<bool>(out var include) && include)
        {
            await Sse(new JsonObject
            {
                ["id"] = completionId,
                ["object"] = "chat.completion.chunk",
                ["created"] = created,
                ["model"] = outModel,
                ["choices"] = new JsonArray(),
                ["usage"] = new JsonObject
                {
                    ["prompt_tokens"] = JsonHelp.ApproxTokens(flat.Text),
                    ["completion_tokens"] = JsonHelp.ApproxTokens(produced),
                    ["total_tokens"] = JsonHelp.ApproxTokens(flat.Text) + JsonHelp.ApproxTokens(produced),
                },
            });
        }
        await writer.WriteAsync("data: [DONE]\n\n");
        await writer.FlushAsync();
    }

    private static async Task<string> FirstDelta(IAsyncEnumerator<string> enumerator, HttpContext ctx,
        double heartbeat, CancellationToken cancel)
    {
        var pending = enumerator.MoveNextAsync().AsTask();
        try
        {
            if (heartbeat > 0)
            {
                while (!pending.IsCompleted)
                {
                    using var timer = CancellationTokenSource.CreateLinkedTokenSource(cancel);
                    var delay = Task.Delay(TimeSpan.FromSeconds(heartbeat), timer.Token);
                    if (await Task.WhenAny(pending, delay) == pending) { timer.Cancel(); break; }
                    if (cancel.IsCancellationRequested) break;
                    await ctx.Response.WriteAsync(": keepalive\n\n", cancel);
                    await ctx.Response.Body.FlushAsync(cancel);
                }
            }
            return await pending ? enumerator.Current : "";
        }
        catch
        {
            if (!pending.IsCompleted)
            {
                ctx.Abort();
                try { await pending; } catch { }
            }
            throw;
        }
    }

    // ---------- responses ----------
    private static async Task Responses(HttpContext ctx, AppState s)
    {
        RequireApi(ctx, s);
        var body = await JsonHelp.ReadBody(ctx.Request);
        var modelName = JsonHelp.Str(body["model"]);
        ctx.Items["model"] = modelName;
        var spec = ModelRegistry.Resolve(modelName, "chat");
        ctx.Items["model"] = modelName ?? spec.Id;
        var messages = ResponsesToMessages(body);
        var flat = Prompt.Flatten(messages);
        if (string.IsNullOrEmpty(flat.Text) && flat.Images.Count == 0 && flat.Files.Count == 0)
            throw MuseException.Invalid("input contains no text, images or files");
        var images = await JsonHelp.LoadImageRefs(flat.Images, ctx.RequestAborted);
        // v0.8.20: Responses giữ nguyên content parts (DeepClone) nên
        // file part cũng về được đây; chở giống Chat để không rơi mất.
        var files = JsonHelp.LoadFileRefs(flat.Files);
        if (files.Count > JsonHelp.MaxFilesPerRequest) throw MuseException.Invalid("at most 10 files per request");
        var req = new ChatRequest(flat.Text, spec.Id, images,
            JsonHelp.Str(body["user"]), Prompt.MessageTurns(messages), ctx.RequestAborted,
            AccountId: JsonHelp.Str(body["account_id"]),
            Files: files);
        var respId = "resp_" + Guid.NewGuid().ToString("N")[..24];
        var msgId = "msg_" + Guid.NewGuid().ToString("N")[..24];
        var created = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var outModel = modelName ?? spec.Id;

        JsonObject MessageItem(string text) => new()
        {
            ["id"] = msgId,
            ["type"] = "message",
            ["status"] = "completed",
            ["role"] = "assistant",
            ["content"] = new JsonArray(new JsonObject
            { ["type"] = "output_text", ["annotations"] = new JsonArray(), ["text"] = text }),
        };
        JsonObject Usage(string output) => new()
        {
            ["input_tokens"] = JsonHelp.ApproxTokens(flat.Text),
            ["output_tokens"] = JsonHelp.ApproxTokens(output),
            ["total_tokens"] = JsonHelp.ApproxTokens(flat.Text) + JsonHelp.ApproxTokens(output),
            ["input_tokens_details"] = new JsonObject { ["cached_tokens"] = 0 },
            ["output_tokens_details"] = new JsonObject { ["reasoning_tokens"] = 0 },
        };
        JsonObject ResponseObject(string text, string status) => new()
        {
            ["id"] = respId,
            ["object"] = "response",
            ["created_at"] = created,
            ["model"] = outModel,
            ["status"] = status,
            ["output"] = status == "completed" ? new JsonArray(MessageItem(text)) : new JsonArray(),
            ["usage"] = Usage(text),
            ["parallel_tool_calls"] = true,
            ["tool_choice"] = "auto",
            ["tools"] = new JsonArray(),
        };

        var stream = JsonHelp.Bool(body["stream"]);
        ctx.Items["stream"] = stream;
        if (!stream)
        {
            var text = "";
            var chatStream = s.Gateway.ChatStream(req, id => ctx.Items["account_id"] = id);
            await foreach (var d in chatStream) text += d;
            await ctx.Response.WriteAsJsonAsync(ResponseObject(text, "completed"));
            return;
        }

        ctx.Response.ContentType = "text/event-stream";
        ctx.Response.Headers.CacheControl = "no-cache";
        ctx.Response.Headers["X-Accel-Buffering"] = "no";
        var seq = 0;
        ctx.Items["response_failure"] = (Func<MuseException, JsonObject>)(error =>
        {
            var failed = ResponseObject("", "failed");
            failed["error"] = JsonSerializer.SerializeToNode(error.ToBody()["error"]);
            return new JsonObject { ["type"] = "response.failed", ["sequence_number"] = seq++, ["response"] = failed };
        });
        var chatStream2 = s.Gateway.ChatStream(req, id => ctx.Items["account_id"] = id);
        await using var enumerator = chatStream2.GetAsyncEnumerator(ctx.RequestAborted);
        var first = await FirstDelta(enumerator, ctx, s.Settings.StreamHeartbeatInterval, ctx.RequestAborted);
        await using var writer = new StreamWriter(ctx.Response.Body, leaveOpen: true);
        async Task Sse(JsonObject payload)
        {
            payload["sequence_number"] = seq++;
            await writer.WriteAsync("event: " + JsonHelp.Str(payload["type"]) + "\ndata: " + payload.ToJsonString() + "\n\n");
            await writer.FlushAsync();
        }
        await Sse(new JsonObject { ["type"] = "response.created", ["response"] = ResponseObject("", "in_progress") });
        await Sse(new JsonObject { ["type"] = "response.in_progress", ["response"] = ResponseObject("", "in_progress") });
        await Sse(new JsonObject
        {
            ["type"] = "response.output_item.added",
            ["output_index"] = 0,
            ["item"] = new JsonObject
            {
                ["id"] = msgId,
                ["type"] = "message",
                ["status"] = "in_progress",
                ["role"] = "assistant",
                ["content"] = new JsonArray(),
            },
        });
        await Sse(new JsonObject
        {
            ["type"] = "response.content_part.added",
            ["item_id"] = msgId,
            ["output_index"] = 0,
            ["content_index"] = 0,
            ["part"] = new JsonObject { ["type"] = "output_text", ["text"] = "", ["annotations"] = new JsonArray() },
        });
        var produced = first;
        if (produced.Length > 0)
            await Sse(new JsonObject
            {
                ["type"] = "response.output_text.delta",
                ["item_id"] = msgId,
                ["output_index"] = 0,
                ["content_index"] = 0,
                ["delta"] = produced,
                ["logprobs"] = new JsonArray(),
            });
        while (await enumerator.MoveNextAsync())
        {
            produced += enumerator.Current;
            await Sse(new JsonObject
            {
                ["type"] = "response.output_text.delta",
                ["item_id"] = msgId,
                ["output_index"] = 0,
                ["content_index"] = 0,
                ["delta"] = enumerator.Current,
                ["logprobs"] = new JsonArray(),
            });
        }
        await Sse(new JsonObject
        {
            ["type"] = "response.output_text.done",
            ["item_id"] = msgId,
            ["output_index"] = 0,
            ["content_index"] = 0,
            ["text"] = produced,
        });
        await Sse(new JsonObject
        {
            ["type"] = "response.content_part.done",
            ["item_id"] = msgId,
            ["output_index"] = 0,
            ["content_index"] = 0,
            ["part"] = new JsonObject { ["type"] = "output_text", ["text"] = produced, ["annotations"] = new JsonArray() },
        });
        await Sse(new JsonObject
        {
            ["type"] = "response.output_item.done",
            ["output_index"] = 0,
            ["item"] = MessageItem(produced),
        });
        await Sse(new JsonObject { ["type"] = "response.completed", ["response"] = ResponseObject(produced, "completed") });
    }

    private static List<JsonObject> ResponsesToMessages(JsonObject body)
    {
        var messages = new List<JsonObject>();
        if (JsonHelp.Str(body["instructions"]) is { } instructions)
            messages.Add(new JsonObject { ["role"] = "system", ["content"] = instructions });
        var input = body["input"];
        var toolItems = new HashSet<string>
            { "function_call", "function_call_output", "reasoning", "computer_call",
              "file_search_call", "web_search_call" };
        if (input is null || (input is JsonValue v && v.TryGetValue<string>(out var sv) && string.IsNullOrWhiteSpace(sv)))
        {
            // no user input
        }
        else if (input is JsonValue sv2 && sv2.TryGetValue<string>(out var s))
            messages.Add(new JsonObject { ["role"] = "user", ["content"] = s });
        else if (input is JsonArray arr)
        {
            foreach (var item in arr)
            {
                if (item is not JsonObject obj)
                    throw MuseException.Invalid("input items must be objects");
                var type = JsonHelp.Str(obj["type"]);
                if (type is not null && toolItems.Contains(type))
                    throw MuseException.Invalid(
                        $"input item type '{type}' is not supported: muse.ai has no function calling");
                if (obj.ContainsKey("role") || type is "message" or null)
                    messages.Add(new JsonObject
                    {
                        ["role"] = JsonHelp.Str(obj["role"]) ?? "user",
                        ["content"] = obj["content"]?.DeepClone(),
                    });
                else
                    throw MuseException.Invalid($"unsupported input item type '{type}'");
            }
        }
        else throw MuseException.Invalid("input must be a string or a list of items");
        return messages;
    }

    // ---------- images ----------
    private static JsonObject ImageTaskView(BgTask task) => new()
    {
        ["id"] = task.Id,
        ["object"] = "image.task",
        ["status"] = task.Status,
        ["progress"] = task.Progress,
        ["created_at"] = (long)task.CreatedAt,
        ["model"] = task.Request.GetValueOrDefault("model")?.ToString(),
        ["result"] = task.Result is null ? null : DictToJson(task.Result),
        ["error"] = task.Error is null ? null : DictToJson(task.Error),
    };

    private static JsonObject VideoTaskView(BgTask task) => new()
    {
        ["id"] = task.Id,
        ["object"] = "video",
        ["status"] = task.Status,
        ["progress"] = task.Progress,
        ["created_at"] = (long)task.CreatedAt,
        ["model"] = task.Request.GetValueOrDefault("model")?.ToString(),
        ["result"] = task.Result is null ? null : DictToJson(task.Result),
        ["error"] = task.Error is null ? null : DictToJson(task.Error),
    };

    private static async Task ImagesGenerate(HttpContext ctx, AppState s)
    {
        RequireApi(ctx, s);
        var body = await JsonHelp.ReadBody(ctx.Request);
        var prompt = JsonHelp.Str(body["prompt"])
            ?? throw MuseException.Invalid("prompt is required");
        if (string.IsNullOrWhiteSpace(prompt)) throw MuseException.Invalid("prompt must not be empty");
        if (JsonHelp.Str(body["background"]) == "transparent") throw MuseException.NotImplemented("transparent background is not supported");
        var spec = ModelRegistry.Resolve(JsonHelp.Str(body["model"]), "image");
        ctx.Items["model"] = body["model"]?.ToString() ?? spec.Id;
        var n = JsonHelp.Int(body["n"], body["n"] is null ? 1 : -1);
        if (n is < 1 or > 4)
            throw MuseException.Invalid("n must be between 1 and 4");
        var refs = new List<string>();
        if (body["image"] is JsonArray arr) refs.AddRange(arr.Select(x => JsonHelp.Str(x) ?? ""));
        else if (JsonHelp.Str(body["image"]) is { } single) refs.Add(single);
        if (refs.Count > 4)
            throw MuseException.Invalid("at most 4 reference images are supported");
        if (refs.Any(string.IsNullOrWhiteSpace)) throw MuseException.Invalid("reference images must be non-empty strings");
        var loaded = await JsonHelp.LoadImageRefs(refs, ctx.RequestAborted);
        var format = JsonHelp.Str(body["response_format"]) ?? "url";
        if (format is not ("url" or "b64_json")) throw MuseException.Invalid("response_format must be url or b64_json");
        var isAsync = JsonHelp.Bool(body["async"]);
        var baseUrl = JsonHelp.BaseUrl(ctx.Request, s.Settings);

        async Task<JsonObject> Run(Action<int>? progress, CancellationToken cancel)
        {
            var (results, imageAccount) = await s.Gateway.GenerateImage(new ImageRequest(
                prompt, spec.Id, JsonHelp.Str(body["size"]), n, loaded, progress, cancel));
            if (!isAsync) ctx.Items["account_id"] = imageAccount;
            var data = new JsonArray();
            foreach (var r in results)
            {
                var item = new JsonObject { ["revised_prompt"] = r.RevisedPrompt };
                if (format == "b64_json") item["b64_json"] = Convert.ToBase64String(r.Data);
                else item["url"] = $"{baseUrl}/v1/media/{s.Media.Save(r.Data, r.Mime, "img")}";
                data.Add(item);
            }
            return new JsonObject
            {
                ["created"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
                ["data"] = data,
            };
        }

        if (!isAsync)
        {
            await ctx.Response.WriteAsJsonAsync(await Run(null, ctx.RequestAborted));
            return;
        }
        var task = s.Tasks.Submit("image", new Dictionary<string, object?>
        {
            ["model"] = spec.Id,
            ["prompt"] = prompt,
            ["size"] = JsonHelp.Str(body["size"]),
            ["n"] = n,
            ["references"] = refs.Count,
        }, async (progress, cancel) => { var r = await Run(progress, cancel); return new Dictionary<string, System.Text.Json.Nodes.JsonNode?> { ["data"] = r["data"]?.DeepClone() }; });
        ctx.Items["task_id"] = task.Id;
        await ctx.Response.WriteAsJsonAsync(ImageTaskView(task));
    }

    private static async Task ImagesEdit(HttpContext ctx, AppState s)
    {
        RequireApi(ctx, s);
        if (!ctx.Request.HasFormContentType) throw MuseException.Invalid("Content-Type must be multipart/form-data");
        var form = await ctx.Request.ReadFormAsync(ctx.RequestAborted);
        if (form.ContainsKey("mask") || form.Files.Any(f => f.Name == "mask"))
            throw MuseException.Invalid("mask is not supported; muse.ai cannot inpaint a region");
        var files = form.Files.Where(f => f.Name is "image" or "image[]").ToList();
        if (files.Count == 0)
            throw MuseException.Invalid("at least one image file is required (field 'image' or 'image[]')");
        if (files.Count > 4) throw MuseException.Invalid("at most 4 reference images are supported");
        var prompt = form["prompt"].ToString();
        if (string.IsNullOrEmpty(prompt)) throw MuseException.Invalid("prompt is required");
        var nText = form["n"].ToString();
        var n = string.IsNullOrEmpty(nText) ? 1 : int.TryParse(nText, out var nv) ? nv : -1;
        if (n < 1 || n > 4) throw MuseException.Invalid("n must be between 1 and 4");
        var format = form["response_format"].ToString();
        if (string.IsNullOrEmpty(format)) format = "url";
        if (format is not ("url" or "b64_json")) throw MuseException.Invalid("response_format must be url or b64_json");
        var spec = ModelRegistry.Resolve(form["model"].ToString() is { Length: > 0 } m ? m : null, "image");
        var refs = new List<InputImage>();
        foreach (var f in files)
        {
            if (f.Length is <= 0 or > MediaHelp.MaxImageBytes) throw MuseException.Invalid("image must be non-empty and at most 20 MiB");
            using var ms = new MemoryStream();
            await f.CopyToAsync(ms, ctx.RequestAborted);
            var mime = f.ContentType;
            if (!mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
                mime = f.FileName.EndsWith(".jpg", StringComparison.OrdinalIgnoreCase)
                    || f.FileName.EndsWith(".jpeg", StringComparison.OrdinalIgnoreCase)
                    ? "image/jpeg" : "image/png";
            refs.Add(new InputImage(ms.ToArray(), mime));
        }
        var (results, editAccount) = await s.Gateway.GenerateImage(new ImageRequest(
            prompt, spec.Id, form["size"].ToString() is { Length: > 0 } sz ? sz : null, n, refs, Cancel: ctx.RequestAborted));
        ctx.Items["account_id"] = editAccount;
        var baseUrl = JsonHelp.BaseUrl(ctx.Request, s.Settings);
        var data = new JsonArray();
        foreach (var r in results)
        {
            var item = new JsonObject { ["revised_prompt"] = r.RevisedPrompt };
            if (format == "b64_json") item["b64_json"] = Convert.ToBase64String(r.Data);
            else item["url"] = $"{baseUrl}/v1/media/{s.Media.Save(r.Data, r.Mime, "img")}";
            data.Add(item);
        }
        await ctx.Response.WriteAsJsonAsync(new JsonObject
        {
            ["created"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            ["data"] = data,
        });
    }

    private static async Task VideoCreate(HttpContext ctx, AppState s)
    {
        RequireApi(ctx, s);
        var body = await JsonHelp.ReadBody(ctx.Request);
        var prompt = JsonHelp.Str(body["prompt"])
            ?? throw MuseException.Invalid("prompt is required");
        if (string.IsNullOrWhiteSpace(prompt)) throw MuseException.Invalid("prompt must not be empty");
        var spec = ModelRegistry.Resolve(JsonHelp.Str(body["model"]), "video");
        ctx.Items["model"] = body["model"]?.ToString() ?? spec.Id;
        InputImage? firstFrame = null;
        var frameRef = JsonHelp.Str(body["image"]) ?? JsonHelp.Str(body["input_reference"]);
        if (frameRef is not null) firstFrame = await MediaHelp.LoadImageRef(frameRef, ctx.RequestAborted);
        var baseUrl = JsonHelp.BaseUrl(ctx.Request, s.Settings);
        var duration = body["duration"] is not null ? JsonHelp.Int(body["duration"]) : JsonHelp.Int(body["seconds"]);
        if (duration is < 1 or > 60 && (body["duration"] is not null || body["seconds"] is not null))
            throw MuseException.Invalid("duration must be between 1 and 60");
        var task = s.Tasks.Submit("video", new Dictionary<string, object?>
        {
            ["model"] = spec.Id,
            ["prompt"] = prompt,
            ["size"] = JsonHelp.Str(body["size"]),
            ["duration"] = duration == 0 ? null : duration,
            ["has_first_frame"] = firstFrame is not null,
        }, async (progress, cancel) =>
        {
            var (result, _) = await s.Gateway.GenerateVideo(new VideoRequest(
                prompt, spec.Id, JsonHelp.Str(body["size"]), duration == 0 ? null : duration,
                firstFrame, progress, cancel));
            var name = s.Media.Save(result.Data, result.Mime, "vid");
            return new Dictionary<string, System.Text.Json.Nodes.JsonNode?>
            {
                ["url"] = $"{baseUrl}/v1/media/{name}",
                ["mime"] = result.Mime,
                ["width"] = result.Width is null ? null : System.Text.Json.Nodes.JsonValue.Create(result.Width.Value),
                ["height"] = result.Height is null ? null : System.Text.Json.Nodes.JsonValue.Create(result.Height.Value),
            };
        });
        ctx.Items["task_id"] = task.Id;
        await ctx.Response.WriteAsJsonAsync(VideoTaskView(task));
    }

    // ---------- admin ----------
    private static void MapAdmin(WebApplication app, AppState s)
    {
        var admin = app.MapGroup("/admin");
        admin.MapGet("/status", async (HttpContext ctx) =>
        {
            RequireAdmin(ctx, s);
            return Results.Json(new JsonObject
            {
                ["version"] = Version,
                ["driver"] = JsonSerializer.SerializeToNode(await s.Driver.Health()),
                ["capabilities"] = JsonSerializer.SerializeToNode(s.Driver.Capabilities),
                ["accounts"] = JsonSerializer.SerializeToNode(s.Pool.Stats()),
            });
        });
        admin.MapGet("/accounts", (HttpContext ctx) =>
        {
            RequireAdmin(ctx, s);
            var arr = new JsonArray();
            foreach (var a in s.Pool.All()) arr.Add(a.Public());
            return Results.Json(new JsonObject { ["data"] = arr });
        });
        admin.MapPost("/accounts", async (HttpContext ctx) =>
        {
            RequireAdmin(ctx, s);
            var body = await JsonHelp.ReadBody(ctx.Request);
            var acc = BuildAccount(body);
            if (JsonHelp.Bool(body["reuse_session"])) acc = s.Pool.UpsertSession(acc);
            else s.Pool.Upsert(acc);
            return Results.Json(new JsonObject
            {
                ["account"] = acc.Public(),
                ["missing_cookies"] = new JsonArray(
                    Upstream.MissingSessionCookies(acc.Cookies).Select(c => (JsonNode?)c).ToArray()),
            });
        });
        admin.MapPost("/accounts/import", async (HttpContext ctx) =>
        {
            RequireAdmin(ctx, s);
            var body = await JsonHelp.ReadBody(ctx.Request);
            var arr = body["accounts"] as JsonArray
                ?? throw MuseException.Invalid("accounts must be a non-empty list");
            var results = new JsonArray();
            for (var i = 0; i < arr.Count; i++)
            {
                try
                {
                    var acc = BuildAccount(arr[i] as JsonObject
                        ?? throw MuseException.Invalid("account must be an object"));
                    s.Pool.Upsert(acc);
                    results.Add(new JsonObject
                    {
                        ["index"] = i,
                        ["ok"] = true,
                        ["account"] = acc.Public(),
                        ["missing_cookies"] = new JsonArray(
                            Upstream.MissingSessionCookies(acc.Cookies).Select(c => (JsonNode?)c).ToArray()),
                    });
                }
                catch (MuseException ex)
                {
                    results.Add(new JsonObject
                    { ["index"] = i, ["ok"] = false, ["error"] = ex.Message, ["code"] = ex.Code });
                }
            }
            return Results.Json(new JsonObject { ["data"] = results });
        });
        admin.MapPatch("/accounts/{id}", async (HttpContext ctx, string id) =>
        {
            RequireAdmin(ctx, s);
            var acc = s.Pool.Get(id) ?? throw MuseException.NotFound($"account '{id}' not found");
            var body = await JsonHelp.ReadBody(ctx.Request);
            if (JsonHelp.Str(body["label"]) is { } label) acc.Label = label;
            if (body["enabled"] is JsonValue ev && ev.TryGetValue<bool>(out var enabled)) acc.Enabled = enabled;
            // v0.8.5: nhập tay hồ sơ (user tự nhập trong panel Cài đặt).
            // Khóa có mặt với giá trị null/rỗng = xóa trường đó; khóa
            // vắng mặt = giữ nguyên. Giá trị không rỗng phải qua đúng
            // kiểm tra hợp lệ đã có, nếu không trả 400 kèm lý do rõ và
            // KHÔNG lưu gì cả (kiểm tra hết trước khi gán). Giá trị
            // nhập tay đã hợp lệ thì lần profile-refresh sau không ghi
            // đè (chỉ điền trường trống) và đường dọn rác cũng không
            // xóa (giá trị hợp lệ qua được kiểm tra dọn rác).
            // MuseUserId KHÔNG cho nhập tay (chỉ session API mới ghi).
            string? ManualField(string key, Func<string, bool> valid, string reason)
            {
                if (!body.ContainsKey(key)) return null;
                var raw = JsonHelp.Str(body[key]);
                if (string.IsNullOrWhiteSpace(raw)) return string.Empty; // xóa trường
                var v = raw.Trim();
                if (!valid(v)) throw MuseException.Invalid(reason);
                return v;
            }
            var newEmail = ManualField("email", ProfileValidation.IsValidEmail,
                "Email nhập tay không hợp lệ: cần đúng dạng tên@miền, không phải tên file hay đường dẫn.");
            var newUsername = ManualField("username", ProfileValidation.IsValidUsername,
                "Tên hiển thị nhập tay không hợp lệ: cần 3–80 ký tự, không phải UUID, tên file hay đường dẫn.");
            var newPhone = ManualField("phone", ProfileValidation.IsPhoneLike,
                "Số điện thoại nhập tay không hợp lệ: cần 7–15 chữ số, chỉ gồm dấu +, chữ số, khoảng trắng, gạch ngang, ngoặc, chấm.");
            if (body.ContainsKey("email")) acc.Email = string.IsNullOrEmpty(newEmail) ? null : newEmail;
            if (body.ContainsKey("username")) acc.Username = string.IsNullOrEmpty(newUsername) ? null : newUsername;
            if (body.ContainsKey("phone")) acc.Phone = string.IsNullOrEmpty(newPhone) ? null : newPhone;
            if (body["cookies"] is JsonObject cookies)
            {
                acc.Cookies = cookies.ToDictionary(kv => kv.Key, kv => JsonHelp.Str(kv.Value) ?? "");
                acc.Status = AccountStatus.Active;
                acc.LastError = null;
            }
            if (body["cookie_expires"] is JsonObject expires)
                acc.CookieExpires = expires.ToDictionary(kv => kv.Key, kv => JsonHelp.Long(kv.Value));
            s.Pool.Upsert(acc);
            if (body.ContainsKey("cookies") || body.ContainsKey("cookie_expires")) await s.Driver.InvalidateAccount(id);
            return Results.Json(new JsonObject { ["account"] = acc.Public() });
        });
        admin.MapDelete("/accounts/{id}", async (HttpContext ctx, string id) =>
        {
            RequireAdmin(ctx, s);
            if (!s.Pool.Remove(id)) throw MuseException.NotFound($"account '{id}' not found");
            await s.Driver.InvalidateAccount(id);
            return Results.Json(new JsonObject { ["deleted"] = id });
        });
        // ---------- xóa hoàn toàn tài khoản khỏi gateway (v0.8.0) ----------
        // KHÁC với DELETE /accounts/{id} ("Đăng xuất", giữ nguyên hành
        // vi cũ): purge còn xóa file browser session của tài khoản đó
        // và mọi mapping local-conversations của nó. KHÔNG gọi bất kỳ
        // API xóa tài khoản nào của muse.ai, KHÔNG đăng xuất app Muse
        // desktop (app desktop giữ đăng nhập riêng của nó); chạy lại
        // "Nhập đăng nhập từ app desktop" sẽ đưa tài khoản quay lại
        // gateway — đó là hành vi đúng của lệnh nhập, không phải lỗi
        // xóa chưa sạch. KHÔNG xóa file accounts.json.bak-* (chỉ là sao
        // lưu toàn bộ file lúc nhập, không tự khôi phục). Thứ tự:
        // Pool.Remove (đã Persist trong Remove) -> InvalidateAccount
        // -> xóa file browser session (thiếu thì bỏ qua) -> xóa mapping.
        // Purge lần 2 trên cùng id trả 404 (Pool.Remove false), không
        // báo thành công giả. sessions trong extension do chính
        // extension xóa sau khi purge trả về (xem purgeGatewayAccount).
        admin.MapDelete("/accounts/{id}/purge", async (HttpContext ctx, string id) =>
        {
            RequireAdmin(ctx, s);
            if (!s.Pool.Remove(id)) throw MuseException.NotFound($"account '{id}' not found");
            await s.Driver.InvalidateAccount(id);
            var browserSessionDeleted = new BrowserSessionStore(s.Settings.DataDir).DeleteById(id);
            var mappingsDeleted = new LocalConversationStore(s.Settings.DataDir).DeleteAccountMappings(id);
            return Results.Json(new JsonObject
            {
                ["deleted"] = id,
                ["browser_session_deleted"] = browserSessionDeleted,
                ["mappings_deleted"] = mappingsDeleted,
            });
        });
        admin.MapPost("/accounts/{id}/reset", (HttpContext ctx, string id) =>
        {
            RequireAdmin(ctx, s);
            var acc = s.Pool.Get(id) ?? throw MuseException.NotFound($"account '{id}' not found");
            acc.Status = AccountStatus.Active;
            acc.CooldownUntil = 0;
            acc.LastError = null;
            acc.Meta.Remove("kind_blocked_until");
            acc.Meta.Remove("wake_blocked_until");
            s.Pool.Upsert(acc);
            return Results.Json(new JsonObject { ["account"] = acc.Public() });
        });
        admin.MapPost("/accounts/{id}/renew", async (HttpContext ctx, string id) =>
        {
            RequireAdmin(ctx, s);
            var acc = s.Pool.Get(id) ?? throw MuseException.NotFound($"account '{id}' not found");
            var info = await s.Driver.RenewSession(acc);
            // Merge, like Python keepalive.renew_account: a renewal that returns
            // only rotated cookies must not wipe the ones it did not return.
            // (The old replace-all code emptied a mock account on renew.)
            foreach (var (k, v) in info.Cookies) acc.Cookies[k] = v;
            foreach (var (k, v) in info.CookieExpires) acc.CookieExpires[k] = v;
            foreach (var (k, v) in info.Meta) acc.Meta[k] = v is null ? null : JsonValue.Create(v);
            if (info.Ok)
            {
                acc.Status = AccountStatus.Active;
                acc.CooldownUntil = 0;
                acc.LastError = null;
            }
            s.Pool.NoteWake(acc, info.Meta);
            s.Pool.Upsert(acc);
            return Results.Json(new JsonObject
            {
                ["ok"] = info.Ok,
                ["account"] = acc.Public(),
                ["meta"] = JsonSerializer.SerializeToNode(info.Meta),
            });
        });
        admin.MapGet("/accounts/{id}/quota", async (HttpContext ctx, string id) =>
        {
            RequireAdmin(ctx, s);
            var acc = s.Pool.Get(id) ?? throw MuseException.NotFound($"account '{id}' not found");
            var snapshot = await s.Driver.Quota(acc);
            var quota = new JsonObject { ["checked_at"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() };
            foreach (var (k, v) in snapshot) quota[k] = JsonSerializer.SerializeToNode(v);
            acc.Meta["quota"] = quota;
            s.Pool.Upsert(acc);
            return Results.Json(new JsonObject { ["account_id"] = acc.Id, ["quota"] = quota });
        });
        // ---------- đồng bộ hội thoại từ web, mức 1 (v0.6.0) ----------
        // Chỉ liệt kê + đăng ký mapping; KHÔNG trả nội dung tin nhắn cũ.
        admin.MapPost("/accounts/{id}/web-threads", async (HttpContext ctx, string id) =>
        {
            RequireAdmin(ctx, s);
            var acc = s.Pool.Get(id) ?? throw MuseException.NotFound($"account '{id}' not found");
            // v0.8.12: ?forceTitles=true ép thăm dò nút sidebar bất kể
            // quét link được bao nhiêu thread (lệnh ép cập nhật tiêu đề
            // của extension); không có tham số thì false, giữ hành vi cũ.
            var forceTitles = ctx.Request.Query.TryGetValue("forceTitles", out var fv)
                && DiagnosticLines.ParseForceTitlesQuery(fv.ToString());
            var scan = await s.Driver.ListWebThreads(acc, forceTitles);
            // v0.8.3: ghi dòng tóm tắt ra stdout gateway để user sao
            // chép được từ Output > Muse Gateway (popup đồng bộ trôi
            // nhanh). Từ v0.8.5 việc ghi log nằm trong ListWebThreads
            // (ghi cả khi Auth, vì endpoint không tới được dòng này
            // khi ném lỗi) — endpoint không ghi lại để khỏi trùng dòng.
            // Dòng log chỉ số lượng + URL trang + tiêu đề chung, không
            // tiêu đề/URL thread.
            var arr = new JsonArray();
            foreach (var (url, title) in scan.Threads)
                // v0.8.8: title có thể null (thread qua thăm dò nút mà
                // document.title chỉ là tiêu đề chung) — extension tự
                // đặt dự phòng; thread qua link vẫn có title chuỗi.
                arr.Add(new JsonObject { ["url"] = url, ["title"] = title is null ? null : JsonValue.Create(title) });
            // debug v0.7.0, điểm 4 (mở rộng v0.8.5): chỉ số lượng +
            // tiêu đề chung, không nội dung trang. pages ghi riêng
            // trang chủ và /thread/new để popup về 0 nêu được số liệu
            // trang chủ, không chỉ trang cuối.
            var pagesArr = new JsonArray();
            foreach (var p in scan.Pages ?? new List<WebThreadsPageDiag>())
                pagesArr.Add(new JsonObject
                {
                    ["pageUrl"] = p.PageUrl,
                    ["threadCount"] = p.Threads,
                    ["linkCount"] = p.Links,
                    ["title"] = p.Title,
                    ["hasLoginForm"] = p.HasLoginForm,
                    ["buttonCount"] = p.Buttons,
                    ["sidebarClicked"] = p.SidebarClicked,
                });
            return Results.Json(new JsonObject
            {
                ["data"] = arr,
                ["debug"] = new JsonObject
                {
                    ["pageUrl"] = scan.PageUrl,
                    ["linkCount"] = scan.LinkCount,
                    ["threadCount"] = scan.Threads.Count,
                    ["pages"] = pagesArr,
                },
            });
        });
        // ---------- lịch sử tin nhắn của một thread web (v0.8.8) ----------
        // POST /admin/accounts/{id}/thread-messages, body {"url": ...}.
        // RequireAdmin như web-threads; không có tài khoản thì 404 như
        // web-threads; URL không phải /thread/ thì 400 rõ ràng; hết
        // hạn thì driver ném Auth như các đường khác; driver không
        // phải trình duyệt thì 501 qua default của interface (mock
        // giữ hành vi cũ, không cần mock endpoint mới). Trả
        // {"data": [{"role", "content"}], "title", "count"} — title
        // đã làm sạch theo quy tắc việc 1 (null = tiêu đề chung,
        // extension tự đặt dự phòng), count = số tin trong data.
        // Log CHỈ số lượng tin + id tài khoản (qua LogLocal, tiền tố
        // "[local] " do LogLocal thêm): không nội dung tin, không
        // tiêu đề hội thoại, không URL thread.
        admin.MapPost("/accounts/{id}/thread-messages", async (HttpContext ctx, string id) =>
        {
            RequireAdmin(ctx, s);
            var acc = s.Pool.Get(id) ?? throw MuseException.NotFound($"account '{id}' not found");
            var body = await JsonHelp.ReadBody(ctx.Request);
            var url = JsonHelp.Str(body["url"]) ?? "";
            if (!LocalConversationStore.IsThread(url))
                throw MuseException.Invalid("URL phải là thread muse.ai dạng /thread/<id>");
            var result = await s.Driver.GetThreadMessages(acc, url);
            s.LogLocal(DiagnosticLines.ThreadMessagesLine(id, result.Messages.Count));
            var data = new JsonArray();
            foreach (var m in result.Messages)
                data.Add(new JsonObject { ["role"] = m.Role, ["content"] = m.Content });
            return Results.Json(new JsonObject
            {
                ["data"] = data,
                ["title"] = result.Title is null ? null : JsonValue.Create(result.Title),
                ["count"] = result.Messages.Count,
            });
        });
        // ---------- hồ sơ tài khoản + gộp trùng (v0.7.0) ----------
        // profile-refresh: best-effort, không bao giờ log email/phone.
        // Lấy được gì thì cập nhật trường đó (trường đã có giá trị thì
        // giữ nguyên, không ghi đè); không lấy được gì thì trả account
        // cũ kèm profile_found=false, không lỗi. Phiên hết hạn thật
        // (Auth) thì vẫn lỗi để extension báo đăng nhập lại.
        admin.MapPost("/accounts/{id}/profile-refresh", async (HttpContext ctx, string id) =>
        {
            RequireAdmin(ctx, s);
            var acc = s.Pool.Get(id) ?? throw MuseException.NotFound($"account '{id}' not found");
            // v0.8.2: FetchProfileDetailed kèm debug (không chứa
            // email/phone) để panel Cài đặt hiện chẩn đoán ngắn gọn
            // khi profile_found=false thay vì chỉ nói chung chung.
            var (profile, debug) = await s.Driver.FetchProfileDetailed(acc);
            // v0.8.3: dọn rác đã lưu TRƯỚC khi gộp hồ sơ mới. Rác (email
            // dạng tên file ảnh, username dạng UUID) từ bản cũ phải bị
            // coi là rỗng để lần lấy mới hợp lệ ghi đè được; nếu lần
            // lấy mới không tìm được gì hợp lệ thì trường ở trạng thái
            // rỗng ("Chưa xác định") chứ không giữ rác. Dọn xong vẫn
            // phải Persist kể cả khi không lấy được gì mới — nếu không
            // lần mở panel sau rác lại hiện ra.
            // v0.8.5: chạy di chuyển dữ liệu cũ TRƯỚC dọn rác — username
            // UUID đã lưu phải chuyển sang MuseUserId trước khi sanitize
            // xóa nó (sanitize chạy sau sẽ xóa mất id nếu chạy trước).
            var cleaned = ProfileValidation.MigrateStoredIdentity(acc) | ProfileValidation.SanitizeStoredIdentity(acc);
            var found = false;
            if (profile is not null)
            {
                if (!string.IsNullOrWhiteSpace(profile.Email) && string.IsNullOrWhiteSpace(acc.Email))
                    { acc.Email = profile.Email.Trim(); found = true; }
                if (!string.IsNullOrWhiteSpace(profile.Username) && string.IsNullOrWhiteSpace(acc.Username))
                    { acc.Username = profile.Username.Trim(); found = true; }
                if (!string.IsNullOrWhiteSpace(profile.Phone) && string.IsNullOrWhiteSpace(acc.Phone))
                    { acc.Phone = profile.Phone.Trim(); found = true; }
                // v0.8.5: điền cả id người dùng Muse (chỉ khi trống).
                if (!string.IsNullOrWhiteSpace(profile.MuseUserId) && string.IsNullOrWhiteSpace(acc.MuseUserId))
                    { acc.MuseUserId = profile.MuseUserId.Trim().ToLowerInvariant(); found = true; }
                // Profile có giá trị nhưng các trường đã đầy: vẫn coi là
                // đã xác định được danh tính (found theo giá trị mới
                // điền không phản ánh đúng) — tính lại: found = có ít
                // nhất một trường hồ sơ (kể cả đã có sẵn) sau khi đọc.
                if (!found && (profile.Email is not null || profile.Username is not null || profile.Phone is not null || profile.MuseUserId is not null))
                    found = true;
                if (found || cleaned) s.Pool.Upsert(acc);
            }
            else if (cleaned) s.Pool.Upsert(acc);
            // v0.8.3: ghi dòng tóm tắt ra stdout gateway để user sao
            // chép được từ Output > Muse Gateway. Chỉ tên bước + cờ,
            // không email/phone/username hay giá trị nào.
            s.LogLocal(DiagnosticLines.ProfileRefreshLine(id, found, debug));
            var debugJson = new JsonObject
            {
                ["attempted"] = new JsonArray(debug.Attempted.Select(v => JsonValue.Create(v)).ToArray()),
                ["succeeded"] = new JsonArray(debug.Succeeded.Select(v => JsonValue.Create(v)).ToArray()),
                ["failed"] = new JsonArray(debug.Failed.Select(v => JsonValue.Create(v)).ToArray()),
                ["final_url"] = debug.FinalUrl,
                ["menu_opened"] = debug.MenuOpened,
                ["settings_opened"] = debug.SettingsOpened,
                ["candidate_count"] = debug.CandidateCount,
                // v0.8.3: tên bước nguồn của giá trị (không chứa giá trị).
                ["email_source"] = debug.EmailSource is null ? null : JsonValue.Create(debug.EmailSource),
                ["username_source"] = debug.UsernameSource is null ? null : JsonValue.Create(debug.UsernameSource),
                // v0.8.4: lý do bước home thất bại (chỉ tên loại, không giá trị).
                ["home_error"] = debug.HomeError is null ? null : JsonValue.Create(debug.HomeError),
            };
            return Results.Json(new JsonObject { ["account"] = acc.Public(), ["profile_found"] = found, ["debug"] = debugJson });
        });
        // merge-duplicates: CHỈ chạy khi user bấm nút và xác nhận ở
        // panel Cài đặt — không tự động gộp khi mở panel hay đăng nhập,
        // vì gộp là thao tác xóa tài khoản. Với mỗi tài khoản chưa có
        // danh tính thì thử FetchProfile trước (timeout 90s/tài khoản,
        // thất bại thì bỏ qua tài khoản đó, không dừng cả quá trình).
        // Nhóm theo Email chuẩn hóa (khóa chính); không có Email thì
        // nhóm theo Username khác rỗng. Nhóm >= 2 mới gộp. Tài khoản
        // chính = LastUsedAt mới nhất (bằng nhau thì CreatedAt sớm
        // nhất). Tài khoản phụ bị xóa khỏi Pool và các file
        // local-conversations của nó được viết lại sang hash của tài
        // khoản chính để thread cũ vẫn nối tiếp được.
        admin.MapPost("/accounts/merge-duplicates", async (HttpContext ctx) =>
        {
            RequireAdmin(ctx, s);
            var all = s.Pool.All();
            foreach (var acc in all)
            {
                // v0.8.5: tài khoản đã có id người dùng thì coi là đã có
                // danh tính, không cần fetch thêm.
                if (!string.IsNullOrWhiteSpace(acc.MuseUserId) || !string.IsNullOrWhiteSpace(acc.Email) || !string.IsNullOrWhiteSpace(acc.Username)) continue;
                try
                {
                    using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(90));
                    var profile = await s.Driver.FetchProfile(acc, cts.Token);
                    if (profile is null) continue;
                    if (!string.IsNullOrWhiteSpace(profile.Email)) acc.Email = profile.Email.Trim();
                    if (!string.IsNullOrWhiteSpace(profile.Username)) acc.Username = profile.Username.Trim();
                    if (!string.IsNullOrWhiteSpace(profile.Phone)) acc.Phone = profile.Phone.Trim();
                    if (!string.IsNullOrWhiteSpace(profile.MuseUserId)) acc.MuseUserId = profile.MuseUserId.Trim().ToLowerInvariant();
                    s.Pool.Upsert(acc);
                }
                catch { /* bỏ qua tài khoản này, không dừng cả quá trình */ }
            }
            all = s.Pool.All();
            // v0.8.3 (bổ sung theo user): dọn rác đã lưu trên MỌI tài
            // khoản TRƯỚC khi tính khóa nhóm — kể cả tài khoản sẽ thành
            // tài khoản chính sau gộp. Nếu không, tài khoản chính giữ
            // nguyên username UUID của nó sau gộp, và nhóm có thể tính
            // theo khóa rác. Gộp KHÔNG copy danh tính từ tài khoản phụ
            // sang tài khoản chính (chỉ xóa phụ + viết lại mapping
            // hội thoại), nên rác không lan theo đường đó; đường lan
            // còn lại là vòng điền FetchProfile ở trên, mà giá trị
            // FetchProfile nay đã qua kiểm tra hợp lệ tại nguồn.
            // Sau bước này, lần refresh sau gộp vẫn xóa được username
            // UUID của tài khoản chính nhờ đường dọn rác của
            // profile-refresh (độc lập với gộp).
            // v0.8.5: di chuyển username UUID sang MuseUserId TRƯỚC khi
            // dọn rác (lý do như profile-refresh: sanitize chạy trước
            // sẽ xóa mất id). Nhóm theo thứ tự: id người dùng → email
            // → username (xem AccountPool.IdentityGroupKey).
            foreach (var acc in all)
                if (ProfileValidation.MigrateStoredIdentity(acc) | ProfileValidation.SanitizeStoredIdentity(acc))
                    s.Pool.Upsert(acc);
            all = s.Pool.All();
            var groups = new Dictionary<string, List<Account>>(StringComparer.Ordinal);
            var skipped = new List<string>();
            foreach (var acc in all)
            {
                var key = AccountPool.IdentityGroupKey(acc);
                if (key is not null) { AddToGroup(groups, key, acc); continue; }
                skipped.Add(acc.Id);
            }
            var merged = new JsonArray();
            var conversations = new LocalConversationStore(s.Settings.DataDir);
            foreach (var (key, members) in groups)
            {
                if (members.Count < 2) continue;
                var primary = members
                    .OrderByDescending(a => a.LastUsedAt)
                    .ThenBy(a => a.CreatedAt)
                    .First();
                var mergedIds = new List<string>();
                foreach (var secondary in members.Where(a => a.Id != primary.Id))
                {
                    if (s.Pool.Remove(secondary.Id))
                    {
                        mergedIds.Add(secondary.Id);
                        try { await s.Driver.InvalidateAccount(secondary.Id); } catch { }
                        conversations.ReassignAccount(secondary.Id, primary.Id);
                    }
                }
                if (mergedIds.Count == 0) continue;
                merged.Add(new JsonObject
                {
                    ["primaryId"] = primary.Id,
                    ["primaryLabel"] = primary.Label,
                    ["mergedIds"] = new JsonArray(mergedIds.Select(i => (JsonNode?)i).ToArray()),
                    ["identity"] = key,
                });
            }
            return Results.Json(new JsonObject { ["merged"] = merged, ["skipped"] = new JsonArray(skipped.Select(i => (JsonNode?)i).ToArray()) });

            static void AddToGroup(Dictionary<string, List<Account>> groups, string key, Account acc)
            {
                if (!groups.TryGetValue(key, out var list)) { list = new List<Account>(); groups[key] = list; }
                list.Add(acc);
            }
        });
        admin.MapPost("/conversations/register", async (HttpContext ctx) =>
        {
            RequireAdmin(ctx, s);
            var body = await JsonHelp.ReadBody(ctx.Request);
            var accountId = JsonHelp.Str(body["accountId"])
                ?? throw MuseException.Invalid("accountId là bắt buộc");
            _ = s.Pool.Get(accountId) ?? throw MuseException.NotFound($"account '{accountId}' not found");
            var hint = JsonHelp.Str(body["hint"]) ?? "";
            var url = JsonHelp.Str(body["url"]) ?? "";
            if (string.IsNullOrWhiteSpace(hint))
                throw MuseException.Invalid("hint không được để trống");
            if (!LocalConversationStore.IsThread(url))
                throw MuseException.Invalid("URL không phải thread muse.ai hợp lệ");
            // AppState không expose LocalConversationStore nên tạo mới
            // giống cách BrowserDriver tạo (new(settings.DataDir)).
            new LocalConversationStore(s.Settings.DataDir).Save(accountId, hint, url, pending: false);
            return Results.Json(new JsonObject { ["ok"] = true });
        });
        admin.MapGet("/conversations/urls", (HttpContext ctx) =>
        {
            RequireAdmin(ctx, s);
            var arr = new JsonArray();
            var dir = Path.Combine(s.Settings.DataDir, "local-conversations");
            if (Directory.Exists(dir))
            {
                foreach (var file in Directory.EnumerateFiles(dir, "*.json"))
                {
                    LocalConversationStore.Entry? entry;
                    try { entry = JsonSerializer.Deserialize<LocalConversationStore.Entry>(File.ReadAllText(file)); }
                    catch { continue; } // File hỏng: bỏ qua, không vỡ cả danh sách.
                    if (entry is null || string.IsNullOrEmpty(entry.Url)) continue;
                    // Chỉ trả URL + hash tài khoản; KHÔNG trả hint gốc
                    // (hint là conversationId nội bộ) và không trả cookie.
                    arr.Add(new JsonObject { ["url"] = entry.Url, ["accountHash"] = entry.Account });
                }
            }
            return Results.Json(new JsonObject { ["data"] = arr });
        });
        // ---------- xóa mapping + tìm chủ sở hữu mapping (v0.8.2) ----------
        // DELETE /admin/conversations/{hint}: xóa file mapping của
        // đúng hint đó (hint = conversationId của session trong
        // extension). File không tồn tại thì mapping_deleted=false,
        // không lỗi. KHÔNG xóa thread trên web muse.ai (đồng bộ mức 1
        // không có tính năng xóa web, gateway không có API xóa thread).
        admin.MapDelete("/conversations/{hint}", (HttpContext ctx, string hint) =>
        {
            RequireAdmin(ctx, s);
            var deleted = new LocalConversationStore(s.Settings.DataDir).DeleteByHint(hint);
            return Results.Json(new JsonObject { ["hint"] = hint, ["mapping_deleted"] = deleted });
        });
        // GET /admin/conversations/by-hint/{hint}: tìm tài khoản sở
        // hữu mapping của hint để extension backfill accountId cho
        // session đã chat nhưng chưa có accountId. Đọc file mapping,
        // lấy Entry.Account (là hash), đối chiếu với Hash của từng
        // tài khoản đang trong pool. KHÔNG trả hash ra ngoài, KHÔNG
        // đảo ngược hash bằng cách khác. Không tìm thấy file, file
        // hỏng, hoặc tài khoản không còn trong pool thì 404.
        admin.MapGet("/conversations/by-hint/{hint}", (HttpContext ctx, string hint) =>
        {
            RequireAdmin(ctx, s);
            var entry = new LocalConversationStore(s.Settings.DataDir).LoadByHint(hint);
            if (entry is null)
                throw MuseException.NotFound($"không tìm thấy mapping cho hint này");
            var owner = s.Pool.All().FirstOrDefault(a =>
                LocalConversationStore.HashAccount(a.Id) == entry.Account);
            if (owner is null)
                throw MuseException.NotFound($"tài khoản sở hữu mapping này không còn trong pool");
            return Results.Json(new JsonObject { ["account"] = owner.Public() });
        });
        // ---------- đăng nhập qua trình duyệt (v0.5.0) ----------
        // Mở cửa sổ Chromium có đầu của chính gateway để user đăng nhập
        // (xem BrowserLogin.cs: không đọc profile trình duyệt hệ thống).
        admin.MapPost("/login/browser/start", async (HttpContext ctx) =>
        {
            RequireAdmin(ctx, s);
            var body = await JsonHelp.ReadBody(ctx.Request);
            var session = await s.Login.StartAsync(JsonHelp.Str(body["label"]), JsonHelp.Str(body["accountId"]));
            return Results.Json(new JsonObject { ["login_id"] = session.Id, ["status"] = session.Status });
        });
        admin.MapGet("/login/browser/{id}/status", async (HttpContext ctx, string id) =>
        {
            RequireAdmin(ctx, s);
            var session = await s.Login.CheckAsync(id);
            return Results.Json(BrowserLoginManager.View(session));
        });
        admin.MapPost("/login/browser/{id}/cancel", async (HttpContext ctx, string id) =>
        {
            RequireAdmin(ctx, s);
            var session = await s.Login.CancelAsync(id);
            return Results.Json(BrowserLoginManager.View(session));
        });
        admin.MapGet("/extension.zip", (HttpContext ctx) =>
        {
            RequireAdmin(ctx, s);
            throw MuseException.NotFound("the browser extension is not bundled with this server");
        });
        admin.MapGet("/tasks", (HttpContext ctx) =>
        {
            RequireAdmin(ctx, s);
            var limit = int.TryParse(ctx.Request.Query["limit"], out var l) ? l : 100;
            var arr = new JsonArray();
            foreach (var t in s.Tasks.List(limit)) arr.Add(TaskJson(t));
            return Results.Json(new JsonObject { ["data"] = arr });
        });
        admin.MapPost("/tasks/{taskId}/cancel", (HttpContext ctx, string taskId) =>
        {
            RequireAdmin(ctx, s);
            return Results.Json(new JsonObject { ["cancelled"] = s.Tasks.Cancel(taskId) });
        });
        admin.MapGet("/keys", (HttpContext ctx) =>
        {
            RequireAdmin(ctx, s);
            var usage = s.Requests.KeyUsage().ToDictionary(u => u["key_id"]?.ToString() ?? "");
            JsonObject UsageFor(string id) => usage.TryGetValue(id, out var u)
                ? new JsonObject
                {
                    ["total"] = (int)(u["total"] ?? 0),
                    ["requests_24h"] = (int)(u["requests_24h"] ?? 0),
                    ["errors_24h"] = (int)(u["errors_24h"] ?? 0),
                    ["last_request_at"] = u["last_request_at"] is null ? null
                        : JsonValue.Create((double)u["last_request_at"]!),
                }
                : new JsonObject
                { ["total"] = 0, ["requests_24h"] = 0, ["errors_24h"] = 0, ["last_request_at"] = null };
            var data = new JsonArray();
            foreach (var k in s.Keys.All())
            {
                var pub = k.Public();
                pub["usage"] = UsageFor(k.Id);
                data.Add(pub);
            }
            var builtin = new JsonArray();
            foreach (var b in new[] { "legacy", "admin" })
            {
                var obj = new JsonObject { ["id"] = b, ["name"] = b };
                obj["usage"] = UsageFor(b);
                builtin.Add(obj);
            }
            return Results.Json(new JsonObject { ["data"] = data, ["builtin"] = builtin });
        });
        admin.MapGet("/keys/usage", (HttpContext ctx) =>
        {
            RequireAdmin(ctx, s);
            var arr = new JsonArray();
            foreach (var u in s.Requests.KeyUsage()) arr.Add(JsonSerializer.SerializeToNode(u));
            return Results.Json(new JsonObject
            {
                ["since"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 86400,
                ["data"] = arr,
            });
        });
        admin.MapPost("/keys", async (HttpContext ctx) =>
        {
            RequireAdmin(ctx, s);
            var body = await JsonHelp.ReadBody(ctx.Request);
            var name = JsonHelp.Str(body["name"]);
            if (string.IsNullOrWhiteSpace(name) || name.Length > 100)
                throw MuseException.Invalid("key name must be 1-100 characters");
            var (key, plaintext) = s.Keys.Create(name.Trim(), JsonHelp.Str(body["note"]) ?? "");
            return Results.Json(new JsonObject { ["key"] = key.Public(), ["api_key"] = plaintext });
        });
        admin.MapPatch("/keys/{keyId}", async (HttpContext ctx, string keyId) =>
        {
            RequireAdmin(ctx, s);
            var key = s.Keys.Get(keyId) ?? throw MuseException.NotFound($"key '{keyId}' not found");
            var body = await JsonHelp.ReadBody(ctx.Request);
            if (JsonHelp.Str(body["name"]) is { } name)
            {
                if (string.IsNullOrWhiteSpace(name) || name.Length > 100) throw MuseException.Invalid("key name must be 1-100 characters");
                key.Name = name.Trim();
            }
            if (JsonHelp.Str(body["note"]) is { } note) key.Note = note;
            if (body["revoked"] is JsonValue rv && rv.TryGetValue<bool>(out var revoked)) key.Revoked = revoked;
            s.Keys.Save();
            return Results.Json(new JsonObject { ["key"] = key.Public() });
        });
        admin.MapDelete("/keys/{keyId}", (HttpContext ctx, string keyId) =>
        {
            RequireAdmin(ctx, s);
            if (!s.Keys.Remove(keyId)) throw MuseException.NotFound($"key '{keyId}' not found");
            return Results.Json(new JsonObject { ["deleted"] = keyId });
        });
        admin.MapGet("/requests", (HttpContext ctx) =>
        {
            RequireAdmin(ctx, s);
            var q = ctx.Request.Query;
            double? since = double.TryParse(q["since"], System.Globalization.NumberStyles.Float,
                System.Globalization.CultureInfo.InvariantCulture, out var sv) && double.IsFinite(sv) ? sv : null;
            var limit = int.TryParse(q["limit"], out var l) ? Math.Clamp(l, 1, 500) : 100;
            var offset = int.TryParse(q["offset"], out var o) ? Math.Max(0, o) : 0;
            var (rows, total) = s.Requests.Query(
                q["key_id"].ToString() is { Length: > 0 } a ? a : null,
                q["account_id"].ToString() is { Length: > 0 } b ? b : null,
                q["status"].ToString() is { Length: > 0 } c ? c : null,
                q["path"].ToString() is { Length: > 0 } d ? d : null,
                since, q.ContainsKey("hide_polls") && q["hide_polls"] != "false", limit, offset);
            var arr = new JsonArray();
            foreach (var r in rows) arr.Add(new JsonObject
            {
                ["ts"] = r.Ts,
                ["method"] = r.Method,
                ["path"] = r.Path,
                ["model"] = r.Model is null ? null : JsonValue.Create(r.Model),
                ["key_id"] = r.KeyId is null ? null : JsonValue.Create(r.KeyId),
                ["key_name"] = r.KeyName is null ? null : JsonValue.Create(r.KeyName),
                ["account_id"] = r.AccountId is null ? null : JsonValue.Create(r.AccountId),
                ["status_code"] = r.StatusCode,
                ["latency_ms"] = r.LatencyMs,
                ["stream"] = r.Stream,
                ["poll"] = r.Poll,
                ["error"] = r.Error is null ? null : JsonValue.Create(r.Error),
                ["client_ip"] = r.ClientIp is null ? null : JsonValue.Create(r.ClientIp),
                ["task_id"] = r.TaskId is null ? null : JsonValue.Create(r.TaskId),
            });
            return Results.Json(new JsonObject { ["data"] = arr, ["total"] = total });
        });
        admin.MapGet("/stats", (HttpContext ctx) =>
        {
            RequireAdmin(ctx, s);
            var window = ctx.Request.Query["window"].ToString();
            if (window is not ("1h" or "24h" or "7d")) window = "24h";
            var stats = s.Requests.Stats(window);
            stats["now"] = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            return Results.Json(JsonSerializer.SerializeToNode(stats));
        });
        admin.MapGet("/metrics", (HttpContext ctx) =>
        {
            RequireAdmin(ctx, s);
            var window = ctx.Request.Query["window"].ToString();
            if (window is not ("1h" or "24h" or "7d")) window = "24h";
            return Results.Content(MetricsText(s, window), "text/plain; version=0.0.4");
        });
    }

    private static Account BuildAccount(JsonObject body)
    {
        var (cookies, expires) = ParseCookies(body["cookies"]);
        cookies = cookies.Where(kv => !string.IsNullOrEmpty(kv.Value))
            .ToDictionary(kv => kv.Key, kv => kv.Value);
        expires = expires.Where(kv => cookies.ContainsKey(kv.Key))
            .ToDictionary(kv => kv.Key, kv => kv.Value);
        if (cookies.Count == 0) throw MuseException.Invalid("cookies must not be empty");
        var acc = new Account
        {
            Label = JsonHelp.Str(body["label"]) ?? "",
            Cookies = cookies,
            CookieExpires = expires,
            Enabled = body["enabled"] is JsonValue ev && ev.TryGetValue<bool>(out var e) ? e : true,
            Email = JsonHelp.Str(body["email"]),
            Username = JsonHelp.Str(body["username"]),
            Phone = JsonHelp.Str(body["phone"]),
        };
        foreach (var (k, v) in expires.ToList())
            if (body["cookie_expires"] is JsonObject extra && extra[k] is not null)
                acc.CookieExpires[k] = JsonHelp.Long(extra[k]);
        if (body["cookie_expires"] is JsonObject extraAll)
            foreach (var (k, v) in extraAll)
                if (cookies.ContainsKey(k)) acc.CookieExpires[k] = JsonHelp.Long(v);
        return acc;
    }

    private static (Dictionary<string, string>, Dictionary<string, long>) ParseCookies(JsonNode? node)
    {
        if (node is JsonObject obj)
            return (obj.ToDictionary(kv => kv.Key, kv => JsonHelp.Str(kv.Value) ?? ""),
                new Dictionary<string, long>());
        if (node is JsonValue sv && sv.TryGetValue<string>(out var str))
        {
            var cookies = new Dictionary<string, string>();
            foreach (var part in str.Split(';'))
            {
                var p = part.Trim();
                if (p.Length == 0 || !p.Contains('=')) continue;
                var eq = p.IndexOf('=');
                cookies[p[..eq].Trim()] = p[(eq + 1)..].Trim();
            }
            return (cookies, new Dictionary<string, long>());
        }
        if (node is JsonArray arr)
        {
            var cookies = new Dictionary<string, string>();
            var expires = new Dictionary<string, long>();
            for (var i = 0; i < arr.Count; i++)
            {
                if (arr[i] is not JsonObject entry || JsonHelp.Str(entry["name"]) is not { } name)
                    throw MuseException.Invalid($"cookies[{i}] must be an object with 'name' and 'value'");
                cookies[name] = JsonHelp.Str(entry["value"]) ?? "";
                if (entry["expirationDate"] is JsonValue dv && dv.TryGetValue<double>(out var d))
                    expires[name] = (long)d;
            }
            return (cookies, expires);
        }
        throw MuseException.Invalid("cookies must be a dict, a raw 'Cookie' header string, or a cookie-export list");
    }

    private static JsonObject DictToJson(Dictionary<string, JsonNode?>? dict)
    {
        if (dict is null) return null!;
        var obj = new JsonObject();
        foreach (var (k, v) in dict) obj[k] = v?.DeepClone();
        return obj;
    }

    private static JsonObject TaskJson(BgTask t) => new()
    {
        ["id"] = t.Id,
        ["kind"] = t.Kind,
        ["status"] = t.Status,
        ["progress"] = t.Progress,
        ["created_at"] = t.CreatedAt,
        ["updated_at"] = t.UpdatedAt,
        ["request"] = JsonSerializer.SerializeToNode(t.Request),
        ["result"] = t.Result is null ? null : DictToJson(t.Result),
        ["error"] = t.Error is null ? null : DictToJson(t.Error),
    };

    private static string PromLabel(object? v)
        => (v?.ToString() ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\n", "\\n");

    private static string MetricsText(AppState s, string window)
    {
        var data = s.Requests.Stats(window);
        var pool = s.Pool.Stats();
        var lines = new List<string>
        {
            "# HELP muse2api_info Gateway version info.",
            "# TYPE muse2api_info gauge",
            $"muse2api_info{{version=\"{Version}\"}} 1",
            "# HELP muse2api_requests_window_total Requests in the window (polls excluded).",
            "# TYPE muse2api_requests_window_total gauge",
            $"muse2api_requests_window_total{{window=\"{window}\"}} {data["total"]}",
            "# HELP muse2api_requests_window_errors Failed requests in the window.",
            "# TYPE muse2api_requests_window_errors gauge",
            $"muse2api_requests_window_errors{{window=\"{window}\"}} {data["errors"]}",
            "# HELP muse2api_requests_window_server_errors Requests with HTTP 5xx in the window.",
            "# TYPE muse2api_requests_window_server_errors gauge",
            $"muse2api_requests_window_server_errors{{window=\"{window}\"}} {data["server_errors"]}",
            "# HELP muse2api_requests_window_error_rate Failed requests as a fraction of the window total.",
            "# TYPE muse2api_requests_window_error_rate gauge",
            FormattableString.Invariant($"muse2api_requests_window_error_rate{{window=\"{window}\"}} {data["error_rate"]}"),
        };
        if (data["latency_ms"] is Dictionary<string, object?> lat)
            foreach (var (name, value) in new[] { ("p50", lat["p50"]), ("p95", lat["p95"]) })
                if (value is not null)
                    lines.Add($"muse2api_request_latency_ms{{window=\"{window}\",quantile=\"{name}\"}} {value}");
        // Stats.By returns a unified row shape; pick the field that matches each group.
        if (data["by_status"] is List<Dictionary<string, object?>> byStatus)
            foreach (var row in byStatus)
                lines.Add($"muse2api_requests_by_status{{window=\"{window}\",status_code=\"{PromLabel(row["status_code"])}\"}} {row["count"]}");
        if (data["by_key"] is List<Dictionary<string, object?>> byKey)
            foreach (var row in byKey)
                lines.Add($"muse2api_requests_by_key{{window=\"{window}\",key_id=\"{PromLabel(row["key_id"])}\",key_name=\"{PromLabel(row["key_name"])}\"}} {row["count"]}");
        if (data["by_account"] is List<Dictionary<string, object?>> byAccount)
            foreach (var row in byAccount)
                lines.Add($"muse2api_requests_by_account{{window=\"{window}\",account_id=\"{PromLabel(row["account_id"])}\"}} {row["count"]}");
        if (data["by_model"] is List<Dictionary<string, object?>> byModel)
            foreach (var row in byModel)
                lines.Add($"muse2api_requests_by_model{{window=\"{window}\",model=\"{PromLabel(row["model"])}\"}} {row["count"]}");
        foreach (var (state, value) in pool)
            lines.Add($"muse2api_accounts{{state=\"{state}\"}} {value}");
        return string.Join("\n", lines) + "\n";
    }

    private const string DashboardHtml = """
        <!doctype html><html lang="en"><head><meta charset="utf-8">
        <title>muse2api (.NET) dashboard</title></head><body>
        <h1>muse2api (.NET port)</h1>
        <p>This is a minimal dashboard for the .NET port. Enter the admin key,
        then use the buttons. The full Python dashboard.html is not ported yet.</p>
        <label>Admin key <input id="key" type="password" size="40"></label>
        <button onclick="show('/admin/status')">Status</button>
        <button onclick="show('/admin/accounts')">Accounts</button>
        <button onclick="show('/admin/stats')">Stats</button>
        <button onclick="show('/admin/metrics')">Metrics</button>
        <pre id="out"></pre>
        <script>
        async function show(path) {
          const key = document.getElementById('key').value;
          const r = await fetch(path, { headers: { Authorization: 'Bearer ' + key } });
          document.getElementById('out').textContent = await r.text();
        }
        </script></body></html>
        """;
}
