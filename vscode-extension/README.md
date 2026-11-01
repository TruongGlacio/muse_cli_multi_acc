# Muse cho VS Code (v0.4.0)

Extension chat trong VS Code: mở thanh bên **Muse**, gửi yêu cầu bằng tiếng
Việt, Muse đọc dự án, sửa tệp và chạy kiểm tra — qua gateway Muse2Api.

## Mới trong v0.4.0: danh sách session nhìn thấy được + bảng quản lý đăng nhập Muse

- Danh sách session nhìn thấy được: thay dropdown nhỏ bằng danh sách session hiển thị rõ ở đầu khung chat (tiêu đề, số tin, thời gian cập nhật, thư mục), bấm vào session nào là làm việc tiếp session đó. Session lưu toàn cục theo user (globalState) nên mở thư mục khác vẫn thấy đủ danh sách; lần đầu lên 0.4.0 sẽ hợp nhất session từ global + session workspace của 0.3.3 + lịch sử cũ. Lưu ý thật: session trước 0.3.3 không bao giờ được lưu thành danh sách nên không thể hiện thành nhiều session cũ, chỉ lịch sử cuối cùng thành 1 session; session workspace khác tạo ở 0.3.3 sẽ được kéo vào khi bạn mở lại đúng workspace đó một lần. Ngoài khung chat, session còn quản lý được từ Command Palette: "Muse: Chọn hội thoại", "Hội thoại mới", "Đổi tên", "Xóa".
- Bảng quản lý đăng nhập Muse trong khung chat ("Tài khoản Muse", ngay dưới danh sách session): luôn hiện trạng thái gateway và từng tài khoản (nhãn, trạng thái active/cooling/invalid, bật/tắt, cooldown, lỗi cuối — không bao giờ hiện cookie). Từ đây bạn tự kiểm tra được có lỗi đăng nhập hay không mà không cần đoán: nếu chưa có tài khoản thì bảng báo rõ và đó là nguyên nhân lỗi 503; nếu Invalid/cooling thì thấy rõ trạng thái và lỗi cuối. Nút theo từng tài khoản: Làm mới / Đăng nhập lại (Renew qua gateway), Xóa cooldown, Bật/Tắt, Đăng xuất (xóa khỏi pool gateway, hỏi xác nhận; không đăng xuất app desktop). Nút chung: Kiểm tra lại tài khoản, Nhập đăng nhập từ app desktop, Mở dashboard, Khởi động lại gateway. Đăng nhập lại đầy đủ khi cookie hết hạn: đăng nhập lại trong app Muse desktop rồi bấm Nhập đăng nhập từ app desktop (VS Code không có WebView2 nên không đăng nhập trực tiếp trong extension được).

## Mới trong v0.3.3: quản lý session + lỗi 502 dạng dễ hiểu

- Quản lý session (trước đây không có giao diện này, chỉ có một lịch sử duy nhất theo workspace): thanh session ở đầu khung chat gồm danh sách chọn hội thoại, nút Hội thoại mới, Đổi tên, Xóa hội thoại. Mỗi session có lịch sử và conversationId riêng (gửi gateway làm ID thread), chuyển session là chuyển cả lịch sử lẫn thread. Lịch sử cũ được chuyển thành session đầu tiên, không mất. Tin đầu tiên của session mới tự đặt tên session. Nút Xóa lịch sử vẫn giữ nghĩa cũ: làm trống hội thoại hiện tại và mở thread mới, session vẫn giữ tên.
- Lỗi 502 upstream: khi Muse web bắt đầu trả lời rồi dừng mà gateway không xác định được phản hồi hoàn tất, extension giờ hiện hướng dẫn tiếng Việt thay vì JSON thô: hội thoại được giữ nguyên, không tự gửi lại, đừng tạo session mới hay xóa lịch sử, hãy gửi tiếp tin ngắn trong cùng session.

## Mới trong v0.3.2: chat dạng chat + đính kèm video/tệp

