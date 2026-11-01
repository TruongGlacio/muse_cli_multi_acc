// Panel Cài đặt riêng của Muse (v0.5.0).
//
// Lý do có panel riêng thay vì nhét danh sách tài khoản vào Settings UI
// của VS Code: Settings UI chỉ chứa được cấu hình muse.* (chuỗi/số/
// boolean), không chứa được danh sách tài khoản động hay nút thao tác
// theo từng tài khoản. Panel này vì thế chứa cả hai: (1) quản lý tài
// khoản Muse (động, gọi admin API của gateway, kể cả đa tài khoản),
// và (2) cấu hình muse.* hiển thị CHỈ ĐỌC kèm nút mở Settings UI của
// VS Code để sửa thật.
// Panel KHÔNG BAO GIỜ nhận hay hiển thị cookie, token hay apiKey:
// - Account.Public() có trả cookies dạng đã che, nhưng asAccount trong
//   admin.ts không chọn trường đó, nên nó không bao giờ tới webview.
// - Cookie_expires chỉ gửi mốc hết hạn sớm nhất + số lượng, không tên
//   hay giá trị cookie. Quota được lọc bỏ key nhạy cảm trước khi gửi.
// - Cấu hình apiKey chỉ hiển thị dạng "Đã đặt"/"Chưa đặt" (boolean).
// Phụ thuộc một chiều: extension.ts -> settings.ts. File này KHÔNG
// import extension.ts; nó nhận hai callback: onAccountsChanged (sau
// thao tác tài khoản, để khung chat làm mới trạng thái session) và
// getSessions (để chi tiết tài khoản hiện các session đang dùng nó).

import * as vscode from 'vscode';
import * as fs from 'fs';
import { GatewayManager } from './gateway';
import { fetchGatewayStatus, fetchGatewayAccounts, resetGatewayAccount, renewGatewayAccount, patchGatewayAccount, patchGatewayAccountLabel, deleteGatewayAccount, purgeGatewayAccount, fetchGatewayAccountQuota, formatCooldown, startBrowserLogin, getBrowserLoginStatus, cancelBrowserLogin, refreshGatewayAccountProfile, mergeGatewayDuplicates } from './admin';

export interface SettingsSessionInfo {
  id: string;
  title: string;
  accountId?: string;
  accountLabel?: string;
}

function sanitizeQuota(value: unknown, depth = 0): unknown {
  if (depth > 3 || value === null || typeof value !== 'object') {
    return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? value : String(value ?? '');
  }
  if (Array.isArray(value)) { return value.slice(0, 20).map((v) => sanitizeQuota(v, depth + 1)); }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (/cookie|token|secret|password|auth|session|key/i.test(k)) { continue; }
    out[k] = sanitizeQuota(v, depth + 1);
  }
  return out;
}

function formatUnix(seconds: number): string {
  if (!seconds) { return '—'; }
  return new Date(seconds * 1000).toLocaleString();
}

export class MuseSettingsPanel {
  private static current: MuseSettingsPanel | undefined;

