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
            new(scan.PageUrl, scan.Threads.Count, scan.LinkCount, scan.Title, scan.HasLoginForm, scan.ButtonCount, false, scan.Threads.Count, scan.LinkCount),
        };
        var pageParts = pages.Select((p, i) =>
            $"{(i == 0 ? "home" : "new")}"
            + $"[page={p.PageUrl} threads={p.Threads} links={p.Links}"
            + $" base_threads={p.BaselineThreads} base_links={p.BaselineLinks}"
            + $" title={TruncateTitle(p.Title)} login_form={Bool(p.HasLoginForm)}"
            + $" buttons={p.Buttons} sidebar_clicked={Bool(p.SidebarClicked)}"
            + $" probed={Bool(p.Probed)}"
            + $" groups=thread={(p.Groups?.ThreadLinks ?? 0)}"
            + $" library={(p.Groups?.LibraryLinks ?? 0)}"
            + $" settings={(p.Groups?.SettingsLinks ?? 0)}"
            + $" other={(p.Groups?.OtherLinks ?? 0)}"
            + $" nohref={(p.Groups?.NoHrefAnchors ?? 0)}"
            + $" aside_nav_buttons={(p.Groups?.AsideNavButtons ?? 0)}"
            + $" labeled_buttons={(p.Groups?.LabeledButtons ?? 0)}"
            + $" history_testids={(p.Groups?.HistoryTestIds ?? 0)}]");
        return $"web_threads account={accountId} threads={scan.Threads.Count} links={scan.LinkCount}"
            + $" login_hint={Bool(scan.LoginHint)} pages={string.Join(" ", pageParts)}";
    }

    /// <summary>Nhóm của một anchor theo mẫu href (v0.8.7, chỉ để đếm).</summary>
    public enum AnchorGroup { NoHref, Thread, Library, Settings, Other }

    /// <summary>
    /// Phân nhóm anchor (v0.8.7, hàm thuần để test đơn vị): không có
    /// href (hoặc href rỗng) thì vào nhóm nohref; href chứa "/thread/"
    /// thì vào nhóm thread (kể cả /thread/new — nhóm này chỉ đếm, số
    /// thread thật vẫn do bước trích IsThread quyết định); tiếp theo
    /// là /library/ rồi /settings/, còn lại vào other. Thứ tự thread
    /// trước library/settings để một URL hiếm khi chứa cả hai mẫu vẫn
    /// được đếm về phía thread.
    /// </summary>
    public static AnchorGroup ClassifyAnchorGroup(bool hasHref, string? href)
    {
        if (!hasHref || string.IsNullOrWhiteSpace(href)) return AnchorGroup.NoHref;
        if (href.Contains("/thread/", StringComparison.Ordinal)) return AnchorGroup.Thread;
        if (href.Contains("/library/", StringComparison.Ordinal)) return AnchorGroup.Library;
        if (href.Contains("/settings/", StringComparison.Ordinal)) return AnchorGroup.Settings;
        return AnchorGroup.Other;
    }

    /// <summary>
    /// Lấy id thread từ URL sau khi bấm nút thăm dò (v0.8.7, hàm thuần):
    /// chỉ chấp nhận https://muse.ai/thread/&lt;id&gt; với id là một đoạn
    /// duy nhất gồm chữ/số/gạch dưới/gạch ngang, khác rỗng và khác
    /// "new". URL có query/fragment thì bỏ phần đó khi ghi nhận (caller
    /// tự ráp lại URL chuẩn từ id). Trả null cho mọi trường hợp còn
    /// lại (kể cả /thread/new, /thread, path lồng nhau, host khác).
    /// </summary>
    public static string? ProbeThreadId(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return null;
        if (!uri.Scheme.Equals("https", StringComparison.OrdinalIgnoreCase)) return null;
        if (!uri.Host.Equals("muse.ai", StringComparison.OrdinalIgnoreCase)) return null;
        var path = uri.AbsolutePath;
        if (!path.StartsWith("/thread/", StringComparison.Ordinal)) return null;
        var id = path["/thread/".Length..].TrimEnd('/');
        if (id.Length == 0 || id.Contains('/')) return null;
        if (id.Equals("new", StringComparison.OrdinalIgnoreCase)) return null;
        foreach (var c in id)
            if (!(char.IsLetterOrDigit(c) || c == '_' || c == '-')) return null;
        return id;
    }

    /// <summary>Kết quả quyết định sau một lần bấm nút thăm dò (v0.8.7).</summary>
    public enum ProbeOutcome
    {
        /// <summary>Gặp tín hiệu hết hạn: dừng toàn bộ vòng thăm dò.</summary>
        StopAuth,
        /// <summary>URL thành thread thật: ghi nhận rồi GoBack.</summary>
        RecordThread,
        /// <summary>URL thành /thread/new: nút tạo mới, GoBack + loại nút.</summary>
        GoBackNew,
        /// <summary>URL vẫn ở khu vực chat nhưng không phải thread
        /// (ví dụ về trang chủ): GoBack + loại nút.</summary>
        GoBackOther,
        /// <summary>URL không đổi: bấm Escape rồi thử nút khác.</summary>
        EscapeUnchanged,
        /// <summary>URL rời khỏi khu vực chat: GoBack ngay, loại nút,
        /// không ghi nhận gì từ trang lạc.</summary>
        GoBackLeftChat,
    }

    /// <summary>
    /// Quyết định sau một lần bấm nút thăm dò (v0.8.7, hàm thuần để
    /// test đơn vị). Thứ tự: tín hiệu hết hạn trước hết; URL không
    /// đổi thì Escape; URL thành thread thật thì ghi nhận; URL thành
    /// /thread/new thì GoBack + loại; URL rời khu vực chat thì GoBack
    /// + loại; còn lại (vẫn ở khu vực chat nhưng không phải thread)
    /// thì GoBack + loại.
    /// </summary>
    public static (ProbeOutcome Outcome, string? ThreadId) DecideProbeOutcome(
        string? beforeUrl, string? afterUrl, bool loginSignal)
    {
        if (loginSignal) return (ProbeOutcome.StopAuth, null);
        if (string.Equals(beforeUrl, afterUrl, StringComparison.Ordinal)) return (ProbeOutcome.EscapeUnchanged, null);
        var threadId = ProbeThreadId(afterUrl);
        if (threadId is not null) return (ProbeOutcome.RecordThread, threadId);
        if (Uri.TryCreate(afterUrl, UriKind.Absolute, out var uri)
            && uri.Host.Equals("muse.ai", StringComparison.OrdinalIgnoreCase)
            && uri.AbsolutePath.TrimEnd('/') == "/thread/new")
            return (ProbeOutcome.GoBackNew, null);
        if (!IsChatAreaUrl(afterUrl)) return (ProbeOutcome.GoBackLeftChat, null);
        return (ProbeOutcome.GoBackOther, null);
    }

    /// <summary>
    /// Làm sạch tiêu đề hội thoại lấy từ document.title của trang
    /// thread (v0.8.8, hàm thuần để test đơn vị): cắt khoảng trắng
    /// hai đầu, bỏ MỘT hậu tố " - Muse" ở cuối nếu có, rồi cắt lại
    /// khoảng trắng. Sau đó nếu còn lại rỗng hoặc chỉ là tiêu đề
    /// chung ("Chat" hoặc "Muse") thì trả null — extension sẽ tự đặt
    /// dự phòng "Hội thoại web &lt;id&gt;" như trước. Tiêu đề thật
    /// (ví dụ "Kế hoạch tuần") giữ nguyên, kể cả khi nó chứa " -
    /// Muse" ở giữa (chỉ hậu tố cuối mới bị bỏ).
    /// </summary>
    public static string? CleanThreadTitle(string? title)
    {
        if (string.IsNullOrWhiteSpace(title)) return null;
        var t = title.Trim();
        const string suffix = " - Muse";
        if (t.EndsWith(suffix, StringComparison.Ordinal))
            t = t[..^suffix.Length].Trim();
        if (t.Length == 0) return null;
        if (t.Equals("Chat", StringComparison.Ordinal)
            || t.Equals("Muse", StringComparison.Ordinal)) return null;
        return t;
    }

    /// <summary>
    /// Dòng log của endpoint thread-messages (v0.8.8): CHỈ số lượng
    /// tin + id tài khoản, KHÔNG nội dung tin, KHÔNG tiêu đề hội
    /// thoại, KHÔNG URL thread. Caller ghi qua LogLocal nên tiền tố
    /// "[local] " do LogLocal thêm, hàm này không tự thêm.
    /// </summary>
    public static string ThreadMessagesLine(string accountId, int count)
        => $"thread_messages account={accountId} count={count}";

    /// <summary>
    /// Cắt một tin nhắn về tối đa <paramref name="maxChars"/> ký tự
    /// (v0.8.8, hàm thuần): tin ngắn hơn hoặc bằng giới hạn giữ
    /// nguyên; tin dài hơn thì cắt để tổng độ dài (kể cả ghi chú)
    /// không vượt giới hạn, ghi chú "[... đã cắt ...]" nằm ở cuối
    /// nội dung bị cắt.
    /// </summary>
    public static string TruncateThreadContent(string content, int maxChars = 8000)
    {
        const string note = "[... đã cắt ...]";
        if (content.Length <= maxChars) return content;
        return content[..Math.Max(0, maxChars - note.Length)] + note;
    }

    /// <summary>
    /// Giới hạn danh sách tin nhắn đã trích theo thứ tự tài liệu
    /// (v0.8.8, hàm thuần): giữ tối đa 200 tin ĐẦU TIÊN theo thứ tự
    /// tài liệu (tin cũ nhất trước), mỗi tin cắt về tối đa 8000 ký
    /// tự kèm ghi chú. Thứ tự user → agent trong danh sách vào được
    /// giữ nguyên, không sắp xếp lại.
    /// </summary>
    public static List<(string Role, string Content)> LimitThreadMessages(
        IEnumerable<(string Role, string Content)> messages)
    {
        var limited = new List<(string Role, string Content)>();
        foreach (var (role, content) in messages)
        {
            if (limited.Count >= 200) break;
            limited.Add((role, TruncateThreadContent(content)));
        }
        return limited;
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
    /// Trang có còn ở khu vực chat không (v0.8.6, chống lạc trang khi
    /// bấm mở sidebar): chỉ chấp nhận host muse.ai và path "/" hoặc
    /// bắt đầu bằng "/thread/". Trang artifact (/library/...), trang
    /// cài đặt hay bất kỳ trang nào khác đều bị coi là đã lạc, dù
    /// trang đó có nhiều link hơn (đúng lỗi 0.8.5: bấm nút "Chatbot
    /// UI" rồi lấy số liệu trang artifact làm kết quả quét).
    /// </summary>
    public static bool IsChatAreaUrl(string? url)
    {
        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri)) return false;
        if (!uri.Host.Equals("muse.ai", StringComparison.OrdinalIgnoreCase)) return false;
        var path = uri.AbsolutePath;
        return path == "/" || path.StartsWith("/thread/", StringComparison.Ordinal);
    }

    /// <summary>
    /// Có chấp nhận kết quả quét lại sau khi bấm sidebar không
    /// (v0.8.6): chỉ khi trang vẫn ở khu vực chat VÀ quét tốt hơn
    /// baseline. Trang đã lạc thì không bao giờ được chấp nhận, kể cả
    /// khi số link tăng (14 link của trang artifact không phải là
    /// "tốt hơn" 1 link của trang chat).
    /// </summary>
    public static bool ShouldAcceptRescan(string? pageUrl, WebThreadsScan rescan, WebThreadsScan baseline)
        => IsChatAreaUrl(pageUrl) && IsBetterScan(rescan, baseline);

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
