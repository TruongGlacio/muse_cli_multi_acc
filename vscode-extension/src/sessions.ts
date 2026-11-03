// Danh sách session DÙNG CHUNG cho sidebar và mọi tab chat (v0.8.0).
//
// Trước v0.8.0, MuseChatProvider giữ `sessions` làm trường riêng của
// chính nó, nên extension chỉ có đúng một khung chat (sidebar) với một
// currentSessionId, một history, một cờ running. Từ v0.8.0, mỗi bề mặt
// chat (sidebar + mỗi WebviewPanel) là một MuseChatProvider riêng, mỗi
// instance giữ trạng thái RIÊNG của nó (session đang mở, history, cờ
// running, abort, đính kèm, tiến trình nền) — nhưng tất cả cùng trỏ
// vào MỘT SessionStore này để danh sách session không phân mảnh:
// tạo/xóa/đổi tên session ở bề mặt nào thì các bề mặt khác đều nhận
// được thông báo và tự cập nhật (kể cả chuyển khỏi session vừa bị xóa
// thay vì kẹt ở session đã mất). Đóng một panel KHÔNG xóa session:
// panel chỉ là một khung nhìn, session vẫn nằm trong store và mở lại
// được bất cứ lúc nào.
//
// Store KHÔNG giữ history/conversationId/running: những thứ đó thuộc
// về từng bề mặt. Nó chỉ giữ mảng session (mỗi session chứa messages
// của chính nó) và việc lưu/tải globalState. Khi một bề mặt lưu, nó
// đồng bộ history của nó vào session đang mở TRƯỚC rồi mới gọi
// persist(); các bề mặt khác nhận notify và tự đọc lại messages từ
// session chung nếu chúng đang mở cùng session đó và không chạy.

import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { QueuedItem, parseQueueItems } from './runManager';

export interface ChatMsg { role: string; content: string | Array<Record<string, unknown>>; }

export interface ChatSession {
  id: string; title: string; conversationId: string; messages: ChatMsg[];
  createdAt: number; updatedAt: number; workspacePath?: string;
  accountId?: string; accountLabel?: string; accountStatusAtSave?: string;
  threadUrl?: string; importedFromWeb?: boolean;
  // v0.8.12: cờ tiêu đề sửa tay. Chỉ handler đổi tên mới đặt true;
  // session mới/import từ web mặc định false. persist() sao chép cả
  // session (...s) nên cờ này lưu cùng globalState như các trường khác;
  // parseSessions dưới đây đọc lại nó nên không mất khi tải lại.
  titleEditedManually?: boolean;
  // v0.8.27: kết quả run GẦN NHẤT của session (để danh sách hiện dấu
  // tích khi xong, dấu lỗi khi lỗi). Chỉ run() đặt/xóa: run mới bắt đầu
  // thì xóa (tích cũ không phải thành tích vĩnh viễn), run kết thúc
  // thành công thì 'done', kết thúc lỗi thì 'error', bị dừng thì không
  // đặt gì (giữ trạng thái trước đó). persist() sao chép cả session
  // nên trường này lưu cùng globalState; parseSessions đọc lại nó nên
  // tích của run đã xong vẫn còn sau khi extension host khởi động lại,
  // trong khi trạng thái 'running' sống (RunManager) thì mất theo
  // restart và về 'stopped' một cách trung thực.
  lastRunOutcome?: 'done' | 'error';
  // Hàng đợi tin nhắn của session (xem runManager.ts): bản mirror bền
  // của hàng runtime. Provider đồng bộ vào đây sau mỗi lần đổi hàng
  // rồi persist, nên chuyển session khác rồi quay lại, hay tải lại
  // webview, hay restart extension host, hàng vẫn còn. Chỉ lưu khi
  // hàng không rỗng (hàng rỗng thì bỏ trường để globalState gọn).
  // Sau restart hàng KHÔNG tự chạy lại — user gửi tin mới sẽ resume
  // drain từ đầu hàng (xem provider run()).
  pendingQueue?: QueuedItem[];
}

export interface StoreChange {
  deletedIds: string[];
  purgedAccountIds: string[];
}

