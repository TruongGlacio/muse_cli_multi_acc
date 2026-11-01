using System.IO.Compression;
using System.Text.Json.Nodes;

namespace Muse2Api;

public sealed record InputImage(byte[] Data, string Mime = "image/png");
public sealed record ChatRequest(string Prompt, string Model, List<InputImage> Images,
    string? ConversationHint, List<(string Role, string Text)> Turns, CancellationToken Cancel, bool LocalTools = false, string? ImageBatchId = null, string? AccountId = null);
public sealed record ImageRequest(string Prompt, string Model, string? Size, int N,
    List<InputImage> References, Action<int>? OnProgress = null, CancellationToken Cancel = default);
public sealed record VideoRequest(string Prompt, string Model, string? Size, int? Duration,
    InputImage? FirstFrame, Action<int>? OnProgress = null, CancellationToken Cancel = default);
public sealed record MediaResult(byte[] Data, string Mime, string Kind,
    int? Width = null, int? Height = null, string? RevisedPrompt = null);
public sealed record SessionInfo(bool Ok, Dictionary<string, string> Cookies,
    Dictionary<string, long> CookieExpires, Dictionary<string, string?> Meta);
// Hồ sơ Muse lấy best-effort (v0.7.0): trường nào không xác định được
// thì null, không bao giờ bịa. Phone thường là null vì trang chủ hiếm
// khi hiện trường Phone gắn nhãn rõ ràng.
public sealed record ProfileInfo(string? Email, string? Username, string? Phone);
// Chẩn đoán profile-refresh (v0.8.2, nguồn giá trị thêm ở v0.8.3):
// CHỈ chứa tên bước + trạng thái + URL cuối + cờ menu/cài đặt + số
// candidate + tên bước nguồn của email/username, KHÔNG BAO GIỜ chứa
// email/phone hay nội dung trang. Attempted/Succeeded/Failed dùng tên
// bước ổn định: session_api, home, menu, settings, local_storage.
// EmailSource/UsernameSource là tên bước đã đặt giá trị đó lần đầu
// (null khi bước đó không đặt được gì) — để chẩn đoán lần sau biết
// bước nào sinh ra giá trị sai.
public sealed record ProfileDebug(List<string> Attempted, List<string> Succeeded, List<string> Failed,
    string FinalUrl, bool MenuOpened, bool SettingsOpened, int CandidateCount,
    string? EmailSource = null, string? UsernameSource = null);
// Kết quả quét thread web (v0.7.0, điểm 4): danh sách + chẩn đoán chỉ
// gồm số lượng (pageUrl, linkCount, threadCount), không nội dung trang.
public sealed record WebThreadsScan(List<(string Url, string Title)> Threads, string PageUrl, int LinkCount, bool LoginHint = false);
public sealed record DriverCapabilities(bool Chat = false, bool ChatImages = false,
    bool Image = false, bool ImageEdit = false, bool Video = false,
    bool RenewSession = false, bool Quota = false);

