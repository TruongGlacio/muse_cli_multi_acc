(function () {
  var vscode = acquireVsCodeApi();
  var accountStatusEl = document.getElementById('accountStatus');
  var accountListEl = document.getElementById('accountList');
  var configListEl = document.getElementById('configList');

  function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  document.getElementById('refreshAccountsBtn').addEventListener('click', function () {
    accountStatusEl.textContent = 'Đang kiểm tra tài khoản Muse…';
    vscode.postMessage({ type: 'refreshAccounts' });
  });
  document.getElementById('importLoginBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'importLogin' });
  });
  document.getElementById('openDashboardBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'openDashboard' });
  });
  document.getElementById('restartGatewayBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'restartGateway' });
  });
  document.getElementById('openVscodeSettingsBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'openVscodeSettings' });
  });
  document.getElementById('browserLoginBtn').addEventListener('click', function () {
    var label = document.getElementById('browserLoginLabel').value || 'Tài khoản cá nhân';
    document.getElementById('browserLoginStatus').textContent = 'Đang mở cửa sổ trình duyệt…';
    vscode.postMessage({ type: 'browserLogin', label: label });
  });
  document.getElementById('cancelBrowserLoginBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'cancelBrowserLogin' });
  });
  document.getElementById('installBrowserBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'installBrowser' });
  });
  document.getElementById('refreshConfigBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'refreshConfig' });
  });
  document.getElementById('mergeDuplicatesBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'mergeDuplicates' });
  });

  function actionBtn(label, action, id) {
    var btn = document.createElement('button');
    btn.textContent = label;
    btn.addEventListener('click', function () { vscode.postMessage({ type: 'accountAction', action: action, id: id }); });
    return btn;
  }

  function renderAccounts(m) {
    accountListEl.innerHTML = '';
    // Dòng trạng thái trình duyệt (v0.6.0): đọc từ kết quả kiểm tra của
    // GatewayManager, hiện cả khi gateway lỗi (vì kiểm tra chỉ quét file
    // local, không cần gateway chạy). Dùng textContent nên đường dẫn
    // không thể chèn HTML.
    var browserStatusEl = document.getElementById('browserStatus');
    if (browserStatusEl && m.browserStatus) { browserStatusEl.textContent = m.browserStatus; }
    if (m.error) {
      accountStatusEl.textContent = 'Không đọc được tài khoản Muse: ' + m.error;
      return;
    }
    if (!m.accounts || m.accounts.length === 0) {
      accountStatusEl.textContent = 'Chưa có tài khoản Muse nào trong gateway' + (m.gatewayMode ? ' (' + m.gatewayMode + ', cổng ' + m.port + ')' : '') + '. Đây là nguyên nhân lỗi 503. Hãy làm theo mục "Thêm tài khoản Muse" bên dưới.';
      return;
    }
    accountStatusEl.textContent = 'Gateway ' + (m.gatewayMode || '') + ' (cổng ' + m.port + (m.version ? ', phiên bản ' + m.version : '') + '): ' + m.total + ' tài khoản, ' + m.available + ' khả dụng. Bấm vào từng tài khoản để xem chi tiết.';
    m.accounts.forEach(function (a) {
      var card = document.createElement('div');
      card.className = 'account-card';
      var det = document.createElement('details');
      var sum = document.createElement('summary');
      sum.textContent = (a.label ? a.label + ' (' + a.id + ')' : a.id) + ' — ' + (a.status || '?') + (a.enabled ? '' : ' (đã tắt)');
      det.appendChild(sum);
      var body = document.createElement('div');
      body.className = 'detail';
      var dl = document.createElement('dl');
      var fields = [
        ['Id', a.id], ['Nhãn', a.label || '(trống)'],
        // Hồ sơ (v0.7.0): chỉ hiện trong panel Cài đặt, chưa biết thì
        // "Chưa xác định". Email/phone không đưa vào khung chat, log
        // hay thông báo nào khác.
        ['Email', a.email || 'Chưa xác định'], ['Username', a.username || 'Chưa xác định'], ['Số điện thoại', a.phone || 'Chưa xác định'],
        ['Trạng thái', a.status || '?'],
        ['Bật/tắt', a.enabled ? 'Đang bật' : 'Đã tắt'], ['Tạo lúc', a.createdAt || '—'],
        ['Dùng lần cuối', a.lastUsedAt || '—'], ['Thành công', a.successCount],
        ['Thất bại', a.failCount], ['Cooldown', a.cooldown || ''],
        ['Cookie hết hạn sớm nhất', a.cookieExpiresEarliest || '—'],
        ['Số cookie có hạn', a.cookieExpiresCount],
        ['Lỗi cuối', a.lastError || '—'],
      ];
      fields.forEach(function (f) {
        var dt = document.createElement('dt'); dt.textContent = f[0];
        var dd = document.createElement('dd'); dd.textContent = String(f[1]);
        dl.appendChild(dt); dl.appendChild(dd);
      });
      body.appendChild(dl);
      var sessTitle = document.createElement('div');
      sessTitle.textContent = 'Session đang dùng tài khoản này:';
      body.appendChild(sessTitle);
      var sessList = document.createElement('ul');
      if (a.sessions && a.sessions.length > 0) {
        a.sessions.forEach(function (s) {
          var li = document.createElement('li'); li.textContent = s.title || 'Hội thoại';
          sessList.appendChild(li);
        });
      } else {
        var li = document.createElement('li'); li.textContent = '(chưa có session nào ghi tài khoản này)';
        sessList.appendChild(li);
      }
      body.appendChild(sessList);
      var quotaBtn = document.createElement('button');
      quotaBtn.textContent = 'Xem quota';
      var quotaBox = document.createElement('pre');
      quotaBox.textContent = '';
      quotaBtn.addEventListener('click', function () {
        quotaBox.textContent = 'Đang đọc quota…';
        vscode.postMessage({ type: 'accountQuota', id: a.id });
      });
      body.appendChild(quotaBtn);
      body.appendChild(quotaBox);
      // Lưu quotaBox theo id để handler 'quota' điền đúng chỗ.
      quotaBox.setAttribute('data-account-id', a.id);
      det.appendChild(body);
      card.appendChild(det);
      var row = document.createElement('div');
      row.className = 'actions';
      row.appendChild(actionBtn('Làm mới / Đăng nhập lại', 'renew', a.id));
      var profileBtn = document.createElement('button');
      profileBtn.textContent = 'Cập nhật thông tin hồ sơ';
      profileBtn.title = 'Lấy email/username từ trang Muse cho tài khoản này mà không cần đăng nhập lại';
      profileBtn.addEventListener('click', function () { vscode.postMessage({ type: 'profileRefresh', id: a.id }); });
      row.appendChild(profileBtn);
      var reloginBtn = document.createElement('button');
      reloginBtn.textContent = 'Đăng nhập lại qua trình duyệt';
      reloginBtn.title = 'Mở cửa sổ trình duyệt của gateway để đăng nhập lại (gia hạn) tài khoản này';
      reloginBtn.addEventListener('click', function () { vscode.postMessage({ type: 'reloginBrowser', id: a.id }); });
      row.appendChild(reloginBtn);
      row.appendChild(actionBtn('Xóa cooldown', 'reset', a.id));
      row.appendChild(actionBtn(a.enabled ? 'Tắt' : 'Bật', 'toggle', a.id));
      row.appendChild(actionBtn('Đổi tên nhãn', 'rename', a.id));
      row.appendChild(actionBtn('Đăng xuất', 'logout', a.id));
      // Xóa hoàn toàn (v0.8.0) — nút RIÊNG BIỆT với Đăng xuất: mở hộp
      // xác nhận liệt kê đúng những gì sẽ mất (xem settings.ts) rồi
      // mới gọi purge. Không xóa tài khoản trên muse.ai, không đăng
      // xuất app Muse desktop.
      var purgeBtn = actionBtn('Xóa hoàn toàn', 'purge', a.id);
      purgeBtn.title = 'Xóa tài khoản khỏi pool gateway + file phiên trình duyệt + mapping thread + toàn bộ session extension dùng tài khoản này. Không xóa tài khoản trên muse.ai, không đăng xuất app Muse desktop.';
      row.appendChild(purgeBtn);
      card.appendChild(row);
      accountListEl.appendChild(card);
    });
  }

  window.addEventListener('message', function (event) {
    var m = event.data || {};
    if (m.type === 'accounts') { renderAccounts(m); }
    else if (m.type === 'config') {
      configListEl.innerHTML = '';
      (m.items || []).forEach(function (it) {
        var row = document.createElement('div');
        row.className = 'config-row';
        var k = document.createElement('span'); k.className = 'key'; k.textContent = it.key;
        var v = document.createElement('span'); v.textContent = String(it.value);
        row.appendChild(k); row.appendChild(v);
        configListEl.appendChild(row);
      });
    }
    else if (m.type === 'quota') {
      var boxes = accountListEl.querySelectorAll('pre[data-account-id="' + m.id + '"]');
      boxes.forEach(function (b) {
        b.textContent = m.error ? ('Không đọc được quota: ' + m.error) : JSON.stringify(m.quota, null, 2);
      });
    }
    else if (m.type === 'mergeResult') {
      var mergeEl = document.getElementById('mergeStatus');
      if (mergeEl) { mergeEl.textContent = m.message || ('Đã gộp ' + m.groups + ' nhóm, ' + m.merged + ' tài khoản; bỏ qua ' + m.skipped + ' tài khoản.'); }
    }
    else if (m.type === 'browserLogin') {
      var statusEl = document.getElementById('browserLoginStatus');
      var cancelBtn = document.getElementById('cancelBrowserLoginBtn');
      if (m.state === 'waiting') {
        statusEl.textContent = m.message || 'Đang chờ bạn đăng nhập trong cửa sổ trình duyệt vừa mở…';
        cancelBtn.style.display = '';
      } else if (m.state === 'authenticated') {
        statusEl.textContent = 'Đã lưu tài khoản: ' + (m.accountLabel || m.accountId || '');
        cancelBtn.style.display = 'none';
      } else {
        statusEl.textContent = m.message || ('Phiên đăng nhập kết thúc: ' + m.state);
        cancelBtn.style.display = 'none';
      }
    }
  });
})();
