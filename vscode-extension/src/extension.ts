import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { GatewayManager, GatewayConfig, GatewayState } from './gateway';
import { fetchGatewayStatus, fetchGatewayAccounts, resetGatewayAccount, renewGatewayAccount, patchGatewayAccount, deleteGatewayAccount, formatAccountLine, fetchWebThreads, registerConversation, deleteGatewayConversation, fetchConversationOwner, fetchThreadMessages, resolveWebTitleUpdated, sessionMatchesAccountFilter, isGenericWebTitle, titleFromFirstUserMessage, fallbackWebTitle, isFallbackWebTitle } from './admin';
import { BackgroundProcesses } from './processes';
import { generateImages, editImage, createVideo, downloadMedia, downloadMediaToFile, writeMediaBuffer, dataUrlOfImageFile, MAX_IMAGE_BYTES } from './media';
import { ComputerHelper, COMPUTER_TOOLS, approveComputerAction, describeComputerCall } from './computer';
import { MuseSettingsPanel } from './settings';
import { SessionStore, ChatSession, ChatMsg, StoreChange } from './sessions';
import { RunManager, computeRunStatus } from './runManager';

// Muse cho VS Code, v0.6.0.
// V0.6.0 thêm đồng bộ hội thoại từ web, mức 1: chỉ liệt kê thread từ
// sidebar muse.ai rồi đăng ký mapping để nối tiếp thread đó (không nhập
// nội dung tin nhắn cũ — lịch sử cũ vẫn nằm trên thread web); và panel
// Nhật ký runtime ngay dưới header, xem 1000 dòng log gần nhất.
// V0.5.0: layout lại — quản lý tài khoản vào panel Cài đặt riêng, session
// kiểu navigation drawer, mỗi session ghi tài khoản Muse (chuẩn bị cho
// multi-account), trạng thái session Đang chạy/Đã dừng/Đã logout, gate
// yêu cầu đăng nhập lại khi tài khoản của session hết hạn/logout.
// V0.6.0: drawer đó đã thay bằng cột hội thoại bên trái khung chat.
// Kiến trúc: extension này là GIAO DIỆN CHAT trong VS Code. Nó gọi gateway
// Muse2Api qua API tương thích OpenAI (/v1/chat/completions), rồi tự thực
// thi các tool cục bộ bằng API của VS Code / Node trong đúng workspace
// đang mở — cùng giao thức tool mà agent terminal Muse2Api.Agent dùng
// (khối ```json {"tool_calls": [...]} và khối ```tool legacy). Từ v0.2.0,
// gateway Muse2Api được đóng gói kèm theo extension (bin/win-x64) và tự
// chạy mỗi lần mở VS Code (activation onStartupFinished); nếu đã có
// gateway ngoài chạy sẵn ở cùng cổng thì extension dùng luôn gateway đó.
// Mọi thao tác ghi tệp / chạy lệnh đều hỏi duyệt trước, trừ khi người dùng
// bật muse.autoApprove — ngoại trừ đường dẫn nhạy cảm (.env/.key/.pem/
// .git/secrets) luôn hỏi duyệt riêng, và mọi hành động điều khiển màn
// hình nguy hiểm luôn hỏi duyệt riêng, kể cả khi autoApprove bật.
// Lệnh chạy với quyền của người dùng và KHÔNG bị
// sandbox trong workspace, đúng như bản desktop đã cảnh báo.
// V0.3.0 thêm: streaming chat, đính kèm ảnh, tạo/sửa ảnh, tạo video,
// quản lý tài khoản gateway, tiến trình nền (Node child_process, không
// dùng VS Code terminal API để lấy output), lưu lịch sử chat, và điều
// khiển màn hình Windows THỬ NGHIỆM qua helper .NET riêng (không load
// DLL net10-windows vào Node).

interface ToolCall { name: string; args: Record<string, unknown>; }
type ChatContent = string | Array<Record<string, unknown>>;
interface PendingAttachment { name: string; size: number; kind: 'image' | 'text' | 'video' | 'file'; kindLabel: string; dataUrl?: string; text?: string; note?: string; mime?: string; }
// File đính kèm gửi nguyên qua gateway (tool send_file / đính kèm
// tay / kéo thả): filename + mime + data URL, đúng dạng gateway
// parse ở Prompt.ContentToText (type "file").
interface ToolFilePart { filename: string; mime: string; dataUrl: string; }

// Trạng thái của MỘT lượt chạy agent (v0.8.27). Trước 0.8.27, các
// trường này nằm rải trên provider (lastStreamed/lastToolImages/
// lastToolFiles/lastComputerImage/turnFileCount) nên hai run chạy cùng
// lúc trên cùng một surface (sidebar gửi session A rồi chuyển sang gửi
// session B) sẽ ghi đè lẫn nhau. Từ 0.8.27, mỗi run có RunCtx riêng,
// truyền qua chatOnce/execute — surface chỉ giữ đính kèm chờ gửi
// (pendingAttachments, thuộc về lần bấm Gửi của chính surface đó).
interface RunCtx {
  lastStreamed: boolean;
  lastToolImages: string[];
  lastToolFiles: ToolFilePart[];
  lastComputerImage?: string;
  turnFileCount: number;
  // v0.8.29: tool media chat cần 3 thứ của riêng lượt này — tin nhắn
  // user gốc (để kiểm tra đường dẫn tuyệt đối ngoài workspace có nằm
  // trong tin nhắn không), gateway đã ensure (baseUrl/apiKey thật, vì
  // execute() chỉ nhận conf settings chứ không có key quản lý), và
  // callback báo tiến trình tạo video qua sink (execute() không cầm
  // sink trực tiếp). Đặt ở run(), sau ensureStarted mới đủ cả ba.
  turnUserText: string;
  gateway?: { baseUrl: string; apiKey: string };
  onStatus?: (text: string) => void;
}

// Sink hiển thị của một run (v0.8.27): thay cho this.post() trong vòng
// lặp run(). post() chuyển tiếp sự kiện tới MỌI bề mặt đang hiển thị
// đúng session đó (sidebar/panel cùng nhìn một RunManager nên mở cùng
// session ở 2 nơi đều thấy cùng tiến trình) và ghi vào live snapshot
// của slot để bề mặt mở session giữa chừng replay được. done() ngoài
// các bề mặt đang hiển thị còn gửi cho surface gốc (để nút Gửi của nó
// hết loading dù user đã chuyển surface đó sang session khác — done
// chỉ clear loading, không vẽ bubble nên không làm bẩn session khác).
// Riêng 'attachmentsCleared' KHÔNG qua sink: chip đính kèm thuộc về
// surface gốc, xóa ở bề mặt khác sẽ là sai.
interface RunSink {
  post: (type: string, payload: Record<string, unknown>) => void;
  done: () => void;
}

// Danh sách đuôi dùng chung cho mọi đường đính kèm (v0.8.12): hộp chọn
// file, kéo thả theo đường dẫn và kéo thả theo nội dung trong bộ nhớ đều
// phân loại bằng đúng ba danh sách này, để không lệch nhau theo đường đi.
const IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
const VIDEO_EXTS = ['.mp4', '.mov', '.webm', '.avi', '.mkv'];
// v0.8.20: giới hạn file gửi nguyên, theo giới hạn của web muse.ai.
// 25 MB là 25.000.000 byte thập phân (không phải 25 MiB), tối đa
// 10 file mỗi lượt gửi. Vượt thì báo lỗi rõ, không bịa nội dung.
export const MAX_FILE_BYTES = 25_000_000;
export const MAX_FILES_PER_TURN = 10;

// Mime theo đuôi file cho file gửi nguyên (gateway nhận mime thật
// để web hiển thị đúng loại; đuôi lạ thì octet-stream, web tự xử).
// Hàm thuần để test trực tiếp từ out/extension.js.
export function mimeForFile(name: string): string {
  const ext = path.extname(name).toLowerCase();
  switch (ext) {
    case '.mp4': return 'video/mp4';
    case '.mov': return 'video/quicktime';
    case '.webm': return 'video/webm';
    case '.avi': return 'video/x-msvideo';
    case '.mkv': return 'video/x-matroska';
    case '.mp3': return 'audio/mpeg';
    case '.wav': return 'audio/wav';
    case '.ogg': return 'audio/ogg';
    case '.m4a': return 'audio/mp4';
    case '.pdf': return 'application/pdf';
    case '.zip': return 'application/zip';
    case '.doc': return 'application/msword';
    case '.docx': return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case '.xls': return 'application/vnd.ms-excel';
    case '.xlsx': return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case '.ppt': return 'application/vnd.ms-powerpoint';
    case '.pptx': return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case '.txt': return 'text/plain';
    case '.json': return 'application/json';
    case '.png': return 'image/png';
    case '.jpg': case '.jpeg': return 'image/jpeg';
    case '.webp': return 'image/webp';
    case '.gif': return 'image/gif';
    default: return 'application/octet-stream';
  }
}

// Kiểm tra giới hạn file gửi nguyên trước khi đọc bytes: trả null
// nếu được gửi, ngược lại trả thông báo lỗi tiếng Việt để caller
// báo đúng câu đó (không bịa, không gửi lén file đã cắt).
// Hàm thuần để test trực tiếp từ out/extension.js.
export function checkFileAttachmentLimit(size: number, currentFileCount: number): string | null {
  if (size <= 0) { return 'Tệp rỗng, không gửi được.'; }
  if (size > MAX_FILE_BYTES) { return `Tệp vượt quá tối đa 25 MB (giới hạn của web).`; }
  if (currentFileCount >= MAX_FILES_PER_TURN) { return `Đã đủ tối đa 10 file mỗi lượt gửi.`; }
  return null;
}
const TEXT_EXTS = ['.txt', '.md', '.markdown', '.json', '.jsonc', '.csv', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.cs', '.java', '.c', '.h', '.cpp', '.go', '.rs', '.rb', '.php', '.sql', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.sh', '.ps1', '.bat'];

// Ước lượng số byte giải mã của một data URL base64 (v0.8.12, hàm thuần
// để test đơn vị trực tiếp từ out/extension.js): data URL không phải
// base64, rỗng hoặc thiếu phần dữ liệu thì trả 0 để caller coi là lỗi
// ảnh rỗng; ngược lại trừ padding '=' khỏi công thức len*3/4. Dùng cho
// ảnh kéo thả từ ngoài hệ điều hành, vì đường này không có file trên
// đĩa để dataUrlOfImageFile kiểm tra như đường theo đường dẫn.
export function decodeDataUrlBytes(dataUrl: string): number {
  if (!dataUrl || !dataUrl.startsWith('data:')) { return 0; }
  const comma = dataUrl.indexOf(',');
  if (comma < 0) { return 0; }
  const meta = dataUrl.slice(5, comma);
  const b64 = dataUrl.slice(comma + 1);
  if (!meta.endsWith(';base64') || b64.length === 0) { return 0; }
  let padding = 0;
  if (b64.endsWith('==')) { padding = 2; } else if (b64.endsWith('=')) { padding = 1; }
  return Math.floor(b64.length * 3 / 4) - padding;
}

// Hàm thuần đứng sau decodeDataUrlBytes, được addDroppedFileAttachment
// gọi (xem comment ở đó). Trả PendingAttachment; ném lỗi chỉ cho ảnh
// rỗng/quá lớn.
export function buildDroppedAttachment(file: { name?: unknown; size?: unknown; dataUrl?: unknown; text?: unknown; type?: unknown; tooLarge?: unknown }): PendingAttachment {
  const name = typeof file.name === 'string' && file.name ? file.name : 'tệp';
  const size = typeof file.size === 'number' && file.size >= 0 ? file.size : 0;
  const ext = path.extname(name).toLowerCase();
  if (IMAGE_EXTS.includes(ext)) {
    const dataUrl = typeof file.dataUrl === 'string' ? file.dataUrl : '';
    const decodedBytes = decodeDataUrlBytes(dataUrl);
    if (decodedBytes === 0 || decodedBytes > MAX_IMAGE_BYTES) {
      throw new Error(`Ảnh ${name} phải khác rỗng và tối đa 20 MiB.`);
    }
    return { name, size, kind: 'image', kindLabel: 'Ảnh', dataUrl };
  }
  // v0.8.20: webview báo tooLarge khi file vượt 25 MB (không đọc
  // bytes vào bộ nhớ nữa) — thành lỗi rõ, không tạo note giả vờ.
  if (file.tooLarge === true) {
    throw new Error(`Tệp ${name} vượt quá tối đa 25 MB (giới hạn của web).`);
  }
  // v0.8.20: video và file generic kéo thả từ hệ điều hành giờ
  // gửi nguyên qua file part (webview đọc đủ bytes dạng dataUrl),
  // không còn note thay thế như trước. Mime ưu tiên type trình
  // duyệt báo, thiếu thì suy từ đuôi file.
  if (typeof file.dataUrl === 'string' && file.dataUrl.startsWith('data:')) {
    const decodedBytes = decodeDataUrlBytes(file.dataUrl);
    if (decodedBytes === 0) {
      throw new Error(`Không đọc được nội dung tệp ${name}.`);
    }
    if (decodedBytes > MAX_FILE_BYTES) {
      throw new Error(`Tệp ${name} vượt quá tối đa 25 MB (giới hạn của web).`);
    }
    const mime = typeof file.type === 'string' && file.type ? file.type : mimeForFile(name);
    return { name, size, kind: 'file', kindLabel: VIDEO_EXTS.includes(ext) ? 'Video' : 'Tệp', dataUrl: file.dataUrl, mime };
  }
  if (typeof file.text === 'string') {
    const limit = 500 * 1024;
    const text = file.text.length > limit ? file.text.slice(0, limit) + `\n[Đã cắt nội dung ở 500 KiB, tệp gốc ${Math.round(size / 1024)} KiB.]` : file.text;
    return { name, size, kind: 'text', kindLabel: 'Văn bản', text };
  }
  // Không dataUrl cũng không text nghĩa là webview đọc hỏng — báo
  // lỗi rõ thay vì tạo note chỉ có tên/dung lượng như trước.
  throw new Error(`Không đọc được nội dung tệp ${name}.`);
}

// v0.8.18: hàm thuần cho 2 tool media mới, để test đơn vị trực tiếp
// từ out/extension.js mà không cần khởi tạo panel chat.
// validateImageExt trả null nếu đuôi ảnh được hỗ trợ, ngược lại trả
// thông báo lỗi (so sánh không phân biệt hoa thường).
export function validateImageExt(ext: string): string | null {
  if (IMAGE_EXTS.includes(ext.toLowerCase())) { return null; }
  return `read_image chỉ nhận ảnh ${IMAGE_EXTS.join(', ')}`;
}

// parseVideoTimes: times bỏ trống thì mặc định [1]; ngược lại phải là
// mảng 1-4 số hữu hạn, mỗi mốc >= 0. Trả { times } hoặc { error }.
export function parseVideoTimes(raw: unknown): { times: number[] } | { error: string } {
  if (raw === undefined) { return { times: [1] }; }
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > 4) {
    return { error: 'read_video_frames cần times là mảng 1-4 mốc giây.' };
  }
  const times: number[] = [];
  for (const t of raw) {
    if (typeof t !== 'number' || !Number.isFinite(t) || t < 0) {
      return { error: `Mốc thời gian phải là số >= 0, nhận được '${String(t)}'.` };
    }
    times.push(t);
  }
  return { times };
}

// toolResultContent: dựng nội dung message TOOL_RESULT cho một call.
// Có ảnh thì trả parts [text, ...image_url], có file thì thêm
// ...file part {type:"file", file:{filename, mime, data_url}} —
// đúng dạng gateway parse ở Prompt.ContentToText (xem
// Prompt.Flatten); không ảnh/file thì trả text thuần. Tái dùng
// cho cả read_image, read_video_frames, send_file và ảnh
// screenshot computer_*.
export function toolResultContent(callName: string, result: string, images: string[], files: ToolFilePart[] = []): ChatContent {
  if (images.length === 0 && files.length === 0) { return `TOOL_RESULT ${callName}:\n${result}`; }
  return [
    { type: 'text', text: `TOOL_RESULT ${callName}:\n${result}` },
    ...images.map((url) => ({ type: 'image_url', image_url: { url } })),
    ...files.map((f) => ({ type: 'file', file: { filename: f.filename, mime: f.mime, data_url: f.dataUrl } })),
  ];
}

// v0.8.23: tự tìm file cho send_file khi đường dẫn chính xác không
// resolve ra file. Chỉ đi dưới root, dùng đúng tập SKIP_DIRS của
// list_files/search_files, chỉ recurse vào thư mục thật (Dirent của
// symlink có isDirectory() false nên không bị đi lạc), bỏ qua thư mục
// không đọc được, chỉ xét tệp (isFile(), symlink không tính). So khớp
// tên không phân biệt hoa thường, thỏa MỘT trong: relative path bằng
// đúng arg; relative path kết thúc bằng '/' + arg (arg là đoạn cuối
// đường dẫn, ví dụ chỉ tên file); arg kết thúc bằng '/' + relative
// path (arg thừa tiền tố đầu, ví dụ root là DaiChienRungXanh mà arg
// ghi DaiChienRungXanh/data/.../shot_0031.mp4). Trả về các đường dẫn
// tương đối dạng posix ('/' nối), không giới hạn số lượng ở đây (giới
// hạn hiển thị 20 do caller quyết).
export function findSendFileCandidates(root: string, arg: string): string[] {
  let a = arg.replace(/\\/g, '/').trim();
  while (a.startsWith('./')) { a = a.slice(2); }
  while (a.startsWith('/')) { a = a.slice(1); }
  const parts: string[] = [];
  for (const seg of a.split('/')) {
    if (seg === '' || seg === '.') { continue; }
    if (seg === '..') {
      if (parts.length === 0) { return []; }
      parts.pop();
      continue;
    }
    parts.push(seg);
  }
  if (parts.length === 0) { return []; }
  const needle = parts.join('/').toLowerCase();
  const out: string[] = [];
  const walk = (d: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) { walk(full); }
        continue;
      }
      if (!e.isFile()) { continue; }
      const rel = path.relative(root, full).split(path.sep).join('/');
      const relLower = rel.toLowerCase();
      if (relLower === needle || relLower.endsWith('/' + needle) || needle.endsWith('/' + relLower)) {
        out.push(rel);
      }
    }
  };
  walk(root);
  return out;
}

// v0.8.29: quy tắc đường dẫn đích cho tool media chat (generate_image,
// edit_image, generate_video, save_media). Đây là tool GHI FILE TỰ ĐỘNG
// theo đường dẫn model đưa ra nên phải chặn model bịa đường dẫn ra
// ngoài workspace — khác với resolve() của tool thường (ném lỗi cho
// MỌI đường dẫn ngoài workspace, kể cả đường dẫn user đã chỉ định):
// - Tương đối → resolve dưới workspace root, thoát root bằng '..' thì
//   từ chối (escape).
// - Tuyệt đối trong workspace → cho phép.
// - Tuyệt đối ngoài workspace → CHỈ cho phép khi chuỗi path đã chuẩn
//   hóa (thống nhất dấu / và \) xuất hiện đúng trong tin nhắn user của
//   lượt chat đó — tin nhắn user chính là sự cho phép cho đúng đường
//   dẫn đó. Không khớp thì từ chối, tuyệt đối không ghi theo path
//   model bịa ra, và KHÔNG mở hộp thoại lưu (tool chat không hỏi lại).
// pm là module path của nền tảng đích (mặc định là path của máy chạy);
// harness truyền path.win32/path.posix để test cả đường dẫn Windows
// kiểu D:\... ngay trên Linux. Hàm thuần để test trực tiếp.
export function normalizePathForMatch(p: string): string {
  return p.replace(/\\/g, '/');
}

export type MediaDestResult =
  | { ok: true; abs: string }
  | { ok: false; reason: 'missing' | 'escape' | 'outside_unmatched'; raw: string };

export function resolveMediaDest(
  root: string, rawPath: string, userText: string, pm: typeof path = path,
): MediaDestResult {
  const raw = rawPath.trim();
  if (!raw) { return { ok: false, reason: 'missing', raw: rawPath }; }
  if (pm.isAbsolute(raw)) {
    const abs = pm.resolve(raw);
    const rel = pm.relative(root, abs);
    const inside = rel !== '' && rel !== '..' && !rel.startsWith('..' + pm.sep) && !pm.isAbsolute(rel);
    if (inside || abs === root) { return { ok: true, abs }; }
    const normAbs = normalizePathForMatch(abs);
    const normUser = normalizePathForMatch(userText);
    if (normUser.includes(normAbs)) { return { ok: true, abs }; }
    return { ok: false, reason: 'outside_unmatched', raw: rawPath };
  }
  const abs = pm.resolve(root, raw.replace(/\\/g, '/'));
  const rel = pm.relative(root, abs);
  if (rel === '..' || rel.startsWith('..' + pm.sep) || pm.isAbsolute(rel)) {
    return { ok: false, reason: 'escape', raw: rawPath };
  }
  return { ok: true, abs };
}

// Đặt tên file đích cho tool media (hàm thuần để test trực tiếp):
// - Chưa có đuôi thì thêm đuôi mặc định (.png cho ảnh, .mp4 cho video).
// - generate_image với n > 1 thì chèn _1.._n TRƯỚC đuôi file
//   (out/a.png → out/a_1.png, out/a_2.png), n = 1 giữ nguyên path.
export function mediaDestWithDefaultExt(absPath: string, defaultExt: string, pm: typeof path = path): string {
  return pm.extname(absPath) === '' ? absPath + defaultExt : absPath;
}

export function numberedMediaDest(absPath: string, index: number, pm: typeof path = path): string {
  const ext = pm.extname(absPath);
  return absPath.slice(0, absPath.length - ext.length) + '_' + index + ext;
}

// Quyết định duyệt ghi cho tool media chat (hàm thuần để test trực
// tiếp): refuse khi đường dẫn không thỏa quy tắc (thiếu/escape/
// ngoài workspace mà không khớp tin nhắn user); ask khi đường dẫn thỏa
// nhưng là đường dẫn nhạy cảm (luật đứng: nhạy cảm luôn hỏi riêng kể
// cả khi autoApprove bật); skip khi thỏa và không nhạy cảm — tin nhắn
// user đã là sự cho phép cho đúng đường dẫn đó nên không mở modal
// duyệt ghi (README 0.8.29 ghi rõ lựa chọn này).
export type MediaWriteDecision =
  | { decision: 'skip'; abs: string }
  | { decision: 'ask'; abs: string }
  | { decision: 'refuse'; reason: 'missing' | 'escape' | 'outside_unmatched'; raw: string };

export function decideMediaWrite(
  root: string, rawPath: string, userText: string, sensitive: boolean, pm: typeof path = path,
): MediaWriteDecision {
  const resolved = resolveMediaDest(root, rawPath, userText, pm);
  if (!resolved.ok) { return { decision: 'refuse', reason: resolved.reason, raw: resolved.raw }; }
  if (sensitive) { return { decision: 'ask', abs: resolved.abs }; }
  return { decision: 'skip', abs: resolved.abs };
}

// v0.8.19: thứ tự hiển thị danh sách hội thoại, mới nhất lên đầu.
// Chỉ đổi thứ tự hiển thị: không đổi thứ tự lưu trong store (sort trên
// bản sao), tie-break createdAt desc rồi giữ thứ tự gốc nhờ sort ổn định.
export function sortSessionsNewestFirst<T extends { updatedAt: number; createdAt: number }>(sessions: T[]): T[] {
  return [...sessions].sort((a, b) => (b.updatedAt - a.updatedAt) || (b.createdAt - a.createdAt));
}

