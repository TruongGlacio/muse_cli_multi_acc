# muse-agent — coding agent chạy trong terminal (kiểu Codex)

Chat với model qua gateway muse2api (OpenAI-compatible), agent tự đọc file,
sửa file và chạy lệnh/test trong thư mục làm việc bạn chọn — giống Codex CLI,
nhưng backend là muse.ai qua gateway local thay vì API của OpenAI.

## Chạy trên Windows (cmd / PowerShell)

```powershell
# 1. Chạy gateway trước (mock hoặc browser driver với tài khoản thật)
#    xem TESTING.md ở root repo.

# 2. Chạy agent, trỏ tới gateway local
dotnet run --project src/Muse2Api.Agent -- --workspace C:\code\myapp --api-key <api-key-cua-gateway>

# Một nhiệm vụ rồi thoát (dùng trong script):
dotnet run --project src/Muse2Api.Agent -- --workspace C:\code\myapp --api-key <key> --yes "chạy dotnet test và sửa lỗi nếu có"
```

Mặc định: base URL `http://127.0.0.1:18610/v1`, model `muse-chat`.
Đổi bằng `--base-url`, `--model`, hoặc biến môi trường
`MUSE_AGENT_BASE_URL`, `MUSE_AGENT_API_KEY`, `MUSE_AGENT_MODEL`,
`MUSE_AGENT_WORKSPACE`.

## Agent làm được gì

| Tool | Mô tả |
|---|---|
| `list_files` | Liệt kê file/thư mục trong workspace |
| `read_file` | Đọc file |
| `send_file` | Gửi nguyên file lên cuộc hội thoại web (video, pdf, zip, ...) — khác `ui_image` chỉ chụp màn hình |
| `write_file` | Ghi đè / tạo file mới |
| `edit_file` | Thay đúng 1 đoạn text khớp chính xác (đọc file trước) |
| `run_command` | Chạy lệnh trong workspace: PowerShell mặc định trên Windows (`--shell cmd` để dùng cmd.exe), bash trên Linux/macOS |

Lệnh trong REPL: `/help`, `/exit`, `/clear`, `/workspace <đường dẫn>`,
`/yes` (bật/tắt tự xác nhận), `/model` (xem model hiện tại).

`send_file` nhận `{"path": "đường-dẫn-tương-đối-trong-workspace"}`:
file phải tồn tại, là tệp (không phải thư mục), không rỗng, tối đa
25 MB (giới hạn của web), và phải nằm trong workspace như mọi tool file
khác (đường dẫn ngoài workspace, `..` và symlink đều bị chặn). Model gọi
`send_file` khi user muốn gửi thẳng một file thật lên cuộc hội thoại web
— ví dụ một clip mp4 để user chấm — thay vì đi qua `ui_image` (chỉ là
ảnh chụp màn hình, không phải file gốc). `send_file` chỉ đọc file nên
không cần xác nhận như `write_file` hay `run_command`.

## Cách agent gọi tool

Gateway muse2api chưa hỗ trợ native function calling, nên agent dùng
định dạng text có cấu trúc: model trả về các block

    ```tool
    {"name": "read_file", "path": "src/Program.cs"}
    ```

Agent parse block, chạy tool, gửi kết quả lại cho model, tiếp tục cho tới khi
model trả lời không còn tool call. Mặc định không tự giới hạn số bước; có thể
đặt giới hạn rõ ràng bằng `--max-steps N`. Khi không còn tool call
nữa — đó là đáp án cuối. Nếu gateway sau này hỗ trợ `tool_calls` native,
agent cũng đã xử lý sẵn trường đó.

## An toàn — đọc kỹ trước khi dùng --yes

- **Jail workspace:** mọi đường dẫn file đều phải nằm trong workspace đã
  chọn. `../secret.txt` hay đường dẫn tuyệt đối ngoài workspace đều bị
  từ chối trước khi đọc/ghi. Symlink và junction bị từ chối; liệt kê đệ quy bỏ qua các link.
- **Xác nhận:** mặc định, trước mỗi `write_file`, `edit_file`,
  `run_command`, agent in ra nội dung bước đó và hỏi `[y/N]`. Chỉ dùng
  `--yes` khi bạn đã tin nhiệm vụ và chấp nhận agent tự sửa/chạy lệnh.
- **Không có danh sách lệnh cấm cứng:** agent tin vào xác nhận của bạn.
  Đừng chạy `--yes` trong workspace chứa dữ liệu quan trọng mà chưa
  commit, và đừng cho agent workspace là `C:\` hay thư mục home.
- **API key** chỉ dùng để gọi gateway bạn chỉ định, không gửi đi nơi khác.

## Giới hạn đã biết

- Trí tuệ của agent phụ thuộc hoàn toàn vào model qua gateway. Với driver
  mock, model chỉ echo lại prompt nên agent sẽ không tự sinh tool call
  thật — cần tài khoản thật + browser driver (xem TESTING.md bước 4)
  mới test được vòng lặp agent thật.
- HTTP client đã được kiểm tra với gateway mock trên localhost, gồm request thành công và lỗi 401. Vòng lặp tool được kiểm tra bằng canned responses; suy luận với tài khoản muse.ai thật vẫn cần kiểm chứng.
- Lệnh chạy qua `Process` với timeout mặc định 120s (đổi bằng
  `timeout_seconds` trong tool call); lệnh chờ nhập liệu sẽ bị timeout.

Lệnh shell chạy với quyền của người dùng và không bị sandbox trong workspace.
Chế độ một nhiệm vụ trả exit 0 khi hoàn thành, 1 nếu gọi model lỗi hoặc hết
giới hạn bước, 2 nếu tham số không hợp lệ.
