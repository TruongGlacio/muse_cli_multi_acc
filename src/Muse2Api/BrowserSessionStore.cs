using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Muse2Api;

/// <summary>Browser state belongs to an account and its current login, never to a build directory.</summary>
public sealed class BrowserSessionStore(string dataDirectory)
{
    private sealed record SavedState(string AuthenticationHash, string StorageState);
    // Đường dẫn chỉ phụ thuộc accountId (hash SHA256 UTF8 của Id), nên
    // purge vẫn xóa được file ngay cả khi tài khoản đã khỏi pool và
    // không còn đối tượng Account nào. PathFor giữ nguyên công thức cũ.
    private string PathForId(string accountId) => Path.Combine(dataDirectory, "browser-sessions",
        Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(accountId))) + ".json");
    private string PathFor(Account account) => PathForId(account.Id);

    // Xóa hoàn toàn (v0.8.0, DELETE /admin/accounts/{id}/purge): xóa
    // file browser session của đúng tài khoản này. File không tồn tại
    // thì bỏ qua, không lỗi — purge phải idempotent ở bước này (bước
    // 404 là do tài khoản đã khỏi pool, không phải do thiếu file này).
    // Trả true nếu đã xóa được một file, false nếu vốn không có file.
    public bool DeleteById(string accountId)
    {
        var file = PathForId(accountId);
        if (!File.Exists(file)) return false;
        try { File.Delete(file); return true; }
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { return false; }
    }

    public bool Delete(Account account) => DeleteById(account.Id);

    public static string AuthenticationHash(Account account)
        => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(string.Join("\n",
            Upstream.SessionCookies.Select(name => name + "=" + account.Cookies.GetValueOrDefault(name, ""))))));

    public string? Load(Account account)
    {
        try
        {
            var file = PathFor(account);
            if (!File.Exists(file)) return null;
            var saved = JsonSerializer.Deserialize<SavedState>(PrivateDataProtection.ReadFile(file));
            if (saved is null || saved.AuthenticationHash != AuthenticationHash(account)) return null;
            using var state = JsonDocument.Parse(saved.StorageState);
            var valid = state.RootElement.ValueKind == JsonValueKind.Object
                && state.RootElement.TryGetProperty("cookies", out var cookies) && cookies.ValueKind == JsonValueKind.Array
                && state.RootElement.TryGetProperty("origins", out var origins) && origins.ValueKind == JsonValueKind.Array;
            if (!valid) return null;
            PrivateDataProtection.MigrateLegacyFile(file);
            return saved.StorageState;
        }
        // This is a cache: recover a context from the separately validated
        // account cookies if its encrypted snapshot is damaged. Preserve the
        // file; accounts/API-key stores still fail closed on decryption errors.
        catch (Exception ex) when (ex is IOException or UnauthorizedAccessException or JsonException or FormatException or CryptographicException) { return null; }
    }

    public async Task SaveAsync(Account account, string storageState)
    {
        using var parsed = JsonDocument.Parse(storageState);
        if (parsed.RootElement.ValueKind != JsonValueKind.Object) throw new InvalidOperationException("Invalid browser state");
        var file = PathFor(account);
        Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        await Task.Run(() => PrivateDataProtection.WriteFile(file,
            JsonSerializer.Serialize(new SavedState(AuthenticationHash(account), storageState))));
    }
}