- Trả lời dạng chat: gateway ở chế độ local tools bắt model trả JSON kế hoạch `{"status":...,"summary":...}` nên các bản trước hiện nguyên JSON trong khung chat. Từ 0.3.2, khung chat hiện câu `summary`/`reply` dạng chat bình thường, còn JSON gốc nằm trong mục **Chi tiết (JSON gốc)** mà bạn bấm mới mở ra. Lịch sử lưu cũng là câu chat, không phải JSON.
- Đính kèm tệp (nút đổi từ "Đính kèm ảnh" thành "Đính kèm tệp"): ảnh gửi dạng ảnh như cũ; tệp văn bản gửi nội dung dạng text (tối đa 500 KiB, quá thì cắt và ghi rõ); video thử trích 1 khung hình bằng ffmpeg nếu máy có ffmpeg và gửi khung hình đó dạng ảnh kèm ghi chú, nếu không có ffmpeg thì chỉ gửi ghi chú tên/dung lượng. Lưu ý thật: gateway chat chỉ nhận text và ảnh, không có part video hay file, nên extension không giả vờ đã gửi video gốc hay nội dung tệp nhị phân.

## Mới trong v0.3.1: vá lỗi 400 conversation ID

- Trước 0.3.1, extension gửi `_muse_local_tools: true` nhưng không gửi field `user`, nên gateway (driver browser) trả 400 `Local tools require a stable conversation ID` ở mọi lượt chat. Từ 0.3.1, extension gửi `user` là UUID hội thoại ổn định theo workspace (lưu ở workspaceState), đúng cách agent terminal gửi conversationId của nó. Xóa lịch sử thì đổi ID mới để gateway mở thread Muse mới, không tái dùng thread cũ.

## Mới trong v0.3.0: tất cả tính năng portable + điều khiển màn hình Windows thử nghiệm

- **Streaming:** câu trả lời hiện dần từng phần thay vì chờ cả câu.
- **Đính kèm ảnh vào chat:** nút “Đính kèm ảnh” trong khung chat (tối đa
  20 MiB/ảnh, đúng giới hạn của gateway), gửi dưới dạng part `image_url`
  như gateway chấp nhận cho chat.
- **Tạo/sửa ảnh, tạo video:** lệnh “Muse: Tạo ảnh” (`POST
  /v1/images/generations`, 1–4 ảnh), “Muse: Sửa ảnh” (multipart
  `/v1/images/edits`, 1–4 ảnh gốc, không mask), “Muse: Tạo video” (`POST
  /v1/videos`, poll theo taskId mỗi 5 giây, tối đa 15 phút). Kết quả được
  hỏi thư mục lưu, tải về workspace rồi mở xem.
- **Quản lý tài khoản ngay trong extension:** lệnh “Muse: Xem trạng thái
  tài khoản gateway” (`/admin/status` + `/admin/accounts`), “Reset tài
  khoản gateway” và “Renew tài khoản gateway”. Chỉ hiện label, trạng
  thái, bật/tắt, cooldown và lỗi cuối — **không bao giờ hiện cookie hay
  token**. Khi chat gặp đúng lỗi `no_account_available`, khung chat hiện
  nút “Nhập đăng nhập từ app desktop” và “Mở dashboard gateway” thay vì
  chỉ mã lỗi. Lưu ý: lỗi 503 này vẫn có nghĩa là pool gateway chưa có
  tài khoản khả dụng; extension không tự tạo tài khoản, bạn vẫn phải nhập
  đăng nhập trên máy mình như mục dưới.
- **Tiến trình nền:** `run_command` với `background: true` khởi động
  tiến trình nền, rồi dùng `process_status` / `process_input` /
  `process_stop` với `process_id` trả về. Chạy bằng Node `child_process`
  trong extension host (tối đa 8 tiến trình chạy cùng lúc, giữ 32000 ký
  tự output mới nhất, đúng semantics của agent desktop), không dùng
  VS Code terminal API để lấy output.
- **Lưu lịch sử chat:** lịch sử giữ trong `workspaceState` của workspace
  đang mở, mở lại VS Code vẫn thấy đoạn chat cũ; nút “Xóa lịch sử” trong
  khung chat (hoặc lệnh “Muse: Xóa lịch sử chat”) để xóa. Ảnh đính kèm
  không được lưu cùng lịch sử (chỉ giữ trong bộ nhớ của phiên).
- **Duyệt nhạy cảm:** đường dẫn chứa `.env`, `.key`, `.pem`, `.git`,
  `secrets` luôn hỏi duyệt modal riêng, kể cả khi bật `muse.autoApprove`.

### Điều khiển màn hình Windows THỬ NGHIỆM (chỉ Windows, mặc định TẮT)