// v0.8.19: chọn session mở mặc định khi tạo bề mặt chat mới.
// - Có initialSessionId tường minh (mở tab mới cho một session cụ thể):
//   giữ nguyên hành vi cũ, tìm đúng session đó, không tìm thấy thì về
//   savedCurrentSessionId cũ, vẫn không thấy thì không chọn gì.
// - Không có initialSessionId (mở sidebar/panel bình thường): chọn
//   session có updatedAt lớn nhất, kể cả khi savedCurrentSessionId cũ
//   đang trỏ session khác (đó chính là lỗi mở lên không vào hội thoại
//   vừa tương tác). Store rỗng thì không chọn gì, không tự tạo session.
export function pickInitialSession<T extends { id: string; updatedAt: number; createdAt: number }>(
  sessions: T[], initialSessionId: string | undefined, savedCurrentSessionId: string,
): T | undefined {
  if (initialSessionId) {
    return sessions.find((s) => s.id === initialSessionId)
      ?? sessions.find((s) => s.id === savedCurrentSessionId);
  }
  return sortSessionsNewestFirst(sessions)[0];
}
const SYSTEM_PROMPT = [
  'Bạn là Muse, trợ lý lập trình chạy trong VS Code, làm việc trực tiếp trên',
  'dự án người dùng đang mở. Nói tiếng Việt rõ ràng, ngắn gọn.',
  'QUY TẮC QUAN TRỌNG VỀ KHI NÀO DÙNG TOOL (v0.8.2): chỉ dùng tool cục bộ',
  'khi user yêu cầu làm việc với file/code trong workspace (đọc, sửa, chạy,',
  'tìm). Với câu chào hỏi, câu hỏi chung, trò chuyện thông thường thì trả',
  "lời trực tiếp, KHÔNG quét workspace trước, KHÔNG gọi tool để 'tìm hiểu",
  'ngữ cảnh khi user chưa yêu cầu. Không tự nhận đã làm gì khi chưa có kết',
  'quả công cụ trả về, không bịa nội dung tệp. Với ảnh/video/file cũng vậy:',
  'chỉ gọi read_image/read_video_frames/send_file khi user yêu cầu kiểm tra',
  'media/file trong workspace, không tự quét media toàn workspace khi chưa',
  'được yêu cầu; khung hình video chỉ là mẫu, không bao giờ nhận đó là',
  'toàn bộ video; web nhận được file không đồng nghĩa bạn xử lý được nội',
  'dung video bên trong — không xem được thì nói rõ, đừng bịa.',
  '',
  'CÔNG CỤ (gửi đúng một khối JSON trong một code fence ```json):',
  '```json',
  '{"tool_calls":[{"name":"read_file","arguments":{"path":"src/Program.cs"}}]}',
  '```',
  'Định dạng cũ ```tool {"name":"read_file","path":"src/Program.cs"} cũng được.',
  'Các công cụ: list_files {path, recursive, limit, offset} (mặc định limit',
  '50; dùng limit/offset để xem tiếp, không quét đệ quy toàn bộ workspace',
  'khi chưa cần), read_file {path, start_line,',
  'max_lines}, read_files {paths}, search_files {query, path, case_sensitive},',
  'read_image {path} (chỉ ảnh .png/.jpg/.jpeg/.webp/.gif trong workspace,',
  'tối đa 20 MiB/ảnh, ảnh gửi kèm kết quả), read_video_frames {path,',
  'times?} (video trong workspace, trích tối đa 4 khung hình tại các mốc',
  'giây trong times, mặc định [1], cần ffmpeg; chỉ gửi khung hình mẫu,',
  'không gửi video gốc), send_file {path} (gửi NGUYÊN file trong workspace',
  'lên web kèm kết quả: video nguyên file, pdf, zip, audio, file generic;',
  'mỗi file tối đa 25 MB (giới hạn của web), tối đa 10 file mỗi lượt gửi;',
  'dùng send_file khi user muốn gửi nguyên file, dùng read_video_frames',
  'khi chỉ cần xem nhanh vài khung hình mẫu),',
  'khi user chỉ nêu tên file mà không có đường dẫn đầy đủ thì cứ gọi',
  'send_file với tên đó, extension sẽ tự tìm trong workspace (duy nhất',
  'thì gửi, nhiều thì báo danh sách để chọn); không bao giờ yêu cầu',
  'user tự đính kèm/gửi thủ công file đã nằm trong workspace, mà phải',
  'tự tìm bằng send_file (hoặc list_files nếu cần xác nhận),',
  'write_file {path, content}, edit_file {path, old_text, new_text} hoặc',
  'edit_file {path, edits:[{old_text, new_text}]}, run_command {command,',
  'workdir, shell, timeout_seconds} hoặc run_command {command, background:true,',
  'timeout_seconds} để chạy nền rồi dùng process_status/process_input/',
  'process_stop với process_id trả về, git_status {}, git_diff {}.',
  'CÔNG CỤ TẠO MEDIA VÀ LƯU THẲNG VÀO ĐƯỜNG DẪN (v0.8.29): khi tin',
  'nhắn user vừa có prompt tạo media vừa có đường dẫn đích thì gọi ngay',
  'tool dưới đây với đúng đường dẫn đó, KHÔNG hỏi lại, KHÔNG mở hộp',
  'thoại lưu (khác 3 lệnh palette "Muse: Tạo ảnh / Sửa ảnh / Tạo video"',
  'vẫn hỏi thư mục sau khi tạo). Sau khi lưu xong, câu trả lời cuối',
  'PHẢI nêu rõ đường dẫn cuối cùng đã lưu.',
  'generate_image {prompt, path, n?, size?} (n 1–4, mặc định 1; n = 1',
  'thì lưu đúng path; n > 1 thì chèn _1.._n trước đuôi file; path',
  'không có đuôi thì thêm .png), edit_image {prompt, path, images}',
  '(images là 1–4 đường dẫn ảnh gốc trong workspace), generate_video',
  '{prompt, path, duration?, first_frame?} (duration 1–60 giây; tạo',
  'video có thể chờ tới 15 phút, user bấm Dừng thì dừng được),',
  'save_media {url, path} (tải URL bất kỳ về đúng path). Ví dụ user',
  'viết "Tạo video mèo đuổi bướm, lưu vào D:\\videos\\meo.mp4" thì gọi',
  'ngay generate_video với path đó, không hỏi lại. Nếu user yêu cầu tạo',
  'media mà KHÔNG nêu đường dẫn thì báo rõ là thiếu đường dẫn và hỏi',
  'lại user, tuyệt đối không tự chọn đường dẫn mặc định, không tự đoán.',
  'File đích đã tồn tại thì ghi đè (vì đó là "đường dẫn cuối cùng"',
  'user chỉ định) và kết quả tool sẽ ghi rõ đã ghi đè file nào.',
  'Công cụ điều khiển màn hình (chỉ thử nghiệm, chỉ Windows, chỉ khi người',
  'dùng đã bật và chọn cửa sổ đích): computer_list_windows {},',
  'computer_inspect {element_id?}, computer_screenshot {}, computer_click',
  '{x, y, snapshot_id, double_click?}, computer_type {element_id, text},',
  'computer_key {key}, computer_scroll {element_id, direction: up|down},',
  'computer_invoke {element_id}, computer_set_value {element_id, text},',
  'computer_focus {}, computer_assert {element_id, property: name|value|toggle|',
  'enabled|offscreen|selected, expected, match?: contains, wait_ms?},',
  'computer_toggle {element_id, state: on|off}, computer_select {element_id},',
  'computer_expand {element_id, expanded?}. Trước khi dùng computer_click phải',
  'chụp computer_screenshot mới và dùng đúng snapshot_id của nó; trước khi',
  'dùng các tool theo element_id phải chạy computer_inspect mới, vì id cũ',
  'hết hạn sau 180 giây. Nếu extension báo điều khiển màn hình đang tắt,',
  'thiếu helper hoặc chưa chọn cửa sổ thì dừng và nói rõ cho người dùng,',
  'không tự bịa cửa sổ hay tọa độ.',
  'Quy tắc: tệp đã có phải đọc trước khi sửa; edit_file yêu cầu old_text khớp',
  'đúng một lần; ưu tiên sửa nhỏ thay vì ghi đè toàn bộ; bỏ qua thư mục',
  'bin, obj, node_modules, .git khi duyệt/tìm; đường dẫn chỉ trong workspace,',
  'không dùng đường dẫn tuyệt đối ngoài workspace — NGOẠI LỆ DUY NHẤT:',
  '4 tool media v0.8.29 được ghi ra đường dẫn tuyệt đối ngoài workspace',
  'KHI VÀ CHỈ KHI chuỗi đường dẫn đó (thống nhất dấu / và \\) xuất hiện',
  'đúng trong tin nhắn user của lượt đó; ngoài trường hợp đó thì tool',
  'media cũng từ chối đường dẫn ngoài workspace như mọi tool khác; lệnh không chờ nhập liệu,',
  'không chạy lệnh tương tác; một lệnh chỉ được coi là thành công khi',
  'exit_code = 0. Thao tác ghi tệp và chạy lệnh sẽ được extension hỏi người',
  'dùng duyệt trước khi thực thi; nếu bị từ chối thì tôn trọng, không thử',
  'lách bằng cách khác. Sau mỗi kết quả công cụ, tiếp tục bước tiếp theo hoặc trả lời cuối.',
  'Câu trả lời cuối không chứa khối tool, tóm tắt đã đổi gì và đã kiểm tra gì.',
].join('\n');

// v0.8.2, việc 4: prompt khi muse.localTools = false. KHÔNG chứa bất
// kỳ hướng dẫn tool cục bộ nào, để không còn dữ liệu workspace nào
// được gửi lên model qua tool. Agent ở chế độ này chỉ trò chuyện.
const SYSTEM_PROMPT_CHAT_ONLY = [
  'Bạn là Muse, trợ lý trò chuyện trong VS Code. Nói tiếng Việt rõ ràng, ngắn gọn.',
  'Chế độ chat thuần đang bật: bạn KHÔNG có tool cục bộ, KHÔNG đọc, sửa hay',
  'chạy gì trong workspace, KHÔNG quét workspace, KHÔNG gửi bất kỳ khối tool',
  'nào. Chỉ trả lời trực tiếp bằng văn bản. Nếu user yêu cầu làm việc với',
  'file/code, hãy nói rõ rằng tool cục bộ đang tắt và cần bật lại bằng lệnh',
  '"Muse: Bật/Tắt tool cục bộ" rồi mới làm được việc đó.',
].join('\n');

const READ_ONLY_TOOLS = new Set(['list_files', 'read_file', 'read_files', 'search_files', 'git_status', 'git_diff', 'read_image', 'read_video_frames', 'send_file']);
const SKIP_DIRS = new Set(['bin', 'obj', 'node_modules', '.git', '.vs', 'dist']);
const ALIASES: Record<string, string> = {
  readFile: 'read_file', writeFile: 'write_file', editFile: 'edit_file',
  list_directory: 'list_files', listFiles: 'list_files', searchFiles: 'search_files',
  execute_command: 'run_command', run_terminal_cmd: 'run_command', runCommand: 'run_command',
  run_cmd: 'run_command', run_powershell: 'run_command',
  replace_in_file: 'edit_file', search_replace: 'edit_file',
};

function cfg() {
  const c = vscode.workspace.getConfiguration('muse');
  const mode = c.get<string>('gatewayMode') || 'auto';
  return {
    baseUrl: (c.get<string>('baseUrl') || 'http://127.0.0.1:18610/v1').replace(/\/+$/, ''),
    model: c.get<string>('model') || 'muse-chat',
    apiKey: c.get<string>('apiKey') || '',
    maxSteps: Math.max(1, c.get<number>('maxSteps') || 30),
    autoApprove: c.get<boolean>('autoApprove') || false,
    // v0.8.2, việc 4: chế độ chat thuần. Mặc định true (giữ hành vi
    // cũ); chỉ false khi user chủ động tắt (setting hoặc lệnh palette).
    // Dùng !== false thay vì || true để false thật không bị nuốt.
    localTools: c.get<boolean>('localTools') !== false,
    commandTimeout: Math.max(5, c.get<number>('commandTimeoutSeconds') || 120),
    gatewayMode: (mode === 'bundled' || mode === 'external' ? mode : 'auto') as GatewayConfig['gatewayMode'],
    gatewayPath: c.get<string>('gatewayPath') || '',
    allowComputerControl: c.get<boolean>('allowComputerControl') || false,
    computerHelperPath: c.get<string>('computerHelperPath') || '',
  };
}

function gatewayConfig(): GatewayConfig {
  const c = cfg();
  return { baseUrl: c.baseUrl, apiKey: c.apiKey, gatewayMode: c.gatewayMode, gatewayPath: c.gatewayPath };
}

function workspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : fallback;
}
function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}
// Giờ nhận dòng log, dạng HH:MM:SS (v0.6.0, panel Nhật ký): extension
// thêm khi nhận dòng, vì dòng gateway gốc không có timestamp.
function logTimeNow(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
function truncate(text: string, max = 8000): string {
  return text.length > max ? text.slice(0, max) + `\n... (đã cắt, còn ${text.length - max} ký tự)` : text;
}

// Đường dẫn nhạy cảm: luôn hỏi duyệt riêng kể cả khi autoApprove bật.
// Khớp tên tệp/thư mục ở bất kỳ cấp nào, không khớp chuỗi con vô tội
// (ví dụ "mysecrets.txt" không tính, nhưng "secrets/api.json" thì tính).
function isSensitivePath(relPath: string): boolean {
  const parts = relPath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.some((p, i) => {
    const lower = p.toLowerCase();
    if (lower === '.git' || lower === 'secrets' || lower === '.secrets') { return true; }
    if (lower.startsWith('.env')) { return true; }
    if (i === parts.length - 1 && (lower.endsWith('.key') || lower.endsWith('.pem') || lower.endsWith('.pfx') || lower.endsWith('.p12'))) { return true; }
    if (i === parts.length - 1 && (lower === 'credentials.json' || lower === 'credentials' || lower.includes('credential'))) { return true; }
    return false;
  });
}

class MuseChatProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'muse.chat';
  // Đăng ký mọi bề mặt chat đang sống (sidebar + các tab panel) để
  // thao tác tài khoản ở panel Cài đặt, gộp trùng hay xóa hoàn toàn
  // đều làm mới được tất cả các bề mặt, không chỉ sidebar. Panel đóng
  // thì tự gỡ khỏi tập này (disposeSurface), không rò rỉ.
  private static surfaces = new Set<MuseChatProvider>();
  static refreshAllAccounts(): void {
    for (const surface of [...MuseChatProvider.surfaces]) { void surface.refreshAccounts(); }
  }
  // Gửi lại danh sách + dropdown lọc cho mọi bề mặt mà không đọc lại
  // pool gateway (dùng khi chỉ đổi bộ lọc hiển thị, xem setAccountFilter).
  static refreshSessionLists(): void {
    for (const surface of [...MuseChatProvider.surfaces]) { surface.postSessions(); }
  }
  private view?: vscode.WebviewView;
  private panel?: vscode.WebviewPanel;
  private disposed = false;
  private readonly isSidebar: boolean;
  private readonly context: vscode.ExtensionContext;
  private readonly gateway: GatewayManager;
  // Store dùng chung (v0.8.0): danh sách session là của chung, còn
  // currentSessionId/history/conversationId/attachments dưới đây là
  // RIÊNG từng bề mặt — đây chính là điểm sửa của việc 3: gửi tin ở
  // panel A không được đổi session, chặn hay ghi đè history của panel
  // B, vì B có bộ trạng thái riêng của nó.
  // Riêng trạng thái CHẠY thì KHÔNG còn ở bề mặt (v0.8.27): nó sống
  // trong RunManager dùng chung (runManager), key theo sessionId, nên
  // chuyển bề mặt sang session khác không hủy run cũ, và mở cùng
  // session ở 2 nơi đều thấy cùng tiến trình.
  private readonly store: SessionStore;
  private readonly runManager: RunManager;
  private removeLogListener?: () => void;
  private removeStoreListener?: () => void;
  private removeRunListener?: () => void;
  private pendingPreset?: string;
  private history: ChatMsg[] = [];
  // Session mà mảng history hiện tại thuộc về. Khi session đang mở bị
  // xóa ở bề mặt khác, syncCurrentSession KHÔNG được ghi history cũ
  // vào session thay thế (sẽ làm sống lại nội dung đã xóa trong một
  // session khác) — nó chỉ nhận messages của session mới.
  private historySessionId = '';
  private conversationId: string;
  private currentSessionId: string;
  private pendingAttachments: PendingAttachment[] = [];
  private processes: BackgroundProcesses;
  private computer: ComputerHelper;
  // v0.8.27: lastComputerImage/lastToolImages/lastToolFiles/
  // turnFileCount/lastStreamed KHÔNG còn là trường provider nữa — đã
  // chuyển thành RunCtx của từng lượt (xem RunCtx), để hai run cùng
  // lúc không ghi đè lẫn nhau.
  // Cache tài khoản mới nhất để tính trạng thái session và backfill.
  // Chỉ chứa các trường an toàn từ Account.Public() (không cookie).
  private cachedAccounts: Array<{ id: string; label: string; enabled: boolean; status: string; email: string | null; username: string | null }> = [];
  private accountsCacheLoaded = false;

  constructor(context: vscode.ExtensionContext, gateway: GatewayManager, store?: SessionStore, options?: { initialSessionId?: string; isSidebar?: boolean; runManager?: RunManager }) {
    this.context = context;
    this.gateway = gateway;
    this.isSidebar = options?.isSidebar === true;
    this.processes = new BackgroundProcesses();
    this.computer = new ComputerHelper(context);
    this.store = store ?? new SessionStore(context, workspaceRoot);
    // v0.8.27: mọi bề mặt dùng chung MỘT RunManager (tạo ở activate,
    // truyền vào đây + openSessionInPanel). Không có runManager truyền
    // vào thì tự tạo một cái để không vỡ đường gọi cũ — nhưng đường
    // đó không còn được dùng, vì activate luôn truyền chung.
    this.runManager = options?.runManager ?? new RunManager();
    MuseChatProvider.surfaces.add(this);
    // Fan-out trạng thái run (v0.8.27): slot bắt đầu/kết thúc thì mọi
    // bề mặt gửi lại danh sách để spinner/tích cập nhật trực tiếp cả
    // khi user đang xem session khác. Gỡ ở disposeSurface.
    this.removeRunListener = this.runManager.addStatusListener(() => {
      if (!this.disposed) { this.postSessions(); }
    });
    // Log fan-out (v0.8.0): mỗi bề mặt đăng ký listener riêng thay vì
    // gán gateway.onLog (gán sẽ ghi đè và làm các bề mặt khác mất log).
    this.removeLogListener = gateway.addLogListener((line: string) => {
      this.post('logLine', { text: line, time: logTimeNow() });
    });
    this.removeStoreListener = this.store.addListener((change, source) => { this.onStoreChanged(change, source); });
    // v0.8.19: mở bề mặt mới không có initialSessionId thì mặc định
    // vào session tương tác mới nhất (updatedAt lớn nhất), thay vì
    // savedCurrentSessionId cũ; đường initialSessionId tường minh giữ
    // nguyên hành vi cũ qua pickInitialSession, không bị override.
    const current = pickInitialSession(this.store.sessions, options?.initialSessionId, this.store.savedCurrentSessionId());
    // v0.8.2, việc 2d: danh sách được phép rỗng (user đã xóa hết).
    // KHÔNG tự tạo "Hội thoại 1" ở đây, nếu không lần khởi động sau
    // sẽ làm sống lại danh sách vừa bị xóa. currentSession() trả null
    // khi rỗng; UI hiện trạng thái trống, gửi tin sẽ tự tạo mới.
    this.currentSessionId = current ? current.id : '';
    this.history = current ? current.messages : [];
    this.historySessionId = current ? current.id : '';
    this.conversationId = current ? current.conversationId : '';
  }

  // Thông báo từ store chung (tạo/xóa/đổi tên session, purge tài khoản
  // ở bề mặt khác). Bề mặt nguồn tự bỏ qua (source === this) vì nó
  // đã tự cập nhật rồi; các bề mặt khác:
  // - Session đang mở đã mất -> chuyển sang session mới nhất còn lại
  //   (hoặc tạo session trống nếu không còn session nào), KHÔNG kẹt ở
  //   session đã xóa; nếu session đó đang có run thì hủy run đó để
  //   finally của run() không ghi đè session thay thế (run đã bị xóa
  //   thì finally cũng không hồi sinh nó, xem run()).
  // - Session đang mở vẫn còn nhưng messages đã đổi ở bề mặt khác
  //   (cùng session mở ở hai panel, hoặc session bị làm trống) và
  //   session đó KHÔNG có run đang sống -> đọc lại messages + gửi lại
  //   lịch sử hiển thị. Session có run đang sống thì KHÔNG render lại
  //   lịch sử từ store: sink của run đã đẩy tiến trình trực tiếp tới
  //   bề mặt, render lại sẽ xóa bubble trực tiếp (historyCleared) và
  //   chỉ còn các turn đã hoàn tất.
  // - Còn lại: chỉ gửi lại danh sách (tiêu đề/trạng thái đổi).
  private onStoreChanged(change: StoreChange, source?: unknown): void {
    if (this.disposed || source === this) { return; }
    const current = this.store.find(this.currentSessionId);
    if (!current) {
      if (this.currentSessionId) { this.runManager.abort(this.currentSessionId); }
      const fallback = [...this.store.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (fallback) {
        this.currentSessionId = fallback.id;
        this.history = fallback.messages;
        this.historySessionId = fallback.id;
        this.conversationId = fallback.conversationId;
        this.pendingAttachments = [];
        this.post('historyCleared', {});
        if (this.history.length > 0) {
          this.post('history', { messages: this.history.map((h) => ({ role: h.role, text: typeof h.content === 'string' ? h.content : '' })) });
        }
        this.post('status', { text: change.purgedAccountIds.length > 0 ? 'Hội thoại đang mở đã bị xóa cùng tài khoản (Xóa hoàn toàn), đã chuyển sang hội thoại còn lại.' : 'Hội thoại đang mở đã bị xóa ở nơi khác, đã chuyển sang hội thoại còn lại.' });
        // v0.8.8, việc 1a: session thay thế mở do bề mặt khác xóa
        // session cũ cũng tự tải lịch sử nếu import từ web mà rỗng.
        void this.maybeAutoLoadCurrentWebHistory();
      } else {
        // v0.8.2, việc 2d: không còn session nào thì về trạng thái
        // trống an toàn, KHÔNG tự tạo session mới (tự tạo sẽ làm danh
        // sách vừa bị xóa ở bề mặt khác sống lại ở bề mặt này).
        this.currentSessionId = '';
        this.history = [];
        this.historySessionId = '';
        this.conversationId = '';
        this.pendingAttachments = [];
        this.post('historyCleared', {});
        this.post('status', { text: change.purgedAccountIds.length > 0 ? 'Không còn hội thoại nào sau khi xóa tài khoản. Bấm "Hội thoại mới" để bắt đầu.' : 'Không còn hội thoại nào. Bấm "Hội thoại mới" để bắt đầu.' });
      }
    } else if (!this.runManager.isRunning(current.id) && (current.messages !== this.history || current.messages.length !== this.history.length)) {
      this.history = current.messages;
      this.historySessionId = current.id;
      this.conversationId = current.conversationId;
      this.post('historyCleared', {});
      if (this.history.length > 0) {
        this.post('history', { messages: this.history.map((h) => ({ role: h.role, text: typeof h.content === 'string' ? h.content : '' })) });
      }
    }
    this.postSessions();
  }

  // Mở một session trong tab editor riêng (v0.8.0, việc 3). Panel là
  // một MuseChatProvider mới với cùng store và CÙNG RunManager, trạng
  // thái hiển thị riêng; đóng panel chỉ dispose bề mặt, KHÔNG xóa
  // session. Mở cùng session ở hai panel được phép: hai panel cùng
  // nhìn một run qua sink của RunManager nên đều thấy cùng tiến trình
  // trực tiếp; gửi từ 2 nơi vào cùng session thì bên gửi sau bị từ
  // chối vì session bận (slot của RunManager), không còn race chạy
  // chồng như trước 0.8.27.
  async openSessionInPanel(sessionId?: string): Promise<void> {
    const target = (sessionId ? this.store.find(sessionId) : undefined) ?? this.currentSession();
    if (!target) { this.postSessions(); return; }
    const surface = new MuseChatProvider(this.context, this.gateway, this.store, { initialSessionId: target.id, runManager: this.runManager });
    const panel = vscode.window.createWebviewPanel('muse.chatPanel', `Muse: ${target.title}`, vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')],
      retainContextWhenHidden: true,
    });
    surface.attachPanel(panel);
    // v0.8.13: bề mặt gốc (nơi bấm "Tab mới") cũng nhận 'sessions'
    // để nút Tab mới hết loading; attachPanel chỉ post cho panel mới.
    this.postSessions();
  }

  private attachPanel(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    panel.webview.html = this.html(panel.webview);
    panel.webview.onDidReceiveMessage((m: { type?: string; text?: string; id?: string; width?: number }) => { this.onWebviewMessage(m); });
    panel.onDidDispose(() => { this.disposeSurface(); });
    this.postSessions();
    void this.refreshAccounts();
    if (this.history.length > 0) {
      void panel.webview.postMessage({
        type: 'history',
        messages: this.history.map((h) => ({ role: h.role, text: typeof h.content === 'string' ? h.content : '' })),
      });
    }
    // Panel mở session đang có run sống thì vẽ thêm tiến trình trực
    // tiếp của nó (v0.8.27, như switchSession).
    this.replayLiveRun(this.currentSessionId);
    if (this.currentSession()?.importedFromWeb) {
      this.post('importedBanner', { text: 'Hội thoại này được đồng bộ từ web muse.ai. Lịch sử cũ nằm trên thread web, tin nhắn tiếp theo sẽ nối tiếp thread đó.' });
    }
    // v0.8.8, việc 1a: mở session trong tab mới cũng tự tải lịch sử
    // nếu session import từ web mà đang rỗng.
    void this.maybeAutoLoadCurrentWebHistory();
  }

  private disposeSurface(): void {
    if (this.disposed) { return; }
    this.disposed = true;
    // Đóng panel KHÔNG xóa session: chỉ đồng bộ history hiện tại vào
    // session chung rồi gỡ bề mặt khỏi đăng ký. Session vẫn còn trong
    // cột trái và mở lại được bất cứ lúc nào.
    try { this.syncCurrentSession(); this.store.persist(); } catch { /* đóng panel không được vỡ vì lỗi lưu */ }
    this.removeLogListener?.();
    this.removeStoreListener?.();
    this.removeRunListener?.();
    MuseChatProvider.surfaces.delete(this);
    this.panel = undefined;
    this.view = undefined;
  }

  private updatePanelTitle(): void {
    if (this.panel) {
      const title = this.currentSession()?.title;
      try { this.panel.title = title ? `Muse: ${title}` : 'Muse'; } catch { /* panel đã đóng thì thôi */ }
    }
  }

  // v0.8.2, việc 2d: trả null khi danh sách rỗng (trước đây fallback
  // về sessions[0] nên không bao giờ rỗng được). Mọi chỗ dùng hàm này
  // đều phải kiểm tra null — xem constructor, run(), rename, delete.
  private currentSession(): ChatSession | null {
    return this.store.find(this.currentSessionId) ?? null;
  }

  private saveSessions(): void {
    this.syncCurrentSession();
    this.store.persist();
    // Chỉ sidebar mới ghi session "hiện tại khi mở lại" và key lịch sử
    // cũ: panel không được ghi đè session khôi phục của sidebar.
    if (this.isSidebar) {
      void this.context.globalState.update('muse.currentSessionId', this.currentSessionId);
      void this.context.workspaceState.update('muse.chatHistory', this.history.slice(-40));
      void this.context.workspaceState.update('muse.conversationId', this.conversationId);
    }
    // Thông báo cho các bề mặt khác tự cập nhật (nguồn tự bỏ qua).
    this.store.notify({ deletedIds: [], purgedAccountIds: [] }, this);
  }

  private syncCurrentSession(): void {
    const s = this.currentSession();
    if (!s) { return; }
    // Chỉ ghi khi history hiện tại đúng là của session này. Nếu bề mặt
    // đã chuyển sang session khác (ví dụ session cũ bị xóa ở bề mặt
    // khác trong lúc bề mặt này đang chạy), nhận messages của session
    // mới thay vì ghi đè nó bằng history của session đã mất.
    if (this.historySessionId === s.id) {
      s.messages = this.history;
      s.conversationId = this.conversationId;
      s.updatedAt = Date.now();
    } else {
      this.history = s.messages;
      this.historySessionId = s.id;
      this.conversationId = s.conversationId;
    }
  }

  // Trạng thái session, đúng 3 giá trị user yêu cầu (v0.5.0):
  // - Đang chạy: session ĐÓ đang có run sống trong RunManager (v0.8.27:
  //   không còn "session hiện tại của bề mặt này + cờ running" — session
  //   nào đang chạy cũng hiện Đang chạy ở mọi bề mặt).
  // - Đã logout: session có accountId đã lưu nhưng account đó không còn
  //   trong pool HOẶC trạng thái Invalid (hết hạn). Cache chưa tải thì
  //   không kết luận logout, để Đã dừng (tránh báo sai).
  // - Đã dừng: còn lại, gồm session chưa xác định tài khoản và session
  //   có account đang active/cooling/disabled. Cooling/disabled chỉ ghi
  //   chú trong accountDetail, không thành trạng thái thứ 4.
  private sessionStatus(session: ChatSession): { status: 'running' | 'stopped' | 'loggedout'; detail: string } {
    if (this.runManager.isRunning(session.id)) { return { status: 'running', detail: '' }; }
    if (session.accountId && this.accountsCacheLoaded) {
      const acc = this.cachedAccounts.find((a) => a.id === session.accountId);
      if (!acc || acc.status.toLowerCase() === 'invalid') { return { status: 'loggedout', detail: '' }; }
      if (!acc.enabled) { return { status: 'stopped', detail: 'Tài khoản đã tắt' }; }
      if (acc.status.toLowerCase() === 'cooling') { return { status: 'stopped', detail: 'Tài khoản đang cooling' }; }
    }
    return { status: 'stopped', detail: '' };
  }

  // Danh tính hiển thị của session (v0.7.0, điểm 3): join
  // session.accountId với cache tài khoản MỚI NHẤT, KHÔNG dùng label
  // đã lưu trong session (label mặc định "Tài khoản cá nhân" trùng
  // nhau giữa nhiều tài khoản). Ưu tiên: Email -> Username -> Label.
  // Trả '' khi session không có accountId hoặc tài khoản không còn
  // trong cache — webview khi đó hiện "Chưa xác định tài khoản".
  // Session KHÔNG lưu thêm trường email; mỗi lần gửi danh sách là
  // join lại từ cache nên profile-refresh/merge/đăng nhập mới đều
  // cập nhật dòng tài khoản ngay (refreshAccounts gọi postSessions).
  // Email chỉ hiện trong VS Code của user, không đưa vào tin nhắn,
  // không log, không đưa vào thông báo.
  private accountDisplayFor(session: ChatSession): string {
    if (!session.accountId || !this.accountsCacheLoaded) { return ''; }
    const acc = this.cachedAccounts.find((a) => a.id === session.accountId);
    if (!acc) { return ''; }
    return acc.email || acc.username || acc.label || '';
  }

  // Chiều rộng cột danh sách hội thoại (v0.8.10): lưu globalState
  // (theo user qua mọi workspace, như session đã làm), mặc định 230.
  // Chỉ là thiết lập giao diện, không lưu vào session hay tài khoản.
  // Giới hạn cứng 160..480 ở đây; giới hạn 50% khung chat do webview
  // kẹp thêm lúc áp vì chỉ webview mới biết chiều rộng khung.
  private sessionListWidth(): number {
    const raw = this.context.globalState.get<unknown>('muse.sessionListWidth', 230);
    if (typeof raw !== 'number' || !Number.isFinite(raw)) { return 230; }
    return Math.min(480, Math.max(160, Math.floor(raw)));
  }

  private async setSessionListWidth(width: number): Promise<void> {
    const next = Math.min(480, Math.max(160, Math.floor(width)));
    if (next === this.sessionListWidth()) { this.postSessions(); return; }
    await this.context.globalState.update('muse.sessionListWidth', next);
    MuseChatProvider.refreshSessionLists();
  }

  // Chiều cao ô nhập đã lưu (v0.8.27, theo mẫu sessionListWidth):
  // lưu globalState (theo user qua mọi workspace), 0 = mặc định
  // rows=3. Chỉ là thiết lập giao diện, không lưu vào session hay
  // tài khoản. Clamp cứng trên 2000px ở host; clamp dưới 64px và
  // trên 60% cột chat do webview kẹp thêm lúc áp vì chỉ webview mới
  // biết chiều cao cột chat.
  private composerHeight(): number {
    const raw = this.context.globalState.get<unknown>('muse.composerHeight', 0);
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) { return 0; }
    return Math.min(2000, Math.floor(raw));
  }

  private async setComposerHeight(height: number): Promise<void> {
    const next = (typeof height === 'number' && Number.isFinite(height) && height > 0) ? Math.min(2000, Math.floor(height)) : 0;
    if (next === this.composerHeight()) { this.postSessions(); return; }
    await this.context.globalState.update('muse.composerHeight', next);
    MuseChatProvider.refreshSessionLists();
  }

  // Bộ lọc hiển thị hội thoại theo tài khoản (v0.8.8): lưu
  // globalState (theo user qua mọi workspace, như session đã làm),
  // mặc định 'all' = "Tất cả tài khoản". Chỉ lọc HIỂN THỊ ở cột
  // trái: mở/xóa session vẫn theo từng session như cũ, session đang
  // mở mà bị lọc khỏi danh sách vẫn hiển thị nội dung bình thường
  // (postSessions gửi kèm currentSession ngoài danh sách đã lọc).
  private accountFilter(): string {
    return this.context.globalState.get<string>('muse.sessionAccountFilter', 'all') || 'all';
  }

  private accountFilterOptions(): Array<{ id: string; label: string; status: string }> {
    const opts: Array<{ id: string; label: string; status: string }> = [{ id: 'all', label: 'Tất cả tài khoản', status: '' }];
    for (const a of this.cachedAccounts) {
      const display = a.email || a.username || a.label || a.id;
      opts.push({ id: a.id, label: `${display} (${a.id})`, status: a.status });
    }
    return opts;
  }

  private async setAccountFilter(id: string): Promise<void> {
    const next = id || 'all';
    if (next === this.accountFilter()) { this.postSessions(); return; }
    await this.context.globalState.update('muse.sessionAccountFilter', next);
    MuseChatProvider.refreshSessionLists();
  }

  // Lệnh palette "Muse: Lọc hội thoại theo tài khoản" (v0.8.8): cùng
  // danh sách mục như dropdown cột trái (Tất cả + mỗi tài khoản
  // gateway, nhãn + id + trạng thái), cho người dùng bàn phím.
  async selectAccountFilter(): Promise<void> {
    try {
      const accounts = await this.fetchAccountsCached();
      const items: Array<{ label: string; description: string; id: string }> = [
        { label: 'Tất cả tài khoản', description: 'Hiện hội thoại của mọi tài khoản, kể cả hội thoại cũ chưa gắn tài khoản', id: 'all' },
        ...accounts.map((a) => ({ ...this.accountPickLabel(a), id: a.id })),
      ];
      const pick = await vscode.window.showQuickPick(items, { placeHolder: 'Lọc danh sách hội thoại theo tài khoản' });
      if (!pick) { return; }
      await this.setAccountFilter(pick.id);
      const label = pick.id === 'all' ? 'tất cả tài khoản' : (accounts.find((a) => a.id === pick.id)?.label || pick.id);
      void vscode.window.showInformationMessage(pick.id === 'all' ? 'Đã hiển thị hội thoại của tất cả tài khoản.' : `Đã lọc danh sách hội thoại theo tài khoản ${label}.`);
    } catch (e) {
      void vscode.window.showErrorMessage(`Không đọc được danh sách tài khoản để lọc hội thoại: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Tài khoản lọc đã chọn mà không còn trong pool thì tự về "Tất cả
  // tài khoản" và báo rõ MỘT lần (chỉ sidebar báo, để các panel khác
  // cùng refresh không spam thêm thông báo; lần refresh sau filter
  // đã là 'all' nên không báo lại).
  private validateAccountFilter(): void {
    if (!this.accountsCacheLoaded) { return; }
    const filter = this.accountFilter();
    if (filter === 'all' || this.cachedAccounts.some((a) => a.id === filter)) { return; }
    void this.context.globalState.update('muse.sessionAccountFilter', 'all');
    if (this.isSidebar) {
      void vscode.window.showInformationMessage(`Tài khoản đang lọc hội thoại (${filter}) không còn trong pool gateway nên đã về "Tất cả tài khoản".`);
    }
  }

  private postSessions(): void {
    const filter = this.accountFilter();
    // v0.8.19: danh sách hiển thị mới nhất lên đầu (chỉ đổi thứ tự
    // hiển thị; sortSessionsNewestFirst sort trên bản sao nên thứ tự
    // lưu trong store, totalSessionCount và logic lọc không đổi).
    const visible = sortSessionsNewestFirst(this.store.sessions.filter((s) => sessionMatchesAccountFilter(s.accountId, filter)));
    const current = this.currentSession();
    this.post('sessions', {
      sessions: visible.map((s) => {
        const st = this.sessionStatus(s);
        return {
          id: s.id, title: s.title, count: s.messages.length, updatedAt: s.updatedAt,
          workspacePath: s.workspacePath || '',
          accountLabel: s.accountLabel || '',
          accountDisplay: this.accountDisplayFor(s),
          accountStatus: st.status,
          accountDetail: st.detail,
          // v0.8.27: chỉ báo run (xoay tròn/tích/lỗi) — xem runStatusFor.
          runStatus: this.runStatusFor(s),
          threadUrl: s.threadUrl || '',
          importedFromWeb: s.importedFromWeb === true,
        };
      }),
      currentId: this.currentSessionId,
      accountFilter: filter,
      accountFilterOptions: this.accountFilterOptions(),
      sessionListWidth: this.sessionListWidth(),
      composerHeight: this.composerHeight(),
      totalSessionCount: this.store.sessions.length,
      currentSession: current ? { id: current.id, title: current.title, accountDisplay: this.accountDisplayFor(current), accountStatus: this.sessionStatus(current).status, runStatus: this.runStatusFor(current) } : null,
    });
    this.updatePanelTitle();
  }

  // Chỉ báo run của một session trong danh sách (v0.8.27, hàm thuần
  // qua computeRunStatus): run đang sống → 'running' (xoay tròn);
  // không thì kết quả run gần nhất đã lưu ('done' → tích, 'error' →
  // dấu lỗi); còn lại giữ trạng thái tài khoản cũ (stopped/loggedout).
  private runStatusFor(s: ChatSession): 'running' | 'done' | 'error' | 'stopped' | 'loggedout' {
    return computeRunStatus(this.runManager.isRunning(s.id), s.lastRunOutcome, this.sessionStatus(s).status);
  }

  // Sink hiển thị của một run (v0.8.27, xem RunSink): chuyển tiếp tới
  // mọi bề mặt đang hiển thị đúng session + ghi live snapshot để
  // replay. done() còn gửi cho surface gốc để nút Gửi của nó hết
  // loading dù surface đó đã chuyển sang session khác.
  private createRunSink(sessionId: string): RunSink {
    const origin = this;
    return {
      post: (type: string, payload: Record<string, unknown>): void => {
        MuseChatProvider.postToSession(sessionId, type, payload);
        origin.runManager.recordLive(sessionId, type, payload);
      },
      done: (): void => {
        // Chỉ gửi riêng cho origin khi nó đã chuyển đi nơi khác (lúc
        // đó postToSession không tới nó); nếu origin vẫn mở đúng
        // session thì postToSession đã gồm nó — tránh 'done' 2 lần.
        if (!origin.disposed && origin.currentSessionId !== sessionId) { origin.post('done', {}); }
        MuseChatProvider.postToSession(sessionId, 'done', {});
      },
    };
  }

  // Chuyển tiếp một message tới mọi bề mặt đang hiển thị session này
  // (sidebar/panel). Bề mặt đã chuyển đi nơi khác không nhận — sự kiện
  // của session A không được vẽ vào khung chat session B.
  private static postToSession(sessionId: string, type: string, payload: Record<string, unknown>): void {
    for (const surface of [...MuseChatProvider.surfaces]) {
      if (!surface.disposed && surface.currentSessionId === sessionId) {
        surface.post(type, payload);
      }
    }
  }

  // Replay tiến trình trực tiếp của run đang sống khi bề mặt vừa mở/
  // chuyển tới session đó (v0.8.27): sau lịch sử đã lưu (chỉ có các
  // turn đã hoàn tất), vẽ thêm bubble trực tiếp của lượt đang chạy +
  // phần stream đang dở + dòng trạng thái mới nhất. Không có run sống
  // thì không làm gì (lịch sử tĩnh đã đủ).
  private replayLiveRun(sessionId: string): void {
    const snap = this.runManager.snapshot(sessionId);
    if (!snap) { return; }
    for (const b of snap.bubbles) {
      if (b.kind === 'message') { this.post('message', { role: b.role || 'assistant', text: b.text || '', details: b.details || '' }); }
      else if (b.kind === 'tool') { this.post('tool', { name: b.name || '', detail: b.detail || '' }); }
      else if (b.kind === 'toolResult') { this.post('toolResult', { name: b.name || '', detail: b.detail || '' }); }
    }
    if (snap.streaming) {
      this.post('streamStart', {});
      if (snap.streamText) { this.post('streamDelta', { text: snap.streamText }); }
    }
    if (snap.status) { this.post('status', { text: snap.status }); }
  }

  // Sau khi gộp trùng ở panel Cài đặt: session nào có accountId nằm
  // trong mergedIds thì đổi sang primaryId + primaryLabel, lưu lại và
  // gửi lại danh sách để dòng tài khoản cập nhật (điểm 3 + điểm 1).
  private remapSessionsAfterMerge(remap: Record<string, { primaryId: string; primaryLabel: string }>): void {
    let changed = false;
    for (const s of this.store.sessions) {
      if (s.accountId && remap[s.accountId]) {
        s.accountId = remap[s.accountId].primaryId;
        s.accountLabel = remap[s.accountId].primaryLabel;
        changed = true;
      }
    }
    if (changed) { this.saveSessions(); }
    this.postSessions();
  }

  private async fetchAccountsCached(): Promise<Array<{ id: string; label: string; enabled: boolean; status: string; email: string | null; username: string | null }>> {
    const info = await this.gateway.ensureStarted();
    const accounts = await fetchGatewayAccounts(info.baseUrl, info.apiKey);
    this.cachedAccounts = accounts.map((a) => ({ id: a.id, label: a.label, enabled: a.enabled, status: a.status, email: a.email, username: a.username }));
    this.accountsCacheLoaded = true;
    return this.cachedAccounts;
  }

  // Làm mới trạng thái session từ pool hiện tại: cập nhật cache, backfill
  // tài khoản cho session chưa xác định (chỉ khi pool có đúng 1 tài
  // khoản — không đoán khi có 0 hoặc nhiều tài khoản), rồi gửi lại danh
  // sách để trạng thái Đã logout cập nhật. Lỗi đọc pool thì giữ cache
  // cũ, không khóa user. Bảng tài khoản chi tiết nằm ở panel Cài đặt,
  // nên hàm này không còn gửi 'accounts' sang khung chat nữa.
  async refreshAccounts(): Promise<void> {
    try { await this.fetchAccountsCached(); } catch { /* giữ cache cũ */ }
    // v0.8.8, việc 2e: pool đổi (đăng nhập/đăng xuất/xóa/refresh) mà
    // tài khoản đang lọc không còn thì tự về "Tất cả tài khoản".
    this.validateAccountFilter();
    // v0.8.2, việc 3: backfill bằng mapping gateway trước (chính xác
    // theo tài khoản thật đã chat), rồi mới fallback single-account.
    // Endpoint lỗi/404 thì giữ nguyên "Chưa xác định", không chặn.
    try { if (await this.backfillSessionAccountsByHint()) { /* đã lưu trong helper */ } }
    catch { /* giữ nguyên, không chặn làm mới danh sách */ }
    if (this.backfillSessionAccounts()) { this.saveSessions(); }
    this.postSessions();
    void MuseSettingsPanel.refreshCurrent().catch(() => { /* panel chưa mở */ });
  }

  // Hiển thị tài khoản cho QuickPick chọn tài khoản (tái dùng cách
  // hiển thị của syncFromWeb): Email -> Username -> Label, kèm id và
  // trạng thái. Email/username chỉ hiện trong VS Code của user.
  private accountPickLabel(a: { id: string; label: string; status: string; email: string | null; username: string | null }): { label: string; description: string } {
    const display = a.email || a.username || a.label || a.id;
    return {
      label: a.label ? `${display} (${a.id})` : `${display} (${a.id})`,
      description: `trạng thái: ${a.status}`,
    };
  }

  // v0.8.2, việc 3: backfill một session chưa có accountId bằng
  // endpoint by-hint của gateway (đọc mapping theo conversationId,
  // đối chiếu hash với pool). Trả true nếu gán được và đã lưu.
  private async backfillOneSessionByHint(session: ChatSession): Promise<boolean> {
    if (session.accountId) { return false; }
    try {
      const info = await this.gateway.ensureStarted();
      const owner = await fetchConversationOwner(info.baseUrl, info.apiKey, session.conversationId);
      if (!owner) { return false; }
      session.accountId = owner.id;
      session.accountLabel = owner.label || owner.id;
      session.accountStatusAtSave = owner.status;
      this.saveSessions();
      this.postSessions();
      return true;
    } catch { return false; }
  }

  // Backfill bằng by-hint cho mọi session chưa có accountId. Trả true
  // nếu gán được ít nhất một session (helper con đã tự lưu + gửi lại
  // danh sách mỗi lần gán được, nên caller không cần lưu thêm).
  private async backfillSessionAccountsByHint(): Promise<boolean> {
    let changed = false;
    for (const s of [...this.store.sessions]) {
      if (!s.accountId) {
        if (await this.backfillOneSessionByHint(s)) { changed = true; }
      }
    }
    return changed;
  }

  // v0.8.2, việc 2c: tombstone — URL thread đã bị user xóa, lưu
  // globalState (khóa riêng, chỉ chứa threadUrl). Đồng bộ bỏ qua mọi
  // URL trong danh sách này và báo rõ số hội thoại đã xóa nên không
  // nhập lại. Session không có threadUrl thì không cần tombstone.
  private deletedThreadUrls(): string[] {
    const raw = this.context.globalState.get<unknown>('muse.deletedThreadUrls', []);
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string' && !!v) : [];
  }

  private addDeletedThreadUrl(url: string): void {
    const norm = url.trim().replace(/\/+$/, '');
    if (!norm) { return; }
    const list = this.deletedThreadUrls();
    if (!list.includes(norm)) {
      list.push(norm);
      void this.context.globalState.update('muse.deletedThreadUrls', list);
    }
  }

  private clearDeletedThreadUrls(): string[] {
    const old = this.deletedThreadUrls();
    void this.context.globalState.update('muse.deletedThreadUrls', []);
    return old;
  }

  async allowReimportDeletedSessions(): Promise<void> {
    const cleared = this.clearDeletedThreadUrls();
    void vscode.window.showInformationMessage(
      cleared.length > 0
        ? `Đã xóa ${cleared.length} hội thoại khỏi danh sách "đã xóa". Lần đồng bộ từ web sau sẽ nhập lại được các thread đó.`
        : 'Không có hội thoại đã xóa nào đang bị chặn nhập lại.');
  }

  // Backfill: chỉ gán khi pool có đúng 1 tài khoản. Trả true nếu đổi gì.
  private backfillSessionAccounts(): boolean {
    if (this.cachedAccounts.length !== 1) { return false; }
    const only = this.cachedAccounts[0];
    let changed = false;
    for (const s of this.store.sessions) {
      if (!s.accountId) {
        s.accountId = only.id;
        s.accountLabel = only.label || only.id;
        s.accountStatusAtSave = only.status;
        changed = true;
      }
    }
    return changed;
  }

  async accountActionFromWebview(action: string, id: string): Promise<void> {
    try {
      const info = await this.gateway.ensureStarted();
      if (action === 'renew') {
        const res = await renewGatewayAccount(info.baseUrl, info.apiKey, id);
        if (!res.ok) {
          this.post('error', { text: 'Làm mới phiên không thành công (gateway báo ok=false). Tài khoản này có thể đã hết hạn thật: hãy đăng nhập lại trong app Muse desktop rồi bấm "Nhập đăng nhập từ app desktop".' });
        } else {
          this.post('status', { text: 'Đã làm mới phiên tài khoản.' });
        }
      } else if (action === 'reset') {
        await resetGatewayAccount(info.baseUrl, info.apiKey, id);
        this.post('status', { text: 'Đã xóa cooldown của tài khoản.' });
      } else if (action === 'toggle') {
        const acc = (await fetchGatewayAccounts(info.baseUrl, info.apiKey)).find((a) => a.id === id);
        if (!acc) { throw new Error('Không tìm thấy tài khoản này trong pool.'); }
        await patchGatewayAccount(info.baseUrl, info.apiKey, id, !acc.enabled);
        this.post('status', { text: acc.enabled ? 'Đã tắt tài khoản.' : 'Đã bật tài khoản.' });
      } else if (action === 'logout') {
        const answer = await vscode.window.showWarningMessage('Đăng xuất tài khoản này khỏi gateway? Tài khoản sẽ bị xóa bền vững khỏi pool của gateway trong extension (khỏi cả file lưu), các session đang dùng tài khoản này sẽ chuyển sang trạng thái Đã logout. Thao tác này không đăng xuất app Muse desktop, vì lệnh nhập chỉ sao chép dữ liệu.', 'Đăng xuất', 'Hủy');
        if (answer !== 'Đăng xuất') { return; }
        await deleteGatewayAccount(info.baseUrl, info.apiKey, id);
        this.post('status', { text: 'Đã đăng xuất tài khoản khỏi gateway.' });
      }
    } catch (e) {
      this.post('error', { text: `Không thực hiện được thao tác tài khoản: ${e instanceof Error ? e.message : String(e)}` });
    }
    MuseChatProvider.refreshAllAccounts();
  }

  // v0.8.21: danh sách chọn nhanh cũng xếp mới nhất lên đầu, đồng bộ
  // với cột trái (0.8.19). Chỉ đổi thứ tự hiển thị: sort trên bản sao
  // nên thứ tự lưu trong store không đổi.
  listSessions(): Array<{ id: string; title: string }> {
    return sortSessionsNewestFirst(this.store.sessions).map((s) => ({ id: s.id, title: s.title }));
  }

  listSessionsWithAccounts(): Array<{ id: string; title: string; accountId?: string; accountLabel?: string }> {
    return sortSessionsNewestFirst(this.store.sessions).map((s) => ({ id: s.id, title: s.title, accountId: s.accountId, accountLabel: s.accountLabel }));
  }

  openSettings(): void {
    MuseSettingsPanel.createOrShow(
      this.context,
      this.gateway,
      // Tài khoản đổi thì MỌI bề mặt đều phải làm mới trạng thái
      // session, không chỉ sidebar mở panel Cài đặt.
      () => { MuseChatProvider.refreshAllAccounts(); },
      () => this.listSessionsWithAccounts(),
      (remap) => { this.remapSessionsAfterMerge(remap); },
      // Xóa hoàn toàn (v0.8.0): gateway đã purge xong mới tới đây;
      // xóa session extension của tài khoản đó khỏi store chung rồi
      // thông báo để mọi bề mặt đang mở session đó chuyển đi.
      (accountId) => this.purgeAccountSessions(accountId),
    );
  }

  // Xóa session extension theo tài khoản sau purge gateway. Trả số
  // session đã xóa để panel Cài đặt hiện thông báo cụ thể (gateway
  // trả mappings/browserSession riêng, xem settings.ts).
  purgeAccountSessions(accountId: string): number {
    // v0.8.2, việc 2c: session bị xóa cùng tài khoản cũng ghi
    // tombstone để đồng bộ sau không tự nhập lại thread của chúng.
    for (const s of this.store.sessions) {
      if (s.accountId === accountId && s.threadUrl) { this.addDeletedThreadUrl(s.threadUrl); }
    }
    const removed = this.store.purgeAccountSessions(accountId);
    if (removed > 0) {
      this.store.notify({ deletedIds: [], purgedAccountIds: [accountId] }, this);
      // Bề mặt gọi purge cũng phải tự xử lý session đang mở của nó
      // (listener của chính nó đã bỏ qua notify vì source === this).
      this.onStoreChanged({ deletedIds: [], purgedAccountIds: [accountId] }, undefined);
    }
    this.postSessions();
    return removed;
  }

  // Tải lịch sử thread web (v0.8.8, việc 1): dùng đúng hợp đồng
  // endpoint của gateway (fetchThreadMessages trong admin.ts). Chỉ
  // gọi MỘT lần cho một session đang tải (webHistoryLoading chặn
  // gọi trùng từ nhiều bề mặt). Tài khoản lấy từ accountId của
  // session, nếu session không có thì dùng tài khoản đang lọc, nếu
  // cũng không có thì bỏ qua ('skipped') và giữ session rỗng.
  // Trả 'ok' / 'empty' (endpoint trả rỗng) / 'error' / 'skipped'.
  // Chỉ ghi đè messages khi có nội dung thật; title chỉ đổi theo
  // quy tắc nới lỏng v0.8.12 (resolveWebTitleUpdated, sửa tay thì giữ).
  private webHistoryLoading = new Set<string>();

  private async loadWebThreadHistory(session: ChatSession, force: boolean): Promise<'ok' | 'empty' | 'error' | 'skipped'> {
    if (!session.threadUrl) { return 'skipped'; }
    if (!force && session.messages.length > 0) { return 'skipped'; }
    const filter = this.accountFilter();
    const accountId = session.accountId || (filter !== 'all' ? filter : undefined);
    if (!accountId) { return 'skipped'; }
    if (this.webHistoryLoading.has(session.id)) { return 'skipped'; }
    this.webHistoryLoading.add(session.id);
    try {
      const info = await this.gateway.ensureStarted();
      const result = await fetchThreadMessages(info.baseUrl, info.apiKey, accountId, session.threadUrl);
      if (result.messages.length === 0) { return 'empty'; }
      session.messages = result.messages.map((m) => ({ role: m.role, content: m.content }));
      session.updatedAt = Date.now();
      const newTitle = resolveWebTitleUpdated(session.title, session.threadUrl, result.title, { titleEditedManually: session.titleEditedManually });
      if (newTitle) { session.title = newTitle; }
      // v0.8.13: sau khi tải được lịch sử, nếu title vẫn là tiêu đề
      // chung hoặc dự phòng và session chưa sửa tay thì suy title từ
      // tin nhắn user đầu tiên trong lịch sử vừa tải (một dòng, tối
      // đa 80 ký tự; tin đầu rỗng hoặc cũng generic thì giữ nguyên).
      if (!session.titleEditedManually && (isGenericWebTitle(session.title) || isFallbackWebTitle(session.title, session.threadUrl))) {
        const derived = titleFromFirstUserMessage(session.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })));
        if (derived && derived !== session.title) { session.title = derived; }
      }
      if (session.id === this.currentSessionId) {
        this.history = session.messages;
        this.historySessionId = session.id;
        this.saveSessions();
      } else {
        this.store.persist();
        this.store.notify({ deletedIds: [], purgedAccountIds: [] }, this);
      }
      this.postSessions();
      return 'ok';
    } catch {
      return 'error';
    } finally {
      this.webHistoryLoading.delete(session.id);
    }
  }

  // Tự tải một lần khi mở hội thoại import từ web mà messages đang
  // rỗng (v0.8.8, việc 1a). Endpoint rỗng hoặc lỗi thì giữ session
  // rỗng và báo rõ là chưa đọc được lịch sử từ trang web (thông báo
  // nhẹ, không báo lỗi giả, không tự gửi lại, không tự retry).
  private async maybeAutoLoadCurrentWebHistory(): Promise<void> {
    const session = this.currentSession();
    if (!session || !session.importedFromWeb || session.messages.length > 0) { return; }
    const res = await this.loadWebThreadHistory(session, false);
    if (res === 'ok') {
      this.post('historyCleared', {});
      this.post('history', { messages: this.history.map((h) => ({ role: h.role, text: typeof h.content === 'string' ? h.content : '' })) });
    } else if (res === 'empty' || res === 'error') {
      void vscode.window.showInformationMessage('Chưa đọc được lịch sử từ trang web cho hội thoại này, hội thoại vẫn để trống. Bạn có thể thử lại bằng lệnh "Muse: Tải lại lịch sử hội thoại web".');
    }
  }

  // Lệnh palette "Muse: Tải lại lịch sử hội thoại web" (v0.8.8,
  // việc 1b): chỉ chạy cho session đang mở và có threadUrl; ghi đè
  // messages đã lưu bằng kết quả mới; nếu messages đã có nội dung thì
  // hỏi xác nhận modal trước (Không thì thôi); xong thì lưu + hiển thị.
  async reloadCurrentWebHistory(): Promise<void> {
    const session = this.currentSession();
    if (!session) { void vscode.window.showInformationMessage('Chưa có hội thoại nào đang mở để tải lại lịch sử.'); return; }
    if (!session.threadUrl) { void vscode.window.showInformationMessage('Hội thoại hiện tại không có thread web nên không tải lại lịch sử từ web được.'); return; }
    if (session.messages.length > 0) {
      const answer = await vscode.window.showWarningMessage(
        `Tải lại lịch sử từ web sẽ ghi đè ${session.messages.length} tin nhắn đã lưu của hội thoại "${session.title}". Tiếp tục?`,
        { modal: true }, 'Tải lại', 'Hủy');
      if (answer !== 'Tải lại') { return; }
    }
    const res = await this.loadWebThreadHistory(session, true);
    if (res === 'ok') {
      this.post('historyCleared', {});
      this.post('history', { messages: this.history.map((h) => ({ role: h.role, text: typeof h.content === 'string' ? h.content : '' })) });
      void vscode.window.showInformationMessage(`Đã tải lại ${session.messages.length} tin nhắn từ thread web.`);
    } else if (res === 'skipped') {
      void vscode.window.showInformationMessage('Không xác định được tài khoản của hội thoại này nên chưa tải được lịch sử từ web. Hãy chọn bộ lọc tài khoản hoặc đồng bộ lại từ web rồi thử lại.');
    } else {
      void vscode.window.showInformationMessage('Chưa đọc được lịch sử từ trang web cho hội thoại này, hội thoại vẫn giữ nội dung cũ. Bạn có thể thử lại sau.');
    }
  }

  // v0.8.27: chuyển session KHÔNG còn chặn khi đang chạy — chuyển chỉ
  // đổi bề mặt đang hiển thị, run của session cũ vẫn chạy trong
  // RunManager cho tới kết quả, không bị hủy giữa chừng. Mở lại session
  // đang chạy thì replayLiveRun vẽ thêm tiến trình trực tiếp của nó.
  async switchSession(id: string): Promise<void> {
    const target = this.store.sessions.find((s) => s.id === id);
    if (!target || target.id === this.currentSessionId) { return; }
    // v0.8.2, việc 3: session chưa có accountId thì thử backfill bằng
    // by-hint trước khi kiểm tra trạng thái tài khoản của nó.
    if (!target.accountId) { await this.backfillOneSessionByHint(target); }
    // Kiểm tra tài khoản của session đích, best effort: gateway không
    // chạy được hoặc không đọc được pool thì vẫn cho xem lịch sử cũ,
    // không cảnh báo sai. Chỉ cảnh báo khi biết chắc đã logout.
    let loggedOut = false;
    if (target.accountId) {
      try {
        const accounts = await this.fetchAccountsCached();
        const acc = accounts.find((a) => a.id === target.accountId);
        loggedOut = !acc || acc.status.toLowerCase() === 'invalid';
      } catch { /* không xác định được thì không cảnh báo */ }
    }
    this.syncCurrentSession();
    this.currentSessionId = target.id;
    this.history = target.messages;
    this.historySessionId = target.id;
    this.conversationId = target.conversationId;
    this.pendingAttachments = [];
    this.saveSessions();
    this.post('historyCleared', {});
    if (this.history.length > 0) {
      this.post('history', { messages: this.history.map((h) => ({ role: h.role, text: typeof h.content === 'string' ? h.content : '' })) });
    }
    // Session đích đang có run sống thì vẽ thêm tiến trình trực tiếp
    // của nó (không chỉ lịch sử tĩnh đã lưu).
    this.replayLiveRun(target.id);
    this.postSessions();
    this.post('status', { text: `Đã chuyển sang hội thoại: ${target.title}` });
    if (target.importedFromWeb) {
      this.post('importedBanner', { text: 'Hội thoại này được đồng bộ từ web muse.ai. Lịch sử cũ nằm trên thread web, tin nhắn tiếp theo sẽ nối tiếp thread đó.' });
    }
    if (loggedOut) {
      this.post('loginWarning', { text: `Hội thoại này dùng tài khoản ${target.accountLabel || target.accountId} đã hết hạn hoặc đã đăng xuất. Bạn vẫn xem lại được lịch sử cũ. Tin nhắn tiếp theo bạn nhắn sẽ yêu cầu đăng nhập lại.` });
    }
    // v0.8.8, việc 1a: hội thoại import từ web mà chưa có messages thì
    // tự tải lịch sử thread một lần khi mở (không chặn việc chuyển).
    await this.maybeAutoLoadCurrentWebHistory();
  }

  // v0.8.2, việc 3: tạo hội thoại mới PHẢI chọn tài khoản trước.
  // - Pool 1 tài khoản: gán luôn, không hỏi (như cũ).
  // - Pool >= 2: QuickPick (Email -> Username -> Label + id + trạng
  //   thái, như syncFromWeb); hủy QuickPick thì KHÔNG tạo session —
  //   tạo session không tài khoản rồi để gateway tự chọn chính là lỗi
  //   user đang báo, nên đường này bị cấm, không còn đường tắt nào.
  // - Pool 0: không tạo session, báo rõ + mở panel Cài đặt (như
  //   syncFromWeb khi không có tài khoản).
  // - Gateway không đọc được pool: báo lỗi, không tạo session mù.
  // Trả true nếu đã tạo, false nếu hủy/không tạo được. Áp dụng cho
  // cả nút cột trái, lệnh palette và nút tạo trong tab panel (cùng
  // một hàm này, không có đường tạo mới riêng nào khác).
  async newSession(): Promise<boolean> {
    // v0.8.13: các đường thoát sớm cũng postSessions để nút Hội thoại
    // mới ở webview không kẹt loading (tín hiệu hoàn tất của nhóm
    // thao tác session là message 'sessions').
    // v0.8.27: tạo mới KHÔNG còn chặn khi đang chạy — các run cũ vẫn
    // chạy trong RunManager, bề mặt này chỉ chuyển sang session mới.
    let accounts: Array<{ id: string; label: string; enabled: boolean; status: string; email: string | null; username: string | null }>;
    try {
      accounts = await this.fetchAccountsCached();
    } catch (e) {
      void vscode.window.showErrorMessage(`Không đọc được danh sách tài khoản từ gateway nên chưa tạo hội thoại mới: ${e instanceof Error ? e.message : String(e)}`);
      this.postSessions();
      return false;
    }
    if (accounts.length === 0) {
      void vscode.window.showInformationMessage('Chưa có tài khoản Muse nào trong gateway, hãy thêm tài khoản trong Cài đặt rồi tạo hội thoại mới.');
      this.openSettings();
      this.postSessions();
      return false;
    }
    // v0.8.8, việc 2d: bộ lọc đang là một tài khoản cụ thể thì gán
    // thẳng tài khoản đó, KHÔNG hiện QuickPick; khi là "Tất cả tài
    // khoản" thì QuickPick như cũ. Tài khoản lọc không còn trong pool
    // thì tự về "Tất cả" và báo rõ, rồi đi tiếp luồng QuickPick cũ.
    let chosen = accounts[0];
    const filter = this.accountFilter();
    let effectiveFilter = filter;
    if (filter !== 'all') {
      const filtered = accounts.find((a) => a.id === filter);
      if (filtered) {
        chosen = filtered;
      } else {
        effectiveFilter = 'all';
        await this.context.globalState.update('muse.sessionAccountFilter', 'all');
        this.postSessions();
        void vscode.window.showInformationMessage(`Tài khoản đang lọc hội thoại (${filter}) không còn trong pool gateway nên đã về "Tất cả tài khoản".`);
      }
    }
    if (effectiveFilter === 'all' && accounts.length > 1 && chosen === accounts[0]) {
      const pick = await vscode.window.showQuickPick(
        accounts.map((a) => ({ ...this.accountPickLabel(a), account: a })),
        { placeHolder: 'Chọn tài khoản cho hội thoại mới' },
      );
      if (!pick) { this.postSessions(); return false; }
      chosen = pick.account;
    }
    this.syncCurrentSession();
    const session: ChatSession = { id: crypto.randomUUID(), title: 'Hội thoại mới', conversationId: crypto.randomUUID(), messages: [], createdAt: Date.now(), updatedAt: Date.now(), workspacePath: workspaceRoot(), accountId: chosen.id, accountLabel: chosen.label || chosen.id, accountStatusAtSave: chosen.status };
    this.store.sessions.push(session);
    this.currentSessionId = session.id;
    this.history = session.messages;
    this.historySessionId = session.id;
    this.conversationId = session.conversationId;
    this.pendingAttachments = [];
    this.saveSessions();
    this.post('historyCleared', {});
    this.postSessions();
    this.post('status', { text: 'Đã tạo hội thoại mới.' });
    return true;
  }

  async renameSession(): Promise<void> {
    const session = this.currentSession();
    if (!session) { void vscode.window.showInformationMessage('Chưa có hội thoại nào để đổi tên.'); this.postSessions(); return; }
    const name = await vscode.window.showInputBox({ prompt: 'Đặt tên mới cho hội thoại hiện tại', value: session.title });
    if (!name || name.trim().length === 0) { this.postSessions(); return; }
    session.title = name.trim().slice(0, 80);
    // v0.8.12: đổi tên tay đặt cờ bảo vệ — từ nay đồng bộ thường và
    // lệnh ép buộc đều không ghi đè tiêu đề này. Lưu ý: hội thoại đổi
    // tên tay TRƯỚC 0.8.12 không có cờ nên lần đồng bộ đầu sau khi lên
    // 0.8.12 vẫn có thể bị ghi đè (xem README).
    session.titleEditedManually = true;
    this.saveSessions();
    this.postSessions();
  }

  async deleteSession(): Promise<void> {
    const session = this.currentSession();
    if (!session) { void vscode.window.showInformationMessage('Chưa có hội thoại nào để xóa.'); this.postSessions(); return; }
    await this.deleteSessionById(session.id);
  }

  // v0.8.2, việc 2: xóa ĐÚNG session theo id, không cần mở nó trước
  // (nút xóa trên từng item trong cột trái + tab panel gọi hàm này).
  // Lựa chọn cho trường hợp chỉ còn 1 session (điểm d): cho danh sách
  // về RỖNG an toàn thay vì làm trống + đổi tên thành "Hội thoại 1"
  // như hành vi cũ (khiến user tưởng xóa không được). Rỗng an toàn vì:
  // currentSession() trả null, onStoreChanged về trạng thái trống thay
  // vì tự tạo session mới, SessionStore không tự tạo session khi tải
  // danh sách rỗng (chỉ tạo từ lịch sử legacy còn tin nhắn), gửi tin
  // khi rỗng tự tạo session mới qua newSession() rồi mới gửi.
  // Sau khi xóa: session biến mất khỏi cột trái + tab panel (notify
  // qua saveSessions), KHÔNG quay lại sau khởi động lại (persist
  // trong removeSession + saveSessions), và KHÔNG xóa thread trên web.
  async deleteSessionById(id: string): Promise<void> {
    const session = this.store.find(id);
    if (!session) { this.postSessions(); return; }
    let msg = `Xóa hội thoại "${session.title}"? Lịch sử của hội thoại này sẽ mất.`;
    if (session.threadUrl) {
      msg += ' Chỉ xóa trong extension và mapping gateway; thread gốc vẫn còn trên web muse.ai trừ khi bạn xóa tay trên web, và đồng bộ sau sẽ không tự nhập lại thread này nữa (muốn nhập lại thì dùng lệnh "Muse: Cho phép nhập lại các hội thoại đã xóa").';
    }
    const answer = await vscode.window.showWarningMessage(msg, 'Xóa', 'Hủy');
    if (answer !== 'Xóa') { this.postSessions(); return; }
    // v0.8.27: session đang có run thì abort run đó TRƯỚC khi xóa (sau
    // khi user đã xác nhận, không abort trước để bấm Hủy không giết
    // run oan). finally của run chịu được session đã mất: nó kiểm tra
    // store.find trước khi ghi, không hồi sinh session đã xóa.
    this.runManager.abort(id);
    // Tombstone trước khi xóa khỏi danh sách (điểm c).
    if (session.threadUrl) { this.addDeletedThreadUrl(session.threadUrl); }
    // Xóa mapping gateway (điểm b): best-effort, lỗi thì vẫn xóa
    // session local và báo rõ, không im lặng. File mapping không tồn
    // tại (session chưa từng chat) thì endpoint trả false, không lỗi.
    let mappingError: string | undefined;
    try {
      const info = await this.gateway.ensureStarted();
      await deleteGatewayConversation(info.baseUrl, info.apiKey, session.conversationId);
    } catch (e) {
      mappingError = e instanceof Error ? e.message : String(e);
    }
    const wasCurrent = id === this.currentSessionId;
    if (!this.store.removeSession(id)) { this.postSessions(); return; }
    if (wasCurrent) {
      const next = [...this.store.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (next) {
        this.currentSessionId = next.id;
        this.history = next.messages;
        this.historySessionId = next.id;
        this.conversationId = next.conversationId;
      } else {
        this.currentSessionId = '';
        this.history = [];
        this.historySessionId = '';
        this.conversationId = '';
      }
      this.pendingAttachments = [];
    }
    // saveSessions: persist + ghi currentSessionId mới (kể cả rỗng)
    // cho lần khởi động sau + notify các bề mặt khác chuyển đi.
    this.saveSessions();
    this.post('historyCleared', {});
    if (wasCurrent && this.history.length > 0) {
      this.post('history', { messages: this.history.map((h) => ({ role: h.role, text: typeof h.content === 'string' ? h.content : '' })) });
    }
    this.postSessions();
    // v0.8.8, việc 1a: xóa session đang mở thì bề mặt chuyển sang
    // session thay thế — session đó cũng tự tải lịch sử nếu import
    // từ web mà đang rỗng.
    if (wasCurrent) { await this.maybeAutoLoadCurrentWebHistory(); }
    if (mappingError) {
      void vscode.window.showWarningMessage(`Đã xóa hội thoại "${session.title}" trong extension, nhưng chưa xóa được mapping gateway (lỗi: ${mappingError}). Thread cũ có thể vẫn nối tiếp được nếu tạo lại session cùng conversationId; hãy thử xóa lại hoặc kiểm tra gateway.`);
    } else {
      this.post('status', { text: `Đã xóa hội thoại: ${session.title}` });
    }
  }

  // Đồng bộ hội thoại từ web, mức 1 (v0.6.0): chỉ lấy danh sách thread
  // từ sidebar muse.ai rồi đăng ký mapping gateway để nối tiếp thread.
  // KHÔNG tự chạy nền, KHÔNG tự xóa session nào, KHÔNG đổi tài khoản
  // của session cũ. Khử trùng theo URL đã chuẩn hóa (bỏ dấu / cuối):
  // thread đã có trong danh sách URL đã đăng ký ở gateway HOẶC đã có
  // threadUrl trong session của extension thì bỏ qua. Session mới chỉ
  // được đưa vào danh sách SAU KHI register thành công; register lỗi
  // thì thread đó không tạo session, đếm lỗi và tiếp tục thread khác.
  // Trạng thái session mới tuân thủ đúng luật 0.5.0 vì postSessions
  // dùng chung sessionStatus theo accountId, không viết logic riêng.
  // Lệnh palette v0.8.12 "Muse: Ép cập nhật tiêu đề hội thoại từ web":
  // hỏi xác nhận bằng modal trước khi ghi đè, rồi chạy syncFromWeb ở
  // chế độ ép buộc. Chỉ ép cho hội thoại import từ web; hội thoại sửa
  // tay từ 0.8.12 trở đi không bị chạm tới (cờ titleEditedManually),
  // nhưng hội thoại đổi tên tay TRƯỚC 0.8.12 không có cờ nên vẫn có
  // thể bị ghi đè — thông báo nêu rõ điều này trước khi user xác nhận.
  async forceSyncTitlesFromWeb(): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      'Ép cập nhật tiêu đề sẽ ghi đè tiêu đề của mọi hội thoại import từ web bằng tiêu đề web mới nhất, kể cả tiêu đề anchor trông như thật nhưng sai. Hội thoại bạn đã đổi tên tay từ v0.8.12 trở đi sẽ không bị chạm tới, nhưng hội thoại đổi tên tay TRƯỚC 0.8.12 không có cờ bảo vệ nên có thể bị ghi đè. Tiếp tục?',
      { modal: true }, 'Ép cập nhật', 'Hủy');
    if (answer !== 'Ép cập nhật') { return; }
    await this.syncFromWeb(true);
  }

  // Lệnh palette v0.8.13 "Muse: Sửa tiêu đề chung thành tiêu đề từ tin
  // nhắn đầu tiên": lệnh opt-in RIÊNG để sửa title hàng loạt, KHÔNG
  // đổi logic đồng bộ mức 1 thường (đồng bộ thường vẫn không tải nội
  // dung tin nhắn). Duyệt các session import từ web có title chung
  // hoặc dự phòng và không có cờ sửa tay; session nào đã có messages
  // thì suy ra ngay từ tin user đầu tiên đã lưu; session nào messages
  // rỗng thì gọi đúng đường loadWebThreadHistory hiện có để tải rồi
  // suy ra (đường đó tự suy title từ tin đầu sau khi tải). Chạy tuần
  // tự, mỗi session báo trạng thái qua post status, cuối cùng báo
  // tổng số đã sửa / không sửa được / bỏ qua, lưu lại và postSessions.
  async fixGenericTitlesFromFirstMessage(): Promise<void> {
    const eligible = this.store.sessions.filter((s) =>
      s.importedFromWeb === true && !s.titleEditedManually && !!s.threadUrl &&
      (isGenericWebTitle(s.title) || isFallbackWebTitle(s.title, s.threadUrl as string)));
    if (eligible.length === 0) {
      void vscode.window.showInformationMessage('Không có hội thoại import từ web nào đang mang tiêu đề chung hoặc dự phòng để sửa.');
      return;
    }
    let fixed = 0;
    let failed = 0;
    let skipped = 0;
    let changed = false;
    for (const session of eligible) {
      const before = session.title;
      if (session.messages.length > 0) {
        const derived = titleFromFirstUserMessage(session.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })));
        if (derived && derived !== before) { session.title = derived; fixed++; changed = true; }
        else { failed++; }
        this.post('status', { text: `Sửa tiêu đề: ${session.title}` });
        continue;
      }
      const res = await this.loadWebThreadHistory(session, false);
      if (res === 'skipped') { skipped++; this.post('status', { text: `Bỏ qua (không xác định được tài khoản): ${before}` }); continue; }
      // loadWebThreadHistory đã tự suy title từ tin đầu khi tải được;
      // nếu sau đó title vẫn chung/dự phòng thì thử suy lại một lần
      // từ messages vừa tải (trường hợp tin đầu rỗng/generic).
      if (session.title !== before && !isGenericWebTitle(session.title) && !isFallbackWebTitle(session.title, session.threadUrl as string)) {
        fixed++; changed = true;
      } else {
        const derived = titleFromFirstUserMessage(session.messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' })));
        if (derived && derived !== before) { session.title = derived; fixed++; changed = true; }
        else { failed++; }
      }
      this.post('status', { text: `Sửa tiêu đề: ${session.title}` });
    }
    if (changed) { this.store.persist(); }
    this.postSessions();
    void vscode.window.showInformationMessage(`Đã sửa ${fixed}/${eligible.length} tiêu đề chung từ tin nhắn đầu tiên (không sửa được ${failed}, bỏ qua ${skipped}).`);
  }

  // v0.8.12: forceTitles=true là chế độ ép buộc của lệnh palette
  // "Muse: Ép cập nhật tiêu đề hội thoại từ web" — gateway thăm dò nút
  // bất kể quét link được bao nhiêu thread, và extension ghi đè title
  // của session import từ web (trừ sửa tay). Đồng bộ thường giữ
  // forceTitles=false.
  async syncFromWeb(forceTitles = false): Promise<void> {
    const normalizeUrl = (u: string): string => u.trim().replace(/\/+$/, '');
    const threadIdFromUrl = (u: string): string => {
      const noQuery = u.split(/[?#]/)[0].replace(/\/+$/, '');
      const idx = noQuery.indexOf('/thread/');
      return idx >= 0 ? noQuery.slice(idx + '/thread/'.length) : noQuery;
    };
    try {
      const info = await this.gateway.ensureStarted();
      const accounts = await fetchGatewayAccounts(info.baseUrl, info.apiKey);
      this.cachedAccounts = accounts.map((a) => ({ id: a.id, label: a.label, enabled: a.enabled, status: a.status, email: a.email, username: a.username }));
      this.accountsCacheLoaded = true;
      if (accounts.length === 0) {
        void vscode.window.showInformationMessage('Chưa có tài khoản Muse nào trong gateway, chưa đồng bộ được hội thoại từ web. Hãy thêm tài khoản trong Cài đặt rồi đồng bộ lại.');
        this.openSettings();
        return;
      }
      // v0.8.8, việc 2c: bộ lọc đang là một tài khoản cụ thể thì
      // đồng bộ thẳng tài khoản đó, KHÔNG hiện QuickPick; khi là
      // "Tất cả tài khoản" thì QuickPick như cũ. Tài khoản lọc không
      // còn trong pool thì tự về "Tất cả" và báo rõ, rồi đi tiếp
      // luồng QuickPick cũ.
      let account = accounts[0];
      const syncFilter = this.accountFilter();
      const filteredAccount = syncFilter !== 'all' ? accounts.find((a) => a.id === syncFilter) : undefined;
      if (syncFilter !== 'all' && filteredAccount) {
        account = filteredAccount;
      } else {
        if (syncFilter !== 'all') {
          await this.context.globalState.update('muse.sessionAccountFilter', 'all');
          this.postSessions();
          void vscode.window.showInformationMessage(`Tài khoản đang lọc hội thoại (${syncFilter}) không còn trong pool gateway nên đã về "Tất cả tài khoản".`);
        }
        if (accounts.length > 1) {
          const pick = await vscode.window.showQuickPick(
            accounts.map((a) => ({ label: a.label ? `${a.label} (${a.id})` : a.id, description: `trạng thái: ${a.status}` + (a.email || a.username ? ` — ${a.email || a.username}` : ''), account: a })),
            { placeHolder: 'Chọn tài khoản để đồng bộ hội thoại từ web' },
          );
          if (!pick) { return; }
          account = pick.account;
        }
      }
      const webResult = await fetchWebThreads(info.baseUrl, info.apiKey, account.id, forceTitles);
      const threads = webResult.threads;
      const debug = webResult.debug;
      // v0.7.0, điểm 4: CHỈ khử trùng theo threadUrl của session đã có
      // trong danh sách extension. Không khử trùng theo tập URL đã đăng
      // ký trong gateway nữa: tập đó là toàn cục (không phân theo tài
      // khoản) và vẫn còn sau khi session bị xóa, nên một thread đã
      // đăng ký dưới tài khoản trùng A sẽ chặn nhập lại dưới tài khoản
      // B, và session đã xóa cũng không nhập lại được — user tưởng
      // đồng bộ không hoạt động. Endpoint /conversations/urls giữ
      // nguyên cho panel khác, nhưng syncFromWeb không dùng nó nữa.
      // Hệ quả: session tạo trước v0.6.0 chưa có threadUrl có thể bị
      // nhập trùng một lần trong lần đồng bộ đầu tiên sau bản này (vì
      // không có URL để đối chiếu); xóa bản trùng tay là xong, từ sau
      // đó session mới đều có threadUrl nên không trùng nữa.
      const existing = new Set(this.store.sessions.filter((s) => s.threadUrl).map((s) => normalizeUrl(s.threadUrl as string)));
      const existingByUrl = new Map(this.store.sessions.filter((s) => s.threadUrl).map((s) => [normalizeUrl(s.threadUrl as string), s] as const));
      // v0.8.2, việc 2c: bỏ qua mọi URL trong tombstone (đã bị user xóa).
      const tombstones = new Set(this.deletedThreadUrls().map((u) => normalizeUrl(u)));
      let added = 0;
      let skipped = 0;
      let tombstoned = 0;
      let errors = 0;
      let titlesUpdated = 0;
      let titlesReset = 0;
      for (const thread of threads) {
        const url = normalizeUrl(thread.url);
        if (tombstones.has(url)) { tombstoned++; continue; }
        if (existing.has(url)) {
          // v0.8.8, việc 1d: đồng bộ cập nhật title cũ — thread quét
          // được mà session đã có vẫn mang title dự phòng "Hội thoại
          // web <id>" thì cập nhật sang title thật lần này quét được,
          // để hội thoại import từ bản trước cũng hiện title mà không
          // cần mở từng cái. Không đổi logic khử trùng/tombstone/
          // register: vẫn bỏ qua (skipped) như cũ, chỉ thêm cập nhật
          // title khi đúng quy tắc resolveWebTitleUpdated (v0.8.12:
          // chế độ ép buộc chỉ ép session import từ web, sửa tay thì
          // resolver chặn trong mọi chế độ).
          const oldSession = existingByUrl.get(url);
          if (oldSession) {
            const newTitle = resolveWebTitleUpdated(oldSession.title, url, thread.title, {
            titleEditedManually: oldSession.titleEditedManually,
            force: forceTitles && oldSession.importedFromWeb === true,
          });
            if (newTitle) { oldSession.title = newTitle; titlesUpdated++; }
            // v0.8.13: session đã nhiễm tiêu đề chung mà lần quét này
            // không cho title thật (kể cả khi title quét được cũng là
            // chung và đã bị resolver loại) thì đặt lại thành dự phòng
            // theo id, để ít nhất các item phân biệt được với nhau thay
            // vì 10 item cùng mang "Chat-Muse". Không bao giờ đụng
            // session có cờ sửa tay, kể cả khi title của nó trùng
            // chuỗi chung.
            else if (!oldSession.titleEditedManually && isGenericWebTitle(oldSession.title)) {
              const fallback = fallbackWebTitle(url);
              if (oldSession.title !== fallback) { oldSession.title = fallback; titlesReset++; }
            }
          }
          skipped++; continue;
        }
        const conversationId = crypto.randomUUID();
        // v0.8.13: title mới là tiêu đề chung ở mọi dạng (kể cả khi
        // gateway cũ vẫn trả chuỗi chung) thì dùng dự phòng theo id,
        // không dùng chuỗi chung làm title của session mới.
        const rawNewTitle = (thread.title || '').trim();
        const session: ChatSession = {
          id: crypto.randomUUID(),
          title: rawNewTitle && !isGenericWebTitle(rawNewTitle) ? rawNewTitle.slice(0, 80) : `Hội thoại web ${threadIdFromUrl(url)}`,
          conversationId,
          messages: [],
          createdAt: Date.now(),
          updatedAt: Date.now(),
          workspacePath: workspaceRoot(),
          accountId: account.id,
          accountLabel: account.label || account.id,
          accountStatusAtSave: account.status,
          threadUrl: url,
          importedFromWeb: true,
        };
        try {
          // Hint đăng ký phải đúng conversationId: BeginChat của gateway
          // dùng hint = conversationId gửi trong field user để Load mapping.
          await registerConversation(info.baseUrl, info.apiKey, account.id, conversationId, url);
        } catch {
          errors++;
          continue;
        }
        this.store.sessions.push(session);
        existing.add(url);
        added++;
      }
      if (added > 0) {
        this.saveSessions();
        // Nếu đang ở trạng thái trống mà đồng bộ thêm được session thì
        // mở luôn session mới nhất, không để danh sách có mà không mở.
        if (!this.currentSession()) {
          const latest = [...this.store.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
          if (latest) {
            this.currentSessionId = latest.id;
            this.history = latest.messages;
            this.historySessionId = latest.id;
            this.conversationId = latest.conversationId;
            this.saveSessions();
          }
        }
      } else if (titlesUpdated > 0 || titlesReset > 0) {
        // Chỉ cập nhật title, không thêm session: persist trực tiếp
        // (không qua saveSessions để khỏi bump updatedAt của session
        // đang mở một cách không liên quan). titlesReset cũng cần
        // persist vì nó đổi title của session đã có về dự phòng.
        this.store.persist();
      }
      this.postSessions();
      // v0.7.0, điểm 4: đừng chỉ báo "Đã thêm 0" chung chung — nêu rõ
      // gateway đọc được bao nhiêu thread, bỏ qua bao nhiêu vì đã có,
      // và nếu gateway đọc được 0 thì nêu trang đã mở + tổng số link
      // đọc được để user biết lỗi ở khâu nào.
      let msg = `Đã thêm ${added} hội thoại mới từ web (gateway đọc được ${threads.length} thread), bỏ qua ${skipped} hội thoại đã có trong danh sách`;
      if (titlesUpdated > 0) { msg += `, cập nhật ${titlesUpdated} tiêu đề thật cho hội thoại đã import trước đó${forceTitles ? ' (chế độ ép buộc, bỏ qua hội thoại sửa tay)' : ''}`; }
      if (titlesReset > 0) { msg += `, đặt lại ${titlesReset} tiêu đề chung về dự phòng theo id (chưa có tiêu đề thật trong lần quét này)`; }
      if (tombstoned > 0) { msg += `, ${tombstoned} hội thoại đã xóa nên không nhập lại`; }
      if (errors > 0) { msg += `, ${errors} hội thoại lỗi khi đăng ký`; }
      if (added === 0 && debug) {
        if (debug.threadCount === 0) {
          // v0.8.5: khi về 0 thì nêu thêm số liệu trang chủ (không
          // chỉ trang cuối) để user tự đọc được lỗi ở khâu nào mà
          // không cần mò log; gateway cũ không có pages thì giữ dạng
          // cũ. Hướng dẫn tìm dòng web_threads: dòng này chỉ có từ
          // 0.8.4 và chỉ in ra khi request đồng bộ kết thúc (sau
          // khoảng 20–25 giây quét) — user 0.8.4 không thấy dòng này
          // có thể vì tìm trước khi quét xong hoặc gateway cũ vẫn
          // đang chạy.
          const home = debug.pages && debug.pages.length > 0 ? debug.pages[0] : undefined;
          const extra = home
            ? ` Trang chủ đọc được ${home.threadCount} thread / ${home.linkCount} link${home.hasLoginForm ? ' (có form đăng nhập)' : ''}${home.sidebarClicked ? ' (đã thử bấm mở sidebar)' : ''}; trang /thread/new đọc được ${debug.pages && debug.pages.length > 1 ? `${debug.pages[1].threadCount} thread / ${debug.pages[1].linkCount} link` : 'không rõ'}.`
            : '';
          msg += `. Gateway không đọc được thread nào từ trang ${debug.pageUrl || 'muse.ai'} (tổng số link đọc được: ${debug.linkCount}). Có thể sidebar lịch sử chưa kịp tải hoặc không render thành link.${extra} Hãy tìm dòng bắt đầu bằng web_threads trong panel Nhật ký hoặc Output (dòng này chỉ có từ bản 0.8.4 và chỉ in ra khi request đồng bộ kết thúc, tức sau khoảng 20–25 giây quét) rồi thử đồng bộ lại.`;
        } else {
          msg += `.`;
        }
      }
      void vscode.window.showInformationMessage(msg);
    } catch (e) {
      void vscode.window.showErrorMessage(`Không đồng bộ được hội thoại từ web: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      // v0.8.13: tín hiệu hoàn tất cho hiệu ứng loading của nút Đồng
      // bộ từ web — finally bao mọi đường thoát (kể cả hủy QuickPick,
      // không có tài khoản, lỗi) nên nút không bao giờ kẹt loading.
      this.post('syncDone', {});
    }
  }

  // v0.8.27: saveHistory() cũ (saveSessions qua bề mặt) đã xóa — run()
  // ghi thẳng vào session đích và finishRun persist, không còn lưu
  // lịch sử qua bề mặt đang hiển thị nữa.
  clearHistory(): void {
    // v0.8.2: danh sách rỗng thì không có gì để xóa lịch sử.
    if (!this.currentSession()) { this.post('historyCleared', {}); this.postSessions(); return; }
    this.history = [];
    this.pendingAttachments = [];
    // Xóa lịch sử thì phải đổi ID hội thoại, nếu không gateway sẽ tái
    // dùng thread Muse cũ phía server dù lịch sử cục bộ đã trống.
    this.conversationId = crypto.randomUUID();
    this.saveSessions();
    this.post('historyCleared', {});
    this.postSessions();
  }

  async stopComputerControl(): Promise<string> {
    const conf = cfg();
    if (this.computer.selectedTitle) {
      try { await this.computer.call(conf.computerHelperPath, 'computer_stop', {}); } catch { /* helper có thể đã thoát */ }
    }
    this.computer.stop();
    return 'Đã dừng điều khiển màn hình thử nghiệm và hủy chọn cửa sổ đích.';
  }

  async selectComputerWindow(): Promise<string> {
    const conf = cfg();
    const reason = this.computer.unavailableReason(conf.computerHelperPath, conf.allowComputerControl);
    if (reason) { return reason; }
    try {
      const list = await this.computer.call(conf.computerHelperPath, 'computer_list_windows', {});
      const windows = JSON.parse(list.text) as Array<{ Handle?: number; ProcessId?: number; Title?: string }>;
      if (windows.length === 0) { return 'Không thấy cửa sổ Windows nào đang mở để chọn làm đích.'; }
      const pick = await vscode.window.showQuickPick(
        windows.map((w) => ({ label: w.Title || '(không tiêu đề)', description: `process ${w.ProcessId}`, window: w })),
        { placeHolder: 'Chọn cửa sổ đích cho điều khiển màn hình thử nghiệm (Muse sẽ chỉ tác động cửa sổ này)' },
      );
      if (!pick) { return 'Bạn đã hủy chọn cửa sổ đích.'; }
      const res = await this.computer.call(conf.computerHelperPath, 'computer_select_window', {
        handle: pick.window.Handle, process_id: pick.window.ProcessId, title: pick.window.Title,
      });
      return res.text;
    } catch (e) {
      return `Không chọn được cửa sổ đích: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // Bộ xử lý tin nhắn DÙNG CHUNG cho sidebar và mọi panel (v0.8.0):
  // cùng một webview.js, cùng một giao thức, nhưng `this` là bề mặt
  // nhận tin nên run/switch/delete đều tác động đúng bề mặt đó.
  // Điểm mới duy nhất so với sidebar cũ: 'openInNewTab' mở session
  // trong một WebviewPanel riêng (xem openSessionInPanel).
  private onWebviewMessage(m: { type?: string; text?: string; id?: string; width?: number; height?: number; uris?: unknown; files?: unknown }): void {
    if (m.type === 'send' && m.text) { void this.run(m.text); }
    else if (m.type === 'stop') { this.stop(); }
    else if (m.type === 'openSettings') { this.openSettings(); }
    else if (m.type === 'attach') { void this.attachFile(); }
    else if (m.type === 'dropUris') {
      // Kéo thả từ Explorer của VS Code: webview gửi danh sách URI
      // dạng text/uri-list; extension xử lý từng file bằng đúng hàm
      // theo đường dẫn (video/file generic gửi nguyên từ 0.8.20),
      // file nào lỗi thì hàm đó báo riêng và vẫn tiếp tục file khác.
      const uris = Array.isArray(m.uris) ? m.uris.filter((u): u is string => typeof u === 'string' && u.length > 0) : [];
      void (async () => {
        try {
          for (const raw of uris) {
            let filePath = raw;
            try { if (raw.startsWith('file://')) { filePath = vscode.Uri.parse(raw).fsPath; } } catch { /* giữ nguyên chuỗi gốc, hàm xử lý sẽ báo lỗi riêng */ }
            await this.processAttachmentFile(filePath);
          }
        } finally {
          // v0.8.13: tín hiệu hoàn tất cho nút Đính kèm khi kéo thả
          // theo URI xong (kể cả khi có file lỗi, vì hàm xử lý đã
          // báo riêng từng file).
          this.post('attachDone', {});
        }
      })();
    } else if (m.type === 'dropFiles') {
      // Kéo thả từ ngoài hệ điều hành: webview chỉ đọc được nội dung
      // qua File API nên gửi kèm dataUrl/text trong bộ nhớ; extension
      // xử lý bằng addDroppedFileAttachment với cùng giới hạn cũ.
      const files = Array.isArray(m.files) ? m.files.filter((f): f is Record<string, unknown> => typeof f === 'object' && f !== null) : [];
      try {
        for (const f of files) { this.addDroppedFileAttachment(f); }
      } finally {
        // v0.8.13: tín hiệu hoàn tất cho nút Đính kèm khi kéo thả
        // theo File API xong.
        this.post('attachDone', {});
      }
    }
    else if (m.type === 'dropNoFile') {
      // v0.8.22: thả mà webview không giao được file nào (cả uri-list
      // lẫn File API đều rỗng) thì không im lặng nữa: 'error' hiện
      // bong bóng đỏ nhìn thấy được trong khung chat, kèm 2 đường
      // thay thế còn hoạt động (nút Đính kèm, kéo từ Explorer của
      // VS Code). Không retry, vì webview đã chặn lần thả này rồi;
      // không bịa thêm nguyên nhân khác.
      this.post('error', { text: 'VS Code không giao được file từ thao tác thả này. Hãy dùng nút Đính kèm để chọn file, hoặc kéo file từ Explorer của VS Code vào khung chat thay thế.' });
    }
    else if (m.type === 'clearHistory') { this.clearHistory(); }
    else if (m.type === 'newSession') { void this.newSession(); }
    else if (m.type === 'switchSession' && m.id) { void this.switchSession(m.id); }
    else if (m.type === 'setAccountFilter' && typeof m.id === 'string') { void this.setAccountFilter(m.id); }
    else if (m.type === 'setSessionListWidth' && typeof m.width === 'number') { void this.setSessionListWidth(m.width); }
    else if (m.type === 'setComposerHeight' && typeof m.height === 'number') { void this.setComposerHeight(m.height); }
    else if (m.type === 'openInNewTab' && m.id) { void this.openSessionInPanel(m.id); }
    else if (m.type === 'renameSession') { void this.renameSession(); }
    else if (m.type === 'deleteSession') { void this.deleteSession(); }
    else if (m.type === 'deleteSessionById' && m.id) { void this.deleteSessionById(m.id); }
    else if (m.type === 'syncFromWeb') { void this.syncFromWeb(); }
    else if (m.type === 'getLogs') { this.post('logs', { lines: this.gateway.getLogLines(), time: logTimeNow() }); }
    else if (m.type === 'clearLogs') { this.gateway.clearLogLines(); this.post('logs', { lines: [], time: logTimeNow() }); }
    else if (m.type === 'openOutput') { this.gateway.showOutput(); }
    else if (m.type === 'importLogin') { void vscode.commands.executeCommand('muse.importDesktopLogin'); }
    else if (m.type === 'openDashboard') { void vscode.commands.executeCommand('muse.openGatewayDashboard'); }
    else if (m.type === 'selectComputerWindow') { void this.selectComputerWindow().then((msg) => this.post('status', { text: msg })); }
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: { type?: string; text?: string; id?: string; width?: number }) => { this.onWebviewMessage(m); });
    this.postSessions();
    void this.refreshAccounts();
    if (this.history.length > 0) {
      void view.webview.postMessage({
        type: 'history',
        messages: this.history.map((h) => ({ role: h.role, text: typeof h.content === 'string' ? h.content : '' })),
      });
    }
    // Sidebar mở lại mà session đang mở có run sống thì vẽ thêm tiến
    // trình trực tiếp của nó (v0.8.27, như switchSession).
    this.replayLiveRun(this.currentSessionId);
    if (this.currentSession()?.importedFromWeb) {
      this.post('importedBanner', { text: 'Hội thoại này được đồng bộ từ web muse.ai. Lịch sử cũ nằm trên thread web, tin nhắn tiếp theo sẽ nối tiếp thread đó.' });
    }
    // v0.8.8, việc 1a: khôi phục session đang mở khi mở lại sidebar
    // cũng tự tải lịch sử nếu session import từ web mà đang rỗng.
    void this.maybeAutoLoadCurrentWebHistory();
    if (this.pendingPreset) {
      const preset = this.pendingPreset; this.pendingPreset = undefined;
      void view.webview.postMessage({ type: 'preset', text: preset });
    }
  }

  focusAndPreset(text: string): void {
    void vscode.commands.executeCommand('muse.chat.focus');
    if (this.view) { void this.view.webview.postMessage({ type: 'preset', text }); }
    else { this.pendingPreset = text; }
  }

  // v0.8.27: Dừng chỉ hủy run của session ĐANG HIỂN THỊ trên bề mặt
  // này, không đụng run của session khác (mỗi session một slot riêng
  // trong RunManager). Không có run thì im lặng, không báo lỗi giả.
  stop(): void {
    if (this.currentSessionId) { this.runManager.abort(this.currentSessionId); }
  }

  // Đính kèm tệp vào lượt chat tiếp theo. Gateway chat chỉ nhận text và
  // ảnh (part text / image_url, xem Prompt.ContentToText trong Models.cs),
  // không có part video hay file, nên extension phân loại thật và nói rõ:
  // - Ảnh: gửi đúng dạng image_url data URL, chỉ giữ trong bộ nhớ phiên.
  // - Tệp văn bản (txt/md/json/code/log...): gửi nội dung dạng text kèm
  //   tên tệp, tối đa 500 KiB (quá thì cắt và ghi rõ đã cắt).
  // - Video: thử trích 1 khung hình bằng ffmpeg (nếu máy có ffmpeg) và
  //   gửi khung hình đó dạng ảnh, kèm ghi chú đó chỉ là khung hình chứ
  //   không phải video gốc; nếu không có ffmpeg thì chỉ gửi ghi chú tên
  //   và dung lượng video, không giả vờ đã gửi video.
  // - Tệp nhị phân khác: chỉ gửi ghi chú tên/dung lượng, không đọc nội
  //   dung. Không lưu nội dung đính kèm vào workspaceState cùng lịch sử.
  // Hộp chọn file v0.8.12: chọn được NHIỀU file cùng lúc
  // (canSelectMany:true); xử lý lần lượt từng file bằng đúng hàm
  // processAttachmentFile dùng chung với đường kéo thả theo URI, file
  // nào lỗi thì báo riêng file đó và vẫn tiếp tục các file còn lại.
  private async attachFile(): Promise<void> {
    try {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        title: 'Chọn tệp đính kèm vào chat Muse (ảnh, văn bản, video)',
      });
      if (!picked || picked.length === 0) { return; }
      for (const uri of picked) { await this.processAttachmentFile(uri.fsPath); }
    } finally {
      // v0.8.13: tín hiệu hoàn tất cho hiệu ứng loading của nút Đính
      // kèm — finally bao cả đường hủy hộp chọn, nên nút không kẹt.
      this.post('attachDone', {});
    }
  }

  // Xử lý MỘT file theo đường dẫn (v0.8.12, tách từ attachFile cũ để
  // hộp chọn nhiều file và kéo thả theo URI dùng chung): ảnh qua
  // dataUrlOfImageFile (tối đa 20 MiB/ảnh, rỗng thì lỗi), video trích
  // khung hình giây 1 bằng ffmpeg nếu có (không có thì chỉ gửi note),
  // text cắt ở 500 KiB kèm ghi chú, nhị phân chỉ gửi note tên +
  // dung lượng. Lỗi của file này chỉ báo riêng file đó, không chặn
  // file khác; thành công thì gửi message 'attached' để hiện chip riêng.
  // v0.8.20: dựng attachment file gửi nguyên từ đĩa (video và
  // nhị phân generic). Kiểm tra giới hạn 25 MB/rỗng trước khi đọc
  // bytes; giới hạn 10 file/lượt do pushAttachment chặn sau đó.
  private buildFileAttachmentFromDisk(filePath: string, name: string, size: number, kindLabel: string): PendingAttachment {
    const currentFiles = this.pendingAttachments.filter((a) => a.kind === 'file' && a.dataUrl).length;
    const limitError = checkFileAttachmentLimit(size, currentFiles);
    if (limitError) { throw new Error(limitError); }
    const buf = fs.readFileSync(filePath);
    const mime = mimeForFile(name);
    return { name, size, kind: 'file', kindLabel, dataUrl: `data:${mime};base64,${buf.toString('base64')}`, mime };
  }

  private async processAttachmentFile(filePath: string): Promise<void> {
    const name = path.basename(filePath);
    try {
      const size = fs.statSync(filePath).size;
      if (size <= 0) { throw new Error('Tệp rỗng, không gửi được.'); }
      const ext = path.extname(filePath).toLowerCase();
      if (IMAGE_EXTS.includes(ext)) {
        const dataUrl = dataUrlOfImageFile(filePath);
        this.pushAttachment({ name, size, kind: 'image', kindLabel: 'Ảnh', dataUrl });
      } else if (VIDEO_EXTS.includes(ext)) {
        // v0.8.20: video đính kèm tay gửi nguyên file, không còn
        // trích khung ffmpeg như trước (khung mẫu vẫn còn ở tool
        // read_video_frames cho model cần xem nhanh).
        this.pushAttachment(this.buildFileAttachmentFromDisk(filePath, name, size, 'Video'));
      } else {
        const buf = fs.readFileSync(filePath);
        const looksText = TEXT_EXTS.includes(ext) || (buf.length > 0 && !buf.includes(0));
        if (looksText) {
          const full = buf.toString('utf8');
          const limit = 500 * 1024;
          const text = full.length > limit ? full.slice(0, limit) + `\n[Đã cắt nội dung ở 500 KiB, tệp gốc ${Math.round(size / 1024)} KiB.]` : full;
          this.pushAttachment({ name, size, kind: 'text', kindLabel: 'Văn bản', text });
        } else {
          // v0.8.20: nhị phân generic gửi nguyên, không còn note
          // chỉ tên/dung lượng như trước.
          this.pushAttachment(this.buildFileAttachmentFromDisk(filePath, name, size, 'Tệp'));
        }
      }
    } catch (e) {
      this.post('error', { text: `Không đính kèm được tệp ${name}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // Xây MỘT attachment từ file kéo thả trong bộ nhớ (v0.8.12, hàm thuần
  // để test đơn vị trực tiếp từ out/extension.js): webview đã đọc sẵn
  // dataUrl cho ảnh/file hoặc text cho tệp văn bản; hàm này áp giới
  // hạn — ảnh kiểm tra dung lượng giải mã tối đa 20 MiB
  // (MAX_IMAGE_BYTES, giống dataUrlOfImageFile) và khác rỗng, file
  // generic tối đa 25 MB (giới hạn của web), text cắt ở 500 KiB kèm
  // ghi chú giống đường theo đường dẫn. v0.8.20: video và nhị phân
  // qua đường này gửi nguyên dạng file part, không còn note thay
  // thế; đọc hỏng hoặc vượt giới hạn thì ném lỗi để caller báo
  // riêng file đó, tuyệt đối không bịa nội dung.
  // v0.8.20: đẩy attachment vào hàng chờ, chặn file thứ 11 trở đi
  // trong cùng một lượt (tối đa 10 file/lượt) bằng lỗi rõ thay vì
  // nhận rồi lặng lẽ bỏ. Ảnh/văn bản không tính vào giới hạn này.
  private pushAttachment(att: PendingAttachment): boolean {
    if (att.kind === 'file' && att.dataUrl) {
      const currentFiles = this.pendingAttachments.filter((a) => a.kind === 'file' && a.dataUrl).length;
      if (currentFiles >= MAX_FILES_PER_TURN) {
        this.post('error', { text: `Không đính kèm được tệp ${att.name}: đã đủ tối đa 10 file mỗi lượt gửi.` });
        return false;
      }
    }
    this.pendingAttachments.push(att);
    this.post('attached', { name: att.name, size: att.size, kindLabel: att.kindLabel });
    return true;
  }

  private addDroppedFileAttachment(file: { name?: unknown; size?: unknown; dataUrl?: unknown; text?: unknown; type?: unknown; tooLarge?: unknown }): void {
    try {
      const att = buildDroppedAttachment(file);
      this.pushAttachment(att);
    } catch (e) {
      const name = typeof file.name === 'string' && file.name ? file.name : 'tệp';
      this.post('error', { text: `Không đính kèm được tệp ${name}: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  // v0.8.18: trích 1 khung hình tại mốc giây t, dùng cho tool
  // read_video_frames (đường đính kèm tay từ 0.8.20 gửi nguyên
  // file nên không dùng wrapper giây 1 này nữa, đã xóa).
  // ffmpeg vắng hoặc lỗi thì trả undefined, caller ghi chú thành
  // thật, tuyệt đối không bịa khung hình. File tạm luôn được dọn
  // sau khi đọc.
  private extractVideoFrameAt(filePath: string, t: number): Promise<string | undefined> {
    return new Promise((resolve) => {
      const tmp = path.join(os.tmpdir(), `muse-frame-${crypto.randomUUID()}.png`);
      execFile('ffmpeg', ['-y', '-ss', String(t), '-i', filePath, '-vframes', '1', '-q:v', '2', tmp], () => {
        try {
          if (!fs.existsSync(tmp)) { resolve(undefined); return; }
          const dataUrl = dataUrlOfImageFile(tmp);
          resolve(dataUrl);
        } catch { resolve(undefined); } finally { try { fs.unlinkSync(tmp); } catch { /* bỏ qua */ } }
      });
    });
  }

  private post(type: string, payload: Record<string, unknown> = {}): void {
    const target = this.panel?.webview ?? this.view?.webview;
    void target?.postMessage({ type, ...payload });
  }

  private html(webview: vscode.Webview): string {
    const base = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const read = (name: string) => fs.readFileSync(vscode.Uri.joinPath(base, name).fsPath, 'utf8');
    const css = webview.asWebviewUri(vscode.Uri.joinPath(base, 'webview.css'));
    const js = webview.asWebviewUri(vscode.Uri.joinPath(base, 'webview.js'));
    return read('webview.html').replaceAll('{{cssUri}}', css.toString()).replaceAll('{{jsUri}}', js.toString());
  }

  // Gate đăng nhập lại (v0.5.0): kiểm tra tài khoản gắn với session hiện
  // tại trước khi gửi chat. Trả 'ok' nếu không có tài khoản gắn, hoặc
  // tài khoản vẫn dùng được; 'unknown' nếu không đọc được pool (lỗi
  // mạng, 401 gateway ngoài có admin key riêng) — trường hợp này KHÔNG
  // chặn, để tương thích ngược. 'loggedout'/'cooling'/'disabled' thì chặn.
  // v0.8.27: kiểm tra theo session đích truyền vào (không còn
  // currentSession() của bề mặt, vì bề mặt có thể đã chuyển đi nơi
  // khác trong lúc run chạy).
  private async checkSessionAccount(gwConf: { baseUrl: string; apiKey: string }, session: ChatSession): Promise<'ok' | 'unknown' | 'loggedout' | 'cooling' | 'disabled'> {
    if (!session.accountId) { return 'ok'; }
    let accounts: Array<{ id: string; enabled: boolean; status: string }>;
    try {
      accounts = await fetchGatewayAccounts(gwConf.baseUrl, gwConf.apiKey);
    } catch {
      return 'unknown';
    }
    const acc = accounts.find((a) => a.id === session.accountId);
    if (!acc || acc.status.toLowerCase() === 'invalid') { return 'loggedout'; }
    if (!acc.enabled) { return 'disabled'; }
    if (acc.status.toLowerCase() === 'cooling') { return 'cooling'; }
    return 'ok';
  }

  // ---------------- Vòng lặp agent: gọi gateway, parse tool, thực thi ----------------
  // Vòng lặp agent, vận hành trên SESSION ĐÍCH (v0.8.27), không còn
  // trên "session đang hiển thị" của bề mặt gọi nó. run() là điểm vào
  // từ nút Gửi của một bề mặt: nó xác định session đích (session đang
  // mở của bề mặt đó, hoặc tạo mới khi rỗng), giành slot của session
  // đó trong RunManager rồi chạy toàn bộ vòng lặp trên session đó.
  // Bề mặt có chuyển đi nơi khác giữa chừng thì run vẫn chạy tới kết
  // quả (slot + AbortController sống trong RunManager, tin nhắn ghi
  // vào messages của session đích, hiển thị qua sink tới mọi bề mặt
  // đang mở đúng session đó). 'done' cuối lượt do finally gửi (qua
  // sink.done) nên mọi đường thoát sớm trong phần giữ slot KHÔNG tự
  // post 'done' nữa — tránh double 'done' và tránh quên 'done'.
  async run(userText: string): Promise<void> {
    // v0.8.13: các đường thoát sớm TRƯỚC khi giành slot cũng post
    // 'done' như các đường khác của run(), để nút Gửi ở webview không
    // kẹt loading.
    const root = workspaceRoot();
    if (!root) {
      this.post('error', { text: 'Hãy mở một thư mục dự án trong VS Code trước (File > Open Folder), rồi gửi lại yêu cầu.' });
      this.post('done', {});
      return;
    }
    const conf = cfg();
    // v0.8.2, việc 2d: gửi tin khi danh sách rỗng thì tự tạo session
    // mới (qua đúng luồng chọn tài khoản của newSession) rồi mới gửi.
    // User hủy chọn tài khoản thì dừng, không gửi tin mù tài khoản.
    let session = this.currentSession();
    if (!session) {
      const created = await this.newSession();
      if (!created) {
        this.post('done', {});
        return;
      }
      session = this.currentSession();
      if (!session) {
        this.post('done', {});
        return;
      }
    }
    // Giành slot của session đích. Session đã có run thì lượt này bị
    // từ chối RIÊNG session đó (không đụng run đang chạy, không đụng
    // run của session khác) — đây là điểm thay cho cờ running cũ.
    const targetId = session.id;
    const slot = this.runManager.tryStart(targetId, session.accountId || '');
    if (!slot) {
      this.post('error', { text: 'Hội thoại này đang có một yêu cầu chạy. Chờ nó xong rồi gửi tiếp.' });
      this.post('done', {});
      return;
    }
    // Run mới bắt đầu thì xóa tích cũ của run gần nhất: tích chỉ phản
    // ánh run gần nhất, và 'running' thắng 'done' trong runStatusFor
    // nên từ đây danh sách hiện xoay tròn cho session này.
    if (session.lastRunOutcome) {
      session.lastRunOutcome = undefined;
      this.store.persist();
    }
    const signal = slot.abort.signal;
    const sink = this.createRunSink(targetId);
    // Trạng thái của riêng lượt này (thay cho các trường provider cũ
    // đã gây race khi cùng surface gửi 2 session — xem RunCtx).
    const ctx: RunCtx = { lastStreamed: false, lastToolImages: [], lastToolFiles: [], lastComputerImage: undefined, turnFileCount: 0, turnUserText: userText };
    // Lịch sử của session đích (tham chiếu sống tới session.messages
    // trong store): vòng lặp đọc/ghi trực tiếp lên nó, không qua
    // this.history của bề mặt (bề mặt có thể đã chuyển đi nơi khác).
    const history = session.messages;
    let outcome: 'done' | 'error' | 'stopped' = 'error';
    // Helper kết thúc run (v0.8.27): mọi đường thoát sau khi giành slot
    // đều qua đây — gateway lỗi, gate chặn, vòng lặp xong/lỗi/dừng.
    // Chỉ persist khi outcome đổi lastRunOutcome (done/error); turn
    // dừng (stopped) không ghi gì thêm, đúng như trước đây finally cũ
    // chỉ tắt cờ mà không lưu. Chỉ bump updatedAt khi done (tin nhắn
    // mới đã ghi vào session); lỗi thì không đẩy session lên đầu danh
    // sách. Session đã bị xóa giữa chừng thì bỏ qua ghi (không hồi
    // sinh), nhưng vẫn finish slot + sink.done để nút Gửi hết loading.
    const finishRun = (o: 'done' | 'error' | 'stopped'): void => {
      const alive = this.store.find(targetId);
      if (alive && (o === 'done' || o === 'error')) {
        alive.lastRunOutcome = o;
        if (o === 'done') { alive.updatedAt = Date.now(); }
        this.store.persist();
      }
      this.runManager.finish(targetId);
      sink.done();
    };
    // Trước vòng lặp agent: đảm bảo gateway đang chạy và lấy đúng
    // baseUrl/apiKey hiện tại (gateway chết thì tự khởi động lại; gateway
    // kèm theo dùng key do extension quản lý, không bắt buộc muse.apiKey).
    // Lỗi ở đây đã chứa hướng dẫn cụ thể nên hiển thị nguyên văn.
    let gwConf = conf;
    try {
      sink.post('status', { text: 'Đang kiểm tra gateway…' });
      const gw = await this.gateway.ensureStarted();
      gwConf = { ...conf, baseUrl: gw.baseUrl, apiKey: gw.apiKey };
      // v0.8.29: tool media chat cần gateway đã ensure + callback báo
      // tiến trình tạo video qua sink (execute() không cầm sink).
      ctx.gateway = { baseUrl: gw.baseUrl, apiKey: gw.apiKey };
      ctx.onStatus = (text: string) => sink.post('status', { text });
      sink.post('status', { text: gw.mode === 'bundled' ? 'Gateway kèm theo đã sẵn sàng.' : 'Đã kết nối gateway sẵn có.' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Panel Nhật ký (v0.6.0): lỗi gateway cũng vào buffer để xem
      // ngay trong khung chat, không chỉ trong Output channel.
      try { this.gateway.appendLogLine(`Lỗi gateway: ${msg}`); } catch { /* không chặn bubble lỗi */ }
      sink.post('error', { text: `Lỗi gateway: ${msg}` });
      finishRun('error');
      return;
    }
    // Gate đăng nhập lại: nếu tài khoản của session đích đã hết hạn
    // hoặc logout thì KHÔNG gửi chat, hiện bubble yêu cầu đăng nhập lại
    // với nút Mở Cài đặt. Không tự gửi lại sau khi đăng nhập lại; user
    // tự gửi lại tin nhắn. Cooling/disabled chặn với lý do riêng.
    {
      const gate = await this.checkSessionAccount(gwConf, session);
      if (gate !== 'ok' && gate !== 'unknown') {
        const label = session.accountLabel || session.accountId || 'tài khoản của hội thoại này';
        const text = gate === 'loggedout'
          ? `Hội thoại này dùng tài khoản ${label} đã hết hạn hoặc đã đăng xuất. Tin nhắn này chưa được gửi. Hãy đăng nhập lại trong Cài đặt rồi gửi lại tin nhắn.`
          : gate === 'cooling'
            ? `Tài khoản ${label} của hội thoại này đang cooling. Tin nhắn này chưa được gửi. Bạn có thể chờ hết cooldown hoặc vào Cài đặt để xóa cooldown rồi gửi lại.`
            : `Tài khoản ${label} của hội thoại này đang tắt. Tin nhắn này chưa được gửi. Hãy vào Cài đặt để bật lại tài khoản rồi gửi lại.`;
        sink.post('loginRequired', { text });
        finishRun('error');
        return;
      }
    }
    try {
      // Đính kèm chờ gửi thuộc về bề mặt gốc (nơi user bấm Gửi): chỉ
      // xóa chip ở bề mặt đó, KHÔNG qua sink (sink sẽ xóa nhầm chip
      // ở bề mặt khác đang mở cùng session).
      const attachments = this.pendingAttachments;
      this.pendingAttachments = [];
      if (attachments.length > 0) { this.post('attachmentsCleared', {}); }
      sink.post('message', { role: 'user', text: attachments.length > 0 ? `${userText}\n[Đã đính kèm: ${attachments.map((a) => `${a.name} (${a.kindLabel})`).join(', ')}]` : userText });
      const textBlocks = [userText,
        ...attachments.filter((a) => a.kind === 'text').map((a) => `[Nội dung tệp đính kèm: ${a.name}]\n${a.text}`),
        ...attachments.filter((a) => a.note).map((a) => a.note as string),
        // v0.8.20: file gửi nguyên có part riêng; text vẫn nhắc tên
        // + dung lượng để model biết có file kèm theo message này.
        ...attachments.filter((a) => a.kind === 'file' && a.dataUrl).map((a) => `[Tệp đính kèm: ${a.name} (${a.size} byte)]`)];
      const combinedText = textBlocks.filter((t) => t.length > 0).join('\n\n');
      const imageParts = attachments.filter((a) => a.kind === 'image' && a.dataUrl).map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl as string } }));
      const fileParts = attachments.filter((a) => a.kind === 'file' && a.dataUrl).map((a) => ({ type: 'file', file: { filename: a.name, mime: a.mime || mimeForFile(a.name), data_url: a.dataUrl as string } }));
      const userContent: ChatContent = (imageParts.length > 0 || fileParts.length > 0)
        ? [{ type: 'text', text: combinedText }, ...imageParts, ...fileParts]
        : combinedText;
      // v0.8.20: ngân sách file của lượt này bắt đầu từ số file
      // đính kèm tay (ảnh/văn bản không tính), tool send_file
      // cộng thêm và bị chặn khi đủ 10.
      ctx.turnFileCount = attachments.filter((a) => a.kind === 'file' && a.dataUrl).length;
      const request: ChatMsg[] = [{ role: 'system', content: conf.localTools ? SYSTEM_PROMPT : SYSTEM_PROMPT_CHAT_ONLY }, ...history, { role: 'user', content: userContent }];
      let malformed = 0;
      for (let step = 0; step < conf.maxSteps; step++) {
        if (signal.aborted) { sink.post('status', { text: 'Đã dừng.' }); break; }
        sink.post('status', { text: `Đang suy nghĩ… (bước ${step + 1}/${conf.maxSteps})` });
        // v0.8.27: gateway stream đi qua hàng đợi theo tài khoản của
        // RunManager (tối đa một stream mỗi accountId tại một thời
        // điểm, xem runManager.ts) — lượt chờ vẫn mang trạng thái
        // running, không chết vì PoolAcquireTimeout của gateway.
        const reply = await this.chatOnceQueued(gwConf, request, signal, session, sink, ctx);
        const calls = parseToolCalls(reply);
        request.push({ role: 'assistant', content: reply });
        if (calls.length === 0) {
          // Trả lời dạng chat, không hiện JSON thô: gateway ở chế độ
          // local tools bắt model trả JSON kế hoạch {"status":...,
          // "summary":...} (xem PlannerReply của desktop). Extension
          // trước 0.3.2 hiện nguyên JSON đó trong khung chat. Từ 0.3.2,
          // hiển thị summary/reply dạng chat, còn JSON gốc chỉ nằm trong
          // mục "Chi tiết" mà user bấm mới mở ra.
          const planner = plannerReply(reply);
          const finalText = planner.display || '(Muse không trả lời gì.)';
          if (ctx.lastStreamed) { sink.post('streamFinal', { text: finalText, details: planner.raw || '' }); }
          else if (planner.raw) { sink.post('message', { role: 'assistant', text: finalText, details: planner.raw }); }
          else { sink.post('message', { role: 'assistant', text: finalText }); }
          sink.post('status', { text: 'Xong.' });
          // Đặt tên session tự động từ tin đầu tiên nếu session vẫn đang
          // mang tên mặc định, để danh sách session đọc được ngay.
          if (history.length === 0) {
            if (session.title === 'Hội thoại mới' || session.title === 'Hội thoại 1') {
              session.title = userText.trim().slice(0, 40) || session.title;
            }
          }
          // Ghi thẳng vào messages của session đích (tham chiếu sống
          // trong store): bề mặt đang mở session này có this.history
          // trỏ cùng mảng nên thấy ngay, không cần đồng bộ ngược.
          history.push({ role: 'user', content: userText }, { role: 'assistant', content: finalText });
          if (history.length > 40) { history.splice(0, history.length - 40); }
          // v0.8.2, việc 3: sau lần chat đầu tiên thành công, session
          // chưa có accountId thì thử backfill bằng by-hint (mapping
          // gateway vừa được BeginChat lưu) để dòng tài khoản hiện
          // đúng tài khoản thật đã dùng. Lỗi thì giữ nguyên, không vỡ.
          try {
            if (!session.accountId) { await this.backfillOneSessionByHint(session); }
          } catch { /* giữ nguyên "Chưa xác định" */ }
          outcome = 'done';
          return;
        }
        const bad = calls.find((c) => c.name === '__parse_error__');
        if (bad) {
          malformed++;
          const err = str(bad.args.error, 'Định dạng tool sai.');
          sink.post('status', { text: 'Muse gửi tool sai định dạng, đang yêu cầu gửi lại…' });
          if (malformed >= 3) { sink.post('error', { text: `Dừng sau 3 phản hồi sai định dạng: ${err} Không thực thi thao tác nào từ các phản hồi lỗi.` }); return; }
          request.push({ role: 'user', content: `APP_PROTOCOL_REPAIR: ${err} Chỉ gửi lại MỘT thao tác nhỏ trong một code fence \`\`\`json. Không lặp lại lô đã bị từ chối.` });
          continue;
        }
        // v0.8.2, việc 4: tool cục bộ đang tắt mà agent vẫn trả JSON
        // tool thì TỪ CHỐI thực thi toàn bộ lô, báo rõ cho user, không
        // thực thi rồi mới báo. (Phòng thủ thêm ở đầu execute().)
        if (!conf.localTools) {
          sink.post('error', { text: 'Tool cục bộ đang tắt (muse.localTools = false) nên Muse không chạy tool nào trong workspace. Hãy bật lại bằng lệnh "Muse: Bật/Tắt tool cục bộ" nếu muốn agent đọc/sửa/chạy file, rồi gửi lại yêu cầu.' });
          return;
        }
        for (const call of calls) {
          if (signal.aborted) { break; }
          sink.post('tool', { name: call.name, detail: describe(call) });
          ctx.lastComputerImage = undefined;
          ctx.lastToolImages = [];
          ctx.lastToolFiles = [];
          const result = await this.execute(call, root, conf, signal, ctx);
          // v0.8.18, tổng quát hóa: tool nào trả về ảnh thì message
          // TOOL_RESULT của chính call đó kèm đúng các image_url tương
          // ứng (read_image: 1 ảnh, read_video_frames: tối đa 4 khung);
          // tool computer_* giữ đường lastComputerImage cũ; các tool
          // khác không có ảnh nên message vẫn text thuần như trước.
          // v0.8.20: tương tự cho file (send_file: 1 file/call) qua
          // file part, không phải image_url hay text.
          const resultImages = ctx.lastToolImages.length > 0
            ? ctx.lastToolImages
            : (call.name.startsWith('computer_') && ctx.lastComputerImage ? [ctx.lastComputerImage] : []);
          request.push({ role: 'user', content: toolResultContent(call.name, result, resultImages, ctx.lastToolFiles) });
          sink.post('toolResult', { name: call.name, detail: truncate(result, 500) });
        }
      }
      // Hết vòng lặp mà chưa return: phân biệt dừng tay với hết bước.
      // (Sửa quirk cũ: trước đây break do abort cũng rơi xuống đây và
      // hiện nhầm lỗi hết bước; từ 0.8.27, abort chỉ báo 'Đã dừng.')
      if (signal.aborted) {
        outcome = 'stopped';
      } else {
        sink.post('error', { text: `Đã hết ${conf.maxSteps} bước tối đa mà yêu cầu chưa hoàn tất. Các bước đã thành công vẫn được giữ lại; hãy gửi tiếp yêu cầu nhỏ hơn.` });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Panel Nhật ký (v0.6.0): lỗi chat vào buffer để panel có lỗi ngay
      // cả khi gateway stdout im lặng. Người dùng bấm Dừng thì không
      // phải lỗi nên không ghi. Thông điệp đã chứa mã lỗi (HTTP 502/
      // 503/429...) nếu gateway trả về; không ghi nội dung request,
      // cookie hay key vào log.
      if (!signal.aborted) {
        try { this.gateway.appendLogLine(`Lỗi chat: ${msg}`); } catch { /* không chặn bubble lỗi */ }
      }
      if (signal.aborted) {
        sink.post('status', { text: 'Đã dừng.' });
        outcome = 'stopped';
      } else if (msg.includes('no_account_available')) {
        // Lỗi 503 này nghĩa là pool gateway chưa có tài khoản khả dụng,
        // không phải lỗi key/cổng. Webview hiện nút hành động được thay vì
        // chỉ mã lỗi; việc nhập đăng nhập vẫn phải làm trên máy người dùng.
        sink.post('accountError', { text: 'Gateway đã chạy nhưng chưa có tài khoản Muse nào khả dụng (lỗi no_account_available). Bạn chưa nhập đăng nhập vào gateway kèm theo, hoặc tài khoản đang cooling/invalid. Bấm một nút dưới đây, rồi gửi lại câu hỏi.' });
      } else if (msg.includes('upstream_response_unavailable') || msg.includes('stopped responding without a completed reply')) {
        // Lỗi 502 này khác 503/429: Muse web đã bắt đầu trả lời rồi dừng,
        // nhưng gateway không xác định được một phản hồi hoàn tất gắn với
        // yêu cầu này nên dừng chờ. Hội thoại được giữ nguyên, gateway
        // KHÔNG tự gửi lại. Đừng tạo session mới hay xóa lịch sử vì sẽ
        // mất ngữ cảnh; gửi tiếp một tin ngắn trong cùng session này.
        sink.post('error', { text: 'Muse web đã bắt đầu trả lời rồi dừng mà gateway không xác định được phản hồi hoàn tất (lỗi 502 upstream_response_unavailable). Đây không phải hết lượt hay hết tài khoản. Hội thoại hiện tại vẫn được giữ nguyên và gateway không tự gửi lại, nên bạn đừng tạo hội thoại mới hay xóa lịch sử. Hãy gửi tiếp một tin ngắn trong cùng hội thoại này, ví dụ: "Bạn vừa dừng mà chưa trả lời xong, hãy trả lời lại ngắn gọn." Nếu lỗi lặp lại nhiều lần, kiểm tra Output > Muse Gateway (dòng local_reply_poll) và thử lại sau ít phút.' });
      } else {
        sink.post('error', { text: `Lỗi: ${msg}` });
      }
    } finally {
      // Run kết thúc ở bất kỳ đường nào trong try này (return thành
      // công, lỗi, dừng) đều qua finishRun: ghi outcome, finish slot
      // (fan-out postSessions hiện tích/lỗi), sink.done.
      finishRun(outcome);
    }
  }

  // Chat có streaming: gateway hỗ trợ stream:true theo SSE (xem Chat
  // trong Endpoints.cs: mỗi dòng "data: {chunk}" với
  // choices[0].delta.content, kết thúc bằng "data: [DONE]"). Extension
  // tích lũy toàn bộ văn bản để parse tool như cũ, đồng thời đẩy từng
  // delta ra webview để hiện dần. Nếu gateway trả về không phải SSE
  // (ví dụ lỗi JSON), rơi về đường parse JSON không-stream.
  // v0.8.27: session/sink/ctx của lượt chạy truyền vào (không còn
  // currentSession()/conversationId/lastStreamed của bề mặt — bề mặt
  // có thể đã chuyển đi nơi khác trong lúc lượt này chạy).
  private async chatOnce(conf: ReturnType<typeof cfg>, messages: ChatMsg[], signal: AbortSignal, session: ChatSession, sink: RunSink, ctx: RunCtx): Promise<string> {
    const url = `${conf.baseUrl.replace(/\/v1$/, '')}/v1/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (conf.apiKey) { headers.Authorization = `Bearer ${conf.apiKey}`; }
    ctx.lastStreamed = false;
    // v0.8.2, việc 3: gửi account_id của session đã chọn để gateway
    // mới ép đúng tài khoản đó (gateway cũ bỏ qua trường lạ này).
    // Việc 4: gửi _muse_local_tools đúng theo setting, KHÔNG cứng true
    // nữa — false nghĩa là gateway cũng không bắt model trả tool.
    const resp = await fetch(url, {
      method: 'POST', headers, signal,
      body: JSON.stringify({ model: conf.model, messages, temperature: 0.2, stream: true, _muse_local_tools: conf.localTools, account_id: session.accountId || undefined, user: session.conversationId }),
    });
    const contentType = resp.headers.get('content-type') || '';
    if (!resp.ok) {
      const text = await resp.text();
      throw new Error(`Gateway trả HTTP ${resp.status}: ${truncate(text, 500)}`);
    }
    if (!contentType.includes('text/event-stream') || !resp.body) {
      const text = await resp.text();
      const data = JSON.parse(text) as { choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown } }> };
      const msg = data.choices?.[0]?.message;
      if (!msg) { throw new Error('Gateway trả về không có choices[0].message.'); }
      const native = msg.tool_calls;
      if (Array.isArray(native) && native.length > 0) {
        const calls = native.map((t) => {
          const o = t as Record<string, unknown>;
          const fn = (o.function || {}) as Record<string, unknown>;
          let args: Record<string, unknown> = {};
          try { args = typeof fn.arguments === 'string' ? (JSON.parse(fn.arguments) as Record<string, unknown>) : (fn.arguments as Record<string, unknown>) || {}; } catch { args = {}; }
          return { name: normalizeName(str(fn.name)), args };
        });
        return '```json\n' + JSON.stringify({ tool_calls: calls }) + '\n```';
      }
      return typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content ?? '');
    }
    sink.post('streamStart', {});
    let full = '';
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { break; }
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          for (const line of block.split('\n')) {
            const trimmed = line.trim();
            if (trimmed.startsWith(':')) { continue; }
            if (!trimmed.startsWith('data:')) { continue; }
            const payload = trimmed.slice(5).trim();
            if (payload === '[DONE]') { return full; }
            try {
              const chunk = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
              const delta = chunk.choices?.[0]?.delta?.content;
              if (delta) {
                full += delta;
                ctx.lastStreamed = true;
                sink.post('streamDelta', { text: delta });
              }
            } catch { /* bỏ qua chunk SSE lỗi, giữ phần đã nhận */ }
          }
        }
      }
      return full;
    } finally {
      reader.releaseLock();
    }
  }

  // Vỏ hàng đợi của chatOnce (v0.8.27): mỗi lần gọi gateway đi qua
  // RunManager.runExclusive theo accountId của session đích — tối đa
  // một gateway stream mỗi tài khoản tại một thời điểm. Lượt chờ bị
  // abort thì không gọi gateway (runExclusive tự reject), lỗi lượt
  // trước không chặn lượt sau. Mức gọi từng lần (không giữ slot tài
  // khoản suốt lượt) nên các session cùng tài khoản xen kẽ từng bước
  // một cách công bằng, không deadlock.
  private async chatOnceQueued(conf: ReturnType<typeof cfg>, messages: ChatMsg[], signal: AbortSignal, session: ChatSession, sink: RunSink, ctx: RunCtx): Promise<string> {
    return this.runManager.runExclusive(session.accountId || '', signal, () => this.chatOnce(conf, messages, signal, session, sink, ctx));
  }

  // ---------------- Thực thi tool trong workspace ----------------
  // v0.8.27: kết quả media/file của tool ghi vào ctx của lượt này
  // (không còn trường provider) để run khác không đọc nhầm.
  private async execute(call: ToolCall, root: string, conf: ReturnType<typeof cfg>, signal: AbortSignal, ctx: RunCtx): Promise<string> {
    // v0.8.2, việc 4: phòng thủ tầng execute — tool tắt thì không
    // tool nào chạy, kể cả tool máy tính, dù đường gọi nào tới đây.
    if (!conf.localTools) { return 'Tool cục bộ đang tắt (muse.localTools = false) nên không thực thi tool này.'; }
    try {
      if (signal.aborted) { return 'Đã dừng trước khi thực thi.'; }
      if (COMPUTER_TOOLS.includes(call.name)) { return this.executeComputer(call, conf, ctx); }
      switch (call.name) {
        case 'list_files': {
          // v0.8.2, việc 4: TÔN TRỌNG limit/offset agent gửi (mặc định
          // limit 50 khi không gửi, tối đa 500), và cắt chuỗi JSON tối
          // đa 8000 ký tự kèm ghi chú để dù agent có quét quá tay thì
          // lượng tên file gửi lên model cũng bị chặn ở mức nhỏ —
          // không còn ~43.000 ký tự một lần như bản cũ (cũ cắt ở 500
          // entry mà không tôn trọng limit/offset).
          const rel = str(call.args.path, '.');
          const dir = this.resolve(root, rel);
          const recursive = call.args.recursive === true;
          const limit = Math.max(1, Math.min(500, num(call.args.limit, 50)));
          const offset = Math.max(0, num(call.args.offset, 0));
          const out: Array<{ path: string; type: string }> = [];
          let seen = 0;
          let hasMore = false;
          const walk = (d: string, base: string): void => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
              if (hasMore) { return; }
              if (e.isDirectory() && SKIP_DIRS.has(e.name)) { continue; }
              const full = path.join(d, e.name);
              const r = path.relative(root, full).split(path.sep).join('/');
              if (seen >= offset && out.length < limit) { out.push({ path: r, type: e.isDirectory() ? 'dir' : 'file' }); }
              seen++;
              if (seen > offset + limit) { hasMore = true; return; }
              if (e.isDirectory() && recursive) { walk(full, r); }
            }
          };
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { return `Lỗi: thư mục không tồn tại: ${rel}`; }
          walk(dir, rel);
          let result = JSON.stringify(out);
          if (hasMore) { result += `\n... (còn tiếp, dùng limit/offset để xem tiếp: đã thấy hơn ${seen} entry)`; }
          if (result.length > 8000) { result = result.slice(0, 8000) + '\n... (đã cắt, dùng limit/offset để xem tiếp)'; }
          return result;
        }
        case 'read_file': {
          const p = this.resolve(root, str(call.args.path));
          const content = readTextFile(p);
          const lines = content.split('\n');
          const start = Math.max(1, num(call.args.start_line, 1));
          const max = Math.max(1, num(call.args.max_lines, 1000));
          const slice = lines.slice(start - 1, start - 1 + max);
          let out = slice.join('\n');
          if (start - 1 + max < lines.length) { out += `\n... (còn tiếp, dùng start_line=${start + max})`; }
          return out;
        }
        case 'read_files': {
          const paths = call.args.paths;
          if (!Array.isArray(paths) || paths.length < 1 || paths.length > 8) { return 'Lỗi: read_files cần paths là mảng 1-8 đường dẫn.'; }
          const parts: string[] = [];
          for (const item of paths) { parts.push(`--- ${String(item)} ---\n${readTextFile(this.resolve(root, String(item)))}`); }
          return parts.join('\n');
        }
        case 'search_files': {
          const query = str(call.args.query);
          if (!query) { return 'Lỗi: search_files cần query.'; }
          const caseSensitive = call.args.case_sensitive === true;
          const base = this.resolve(root, str(call.args.path, '.'));
          const needle = caseSensitive ? query : query.toLowerCase();
          const matches: string[] = [];
          const walk = (d: string): void => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
              if (matches.length >= 100) { return; }
              const full = path.join(d, e.name);
              if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) { walk(full); } continue; }
              try {
                const buf = fs.readFileSync(full);
                if (buf.length > 2 * 1024 * 1024 || buf.includes(0)) { continue; }
                const text = buf.toString('utf8');
                text.split('\n').forEach((line, i) => {
                  const hay = caseSensitive ? line : line.toLowerCase();
                  if (hay.includes(needle) && matches.length < 100) {
                    matches.push(`${path.relative(root, full).split(path.sep).join('/')}:${i + 1}: ${line.trim().slice(0, 200)}`);
                  }
                });
              } catch { /* bỏ qua tệp không đọc được */ }
            }
          };
          if (!fs.existsSync(base)) { return `Lỗi: không tìm thấy: ${str(call.args.path, '.')}`; }
          if (fs.statSync(base).isFile()) { walk(path.dirname(base)); } else { walk(base); }
          return matches.length > 0 ? matches.join('\n') : 'Không tìm thấy kết quả.';
        }
        case 'read_image': {
          // v0.8.18: đọc 1 ảnh trong workspace, ảnh đi kèm message
          // TOOL_RESULT qua lastToolImages (vòng lặp run() dựng parts).
          // Sai định dạng, rỗng, quá 20 MiB hoặc ngoài workspace đều
          // thành lỗi text qua catch cuối execute, tuyệt đối không bịa ảnh.
          const rel = str(call.args.path);
          if (!rel) { return 'Lỗi: read_image cần path.'; }
          const extError = validateImageExt(path.extname(rel));
          if (extError) { return `Lỗi: ${extError}, không nhận '${path.extname(rel) || '(không có đuôi)'}': ${rel}`; }
          const target = this.resolve(root, rel);
          const dataUrl = dataUrlOfImageFile(target);
          ctx.lastToolImages = [dataUrl];
          return `Đã gửi ảnh ${rel} kèm theo message này (định dạng ${path.extname(rel).toLowerCase()}, ${fs.statSync(target).size} byte). Hãy xem ảnh đính kèm để kiểm tra, không suy đoán nội dung ảnh từ tên file.`;
        }
        case 'read_video_frames': {
          // v0.8.18: trích khung hình video trong workspace bằng ffmpeg.
          // Không có ffmpeg hoặc trích hỏng hết thì chỉ trả ghi chú text
          // thành thật, tuyệt đối không bịa khung hình. Text kết quả ghi
          // rõ đây chỉ là khung hình mẫu, không phải toàn bộ video.
          const rel = str(call.args.path);
          if (!rel) { return 'Lỗi: read_video_frames cần path.'; }
          const parsed = parseVideoTimes(call.args.times);
          if ('error' in parsed) { return `Lỗi: ${parsed.error}`; }
          const target = this.resolve(root, rel);
          const frames: string[] = [];
          const done: number[] = [];
          for (const t of parsed.times) {
            const frame = await this.extractVideoFrameAt(target, t);
            if (frame) { frames.push(frame); done.push(t); }
          }
          if (frames.length === 0) {
            return `Không trích được khung hình nào từ video ${rel} (máy này có thể không có ffmpeg, hoặc video lỗi). Video gốc KHÔNG được gửi lên; hãy mô tả nội dung video hoặc đính kèm ảnh chụp khung hình thay thế.`;
          }
          ctx.lastToolImages = frames;
          return `Đã gửi ${frames.length} khung hình mẫu trích từ video ${rel} tại các mốc giây ${done.join(', ')} kèm theo message này. Đây CHỈ là các khung hình mẫu, KHÔNG phải toàn bộ video — đừng kết luận về những đoạn không có trong khung hình.`;
        }
        case 'send_file': {
          // v0.8.20: gửi nguyên file trong workspace lên web qua
          // file part (vòng lặp run() dựng parts từ lastToolFiles).
          // Ngoài workspace thì resolve() ném lỗi qua catch cuối
          // execute thành lỗi text; rỗng/quá 25 MB/đủ 10 file thì
          // lỗi text rõ, tuyệt đối không cắt file hay giả vờ đã gửi.
          // v0.8.23: đường dẫn chính xác không resolve ra file thì
          // tự tìm trong cây workspace (findSendFileCandidates):
          // duy nhất thì gửi file đó và ghi rõ path thật tìm thấy;
          // 0 thì lỗi như cũ (ghi thêm là đã tìm theo tên); nhiều
          // thì lỗi liệt kê tối đa 20 ứng viên, TUYỆT ĐỐI không tự
          // đoán chọn một file; hơn 20 thì báo quá nhiều kết quả.
          const rel = str(call.args.path);
          if (!rel) { return 'Lỗi: send_file cần path.'; }
          let target = this.resolve(root, rel);
          let displayRel = rel;
          if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
            const candidates = findSendFileCandidates(root, rel);
            if (candidates.length === 0) { return `Lỗi: tệp không tồn tại: ${rel} (đã tìm theo tên trong workspace, không thấy file nào khớp).`; }
            if (candidates.length > 20) { return `Lỗi: có quá nhiều file khớp với "${rel}" (hơn 20), hãy chỉ định đường dẫn đầy đủ hơn.`; }
            if (candidates.length > 1) { return `Lỗi: có nhiều file khớp với "${rel}", hãy chỉ định rõ đường dẫn đầy đủ:\n${candidates.map((c) => `- ${c}`).join('\n')}`; }
            displayRel = candidates[0];
            target = path.join(root, ...displayRel.split('/'));
          }
          const st = fs.statSync(target);
          if (!st.isFile()) { return `Lỗi: send_file chỉ gửi được tệp, không phải thư mục: ${displayRel}`; }
          const limitError = checkFileAttachmentLimit(st.size, ctx.turnFileCount);
          if (limitError) { return `Lỗi: ${limitError}`; }
          const buf = fs.readFileSync(target);
          const mime = mimeForFile(displayRel);
          const filename = path.basename(target);
          ctx.lastToolFiles = [{ filename, mime, dataUrl: `data:${mime};base64,${buf.toString('base64')}` }];
          ctx.turnFileCount++;
          const videoNote = VIDEO_EXTS.includes(path.extname(displayRel).toLowerCase())
            ? ' Lưu ý: web đã nhận file không đồng nghĩa bạn xem được nội dung video — nếu bạn không truy cập được video thì hãy nói rõ và đề nghị dùng khung hình mẫu thay thế.'
            : '';
          const foundNote = displayRel !== rel ? ` (tìm thấy theo "${rel}" tại đường dẫn tương đối thật: ${displayRel})` : '';
          return `Đã gửi nguyên file ${displayRel} kèm theo message này (tên ${filename}, ${st.size} byte, ${mime})${foundNote}. Hãy dùng nội dung file đính kèm để kiểm tra, không suy đoán nội dung file từ tên file.${videoNote}`;
        }
        case 'write_file': {
          const rel = str(call.args.path);
          const content = str(call.args.content);
          if (!rel) { return 'Lỗi: write_file cần path và content.'; }
          const target = this.resolve(root, rel);
          if (!await this.approve(call, root, conf, `Ghi tệp ${rel} (${content.length} ký tự)`, content, target)) {
            return 'Người dùng đã từ chối thao tác ghi tệp. Không thử lại thao tác này.';
          }
          fs.mkdirSync(path.dirname(target), { recursive: true });
          fs.writeFileSync(target, content, 'utf8');
          return `Đã ghi ${rel} (${content.length} ký tự).`;
        }
        case 'edit_file': {
          const rel = str(call.args.path);
          const target = this.resolve(root, rel);
          if (!fs.existsSync(target)) { return `Lỗi: tệp không tồn tại, hãy đọc trước khi sửa: ${rel}`; }
          const current = fs.readFileSync(target, 'utf8');
          const edits: Array<{ old_text: string; new_text: string }> = Array.isArray(call.args.edits)
            ? (call.args.edits as Array<Record<string, unknown>>).map((e) => ({ old_text: str(e.old_text), new_text: str(e.new_text) }))
            : [{ old_text: str(call.args.old_text), new_text: str(call.args.new_text) }];
          let next = current;
          for (const e of edits) {
            if (!e.old_text) { return 'Lỗi: edit_file cần old_text khác rỗng.'; }
            const count = next.split(e.old_text).length - 1;
            if (count !== 1) { return `Lỗi: old_text khớp ${count} lần trong ${rel} (yêu cầu đúng 1 lần). Hãy đọc lại tệp rồi gửi old_text chính xác.`; }
            next = next.replace(e.old_text, e.new_text);
          }
          if (!await this.approve(call, root, conf, `Sửa tệp ${rel} (${edits.length} đoạn)`, next, target)) {
            return 'Người dùng đã từ chối thao tác sửa tệp. Không thử lại thao tác này.';
          }
          fs.writeFileSync(target, next, 'utf8');
          return `Đã sửa ${rel}.`;
        }
        case 'run_command': {
          const command = str(call.args.command);
          if (!command) { return 'Lỗi: run_command cần command.'; }
          const workdir = this.resolve(root, str(call.args.workdir, '.'));
          const shell = str(call.args.shell, 'auto');
          if (call.args.background === true) {
            if (!await this.approve(call, root, conf, `Chạy nền trong ${path.relative(root, workdir) || '.'}: ${command}\nLệnh nền chạy với quyền của bạn và không bị sandbox; dùng process_status/process_input/process_stop với process_id để theo dõi.`)) {
              return 'Người dùng đã từ chối chạy lệnh nền. Không thử lại lệnh này.';
            }
            return this.processes.start(command, workdir, shell, num(call.args.timeout_seconds, 300));
          }
          if (!await this.approve(call, root, conf, `Chạy lệnh trong ${path.relative(root, workdir) || '.'}: ${command}\nLệnh chạy với quyền của bạn và không bị sandbox trong workspace.`)) {
            return 'Người dùng đã từ chối chạy lệnh. Không thử lại lệnh này.';
          }
          return await runShell(command, workdir, shell, num(call.args.timeout_seconds, conf.commandTimeout));
        }
        case 'process_status': {
          const id = str(call.args.process_id);
          if (!id) {
            const list = this.processes.list();
            return list.length === 0 ? 'Không có tiến trình nền nào trong phiên này.' : list.map((p) => `${p.id}: ${p.command.slice(0, 120)} — ${p.running ? 'đang chạy' : `đã thoát (exit_code=${p.exitCode})`}${p.timedOut ? ' (timeout)' : ''}`).join('\n');
          }
          return this.processes.status(id, num(call.args.wait_ms, 30000));
        }
        case 'process_input': {
          const id = str(call.args.process_id);
          if (!id) { return 'Lỗi: process_input cần process_id.'; }
          return this.processes.input(id, str(call.args.text), call.args.newline !== false);
        }
        case 'process_stop': {
          const id = str(call.args.process_id);
          if (!id) { return 'Lỗi: process_stop cần process_id.'; }
          if (!await this.approve(call, root, conf, `Dừng tiến trình nền ${id}.`)) {
            return 'Người dùng đã từ chối dừng tiến trình. Không thử lại thao tác này.';
          }
          return this.processes.stop(id);
        }
        case 'git_status': return await runShell('git status --short', root, 'auto', 30);
        case 'git_diff': return await runShell('git diff --stat && git diff', root, 'auto', 30);
        case 'generate_image': case 'edit_image': case 'generate_video': case 'save_media': {
          // v0.8.29: tool media chat — tạo/sửa/tải media rồi lưu THẲNG
          // vào đường dẫn đích user chỉ định trong tin nhắn, KHÔNG mở
          // hộp thoại chọn thư mục (khác 3 lệnh palette vẫn dùng hộp
          // thoại). Đường dẫn đi qua decideMediaWrite: thỏa quy tắc
          // (trong workspace, hoặc tuyệt đối ngoài workspace nhưng khớp
          // đúng tin nhắn user) và không nhạy cảm thì BỎ QUA modal
          // duyệt ghi — tin nhắn user đã là sự cho phép cho đúng đường
          // dẫn đó; nhạy cảm thì vẫn hỏi modal như luật đứng; không
          // thỏa thì TỪ CHỐI thẳng, không ghi, không hỏi modal.
          const gw = ctx.gateway;
          if (!gw) { return 'Lỗi: gateway chưa sẵn sàng, hãy gửi lại yêu cầu.'; }
          const rawPath = str(call.args.path);
          const tool = call.name;
          if (!rawPath) {
            return `Lỗi: ${tool} cần tham số path là đường dẫn lưu file cuối cùng. Bạn chưa có đường dẫn này — hãy hỏi lại người dùng đường dẫn đích rồi gọi lại tool, không tự chọn đường dẫn mặc định, không mở hộp thoại lưu.`;
          }
          const sensitive = (abs: string): boolean => isSensitivePath(path.relative(root, abs));
          // Cần abs trước để kiểm tra nhạy cảm: resolve thử (không ghi
          // gì ở bước này), chỉ dùng abs để tính sensitive.
          const probe = resolveMediaDest(root, rawPath, ctx.turnUserText);
          if (!probe.ok) {
            if (probe.reason === 'escape') { return `Lỗi: đường dẫn ${rawPath} thoát khỏi workspace nên bị từ chối. Hãy dùng đường dẫn trong workspace, hoặc yêu cầu người dùng nêu đúng đường dẫn tuyệt đối trong tin nhắn rồi gọi lại tool.`; }
            return `Lỗi: đường dẫn tuyệt đối ngoài workspace ${rawPath} không xuất hiện trong tin nhắn của người dùng nên extension từ chối ghi ra ngoài workspace (không ghi theo đường dẫn model tự đưa ra). Hãy yêu cầu người dùng nêu đúng đường dẫn đó trong tin nhắn rồi gọi lại tool.`;
          }
          const decision = decideMediaWrite(root, rawPath, ctx.turnUserText, sensitive(probe.abs));
          if (decision.decision === 'refuse') {
            return `Lỗi: không ghi được vào ${rawPath} (quy tắc đường dẫn không thỏa).`;
          }
          if (decision.decision === 'ask') {
            const ok = await this.approve(call, root, conf, `Lưu media vào ${decision.abs}`, undefined, decision.abs);
            if (!ok) { return 'Người dùng đã từ chối lưu media. Không thử lại thao tác này.'; }
          }
          const abs = decision.abs;
          const fmtSaved = (saved: Array<{ path: string; size: number; overwritten: boolean }>): string =>
            saved.map((s) => `- ${s.path} (${s.size} byte)${s.overwritten ? ' [đã ghi đè file cũ]' : ''}`).join('\n');
          if (tool === 'save_media') {
            const url = str(call.args.url);
            if (!url) { return 'Lỗi: save_media cần url và path.'; }
            const saved = await downloadMediaToFile(url, abs);
            return `Đã tải và lưu media vào:\n${fmtSaved([saved])}`;
          }
          if (tool === 'generate_video') {
            const prompt = str(call.args.prompt);
            if (!prompt) { return 'Lỗi: generate_video cần prompt và path.'; }
            const duration = call.args.duration === undefined ? undefined : num(call.args.duration, 0);
            if (duration !== undefined && (!Number.isInteger(duration) || duration < 1 || duration > 60)) {
              return 'Lỗi: generate_video cần duration là số nguyên từ 1 đến 60 giây.';
            }
            let firstFrame: string | undefined;
            if (str(call.args.first_frame)) {
              firstFrame = dataUrlOfImageFile(this.resolve(root, str(call.args.first_frame)));
            }
            let video;
            try {
              video = await createVideo(gw.baseUrl, gw.apiKey, { prompt, duration, firstFrameDataUrl: firstFrame, signal }, (status, pct) => {
                ctx.onStatus?.(`Đang tạo video… trạng thái: ${status}${pct ? `, tiến trình ${pct}%` : ''}`);
              });
            } catch (e) {
              if (signal.aborted) { return 'Đã dừng tạo video theo yêu cầu.'; }
              throw e;
            }
            if (signal.aborted) { return 'Đã dừng tạo video theo yêu cầu.'; }
            const dest = mediaDestWithDefaultExt(abs, '.mp4');
            const saved = await downloadMediaToFile(video.url, dest);
            return `Đã tạo và lưu video vào:\n${fmtSaved([saved])}`;
          }
          // generate_image / edit_image: ảnh, đuôi mặc định .png.
          const prompt = str(call.args.prompt);
          if (!prompt) { return `Lỗi: ${tool} cần prompt và path.`; }
          const base = mediaDestWithDefaultExt(abs, '.png');
          if (tool === 'generate_image') {
            const n = call.args.n === undefined ? 1 : num(call.args.n, 1);
            if (!Number.isInteger(n) || n < 1 || n > 4) { return 'Lỗi: generate_image cần n là số nguyên từ 1 đến 4 (mặc định 1).'; }
            const size = str(call.args.size) || undefined;
            const images = await generateImages(gw.baseUrl, gw.apiKey, { prompt, n, size });
            const dests = n === 1 ? [base] : Array.from({ length: n }, (_, i) => numberedMediaDest(base, i + 1));
            const saved: Array<{ path: string; size: number; overwritten: boolean }> = [];
            for (let i = 0; i < Math.min(images.length, dests.length); i++) {
              const img = images[i];
              if (img.url) { saved.push(await downloadMediaToFile(img.url, dests[i])); }
              else if (img.b64) { saved.push(writeMediaBuffer(Buffer.from(img.b64, 'base64'), dests[i])); }
            }
            if (saved.length === 0) { return 'Lỗi: gateway không trả về ảnh nào để lưu.'; }
            const short = saved.length < n ? ` (gateway chỉ trả về ${saved.length}/${n} ảnh)` : '';
            return `Đã tạo và lưu ${saved.length} ảnh vào:${short}\n${fmtSaved(saved)}`;
          }
          // edit_image: images là 1–4 ảnh gốc TRONG workspace (resolve
          // thường — ngoài workspace thì lỗi như tool khác, không áp
          // quy tắc khớp tin nhắn vì đây là đầu vào, không phải đích ghi).
          const sources = call.args.images;
          if (!Array.isArray(sources) || sources.length < 1 || sources.length > 4) {
            return 'Lỗi: edit_image cần images là mảng 1–4 đường dẫn ảnh gốc trong workspace.';
          }
          const resolvedSources = sources.map((s) => this.resolve(root, String(s)));
          const images = await editImage(gw.baseUrl, gw.apiKey, { prompt, imagePaths: resolvedSources, n: 1 });
          if (images.length === 0 || (!images[0].url && !images[0].b64)) { return 'Lỗi: gateway không trả về ảnh nào để lưu.'; }
          const first = images[0];
          const saved = first.url
            ? await downloadMediaToFile(first.url, base)
            : writeMediaBuffer(Buffer.from(first.b64 as string, 'base64'), base);
          return `Đã sửa và lưu ảnh vào:\n${fmtSaved([saved])}`;
        }
        default:
          return `Lỗi: công cụ không hỗ trợ trong extension VS Code: ${call.name}`;
      }
    } catch (e) {
      return `Lỗi khi thực thi ${call.name}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ---------------- Điều khiển màn hình Windows thử nghiệm ----------------
  private async executeComputer(call: ToolCall, conf: ReturnType<typeof cfg>, ctx: RunCtx): Promise<string> {
    const reason = this.computer.unavailableReason(conf.computerHelperPath, conf.allowComputerControl);
    if (reason) { return reason; }
    if (call.name === 'computer_list_windows') {
      try {
        const res = await this.computer.call(conf.computerHelperPath, 'computer_list_windows', {});
        return res.text;
      } catch (e) {
        return `Lỗi: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    // Chưa chọn cửa sổ đích thì hỏi chọn ngay, thay vì để helper lỗi rồi
    // model tự đoán cửa sổ. Chọn xong thì chạy tiếp tool đã yêu cầu.
    if (!this.computer.selectedTitle) {
      const picked = await this.selectComputerWindow();
      if (!this.computer.selectedTitle) { return `Chưa chọn được cửa sổ đích nên không chạy ${call.name}: ${picked}`; }
    }
    if (this.computer.isDangerous(call.name)) {
      const ok = await approveComputerAction(call.name, call.args, this.computer.selectedTitle);
      if (!ok) { return 'Người dùng đã từ chối hành động điều khiển màn hình. Không thử lại hành động này.'; }
    }
    try {
      const res = await this.computer.call(conf.computerHelperPath, call.name, call.args);
      if (res.imageDataUrl) { ctx.lastComputerImage = res.imageDataUrl; }
      return res.text;
    } catch (e) {
      return `Lỗi: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private resolve(root: string, rel: string): string {
    const clean = rel.replace(/\\/g, '/');
    const full = path.resolve(root, clean);
    if (full !== root && !full.startsWith(root + path.sep)) { throw new Error(`Đường dẫn ngoài workspace bị từ chối: ${rel}`); }
    return full;
  }

  private async approve(call: ToolCall, root: string, conf: ReturnType<typeof cfg>, detail: string, proposed?: string, target?: string): Promise<boolean> {
    // Đường dẫn nhạy cảm luôn hỏi duyệt riêng, kể cả khi autoApprove bật.
    const sensitive = target !== undefined && isSensitivePath(path.relative(root, target));
    if (conf.autoApprove && !sensitive) { return true; }
    if (READ_ONLY_TOOLS.has(call.name)) { return true; }
    let viewed = false;
    for (;;) {
      const choices: string[] = ['Cho phép', 'Từ chối'];
      const canPreview = proposed !== undefined && target !== undefined && (call.name === 'write_file' || call.name === 'edit_file') && !viewed;
      if (canPreview) { choices.splice(1, 0, 'Xem diff'); }
      const pick = await vscode.window.showWarningMessage(
        sensitive ? `Muse muốn thay đổi ĐƯỜNG DẪN NHẠY CẢM (luôn hỏi riêng, kể cả khi autoApprove bật): ${detail}` : `Muse muốn: ${detail}`,
        { modal: true }, ...choices);
      if (pick === 'Cho phép') { return true; }
      if (pick === 'Xem diff' && proposed !== undefined && target !== undefined) {
        viewed = true;
        const tmp = path.join(os.tmpdir(), `muse-preview-${Date.now()}.txt`);
        fs.writeFileSync(tmp, proposed, 'utf8');
        const left = fs.existsSync(target) ? vscode.Uri.file(target) : vscode.Uri.file(path.join(os.tmpdir(), 'muse-preview-trong.txt'));
        if (!fs.existsSync(target)) { fs.writeFileSync(left.fsPath, '', 'utf8'); }
        await vscode.commands.executeCommand('vscode.diff', vscode.Uri.file(tmp), left, `Muse: xem trước thay đổi (${path.relative(root, target)})`);
        continue;
      }
      return false;
    }
  }
}

function readTextFile(p: string): string {
  if (!fs.existsSync(p)) { throw new Error(`Tệp không tồn tại: ${p}`); }
  const stat = fs.statSync(p);
  if (stat.size > 2 * 1024 * 1024) { throw new Error(`Tệp quá 2 MiB, không đọc được: ${p}`); }
  return fs.readFileSync(p, 'utf8');
}

function runShell(command: string, workdir: string, shell: string, timeoutSeconds: number): Promise<string> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    let file = '/bin/bash'; let args = ['-c', command];
    if (isWin) {
      if (shell === 'cmd') { file = 'cmd.exe'; args = ['/d', '/c', command]; }
      else { file = 'powershell.exe'; args = ['-NoProfile', '-NonInteractive', '-Command', command]; }
    } else if (shell === 'cmd' || shell === 'powershell') {
      resolve(`Lỗi: shell '${shell}' chỉ hỗ trợ trên Windows.`); return;
    }
    execFile(file, args, { cwd: workdir, timeout: Math.max(5, timeoutSeconds) * 1000, maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      const out = truncate((stdout || '') + (stderr ? `\n[stderr]\n${stderr}` : ''), 8000);
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0;
      resolve(`exit_code=${code}\n${out}`);
    });
  });
}

function normalizeName(name: string): string {
  return ALIASES[name] || name.toLowerCase();
}

function describe(call: ToolCall): string {
  const p = str(call.args.path);
  switch (call.name) {
    case 'list_files': return `Liệt kê ${p || '.'}`;
    case 'read_file': case 'read_files': return `Đọc ${p || String(call.args.paths || '')}`;
    case 'read_image': return `Đọc ảnh ${p}`;
    case 'read_video_frames': return `Trích khung hình video ${p}`;
    case 'send_file': return `Gửi nguyên file ${p}`;
    case 'generate_image': return `Tạo ảnh, lưu vào ${p}`;
    case 'edit_image': return `Sửa ảnh, lưu vào ${p}`;
    case 'generate_video': return `Tạo video, lưu vào ${p}`;
    case 'save_media': return `Tải media, lưu vào ${p}`;
    case 'write_file': return `Ghi ${p}`;
    case 'edit_file': return `Sửa ${p}`;
    case 'search_files': return `Tìm "${str(call.args.query)}"`;
    case 'run_command': return str(call.args.command);
    case 'git_status': return 'git status';
    case 'git_diff': return 'git diff';
    case 'process_status': return `Trạng thái tiến trình nền ${str(call.args.process_id) || '(liệt kê)'}`;
    case 'process_input': return `Gửi input cho tiến trình nền ${str(call.args.process_id)}`;
    case 'process_stop': return `Dừng tiến trình nền ${str(call.args.process_id)}`;
    default:
      if (call.name.startsWith('computer_')) { return describeComputerCall(call.name, call.args); }
      return call.name;
  }
}

// Trích câu trả lời dạng chat từ JSON kế hoạch của gateway, đúng logic
// PlannerReply của desktop: JSON có status completed/done/needs_input
// và trường reply/summary thì hiển thị trường đó, JSON gốc giữ lại để
// hiện trong mục Chi tiết. Trả về raw rỗng nếu không phải dạng này.
function plannerReply(text: string): { display: string; raw: string } {
  const candidates: string[] = [];
  const fence = /```(?:json)?[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) { candidates.push(m[1].trim()); }
  candidates.push(text.trim());
  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate) as Record<string, unknown>;
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) { continue; }
      const status = obj.status;
      if (status !== 'completed' && status !== 'done' && status !== 'needs_input') { continue; }
      const reply = obj.reply ?? obj.summary;
      if (typeof reply === 'string' && reply.trim().length > 0) {
        return { display: reply, raw: JSON.stringify(obj, null, 2) };
      }
    } catch { /* không phải JSON kế hoạch */ }
  }
  return { display: text.trim(), raw: '' };
}

// Export để test đơn vị từ out/extension.js (v0.8.12): hành vi runtime
// không đổi, chỉ cho phép test trích hàm thật kiểm tra guard JSON vỡ.
export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  const fence = /```(?:tool|json)?[^\n]*\n([\s\S]*?)```/g;
  let m: RegExpExecArray | null;
  while ((m = fence.exec(text)) !== null) {
    const body = m[1].trim();
    if (!body) { continue; }
    try { extractToolJson(JSON.parse(body), calls); }
    catch { if (body.includes('"tool_calls"') || body.includes('"name"')) { calls.push({ name: '__parse_error__', args: { error: 'Khối tool không phải JSON hợp lệ. Hãy gửi lại đúng một thao tác trong code fence ```json, escape dấu nháy và xuống dòng.' } }); } }
  }
  if (calls.length > 0) { return calls; }
  const raw = text.trim();
  if (raw.startsWith('{') || raw.startsWith('[')) {
    try { extractToolJson(JSON.parse(raw), calls); } catch { /* không phải tool */ }
  }
  if (calls.length === 0 && /```tool\s*$/.test(text)) {
    calls.push({ name: '__parse_error__', args: { error: 'Khối ```tool chưa đóng hoặc chưa có nội dung.' } });
  }
  return calls;
}

function extractToolJson(node: unknown, calls: ToolCall[]): void {
  if (Array.isArray(node)) { for (const item of node) { extractToolJson(item, calls); } return; }
  if (typeof node !== 'object' || node === null) { return; }
  const obj = node as Record<string, unknown>;
  if (Array.isArray(obj.tool_calls)) { for (const item of obj.tool_calls) { extractToolJson(item, calls); } return; }
  if (Array.isArray(obj.actions)) {
    const map: Record<string, string> = { scan: 'list_files', inspect_text: 'read_file', inspect_texts: 'read_files', find_text: 'search_files', replace_text: 'edit_file', save_text: 'write_file', terminal: 'run_command', git_status: 'git_status', git_diff: 'git_diff', send_file: 'send_file', generate_image: 'generate_image', edit_image: 'edit_image', generate_video: 'generate_video', save_media: 'save_media' };
    for (const item of obj.actions) {
      const step = item as Record<string, unknown>;
      const tool = map[str(step.action)] || '';
      if (!tool) { calls.push({ name: '__parse_error__', args: { error: `Action không hỗ trợ: ${str(step.action)}` } }); continue; }
      const args = { ...step }; delete args.action;
      if (step.find !== undefined) { args.old_text = step.find; }
      if (step.text !== undefined) { args.content = step.text; }
      if (step.script !== undefined) { args.command = step.script; }
      calls.push({ name: tool, args });
    }
    return;
  }
  const fn = (obj.function || {}) as Record<string, unknown>;
  const name = str(fn.name) || str(obj.name) || str(obj.tool);
  if (!name) { return; }
  let args: Record<string, unknown> = {};
  const rawArgs = fn.arguments ?? obj.arguments ?? obj.parameters;
  if (typeof rawArgs === 'string') { try { args = JSON.parse(rawArgs) as Record<string, unknown>; } catch { calls.push({ name: '__parse_error__', args: { error: 'arguments của tool không phải JSON hợp lệ.' } }); return; } }
  else if (typeof rawArgs === 'object' && rawArgs !== null) { args = rawArgs as Record<string, unknown>; }
  else {
    args = { ...obj }; delete args.name; delete args.tool; delete args.id;
  }
  for (const [from, to] of [['file_path', 'path'], ['directory', 'path'], ['cmd', 'command'], ['working_directory', 'workdir'], ['cwd', 'workdir'], ['search', 'old_text'], ['old_string', 'old_text'], ['replace', 'new_text'], ['new_string', 'new_text'], ['new_content', 'content']]) {
    if (args[to] === undefined && args[from] !== undefined) { args[to] = args[from]; }
  }
  calls.push({ name: normalizeName(name), args });
}

async function accountAction(gateway: GatewayManager, output: vscode.OutputChannel, kind: 'reset' | 'renew'): Promise<void> {
  try {
    const info = await gateway.ensureStarted();
    const accounts = await fetchGatewayAccounts(info.baseUrl, info.apiKey);
    if (accounts.length === 0) {
      void vscode.window.showWarningMessage('Chưa có tài khoản nào trong pool gateway nên không có gì để reset/renew. Hãy chạy "Muse: Nhập đăng nhập từ app desktop" trước.');
      return;
    }
    const pick = await vscode.window.showQuickPick(
      accounts.map((a) => ({ label: formatAccountLine(a), account: a })),
      { placeHolder: `Chọn tài khoản để ${kind === 'reset' ? 'reset (xóa cooldown, đưa về Active)' : 'renew (gia hạn phiên)'}` },
    );
    if (!pick) { return; }
    const confirm = await vscode.window.showWarningMessage(
      `${kind === 'reset' ? 'Reset' : 'Renew'} tài khoản ${pick.account.label || pick.account.id}?`,
      { modal: true }, 'Đồng ý', 'Hủy',
    );
    if (confirm !== 'Đồng ý') { return; }
    const result = kind === 'reset'
      ? await resetGatewayAccount(info.baseUrl, info.apiKey, pick.account.id)
      : (await renewGatewayAccount(info.baseUrl, info.apiKey, pick.account.id)).account;
    const msg = `Đã ${kind} tài khoản: ${formatAccountLine(result)}`;
    output.appendLine('[Muse] ' + msg);
    void vscode.window.showInformationMessage(msg);
  } catch (e) {
    void vscode.window.showErrorMessage(`Không ${kind} được tài khoản: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function askSaveFolder(): Promise<string | undefined> {
  const root = workspaceRoot();
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false, canSelectFolders: true, canSelectMany: false,
    defaultUri: root ? vscode.Uri.file(root) : undefined,
    title: 'Chọn thư mục lưu kết quả media',
  });
  return picked?.[0]?.fsPath;
}

async function mediaGenerateImage(gateway: GatewayManager): Promise<void> {
  try {
    const prompt = await vscode.window.showInputBox({ prompt: 'Mô tả ảnh cần tạo (prompt)', placeHolder: 'Ví dụ: một con mèo cam ngồi bên cửa sổ, phong cách vẽ tay' });
    if (!prompt) { return; }
    const nText = await vscode.window.showInputBox({ prompt: 'Số ảnh (1-4)', value: '1', validateInput: (v) => { const n = Number(v); return Number.isInteger(n) && n >= 1 && n <= 4 ? undefined : 'Nhập số nguyên từ 1 đến 4.'; } });
    if (!nText) { return; }
    const size = await vscode.window.showInputBox({ prompt: 'Kích thước (để trống = mặc định của gateway)', placeHolder: 'Ví dụ: 1024x1024' });
    const info = await gateway.ensureStarted();
    const images = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Muse: đang tạo ảnh…' }, async () =>
      generateImages(info.baseUrl, info.apiKey, { prompt, n: Number(nText), size: size || undefined }));
    if (images.length === 0 || !images[0].url) { throw new Error('Gateway không trả về URL ảnh nào.'); }
    const folder = await askSaveFolder();
    if (!folder) { return; }
    const saved: string[] = [];
    for (const img of images) {
      if (img.url) { saved.push(await downloadMedia(img.url, folder, 'muse-image.png')); }
    }
    for (const file of saved) { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file)); }
    void vscode.window.showInformationMessage(`Đã tạo và lưu ${saved.length} ảnh vào ${folder}.`);
  } catch (e) {
    void vscode.window.showErrorMessage(`Không tạo được ảnh: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function mediaEditImage(gateway: GatewayManager): Promise<void> {
  try {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true, filters: { 'Ảnh': ['png', 'jpg', 'jpeg', 'webp', 'gif'] },
      title: 'Chọn 1-4 ảnh gốc để sửa',
    });
    if (!picked || picked.length === 0 || picked.length > 4) {
      if (picked && picked.length > 4) { void vscode.window.showWarningMessage('Sửa ảnh tối đa 4 ảnh gốc (giới hạn của gateway).'); }
      return;
    }
    const prompt = await vscode.window.showInputBox({ prompt: 'Mô tả cách sửa ảnh (prompt)' });
    if (!prompt) { return; }
    const info = await gateway.ensureStarted();
    const images = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Muse: đang sửa ảnh…' }, async () =>
      editImage(info.baseUrl, info.apiKey, { prompt, imagePaths: picked.map((u) => u.fsPath), n: 1 }));
    if (images.length === 0 || !images[0].url) { throw new Error('Gateway không trả về URL ảnh nào.'); }
    const folder = await askSaveFolder();
    if (!folder) { return; }
    const saved: string[] = [];
    for (const img of images) {
      if (img.url) { saved.push(await downloadMedia(img.url, folder, 'muse-edit.png')); }
    }
    for (const file of saved) { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(file)); }
    void vscode.window.showInformationMessage(`Đã sửa và lưu ${saved.length} ảnh vào ${folder}.`);
  } catch (e) {
    void vscode.window.showErrorMessage(`Không sửa được ảnh: ${e instanceof Error ? e.message : String(e)}`);
  }
}

