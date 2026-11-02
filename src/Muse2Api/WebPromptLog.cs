namespace Muse2Api;

/// <summary>
/// Log chẩn đoán web_prompt (v0.8.16): ghi đúng prompt cuối cùng mà
/// gateway đưa lên trang muse.ai, để user tự đối chiếu với câu trả lời
/// (kể cả câu từ chối) của model web.
/// <para>
/// Đây là ngoại lệ có chủ ý so với quy tắc "log chỉ đếm số lượng" của
/// các dòng [local] khác, theo yêu cầu tường minh của user: nội dung
/// prompt là dữ liệu của chính user trên chính máy user, chỉ nằm ở
/// Output local và (khi prompt dài) file local dưới thư mục dữ liệu
/// của gateway, không gửi đi đâu. Hàm trong file này là thuần (không
/// I/O, không key/cookie/token) để test đơn vị được; việc ghi file và
/// phát dòng log nằm ở BrowserDriver.
/// </para>
/// <para>
/// Quy tắc chống flood: prompt dài hơn <see cref="FullLimit"/> ký tự
/// thì Output chỉ nhận preview (đầu + cuối), toàn văn ghi ra file.
/// Nội dung prompt KHÔNG bao giờ vào ring buffer/panel Nhật ký của
/// extension: phía extension chỉ đẩy dòng header/dòng đường dẫn vào
/// buffer, còn các dòng nội dung (tiền tố "web_prompt_body ") chỉ ra
/// Output (xem GatewayManager, handler stdout của gateway kèm theo).
/// </para>
/// </summary>
public static class WebPromptLog
{
    /// <summary>Prompt dài hơn ngưỡng này thì chỉ in preview + ghi file.</summary>
    public const int FullLimit = 20000;

    /// <summary>Số ký tự đầu giữ lại trong preview của prompt dài.</summary>
    public const int HeadChars = 10000;

    /// <summary>Số ký tự cuối giữ lại trong preview của prompt dài.</summary>
    public const int TailChars = 5000;

    /// <summary>Tiền tố dòng nội dung prompt (sau tiền tố "[local] " của LogLocal).</summary>
    public const string BodyPrefix = "web_prompt_body ";

    /// <summary>
    /// Prompt có cần ghi file toàn văn không (chỉ prompt dài mới ghi).
    /// </summary>
    public static bool NeedsFile(string prompt) => prompt.Length > FullLimit;

    /// <summary>
    /// Dòng header web_prompt (đi vào cả Output lẫn ring buffer/panel):
    /// chỉ số liệu + đường dẫn file, không chứa nội dung prompt.
    /// <paramref name="file"/> là đường dẫn file toàn văn, "-" khi
    /// prompt ngắn (không ghi file), "write_failed" khi ghi file lỗi.
    /// </summary>
    public static string Header(string accountId, string mode, string model, int chars, int turns, string thread, int images, string file)
        => $"web_prompt account={accountId} mode={mode} model={model} chars={chars} turns={turns} thread={thread} images={images} file={file}";

    /// <summary>
    /// Dòng đánh dấu preview bị cắt (đi vào cả Output lẫn ring buffer).
    /// </summary>
    public static string TruncatedLine(int chars, int shown, string file)
        => $"web_prompt_truncated chars={chars} shown={shown} file={file}";

    /// <summary>
    /// Tên file toàn văn cho prompt dài: web_prompt_yyyyMMdd_HHmmss_xxxxxxxx.txt.
    /// </summary>
    public static string FileName(DateTime when, string shortId)
        => $"web_prompt_{when:yyyyMMdd_HHmmss}_{shortId}.txt";

    /// <summary>
    /// Cắt an toàn một đoạn chuỗi: không bao giờ cắt đôi một cặp
    /// surrogate (emoji/ký tự ngoài BMP) ở biên. Trả về đoạn
    /// [start, start + length) đã điều chỉnh biên cho hợp lệ.
    /// </summary>
    public static string SafeSlice(string text, int start, int length)
    {
        if (text.Length == 0 || length <= 0) return "";
        start = Math.Clamp(start, 0, text.Length);
        var end = Math.Clamp(start + length, 0, text.Length);
        // Biên đầu rơi vào giữa cặp surrogate (ký tự đầu là low
        // surrogate mà ký tự trước là high surrogate) thì lùi về đầu cặp.
        if (start > 0 && start < text.Length
            && char.IsLowSurrogate(text[start]) && char.IsHighSurrogate(text[start - 1]))
            start--;
        // Biên cuối rơi vào giữa cặp surrogate (ký tự cuối là high
        // surrogate mà ký tự sau là low surrogate) thì bỏ ký tự lẻ đó.
        if (end > start && end < text.Length
            && char.IsHighSurrogate(text[end - 1]) && char.IsLowSurrogate(text[end]))
            end--;
        return text[start..end];
    }

    /// <summary>
    /// Preview của prompt dài: (phần đầu, phần cuối). Prompt ngắn thì
    /// trả (toàn bộ, "") — caller chỉ dùng phần cuối khi NeedsFile.
    /// </summary>
    public static (string Head, string Tail) Preview(string prompt)
    {
        if (!NeedsFile(prompt)) return (prompt, "");
        return (SafeSlice(prompt, 0, HeadChars), SafeSlice(prompt, prompt.Length - TailChars, TailChars));
    }

    /// <summary>
    /// Tách prompt thành các dòng để phát qua Diagnostic (mỗi dòng một
    /// lần Invoke). Dòng rỗng giữ nguyên thành "" để phía extension
    /// vẫn in ra dòng trống, không làm lệch cấu trúc preview.
    /// Ký tự \r cuối dòng (prompt dùng \r\n) được bỏ.
    /// </summary>
    public static List<string> SplitLines(string text)
    {
        var lines = new List<string>();
        foreach (var raw in text.Split('\n'))
            lines.Add(raw.EndsWith('\r') ? raw[..^1] : raw);
        return lines;
    }
}