export class SessionStore {
  sessions: ChatSession[] = [];
  private listeners = new Set<(change: StoreChange, source?: unknown) => void>();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly workspaceRoot: () => string | undefined,
  ) {
    // Logic tải/hợp nhất y nguyên từ constructor của provider cũ
    // (v0.4.0): globalState là nguồn chính, workspaceState của 0.3.3
    // chỉ hợp nhất một lần, lịch sử cũ thành một session nếu chưa có
    // session nào. Chuyển sang đây để mọi bề mặt dùng chung một lần
    // tải duy nhất, không tạo hai danh sách khác nhau.
    const parseSessions = (raw: Array<Record<string, unknown>>): ChatSession[] => {
      const out: ChatSession[] = [];
      for (const s of raw) {
        if (typeof s.id !== 'string' || typeof s.conversationId !== 'string' || !Array.isArray(s.messages)) { continue; }
        const messages = (s.messages as Array<Record<string, unknown>>)
          .filter((m) => typeof m.role === 'string' && typeof m.content === 'string')
          .map((m) => ({ role: m.role as string, content: m.content as string }))
          .slice(-40);
        const pendingQueue = parseQueueItems(s.pendingQueue);
        out.push({ id: s.id, title: typeof s.title === 'string' && s.title ? s.title : 'Hội thoại', conversationId: s.conversationId, messages, createdAt: typeof s.createdAt === 'number' ? s.createdAt : Date.now(), updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : Date.now(), workspacePath: typeof s.workspacePath === 'string' ? s.workspacePath : undefined, accountId: typeof s.accountId === 'string' && s.accountId ? s.accountId : undefined, accountLabel: typeof s.accountLabel === 'string' && s.accountLabel ? s.accountLabel : undefined, accountStatusAtSave: typeof s.accountStatusAtSave === 'string' ? s.accountStatusAtSave : undefined, threadUrl: typeof s.threadUrl === 'string' && s.threadUrl ? s.threadUrl : undefined, importedFromWeb: s.importedFromWeb === true, titleEditedManually: s.titleEditedManually === true, lastRunOutcome: s.lastRunOutcome === 'done' || s.lastRunOutcome === 'error' ? s.lastRunOutcome : undefined, pendingQueue: pendingQueue.length > 0 ? pendingQueue : undefined });
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
    // v0.8.2, việc 2d: danh sách được phép rỗng. Chỉ tạo session từ
    // lịch sử legacy khi legacy còn tin nhắn thật; legacy trống (kể cả
    // chỉ còn conversationId cũ) thì KHÔNG tạo "Hội thoại 1" — nếu tạo
    // thì lần khởi động sau sẽ làm sống lại danh sách user vừa xóa hết.
    if (parsed.length === 0) {
      const legacy = this.context.workspaceState.get<Array<{ role?: unknown; content?: unknown }>>('muse.chatHistory', [])
        .filter((m) => typeof m.role === 'string' && typeof m.content === 'string')
        .map((m) => ({ role: m.role as string, content: m.content as string }))
        .slice(-40);
      const legacyId = this.context.workspaceState.get<string>('muse.conversationId', '');
      const firstUser = legacy.find((m) => m.role === 'user');
      if (legacy.length === 0) {
        // Không tạo session nào: provider hiện trạng thái trống.
        this.sessions = parsed;
        return;
      }
      parsed.push({
        id: crypto.randomUUID(),
        title: firstUser ? String(firstUser.content).trim().slice(0, 40) || 'Hội thoại 1' : 'Hội thoại 1',
        conversationId: legacyId || crypto.randomUUID(),
        messages: legacy,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        workspacePath: this.workspaceRoot(),
      });
    }
    this.sessions = parsed;
  }

  savedCurrentSessionId(): string {
    return this.context.globalState.get<string>('muse.currentSessionId', '') || this.context.workspaceState.get<string>('muse.currentSessionId', '');
  }

  find(id: string): ChatSession | undefined {
    return this.sessions.find((s) => s.id === id);
  }

  persist(): void {
    const stored = this.sessions.map((s) => ({ ...s, messages: s.messages.slice(-40) }));
    void this.context.globalState.update('muse.sessions', stored);
  }

  addListener(fn: (change: StoreChange, source?: unknown) => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  notify(change: StoreChange, source?: unknown): void {
    // Gửi cho mọi bề mặt; bề mặt nguồn tự bỏ qua nhờ kiểm tra source,
    // các bề mặt khác cập nhật. Một bề mặt lỗi không vỡ các bề mặt khác.
    for (const fn of [...this.listeners]) {
      try { fn(change, source); } catch { /* bỏ qua */ }
    }
  }

  // Xóa một session khỏi danh sách chung. Người gọi tự chọn session
  // thay thế cho bề mặt của mình rồi mới notify, để các bề mặt khác
  // cũng chuyển khỏi session đã mất trong cùng một thông báo.
  removeSession(id: string): boolean {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.id !== id);
    if (this.sessions.length === before) { return false; }
    this.persist();
    return true;
  }

  // Xóa hoàn toàn theo tài khoản (v0.8.0, sau khi gateway purge đã
  // xóa pool + file browser session + mapping): xóa MỌI session của
  // extension có accountId đó, kèm lịch sử chat của chúng trong
  // extension. Trả số session đã xóa để hiện thông báo cụ thể.
  purgeAccountSessions(accountId: string): number {
    const before = this.sessions.length;
    this.sessions = this.sessions.filter((s) => s.accountId !== accountId);
    const removed = before - this.sessions.length;
    if (removed > 0) { this.persist(); }
    return removed;
  }
}
