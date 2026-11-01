using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Muse2Api;

public enum AccountStatus { Active, Cooling, Invalid }

public sealed class Account
{
    public string Id { get; set; } = "acc_" + Guid.NewGuid().ToString("N")[..10];
    public string Label { get; set; } = "";
    // Hồ sơ Muse (v0.7.0, nullable): file accounts.json cũ load lên sẽ
    // có null, tương thích ngược. Chỉ điền bằng FetchProfile best-effort
    // (trang chủ muse.ai), không bao giờ suy ra từ nội dung chat.
    public string? Email { get; set; }
    public string? Username { get; set; }
    public string? Phone { get; set; }
    // Khóa định danh nội bộ của người dùng Muse (v0.8.5): giá trị khóa
    // `name` dạng UUID của API phiên, ổn định qua các lần đăng nhập
    // của cùng một người và khác nhau giữa hai tài khoản. TÁCH RIÊNG
    // khỏi Username hiển thị: UUID nhìn như rác khi hiện tên, nhưng
    // là khóa chống trùng tốt nhất (email có thể không có, cookie xoay
    // vòng). Chỉ session API mới được ghi vào đây, username từ trang
    // web không bao giờ ghi vào. Hiện trong panel Cài đặt ở dòng
    // "ID Muse" để user đối chiếu, không đưa vào popup.
    public string? MuseUserId { get; set; }
    public bool Enabled { get; set; } = true;
    public AccountStatus Status { get; set; } = AccountStatus.Active;
    public Dictionary<string, string> Cookies { get; set; } = new();
    public Dictionary<string, long> CookieExpires { get; set; } = new();
    public double CreatedAt { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    public double LastUsedAt { get; set; }
    public double CooldownUntil { get; set; }
    public string? LastError { get; set; }
    public int SuccessCount { get; set; }
    public int FailCount { get; set; }
    public Dictionary<string, JsonNode?> Meta { get; set; } = new();

    public bool IsAvailable(double now)
    {
        if (!Enabled || Status == AccountStatus.Invalid) return false;
        if (Status == AccountStatus.Cooling) return now >= CooldownUntil;
        return true;
    }

    public JsonObject Public()
    {
        var masked = new JsonObject();
        foreach (var (k, v) in Cookies)
            masked[k] = v.Length <= 8 ? "***" : $"{v[..4]}...{v[^4..]}";
        var expires = new JsonObject();
        foreach (var (k, v) in CookieExpires) expires[k] = v;
        var meta = new JsonObject();
        foreach (var (k, v) in Meta) meta[k] = v?.DeepClone();
        return new JsonObject
        {
            ["id"] = Id,
            ["label"] = Label,
            ["email"] = Email is null ? null : JsonValue.Create(Email),
            ["username"] = Username is null ? null : JsonValue.Create(Username),
            ["phone"] = Phone is null ? null : JsonValue.Create(Phone),
            ["muse_user_id"] = MuseUserId is null ? null : JsonValue.Create(MuseUserId),
            ["enabled"] = Enabled,
            ["status"] = Status.ToString().ToLowerInvariant(),
            ["cookies"] = masked,
            ["cookie_expires"] = expires,
            ["created_at"] = CreatedAt,
            ["last_used_at"] = LastUsedAt,
            ["cooldown_until"] = CooldownUntil,
            ["last_error"] = LastError is null ? null : JsonValue.Create(LastError),
            ["success_count"] = SuccessCount,
            ["fail_count"] = FailCount,
            ["meta"] = meta,
        };
    }
}

public sealed class Lease : IDisposable
{
    public Account Account { get; }
    public Exception? Error { get; set; }
    private readonly AccountPool _pool;
    private bool _released;
    public Lease(AccountPool pool, Account account) { _pool = pool; Account = account; }
    public void Fail(Exception ex) => Error = ex;
    public void Dispose()
    {
        if (_released) return;
        _released = true;
        _pool.Release(Account, Error);
    }
}

/// <summary>Account pool: scheduling, concurrency limits, cooldown and failover
/// state, including cancellable waiting for busy accounts.</summary>
public sealed class AccountPool
{
    private readonly string _file;
    private readonly Dictionary<string, Account> _accounts = new();
    private readonly Dictionary<string, int> _inflight = new();
    private readonly Dictionary<string, string> _affinity = new();
    private long _roundRobin;
    private readonly object _lock = new();

    public string Strategy { get; }
    public int MaxConcurrency { get; }
    public double Cooldown { get; }
    public double AcquireTimeout { get; }

    public AccountPool(string file, string strategy = "affinity",
        int maxConcurrency = 1, double cooldown = 120, double acquireTimeout = 60)
    {
        _file = file; Strategy = strategy; MaxConcurrency = Math.Max(1, maxConcurrency);
        Cooldown = cooldown; AcquireTimeout = acquireTimeout;
    }

    public void Load()
    {
        if (!File.Exists(_file)) return;
        try
        {
            var list = JsonSerializer.Deserialize<List<Account>>(PrivateDataProtection.ReadFile(_file)) ?? new();
            lock (_lock) { foreach (var a in list) _accounts[a.Id] = a; }
            PrivateDataProtection.MigrateLegacyFile(_file);
        }
        catch (Exception ex) { throw new InvalidOperationException($"Cannot load account store '{_file}'; existing data was preserved.", ex); }
    }

