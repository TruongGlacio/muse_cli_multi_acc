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
//   lần trong cùng session đang chạy thì lượt sau XẾP HÀNG, không bị
//   từ chối nữa — xem "Hàng đợi tin nhắn" dưới đây — tránh 2 run
//   chồng lên cùng một thread web). Slot giữ AbortController riêng
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

// Hàng đợi tin nhắn theo session (xem README, mục "Nhắn thêm trong
// lúc lượt trước đang chạy"): gửi trong lúc session đang chạy thì tin
// được CHẤP NHẬN và xếp hàng FIFO của đúng session đó — không chặn ô
// nhập, không chạy chồng lượt, không tự gửi tiếp mù sau lỗi/abort.
// Hàng sống trong RunManager (runtime) và được provider mirror bền qua
// session.pendingQueue (SessionStore). File này KHÔNG import 'vscode'
// nên toàn bộ API hàng đợi đều test được bằng harness Node thuần.
//
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

// Một tin nhắn đang chờ trong hàng của một session. Chỉ giữ text thuần:
// tệp đính kèm KHÔNG xếp hàng cùng tin nhắn (file base64 nhét vào
// globalState sẽ phình to, và đính kèm thuộc về bề mặt gốc nên dễ gán
// nhầm lượt) — gửi trong lúc đang chạy mà đang có tệp chờ thì provider
// từ chối rõ ràng bằng 'sendRejected' thay vì xếp hàng.
export interface QueuedItem {
  id: string;
  text: string;
  createdAt: number;
}

// Giới hạn tin chờ mỗi session: đủ cho một chùm nhắn thêm, đủ nhỏ để
// globalState không phình khi session có hàng bền. Vượt thì provider
// từ chối rõ ràng (không im lặng, không tràn).
export const MAX_QUEUE_PER_SESSION = 20;

// Kết quả một lượt chạy, theo góc nhìn của vòng drain trong provider:
// 'done'/'error'/'stopped' như cũ, thêm 'contended' (lượt trong hàng
// thua tryStart vì một bề mặt khác đã giành slot trước — đưa lại lên
// đầu hàng, không pause), 'early' (thoát trước khi giành slot vì không
// còn session — không đổi trạng thái hàng) và 'queued' (lượt gửi trực
// tiếp thua race tryStart nên đã tự xếp hàng — vòng drain không cần
// làm gì thêm).
export type QueueTurnOutcome = 'done' | 'error' | 'stopped' | 'contended' | 'early' | 'queued';

// Quyết định của afterTurn sau mỗi lượt, để provider chạy vòng drain:
// - run: chạy tiếp tin này ngay (đã lấy khỏi đầu hàng).
// - pause: dừng drain, giữ nguyên hàng (sau lỗi/abort) — user tự quyết
//   gửi tiếp hay xóa, không tự gửi tiếp mù.
// - idle: không còn gì để chạy, vòng drain kết thúc.
// - removed: lượt vừa abort vốn là tin trong hàng — đã gỡ bubble của
//   nó (không đưa lại vào hàng, không tự chạy lại), vòng drain kết
//   thúc (hàng đang pause).
export type QueueAfterTurn =
  | { action: 'run'; item: QueuedItem }
  | { action: 'pause' }
  | { action: 'idle' }
  | { action: 'removed'; item: QueuedItem };

// Validate hình dáng hàng đợi đọc từ session store (dữ liệu cũ/lỗi
// thì lọc bỏ từng mục, không vỡ toàn bộ hàng).
export function parseQueueItems(raw: unknown): QueuedItem[] {
  if (!Array.isArray(raw)) { return []; }
  const out: QueuedItem[] = [];
  for (const it of raw) {
    if (typeof it !== 'object' || it === null) { continue; }
    const rec = it as Record<string, unknown>;
    if (typeof rec.id !== 'string' || rec.id.length === 0) { continue; }
    if (typeof rec.text !== 'string') { continue; }
    out.push({ id: rec.id, text: rec.text, createdAt: typeof rec.createdAt === 'number' ? rec.createdAt : Date.now() });
  }
  return out;
}

export class RunManager {
  private slots = new Map<string, RunSlot>();
  private chains = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  private queues = new Map<string, QueuedItem[]>();
  private pausedQueues = new Set<string>();
  private queueSeq = 0;

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
  // (provider nhận null thì xếp hàng thay vì báo lỗi — xem enqueue).
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

  // --- Hàng đợi tin nhắn theo session ---

  // Xếp tin vào cuối hàng của session. Trả null khi hàng đã đầy
  // (provider từ chối rõ ràng bằng 'sendRejected', không im lặng).
  enqueue(sessionId: string, text: string): QueuedItem | null {
    const q = this.queues.get(sessionId) ?? [];
    if (q.length >= MAX_QUEUE_PER_SESSION) { return null; }
    const item: QueuedItem = { id: `q${++this.queueSeq}_${Date.now()}`, text, createdAt: Date.now() };
    q.push(item);
    this.queues.set(sessionId, q);
    return item;
  }

