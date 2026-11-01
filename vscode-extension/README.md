# Muse cho VS Code (v0.7.0)

Extension chat trong VS Code: mở thanh bên **Muse**, gửi yêu cầu bằng tiếng
Việt, Muse đọc dự án, sửa tệp và chạy kiểm tra — qua gateway Muse2Api.

## Mới trong v0.7.0: hồ sơ tài khoản, chống trùng bằng email, hiện danh tính trong hội thoại, sửa đồng bộ web

1. **Ba trường hồ sơ mới trên tài khoản (điểm 1).** `Account` có thêm `Email`, `Username`, `Phone` (nullable; file `accounts.json` cũ load lên sẽ có null, tương thích ngược). `Public()` trả thêm 3 trường này. Panel Cài đặt hiện cả 3 trong chi tiết từng tài khoản, chưa biết thì hiện "Chưa xác định". CHỈ hiện trong panel Cài đặt — không đưa email/phone vào khung chat, không log email/phone, không đưa vào bất kỳ thông báo nào khác (thông báo chỉ nói "Đã cập nhật thông tin hồ sơ", không kèm giá trị).
2. **Cách lấy hồ sơ, best-effort (điểm 1).** `FetchProfile` (BrowserDriver) mở trang chủ `https://muse.ai` trong một page tạm thuộc đúng context của tài khoản (như `ListWebThreads`), không dùng tab chat đang chạy, đóng page sau khi đọc. Trong code hiện có KHÔNG có URL trang cài đặt tài khoản nào nên chỉ đọc trang chủ, không đoán URL cài đặt. Email: regex email trong text trang chủ, ưu tiên vùng menu hồ sơ rồi tiêu đề, cuối cùng mới toàn bộ text; KHÔNG mở thread để tìm email (email trong hội thoại có thể là của người khác). Username/tên hiển thị: best-effort từ aria-label/innerText của nút hồ sơ/avatar hoặc phần đầu tiêu đề trang, không xác định được thì null. Phone: CHỈ điền khi có dòng gắn nhãn rõ ràng "Phone"/"Số điện thoại"/"Điện thoại" kèm số, hoặc input type=tel; KHÔNG regex số điện thoại từ text tự do. Trong đa số trường hợp phone sẽ vẫn là null — đó là hành vi đúng, không phải lỗi, đừng bịa số. Lấy được gì thì cập nhật vào Account và Persist; không lấy được gì thì trả null và để nguyên tài khoản; lấy hồ sơ thất bại KHÔNG bao giờ làm thất bại đăng nhập/tạo tài khoản.
3. **Nút "Cập nhật thông tin hồ sơ" (điểm 1).** Trên chi tiết từng tài khoản trong panel Cài đặt, gọi `POST /admin/accounts/{id}/profile-refresh` (RequireAdmin) → FetchProfile → cập nhật Email/Username/Phone → trả Public mới. Nút này điền danh tính cho các tài khoản cũ nhập từ desktop (vốn chưa từng lấy hồ sơ) mà không cần đăng nhập lại. Luồng đăng nhập qua trình duyệt cũng thử FetchProfile cho tài khoản kết quả sau khi UpsertSession thành công, best-effort, không chặn thông báo thành công nếu thất bại.
4. **Luật khớp danh tính chống trùng (điểm 2).** `Pool.UpsertSession` giữ nguyên bước 1 khớp auth-hash (SHA256 của 2 cookie phiên) như cũ; thêm bước 2: nếu tài khoản vào có Email (chuẩn hóa trim + lowercase) và có tài khoản cũ cùng Email → cập nhật tài khoản cũ đó (cookies, cookie_expires mới, Status về Active nếu đang Invalid, xóa LastError, điền Email/Username/Phone từ tài khoản vào nếu tài khoản cũ còn trống, GIỮ NGUYÊN Id và GIỮ NGUYÊN label cũ để không ghi đè tên do user tự đổi) rồi trả tài khoản cũ; bước 3: chỉ khi cả hai bên đều không có Email và Username đều khác rỗng và dài từ 3 ký tự thì mới khớp theo Username (không phân biệt hoa/thường). Khớp theo Username yếu hơn Email (tên hiển thị có thể trùng giữa hai người), chỉ dùng khi không có Email. Nhờ bước 2/3, đăng nhập lại cùng tài khoản Muse sẽ không sinh acc_ mới nữa, và các session cũ gắn Id đó vẫn dùng được.
5. **Gộp các tài khoản trùng đã tồn tại (điểm 2).** Nút "Gộp tài khoản trùng" trong panel Cài đặt (kèm xác nhận giải thích rõ) gọi `POST /admin/accounts/merge-duplicates` (RequireAdmin). Với mỗi tài khoản chưa có Email/Username thì thử FetchProfile trước (timeout 90 giây/tài khoản, thất bại thì bỏ qua tài khoản đó, không dừng cả quá trình). Nhóm theo Email đã chuẩn hóa (khóa chính); nếu không có Email thì nhóm theo Username (chỉ khi Username khác rỗng). Nhóm nào có từ 2 tài khoản trở lên mới gộp. Tài khoản chính trong nhóm = tài khoản có LastUsedAt mới nhất (nếu bằng nhau thì CreatedAt sớm nhất). Với mỗi tài khoản phụ: xóa khỏi Pool (Remove + Persist), và viết lại các file `dataDir/local-conversations/*.json` mà `Entry.Account == Hash(Id phụ)` thành `Hash(Id chính)` (dùng đúng hàm Hash của LocalConversationStore, giữ nguyên Url/Pending/ImageHash) để các thread cũ vẫn nối tiếp được dưới tài khoản chính — nếu không làm bước này thì các session cũ sẽ bị gateway từ chối vì hash tài khoản không khớp. Trả về `{merged: [{primaryId, primaryLabel, mergedIds, identity}], skipped: [id...]}` trong đó skipped là các tài khoản không có danh tính nên không dám gộp. Sau khi merge thành công, extension cập nhật session của chính nó: mọi session có accountId nằm trong mergedIds thì đổi thành primaryId + primaryLabel, lưu lại, làm mới cột trái và danh sách tài khoản, rồi hiện thông báo kết quả (số nhóm đã gộp, số tài khoản đã gộp, số tài khoản bỏ qua vì chưa xác định). KHÔNG tự động gộp khi mở panel hay khi đăng nhập (chỉ gộp khi user bấm nút và xác nhận), vì gộp là thao tác xóa tài khoản, không được tự ý làm.
6. **Hiện danh tính trong quản lý hội thoại (điểm 3).** Dòng tài khoản trên mỗi item session trong cột trái, và dòng tài khoản trong header của khung chat (ngay cạnh tiêu đề session hiện tại), đều đổi thành thông tin định danh, lấy từ cache tài khoản mới nhất của provider (join session.accountId với cache mỗi lần gửi danh sách ra webview, KHÔNG lấy từ label đã lưu trong session vì label mặc định trùng nhau). Thứ tự ưu tiên: Email (nếu có) → Username (nếu không có Email) → Label → "Chưa xác định tài khoản" (nếu session không có accountId hoặc tài khoản không còn trong cache). Session chỉ lưu accountId/accountLabel như hiện tại, KHÔNG thêm trường email vào session. Khi cache tài khoản làm mới (sau profile-refresh, merge-duplicates, đăng nhập mới), provider gửi lại danh sách session nên dòng tài khoản cập nhật theo danh tính mới, không kẹt email cũ hay tài khoản của session cũ. Email dài thì cắt ngắn bằng ellipsis trong item/header, đầy đủ trong thuộc tính title (tooltip khi rê chuột). Dòng tài khoản vẫn nằm cùng vị trí cũ trong item (dưới tiêu đề, cùng hàng với số tin/thời gian/thư mục/trạng thái), không thêm hàng mới làm item cao gấp đôi; header chỉ thêm đúng một dòng nhỏ. Nếu tài khoản của hội thoại đang mở đã logout, dòng tài khoản vẫn hiện danh tính kèm trạng thái đó (không giấu danh tính chỉ vì logout). Riêng tư: email chỉ hiện trong cột trái/header của chính VS Code của user (cùng máy, cùng user như panel Cài đặt), KHÔNG đưa vào nội dung tin nhắn chat, KHÔNG log, KHÔNG đưa vào thông báo. Trạng thái Đang chạy/Đã dừng/Đã logout và gate đăng nhập lại giữ nguyên. Lưu ý: việc hiện email chỉ đúng khi tài khoản đã lấy được hồ sơ (điểm 1); tài khoản chưa lấy được hồ sơ vẫn hiện label hoặc "Chưa xác định" — đó là hành vi đúng, không phải lỗi. Logic join nằm ở provider (extension.ts: `accountDisplayFor` + `postSessions`), webview chỉ hiển thị chuỗi đã join.
8. **Icon extension (điểm 5).** Extension giờ có icon riêng tại `images/icon.png` (PNG 128×128, vẽ bằng code PIL — không dùng công cụ sinh ảnh, không sao chép logo chính thức của Muse): khung vuông bo góc nền tím đậm, bong bóng chat trắng kèm chữ M đậm, thêm bong bóng tím nhạt lệch phía sau gợi ý đa tài khoản. Chi tiết cố tình to, ít nét để vẫn nhìn rõ khi thu nhỏ 16–32px. `package.json` có trường `"icon": "images/icon.png"`; `.vscodeignore` không loại trừ thư mục `images/` nên icon được đóng gói vào vsix. Việc icon hiển thị đẹp trên VS Code thật vẫn cần nhìn trực tiếp sau khi cài (máy build Linux không mở được giao diện VS Code Windows để xác nhận bằng mắt).
7. **Sửa đồng bộ hội thoại từ web (điểm 4, lỗi chặn).** `ListWebThreads` bền hơn: ngoài thẻ `<a href>`, quét thêm HTML bằng regex `/thread/<id>` trên `document.documentElement.outerHTML` (bắt cả link trong JSON hydration, data-url, button điều hướng mà `<a>` bỏ sót), hợp nhất rồi khử trùng theo URL, chỉ giữ URL qua được `IsThread`; thay chờ cố định 2,5 giây bằng vòng poll mỗi 500ms tối đa 10 giây, dừng sớm khi số thread ổn định qua 2 lần quét liên tiếp và > 0; sau 10 giây vẫn 0 thì thử mở thêm `https://muse.ai/thread/new` (trang chat mới thường hiện sidebar lịch sử) và lặp lại vòng poll, rồi mới trả về rỗng. Chỉ quét trang danh sách/trang chủ, KHÔNG mở từng thread để quét. Endpoint `web-threads` trả thêm `debug: {pageUrl, linkCount, threadCount}` (chỉ số lượng, không nội dung trang hay tiêu đề nhạy cảm). Phía extension, `syncFromWeb` BỎ khử trùng theo tập URL đã đăng ký trong gateway: chỉ khử trùng theo `threadUrl` của session đã có trong danh sách extension (tập gateway là toàn cục, không phân theo tài khoản, và còn lại sau khi xóa session nên đã chặn nhập lại thread dưới tài khoản khác). Endpoint `GET /admin/conversations/urls` giữ nguyên (không xóa) vì panel khác có thể dùng, nhưng syncFromWeb không dùng nó để khử trùng nữa; không còn chỗ nào khác dùng nó để khử trùng. Hệ quả: session tạo trước v0.6.0 chưa có threadUrl có thể bị nhập trùng một lần trong lần đồng bộ đầu tiên sau bản này (vì không có URL để đối chiếu), user xóa bản trùng tay là xong; từ sau đó các session mới đều có threadUrl nên không trùng nữa. Khi đồng bộ xong mà added = 0, thông báo nêu rõ số thread gateway đọc được từ web (từ debug), số đã bỏ qua vì đã có trong danh sách, và nếu gateway đọc được 0 thread thì nêu rõ trang đã mở và tổng số link đọc được, kèm hướng dẫn mở panel Nhật ký — không chỉ báo "Đã thêm 0" chung chung. Hai điểm cũ giữ nguyên: chỉ tạo session sau khi registerConversation thành công, và banner importedBanner không nằm trong messages nên không gửi lên model.

