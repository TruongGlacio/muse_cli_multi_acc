// Quản lý tài khoản gateway cho extension v0.3.
//
// Căn cứ code thật trong src/Muse2Api/Endpoints.cs:
//  - GET /admin/status, GET /admin/accounts, POST /admin/accounts/{id}/reset,
//    POST /admin/accounts/{id}/renew, GET /admin/accounts/{id}/quota đều gọi
//    RequireAdmin, tức chỉ chấp nhận EffectiveAdminKey (xem Settings.cs:
//    AdminKey nếu có, nếu không thì ApiKey). Gateway kèm theo do extension
//    khởi động chỉ đặt MUSE2API_API_KEY, không đặt ADMIN_KEY, nên key do
//    extension quản lý chính là admin key cho gateway kèm theo. Với gateway
//    ngoài có ADMIN_KEY riêng, các lệnh này sẽ 401 và extension báo rõ.
//  - Account.Public() chỉ trả id, label, enabled, status, last_error,
//    cooldown_until và meta — KHÔNG bao giờ trả cookie. Module này cũng
//    chỉ giữ và hiển thị đúng các trường đó; không log, không lưu cookie.

export interface GatewayAccountSummary {
  id: string;
  label: string;
  enabled: boolean;
  status: string;
  lastError: string;
  cooldownUntil: number;
  // Hồ sơ Muse (v0.7.0, nullable): chỉ hiện trong panel Cài đặt, KHÔNG
  // bao giờ đưa vào khung chat, log hay thông báo. asAccount chỉ chọn
  // đúng các trường này, không bao giờ chuyển cookies sang webview.
  email: string | null;
  username: string | null;
  phone: string | null;
  // ID người dùng Muse (v0.8.5, nullable): UUID từ API phiên, khóa
  // định danh nội bộ, hiện ở panel Cài đặt để user đối chiếu.
  museUserId: string | null;
  // Các trường an toàn bổ sung cho panel đa tài khoản (v0.5.0). KHÔNG
  // bao gồm cookies (kể cả dạng đã che) hay meta: asAccount chỉ chọn
  // đúng các trường dưới đây, không bao giờ chuyển cookies sang webview.
  createdAt: number;
  lastUsedAt: number;
  successCount: number;
  failCount: number;
  // Chỉ ngày/giờ hết hạn cookie (unix giây), không tên/giá trị cookie:
  // settings.ts chỉ gửi mốc sớm nhất + số lượng sang webview.
  cookieExpires: Record<string, number>;
}

export interface GatewayStatusSummary {
  version: string;
  accounts: Record<string, unknown>;
  driverOk: boolean;
}

function apiBase(baseUrl: string): string {
  return baseUrl.replace(/\/v1$/, '').replace(/\/+$/, '');
}