    public void Persist()
    {
        lock (_lock)
        {
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(_file)) ?? ".");
            PrivateDataProtection.WriteFile(_file, JsonSerializer.Serialize(_accounts.Values.ToList(),
                new JsonSerializerOptions { WriteIndented = true }));
        }
    }

    public List<Account> All() { lock (_lock) return _accounts.Values.ToList(); }
    public Account? Get(string id) { lock (_lock) return _accounts.GetValueOrDefault(id); }

    public Account Upsert(Account acc)
    {
        lock (_lock) _accounts[acc.Id] = acc;
        Persist();
        return acc;
    }

    // Chuẩn hóa email để so khớp danh tính: trim + lowercase. Giá trị
    // không hợp lệ (v0.8.3: tên file ảnh như calendar@2x.png, chuỗi
    // rác) coi như không có email — để gộp trùng và khớp phiên không
    // bao giờ nhóm tài khoản theo rác.
    public static string? NormalizeEmail(string? email)
    {
        if (string.IsNullOrWhiteSpace(email)) return null;
        var v = email.Trim();
        return ProfileValidation.IsValidEmail(v) ? v.ToLowerInvariant() : null;
    }

    // Chuẩn hóa username để so khớp: trim. Giá trị không hợp lệ
    // (v0.8.3: UUID, hex dài, tên file, URL) coi như không có username.
    public static string? NormalizeUsername(string? username)
    {
        if (string.IsNullOrWhiteSpace(username)) return null;
        var v = username.Trim();
        return ProfileValidation.IsValidUsername(v) ? v : null;
    }

    // Chuẩn hóa id người dùng Muse để so khớp (v0.8.5): trim +
    // lowercase, CHỈ chấp nhận chuỗi dạng UUID. Giá trị khác dạng
    // UUID (tên người, hex thuần, chuỗi rác) coi như không có id.
    public static string? NormalizeMuseUserId(string? id)
    {
        if (string.IsNullOrWhiteSpace(id)) return null;
        var v = id.Trim();
        return ProfileValidation.IsUuid(v) ? v.ToLowerInvariant() : null;
    }

    // Khóa nhóm danh tính cho merge-duplicates (v0.8.5), theo thứ tự
    // ưu tiên: id người dùng Muse → email → username. Trả null khi
    // tài khoản không có danh tính nào dùng được (bỏ qua khi nhóm).
    public static string? IdentityGroupKey(Account acc)
    {
        var id = NormalizeMuseUserId(acc.MuseUserId);
        if (id is not null) return "museid:" + id;
        var email = NormalizeEmail(acc.Email);
        if (email is not null) return "email:" + email;
        var username = NormalizeUsername(acc.Username);
        if (username is not null) return "username:" + username.ToLowerInvariant();
        return null;
    }

    // Điền danh tính từ tài khoản vào vào tài khoản cũ, CHỈ khi trường
    // cũ còn trống — không ghi đè email/username/phone đã có.
    private static void FillMissingIdentity(Account existing, Account incoming)
    {
        if (string.IsNullOrWhiteSpace(existing.Email) && !string.IsNullOrWhiteSpace(incoming.Email))
            existing.Email = incoming.Email;
        if (string.IsNullOrWhiteSpace(existing.Username) && !string.IsNullOrWhiteSpace(incoming.Username))
            existing.Username = incoming.Username;
        if (string.IsNullOrWhiteSpace(existing.Phone) && !string.IsNullOrWhiteSpace(incoming.Phone))
            existing.Phone = incoming.Phone;
        if (string.IsNullOrWhiteSpace(existing.MuseUserId) && !string.IsNullOrWhiteSpace(incoming.MuseUserId))
            existing.MuseUserId = incoming.MuseUserId;
    }

    public Account UpsertSession(Account incoming)
    {
        lock (_lock)
        {
            // Bước 1 (giữ nguyên hành vi cũ): khớp theo auth-hash của
            // cookie phiên. Cookie xoay vòng nên bước này không đủ một
            // mình — xem bước 2/3 dưới đây.
            var existing = Upstream.MissingSessionCookies(incoming.Cookies).Count == 0
                ? _accounts.Values.FirstOrDefault(a => BrowserSessionStore.AuthenticationHash(a) == BrowserSessionStore.AuthenticationHash(incoming)) : null;
            if (existing is not null)
            {
                existing.Cookies = incoming.Cookies; existing.CookieExpires = incoming.CookieExpires;
                existing.Label = incoming.Label; existing.Enabled = incoming.Enabled;
                if (existing.Status == AccountStatus.Invalid) { existing.Status = AccountStatus.Active; existing.LastError = null; }
                FillMissingIdentity(existing, incoming);
                Persist(); return existing;
            }
            // Bước 2 (v0.8.5): khớp theo id người dùng Muse (UUID từ khóa
            // `name` của API phiên). Đây là khóa ổn định nhất: cùng một
            // người đăng nhập lại sẽ có auth-hash khác (cookie xoay
            // vòng) và có thể không có email, nhưng id này không đổi.
            // Đặt trước khớp email vì id chính xác hơn email (email có
            // thể đổi, id thì không). Ngữ nghĩa cập nhật như bước 1:
            // giữ nguyên Id và label cũ.
            var incomingId = NormalizeMuseUserId(incoming.MuseUserId);
            if (incomingId is not null)
            {
                existing = _accounts.Values.FirstOrDefault(a => NormalizeMuseUserId(a.MuseUserId) == incomingId);
                if (existing is not null)
                {
                    existing.Cookies = incoming.Cookies; existing.CookieExpires = incoming.CookieExpires;
                    existing.Enabled = incoming.Enabled;
                    if (existing.Status == AccountStatus.Invalid) { existing.Status = AccountStatus.Active; existing.LastError = null; }
                    FillMissingIdentity(existing, incoming);
                    Persist(); return existing;
                }
            }
            // Bước 3 (v0.7.0): khớp theo Email đã chuẩn hóa. Đây là khóa
            // chính chống trùng: cùng một tài khoản Muse đăng nhập lại
            // (trình duyệt khác, desktop khác, gia hạn khác) sẽ có
            // auth-hash khác nhưng cùng email → cập nhật tài khoản cũ,
            // GIỮ NGUYÊN Id và GIỮ NGUYÊN label cũ (không ghi đè tên do
            // user tự đổi).
            var incomingEmail = NormalizeEmail(incoming.Email);
            if (incomingEmail is not null)
            {
                existing = _accounts.Values.FirstOrDefault(a => NormalizeEmail(a.Email) == incomingEmail);
                if (existing is not null)
                {
                    existing.Cookies = incoming.Cookies; existing.CookieExpires = incoming.CookieExpires;
                    existing.Enabled = incoming.Enabled;
                    if (existing.Status == AccountStatus.Invalid) { existing.Status = AccountStatus.Active; existing.LastError = null; }
                    FillMissingIdentity(existing, incoming);
                    Persist(); return existing;
                }
            }
            // Bước 4 (v0.7.0, yếu hơn): chỉ khi cả hai bên đều không có
            // Email và Username đều khác rỗng, dài từ 3 ký tự, mới khớp
            // theo Username (không phân biệt hoa/thường). Khớp Username
            // yếu hơn Email vì tên hiển thị có thể trùng giữa hai người.
            var incomingUsername = NormalizeUsername(incoming.Username);
            if (incomingEmail is null && incomingUsername is not null && incomingUsername.Length >= 3)
            {
                existing = _accounts.Values.FirstOrDefault(a =>
                    NormalizeEmail(a.Email) is null
                    && NormalizeUsername(a.Username) is { Length: >= 3 } oldName
                    && string.Equals(oldName, incomingUsername, StringComparison.OrdinalIgnoreCase));
                if (existing is not null)
                {
                    existing.Cookies = incoming.Cookies; existing.CookieExpires = incoming.CookieExpires;
                    existing.Enabled = incoming.Enabled;
                    if (existing.Status == AccountStatus.Invalid) { existing.Status = AccountStatus.Active; existing.LastError = null; }
                    FillMissingIdentity(existing, incoming);
                    Persist(); return existing;
                }
            }
            return Upsert(incoming);
        }
    }

    public bool Remove(string id)
    {
        bool removed;
        lock (_lock) removed = _accounts.Remove(id);
        if (removed) Persist();
        return removed;
    }

    public Dictionary<string, int> Stats()
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        lock (_lock) return new Dictionary<string, int>
        {
            ["total"] = _accounts.Count,
            ["available"] = _accounts.Values.Count(a => a.IsAvailable(now)),
            ["invalid"] = _accounts.Values.Count(a => a.Status == AccountStatus.Invalid),
            ["inflight"] = _inflight.Values.Sum(),
        };
    }

    private List<Account> Candidates(IReadOnlySet<string> exclude, string? kind)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        return _accounts.Values.Where(a =>
            !exclude.Contains(a.Id) && a.Enabled && a.Status != AccountStatus.Invalid
            && a.IsAvailable(now) && !KindBlocked(a, kind, now)
            && _inflight.GetValueOrDefault(a.Id) < MaxConcurrency).ToList();
    }

    private static bool KindBlocked(Account account, string? kind, double now)
        => kind is not null && account.Meta.GetValueOrDefault("kind_blocked_until") is JsonObject blocks
            && blocks[kind] is JsonValue value
            && (value.TryGetValue<double>(out var until) ? until > now : value.TryGetValue<long>(out var seconds) && seconds > now);

    public async Task<Lease> AcquireAsync(IEnumerable<string> exclude, string? hint,
        string? kind = null, CancellationToken cancel = default)
    {
        var excluded = exclude.ToHashSet();
        var timer = System.Diagnostics.Stopwatch.StartNew();
        while (true)
        {
            cancel.ThrowIfCancellationRequested();
            lock (_lock)
            {
                if (Candidates(excluded, kind).Count > 0) return Acquire(excluded, hint, kind);
                if (!_accounts.Values.Any(a => !excluded.Contains(a.Id) && a.Enabled && a.Status != AccountStatus.Invalid))
                    throw MuseException.NoAccount();
            }
            var remaining = AcquireTimeout - timer.Elapsed.TotalSeconds;
            if (remaining <= 0) throw MuseException.NoAccount("timed out waiting for an available account");
            await Task.Delay(TimeSpan.FromSeconds(Math.Min(0.05, remaining)), cancel);
        }
    }

    // v0.8.2: lấy lease cho ĐÚNG một tài khoản đã chọn (chat của
    // session có accountId). KHÔNG BAO GIỜ tự chọn tài khoản khác:
    // tài khoản không còn trong pool, đang tắt, Invalid hoặc đang
    // cooling (chưa hết cooldown) thì lỗi ngay với thông điệp nêu rõ
    // id tài khoản đó. Chỉ chờ khi tài khoản khả dụng nhưng đang bận
    // (inflight >= MaxConcurrency), hết AcquireTimeout thì lỗi nêu rõ
    // id thay vì chọn tài khoản khác. Affinity của hint cũng được ghim
    // về tài khoản này để các lần gọi không kèm account_id (nếu có)
    // vẫn không trôi sang tài khoản khác.
    public async Task<Lease> AcquirePinnedAsync(string accountId, string? hint, string? kind, CancellationToken cancel)
    {
        var timer = System.Diagnostics.Stopwatch.StartNew();
        while (true)
        {
            cancel.ThrowIfCancellationRequested();
            lock (_lock)
            {
                var acc = _accounts.GetValueOrDefault(accountId)
                    ?? throw MuseException.NotFound($"Tài khoản đã chọn '{accountId}' không còn trong pool, không tự chọn tài khoản khác.");
                var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                if (!acc.Enabled)
                    throw MuseException.NoAccount($"Tài khoản đã chọn '{accountId}' đang tắt, không tự chọn tài khoản khác.");
                if (acc.Status == AccountStatus.Invalid)
                    throw MuseException.NoAccount($"Tài khoản đã chọn '{accountId}' đã hết hạn (Invalid), không tự chọn tài khoản khác.");
                if (acc.Status == AccountStatus.Cooling && now < acc.CooldownUntil)
                    throw MuseException.NoAccount($"Tài khoản đã chọn '{accountId}' đang cooling, không tự chọn tài khoản khác.");
                if (KindBlocked(acc, kind, now))
                    throw MuseException.NoAccount($"Tài khoản đã chọn '{accountId}' đang bị chặn cho loại yêu cầu này, không tự chọn tài khoản khác.");
                if (_inflight.GetValueOrDefault(acc.Id) < MaxConcurrency)
                {
                    _inflight[acc.Id] = _inflight.GetValueOrDefault(acc.Id) + 1;
                    acc.LastUsedAt = now;
                    if (hint is not null) _affinity[hint] = acc.Id;
                    return new Lease(this, acc);
                }
            }
            var remaining = AcquireTimeout - timer.Elapsed.TotalSeconds;
            if (remaining <= 0)
                throw MuseException.NoAccount($"Tài khoản đã chọn '{accountId}' đang bận quá lâu, không tự chọn tài khoản khác.");
            await Task.Delay(TimeSpan.FromSeconds(Math.Min(0.05, remaining)), cancel);
        }
    }

    public bool HasAlternative(IEnumerable<string> exclude)
    {
        var excluded = exclude.ToHashSet();
        lock (_lock) return _accounts.Values.Any(a =>
            !excluded.Contains(a.Id) && a.Enabled && a.Status != AccountStatus.Invalid);
    }

    public Lease Acquire(IEnumerable<string> exclude, string? hint, string? kind = null)
    {
        lock (_lock)
        {
            var free = Candidates(exclude.ToHashSet(), kind);
            if (free.Count == 0) throw MuseException.NoAccount("no usable account in pool");
            Account chosen;
            if (Strategy == "round_robin")
                chosen = free.OrderBy(a => a.Id).ToList()[(int)((Interlocked.Increment(ref _roundRobin) - 1) % free.Count)];
            else if (Strategy == "lru")
                chosen = free.MinBy(a => a.LastUsedAt)!;
            else // affinity, default
            {
                if (hint is not null && _affinity.TryGetValue(hint, out var id)
                    && free.FirstOrDefault(a => a.Id == id) is { } pinned)
                    chosen = pinned;
                else
                {
                    chosen = free.MinBy(a => a.LastUsedAt)!;
                    if (hint is not null) _affinity[hint] = chosen.Id;
                }
            }
            _inflight[chosen.Id] = _inflight.GetValueOrDefault(chosen.Id) + 1;
            chosen.LastUsedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
            return new Lease(this, chosen);
        }
    }

    internal void Release(Account acc, Exception? error)
    {
        lock (_lock)
        {
            if (!_accounts.ContainsKey(acc.Id)) return;
            _inflight[acc.Id] = Math.Max(0, _inflight.GetValueOrDefault(acc.Id) - 1);
            if (error is null)
            {
                acc.SuccessCount++;
                acc.LastError = null;
                if (acc.Status == AccountStatus.Cooling) acc.Status = AccountStatus.Active;
            }
            else if (error is not OperationCanceledException)
            {
                acc.FailCount++;
                acc.LastError = error.Message[..Math.Min(500, error.Message.Length)];
                var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                if (error is UpstreamException { Code: "upstream_auth_failed" })
                    acc.Status = AccountStatus.Invalid;
                else if (error is UpstreamException { Code: "upstream_quota_exhausted" })
                {
                    acc.Status = AccountStatus.Cooling;
                    acc.CooldownUntil = now + Math.Max(Cooldown, 3600);
                }
                else if (error is UpstreamException { Retryable: true })
                {
                    acc.Status = AccountStatus.Cooling;
                    acc.CooldownUntil = now + Cooldown;
                }
            }
        }
        Persist();
    }

    public void NoteWake(Account acc, Dictionary<string, string?> meta)
    {
        // Python note_wake: an unconfirmed VM wake blocks video for 600s.
        if (meta.GetValueOrDefault("vm_wake_ok") is not { } ok) return;
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        if (ok == "false")
        {
            var blocks = new JsonObject { ["video"] = now + 600 };
            acc.Meta["kind_blocked_until"] = blocks;
        }
        else if (ok == "true")
        {
            acc.Meta.Remove("kind_blocked_until");
        }
    }
}

