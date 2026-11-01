(function () {
  var vscode = acquireVsCodeApi();
  var messagesEl = document.getElementById('messages');
  var sessionSelect = document.getElementById('sessionSelect');
  var statusEl = document.getElementById('status');
  var inputEl = document.getElementById('input');
  var attachmentsEl = document.getElementById('attachments');
  var streamBubble = null;
  var streamRaw = '';

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
    row.appendChild(importBtn);
    row.appendChild(dashBtn);
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
  document.getElementById('deleteSessionBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'deleteSession' });
  });
  sessionSelect.addEventListener('change', function () {
    vscode.postMessage({ type: 'switchSession', id: sessionSelect.value });
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
    else if (m.type === 'error') { addBubble('error', m.text || 'Đã xảy ra lỗi.'); statusEl.textContent = 'Có lỗi, xem khung đỏ ở trên.'; }
    else if (m.type === 'accountError') { addAccountErrorBubble(m.text || ''); statusEl.textContent = 'Chưa có tài khoản Muse khả dụng.'; }
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
      sessionSelect.innerHTML = '';
      (m.sessions || []).forEach(function (s) {
        var opt = document.createElement('option');
        opt.value = s.id;
        opt.textContent = s.title || 'Hội thoại';
        sessionSelect.appendChild(opt);
      });
      if (m.currentId) { sessionSelect.value = m.currentId; }
    }
    else if (m.type === 'history') {
      (m.messages || []).forEach(function (h) { addBubble(h.role === 'user' ? 'user' : 'assistant', h.text || ''); });
    }
    else if (m.type === 'historyCleared') { messagesEl.innerHTML = ''; attachmentsEl.innerHTML = ''; streamBubble = null; streamRaw = ''; }
    else if (m.type === 'preset') { inputEl.value = m.text || ''; send(); }
    else if (m.type === 'done') { statusEl.textContent = 'Sẵn sàng.'; }
  });
})();
