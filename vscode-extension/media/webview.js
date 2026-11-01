(function () {
  var vscode = acquireVsCodeApi();
  var messagesEl = document.getElementById('messages');
  var statusEl = document.getElementById('status');
  var inputEl = document.getElementById('input');

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
  function addBubble(cls, text) {
    var div = document.createElement('div');
    div.className = 'bubble ' + cls;
    div.innerHTML = render(text);
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
    if (m.type === 'message') { addBubble(m.role === 'user' ? 'user' : 'assistant', m.text || ''); }
    else if (m.type === 'tool') { addBubble('tool', 'Công cụ: ' + (m.name || '') + ' — ' + (m.detail || '')); }
    else if (m.type === 'toolResult') { addBubble('tool', 'Kết quả ' + (m.name || '') + ': ' + (m.detail || '')); }
    else if (m.type === 'status') { statusEl.textContent = m.text || ''; }
    else if (m.type === 'error') { addBubble('error', m.text || 'Đã xảy ra lỗi.'); statusEl.textContent = 'Có lỗi, xem khung đỏ ở trên.'; }
    else if (m.type === 'preset') { inputEl.value = m.text || ''; send(); }
    else if (m.type === 'done') { statusEl.textContent = 'Sẵn sàng.'; }
  });
})();