  static createOrShow(
    context: vscode.ExtensionContext,
    gateway: GatewayManager,
    onAccountsChanged: () => void,
    getSessions: () => SettingsSessionInfo[],
    // v0.7.0: sau khi gộp trùng, khung chat đổi accountId của session
    // mình sang tài khoản chính (mergedIds -> primaryId/primaryLabel).
    onMerged?: (remap: Record<string, { primaryId: string; primaryLabel: string }>) => void,
    // v0.8.0: sau khi gateway purge xong, extension xóa session của
    // tài khoản đó khỏi store chung; callback trả số session đã xóa
    // để hiện thông báo cụ thể (không chỉ "Đã xóa").
    onPurged?: (accountId: string) => number,
  ): void {
    if (MuseSettingsPanel.current) {
      MuseSettingsPanel.current.panel.reveal(vscode.ViewColumn.Beside);
      void MuseSettingsPanel.current.refreshAccounts();
      void MuseSettingsPanel.current.refreshConfig();
      return;
    }
    const panel = vscode.window.createWebviewPanel('muse.settings', 'Cài đặt Muse', vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    MuseSettingsPanel.current = new MuseSettingsPanel(panel, context, gateway, onAccountsChanged, getSessions, onMerged, onPurged);
    panel.onDidDispose(() => {
      const inst = MuseSettingsPanel.current;
      if (inst?.browserLoginTimer) { clearInterval(inst.browserLoginTimer); inst.browserLoginTimer = undefined; }
      MuseSettingsPanel.current = undefined;
    });
    void MuseSettingsPanel.current.refreshAccounts();
    void MuseSettingsPanel.current.refreshConfig();
  }

  static async refreshCurrent(): Promise<void> {
    if (MuseSettingsPanel.current) {
      await MuseSettingsPanel.current.refreshAccounts();
      await MuseSettingsPanel.current.refreshConfig();
    }
  }

  private browserLoginTimer?: NodeJS.Timeout;
  private activeBrowserLoginId?: string;
  private activeBrowserLoginRequestedAccountId?: string;
  private browserLoginBaseUrl = '';
  private browserLoginApiKey = '';
  private browserLoginFailures = 0;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly context: vscode.ExtensionContext,
    private readonly gateway: GatewayManager,
    private readonly onAccountsChanged: () => void,
    private readonly getSessions: () => SettingsSessionInfo[],
    private readonly onMerged?: (remap: Record<string, { primaryId: string; primaryLabel: string }>) => void,
    private readonly onPurged?: (accountId: string) => number,
  ) {
    const base = vscode.Uri.joinPath(context.extensionUri, 'media');
    const read = (name: string): string => fs.readFileSync(vscode.Uri.joinPath(base, name).fsPath, 'utf8');
    const css = panel.webview.asWebviewUri(vscode.Uri.joinPath(base, 'settings.css'));
    const js = panel.webview.asWebviewUri(vscode.Uri.joinPath(base, 'settings.js'));
    panel.webview.html = read('settings.html').replaceAll('{{cssUri}}', css.toString()).replaceAll('{{jsUri}}', js.toString());
    panel.webview.onDidReceiveMessage((m: { type?: string; action?: string; id?: string }) => {
      if (m.type === 'refreshAccounts') { void this.refreshAccounts(); }
      else if (m.type === 'refreshConfig') { void this.refreshConfig(); }
      else if (m.type === 'accountAction' && m.action && m.id) { void this.accountAction(m.action, m.id); }
      else if (m.type === 'profileRefresh' && m.id) { void this.profileRefresh(m.id); }
      else if (m.type === 'mergeDuplicates') { void this.mergeDuplicates(); }
      else if (m.type === 'accountQuota' && m.id) { void this.accountQuota(m.id); }
      else if (m.type === 'browserLogin') { void this.startBrowserLoginFlow((m as { label?: string }).label, undefined); }
      else if (m.type === 'reloginBrowser' && m.id) { void this.startBrowserLoginFlow(undefined, m.id); }
      else if (m.type === 'cancelBrowserLogin') { void this.cancelBrowserLoginFlow(); }
      else if (m.type === 'installBrowser') { void vscode.commands.executeCommand('muse.installGatewayBrowser').then(() => { void this.refreshAccounts(); }); }
      else if (m.type === 'importLogin') { void vscode.commands.executeCommand('muse.importDesktopLogin').then(() => { void this.refreshAccounts(); }); }
      else if (m.type === 'openDashboard') { void vscode.commands.executeCommand('muse.openGatewayDashboard'); }
      else if (m.type === 'restartGateway') { void vscode.commands.executeCommand('muse.restartGateway').then(() => { setTimeout(() => { void this.refreshAccounts(); }, 3000); }); }
      else if (m.type === 'openVscodeSettings') { void vscode.commands.executeCommand('workbench.action.openSettings', 'muse.'); }
    });
  }

