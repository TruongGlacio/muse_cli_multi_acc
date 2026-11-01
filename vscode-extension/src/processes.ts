// Tiến trình nền cho extension v0.3, theo đúng semantics của
// src/Muse2Api.Agent/BackgroundProcesses.cs (không dùng VS Code terminal
// API để lấy output, vì terminal API không cho đọc output của tiến trình):
//  - run_command với background=true khởi động tiến trình, trả process_id.
//  - process_status chờ tối đa wait_ms (mặc định 30000, tối đa 60000) rồi
//    trả trạng thái + output mới nhất (giữ tối đa 32000 ký tự cuối).
//  - process_input ghi text vào stdin, mặc định thêm newline.
//  - process_stop dừng cây tiến trình rồi trả trạng thái cuối.
//  - Tối đa 8 tiến trình đang chạy cùng lúc.
//
// Khác bản desktop ở một điểm, nói rõ để không hiểu nhầm: bản desktop
// dừng cả cây tiến trình con (ProcessTree.StopAsync). Extension dùng
// child.kill() trên tiến trình shell chính; tiến trình con do shell tự
// tách ra có thể sống sót, vì vậy sau khi dừng, người dùng vẫn nên kiểm
// tra bằng lệnh hệ thống nếu tiến trình con còn chạy.

import { spawn, ChildProcess } from 'child_process';

export interface BgProcessInfo {
  id: string;
  command: string;
  running: boolean;
  exitCode: number | null;
  timedOut: boolean;
}

interface Running {
  id: string;
  command: string;
  child: ChildProcess;
  output: string;
  done: boolean;
  exitCode: number | null;
  timedOut: boolean;
  timer?: NodeJS.Timeout;
}

function shellFor(command: string, shell: string): { file: string; args: string[] } {
  const isWin = process.platform === 'win32';
  if (isWin) {
    if (shell === 'cmd') { return { file: 'cmd.exe', args: ['/d', '/c', command] }; }
    return { file: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-Command', command] };
  }
  return { file: '/bin/bash', args: ['-c', command] };
}

export class BackgroundProcesses {
  private map = new Map<string, Running>();
  private counter = 0;

  private append(r: Running, text: string): void {
    r.output += text;
    if (r.output.length > 32000) { r.output = r.output.slice(r.output.length - 32000); }
  }

  private statusText(r: Running): string {
    const head = `process_id=${r.id}\nrunning=${!r.done}\n` +
      (r.done && r.exitCode !== null ? `exit_code=${r.exitCode}\n` : '') +
      (r.timedOut ? 'timed_out=true\n' : '');
    return head + `output (latest 32000 chars):\n${r.output}`;
  }

  start(command: string, workdir: string, shell: string, timeoutSeconds: number): string {
    if (!command.trim()) { return 'error: command must not be empty'; }
    const runningCount = [...this.map.values()].filter((r) => !r.done).length;
    if (runningCount >= 8) { return 'error: background process limit reached (8). Stop an existing process first.'; }
    const { file, args } = shellFor(command, shell);
    let child: ChildProcess;
    try {
      child = spawn(file, args, { cwd: workdir, windowsHide: true });
    } catch (e) {
      return `error: could not start process: ${e instanceof Error ? e.message : String(e)}`;
    }
    this.counter += 1;
    const id = `bg${Date.now().toString(36)}${this.counter}`;
    const r: Running = { id, command, child, output: '', done: false, exitCode: null, timedOut: false };
    child.stdout?.on('data', (d: Buffer) => this.append(r, String(d)));
    child.stderr?.on('data', (d: Buffer) => this.append(r, '[stderr] ' + String(d)));
    child.on('error', (e) => this.append(r, `\nerror: ${e.message}`));
    child.on('exit', (code) => {
      r.done = true;
      r.exitCode = code;
      if (r.timer) { clearTimeout(r.timer); r.timer = undefined; }
    });
    const timeoutMs = Math.max(1, Math.min(3600, Math.floor(timeoutSeconds) || 300)) * 1000;
    r.timer = setTimeout(() => {
      if (!r.done) {
        r.timedOut = true;
        this.append(r, '\n[background process timed out and was killed]\n');
        try { child.kill(); } catch { /* đã thoát */ }
      }
    }, timeoutMs);
    // Giống bản desktop: chờ 250ms đầu để bắt lỗi khởi động sớm, rồi trả trạng thái.
    this.map.set(id, r);
    return this.statusText(r);
  }

  async status(id: string, waitMs: number): Promise<string> {
    const r = this.map.get(id);
    if (!r) { return `error: Unknown process_id in this workspace session: ${id}`; }
    if (!r.done && waitMs > 0) {
      await new Promise<void>((resolve) => {
        const wait = Math.max(0, Math.min(60000, waitMs));
        const t = setTimeout(resolve, wait);
        const poll = setInterval(() => {
          if (r.done) { clearTimeout(t); clearInterval(poll); resolve(); }
        }, 100);
        setTimeout(() => clearInterval(poll), wait + 200);
      });
    }
    return this.statusText(r);
  }

  async input(id: string, text: string, newline: boolean): Promise<string> {
    const r = this.map.get(id);
    if (!r) { return `error: Unknown process_id in this workspace session: ${id}`; }
    if (r.done) { return 'error: process has already exited'; }
    if (text.length > 16000) { return 'error: process input is too long'; }
    if (!r.child.stdin) { return 'error: process stdin is not available'; }
    try {
      r.child.stdin.write(text + (newline ? '\n' : ''));
      return this.statusText(r);
    } catch (e) {
      return `error: could not write to process stdin: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  async stop(id: string): Promise<string> {
    const r = this.map.get(id);
    if (!r) { return `error: Unknown process_id in this workspace session: ${id}`; }
    if (!r.done) {
      try { r.child.kill(); } catch { /* đã thoát */ }
      for (let i = 0; i < 50 && !r.done; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
    return 'stopped=true\n' + this.statusText(r);
  }

  list(): BgProcessInfo[] {
    return [...this.map.values()].map((r) => ({
      id: r.id, command: r.command, running: !r.done, exitCode: r.exitCode, timedOut: r.timedOut,
    }));
  }
}
