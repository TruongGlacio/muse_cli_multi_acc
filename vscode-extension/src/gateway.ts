import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, execFile, ChildProcess } from 'child_process';
import * as crypto from 'crypto';

// GatewayManager — v0.2.0: chạy gateway Muse2Api kèm theo extension.
//
// Luồng ưu tiên (muse.gatewayMode, mặc định "auto"):
//   1. Nếu đã có gateway khỏe ở muse.baseUrl (app desktop, gateway chạy tay,
//      hoặc một cửa sổ VS Code khác đã khởi động trước) thì DÙNG LUÔN, không
//      khởi động thêm một tiến trình nữa trên cùng cổng.
//   2. Nếu chưa có gateway nào, khởi động binary kèm theo trong
//      bin/<nền tảng>/ (win-x64, osx-arm64; nền tảng khác báo rõ).
//   3. Nếu muse.gatewayMode = "external" thì không bao giờ tự khởi động,
//      chỉ kiểm tra gateway ngoài.
//
// v0.8.28: binary kèm theo là bản framework-dependent (không còn runtime
// .NET đóng gói kèm — máy user phải cài .NET 10 Runtime + ASP.NET Core
// Runtime, và WindowsDesktop Runtime trên Windows; thiếu runtime thì
// gateway thoát ngay và extension map output "framework not found" thành
// thông báo tiếng Việt kèm link tải Microsoft). Node của Playwright cũng
// không còn đóng gói trong vsix: extension tự phân giải node lúc chạy
// (PLAYWRIGHT_NODEJS_PATH → node hệ thống >= 20 → tải bản ghim v24.22.1
// về thư mục dữ liệu gateway sau khi user đồng ý) và đặt biến đó cho
// tiến trình gateway.
//
// v0.8.30: RÚT LẠI 0.8.28 — binary kèm theo trở lại self-contained như
// 0.8.27 (vsix đóng gói kèm runtime .NET, máy user khỏi cài runtime) và
// node của Playwright lại đóng gói trong vsix. Thứ tự phân giải node đổi
// thành: PLAYWRIGHT_NODEJS_PATH → node đóng gói sẵn trong vsix → node hệ
// thống >= 20 → node đã tải về → hỏi user rồi tải bản ghim. Luồng tải
// node chỉ chạy khi thật sự chưa có node nào (không còn chuyện vsix có
// node sẵn mà extension vẫn đi tải trùng).
//
// Key: nếu muse.apiKey trong Settings có giá trị thì dùng nó (cả cho gateway
// kèm theo lẫn gateway ngoài). Nếu để trống, key cho gateway kèm theo được
// tự sinh dạng m2a-... và lưu trong SecretStorage của VS Code, không ghi
// vào Settings, không in ra log. Gateway ngoài chạy sẵn mà không khớp key
// nào trong hai nguồn trên thì KHÔNG bị giết — chỉ báo lỗi key không khớp.
//
// Chromium: gateway driver "browser" cần một trình duyệt để mở muse.ai.
// Extension ưu tiên Edge/Chrome đã cài sẵn trên máy (truyền qua
// MUSE2API_CHROMIUM_PATH), vì đó là cách app desktop vẫn làm. Nếu không có
// trình duyệt hệ thống, gateway sẽ dùng Chromium của Playwright — lúc đó
// cần chạy lệnh "Muse: Cài Chromium cho gateway" một lần (chạy
// playwright.ps1 kèm theo binary).

export interface GatewayConfig {
  baseUrl: string;
  apiKey: string;
  gatewayMode: 'auto' | 'bundled' | 'external';
  gatewayPath: string;
}

export interface GatewayInfo {
  baseUrl: string;
  apiKey: string;
  mode: 'external' | 'bundled';
  port: number;
  dashboardUrl: string;
}

export type GatewayState = 'running' | 'starting' | 'stopped' | 'error';

// Kết quả kiểm tra trình duyệt cho gateway (v0.6.0, kiểm tra chủ động):
// system = Edge/Chrome hệ thống qua findChromium(); playwright = Chromium
// của Playwright đã cài trong thư mục ms-playwright; none = cả hai đều
// không có, gateway không mở được muse.ai.
export interface BrowserCheckResult {
  kind: 'system' | 'playwright' | 'none';
  systemPath?: string;
  playwrightPath?: string;
  label: string;
}

const SECRET_KEY = 'muse.gatewayApiKey';

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Che giá trị nhạy cảm trước khi đưa một dòng vào buffer log (v0.6.0):
// gateway không in cookie/key, nhưng nếu một dòng nào đó có dạng gán
// cookie/key/token/password/secret hay "Bearer ..." thì che giá trị,
// chỉ giữ tên trường. Xử lý đơn giản theo chuỗi, không parser phức tạp.
function redactLogLine(line: string): string {
  return line
    .replace(/((?:cookie|api[_-]?key|token|password|secret)\s*[:=]\s*)([^\s;]+)/gi, '$1***')
    .replace(/(Bearer\s+)[^\s]+/gi, '$1***');
}

async function fetchWithTimeout(url: string, init: RequestInit, ms: number): Promise<Response> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, { ...init, signal: ctrl.signal });
  } finally {
    clearTimeout(t);
  }
}