// ---------- API keys ----------
public sealed class ApiKey
{
    public string Id { get; set; } = "key_" + Guid.NewGuid().ToString("N")[..10];
    public string Name { get; set; } = "";
    public string Prefix { get; set; } = "";
    public string Hash { get; set; } = "";
    public double CreatedAt { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    public double LastUsedAt { get; set; }
    public bool Revoked { get; set; }
    public string Note { get; set; } = "";
    public JsonObject Public() => new()
    {
        ["id"] = Id,
        ["name"] = Name,
        ["prefix"] = Prefix,
        ["created_at"] = CreatedAt,
        ["last_used_at"] = LastUsedAt,
        ["revoked"] = Revoked,
        ["note"] = Note,
    };
}

public sealed class KeyStore
{
    private readonly string _file;
    private readonly Dictionary<string, ApiKey> _keys = new();
    private readonly object _lock = new();
    private bool _dirty;

    public KeyStore(string file) => _file = file;

    public void Load()
    {
        if (!File.Exists(_file)) return;
        try
        {
            var list = JsonSerializer.Deserialize<List<ApiKey>>(File.ReadAllText(_file)) ?? new();
            lock (_lock) { foreach (var k in list) _keys[k.Id] = k; }
        }
        catch (Exception ex) { throw new InvalidOperationException($"Cannot load key store '{_file}'; existing data was preserved.", ex); }
    }

