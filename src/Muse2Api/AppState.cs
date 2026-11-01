using System.Text.Json.Nodes;

namespace Muse2Api;

public sealed class AppState
{
    public Settings Settings { get; }
    public IMuseDriver Driver { get; }
    public AccountPool Pool { get; }
    public BrowserLoginManager Login { get; }
    public Gateway Gateway { get; }
    public TaskManager Tasks { get; }
    public MediaStore Media { get; }
    public KeyStore Keys { get; }
    public RequestLog Requests { get; }

    // Diagnostic của BrowserDriver trước đây không có ai subscribe nên
    // các dòng local_reply_poll / local_reply_complete không bao giờ vào
    // stdout → Output > Muse Gateway và panel Nhật ký. Subscribe một lần
    // duy nhất cho mỗi instance driver (AppState có thể tạo lại với cùng
    // driver thì không subscribe trùng, tránh log lặp).
    private static readonly HashSet<BrowserDriver> DiagnosticSubscribed = new();
    private static readonly object DiagnosticLock = new();

    public AppState(Settings settings, IMuseDriver? driver = null)
    {
        settings.Validate();
        Settings = settings;
        settings.EnsureDirs();
        settings.ResolveApiKey();
        Driver = driver ?? DriverFactory.Create(settings);
        if (Driver is BrowserDriver browserDriver)
        {
            lock (DiagnosticLock)
            {
                if (DiagnosticSubscribed.Add(browserDriver))
                    browserDriver.Diagnostic += msg => Console.WriteLine("[local] " + msg);
            }
        }
        Pool = new AccountPool(settings.AccountsFile, settings.PoolStrategy,
            settings.AccountMaxConcurrency, settings.AccountCooldown, settings.PoolAcquireTimeout);
        Pool.Load();
        Login = new BrowserLoginManager(settings, Pool, Driver);
        Gateway = new Gateway(Pool, Driver, settings.MaxFailover);
        Tasks = new TaskManager(settings.TasksFile);
        Tasks.Load();
        Media = new MediaStore(settings.MediaDir);
        Keys = new KeyStore(settings.KeysFile);
        Keys.Load();
        Requests = new RequestLog(settings.RequestsFile);
        Requests.Prune(settings.RequestLogRetentionDays);
    }
}

/// <summary>Small helpers for the flexible OpenAI JSON shapes (content can be a
/// string or a list of parts, unknown fields are ignored).</summary>
public static class JsonHelp
{
    public static string? Str(JsonNode? n) => n is JsonValue v ? v.TryGetValue<string>(out var s) ? s : null : null;
    public static string StrOr(JsonNode? n, string fallback) => Str(n) ?? fallback;
    public static bool Bool(JsonNode? n, bool fallback = false)
        => n is JsonValue v && v.TryGetValue<bool>(out var b) ? b : fallback;
    public static int Int(JsonNode? n, int fallback = 0)
        => n is JsonValue v && v.TryGetValue<int>(out var i) ? i : fallback;
    public static long Long(JsonNode? n, long fallback = 0)
        => n is JsonValue v && v.TryGetValue<long>(out var i) ? i : fallback;
    public static int ApproxTokens(string text) => Math.Max(1, text.Length / 4);

    public static async Task<JsonObject> ReadBody(HttpRequest request)
    {
        if (request.ContentLength == 0) return new JsonObject();
        if (!request.HasJsonContentType()) throw MuseException.Invalid("Content-Type must be application/json");
        try
        {
            return await request.ReadFromJsonAsync<JsonObject>(request.HttpContext.RequestAborted)
                ?? throw MuseException.Invalid("request body must be a JSON object");
        }
        catch (System.Text.Json.JsonException) { throw MuseException.Invalid("request body must be a valid JSON object"); }
    }

    public static string BaseUrl(HttpRequest request, Settings settings)
    {
        if (!string.IsNullOrEmpty(settings.PublicBase)) return settings.PublicBase.TrimEnd('/');
        return $"{request.Scheme}://{request.Host}".TrimEnd('/');
    }