async function adminFetch(baseUrl: string, apiKey: string, path: string, init: RequestInit = {}, notFoundMessage?: string): Promise<unknown> {
  const url = `${apiBase(baseUrl)}${path}`;
  const resp = await fetch(url, {
    ...init,
    headers: { ...(init.headers || {}), Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
  });
  const text = await resp.text();
  if (!resp.ok) {
    if (resp.status === 401) {
      throw new Error('Gateway từ chối quyền admin (HTTP 401). Với gateway kèm theo, key do extension quản lý phải khớp; với gateway ngoài có ADMIN_KEY riêng, hãy dùng dashboard của gateway đó thay vì lệnh này.');
    }
    if (resp.status === 404 && notFoundMessage) {
      throw new Error(notFoundMessage);
    }
    throw new Error(`Gateway trả HTTP ${resp.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error('Gateway trả về không phải JSON.');
  }
}

function asAccount(obj: Record<string, unknown>): GatewayAccountSummary {
  const expires: Record<string, number> = {};
  const rawExpires = obj.cookie_expires as Record<string, unknown> | undefined;
  if (rawExpires && typeof rawExpires === 'object') {
    for (const [k, v] of Object.entries(rawExpires)) {
      if (typeof v === 'number' && Number.isFinite(v)) { expires[k] = v; }
    }
  }
  return {
    id: String(obj.id || ''),
    label: String(obj.label || ''),
    email: typeof obj.email === 'string' && obj.email ? obj.email : null,
    username: typeof obj.username === 'string' && obj.username ? obj.username : null,
    phone: typeof obj.phone === 'string' && obj.phone ? obj.phone : null,
    museUserId: typeof obj.muse_user_id === 'string' && obj.muse_user_id ? obj.muse_user_id : null,
    enabled: obj.enabled === true,
    status: String(obj.status || ''),
    lastError: String(obj.last_error || obj.lastError || ''),
    cooldownUntil: typeof obj.cooldown_until === 'number' ? obj.cooldown_until : 0,
    createdAt: typeof obj.created_at === 'number' ? obj.created_at : 0,
    lastUsedAt: typeof obj.last_used_at === 'number' ? obj.last_used_at : 0,
    successCount: typeof obj.success_count === 'number' ? obj.success_count : 0,
    failCount: typeof obj.fail_count === 'number' ? obj.fail_count : 0,
    cookieExpires: expires,
  };
}

export async function fetchGatewayStatus(baseUrl: string, apiKey: string): Promise<GatewayStatusSummary> {
  const data = (await adminFetch(baseUrl, apiKey, '/admin/status')) as Record<string, unknown>;
  const accounts = (data.accounts || {}) as Record<string, unknown>;
  const driver = (data.driver || {}) as Record<string, unknown>;
  return { version: String(data.version || ''), accounts, driverOk: driver.ok === true };
}

export async function fetchGatewayAccounts(baseUrl: string, apiKey: string): Promise<GatewayAccountSummary[]> {
  const data = (await adminFetch(baseUrl, apiKey, '/admin/accounts')) as Record<string, unknown>;
  const arr = Array.isArray(data.data) ? data.data : [];
  return arr
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map(asAccount);
}

export async function resetGatewayAccount(baseUrl: string, apiKey: string, id: string): Promise<GatewayAccountSummary> {
  const data = (await adminFetch(baseUrl, apiKey, `/admin/accounts/${encodeURIComponent(id)}/reset`, { method: 'POST' })) as Record<string, unknown>;
  return asAccount((data.account || {}) as Record<string, unknown>);
}

export async function renewGatewayAccount(baseUrl: string, apiKey: string, id: string): Promise<{ ok: boolean; account: GatewayAccountSummary }> {
  const data = (await adminFetch(baseUrl, apiKey, `/admin/accounts/${encodeURIComponent(id)}/renew`, { method: 'POST' })) as Record<string, unknown>;
  return { ok: data.ok === true, account: asAccount((data.account || {}) as Record<string, unknown>) };
}

export async function patchGatewayAccount(baseUrl: string, apiKey: string, id: string, enabled: boolean): Promise<GatewayAccountSummary> {
  const data = (await adminFetch(baseUrl, apiKey, `/admin/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ enabled }) })) as Record<string, unknown>;
  return asAccount((data.account || {}) as Record<string, unknown>);
}