  private post(type: string, payload: Record<string, unknown> = {}): void {
    void this.panel.webview.postMessage({ type, ...payload });
  }

  private async refreshConfig(): Promise<void> {
    // Chỉ đọc, không gửi giá trị key: apiKey chỉ báo đã đặt hay chưa.
    const c = vscode.workspace.getConfiguration('muse');
    this.post('config', {
      items: [
        { key: 'muse.apiKey', value: c.get<string>('apiKey') ? 'Đã đặt (không hiển thị giá trị)' : 'Chưa đặt — extension tự sinh key cho gateway kèm theo' },
        { key: 'muse.autoApprove', value: String(c.get<boolean>('autoApprove') || false) },
        { key: 'muse.localTools', value: c.get<boolean>('localTools') !== false ? 'Bật (agent dùng tool cục bộ)' : 'Tắt (chỉ trò chuyện, không gửi dữ liệu workspace lên model qua tool)' },
        { key: 'muse.gatewayMode', value: c.get<string>('gatewayMode') || 'auto' },
        { key: 'muse.baseUrl', value: c.get<string>('baseUrl') || 'http://127.0.0.1:18610/v1' },
        { key: 'muse.model', value: c.get<string>('model') || 'muse-chat' },
        { key: 'muse.maxSteps', value: String(c.get<number>('maxSteps') || 30) },
        { key: 'muse.commandTimeoutSeconds', value: String(c.get<number>('commandTimeoutSeconds') || 120) },
        { key: 'muse.gatewayPath', value: c.get<string>('gatewayPath') || '(mặc định: binary kèm theo extension)' },
        { key: 'muse.allowComputerControl', value: String(c.get<boolean>('allowComputerControl') || false) },
        { key: 'muse.computerHelperPath', value: c.get<string>('computerHelperPath') || '(mặc định: helper kèm theo extension)' },
      ],
    });
  }