## Mới trong v0.6.0: đồng bộ hội thoại từ web, mức 1 (chỉ danh sách + nối tiếp, không nhập nội dung cũ)

1. **Phạm vi mức 1.** Nút "Đồng bộ từ web" trong drawer session (cùng nhóm với 4 nút quản lý) hoặc lệnh "Muse: Đồng bộ hội thoại từ web" sẽ: gọi gateway liệt kê thread từ sidebar muse.ai của tài khoản đã chọn, rồi tạo session mới cho mỗi thread chưa có. Session mới có messages trống — **không nhập nội dung tin nhắn cũ**; lịch sử cũ vẫn nằm trên thread web, tin nhắn tiếp theo bạn gửi trong session đó sẽ nối tiếp đúng thread đó nhờ mapping đã đăng ký ở gateway (cùng cơ chế nối tiếp LocalConversationStore: conversationId của session làm hint, gateway mở đúng URL thread đã lưu).
2. **Chọn tài khoản và khử trùng.** Đồng bộ theo từng tài khoản, không lẫn tài khoản: 0 tài khoản thì báo rõ và mở panel Cài đặt; 1 tài khoản thì dùng luôn; nhiều tài khoản thì chọn bằng QuickPick (nhãn + trạng thái, hủy thì dừng êm). Khử trùng theo URL đã chuẩn hóa (bỏ dấu / cuối): thread đã có trong danh sách URL đã đăng ký ở gateway (`GET /admin/conversations/urls`) HOẶC đã có trong `threadUrl` của session extension thì bỏ qua. (Từ v0.7.0 luật này đã đổi: chỉ khử trùng theo `threadUrl` của session extension, xem điểm 4 của v0.7.0 ở trên.) Chỉ sau khi `POST /admin/conversations/register` thành công mới tạo session; register lỗi thì thread đó không tạo session, đếm lỗi và tiếp tục thread khác. Sau đồng bộ hiện "Đã thêm X hội thoại mới từ web, bỏ qua Y hội thoại đã có" (thêm "Z hội thoại lỗi khi đăng ký" nếu có lỗi).
3. **Banner nhập khẩu, không lọt vào model.** Khi mở session đồng bộ từ web, khung chat hiện banner riêng: "Hội thoại này được đồng bộ từ web muse.ai. Lịch sử cũ nằm trên thread web, tin nhắn tiếp theo sẽ nối tiếp thread đó." Banner này không nằm trong `messages` nên không gửi lên model; session thường không hiện banner. Trong danh sách, session từ web có dấu "Từ web". Session mới tuân thủ cùng luật trạng thái 0.5.0 (Đang chạy/Đã dừng/Đã logout theo accountId) và gate đăng nhập lại như session thường.
4. **Gateway mới (đều qua RequireAdmin).** `POST /admin/accounts/{id}/web-threads` (tài khoản không tồn tại → 404; driver không phải browser → 501; cookie hết hạn/redirect login → lỗi Auth tiếng Việt, không trả danh sách rỗng), `POST /admin/conversations/register {accountId, hint, url}` (tài khoản không tồn tại → 404; hint trống hoặc URL không phải thread → 400), `GET /admin/conversations/urls` (trả `{url, accountHash}`; không trả hint gốc, không trả cookie hay thông tin nhạy cảm).
5. **Panel Nhật ký runtime (cùng v0.6.0).** Nút "Nhật ký" trong header khung chat, ngay bên cạnh nút "☰ Quản lý hội thoại", bật/tắt một panel log nằm ngay dưới header (không nằm trong drawer quản lý hội thoại). Panel hiển thị dòng log runtime: mỗi dòng có giờ nhận (HH:MM:SS, do extension thêm khi nhận dòng vì dòng gateway gốc không có timestamp), nội dung dòng giữ nguyên, font monospace, cuộn được, có dòng mới và panel đang mở thì tự cuộn xuống cuối. Thanh công cụ: ô lọc theo từ khóa, nút "Làm mới" (lấy lại toàn bộ buffer), "Sao chép" (copy các dòng đang hiển thị sau lọc vào clipboard), "Xóa" (xóa buffer hiển thị), "Mở Output" (mở OutputChannel 'Muse Gateway'). Các dòng chứa error, lỗi, failed, 502, 503, 429, quota được tô khác màu. Khi chat gặp lỗi, extension cũng ghi lỗi đó vào buffer nên panel có lỗi ngay cả khi gateway stdout im lặng.