Đây là phần duy nhất không thể bê nguyên từ app desktop sang VS Code:
app desktop dùng UI Automation và SendInput của project
`Muse2Api.Computer` trên .NET Windows, còn extension host chạy Node
không load được DLL đó và VS Code API không có UI Automation hay chụp
màn hình desktop. Vì vậy v0.3.0 làm theo cách sau, và **không giả vờ**
chạy khi không đủ điều kiện:

- **Helper .NET riêng:** project mới `src/Muse2Api.ComputerHelper`
  (console `net10.0-windows`, tham chiếu `Muse2Api.Computer`, publish
  win-x64 self-contained vào
  `bin/win-x64/computer-helper/Muse2Api.ComputerHelper.exe`), giữ một
  `DesktopComputer` duy nhất và nói chuyện với extension bằng JSON-lines
  qua stdin/stdout. Mọi logic UI Automation, cache element, snapshot
  ảnh cho click đều là code thật của `DesktopComputer`, không viết lại.
- **Bật:** đặt `muse.allowComputerControl` thành `true` (mặc định
  `false`). Khi tắt, không phải Windows, hoặc thiếu helper, mọi tool
  `computer_*` trả lỗi rõ ràng và hướng về app desktop.
- **Chọn cửa sổ đích:** extension hỏi chọn bằng QuickPick từ danh sách
  cửa sổ (`computer_list_windows`), rồi mới chạy các tool khác. Helper
  không tự mở cửa sổ chooser như bản desktop; cách dừng khẩn cấp là
  lệnh “Muse: Dừng điều khiển màn hình” (hủy chọn cửa sổ và tắt helper),
  vì helper không có cửa sổ WinForms để nhận phím Esc như bản desktop.
- **Duyệt riêng từng hành động:** mọi hành động `computer_click`,
  `computer_type`, `computer_key`, `computer_invoke`, `computer_set_value`,
  `computer_toggle`, `computer_select`, `computer_expand`,
  `computer_scroll` đều hiện modal riêng ghi rõ hành động và cửa sổ đích,
  **kể cả khi `muse.autoApprove` bật**. Sau `computer_screenshot`, ảnh
  được đưa vào lượt model tiếp theo dưới dạng `image_url` data URI,
  đúng cách `AgentLoop` của bản desktop làm với `LastComputerImage`.
- **Rủi ro phải biết trước:** hành động này bấm/gõ thật vào Windows.
  Chỉ bật khi bạn đang nhìn thấy đúng cửa sổ đích, và đừng chọn cửa sổ
  VS Code đang chạy extension nếu bạn không muốn model bấm vào chính
  VS Code. Helper chỉ tự loại trừ cửa sổ của chính nó, không loại trừ
  VS Code.
- **Kích thước gói:** helper self-contained khoảng 173 MB chưa nén, cộng
  gateway khoảng 213 MB, nên file `.vsix` v0.3.0 sẽ to hơn hẳn v0.2.0
  (xem dung lượng thực tế khi giao). Repo vẫn không chứa binary: script
  `scripts/Build-VscodeExtension.ps1` nay publish cả helper trước khi
  đóng gói (chỉ trên runtime `win-*`; trên runtime khác thì bỏ qua
  helper và extension báo rõ computer_* không khả dụng).

## Mới trong v0.2.0: gateway kèm theo, tự chạy khi mở VS Code

- **Gateway tự chạy khi mở VS Code.** Extension đóng gói sẵn gateway
  Muse2Api cho Windows x64 (`bin/win-x64/Muse2Api.exe`) và tự khởi động
  nó ngay khi VS Code mở lên (nhờ `onStartupFinished`), kể cả khi bạn
  chưa bấm biểu tượng Muse. Bạn **không còn phải chạy gateway tay** nữa.
  Trạng thái gateway hiện ở thanh trạng thái góc phải dưới
  (“Muse Gateway: Đang chạy / Đang khởi động… / Lỗi”) và log đầy đủ ở
  **Output > Muse Gateway**.
- **Dùng luôn gateway sẵn có nếu đã chạy.** Nếu app Muse desktop hoặc một
  gateway khác đã chạy sẵn ở cùng cổng và key khớp, extension dùng luôn
  gateway đó thay vì khởi động thêm một tiến trình nữa. Gateway ngoài
  đang chạy nhưng key không khớp sẽ **không bị giết** — extension chỉ báo
  lỗi key không khớp, bạn dán đúng key vào `muse.apiKey` là dùng được.
