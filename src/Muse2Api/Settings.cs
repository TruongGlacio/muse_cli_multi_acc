namespace Muse2Api;

/// <summary>Runtime configuration, mirroring the Python <c>Settings</c> class.
/// Every value comes from a <c>MUSE2API_*</c> environment variable.</summary>
public sealed class Settings
{
    public string Host { get; init; } = Env("HOST", "127.0.0.1");
    public int Port { get; init; } = EnvInt("PORT", 18610);
    public string LogLevel { get; init; } = Env("LOG_LEVEL", "INFO");
    public string PublicBase { get; init; } = Env("PUBLIC_BASE", "");
    public string ApiKey { get; set; } = Env("API_KEY", "");
    public string AdminKey { get; init; } = Env("ADMIN_KEY", "");
    public string DataDir { get; init; } = Env("DATA_DIR", "data");
    public double RequestLogRetentionDays { get; init; } = EnvDouble("REQUEST_LOG_RETENTION_DAYS", 14);
    public double MediaRetentionDays { get; init; } = EnvDouble("MEDIA_RETENTION_DAYS", 14);
    public string Driver { get; init; } = Env("DRIVER", "mock");
    public string SiteUrl { get; init; } = Env("SITE_URL", "https://muse.ai");
    public double ChatTimeout { get; init; } = EnvDouble("CHAT_TIMEOUT", 300);
    public double FirstTokenTimeout { get; init; } = EnvDouble("FIRST_TOKEN_TIMEOUT", 45);
    public double ChatIdleTimeout { get; init; } = EnvDouble("CHAT_IDLE_TIMEOUT", 90);
    public double ReplyRenderGrace { get; init; } = EnvDouble("REPLY_RENDER_GRACE", 15);
    public double StreamHeartbeatInterval { get; init; } = EnvDouble("STREAM_HEARTBEAT_INTERVAL", 0);
    public double ImageTimeout { get; init; } = EnvDouble("IMAGE_TIMEOUT", 240);
    public double VideoTimeout { get; init; } = EnvDouble("VIDEO_TIMEOUT", 600);
    public string PoolStrategy { get; init; } = Env("POOL_STRATEGY", "affinity");
    public double PoolAcquireTimeout { get; init; } = EnvDouble("POOL_ACQUIRE_TIMEOUT", 60);
    public int AccountMaxConcurrency { get; init; } = EnvInt("ACCOUNT_MAX_CONCURRENCY", 1);
    public double AccountCooldown { get; init; } = EnvDouble("ACCOUNT_COOLDOWN", 120);
    public int MaxFailover { get; init; } = EnvInt("MAX_FAILOVER", 2);
    public double QuotaCacheSeconds { get; init; } = EnvDouble("QUOTA_CACHE_S", 1800);
    public double WakeConfirmSeconds { get; init; } = EnvDouble("WAKE_CONFIRM_S", 20);
    public bool KeepaliveEnabled { get; init; } = EnvBool("KEEPALIVE_ENABLED", false);
    public double KeepaliveInterval { get; init; } = EnvDouble("KEEPALIVE_INTERVAL", 6 * 3600);
    // Browser driver (Playwright port of drivers/browser/)
    public string ChromiumPath { get; init; } = Env("CHROMIUM_PATH", "");
    public int CdpPort { get; init; } = EnvInt("CDP_PORT", 19210);
    public bool Headless { get; init; } = EnvBool("HEADLESS", true);
    public string BrowserProxy { get; init; } = Env("BROWSER_PROXY", "");
    public string? BrowserProfileDir { get; init; } = Env("BROWSER_PROFILE_DIR", "") is { Length: > 0 } p ? p : null;
    public double PageReadyTimeout { get; init; } = EnvDouble("PAGE_READY_TIMEOUT", 45);
    public string ProfileDir => BrowserProfileDir ?? Path.Combine(DataDir, "browser-profile");

