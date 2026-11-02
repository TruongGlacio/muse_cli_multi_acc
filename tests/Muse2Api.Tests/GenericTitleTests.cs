// Test v0.8.13 cho kiểm tra tiêu đề chung của app Muse.
// Chỉ test logic thuần trong DiagnosticLines (không cần browser thật):
// - IsGenericWebTitle: mọi biến thể Chat/Muse/Chat-Muse đều bị loại,
//   tiêu đề thật giữ nguyên.
// - CleanThreadTitle / CleanProbeButtonTitle: tiêu đề chung ở mọi
//   dạng đều về null, tiêu đề thật giữ nguyên.
// Đường quét anchor thật trên trang muse.ai và endpoint HTTP đầy đủ
// vẫn cần Windows + browser thật nên không có trong file này.
using Xunit;

namespace Muse2Api.Tests;

public class GenericTitleTests
{
    [Theory]
    [InlineData("Chat")]
    [InlineData("Muse")]
    [InlineData("Chat - Muse")]
    [InlineData("Chat-Muse")]
    [InlineData("Chat—Muse")]
    [InlineData("Chat | Muse")]
    [InlineData("chatmuse")]
    [InlineData("CHAT-MUSE")]
    [InlineData("  Chat - Muse  ")]
    public void IsGeneric_AllVariants_AreGeneric(string title)
    {
        Assert.True(DiagnosticLines.IsGenericWebTitle(title));
    }

    [Theory]
    [InlineData("Đọc repo muse-cli trên github")]
    [InlineData("Kế hoạch tuần")]
    [InlineData("History of Rome")]
    [InlineData("Chuyến đi lịch sử")]
    public void IsGeneric_RealTitles_AreNotGeneric(string title)
    {
        Assert.False(DiagnosticLines.IsGenericWebTitle(title));
    }

    [Theory]
    [InlineData("Chat")]
    [InlineData("Muse")]
    [InlineData("Chat - Muse")]
    [InlineData("Chat-Muse")]
    [InlineData("Chat—Muse")]
    [InlineData("Chat | Muse")]
    [InlineData("chatmuse")]
    public void CleanThreadTitle_GenericVariants_ReturnNull(string title)
    {
        Assert.Null(DiagnosticLines.CleanThreadTitle(title));
    }

    [Fact]
    public void CleanThreadTitle_RealTitleWithSuffix_KeepsRealPart()
    {
        Assert.Equal("Kế hoạch tuần", DiagnosticLines.CleanThreadTitle("Kế hoạch tuần - Muse"));
    }

    [Fact]
    public void CleanThreadTitle_RealTitle_Unchanged()
    {
        Assert.Equal("Đọc repo muse-cli trên github", DiagnosticLines.CleanThreadTitle("Đọc repo muse-cli trên github"));
    }

    [Theory]
    [InlineData("Chat")]
    [InlineData("Muse")]
    [InlineData("Chat - Muse")]
    [InlineData("Chat-Muse")]
    [InlineData("Chat—Muse")]
    [InlineData("Chat | Muse")]
    public void CleanProbeButtonTitle_GenericVariants_ReturnNull(string title)
    {
        Assert.Null(DiagnosticLines.CleanProbeButtonTitle(title));
    }

    [Fact]
    public void CleanProbeButtonTitle_RealTitle_Unchanged()
    {
        Assert.Equal("Đọc repo muse-cli trên github", DiagnosticLines.CleanProbeButtonTitle("Đọc repo muse-cli trên github"));
    }

    [Fact]
    public void CleanProbeButtonTitle_ControlLabel_StillRejected()
    {
        Assert.Null(DiagnosticLines.CleanProbeButtonTitle("History"));
        Assert.Null(DiagnosticLines.CleanProbeButtonTitle("Lịch sử"));
    }
}