    public List<ApiKey> All()
    {
        lock (_lock) return _keys.Values.OrderBy(k => k.CreatedAt).ToList();
    }
    public ApiKey? Get(string id) { lock (_lock) return _keys.GetValueOrDefault(id); }

    public ApiKey? Verify(string provided)
    {
        if (string.IsNullOrEmpty(provided)) return null;
        var digest = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(provided))).ToLowerInvariant();
        lock (_lock)
        {
            ApiKey? found = null;
            foreach (var key in _keys.Values)
                if (CryptographicOperations.FixedTimeEquals(
                        Encoding.UTF8.GetBytes(digest), Encoding.UTF8.GetBytes(key.Hash))
                    && !key.Revoked)
                    found = key;
            return found;
        }
    }

    public void Touch(ApiKey key)
    {
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        lock (_lock)
            if (now - key.LastUsedAt >= 1) { key.LastUsedAt = now; _dirty = true; }
    }

    public (ApiKey Key, string Plaintext) Create(string name, string note)
    {
        // Hex, not base64: base64 can lose characters when '+'/'/' are stripped,
        // which made [..24] throw on some random keys (found by the test runner).
        var plaintext = "m2a-" + Convert.ToHexString(
            System.Security.Cryptography.RandomNumberGenerator.GetBytes(24)).ToLowerInvariant();
        var key = new ApiKey
        {
            Name = name,
            Note = note,
            Prefix = plaintext[..8],
            Hash = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(plaintext))).ToLowerInvariant(),
        };
        lock (_lock) _keys[key.Id] = key;
        Save();
        return (key, plaintext);
    }

    public bool Remove(string id)
    {
        bool removed;
        lock (_lock) removed = _keys.Remove(id);
        if (removed) Save();
        return removed;
    }

    public void Save()
    {
        lock (_lock)
        {
            var dir = Path.GetDirectoryName(Path.GetFullPath(_file)) ?? ".";
            Directory.CreateDirectory(dir);
            var tmp = Path.Combine(dir, ".keys.tmp");
            File.WriteAllText(tmp, JsonSerializer.Serialize(All(),
                new JsonSerializerOptions { WriteIndented = true }));
            File.Move(tmp, _file, overwrite: true);
            _dirty = false;
        }
    }

    public void Flush() { lock (_lock) if (_dirty) Save(); }
}