- **Key tự quản lý.** Nếu `muse.apiKey` để trống, key cho gateway kèm
  theo được tự sinh dạng `m2a-…` và lưu trong SecretStorage của VS Code,
  không ghi vào Settings, không in ra log.
- **Lệnh gateway mới** (Command Palette, gõ “Muse:”): Khởi động gateway,
  Dừng gateway kèm theo, Khởi động lại gateway, Nhập đăng nhập từ app
  desktop, Cài Chromium cho gateway, Xem log gateway, Mở dashboard
  gateway.

### Lần đầu chưa có đăng nhập thì làm sao?

Gateway chạy được chưa có nghĩa là đã có tài khoản Muse để gọi. Tài
khoản Muse (cookie phiên) lưu trong `accounts.json` của gateway. Làm
theo một trong hai cách:

1. **Nếu máy đã có app Muse desktop đăng nhập rồi (cách nhanh nhất):**
   chạy lệnh **“Muse: Nhập đăng nhập từ app desktop”**. Lệnh này chỉ
   **copy** file `accounts.json` từ
   `%LOCALAPPDATA%\Muse2Api.WinForms\Gateway\` sang thư mục dữ liệu của
   gateway kèm theo — **không xóa, không sửa dữ liệu của app desktop**.
   Việc này chỉ hoạt động trên **cùng máy, cùng tài khoản Windows**, vì
   cookie được mã hóa DPAPI theo tài khoản đó. Sau khi nhập, dùng lệnh
   “Muse: Khởi động lại gateway” rồi gửi yêu cầu.
2. **Nếu chưa có app desktop đăng nhập:** mở app Muse desktop, đăng nhập
   tài khoản Muse một lần, rồi làm theo cách 1. Hoặc mở dashboard của
   gateway (lệnh “Muse: Mở dashboard gateway”, `http://127.0.0.1:18610/dashboard`)
   để thêm tài khoản theo hướng dẫn trong đó.

### Nếu gateway thoát vì thiếu Chromium thì làm sao?

Gateway dùng driver “browser” nên cần một trình duyệt để mở muse.ai.
Extension ưu tiên Edge/Chrome đã cài sẵn trên máy (truyền qua
`MUSE2API_CHROMIUM_PATH`). Nếu máy không có Edge/Chrome và cũng chưa có
Chromium của Playwright, gateway sẽ thoát ngay khi khởi động và log sẽ
ghi rõ lỗi Playwright. Khi đó, làm một trong hai việc rồi khởi động lại
gateway:

- Chạy lệnh **“Muse: Cài Chromium cho gateway”** một lần (chạy
  `playwright.ps1 install chromium` kèm theo binary), hoặc
- Cài Edge hoặc Chrome rồi dùng lệnh “Muse: Khởi động lại gateway”.

## Cách hoạt động

- Extension là **giao diện chat**, không tự chứa model. Nó gọi gateway
  Muse2Api qua API tương thích OpenAI tại `POST /v1/chat/completions`.
- Sau khi model trả về khối tool (cùng giao thức với agent terminal
  `Muse2Api.Agent`: ```json {"tool_calls": [...]} hoặc ```tool legacy),
  extension tự thực thi tool trong workspace đang mở bằng API của VS Code /
  Node: `list_files`, `read_file`, `read_files`, `search_files`,
  `write_file`, `edit_file`, `run_command` (kể cả `background: true`),
  `process_status`, `process_input`, `process_stop`, `git_status`,
  `git_diff`, và (thử nghiệm, chỉ Windows, khi bật
  `muse.allowComputerControl`) toàn bộ 14 tool `computer_*` qua helper
  .NET riêng.
- Mọi thao tác ghi tệp và chạy lệnh đều **hỏi duyệt trước** (hộp thoại
  modal), riêng sửa/ghi tệp có thêm nút **Xem diff**. Chỉ khi bật
  `muse.autoApprove` mới tự duyệt. Lệnh chạy với quyền của người dùng và
  **không bị sandbox** trong workspace, giống bản desktop.

## Cài đặt

### 1. Gateway: từ v0.2.0 không cần chạy tay nữa

Mặc định, mở VS Code là extension tự chạy gateway kèm theo. Mục này chỉ
còn áp dụng khi bạn muốn dùng gateway ngoài thay vì gateway kèm theo
(đặt `muse.gatewayMode` thành `external`):

