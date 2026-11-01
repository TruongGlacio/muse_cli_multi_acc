// Muse2Api.ComputerHelper — helper console THỬ NGHIỆM cho extension VS Code.
//
// Vì sao cần helper riêng: extension VS Code chạy trên Node, không thể load
// DLL net10-windows của Muse2Api.Computer, và API của VS Code không có
// UI Automation hay chụp màn hình desktop. Helper này là một tiến trình
// .NET Windows riêng, giữ một DesktopComputer duy nhất và nói chuyện với
// extension bằng JSON-lines qua stdin/stdout:
//   Request:  {"id":1,"tool":"computer_inspect","arguments":{...}}
//   Response: {"id":1,"ok":true,"result":"...","image_base64":"..."} hoặc
//             {"id":1,"ok":false,"error":"..."}
// Helper KHÔNG tự chọn cửa sổ, KHÔNG tự xin quyền bằng cửa sổ chooser của
// bản desktop: extension là bên chọn cửa sổ (QuickPick từ danh sách) rồi
// gửi computer_select_window, và extension là bên hỏi duyệt từng hành động
// nguy hiểm trước khi gửi. DesktopComputer.RequestAuthorization luôn để
// null trong helper, nên khi chưa chọn cửa sổ, ExecuteAsync sẽ lỗi rõ ràng
// thay vì mở chooser.
//
// Hai điểm khác bản desktop, cố ý và đã ghi trong README của extension:
//  - computer_list_windows ở đây luôn gọi DesktopComputer.ListWindows()
//    tĩnh (liệt kê mọi cửa sổ nhìn thấy, trừ tiến trình của chính helper),
//    kể cả khi đã chọn cửa sổ đích. Bản desktop khi đã chọn cửa sổ thì
//    ExecuteAsync("computer_list_windows") chỉ trả về đúng cửa sổ đích.
//  - Helper không đăng ký phím Esc dừng khẩn cấp (EmergencyHotkey) như bản
//    desktop, vì helper không có cửa sổ WinForms để nhận WM_HOTKEY. Cách
//    dừng: đóng helper từ extension (lệnh "Muse: Dừng điều khiển màn hình")
//    hoặc từ chối ở hộp thoại duyệt của extension trước mỗi hành động.

using System.Text.Json;
using System.Text.Json.Nodes;
using Muse2Api.Agent;
using Muse2Api.Computer;

var computer = new DesktopComputer();
string? line;
while ((line = Console.ReadLine()) is not null)
{
    if (string.IsNullOrWhiteSpace(line)) continue;
    JsonObject? response;
    try
    {
        var request = JsonNode.Parse(line) as JsonObject
            ?? throw new InvalidOperationException("request must be a JSON object");
        var id = request["id"]?.GetValue<int>() ?? 0;
        var tool = request["tool"]?.GetValue<string>() ?? "";
        var callArgs = request["arguments"] as JsonObject ?? new JsonObject();
        try
        {
            var (text, image) = await DispatchAsync(tool, callArgs);
            var ok = new JsonObject { ["id"] = id, ["ok"] = true, ["result"] = text };
            if (image is not null) ok["image_base64"] = image;
            response = ok;
        }
        catch (Exception ex)
        {
            response = new JsonObject
            {
                ["id"] = id,
                ["ok"] = false,
                ["error"] = ex.Message.Length > 1000 ? ex.Message[..1000] : ex.Message,
            };
        }
    }
    catch (Exception ex)
    {
        response = new JsonObject { ["id"] = 0, ["ok"] = false, ["error"] = "bad request: " + ex.Message };
    }
    Console.Out.WriteLine(response.ToJsonString());
    await Console.Out.FlushAsync();

    async Task<(string Text, string? ImageBase64)> DispatchAsync(string tool, JsonObject callArgs)
    {
        switch (tool)
        {
            case "computer_list_windows":
                return (JsonSerializer.Serialize(DesktopComputer.ListWindows()), null);
            case "computer_select_window": {
                var handle = callArgs["handle"]?.GetValue<long>() ?? 0;
                var pid = callArgs["process_id"]?.GetValue<int>() ?? 0;
                var title = callArgs["title"]?.GetValue<string>() ?? "";
                if (handle == 0 || pid == 0)
                    throw new InvalidOperationException("computer_select_window cần handle và process_id của cửa sổ.");
                computer.Authorize(new DesktopWindow(handle, pid, title));
                return ($"selected_window={title} (process {pid})", null);
            }
            case "computer_stop":
                computer.Disarm();
                return ("screen_control_stopped=true", null);
            case "computer_inspect":
            case "computer_screenshot":
            case "computer_click":
            case "computer_type":
            case "computer_key":
            case "computer_scroll":
            case "computer_invoke":
            case "computer_set_value":
            case "computer_focus":
            case "computer_assert":
            case "computer_toggle":
            case "computer_select":
            case "computer_expand": {
                if (computer.Target is null)
                    throw new InvalidOperationException(
                        "Chưa chọn cửa sổ đích. Hãy gọi computer_list_windows rồi chọn một cửa sổ trước khi dùng công cụ này.");
                var result = await computer.ExecuteAsync(new ToolCall(tool, callArgs), CancellationToken.None);
                string? imageBase64 = null;
                if (result.ImageDataUrl is { } dataUrl)
                {
                    const string prefix = "data:image/jpeg;base64,";
                    imageBase64 = dataUrl.StartsWith(prefix, StringComparison.Ordinal)
                        ? dataUrl[prefix.Length..]
                        : dataUrl;
                }
                return (result.Text, imageBase64);
            }
            default:
                throw new InvalidOperationException($"Unknown computer tool for helper: {tool}");
        }
    }
}