async function mediaGenerateVideo(gateway: GatewayManager): Promise<void> {
  try {
    const prompt = await vscode.window.showInputBox({ prompt: 'Mô tả video cần tạo (prompt)' });
    if (!prompt) { return; }
    const durText = await vscode.window.showInputBox({
      prompt: 'Thời lượng giây (1-60, để trống = mặc định của gateway)',
      validateInput: (v) => {
        if (!v) { return undefined; }
        const n = Number(v);
        return Number.isInteger(n) && n >= 1 && n <= 60 ? undefined : 'Nhập số nguyên từ 1 đến 60.';
      },
    });
    if (durText === undefined) { return; }
    const useFrame = await vscode.window.showQuickPick(['Không dùng first frame', 'Chọn ảnh làm first frame'], { placeHolder: 'Video có dùng ảnh khung hình đầu không?' });
    let firstFrame: string | undefined;
    if (useFrame === 'Chọn ảnh làm first frame') {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: false, filters: { 'Ảnh': ['png', 'jpg', 'jpeg', 'webp'] },
        title: 'Chọn ảnh làm first frame',
      });
      if (!picked || picked.length === 0) { return; }
      firstFrame = dataUrlOfImageFile(picked[0].fsPath);
    }
    const info = await gateway.ensureStarted();
    const video = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Muse: đang tạo video (poll mỗi 5 giây, tối đa 15 phút)…' }, async (progress) =>
      createVideo(info.baseUrl, info.apiKey, { prompt, duration: durText ? Number(durText) : undefined, firstFrameDataUrl: firstFrame }, (status, pct) => {
        progress.report({ message: `trạng thái: ${status}${pct ? `, tiến trình ${pct}%` : ''}` });
      }));
    const folder = await askSaveFolder();
    if (!folder) { return; }
    const saved = await downloadMedia(video.url, folder, 'muse-video.mp4');
    await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(saved));
    void vscode.window.showInformationMessage(`Đã tạo và lưu video vào ${saved}.`);
  } catch (e) {
    void vscode.window.showErrorMessage(`Không tạo được video: ${e instanceof Error ? e.message : String(e)}`);
  }
}

