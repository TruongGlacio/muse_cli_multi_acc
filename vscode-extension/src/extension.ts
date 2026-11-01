import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { execFile } from 'child_process';
import { GatewayManager, GatewayConfig, GatewayState } from './gateway';
import { fetchGatewayStatus, fetchGatewayAccounts, resetGatewayAccount, renewGatewayAccount, patchGatewayAccount, deleteGatewayAccount, formatAccountLine, fetchWebThreads, registerConversation } from './admin';
import { BackgroundProcesses } from './processes';
import { generateImages, editImage, createVideo, downloadMedia, dataUrlOfImageFile } from './media';
import { ComputerHelper, COMPUTER_TOOLS, approveComputerAction, describeComputerCall } from './computer';
import { MuseSettingsPanel } from './settings';

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
interface ChatMsg { role: string; content: ChatContent; }
interface PendingAttachment { name: string; size: number; kind: 'image' | 'text' | 'video' | 'file'; kindLabel: string; dataUrl?: string; text?: string; note?: string; }
interface ChatSession {
  id: string; title: string; conversationId: string; messages: ChatMsg[];
  createdAt: number; updatedAt: number; workspacePath?: string;
  // Tài khoản Muse gắn với session (v0.5.0, chuẩn bị cho multi-account):
  // accountId là Id ngẫu nhiên của gateway (acc_ + chuỗi ngẫu nhiên),
  // KHÔNG phải danh tính Muse, nên chỉ ghi khi xác định chắc chắn.
  accountId?: string; accountLabel?: string; accountStatusAtSave?: string;
  // Đồng bộ từ web (v0.6.0, mức 1): threadUrl là URL thread muse.ai
  // (cũng là hint đăng ký ở gateway: conversationId của session này),
  // importedFromWeb đánh dấu session chỉ có danh sách, không có nội
  // dung cũ — banner riêng hiện khi mở session, KHÔNG đưa vào messages
  // nên không bao giờ lọt vào turns gửi model.
  threadUrl?: string; importedFromWeb?: boolean;
}

const SYSTEM_PROMPT = [
  'Bạn là Muse, trợ lý lập trình chạy trong VS Code, làm việc trực tiếp trên',
  'dự án người dùng đang mở. Nói tiếng Việt rõ ràng, ngắn gọn. Chỉ dùng các',
  'công cụ dưới đây để đọc, sửa và kiểm tra dự án; không tự nhận đã làm gì',
  'khi chưa có kết quả công cụ trả về, không bịa nội dung tệp.',
  '',
  'CÔNG CỤ (gửi đúng một khối JSON trong một code fence ```json):',
  '```json',
  '{"tool_calls":[{"name":"read_file","arguments":{"path":"src/Program.cs"}}]}',
  '```',
  'Định dạng cũ ```tool {"name":"read_file","path":"src/Program.cs"} cũng được.',
  'Các công cụ: list_files {path, recursive}, read_file {path, start_line,',
  'max_lines}, read_files {paths}, search_files {query, path, case_sensitive},',
  'write_file {path, content}, edit_file {path, old_text, new_text} hoặc',
  'edit_file {path, edits:[{old_text, new_text}]}, run_command {command,',
  'workdir, shell, timeout_seconds} hoặc run_command {command, background:true,',
  'timeout_seconds} để chạy nền rồi dùng process_status/process_input/',
  'process_stop với process_id trả về, git_status {}, git_diff {}.',
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
  'không dùng đường dẫn tuyệt đối ngoài workspace; lệnh không chờ nhập liệu,',
  'không chạy lệnh tương tác; một lệnh chỉ được coi là thành công khi',
  'exit_code = 0. Thao tác ghi tệp và chạy lệnh sẽ được extension hỏi người',
  'dùng duyệt trước khi thực thi; nếu bị từ chối thì tôn trọng, không thử',
  'lách bằng cách khác. Sau mỗi kết quả công cụ, tiếp tục bước tiếp theo hoặc trả lời cuối.',
  'Câu trả lời cuối không chứa khối tool, tóm tắt đã đổi gì và đã kiểm tra gì.',
].join('\n');

