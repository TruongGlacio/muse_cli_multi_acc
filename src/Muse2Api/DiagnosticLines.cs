namespace Muse2Api;

/// <summary>
/// Dòng tóm tắt chẩn đoán ghi ra stdout gateway (v0.8.3) để user sao
/// chép được từ Output > Muse Gateway. Popup đồng bộ vốn đã có hai con
/// số thread/link nhưng trôi nhanh nên dòng log này là bản ghi bền.
/// <para>
/// QUY TẮC RIÊNG TƯ: các dòng TÓM TẮT (web_threads, profile_refresh)
/// chỉ chứa id tài khoản, số lượng, tên bước và cờ — KHÔNG BAO GIỜ
/// chứa email/phone/username, tiêu đề thread hay URL thread. Riêng
/// dòng CHI TIẾT profile_detail thì CÓ chứa giá trị khớp được thật
/// (theo yêu cầu chẩn đoán mapping của user) nên nó chỉ in ra stdout
/// gateway cục bộ, không đưa vào JSON debug, popup hay panel Cài đặt.
/// </para>
/// </summary>
public static class DiagnosticLines
{
    private static string Bool(bool v) => v ? "true" : "false";

    /// <summary>
    /// Một lần quét web-threads (v0.8.3, mở rộng v0.8.5): số thread/
    /// link đọc được, cờ gợi ý chưa đăng nhập, và chẩn đoán RIÊNG
    /// từng trang (trang chủ + /thread/new). Trước v0.8.5 chỉ ghi
    /// trang cuối nên số liệu trang chủ bị mất khi chuyển sang trang
    /// thứ hai — đúng trường hợp popup của user: trang cuối là
    /// /thread/new với 1 link, không biết trang chủ ra sao.
    /// QUY TẮC RIÊNG TƯ (v0.8.5): dòng này chỉ chứa số lượng, URL
    /// trang đã quét (trang chủ//thread/new, không phải URL thread),
    /// tiêu đề chung của app (đã cắt 80 ký tự) và các cờ — KHÔNG
    /// tiêu đề hội thoại, KHÔNG nội dung trang, KHÔNG URL thread.
    /// </summary>
    public static string WebThreadsLine(string accountId, WebThreadsScan scan)
    {
        var pages = scan.Pages is { Count: > 0 } ? scan.Pages : new List<WebThreadsPageDiag>
        {
            new(scan.PageUrl, scan.Threads.Count, scan.LinkCount, scan.Title, scan.HasLoginForm, scan.ButtonCount, false),
        };
        var pageParts = pages.Select((p, i) =>
            $"{(i == 0 ? "home" : "new")}"
            + $"[page={p.PageUrl} threads={p.Threads} links={p.Links}"
            + $" title={TruncateTitle(p.Title)} login_form={Bool(p.HasLoginForm)}"
            + $" buttons={p.Buttons} sidebar_clicked={Bool(p.SidebarClicked)}]");
        return $"web_threads account={accountId} threads={scan.Threads.Count} links={scan.LinkCount}"
            + $" login_hint={Bool(scan.LoginHint)} pages={string.Join(" ", pageParts)}";
    }

    /// <summary>Tiêu đề trang chung, cắt 80 ký tự (v0.8.5).</summary>
    public static string TruncateTitle(string? title)
    {
        var t = (title ?? "").Replace('\n', ' ').Replace('\r', ' ').Trim();
        return t.Length > 80 ? t[..80] : t;
    }

    /// <summary>
    /// Tín hiệu hết hạn (v0.8.5): gợi ý đăng nhập bằng chữ HOẶC form
    /// đăng nhập (input password/email). Trước đây chỉ có chữ nên
    /// trang chỉ hiện form mà không có chữ gợi ý sẽ im lặng trả 0.
    /// </summary>
    public static bool HasLoginSignal(bool textHint, bool hasLoginForm) => textHint || hasLoginForm;

    /// <summary>
    /// Quét nào tốt hơn (v0.8.5, cho bước bấm mở sidebar): nhiều
    /// thread hơn thì thắng; hòa thread thì nhiều link hơn thắng.
    /// </summary>
    public static bool IsBetterScan(WebThreadsScan candidate, WebThreadsScan baseline)
        => candidate.Threads.Count != baseline.Threads.Count
            ? candidate.Threads.Count > baseline.Threads.Count
            : candidate.LinkCount > baseline.LinkCount;

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
            + $" candidates={debug.CandidateCount}"
            // v0.8.4: lý do bước home thất bại (chỉ tên loại, không giá trị).
            + $" home_error={debug.HomeError ?? "-"}";

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
    /// v0.8.4 thêm home_error và api_calls (các path /api/* quan sát
    /// được từ request của trang — chỉ path, không query/body/header/
    /// cookie/response — để phát hiện API, chưa dùng API mới nào).
    /// v0.8.5 thêm muse_user_id + nguồn: id người dùng Muse dạng UUID
    /// từ API phiên, dùng làm khóa định danh nội bộ (không phải
    /// username hiển thị). Id nội bộ không phải mật khẩu hay cookie
    /// nên in ở log Output cục bộ là được, như các giá trị khác của
    /// dòng này; vẫn KHÔNG đưa vào JSON debug, popup hay panel.
    /// </summary>
    public static string ProfileDetailLine(string accountId,
        string? email, string? emailDetail, string? emailRejectedSource, string? emailRejectedValue,
        string? username, string? usernameDetail, string? usernameRejectedSource, string? usernameRejectedValue,
        string? phone, string? phoneDetail, string? homeError, IReadOnlyList<string>? apiCalls,
        string? museUserId = null, string? museUserIdDetail = null)
        => $"profile_detail account={accountId}"
            + $" email={(email is null ? "not_found" : "found")}"
            + $" email_source={DetailSource(emailDetail, emailRejectedSource)}"
            + $" email_value={DetailValue(email, emailRejectedValue)}"
            + $" username={(username is null ? "not_found" : "found")}"
            + $" username_source={DetailSource(usernameDetail, usernameRejectedSource)}"
            + $" username_value={DetailValue(username, usernameRejectedValue)}"
            + $" phone={(phone is null ? "not_found" : "found")}"
            + $" phone_source={phoneDetail ?? "-"}"
            + $" phone_value={phone ?? "-"}"
            // v0.8.4: lý do bước home thất bại (chỉ tên loại, không giá trị).
            + $" home_error={homeError ?? "-"}"
            // v0.8.4: các đường dẫn /api/* quan sát được từ request của
            // trang trong lúc fetch (chỉ path đã bỏ query, đã khử trùng,
            // theo thứ tự quan sát; không có thì "none"). Chỉ phục vụ
            // phát hiện API, không phải dữ liệu hồ sơ.
            + $" api_calls={(apiCalls is null || apiCalls.Count == 0 ? "none" : string.Join(",", apiCalls))}"
            // v0.8.5: id người dùng Muse + nguồn (session_api:name hoặc
            // session_api:username khi khóa đó dạng UUID; không có thì
            // "not_found"/"-").
            + $" muse_user_id={(museUserId is null ? "not_found" : museUserId)}"
            + $" muse_user_id_source={museUserIdDetail ?? "-"}";
}