## Giới hạn thật của đồng bộ từ web (đọc trước khi dùng v0.6.0)

- Danh sách có thể thiếu nếu sidebar muse.ai tải lười/thu gọn: gateway chỉ chờ ~2,5 giây sau khi trang tải rồi đọc các thẻ `<a>` tới `/thread/<id>` đang có trong DOM; thread nằm ngoài vùng tải lười sẽ không được liệt kê cho tới khi sidebar tải đủ.
- (Đã đổi từ v0.7.0, xem điểm 4 ở trên) Session đã xóa khỏi extension nhưng mapping gateway còn thì thread đó sẽ bị coi là đã có và không nhập lại — từ v0.7.0 syncFromWeb không khử trùng theo mapping gateway nữa nên session đã xóa nhập lại được bình thường.
- Cần Chromium + tài khoản đang đăng nhập tốt: gateway mở page tạm trong đúng context của tài khoản để đọc sidebar; cookie hết hạn thì đồng bộ báo hết hạn, không trả danh sách rỗng.
- Đồng bộ theo từng tài khoản, không lẫn tài khoản; đồng bộ không tự chạy nền, không tự xóa session nào, không đổi tài khoản của session cũ.
- Panel Nhật ký chỉ là cửa sổ xem 1000 dòng gần nhất, lịch sử đầy đủ vẫn ở Output > Muse Gateway; panel log không thay thế Output channel. Nội dung panel là đúng những gì đã có trong OutputChannel (cùng máy, cùng user), gateway không in cookie; dòng nào có dạng gán cookie/key/token thì extension che giá trị trước khi đưa vào buffer, và panel không bao giờ ghi nội dung request, cookie hay key. Diagnostic nội bộ của driver (BrowserDriver.Diagnostic) hiện không được gateway app subscribe nên không hiện trong panel — panel chỉ hiện những gì gateway in ra stdout/stderr cộng với lỗi phía extension.