    public static async Task<List<InputImage>> LoadImageRefs(IEnumerable<string> refs, CancellationToken cancel = default)
    {
        var loaded = new List<InputImage>();
        foreach (var r in refs) loaded.Add(await MediaHelp.LoadImageRef(r, cancel));
        return loaded;
    }
}

public static class MediaHelp
{
    /// <summary>True for loopback, private, link-local, multicast, reserved
    /// and unspecified IPs — the same set Python's ipaddress checks reject
    /// (is_private / is_loopback / is_link_local / is_multicast /
    /// is_reserved / is_unspecified), with IPv4-mapped IPv6 unwrapped first.</summary>
    public static bool IsNonPublicIp(System.Net.IPAddress ip)
    {
        if (ip.IsIPv4MappedToIPv6) ip = ip.MapToIPv4();
        if (System.Net.IPAddress.IsLoopback(ip)) return true;
        var b = ip.GetAddressBytes();
        if (ip.AddressFamily == System.Net.Sockets.AddressFamily.InterNetwork)
        {
            if (b[0] == 0) return true; // unspecified 0.0.0.0/8
            if (b[0] == 10) return true;
            if (b[0] == 172 && b[1] >= 16 && b[1] <= 31) return true;
            if (b[0] == 192 && b[1] == 168) return true;
            if (b[0] == 169 && b[1] == 254) return true; // link-local
            if (b[0] == 100 && b[1] is >= 64 and <= 127) return true; // shared address space
            if (b[0] == 192 && b[1] == 0 && (b[2] == 0 || b[2] == 2)) return true;
            if (b[0] == 198 && (b[1] is 18 or 19 || b[1] == 51 && b[2] == 100)) return true;
            if (b[0] == 203 && b[1] == 0 && b[2] == 113) return true;
            if (b[0] >= 224 && b[0] <= 239) return true; // multicast
            if (b[0] >= 240) return true; // reserved
            return false;
        }
        // IPv6: ::1 loopback handled above; :: unspecified, fe80::/10
        // link-local, fc00::/7 unique-local, ff00::/8 multicast, 100::/64 discard.
        if (b.All(x => x == 0)) return true;
        if (b[0] == 0xfe && (b[1] & 0xc0) == 0x80) return true;
        if ((b[0] & 0xfe) == 0xfc) return true;
        if (b[0] == 0xff) return true;
        if ((b[0] & 0xe0) != 0x20) return true; // only global unicast 2000::/3
        if (b[0] == 0x20 && b[1] == 0x01 && (b[2] < 0x02 || b[2] == 0x0d && b[3] == 0xb8)) return true;
        if (b[0] == 0x20 && b[1] == 0x02) return true; // 6to4 embeds IPv4 addresses
        return false;
    }

    public static async Task AssertPublicHostAsync(string host, CancellationToken cancel = default)
    {
        System.Net.IPAddress[] addrs;
        try { addrs = await System.Net.Dns.GetHostAddressesAsync(host, cancel); }
        catch (OperationCanceledException) when (cancel.IsCancellationRequested) { throw; }
        catch { throw MuseException.Invalid("image_url host does not resolve"); }
        if (addrs.Length == 0 || addrs.Any(IsNonPublicIp))
            throw MuseException.Invalid("image_url must resolve to a public IP address");
    }

    public const int MaxImageBytes = 20 * 1024 * 1024;

