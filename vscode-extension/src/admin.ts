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

async function adminFetch(baseUrl: string, apiKey: string, path: string, init: RequestInit = {}): Promise<unknown> {
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

export async function startBrowserLogin(baseUrl: string, apiKey: string, label?: string, accountId?: string): Promise<BrowserLoginResult> {
  const body: Record<string, string> = {};
  if (label) { body.label = label; }
  if (accountId) { body.accountId = accountId; }
  const data = (await adminFetch(baseUrl, apiKey, '/login/browser/start', { method: 'POST', body: JSON.stringify(body) })) as Record<string, unknown>;
  return asBrowserLogin(data);
}

export async function getBrowserLoginStatus(baseUrl: string, apiKey: string, id: string): Promise<BrowserLoginResult> {
  const data = (await adminFetch(baseUrl, apiKey, `/login/browser/${encodeURIComponent(id)}/status`)) as Record<string, unknown>;
  return asBrowserLogin(data);
}

export async function cancelBrowserLogin(baseUrl: string, apiKey: string, id: string): Promise<BrowserLoginResult> {
  const data = (await adminFetch(baseUrl, apiKey, `/login/browser/${encodeURIComponent(id)}/cancel`, { method: 'POST' })) as Record<string, unknown>;
  return asBrowserLogin(data);
}

export async function deleteGatewayAccount(baseUrl: string, apiKey: string, id: string): Promise<void> {
  await adminFetch(baseUrl, apiKey, `/admin/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' });
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