// ---------------- Node cho Playwright + runtime thiếu (v0.8.28, sửa ở v0.8.30) ----------------
// Từ 0.8.28, vsix KHÔNG còn đóng gói runtime .NET (gateway + helper đều
// framework-dependent) và KHÔNG còn đóng gói node của Playwright.
// Extension tự phân giải node lúc chạy theo thứ tự: PLAYWRIGHT_NODEJS_PATH
// (user đặt sẵn) → node hệ thống → tải bản ghim về thư mục dữ liệu gateway
// (chỉ sau khi user đồng ý, theo đúng quy tắc "không tải ngầm" của luồng
// cài Chromium). Bản ghim = đúng bản node mà Playwright 1.64.1 đóng gói
// sẵn (v24.22.1, đọc từ chuỗi version trong node.exe của gói cũ), thỏa yêu
// cầu engines "node >= 20" trong playwright-core 1.64.1. Playwright .NET
// 1.64.1 tôn trọng biến PLAYWRIGHT_NODEJS_PATH (chuỗi này có trong
// Microsoft.Playwright.dll và đã kiểm chứng thực nghiệm bằng driver thật:
// driver spawn đúng node được chỉ qua biến này, xem README 0.8.28).
// Từ 0.8.30, vsix lại đóng gói node của Playwright như 0.8.27 nên thứ tự
// phân giải thêm một nấc "bundled" ngay sau env, trước node hệ thống:
// env → bundled → hệ thống → đã tải → hỏi rồi tải. Nấc bundled chỉ nhận
// node đóng gói sẵn khi file tồn tại VÀ chạy ra version tương thích
// (>= 20); hỏng thì rơi xuống các nấc sau như cũ, không fail cứng.
export const PLAYWRIGHT_NODE_MIN_MAJOR = 20;
export const PINNED_NODE_VERSION = '24.22.1';
export const DOTNET_DOWNLOAD_URL = 'https://dotnet.microsoft.com/download/dotnet/10.0';

export interface NodeVersion { major: number; minor: number; patch: number; }

export function parseNodeVersion(output: string): NodeVersion | null {
  const m = /v?(\d+)\.(\d+)\.(\d+)/.exec(output || '');
  if (!m) { return null; }
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}

export function isNodeCompatible(v: NodeVersion | null): boolean {
  return !!v && v.major >= PLAYWRIGHT_NODE_MIN_MAJOR;
}

export interface NodeDownloadSpec { url: string; archiveName: string; exeRelPath: string; }

export function nodeDownloadSpec(platform: NodeJS.Platform, arch: string): NodeDownloadSpec | null {
  const v = PINNED_NODE_VERSION;
  if (platform === 'win32' && arch === 'x64') {
    return { url: `https://nodejs.org/dist/v${v}/node-v${v}-win-x64.zip`, archiveName: `node-v${v}-win-x64.zip`, exeRelPath: `node-v${v}-win-x64/node.exe` };
  }
  if (platform === 'darwin' && arch === 'arm64') {
    return { url: `https://nodejs.org/dist/v${v}/node-v${v}-darwin-arm64.tar.gz`, archiveName: `node-v${v}-darwin-arm64.tar.gz`, exeRelPath: `node-v${v}-darwin-arm64/bin/node` };
  }
  if (platform === 'darwin' && arch === 'x64') {
    return { url: `https://nodejs.org/dist/v${v}/node-v${v}-darwin-x64.tar.gz`, archiveName: `node-v${v}-darwin-x64.tar.gz`, exeRelPath: `node-v${v}-darwin-x64/bin/node` };
  }
  if (platform === 'linux' && arch === 'x64') {
    return { url: `https://nodejs.org/dist/v${v}/node-v${v}-linux-x64.tar.xz`, archiveName: `node-v${v}-linux-x64.tar.xz`, exeRelPath: `node-v${v}-linux-x64/bin/node` };
  }
  return null;
}

// Map output lỗi thiếu runtime của dotnet apphost thành thông báo tiếng
// Việt nêu rõ runtime nào thiếu + link tải chính thức + lệnh khởi động
// lại. Hai dạng output thật của apphost: (1) hoàn toàn không tìm thấy
// .NET ("You must install .NET to run this application" / ".NET location:
// Not found") — trường hợp phổ biến nhất với máy chưa cài .NET, lúc đó
// cần cả .NET Runtime + ASP.NET Core Runtime (+ WindowsDesktop trên
// Windows cho helper); (2) có runtime nhưng thiếu đúng framework/version
// ("The framework 'Microsoft.X.App', version ... was not found") — chỉ
// khớp khi output vừa nhắc tên framework vừa báo không tìm thấy, tránh
// dương tính giả với log nhắc tên framework khác.
export interface RuntimeMissingInfo { runtimes: string[]; message: string; }

export function mapRuntimeMissingError(output: string): RuntimeMissingInfo | null {
  if (!output) { return null; }
  let runtimes: string[] = [];
  if (/You must install \.NET to run this application/i.test(output) || /\.NET location:\s*Not found/i.test(output)) {
    runtimes = ['.NET 10 Runtime', 'ASP.NET Core Runtime 10', 'WindowsDesktop Runtime 10 (chỉ Windows)'];
  } else {
    const notFound = /was not found|not possible to find any compatible framework/i.test(output);
    if (!notFound) { return null; }
    if (/Microsoft\.NETCore\.App/i.test(output)) { runtimes.push('.NET 10 Runtime'); }
    if (/Microsoft\.AspNetCore\.App/i.test(output)) { runtimes.push('ASP.NET Core Runtime 10'); }
    if (/Microsoft\.WindowsDesktop\.App/i.test(output)) { runtimes.push('WindowsDesktop Runtime 10 (chỉ Windows)'); }
    if (runtimes.length === 0) { return null; }
  }
  const list = runtimes.join(', ');
  return {
    runtimes,
    message: `Gateway kèm theo không chạy được vì máy này thiếu runtime: ${list}. Hãy tải và cài runtime .NET 10 chính thức của Microsoft tại ${DOTNET_DOWNLOAD_URL} (trang này có đủ .NET Runtime, ASP.NET Core Runtime và WindowsDesktop Runtime cho Windows/macOS/Linux), cài xong thì dùng lệnh "Muse: Khởi động lại gateway" rồi gửi lại.`,
  };
}

