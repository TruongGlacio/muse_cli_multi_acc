// Điều khiển màn hình Windows THỬ NGHIỆM cho extension v0.3.
//
// Kiến trúc bắt buộc (không load DLL net10-windows vào Node): extension
// chỉ spawn helper console .NET riêng (Muse2Api.ComputerHelper.exe,
// win-x64 self-contained, nằm trong bin/win-x64/computer-helper/) và nói
// chuyện với nó bằng JSON-lines qua stdin/stdout. Helper giữ một
// DesktopComputer duy nhất trong suốt vòng đời tiến trình, nên các trạng
// thái có sẵn của bản desktop được giữ nguyên: cửa sổ đích đã chọn
// (Authorize), cache element từ computer_inspect (e0, e1…), snapshot
// ảnh + bounds cho computer_click (phải chụp ảnh mới trong 120 giây và
// cửa sổ không được di chuyển/resize).
//
// Giao thức (một dòng JSON mỗi request/response):
//   Request:  {"id":1,"tool":"computer_inspect","arguments":{...}}
//   Response: {"id":1,"ok":true,"result":"...","image_base64":"..."} hoặc
//             {"id":1,"ok":false,"error":"..."}
// Ngoài 14 tool computer_* của agent, helper còn có 2 lệnh điều khiển
// riêng (không phải tool của model): computer_select_window
// {handle, process_id, title} và computer_stop (Disarm).
//
// Giới hạn an toàn, không thỏa hiệp:
//  - Chỉ chạy trên Windows, chỉ khi muse.allowComputerControl = true
//    (mặc định false). Tắt hoặc không phải Windows thì trả lỗi rõ ràng,
//    hướng về app desktop, không giả vờ chạy.
//  - Helper thoát thì trạng thái chọn cửa sổ mất; lần gọi sau phải chọn
//    lại cửa sổ, extension báo rõ điều đó thay vì tự đoán cửa sổ cũ.

import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { spawn, ChildProcessWithoutNullStreams } from 'child_process';

export const COMPUTER_TOOLS = [
  'computer_list_windows', 'computer_inspect', 'computer_screenshot', 'computer_click',
  'computer_type', 'computer_key', 'computer_scroll', 'computer_invoke', 'computer_set_value',
  'computer_focus', 'computer_assert', 'computer_toggle', 'computer_select', 'computer_expand',
];

const DANGEROUS_TOOLS = new Set([
  'computer_click', 'computer_type', 'computer_key', 'computer_invoke',
  'computer_set_value', 'computer_toggle', 'computer_select', 'computer_expand', 'computer_scroll',
]);

interface HelperResponse { id: number; ok: boolean; result?: string; image_base64?: string; error?: string; }

export class ComputerHelper {
  private child?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = '';
  private pending = new Map<number, { resolve: (r: HelperResponse) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }>();
  private lastError?: string;
  selectedTitle?: string;

  constructor(private readonly context: vscode.ExtensionContext) {}

  helperPath(customPath: string): string | undefined {
    if (customPath.trim()) {
      return fs.existsSync(customPath.trim()) ? customPath.trim() : undefined;
    }
    const p = path.join(this.context.extensionPath, 'bin', 'win-x64', 'computer-helper', 'Muse2Api.ComputerHelper.exe');
    return fs.existsSync(p) ? p : undefined;
  }

  isAvailable(customPath: string): boolean {
    return process.platform === 'win32' && !!this.helperPath(customPath);
  }

  unavailableReason(customPath: string, allowControl: boolean): string {
    if (process.platform !== 'win32') {
      return 'Lỗi: điều khiển màn hình chỉ có trên Windows. Trên nền tảng này, hãy dùng app Muse desktop (WinForms) để điều khiển màn hình, extension VS Code không tự làm được.';
    }
    if (!allowControl) {
      return 'Lỗi: điều khiển màn hình đang TẮT trong extension (muse.allowComputerControl = false, mặc định). Đây là tính năng thử nghiệm, có thể bấm vào cửa sổ khác và gõ phím thật — chỉ bật khi bạn thực sự muốn thử, rồi chọn lại cửa sổ đích.';
    }
    if (!this.helperPath(customPath)) {
      return 'Lỗi: không tìm thấy helper điều khiển màn hình (bin/win-x64/computer-helper/Muse2Api.ComputerHelper.exe). Bản vsix này có thể thiếu helper; hãy cài lại bản 0.3.0 đầy đủ hoặc dùng app Muse desktop.';
    }
    return '';
  }