const READ_ONLY_TOOLS = new Set(['list_files', 'read_file', 'read_files', 'search_files', 'git_status', 'git_diff']);
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
  private view?: vscode.WebviewView;
  private pendingPreset?: string;
  private running = false;
  private abort?: AbortController;
  private history: ChatMsg[] = [];
  private conversationId: string;
  private sessions: ChatSession[] = [];
  private currentSessionId: string;
  private pendingAttachments: PendingAttachment[] = [];
  private processes = new BackgroundProcesses();
  private computer = new ComputerHelper(this.context);
  private lastComputerImage?: string;
  private lastStreamed = false;
  // Cache tài khoản mới nhất để tính trạng thái session và backfill.
  // Chỉ chứa các trường an toàn từ Account.Public() (không cookie).
  private cachedAccounts: Array<{ id: string; label: string; enabled: boolean; status: string; email: string | null; username: string | null }> = [];
  private accountsCacheLoaded = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly gateway: GatewayManager) {
    // Panel Nhật ký (v0.6.0): mỗi dòng gateway mới vào buffer thì đẩy
    // ngay sang webview. Webview chưa mở thì post() bỏ qua an toàn, dòng
    // vẫn nằm trong buffer để nút Làm mới lấy lại sau.
    this.gateway.onLog = (line: string) => {
      this.post('logLine', { text: line, time: logTimeNow() });
    };
    // Quản lý session (v0.4.0): các bản trước lưu session theo workspace
    // nên mở thư mục khác là mất danh sách, và chỉ có dropdown nhỏ nên
    // user không thấy được danh sách để chọn tiếp. Từ 0.4.0, session
    // lưu ở globalState (theo user, không theo thư mục) nên danh sách
    // theo user qua mọi workspace. Lần đầu chạy 0.4.0, hợp nhất session
    // từ global (nếu có) + session workspace của 0.3.3 (nếu chưa hợp
    // nhất) + lịch sử cũ, theo id, bản mới hơn thắng; sau đó đánh dấu
    // đã hợp nhất để lần sau không hồi sinh session đã xóa. Lưu ý thật:
    // session của workspace khác tạo ở 0.3.3 chỉ được kéo vào khi user
    // mở lại đúng workspace đó một lần sau khi lên 0.4.0; session trước
    // 0.3.3 không bao giờ được lưu thành danh sách nên không thể khôi
    // phục thành nhiều session, chỉ lịch sử cuối cùng thành 1 session.
    const parseSessions = (raw: Array<Record<string, unknown>>): ChatSession[] => {
      const out: ChatSession[] = [];
      for (const s of raw) {
        if (typeof s.id !== 'string' || typeof s.conversationId !== 'string' || !Array.isArray(s.messages)) { continue; }
        const messages = (s.messages as Array<Record<string, unknown>>)
          .filter((m) => typeof m.role === 'string' && typeof m.content === 'string')
          .map((m) => ({ role: m.role as string, content: m.content as string }))
          .slice(-40);
        out.push({ id: s.id, title: typeof s.title === 'string' && s.title ? s.title : 'Hội thoại', conversationId: s.conversationId, messages, createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(), updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(), workspacePath: typeof s.workspacePath === 'string' ? s.workspacePath : undefined, accountId: typeof s.accountId === 'string' && s.accountId ? s.accountId : undefined, accountLabel: typeof s.accountLabel === 'string' && s.accountLabel ? s.accountLabel : undefined, accountStatusAtSave: typeof s.accountStatusAtSave === 'string' ? s.accountStatusAtSave : undefined, threadUrl: typeof s.threadUrl === 'string' && s.threadUrl ? s.threadUrl : undefined, importedFromWeb: s.importedFromWeb === true });
      }
      return out;
    };
    const merged = new Map<string, ChatSession>();
    for (const s of parseSessions(this.context.globalState.get<Array<Record<string, unknown>>>('muse.sessions', []))) { merged.set(s.id, s); }
    const migrated = this.context.workspaceState.get<boolean>('muse.sessionsMigratedToGlobal', false);
    if (!migrated) {
      for (const s of parseSessions(this.context.workspaceState.get<Array<Record<string, unknown>>>('muse.sessions', []))) {
        const old = merged.get(s.id);
        if (!old || s.updatedAt > old.updatedAt) { merged.set(s.id, s); }
      }
      void this.context.workspaceState.update('muse.sessionsMigratedToGlobal', true);
      void this.context.workspaceState.update('muse.sessions', []);
    }
    const parsed = [...merged.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    if (parsed.length === 0) {
      const legacy = this.context.workspaceState.get<Array<{ role?: unknown; content?: unknown }>>('muse.chatHistory', [])
        .filter((m) => typeof m.role === 'string' && typeof m.content === 'string')
        .map((m) => ({ role: m.role as string, content: m.content as string }))
        .slice(-40);
      const legacyId = this.context.workspaceState.get<string>('muse.conversationId', '');
      const firstUser = legacy.find((m) => m.role === 'user');
      parsed.push({
        id: crypto.randomUUID(),
        title: firstUser ? String(firstUser.content).trim().slice(0, 40) || 'Hội thoại 1' : 'Hội thoại 1',
        conversationId: legacyId || crypto.randomUUID(),
        messages: legacy,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        workspacePath: workspaceRoot(),
      });
    }
    this.sessions = parsed;
    const savedCurrent = this.context.globalState.get<string>('muse.currentSessionId', '') || this.context.workspaceState.get<string>('muse.currentSessionId', '');
    const current = this.sessions.find((s) => s.id === savedCurrent) || this.sessions[0];
    this.currentSessionId = current.id;
    this.history = current.messages;
    this.conversationId = current.conversationId;
  }

  private currentSession(): ChatSession {
    return this.sessions.find((s) => s.id === this.currentSessionId) || this.sessions[0];
  }

  private saveSessions(): void {
    this.syncCurrentSession();
    const stored = this.sessions.map((s) => ({ ...s, messages: s.messages.slice(-40) }));
    void this.context.globalState.update('muse.sessions', stored);
    void this.context.globalState.update('muse.currentSessionId', this.currentSessionId);
    // Giữ key lịch sử cũ theo session hiện tại để không mất dữ liệu nếu hạ cấp.
    void this.context.workspaceState.update('muse.chatHistory', this.history.slice(-40));
    void this.context.workspaceState.update('muse.conversationId', this.conversationId);
  }

  private syncCurrentSession(): void {
    const s = this.currentSession();
    if (!s) { return; }
    s.messages = this.history;
    s.conversationId = this.conversationId;
    s.updatedAt = Date.now();
  }

  // Trạng thái session, đúng 3 giá trị user yêu cầu (v0.5.0):
  // - Đang chạy: session hiện tại đang có yêu cầu chạy (running=true).
  // - Đã logout: session có accountId đã lưu nhưng account đó không còn
  //   trong pool HOẶC trạng thái Invalid (hết hạn). Cache chưa tải thì
  //   không kết luận logout, để Đã dừng (tránh báo sai).
  // - Đã dừng: còn lại, gồm session chưa xác định tài khoản và session
  //   có account đang active/cooling/disabled. Cooling/disabled chỉ ghi
  //   chú trong accountDetail, không thành trạng thái thứ 4.
  private sessionStatus(session: ChatSession): { status: 'running' | 'stopped' | 'loggedout'; detail: string } {
    if (session.id === this.currentSessionId && this.running) { return { status: 'running', detail: '' }; }
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

  private postSessions(): void {
    this.post('sessions', {
      sessions: this.sessions.map((s) => {
        const st = this.sessionStatus(s);
        return {
          id: s.id, title: s.title, count: s.messages.length, updatedAt: s.updatedAt,
          workspacePath: s.workspacePath || '',
          accountLabel: s.accountLabel || '',
          accountDisplay: this.accountDisplayFor(s),
          accountStatus: st.status,
          accountDetail: st.detail,
          threadUrl: s.threadUrl || '',
          importedFromWeb: s.importedFromWeb === true,
        };
      }),
      currentId: this.currentSessionId,
    });
  }

  // Sau khi gộp trùng ở panel Cài đặt: session nào có accountId nằm
  // trong mergedIds thì đổi sang primaryId + primaryLabel, lưu lại và
  // gửi lại danh sách để dòng tài khoản cập nhật (điểm 3 + điểm 1).
  private remapSessionsAfterMerge(remap: Record<string, { primaryId: string; primaryLabel: string }>): void {
    let changed = false;
    for (const s of this.sessions) {
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
    if (this.backfillSessionAccounts()) { this.saveSessions(); }
    this.postSessions();
    void MuseSettingsPanel.refreshCurrent().catch(() => { /* panel chưa mở */ });
  }

  // Backfill: chỉ gán khi pool có đúng 1 tài khoản. Trả true nếu đổi gì.
  private backfillSessionAccounts(): boolean {
    if (this.cachedAccounts.length !== 1) { return false; }
    const only = this.cachedAccounts[0];
    let changed = false;
    for (const s of this.sessions) {
      if (!s.accountId) {
        s.accountId = only.id;
        s.accountLabel = only.label || only.id;
        s.accountStatusAtSave = only.status;
        changed = true;
      }
    }
    return changed;
  }

  // Gán tài khoản cho session mới, best effort, không chặn tạo session.
  private async assignAccountBestEffort(session: ChatSession): Promise<void> {
    try {
      let accounts = this.cachedAccounts;
      if (!this.accountsCacheLoaded) { accounts = await this.fetchAccountsCached(); }
      if (accounts.length === 1) {
        session.accountId = accounts[0].id;
        session.accountLabel = accounts[0].label || accounts[0].id;
        session.accountStatusAtSave = accounts[0].status;
        this.saveSessions();
        this.postSessions();
      }
    } catch { /* gateway chưa chạy thì để trống, backfill sau */ }
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
    await this.refreshAccounts();
  }

  listSessions(): Array<{ id: string; title: string }> {
    return this.sessions.map((s) => ({ id: s.id, title: s.title }));
  }

  listSessionsWithAccounts(): Array<{ id: string; title: string; accountId?: string; accountLabel?: string }> {
    return this.sessions.map((s) => ({ id: s.id, title: s.title, accountId: s.accountId, accountLabel: s.accountLabel }));
  }

  openSettings(): void {
    MuseSettingsPanel.createOrShow(
      this.context,
      this.gateway,
      () => { void this.refreshAccounts(); },
      () => this.listSessionsWithAccounts(),
      (remap) => { this.remapSessionsAfterMerge(remap); },
    );
  }

  async switchSession(id: string): Promise<void> {
    if (this.running) { this.post('error', { text: 'Đang có một yêu cầu chạy. Bấm Dừng rồi mới đổi hội thoại.' }); return; }
    const target = this.sessions.find((s) => s.id === id);
    if (!target || target.id === this.currentSessionId) { return; }
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
    this.conversationId = target.conversationId;
    this.pendingAttachments = [];
    this.saveSessions();
    this.post('historyCleared', {});
    if (this.history.length > 0) {
      this.post('history', { messages: this.history.map((h) => ({ role: h.role, text: typeof h.content === 'string' ? h.content : '' })) });
    }
    this.postSessions();
    this.post('status', { text: `Đã chuyển sang hội thoại: ${target.title}` });
    if (target.importedFromWeb) {
      this.post('importedBanner', { text: 'Hội thoại này được đồng bộ từ web muse.ai. Lịch sử cũ nằm trên thread web, tin nhắn tiếp theo sẽ nối tiếp thread đó.' });
    }
    if (loggedOut) {
      this.post('loginWarning', { text: `Hội thoại này dùng tài khoản ${target.accountLabel || target.accountId} đã hết hạn hoặc đã đăng xuất. Bạn vẫn xem lại được lịch sử cũ. Tin nhắn tiếp theo bạn nhắn sẽ yêu cầu đăng nhập lại.` });
    }
  }

  newSession(): void {
    if (this.running) { this.post('error', { text: 'Đang có một yêu cầu chạy. Bấm Dừng rồi mới tạo hội thoại mới.' }); return; }
    this.syncCurrentSession();
    const session: ChatSession = { id: crypto.randomUUID(), title: 'Hội thoại mới', conversationId: crypto.randomUUID(), messages: [], createdAt: Date.now(), updatedAt: Date.now(), workspacePath: workspaceRoot() };
    this.sessions.push(session);
    this.currentSessionId = session.id;
    this.history = session.messages;
    this.conversationId = session.conversationId;
    this.pendingAttachments = [];
    this.saveSessions();
    this.post('historyCleared', {});
    this.postSessions();
    this.post('status', { text: 'Đã tạo hội thoại mới.' });
    void this.assignAccountBestEffort(session);
  }

  async renameSession(): Promise<void> {
    const session = this.currentSession();
    const name = await vscode.window.showInputBox({ prompt: 'Đặt tên mới cho hội thoại hiện tại', value: session.title });
    if (!name || name.trim().length === 0) { return; }
    session.title = name.trim().slice(0, 80);
    this.saveSessions();
    this.postSessions();
  }

  async deleteSession(): Promise<void> {
    const session = this.currentSession();
    const answer = await vscode.window.showWarningMessage(`Xóa hội thoại "${session.title}"? Lịch sử của hội thoại này sẽ mất.`, 'Xóa', 'Hủy');
    if (answer !== 'Xóa') { return; }
    if (this.sessions.length <= 1) {
      // Chỉ còn một session: làm trống nó thay vì để danh sách rỗng.
      this.history = [];
      this.pendingAttachments = [];
      this.conversationId = crypto.randomUUID();
      session.messages = [];
      session.conversationId = this.conversationId;
      session.title = 'Hội thoại 1';
      this.saveSessions();
      this.post('historyCleared', {});
      this.postSessions();
      return;
    }
    this.sessions = this.sessions.filter((s) => s.id !== session.id);
    const next = [...this.sessions].sort((a, b) => b.updatedAt - a.updatedAt)[0];
    this.currentSessionId = next.id;
    this.history = next.messages;
    this.conversationId = next.conversationId;
    this.pendingAttachments = [];
    this.saveSessions();
    this.post('historyCleared', {});
    if (this.history.length > 0) {
      this.post('history', { messages: this.history.map((h) => ({ role: h.role, text: typeof h.content === 'string' ? h.content : '' })) });
    }
    this.postSessions();
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
  async syncFromWeb(): Promise<void> {
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
      let account = accounts[0];
      if (accounts.length > 1) {
        const pick = await vscode.window.showQuickPick(
          accounts.map((a) => ({ label: a.label ? `${a.label} (${a.id})` : a.id, description: `trạng thái: ${a.status}` + (a.email || a.username ? ` — ${a.email || a.username}` : ''), account: a })),
          { placeHolder: 'Chọn tài khoản để đồng bộ hội thoại từ web' },
        );
        if (!pick) { return; }
        account = pick.account;
      }
      const webResult = await fetchWebThreads(info.baseUrl, info.apiKey, account.id);
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
      const existing = new Set(this.sessions.filter((s) => s.threadUrl).map((s) => normalizeUrl(s.threadUrl as string)));
      let added = 0;
      let skipped = 0;
      let errors = 0;
      for (const thread of threads) {
        const url = normalizeUrl(thread.url);
        if (existing.has(url)) { skipped++; continue; }
        const conversationId = crypto.randomUUID();
        const session: ChatSession = {
          id: crypto.randomUUID(),
          title: thread.title ? thread.title.slice(0, 80) : `Hội thoại web ${threadIdFromUrl(url)}`,
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
        this.sessions.push(session);
        existing.add(url);
        added++;
      }
      if (added > 0) { this.saveSessions(); }
      this.postSessions();
      // v0.7.0, điểm 4: đừng chỉ báo "Đã thêm 0" chung chung — nêu rõ
      // gateway đọc được bao nhiêu thread, bỏ qua bao nhiêu vì đã có,
      // và nếu gateway đọc được 0 thì nêu trang đã mở + tổng số link
      // đọc được để user biết lỗi ở khâu nào.
      let msg = `Đã thêm ${added} hội thoại mới từ web (gateway đọc được ${threads.length} thread), bỏ qua ${skipped} hội thoại đã có trong danh sách`;
      if (errors > 0) { msg += `, ${errors} hội thoại lỗi khi đăng ký`; }
      if (added === 0 && debug) {
        if (debug.threadCount === 0) {
          msg += `. Gateway không đọc được thread nào từ trang ${debug.pageUrl || 'muse.ai'} (tổng số link đọc được: ${debug.linkCount}). Có thể sidebar lịch sử chưa kịp tải hoặc không render thành link — hãy mở panel Nhật ký để xem chi tiết rồi thử đồng bộ lại.`;
        } else {
          msg += `.`;
        }
      }
      void vscode.window.showInformationMessage(msg);
    } catch (e) {
      void vscode.window.showErrorMessage(`Không đồng bộ được hội thoại từ web: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private saveHistory(): void {
    this.saveSessions();
  }

  clearHistory(): void {
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

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: { type?: string; text?: string; id?: string }) => {
      if (m.type === 'send' && m.text) { void this.run(m.text); }
      else if (m.type === 'stop') { this.abort?.abort(); }
      else if (m.type === 'openSettings') { this.openSettings(); }
      else if (m.type === 'attach') { void this.attachFile(); }
      else if (m.type === 'clearHistory') { this.clearHistory(); }
      else if (m.type === 'newSession') { this.newSession(); }
      else if (m.type === 'switchSession' && m.id) { void this.switchSession(m.id); }
      else if (m.type === 'renameSession') { void this.renameSession(); }
      else if (m.type === 'deleteSession') { void this.deleteSession(); }
      else if (m.type === 'syncFromWeb') { void this.syncFromWeb(); }
      else if (m.type === 'getLogs') { this.post('logs', { lines: this.gateway.getLogLines(), time: logTimeNow() }); }
      else if (m.type === 'clearLogs') { this.gateway.clearLogLines(); this.post('logs', { lines: [], time: logTimeNow() }); }
      else if (m.type === 'openOutput') { this.gateway.showOutput(); }
      else if (m.type === 'importLogin') { void vscode.commands.executeCommand('muse.importDesktopLogin'); }
      else if (m.type === 'openDashboard') { void vscode.commands.executeCommand('muse.openGatewayDashboard'); }
      else if (m.type === 'selectComputerWindow') { void this.selectComputerWindow().then((msg) => this.post('status', { text: msg })); }
    });
    this.postSessions();
    void this.refreshAccounts();
    if (this.history.length > 0) {
      void view.webview.postMessage({
        type: 'history',
        messages: this.history.map((h) => ({ role: h.role, text: typeof h.content === 'string' ? h.content : '' })),
      });
    }
    if (this.currentSession().importedFromWeb) {
      this.post('importedBanner', { text: 'Hội thoại này được đồng bộ từ web muse.ai. Lịch sử cũ nằm trên thread web, tin nhắn tiếp theo sẽ nối tiếp thread đó.' });
    }
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

  stop(): void { this.abort?.abort(); }

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
  private async attachFile(): Promise<void> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      title: 'Chọn tệp đính kèm vào chat Muse (ảnh, văn bản, video)',
    });
    if (!picked || picked.length === 0) { return; }
    const filePath = picked[0].fsPath;
    const name = path.basename(filePath);
    try {
      const size = fs.statSync(filePath).size;
      const ext = path.extname(filePath).toLowerCase();
      const imageExts = ['.png', '.jpg', '.jpeg', '.webp', '.gif'];
      const videoExts = ['.mp4', '.mov', '.webm', '.avi', '.mkv'];
      const textExts = ['.txt', '.md', '.markdown', '.json', '.jsonc', '.csv', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.cs', '.java', '.c', '.h', '.cpp', '.go', '.rs', '.rb', '.php', '.sql', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.sh', '.ps1', '.bat'];
      if (imageExts.includes(ext)) {
        const dataUrl = dataUrlOfImageFile(filePath);
        this.pendingAttachments.push({ name, size, kind: 'image', kindLabel: 'Ảnh', dataUrl });
      } else if (videoExts.includes(ext)) {
        const frame = await this.extractVideoFrame(filePath);
        if (frame) {
          this.pendingAttachments.push({ name, size, kind: 'video', kindLabel: 'Video (khung hình)', dataUrl: frame, note: `Đây là khung hình ở giây thứ 1 trích từ video ${name}. Gateway chat chỉ nhận ảnh và text nên video gốc không được gửi dưới dạng video.` });
        } else {
          this.pendingAttachments.push({ name, size, kind: 'file', kindLabel: 'Video', note: `Video ${name} (${Math.round(size / 1024)} KiB) chưa gửi được dưới dạng video vì gateway chat chỉ nhận ảnh và text, và máy này không có ffmpeg để trích khung hình. Hãy mô tả nội dung video hoặc đính kèm ảnh chụp khung hình thay thế.` });
        }
      } else {
        const buf = fs.readFileSync(filePath);
        const looksText = textExts.includes(ext) || (buf.length > 0 && !buf.includes(0));
        if (looksText) {
          const full = buf.toString('utf8');
          const limit = 500 * 1024;
          const text = full.length > limit ? full.slice(0, limit) + `\n[Đã cắt nội dung ở 500 KiB, tệp gốc ${Math.round(size / 1024)} KiB.]` : full;
          this.pendingAttachments.push({ name, size, kind: 'text', kindLabel: 'Văn bản', text });
        } else {
          this.pendingAttachments.push({ name, size, kind: 'file', kindLabel: 'Tệp', note: `Tệp ${name} (${Math.round(size / 1024)} KiB) là tệp nhị phân nên gateway chat không đọc được nội dung; chỉ gửi kèm tên và dung lượng để bạn mô tả thêm.` });
        }
      }
      const last = this.pendingAttachments[this.pendingAttachments.length - 1];
      this.post('attached', { name, size, kindLabel: last.kindLabel });
    } catch (e) {
      this.post('error', { text: `Không đính kèm được tệp: ${e instanceof Error ? e.message : String(e)}` });
    }
  }

  private extractVideoFrame(filePath: string): Promise<string | undefined> {
    return new Promise((resolve) => {
      const tmp = path.join(os.tmpdir(), `muse-frame-${crypto.randomUUID()}.png`);
      execFile('ffmpeg', ['-y', '-ss', '1', '-i', filePath, '-vframes', '1', '-q:v', '2', tmp], () => {
        try {
          if (!fs.existsSync(tmp)) { resolve(undefined); return; }
          const dataUrl = dataUrlOfImageFile(tmp);
          resolve(dataUrl);
        } catch { resolve(undefined); } finally { try { fs.unlinkSync(tmp); } catch { /* bỏ qua */ } }
      });
    });
  }

  private post(type: string, payload: Record<string, unknown> = {}): void {
    void this.view?.webview.postMessage({ type, ...payload });
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
  private async checkSessionAccount(gwConf: { baseUrl: string; apiKey: string }): Promise<'ok' | 'unknown' | 'loggedout' | 'cooling' | 'disabled'> {
    const session = this.currentSession();
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
  async run(userText: string): Promise<void> {
    if (this.running) { this.post('error', { text: 'Đang có một yêu cầu chạy. Bấm Dừng rồi gửi lại.' }); return; }
    const root = workspaceRoot();
    if (!root) {
      this.post('error', { text: 'Hãy mở một thư mục dự án trong VS Code trước (File > Open Folder), rồi gửi lại yêu cầu.' });
      return;
    }
    const conf = cfg();
    this.running = true;
    this.abort = new AbortController();
    const signal = this.abort.signal;
    // Trước vòng lặp agent: đảm bảo gateway đang chạy và lấy đúng
    // baseUrl/apiKey hiện tại (gateway chết thì tự khởi động lại; gateway
    // kèm theo dùng key do extension quản lý, không bắt buộc muse.apiKey).
    // Lỗi ở đây đã chứa hướng dẫn cụ thể nên hiển thị nguyên văn.
    let gwConf = conf;
    try {
      this.post('status', { text: 'Đang kiểm tra gateway…' });
      const gw = await this.gateway.ensureStarted();
      gwConf = { ...conf, baseUrl: gw.baseUrl, apiKey: gw.apiKey };
      this.post('status', { text: gw.mode === 'bundled' ? 'Gateway kèm theo đã sẵn sàng.' : 'Đã kết nối gateway sẵn có.' });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Panel Nhật ký (v0.6.0): lỗi gateway cũng vào buffer để xem
      // ngay trong khung chat, không chỉ trong Output channel.
      try { this.gateway.appendLogLine(`Lỗi gateway: ${msg}`); } catch { /* không chặn bubble lỗi */ }
      this.post('error', { text: `Lỗi gateway: ${msg}` });
      this.running = false;
      this.post('done', {});
      return;
    }
    // Gate đăng nhập lại: nếu tài khoản của session hiện tại đã hết hạn
    // hoặc logout thì KHÔNG gửi chat, hiện bubble yêu cầu đăng nhập lại
    // với nút Mở Cài đặt. Không tự gửi lại sau khi đăng nhập lại; user
    // tự gửi lại tin nhắn. Cooling/disabled chặn với lý do riêng.
    {
      const gate = await this.checkSessionAccount(gwConf);
      if (gate !== 'ok' && gate !== 'unknown') {
        const session = this.currentSession();
        const label = session.accountLabel || session.accountId || 'tài khoản của hội thoại này';
        const text = gate === 'loggedout'
          ? `Hội thoại này dùng tài khoản ${label} đã hết hạn hoặc đã đăng xuất. Tin nhắn này chưa được gửi. Hãy đăng nhập lại trong Cài đặt rồi gửi lại tin nhắn.`
          : gate === 'cooling'
            ? `Tài khoản ${label} của hội thoại này đang cooling. Tin nhắn này chưa được gửi. Bạn có thể chờ hết cooldown hoặc vào Cài đặt để xóa cooldown rồi gửi lại.`
            : `Tài khoản ${label} của hội thoại này đang tắt. Tin nhắn này chưa được gửi. Hãy vào Cài đặt để bật lại tài khoản rồi gửi lại.`;
        this.post('loginRequired', { text });
        this.running = false;
        this.postSessions();
        this.post('done', {});
        return;
      }
    }
    try {
      const attachments = this.pendingAttachments;
      this.pendingAttachments = [];
      if (attachments.length > 0) { this.post('attachmentsCleared', {}); }
      this.post('message', { role: 'user', text: attachments.length > 0 ? `${userText}\n[Đã đính kèm: ${attachments.map((a) => `${a.name} (${a.kindLabel})`).join(', ')}]` : userText });
      const textBlocks = [userText,
        ...attachments.filter((a) => a.kind === 'text').map((a) => `[Nội dung tệp đính kèm: ${a.name}]\n${a.text}`),
        ...attachments.filter((a) => a.note).map((a) => a.note as string)];
      const combinedText = textBlocks.filter((t) => t.length > 0).join('\n\n');
      const imageParts = attachments.filter((a) => a.dataUrl).map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl as string } }));
      const userContent: ChatContent = imageParts.length > 0
        ? [{ type: 'text', text: combinedText }, ...imageParts]
        : combinedText;
      const request: ChatMsg[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...this.history, { role: 'user', content: userContent }];
      let malformed = 0;
      for (let step = 0; step < conf.maxSteps; step++) {
        if (signal.aborted) { this.post('status', { text: 'Đã dừng.' }); break; }
        this.post('status', { text: `Đang suy nghĩ… (bước ${step + 1}/${conf.maxSteps})` });
        const reply = await this.chatOnce(gwConf, request, signal);
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
          if (this.lastStreamed) { this.post('streamFinal', { text: finalText, details: planner.raw || '' }); }
          else if (planner.raw) { this.post('message', { role: 'assistant', text: finalText, details: planner.raw }); }
          else { this.post('message', { role: 'assistant', text: finalText }); }
          this.post('status', { text: 'Xong.' });
          // Đặt tên session tự động từ tin đầu tiên nếu session vẫn đang
          // mang tên mặc định, để danh sách session đọc được ngay.
          if (this.history.length === 0) {
            const session = this.currentSession();
            if (session.title === 'Hội thoại mới' || session.title === 'Hội thoại 1') {
              session.title = userText.trim().slice(0, 40) || session.title;
              this.postSessions();
            }
          }
          this.history.push({ role: 'user', content: userText }, { role: 'assistant', content: finalText });
          if (this.history.length > 40) { this.history.splice(0, this.history.length - 40); }
          this.saveHistory();
          return;
        }
        const bad = calls.find((c) => c.name === '__parse_error__');
        if (bad) {
          malformed++;
          const err = str(bad.args.error, 'Định dạng tool sai.');
          this.post('status', { text: 'Muse gửi tool sai định dạng, đang yêu cầu gửi lại…' });
          if (malformed >= 3) { this.post('error', { text: `Dừng sau 3 phản hồi sai định dạng: ${err} Không thực thi thao tác nào từ các phản hồi lỗi.` }); return; }
          request.push({ role: 'user', content: `APP_PROTOCOL_REPAIR: ${err} Chỉ gửi lại MỘT thao tác nhỏ trong một code fence \`\`\`json. Không lặp lại lô đã bị từ chối.` });
          continue;
        }
        for (const call of calls) {
          if (signal.aborted) { break; }
          this.post('tool', { name: call.name, detail: describe(call) });
          this.lastComputerImage = undefined;
          const result = await this.execute(call, root, conf, signal);
          // Giống AgentLoop: nếu tool computer vừa trả ảnh screenshot thì
          // lượt tiếp theo gửi kèm ảnh đó dưới dạng image_url data URI.
          if (call.name.startsWith('computer_') && this.lastComputerImage) {
            request.push({
              role: 'user',
              content: [
                { type: 'text', text: `TOOL_RESULT ${call.name}:\n${result}` },
                { type: 'image_url', image_url: { url: this.lastComputerImage } },
              ],
            });
          } else {
            request.push({ role: 'user', content: `TOOL_RESULT ${call.name}:\n${result}` });
          }
          this.post('toolResult', { name: call.name, detail: truncate(result, 500) });
        }
      }
      this.post('error', { text: `Đã hết ${conf.maxSteps} bước tối đa mà yêu cầu chưa hoàn tất. Các bước đã thành công vẫn được giữ lại; hãy gửi tiếp yêu cầu nhỏ hơn.` });
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
      if (signal.aborted) { this.post('status', { text: 'Đã dừng.' }); }
      else if (msg.includes('no_account_available')) {
        // Lỗi 503 này nghĩa là pool gateway chưa có tài khoản khả dụng,
        // không phải lỗi key/cổng. Webview hiện nút hành động được thay vì
        // chỉ mã lỗi; việc nhập đăng nhập vẫn phải làm trên máy người dùng.
        this.post('accountError', { text: 'Gateway đã chạy nhưng chưa có tài khoản Muse nào khả dụng (lỗi no_account_available). Bạn chưa nhập đăng nhập vào gateway kèm theo, hoặc tài khoản đang cooling/invalid. Bấm một nút dưới đây, rồi gửi lại câu hỏi.' });
      } else if (msg.includes('upstream_response_unavailable') || msg.includes('stopped responding without a completed reply')) {
        // Lỗi 502 này khác 503/429: Muse web đã bắt đầu trả lời rồi dừng,
        // nhưng gateway không xác định được một phản hồi hoàn tất gắn với
        // yêu cầu này nên dừng chờ. Hội thoại được giữ nguyên, gateway
        // KHÔNG tự gửi lại. Đừng tạo session mới hay xóa lịch sử vì sẽ
        // mất ngữ cảnh; gửi tiếp một tin ngắn trong cùng session này.
        this.post('error', { text: 'Muse web đã bắt đầu trả lời rồi dừng mà gateway không xác định được phản hồi hoàn tất (lỗi 502 upstream_response_unavailable). Đây không phải hết lượt hay hết tài khoản. Hội thoại hiện tại vẫn được giữ nguyên và gateway không tự gửi lại, nên bạn đừng tạo hội thoại mới hay xóa lịch sử. Hãy gửi tiếp một tin ngắn trong cùng hội thoại này, ví dụ: "Bạn vừa dừng mà chưa trả lời xong, hãy trả lời lại ngắn gọn." Nếu lỗi lặp lại nhiều lần, kiểm tra Output > Muse Gateway (dòng local_reply_poll) và thử lại sau ít phút.' });
      } else {
        this.post('error', { text: `Lỗi: ${msg}` });
      }
    } finally {
      this.running = false;
      this.post('done', {});
    }
  }

  // Chat có streaming: gateway hỗ trợ stream:true theo SSE (xem Chat
  // trong Endpoints.cs: mỗi dòng "data: {chunk}" với
  // choices[0].delta.content, kết thúc bằng "data: [DONE]"). Extension
  // tích lũy toàn bộ văn bản để parse tool như cũ, đồng thời đẩy từng
  // delta ra webview để hiện dần. Nếu gateway trả về không phải SSE
  // (ví dụ lỗi JSON), rơi về đường parse JSON không-stream.
  private async chatOnce(conf: ReturnType<typeof cfg>, messages: ChatMsg[], signal: AbortSignal): Promise<string> {
    const url = `${conf.baseUrl.replace(/\/v1$/, '')}/v1/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (conf.apiKey) { headers.Authorization = `Bearer ${conf.apiKey}`; }
    this.lastStreamed = false;
    const resp = await fetch(url, {
      method: 'POST', headers, signal,
      body: JSON.stringify({ model: conf.model, messages, temperature: 0.2, stream: true, _muse_local_tools: true, user: this.conversationId }),
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
    this.post('streamStart', {});
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
                this.lastStreamed = true;
                this.post('streamDelta', { text: delta });
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

  // ---------------- Thực thi tool trong workspace ----------------
  private async execute(call: ToolCall, root: string, conf: ReturnType<typeof cfg>, signal: AbortSignal): Promise<string> {
    try {
      if (signal.aborted) { return 'Đã dừng trước khi thực thi.'; }
      if (COMPUTER_TOOLS.includes(call.name)) { return this.executeComputer(call, conf); }
      switch (call.name) {
        case 'list_files': {
          const rel = str(call.args.path, '.');
          const dir = this.resolve(root, rel);
          const recursive = call.args.recursive === true;
          const out: Array<{ path: string; type: string }> = [];
          const walk = (d: string, base: string): void => {
            for (const e of fs.readdirSync(d, { withFileTypes: true })) {
              if (e.isDirectory() && SKIP_DIRS.has(e.name)) { continue; }
              const full = path.join(d, e.name);
              const r = path.relative(root, full).split(path.sep).join('/');
              if (e.isDirectory()) { out.push({ path: r, type: 'dir' }); if (recursive && out.length < 500) { walk(full, r); } }
              else { out.push({ path: r, type: 'file' }); }
              if (out.length >= 500) { return; }
            }
          };
          if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) { return `Lỗi: thư mục không tồn tại: ${rel}`; }
          walk(dir, rel);
          return JSON.stringify(out);
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
        default:
          return `Lỗi: công cụ không hỗ trợ trong extension VS Code: ${call.name}`;
      }
    } catch (e) {
      return `Lỗi khi thực thi ${call.name}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  // ---------------- Điều khiển màn hình Windows thử nghiệm ----------------
  private async executeComputer(call: ToolCall, conf: ReturnType<typeof cfg>): Promise<string> {
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
      if (res.imageDataUrl) { this.lastComputerImage = res.imageDataUrl; }
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

function parseToolCalls(text: string): ToolCall[] {
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
    const map: Record<string, string> = { scan: 'list_files', inspect_text: 'read_file', inspect_texts: 'read_files', find_text: 'search_files', replace_text: 'edit_file', save_text: 'write_file', terminal: 'run_command', git_status: 'git_status', git_diff: 'git_diff' };
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
  const provider = new MuseChatProvider(context, gateway);
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
    vscode.commands.registerCommand('muse.newSession', () => {
      provider.newSession();
      void vscode.commands.executeCommand('muse.chat.focus');
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
