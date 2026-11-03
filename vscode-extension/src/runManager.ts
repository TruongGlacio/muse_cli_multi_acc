// RunManager (v0.8.27): trạng thái chạy DÙNG CHUNG cho mọi bề mặt chat
// (sidebar + các tab panel), key theo sessionId.
//
// Trước 0.8.27, mỗi provider surface giữ MỘT cờ `running` + MỘT
// `abort` của riêng nó, và switchSession/newSession/send đều TỪ CHỐI
// khi cờ đó bật — nên đang chạy hội thoại A mà chuyển sang B rồi quay
// lại A thì A mất tiến trình đang chạy. Từ 0.8.27, "đang chạy" là trạng
// thái của SESSION (sống trong RunManager này, tạo một lần ở activate
// và truyền vào mọi provider), không phải của bề mặt đang hiển thị:
// chuyển session chỉ đổi surface đang nhìn, không abort run cũ.
//
// Hai tầng tách bạch:
// - Slot chạy: mỗi session có tối đa MỘT run tại một thời điểm (gửi 2
//   lần trong cùng session đang chạy thì lượt sau bị từ chối, tránh 2
//   run chồng lên cùng một thread web). Slot giữ AbortController riêng
//   và live snapshot của lượt đang chạy để bề mặt nào mở session đó
//   giữa chừng cũng thấy đủ tiến trình trực tiếp (replay), không chỉ
//   lịch sử tĩnh đã lưu.
// - Hàng đợi theo tài khoản: gateway pool mặc định chỉ 1 request cùng
//   lúc cho mỗi tài khoản (ACCOUNT_MAX_CONCURRENCY=1, KHÔNG tự nâng
//   vì nguy cơ rate limit), nên RunManager chỉ phát tối đa MỘT gateway
//   stream tại một thời điểm cho mỗi accountId. Session đang chờ lượt
//   vẫn mang trạng thái 'running' (xoay tròn) — "đang thực hiện" theo
//   nghĩa toàn bộ công việc sẽ chạy tới kết quả mà không bị hủy khi
//   chuyển hội thoại, chứ không phải mọi session cùng chiếm web cùng
//   một giây. Tài khoản khác nhau thì chạy song song thật. Lượt chờ
//   được gọi gateway khi tới lượt nên không bao giờ chạm
//   PoolAcquireTimeout của gateway làm chết run đang xếp hàng.
//
// File này KHÔNG import 'vscode' để harness Node test được logic thuần
// mà không cần extension host. Trạng thái 'running' chỉ sống trong bộ
// nhớ: extension host khởi động lại thì RunManager mới không còn slot
// nào, nên session đang chạy dở về 'stopped' một cách trung thực (dấu
// tích 'done' của run đã hoàn thành thì nằm ở session.lastRunOutcome
// và được persist cùng session, nên vẫn còn sau restart).

export type RunOutcome = 'done' | 'error';

export type RunStatus = 'running' | 'done' | 'error' | 'stopped' | 'loggedout';

// Một bubble/sự kiện hiển thị của lượt đang chạy, đủ để bề mặt mở
// session giữa chừng replay lại tiến trình trực tiếp. Chỉ giữ lượt
// hiện tại; lượt kết thúc thì snapshot đi cùng slot, không giữ mãi.
export interface LiveBubble {
  kind: 'message' | 'tool' | 'toolResult';
  role?: string;
  text?: string;
  details?: string;
  name?: string;
  detail?: string;
}

export interface LiveSnapshot {
  bubbles: LiveBubble[];
  status: string;
  streamText: string;
  streaming: boolean;
}

export interface RunSlot {
  sessionId: string;
  accountId: string;
  abort: AbortController;
  live: LiveSnapshot;
}

// Ánh xạ trạng thái hiển thị cho một session trong danh sách (hàm thuần
// để test được): run đang sống thắng mọi thứ; tiếp theo là kết quả run
// gần nhất (tích/lỗi); còn lại giữ trạng thái tài khoản cũ
// (stopped/loggedout). Chạy mới xóa tích cũ ở tầng provider (xóa
// session.lastRunOutcome khi tryStart thành công) nên 'running' và
// 'done' không bao giờ cùng tồn tại cho một session.
export function computeRunStatus(
  isRunning: boolean,
  lastOutcome: RunOutcome | undefined,
  accountStatus: 'running' | 'stopped' | 'loggedout',
): RunStatus {
  if (isRunning) { return 'running'; }
  if (lastOutcome === 'done') { return 'done'; }
  if (lastOutcome === 'error') { return 'error'; }
  return accountStatus;
}

export class RunManager {
  private slots = new Map<string, RunSlot>();
  private chains = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();

  // Đăng ký fan-out khi trạng thái run đổi (tryStart/finish): provider
  // dùng để postSessions lại cho mọi bề mặt, nên spinner/tích cập nhật
  // trực tiếp cả khi user đang xem session khác. Trả hàm gỡ đăng ký.
  addStatusListener(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => { this.listeners.delete(fn); };
  }

  private notify(): void {
    for (const fn of [...this.listeners]) {
      try { fn(); } catch { /* listener lỗi không được vỡ run */ }
    }
  }