```powershell
# Windows (PowerShell), đặt key tùy ý rồi chạy gateway
$env:MUSE2API_API_KEY = "khoa-cua-ban"
$env:MUSE2API_PORT = "18610"
dotnet run --project src/Muse2Api -c Release
```

Hoặc dùng gateway của app desktop đang chạy (mặc định cổng 18610; key
nằm trong file `api_key` dưới thư mục `Gateway` của app desktop, ví dụ
`%LOCALAPPDATA%\Muse2Api.WinForms\Gateway\api_key`).

### 2. Cài extension

- Mở file `.vsix` trong VS Code: bấm phải vào file > **Install Extension
  VSIX**, hoặc chạy `code --install-extension muse-vscode-0.3.0.vsix`.
- Mở một thư mục dự án, bấm biểu tượng **Muse** ở thanh Activity Bar
  (trái), hoặc chạy lệnh **Muse: Mở chat** từ Command Palette.

### 3. Cấu hình (Settings > tìm `muse.`)

- `muse.baseUrl`: mặc định `http://127.0.0.1:18610/v1`.
- `muse.model`: mặc định `muse-chat`.
- `muse.apiKey`: để trống thì extension tự quản lý key cho gateway kèm
  theo; chỉ cần dán key khi dùng gateway ngoài chạy sẵn mà key không khớp.
- `muse.gatewayMode`: `auto` (mặc định), `bundled` hoặc `external`.
- `muse.gatewayPath`: để trống thì dùng binary kèm theo extension.
- `muse.maxSteps`: mặc định 30 bước tool / yêu cầu.
- `muse.commandTimeoutSeconds`: mặc định 120 giây / lệnh.
- `muse.autoApprove`: mặc định `false` (khuyên giữ nguyên).
- `muse.allowComputerControl`: mặc định `false` (thử nghiệm, chỉ Windows).
- `muse.computerHelperPath`: để trống thì dùng helper kèm theo extension.

## Gợi ý sẵn trong UI

- **Tìm hiểu dự án**: chỉ đọc, chưa sửa.
- **Tìm và sửa lỗi**: sửa sau khi bạn duyệt từng thay đổi.
- **Thêm tính năng**: đọc tệp liên quan trước, hỏi mô tả rồi mới làm.
- **Kiểm tra chất lượng**: chạy kiểm tra phù hợp và giải thích kết quả.

## Giới hạn của v0.1.0 (nói rõ, không giấu)

- Chưa có gateway đi kèm: bạn phải tự chạy gateway như mục 1. Extension
  không tự khởi động gateway, không tự đăng nhập Muse.
- Chưa có lịch sử chat lưu lâu dài: lịch sử chỉ giữ trong phiên VS Code
  hiện tại; đóng VS Code là mất đoạn chat cũ (tệp đã sửa thì vẫn còn).
- Chưa hỗ trợ tiến trình nền (`process_*`) và công cụ điều khiển màn
  hình (`computer_*`): hai nhóm này chỉ có trên app WinForms. Nếu model
  gọi chúng, extension trả lỗi rõ ràng thay vì giả vờ chạy.
- Chưa có streaming từng ký tự: mỗi lượt model trả về nguyên văn bản
  rồi mới hiện; với model chậm, khung trạng thái chỉ báo "Đang suy nghĩ…".
- Chưa gửi ảnh: chỉ chat chữ trong v0.1.0 (bản desktop đã hỗ trợ dán ảnh).
- Chưa kiểm thử đầu cuối với tài khoản Muse thật: đã kiểm chứng biên
  dịch TypeScript, đóng gói `.vsix` và đọc lại manifest/code trong gói;
  vòng chat thật cần gateway + tài khoản của bạn (xem mục 1).

## Phát triển (build từ source trong repo này)

Lưu ý quan trọng: thư mục `bin/` bị gitignore nên **repo không chứa
binary gateway**. File `.vsix` đã giao cho bạn thì có kèm binary, còn
khi build từ repo thì phải publish gateway trước rồi mới đóng gói
extension. Trên Windows, chạy một lệnh duy nhất từ gốc repo:

```powershell
.\scripts\Build-VscodeExtension.ps1
```