  private async refreshAccounts(): Promise<void> {
    try {
      const info = await this.gateway.ensureStarted();
      const status = await fetchGatewayStatus(info.baseUrl, info.apiKey);
      const accounts = await fetchGatewayAccounts(info.baseUrl, info.apiKey);
      const available = Number(status.accounts.available ?? 0);
      const total = Number(status.accounts.total ?? accounts.length);
      const sessions = this.getSessions();
      this.post('accounts', {
        gatewayMode: info.mode === 'bundled' ? 'kèm theo extension' : 'sẵn có',
        port: info.port,
        version: status.version || '',
        total, available,
        browserStatus: this.gateway.browserStatusLabel(),
        accounts: accounts.map((a) => {
          const expiries = Object.values(a.cookieExpires).filter((v) => v > 0);
          return {
            id: a.id,
            label: a.label,
            // Hồ sơ chỉ gửi sang panel Cài đặt, không sang khung chat.
            email: a.email,
            username: a.username,
            phone: a.phone,
            enabled: a.enabled,
            status: a.status,
            lastError: a.lastError.slice(0, 200),
            cooldown: formatCooldown(a.cooldownUntil),
            createdAt: formatUnix(a.createdAt),
            lastUsedAt: formatUnix(a.lastUsedAt),
            successCount: a.successCount,
            failCount: a.failCount,
            cookieExpiresEarliest: expiries.length > 0 ? formatUnix(Math.min(...expiries)) : '—',
            cookieExpiresCount: expiries.length,
            sessions: sessions.filter((s) => s.accountId === a.id).map((s) => ({ id: s.id, title: s.title })),
          };
        }),
        error: '',
      });
    } catch (e) {
      this.post('accounts', {
        gatewayMode: '', port: 0, version: '', total: 0, available: 0, accounts: [],
        browserStatus: this.gateway.browserStatusLabel(),
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }

  private async accountQuota(id: string): Promise<void> {
    try {
      const info = await this.gateway.ensureStarted();
      const quota = await fetchGatewayAccountQuota(info.baseUrl, info.apiKey, id);
      this.post('quota', { id, quota: sanitizeQuota(quota), error: '' });
    } catch (e) {
      // Quota có thể thất bại khi tài khoản Invalid: báo nhẹ, không vỡ panel.
      this.post('quota', { id, quota: {}, error: e instanceof Error ? e.message : String(e) });
    }
  }

  // ---------------- Đăng nhập qua trình duyệt (v0.5.0) ----------------
  // Gateway mở cửa sổ Chromium có đầu của chính nó; extension chỉ poll
  // trạng thái mỗi 3 giây. Chỉ một phiên chờ tại một thời điểm (gateway
  // cũng chặn phiên thứ hai). Đóng panel thì dừng poll, nhưng phiên
  // gateway vẫn chờ tới 10 phút hoặc tới khi user đóng cửa sổ.
  private async startBrowserLoginFlow(label: string | undefined, accountId: string | undefined): Promise<void> {
    if (this.browserLoginTimer && this.activeBrowserLoginId) {
      this.post('browserLogin', { state: 'waiting', loginId: this.activeBrowserLoginId, message: 'Đã có một phiên đăng nhập đang chờ. Hãy đăng nhập trong cửa sổ trình duyệt đã mở.' });
      return;
    }
    try {
      const info = await this.gateway.ensureStarted();
      const started = await startBrowserLogin(info.baseUrl, info.apiKey, label, accountId);
      this.activeBrowserLoginId = started.loginId;
      this.activeBrowserLoginRequestedAccountId = accountId;
      this.browserLoginBaseUrl = info.baseUrl;
      this.browserLoginApiKey = info.apiKey;
      this.browserLoginFailures = 0;
      this.post('browserLogin', { state: 'waiting', loginId: started.loginId, message: 'Đang chờ bạn đăng nhập trong cửa sổ trình duyệt vừa mở. Đăng nhập xong, panel sẽ tự nhận tài khoản (không cần bấm thêm gì).' });
      this.browserLoginTimer = setInterval(() => { void this.pollBrowserLogin(); }, 3000);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.post('browserLogin', { state: 'error', message: msg });
      if (/browser_not_installed|Chromium/i.test(msg)) {
        void vscode.window.showWarningMessage('Chưa cài Chromium cho gateway. Hãy bấm "Cài Chromium cho gateway" trong panel Cài đặt rồi thử đăng nhập lại.');
      }
    }
  }

  private stopBrowserLoginPoll(): void {
    if (this.browserLoginTimer) { clearInterval(this.browserLoginTimer); this.browserLoginTimer = undefined; }
    this.activeBrowserLoginId = undefined;
    this.activeBrowserLoginRequestedAccountId = undefined;
  }

  private async pollBrowserLogin(): Promise<void> {
    const loginId = this.activeBrowserLoginId;
    if (!loginId) { this.stopBrowserLoginPoll(); return; }
    try {
      const res = await getBrowserLoginStatus(this.browserLoginBaseUrl, this.browserLoginApiKey, loginId);
      this.browserLoginFailures = 0;
      if (res.status === 'waiting') { return; } // vẫn chờ, không spam webview
      if (res.status === 'authenticated' && res.account) {
        const requested = this.activeBrowserLoginRequestedAccountId;
        const accountLabel = res.account.label || res.account.id;
        const accountId = res.account.id;
        this.stopBrowserLoginPoll();
        this.post('browserLogin', { state: 'authenticated', accountLabel, accountId });
        if (requested && accountId !== requested) {
          void vscode.window.showWarningMessage(`Tài khoản vừa đăng nhập (${accountLabel}) khác với tài khoản cần gia hạn. Tài khoản mới đã được lưu, tài khoản cũ vẫn còn trong danh sách (không tự xóa tài khoản cũ, không tự nối session cũ sang tài khoản mới).`);
        } else if (requested) {
          void vscode.window.showInformationMessage(`Đã gia hạn lại tài khoản ${accountLabel}.`);
        } else {
          void vscode.window.showInformationMessage(`Đã lưu tài khoản ${accountLabel}.`);
        }
        await this.refreshAccounts();
        this.onAccountsChanged();
      } else {
        this.stopBrowserLoginPoll();
        this.post('browserLogin', { state: res.status, message: res.status === 'cancelled' ? 'Phiên đăng nhập đã bị hủy (bạn đã đóng cửa sổ trình duyệt hoặc bấm Hủy). Bạn có thể thử lại.' : res.status === 'expired' ? 'Phiên đăng nhập đã hết hạn sau 10 phút chưa đăng nhập. Bạn có thể thử lại.' : `Phiên đăng nhập kết thúc với trạng thái: ${res.status}` });
        if (res.status === 'expired') {
          void vscode.window.showWarningMessage('Phiên đăng nhập qua trình duyệt đã hết hạn sau 10 phút. Hãy thử đăng nhập lại.');
        }
      }
    } catch (e) {
      this.browserLoginFailures += 1;
      if (this.browserLoginFailures >= 3) {
        this.stopBrowserLoginPoll();
        this.post('browserLogin', { state: 'error', message: `Không đọc được trạng thái đăng nhập sau 3 lần thử (gateway có thể đã khởi động lại, phiên cũ không còn): ${e instanceof Error ? e.message : String(e)}` });
      }
    }
  }

  private async cancelBrowserLoginFlow(): Promise<void> {
    const loginId = this.activeBrowserLoginId;
    this.stopBrowserLoginPoll();
    if (loginId) {
      try { await cancelBrowserLogin(this.browserLoginBaseUrl, this.browserLoginApiKey, loginId); } catch { /* phiên đã kết thúc thì thôi */ }
    }
    this.post('browserLogin', { state: 'cancelled', message: 'Phiên đăng nhập đã bị hủy. Bạn có thể thử lại.' });
  }

  // ---------------- Hồ sơ + gộp trùng (v0.7.0) ----------------
  // profileRefresh: điền danh tính cho tài khoản cũ (nhập từ desktop)
  // mà không cần đăng nhập lại. Thông báo KHÔNG chứa email/phone.
  private async profileRefresh(id: string): Promise<void> {
    try {
      const info = await this.gateway.ensureStarted();
      const res = await refreshGatewayAccountProfile(info.baseUrl, info.apiKey, id);
      // v0.8.2: khi profile_found=false thì thông báo kèm debug ngắn
      // gọn (chỉ tên bước + cờ, không chứa email/phone) thay vì chỉ
      // nói chung chung "không lấy được".
      if (res.profileFound) {
        void vscode.window.showInformationMessage('Đã cập nhật thông tin hồ sơ của tài khoản.');
      } else {
        const d = res.debug;
        const stepName = (s: string): string => s === 'session_api' ? 'API phiên' : s === 'home' ? 'trang chủ' : s === 'menu' ? 'menu hồ sơ' : s === 'settings' ? 'trang cài đặt' : s === 'local_storage' ? 'localStorage' : s;
        const tried = d && d.attempted.length > 0 ? d.attempted.map(stepName).join(' + ') : 'trang chủ';
        const extra = d
          ? ` (đã thử ${tried}; menu hồ sơ ${d.menuOpened ? 'mở được' : 'không mở được'}; trang cài đặt ${d.settingsOpened ? 'vào được' : 'không vào được'}; đọc được ${d.candidateCount} candidate${d.emailSource ? `; email từ bước ${d.emailSource}` : ''}${d.usernameSource ? `; username từ bước ${d.usernameSource}` : ''})`
          : '';
        void vscode.window.showInformationMessage(`Không lấy được thông tin hồ sơ từ trang Muse (tài khoản giữ nguyên)${extra}. Hãy thử lại sau khi tài khoản đã đăng nhập lại.`);
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Không cập nhật được thông tin hồ sơ: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.refreshAccounts();
    // Cache tài khoản của khung chat làm mới theo, để dòng tài khoản
    // trong cột trái + header chat cập nhật danh tính mới (điểm 3).
    this.onAccountsChanged();
  }

  // mergeDuplicates: CHỈ chạy khi user bấm nút và xác nhận (gộp là thao
  // tác xóa tài khoản, không tự động). Sau khi gộp, đổi accountId của
  // session khung chat sang tài khoản chính rồi làm mới mọi danh sách.
  private async mergeDuplicates(): Promise<void> {
    const answer = await vscode.window.showWarningMessage(
      'Gộp các tài khoản Muse trùng nhau? Các tài khoản có cùng email (hoặc cùng username khi không có email) sẽ gộp thành một tài khoản chính (tài khoản dùng gần nhất). Tài khoản bị gộp sẽ bị xóa khỏi gateway, session của tài khoản bị gộp sẽ chuyển sang tài khoản chính, và các hội thoại cũ vẫn nối tiếp được dưới tài khoản chính. Tài khoản chưa xác định được email/username sẽ được bỏ qua, không gộp.',
      'Gộp tài khoản trùng', 'Hủy');
    if (answer !== 'Gộp tài khoản trùng') { return; }
    try {
      const info = await this.gateway.ensureStarted();
      const res = await mergeGatewayDuplicates(info.baseUrl, info.apiKey);
      const remap: Record<string, { primaryId: string; primaryLabel: string }> = {};
      let mergedCount = 0;
      for (const g of res.merged) {
        for (const oldId of g.mergedIds) { remap[oldId] = { primaryId: g.primaryId, primaryLabel: g.primaryLabel }; }
        mergedCount += g.mergedIds.length;
      }
      if (Object.keys(remap).length > 0) { this.onMerged?.(remap); }
      this.post('mergeResult', {
        groups: res.merged.length, merged: mergedCount, skipped: res.skipped.length,
        message: `Đã gộp ${res.merged.length} nhóm, ${mergedCount} tài khoản vào tài khoản chính; bỏ qua ${res.skipped.length} tài khoản chưa xác định được danh tính.`,
      });
      void vscode.window.showInformationMessage(`Đã gộp ${res.merged.length} nhóm (${mergedCount} tài khoản), bỏ qua ${res.skipped.length} tài khoản chưa xác định được danh tính.`);
    } catch (e) {
      void vscode.window.showErrorMessage(`Không gộp được tài khoản trùng: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.refreshAccounts();
    this.onAccountsChanged();
  }

  private async accountAction(action: string, id: string): Promise<void> {
    try {
      const info = await this.gateway.ensureStarted();
      if (action === 'renew') {
        const res = await renewGatewayAccount(info.baseUrl, info.apiKey, id);
        if (!res.ok) {
          void vscode.window.showWarningMessage('Làm mới phiên không thành công (gateway báo ok=false). Tài khoản này có thể đã hết hạn thật: hãy đăng nhập lại trong app Muse desktop rồi bấm "Nhập đăng nhập từ app desktop".');
        } else {
          void vscode.window.showInformationMessage('Đã làm mới phiên tài khoản.');
        }
      } else if (action === 'reset') {
        await resetGatewayAccount(info.baseUrl, info.apiKey, id);
        void vscode.window.showInformationMessage('Đã xóa cooldown của tài khoản.');
      } else if (action === 'toggle') {
        const acc = (await fetchGatewayAccounts(info.baseUrl, info.apiKey)).find((a) => a.id === id);
        if (!acc) { throw new Error('Không tìm thấy tài khoản này trong pool.'); }
        await patchGatewayAccount(info.baseUrl, info.apiKey, id, !acc.enabled);
        void vscode.window.showInformationMessage(acc.enabled ? 'Đã tắt tài khoản.' : 'Đã bật tài khoản.');
      } else if (action === 'rename') {
        const acc = (await fetchGatewayAccounts(info.baseUrl, info.apiKey)).find((a) => a.id === id);
        if (!acc) { throw new Error('Không tìm thấy tài khoản này trong pool.'); }
        const name = await vscode.window.showInputBox({ prompt: 'Nhập nhãn mới cho tài khoản này', value: acc.label });
        if (!name || name.trim().length === 0) { return; }
        await patchGatewayAccountLabel(info.baseUrl, info.apiKey, id, name.trim().slice(0, 80));
        void vscode.window.showInformationMessage('Đã đổi tên nhãn tài khoản.');
      } else if (action === 'logout') {
        const answer = await vscode.window.showWarningMessage('Đăng xuất tài khoản này khỏi gateway? Tài khoản sẽ bị xóa bền vững khỏi pool của gateway trong extension (khỏi cả file lưu), các session đang dùng tài khoản này sẽ chuyển sang trạng thái Đã logout. Thao tác này không đăng xuất app Muse desktop, vì lệnh nhập chỉ sao chép dữ liệu.', 'Đăng xuất', 'Hủy');
        if (answer !== 'Đăng xuất') { return; }
        await deleteGatewayAccount(info.baseUrl, info.apiKey, id);
        void vscode.window.showInformationMessage('Đã đăng xuất tài khoản khỏi gateway.');
      } else if (action === 'purge') {
        // Xóa hoàn toàn (v0.8.0) — RIÊNG BIỆT với Đăng xuất ở trên và
        // không đổi hành vi của Đăng xuất. Hộp xác nhận phải liệt kê
        // đúng những gì sẽ mất, và nói rõ hai điều KHÔNG xảy ra:
        // không xóa tài khoản trên muse.ai, không đăng xuất app Muse
        // desktop; chạy lại "Nhập đăng nhập từ app desktop" sẽ đưa
        // tài khoản quay lại gateway (hành vi đúng của lệnh nhập).
        const sessionsUsing = this.getSessions().filter((s) => s.accountId === id);
        const answer = await vscode.window.showWarningMessage(
          `Xóa hoàn toàn tài khoản này khỏi gateway và extension? Những thứ sau sẽ mất và không khôi phục được: (1) tài khoản khỏi pool của gateway và file lưu; (2) file phiên trình duyệt của tài khoản này trong gateway; (3) các mapping thread của tài khoản này trong gateway; (4) TOÀN BỘ ${sessionsUsing.length} session trong extension đang dùng tài khoản này, kèm lịch sử chat của chúng trong extension. Thao tác này KHÔNG xóa tài khoản của bạn trên muse.ai và KHÔNG đăng xuất app Muse desktop (app desktop giữ đăng nhập riêng của nó). Nếu sau này bạn chạy lại "Nhập đăng nhập từ app desktop" thì tài khoản này sẽ quay lại gateway — đó là hành vi đúng của lệnh nhập, không phải lỗi xóa chưa sạch.`,
          { modal: true }, 'Xóa hoàn toàn', 'Hủy');
        if (answer !== 'Xóa hoàn toàn') { return; }
        const res = await purgeGatewayAccount(info.baseUrl, info.apiKey, id);
        const removedSessions = this.onPurged ? this.onPurged(id) : 0;
        void vscode.window.showInformationMessage(
          `Đã xóa hoàn toàn tài khoản khỏi gateway và extension: file phiên trình duyệt ${res.browserSessionDeleted ? 'đã xóa' : 'vốn không có'}, ${res.mappingsDeleted} mapping thread trong gateway đã xóa, ${removedSessions} session trong extension đã xóa. Tài khoản trên muse.ai và app Muse desktop không bị ảnh hưởng.`);
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Không thực hiện được thao tác tài khoản: ${e instanceof Error ? e.message : String(e)}`);
    }
    await this.refreshAccounts();
    // Báo cho khung chat làm mới trạng thái session (Đã logout phụ thuộc
    // vào pool hiện tại). Callback này không gửi dữ liệu tài khoản sang chat.
    this.onAccountsChanged();
  }
}
