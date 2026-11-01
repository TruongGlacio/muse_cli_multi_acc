using Microsoft.Playwright;
using System.Text.Json.Nodes;

namespace Muse2Api;

/// <summary>
/// Đăng nhập qua trình duyệt của chính gateway (v0.5.0).
///
/// Vì sao không thể chỉ mở muse.ai trong trình duyệt ngoài của user:
/// BrowserDriver dùng Playwright Chromium với context riêng cho từng tài
/// khoản, cookie được nạp từ account store (SetCookies), không đọc
/// profile trình duyệt hệ thống — đăng nhập ngoài không truyền session
/// sang gateway được. Vì vậy gateway tự mở một cửa sổ Chromium có đầu
/// (headed) của chính nó, user đăng nhập trong cửa sổ đó, gateway đọc
/// cookie từ context đó rồi lưu.
///
/// An toàn và giới hạn:
/// - Playwright instance RIÊNG, Headless=false, không dùng chung browser
///   instance của chat driver (chat đang chạy headless, windowsHide=true)
///   nên việc đăng nhập không làm gián đoạn chat đang chạy.
/// - Chỉ một phiên đăng nhập đang chờ tại một thời điểm; start khi đã
///   có phiên chờ sẽ lỗi rõ kèm id phiên đó để extension tiếp tục poll.
/// - Cookie bắt buộc: hatch_sess, hatch_native_auth_device; tùy chọn:
///   hatch_gw, hatch_vml (cùng danh sách với LoginForm của app desktop
///   và Upstream.SessionCookies). Chỉ khi đủ cookie bắt buộc mới lưu.
/// - Lưu bằng Pool.UpsertSession: cùng danh tính Muse thì cập nhật tài
///   khoản cũ (giữ nguyên Id), khác danh tính thì tạo tài khoản mới với
///   Id mới — tài khoản cũ không bị xóa, session cũ không tự nối sang.
/// - User đóng cửa sổ tay => cancelled. Hết 10 phút chưa đăng nhập =>
///   đóng trình duyệt, expired. Lỗi chưa cài Chromium báo rõ và hướng
///   dẫn dùng nút cài Chromium trong panel Cài đặt.
/// </summary>
public sealed class BrowserLoginSession
{
    public string Id { get; init; } = "login_" + Guid.NewGuid().ToString("N")[..12];
    public string Label { get; init; } = "Tài khoản cá nhân";
    public string? AccountId { get; init; }
    public string Status { get; set; } = "waiting";
    public JsonObject? Account { get; set; }
    public DateTimeOffset CreatedAt { get; init; } = DateTimeOffset.UtcNow;
    internal IPlaywright? Playwright { get; set; }
    internal IBrowser? Browser { get; set; }
    internal IBrowserContext? Context { get; set; }
    internal IPage? Page { get; set; }
}

public sealed class BrowserLoginManager
{
    private static readonly TimeSpan Timeout = TimeSpan.FromMinutes(10);
    private readonly Settings _settings;
    private readonly AccountPool _pool;
    private readonly IMuseDriver? _driver;
    private readonly SemaphoreSlim _gate = new(1, 1);
    private BrowserLoginSession? _current;

    public BrowserLoginManager(Settings settings, AccountPool pool, IMuseDriver? driver = null)
    {
        _settings = settings;
        _pool = pool;
        _driver = driver;
    }

