using System.Text.Json;
using Microsoft.Playwright;

namespace Muse2Api;

/// <summary>Browser driver, ported from Python <c>drivers/browser/</c> to
/// Microsoft.Playwright.
/// <para>
/// Design (same as Python): one Chromium process; each account gets its own
/// browser context (isolated cookie jar), so switching accounts never requires
/// clearing cookies. One page per tab, reused across requests. Per-account
/// serialisation is guaranteed by the account pool
/// (<c>MUSE2API_ACCOUNT_MAX_CONCURRENCY=1</c> by default).
/// </para>
/// <para>
/// <b>Setup on Windows:</b> after building, install the matching browser with
/// <c>pwsh src/Muse2Api/bin/Release/net8.0/playwright.ps1 install chromium</c>.
/// Or set <c>MUSE2API_CHROMIUM_PATH</c> to an
/// existing Chrome/Chromium executable, which Playwright will use instead.
/// </para>
/// <para>
/// Local agent replies preserve rendered code fences and wait for a stable
/// complete response before decoding tool JSON. The local read/edit/command
/// round trip has been verified with a real Muse account; upstream UI changes
/// may still require selector updates in <c>Dom.cs</c>.
/// </para>
/// </summary>
public sealed class BrowserDriver : IMuseDriver
{
    public event Action<string>? Diagnostic;
    public string Name => "browser";
    public bool RequiresAccount => true;
    public DriverCapabilities Capabilities { get; } = new(
        Chat: true, ChatImages: true, Image: true, ImageEdit: true, Video: true,
        RenewSession: true, Quota: true);

    private const double PollInterval = 0.15;
    private const int StablePollsDone = 4;
    private const int HotBubbleLimit = 16;
    private const double QuotaClickTimeout = 8;
    private const double QuotaReadTimeout = 12;
    private const double EscapePause = 0.1;

    private readonly Settings _settings;
    private readonly BrowserSessionStore _sessions;
    private readonly LocalConversationStore _localConversations;
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, SemaphoreSlim> _localGates = new();
    private readonly HashSet<string> _resetContexts = new();
    private IPlaywright? _playwright;
    private IBrowser? _browser;
    private readonly Dictionary<string, IBrowserContext> _contexts = new();
    private readonly Dictionary<string, string> _contextAuthHashes = new();
    private readonly Dictionary<string, List<BrowserTab>> _tabs = new();
    private readonly Dictionary<string, int> _opening = new();
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, Dictionary<string, object?>> _quotaCache = new();
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, SemaphoreSlim> _quotaLocks = new();
    private readonly System.Collections.Concurrent.ConcurrentDictionary<string, SemaphoreSlim> _contextLocks = new();
    private readonly SemaphoreSlim _startupLock = new(1, 1);
    private readonly object _lock = new();

    public BrowserDriver(Settings settings) { _settings = settings; _sessions = new(settings.DataDir); _localConversations = new(settings.DataDir); }

    // ---------- lifecycle ----------
    public async Task StartupAsync()
    {
        await _startupLock.WaitAsync();
        try
        {
            if (_browser is not null) return;
            _playwright = await Playwright.CreateAsync();
            var launch = new BrowserTypeLaunchOptions
            {
                Headless = _settings.Headless,
                Args = new[]
                {
                "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage",
                "--disable-background-networking", "--autoplay-policy=no-user-gesture-required",
                "--window-size=1440,2200",
            },
            };
            if (!string.IsNullOrEmpty(_settings.ChromiumPath)) launch.ExecutablePath = _settings.ChromiumPath;
            if (!string.IsNullOrEmpty(_settings.BrowserProxy))
                launch.Proxy = new Proxy { Server = _settings.BrowserProxy };
            try
            {
                _browser = await _playwright.Chromium.LaunchAsync(launch);
            }
            catch (Exception ex)
            {
                _playwright.Dispose();
                _playwright = null;
                throw new MuseException(
                "Could not launch Playwright Chromium. Install the matching browser with: pwsh \""
                + Path.Combine(AppContext.BaseDirectory, "playwright.ps1") + "\" install chromium "
                    + $" (or set MUSE2API_CHROMIUM_PATH). Original error: {ex.Message}",
                    500, "server_error", "browser_not_installed");
            }
        }
        finally { _startupLock.Release(); }
    }

    public async Task ShutdownAsync()
    {
        List<BrowserTab> tabs;
        lock (_lock) tabs = _tabs.Values.SelectMany(t => t).ToList();
        foreach (var tab in tabs) await CloseTab(tab);
        if (_browser is not null) await _browser.CloseAsync();
        _playwright?.Dispose();
        _browser = null;
        _playwright = null;
        lock (_lock) { _contexts.Clear(); _contextAuthHashes.Clear(); _resetContexts.Clear(); _tabs.Clear(); _opening.Clear(); }
        _quotaCache.Clear();
    }

    public Task<Dictionary<string, object?>> Health()
    {
        List<BrowserTab> tabs;
        lock (_lock) tabs = _tabs.Values.SelectMany(t => t).ToList();
        return Task.FromResult(new Dictionary<string, object?>
        {
            ["driver"] = Name,
            ["ok"] = _browser is not null,
            ["tabs"] = tabs.Count,
            ["busy_tabs"] = tabs.Count(t => t.Busy),
        });
    }

    // ---------- tabs ----------
    private sealed class BrowserTab
    {
        public required string AccountId { get; init; }
        public required IPage Page { get; init; }
        public string? Hint { get; set; }
        public List<(string Role, string Text)> Turns { get; set; } = new();
        public int ImageCount { get; set; }
        public string ThreadUrl { get; set; } = "";
        public string QuotaNote { get; set; } = "";
        public bool Busy { get; set; }
        public bool Stale { get; set; }
        public bool Closed { get; set; }
        public bool Local { get; set; }
        public bool RateLimited { get; set; }
        public bool HasState => Turns.Count > 0 || ThreadUrl.Length > 0 || Local && Hint is { Length: > 0 };
    }

    private async Task<BrowserTab> Checkout(Account account, Func<BrowserTab, bool>? prefer, CancellationToken cancel = default)
    {
        var limit = Math.Max(1, _settings.AccountMaxConcurrency);
        var deadline = DateTime.UtcNow.AddSeconds(_settings.PoolAcquireTimeout);
        while (true)
        {
            cancel.ThrowIfCancellationRequested();
            BrowserTab? match = null;
            bool canOpen;
            lock (_lock)
            {
                var tabs = _tabs.GetValueOrDefault(account.Id) ?? new List<BrowserTab>();
                _tabs[account.Id] = tabs;
                tabs.RemoveAll(t => t.Closed);
                var idle = tabs.Where(t => !t.Busy && !t.Stale).ToList();
                canOpen = tabs.Count + _opening.GetValueOrDefault(account.Id) < limit;
                match = idle.FirstOrDefault(t => prefer is null || prefer(t));
                if (match is null && idle.Count > 0 && !canOpen)
                    match = idle.FirstOrDefault(t => !t.HasState) ?? idle[0];
                if (match is not null) match.Busy = true;
                else if (canOpen) _opening[account.Id] = _opening.GetValueOrDefault(account.Id) + 1;
            }
            if (match is not null) return match;
            if (canOpen)
            {
                try
                {
                    var tab = await OpenTab(account);
                    lock (_lock)
                    {
                        tab.Busy = true;
                        _tabs[account.Id].Add(tab);
                    }
                    return tab;
                }
                finally
                {
                    lock (_lock) _opening[account.Id] = _opening.GetValueOrDefault(account.Id) - 1;
                }
            }
            if (DateTime.UtcNow > deadline)
                throw MuseException.NoAccount("all tabs of the account are busy, try again later");
            await Task.Delay(100);
        }
    }

    private void Checkin(BrowserTab tab)
    {
        lock (_lock)
        {
            tab.Busy = false;
            if (tab.Stale) _ = CloseTab(tab);
        }
    }

