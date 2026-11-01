using System.Text.RegularExpressions;

namespace Muse2Api;

/// <summary>
/// Kiểm tra tính hợp lệ của email/username lấy từ hồ sơ Muse (v0.8.3).
/// <para>
/// Lý do tồn tại: bản 0.8.2 lấy match email ĐẦU TIÊN bằng regex nên tên
/// file ảnh retina như "calendar@2x.png" (khớp dạng @domain.tld) bị nhận
/// thành email, và UUID/hex dài lọt qua thành username. Các hàm này chặn
/// rác ngay tại nguồn lấy, đồng thời dùng để dọn rác đã lưu trước đó.
/// KHÔNG BAO GIỜ log giá trị email/username thật — các hàm chỉ trả
/// true/false hoặc giá trị đã qua kiểm tra.
/// </para>
/// </summary>
public static class ProfileValidation
{
    // Đuôi file (ảnh/tệp) không bao giờ là đuôi domain email thật hay
    // đuôi username thật. "png" là đuôi hay gặp nhất vì ảnh retina
    // "@2x.png" trông đúng dạng @domain.tld với regex email thô.
    private static readonly HashSet<string> FileExtensions = new(StringComparer.OrdinalIgnoreCase)
        { "png", "jpg", "jpeg", "gif", "svg", "webp", "ico", "bmp", "avif" };

    private static readonly Regex EmailPattern =
        new(@"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", RegexOptions.Compiled);

    private static readonly Regex FullEmailPattern =
        new(@"^[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}$", RegexOptions.Compiled);

    // UUID chuẩn dạng 8-4-4-4-12 hex (ví dụ id phiên/avatar hay lọt vào
    // candidate hồ sơ). Chuỗi hex thuần dài cũng là id kỹ thuật, không
    // phải tên người dùng.
    private static readonly Regex UuidPattern =
        new(@"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", RegexOptions.Compiled);

    private static readonly Regex PureHexPattern =
        new(@"^[0-9a-fA-F]{16,}$", RegexOptions.Compiled);

    // Marker retina kiểu "2x"/"3x": nhãn domain đầu tiên chỉ gồm số +
    // chữ x thì đó là hậu tố ảnh, không phải domain thật.
    private static readonly Regex RetinaLabelPattern =
        new(@"^\d+x$", RegexOptions.Compiled | RegexOptions.IgnoreCase);

    private static readonly Regex UrlAttributePattern =
        new(@"\s+(?:src|href)\s*=\s*(?:""[^""]*""|'[^']*'|[^\s>]+)",
            RegexOptions.Compiled | RegexOptions.IgnoreCase);

    /// <summary>Email đã lưu/lấy về có phải email thật không.</summary>
    public static bool IsValidEmail(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        var v = value.Trim();
        // Email thật không chứa khoảng trắng, dấu gạch chéo hay "http".
        if (v.Any(char.IsWhiteSpace) || v.Contains('/') || v.Contains('\\')) return false;
        if (!FullEmailPattern.IsMatch(v)) return false;
        var domain = v[(v.LastIndexOf('@') + 1)..];
        var labels = domain.Split('.');
        if (labels.Length < 2 || labels.Any(string.IsNullOrEmpty)) return false;
        // Đuôi domain là đuôi file ảnh/tệp thì đó là tên file, không
        // phải email (ví dụ calendar@2x.png).
        if (FileExtensions.Contains(labels[^1])) return false;
        // Nhãn đầu là marker retina (2x, 3x) thì cũng là tên file ảnh.
        if (RetinaLabelPattern.IsMatch(labels[0])) return false;
        return true;
    }

    /// <summary>Username đã lưu/lấy về có phải tên người dùng thật không.</summary>
    public static bool IsValidUsername(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        var v = value.Trim();
        if (v.Length < 3 || v.Length > 80) return false;
        // Chứa @ thì đó là email; chứa / hay "http" thì đó là URL/đường dẫn.
        if (v.Contains('@') || v.Contains('/') || v.Contains('\\')) return false;
        if (v.Contains("http", StringComparison.OrdinalIgnoreCase)) return false;
        // Đuôi file ảnh/tệp thì đó là tên file, không phải tên người.
        var dot = v.LastIndexOf('.');
        if (dot > 0 && FileExtensions.Contains(v[(dot + 1)..])) return false;
        if (UuidPattern.IsMatch(v)) return false;
        if (PureHexPattern.IsMatch(v)) return false;
        return true;
    }

    /// <summary>
    /// Tìm email ĐẦU TIÊN HỢP LỆ trong một đoạn text (không phải match
    /// đầu tiên như regex thô trước đây). Match nằm trong đường dẫn URL
    /// (ký tự ngay trước là '/') hoặc không qua IsValidEmail đều bị bỏ
    /// qua để nhường chỗ cho email thật đứng sau nó.
    /// </summary>
    public static string? FindEmail(string? text)
    {
        if (string.IsNullOrEmpty(text)) return null;
        foreach (Match m in EmailPattern.Matches(text))
        {
            if (m.Index > 0 && text[m.Index - 1] == '/') continue;
            if (IsValidEmail(m.Value)) return m.Value;
        }
        return null;
    }

    /// <summary>
    /// Match email-like ĐẦU TIÊN trong text, kể cả khi nó không hợp lệ
    /// (dùng để ghi nguồn rác bị loại, phục vụ chẩn đoán mapping).
    /// </summary>
    public static string? FirstEmailLike(string? text)
    {
        if (string.IsNullOrEmpty(text)) return null;
        var m = EmailPattern.Match(text);
        return m.Success ? m.Value : null;
    }

    /// <summary>Chuỗi có phải id kỹ thuật (UUID hoặc hex thuần dài) không.</summary>
    public static bool IsTechnicalId(string? value)
    {
        if (string.IsNullOrWhiteSpace(value)) return false;
        var v = value.Trim();
        return UuidPattern.IsMatch(v) || PureHexPattern.IsMatch(v);
    }
    public static string StripUrlAttributes(string html)
        => string.IsNullOrEmpty(html) ? html : UrlAttributePattern.Replace(html, "");

    /// <summary>
    /// Xóa Email/Username đã lưu mà không hợp lệ (rác từ bản cũ).
    /// Trả true nếu có trường nào bị xóa — caller phải Persist/Upsert
    /// để lần mở panel sau không thấy lại rác.
    /// </summary>
    public static bool SanitizeStoredIdentity(Account acc)
    {
        var changed = false;
        if (!string.IsNullOrWhiteSpace(acc.Email) && !IsValidEmail(acc.Email))
            { acc.Email = null; changed = true; }
        if (!string.IsNullOrWhiteSpace(acc.Username) && !IsValidUsername(acc.Username))
            { acc.Username = null; changed = true; }
        return changed;
    }
}