// ---------- Request log (SQLite, ported from Python services/request_log.py) ----------
public sealed record RequestRecord(double Ts, string Method, string Path, string? Model,
    string? KeyId, string? KeyName, string? AccountId, int StatusCode, long LatencyMs,
    bool Stream, bool Poll, string? Error, string? ClientIp, string? TaskId);

/// <summary>One SQLite row per /v1/* request, like Python.
/// Same schema and indexes as Python (requests table, WAL, task_status/task_ms
/// added columns), so /admin/requests, /admin/stats and /admin/metrics
/// survive a gateway restart. One connection under a lock, like Python's
/// threading.Lock around a shared sqlite3 connection. A failed write is
/// logged and dropped, never surfaced to the client.</summary>
public sealed class RequestLog : IDisposable
{
    private readonly string _file;
    private readonly object _lock = new();
    private Microsoft.Data.Sqlite.SqliteConnection? _conn;

    public RequestLog(string file = ":memory:")
    {
        _file = file;
        Open();
    }

    private void Open()
    {
        lock (_lock)
        {
            if (_file != ":memory:")
                Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(_file)) ?? ".");
            _conn = new Microsoft.Data.Sqlite.SqliteConnection(
                new Microsoft.Data.Sqlite.SqliteConnectionStringBuilder { DataSource = _file, Pooling = false }.ToString());
            _conn.Open();
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = """
                PRAGMA journal_mode=WAL;
                PRAGMA synchronous=NORMAL;
                CREATE TABLE IF NOT EXISTS requests (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    ts REAL NOT NULL, method TEXT NOT NULL, path TEXT NOT NULL,
                    model TEXT, key_id TEXT, key_name TEXT, account_id TEXT,
                    status_code INTEGER NOT NULL, latency_ms INTEGER NOT NULL,
                    stream INTEGER NOT NULL DEFAULT 0, poll INTEGER NOT NULL DEFAULT 0,
                    error TEXT, client_ip TEXT, user_agent TEXT, task_id TEXT,
                    task_status TEXT, task_ms INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_requests_ts ON requests (ts);
                CREATE INDEX IF NOT EXISTS idx_requests_key ON requests (key_id, ts);
                CREATE INDEX IF NOT EXISTS idx_requests_account ON requests (account_id, ts);
                CREATE INDEX IF NOT EXISTS idx_requests_task ON requests (task_id);
                """;
            cmd.ExecuteNonQuery();
        }
    }

    public void Add(RequestRecord r)
    {
        lock (_lock)
        {
            if (_conn is null) return;
            try
            {
                using var cmd = _conn.CreateCommand();
                cmd.CommandText = """
                    INSERT INTO requests (ts, method, path, model, key_id, key_name,
                        account_id, status_code, latency_ms, stream, poll, error,
                        client_ip, task_id)
                    VALUES ($ts, $method, $path, $model, $keyId, $keyName, $accountId,
                        $status, $latency, $stream, $poll, $error, $clientIp, $taskId)
                    """;
                cmd.Parameters.AddWithValue("$ts", r.Ts);
                cmd.Parameters.AddWithValue("$method", r.Method);
                cmd.Parameters.AddWithValue("$path", r.Path);
                cmd.Parameters.AddWithValue("$model", (object?)r.Model ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$keyId", (object?)r.KeyId ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$keyName", (object?)r.KeyName ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$accountId", (object?)r.AccountId ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$status", r.StatusCode);
                cmd.Parameters.AddWithValue("$latency", r.LatencyMs);
                cmd.Parameters.AddWithValue("$stream", r.Stream ? 1 : 0);
                cmd.Parameters.AddWithValue("$poll", r.Poll ? 1 : 0);
                cmd.Parameters.AddWithValue("$error", (object?)r.Error ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$clientIp", (object?)r.ClientIp ?? DBNull.Value);
                cmd.Parameters.AddWithValue("$taskId", (object?)r.TaskId ?? DBNull.Value);
                cmd.ExecuteNonQuery();
            }
            catch (Exception ex) { Console.WriteLine($"failed to write request log row: {ex.Message}"); }
        }
    }

    private static RequestRecord Row(Microsoft.Data.Sqlite.SqliteDataReader rd)
    {
        string? S(string name) => rd.IsDBNull(rd.GetOrdinal(name)) ? null : rd.GetString(rd.GetOrdinal(name));
        return new RequestRecord(
            rd.GetDouble(rd.GetOrdinal("ts")), S("method") ?? "", S("path") ?? "",
            S("model"), S("key_id"), S("key_name"), S("account_id"),
            rd.GetInt32(rd.GetOrdinal("status_code")), rd.GetInt64(rd.GetOrdinal("latency_ms")),
            rd.GetInt32(rd.GetOrdinal("stream")) != 0, rd.GetInt32(rd.GetOrdinal("poll")) != 0,
            S("error"), S("client_ip"), S("task_id"));
    }

    public (List<RequestRecord> Rows, int Total) Query(string? keyId, string? accountId,
        string? status, string? path, double? since, bool hidePolls, int limit, int offset)
    {
        lock (_lock)
        {
            if (_conn is null) return (new List<RequestRecord>(), 0);
            var where = new List<string> { "1=1" };
            var args = new List<Microsoft.Data.Sqlite.SqliteParameter>();
            void AddParam(string name, object value)
            {
                args.Add(new Microsoft.Data.Sqlite.SqliteParameter(name, value));
            }
            if (keyId is not null) { where.Add("key_id = $keyId"); AddParam("$keyId", keyId); }
            if (accountId is not null) { where.Add("account_id = $accountId"); AddParam("$accountId", accountId); }
            if (status is "failed") where.Add("status_code >= 400");
            else if (status is not null && status.Length == 3 && status.EndsWith("xx", StringComparison.OrdinalIgnoreCase) && int.TryParse(status[..1], out var d))
            {
                where.Add("status_code >= $low AND status_code < $high");
                AddParam("$low", d * 100); AddParam("$high", d * 100 + 100);
            }
            else if (int.TryParse(status, out var code)) { where.Add("status_code = $code"); AddParam("$code", code); }
            if (path is not null)
            {
                where.Add("path LIKE $path ESCAPE '\\'");
                AddParam("$path", path.Replace("\\", "\\\\").Replace("%", "\\%").Replace("_", "\\_") + "%");
            }
            if (since is not null) { where.Add("ts >= $since"); AddParam("$since", since.Value); }
            if (hidePolls) where.Add("poll = 0");
            var cond = string.Join(" AND ", where);
            int total;
            using (var cmd = _conn.CreateCommand())
            {
                cmd.CommandText = $"SELECT COUNT(*) FROM requests WHERE {cond}";
                cmd.Parameters.AddRange(args.ToArray());
                total = Convert.ToInt32(cmd.ExecuteScalar());
            }
            var rows = new List<RequestRecord>();
            using (var cmd = _conn.CreateCommand())
            {
                cmd.CommandText = $"SELECT * FROM requests WHERE {cond} ORDER BY id DESC LIMIT $limit OFFSET $offset";
                cmd.Parameters.AddRange(args.ToArray());
                cmd.Parameters.AddWithValue("$limit", limit);
                cmd.Parameters.AddWithValue("$offset", offset);
                using var rd = cmd.ExecuteReader();
                while (rd.Read()) rows.Add(Row(rd));
            }
            return (rows, total);
        }
    }

    private List<RequestRecord> RowsSince(double start, bool excludePolls)
    {
        lock (_lock)
        {
            var rows = new List<RequestRecord>();
            if (_conn is null) return rows;
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = excludePolls
                ? "SELECT * FROM requests WHERE ts >= $start AND poll = 0"
                : "SELECT * FROM requests WHERE ts >= $start";
            cmd.Parameters.AddWithValue("$start", start);
            using var rd = cmd.ExecuteReader();
            while (rd.Read()) rows.Add(Row(rd));
            return rows;
        }
    }

    public Dictionary<string, object?> Stats(string window)
    {
        var (length, bucket) = window switch
        {
            "1h" => (3600.0, 60.0),
            "7d" => (7 * 86400.0, 3 * 3600.0),
            _ => (86400.0, 1800.0),
        };
        var now = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
        var start = Math.Floor((now - length) / bucket) * bucket + bucket;
        var nBuckets = (int)((now - start) / bucket) + 1;
        List<RequestRecord> rows;
        rows = RowsSince(start, excludePolls: true);
        var lat = rows.Select(r => (long)r.LatencyMs).OrderBy(x => x).ToList();
        long? Percentile(double q) => lat.Count == 0 ? null
            : lat[Math.Max(0, Math.Min(lat.Count - 1, (int)Math.Ceiling(q * lat.Count) - 1))];
        var series = Enumerable.Range(0, nBuckets).Select(i => new Dictionary<string, object?>
        {
            ["t"] = start + i * bucket,
            ["count"] = 0,
            ["errors"] = 0,
        }).ToList();
        foreach (var r in rows)
        {
            var idx = (int)((r.Ts - start) / bucket);
            if (idx >= 0 && idx < nBuckets)
            {
                series[idx]["count"] = (int)series[idx]["count"]! + 1;
                if (r.StatusCode >= 400) series[idx]["errors"] = (int)series[idx]["errors"]! + 1;
            }
        }
        return new Dictionary<string, object?>
        {
            ["window"] = window,
            ["since"] = start,
            ["bucket_seconds"] = bucket,
            ["total"] = rows.Count,
            ["errors"] = rows.Count(r => r.StatusCode >= 400),
            ["server_errors"] = rows.Count(r => r.StatusCode >= 500),
            ["error_rate"] = rows.Count == 0 ? 0.0 : (double)rows.Count(r => r.StatusCode >= 400) / rows.Count,
            ["latency_ms"] = new Dictionary<string, object?>
            { ["p50"] = Percentile(0.50), ["p95"] = Percentile(0.95) },
            ["by_key"] = By(rows, r => r.KeyId, r => r.KeyName),
            ["by_account"] = By(rows, r => r.AccountId, null),
            ["by_model"] = By(rows, r => r.Model, null),
            ["by_status"] = By(rows, r => r.StatusCode.ToString(), null),
            ["series"] = series,
        };
    }

    private static List<Dictionary<string, object?>> By(List<RequestRecord> rows,
        Func<RequestRecord, string?> key, Func<RequestRecord, string?>? name)
    {
        return rows.GroupBy(key).OrderByDescending(g => g.Count()).Take(50)
            .Select(g => new Dictionary<string, object?>
            {
                ["key_id"] = g.Key,
                ["key_name"] = name is null ? null : g.FirstOrDefault() is { } f ? name(f) : null,
                ["account_id"] = g.Key,
                ["model"] = g.Key,
                ["status_code"] = g.Key is null ? null : int.TryParse(g.Key, out var s) ? s : g.Key,
                ["count"] = g.Count(),
                ["errors"] = g.Count(r => r.StatusCode >= 400),
            }).ToList();
    }

    public List<Dictionary<string, object?>> KeyUsage()
    {
        var since = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - 86400;
        var rows = RowsSince(0, excludePolls: true)
            .Where(r => r.KeyId is not null).ToList();
        return rows.GroupBy(r => r.KeyId)
            .OrderByDescending(g => g.Count()).Select(g => new Dictionary<string, object?>
            {
                ["key_id"] = g.Key,
                ["key_name"] = g.OrderByDescending(r => r.Ts).First().KeyName,
                ["last_request_at"] = g.Max(r => r.Ts),
                ["total"] = g.Count(),
                ["requests_24h"] = g.Count(r => r.Ts >= since),
                ["errors_24h"] = g.Count(r => r.Ts >= since && r.StatusCode >= 400),
            }).ToList();
    }

    /// <summary>Delete rows older than retentionDays, like Python prune().
    /// Returns the number deleted.</summary>
    public int Prune(double retentionDays)
    {
        if (retentionDays <= 0) return 0;
        lock (_lock)
        {
            if (_conn is null) return 0;
            var cutoff = DateTimeOffset.UtcNow.ToUnixTimeSeconds() - retentionDays * 86400;
            using var cmd = _conn.CreateCommand();
            cmd.CommandText = "DELETE FROM requests WHERE ts < $cutoff";
            cmd.Parameters.AddWithValue("$cutoff", cutoff);
            return cmd.ExecuteNonQuery();
        }
    }

    public void Dispose()
    {
        lock (_lock)
        {
            _conn?.Dispose();
            _conn = null;
        }
    }
}

