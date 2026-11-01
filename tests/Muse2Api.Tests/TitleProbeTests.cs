// Test v0.8.12 cho các hàm thuần của thăm dò/cập nhật tiêu đề hội thoại.
// Chỉ test logic thuần trong DiagnosticLines (không cần browser thật):
// - ShouldProbeForTitles: khi nào ListWebThreads chạy thăm dò nút.
// - ApplyProbeTitle: title nút ghi đè title cũ của thread đã có.
// - ParseForceTitlesQuery: tham số ?forceTitles= của endpoint web-threads.
// Đường bấm nút thật trên trang muse.ai và endpoint HTTP đầy đủ vẫn cần
// Windows + browser thật nên không có trong file này (xem README).

namespace Muse2Api.Tests;

public class TitleProbeTests
{
    [Fact]
    public void ShouldProbe_ForceTitles_ProbesEvenWithRealTitles()
    {
        var threads = new List<(string Url, string? Title)>
            { ("https://muse.ai/thread/abc", "Tiêu đề thật") };
        Assert.True(DiagnosticLines.ShouldProbeForTitles(threads, forceTitles: true));
    }

    [Fact]
    public void ShouldProbe_ZeroThreads_Probes()
    {
        Assert.True(DiagnosticLines.ShouldProbeForTitles(new List<(string Url, string? Title)>(), forceTitles: false));
    }

    [Fact]
    public void ShouldProbe_EmptyTitle_Probes()
    {
        var threads = new List<(string Url, string? Title)>
        {
            ("https://muse.ai/thread/abc", "Tiêu đề thật"),
            ("https://muse.ai/thread/def", ""),
        };
        Assert.True(DiagnosticLines.ShouldProbeForTitles(threads, forceTitles: false));
    }

    [Fact]
    public void ShouldProbe_NullTitle_Probes()
    {
        var threads = new List<(string Url, string? Title)>
            { ("https://muse.ai/thread/abc", null) };
        Assert.True(DiagnosticLines.ShouldProbeForTitles(threads, forceTitles: false));
    }

    [Fact]
    public void ShouldProbe_AllRealTitles_NoForce_DoesNotProbe()
    {
        var threads = new List<(string Url, string? Title)>
        {
            ("https://muse.ai/thread/abc", "Tiêu đề thật"),
            ("https://muse.ai/thread/def", "Tiêu đề khác"),
        };
        Assert.False(DiagnosticLines.ShouldProbeForTitles(threads, forceTitles: false));
    }

    [Fact]
    public void ApplyProbeTitle_NewUrl_Appends()
    {
        var found = new List<(string Url, string? Title)>
            { ("https://muse.ai/thread/abc", "Cũ") };
        Assert.True(DiagnosticLines.ApplyProbeTitle(found, "https://muse.ai/thread/def", "Mới"));
        Assert.Equal(2, found.Count);
        Assert.Equal("Mới", found[1].Title);
    }

    [Fact]
    public void ApplyProbeTitle_ExistingUrl_OverwritesOldTitle()
    {
        var found = new List<(string Url, string? Title)>
            { ("https://muse.ai/thread/abc", "Anchor cũ") };
        Assert.True(DiagnosticLines.ApplyProbeTitle(found, "https://muse.ai/thread/abc", "Đọc repo muse-cli trên github"));
        Assert.Single(found);
        Assert.Equal("Đọc repo muse-cli trên github", found[0].Title);
    }

    [Fact]
    public void ApplyProbeTitle_ExistingUrl_EmptyOldTitle_Overwrites()
    {
        var found = new List<(string Url, string? Title)>
            { ("https://muse.ai/thread/abc", "") };
        Assert.True(DiagnosticLines.ApplyProbeTitle(found, "https://muse.ai/thread/abc", "Tiêu đề nút"));
        Assert.Equal("Tiêu đề nút", found[0].Title);
    }

    [Fact]
    public void ApplyProbeTitle_NullTitle_KeepsOldTitle()
    {
        var found = new List<(string Url, string? Title)>
            { ("https://muse.ai/thread/abc", "Cũ") };
        Assert.False(DiagnosticLines.ApplyProbeTitle(found, "https://muse.ai/thread/abc", null));
        Assert.Equal("Cũ", found[0].Title);
    }

    [Fact]
    public void ApplyProbeTitle_SameTitle_NoChange()
    {
        var found = new List<(string Url, string? Title)>
            { ("https://muse.ai/thread/abc", "Giống nhau") };
        Assert.False(DiagnosticLines.ApplyProbeTitle(found, "https://muse.ai/thread/abc", "Giống nhau"));
        Assert.Single(found);
    }

    [Fact]
    public void ApplyProbeTitle_UrlMatch_IsCaseInsensitive()
    {
        var found = new List<(string Url, string? Title)>
            { ("https://muse.ai/thread/ABC", "Cũ") };
        Assert.True(DiagnosticLines.ApplyProbeTitle(found, "https://muse.ai/thread/abc", "Mới"));
        Assert.Single(found);
        Assert.Equal("Mới", found[0].Title);
    }

    [Theory]
    [InlineData("true", true)]
    [InlineData("TRUE", true)]
    [InlineData("1", true)]
    [InlineData("false", false)]
    [InlineData("0", false)]
    [InlineData("yes", false)]
    [InlineData("", false)]
    [InlineData(null, false)]
    public void ParseForceTitlesQuery_OnlyTrueOrOne(string? value, bool expected)
    {
        Assert.Equal(expected, DiagnosticLines.ParseForceTitlesQuery(value));
    }
}
