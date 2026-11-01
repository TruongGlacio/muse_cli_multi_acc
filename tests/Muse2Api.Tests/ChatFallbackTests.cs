// Test v0.8.12 cho đường fallback thô của ChatStream (không cần browser
// thật): quyết định trả/không trả chỉ xét lastText và độ ổn định, cố ý
// KHÔNG xét localReplyBound, userKey hay replyAfterUser — chính các
// kiểm tra gắn đó là điểm hay hỏng khi DOM thay đổi nên từ 0.8.12
// chúng không còn là điều kiện để được trả phản hồi.
// Việc Cancel vẫn kết thúc vòng lặp được kiểm chứng bằng code (vòng
// lặp gọi req.Cancel.ThrowIfCancellationRequested() mỗi poll và
// Task.Delay truyền req.Cancel; iterator không cho phép try-catch quanh
// yield nên dòng chẩn đoán user_stop được ghi trong finally khi
// !finished và Cancel đã được yêu cầu) chứ không bằng test browser.

namespace Muse2Api.Tests;

public class ChatFallbackTests
{
    [Fact]
    public void RawFallbackCandidate_NonEmptyDifferentFromBaseline_IsCandidate()
    {
        Assert.True(DiagnosticLines.IsRawFallbackCandidate("Câu trả lời dài từ web", "Câu cũ"));
    }

    [Fact]
    public void RawFallbackCandidate_Empty_IsNotCandidate()
    {
        Assert.False(DiagnosticLines.IsRawFallbackCandidate("", "Câu cũ"));
        Assert.False(DiagnosticLines.IsRawFallbackCandidate(null, "Câu cũ"));
    }

    [Fact]
    public void RawFallbackCandidate_EqualToBaseline_IsNotCandidate()
    {
        Assert.False(DiagnosticLines.IsRawFallbackCandidate("Giống baseline", "Giống baseline"));
    }

    [Fact]
    public void ShouldReturnRawFallback_StableFourPolls_Returns()
    {
        // Trường hợp user chốt: bound=false, userKey không khớp,
        // replyAfterUser=false — nhưng hàm này cố ý không nhận các
        // tham số đó nên chúng không thể chặn việc trả nữa; chỉ cần
        // lastText ổn định khác baseline.
        Assert.True(DiagnosticLines.ShouldReturnRawFallback("Câu trả lời dài từ web", "Câu cũ", stablePolls: 4));
    }

    [Fact]
    public void ShouldReturnRawFallback_Unstable_DoesNotReturn()
    {
        Assert.False(DiagnosticLines.ShouldReturnRawFallback("Câu trả lời dài từ web", "Câu cũ", stablePolls: 3));
        Assert.False(DiagnosticLines.ShouldReturnRawFallback("Câu trả lời dài từ web", "Câu cũ", stablePolls: 0));
    }

    [Fact]
    public void ShouldReturnRawFallback_EmptyOrBaseline_DoesNotReturnEvenIfStable()
    {
        Assert.False(DiagnosticLines.ShouldReturnRawFallback("", "Câu cũ", stablePolls: 10));
        Assert.False(DiagnosticLines.ShouldReturnRawFallback("Giống baseline", "Giống baseline", stablePolls: 10));
    }

    [Fact]
    public void ShouldReturnRawFallback_LongerStable_Returns()
    {
        Assert.True(DiagnosticLines.ShouldReturnRawFallback("Câu trả lời dài từ web", "Câu cũ", stablePolls: 9));
    }
}