  isRunning(sessionId: string): boolean {
    return this.slots.has(sessionId);
  }

  getSlot(sessionId: string): RunSlot | undefined {
    return this.slots.get(sessionId);
  }

  // Giành slot chạy cho session. Trả null khi session đó đã có run
  // (lượt gửi sau trong cùng session bị từ chối, không chồng run).
  tryStart(sessionId: string, accountId: string): RunSlot | null {
    if (this.slots.has(sessionId)) { return null; }
    const slot: RunSlot = {
      sessionId,
      accountId,
      abort: new AbortController(),
      live: { bubbles: [], status: '', streamText: '', streaming: false },
    };
    this.slots.set(sessionId, slot);
    this.notify();
    return slot;
  }

  // Kết thúc slot (mọi kết cục: done/error/stopped đều qua đây).
  finish(sessionId: string): void {
    if (this.slots.delete(sessionId)) { this.notify(); }
  }

  // Dừng run của đúng session này, không đụng session khác. Trả false
  // khi session không có run đang sống (stop bấm thừa thì im lặng).
  abort(sessionId: string): boolean {
    const slot = this.slots.get(sessionId);
    if (!slot) { return false; }
    slot.abort.abort();
    return true;
  }

  // Ghi một sự kiện hiển thị vào live snapshot của lượt đang chạy.
  // Chỉ các sự kiện tạo bubble/trạng thái trực tiếp mới cần replay;
  // 'error'/'loginRequired'/'accountError'/'done' đều kết thúc lượt nên
  // không ghi (lượt kết thúc thì snapshot đi cùng slot).
  recordLive(sessionId: string, type: string, payload: Record<string, unknown>): void {
    const slot = this.slots.get(sessionId);
    if (!slot) { return; }
    const live = slot.live;
    const str = (v: unknown): string => (typeof v === 'string' ? v : '');
    if (type === 'message') {
      live.bubbles.push({ kind: 'message', role: str(payload.role) || undefined, text: str(payload.text), details: str(payload.details) || undefined });
    } else if (type === 'tool') {
      live.bubbles.push({ kind: 'tool', name: str(payload.name), detail: str(payload.detail) });
    } else if (type === 'toolResult') {
      live.bubbles.push({ kind: 'toolResult', name: str(payload.name), detail: str(payload.detail) });
    } else if (type === 'status') {
      live.status = str(payload.text);
    } else if (type === 'streamStart') {
      live.streaming = true;
      live.streamText = '';
    } else if (type === 'streamDelta') {
      live.streamText += str(payload.text);
    } else if (type === 'streamFinal') {
      live.streaming = false;
      live.streamText = '';
      live.bubbles.push({ kind: 'message', role: 'assistant', text: str(payload.text), details: str(payload.details) || undefined });
    }
  }

  // Bản sao snapshot để bề mặt mở session giữa chừng replay (không
  // đưa tham chiếu sống ra ngoài để bề mặt không sửa nhầm slot).
  snapshot(sessionId: string): LiveSnapshot | null {
    const slot = this.slots.get(sessionId);
    if (!slot) { return null; }
    return {
      bubbles: [...slot.live.bubbles],
      status: slot.live.status,
      streamText: slot.live.streamText,
      streaming: slot.live.streaming,
    };
  }

  // Chạy fn khi tới lượt của tài khoản này (FIFO theo accountId, tối đa
  // MỘT fn đang chạy cho mỗi tài khoản tại một thời điểm) và trả về
  // đúng kết quả của fn (generic để chatOnce trả về chuỗi reply).
  // Lượt chờ mà bị abort giữa chừng thì fn KHÔNG được gọi và
  // waitForTurn ném lỗi abort — tầng vòng lặp bắt theo signal.aborted
  // và báo 'Đã dừng.' như mọi đường abort khác. Lỗi của lượt trước
  // không chặn lượt sau (chuỗi luôn đi tiếp, finally vẫn release).
  async runExclusive<T>(accountId: string, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(accountId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    const chained = prev.then(() => current, () => current);
    this.chains.set(accountId, chained);
    try {
      await this.waitForTurn(prev, signal);
      if (signal.aborted) { throw new Error('aborted'); }
      return await fn();
    } finally {
      release();
      if (this.chains.get(accountId) === chained) { this.chains.delete(accountId); }
    }
  }

  // Chờ lượt của mình trong chuỗi. Ném lỗi abort khi signal bị hủy
  // trong lúc chờ (tầng vòng lặp bắt theo signal.aborted và báo
  // 'Đã dừng.' như mọi đường abort khác, không ghi thành lỗi chat).
  private waitForTurn(prev: Promise<void>, signal: AbortSignal): Promise<void> {
    if (signal.aborted) { return Promise.reject(new Error('aborted')); }
    return new Promise<void>((resolve, reject) => {
      const cleanup = (): void => { signal.removeEventListener('abort', onAbort); };
      const onAbort = (): void => { cleanup(); reject(new Error('aborted')); };
      const onDone = (): void => { cleanup(); resolve(); };
      signal.addEventListener('abort', onAbort, { once: true });
      prev.then(onDone, onDone);
    });
  }
}
