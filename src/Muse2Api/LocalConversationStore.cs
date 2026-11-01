using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

namespace Muse2Api;

/// <summary>One desktop conversation owns one upstream thread across rounds and restarts.</summary>
public sealed class LocalConversationStore(string dataDirectory)
{
    public sealed record Entry(string Account, string Url, bool Pending = false, string ImageHash = "");
    private static string Hash(string value) => Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(value)));
    private string FileFor(string hint) => Path.Combine(dataDirectory, "local-conversations", Hash(hint) + ".json");

    public Entry? Load(string accountId, string hint)
    {
        var file = FileFor(hint);
        if (!File.Exists(file)) return null;
        Entry entry;
        try { entry = JsonSerializer.Deserialize<Entry>(File.ReadAllText(file)) ?? throw new JsonException(); }
        catch (Exception ex) when (ex is JsonException or IOException)
        { throw UpstreamException.Refused("Saved Muse conversation cannot be read. No replacement chat was created."); }
        if (entry.Url is null || string.IsNullOrEmpty(entry.Account)) throw UpstreamException.Refused("Saved Muse conversation is incomplete. No replacement chat was created.");
        if (entry.Account != Hash(accountId)) throw UpstreamException.Refused("This conversation belongs to another Muse account. Reconnect that account; no replacement chat was created.");
        if (entry.Url.Length > 0 && !IsThread(entry.Url)) throw UpstreamException.Refused("Saved Muse conversation URL is invalid. No replacement chat was created.");
        return entry;
    }

    public void Save(string accountId, string hint, string url, bool pending, string imageHash = "")
    {
        if (string.IsNullOrWhiteSpace(hint)) throw MuseException.Invalid("Local conversations require a stable conversation ID.");
        if (url.Length > 0 && !IsThread(url)) throw MuseException.Invalid("Invalid Muse thread URL.");
        var file = FileFor(hint); Directory.CreateDirectory(Path.GetDirectoryName(file)!);
        var temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
        try
        {
            File.WriteAllText(temporary, JsonSerializer.Serialize(new Entry(Hash(accountId), url, pending, imageHash)));
            File.Move(temporary, file, overwrite: true);
        }
        finally { if (File.Exists(temporary)) File.Delete(temporary); }
    }

    // Viết lại mapping cho các thread cũ của tài khoản phụ sang tài
    // khoản chính (v0.7.0, dùng khi gộp trùng): Entry.Account là
    // Hash(accountId) — dùng đúng hàm Hash nội bộ này, không tự chế
    // hàm khác. Giữ nguyên Url/Pending/ImageHash. Trả số file đã viết
    // lại; file hỏng thì bỏ qua để không vỡ cả quá trình gộp.
    public int ReassignAccount(string oldAccountId, string newAccountId)
    {
        var dir = Path.Combine(dataDirectory, "local-conversations");
        if (!Directory.Exists(dir)) return 0;
        var oldHash = Hash(oldAccountId);
        var newHash = Hash(newAccountId);
        var rewritten = 0;
        foreach (var file in Directory.EnumerateFiles(dir, "*.json"))
        {
            Entry entry;
            try { entry = JsonSerializer.Deserialize<Entry>(File.ReadAllText(file)) ?? throw new JsonException(); }
            catch { continue; }
            if (entry.Account != oldHash) continue;
            var temporary = file + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                File.WriteAllText(temporary, JsonSerializer.Serialize(new Entry(newHash, entry.Url, entry.Pending, entry.ImageHash)));
                File.Move(temporary, file, overwrite: true);
                rewritten++;
            }
            catch { if (File.Exists(temporary)) try { File.Delete(temporary); } catch { } }
        }
        return rewritten;
    }

    // Xóa hoàn toàn (v0.8.0, DELETE /admin/accounts/{id}/purge): xóa
    // CHỈ các file mà Entry.Account == Hash(accountId), tái dùng đúng
    // hàm Hash nội bộ (giống ReassignAccount). File hỏng thì bỏ qua
    // (không vỡ cả quá trình purge); file của tài khoản khác không
    // đụng tới. Trả số file đã xóa thành công.
    public int DeleteAccountMappings(string accountId)
    {
        var dir = Path.Combine(dataDirectory, "local-conversations");
        if (!Directory.Exists(dir)) return 0;
        var targetHash = Hash(accountId);
        var deleted = 0;
        foreach (var file in Directory.EnumerateFiles(dir, "*.json"))
        {
            Entry entry;
            try { entry = JsonSerializer.Deserialize<Entry>(File.ReadAllText(file)) ?? throw new JsonException(); }
            catch { continue; }
            if (entry.Account != targetHash) continue;
            try { File.Delete(file); deleted++; }
            catch (Exception ex) when (ex is IOException or UnauthorizedAccessException) { /* bỏ qua file không xóa được */ }
        }
        return deleted;
    }

    public static bool IsThread(string url)
        => Uri.TryCreate(url, UriKind.Absolute, out var uri) && uri.Scheme == "https"
            && uri.Host.Equals("muse.ai", StringComparison.OrdinalIgnoreCase) && uri.IsDefaultPort
            && uri.AbsolutePath.StartsWith("/thread/", StringComparison.Ordinal)
            && uri.AbsolutePath.TrimEnd('/') is not ("/thread/new" or "/thread");
}