public interface IMuseDriver
{
    string Name { get; }
    bool RequiresAccount { get; }
    DriverCapabilities Capabilities { get; }
    Task StartupAsync() => Task.CompletedTask;
    Task ShutdownAsync() => Task.CompletedTask;
    Task InvalidateAccount(string accountId) => Task.CompletedTask;
    IAsyncEnumerable<string> ChatStream(Account account, ChatRequest req);
    Task<List<MediaResult>> GenerateImage(Account account, ImageRequest req)
        => throw MuseException.NotImplemented($"driver '{Name}' does not support image generation");
    Task<MediaResult> GenerateVideo(Account account, VideoRequest req)
        => throw MuseException.NotImplemented($"driver '{Name}' does not support video generation");
    Task<SessionInfo> RenewSession(Account account)
        => throw MuseException.NotImplemented($"driver '{Name}' does not support session renewal");
    Task<Dictionary<string, object?>> Quota(Account account)
        => throw MuseException.NotImplemented($"driver '{Name}' does not support quota lookup");
    // v0.6.0, mức 1: liệt kê thread web của tài khoản (danh sách + tiêu
    // đề từ sidebar muse.ai). Chỉ BrowserDriver cài đặt thật; các driver
    // khác dùng default này và gateway trả 501.
    Task<WebThreadsScan> ListWebThreads(Account account)
        => throw MuseException.NotImplemented($"driver '{Name}' không hỗ trợ liệt kê hội thoại web");
    // v0.7.0: lấy hồ sơ best-effort của tài khoản. Driver không phải
    // trình duyệt trả null (không lấy được gì), không lỗi.
    Task<ProfileInfo?> FetchProfile(Account account, CancellationToken cancel = default)
        => Task.FromResult<ProfileInfo?>(null);
    // v0.8.2: như FetchProfile nhưng kèm ProfileDebug (không chứa
    // email/phone). Driver mặc định suy ra debug rỗng từ FetchProfile.
    async Task<(ProfileInfo? Profile, ProfileDebug Debug)> FetchProfileDetailed(Account account, CancellationToken cancel = default)
    {
        var profile = await FetchProfile(account, cancel);
        return (profile, new ProfileDebug(new List<string>(), new List<string>(), new List<string>(), "", false, false, 0));
    }
    Task<Dictionary<string, object?>> Health()
        => Task.FromResult(new Dictionary<string, object?> { ["driver"] = Name, ["ok"] = true });
}

/// <summary>Offline driver, ported from Python <c>drivers/mock.py</c>.
/// Needs no account and returns deterministic output.</summary>
public sealed class MockDriver : IMuseDriver
{
    public string Name => "mock";
    public bool RequiresAccount => false;
    public DriverCapabilities Capabilities { get; } = new(
        Chat: true, ChatImages: true, Image: true, ImageEdit: true, Video: true,
        RenewSession: true, Quota: true);

    private readonly int _delayMs;
    public MockDriver(int delayMs = 1) => _delayMs = delayMs;

    public async IAsyncEnumerable<string> ChatStream(Account account, ChatRequest req)
    {
        var reply = $"[mock:{req.Model}] You said: {req.Prompt[^Math.Min(200, req.Prompt.Length)..]}";
        if (req.Images.Count > 0) reply += $" (with {req.Images.Count} image(s))";
        for (var i = 0; i < reply.Length; i += 8)
        {
            req.Cancel.ThrowIfCancellationRequested();
            await Task.Delay(_delayMs, req.Cancel);
            yield return reply.Substring(i, Math.Min(8, reply.Length - i));
        }
    }

    public async Task<List<MediaResult>> GenerateImage(Account account, ImageRequest req)
    {
        var results = new List<MediaResult>();
        var n = Math.Max(1, req.N);
        for (var i = 0; i < n; i++)
        {
            req.OnProgress?.Invoke((i + 1) * 100 / n);
            await Task.Delay(_delayMs, req.Cancel);
            var color = ((byte)(40 + (50 * i) % 200), (byte)120, (byte)200);
            results.Add(new MediaResult(SolidPng(64, 64, color), "image/png", "image",
                64, 64, req.Prompt));
        }
        return results;
    }

    public async Task<MediaResult> GenerateVideo(Account account, VideoRequest req)
    {
        foreach (var p in new[] { 10, 40, 70, 100 })
        {
            await Task.Delay(_delayMs, req.Cancel);
            req.OnProgress?.Invoke(p);
        }
        // Placeholder bytes with the right mime, like the Python mock.
        return new MediaResult(
            new byte[] { 0, 0, 0, 0x18, (byte)'f', (byte)'t', (byte)'y', (byte)'p',
                (byte)'m', (byte)'p', (byte)'4', (byte)'2', (byte)'m', (byte)'o', (byte)'c', (byte)'k' },
            "video/mp4", "video");
    }

    public Task<SessionInfo> RenewSession(Account account) => Task.FromResult(new SessionInfo(
        true, new Dictionary<string, string>(), new Dictionary<string, long>(),
        new Dictionary<string, string?> { ["driver"] = "mock" }));