## Mới trong v0.5.0: layout lại — Cài đặt, drawer session, session gắn tài khoản, trạng thái, gate đăng nhập lại, đa tài khoản

1. **Quản lý tài khoản Muse đưa vào Cài đặt.** Nút "Cài đặt" trong khung chat và lệnh "Muse: Cài đặt" mở panel Cài đặt riêng (tab bên cạnh, không phải Settings UI của VS Code — Settings UI chỉ chứa được cấu hình muse.*, không chứa được danh sách tài khoản). Toàn bộ bảng tài khoản chuyển sang panel này và đã xóa khỏi khung chat để không lệch nhau: trạng thái gateway, danh sách tài khoản (nhãn, trạng thái, bật/tắt, cooldown, lỗi cuối — không bao giờ hiện cookie/token/key), nút từng tài khoản và nút chung như cũ. Panel còn có mục cấu hình Muse hiển thị chỉ đọc (autoApprove, gatewayMode, baseUrl, model...) kèm nút mở Settings UI của VS Code để sửa thật. Khung chat chỉ giữ bubble lỗi đăng nhập với nút "Mở Cài đặt".
2. **Quản lý session kiểu navigation drawer.** Header khung chat có nút "☰ Quản lý hội thoại" + tiêu đề session hiện tại + nút "Cài đặt". Drawer là panel thu gọn/mở được ngay dưới header (không dùng overlay phức tạp trong sidebar): đóng thì chỉ thấy header + chat, mở thì hiện menu + danh sách. Menu đúng 4 nút: "Hội thoại mới", "Đổi tên", "Xóa hội thoại", "Quản lý hội thoại" (ba nút đầu tác động ngay session hiện tại, nút cuối bật/tắt phần danh sách). Bấm item trong danh sách thì đóng drawer và mở lại chat của session đó. Các lệnh palette session vẫn giữ nguyên.
3. **Danh sách hội thoại và tài khoản gắn với session (chuẩn bị multi-account).** Mỗi session giờ lưu thêm accountId/accountLabel (và trạng thái lúc lưu). Khi tạo session mới, extension thử lấy danh sách tài khoản (best effort, không chặn nếu gateway chưa chạy); nếu pool có đúng 1 tài khoản thì ghi tài khoản đó, nếu có 0 hoặc nhiều tài khoản thì để trống (chưa xác định) — tuyệt đối không đoán khi có nhiều tài khoản, vì gateway chọn account theo affinity nội bộ và admin API không lộ mapping conversation → account. Session cũ chưa có accountId sẽ được backfill tương tự trong lần làm mới tài khoản, nếu pool có đúng 1 tài khoản. Danh sách hiển thị tiêu đề, số tin, thời gian cập nhật, thư mục (nếu có) và tài khoản (nhãn, hoặc "Chưa xác định tài khoản").
4. **Trạng thái từng hội thoại trên danh sách.** Đúng 3 giá trị: **Đang chạy** = session hiện tại đang có yêu cầu chạy; **Đã logout** = session có accountId đã lưu nhưng account đó không còn trong pool hoặc trạng thái Invalid (hết hạn); còn lại là **Đã dừng** (gồm session chưa xác định tài khoản và session có account đang active/cooling/disabled — cooling/disabled chỉ ghi chú riêng trong chi tiết, không thành trạng thái thứ 4). Trạng thái tính từ cache tài khoản mới nhất, làm mới tài khoản xong thì gửi lại danh sách; trạng thái chạy không lưu bền (mở lại VS Code thì không còn Đang chạy).
5. **Mở lại chat và gate đăng nhập lại.** Bấm item thì mở lại chat của session đó; nếu tài khoản của session đó đã logout (kiểm tra lúc chuyển, nếu gateway chạy được) thì hiện bubble cảnh báo nhưng vẫn cho xem lại lịch sử cũ. Ở tin nhắn tiếp theo user nhắn, gate ở đầu run() (sau khi đảm bảo gateway chạy, trước khi gửi chat) kiểm tra tài khoản của session: nếu không còn trong pool hoặc Invalid thì KHÔNG gửi chat, hiện bubble yêu cầu đăng nhập lại với nút "Mở Cài đặt"; nếu đang cooling thì chặn với lý do cooling + nút Mở Cài đặt (để reset); nếu bị tắt thì chặn với lý do đã tắt + nút Mở Cài đặt (để bật lại). Nếu session chưa xác định tài khoản, hoặc không đọc được pool do 401 gateway ngoài (admin key riêng), thì KHÔNG chặn để tránh khóa user. Extension không tự gửi lại yêu cầu sau khi đăng nhập lại; user tự gửi lại tin nhắn.
6. **Quản lý đa tài khoản Muse đầy đủ trong panel Cài đặt.** Danh sách tất cả tài khoản trong pool (GET /admin/accounts); bấm vào từng tài khoản để mở rộng xem chi tiết: id, nhãn, trạng thái, bật/tắt, tạo lúc, dùng lần cuối, success_count, fail_count, cooldown, lỗi cuối, ngày hết hạn cookie sớm nhất (chỉ ngày/giờ, không giá trị cookie — panel không hiển thị cookie kể cả dạng đã che), các session đang dùng tài khoản đó, và quota khi bấm "Xem quota" (quota có thể thất bại khi tài khoản Invalid, panel báo nhẹ). Thao tác từng tài khoản: Làm mới/Renew, Xóa cooldown, Bật/Tắt, Đổi tên nhãn (PATCH label qua input box), Đăng xuất/Xóa khỏi pool (DELETE sau khi xác nhận, xóa bền vững khỏi cả file lưu; các session của tài khoản đó chuyển sang Đã logout, session không bị xóa).
   - **Thêm tài khoản — luồng chính: đăng nhập qua trình duyệt.** Nút "Đăng nhập qua trình duyệt" trong panel Cài đặt: nhập nhãn (mặc định "Tài khoản cá nhân"), gateway mở một cửa sổ Chromium có đầu của chính nó (1200×800, Playwright instance riêng, không dùng chung browser của chat nên không gián đoạn chat đang chạy), bạn đăng nhập trong cửa sổ đó, panel poll trạng thái mỗi 3 giây, thành công thì tự làm mới danh sách và báo tên tài khoản đã lưu. Mở muse.ai trong trình duyệt ngoài rồi đăng nhập thì không truyền được session sang gateway (gateway dùng context riêng, không đọc profile trình duyệt hệ thống) nên không dùng cách đó. Chỉ một phiên đăng nhập chờ tại một thời điểm (mở thêm sẽ lỗi rõ kèm id phiên đang chờ); đóng cửa sổ tay thì phiên bị hủy; hết 10 phút chưa đăng nhập thì phiên hết hạn. Chưa cài Chromium thì gateway lỗi rõ và panel hướng dẫn bấm "Cài Chromium cho gateway".
   - **Gia hạn lại: "Đăng nhập lại qua trình duyệt" trên chi tiết từng tài khoản.** Gọi start với accountId đó; cùng danh tính Muse thì cập nhật tài khoản cũ (giữ nguyên Id, xóa cooling); nếu tài khoản vừa đăng nhập khác với tài khoản cần gia hạn thì panel cảnh báo rõ: đã lưu thành tài khoản mới, tài khoản cũ vẫn còn trong danh sách (không tự xóa tài khoản cũ, không tự nối session cũ sang id mới).
   - **Phương án dự phòng: nhập từ app desktop.** Nút "Nhập đăng nhập từ app desktop": (1) trong app Muse desktop dùng nút "Đăng nhập tài khoản khác" để thêm từng tài khoản, (2) trong panel bấm nhập để đưa toàn bộ danh sách vào pool (panel tự làm mới sau khi nhập, qua ensureStarted). Panel không mở form đăng nhập (VS Code không có WebView2, gateway không nhận username/password, chỉ nhận cookie).