// ---------- Background tasks ----------
public sealed class BgTask
{
    public string Id { get; init; } = "task_" + Guid.NewGuid().ToString("N")[..16];
    public string Kind { get; set; } = "";
    public string Status { get; set; } = "queued";
    public int Progress { get; set; }
    public double CreatedAt { get; init; } = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    public double UpdatedAt { get; set; } = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
    public Dictionary<string, object?> Request { get; set; } = new();
    public Dictionary<string, JsonNode?>? Result { get; set; }
    public Dictionary<string, JsonNode?>? Error { get; set; }
    public bool Finished => Status is "succeeded" or "failed" or "cancelled";
}

public sealed class TaskManager
{
    private readonly Dictionary<string, BgTask> _tasks = new();
    private readonly Dictionary<string, CancellationTokenSource> _running = new();
    private readonly Dictionary<string, Task> _executions = new();
    private readonly object _lock = new();
    private readonly string _file;

    public TaskManager(string file) => _file = file;

    public void Load()
    {
        if (!File.Exists(_file)) return;
        try
        {
            var list = JsonSerializer.Deserialize<List<BgTask>>(File.ReadAllText(_file)) ?? new();
            lock (_lock)
            {
                foreach (var t in list)
                {
                    if (!t.Finished)
                    {
                        t.Status = "failed";
                        t.Error = new Dictionary<string, JsonNode?>
                        { ["message"] = "interrupted by server restart", ["code"] = "interrupted" };
                    }
                    _tasks[t.Id] = t;
                }
                Persist();
            }
        }
        catch (Exception ex) { throw new InvalidOperationException($"Cannot load task store '{_file}'; existing data was preserved.", ex); }
    }

