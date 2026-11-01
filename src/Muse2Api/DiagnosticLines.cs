namespace Muse2Api;

/// <summary>
/// Dòng tóm tắt chẩn đoán ghi ra stdout gateway (v0.8.3) để user sao
/// chép được từ Output > Muse Gateway. Popup đồng bộ vốn đã có hai con
/// số thread/link nhưng trôi nhanh nên dòng log này là bản ghi bền.
/// <para>
/// QUY TẮC RIÊNG TƯ CỨNG: các dòng này chỉ chứa id tài khoản, số lượng,
/// tên bước và cờ — KHÔNG BAO GIỜ chứa email/phone/username, tiêu đề
/// thread hay URL thread.
/// </para>
/// </summary>
public static class DiagnosticLines
{
    private static string Bool(bool v) => v ? "true" : "false";

    /// <summary>
    /// Một lần quét web-threads: số thread/link đọc được, trang đã mở
    /// (trang chủ hoặc /thread/new) và cờ gợi ý chưa đăng nhập.
    /// </summary>
    public static string WebThreadsLine(string accountId, int threadCount, int linkCount,
        string pageUrl, bool loginHint)
        => $"web_threads account={accountId} threads={threadCount} links={linkCount} page={pageUrl} login_hint={Bool(loginHint)}";

    /// <summary>
    /// Một lần profile-refresh: có lấy được hồ sơ không, các bước đã
    /// thử/thành công/thất bại (chỉ tên bước), cờ menu/cài đặt và số
    /// candidate đọc được.
    /// </summary>
    public static string ProfileRefreshLine(string accountId, bool found, ProfileDebug debug)
        => $"profile_refresh account={accountId} found={Bool(found)}"
            + $" attempted={string.Join(",", debug.Attempted)}"
            + $" succeeded={string.Join(",", debug.Succeeded)}"
            + $" failed={string.Join(",", debug.Failed)}"
            + $" menu_opened={Bool(debug.MenuOpened)}"
            + $" settings_opened={Bool(debug.SettingsOpened)}"
            + $" candidates={debug.CandidateCount}";

    // Nguồn/giá trị hiển thị cho một trường trong dòng profile_detail:
    // giá trị chấp nhận thì nguồn là bước:trường của nó; chỉ có rác bị
    // loại thì nguồn kèm ":rejected" và giá trị là rác đó; không có gì
    // thì "-". Dòng này CÓ chứa giá trị thật nên chỉ in ra stdout
    // gateway cục bộ (Output > Muse Gateway), không đưa vào JSON debug,
    // popup hay panel Cài đặt.
    private static string DetailSource(string? detail, string? rejectedSource)
        => detail ?? rejectedSource ?? "-";

    private static string DetailValue(string? value, string? rejectedValue)
        => value ?? rejectedValue ?? "-";

    /// <summary>
    /// Dòng chi tiết mapping hồ sơ (v0.8.3): trường nào map vào
    /// email/username/phone, từ bước và trường nguồn nào, với giá trị
    /// khớp được nào. Chỉ dùng cho chẩn đoán ở log Output cục bộ.
    /// </summary>
    public static string ProfileDetailLine(string accountId,
        string? email, string? emailDetail, string? emailRejectedSource, string? emailRejectedValue,
        string? username, string? usernameDetail, string? usernameRejectedSource, string? usernameRejectedValue,
        string? phone, string? phoneDetail)
        => $"profile_detail account={accountId}"
            + $" email={(email is null ? "not_found" : "found")}"
            + $" email_source={DetailSource(emailDetail, emailRejectedSource)}"
            + $" email_value={DetailValue(email, emailRejectedValue)}"
            + $" username={(username is null ? "not_found" : "found")}"
            + $" username_source={DetailSource(usernameDetail, usernameRejectedSource)}"
            + $" username_value={DetailValue(username, usernameRejectedValue)}"
            + $" phone={(phone is null ? "not_found" : "found")}"
            + $" phone_source={phoneDetail ?? "-"}"
            + $" phone_value={phone ?? "-"}";
}