    public Task<Dictionary<string, object?>> Quota(Account account) => Task.FromResult(
        new Dictionary<string, object?>
        {
            ["plan"] = "free",
            ["messages_used"] = 0,
            ["messages_limit"] = 100,
            ["messages_remaining"] = 100,
            ["media_used"] = 0,
            ["media_limit"] = 20,
            ["media_remaining"] = 20,
            ["resets_at"] = null,
        });

    // --- Solid PNG encoder, mirroring Python's struct/zlib version ---
    internal static byte[] SolidPng(int width, int height, (byte R, byte G, byte B) rgb)
    {
        using var ms = new MemoryStream();
        ms.Write(new byte[] { 0x89, (byte)'P', (byte)'N', (byte)'G', 13, 10, 26, 10 });
        WriteChunk(ms, "IHDR", BigEndian(width).Concat(BigEndian(height))
            .Concat(new byte[] { 8, 2, 0, 0, 0 }).ToArray());
        var row = new byte[1 + width * 3];
        for (var x = 0; x < width; x++)
        {
            row[1 + x * 3] = rgb.R; row[2 + x * 3] = rgb.G; row[3 + x * 3] = rgb.B;
        }
        var raw = new byte[row.Length * height];
        for (var y = 0; y < height; y++) row.CopyTo(raw, y * row.Length);
        using (var comp = new MemoryStream())
        {
            using (var z = new ZLibStream(comp, CompressionMode.Compress, leaveOpen: true))
                z.Write(raw, 0, raw.Length);
            WriteChunk(ms, "IDAT", comp.ToArray());
        }
        WriteChunk(ms, "IEND", Array.Empty<byte>());
        return ms.ToArray();
    }

    private static byte[] BigEndian(int v)
        => new[] { (byte)(v >> 24), (byte)(v >> 16), (byte)(v >> 8), (byte)v };

    private static readonly uint[] CrcTable = BuildCrcTable();
    private static uint[] BuildCrcTable()
    {
        var table = new uint[256];
        for (uint n = 0; n < 256; n++)
        {
            var c = n;
            for (var k = 0; k < 8; k++) c = (c & 1) != 0 ? 0xEDB88320u ^ (c >> 1) : c >> 1;
            table[n] = c;
        }
        return table;
    }
    private static uint Crc32(byte[] type, byte[] data)
    {
        var c = 0xFFFFFFFFu;
        foreach (var b in type.Concat(data)) c = CrcTable[(c ^ b) & 0xFF] ^ (c >> 8);
        return c ^ 0xFFFFFFFFu;
    }
    private static void WriteChunk(Stream s, string type, byte[] data)
    {
        var typeBytes = System.Text.Encoding.ASCII.GetBytes(type);
        s.Write(BigEndian(data.Length));
        s.Write(typeBytes);
        s.Write(data);
        s.Write(BigEndian((int)Crc32(typeBytes, data)));
    }
}

/// <summary>Browser driver — implemented in <c>BrowserDriver.cs</c> with
/// Microsoft.Playwright, ported from Python <c>drivers/browser/</c>.
/// Kept here only as a factory alias; the real class is <see cref="BrowserDriver"/>.</summary>

/// <summary>Direct HTTP protocol driver — reserved in Python too (501 for chat).
/// Session renewal already works over plain HTTP and is ported here.</summary>
public sealed class HttpDriver : IMuseDriver
{
    public string Name => "http";
    public bool RequiresAccount => true;
    public DriverCapabilities Capabilities { get; } = new(RenewSession: true);
    public IAsyncEnumerable<string> ChatStream(Account account, ChatRequest req)
        => throw MuseException.NotImplemented(
            "http driver chat is not implemented yet; use driver=browser");
    public Task<SessionInfo> RenewSession(Account account)
        => Upstream.RenewSession(account.Cookies);
}

public static class DriverFactory
{
    public static IMuseDriver Create(Settings settings) => settings.Driver switch
    {
        "browser" => new BrowserDriver(settings),
        "http" => new HttpDriver(),
        "mock" => new MockDriver(),
        _ => throw new InvalidOperationException($"unknown driver '{settings.Driver}'"),
    };
}