    private void Persist()
    {
        lock (_lock)
        {
            var tasks = _tasks.Values.OrderBy(t => t.CreatedAt).TakeLast(500).ToList();
            Directory.CreateDirectory(Path.GetDirectoryName(Path.GetFullPath(_file)) ?? ".");
            var tmp = _file + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(tasks,
                new JsonSerializerOptions { WriteIndented = true }));
            File.Move(tmp, _file, overwrite: true);
        }
    }

    private static BgTask Snapshot(BgTask task)
        => JsonSerializer.Deserialize<BgTask>(JsonSerializer.Serialize(task))!;

    public BgTask? Get(string id) { lock (_lock) return _tasks.TryGetValue(id, out var task) ? Snapshot(task) : null; }
    public List<BgTask> List(int limit = 100)
    {
        lock (_lock) return _tasks.Values.OrderByDescending(t => t.CreatedAt).Take(limit).Select(Snapshot).ToList();
    }

    public BgTask Submit(string kind, Dictionary<string, object?> request,
        Func<Action<int>, CancellationToken, Task<Dictionary<string, JsonNode?>>> runner)
    {
        var task = new BgTask { Kind = kind, Request = request };
        var cts = new CancellationTokenSource();
        lock (_lock)
        {
            _tasks[task.Id] = task;
            _running[task.Id] = cts;
            Persist();
            _executions[task.Id] = Run(task, runner, cts);
            return Snapshot(task);
        }
    }

    private async Task Run(BgTask task, Func<Action<int>, CancellationToken, Task<Dictionary<string, JsonNode?>>> runner,
        CancellationTokenSource cts)
    {
        await Task.Yield();
        lock (_lock) task.Status = "running";
        try
        {
            cts.Token.ThrowIfCancellationRequested();
            var result = await runner(p =>
            {
                lock (_lock)
                {
                    task.Progress = Math.Max(task.Progress, Math.Min(99, p));
                    task.UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                }
            }, cts.Token);
            lock (_lock)
            {
                cts.Token.ThrowIfCancellationRequested();
                task.Result = result;
                task.Status = "succeeded";
                task.Progress = 100;
            }
        }
        catch (OperationCanceledException) { lock (_lock) task.Status = "cancelled"; }
        catch (MuseException ex)
        {
            lock (_lock)
            {
                task.Status = "failed";
                task.Error = new Dictionary<string, JsonNode?> { ["message"] = ex.Message, ["code"] = ex.Code };
            }
        }
        catch (Exception ex)
        {
            lock (_lock)
            {
                task.Status = "failed";
                task.Error = new Dictionary<string, JsonNode?> { ["message"] = ex.Message, ["code"] = "internal_error" };
            }
        }
        finally
        {
            lock (_lock)
            {
                task.UpdatedAt = DateTimeOffset.UtcNow.ToUnixTimeSeconds();
                _running.Remove(task.Id);
                _executions.Remove(task.Id);
                Persist();
                cts.Dispose();
            }
        }
    }

    public bool Cancel(string id)
    {
        lock (_lock)
        {
            if (!_running.TryGetValue(id, out var cts) || _tasks[id].Finished) return false;
            cts.Cancel();
            return true;
        }
    }

    public async Task StopAsync()
    {
        Task[] pending;
        lock (_lock)
        {
            foreach (var cts in _running.Values) cts.Cancel();
            pending = _executions.Values.ToArray();
        }
        await Task.WhenAll(pending);
    }
}