    public string EffectiveAdminKey => string.IsNullOrEmpty(AdminKey) ? ApiKey : AdminKey;
    public string MediaDir => Path.Combine(DataDir, "media");
    // v0.8.25: thư mục file tạm cho setInputFiles (mỗi lượt một thư
    // mục con Guid, dọn sau khi Send). Nằm dưới DataDir để chạy
    // đúng trên Windows/Mac của user, không dùng /tmp hệ thống.
    public string AttachTmpDir => Path.Combine(DataDir, "attach-tmp");
    public string AccountsFile => Path.Combine(DataDir, "accounts.json");
    public string TasksFile => Path.Combine(DataDir, "tasks.json");
    public string RequestsFile => Path.Combine(DataDir, "requests.db");
    public string KeyFile => Path.Combine(DataDir, "api_key");
    public string KeysFile => Path.Combine(DataDir, "keys.json");

    public void Validate()
    {
        if (Port is < 1 or > 65535) throw new InvalidOperationException("MUSE2API_PORT must be between 1 and 65535");
        if (Driver is not ("mock" or "browser" or "http")) throw new InvalidOperationException("MUSE2API_DRIVER must be mock, browser or http");
        if (PoolStrategy is not ("affinity" or "lru" or "round_robin")) throw new InvalidOperationException("invalid MUSE2API_POOL_STRATEGY");
        if (AccountMaxConcurrency < 1 || MaxFailover < 0) throw new InvalidOperationException("account concurrency must be positive and max failover must be non-negative");
        foreach (var value in new[] { ChatTimeout, FirstTokenTimeout, ChatIdleTimeout, ReplyRenderGrace, ImageTimeout, VideoTimeout, PageReadyTimeout, KeepaliveInterval })
            if (!double.IsFinite(value) || value <= 0) throw new InvalidOperationException("timeouts and intervals must be finite and positive");
        foreach (var value in new[] { PoolAcquireTimeout, AccountCooldown, StreamHeartbeatInterval, RequestLogRetentionDays, MediaRetentionDays, QuotaCacheSeconds, WakeConfirmSeconds })
            if (!double.IsFinite(value) || value < 0) throw new InvalidOperationException("retention, cooldown and optional intervals must be finite and non-negative");
    }

    public void EnsureDirs()
    {
        Directory.CreateDirectory(DataDir);
        Directory.CreateDirectory(MediaDir);
    }

    /// <summary>Python behaviour: generate + persist an API key on first start
    /// when none was configured, so a fresh install is usable immediately.</summary>
    public void ResolveApiKey()
    {
        if (!string.IsNullOrEmpty(ApiKey)) return;
        EnsureDirs();
        if (File.Exists(KeyFile))
        {
            ApiKey = PrivateDataProtection.ReadFile(KeyFile).Trim();
            // Preserve the key and upgrade plaintext storage for existing desktop profiles.
            if (!string.IsNullOrEmpty(ApiKey)) PrivateDataProtection.MigrateLegacyFile(KeyFile);
            if (!string.IsNullOrEmpty(ApiKey)) return;
        }
        ApiKey = "m2a-" + Convert.ToHexString(
            System.Security.Cryptography.RandomNumberGenerator.GetBytes(18)).ToLowerInvariant();
        PrivateDataProtection.WriteFile(KeyFile, ApiKey);
    }

    private static string Env(string name, string fallback)
    {
        var v = Environment.GetEnvironmentVariable("MUSE2API_" + name);
        return string.IsNullOrEmpty(v) ? fallback : v;
    }
    private static int EnvInt(string name, int fallback)
        => int.TryParse(Environment.GetEnvironmentVariable("MUSE2API_" + name), out var v) ? v : fallback;
    private static double EnvDouble(string name, double fallback)
        => double.TryParse(Environment.GetEnvironmentVariable("MUSE2API_" + name),
            System.Globalization.NumberStyles.Float,
            System.Globalization.CultureInfo.InvariantCulture, out var v) ? v : fallback;
    private static bool EnvBool(string name, bool fallback)
    {
        var v = Environment.GetEnvironmentVariable("MUSE2API_" + name);
        return v is null ? fallback : v is "1" or "true" or "True" or "TRUE";
    }
}