export class GatewayManager {
  private child?: ChildProcess;
  private childPid?: number;
  private starting?: Promise<GatewayInfo>;
  private stopping = false;
  private lastLines: string[] = [];
  private state: GatewayState = 'stopped';
  private detail = 'Chưa khởi động';
  // Callback cho panel Nhật ký (v0.6.0): gọi cho mỗi dòng mới vào
  // buffer, để provider chat đẩy sang webview ngay khi dòng tới.
  // Provider đăng ký callback này; gateway không tự biết webview.
  // v0.8.0: onLog là callback ĐƠN (giữ để tương thích), nhưng sidebar
  // và mỗi tab chat đều cần nhận dòng log nên provider dùng
  // addLogListener (nhiều listener, mỗi bề mặt tự hủy đăng ký khi
  // panel đóng). Gán trực tiếp onLog sẽ GHI ĐÈ listener duy nhất cũ
  // và làm các bề mặt khác mất log, nên từ v0.8.0 không bề mặt nào
  // được gán onLog nữa — xem extension.ts.
  onLog?: (line: string) => void;
  private logListeners = new Set<(line: string) => void>();
  addLogListener(fn: (line: string) => void): () => void {
    this.logListeners.add(fn);
    return () => { this.logListeners.delete(fn); };
  }

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly output: vscode.OutputChannel,
    private readonly getConfig: () => GatewayConfig,
    private readonly onStatus: (state: GatewayState, detail: string) => void,
  ) {}

  getStatus(): { state: GatewayState; detail: string } {
    return { state: this.state, detail: this.detail };
  }

  isBundledRunning(): boolean {
    return !!this.child && !this.child.killed;
  }

  // ---------------- Địa chỉ, cổng, binary ----------------
  parseBaseUrl(): { origin: string; port: number; baseUrl: string } {
    const raw = (this.getConfig().baseUrl || 'http://127.0.0.1:18610/v1').replace(/\/+$/, '');
    const baseUrl = raw.endsWith('/v1') ? raw : `${raw}/v1`;
    try {
      const u = new URL(baseUrl);
      return { origin: `${u.protocol}//${u.host}`, port: Number(u.port) || 18610, baseUrl };
    } catch {
      return { origin: 'http://127.0.0.1:18610', port: 18610, baseUrl: 'http://127.0.0.1:18610/v1' };
    }
  }

  dataDir(): string {
    const dir = path.join(this.context.globalStorageUri.fsPath, 'gateway');
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  bundledBinaryPath(): string | undefined {
    const platform = process.platform;
    const arch = process.arch;
    let folder: string | undefined;
    let exe = 'Muse2Api';
    if (platform === 'win32') { folder = 'win-x64'; exe = 'Muse2Api.exe'; }
    else if (platform === 'linux' && arch === 'x64') { folder = 'linux-x64'; exe = 'Muse2Api'; }
    else if (platform === 'darwin' && arch === 'arm64') { folder = 'osx-arm64'; exe = 'Muse2Api'; }
    else if (platform === 'darwin' && arch === 'x64') { folder = 'osx-x64'; exe = 'Muse2Api'; }
    if (!folder) { return undefined; }
    const p = path.join(this.context.extensionPath, 'bin', folder, exe);
    return fs.existsSync(p) ? p : undefined;
  }

  bundledBinaryDir(): string | undefined {
    const bin = this.bundledBinaryPath();
    return bin ? path.dirname(bin) : undefined;
  }

  findChromium(): string | undefined {
    const envPath = process.env.MUSE2API_CHROMIUM_PATH;
    if (envPath && fs.existsSync(envPath)) { return envPath; }
    const candidates: string[] = [];
    if (process.platform === 'win32') {
      const roots = [process.env['ProgramFiles(x86)'], process.env.ProgramFiles, process.env.LOCALAPPDATA].filter(Boolean) as string[];
      for (const r of roots) {
        candidates.push(
          path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
          path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        );
      }
    } else if (process.platform === 'darwin') {
      candidates.push(
        '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        '/Applications/Chromium.app/Contents/MacOS/Chromium',
      );
    } else {
      candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable');
    }
    return candidates.find((p) => fs.existsSync(p));
  }

  // Chromium của Playwright (v0.6.0): Playwright .NET cài trình duyệt
  // vào thư mục ms-playwright (mặc định: Windows %LOCALAPPDATA%,
  // macOS ~/Library/Caches, Linux ~/.cache; hoặc PLAYWRIGHT_BROWSERS_PATH
  // nếu có). Quét thư mục này nhanh và không spawn process, đáng tin hơn
  // việc thử khởi động gateway rồi bắt lỗi — vì vậy kiểm tra chủ động
  // dùng cách này, không làm cả hai cách chồng chéo gây chậm khởi động.
  // Giới hạn: chỉ kiểm tra có file chạy Chromium hay không, không kiểm
  // tra đúng revision Playwright của gateway; nếu revision lệch thì
  // gateway vẫn thất bại và luồng hỏi cài khi thất bại sẽ bắt lại.
  findPlaywrightChromium(): string | undefined {
    const roots: string[] = [];
    const envRoot = process.env.PLAYWRIGHT_BROWSERS_PATH;
    if (envRoot) { roots.push(envRoot); }
    else if (process.platform === 'win32') {
      if (process.env.LOCALAPPDATA) { roots.push(path.join(process.env.LOCALAPPDATA, 'ms-playwright')); }
      if (process.env.USERPROFILE) { roots.push(path.join(process.env.USERPROFILE, 'AppData', 'Local', 'ms-playwright')); }
    } else if (process.platform === 'darwin') {
      if (process.env.HOME) { roots.push(path.join(process.env.HOME, 'Library', 'Caches', 'ms-playwright')); }
    } else if (process.env.HOME) {
      roots.push(path.join(process.env.HOME, '.cache', 'ms-playwright'));
    }
    const exeCandidates = process.platform === 'win32'
      ? ['chrome-win/chrome.exe', 'chrome-win/headless_shell.exe']
      : process.platform === 'darwin'
        ? ['chrome-mac/Chromium.app/Contents/MacOS/Chromium', 'chrome-mac/headless_shell']
        : ['chrome-linux/chrome', 'chrome-linux/headless_shell'];
    for (const root of roots) {
      if (!fs.existsSync(root)) { continue; }
      let entries: string[] = [];
      try { entries = fs.readdirSync(root); } catch { continue; }
      for (const entry of entries) {
        if (!entry.startsWith('chromium')) { continue; }
        for (const exe of exeCandidates) {
          const p = path.join(root, entry, exe);
          if (fs.existsSync(p)) { return p; }
        }
      }
    }
    return undefined;
  }

  // Kiểm tra trình duyệt chủ động (v0.6.0): tái dùng findChromium()
  // hiện có cho trình duyệt hệ thống, không viết lại danh sách đường dẫn.
  // Có Edge/Chrome hệ thống thì không cần Chromium Playwright.
  checkBrowser(): BrowserCheckResult {
    const system = this.findChromium();
    if (system) {
      const base = path.basename(system).toLowerCase();
      const name = base.includes('msedge') ? 'Edge hệ thống' : base.includes('chrome') ? 'Chrome hệ thống' : 'Chromium hệ thống';
      return { kind: 'system', systemPath: system, label: `Trình duyệt gateway: ${name} (${system})` };
    }
    const playwright = this.findPlaywrightChromium();
    if (playwright) {
      return { kind: 'playwright', playwrightPath: playwright, label: 'Trình duyệt gateway: Chromium của Playwright (đã cài)' };
    }
    return { kind: 'none', label: 'Trình duyệt gateway: Chưa có trình duyệt — bấm Cài Chromium cho gateway' };
  }

  // Dòng trạng thái trình duyệt cho panel Cài đặt. Gateway ngoài thì
  // trình duyệt nằm ở máy chạy gateway ngoài, extension không kiểm tra
  // hay cài ở máy VS Code nên báo rõ như vậy.
  browserStatusLabel(): string {
    if (this.getConfig().gatewayMode === 'external') {
      return 'Trình duyệt gateway: gateway ngoài tự lo trình duyệt ở máy chạy gateway đó (extension không kiểm tra/cài ở máy này)';
    }
    return this.checkBrowser().label;
  }

  // Cờ chống nag trong cùng phiên VS Code: mỗi lý do chỉ hỏi một lần.
  // "Để sau" ở lần khởi động không chặn lần hỏi lại khi gateway thất bại
  // thật vì thiếu trình duyệt (sự kiện thất bại mới, không phải nag),
  // và ngược lại; sang phiên VS Code sau thì hỏi lại bình thường.
  private browserStartupPromptDone = false;
  private browserFailurePromptDone = false;

  // Hỏi cài Chromium khi cả hai nguồn trình duyệt đều không có (v0.6.0).
  // KHÔNG tự tải ngầm: chỉ sau khi user bấm "Cài ngay" mới chạy
  // installBrowser() hiện có, cài xong thì tự khởi động lại gateway
  // (không bắt user chạy thêm lệnh). Có trình duyệt hệ thống thì hàm này
  // im lặng hoàn toàn, không hiện thông báo.
  async promptBrowserInstallIfMissing(reason: 'startup' | 'gatewayFailure'): Promise<void> {
    if (this.getConfig().gatewayMode === 'external') { return; }
    if (reason === 'startup' && this.browserStartupPromptDone) { return; }
    if (reason === 'gatewayFailure' && this.browserFailurePromptDone) { return; }
    if (this.checkBrowser().kind !== 'none') { return; }
    if (reason === 'startup') { this.browserStartupPromptDone = true; }
    else { this.browserFailurePromptDone = true; }
    const answer = await vscode.window.showWarningMessage(
      'Máy này chưa có Edge/Chrome và chưa có Chromium cho gateway nên gateway không mở được muse.ai. Bạn có muốn cài Chromium cho gateway ngay không? (Tải một lần, khoảng hơn 100 MB, cần PowerShell trên Windows.)',
      { modal: true }, 'Cài ngay', 'Để sau');
    if (answer !== 'Cài ngay') { return; }
    this.output.show(true);
    this.output.appendLine('[Muse] Đang cài Chromium cho gateway, vui lòng chờ…');
    const result = await this.installBrowserDetailed((line) => this.output.appendLine(line));
    if (!result.ok) {
      void vscode.window.showErrorMessage(`Cài Chromium thất bại: ${result.message} Hãy cài Edge hoặc Chrome rồi khởi động lại gateway.`);
      return;
    }
    try {
      await this.restart();
      void vscode.window.showInformationMessage('Đã cài Chromium cho gateway và khởi động lại gateway thành công.');
    } catch (e) {
      void vscode.window.showErrorMessage(`Đã cài Chromium nhưng khởi động lại gateway thất bại: ${e instanceof Error ? e.message : String(e)} Hãy dùng lệnh "Muse: Khởi động lại gateway".`);
    }
  }

  // ---------------- Kiểm tra sức khỏe ----------------
  async healthOk(origin: string): Promise<boolean> {
    try {
      const r = await fetchWithTimeout(`${origin}/healthz`, {}, 3000);
      return r.ok;
    } catch {
      return false;
    }
  }

  async keyOk(origin: string, apiKey: string): Promise<boolean> {
    if (!apiKey) { return false; }
    try {
      const r = await fetchWithTimeout(`${origin}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } }, 5000);
      return r.ok;
    } catch {
      return false;
    }
  }

  private async managedApiKey(): Promise<string> {
    const fromSettings = this.getConfig().apiKey.trim();
    if (fromSettings) { return fromSettings; }
    let key = await this.context.secrets.get(SECRET_KEY);
    if (!key) {
      key = 'm2a-' + crypto.randomBytes(18).toString('hex');
      await this.context.secrets.store(SECRET_KEY, key);
    }
    return key;
  }

  private setStatus(state: GatewayState, detail: string): void {
    this.state = state;
    this.detail = detail;
    this.onStatus(state, detail);
  }

  private log(line: string): void {
    const clean = redactLogLine(line.replace(/\r/g, '').trimEnd());
    if (!clean) { return; }
    this.output.appendLine(clean);
    this.pushLogLine(clean);
  }

  private pushLogLine(clean: string): void {
    this.lastLines.push(clean);
    if (this.lastLines.length > 1000) { this.lastLines.splice(0, this.lastLines.length - 1000); }
    this.onLog?.(clean);
    for (const fn of [...this.logListeners]) {
      try { fn(clean); } catch { /* một bề mặt lỗi không chặn log của bề mặt khác */ }
    }
  }

  // Panel Nhật ký (v0.6.0): cửa sổ xem 1000 dòng gần nhất. Trả bản sao
  // để webview không sửa được buffer thật.
  getLogLines(): string[] {
    return [...this.lastLines];
  }

  clearLogLines(): void {
    this.lastLines = [];
  }

  showOutput(): void {
    this.output.show(true);
  }

  // Ghi một dòng lỗi phía extension vào cùng buffer với log gateway:
  // ra OutputChannel với tiền tố [Muse] và gọi onLog như dòng gateway,
  // để panel log có lỗi ngay cả khi gateway stdout im lặng.
  appendLogLine(line: string): void {
    const clean = redactLogLine(line.replace(/\r/g, '').trimEnd());
    if (!clean) { return; }
    this.output.appendLine(`[Muse] ${clean}`);
    this.pushLogLine(clean);
  }

  private lastLogTail(): string {
    return this.lastLines.slice(-15).join('\n');
  }

  // ---------------- Khởi động / dừng ----------------
  async ensureStarted(): Promise<GatewayInfo> {
    if (this.starting) { return this.starting; }
    this.starting = this.ensureStartedInner();
    try {
      return await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  private async ensureStartedInner(): Promise<GatewayInfo> {
    const conf = this.getConfig();
    const { origin, port, baseUrl } = this.parseBaseUrl();

    if (this.isBundledRunning() && (await this.healthOk(origin))) {
      const key = await this.managedApiKey();
      this.setStatus('running', `Gateway kèm theo đang chạy (cổng ${port})`);
      return { baseUrl, apiKey: key, mode: 'bundled', port, dashboardUrl: `${origin}/dashboard` };
    }

    this.setStatus('starting', 'Đang kiểm tra gateway…');
    if (await this.healthOk(origin)) {
      // Đã có gateway ngoài (hoặc một cửa sổ VS Code khác đã khởi động).
      const candidates: string[] = [];
      if (conf.apiKey.trim()) { candidates.push(conf.apiKey.trim()); }
      const secret = await this.context.secrets.get(SECRET_KEY);
      if (secret && !candidates.includes(secret)) { candidates.push(secret); }
      for (const key of candidates) {
        if (await this.keyOk(origin, key)) {
          this.setStatus('running', `Đang dùng gateway sẵn có (cổng ${port})`);
          return { baseUrl, apiKey: key, mode: 'external', port, dashboardUrl: `${origin}/dashboard` };
        }
      }
      // Gateway chạy nhưng không có key nào khớp: không giết nó, báo rõ.
      const msg = `Đã có gateway chạy ở cổng ${port} nhưng key không khớp. Hãy dán đúng key của gateway đó vào muse.apiKey trong Settings, hoặc dừng gateway ngoài rồi gửi lại để extension tự chạy gateway kèm theo.`;
      this.setStatus('error', msg);
      throw new Error(msg);
    }

    if (conf.gatewayMode === 'external') {
      const msg = `Gateway chưa chạy ở ${origin} và muse.gatewayMode đang là "external" nên extension không tự khởi động. Hãy chạy gateway ngoài rồi gửi lại, hoặc đổi muse.gatewayMode sang "auto".`;
      this.setStatus('error', msg);
      throw new Error(msg);
    }

    const bin = conf.gatewayPath.trim() || this.bundledBinaryPath();
    if (!bin || !fs.existsSync(bin)) {
      const msg = `Không tìm thấy gateway kèm theo cho nền tảng ${process.platform}/${process.arch} (đã tìm ${bin || 'bin/<nền tảng>/Muse2Api'}). Bản 0.2.0 chỉ đóng gói sẵn cho Windows x64; trên nền tảng khác hãy chạy gateway ngoài và đặt muse.gatewayMode thành "external".`;
      this.setStatus('error', msg);
      throw new Error(msg);
    }

    const key = await this.managedApiKey();
    const dataDir = this.dataDir();
    const chromium = this.findChromium();
    // v0.8.28 (giữ ở 0.8.30): phải phân giải xong node mới khởi động
    // gateway kèm theo; không có node thì báo rõ ngay thay vì để gateway
    // chạy rồi driver mới vỡ giữa chừng. Từ 0.8.30 node đóng gói sẵn
    // trong vsix được ưu tiên nên máy cài vsix mới thường dừng ở nấc
    // bundled, không cần node hệ thống hay tải về.
    const nodeRes = await this.resolvePlaywrightNode();
    if (!nodeRes.ok) {
      const msg = `Gateway kèm theo cần Node để chạy driver Playwright nhưng ${nodeRes.message}. Hãy cài Node 20 trở lên rồi dùng lệnh "Muse: Khởi động lại gateway".`;
      this.setStatus('error', msg);
      throw new Error(msg);
    }
    this.log(`[Muse] Node cho Playwright: ${nodeRes.source} (${nodeRes.path})`);
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      MUSE2API_HOST: '127.0.0.1',
      MUSE2API_PORT: String(port),
      MUSE2API_DRIVER: 'browser',
      MUSE2API_DATA_DIR: dataDir,
      MUSE2API_API_KEY: key,
      MUSE2API_HEADLESS: 'true',
      PLAYWRIGHT_NODEJS_PATH: nodeRes.path,
      DOTNET_CLI_TELEMETRY_OPTOUT: '1',
      DOTNET_NOLOGO: '1',
    };
    if (chromium) { env.MUSE2API_CHROMIUM_PATH = chromium; }

    this.setStatus('starting', `Đang khởi động gateway kèm theo (cổng ${port})…`);
    // Các dòng khởi động này đi qua log() (v0.6.0) thay vì appendLine
    // trực tiếp như trước, để chúng cũng vào ring buffer và panel log.
    this.log(`[Muse] Khởi động gateway: ${bin}`);
    this.log(`[Muse] Cổng ${port}, dữ liệu tại ${dataDir}, trình duyệt: ${chromium || '(Playwright Chromium, nếu đã cài)'}`);
    this.stopping = false;
    const child = spawn(bin, [], { env, cwd: path.dirname(bin), windowsHide: true });
    this.child = child;
    this.childPid = child.pid;
    // v0.8.16: dòng nội dung prompt chẩn đoán (gateway phát dạng
    // "[local] web_prompt_body <dòng>") CHỈ ra Output, KHÔNG vào ring
    // buffer 1000 dòng và panel Nhật ký — nếu không prompt dài sẽ
    // tràn buffer một cách vô ích. Header web_prompt và dòng đường
    // dẫn file vẫn đi qua log() bình thường nên vẫn vào buffer/panel.
    // Dòng trống trong prompt vẫn in ra dòng trống (không qua trimEnd
    // của log()) để không lệch cấu trúc preview. Mẫu key-like trong
    // nội dung vẫn bị redactLogLine che như mọi dòng log khác.
    child.stdout?.on('data', (d: Buffer) => { for (const line of String(d).split('\n')) {
      if (line.startsWith('[local] web_prompt_body ')) {
        this.output.appendLine(redactLogLine(line.slice('[local] web_prompt_body '.length).replace(/\r$/, '')));
      } else if (line === '[local] web_prompt_body') {
        this.output.appendLine('');
      } else { this.log(line); }
    } });
    child.stderr?.on('data', (d: Buffer) => { for (const line of String(d).split('\n')) { this.log(line); } });
    child.on('exit', (code) => {
      const wasBundled = this.child === child;
      if (wasBundled) { this.child = undefined; this.childPid = undefined; }
      if (this.stopping) { return; }
      this.setStatus('error', `Gateway kèm theo đã thoát (mã ${code}). Xem Output > Muse Gateway để biết lý do, rồi dùng lệnh "Muse: Khởi động lại gateway".`);
    });

    const deadline = Date.now() + 45_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        const tail = this.lastLogTail();
        // v0.8.28: gateway framework-dependent thoát ngay vì thiếu runtime
        // thì báo rõ runtime nào + link tải, thay vì lỗi chung chung.
        const missing = mapRuntimeMissingError(tail);
        if (missing) {
          this.setStatus('error', missing.message);
          throw new Error(missing.message);
        }
        const browserMissing = tail.includes('Playwright Chromium') || tail.includes('playwright.ps1');
        if (browserMissing) {
          // Hỏi lại khi gateway thất bại thật vì thiếu trình duyệt
          // (sự kiện mới, không phải nag của lần hỏi lúc khởi động).
          // prompt tự im lặng nếu lúc này đã có trình duyệt.
          void this.promptBrowserInstallIfMissing('gatewayFailure');
        }
        const msg = `Gateway kèm theo thoát ngay khi khởi động (mã ${child.exitCode}). ${tail.includes('Playwright Chromium') || tail.includes('playwright.ps1')
          ? 'Nguyên nhân thường gặp: chưa có Chromium. Hãy chạy lệnh "Muse: Cài Chromium cho gateway" một lần, hoặc cài Edge/Chrome rồi khởi động lại gateway.'
          : `Xem Output > Muse Gateway để biết lý do. Log cuối:\n${tail}`}`;
        this.setStatus('error', msg);
        throw new Error(msg);
      }
      if (await this.healthOk(origin)) {
        this.setStatus('running', `Gateway kèm theo đang chạy (cổng ${port})`);
        return { baseUrl, apiKey: key, mode: 'bundled', port, dashboardUrl: `${origin}/dashboard` };
      }
      await sleep(500);
    }
    const msg = `Gateway kèm theo không trả lời /healthz sau 45 giây ở cổng ${port}. Xem Output > Muse Gateway rồi dùng lệnh "Muse: Khởi động lại gateway".`;
    this.setStatus('error', msg);
    throw new Error(msg);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.child;
    this.child = undefined;
    if (!child || child.killed) {
      this.setStatus('stopped', 'Gateway đã dừng');
      return;
    }
    const pid = child.pid;
    try { child.kill(); } catch { /* đã thoát */ }
    for (let i = 0; i < 30 && child.exitCode === null; i++) { await sleep(100); }
    if (child.exitCode === null && pid && process.platform === 'win32') {
      await new Promise<void>((resolve) => {
        execFile('taskkill', ['/PID', String(pid), '/T', '/F'], () => resolve());
      });
    }
    this.setStatus('stopped', 'Gateway đã dừng');
  }

  async restart(): Promise<GatewayInfo> {
    await this.stop();
    this.stopping = false;
    return this.ensureStarted();
  }

  // ---------------- Nhập đăng nhập từ app desktop ----------------
  // App desktop lưu accounts.json (DPAPI theo tài khoản Windows hiện tại)
  // tại %LOCALAPPDATA%\Muse2Api.WinForms\Gateway. Copy tệp đó sang thư mục
  // dữ liệu của gateway kèm theo trên cùng máy, cùng tài khoản Windows thì
  // gateway kèm theo đọc được ngay, không cần đăng nhập lại. Không bao giờ
  // xóa hay sửa dữ liệu của app desktop.
  async importDesktopLogin(): Promise<string> {
    if (process.platform !== 'win32') {
      return 'App Muse desktop chỉ có trên Windows nên không có dữ liệu đăng nhập để nhập trên nền tảng này.';
    }
    const localAppData = process.env.LOCALAPPDATA;
    if (!localAppData) { return 'Không tìm thấy thư mục LocalAppData trên máy này.'; }
    const candidates = [
      path.join(localAppData, 'Muse2Api.WinForms', 'Gateway', 'accounts.json'),
      path.join(localAppData, 'Muse2Api.WinForms-Preview-Net10', 'Gateway', 'accounts.json'),
    ];
    const src = candidates.find((p) => fs.existsSync(p));
    if (!src) {
      return 'Không tìm thấy đăng nhập của app Muse desktop (chưa thấy accounts.json trong LocalAppData). Hãy mở app Muse desktop và đăng nhập tài khoản Muse một lần, rồi chạy lại lệnh này.';
    }
    const wasRunning = this.isBundledRunning();
    if (wasRunning) { await this.stop(); }
    const destDir = this.dataDir();
    const dest = path.join(destDir, 'accounts.json');
    if (fs.existsSync(dest)) {
      fs.copyFileSync(dest, dest + `.bak-${Date.now()}`);
    }
    fs.copyFileSync(src, dest);
    return `Đã nhập đăng nhập từ app desktop (${src}) sang dữ liệu của gateway kèm theo. ${wasRunning ? 'Gateway sẽ được khởi động lại khi bạn gửi yêu cầu tiếp theo.' : 'Hãy dùng lệnh "Muse: Khởi động gateway" rồi gửi yêu cầu.'} Lưu ý: chỉ hoạt động trên cùng máy, cùng tài khoản Windows, vì cookie được mã hóa theo tài khoản đó.`;
  }

  // ---------------- Cài Chromium cho Playwright ----------------
  // Bản chi tiết (v0.6.0): luồng hỏi cài tự động cần biết cài thành công
  // hay không để tự khởi động lại gateway; lệnh palette cũ dùng wrapper
  // installBrowser() bên dưới nên hành vi tay không đổi.
  async installBrowserDetailed(onProgress: (line: string) => void): Promise<{ ok: boolean; message: string }> {
    const binDir = this.bundledBinaryDir() || (this.getConfig().gatewayPath.trim() ? path.dirname(this.getConfig().gatewayPath.trim()) : undefined);
    if (!binDir) { return { ok: false, message: 'Không tìm thấy thư mục gateway kèm theo để chạy playwright.ps1.' }; }
    const script = path.join(binDir, 'playwright.ps1');
    if (!fs.existsSync(script)) { return { ok: false, message: `Không tìm thấy ${script}. Hãy cài Edge hoặc Chrome rồi khởi động lại gateway thay vì dùng Chromium của Playwright.` }; }
    if (process.platform === 'win32') {
      const ps = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
      return await new Promise<{ ok: boolean; message: string }>((resolve) => {
        const child = spawn(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, 'install', 'chromium'], { cwd: binDir, windowsHide: false });
        child.stdout?.on('data', (d: Buffer) => onProgress(String(d)));
        child.stderr?.on('data', (d: Buffer) => onProgress(String(d)));
        child.on('exit', (code) => resolve(code === 0
          ? { ok: true, message: 'Đã cài Chromium cho gateway.' }
          : { ok: false, message: `Cài Chromium thất bại (mã ${code}).` }));
        child.on('error', (e) => resolve({ ok: false, message: `Không chạy được PowerShell để cài Chromium: ${e.message}.` }));
      });
    }
    // Linux/macOS: cần pwsh. Nếu không có pwsh, hướng dẫn cài trình duyệt hệ thống.
    return await new Promise<{ ok: boolean; message: string }>((resolve) => {
      const child = spawn('pwsh', ['-NoProfile', '-NonInteractive', '-File', script, 'install', 'chromium'], { cwd: binDir });
      child.stdout?.on('data', (d: Buffer) => onProgress(String(d)));
      child.stderr?.on('data', (d: Buffer) => onProgress(String(d)));
      child.on('exit', (code) => resolve(code === 0
        ? { ok: true, message: 'Đã cài Chromium cho gateway.' }
        : { ok: false, message: `Cài Chromium thất bại (mã ${code}).` }));
      child.on('error', () => resolve({ ok: false, message: 'Không tìm thấy pwsh trên máy này. Hãy cài Chromium hoặc Chrome hệ thống rồi khởi động lại gateway.' }));
    });
  }

  async installBrowser(onProgress: (line: string) => void): Promise<string> {
    const result = await this.installBrowserDetailed(onProgress);
    if (result.ok) { return 'Đã cài Chromium cho gateway. Hãy dùng lệnh "Muse: Khởi động lại gateway" rồi gửi yêu cầu.'; }
    return result.message.includes('Hãy cài') ? result.message : `${result.message} Hãy cài Edge hoặc Chrome rồi khởi động lại gateway.`;
  }

  // ---------------- Node cho Playwright (v0.8.28, sửa ở v0.8.30) ----------------
  // Gateway kèm theo chỉ chạy được khi extension phân giải xong node và
  // đặt PLAYWRIGHT_NODEJS_PATH cho tiến trình gateway. Thứ tự từ 0.8.30:
  // env → node đóng gói sẵn trong vsix → node hệ thống (>= 20) → node đã
  // tải về → hỏi user rồi tải bản ghim. Gateway ngoài tự lo node ở máy
  // chạy nó nên luồng này chỉ chạy cho gateway kèm theo.
  private nodeDownloadPromptDone = false;

  // Node đóng gói sẵn trong vsix (v0.8.30, như 0.8.27): nằm cùng thư mục
  // gateway, bin/<nền tảng>/.playwright/node/<thư mục nền tảng>/node(.exe).
  // Thư mục nền tảng của Playwright khác với RID của .NET (win32_x64 thay
  // vì win-x64, darwin-arm64 thay vì osx-arm64). Chỉ nhận khi file tồn
  // tại VÀ chạy ra version tương thích; hỏng thì trả undefined để các
  // nấc sau lo, không fail cứng.
  private async bundledNodePath(): Promise<string | undefined> {
    const binDir = this.bundledBinaryDir();
    if (!binDir) { return undefined; }
    let sub: string | undefined;
    let exe = 'node';
    if (process.platform === 'win32') { sub = 'win32_x64'; exe = 'node.exe'; }
    else if (process.platform === 'darwin' && process.arch === 'arm64') { sub = 'darwin-arm64'; }
    else if (process.platform === 'darwin' && process.arch === 'x64') { sub = 'darwin-x64'; }
    else if (process.platform === 'linux' && process.arch === 'x64') { sub = 'linux-x64'; }
    else if (process.platform === 'linux' && process.arch === 'arm64') { sub = 'linux-arm64'; }
    if (!sub) { return undefined; }
    const p = path.join(binDir, '.playwright', 'node', sub, exe);
    if (!fs.existsSync(p)) { return undefined; }
    const v = await this.nodeVersionAt(p);
    return isNodeCompatible(v) ? p : undefined;
  }

  private execFileText(cmd: string, args: string[], timeoutMs = 10000): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
        if (err) { reject(err); return; }
        resolve(String(stdout));
      });
    });
  }

  private async nodeVersionAt(nodePath: string): Promise<NodeVersion | null> {
    try {
      const out = await this.execFileText(nodePath, ['--version'], 10000);
      return parseNodeVersion(out);
    } catch { return null; }
  }

  private async findSystemNode(): Promise<string | undefined> {
    const locator = process.platform === 'win32' ? 'where' : 'which';
    try {
      const out = await this.execFileText(locator, ['node'], 10000);
      const first = out.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
      if (!first) { return undefined; }
      const v = await this.nodeVersionAt(first);
      return isNodeCompatible(v) ? first : undefined;
    } catch { return undefined; }
  }

  private downloadedNodeDir(): string {
    return path.join(this.dataDir(), 'node', PINNED_NODE_VERSION);
  }

  private async downloadedNodePath(): Promise<string | undefined> {
    const spec = nodeDownloadSpec(process.platform, process.arch);
    if (!spec) { return undefined; }
    const exe = path.join(this.downloadedNodeDir(), spec.exeRelPath);
    if (!fs.existsSync(exe)) { return undefined; }
    const v = await this.nodeVersionAt(exe);
    if (!v || `${v.major}.${v.minor}.${v.patch}` !== PINNED_NODE_VERSION) { return undefined; }
    return exe;
  }

  private spawnPromise(cmd: string, args: string[], opts: { cwd?: string; windowsHide?: boolean } = {}): Promise<{ code: number | null; error?: Error }> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, { ...opts });
      child.on('exit', (code) => resolve({ code }));
      child.on('error', (e) => resolve({ code: null, error: e }));
    });
  }

  private async downloadNode(): Promise<string> {
    const spec = nodeDownloadSpec(process.platform, process.arch);
    if (!spec) { throw new Error('Nền tảng này không có bản Node ghim sẵn.'); }
    const dir = this.downloadedNodeDir();
    fs.mkdirSync(dir, { recursive: true });
    const archive = path.join(dir, spec.archiveName);
    this.output.appendLine(`[Muse] Đang tải Node ${PINNED_NODE_VERSION} cho Playwright từ nodejs.org…`);
    const res = await fetch(spec.url);
    if (!res.ok) { throw new Error(`Tải Node thất bại (HTTP ${res.status}).`); }
    fs.writeFileSync(archive, Buffer.from(await res.arrayBuffer()));
    if (process.platform === 'win32') {
      const ps = process.env.SystemRoot ? path.join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe') : 'powershell.exe';
      const r = await this.spawnPromise(ps, ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archive}' -DestinationPath '${dir}' -Force`], { windowsHide: true });
      if (r.code !== 0) { throw new Error(`Giải nén Node thất bại (mã ${r.code}).`); }
    } else if (process.platform === 'darwin') {
      const r = await this.spawnPromise('tar', ['-xzf', archive, '-C', dir]);
      if (r.code !== 0) { throw new Error(`Giải nén Node thất bại (mã ${r.code}).`); }
    } else {
      const r = await this.spawnPromise('tar', ['-xJf', archive, '-C', dir]);
      if (r.code !== 0) { throw new Error(`Giải nén Node thất bại (mã ${r.code}).`); }
    }
    const exe = path.join(dir, spec.exeRelPath);
    if (!fs.existsSync(exe)) { throw new Error('Giải nén Node xong nhưng không thấy file chạy node.'); }
    if (process.platform !== 'win32') { try { fs.chmodSync(exe, 0o755); } catch { /* không chmod được vẫn thử chạy */ } }
    const v = await this.nodeVersionAt(exe);
    if (!v || `${v.major}.${v.minor}.${v.patch}` !== PINNED_NODE_VERSION) { throw new Error(`Node tải về không đúng bản ${PINNED_NODE_VERSION}.`); }
    try { fs.unlinkSync(archive); } catch { /* giữ archive cũng không sao */ }
    return exe;
  }

  async resolvePlaywrightNode(): Promise<{ ok: true; path: string; source: 'env' | 'bundled' | 'system' | 'downloaded' } | { ok: false; message: string }> {
    const envPath = process.env.PLAYWRIGHT_NODEJS_PATH;
    if (envPath && fs.existsSync(envPath)) { return { ok: true, path: envPath, source: 'env' }; }
    // v0.8.30: ưu tiên node đóng gói sẵn trong vsix khi có — nấc này phải
    // đứng trước node hệ thống và luồng tải, nếu không vsix có node sẵn
    // mà extension vẫn đi tải trùng về thư mục dữ liệu.
    const bundled = await this.bundledNodePath();
    if (bundled) { return { ok: true, path: bundled, source: 'bundled' }; }
    const system = await this.findSystemNode();
    if (system) { return { ok: true, path: system, source: 'system' }; }
    const downloaded = await this.downloadedNodePath();
    if (downloaded) { return { ok: true, path: downloaded, source: 'downloaded' }; }
    if (this.nodeDownloadPromptDone) {
      return { ok: false, message: 'chưa có Node tương thích và bạn đã chọn không tải Node lúc này' };
    }
    this.nodeDownloadPromptDone = true;
    if (!nodeDownloadSpec(process.platform, process.arch)) {
      return { ok: false, message: 'nền tảng này không có bản Node ghim sẵn để tải' };
    }
    const answer = await vscode.window.showWarningMessage(
      `Gateway cần Node để chạy driver Playwright nhưng máy này chưa có Node tương thích (cần Node 20 trở lên). Bạn có muốn extension tải Node ${PINNED_NODE_VERSION} về thư mục dữ liệu gateway ngay không? (Tải một lần, khoảng 25–35 MB, từ nodejs.org; hoặc bạn có thể tự cài Node 20+ rồi khởi động lại gateway.)`,
      { modal: true }, 'Tải ngay', 'Để sau');
    if (answer !== 'Tải ngay') {
      return { ok: false, message: 'chưa có Node tương thích và bạn đã chọn không tải Node lúc này' };
    }
    this.output.show(true);
    try {
      const p = await this.downloadNode();
      return { ok: true, path: p, source: 'downloaded' };
    } catch (e) {
      return { ok: false, message: `tải Node thất bại (${e instanceof Error ? e.message : String(e)})` };
    }
  }
}