export async function patchGatewayAccountLabel(baseUrl: string, apiKey: string, id: string, label: string): Promise<GatewayAccountSummary> {
  const data = (await adminFetch(baseUrl, apiKey, `/admin/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ label }) })) as Record<string, unknown>;
  return asAccount((data.account || {}) as Record<string, unknown>);
}

export async function fetchGatewayAccountQuota(baseUrl: string, apiKey: string, id: string): Promise<Record<string, unknown>> {
  const data = (await adminFetch(baseUrl, apiKey, `/admin/accounts/${encodeURIComponent(id)}/quota`)) as Record<string, unknown>;
  const quota = data.quota;
  return quota && typeof quota === 'object' && !Array.isArray(quota) ? (quota as Record<string, unknown>) : {};
}

export interface BrowserLoginResult {
  loginId: string;
  status: string;
  account?: GatewayAccountSummary;
}

function asBrowserLogin(data: Record<string, unknown>): BrowserLoginResult {
  const account = data.account as Record<string, unknown> | undefined;
  return {
    loginId: String(data.login_id || ''),
    status: String(data.status || ''),
    account: account && typeof account === 'object' ? asAccount(account) : undefined,
  };
}

// Thông báo riêng cho 404 ở luồng đăng nhập qua trình duyệt (hotfix
// v0.6.0): gateway cũ không có endpoint này, khác với 401 (sai key)
// hay các lỗi admin khác nên không dùng thông điệp chung "HTTP 404".
const browserLoginNotFoundMessage = 'Gateway chưa có endpoint đăng nhập qua trình duyệt. Nếu bạn vừa cập nhật extension, hãy Khởi động lại gateway rồi thử lại; nếu đang dùng gateway ngoài cũ, hãy cập nhật gateway đó.';

export async function startBrowserLogin(baseUrl: string, apiKey: string, label?: string, accountId?: string): Promise<BrowserLoginResult> {
  const body: Record<string, string> = {};
  if (label) { body.label = label; }
  if (accountId) { body.accountId = accountId; }
  const data = (await adminFetch(baseUrl, apiKey, '/admin/login/browser/start', { method: 'POST', body: JSON.stringify(body) }, browserLoginNotFoundMessage)) as Record<string, unknown>;
  return asBrowserLogin(data);
}

export async function getBrowserLoginStatus(baseUrl: string, apiKey: string, id: string): Promise<BrowserLoginResult> {
  const data = (await adminFetch(baseUrl, apiKey, `/admin/login/browser/${encodeURIComponent(id)}/status`, {}, browserLoginNotFoundMessage)) as Record<string, unknown>;
  return asBrowserLogin(data);
}

export async function cancelBrowserLogin(baseUrl: string, apiKey: string, id: string): Promise<BrowserLoginResult> {
  const data = (await adminFetch(baseUrl, apiKey, `/admin/login/browser/${encodeURIComponent(id)}/cancel`, { method: 'POST' }, browserLoginNotFoundMessage)) as Record<string, unknown>;
  return asBrowserLogin(data);
}

export async function deleteGatewayAccount(baseUrl: string, apiKey: string, id: string): Promise<void> {
  await adminFetch(baseUrl, apiKey, `/admin/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

export interface PurgeGatewayAccountResult {
  deleted: string;
  browserSessionDeleted: boolean;
  mappingsDeleted: number;
}

// Xóa hoàn toàn (v0.8.0, DELETE /admin/accounts/{id}/purge): KHÁC
// với Đăng xuất (DELETE /accounts/{id}) — purge còn xóa file browser
// session và mọi mapping local-conversations của tài khoản đó trong
// gateway. KHÔNG xóa tài khoản trên muse.ai, KHÔNG đăng xuất app Muse
// desktop. Session trong extension do settings.ts xóa tiếp sau khi
// purge trả về (xem purgeAccountSessions trong extension.ts).
export async function purgeGatewayAccount(baseUrl: string, apiKey: string, id: string): Promise<PurgeGatewayAccountResult> {
  const data = (await adminFetch(baseUrl, apiKey, `/admin/accounts/${encodeURIComponent(id)}/purge`, { method: 'DELETE' },
    'Tài khoản này không còn trong pool của gateway (có thể đã bị xóa hoàn toàn trước đó).')) as Record<string, unknown>;
  return {
    deleted: String(data.deleted || id),
    browserSessionDeleted: data.browser_session_deleted === true,
    mappingsDeleted: typeof data.mappings_deleted === 'number' ? data.mappings_deleted : 0,
  };
}

// Chẩn đoán profile-refresh (v0.8.2): chỉ tên bước + cờ + số lượng,
// KHÔNG BAO GIỜ chứa email/phone.
export interface ProfileRefreshDebug {
  attempted: string[];
  succeeded: string[];
  failed: string[];
  finalUrl: string;
  menuOpened: boolean;
  settingsOpened: boolean;
  candidateCount: number;
  // v0.8.3: tên bước nguồn của giá trị (không chứa giá trị).
  emailSource?: string;
  usernameSource?: string;
  // v0.8.4: lý do bước home thất bại (chỉ tên loại, không giá trị).
  homeError?: string;
}

function asProfileDebug(obj: unknown): ProfileRefreshDebug | undefined {
  if (!obj || typeof obj !== 'object') { return undefined; }
  const d = obj as Record<string, unknown>;
  const arr = (v: unknown): string[] => Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  return {
    attempted: arr(d.attempted),
    succeeded: arr(d.succeeded),
    failed: arr(d.failed),
    finalUrl: typeof d.final_url === 'string' ? d.final_url : '',
    menuOpened: d.menu_opened === true,
    settingsOpened: d.settings_opened === true,
    candidateCount: typeof d.candidate_count === 'number' ? d.candidate_count : 0,
    emailSource: typeof d.email_source === 'string' ? d.email_source : undefined,
    usernameSource: typeof d.username_source === 'string' ? d.username_source : undefined,
    homeError: typeof d.home_error === 'string' ? d.home_error : undefined,
  };
}

// Hồ sơ tài khoản (v0.7.0, debug v0.8.2): cập nhật Email/Username/Phone
// best-effort cho một tài khoản, không cần đăng nhập lại. Trả về
// account mới + profileFound + debug. Email/phone trong kết quả này
// chỉ dùng trong panel Cài đặt, không log, không thông báo; debug
// không chứa email/phone nên được phép hiện trong thông báo chẩn đoán.
export async function refreshGatewayAccountProfile(baseUrl: string, apiKey: string, id: string): Promise<{ account: GatewayAccountSummary; profileFound: boolean; debug?: ProfileRefreshDebug }> {
  const data = (await adminFetch(baseUrl, apiKey, `/admin/accounts/${encodeURIComponent(id)}/profile-refresh`, { method: 'POST' })) as Record<string, unknown>;
  return { account: asAccount((data.account || {}) as Record<string, unknown>), profileFound: data.profile_found === true, debug: asProfileDebug(data.debug) };
}

// Nhập tay hồ sơ (v0.8.5): PATCH /admin/accounts/{id} với đúng trường
// user sửa (email/phone/username). Giá trị null = xóa trường đó.
// Gateway kiểm tra hợp lệ và trả 400 kèm lý do rõ khi không hợp lệ;
// adminFetch ném lỗi đó để extension hiện nguyên văn cho user.
export async function updateGatewayAccountProfile(baseUrl: string, apiKey: string, id: string, patch: { email?: string | null; phone?: string | null; username?: string | null }): Promise<GatewayAccountSummary> {
  const data = (await adminFetch(baseUrl, apiKey, `/admin/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) })) as Record<string, unknown>;
  return asAccount((data.account || {}) as Record<string, unknown>);
}

// Xóa mapping gateway của một session (v0.8.2, việc 2b): DELETE
// /admin/conversations/{hint}, hint = conversationId. Trả true nếu
// file mapping đã xóa, false nếu file vốn không có. Lỗi HTTP thì ném
// để extension báo rõ "mapping gateway chưa xóa được".
export async function deleteGatewayConversation(baseUrl: string, apiKey: string, hint: string): Promise<boolean> {
  const data = (await adminFetch(baseUrl, apiKey, `/admin/conversations/${encodeURIComponent(hint)}`, { method: 'DELETE' },
    'Gateway chưa có endpoint xóa mapping hội thoại (gateway cũ).')) as Record<string, unknown>;
  return data.mapping_deleted === true;
}

// Tìm chủ sở hữu mapping (v0.8.2, việc 3): GET
// /admin/conversations/by-hint/{hint} trả Public của tài khoản sở hữu.
// 404 (không có mapping / tài khoản không còn trong pool) thì ném lỗi
// để caller giữ nguyên "Chưa xác định", không chặn chat.
export async function fetchConversationOwner(baseUrl: string, apiKey: string, hint: string): Promise<GatewayAccountSummary> {
  const data = (await adminFetch(baseUrl, apiKey, `/admin/conversations/by-hint/${encodeURIComponent(hint)}`, {},
    'Không tìm thấy mapping cho hội thoại này (chưa từng chat qua gateway hoặc mapping đã mất).')) as Record<string, unknown>;
  return asAccount((data.account || {}) as Record<string, unknown>);
}

export interface MergeDuplicatesResult {
  merged: Array<{ primaryId: string; primaryLabel: string; mergedIds: string[]; identity: string }>;
  skipped: string[];
}

// Gộp tài khoản trùng (v0.7.0): chỉ gọi sau khi user xác nhận trong
// panel Cài đặt. Trả về các nhóm đã gộp để extension đổi accountId của
// session mình sang tài khoản chính.
export async function mergeGatewayDuplicates(baseUrl: string, apiKey: string): Promise<MergeDuplicatesResult> {
  const data = (await adminFetch(baseUrl, apiKey, '/admin/accounts/merge-duplicates', { method: 'POST' })) as Record<string, unknown>;
  const merged = Array.isArray(data.merged) ? data.merged : [];
  const skipped = Array.isArray(data.skipped) ? data.skipped : [];
  return {
    merged: merged
      .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
      .map((x) => ({
        primaryId: String(x.primaryId || ''),
        primaryLabel: String(x.primaryLabel || ''),
        mergedIds: Array.isArray(x.mergedIds) ? x.mergedIds.map((v) => String(v)) : [],
        identity: String(x.identity || ''),
      })),
    skipped: skipped.map((v) => String(v)),
  };
}

// Đồng bộ hội thoại từ web, mức 1 (v0.6.0): chỉ danh sách + đăng ký
// mapping, không nhập nội dung tin nhắn cũ.
export interface WebThread { url: string; title: string; }

export interface WebThreadsPageDebug { pageUrl: string; threadCount: number; linkCount: number; title: string; hasLoginForm: boolean; buttonCount: number; sidebarClicked: boolean; }
export interface WebThreadsDebug { pageUrl: string; linkCount: number; threadCount: number; pages?: WebThreadsPageDebug[]; }

export interface WebThreadsResult { threads: WebThread[]; debug?: WebThreadsDebug; }

// Đồng bộ web (v0.7.0, điểm 4): gateway trả thêm debug (chỉ số lượng,
// không nội dung trang hay tiêu đề nhạy cảm) để thông báo "Đã thêm 0"
// nêu rõ được lỗi ở khâu nào.
// v0.8.12: forceTitles=true thêm ?forceTitles=true để gateway thăm dò
// nút sidebar bất kể quét link được bao nhiêu thread (xem ListWebThreads
// phía gateway); không có tham số thì giữ hành vi cũ.
export async function fetchWebThreads(baseUrl: string, apiKey: string, id: string, forceTitles?: boolean): Promise<WebThreadsResult> {
  const suffix = forceTitles ? '?forceTitles=true' : '';
  const data = (await adminFetch(baseUrl, apiKey, `/admin/accounts/${encodeURIComponent(id)}/web-threads${suffix}`, { method: 'POST' })) as Record<string, unknown>;
  const arr = Array.isArray(data.data) ? data.data : [];
  const threads = arr
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && typeof x.url === 'string')
    .map((x) => ({ url: x.url as string, title: typeof x.title === 'string' ? x.title : '' }));
  const d = data.debug as Record<string, unknown> | undefined;
  const pagesRaw = Array.isArray(d?.pages) ? (d?.pages as Record<string, unknown>[]) : [];
  const pages: WebThreadsPageDebug[] = pagesRaw
    .filter((p) => typeof p === 'object' && p !== null)
    .map((p) => ({
      pageUrl: typeof p.pageUrl === 'string' ? p.pageUrl : '',
      threadCount: typeof p.threadCount === 'number' ? p.threadCount : 0,
      linkCount: typeof p.linkCount === 'number' ? p.linkCount : 0,
      title: typeof p.title === 'string' ? p.title : '',
      hasLoginForm: p.hasLoginForm === true,
      buttonCount: typeof p.buttonCount === 'number' ? p.buttonCount : 0,
      sidebarClicked: p.sidebarClicked === true,
    }));
  const debug: WebThreadsDebug | undefined = d && typeof d === 'object'
    ? { pageUrl: typeof d.pageUrl === 'string' ? d.pageUrl : '', linkCount: typeof d.linkCount === 'number' ? d.linkCount : 0, threadCount: typeof d.threadCount === 'number' ? d.threadCount : threads.length, pages: pages.length > 0 ? pages : undefined }
    : undefined;
  return { threads, debug };
}

// Lấy lịch sử một thread web (v0.8.8, hợp đồng endpoint do phía
// gateway thực hiện): POST /admin/accounts/{id}/thread-messages,
// body {"url": "<thread url>"}, RequireAdmin; trả {"data":
// [{"role": "user"|"assistant", "content": "..."}], "title": "<title
// đã làm sạch hoặc null>", "count": <n>}. Title null nghĩa là
// gateway không lấy được tiêu đề thật (ví dụ tiêu đề chung) — phía
// extension giữ nguyên tiêu đề dự phòng như cũ, không ghi đè.
export interface ThreadMessage { role: 'user' | 'assistant'; content: string; }
export interface ThreadMessagesResult { messages: ThreadMessage[]; title: string | null; count: number; }

export async function fetchThreadMessages(baseUrl: string, apiKey: string, accountId: string, url: string): Promise<ThreadMessagesResult> {
  const data = (await adminFetch(baseUrl, apiKey, `/admin/accounts/${encodeURIComponent(accountId)}/thread-messages`, { method: 'POST', body: JSON.stringify({ url }) },
    'Gateway chưa có endpoint lấy lịch sử thread web (gateway cũ).')) as Record<string, unknown>;
  const arr = Array.isArray(data.data) ? data.data : [];
  const messages = arr
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && (x.role === 'user' || x.role === 'assistant') && typeof x.content === 'string')
    .map((x) => ({ role: x.role as 'user' | 'assistant', content: x.content as string }));
  return {
    messages,
    title: typeof data.title === 'string' && data.title.trim() ? data.title.trim() : null,
    count: typeof data.count === 'number' ? data.count : messages.length,
  };
}

// Quy tắc cập nhật title thread web (v0.8.8, hàm thuần để test đơn
// vị trực tiếp từ out/admin.js): CHỈ ghi đè khi title hiện tại đúng
// dạng dự phòng "Hội thoại web <id>" (id lấy từ threadUrl) VÀ title
// mới là tiêu đề thật (khác null/rỗng, khác chính dạng dự phòng đó,
// không phải tiêu đề chung "Chat"/"Muse"). Trả title mới (cắt 80 ký
// tự như syncFromWeb) hoặc null = giữ nguyên: không ghi đè title từ
// anchor text, không ghi đè title user đã sửa tay.
export function threadIdFromWebUrl(url: string): string {
  const noQuery = url.split(/[?#]/)[0].replace(/\/+$/, '');
  const idx = noQuery.indexOf('/thread/');
  return idx >= 0 ? noQuery.slice(idx + '/thread/'.length) : noQuery;
}

export function fallbackWebTitle(threadUrl: string): string {
  return `Hội thoại web ${threadIdFromWebUrl(threadUrl)}`;
}

export function isFallbackWebTitle(title: string, threadUrl: string): boolean {
  return !!threadUrl && title === fallbackWebTitle(threadUrl);
}

export function resolveWebTitle(currentTitle: string, threadUrl: string, fetchedTitle: string | null | undefined): string | null {
  if (!fetchedTitle) { return null; }
  const fresh = fetchedTitle.trim();
  if (!fresh) { return null; }
  if (fresh.toLowerCase() === 'chat' || fresh.toLowerCase() === 'muse') { return null; }
  if (!isFallbackWebTitle(currentTitle, threadUrl)) { return null; }
  if (fresh === fallbackWebTitle(threadUrl)) { return null; }
  return fresh.slice(0, 80);
}

// Quy tắc cập nhật title thread web, bản nới lỏng v0.8.12 (hàm thuần để
// test đơn vị trực tiếp từ out/admin.js). Hàm cũ resolveWebTitle được
// GIỮ NGUYÊN để không làm vỡ hành vi cũ một cách im lặng; các đường
// đồng bộ/mở hội thoại từ 0.8.12 dùng hàm mới này.
// - Title mới phải là thật: đã trim, khác rỗng, khác "Chat"/"Muse",
//   khác chính dạng dự phòng của thread đó, khác title hiện tại
//   (bằng nhau thì không có gì để đổi, trả null để khỏi đếm oan).
// - Session có cờ sửa tay thì KHÔNG BAO GIỜ bị ghi đè tự động, kể cả
//   ở chế độ ép buộc (force chỉ ép session import từ web chưa sửa tay).
// - Chế độ thường: chỉ ghi đè khi title hiện tại là dự phòng
//   "Hội thoại web <id>", rỗng, "Hội thoại mới" hoặc "Hội thoại 1".
//   Title anchor trông như thật nhưng sai thì chế độ thường KHÔNG đổi,
//   phải dùng lệnh ép buộc.
// - Chế độ ép buộc: ghi đè mọi title hiện tại (trừ sửa tay) khi title
//   mới là thật; caller vẫn phải tự giới hạn ép buộc cho session
//   import từ web (xem syncFromWeb).
export function resolveWebTitleUpdated(
  currentTitle: string,
  threadUrl: string,
  fetchedTitle: string | null | undefined,
  opts?: { titleEditedManually?: boolean; force?: boolean },
): string | null {
  if (opts?.titleEditedManually) { return null; }
  if (!fetchedTitle) { return null; }
  const fresh = fetchedTitle.trim();
  if (!fresh) { return null; }
  if (fresh.toLowerCase() === 'chat' || fresh.toLowerCase() === 'muse') { return null; }
  if (fresh === fallbackWebTitle(threadUrl)) { return null; }
  if (fresh === currentTitle) { return null; }
  if (opts?.force) { return fresh.slice(0, 80); }
  const current = (currentTitle || '').trim();
  if (isFallbackWebTitle(currentTitle, threadUrl) || current === '' || current === 'Hội thoại mới' || current === 'Hội thoại 1') {
    return fresh.slice(0, 80);
  }
  return null;
}

// Bộ lọc hiển thị hội thoại theo tài khoản (v0.8.8, hàm thuần):
// 'all' (hoặc rỗng) hiện tất cả; tài khoản cụ thể chỉ hiện session
// có accountId đúng bằng nó — session không có accountId (cũ, trước
// 0.5.0) vì vậy chỉ hiện khi chọn "Tất cả tài khoản". Chỉ lọc hiển
// thị, không đổi logic mở/xóa theo từng session.
export function sessionMatchesAccountFilter(accountId: string | undefined, filter: string): boolean {
  if (!filter || filter === 'all') { return true; }
  return accountId === filter;
}

export async function registerConversation(baseUrl: string, apiKey: string, accountId: string, hint: string, url: string): Promise<void> {
  await adminFetch(baseUrl, apiKey, '/admin/conversations/register', { method: 'POST', body: JSON.stringify({ accountId, hint, url }) });
}

export async function fetchRegisteredConversationUrls(baseUrl: string, apiKey: string): Promise<string[]> {
  const data = (await adminFetch(baseUrl, apiKey, '/admin/conversations/urls')) as Record<string, unknown>;
  const arr = Array.isArray(data.data) ? data.data : [];
  return arr
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null && typeof x.url === 'string')
    .map((x) => x.url as string);
}

export function formatCooldown(cooldownUntil: number): string {
  if (!cooldownUntil) { return 'không cooldown'; }
  const remainingMs = cooldownUntil * 1000 - Date.now();
  if (remainingMs <= 0) { return 'đã hết cooldown'; }
  const mins = Math.ceil(remainingMs / 60000);
  return `cooldown còn khoảng ${mins} phút`;
}

export function formatAccountLine(a: GatewayAccountSummary): string {
  const label = a.label ? `${a.label} (${a.id})` : a.id;
  const parts = [`${label}`, `trạng thái: ${a.status || '?'}`, a.enabled ? 'đang bật' : 'đã tắt', formatCooldown(a.cooldownUntil)];
  if (a.lastError) { parts.push(`lỗi cuối: ${a.lastError.slice(0, 200)}`); }
  return parts.join(' — ');
}