    public async Task<BrowserLoginSession> StartAsync(string? label, string? accountId)
    {
        await _gate.WaitAsync();
        try
        {
            if (_current is { Status: "waiting" } pending)
            {
                if (DateTimeOffset.UtcNow - pending.CreatedAt > Timeout)
                {
                    await CloseSessionAsync(pending);
                    pending.Status = "expired";
                    _current = null;
                }
                else
                {
                    throw new MuseException(
                        $"Đã có một phiên đăng nhập qua trình duyệt đang chờ (id: {pending.Id}). Hãy tiếp tục đăng nhập trong cửa sổ đã mở, hoặc hủy phiên đó rồi thử lại.",
                        409, "invalid_request_error", "login_already_pending");
                }
            }
            string resolvedLabel = string.IsNullOrWhiteSpace(label) ? "Tài khoản cá nhân" : label.Trim();
            Account? existing = null;
            if (!string.IsNullOrWhiteSpace(accountId))
            {
                existing = _pool.Get(accountId) ?? throw MuseException.NotFound($"account '{accountId}' not found");
                if (string.IsNullOrWhiteSpace(label)) resolvedLabel = existing.Label;
            }
            var session = new BrowserLoginSession { Label = resolvedLabel, AccountId = accountId };
            try
            {
                session.Playwright = await Playwright.CreateAsync();
                var launch = new BrowserTypeLaunchOptions
                {
                    Headless = false,
                    Args = new[] { "--no-first-run", "--no-default-browser-check", "--disable-dev-shm-usage", "--window-size=1200,800" },
                };
                if (!string.IsNullOrEmpty(_settings.ChromiumPath)) launch.ExecutablePath = _settings.ChromiumPath;
                if (!string.IsNullOrEmpty(_settings.BrowserProxy))
                    launch.Proxy = new Proxy { Server = _settings.BrowserProxy };
                try
                {
                    session.Browser = await session.Playwright.Chromium.LaunchAsync(launch);
                }
                catch (Exception ex)
                {
                    throw new MuseException(
                        "Không mở được trình duyệt Chromium của Playwright. Có thể máy chưa cài Chromium: trong VS Code, mở panel Cài đặt Muse rồi bấm \"Cài Chromium cho gateway\", hoặc chạy playwright.ps1 install chromium, hoặc đặt MUSE2API_CHROMIUM_PATH trỏ tới Edge/Chrome sẵn có. Lỗi gốc: " + ex.Message,
                        500, "server_error", "browser_not_installed");
                }
                session.Context = await session.Browser.NewContextAsync();
                session.Page = await session.Context.NewPageAsync();
                await session.Page.GotoAsync("https://muse.ai", new PageGotoOptions { WaitUntil = WaitUntilState.DOMContentLoaded, Timeout = 60000 });
            }
            catch
            {
                await CloseSessionAsync(session);
                throw;
            }
            _current = session;
            return session;
        }
        finally { _gate.Release(); }
    }