Lệnh này publish `src/Muse2Api` cho `win-x64` vào
`vscode-extension/bin/win-x64/`, rồi chạy `npm install`, `npm run compile`
và `npx vsce package` để ra file `.vsix`. Muốn bỏ qua bước publish
gateway (khi đã có sẵn binary trong `bin/`), thêm `-SkipGateway`.

Build tay trên Linux/macOS (thay `win-x64` bằng runtime của máy, ví dụ
`linux-x64` hoặc `osx-arm64`):

```bash
dotnet publish src/Muse2Api -c Release -r linux-x64 --self-contained true -o vscode-extension/bin/linux-x64
cd vscode-extension
npm install
npm run compile        # ra out/extension.js
npx @vscode/vsce package   # ra file .vsix
```

Bản extension trên nền tảng khác Windows x64 sẽ báo rõ là chưa có binary
kèm theo nếu bạn đóng gói mà không publish gateway cho đúng runtime đó;
khi đó hãy dùng `muse.gatewayMode = "external"` và chạy gateway ngoài.

## Giấy phép

Xem `LICENSING.md` ở gốc repo. Phần code upstream muse2api vẫn theo MIT;
chưa có giấy phép thương mại mới nào được cấp cho phần code riêng.


## Sửa lỗi v0.1.1: không thấy biểu tượng sau khi cài (lỗi của v0.1.0)

Nguyên nhân đã xác minh trong code: ở v0.1.0, `contributes.views` trong
`package.json` bị viết dạng mảng, trong khi VS Code bắt buộc dạng object
theo id của views container, ví dụ `"views": {"muse": [{"id": "muse.chat",
...}]}`. VS Code bỏ qua khai báo sai định dạng đó nên không hiện biểu
tượng ở thanh Activity Bar. v0.1.1 đã sửa đúng định dạng, bỏ `when`
không hợp lệ, và thêm `extensionKind: ["ui", "workspace"]` để biểu tượng
hiện cả khi chưa mở thư mục nào.

## Nếu cài bản mới rồi mà vẫn không thấy biểu tượng, kiểm tra theo thứ tự

1. Gỡ bản cũ rồi cài lại bản 0.1.1, sau đó khởi động lại VS Code hoàn
   toàn (đóng hết cửa sổ, mở lại). Cài đè không gỡ đôi khi giữ lại bản
   cũ trong bộ nhớ.
2. Nhìn thanh dọc ngoài cùng bên trái (Activity Bar): biểu tượng là ô
   vuông tím có chữ M. Bấm vào đó, khung Chat phải hiện ở sidebar.
   Nếu không thấy thanh dọc này, bấm View > Appearance > Activity Bar.
3. Mở Extensions (Ctrl+Shift+X), gõ "Muse": extension phải hiện trạng
   thái Enabled và version 0.1.1. Nếu thấy Disabled thì bấm Enable.
4. Mở Command Palette (Ctrl+Shift+P), gõ "Muse: Mở chat": nếu lệnh
   chạy được mà chỉ thiếu biểu tượng, báo lại cho tôi đúng hiện tượng
   này để xử lý tiếp.
5. Nếu extension báo lỗi khi kích hoạt, mở Output > chọn "Log
   (Extension Host)" và gửi lại dòng lỗi có chữ muse.


## Sửa lỗi v0.1.2: vẫn không thấy biểu tượng, Runtime Status báo container không tồn tại

v0.1.1 mới sửa được một nửa: sửa `views` sang dạng object, nhưng quên
`viewsContainers` vẫn còn dạng mảng từ bản đầu. Theo tài liệu chính thức
VS Code (Tree View API), cả hai đều phải là object:

- `"viewsContainers": {"activitybar": [{"id": "muse", "title": "Muse",
  "icon": "media/icon.svg"}]}`
- `"views": {"muse": [{"id": "muse.chat", "name": "Chat",
  "type": "webview"}]}`

Vì container `muse` chưa từng được đăng ký đúng nên VS Code báo đúng
như user thấy: "View container 'muse' does not exist and all views
registered to it will be added to 'Explorer'", và extension chưa bao giờ
được kích hoạt (onView:muse.chat không bao giờ xảy ra) nên Runtime
Status hiện "Not yet activated". v0.1.2 sửa cả hai về đúng định dạng
trên. Lần này, trước khi giao, manifest trong file .vsix đã được đọc
lại để đối chiếu từng trường, không chỉ kiểm tra code nguồn.
