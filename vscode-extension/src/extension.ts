import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFile } from 'child_process';
import { GatewayManager, GatewayConfig, GatewayState } from './gateway';

// Muse cho VS Code, v0.2.0.
// Kiến trúc: extension này là GIAO DIỆN CHAT trong VS Code. Nó gọi gateway
// Muse2Api qua API tương thích OpenAI (/v1/chat/completions), rồi tự thực
// thi các tool cục bộ bằng API của VS Code / Node trong đúng workspace
// đang mở — cùng giao thức tool mà agent terminal Muse2Api.Agent dùng
// (khối ```json {"tool_calls": [...]} và khối ```tool legacy). Từ v0.2.0,
// gateway Muse2Api được đóng gói kèm theo extension (bin/win-x64) và tự
// chạy mỗi lần mở VS Code (activation onStartupFinished); nếu đã có
// gateway ngoài chạy sẵn ở cùng cổng thì extension dùng luôn gateway đó.
// Mọi thao tác ghi tệp / chạy lệnh đều hỏi duyệt trước, trừ khi người dùng
// bật muse.autoApprove. Lệnh chạy với quyền của người dùng và KHÔNG bị
// sandbox trong workspace, đúng như bản desktop đã cảnh báo.

interface ToolCall { name: string; args: Record<string, unknown>; }
interface ChatMsg { role: string; content: string; }

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
  'workdir, shell, timeout_seconds}, git_status {}, git_diff {}.',
  'Quy tắc: tệp đã có phải đọc trước khi sửa; edit_file yêu cầu old_text khớp',
  'đúng một lần; ưu tiên sửa nhỏ thay vì ghi đè toàn bộ; bỏ qua thư mục',
  'bin, obj, node_modules, .git khi duyệt/tìm; đường dẫn chỉ trong workspace,',
  'không dùng đường dẫn tuyệt đối ngoài workspace; lệnh không chờ nhập liệu,',
  'không chạy lệnh tương tác; một lệnh chỉ được coi là thành công khi',
  'exit_code = 0. Thao tác ghi tệp và chạy lệnh sẽ được extension hỏi người',
  'dùng duyệt trước khi thực thi; nếu bị từ chối thì tôn trọng, không thử',
  'lách bằng cách khác. Công cụ điều khiển màn hình (computer_*) và tiến',
  'trình nền (process_*) KHÔNG có trong VS Code — đừng dùng chúng.',
  'Sau mỗi kết quả công cụ, tiếp tục bước tiếp theo hoặc trả lời cuối.',
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
function truncate(text: string, max = 8000): string {
  return text.length > max ? text.slice(0, max) + `\n... (đã cắt, còn ${text.length - max} ký tự)` : text;
}

class MuseChatProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'muse.chat';
  private view?: vscode.WebviewView;
  private pendingPreset?: string;
  private running = false;
  private abort?: AbortController;
  private history: ChatMsg[] = [];

  constructor(private readonly context: vscode.ExtensionContext, private readonly gateway: GatewayManager) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')] };
    view.webview.html = this.html(view.webview);
    view.webview.onDidReceiveMessage((m: { type?: string; text?: string }) => {
      if (m.type === 'send' && m.text) { void this.run(m.text); }
      else if (m.type === 'stop') { this.abort?.abort(); }
      else if (m.type === 'openSettings') { void vscode.commands.executeCommand('workbench.action.openSettings', 'muse.'); }
    });
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
      this.post('error', { text: `Lỗi gateway: ${msg}` });
      this.running = false;
      this.post('done', {});
      return;
    }
    try {
      this.post('message', { role: 'user', text: userText });
      const request: ChatMsg[] = [{ role: 'system', content: SYSTEM_PROMPT }, ...this.history, { role: 'user', content: userText }];
      let malformed = 0;
      for (let step = 0; step < conf.maxSteps; step++) {
        if (signal.aborted) { this.post('status', { text: 'Đã dừng.' }); break; }
        this.post('status', { text: `Đang suy nghĩ… (bước ${step + 1}/${conf.maxSteps})` });
        const reply = await this.chatOnce(gwConf, request, signal);
        const calls = parseToolCalls(reply);
        request.push({ role: 'assistant', content: reply });
        if (calls.length === 0) {
          const finalText = reply.trim() || '(Muse không trả lời gì.)';
          this.post('message', { role: 'assistant', text: finalText });
          this.post('status', { text: 'Xong.' });
          this.history.push({ role: 'user', content: userText }, { role: 'assistant', content: finalText });
          if (this.history.length > 40) { this.history.splice(0, this.history.length - 40); }
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
          const result = await this.execute(call, root, conf, signal);
          request.push({ role: 'user', content: `TOOL_RESULT ${call.name}:\n${result}` });
          this.post('toolResult', { name: call.name, detail: truncate(result, 500) });
        }
      }
      this.post('error', { text: `Đã hết ${conf.maxSteps} bước tối đa mà yêu cầu chưa hoàn tất. Các bước đã thành công vẫn được giữ lại; hãy gửi tiếp yêu cầu nhỏ hơn.` });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (signal.aborted) { this.post('status', { text: 'Đã dừng.' }); }
      else {
        this.post('error', { text: `Lỗi: ${msg}` });
      }
    } finally {
      this.running = false;
      this.post('done', {});
    }
  }

  private async chatOnce(conf: ReturnType<typeof cfg>, messages: ChatMsg[], signal: AbortSignal): Promise<string> {
    const url = `${conf.baseUrl.replace(/\/v1$/, '')}/v1/chat/completions`;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (conf.apiKey) { headers.Authorization = `Bearer ${conf.apiKey}`; }
    const timeout = setTimeout(() => { /* gateway tự có timeout riêng; không abort sớm ở đây */ }, 11 * 60 * 1000);
    try {
      const resp = await fetch(url, {
        method: 'POST', headers, signal,
        body: JSON.stringify({ model: conf.model, messages, temperature: 0.2, stream: false, _muse_local_tools: true }),
      });
      const text = await resp.text();
      if (!resp.ok) { throw new Error(`Gateway trả HTTP ${resp.status}: ${truncate(text, 500)}`); }
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
    } finally { clearTimeout(timeout); }
  }

  // ---------------- Thực thi tool trong workspace ----------------
  private async execute(call: ToolCall, root: string, conf: ReturnType<typeof cfg>, signal: AbortSignal): Promise<string> {
    try {
      if (signal.aborted) { return 'Đã dừng trước khi thực thi.'; }
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
          if (!await this.approve(call, root, conf, `Chạy lệnh trong ${path.relative(root, workdir) || '.'}: ${command}\nLệnh chạy với quyền của bạn và không bị sandbox trong workspace.`)) {
            return 'Người dùng đã từ chối chạy lệnh. Không thử lại lệnh này.';
          }
          return await runShell(command, workdir, shell, num(call.args.timeout_seconds, conf.commandTimeout));
        }
        case 'git_status': return await runShell('git status --short', root, 'auto', 30);
        case 'git_diff': return await runShell('git diff --stat && git diff', root, 'auto', 30);
        default:
          if (call.name.startsWith('computer_')) { return 'Lỗi: công cụ điều khiển màn hình chỉ có trên app WinForms, không có trong extension VS Code.'; }
          if (call.name.startsWith('process_')) { return 'Lỗi: tiến trình nền chưa hỗ trợ trong extension v0.2.0; hãy dùng lệnh chạy tới khi xong thay vì chạy nền.'; }
          return `Lỗi: công cụ không hỗ trợ trong extension VS Code: ${call.name}`;
      }
    } catch (e) {
      return `Lỗi khi thực thi ${call.name}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  private resolve(root: string, rel: string): string {
    const clean = rel.replace(/\\/g, '/');
    const full = path.resolve(root, clean);
    if (full !== root && !full.startsWith(root + path.sep)) { throw new Error(`Đường dẫn ngoài workspace bị từ chối: ${rel}`); }
    return full;
  }

  private async approve(call: ToolCall, root: string, conf: ReturnType<typeof cfg>, detail: string, proposed?: string, target?: string): Promise<boolean> {
    if (conf.autoApprove || READ_ONLY_TOOLS.has(call.name)) { return true; }
    let viewed = false;
    for (;;) {
      const choices: string[] = ['Cho phép', 'Từ chối'];
      const canPreview = proposed !== undefined && target !== undefined && (call.name === 'write_file' || call.name === 'edit_file') && !viewed;
      if (canPreview) { choices.splice(1, 0, 'Xem diff'); }
      const pick = await vscode.window.showWarningMessage(`Muse muốn: ${detail}`, { modal: true }, ...choices);
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
    default: return call.name;
  }
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
      } catch (e) {
        void vscode.window.showErrorMessage(`Không khởi động lại được gateway: ${e instanceof Error ? e.message : String(e)}`);
      }
    }),
    vscode.commands.registerCommand('muse.importDesktopLogin', async () => {
      const msg = await gateway.importDesktopLogin();
      void vscode.window.showInformationMessage(msg);
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
  );
  // Tự chạy gateway ngay khi extension kích hoạt — kể cả khi kích hoạt do
  // onStartupFinished lúc mở VS Code, chưa bấm biểu tượng Muse. Không chặn
  // activation và không spam modal lúc khởi động: lỗi chỉ hiện ở status bar
  // và Output > Muse Gateway, và sẽ hiện lại trong khung chat khi gửi yêu cầu.
  void gateway.ensureStarted().catch(() => { /* đã báo qua status bar + output */ });
}

export function deactivate(): void {
  // Chỉ dừng gateway do chính instance này khởi động (GatewayManager.stop
  // không động tới gateway ngoài). Nếu cửa sổ này là cửa sổ đã khởi động
  // gateway kèm theo thì đóng cửa sổ sẽ dừng nó; cửa sổ khác có thể khởi
  // động lại khi gửi yêu cầu tiếp theo.
  void sharedGateway?.stop();
}