  private ensureStarted(customPath: string): void {
    if (this.child && !this.child.killed) { return; }
    const exe = this.helperPath(customPath);
    if (!exe) { throw new Error(this.unavailableReason(customPath, true)); }
    this.selectedTitle = undefined;
    this.lastError = undefined;
    const child = spawn(exe, [], { windowsHide: true });
    this.child = child;
    child.stdout.on('data', (d: Buffer) => {
      this.buffer += String(d);
      let idx: number;
      while ((idx = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, idx).trim();
        this.buffer = this.buffer.slice(idx + 1);
        if (!line) { continue; }
        try {
          const resp = JSON.parse(line) as HelperResponse;
          const entry = this.pending.get(resp.id);
          if (entry) { clearTimeout(entry.timer); this.pending.delete(resp.id); entry.resolve(resp); }
        } catch { /* bỏ qua dòng không phải JSON của helper */ }
      }
    });
    child.stderr?.on('data', (d: Buffer) => { this.lastError = String(d).slice(0, 500); });
    child.on('exit', () => {
      this.child = undefined;
      this.selectedTitle = undefined;
      for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(new Error('Helper điều khiển màn hình đã thoát giữa chừng. Trạng thái chọn cửa sổ đã mất; hãy chọn lại cửa sổ đích rồi thử lại.')); }
      this.pending.clear();
    });
  }

  stop(): void {
    try { this.child?.kill(); } catch { /* đã thoát */ }
    this.child = undefined;
    this.selectedTitle = undefined;
  }

  async call(customPath: string, tool: string, args: Record<string, unknown>): Promise<{ text: string; imageDataUrl?: string }> {
    this.ensureStarted(customPath);
    if (!this.child || !this.child.stdin) { throw new Error('Không khởi động được helper điều khiển màn hình.'); }
    const id = this.nextId++;
    const response = await new Promise<HelperResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('Helper điều khiển màn hình không trả lời sau 20 giây (bản desktop cũng giới hạn 12 giây cho mỗi thao tác UI). Cửa sổ đích có thể đã treo; hãy kiểm tra lại rồi thử lại.'));
      }, 20000);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin.write(JSON.stringify({ id, tool, arguments: args }) + '\n');
    });
    if (!response.ok) { throw new Error(response.error || 'Helper điều khiển màn hình báo lỗi không rõ nguyên nhân.'); }
    if (tool === 'computer_select_window' && typeof args.title === 'string') { this.selectedTitle = args.title; }
    if (tool === 'computer_stop') { this.selectedTitle = undefined; }
    const text = response.result || '';
    const imageDataUrl = response.image_base64 ? `data:image/jpeg;base64,${response.image_base64}` : undefined;
    return { text, imageDataUrl };
  }

  isDangerous(tool: string): boolean {
    return DANGEROUS_TOOLS.has(tool);
  }
}

export function describeComputerCall(tool: string, args: Record<string, unknown>): string {
  const el = typeof args.element_id === 'string' ? `element ${args.element_id}` : '';
  switch (tool) {
    case 'computer_list_windows': return 'Liệt kê các cửa sổ Windows đang mở (không chạm vào cửa sổ nào).';
    case 'computer_inspect': return 'Đọc cây UI của cửa sổ đích đã chọn (không bấm, không gõ).';
    case 'computer_screenshot': return 'Chụp ảnh cửa sổ đích đã chọn (đưa cửa sổ lên trước).';
    case 'computer_click': return `Bấm chuột tại (${String(args.x ?? '?')}, ${String(args.y ?? '?')}) trên ảnh chụp mới nhất${args.double_click ? ' (bấm đúp)' : ''}.`;
    case 'computer_type': return `Gõ văn bản vào ${el || 'ô nhập đã chọn'}: "${String(args.text || '').slice(0, 100)}".`;
    case 'computer_key': return `Nhấn phím "${String(args.key || '')}" vào cửa sổ đích.`;
    case 'computer_scroll': return `Cuộn ${String(args.direction || '')} trên ${el || 'phần tử đã chọn'}.`;
    case 'computer_invoke': return `Kích hoạt (invoke) ${el || 'phần tử đã chọn'}.`;
    case 'computer_set_value': return `Đặt giá trị cho ${el || 'phần tử đã chọn'} thành: "${String(args.text || '').slice(0, 100)}".`;
    case 'computer_focus': return 'Đưa cửa sổ đích lên trước.';
    case 'computer_assert': return `Kiểm tra ${el || 'phần tử'}: ${String(args.property || '')} ${String(args.match || '')} "${String(args.expected || '')}".`;
    case 'computer_toggle': return `Bật/tắt ${el || 'phần tử'} sang trạng thái ${String(args.state || '')}.`;
    case 'computer_select': return `Chọn ${el || 'mục đã chọn'}.`;
    case 'computer_expand': return `${args.expanded === false ? 'Thu gọn' : 'Mở rộng'} ${el || 'phần tử đã chọn'}.`;
    default: return tool;
  }
}

// Hỏi duyệt riêng cho từng hành động computer nguy hiểm, KỂ CẢ khi
// muse.autoApprove bật — đúng như yêu cầu của tính năng thử nghiệm.
export async function approveComputerAction(tool: string, args: Record<string, unknown>, selectedTitle?: string): Promise<boolean> {
  const detail = describeComputerCall(tool, args);
  const target = selectedTitle ? `Cửa sổ đích: ${selectedTitle}\n` : '';
  const pick = await vscode.window.showWarningMessage(
    `Muse (THỬ NGHIỆM) muốn điều khiển màn hình:\n${target}${detail}\nHành động này bấm/gõ thật vào Windows. Chỉ cho phép nếu bạn đang nhìn thấy đúng cửa sổ đích.`,
    { modal: true }, 'Cho phép hành động này', 'Từ chối',
  );
  return pick === 'Cho phép hành động này';
}
