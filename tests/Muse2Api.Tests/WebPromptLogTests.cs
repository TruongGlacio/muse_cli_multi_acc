// Test v0.8.16 cho log chẩn đoán web_prompt.
// Chỉ test logic thuần trong WebPromptLog (không cần browser thật):
// - Header đúng dạng, đủ trường, không chứa nội dung prompt.
// - Ngưỡng file: <= 20000 ký tự thì không ghi file, > 20000 thì ghi.
// - Preview prompt dài: đúng 10000 đầu + 5000 cuối, không cắt đôi
//   cặp surrogate (emoji ở biên).
// - Tách dòng: giữ dòng rỗng, bỏ \r cuối dòng (\r\n).
// Việc BrowserDriver log đúng chuỗi Send() và phía extension tách
// dòng body ra khỏi ring buffer được kiểm chứng bằng harness mô
// phỏng + kiểm tra tĩnh (điểm submit thật cần browser + tài khoản
// thật nên không có trong file này).
using Xunit;

namespace Muse2Api.Tests;

public class WebPromptLogTests
{
    [Fact]
    public void Header_HasAllFields_AndNoPromptContent()
    {
        var h = WebPromptLog.Header("acc_1", "openai-tools", "muse-chat", 123, 4, "reused", 2, "-");
        Assert.Equal("web_prompt account=acc_1 mode=openai-tools model=muse-chat chars=123 turns=4 thread=reused images=2 file=-", h);
        Assert.DoesNotContain("hello prompt", h);
    }

    [Theory]
    [InlineData("normal")]
    [InlineData("local")]
    [InlineData("openai-tools")]
    public void Header_Modes_PassThrough(string mode)
    {
        Assert.Contains($"mode={mode}", WebPromptLog.Header("a", mode, "muse-chat", 1, 1, "new", 0, "-"));
    }

    [Fact]
    public void NeedsFile_Threshold_Is20000()
    {
        Assert.False(WebPromptLog.NeedsFile(new string('x', 20000)));
        Assert.True(WebPromptLog.NeedsFile(new string('x', 20001)));
    }

    [Fact]
    public void Preview_LongPrompt_Head10000_Tail5000()
    {
        var prompt = new string('a', 10000) + new string('b', 10000) + new string('c', 5000);
        Assert.Equal(25000, prompt.Length);
        var (head, tail) = WebPromptLog.Preview(prompt);
        Assert.Equal(10000, head.Length);
        Assert.Equal(new string('a', 10000), head);
        Assert.Equal(5000, tail.Length);
        Assert.Equal(new string('c', 5000), tail);
    }

    [Fact]
    public void Preview_ShortPrompt_ReturnsFull_AsHead()
    {
        var (head, tail) = WebPromptLog.Preview("hello");
        Assert.Equal("hello", head);
        Assert.Equal("", tail);
    }

    [Fact]
    public void SafeSlice_DoesNotSplitSurrogatePair_AtHeadEnd()
    {
        // 9999 ký tự 'x' + một emoji (2 code unit) ở vị trí 9999-10000:
        // cắt 10000 ký tự không được để lại high surrogate lẻ ở cuối.
        var text = new string('x', 9999) + "😀" + new string('y', 10);
        var head = WebPromptLog.SafeSlice(text, 0, 10000);
        Assert.Equal(9999, head.Length);
        Assert.DoesNotContain("😀", head);
    }

    [Fact]
    public void SafeSlice_DoesNotSplitSurrogatePair_AtTailStart()
    {
        // Tail bắt đầu ngay giữa cặp surrogate thì phải lùi về đầu cặp.
        var text = new string('x', 10) + "😀" + new string('y', 10);
        var tail = WebPromptLog.SafeSlice(text, 11, 5);
        Assert.StartsWith("😀", tail);
    }

    [Fact]
    public void SplitLines_KeepsEmptyLines_StripsCarriageReturn()
    {
        var lines = WebPromptLog.SplitLines("a\r\n\r\nb\n");
        Assert.Equal(new[] { "a", "", "b", "" }, lines);
    }

    [Fact]
    public void FileName_HasTimestampAndShortId()
    {
        var name = WebPromptLog.FileName(new DateTime(2026, 11, 2, 9, 47, 0), "abcd1234");
        Assert.Equal("web_prompt_20261102_094700_abcd1234.txt", name);
    }

    [Fact]
    public void TruncatedLine_HasCountsAndFile()
    {
        var line = WebPromptLog.TruncatedLine(25000, 15000, "/data/prompts/f.txt");
        Assert.Equal("web_prompt_truncated chars=25000 shown=15000 file=/data/prompts/f.txt", line);
    }

    [Fact]
    public void BodyPrefix_IsStable_ForExtensionRouting()
    {
        // Extension tách dòng body ra khỏi ring buffer bằng đúng tiền tố
        // này; đổi tiền tố ở đây mà không đổi gateway.ts sẽ làm prompt
        // tràn lại ring buffer, nên test khóa giá trị này.
        Assert.Equal("web_prompt_body ", WebPromptLog.BodyPrefix);
    }
}