    // v0.8.5: lấy danh tính từ API phiên bằng cookie mới nhận, CHỈ để
    // gắn vào tài khoản trước khi upsert (xem CheckAsync). Không cần
    // context trình duyệt, không đọc trang, không log giá trị. Trả null
    // khi API từ chối (401/403) hoặc không đọc được JSON — caller giữ
    // hành vi cũ. Quy tắc map giống khối Walk của BrowserDriver:
    // email hợp lệ mới nhận; username hợp lệ mới nhận; khóa `name`
    // dạng UUID → MuseUserId, tên thật → username; phone nhận nguyên.
    private static async Task<(string? Email, string? Username, string? Phone, string? MuseUserId)?> FetchSessionIdentityAsync(
        Dictionary<string, string> cookies)
    {
        using var client = new HttpClient { Timeout = TimeSpan.FromSeconds(15) };
        client.DefaultRequestHeaders.Add("User-Agent", Upstream.UserAgent);
        client.DefaultRequestHeaders.Add("Accept", "application/json");
        using var req = new HttpRequestMessage(HttpMethod.Get, Upstream.SessionApi);
        req.Headers.Add("Cookie", Upstream.CookieHeader(cookies));
        req.Headers.Referrer = new Uri(Upstream.Site);
        using var resp = await client.SendAsync(req);
        if ((int)resp.StatusCode is 401 or 403) return null;
        if (!resp.IsSuccessStatusCode) return null;
        var text = await resp.Content.ReadAsStringAsync();
        System.Text.Json.Nodes.JsonNode? root;
        try { root = System.Text.Json.Nodes.JsonNode.Parse(text); } catch { return null; }
        string? email = null, username = null, phone = null, museUserId = null, nameFallback = null;
        void Walk(System.Text.Json.Nodes.JsonNode? node)
        {
            if (node is System.Text.Json.Nodes.JsonObject obj)
            {
                foreach (var (key, value) in obj)
                {
                    if (value is System.Text.Json.Nodes.JsonValue v
                        && v.TryGetValue<string>(out var s) && !string.IsNullOrWhiteSpace(s))
                    {
                        switch (key.ToLowerInvariant())
                        {
                            case "email":
                                if (email is null && ProfileValidation.IsValidEmail(s)) email = s.Trim();
                                break;
                            case "username":
                                if (ProfileValidation.IsUuid(s))
                                {
                                    if (museUserId is null) museUserId = s.Trim().ToLowerInvariant();
                                }
                                else if (username is null && ProfileValidation.IsValidUsername(s)) username = s.Trim();
                                break;
                            case "name":
                                if (ProfileValidation.IsUuid(s))
                                {
                                    if (museUserId is null) museUserId = s.Trim().ToLowerInvariant();
                                }
                                else if (nameFallback is null && ProfileValidation.IsValidUsername(s)) nameFallback = s.Trim();
                                break;
                            case "phone":
                                if (phone is null) phone = s.Trim();
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
        Walk(root);
        username ??= nameFallback;
        return (email, username, phone, museUserId);
    }

    public async Task<BrowserLoginSession> CheckAsync(string id)
    {
        await _gate.WaitAsync();
        try
        {
            var session = _current is not null && _current.Id == id ? _current : null;
            if (session is null) throw MuseException.NotFound($"login session '{id}' not found");
            if (session.Status != "waiting") return session;
            if (DateTimeOffset.UtcNow - session.CreatedAt > Timeout)
            {
                await CloseSessionAsync(session);
                session.Status = "expired";
                _current = null;
                return session;
            }
            // User đóng cửa sổ tay: browser ngắt kết nối hoặc page đã đóng.
            if (session.Browser is not { IsConnected: true } || session.Page is { IsClosed: true })
            {
                await CloseSessionAsync(session);
                session.Status = "cancelled";
                _current = null;
                return session;
            }
            var cookies = await session.Context!.CookiesAsync("https://muse.ai");
            var byName = cookies
                .Where(c => !string.IsNullOrEmpty(c.Value))
                .GroupBy(c => c.Name)
                .ToDictionary(g => g.Key, g => g.First());
            if (Upstream.SessionCookies.Any(name => !byName.ContainsKey(name)))
            {
                return session; // chưa đăng nhập xong, vẫn chờ
            }
            var dict = new Dictionary<string, string>();
            var expires = new Dictionary<string, long>();
            foreach (var name in Upstream.SessionCookies.Concat(new[] { "hatch_gw", "hatch_vml" }))
            {
                if (!byName.TryGetValue(name, out var c)) continue;
                dict[name] = c.Value;
                if (c.Expires > 0) expires[name] = (long)c.Expires;
            }
            var existing = session.AccountId is not null ? _pool.Get(session.AccountId) : null;
            var incoming = new Account
            {
                Label = session.Label,
                Enabled = existing?.Enabled ?? true,
                Cookies = dict,
                CookieExpires = expires,
            };
            // v0.8.5: biết danh tính TRƯỚC khi upsert. UpsertSession
            // khớp theo MuseUserId nên phải có id trước — nếu upsert
            // trước rồi mới fetch sau thì lần đăng nhập lại vẫn tạo tài
            // khoản mới rồi mới biết id (đúng lỗi trùng tài khoản gốc).
            // Chỉ gọi API phiên bằng cookie mới (HttpClient, không cần
            // context trình duyệt); thất bại thì giữ hành vi cũ (upsert
            // theo cookie, lần fetch sau sẽ điền id).
            try
            {
                var ident = await FetchSessionIdentityAsync(dict);
                if (ident is not null)
                {
                    if (!string.IsNullOrWhiteSpace(ident.Value.Email)) incoming.Email = ident.Value.Email;
                    if (!string.IsNullOrWhiteSpace(ident.Value.Username)) incoming.Username = ident.Value.Username;
                    if (!string.IsNullOrWhiteSpace(ident.Value.Phone)) incoming.Phone = ident.Value.Phone;
                    if (!string.IsNullOrWhiteSpace(ident.Value.MuseUserId)) incoming.MuseUserId = ident.Value.MuseUserId;
                }
            }
            catch { /* giữ hành vi cũ khi không gọi được API phiên */ }
            var saved = _pool.UpsertSession(incoming);
            // Gia hạn lại đúng tài khoản đã yêu cầu: cookie mới phải làm
            // tài khoản dùng được ngay, kể cả khi trước đó đang cooling.
            if (existing is not null && saved.Id == existing.Id)
            {
                saved.Status = AccountStatus.Active;
                saved.CooldownUntil = 0;
                saved.LastError = null;
                _pool.Upsert(saved);
            }
            // v0.7.0: sau khi lưu xong, thử lấy hồ sơ best-effort cho
            // tài khoản kết quả. Thất bại thì bỏ qua, KHÔNG chặn thông
            // báo thành công (user vẫn có thể bấm "Cập nhật thông tin
            // hồ sơ" trong panel Cài đặt sau). Không log email/phone.
            if (_driver is not null)
            {
                try
                {
                    var profile = await _driver.FetchProfile(saved);
                    if (profile is not null)
                    {
                        if (!string.IsNullOrWhiteSpace(profile.Email) && string.IsNullOrWhiteSpace(saved.Email))
                            saved.Email = profile.Email.Trim();
                        if (!string.IsNullOrWhiteSpace(profile.Username) && string.IsNullOrWhiteSpace(saved.Username))
                            saved.Username = profile.Username.Trim();
                        if (!string.IsNullOrWhiteSpace(profile.Phone) && string.IsNullOrWhiteSpace(saved.Phone))
                            saved.Phone = profile.Phone.Trim();
                        // v0.8.5: điền cả id người dùng Muse (UUID từ API
                        // phiên) — chỉ điền khi trống, như các trường khác.
                        if (!string.IsNullOrWhiteSpace(profile.MuseUserId) && string.IsNullOrWhiteSpace(saved.MuseUserId))
                            saved.MuseUserId = profile.MuseUserId.Trim().ToLowerInvariant();
                        _pool.Upsert(saved);
                    }
                }
                catch { /* best-effort: đăng nhập đã thành công thì vẫn báo thành công */ }
            }
            session.Account = saved.Public();
            session.Status = "authenticated";
            await CloseSessionAsync(session);
            _current = null;
            return session;
        }
        finally { _gate.Release(); }
    }

    public async Task<BrowserLoginSession> CancelAsync(string id)
    {
        await _gate.WaitAsync();
        try
        {
            var session = _current is not null && _current.Id == id ? _current : null;
            if (session is null) throw MuseException.NotFound($"login session '{id}' not found");
            if (session.Status == "waiting")
            {
                await CloseSessionAsync(session);
                session.Status = "cancelled";
                _current = null;
            }
            return session;
        }
        finally { _gate.Release(); }
    }

    private static async Task CloseSessionAsync(BrowserLoginSession session)
    {
        try { if (session.Context is not null) await session.Context.CloseAsync(); } catch { /* đóng trình duyệt không được thì bỏ qua */ }
        try { if (session.Browser is not null) await session.Browser.CloseAsync(); } catch { /* như trên */ }
        try { session.Playwright?.Dispose(); } catch { /* như trên */ }
        session.Context = null;
        session.Browser = null;
        session.Playwright = null;
        session.Page = null;
    }

    public static JsonObject View(BrowserLoginSession session) => new()
    {
        ["login_id"] = session.Id,
        ["status"] = session.Status,
        ["account"] = session.Account?.DeepClone(),
    };
}