  // Đưa một tin (thường là tin vừa lỗi/thua race) lại lên ĐẦU hàng,
  // giữ nguyên thứ tự các tin còn lại.
  unshift(sessionId: string, item: QueuedItem): void {
    const q = this.queues.get(sessionId) ?? [];
    q.unshift(item);
    this.queues.set(sessionId, q);
  }

  // Bản sao hàng của session (không đưa tham chiếu sống ra ngoài để
  // bề mặt không sửa nhầm hàng).
  queueOf(sessionId: string): QueuedItem[] {
    return [...(this.queues.get(sessionId) ?? [])];
  }

  peekQueue(sessionId: string): QueuedItem | undefined {
    return this.queues.get(sessionId)?.[0];
  }

  // Lấy tin đầu hàng ra (vòng drain chạy nó ngay sau đó). Hàng rỗng
  // thì xóa key để queueOf/prune không giữ key chết.
  dequeue(sessionId: string): QueuedItem | undefined {
    const q = this.queues.get(sessionId);
    if (!q || q.length === 0) { return undefined; }
    const item = q.shift();
    if (q.length === 0) { this.queues.delete(sessionId); }
    return item;
  }

  // Xóa một tin khỏi hàng (user bấm ✕ trên bubble chờ). Trả false
  // khi id không còn (đã chạy hoặc đã xóa ở nơi khác) — im lặng.
  removeQueued(sessionId: string, id: string): boolean {
    const q = this.queues.get(sessionId);
    if (!q) { return false; }
    const idx = q.findIndex((it) => it.id === id);
    if (idx < 0) { return false; }
    q.splice(idx, 1);
    if (q.length === 0) { this.queues.delete(sessionId); }
    return true;
  }

  // Xóa toàn bộ hàng của session, kèm cờ pause của nó.
  clearQueue(sessionId: string): void {
    this.queues.delete(sessionId);
    this.pausedQueues.delete(sessionId);
  }

  pauseQueue(sessionId: string): void { this.pausedQueues.add(sessionId); }
  resumeQueue(sessionId: string): void { this.pausedQueues.delete(sessionId); }
  isQueuePaused(sessionId: string): boolean { return this.pausedQueues.has(sessionId); }

  // Khôi phục hàng đã lưu bền (từ session store) sau restart — CHỈ
  // khi hàng runtime đang trống, để bề mặt thứ hai không nhân đôi.
  // Hàng khôi phục chưa pause: sau restart không tự chạy lại, user gửi
  // tin mới sẽ resume drain từ đầu hàng (xem provider run()).
  restoreQueue(sessionId: string, items: QueuedItem[]): void {
    if ((this.queues.get(sessionId)?.length ?? 0) > 0) { return; }
    const valid = parseQueueItems(items);
    if (valid.length === 0) { return; }
    this.queues.set(sessionId, valid);
    this.pausedQueues.delete(sessionId);
  }

  // Bỏ hàng của mọi session không còn tồn tại (xóa/purge ở bất kỳ bề
  // mặt nào). Predicate do provider cấp (store.find), để hàm này vẫn
  // thuần và test được.
  pruneQueues(exists: (sessionId: string) => boolean): void {
    for (const id of [...this.queues.keys(), ...this.pausedQueues]) {
      if (!exists(id)) { this.clearQueue(id); }
    }
  }

  // Quyết định sau một lượt chạy, để vòng drain của provider chạy
  // tiếp hay dừng. currentItem là tin trong hàng mà lượt vừa chạy
  // thuộc về (null với lượt gửi trực tiếp — lượt đó không nằm trong
  // hàng nên lỗi/abort của nó không đưa lại gì).
  // - done: hàng đang chảy lại (xóa pause) rồi lấy tin đầu hàng chạy
  //   tiếp; hết hàng thì idle.
  // - error: pause, giữ nguyên hàng; tin lỗi thuộc hàng thì đưa lại
  //   lên đầu (không mất, không tự chạy lại).
  // - stopped (bấm Dừng): pause, giữ hàng còn lại; tin vừa abort
  //   thuộc hàng thì KHÔNG đưa lại (lượt đó đã thử) — provider gỡ
  //   bubble của nó qua 'queueRemoved'.
  // - contended: đưa lại lên đầu nhưng KHÔNG pause (chỉ thua race
  //   slot với bề mặt khác), vòng drain dừng để tránh quay vòng.
  // - early/queued: không đổi trạng thái hàng, vòng drain kết thúc.
  afterTurn(sessionId: string, outcome: QueueTurnOutcome, currentItem: QueuedItem | null): QueueAfterTurn {
    switch (outcome) {
      case 'done': {
        this.pausedQueues.delete(sessionId);
        const next = this.dequeue(sessionId);
        return next ? { action: 'run', item: next } : { action: 'idle' };
      }
      case 'error': {
        this.pausedQueues.add(sessionId);
        if (currentItem) { this.unshift(sessionId, currentItem); }
        return { action: 'pause' };
      }
      case 'stopped': {
        this.pausedQueues.add(sessionId);
        if (currentItem) { return { action: 'removed', item: currentItem }; }
        return { action: 'pause' };
      }
      case 'contended': {
        if (currentItem) { this.unshift(sessionId, currentItem); }
        return { action: 'idle' };
      }
      default:
        return { action: 'idle' };
    }
  }
}