## Giới hạn thật (đọc trước khi dùng v0.5.0)

- Đăng nhập lại đầy đủ khi cookie hết hạn có hai đường: đăng nhập qua trình duyệt trong panel Cài đặt (gateway mở cửa sổ Chromium của chính nó, cần Chromium và cửa sổ có đầu trên Windows), hoặc qua app Muse desktop rồi Nhập đăng nhập — vì VS Code không có WebView2 để đăng nhập trực tiếp trong extension.
- Tài khoản của session chỉ xác định chắc khi pool có đúng 1 tài khoản; khi có nhiều tài khoản, session mới/cũ chưa xác định sẽ để trống cho tới khi pool chỉ còn 1 tài khoản lúc backfill.
- Id tài khoản là ngẫu nhiên (acc_ + chuỗi ngẫu nhiên), không suy ra từ danh tính Muse: xóa một tài khoản rồi nhập lại cùng tài khoản Muse đó sẽ có Id mới, và session cũ ghi Id cũ sẽ không tự nối lại được. Extension không tự nối lại theo nhãn, vì nhãn mặc định ("Tài khoản cá nhân") không duy nhất.
- Lệnh nhập đăng nhập ghi đè toàn bộ danh sách tài khoản của gateway bằng danh sách từ app desktop (có sao lưu .bak-timestamp trước khi ghi): tài khoản nào đang ở gateway mà không có trong app desktop sẽ mất sau khi nhập.
- Session trước 0.3.3 không bao giờ được lưu thành danh sách nên không thể khôi phục thành nhiều session cũ, chỉ lịch sử cuối cùng thành 1 session.

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