// ---------- Media ----------
public sealed class MediaStore
{
    private static readonly Dictionary<string, string> ExtByMime = new()
    {
        ["image/png"] = ".png",
        ["image/jpeg"] = ".jpg",
        ["image/webp"] = ".webp",
        ["image/gif"] = ".gif",
        ["video/mp4"] = ".mp4",
        ["video/webm"] = ".webm",
        ["video/quicktime"] = ".mov",
    };

    public string Root { get; }
    public MediaStore(string root) { Root = root; Directory.CreateDirectory(root); }

    public string Save(byte[] data, string mime, string prefix = "m")
    {
        var ext = ExtByMime.GetValueOrDefault(mime.Split(';')[0].Trim().ToLowerInvariant(), ".bin");
        var name = $"{prefix}_{Guid.NewGuid():N}"[..20] + ext;
        File.WriteAllBytes(Path.Combine(Root, name), data);
        return name;
    }

    public string PathOf(string name)
    {
        if (!System.Text.RegularExpressions.Regex.IsMatch(name, @"^[A-Za-z0-9_\-]+\.[A-Za-z0-9]+$"))
            throw MuseException.NotFound("media not found");
        var path = Path.Combine(Root, name);
        if (!File.Exists(path)) throw MuseException.NotFound("media not found");
        return path;
    }

    public static string MimeOf(string name) => ExtByMime.FirstOrDefault(
        entry => entry.Value.Equals(Path.GetExtension(name), StringComparison.OrdinalIgnoreCase)).Key
        ?? "application/octet-stream";

    public int Prune(double maxAgeSeconds)
    {
        if (maxAgeSeconds <= 0) return 0;
        var cutoff = DateTime.UtcNow.AddSeconds(-maxAgeSeconds);
        var removed = 0;
        foreach (var file in Directory.GetFiles(Root))
        {
            if (File.GetLastWriteTimeUtc(file) < cutoff)
            {
                try { File.Delete(file); removed++; } catch { }
            }
        }
        return removed;
    }
}
