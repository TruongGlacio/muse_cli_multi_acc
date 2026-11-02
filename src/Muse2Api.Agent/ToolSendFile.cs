namespace Muse2Api.Agent;

/// <summary>One file ready to send to the web conversation, mirroring the
/// gateway's file-part contract ({type:"file", file:{filename, mime,
/// data_url}}). Bytes travel only through this part, never through the
/// tool-result text, so the gateway can Attach them like the extension's
/// send_file (v0.8.20) without any gateway change.</summary>
public sealed record SentFileAttachment(string Filename, string Mime, string DataUrl);

public sealed partial class ToolExecutor
{
    // Same web limit as the gateway (AppState.MaxFileBytes): 25,000,000
    // bytes decimal, not 25 MiB. Checked here so an oversize file fails
    // with a clear local error instead of a gateway rejection after the
    // bytes were already read.
    public const long MaxSendFileBytes = 25_000_000;

    /// <summary>Set only when the latest send_file succeeded, mirroring
    /// LastComputerImage: AgentLoop attaches it to that call's tool-result
    /// message and to nothing else.</summary>
    public SentFileAttachment? LastSentFile { get; private set; }

    public async Task<string> SendFileAsync(string path, CancellationToken cancel = default)
    {
        LastSentFile = null;
        var full = Resolve(path);
        if (Directory.Exists(full)) return $"error: path is a directory, not a file: {path}";
        if (!File.Exists(full)) return $"error: file not found: {path}";
        var info = new FileInfo(full);
        if (info.Length == 0) return $"error: file is empty: {path}";
        if (info.Length > MaxSendFileBytes) return $"error: file exceeds 25 MB (web limit): {path}";
        var bytes = await File.ReadAllBytesAsync(full, cancel);
        var mime = MimeForExtension(Path.GetExtension(full));
        LastSentFile = new SentFileAttachment(Path.GetFileName(full), mime,
            $"data:{mime};base64,{Convert.ToBase64String(bytes)}");
        var relative = Path.GetRelativePath(Root, full).Replace('\\', '/');
        return $"sent file: {relative} ({bytes.Length} bytes, {mime})";
    }

    private static string MimeForExtension(string extension) => extension.ToLowerInvariant() switch
    {
        ".mp4" => "video/mp4",
        ".mov" => "video/quicktime",
        ".webm" => "video/webm",
        ".png" => "image/png",
        ".jpg" or ".jpeg" => "image/jpeg",
        ".webp" => "image/webp",
        ".gif" => "image/gif",
        ".pdf" => "application/pdf",
        ".zip" => "application/zip",
        _ => "application/octet-stream",
    };
}