let sharedGateway: GatewayManager | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const output = vscode.window.createOutputChannel('Muse Gateway');
  context.subscriptions.push(output);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'muse.openChat';
  statusBar.tooltip = 'Muse: bấm để mở chat. Trạng thái gateway xem ở Output > Muse Gateway.';
  context.subscriptions.push(statusBar);
  const updateStatusBar = (state: GatewayState, detail: string): void => {
    const icon = state === 'running' ? '$(check)' : state === 'starting' ? '$(sync~spin)' : state === 'error' ? '$(error)' : '$(circle-slash)';
    const label = state === 'running' ? 'Muse Gateway: Đang chạy' : state === 'starting' ? 'Muse Gateway: Đang khởi động…' : state === 'error' ? 'Muse Gateway: Lỗi' : 'Muse Gateway: Chưa chạy';
    statusBar.text = `${icon} ${label}`;
    statusBar.tooltip = `Muse Gateway: ${detail}`;
    statusBar.show();
  };
  const gateway = new GatewayManager(context, output, gatewayConfig, updateStatusBar);
  sharedGateway = gateway;
  updateStatusBar('stopped', 'Chưa khởi động');
  // v0.8.27: store + RunManager tạo MỘT LẦN ở đây, truyền chung cho
  // sidebar và mọi panel (openSessionInPanel) — trạng thái chạy sống
  // ở RunManager nên chuyển bề mặt không hủy run cũ.
  const store = new SessionStore(context, workspaceRoot);
  const runManager = new RunManager();
  const provider = new MuseChatProvider(context, gateway, store, { isSidebar: true, runManager });
  context.subscriptions.push(vscode.window.registerWebviewViewProvider(MuseChatProvider.viewId, provider));
  const preset = (text: string) => provider.focusAndPreset(text);
  context.subscriptions.push(
    vscode.commands.registerCommand('muse.openChat', () => { void vscode.commands.executeCommand('muse.chat.focus'); }),
    vscode.commands.registerCommand('muse.openSettings', () => { provider.openSettings(); }),
    vscode.commands.registerCommand('muse.explainProject', () => preset('Giải thích dự án này đang làm gì và các phần chính liên hệ với nhau thế nào. Chỉ đọc tệp, chưa sửa gì.')),
    vscode.commands.registerCommand('muse.findAndFix', () => preset('Tìm lỗi trong dự án này, giải thích nguyên nhân, rồi đề xuất và sửa sau khi tôi duyệt từng thay đổi.')),
    vscode.commands.registerCommand('muse.addFeature', () => preset('Tôi muốn thêm một tính năng. Trước hết hãy đọc các tệp liên quan rồi hỏi tôi mô tả tính năng, đừng tự sửa ngay.')),
    vscode.commands.registerCommand('muse.checkQuality', () => preset('Kiểm tra những gì vừa sửa: chạy kiểm tra phù hợp với dự án và giải thích kết quả, không tự sửa thêm.')),
    vscode.commands.registerCommand('muse.stop', () => provider.stop()),
    vscode.commands.registerCommand('muse.startGateway', async () => {
      try {
        const info = await gateway.ensureStarted();
        void vscode.window.showInformationMessage(`Gateway đã chạy (${info.mode === 'bundled' ? 'kèm theo extension' : 'sẵn có'}, cổng ${info.port}).`);
      } catch (e) {
        void vscode.window.showErrorMessage(`Không khởi động được gateway: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    vscode.commands.registerCommand('muse.stopGateway', async () => {
      await gateway.stop();
      void vscode.window.showInformationMessage('Đã dừng gateway kèm theo (nếu có). Gateway ngoài không bị ảnh hưởng.');
    }),
    vscode.commands.registerCommand('muse.restartGateway', async () => {
      try {
        const info = await gateway.restart();
        void vscode.window.showInformationMessage(`Gateway đã khởi động lại (cổng ${info.port}).`);
        void provider.refreshAccounts();
      } catch (e) {
        void vscode.window.showErrorMessage(`Không khởi động lại được gateway: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    vscode.commands.registerCommand('muse.importDesktopLogin', async () => {
      const msg = await gateway.importDesktopLogin();
      void vscode.window.showInformationMessage(msg);
      void provider.refreshAccounts();
    }),
    vscode.commands.registerCommand('muse.installGatewayBrowser', async () => {
      output.show(true);
      output.appendLine('[Muse] Đang cài Chromium cho gateway, vui lòng chờ…');
      const msg = await gateway.installBrowser((line) => output.appendLine(line));
      void vscode.window.showInformationMessage(msg);
    }),
    vscode.commands.registerCommand('muse.showGatewayLog', () => { output.show(true); }),
    vscode.commands.registerCommand('muse.openGatewayDashboard', async () => {
      try {
        const info = await gateway.ensureStarted();
        await vscode.env.openExternal(vscode.Uri.parse(info.dashboardUrl));
      } catch (e) {
        void vscode.window.showErrorMessage(`Không mở được dashboard gateway: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    vscode.commands.registerCommand('muse.checkGatewayAccounts', async () => {
      try {
        const info = await gateway.ensureStarted();
        const status = await fetchGatewayStatus(info.baseUrl, info.apiKey);
        const accounts = await fetchGatewayAccounts(info.baseUrl, info.apiKey);
        const lines = [
          `Gateway ${info.mode === 'bundled' ? 'kèm theo' : 'sẵn có'} (cổng ${info.port}), phiên bản gateway ${status.version || '?'}:`,
          `Tài khoản: tổng ${String(status.accounts.total ?? '?')}, khả dụng ${String(status.accounts.available ?? '?')}, đang cooling ${String(status.accounts.cooling ?? '?')}, invalid ${String(status.accounts.invalid ?? '?')}.`,
          accounts.length === 0 ? 'Chưa có tài khoản nào trong pool — đây chính là nguyên nhân của lỗi 503 no_account_available. Hãy chạy "Muse: Nhập đăng nhập từ app desktop".' : accounts.map(formatAccountLine).join('\n'),
        ];
        output.appendLine('[Muse] ' + lines.join('\n'));
        output.show(true);
        void vscode.window.showInformationMessage(lines.join('\n'));
      } catch (e) {
        void vscode.window.showErrorMessage(`Không xem được trạng thái gateway: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    vscode.commands.registerCommand('muse.resetGatewayAccount', async () => {
      await accountAction(gateway, output, 'reset');
    }),
    vscode.commands.registerCommand('muse.renewGatewayAccount', async () => {
      await accountAction(gateway, output, 'renew');
    }),
    vscode.commands.registerCommand('muse.selectComputerWindow', async () => {
      const msg = await provider.selectComputerWindow();
      void vscode.window.showInformationMessage(msg);
    }),
    vscode.commands.registerCommand('muse.stopComputerControl', async () => {
      const msg = await provider.stopComputerControl();
      void vscode.window.showInformationMessage(msg);
    }),
    vscode.commands.registerCommand('muse.clearChatHistory', () => {
      provider.clearHistory();
      void vscode.window.showInformationMessage('Đã xóa lịch sử chat của Muse trong workspace này.');
    }),
    vscode.commands.registerCommand('muse.openSessionInNewTab', async (sessionId?: string) => {
      // Không tự mở tab khi khởi động: chỉ khi user chủ động gọi lệnh
      // này (palette) hoặc bấm nút "Tab mới" trên item session. Không
      // có id thì hỏi chọn session bằng QuickPick, hủy thì dừng êm.
      let id = typeof sessionId === 'string' ? sessionId : undefined;
      if (!id) {
        const sessions = provider.listSessions();
        if (sessions.length === 0) { void vscode.window.showInformationMessage('Chưa có hội thoại nào.'); return; }
        const pick = await vscode.window.showQuickPick(sessions.map((s) => ({ label: s.title, id: s.id })), { placeHolder: 'Chọn hội thoại để mở trong tab mới (kéo tab sang nhóm bên cạnh để xem song song)' });
        if (!pick) { return; }
        id = pick.id;
      }
      await provider.openSessionInPanel(id);
    }),
    vscode.commands.registerCommand('muse.newSession', () => {
      void provider.newSession().then(() => { void vscode.commands.executeCommand('muse.chat.focus'); });
    }),
    vscode.commands.registerCommand('muse.reloadWebHistory', () => { void provider.reloadCurrentWebHistory(); }),
    vscode.commands.registerCommand('muse.filterSessionsByAccount', () => { void provider.selectAccountFilter(); }),
    vscode.commands.registerCommand('muse.allowReimportDeleted', () => { void provider.allowReimportDeletedSessions(); }),
    vscode.commands.registerCommand('muse.toggleLocalTools', async () => {
      // v0.8.2, việc 4: đổi nhanh muse.localTools mà không cần mở
      // Settings. Tắt thì agent chỉ trò chuyện, không đọc/sửa/chạy gì
      // trong workspace được (xem README).
      const config = vscode.workspace.getConfiguration('muse');
      const current = config.get<boolean>('localTools') !== false;
      await config.update('localTools', !current, vscode.ConfigurationTarget.Global);
      void vscode.window.showInformationMessage(!current
        ? 'Đã bật tool cục bộ: agent có thể đọc/sửa/chạy trong workspace (tool chỉ đọc vẫn chạy không hỏi duyệt, kết quả gửi ngược lên model).'
        : 'Đã tắt tool cục bộ: agent chỉ trò chuyện, không đọc/sửa/chạy gì trong workspace, không còn dữ liệu workspace nào gửi lên model qua tool.');
    }),
    vscode.commands.registerCommand('muse.switchSession', async () => {
      const sessions = provider.listSessions();
      if (sessions.length === 0) { void vscode.window.showInformationMessage('Chưa có hội thoại nào.'); return; }
      const pick = await vscode.window.showQuickPick(sessions.map((s) => ({ label: s.title, id: s.id })), { placeHolder: 'Chọn hội thoại để làm việc tiếp' });
      if (pick) { void provider.switchSession(pick.id); void vscode.commands.executeCommand('muse.chat.focus'); }
    }),
    vscode.commands.registerCommand('muse.renameSession', () => { void provider.renameSession(); }),
    vscode.commands.registerCommand('muse.deleteSession', () => { void provider.deleteSession(); }),
    vscode.commands.registerCommand('muse.syncFromWeb', () => { void provider.syncFromWeb(); }),
    vscode.commands.registerCommand('muse.forceSyncTitles', () => { void provider.forceSyncTitlesFromWeb(); }),
    vscode.commands.registerCommand('muse.fixGenericTitles', () => { void provider.fixGenericTitlesFromFirstMessage(); }),
    vscode.commands.registerCommand('muse.refreshGatewayAccounts', async () => {
      await provider.refreshAccounts();
      void vscode.window.showInformationMessage('Đã làm mới trạng thái tài khoản Muse, xem trong panel Cài đặt (Muse: Cài đặt) và trạng thái session trong khung chat.');
    }),
    vscode.commands.registerCommand('muse.logoutGatewayAccount', async () => {
      try {
        const info = await gateway.ensureStarted();
        const accounts = await fetchGatewayAccounts(info.baseUrl, info.apiKey);
        if (accounts.length === 0) { void vscode.window.showInformationMessage('Không có tài khoản nào trong pool để đăng xuất.'); return; }
        const pick = await vscode.window.showQuickPick(accounts.map((a) => ({ label: a.label ? `${a.label} (${a.id})` : a.id, id: a.id, description: `trạng thái: ${a.status}` })), { placeHolder: 'Chọn tài khoản để đăng xuất khỏi gateway' });
        if (!pick) { return; }
        await provider.accountActionFromWebview('logout', pick.id);
      } catch (e) {
        void vscode.window.showErrorMessage(`Không đăng xuất được: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    vscode.commands.registerCommand('muse.generateImage', async () => {
      await mediaGenerateImage(gateway);
    }),
    vscode.commands.registerCommand('muse.editImage', async () => {
      await mediaEditImage(gateway);
    }),
    vscode.commands.registerCommand('muse.generateVideo', async () => {
      await mediaGenerateVideo(gateway);
    }),
  );
  // Tự chạy gateway ngay khi extension kích hoạt — kể cả khi kích hoạt do
  // onStartupFinished lúc mở VS Code, chưa bấm biểu tượng Muse. Không chặn
  // activation và không spam modal lúc khởi động: lỗi chỉ hiện ở status bar
  // và Output > Muse Gateway, và sẽ hiện lại trong khung chat khi gửi yêu cầu.
  // Ngoại lệ duy nhất (v0.6.0, kiểm tra trình duyệt chủ động): trước lần
  // ensureStarted đầu tiên, nếu máy không có Edge/Chrome hệ thống lẫn
  // Chromium Playwright thì hỏi một lần bằng modal có 2 nút (Cài ngay /
  // Để sau); có trình duyệt thì không hiện gì. Điểm này được chọn thay vì
  // chờ mở panel Cài đặt, vì gateway tự chạy ngay lúc kích hoạt nên hỏi
  // muộn hơn là đã thất bại rồi; và thay vì hỏi ở mọi lần ensureStarted,
  // vì modal chỉ hiện một lần mỗi phiên cho mỗi lý do.
  void (async () => {
    await gateway.promptBrowserInstallIfMissing('startup');
    await gateway.ensureStarted().catch(() => { /* đã báo qua status bar + output */ });
  })();
}

export function deactivate(): void {
  // Chỉ dừng gateway do chính instance này khởi động (GatewayManager.stop
  // không động tới gateway ngoài). Nếu cửa sổ này là cửa sổ đã khởi động
  // gateway kèm theo thì đóng cửa sổ sẽ dừng nó; cửa sổ khác có thể khởi
  // động lại khi gửi yêu cầu tiếp theo.
  void sharedGateway?.stop();
}