    private static InputImage DecodeImage(string payload, string mime)
    {
        if (!mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase))
            throw MuseException.Invalid("image data must have an image MIME type");
        if (payload.Length > (MaxImageBytes + 2L) / 3 * 4)
            throw MuseException.Invalid("image exceeds 20 MiB");
        byte[] bytes;
        try { bytes = Convert.FromBase64String(payload); }
        catch (FormatException) { throw MuseException.Invalid("invalid base64 image data"); }
        if (bytes.Length is 0 or > MaxImageBytes) throw MuseException.Invalid("image must be non-empty and at most 20 MiB");
        return new InputImage(bytes, mime);
    }

    public static async Task<InputImage> LoadImageRef(string reference, CancellationToken cancel = default)
    {
        var r = reference.Trim();
        if (r.StartsWith("data:", StringComparison.OrdinalIgnoreCase))
        {
            var comma = r.IndexOf(',');
            if (comma < 0 || !r[..comma].EndsWith(";base64", StringComparison.OrdinalIgnoreCase))
                throw MuseException.Invalid("image data URL must contain base64 data");
            return DecodeImage(r[(comma + 1)..], r[5..comma].Split(';')[0]);
        }
        if (!r.StartsWith("http:", StringComparison.OrdinalIgnoreCase) && !r.StartsWith("https:", StringComparison.OrdinalIgnoreCase))
            return DecodeImage(r, "image/png");
        if (!Uri.TryCreate(r, UriKind.Absolute, out var uri)) throw MuseException.Invalid("invalid image_url");
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancel);
        timeout.CancelAfter(TimeSpan.FromSeconds(20));
        // Validate DNS at the connection itself, preventing a DNS change between
        // validation and fetch from reaching a private address. Disable proxies
        // so a proxy cannot bypass this connection check.
        using var handler = new SocketsHttpHandler
        {
            AllowAutoRedirect = false,
            UseProxy = false,
            ConnectCallback = async (context, token) =>
            {
                var addresses = await System.Net.Dns.GetHostAddressesAsync(context.DnsEndPoint.Host, token);
                if (addresses.Length == 0 || addresses.Any(IsNonPublicIp))
                    throw MuseException.Invalid("image_url must resolve to a public IP address");
                foreach (var address in addresses)
                {
                    var socket = new System.Net.Sockets.Socket(address.AddressFamily,
                        System.Net.Sockets.SocketType.Stream, System.Net.Sockets.ProtocolType.Tcp);
                    try
                    {
                        await socket.ConnectAsync(new System.Net.IPEndPoint(address, context.DnsEndPoint.Port), token);
                        return new System.Net.Sockets.NetworkStream(socket, ownsSocket: true);
                    }
                    catch { socket.Dispose(); if (token.IsCancellationRequested) throw; }
                }
                throw new HttpRequestException("could not connect to image_url");
            },
        };
        using var client = new HttpClient(handler);
        try
        {
            for (var hop = 0; hop <= 5; hop++)
            {
                if (uri.Scheme is not ("http" or "https") || uri.UserInfo.Length > 0)
                    throw MuseException.Invalid("image_url must be an http(s) URL without credentials");
                await AssertPublicHostAsync(uri.DnsSafeHost, timeout.Token);
                using var resp = await client.GetAsync(uri, HttpCompletionOption.ResponseHeadersRead, timeout.Token);
                if ((int)resp.StatusCode is 301 or 302 or 303 or 307 or 308)
                {
                    if (resp.Headers.Location is not { } location) throw MuseException.Invalid("image_url redirect missing location");
                    uri = new Uri(uri, location);
                    continue;
                }
                if (!resp.IsSuccessStatusCode) throw MuseException.Invalid($"image_url returned HTTP {(int)resp.StatusCode}");
                var mime = resp.Content.Headers.ContentType?.MediaType ?? "image/png";
                if (!mime.StartsWith("image/", StringComparison.OrdinalIgnoreCase)) throw MuseException.Invalid("image_url did not return an image");
                if (resp.Content.Headers.ContentLength > MaxImageBytes) throw MuseException.Invalid("image exceeds 20 MiB");
                using var stream = await resp.Content.ReadAsStreamAsync(timeout.Token);
                using var ms = new MemoryStream();
                var buffer = new byte[65536];
                int read;
                while ((read = await stream.ReadAsync(buffer, timeout.Token)) > 0)
                {
                    if (ms.Length + read > MaxImageBytes) throw MuseException.Invalid("image exceeds 20 MiB");
                    ms.Write(buffer, 0, read);
                }
                if (ms.Length == 0) throw MuseException.Invalid("image must not be empty");
                return new InputImage(ms.ToArray(), mime);
            }
            throw MuseException.Invalid("image_url exceeded redirect limit");
        }
        catch (OperationCanceledException) when (!cancel.IsCancellationRequested) { throw MuseException.Invalid("image_url download timed out"); }
        catch (HttpRequestException) { throw MuseException.Invalid("could not download image_url from a public address"); }
    }
}