    private async Task<IBrowserContext> GetContext(Account account)
    {
        var gate = _contextLocks.GetOrAdd(account.Id, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync();
        try
        {
            if (_browser is null) await StartupAsync();
            lock (_lock)
            {
                if (_contexts.TryGetValue(account.Id, out var existing)) return existing;
            }
            if (_browser is null) throw new MuseException("browser is not started", 500);
            var context = await _browser.NewContextAsync(new BrowserNewContextOptions
            {
                ViewportSize = new ViewportSize { Width = 1440, Height = 2200 },
                StorageState = _sessions.Load(account),
            });
            await SetCookies(context, account);
            lock (_lock) { _contexts[account.Id] = context; _contextAuthHashes[account.Id] = BrowserSessionStore.AuthenticationHash(account); }
            return context;
        }
        finally { gate.Release(); }
    }

    private async Task<BrowserTab> OpenTab(Account account)
    {
        if (Upstream.MissingSessionCookies(account.Cookies) is { Count: > 0 } missing)
            throw UpstreamException.Auth(
                $"account is missing session cookies: {string.Join(", ", missing)}");
        var context = await GetContext(account);
        var page = await context.NewPageAsync();
        var tab = new BrowserTab { AccountId = account.Id, Page = page };
        page.Response += (_, response) =>
        {
            if (response.Status == 429 && Uri.TryCreate(response.Url, UriKind.Absolute, out var uri)
                && uri.Host.Equals("muse.ai", StringComparison.OrdinalIgnoreCase) && uri.AbsolutePath.StartsWith("/api/", StringComparison.Ordinal)) tab.RateLimited = true;
        };
        return tab;
    }

    private async Task CloseTab(BrowserTab tab)
    {
        if (tab.Closed) return;
        tab.Closed = true;
        tab.Busy = false;
        bool last;
        IBrowserContext? context = null;
        lock (_lock)
        {
            var tabs = _tabs.GetValueOrDefault(tab.AccountId) ?? new List<BrowserTab>();
            tabs.Remove(tab);
            last = tabs.Count == 0 && _opening.GetValueOrDefault(tab.AccountId) == 0;
            if (last && _resetContexts.Remove(tab.AccountId) && _contexts.TryGetValue(tab.AccountId, out var ctx))
            {
                _contexts.Remove(tab.AccountId);
                _contextAuthHashes.Remove(tab.AccountId);
                context = ctx;
            }
        }
        try { await tab.Page.CloseAsync(); } catch { }
        if (context is not null) try { await context.CloseAsync(); } catch { }
    }

    private static async Task SetCookies(IBrowserContext context, Account account)
    {
        var cookies = new List<Cookie>();
        foreach (var (name, value) in account.Cookies)
        {
            if (string.IsNullOrEmpty(value)) continue;
            var exp = account.CookieExpires.GetValueOrDefault(name);
            cookies.Add(new Cookie
            {
                Name = name,
                Value = value,
                Domain = ".muse.ai",
                Path = "/",
                Secure = true,
                Expires = exp > 0 ? exp : -1,
            });
        }
        if (cookies.Count > 0) await context.AddCookiesAsync(cookies);
    }

    private static void Forget(BrowserTab tab)
    {
        tab.Hint = null; tab.Turns = new(); tab.ImageCount = 0; tab.ThreadUrl = "";
        tab.Local = false; tab.RateLimited = false;
    }

    private static void LoadHot(BrowserTab tab, Account account)
    {
        if (tab.Turns.Count > 0 || tab.ThreadUrl.Length > 0) return;
        if (account.Meta.GetValueOrDefault("hot_page") is not System.Text.Json.Nodes.JsonObject hot) return;
        var turns = new List<(string, string)>();
        if (hot["turns"] is System.Text.Json.Nodes.JsonArray arr)
            foreach (var item in arr)
                if (item is System.Text.Json.Nodes.JsonArray pair && pair.Count == 2)
                    turns.Add((pair[0]?.GetValue<string>() ?? "", pair[1]?.GetValue<string>() ?? ""));
        tab.Turns = turns;
        tab.Hint = hot["hint"]?.GetValue<string>();
        tab.ThreadUrl = hot["url"]?.GetValue<string>() ?? "";
        tab.ImageCount = hot["image_count"] is System.Text.Json.Nodes.JsonValue v
            && v.TryGetValue<int>(out var n) ? n : 0;
    }

    private static void SaveHot(BrowserTab tab, Account account, ChatRequest req, string url)
    {
        if (url.Length > 0) tab.ThreadUrl = url;
        tab.Hint = req.ConversationHint;
        tab.Turns = new List<(string, string)>(req.Turns);
        tab.ImageCount = req.Images.Count;
        account.Meta["hot_page"] = new System.Text.Json.Nodes.JsonObject
        {
            ["hint"] = req.ConversationHint ?? "",
            ["turns"] = new System.Text.Json.Nodes.JsonArray(
                req.Turns.Select(t => (System.Text.Json.Nodes.JsonNode)new System.Text.Json.Nodes.JsonArray(t.Role, t.Text)).ToArray()),
            ["url"] = tab.ThreadUrl,
            ["image_count"] = tab.ImageCount,
        };
    }

    // ---------- page helpers ----------
    private static async Task<System.Text.Json.Nodes.JsonNode?> Eval(IPage page, string script, CancellationToken cancel = default)
    {
        try
        {
            var el = await page.EvaluateAsync<System.Text.Json.JsonElement>(script).WaitAsync(TimeSpan.FromSeconds(10), cancel);
            return el.ValueKind == System.Text.Json.JsonValueKind.Undefined
                ? null : System.Text.Json.Nodes.JsonNode.Parse(el.GetRawText());
        }
        catch (OperationCanceledException) { throw; }
        catch
        {
            return null;
        }
    }

    private static string? Str(System.Text.Json.Nodes.JsonNode? node, string key)
        => node?[key]?.GetValue<string>();
    private static bool BoolNode(System.Text.Json.Nodes.JsonNode? node, string key)
        => node?[key] is System.Text.Json.Nodes.JsonValue v && v.TryGetValue<bool>(out var b) && b;
    private static int IntNode(System.Text.Json.Nodes.JsonNode? node, string key)
        => node?[key] is System.Text.Json.Nodes.JsonValue v && v.TryGetValue<int>(out var n) ? n : 0;

    private static bool IsThreadUrl(string url)
    {
        var path = new Uri(url).AbsolutePath.TrimEnd('/');
        return path.StartsWith("/thread/", StringComparison.Ordinal) && path != "/thread/new";
    }

    private async Task<System.Text.Json.Nodes.JsonNode?> PageState(IPage page)
        => await Eval(page, Dom.PageState);

    private async Task<System.Text.Json.Nodes.JsonNode?> ChatState(BrowserTab tab, CancellationToken cancel = default, string? localRequestId = null)
    {
        if (tab.RateLimited) throw UpstreamException.Quota("Muse returned rate limit (HTTP 429). Conversation retained; no automatic retry or replacement chat.");
        if (tab.Page.IsClosed) throw UpstreamException.ResponseUnavailable("Muse web page closed; stopped waiting. Conversation retained.");
        var state = await Eval(tab.Page, localRequestId is null ? Dom.ChatState : Dom.ReadChatState(localRequestId), cancel)
            ?? throw UpstreamException.ResponseUnavailable("Muse web state unavailable; stopped waiting. Conversation retained.");
        if (BoolNode(state, "rateLimited")) throw UpstreamException.Quota("Muse shows a rate limit notice. Conversation retained; no automatic retry or replacement chat.");
        if (!string.IsNullOrWhiteSpace(Str(state, "error")))
            throw UpstreamException.ResponseUnavailable("Muse web stopped responding: " + Str(state, "error"));
        var tail = Str(state, "tail") ?? "";
        var low = tail.ToLowerInvariant();
        foreach (var hint in Dom.QuotaHints)
        {
            if (!low.Contains(hint)) continue;
            var i = low.IndexOf(hint, StringComparison.Ordinal);
            var snippet = string.Join(" ", tail[Math.Max(0, i - 120)..Math.Min(tail.Length, i + 120)].Split());
            var reply = Str(state, "lastText") ?? "";
            if (!BoolNode(state, "generating") && reply.ToLowerInvariant().Contains(hint))
                throw UpstreamException.Quota(
                    $"muse.ai reports the account is out of quota: …{snippet}…");
            if (snippet != tab.QuotaNote)
            {
                tab.QuotaNote = snippet;
                Console.WriteLine($"ignoring quota hint '{hint}' outside the reply: {snippet}");
            }
        }
        return state;
    }

    private async Task NewThread(BrowserTab tab)
    {
        Forget(tab);
        await tab.Page.GotoAsync(Upstream.NewThreadUrl,
            new PageGotoOptions { WaitUntil = WaitUntilState.DOMContentLoaded });
        var deadline = DateTime.UtcNow.AddSeconds(_settings.PageReadyTimeout);
        System.Text.Json.Nodes.JsonNode? state = null;
        while (DateTime.UtcNow < deadline)
        {
            await Task.Delay(250);
            state = await PageState(tab.Page);
            if (BoolNode(state, "ready")) return;
        }
        var head = (Str(state, "head") ?? "").ToLowerInvariant();
        if (Dom.LoginHints.Any(h => head.Contains(h)))
            throw UpstreamException.Auth("muse.ai redirected to login; cookies are no longer valid");
        throw UpstreamException.Timeout("muse.ai page did not become ready");
    }

    private async Task<bool> OnThread(BrowserTab tab)
    {
        var href = tab.Page.Url;
        if (!IsThreadUrl(href)) return false;
        if (tab.ThreadUrl.Length > 0
            && new Uri(href).AbsolutePath.TrimEnd('/') != new Uri(tab.ThreadUrl).AbsolutePath.TrimEnd('/'))
            return false;
        var page = await PageState(tab.Page);
        if (!BoolNode(page, "hasInput")) return false;
        if ((Str(page, "head") ?? "").Contains("Connecting...")) return false;
        var state = await ChatState(tab);
        if (BoolNode(state, "generating")) return false;
        if (Dom.StallHints.Any(h => (Str(state, "tail") ?? "").Contains(h))) return false;
        return tab.Local || IntNode(state, "agentCount") < HotBubbleLimit;
    }

    private async Task<bool> LiveContinuation(BrowserTab tab)
    {
        var lastUser = tab.Turns.Where(t => t.Role == "user").Select(t => t.Text).LastOrDefault() ?? "";
        if (lastUser.Length == 0) return false;
        var page = await PageState(tab.Page);
        if (!BoolNode(page, "hasInput")) return false;
        var state = await ChatState(tab);
        var present = await Eval(tab.Page,
            $"!!(document.body && document.body.innerText.includes({Dom.Q(lastUser[..Math.Min(80, lastUser.Length)])}))");
        if (BoolNode(state, "generating")) return false;
        if (Dom.StallHints.Any(h => (Str(state, "tail") ?? "").Contains(h))) return false;
        if (IntNode(state, "agentCount") >= HotBubbleLimit) return false;
        return present is System.Text.Json.Nodes.JsonValue pv && pv.TryGetValue<bool>(out var b) && b;
    }

    private async Task OpenSaved(BrowserTab tab)
    {
        await tab.Page.GotoAsync(tab.ThreadUrl,
            new PageGotoOptions { WaitUntil = WaitUntilState.DOMContentLoaded });
        var deadline = DateTime.UtcNow.AddSeconds(_settings.PageReadyTimeout);
        while (DateTime.UtcNow < deadline)
        {
            await Task.Delay(250);
            if (await OnThread(tab)) return;
        }
        throw UpstreamException.Timeout("saved conversation did not become ready");
    }

    private async Task Attach(BrowserTab tab, List<InputImage> images, CancellationToken cancel = default)
    {
        for (var idx = 0; idx < images.Count; idx++)
        {
            var img = images[idx];
            var ext = img.Mime.Split('/').Last().Replace("jpeg", "jpg");
            var res = await Eval(tab.Page, Dom.AttachFile(
                Convert.ToBase64String(img.Data), img.Mime, $"input_{idx}.{ext}"), cancel);
            if (!BoolNode(res, "ok"))
                throw new UpstreamException($"failed to attach image: {Str(res, "err")}");
        }
        if (images.Count > 0) await Task.Delay(1000, cancel);
    }

    private async Task Send(BrowserTab tab, string prompt, CancellationToken cancel = default)
    {
        cancel.ThrowIfCancellationRequested();
        var res = await Eval(tab.Page, Dom.FillInput(prompt), cancel);
        if (!BoolNode(res, "ok"))
            throw new UpstreamException($"cannot fill chat input: {Str(res, "err")}");
        var deadline = DateTime.UtcNow.AddSeconds(5);
        while (DateTime.UtcNow < deadline)
        {
            cancel.ThrowIfCancellationRequested();
            if (await Eval(tab.Page, Dom.ClickSend, cancel) is System.Text.Json.Nodes.JsonValue v
                && v.TryGetValue<string>(out var s) && s == "clicked") return;
            await Task.Delay(100, cancel);
        }
        cancel.ThrowIfCancellationRequested();
        await tab.Page.Keyboard.PressAsync("Enter").WaitAsync(TimeSpan.FromSeconds(10), cancel);
        await Task.Delay(500, cancel);
        var empty = await Eval(tab.Page, Dom.InputEmpty, cancel);
        if (empty is not System.Text.Json.Nodes.JsonValue ev || !ev.TryGetValue<bool>(out var isEmpty) || !isEmpty)
            throw new UpstreamException("send button not found and Enter did not submit");
    }

    private async Task DenyApprovals(BrowserTab tab)
    {
        var denied = await Eval(tab.Page, Dom.DenyApprovals);
        if (denied is System.Text.Json.Nodes.JsonArray arr)
            foreach (var item in arr)
                Console.WriteLine($"denied muse.ai {item?.GetValue<string>()?.ToLowerInvariant()}");
    }

    private async Task<(BrowserTab Tab, System.Text.Json.Nodes.JsonNode? Base)> BeginChat(
        Account account, ChatRequest req)
    {
        var hint = req.ConversationHint ?? "";
        var tab = await Checkout(account, t => t.HasState && (t.Hint ?? "") == hint, req.Cancel);
        var prompt = req.Prompt;
        var images = req.Images;
        try
        {
            if (req.LocalTools)
            {
                if (string.IsNullOrWhiteSpace(hint)) throw MuseException.Invalid("Local tools require a stable conversation ID.");
                var saved = _localConversations.Load(account.Id, hint);
                var live = tab.Local && tab.Hint == hint && LocalConversationStore.IsThread(tab.Page.Url)
                    && (string.IsNullOrEmpty(saved?.Url) || new Uri(saved.Url).AbsolutePath.TrimEnd('/') == new Uri(tab.Page.Url).AbsolutePath.TrimEnd('/'));
                tab.Local = true; tab.RateLimited = false;
                if (saved is not null || live)
                {
                    tab.Hint = hint;
                    tab.ThreadUrl = live ? tab.Page.Url : saved!.Url;
                    if (tab.ThreadUrl.Length == 0) throw UpstreamException.Refused("Previous Muse request has no confirmed thread URL. No replacement chat was created; check the existing chat before continuing.");
                    if (!await OnThread(tab)) await OpenSaved(tab);
                    prompt = Prompt.LocalContinuation(req.Turns);
                    Diagnostic?.Invoke("local_conversation_reused");
                }
                else
                {
                    await NewThread(tab); tab.Local = true; tab.Hint = hint;
                    Diagnostic?.Invoke("local_conversation_created");
                }
                var state = await ChatState(tab, req.Cancel);
                var imageHash = images.Count == 0 ? "" : Convert.ToHexString(System.Security.Cryptography.SHA256.HashData(images.SelectMany(i => i.Data).ToArray()));
                // A newly pasted image/capture gets a new ID even if its bytes
                // match. Repeated context from subsequent tool rounds keeps its
                // ID and must not upload the same attachment on every round.
                if (req.ImageBatchId is { Length: > 0 }) imageHash = req.ImageBatchId + ":" + imageHash;
                if (req.ImageBatchId is { Length: > 0 } && imageHash == saved?.ImageHash) images = new();
                // Record ownership before submission, so an interrupted request
                // never silently creates another upstream thread on the next run.
                _localConversations.Save(account.Id, hint, IsThreadUrl(tab.Page.Url) ? tab.Page.Url : saved?.Url ?? "", true, imageHash);
                await Attach(tab, images, req.Cancel);
                var requestId = Guid.NewGuid().ToString("N");
                state!["submittedRequestId"] = requestId;
                await Send(tab, "MUSE_LOCAL_REQUEST_ID: " + requestId + "\n(Transport metadata for the app; do not echo it in your answer.)\n\n" + prompt, req.Cancel);
                if (LocalConversationStore.IsThread(tab.Page.Url))
                {
                    tab.ThreadUrl = tab.Page.Url;
                    _localConversations.Save(account.Id, hint, tab.ThreadUrl, true, imageHash);
                }
                return (tab, state);
            }
            List<BrowserTab> others;
            lock (_lock) others = _tabs.GetValueOrDefault(account.Id, new()).Where(t => t != tab && t.HasState).ToList();
            if (!req.LocalTools && others.Count == 0) LoadHot(tab, account);
            var sameOwner = (tab.Hint ?? "") == hint;
            var follow = !req.LocalTools && tab.Turns.Count > 0 && sameOwner
                ? Prompt.FollowupText(tab.Turns, req.Turns) : null;
            if (follow is not null && req.Images.Count >= tab.ImageCount
                && (tab.ThreadUrl.Length > 0 || await LiveContinuation(tab)))
            {
                if (await OnThread(tab) || await LiveContinuation(tab)) { }
                else if (tab.ThreadUrl.Length > 0) await OpenSaved(tab);
                prompt = follow;
                images = req.Images.Skip(tab.ImageCount).ToList();
            }
            else
            {
                if (account.Meta.GetValueOrDefault("hot_page") is System.Text.Json.Nodes.JsonObject saved
                    && (saved["hint"]?.GetValue<string>() ?? "") == hint)
                    account.Meta.Remove("hot_page");
                await NewThread(tab);
            }
            var baseState = await ChatState(tab);
            await Attach(tab, images, req.Cancel);
            await Send(tab, prompt, req.Cancel);
            return (tab, baseState);
        }
        catch (Exception)
        {
            if (req.LocalTools) { tab.Stale = true; Checkin(tab); throw; }
            Forget(tab);
            tab.Stale = true;
            Checkin(tab);
            throw;
        }
    }

    // ---------- chat ----------
    public async IAsyncEnumerable<string> ChatStream(Account account, ChatRequest req)
    {
        req.Cancel.ThrowIfCancellationRequested();
        using var localGate = req.LocalTools ? await AcquireLocalGate(account.Id, req.ConversationHint, req.Cancel) : null;
        var (tab, baseState) = await BeginChat(account, req);
        var baseCount = IntNode(baseState, "agentCount");
        var baseText = Str(baseState, "lastText") ?? "";
        var submittedRequestId = Str(baseState, "submittedRequestId") ?? "";
        var baseUserKey = Str(baseState, "userKey") ?? "";
        var baseReplyKeys = (baseState?["replyKeys"] as System.Text.Json.Nodes.JsonArray)?
            .Select(n => n?.GetValue<string>() ?? "").ToHashSet() ?? new HashSet<string>();
        var started = DateTime.UtcNow;
        var emitted = "";
        string? last = null;
        var stable = 0;
        var gotFirst = false;
        var finished = false;
        var diagnosticAt = 0d;
        var sawGenerating = false;
        double? stoppedAt = null;
        // v0.8.12: trạng thái mới nhất để ghi dòng chẩn đoán khi vòng
        // chat kết thúc do user bấm Dừng (không ghi nội dung tin nhắn).
        var lastBound = false;
        var lastPartialChars = 0;
        // Fallback binding (v0.6.0): khi web đã dừng tạo mà phản hồi vẫn
        // không gắn được với request id (localReplyBound=false, thường do
        // DOM hydration/reorder), lastText sau user message mới vẫn có thể
        // là phản hồi thật. Chỉ kích hoạt sau khi dừng + hết grace, và
        // vẫn đi qua đường ổn định 4 poll như phản hồi thường. Không tự
        // gửi lại, không tạo hội thoại mới, không xóa lịch sử.
        var fallbackActive = false;
        var fallbackText = "";
        try
        {
            // QUY TẮC CỨNG v0.8.12 (user chốt ngày 01/11, thay thế mọi
                // đề xuất nâng timeout trước đó): vòng trả lời chat này
                // KHÔNG có timeout nào. Chỉ dừng khi user tự bấm Dừng
                // (req.Cancel ném OperationCanceledException, hội thoại
                // được giữ nguyên qua finally như cũ). Web đã ra chữ rồi
                // nhưng hơn 90 giây không có tiến triển DOM mới cũng
                // KHÔNG được tự động cắt. Các lần ném theo thời gian đã
                // gỡ khỏi vòng này: ChatTimeout (300s), FirstTokenTimeout
                // (45s), ChatIdleTimeout (90s) và StallHints sau 15s.
                // Các trường timeout vẫn còn trong Settings.cs vì code
                // khác (media, profile) có thể còn dùng; chỉ ChatStream
                // không còn dùng chúng để cắt câu trả lời. Trade-off đã
                // ghi trong README: nếu web kẹt thật thì gateway chờ mãi
                // cho tới khi bạn bấm Dừng, đây là hành vi theo yêu cầu
                // chứ không phải lỗi treo mới.
            while (true)
            {
                req.Cancel.ThrowIfCancellationRequested();
                var elapsed = (DateTime.UtcNow - started).TotalSeconds;
                await Task.Delay(TimeSpan.FromSeconds(PollInterval), req.Cancel);
                var st = await ChatState(tab, req.Cancel, req.LocalTools ? submittedRequestId : null);
                lastBound = BoolNode(st, "localReplyBound");
                lastPartialChars = (Str(st, "lastText") ?? "").Length;
                if (BoolNode(st, "generating")) { sawGenerating = true; stoppedAt = null; }
                else if (sawGenerating) stoppedAt ??= elapsed;
                var responseText = Str(st, req.LocalTools ? "localReplyText" : "lastText") ?? "";
                if (req.LocalTools && elapsed >= diagnosticAt)
                {
                    Diagnostic?.Invoke($"local_reply_poll seconds={(int)elapsed} bubbles={IntNode(st, "agentCount")} baseline={baseCount} chars={responseText.Length} bound={BoolNode(st, "localReplyBound")} generating={BoolNode(st, "generating")}");
                    diagnosticAt = elapsed + 10;
                }
                if (BoolNode(st, "approval")) { await DenyApprovals(tab); continue; }
                var text = responseText;
                var currentUserKey = Str(st, "userKey") ?? "";
                var replyKey = Str(st, "replyKey") ?? "";
                var newMessage = BoolNode(st, "replyAfterUser") && currentUserKey.Length > 0 && currentUserKey != baseUserKey
                    && replyKey.Length > 0 && !baseReplyKeys.Contains(replyKey);
                var isNew = req.LocalTools
                    ? submittedRequestId.Length > 0 && Str(st, "localRequestId") == submittedRequestId && BoolNode(st, "localReplyBound")
                    : newMessage || IntNode(st, "agentCount") > baseCount || (text.Length > 0 && text != baseText);
                if (!isNew || text.Length == 0)
                {
                    if (stoppedAt is { } idleAt && elapsed - idleAt > _settings.ReplyRenderGrace)
                    {
                        // Fallback thô (v0.8.12, chỉ chế độ LocalTools, chỉ
                        // sau khi web đã dừng tạo + hết grace 15s, không
                        // kích hoạt trong lúc đang tạo). Quy tắc user chốt:
                        // web đã dừng nhưng gateway không gắn được phản hồi
                        // vào đúng yêu cầu đã gửi thì CŨNG PHẢI TỰ XỬ LÝ
                        // VÀ TRẢ LẠI TIN NHẮN THÔ, không được vứt phần chữ
                        // đã đọc chỉ vì gắn thất bại. Điều kiện duy nhất
                        // để trả là lastText (bubble assistant mới nhất,
                        // không phải localReplyText vốn rỗng khi chưa bound)
                        // khác rỗng, khác baseline, và ổn định qua 4 poll
                        // (0,6 giây) như đường thường để khỏi trả chữ đang
                        // render dở. Cố ý BỎ các điều kiện gắn cũ:
                        // localReplyBound=true, userKey khác baseline và
                        // replyAfterUser=true — chính chúng là điểm hay
                        // hỏng khi DOM thay đổi. Trả lastText nguyên văn
                        // qua SSE như phản hồi thường, không cắt, không
                        // tóm tắt, không tự sửa JSON bên trong. JSON tool
                        // dở dang trong text thô này KHÔNG bị thực thi:
                        // parseToolCalls của extension chỉ tạo
                        // __parse_error__ cho JSON vỡ và vòng lặp không
                        // thực thi lô có lỗi đó (xem README); JSON tool
                        // hợp lệ hoàn chỉnh thì thực thi như bình thường.
                        if (req.LocalTools && !fallbackActive)
                        {
                            var candidate = Str(st, "lastText") ?? "";
                            if (DiagnosticLines.IsRawFallbackCandidate(candidate, baseText))
                            {
                                fallbackActive = true;
                                fallbackText = candidate;
                                last = candidate;
                                stable = 0;
                                gotFirst = true;
                                continue;
                            }
                        }
                        if (req.LocalTools && fallbackActive)
                        {
                            var current = Str(st, "lastText") ?? "";
                            if (current.Length > 0 && current != fallbackText) { fallbackText = current; last = current; stable = 0; continue; }
                            stable++;
                            if (DiagnosticLines.ShouldReturnRawFallback(fallbackText, baseText, stable, StablePollsDone))
                            {
                                // Một dòng chẩn đoán duy nhất khi trả qua
                                // đường thô: không ghi nội dung tin nhắn.
                                Diagnostic?.Invoke($"local_reply_raw_fallback elapsed={(int)elapsed} gotFirst={gotFirst} bound={lastBound} chars={fallbackText.Length} reason=fallback");
                                finished = true;
                                yield return fallbackText;
                                break;
                            }
                            continue;
                        }
                        // Chưa có phản hồi trả được (lastText rỗng hoặc
                        // bằng baseline): KHÔNG ném 502 nữa, tiếp tục poll
                        // chờ cho tới khi user bấm Dừng (quy tắc cứng
                        // 0.8.12). Nhánh này cũng áp cho chế độ không
                        // dùng tool cục bộ.
                    }
                    continue;
                }
                gotFirst = true;
                if (req.LocalTools)
                {
                    // Rendered Markdown may replace its DOM while streaming
                    // (especially code fences/tool JSON). JSON cannot be
                    // reconstructed from irreversible partial DOM deltas.
                    if (text != last) { last = text; stable = 0; }
                    else if (!BoolNode(st, "generating") && ++stable >= StablePollsDone)
                    {
                        Diagnostic?.Invoke($"local_reply_complete chars={text.Length}");
                        finished = true;
                        yield return text;
                        break;
                    }
                    else if (BoolNode(st, "generating")) stable = 0;
                    continue;
                }
                if (text != last)
                {
                    // DOM re-renders may briefly shorten text. Wait until the
                    // committed prefix returns rather than duplicating output.
                    if (!text.StartsWith(emitted, StringComparison.Ordinal)) continue;
                    var delta = text[emitted.Length..];
                    emitted = text;
                    last = text;
                    stable = 0;
                    if (delta.Length > 0) yield return delta;
                }
                else if (!BoolNode(st, "generating") && ++stable >= StablePollsDone)
                {
                    finished = true;
                    break;
                }
                else if (BoolNode(st, "generating")) stable = 0;
            }
        }
        finally
        {
            // v0.8.12: vòng chat kết thúc do user bấm Dừng thì ghi một
            // dòng chẩn đoán duy nhất (không ghi nội dung tin nhắn).
            // Không dùng catch vì iterator không cho phép yield trong
            // try có catch; nhận biết qua finished=false + Cancel đã
            // được yêu cầu khi finally chạy lúc unwind. Hội thoại được
            // giữ nguyên như hành vi finally hiện tại (Save với
            // !finished, tab Stale).
            if (!finished && req.Cancel.IsCancellationRequested)
                Diagnostic?.Invoke($"chat_ended elapsed={(int)(DateTime.UtcNow - started).TotalSeconds} gotFirst={gotFirst} bound={lastBound} chars={lastPartialChars} reason=user_stop");
            try
            {
                if (req.LocalTools)
                {
                    var saved = _localConversations.Load(account.Id, req.ConversationHint!);
                    var url = LocalConversationStore.IsThread(tab.Page.Url) ? tab.Page.Url : saved?.Url ?? "";
                    _localConversations.Save(account.Id, req.ConversationHint!, url, !finished, saved?.ImageHash ?? "");
                    tab.ThreadUrl = url; tab.Hint = req.ConversationHint; tab.Local = true; tab.Turns.Clear();
                    if (!finished) tab.Stale = true;
                }
                else if (finished)
                {
                    var url = tab.Page.Url;
                    SaveHot(tab, account, req, IsThreadUrl(url) ? url : "");
                }
                else { Forget(tab); tab.Stale = true; }
                await SaveSession(account, tab.Page.Context);
            }
            finally { Checkin(tab); }
        }
    }
    private async Task<IDisposable> AcquireLocalGate(string accountId, string? hint, CancellationToken cancel)
    {
        if (string.IsNullOrWhiteSpace(hint)) throw MuseException.Invalid("Local tools require a stable conversation ID.");
        var gate = _localGates.GetOrAdd(accountId + ":" + hint, _ => new SemaphoreSlim(1, 1));
        await gate.WaitAsync(cancel); return new GateLease(gate);
    }
    private sealed class GateLease(SemaphoreSlim gate) : IDisposable { public void Dispose() => gate.Release(); }
    // ---------- media ----------
    private static string MediaPrompt(string prompt, string kind, string? size, int? duration = null)
    {
        var hints = new List<string>();
        if (!string.IsNullOrEmpty(size)) hints.Add($"aspect ratio {size}");
        if (duration is not null) hints.Add($"{duration} seconds long");
        var verb = kind == "image" ? "Generate an image" : "Generate a video";
        var suffix = hints.Count > 0 ? $" ({string.Join(", ", hints)})" : "";
        return $"{verb}{suffix}: {prompt}";
    }

    private async Task<Dictionary<string, object?>> WaitMedia(BrowserTab tab,
        System.Text.Json.Nodes.JsonNode? baseState, string kind, double timeout,
        Action<int>? onProgress, CancellationToken cancel)
    {
        var baseAtts = baseState?["attachments"] is System.Text.Json.Nodes.JsonArray ba ? ba.Count : 0;
        var baseCount = IntNode(baseState, "agentCount");
        var grace = kind == "video" ? 90.0 : 8.0;
        var started = DateTime.UtcNow;
        DateTime? textDoneAt = null;
        var denied = false;
        var askedToAttach = false;
        while (true)
        {
            var elapsed = (DateTime.UtcNow - started).TotalSeconds;
            if (elapsed >= timeout * 2.5) break;
            cancel.ThrowIfCancellationRequested();
            await Task.Delay(600, cancel);
            var st = await ChatState(tab);
            if (BoolNode(st, "approval"))
            {
                await DenyApprovals(tab);
                denied = true; textDoneAt = null;
                continue;
            }
            var atts = st?["attachments"] is System.Text.Json.Nodes.JsonArray all
                ? all.Skip(baseAtts).ToList() : new List<System.Text.Json.Nodes.JsonNode?>();
            var fresh = atts.Where(a =>
                a is System.Text.Json.Nodes.JsonObject o
                && (o["src"]?.GetValue<string>() ?? "").Length > 0
                && (o["kind"]?.GetValue<string>() ?? "") == kind).ToList();
            if (fresh.Count > 0)
            {
                var lastAtt = (System.Text.Json.Nodes.JsonObject)fresh[^1]!;
                return new Dictionary<string, object?>
                {
                    ["src"] = lastAtt["src"]?.GetValue<string>(),
                    ["kind"] = kind,
                    ["w"] = lastAtt["w"] is System.Text.Json.Nodes.JsonValue wv && wv.TryGetValue<int>(out var w) ? w : 0,
                    ["h"] = lastAtt["h"] is System.Text.Json.Nodes.JsonValue hv && hv.TryGetValue<int>(out var h) ? h : 0,
                };
            }
            var busy = BoolNode(st, "generating")
                || atts.Any(a => (a?["tid"]?.GetValue<string>() ?? "").Contains(kind));
            elapsed = (DateTime.UtcNow - started).TotalSeconds;
            if (elapsed >= timeout && !busy) break;
            onProgress?.Invoke(Math.Min(95, (int)(elapsed / timeout * 100)));
            if (atts.Any(a => (a?["tid"]?.GetValue<string>() ?? "").Contains(kind)))
            {
                textDoneAt = null;
                continue;
            }
            var text = Str(st, "lastText") ?? "";
            if (IntNode(st, "agentCount") > baseCount && text.Length > 0 && !BoolNode(st, "generating"))
            {
                if (textDoneAt is null) textDoneAt = DateTime.UtcNow;
                else if ((DateTime.UtcNow - textDoneAt.Value).TotalSeconds >= grace)
                {
                    if (!askedToAttach)
                    {
                        await Send(tab, $"Please attach the final {kind} file here in the chat"
                            + (denied ? " instead of uploading it." : ", as a single attachment."));
                        askedToAttach = true; textDoneAt = null;
                        baseCount = IntNode(st, "agentCount");
                        continue;
                    }
                    var probe = await Eval(tab.Page, Dom.LastBubbleMedia);
                    var links = probe?["links"] is System.Text.Json.Nodes.JsonArray la
                        ? la.Select(x => x?.GetValue<string>() ?? "").ToList() : new List<string>();
                    var url = PickMediaUrl(links, kind);
                    if (url is not null) return new Dictionary<string, object?> { ["src"] = url, ["kind"] = kind };
                    throw UpstreamException.Refused($"upstream replied with text only: {text[..Math.Min(200, text.Length)]}");
                }
            }
            else textDoneAt = null;
        }
        throw UpstreamException.Timeout($"{kind} generation timed out");
    }

    private static readonly string[] VideoExt = { ".mp4", ".webm", ".mov", ".m4v" };
    private static readonly string[] ImageExt = { ".png", ".jpg", ".jpeg", ".webp", ".gif", ".avif" };
    private static readonly string[] MediaHosts =
        { "videodelivery.net", "cloudflarestream.com", "cloudflarestorage.com", "amazonaws.com",
          "storage.googleapis.com", "blob.core.windows.net", "musecdn", "cdn.muse", "muse-cdn" };
    private static readonly string[] MediaPaths =
        { "/media/", "/download", "/dl/", "/video", "/attachment", "/files/" };

    private static string? PickMediaUrl(List<string> links, string kind)
    {
        var exts = kind == "video" ? VideoExt : ImageExt;
        int Score(string u)
        {
            var low = u.ToLowerInvariant();
            var path = low.Split('?')[0].Split('#')[0];
            if (u.StartsWith("blob:", StringComparison.Ordinal) || exts.Any(e => path.EndsWith(e))) return 3;
            if (MediaHosts.Any(h => low.Contains(h))) return 2;
            if (MediaPaths.Any(p => low.Contains(p))) return 1;
            return 0;
        }
        var cands = links.Where(u => u.Length > 0
            && !u.StartsWith("mailto:", StringComparison.Ordinal)
            && !u.StartsWith("javascript:", StringComparison.Ordinal)).ToList();
        cands.Sort((a, b) => Score(b).CompareTo(Score(a)));
        return cands.Count > 0 && Score(cands[0]) > 0 ? cands[0] : null;
    }

    private async Task<MediaResult> Download(BrowserTab tab, Dictionary<string, object?> att, string kind)
    {
        var res = await Eval(tab.Page, Dom.FetchAsBase64(att["src"]?.ToString() ?? ""));
        if (!BoolNode(res, "ok"))
            throw new UpstreamException($"failed to download generated {kind}: {Str(res, "err")}");
        var mime = Str(res, "mime");
        if (string.IsNullOrEmpty(mime)) mime = kind == "video" ? "video/mp4" : "image/png";
        var b64 = Str(res, "b64") ?? "";
        return new MediaResult(Convert.FromBase64String(b64), mime, kind,
            att["w"] is int w && w > 0 ? w : null,
            att["h"] is int h && h > 0 ? h : null);
    }

    private async Task<MediaResult> Generate(BrowserTab tab, Account account, string prompt,
        List<InputImage> images, string kind, double timeout, Action<int>? onProgress,
        CancellationToken cancel)
    {
        // Media always starts a fresh thread, so keep tabs holding a chat for chats.
        var t = tab;
        var completed = false;
        try
        {
            await NewThread(t);
            var baseState = await ChatState(t);
            await Attach(t, images);
            await Send(t, prompt);
            var att = await WaitMedia(t, baseState, kind, timeout, onProgress, cancel);
            var result = await Download(t, att, kind);
            completed = true;
            return result;
        }
        finally
        {
            if (!completed) t.Stale = true;
            Checkin(t);
        }
    }

    public async Task<List<MediaResult>> GenerateImage(Account account, ImageRequest req)
    {
        var prompt = MediaPrompt(req.Prompt, "image", req.Size);
        var results = new List<MediaResult>();
        for (var i = 0; i < Math.Max(1, req.N); i++)
        {
            var tab = await Checkout(account, t => !t.HasState, req.Cancel);
            var r = await Generate(tab, account, prompt, req.References, "image",
                _settings.ImageTimeout, req.OnProgress, req.Cancel);
            r = r with { RevisedPrompt = req.Prompt };
            results.Add(r);
        }
        return results;
    }

    public async Task<MediaResult> GenerateVideo(Account account, VideoRequest req)
    {
        var prompt = MediaPrompt(req.Prompt, "video", req.Size, req.Duration);
        var images = req.FirstFrame is null ? new List<InputImage>() : new List<InputImage> { req.FirstFrame };
        var tab = await Checkout(account, t => !t.HasState, req.Cancel);
        return await Generate(tab, account, prompt, images, "video",
            _settings.VideoTimeout, req.OnProgress, req.Cancel);
    }

    // ---------- liệt kê thread web (v0.6.0, mức 1; bền hơn ở v0.7.0, điểm 4; chẩn đoán từng trang + bấm mở sidebar ở v0.8.5) ----------
    // Mở trang chủ muse.ai trong một page TẠM thuộc đúng context của tài
    // khoản (GetContext, cookie đã gắn sẵn lúc tạo context). Page tạm
    // KHÔNG đưa vào _tabs, chỉ đóng page đó trong finally, không đóng
    // context và không chạm tab chat đang chạy. Nếu đã bị đẩy về trang
    // đăng nhập thì báo Auth tiếng Việt, KHÔNG trả danh sách rỗng (danh
    // sách rỗng thật và hết hạn trông giống nhau, trả rỗng sẽ làm
    // extension kết luận sai là tài khoản không có hội thoại nào).
    // Vì sao v0.7.0 quét khác v0.6.0: bản cũ chỉ quét thẻ <a> sau khi
    // chờ cố định 2,5 giây. Nếu sidebar không render thành <a> (mà là
    // button/div điều hướng, danh sách ảo chỉ render phần nhìn thấy,
    // hoặc lịch sử tải lười qua API sau 2,5 giây) thì trả về rỗng dù
    // web có rất nhiều thread. Bản này: (a) quét thêm HTML bằng regex
    // /thread/<id> trên outerHTML (bắt cả link trong JSON hydration,
    // data-url, button điều hướng mà <a> bỏ sót), hợp nhất với <a>
    // rồi khử trùng theo URL, chỉ giữ URL qua được IsThread;
    // (b) poll mỗi 500ms tối đa 10 giây, dừng sớm khi số thread ổn định
    // qua 2 lần quét liên tiếp và > 0; sau 10 giây vẫn 0 thì thử mở
    // thêm /thread/new (trang chat mới thường hiện sidebar lịch sử)
    // và lặp lại vòng poll, rồi mới trả về rỗng. Chỉ quét trang danh
    // sách/trang chủ, KHÔNG mở từng thread để quét (không lấy thread
    // từ nội dung chat trong thread). Mở /thread/new chỉ mở trang,
    // không gửi tin nhắn nên không tự tạo thread mới.
    // v0.8.5, theo bằng chứng popup của user ("trang cuối là
    // /thread/new, tổng số link là 1" — trang gần như không render
    // gì, và số liệu trang chủ đã mất khi chuyển trang):
    // (a) Chẩn đoán RIÊNG từng trang: mỗi trang ghi threads, links,
    // pageUrl, tiêu đề chung của app (cắt 80 ký tự), có form đăng
    // nhập không, số nút bấm — chỉ số lượng, không tiêu đề hội thoại
    // hay nội dung trang. Dòng web_threads in cả hai trang (kể cả khi
    // Auth: ghi log trước khi ném, để user vẫn đọc được chẩn đoán).
    // (b) Mở rộng phát hiện hết hạn: ngoài gợi ý đăng nhập bằng chữ
    // (Dom.LoginHints trên 2000 ký tự đầu), trang có form đăng nhập
    // (input password/email) cũng coi là hết hạn → Auth rõ ràng, thay
    // vì im lặng trả 0 thread gây hiểu nhầm.
    // (c) Bấm mở sidebar lịch sử: sau khi quét một trang được 0
    // thread, thử bấm tối đa 4 nút có aria-label/title/text chứa
    // history/lịch sử/chat/sidebar/menu rồi quét lại; nút nào làm
    // tăng số link/thread thì giữ kết quả đó. CHỈ bấm nút: không điền
    // form (bỏ qua nút trong form), không bấm nút đăng nhập/đăng
    // xuất/thanh toán/nâng cấp/xóa. Không đoán mò cấu trúc DOM: nếu
    // sau bước này vẫn 0 thì trả 0 kèm chẩn đoán đầy đủ.
    // v0.8.6, sửa lỗi lạc trang của bước (c) trên 0.8.5 (log thật:
    // cả hai trang kết thúc ở /library/artifacts/chatbot-ui):
    // matcher cũ khớp chuỗi con "chat" trên cả innerText nên bấm nhầm
    // nút "Chatbot UI" rồi lấy số liệu trang artifact làm kết quả.
    // Nay chỉ xét aria-label/title và khớp cụm từ nguyên (history/
    // lịch sử/sidebar/menu/new chat); sau mỗi lần bấm, trang rời
    // khỏi khu vực chat thì GoBack và loại nút đó, không lấy số liệu
    // trang lạc; chẩn đoán từng trang giữ riêng số liệu trước khi
    // bấm (base_threads/base_links) để không mất số liệu gốc.
    // v0.8.12: forceTitles=true ép thăm dò nút sidebar bất kể quét link
    // được bao nhiêu thread (lệnh ép cập nhật tiêu đề của extension);
    // mặc định false giữ hành vi cũ.
    public async Task<WebThreadsScan> ListWebThreads(Account account, bool forceTitles = false)
    {
        if (Upstream.MissingSessionCookies(account.Cookies) is { Count: > 0 })
            throw UpstreamException.Auth("Tài khoản Muse đã hết hạn, hãy đăng nhập lại");
        var context = await GetContext(account);
        var page = await context.NewPageAsync();
        try
        {
            var pages = new List<WebThreadsPageDiag>();
            var best = new WebThreadsScan(new List<(string Url, string? Title)>(), Upstream.Site, 0);
            var last = best;
            // v0.8.7: ngân sách thăm dò CHUNG cho cả lần quét một tài
            // khoản là 60 giây (mỗi trang thăm dò tối đa 30 nút nhưng
            // không vượt deadline này), để tổng thời gian quét không
            // vượt khung hiện tại cộng thêm quá 60 giây.
            var probeDeadline = DateTimeOffset.UtcNow.AddSeconds(60);
            // Ghi log chẩn đoán trước khi ném Auth để user vẫn đọc được
            // số liệu các trang đã quét (endpoint chỉ ghi log khi quét
            // kết thúc thành công, còn đường Auth thì không tới đó).
            void LogScan(WebThreadsScan s) =>
                Diagnostic?.Invoke(DiagnosticLines.WebThreadsLine(account.Id, s with { Pages = pages.ToList() }));
            foreach (var startUrl in new[] { Upstream.Site, Upstream.Site + "/thread/new" })
            {
                await page.GotoAsync(startUrl,
                    new PageGotoOptions { WaitUntil = WaitUntilState.DOMContentLoaded });
                var scan = new WebThreadsScan(new List<(string Url, string? Title)>(), Upstream.Site, 0);
                var previousCount = -1;
                for (var i = 0; i < 20; i++)
                {
                    scan = await ScanThreadsPage(page);
                    if (!Uri.TryCreate(page.Url, UriKind.Absolute, out var pageUri)
                        || !pageUri.Host.Equals("muse.ai", StringComparison.OrdinalIgnoreCase))
                    {
                        LogScan(scan);
                        throw UpstreamException.Auth("Tài khoản Muse đã hết hạn, hãy đăng nhập lại");
                    }
                    if (scan.LoginHint)
                    {
                        LogScan(scan);
                        throw UpstreamException.Auth("Tài khoản Muse đã hết hạn, hãy đăng nhập lại");
                    }
                    if (scan.Threads.Count > 0 && scan.Threads.Count == previousCount) break;
                    previousCount = scan.Threads.Count;
                    if (i < 19) await Task.Delay(TimeSpan.FromMilliseconds(500));
                }
                // v0.8.6: giữ số liệu TRƯỚC khi bấm để chẩn đoán từng
                // trang không mất số liệu gốc của trang chat (0.8.5
                // chỉ ghi số liệu sau khi bấm nên trang chat gốc bị
                // số liệu trang artifact che mất).
                var baselineThreads = scan.Threads.Count;
                var baselineLinks = scan.LinkCount;
                var sidebarClicked = false;
                if (scan.Threads.Count == 0)
                {
                    var improved = await TryOpenSidebarAsync(page, scan);
                    if (improved is not null) { scan = improved; sidebarClicked = true; }
                    else sidebarClicked = await AnySidebarButtonClickedAsync(page);
                }
                // v0.8.7: quét link vẫn 0 thread thì thăm dò nút lịch
                // sử trong aside/nav (lịch sử có thể nằm ở dạng nút
                // chứ không phải link). Gặp Auth trong lúc thăm dò thì
                // ghi log rồi ném Auth như vòng poll chính, không trả
                // kết quả nửa vời.
                var probed = false;
                var probeHitAuth = false;
                // v0.8.12: thăm dò không chỉ khi 0 thread mà còn khi có
                // thread title rỗng (regex) hoặc ở chế độ ép buộc; hàm
                // ShouldProbeForTitles giữ đúng ba điều kiện này. Các
                // giới hạn an toàn của thăm dò không đổi (30 nút,
                // deadline chung 60 giây, chỉ nút đang hiển thị trong
                // aside/nav, bỏ qua form/dialog, lạc trang thì GoBack).
                if (DiagnosticLines.ShouldProbeForTitles(scan.Threads, forceTitles))
                {
                    probed = true;
                    var (probeFound, hitAuth) = await ProbeHistoryButtonsAsync(page, scan, probeDeadline);
                    probeHitAuth = hitAuth;
                    if (probeFound is not null) scan = probeFound;
                }
                pages.Add(new WebThreadsPageDiag(scan.PageUrl, scan.Threads.Count, scan.LinkCount,
                    scan.Title, scan.HasLoginForm, scan.ButtonCount, sidebarClicked, baselineThreads, baselineLinks,
                    scan.Groups, probed));
                last = scan;
                if (probeHitAuth)
                {
                    LogScan(scan);
                    throw UpstreamException.Auth("Tài khoản Muse đã hết hạn, hãy đăng nhập lại");
                }
                if (DiagnosticLines.IsBetterScan(scan, best)) best = scan;
                if (best.Threads.Count > 0) break;
            }
            // Có thread thì trả quét tốt nhất; không có thread nào thì
            // trả quét của trang cuối (giữ tương thích popup cũ: trang
            // cuối + tổng số link của nó), kèm chẩn đoán cả hai trang.
            var final = best.Threads.Count > 0 ? best : last;
            final = final with { Pages = pages };
            LogScan(final);
            return final;
        }
        finally { try { await page.CloseAsync(); } catch { } }
    }

    // ---------- lấy lịch sử tin nhắn của một thread web (v0.8.8) ----------
    // Mở URL thread trong một page TẠM thuộc đúng context của tài
    // khoản (GetContext, giống ListWebThreads), không đưa vào _tabs,
    // chỉ đóng page trong finally. Chờ tải theo mẫu poll của quét
    // (mỗi 500ms tối đa 10 giây, dừng sớm khi số tin > 0 và ổn định
    // qua 2 lần trích liên tiếp, không chờ vô hạn); sau đó cuộn
    // container lên đầu để tải thêm tin cũ nếu cần (tối đa 8 lần
    // cuộn, dừng khi số tin ổn định 2 lần liên tiếp, không cuộn vô
    // hạn). Trích bằng ĐÚNG selector + replyText của Dom.ThreadHistory
    // (bubble trợ lý → assistant, nhóm user → user, theo thứ tự tài
    // liệu, kèm fence code khôi phục). Giới hạn ở C# bằng
    // LimitThreadMessages (tối đa 200 tin đầu, mỗi tin tối đa 8000
    // ký tự kèm ghi chú). Hết hạn thì ném Auth như ListWebThreads;
    // URL không phải thread thì endpoint đã chặn bằng 400 trước khi
    // tới đây, nhưng vẫn kiểm tra lại để không mở URL lạ.
    public async Task<ThreadMessagesResult> GetThreadMessages(Account account, string url)
    {
        if (!LocalConversationStore.IsThread(url))
            throw MuseException.Invalid("URL phải là thread muse.ai dạng /thread/<id>");
        if (Upstream.MissingSessionCookies(account.Cookies) is { Count: > 0 })
            throw UpstreamException.Auth("Tài khoản Muse đã hết hạn, hãy đăng nhập lại");
        var context = await GetContext(account);
        var page = await context.NewPageAsync();
        try
        {
            await page.GotoAsync(url,
                new PageGotoOptions { WaitUntil = WaitUntilState.DOMContentLoaded });
            if (!Uri.TryCreate(page.Url, UriKind.Absolute, out var pageUri)
                || !pageUri.Host.Equals("muse.ai", StringComparison.OrdinalIgnoreCase))
                throw UpstreamException.Auth("Tài khoản Muse đã hết hạn, hãy đăng nhập lại");
            var probe = await ReadProbeStateAsync(page);
            if (probe.LoginSignal)
                throw UpstreamException.Auth("Tài khoản Muse đã hết hạn, hãy đăng nhập lại");
            // Poll như quét: tối đa 20 lần × 500ms.
            var raw = new List<(string Role, string Content)>();
            var rawTitle = probe.Title;
            var previousCount = -1;
            for (var i = 0; i < 20; i++)
            {
                var extracted = await ExtractThreadHistoryAsync(page);
                raw = extracted.Messages;
                rawTitle = extracted.Title;
                if (raw.Count > 0 && raw.Count == previousCount) break;
                previousCount = raw.Count;
                if (i < 19) await Task.Delay(TimeSpan.FromMilliseconds(500));
            }
            // Cuộn lên đầu để tải thêm tin cũ: cùng cách tìm container
            // cuộn của ChatState (overflowY auto/scroll, scrollHeight
            // vượt clientHeight), chỉ khác hướng cuộn (lên đầu thay
            // vì xuống cuối) vì tin cũ nằm phía trên.
            var stableScrolls = 0;
            for (var s = 0; s < 8; s++)
            {
                await Eval(page, """
                    (() => {
                      const scrollers = [...document.querySelectorAll('*')].filter(e => {
                        const st = getComputedStyle(e);
                        return (st.overflowY === 'auto' || st.overflowY === 'scroll') && e.scrollHeight > e.clientHeight + 50;
                      });
                      scrollers.forEach(e => { e.scrollTop = 0; });
                      return { scrollers: scrollers.length };
                    })()
                    """);
                await Task.Delay(TimeSpan.FromMilliseconds(500));
                var extracted = await ExtractThreadHistoryAsync(page);
                if (extracted.Messages.Count == raw.Count)
                {
                    stableScrolls++;
                    if (stableScrolls >= 2) break;
                }
                else
                {
                    stableScrolls = 0;
                    raw = extracted.Messages;
                    rawTitle = extracted.Title;
                }
            }
            var limited = DiagnosticLines.LimitThreadMessages(raw);
            return new ThreadMessagesResult(
                limited.Select(m => new ThreadMessage(m.Role, m.Content)).ToList(),
                DiagnosticLines.CleanThreadTitle(rawTitle));
        }
        finally { try { await page.CloseAsync(); } catch { } }
    }

    // Một lần trích lịch sử bằng Dom.ThreadHistory: trả danh sách
    // (role, content) theo thứ tự tài liệu + document.title thô.
    // Eval trả null (lỗi đọc trang) thì coi là 0 tin, để vòng poll
    // thử lại thay vì vỡ cả lần lấy.
    private async Task<(List<(string Role, string Content)> Messages, string? Title)> ExtractThreadHistoryAsync(IPage page)
    {
        var result = await Eval(page, Dom.ThreadHistory);
        var messages = new List<(string Role, string Content)>();
        if (result is not System.Text.Json.Nodes.JsonObject obj) return (messages, null);
        if (obj["messages"] is System.Text.Json.Nodes.JsonArray arr)
        {
            foreach (var item in arr)
            {
                if (item is not System.Text.Json.Nodes.JsonObject msg) continue;
                var role = Str(msg, "role") ?? "";
                if (role != "user" && role != "assistant") continue;
                messages.Add((role, Str(msg, "content") ?? ""));
            }
        }
        return (messages, Str(obj, "title"));
    }

    // Bấm mở sidebar lịch sử (v0.8.5, sửa triệt để lỗi lạc trang ở
    // v0.8.6): tìm nút ứng viên bằng JS trên trang (không trả nhãn nút
    // về C#, chỉ trả token), bấm từng nút rồi quét lại; quét nào tốt
    // hơn baseline thì giữ. Trả null nếu không nút nào làm tăng số
    // liệu. Nút đã bấm được đánh dấu để lần gọi sau không bấm lại.
    // v0.8.6, theo log thật của user trên 0.8.5 (cả hai trang đều kết
    // thúc ở /library/artifacts/chatbot-ui, 0 thread / 14 link):
    // matcher cũ dùng chuỗi con "chat" trên chuỗi gộp aria-label +
    // title + innerText nên nút có nhãn "Chatbot UI" cũng khớp, bấm
    // vào thì rời khỏi trang chat, và vì trang artifact có nhiều link
    // hơn baseline nên IsBetterScan nhận nhầm là "tốt hơn". Bản này:
    // (a) CHỈ xét aria-label/title (nhãn điều khiển), KHÔNG xét
    // innerText (tiêu đề nội dung); nhãn phải khớp dạng cụm từ
    // nguyên (history/lịch sử/sidebar/menu/new chat) sau khi chuẩn
    // hóa, nên "Chatbot", "Chatbot UI", "My Chatbot" đều KHÔNG khớp;
    // (b) sau mỗi lần bấm, kiểm tra URL: chỉ quét lại khi trang vẫn
    // ở khu vực chat (muse.ai, "/" hoặc "/thread/..."); nếu đã lạc
    // thì GoBack, loại nút đó và KHÔNG BAO GIỜ lấy số liệu trang lạc
    // làm kết quả, dù trang lạc có nhiều link hơn.
    private async Task<WebThreadsScan?> TryOpenSidebarAsync(IPage page, WebThreadsScan baseline)
    {
        for (var attempt = 0; attempt < 4; attempt++)
        {
            var tokens = await Eval(page, """
                (() => {
                  // __SIDEBAR_MATCH_FN_START__
                  const sidebarControlMatch = (label) => {
                    const norm = ' ' + (label || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' ';
                    return norm.includes(' history ') || norm.includes(' lịch sử ') || norm.includes(' sidebar ') || norm.includes(' menu ') || norm.includes(' new chat ');
                  };
                  // __SIDEBAR_MATCH_FN_END__
                  const exclude = /log\s?in|sign\s?in|đăng nhập|log\s?out|sign\s?out|đăng xuất|payment|thanh toán|billing|upgrade|subscribe|pricing|delete|xoá|xóa/i;
                  const out = [];
                  if (!window.__museSyncNext) window.__museSyncNext = 1;
                  for (const b of document.querySelectorAll('button, [role="button"]')) {
                    if (b.dataset.museSyncClicked === '1') continue;
                    const r = b.getClientRects();
                    if (!r.length || (r[0].width === 0 && r[0].height === 0)) continue;
                    if (b.closest('form')) continue;
                    const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).trim();
                    if (!label || !sidebarControlMatch(label) || exclude.test(label)) continue;
                    const token = 'm' + (window.__museSyncNext++);
                    b.dataset.museSyncToken = token;
                    out.push(token);
                  }
                  return { tokens: out };
                })()
                """);
            if (tokens is not System.Text.Json.Nodes.JsonObject tokObj
                || tokObj["tokens"] is not System.Text.Json.Nodes.JsonArray tokArr
                || tokArr.Count == 0)
                return null;
            var token = tokArr[0]?.GetValue<string>();
            if (string.IsNullOrEmpty(token)) return null;
            var clicked = await Eval(page, $$"""
                (() => {
                  const b = document.querySelector('[data-muse-sync-token="{{token}}"]');
                  if (!b) return { clicked: false };
                  b.dataset.museSyncClicked = '1';
                  b.click();
                  return { clicked: true };
                })()
                """);
            if (clicked is not System.Text.Json.Nodes.JsonObject clickObj || !BoolNode(clickObj, "clicked"))
                return null;
            await Task.Delay(TimeSpan.FromMilliseconds(800));
            // v0.8.6, chống lạc trang: chỉ quét lại khi trang vẫn ở
            // khu vực chat. Nếu nút bấm đã dẫn sang trang khác thì
            // quay lại trang trước, loại nút đó (đã đánh dấu clicked)
            // và KHÔNG lấy số liệu trang lạc — kể cả khi trang lạc có
            // nhiều link hơn baseline. Lưu ý: nếu GoBack tải lại toàn
            // bộ trang thì dấu đã bấm trên DOM mất theo, nút đó có thể
            // bị bấm lại ở lần thử sau — nhưng vòng lặp vẫn giới hạn
            // 4 lần và không bao giờ nhận số liệu trang lạc làm kết quả.
            if (!DiagnosticLines.IsChatAreaUrl(page.Url))
            {
                try { await page.GoBackAsync(); } catch { }
                await Task.Delay(TimeSpan.FromMilliseconds(800));
                continue;
            }
            var rescan = await ScanThreadsPage(page);
            if (DiagnosticLines.ShouldAcceptRescan(page.Url, rescan, baseline)) return rescan;
            // Không tốt hơn thì giữ nguyên baseline và thử nút tiếp
            // theo (tối đa 4 lần); nút đã bấm không bấm lại.
        }
        return null;
    }

    // Đã bấm nút sidebar nào chưa (v0.8.5, chỉ để ghi cờ chẩn đoán
    // khi bấm mà số liệu không tăng): kiểm tra dấu đã bấm trên trang.
    private async Task<bool> AnySidebarButtonClickedAsync(IPage page)
    {
        var result = await Eval(page, """
            (() => ({ clicked: !!document.querySelector('[data-muse-sync-clicked="1"]') }))()
            """);
        return result is System.Text.Json.Nodes.JsonObject obj && BoolNode(obj, "clicked");
    }

    // Thăm dò nút lịch sử có kiểm soát (v0.8.7, chỉ chạy khi quét link
    // cho 0 thread và chỉ sau bước mở sidebar cũ): lịch sử trên trang
    // tạm không hiện thành link /thread/ (log thật 0.8.6: trang chủ 0
    // thread / 13 link / 119 nút, /thread/new 0 thread / 1 link / 96
    // nút) nên phải thử bấm nút trong aside/nav và xem URL đổi đi đâu.
    // An toàn: chỉ nút đang hiển thị trong aside/nav; bỏ qua nút trong
    // form, nút trong dialog, nút khớp loại trừ cũ (đăng nhập/đăng
    // xuất/thanh toán/nâng cấp/xóa) và nút khớp mẫu điều khiển sidebar
    // cũ (đã thử ở bước trước); tối đa 30 nút và chung ngân sách 60
    // giây cho cả lần quét một tài khoản (deadline do caller cấp).
    // Sau mỗi lần bấm: URL thành /thread/<id> thì ghi nhận thread đó
    // (id từ URL + title theo thứ tự ưu tiên v0.8.9: text hiển thị
    // của nút vừa bấm đã làm sạch, rồi document.title đã làm sạch,
    // rồi null thì extension tự đặt dự phòng như cũ) rồi GoBack; URL thành /thread/new thì GoBack
    // + loại nút (nút tạo
    // mới, không phải lịch sử); URL không đổi thì bấm Escape; URL rời
    // khỏi khu vực chat thì GoBack ngay + loại nút, không ghi nhận gì
    // từ trang lạc. Không bao giờ điền form, không gửi tin, không bấm
    // nút trong dialog (dialog hiện ra thì chỉ bấm Escape). Gặp tín
    // hiệu hết hạn thì dừng ngay và báo HitAuth để caller ném Auth
    // như vòng poll chính. Nút đã bấm được đánh dấu trên DOM để lần
    // liệt kê sau không bấm lại (cùng lưu ý như 0.8.6: nếu GoBack tải
    // lại toàn bộ trang thì dấu mất theo và nút có thể bị bấm lại,
    // nhưng vòng lặp vẫn bị chặn bởi 30 nút / 60 giây và URL thread
    // đã ghi nhận thì không ghi trùng).
    private async Task<(WebThreadsScan? Found, bool HitAuth)> ProbeHistoryButtonsAsync(
        IPage page, WebThreadsScan baseline, DateTimeOffset deadline)
    {
        var found = new List<(string Url, string? Title)>(baseline.Threads);
        var seen = new HashSet<string>(found.Select(t => t.Url), StringComparer.OrdinalIgnoreCase);
        var clicked = 0;
        // v0.8.12: true khi title của một thread ĐÃ CÓ trong baseline
        // được ghi đè bằng title nút thật — trường hợp này số lượng
        // thread không tăng nên điều kiện trả kết quả cũ (chỉ đếm số
        // lượng) sẽ nuốt mất nâng cấp; cờ này giữ lại kết quả đó.
        var upgraded = false;
        // v0.8.9: bảng token → text hiển thị của nút, giữ trong vòng
        // quét hiện tại để khi một cú bấm mở ra thread thì lấy text
        // của chính nút đó làm title (không lưu text ra ngoài vòng
        // quét, không ghi text vào log — title chỉ đi trong kết quả
        // thread trả về extension).
        var probeTexts = new Dictionary<string, string?>(StringComparer.Ordinal);
        while (clicked < 30 && DateTimeOffset.UtcNow < deadline)
        {
            var tokens = await Eval(page, """
                (() => {
                  // __PROBE_SKIP_FN_START__
                  const probeSkipLabel = (label) => {
                    const exclude = /log\s?in|sign\s?in|đăng nhập|log\s?out|sign\s?out|đăng xuất|payment|thanh toán|billing|upgrade|subscribe|pricing|delete|xoá|xóa/i;
                    const norm = ' ' + (label || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim() + ' ';
                    const control = norm.includes(' history ') || norm.includes(' lịch sử ') || norm.includes(' sidebar ') || norm.includes(' menu ') || norm.includes(' new chat ');
                    return exclude.test(label || '') || control;
                  };
                  // __PROBE_SKIP_FN_END__
                  // __PROBE_ENUM_START__
                  const probeEnumerate = () => {
                    const out = [];
                    if (!window.__museProbeNext) window.__museProbeNext = 1;
                    for (const b of document.querySelectorAll('aside button, aside [role="button"], nav button, nav [role="button"]')) {
                      if (b.dataset.museProbeClicked === '1') continue;
                      if (b.closest('form')) continue;
                      if (b.closest('dialog, [role="dialog"], [role="alertdialog"]')) continue;
                      const r = b.getClientRects();
                      if (!r.length || (r[0].width === 0 && r[0].height === 0)) continue;
                      const label = ((b.getAttribute('aria-label') || '') + ' ' + (b.getAttribute('title') || '')).trim();
                      if (probeSkipLabel(label)) continue;
                      const token = 'p' + (window.__museProbeNext++);
                      b.dataset.museProbeToken = token;
                      // v0.8.9: trả thêm text hiển thị của nút — đây là
                      // nơi title thật của hội thoại nằm (document.title
                      // của muse.ai chỉ là "Chat - Muse" chung chung).
                      const text = (b.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 80);
                      out.push({ token, text });
                    }
                    return { items: out };
                  };
                  // __PROBE_ENUM_END__
                  return probeEnumerate();
                })()
                """);
            if (tokens is not System.Text.Json.Nodes.JsonObject tokObj
                || tokObj["items"] is not System.Text.Json.Nodes.JsonArray tokArr
                || tokArr.Count == 0)
                break;
            foreach (var it in tokArr)
            {
                if (it is System.Text.Json.Nodes.JsonObject io
                    && io["token"]?.GetValue<string>() is string tk && tk.Length > 0)
                    probeTexts[tk] = io["text"]?.GetValue<string>();
            }
            var token = tokArr[0] is System.Text.Json.Nodes.JsonObject first
                ? first["token"]?.GetValue<string>() : null;
            if (string.IsNullOrEmpty(token)) break;
            var beforeUrl = page.Url;
            var clickedResult = await Eval(page, $$"""
                (() => {
                  const b = document.querySelector('[data-muse-probe-token="{{token}}"]');
                  if (!b) return { clicked: false };
                  b.dataset.museProbeClicked = '1';
                  b.click();
                  return { clicked: true };
                })()
                """);
            if (clickedResult is not System.Text.Json.Nodes.JsonObject clickObj || !BoolNode(clickObj, "clicked"))
                break;
            clicked++;
            await Task.Delay(TimeSpan.FromMilliseconds(800));
            var state = await ReadProbeStateAsync(page);
            var (outcome, threadId) = DiagnosticLines.DecideProbeOutcome(beforeUrl, state.Url, state.LoginSignal);
            switch (outcome)
            {
                case DiagnosticLines.ProbeOutcome.StopAuth:
                    return (null, true);
                case DiagnosticLines.ProbeOutcome.RecordThread:
                {
                    var url = Upstream.Site + "/thread/" + threadId!;
                    // v0.8.9: title lấy theo thứ tự ưu tiên — (a) text
                    // hiển thị của chính nút vừa bấm (đây mới là nơi
                    // title thật nằm; document.title của muse.ai chỉ
                    // là "Chat - Muse" chung chung), (b) document.title
                    // đã làm sạch như cũ, (c) null để extension giữ dự
                    // phòng "Hội thoại web <id>" như cũ. Text nút
                    // không bao giờ ghi vào log.
                    probeTexts.TryGetValue(token, out var buttonText);
                    var title = DiagnosticLines.CleanProbeButtonTitle(buttonText)
                        ?? DiagnosticLines.CleanThreadTitle(state.Title);
                    // v0.8.12: thread đã có trong baseline thì title nút
                    // GHI ĐÈ title cũ (anchor text hoặc rỗng) thay vì
                    // bị bỏ qua vì seen.Add thất bại như trước; title
                    // null thì giữ nguyên title cũ. Thread mới vẫn thêm
                    // như cũ, không tạo trùng lặp.
                    var alreadyKnown = !seen.Add(url);
                    var titleChanged = DiagnosticLines.ApplyProbeTitle(found, url, title);
                    if (alreadyKnown && titleChanged) upgraded = true;
                    try { await page.GoBackAsync(); } catch { }
                    await Task.Delay(TimeSpan.FromMilliseconds(800));
                    break;
                }
                case DiagnosticLines.ProbeOutcome.GoBackNew:
                case DiagnosticLines.ProbeOutcome.GoBackOther:
                case DiagnosticLines.ProbeOutcome.GoBackLeftChat:
                    try { await page.GoBackAsync(); } catch { }
                    await Task.Delay(TimeSpan.FromMilliseconds(800));
                    // Sau khi quay lại mà trang đã hết hạn thì dừng
                    // ngay thay vì liệt kê tiếp trên trang đăng nhập.
                    if ((await ReadProbeStateAsync(page)).LoginSignal) return (null, true);
                    break;
                case DiagnosticLines.ProbeOutcome.EscapeUnchanged:
                    try { await page.Keyboard.PressAsync("Escape"); } catch { }
                    await Task.Delay(TimeSpan.FromMilliseconds(300));
                    break;
            }
        }
        if (found.Count > baseline.Threads.Count || upgraded)
            return (new WebThreadsScan(found, baseline.PageUrl, baseline.LinkCount, baseline.LoginHint,
                baseline.Title, baseline.HasLoginForm, baseline.ButtonCount, Groups: baseline.Groups), false);
        return (null, false);
    }

    // Trạng thái nhẹ sau một lần bấm thăm dò: URL hiện tại + tín hiệu
    // hết hạn (gợi ý chữ trên 2000 ký tự đầu hoặc form đăng nhập) +
    // document.title thô của trang hiện tại. Title thô do caller làm
    // sạch bằng CleanThreadTitle; chỉ đọc title, không đọc nội dung
    // trang hay tin nhắn.
    private async Task<(string Url, bool LoginSignal, string? Title)> ReadProbeStateAsync(IPage page)
    {
        var result = await Eval(page, """
            (() => ({
              head: (document.body ? document.body.innerText.slice(0, 2000) : ''),
              hasLoginForm: !!document.querySelector('input[type="password"], input[type="email"]'),
              title: (document.title || ''),
            }))()
            """);
        if (result is not System.Text.Json.Nodes.JsonObject obj)
            return (page.Url, false, null);
        var head = (Str(obj, "head") ?? "").ToLowerInvariant();
        var textHint = Dom.LoginHints.Any(h => head.Contains(h));
        return (page.Url, DiagnosticLines.HasLoginSignal(textHint, BoolNode(obj, "hasLoginForm")), Str(obj, "title"));
    }

    // Một lần quét trang: <a href> + regex /thread/<id> trên outerHTML.
    // Trả kèm linkCount (tổng số <a> CÓ href đọc được, giữ nguyên nghĩa
    // cũ), LoginHint (gợi ý chữ HOẶC form đăng nhập, v0.8.5), tiêu đề
    // chung của app, số nút bấm, và nhóm chẩn đoán chỉ gồm số lượng
    // (v0.8.7: anchor phân theo mẫu href, nút trong aside/nav, nút có
    // aria-label, phần tử có data-testid chứa history/sidebar) — để
    // caller phân biệt hết hạn với rỗng thật và để dòng web_threads
    // chẩn đoán từng trang. Debug chỉ chứa số lượng + tiêu đề chung,
    // không chứa nội dung trang hay tiêu đề hội thoại.
    private async Task<WebThreadsScan> ScanThreadsPage(IPage page)
    {
        var result = await Eval(page, """
            (() => {
              const links = [...document.querySelectorAll('a')].map(a => {
                const attr = a.getAttribute('href');
                const hasHref = attr !== null && attr.trim() !== '';
                return {
                  href: hasHref ? (a.href || '') : '',
                  hasHref,
                  title: hasHref ? (a.innerText || '').trim().replace(/\s+/g, ' ') : '',
                };
              });
              return {
                head: (document.body ? document.body.innerText.slice(0, 2000) : ''),
                html: (document.documentElement ? document.documentElement.outerHTML.slice(0, 500000) : ''),
                links,
                title: (document.title || ''),
                hasLoginForm: !!document.querySelector('input[type="password"], input[type="email"]'),
                buttonCount: document.querySelectorAll('button, [role="button"]').length,
                asideNavButtons: document.querySelectorAll('aside button, aside [role="button"], nav button, nav [role="button"]').length,
                labeledButtons: [...document.querySelectorAll('button, [role="button"]')].filter(b => (b.getAttribute('aria-label') || '').trim() !== '').length,
                historyTestids: [...document.querySelectorAll('[data-testid]')].filter(el => /history|sidebar/i.test(el.getAttribute('data-testid') || '')).length,
              };
            })()
            """);
        if (result is not System.Text.Json.Nodes.JsonObject obj)
            return new WebThreadsScan(new List<(string Url, string? Title)>(), page.Url, 0, LoginHint: false);
        var head = (Str(obj, "head") ?? "").ToLowerInvariant();
        var textHint = Dom.LoginHints.Any(h => head.Contains(h));
        var hasLoginForm = BoolNode(obj, "hasLoginForm");
        var loginHint = DiagnosticLines.HasLoginSignal(textHint, hasLoginForm);
        var pageTitle = DiagnosticLines.TruncateTitle(Str(obj, "title"));
        var buttonCount = obj["buttonCount"] is System.Text.Json.Nodes.JsonValue bv && bv.TryGetValue<int>(out var bc) ? bc : 0;
        var asideNavButtons = obj["asideNavButtons"] is System.Text.Json.Nodes.JsonValue av && av.TryGetValue<int>(out var an) ? an : 0;
        var labeledButtons = obj["labeledButtons"] is System.Text.Json.Nodes.JsonValue lv && lv.TryGetValue<int>(out var lb) ? lb : 0;
        var historyTestids = obj["historyTestids"] is System.Text.Json.Nodes.JsonValue hv && hv.TryGetValue<int>(out var ht) ? ht : 0;
        var seen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var threads = new List<(string Url, string? Title)>();
        var linkCount = 0;
        var threadLinks = 0;
        var libraryLinks = 0;
        var settingsLinks = 0;
        var otherLinks = 0;
        var noHrefAnchors = 0;
        if (obj["links"] is System.Text.Json.Nodes.JsonArray links)
        {
            foreach (var item in links)
            {
                if (item is not System.Text.Json.Nodes.JsonObject link) continue;
                var hasHref = link["hasHref"] is System.Text.Json.Nodes.JsonValue hv2 && hv2.TryGetValue<bool>(out var hb) && hb;
                var href = Str(link, "href") ?? "";
                // Phân nhóm chỉ để đếm (v0.8.7): anchor không href đếm
                // riêng; linkCount giữ nguyên nghĩa cũ là số anchor CÓ
                // href (để số liệu các bản so sánh được với nhau).
                switch (DiagnosticLines.ClassifyAnchorGroup(hasHref, href))
                {
                    case DiagnosticLines.AnchorGroup.Thread: threadLinks++; break;
                    case DiagnosticLines.AnchorGroup.Library: libraryLinks++; break;
                    case DiagnosticLines.AnchorGroup.Settings: settingsLinks++; break;
                    case DiagnosticLines.AnchorGroup.Other: otherLinks++; break;
                    default: noHrefAnchors++; break;
                }
                if (!hasHref) continue;
                linkCount++;
                if (!LocalConversationStore.IsThread(href)) continue;
                var normalized = href.TrimEnd('/');
                if (!seen.Add(normalized)) continue;
                var title = Str(link, "title") ?? "";
                if (title.Length > 200) title = title[..200];
                // v0.8.13: anchor mang tiêu đề chung của app (mọi dạng
                // Chat/Muse/Chat-Muse) thì lưu thành "" để extension rơi
                // về dự phòng "Hội thoại web <id>", không lưu chuỗi
                // chung làm title thật khiến mọi hội thoại giống nhau.
                if (DiagnosticLines.IsGenericWebTitle(title)) title = "";
                threads.Add((normalized, title));
            }
        }
        var html = Str(obj, "html") ?? "";
        foreach (System.Text.RegularExpressions.Match m in
            System.Text.RegularExpressions.Regex.Matches(html, @"/thread/([A-Za-z0-9_\-]+)"))
        {
            var url = Upstream.Site + "/thread/" + m.Groups[1].Value;
            if (!LocalConversationStore.IsThread(url)) continue;
            if (!seen.Add(url)) continue;
            threads.Add((url, ""));
        }
        var groups = new WebThreadsGroupDiag(threadLinks, libraryLinks, settingsLinks, otherLinks,
            noHrefAnchors, asideNavButtons, labeledButtons, historyTestids);
        return new WebThreadsScan(threads, page.Url, linkCount, loginHint, pageTitle, hasLoginForm, buttonCount, Groups: groups);
    }

    // ---------- lấy hồ sơ tài khoản, best-effort (v0.8.2, viết lại từ v0.7.0) ----------
    // Nguyên nhân lỗi 0.8.1: bản cũ chỉ mở trang chủ, chờ 2,5 giây, đọc
    // innerText + vài nút hồ sơ mà KHÔNG bấm mở menu hồ sơ, KHÔNG vào
    // trang cài đặt/tài khoản, KHÔNG đọc HTML nhúng hay localStorage,
    // KHÔNG gọi API phiên. Trên trang chủ, email gần như chắc chắn
    // không hiện dưới dạng text nhìn thấy (menu hồ sơ thường chỉ hiện
    // avatar/tên, email chỉ hiện khi bấm mở menu hoặc vào trang cài
    // đặt), nên regex email trên text trang chủ gần như luôn về rỗng.
    // Bản này làm nhiều bước best-effort theo thứ tự, bước nào lấy
    // được thì dùng, bước nào thất bại thì bỏ qua không lỗi cả quá
    // trình, KHÔNG BAO GIỜ log email/phone hay toàn bộ JSON:
    //  1. API phiên /api/session bằng HttpClient với cookie của tài
    //     khoản: đọc toàn bộ JSON, tìm đệ quy các khóa user/email/
    //     username/name/phone (chỉ lấy giá trị chuỗi).
    //  2. Trang chủ như cũ (text + candidates) cộng regex email trên
    //     toàn bộ outerHTML (bắt email trong JSON nhúng/hydration mà
    //     innerText không thấy). Vẫn KHÔNG mở thread để tìm email.
    //  3. Bấm mở menu hồ sơ (selector nút avatar/hồ sơ, xem script):
    //     bấm không được thì bỏ qua, không lỗi.
    //  4. Nếu menu đã mở, bấm mục menu Settings/Cài đặt/Account/Tài
    //     khoản để vào trang cài đặt (đi theo menu thật, KHÔNG đoán
    //     URL cài đặt rồi coi 404 là lỗi); đọc lại text + trường gắn
    //     nhãn Phone/Số điện thoại/Điện thoại + input tel.
    //  5. Quét localStorage của trang (đúng context của tài khoản) để
    //     tìm email bằng regex trong các giá trị trông như đối tượng
    //     user, làm bước cuối cùng.
    //  6. Trả kèm ProfileDebug (chỉ tên bước, trạng thái, URL cuối,
    //     menu/cài đặt có mở được không, số candidate — không chứa
    //     email/phone) để endpoint profile-refresh trả về cho panel
    //     Cài đặt hiện chẩn đoán ngắn gọn khi không lấy được gì.
    // Phiên hết hạn thật thì vẫn lỗi Auth: API phiên trả 401/403, hoặc
    // trang chủ bị đẩy khỏi muse.ai / hiện gợi ý đăng nhập trong khi
    // API phiên cũng không xác nhận được phiên.
    // Phone: chỉ khi trang cài đặt thực sự có trường phone gắn nhãn
    // hoặc API phiên trả về phone; trong đa số trường hợp phone vẫn
    // trống vì Muse không dùng số điện thoại làm thông tin hồ sơ — đó
    // là hành vi đúng, không phải lỗi (xem README).
    // Selector nút avatar/menu cài đặt là PHỎNG ĐOÁN về DOM thật của
    // muse.ai, chưa kiểm chứng bằng mắt trên Windows — xem README.
    public async Task<ProfileInfo?> FetchProfile(Account account, CancellationToken cancel = default)
        => (await FetchProfileDetailed(account, cancel)).Profile;

    public async Task<(ProfileInfo? Profile, ProfileDebug Debug)> FetchProfileDetailed(Account account, CancellationToken cancel = default)
    {
        if (Upstream.MissingSessionCookies(account.Cookies) is { Count: > 0 })
            throw UpstreamException.Auth("Tài khoản Muse đã hết hạn, hãy đăng nhập lại");
        var attempted = new List<string>();
        var succeeded = new List<string>();
        var failed = new List<string>();
        // v0.8.3: tích lũy quét hồ sơ — giá trị chấp nhận + nguồn chi
        // tiết (bước:trường) + rác bị loại (chỉ rác đầu tiên mỗi
        // trường). Nguồn chi tiết dùng cho dòng profile_detail ở cuối
        // hàm; nguồn tên bước dùng cho JSON debug (không giá trị).
        var scan = new ProfileScan();
        var sessionApiOk = false;

        // ---- Bước 1: API phiên ----
        attempted.Add("session_api");
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
            client.DefaultRequestHeaders.Add("User-Agent", Upstream.UserAgent);
            client.DefaultRequestHeaders.Add("Accept", "application/json");
            using var req = new HttpRequestMessage(HttpMethod.Get, Upstream.SessionApi);
            req.Headers.Add("Cookie", Upstream.CookieHeader(account.Cookies));
            req.Headers.Referrer = new Uri(Upstream.Site);
            using var resp = await client.SendAsync(req, cancel);
            if ((int)resp.StatusCode is 401 or 403)
                throw UpstreamException.Auth("Tài khoản Muse đã hết hạn, hãy đăng nhập lại");
            if (resp.IsSuccessStatusCode)
            {
                var text = await resp.Content.ReadAsStringAsync(cancel);
                string? nameFallback = null;
                void Walk(System.Text.Json.Nodes.JsonNode? node)
                {
                    if (node is System.Text.Json.Nodes.JsonObject obj)
                    {
                        foreach (var (key, value) in obj)
                        {
                            if (value is System.Text.Json.Nodes.JsonValue v
                                && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s))
                            {
                                // v0.8.3: chỉ nhận giá trị qua kiểm tra
                                // hợp lệ — API phiên cũng có thể trả id
                                // kỹ thuật (UUID) hay chuỗi trông như
                                // email nhưng thực ra là tên file. Rác
                                // bị loại cũng ghi lại nguồn (khóa JSON)
                                // để dòng profile_detail chỉ rõ nó từ
                                // đâu tới, thay vì chỉ biết là không lấy
                                // được.
                                switch (key.ToLowerInvariant())
                                {
                                    case "email":
                                        if (scan.Email is null && ProfileValidation.IsValidEmail(s))
                                            { scan.Email = s.Trim(); scan.EmailDetail ??= "session_api:email"; scan.EmailSource ??= "session_api"; }
                                        else if (scan.Email is null && scan.EmailRejectedValue is null
                                            && s.Contains('@') && !ProfileValidation.IsValidEmail(s))
                                            { scan.EmailRejectedSource = "session_api:email:rejected"; scan.EmailRejectedValue = s.Trim(); }
                                        break;
                                    case "username":
                                        // v0.8.5: khóa `username` dạng UUID cũng là id
                                        // người dùng, không phải tên hiển thị — ghi
                                        // vào MuseUserId, không ghi username.
                                        if (ProfileValidation.IsUuid(s))
                                        {
                                            if (scan.MuseUserId is null)
                                                { scan.MuseUserId = s.Trim().ToLowerInvariant(); scan.MuseUserIdDetail ??= "session_api:username"; }
                                        }
                                        else if (scan.Username is null && ProfileValidation.IsValidUsername(s))
                                            { scan.Username = s.Trim(); scan.UsernameDetail ??= "session_api:username"; scan.UsernameSource ??= "session_api"; }
                                        else if (scan.Username is null && scan.UsernameRejectedValue is null
                                            && ProfileValidation.IsTechnicalId(s))
                                            { scan.UsernameRejectedSource = "session_api:username:rejected"; scan.UsernameRejectedValue = s.Trim(); }
                                        break;
                                    case "name":
                                        // v0.8.5: khóa `name` dạng UUID là id người dùng
                                        // Muse ổn định (trường hợp user đã xác nhận) —
                                        // ghi vào MuseUserId, KHÔNG ghi username.
                                        // Tên người thật vẫn làm username như cũ.
                                        if (ProfileValidation.IsUuid(s))
                                        {
                                            if (scan.MuseUserId is null)
                                                { scan.MuseUserId = s.Trim().ToLowerInvariant(); scan.MuseUserIdDetail ??= "session_api:name"; }
                                        }
                                        else if (nameFallback is null && ProfileValidation.IsValidUsername(s))
                                            nameFallback = s.Trim();
                                        else if (scan.Username is null && scan.UsernameRejectedValue is null
                                            && ProfileValidation.IsTechnicalId(s))
                                            { scan.UsernameRejectedSource = "session_api:name:rejected"; scan.UsernameRejectedValue = s.Trim(); }
                                        break;
                                    case "phone":
                                        if (scan.Phone is null)
                                            { scan.Phone = s.Trim(); scan.PhoneDetail ??= "session_api:phone"; }
                                        break;
                                }
                            }
                            Walk(value);
                        }
                    }
                    else if (node is System.Text.Json.Nodes.JsonArray arr)
                    {
                        foreach (var item in arr) Walk(item);
                    }
                }
                try
                {
                    Walk(System.Text.Json.Nodes.JsonNode.Parse(text));
                    if (scan.Username is null && nameFallback is not null)
                        { scan.Username = nameFallback; scan.UsernameDetail ??= "session_api:name"; scan.UsernameSource ??= "session_api"; }
                    sessionApiOk = true;
                    succeeded.Add("session_api");
                }
                catch { failed.Add("session_api"); }
            }
            else failed.Add("session_api");
        }
        catch (UpstreamException) { throw; }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested) { throw; }
        catch { if (!failed.Contains("session_api")) failed.Add("session_api"); }

        // ---- Các bước trình duyệt (trang tạm, đúng context) ----
        var context = await GetContext(account);
        var page = await context.NewPageAsync();
        // v0.8.4: PHÁT HIỆN API (chỉ chẩn đoán, chưa dùng API mới nào
        // để lấy hồ sơ). Lắng nghe request của chính trang này trong
        // suốt quá trình fetch (trang chủ, menu, cài đặt) và ghi lại
        // đường dẫn /api/* tới host muse.ai — CHỈ path đã bỏ query
        // string, KHÔNG body, KHÔNG header, KHÔNG cookie, KHÔNG nội
        // dung response. Danh sách này in vào dòng profile_detail để
        // lần sau biết chính trang web Muse gọi API nào khi tải trang
        // hồ sơ/cài đặt, từ đó mới chọn API nào để dùng tiếp.
        var apiPaths = new List<string>();
        var apiSeen = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        var apiLock = new object();
        EventHandler<IRequest> onRequest = (_, req) =>
        {
            try
            {
                var path = ApiPathOfRequest(req.Url);
                if (path is null) return;
                lock (apiLock)
                {
                    // Giới hạn để dòng log không dài vô hạn.
                    if (apiPaths.Count < 50 && apiSeen.Add(path)) apiPaths.Add(path);
                }
            }
            catch { /* lắng nghe chẩn đoán không được làm hỏng fetch */ }
        };
        page.Request += onRequest;
        var finalUrl = Upstream.Site;
        var menuOpened = false;
        var settingsOpened = false;
        var homeUsable = false;
        // v0.8.4: trang đã tải đúng host muse.ai thì vẫn dùng được cho
        // menu/localStorage dù khâu đọc trang chủ lỗi (read null hay
        // gợi ý đăng nhập trong đầu trang khi API phiên vẫn xác thực
        // được); chỉ Goto thất bại hoặc host sai mới bỏ qua các bước
        // sau. homeError ghi rõ lý do để log 0.8.4 chẩn đoán được.
        var pageUsable = false;
        string? homeError = null;
        try
        {
            // ---- Bước 2: trang chủ (+ outerHTML), thử lại 1 lần ----
            // Lỗi tải trang thoáng qua khá thường gặp nên Goto + đọc
            // được thử tối đa 2 lần trước khi kết luận home thất bại.
            attempted.Add("home");
            for (var attempt = 0; attempt < 2 && !homeUsable; attempt++)
            {
                try
                {
                    await page.GotoAsync(Upstream.Site,
                        new PageGotoOptions { WaitUntil = WaitUntilState.DOMContentLoaded });
                    await Task.Delay(TimeSpan.FromSeconds(2.5), cancel);
                    finalUrl = page.Url;
                    var read = await ReadProfilePage(page, cancel);
                    var hostOk = Uri.TryCreate(page.Url, UriKind.Absolute, out var pageUri)
                        && pageUri.Host.Equals("muse.ai", StringComparison.OrdinalIgnoreCase);
                    var head = read is null ? ""
                        : (read.Text.Length > 2000 ? read.Text[..2000] : read.Text).ToLowerInvariant();
                    var loginHint = read is not null && Dom.LoginHints.Any(h => head.Contains(h));
                    var (usable, error, throwAuth) = DecideHomeOutcome(read is null, hostOk, loginHint, sessionApiOk);
                    pageUsable = usable;
                    homeError = error;
                    if (throwAuth)
                        throw UpstreamException.Auth("Tài khoản Muse đã hết hạn, hãy đăng nhập lại");
                    if (error is null && read is not null)
                    {
                        MergeProfilePage(read, "home", scan);
                        homeUsable = true;
                        succeeded.Add("home");
                    }
                }
                catch (UpstreamException) { throw; }
                catch (OperationCanceledException) when (cancel.IsCancellationRequested) { throw; }
                catch (Exception ex)
                {
                    // Chỉ ghi tên loại exception, không ghi thông điệp
                    // (có thể chứa nội dung trang) hay nội dung trang.
                    homeError = "goto_error:" + ex.GetType().Name;
                    pageUsable = false;
                }
            }
            if (!homeUsable && !failed.Contains("home")) failed.Add("home");

            // ---- Bước 3: bấm mở menu hồ sơ ----
            // v0.8.4: chỉ cần trang đã tải đúng host là thử, không cần
            // khâu đọc trang chủ thành công.
            if (pageUsable)
            {
                attempted.Add("menu");
                try
                {
                    var click = await Eval(page, """
                        (() => {
                          const els = [...document.querySelectorAll('button, [role="button"], a')];
                          const isMenuBtn = (e) => {
                            const label = (((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || ''))).toLowerCase();
                            const testid = (e.getAttribute('data-testid') || '').toLowerCase();
                            if (label.includes('profile') || label.includes('account') || label.includes('user') || label.includes('hồ sơ') || label.includes('tài khoản')) return true;
                            if (testid.includes('avatar') || testid.includes('profile') || testid.includes('account')) return true;
                            if (e.querySelector('img') && e.closest('header')) return true;
                            return false;
                          };
                          const btn = els.find(isMenuBtn);
                          if (!btn) return { clicked: false };
                          try { btn.click(); } catch { return { clicked: false }; }
                          return { clicked: true };
                        })()
                        """, cancel);
                    var clicked = click is System.Text.Json.Nodes.JsonObject clickObj
                        && clickObj["clicked"] is System.Text.Json.Nodes.JsonValue cv
                        && cv.TryGetValue<bool>(out var cb) && cb;
                    if (!clicked) { failed.Add("menu"); }
                    else
                    {
                        await Task.Delay(TimeSpan.FromSeconds(1.5), cancel);
                        finalUrl = page.Url;
                        var menuRead = await ReadProfilePage(page, cancel);
                        if (menuRead is not null) MergeProfilePage(menuRead, "menu", scan);
                        var menuCheck = await Eval(page, """
                            (() => ({ menuFound: !!document.querySelector('[role="menu"], [role="menuitem"]') }))()
                            """, cancel);
                        menuOpened = menuCheck is System.Text.Json.Nodes.JsonObject mc
                            && mc["menuFound"] is System.Text.Json.Nodes.JsonValue mv
                            && mv.TryGetValue<bool>(out var mb) && mb;
                        // Menu có thể mở mà không dùng role=menu: nếu
                        // sau khi bấm mà đọc được thêm candidate chứa
                        // Settings/Cài đặt thì cũng coi là đã mở.
                        if (!menuOpened && menuRead is not null)
                            menuOpened = menuRead.Candidates.Any(c =>
                                c.Equals("Settings", StringComparison.OrdinalIgnoreCase)
                                || c.Equals("Cài đặt", StringComparison.OrdinalIgnoreCase));
                        if (menuOpened) succeeded.Add("menu"); else failed.Add("menu");
                    }
                }
                catch (OperationCanceledException) when (cancel.IsCancellationRequested) { throw; }
                catch { if (!failed.Contains("menu") && !succeeded.Contains("menu")) failed.Add("menu"); }
            }

            // ---- Bước 4: bấm mục menu vào trang cài đặt ----
            if (menuOpened)
            {
                attempted.Add("settings");
                try
                {
                    var beforeUrl = page.Url;
                    var click = await Eval(page, """
                        (() => {
                          const els = [...document.querySelectorAll('a, button, [role="menuitem"]')];
                          const labelOf = (e) => ((e.innerText || '') + ' ' + (e.getAttribute('aria-label') || '')).trim().toLowerCase();
                          const isSettings = (e) => {
                            const t = labelOf(e);
                            return t === 'settings' || t === 'cài đặt' || t === 'account' || t === 'tài khoản'
                              || t.startsWith('settings ') || t.startsWith('cài đặt ');
                          };
                          const inMenu = els.filter(e => e.getAttribute('role') === 'menuitem' || e.closest('[role="menu"]'));
                          const btn = inMenu.find(isSettings) || els.find(isSettings);
                          if (!btn) return { clicked: false };
                          try { btn.click(); } catch { return { clicked: false }; }
                          return { clicked: true };
                        })()
                        """, cancel);
                    var clicked = click is System.Text.Json.Nodes.JsonObject clickObj
                        && clickObj["clicked"] is System.Text.Json.Nodes.JsonValue cv
                        && cv.TryGetValue<bool>(out var cb) && cb;
                    if (!clicked) { failed.Add("settings"); }
                    else
                    {
                        await Task.Delay(TimeSpan.FromSeconds(2), cancel);
                        finalUrl = page.Url;
                        var settingsRead = await ReadProfilePage(page, cancel);
                        if (settingsRead is not null) MergeProfilePage(settingsRead, "settings", scan);
                        settingsOpened = !string.Equals(page.Url, beforeUrl, StringComparison.OrdinalIgnoreCase)
                            || (settingsRead is not null && (settingsRead.Text.Contains("Settings") || settingsRead.Text.Contains("Cài đặt")));
                        if (settingsOpened) succeeded.Add("settings"); else failed.Add("settings");
                    }
                }
                catch (OperationCanceledException) when (cancel.IsCancellationRequested) { throw; }
                catch { if (!failed.Contains("settings") && !succeeded.Contains("settings")) failed.Add("settings"); }
            }

            // ---- Bước 5: quét localStorage (bước cuối) ----
            // v0.8.4: như bước menu — chỉ cần trang đã tải đúng host.
            if (pageUsable)
            {
                attempted.Add("local_storage");
                try
                {
                    var ls = await Eval(page, """
                        (() => {
                          const entries = [];
                          try {
                            for (let i = 0; i < localStorage.length; i++) {
                              const k = localStorage.key(i) || '';
                              const v = localStorage.getItem(k) || '';
                              if (v.length <= 20000) entries.push({ k, v });
                            }
                          } catch {}
                          return { entries: entries.slice(0, 50) };
                        })()
                        """, cancel);
                    var found = false;
                    if (ls is System.Text.Json.Nodes.JsonObject lsObj
                        && lsObj["entries"] is System.Text.Json.Nodes.JsonArray entries)
                    {
                        foreach (var item in entries)
                        {
                            if (item is not System.Text.Json.Nodes.JsonObject e) continue;
                            if (e["v"]?.GetValue<string>() is not { } v) continue;
                            if (!v.Contains('@')) continue;
                            if (!(v.Contains("\"email\"") || v.Contains("\"user\"") || v.Contains('{'))) continue;
                            var foundEmail = ProfileValidation.FindEmail(v);
                            if (foundEmail is not null)
                            {
                                if (scan.Email is null)
                                {
                                    scan.Email = foundEmail;
                                    scan.EmailDetail ??= "local_storage:" + (e["k"]?.GetValue<string>() ?? "?");
                                    scan.EmailSource ??= "local_storage";
                                }
                                found = true; break;
                            }
                        }
                    }
                    if (found) succeeded.Add("local_storage"); else failed.Add("local_storage");
                }
                catch (OperationCanceledException) when (cancel.IsCancellationRequested) { throw; }
                catch { failed.Add("local_storage"); }
            }
        }
        finally
        {
            try { page.Request -= onRequest; } catch { }
            try { await page.CloseAsync(); } catch { }
        }

        var debug = new ProfileDebug(attempted, succeeded, failed, finalUrl, menuOpened, settingsOpened, scan.CandidateCount, scan.EmailSource, scan.UsernameSource, homeError);
        // v0.8.3: dòng chi tiết mapping — CÓ chứa giá trị khớp được thật
        // (kể cả rác bị loại, kèm nguồn bước:trường), chỉ in ra stdout
        // gateway cục bộ (Output > Muse Gateway) theo yêu cầu chẩn đoán
        // của user; KHÔNG đưa vào JSON debug, popup hay panel Cài đặt.
        // Dòng tóm tắt profile_refresh (không giá trị) vẫn giữ nguyên để
        // sao chép thoải mái.
        Diagnostic?.Invoke(DiagnosticLines.ProfileDetailLine(account.Id,
            scan.Email, scan.EmailDetail, scan.EmailRejectedSource, scan.EmailRejectedValue,
            scan.Username, scan.UsernameDetail, scan.UsernameRejectedSource, scan.UsernameRejectedValue,
            scan.Phone, scan.PhoneDetail, homeError, apiPaths,
            scan.MuseUserId, scan.MuseUserIdDetail));
        if (scan.Email is null && scan.Username is null && scan.Phone is null && scan.MuseUserId is null) return (null, debug);
        return (new ProfileInfo(scan.Email, scan.Username, scan.Phone, scan.MuseUserId), debug);
    }

    // v0.8.4: phân loại kết quả một lần đọc trang chủ thành
    // (pageUsable, homeError, throwAuth), để kiểm chứng được bằng
    // test đơn vị mà không cần trình duyệt thật. pageUsable=true khi
    // trang đã tải đúng host muse.ai — kể cả khi đọc trả null hay đầu
    // trang có gợi ý đăng nhập — vì menu/localStorage vẫn thử được
    // trên cùng trang đó; chỉ host sai mới coi là trang không dùng
    // được. throwAuth=true giữ đúng hành vi cũ: phiên hết hạn thật
    // (API phiên cũng không xác thực được) thì báo Auth thay vì im
    // lặng coi là home thất bại.
    public static (bool PageUsable, string? HomeError, bool ThrowAuth) DecideHomeOutcome(
        bool readNull, bool hostIsMuseAi, bool loginHint, bool sessionApiOk)
    {
        if (!hostIsMuseAi) return (false, "wrong_host", !sessionApiOk);
        if (readNull) return (true, "read_null", false);
        if (loginHint) return (true, "login_hint", !sessionApiOk);
        return (true, null, false);
    }

    // v0.8.4: trích đường dẫn /api/* từ URL request của trang để PHÁT
    // HIỆN API (chỉ chẩn đoán). Trả null khi không phải request tới
    // host muse.ai hoặc không bắt đầu bằng /api/. CHỈ lấy AbsolutePath
    // (đã bỏ query string — query có thể chứa token) và không bao giờ
    // đọc body/header/cookie/response của request.
    public static string? ApiPathOfRequest(string url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return null;
        if (!uri.Host.Equals("muse.ai", StringComparison.OrdinalIgnoreCase)) return null;
        var path = uri.AbsolutePath;
        if (!path.StartsWith("/api/", StringComparison.OrdinalIgnoreCase)) return null;
        return path;
    }

    // Một lần đọc trang cho profile: text + tiêu đề + candidates +
    // input tel + outerHTML (để regex email trong JSON nhúng).
    private sealed record ProfilePageRead(string Text, string Title, List<string> Candidates, string TelValue, string Html);

    private async Task<ProfilePageRead?> ReadProfilePage(IPage page, CancellationToken cancel)
    {
        var result = await Eval(page, """
            (() => {
              const seen = new Set();
              const candidates = [];
              const push = (v) => {
                const t = (v || '').trim().replace(/\s+/g, ' ');
                if (t && t.length <= 120 && !seen.has(t)) { seen.add(t); candidates.push(t); }
              };
              document.querySelectorAll('button[aria-label], [role="button"][aria-label]').forEach(e => push(e.getAttribute('aria-label')));
              document.querySelectorAll('[data-testid]').forEach(e => {
                const id = (e.getAttribute('data-testid') || '').toLowerCase();
                if (id.includes('profile') || id.includes('avatar') || id.includes('account') || id.includes('user')) push(e.innerText);
              });
              document.querySelectorAll('header button, header [role="button"]').forEach(e => push(e.innerText || e.getAttribute('aria-label')));
              const tel = document.querySelector('input[type="tel"]');
              return {
                text: (document.body ? document.body.innerText.slice(0, 12000) : ''),
                title: document.title || '',
                candidates: candidates.slice(0, 20),
                telValue: tel ? (tel.value || '') : '',
                html: (document.documentElement ? document.documentElement.outerHTML.slice(0, 500000) : ''),
              };
            })()
            """, cancel);
        if (result is not System.Text.Json.Nodes.JsonObject obj) return null;
        var candidates = new List<string>();
        if (obj["candidates"] is System.Text.Json.Nodes.JsonArray arr)
            foreach (var item in arr)
                if (item?.GetValue<string>() is { } c) candidates.Add(c);
        return new ProfilePageRead(Str(obj, "text") ?? "", Str(obj, "title") ?? "",
            candidates, Str(obj, "telValue") ?? "", Str(obj, "html") ?? "");
    }

    // Tích lũy quét hồ sơ trong một lần FetchProfileDetailed: giá trị
    // chấp nhận + nguồn chi tiết (bước:trường, cho dòng profile_detail)
    // + nguồn tên bước (cho JSON debug, không giá trị) + rác bị loại
    // đầu tiên mỗi trường (để chẩn đoán rác cũ từng từ đâu tới).
    private sealed class ProfileScan
    {
        public string? Email;
        public string? Username;
        public string? Phone;
        // v0.8.5: id người dùng Muse (UUID từ API phiên) + nguồn chi tiết.
        public string? MuseUserId;
        public string? MuseUserIdDetail;
        public string? EmailSource;
        public string? UsernameSource;
        public string? EmailDetail;
        public string? UsernameDetail;
        public string? PhoneDetail;
        public string? EmailRejectedSource;
        public string? EmailRejectedValue;
        public string? UsernameRejectedSource;
        public string? UsernameRejectedValue;
        public int CandidateCount;
    }

    // Gộp kết quả một lần đọc trang vào scan tích lũy.
    // Thứ tự email: candidates -> tiêu đề -> outerHTML (đã lược giá trị
    // src/href để tên file ảnh không thành ứng viên) -> text. Giá trị
    // chấp nhận ghi nguồn chi tiết bước:trường; rác email-like chỉ ghi
    // lại rác đầu tiên (nguồn kèm ":rejected") để chẩn đoán.
    private static void MergeProfilePage(ProfilePageRead read, string step, ProfileScan scan)
    {
        foreach (var c in read.Candidates)
        {
            var found = ProfileValidation.FindEmail(c);
            if (found is not null)
            {
                if (scan.Email is null)
                    { scan.Email = found; scan.EmailDetail ??= step + ":candidate"; scan.EmailSource ??= step; }
                break;
            }
            NoteRejectedEmail(c, step, "candidate", scan);
        }
        if (scan.Email is null)
        {
            var f = ProfileValidation.FindEmail(read.Title);
            if (f is not null) { scan.Email = f; scan.EmailDetail ??= step + ":title"; scan.EmailSource ??= step; }
            else NoteRejectedEmail(read.Title, step, "title", scan);
        }
        if (scan.Email is null)
        {
            var stripped = ProfileValidation.StripUrlAttributes(read.Html);
            var f = ProfileValidation.FindEmail(stripped);
            if (f is not null) { scan.Email = f; scan.EmailDetail ??= step + ":outerHTML"; scan.EmailSource ??= step; }
            else NoteRejectedEmail(stripped, step, "outerHTML", scan);
        }
        if (scan.Email is null)
        {
            var f = ProfileValidation.FindEmail(read.Text);
            if (f is not null) { scan.Email = f; scan.EmailDetail ??= step + ":text"; scan.EmailSource ??= step; }
            else NoteRejectedEmail(read.Text, step, "text", scan);
        }
        foreach (var c in read.Candidates)
        {
            var cleaned = CleanProfileCandidate(c);
            if (cleaned is not null)
            {
                if (scan.Username is null)
                    { scan.Username = cleaned; scan.UsernameDetail ??= step + ":candidate"; scan.UsernameSource ??= step; }
                break;
            }
            var trimmed = TrimCandidate(c);
            if (scan.Username is null && scan.UsernameRejectedValue is null
                && ProfileValidation.IsTechnicalId(trimmed))
                { scan.UsernameRejectedSource = step + ":candidate:rejected"; scan.UsernameRejectedValue = trimmed; }
        }
        if (scan.Username is null)
        {
            foreach (var sep in new[] { " — ", " - ", " | ", " · " })
            {
                if (!read.Title.Contains(sep)) continue;
                var first = read.Title.Split(sep)[0].Trim();
                if (first.Length >= 3 && first.Length <= 60
                    && !new[] { "muse", "home", "trang chủ", "chat" }.Contains(first.ToLowerInvariant()))
                {
                    if (ProfileValidation.IsValidUsername(first))
                        { scan.Username = first; scan.UsernameDetail ??= step + ":title"; scan.UsernameSource ??= step; }
                    else if (scan.UsernameRejectedValue is null && ProfileValidation.IsTechnicalId(first))
                        { scan.UsernameRejectedSource = step + ":title:rejected"; scan.UsernameRejectedValue = first; }
                    break;
                }
            }
        }
        if (scan.Phone is null && IsPhoneLike(read.TelValue))
            { scan.Phone = read.TelValue.Trim(); scan.PhoneDetail ??= step + ":tel_input"; }
        if (scan.Phone is null)
        {
            foreach (var line in read.Text.Split('\n'))
            {
                var m = System.Text.RegularExpressions.Regex.Match(line,
                    @"^\s*(Phone|Số điện thoại|Điện thoại)\s*[:：]\s*(.+?)\s*$",
                    System.Text.RegularExpressions.RegexOptions.IgnoreCase);
                if (m.Success && IsPhoneLike(m.Groups[2].Value))
                    { scan.Phone = m.Groups[2].Value.Trim(); scan.PhoneDetail ??= step + ":labeled_line"; break; }
            }
        }
        scan.CandidateCount += read.Candidates.Count;
    }

    private static void NoteRejectedEmail(string text, string step, string field, ProfileScan scan)
    {
        if (scan.Email is not null || scan.EmailRejectedValue is not null) return;
        var like = ProfileValidation.FirstEmailLike(text);
        if (like is not null && !ProfileValidation.IsValidEmail(like))
        {
            scan.EmailRejectedSource = step + ":" + field + ":rejected";
            scan.EmailRejectedValue = like;
        }
    }

    private static bool IsPhoneLike(string value)
        => ProfileValidation.IsPhoneLike(value);

    private static string TrimCandidate(string raw)
    {
        var t = raw.Trim();
        foreach (var prefix in new[] { "Open ", "Mở ", "Show ", "Hiện " })
            if (t.StartsWith(prefix, StringComparison.OrdinalIgnoreCase)) t = t[prefix.Length..].Trim();
        foreach (var suffix in new[] { " menu", " Menu" })
            if (t.EndsWith(suffix, StringComparison.OrdinalIgnoreCase)) t = t[..^suffix.Length].Trim();
        return t;
    }

    private static string? CleanProfileCandidate(string raw)
    {
        var t = TrimCandidate(raw);
        if (t.Length < 3 || t.Length > 80) return null;
        if (t.Contains('@')) return null; // đó là email, không phải username
        // v0.8.3: chặn id kỹ thuật lọt thành username (UUID, hex dài,
        // tên file, URL) — kiểm tra chung trong ProfileValidation.
        if (!ProfileValidation.IsValidUsername(t)) return null;
        var lower = t.ToLowerInvariant();
        if (new[] { "profile", "account", "settings", "menu", "user", "avatar",
            "hồ sơ", "tài khoản", "cài đặt", "đăng xuất", "log out", "sign out",
            "log in", "sign in", "đăng nhập" }.Contains(lower)) return null;
        if (lower.StartsWith("open ") || lower.StartsWith("mở ")) return null;
        return t;
    }

    // ---------- session / quota ----------
    public async Task<SessionInfo> RenewSession(Account account)
    {
        var info = await Upstream.RenewSession(account.Cookies, _settings.WakeConfirmSeconds);
        await InvalidateAccount(account.Id);
        return info;
    }

    public async Task InvalidateAccount(string accountId)
    {
        List<BrowserTab> tabs;
        lock (_lock) { tabs = _tabs.GetValueOrDefault(accountId, new()).ToList(); _resetContexts.Add(accountId); }
        foreach (var t in tabs) t.Stale = true;
        foreach (var t in tabs.Where(t => !t.Busy)) await CloseTab(t);
        if (tabs.Count == 0)
        {
            IBrowserContext? context;
            lock (_lock) { _contexts.Remove(accountId, out context); _resetContexts.Remove(accountId); _contextAuthHashes.Remove(accountId); }
            if (context is not null) try { await context.CloseAsync(); } catch { }
        }
        _quotaCache.TryRemove(accountId, out _);
    }

    private async Task SaveSession(Account account, IBrowserContext context)
    {
        try
        {
            var cookies = await context.CookiesAsync(new[] { Upstream.Site }).WaitAsync(TimeSpan.FromSeconds(10));
            if (Upstream.SessionCookies.Any(name => !cookies.Any(c => c.Name == name && c.Value.Length > 0))) return;
            lock (_lock)
                if (_contextAuthHashes.GetValueOrDefault(account.Id) != BrowserSessionStore.AuthenticationHash(account)) return;
            var savedCookies = new Dictionary<string, string>(account.Cookies);
            var savedExpires = new Dictionary<string, long>(account.CookieExpires);
            foreach (var cookie in cookies.Where(c => Upstream.SessionCookies.Contains(c.Name) || Upstream.OptionalSessionCookies.Contains(c.Name)))
            {
                savedCookies[cookie.Name] = cookie.Value;
                if (cookie.Expires > 0) savedExpires[cookie.Name] = (long)cookie.Expires;
                else savedExpires.Remove(cookie.Name);
            }
            account.Cookies = savedCookies; account.CookieExpires = savedExpires;
            lock (_lock) _contextAuthHashes[account.Id] = BrowserSessionStore.AuthenticationHash(account);
            await _sessions.SaveAsync(account, await context.StorageStateAsync().WaitAsync(TimeSpan.FromSeconds(10)));
        }
        catch (Exception) { Diagnostic?.Invoke("session_save_failed"); }
    }

    public async Task<Dictionary<string, object?>> Quota(Account account)
    {
        if (_quotaCache.TryGetValue(account.Id, out var hit)
            && DateTimeOffset.UtcNow.ToUnixTimeSeconds() - Convert.ToDouble(hit["fetched_at"] ?? 0) < _settings.QuotaCacheSeconds)
            return new Dictionary<string, object?>(hit);
        var sem = _quotaLocks.GetOrAdd(account.Id, _ => new SemaphoreSlim(1, 1));
        await sem.WaitAsync();
        try
        {
            if (_quotaCache.TryGetValue(account.Id, out hit)
                && DateTimeOffset.UtcNow.ToUnixTimeSeconds() - Convert.ToDouble(hit["fetched_at"] ?? 0) < _settings.QuotaCacheSeconds)
                return new Dictionary<string, object?>(hit);
            var tab = await CheckoutIdle(account);
            Dictionary<string, object?> parsed;
            try { parsed = await ReadQuota(tab); }
            finally { Checkin(tab); }
            var snapshot = new Dictionary<string, object?>(parsed)
            {
                ["source"] = "browser",
                ["fetched_at"] = (double)DateTimeOffset.UtcNow.ToUnixTimeSeconds(),
            };
            _quotaCache[account.Id] = snapshot;
            return new Dictionary<string, object?>(snapshot);
        }
        finally { sem.Release(); }
    }

    private async Task<BrowserTab> CheckoutIdle(Account account)
    {
        lock (_lock)
        {
            var tabs = _tabs.GetValueOrDefault(account.Id, new()).Where(t => !t.Closed).ToList();
            var idle = tabs.Where(t => !t.Busy && !t.Stale).ToList();
            if (idle.Count > 0)
            {
                var tab = idle.FirstOrDefault(t => !t.HasState) ?? idle[0];
                tab.Busy = true;
                return tab;
            }
            if (tabs.Any(t => t.Busy) || _opening.GetValueOrDefault(account.Id) > 0)
                throw new MuseException($"account '{account.Id}' is serving a request; try the quota again when it is idle",
                    409, "server_error", "account_busy");
        }
        return await Checkout(account, t => !t.HasState);
    }

    private async Task<bool> ClickJs(BrowserTab tab, string expr)
    {
        var deadline = DateTime.UtcNow.AddSeconds(QuotaClickTimeout);
        while (true)
        {
            var pt = await Eval(tab.Page, expr);
            if (pt is System.Text.Json.Nodes.JsonObject o
                && o["x"] is System.Text.Json.Nodes.JsonValue xv && xv.TryGetValue<int>(out var x)
                && o["y"] is System.Text.Json.Nodes.JsonValue yv && yv.TryGetValue<int>(out var y))
            {
                await tab.Page.Mouse.ClickAsync(x, y);
                return true;
            }
            if (DateTime.UtcNow >= deadline) return false;
            await Task.Delay(150);
        }
    }

    private async Task Escape(BrowserTab tab)
    {
        for (var i = 0; i < 2; i++)
        {
            await tab.Page.Keyboard.PressAsync("Escape");
            await Task.Delay(TimeSpan.FromSeconds(EscapePause));
        }
    }

    private async Task<Dictionary<string, object?>> ReadQuota(BrowserTab tab)
    {
        var page = await PageState(tab.Page);
        if (!BoolNode(page, "hasInput")) await NewThread(tab);
        await Escape(tab);
        try
        {
            if (!await ClickJs(tab, Dom.QuotaSettingsEntry))
                return new Dictionary<string, object?>(Dom.ParseUsageText(""))
                { ["error"] = "settings entry not found" };
            if (!await ClickJs(tab, Dom.QuotaMenuItem))
                return new Dictionary<string, object?>(Dom.ParseUsageText(""))
                { ["error"] = "settings menu item not found" };
            var deadline = DateTime.UtcNow.AddSeconds(QuotaReadTimeout);
            while (true)
            {
                var dialog = await Eval(tab.Page, Dom.QuotaDialogText);
                var parsed = Dom.ParseUsageText(
                    dialog is System.Text.Json.Nodes.JsonValue dv && dv.TryGetValue<string>(out var s) ? s : "");
                if (parsed["found"] is true || DateTime.UtcNow >= deadline) return parsed;
                await Task.Delay(200);
            }
        }
        finally
        {
            try
            {
                await Escape(tab);
                var dialog = await Eval(tab.Page, Dom.QuotaDialogText);
                if (dialog is System.Text.Json.Nodes.JsonValue dv
                    && dv.TryGetValue<string>(out var s) && s.Length > 0)
                    tab.Stale = true;
            }
            catch { tab.Stale = true; }
        }
    }
}
