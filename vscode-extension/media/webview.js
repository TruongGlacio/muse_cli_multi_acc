(function () {
  var vscode = acquireVsCodeApi();
  var messagesEl = document.getElementById('messages');
  var sessionListEl = document.getElementById('sessionList');
  var currentSessionLabel = document.getElementById('currentSessionLabel');
  var currentSessionAccountEl = document.getElementById('currentSessionAccount');
  // Layout 2 cột (v0.6.0): drawer dưới header của 0.5.0 đã xóa; nút
  // "☰ Quản lý hội thoại" giờ bật/tắt cột trái. Trạng thái mở/thu gọn
  // lưu bằng webview setState (mất khi webview bị dispose hoàn toàn thì
  // mặc định mở lại).
  function setSidebarCollapsed(collapsed) {
    document.body.classList.toggle('sidebar-collapsed', !!collapsed);
    try { vscode.setState({ sidebarCollapsed: !!collapsed }); } catch (e) { /* webview cũ không có setState thì thôi */ }
  }
  function toggleSidebar() {
    setSidebarCollapsed(!document.body.classList.contains('sidebar-collapsed'));
  }
  try {
    var savedState = vscode.getState();
    if (savedState && savedState.sidebarCollapsed) { document.body.classList.add('sidebar-collapsed'); }
  } catch (e) { /* mặc định mở */ }
  var statusEl = document.getElementById('status');
  var inputEl = document.getElementById('input');
  var attachmentsEl = document.getElementById('attachments');
  var streamBubble = null;
  var streamRaw = '';
  // Panel Nhật ký (v0.6.0): dòng log runtime, mỗi dòng có giờ nhận do
  // extension thêm (dòng gateway gốc không có timestamp). Dòng hiển thị
  // dùng textContent nên nội dung log không thể chèn HTML.
  var logLinesEl = document.getElementById('logLines');
  var logPanelEl = document.getElementById('logPanel');
  var logFilterEl = document.getElementById('logFilter');
  var logData = [];
  var logErrorWords = ['error', 'lỗi', 'failed', '502', '503', '429', 'quota'];
  function isLogError(text) {
    var low = (text || '').toLowerCase();
    return logErrorWords.some(function (w) { return low.indexOf(w) >= 0; });
  }
  function visibleLogLines() {
    var q = (logFilterEl.value || '').trim().toLowerCase();
    if (!q) { return logData; }
    return logData.filter(function (l) { return (l.text || '').toLowerCase().indexOf(q) >= 0; });
  }
  function renderLogs() {
    logLinesEl.innerHTML = '';
    visibleLogLines().forEach(function (l) {
      var div = document.createElement('div');
      div.className = 'log-line' + (isLogError(l.text) ? ' log-error' : '');
      div.textContent = (l.time ? l.time + ' ' : '') + (l.text || '');
      logLinesEl.appendChild(div);
    });
    if (logPanelEl.style.display !== 'none') { logLinesEl.scrollTop = logLinesEl.scrollHeight; }
  }
  function addLogLine(time, text) {
    logData.push({ time: time || '', text: text || '' });
    if (logData.length > 1000) { logData.splice(0, logData.length - 1000); }
    renderLogs();
  }

  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function render(text) {
    var parts = [];
    var html = escapeHtml(text);
    html = html.replace(/```([\s\S]*?)```/g, function (_m, code) {
      parts.push('<pre><code>' + code + '</code></pre>');
      return '\u0000' + (parts.length - 1) + '\u0000';
    });
    html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\n/g, '<br>');
    html = html.replace(/\u0000(\d+)\u0000/g, function (_m, i) { return parts[Number(i)]; });
    return html;
  }
  function addBubble(cls, text, details) {
    var div = document.createElement('div');
    div.className = 'bubble ' + cls;
    div.innerHTML = render(text);
    if (details) {
      var det = document.createElement('details');
      var sum = document.createElement('summary');
      sum.textContent = 'Chi tiết (JSON gốc)';
      det.appendChild(sum);
      var pre = document.createElement('pre');
      pre.textContent = details;
      det.appendChild(pre);
      div.appendChild(det);
    }
    messagesEl.appendChild(div);
    div.scrollIntoView();
    return div;
  }
  function addLoginBubble(text, isWarning) {
    var div = document.createElement('div');
    div.className = 'bubble error';
    div.innerHTML = render(text);
    var row = document.createElement('div');
    row.className = 'actions';
    var settingsBtn = document.createElement('button');
    settingsBtn.textContent = 'Mở Cài đặt';
    settingsBtn.addEventListener('click', function () { vscode.postMessage({ type: 'openSettings' }); });
    row.appendChild(settingsBtn);
    div.appendChild(row);
    messagesEl.appendChild(div);
    div.scrollIntoView();
  }
  function addAccountErrorBubble(text) {
    var div = document.createElement('div');
    div.className = 'bubble error';
    div.innerHTML = render(text);
    var row = document.createElement('div');
    row.className = 'actions';
    var importBtn = document.createElement('button');
    importBtn.textContent = 'Nhập đăng nhập từ app desktop';
    importBtn.addEventListener('click', function () { vscode.postMessage({ type: 'importLogin' }); });
    var dashBtn = document.createElement('button');
    dashBtn.textContent = 'Mở dashboard gateway';
    dashBtn.addEventListener('click', function () { vscode.postMessage({ type: 'openDashboard' }); });
    var settingsBtn = document.createElement('button');
    settingsBtn.textContent = 'Mở Cài đặt';
    settingsBtn.addEventListener('click', function () { vscode.postMessage({ type: 'openSettings' }); });
    row.appendChild(importBtn);
    row.appendChild(dashBtn);
    row.appendChild(settingsBtn);
    div.appendChild(row);
    messagesEl.appendChild(div);
    div.scrollIntoView();
  }
  function send() {
    var text = inputEl.value.trim();
    if (!text) { return; }
    inputEl.value = '';
    vscode.postMessage({ type: 'send', text: text });
  }
  document.getElementById('sendBtn').addEventListener('click', send);
  document.getElementById('stopBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'stop' });
  });
  document.getElementById('attachBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'attach' });
  });
  document.getElementById('clearHistoryBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'clearHistory' });
  });
  document.getElementById('newSessionBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'newSession' });
  });
  document.getElementById('renameSessionBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'renameSession' });
  });
  document.getElementById('sidebarBtn').addEventListener('click', toggleSidebar);
  document.getElementById('collapseSidebarBtn').addEventListener('click', function () { setSidebarCollapsed(true); });
  document.getElementById('logBtn').addEventListener('click', function () {
    var opening = logPanelEl.style.display === 'none';
    logPanelEl.style.display = opening ? 'block' : 'none';
    if (opening) { vscode.postMessage({ type: 'getLogs' }); }
  });
  document.getElementById('refreshLogsBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'getLogs' });
  });
  document.getElementById('copyLogsBtn').addEventListener('click', function () {
    var text = visibleLogLines().map(function (l) { return (l.time ? l.time + ' ' : '') + (l.text || ''); }).join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        statusEl.textContent = 'Đã sao chép log đang hiển thị vào clipboard.';
      }, function () {
        statusEl.textContent = 'Không sao chép được log vào clipboard.';
      });
    } else {
      statusEl.textContent = 'Trình duyệt webview này không hỗ trợ sao chép vào clipboard.';
    }
  });
  document.getElementById('clearLogsBtn').addEventListener('click', function () {
    logData = [];
    renderLogs();
    vscode.postMessage({ type: 'clearLogs' });
  });
  document.getElementById('openOutputBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'openOutput' });
  });
  logFilterEl.addEventListener('input', renderLogs);
  document.getElementById('deleteSessionBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'deleteSession' });
  });
  document.getElementById('syncFromWebBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'syncFromWeb' });
  });
  document.getElementById('settingsBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'openSettings' });
  });
  document.querySelectorAll('#chips button').forEach(function (btn) {
    btn.addEventListener('click', function () {
      inputEl.value = btn.getAttribute('data-prompt') || '';
      inputEl.focus();
    });
  });
  inputEl.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  window.addEventListener('message', function (event) {
    var m = event.data || {};
    if (m.type === 'message') { addBubble(m.role === 'user' ? 'user' : 'assistant', m.text || '', m.details || ''); }
    else if (m.type === 'tool') { addBubble('tool', 'Công cụ: ' + (m.name || '') + ' — ' + (m.detail || '')); }
    else if (m.type === 'toolResult') { addBubble('tool', 'Kết quả ' + (m.name || '') + ': ' + (m.detail || '')); }
    else if (m.type === 'status') { statusEl.textContent = m.text || ''; }
    else if (m.type === 'error') {
      var errBubble = addBubble('error', m.text || 'Đã xảy ra lỗi.');
      statusEl.textContent = 'Có lỗi, xem khung đỏ ở trên.';
      // Fix 502 (v0.6.0): chỉ khi thông điệp chứa 502 hoặc
      // upstream_response_unavailable mới thêm nút này. Bấm nút CHỈ
      // điền sẵn câu ngắn vào ô soạn thảo trong cùng hội thoại, user tự
      // bấm Gửi — tuyệt đối không tự gửi, không tạo hội thoại mới.
      if (/502|upstream_response_unavailable/.test(m.text || '')) {
        var row = document.createElement('div');
        row.className = 'actions';
        var resendBtn = document.createElement('button');
        resendBtn.textContent = 'Gửi lại tin ngắn';
        resendBtn.addEventListener('click', function () {
          inputEl.value = 'Bạn vừa dừng mà chưa trả lời xong, hãy trả lời lại ngắn gọn.';
          inputEl.focus();
        });
        row.appendChild(resendBtn);
        errBubble.appendChild(row);
      }
    }
    else if (m.type === 'accountError') { addAccountErrorBubble(m.text || ''); statusEl.textContent = 'Chưa có tài khoản Muse khả dụng.'; }
    else if (m.type === 'loginRequired') { addLoginBubble(m.text || 'Hội thoại này cần đăng nhập lại.'); statusEl.textContent = 'Cần đăng nhập lại.'; }
    else if (m.type === 'loginWarning') { addLoginBubble(m.text || ''); statusEl.textContent = 'Tài khoản của hội thoại này đã hết hạn hoặc đã đăng xuất.'; }
    else if (m.type === 'importedBanner') {
      // Banner nhập khẩu (v0.6.0, mức 1): banner riêng trên khung chat,
      // KHÔNG nằm trong messages nên không gửi lên model. Session đồng
      // bộ từ web có messages trống nên banner hiện ở đầu khung chat.
      var old = document.getElementById('importedBanner');
      if (old) { old.remove(); }
      var banner = document.createElement('div');
      banner.id = 'importedBanner';
      banner.className = 'imported-banner';
      banner.textContent = m.text || '';
      messagesEl.insertBefore(banner, messagesEl.firstChild);
      banner.scrollIntoView();
    }
    else if (m.type === 'streamStart') { streamRaw = ''; streamBubble = addBubble('assistant', ''); }
    else if (m.type === 'streamDelta') {
      streamRaw += m.text || '';
      if (streamBubble) { streamBubble.innerHTML = render(streamRaw); streamBubble.scrollIntoView(); }
    }
    else if (m.type === 'streamEnd') { streamBubble = null; streamRaw = ''; }
    else if (m.type === 'streamFinal') {
      if (streamBubble) {
        streamBubble.innerHTML = render(m.text || '');
        if (m.details) {
          var det = document.createElement('details');
          var sum = document.createElement('summary');
          sum.textContent = 'Chi tiết (JSON gốc)';
          det.appendChild(sum);
          var pre = document.createElement('pre');
          pre.textContent = m.details;
          det.appendChild(pre);
          streamBubble.appendChild(det);
        }
        streamBubble.scrollIntoView();
      } else { addBubble('assistant', m.text || '', m.details || ''); }
      streamBubble = null; streamRaw = '';
    }
    else if (m.type === 'attached') {
      var chip = document.createElement('div');
      chip.className = 'chip';
      chip.textContent = 'Đã đính kèm: ' + (m.name || 'tệp') + ' (' + (m.kindLabel || 'tệp') + ', ' + Math.round((m.size || 0) / 1024) + ' KiB) — sẽ gửi kèm lượt chat tiếp theo.';
      attachmentsEl.appendChild(chip);
    }
    else if (m.type === 'attachmentsCleared') { attachmentsEl.innerHTML = ''; }
    else if (m.type === 'sessions') {
      sessionListEl.innerHTML = '';
      var sessions = m.sessions || [];
      if (sessions.length === 0) {
        var empty = document.createElement('div');
        empty.textContent = 'Chưa có hội thoại nào. Bấm "Hội thoại mới" để bắt đầu.';
        sessionListEl.appendChild(empty);
      }
      sessions.forEach(function (s) {
        var item = document.createElement('button');
        item.className = 'session-item' + (s.id === m.currentId ? ' current' : '');
        var title = document.createElement('span');
        title.textContent = s.title || 'Hội thoại';
        item.appendChild(title);
        var meta = document.createElement('small');
        var when = s.updatedAt ? new Date(s.updatedAt).toLocaleString() : '';
        meta.textContent = (s.count || 0) + ' tin' + (when ? ' • ' + when : '') + (s.workspacePath ? ' • ' + s.workspacePath.split(/[\\/]/).pop() : '') + (s.importedFromWeb ? ' • Từ web' : '');
        item.appendChild(meta);
        // Dòng tài khoản (v0.7.0, điểm 3): dùng accountDisplay do
        // provider join từ cache tài khoản mới nhất (Email -> Username
        // -> Label), KHÔNG dùng label lưu trong session. Email dài thì
        // CSS cắt ellipsis, title giữ đầy đủ để rê chuột đọc được.
        // Vẫn cùng hàng/vị trí cũ, không thêm hàng mới.
        var accLine = document.createElement('small');
        accLine.className = 'account-line';
        var accDisplay = s.accountDisplay || 'Chưa xác định tài khoản';
        accLine.textContent = 'Tài khoản: ' + accDisplay + (s.accountDetail ? ' (' + s.accountDetail + ')' : '');
        accLine.title = accDisplay;
        item.appendChild(accLine);
        var badge = document.createElement('span');
        badge.className = 'status-badge status-' + (s.accountStatus || 'stopped');
        badge.textContent = s.accountStatus === 'running' ? 'Đang chạy' : s.accountStatus === 'loggedout' ? 'Đã logout' : 'Đã dừng';
        item.appendChild(badge);
        item.addEventListener('click', function () {
          // Cột trái vẫn mở sau khi chuyển session (không còn drawer để đóng).
          vscode.postMessage({ type: 'switchSession', id: s.id });
        });
        sessionListEl.appendChild(item);
        if (s.id === m.currentId) {
          currentSessionLabel.textContent = 'Hội thoại hiện tại: ' + (s.title || 'Hội thoại');
          // Header chat (v0.7.0, điểm 3 bổ sung): dòng tài khoản của
          // hội thoại đang mở, cùng thứ tự ưu tiên như danh sách.
          // Cập nhật ngay mỗi lần nhận danh sách session (chuyển
          // session, tạo mới, làm mới cache) nên không kẹt tài khoản
          // của session cũ. Đã logout vẫn hiện danh tính kèm trạng
          // thái, vì user cần biết chính tài khoản nào đã logout.
          if (currentSessionAccountEl) {
            var curDisplay = s.accountDisplay || 'Chưa xác định tài khoản';
            currentSessionAccountEl.textContent = 'Tài khoản: ' + curDisplay + (s.accountStatus === 'loggedout' ? ' (Đã logout)' : '');
            currentSessionAccountEl.title = curDisplay;
          }
        }
      });
    }
    else if (m.type === 'history') {
      (m.messages || []).forEach(function (h) { addBubble(h.role === 'user' ? 'user' : 'assistant', h.text || ''); });
    }
    else if (m.type === 'historyCleared') { messagesEl.innerHTML = ''; attachmentsEl.innerHTML = ''; streamBubble = null; streamRaw = ''; }
    else if (m.type === 'logLine') { addLogLine(m.time || '', m.text || ''); }
    else if (m.type === 'logs') {
      var t = m.time || '';
      logData = (m.lines || []).map(function (text) { return { time: t, text: text || '' }; });
      renderLogs();
    }
    else if (m.type === 'preset') { inputEl.value = m.text || ''; send(); }
    else if (m.type === 'done') { statusEl.textContent = 'Sẵn sàng.'; }
  });
})();
