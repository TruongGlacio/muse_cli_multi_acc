(function () {
  var vscode = acquireVsCodeApi();
  var messagesEl = document.getElementById('messages');
  var sessionListEl = document.getElementById('sessionList');
  // Dropdown lọc hội thoại theo tài khoản (v0.8.8): nằm ngay trên
  // danh sách, chỉ lọc hiển thị. Chỉ rebuild options khi danh sách
  // thay đổi để không giật focus khi đang chọn.
  var accountFilterEl = document.getElementById('accountFilterSelect');
  var lastFilterOptionsKey = '';
  if (accountFilterEl) {
    accountFilterEl.addEventListener('change', function () {
      vscode.postMessage({ type: 'setAccountFilter', id: accountFilterEl.value });
    });
  }
  function renderAccountFilter(options, currentFilter) {
    if (!accountFilterEl) { return; }
    var opts = options && options.length ? options : [{ id: 'all', label: 'Tất cả tài khoản', status: '' }];
    var key = opts.map(function (o) { return o.id + '|' + o.label + '|' + (o.status || ''); }).join(';');
    if (key !== lastFilterOptionsKey) {
      lastFilterOptionsKey = key;
      accountFilterEl.innerHTML = '';
      opts.forEach(function (o) {
        var opt = document.createElement('option');
        opt.value = o.id;
        opt.textContent = o.label + (o.status ? ' — ' + o.status : '');
        accountFilterEl.appendChild(opt);
      });
    }
    var want = currentFilter || 'all';
    if (accountFilterEl.value !== want) { accountFilterEl.value = want; }
  }
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
  // Tay kéo đổi chiều rộng cột hội thoại (v0.8.10): vùng kéo là
  // #sidebarResizer ở mép phải sidebar, kéo bằng pointer, chiều rộng
  // bám theo chuột theo thời gian thực, thả chuột thì lưu bền qua
  // extension (globalState), nhấp đúp thì về mặc định 230px. Kéo chỉ
  // bắt đầu khi pointer xuống đúng vùng tay kéo nên không ảnh hưởng
  // lựa chọn hay cuộn trong nội dung sidebar.
  var sidebarEl = document.getElementById('sidebar');
  var layoutEl = document.getElementById('layout');
  var resizerEl = document.getElementById('sidebarResizer');
  var sidebarResizing = false;
  // __SIDEBAR_WIDTH_FN_START__
  function clampSidebarWidth(px, containerWidth) {
    var DEFAULT_WIDTH = 230;
    if (typeof px !== 'number' || !isFinite(px)) { return DEFAULT_WIDTH; }
    var w = Math.floor(px);
    if (w < 160) { w = 160; }
    if (w > 480) { w = 480; }
    if (typeof containerWidth === 'number' && isFinite(containerWidth) && containerWidth > 0) {
      var half = Math.floor(containerWidth / 2);
      if (w > half) { w = half; }
    }
    return w;
  }
  // __SIDEBAR_WIDTH_FN_END__
  function applySidebarWidth(px) {
    if (!sidebarEl) { return 230; }
    var w = clampSidebarWidth(px, layoutEl ? layoutEl.clientWidth : 0);
    sidebarEl.style.width = w + 'px';
    sidebarEl.style.flexBasis = w + 'px';
    return w;
  }
  if (resizerEl && sidebarEl) {
    resizerEl.addEventListener('pointerdown', function (e) {
      if (document.body.classList.contains('sidebar-collapsed')) { return; }
      e.preventDefault();
      sidebarResizing = true;
      var startX = e.clientX;
      var startW = sidebarEl.getBoundingClientRect().width;
      document.body.classList.add('sidebar-resizing');
      try { resizerEl.setPointerCapture(e.pointerId); } catch (err) { /* trình duyệt cũ không có capture thì vẫn kéo bằng listener */ }
      function onMove(ev) { applySidebarWidth(startW + (ev.clientX - startX)); }
      function onUp() {
        resizerEl.removeEventListener('pointermove', onMove);
        resizerEl.removeEventListener('pointerup', onUp);
        resizerEl.removeEventListener('pointercancel', onUp);
        document.body.classList.remove('sidebar-resizing');
        sidebarResizing = false;
        var finalW = clampSidebarWidth(sidebarEl.getBoundingClientRect().width, layoutEl ? layoutEl.clientWidth : 0);
        vscode.postMessage({ type: 'setSessionListWidth', width: finalW });
      }
      resizerEl.addEventListener('pointermove', onMove);
      resizerEl.addEventListener('pointerup', onUp);
      resizerEl.addEventListener('pointercancel', onUp);
    });
    resizerEl.addEventListener('dblclick', function () {
      if (document.body.classList.contains('sidebar-collapsed')) { return; }
      applySidebarWidth(230);
      vscode.postMessage({ type: 'setSessionListWidth', width: 230 });
    });
  }
  var statusEl = document.getElementById('status');
  var inputEl = document.getElementById('input');
  var attachmentsEl = document.getElementById('attachments');
  var sendBtnEl = document.getElementById('sendBtn');
  var attachBtnEl = document.getElementById('attachBtn');
  var syncBtnEl = document.getElementById('syncFromWebBtn');
  var newSessionBtnEl = document.getElementById('newSessionBtn');
  var renameSessionBtnEl = document.getElementById('renameSessionBtn');
  var deleteSessionBtnEl = document.getElementById('deleteSessionBtn');
  // Tay kéo chiều cao ô nhập (v0.8.27, theo mẫu #sidebarResizer):
  // #composerResizer ở mép trên cụm soạn thảo, full chiều ngang, kéo
  // bằng pointer — kéo LÊN mở rộng, kéo XUỐNG thu nhỏ (hướng trực
  // quan của ô chat, ngược với grip góc dưới-phải của textarea vốn
  // kéo lên là thu nhỏ vì nó kéo mép dưới). Chiều cao bám theo chuột
  // theo thời gian thực, thả chuột thì lưu bền qua extension
  // (globalState, theo mẫu sessionListWidth), nhấp đúp về mặc định.
  // Clamp: tối thiểu 64px (~3 dòng, khớp chiều cao mặc định rows=3
  // đo được là 63px), tối đa 60% chiều cao cột chat để không nuốt
  // hết vùng tin nhắn (#messages flex:1 tự co lại tương ứng).
  var composerResizerEl = document.getElementById('composerResizer');
  var chatColumnEl = document.getElementById('chatColumn');
  var composerResizing = false;
  var lastAppliedComposerHeight = null;
  // __COMPOSER_HEIGHT_FN_START__
  function composerMinHeight() { return 64; }
  function composerMaxHeight() {
    var h = chatColumnEl ? chatColumnEl.clientHeight : 0;
    var max = h ? Math.floor(h * 0.6) : 400;
    return Math.max(composerMinHeight(), max);
  }
  // Kẹp thuần về [min, max] — dùng cho giá trị kéo (kéo quá đà thì
  // dừng ở min/max, KHÔNG về 0). Ý nghĩa "0 = về mặc định" chỉ nằm
  // ở applyComposerHeight (giá trị host gửi / nhấp đúp), không nằm ở
  // đây: trước đây clamp trả 0 khi px <= 0 nên kéo xuống quá đà đặt
  // style.height = '0px' làm ô nhập xẹp còn ~16px thay vì dừng ở 64px.
  function clampComposerHeight(px) {
    if (typeof px !== 'number' || !isFinite(px)) { return composerMinHeight(); }
    var h = Math.floor(px);
    if (h < composerMinHeight()) { h = composerMinHeight(); }
    if (h > composerMaxHeight()) { h = composerMaxHeight(); }
    return h;
  }
  function applyComposerHeight(px) {
    if (!inputEl) { return 0; }
    // 0 (hoặc không hợp lệ) = về mặc định rows=3: xóa inline height.
    if (typeof px !== 'number' || !isFinite(px) || px <= 0) {
      inputEl.style.height = '';
      lastAppliedComposerHeight = 0;
      return 0;
    }
    var h = clampComposerHeight(px);
    inputEl.style.height = h + 'px';
    lastAppliedComposerHeight = h;
    return h;
  }
  // __COMPOSER_HEIGHT_FN_END__
  if (composerResizerEl && inputEl) {
    composerResizerEl.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      composerResizing = true;
      var startY = e.clientY;
      var startH = inputEl.getBoundingClientRect().height;
      document.body.classList.add('composer-resizing');
      try { composerResizerEl.setPointerCapture(e.pointerId); } catch (err) { /* trình duyệt cũ không có capture thì vẫn kéo bằng listener */ }
      function onMove(ev) {
        // Kéo LÊN (clientY giảm) = mở rộng; kéo XUỐNG = thu nhỏ.
        var next = clampComposerHeight(startH + (startY - ev.clientY));
        inputEl.style.height = next + 'px';
      }
      function onUp() {
        composerResizerEl.removeEventListener('pointermove', onMove);
        composerResizerEl.removeEventListener('pointerup', onUp);
        composerResizerEl.removeEventListener('pointercancel', onUp);
        document.body.classList.remove('composer-resizing');
        composerResizing = false;
        var finalH = clampComposerHeight(inputEl.getBoundingClientRect().height);
        lastAppliedComposerHeight = finalH;
        vscode.postMessage({ type: 'setComposerHeight', height: finalH });
      }
      composerResizerEl.addEventListener('pointermove', onMove);
      composerResizerEl.addEventListener('pointerup', onUp);
      composerResizerEl.addEventListener('pointercancel', onUp);
    });
    composerResizerEl.addEventListener('dblclick', function () {
      applyComposerHeight(0);
      vscode.postMessage({ type: 'setComposerHeight', height: 0 });
    });
  }
  // Hiệu ứng loading cho nút bấm (v0.8.13): bấm thì disable nút, thêm
  // class loading (spinner CSS + mờ đi), đổi text thành dạng đang xử
  // lý (text gốc + "…"); nút chỉ có icon (text rỗng hoặc 1 ký tự) thì
  // chỉ disable + mờ, không đổi text. Khi xong thì khôi phục ĐÚNG
  // text gốc đã lưu và bỏ disable/class. Mọi trạng thái loading đều
  // chỉ clear bằng message hoàn tất/lỗi tương ứng (done/sessions/
  // syncDone/attachDone/error), KHÔNG BAO GIỜ clear bằng setTimeout
  // đoán thời gian xử lý. Nhóm loading: 'send', 'sync', 'attach',
  // 'session' — mỗi message hoàn tất chỉ clear đúng nhóm của nó, trừ
  // 'error' thì clear tất cả để không còn đường nào kẹt loading.
  // __BUTTON_LOADING_FN_START__
  var loadingButtons = [];
  function setButtonLoading(el, on, group) {
    if (!el) { return; }
    if (on) {
      if (el.dataset && el.dataset.museLoading === '1') { return; }
      if (el.dataset) {
        el.dataset.museLoading = '1';
        el.dataset.museOrigText = el.textContent;
        el.dataset.museLoadingGroup = group || '';
      }
      if (loadingButtons.indexOf(el) < 0) { loadingButtons.push(el); }
      if (el.classList) { el.classList.add('loading'); }
      if (el.tagName === 'BUTTON') { el.disabled = true; }
      else if (el.setAttribute) { el.setAttribute('aria-disabled', 'true'); }
      var t = el.textContent || '';
      if (t.trim().length > 1) { el.textContent = t + '…'; }
    } else {
      if (el.dataset && el.dataset.museLoading !== '1') { return; }
      if (el.dataset && typeof el.dataset.museOrigText === 'string') { el.textContent = el.dataset.museOrigText; }
      if (el.dataset) { delete el.dataset.museLoading; delete el.dataset.museOrigText; delete el.dataset.museLoadingGroup; }
      var idx = loadingButtons.indexOf(el);
      if (idx >= 0) { loadingButtons.splice(idx, 1); }
      if (el.classList) { el.classList.remove('loading'); }
      if (el.tagName === 'BUTTON') { el.disabled = false; }
      else if (el.removeAttribute) { el.removeAttribute('aria-disabled'); }
    }
  }
  function clearLoadingGroup(group) {
    loadingButtons.slice().forEach(function (el) {
      if (el.dataset && el.dataset.museLoadingGroup === group) { setButtonLoading(el, false); }
    });
  }
  function clearAllButtonLoading() {
    loadingButtons.slice().forEach(function (el) { setButtonLoading(el, false); });
  }
  // __BUTTON_LOADING_FN_END__
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
  // Cuộn độc lập (v0.8.11): tin nhắn mới nhất luôn cuộn đúng vùng
  // #messages, không cuộn theo trang (body đã overflow hidden nên
  // scrollIntoView cũ không còn cuộn được body, nhưng ghi rõ đích
  // để khỏi phụ thuộc hành vi cuộn tổ tiên).
  function scrollMessagesToBottom() { messagesEl.scrollTop = messagesEl.scrollHeight; }
  // v0.8.19: cuộn chốt xuống tin cuối sau khi render xong cả lô
  // (mở panel lần đầu hoặc chuyển hội thoại). addBubble đã cuộn từng
  // bubble, nhưng layout chưa ổn định ngay sau khi render (trình duyệt
  // chưa tính xong chiều cao thực tế) nên gọi lại sau 2 frame để vị
  // trí cuối cùng vẫn đúng. Chỉ dùng ở handler history/importedBanner,
  // không dùng trong streamDelta (đã tự cuộn) hay sessions (chỉ render
  // danh sách) để tránh giật cuộn khi đang chat.
  function scrollMessagesToBottomSettled() {
    scrollMessagesToBottom();
    requestAnimationFrame(function () { requestAnimationFrame(scrollMessagesToBottom); });
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
    scrollMessagesToBottom();
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
    scrollMessagesToBottom();
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
    scrollMessagesToBottom();
  }
  function send() {
    var text = inputEl.value.trim();
    if (!text) { return; }
    inputEl.value = '';
    setButtonLoading(sendBtnEl, true, 'send');
    vscode.postMessage({ type: 'send', text: text });
  }
  document.getElementById('sendBtn').addEventListener('click', send);
  document.getElementById('stopBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'stop' });
  });
  document.getElementById('attachBtn').addEventListener('click', function () {
    setButtonLoading(attachBtnEl, true, 'attach');
    vscode.postMessage({ type: 'attach' });
  });
  // Kéo thả file vào khung chat (v0.8.12, mở rộng v0.8.20, vùng
  // nhận mở rộng toàn panel ở v0.8.22): CHỈ MỘT handler duy nhất
  // gắn ở #layout (phần tử bao toàn bộ nội dung webview), nên thả
  // file vào bất kỳ chỗ nào trong panel — vùng tin nhắn, cột danh
  // sách hội thoại, ô nhập, hàng nút, chip đính kèm — cũng đi vào
  // cùng đường xử lý. Cố ý KHÔNG giữ handler cũ ở .composer hay
  // #attachments nữa: sự kiện drop nổi bọt từ phần tử con lên
  // #layout, giữ cả hai tầng sẽ gửi trùng 2 message cho một lần thả.
  // preventDefault ở dragover/drop là bắt buộc, nếu không trình
  // duyệt sẽ mở file thay vì giao cho extension. Khi đang kéo qua
  // thì thêm class drag-over ở cấp #layout (viền focusBorder, nền
  // nhẹ) và gỡ khi rời/thả; bộ đếm dragenter/dragleave tránh nhấp
  // nháy khi rê qua các phần tử con bên trong panel. Thứ tự ưu tiên
  // khi thả: (a) nếu kéo từ Explorer của VS Code mà đọc được danh
  // sách URI dạng text/uri-list thì gửi URI về extension để xử lý
  // theo đường dẫn; (b) nếu không thì đọc File qua File API trong
  // webview rồi gửi nội dung về extension: ảnh dạng dataUrl, văn
  // bản dạng text (cắt 500 KiB phía host), còn video và mọi file
  // khác đều đọc đủ bytes dạng dataUrl để host gửi nguyên file (từ
  // 0.8.20, không còn note thay thế). File vượt 25 MB thì không đọc
  // bytes nữa mà gửi cờ tooLarge để host báo lỗi rõ. (c) v0.8.22:
  // nếu cả uri-list lẫn File API đều rỗng (webview không giao được
  // gì từ lần thả này) thì KHÔNG im lặng nữa mà gửi message
  // dropNoFile để host hiện lỗi nhìn thấy được trong khung chat.
  // Lưu ý chưa kiểm chứng được trên VS Code thật: webview có thể
  // chặn hoàn toàn drop từ hệ điều hành ở một số trường hợp — bản
  // này chỉ giúp user thấy thông báo rõ thay vì im lặng, không ép
  // được webview giao file; khi đó chỉ còn kéo từ Explorer + hộp
  // chọn nhiều file là đường gửi nhiều file hoạt động được (xem
  // README). Tay kéo đổi chiều rộng cột (#sidebarResizer) dùng
  // pointer, không phải HTML5 drag, nên không bị handler này ảnh
  // hưởng; click/chọn hội thoại cũng không bị chặn vì handler chỉ
  // preventDefault ở dragover/drop.
  function readDroppedFile(file) {
    return new Promise(function (resolve) {
      var lower = (file.name || '').toLowerCase();
      var type = file.type || '';
      // v0.8.20: giới hạn 25 MB áp cho mọi file kéo thả (kể cả text,
      // để khỏi đọc file khổng lồ vào bộ nhớ rồi mới cắt).
      if (file.size > 25000000) {
        resolve({ name: file.name, size: file.size, tooLarge: true });
        return;
      }
      var isImage = type.indexOf('image/') === 0
        || /\.png$|\.jpg$|\.jpeg$|\.webp$|\.gif$/.test(lower);
      if (isImage) {
        var rd = new FileReader();
        rd.onload = function () { resolve({ name: file.name, size: file.size, type: type, dataUrl: rd.result }); };
        rd.onerror = function () { resolve({ name: file.name, size: file.size, type: type }); };
        rd.readAsDataURL(file);
        return;
      }
      var textExts = ['.txt', '.md', '.markdown', '.json', '.jsonc', '.csv', '.xml', '.html', '.htm', '.css', '.js', '.mjs', '.ts', '.tsx', '.jsx', '.py', '.cs', '.java', '.c', '.h', '.cpp', '.go', '.rs', '.rb', '.php', '.sql', '.log', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.sh', '.ps1', '.bat'];
      var isText = type.indexOf('text/') === 0
        || type === 'application/json' || type === 'application/xml'
        || textExts.some(function (ext) { return lower.slice(-ext.length) === ext; });
      if (isText) {
        var rt = new FileReader();
        rt.onload = function () { resolve({ name: file.name, size: file.size, type: type, text: rt.result }); };
        rt.onerror = function () { resolve({ name: file.name, size: file.size, type: type }); };
        rt.readAsText(file);
        return;
      }
      // v0.8.20: video, audio, pdf, zip và mọi loại còn lại đều
      // đọc đủ bytes để host gửi nguyên file, không còn trả về
      // chỉ tên/dung lượng như trước.
      var rf = new FileReader();
      rf.onload = function () { resolve({ name: file.name, size: file.size, type: type, dataUrl: rf.result }); };
      rf.onerror = function () { resolve({ name: file.name, size: file.size, type: type }); };
      rf.readAsDataURL(file);
    });
  }
  function enableDropZone(el) {
    if (!el) { return; }
    var depth = 0;
    el.addEventListener('dragenter', function (e) {
      e.preventDefault();
      depth++;
      el.classList.add('drag-over');
    });
    el.addEventListener('dragover', function (e) {
      e.preventDefault();
      if (e.dataTransfer) { e.dataTransfer.dropEffect = 'copy'; }
      el.classList.add('drag-over');
    });
    el.addEventListener('dragleave', function (e) {
      depth = Math.max(0, depth - 1);
      if (depth === 0) { el.classList.remove('drag-over'); }
    });
    el.addEventListener('drop', function (e) {
      e.preventDefault();
      depth = 0;
      el.classList.remove('drag-over');
      var dt = e.dataTransfer;
      // v0.8.22: không còn return im lặng khi webview không giao
      // được gì — host sẽ hiện lỗi nhìn thấy được trong khung chat.
      if (!dt) { vscode.postMessage({ type: 'dropNoFile' }); return; }
      var uriList = '';
      try { uriList = dt.getData('text/uri-list') || ''; } catch (err) { uriList = ''; }
      var uris = uriList.split(/\r?\n/).map(function (s) { return s.trim(); })
        .filter(function (s) { return s !== '' && s.charAt(0) !== '#'; });
      if (uris.length > 0) {
        setButtonLoading(attachBtnEl, true, 'attach');
        vscode.postMessage({ type: 'dropUris', uris: uris });
        return;
      }
      var files = dt.files ? Array.prototype.slice.call(dt.files) : [];
      if (files.length === 0) { vscode.postMessage({ type: 'dropNoFile' }); return; }
      setButtonLoading(attachBtnEl, true, 'attach');
      Promise.all(files.map(readDroppedFile)).then(function (items) {
        vscode.postMessage({ type: 'dropFiles', files: items });
      });
    });
  }
  // v0.8.22: một handler duy nhất ở #layout (xem ghi chú ở đầu
  // khối kéo thả). layoutEl đã khai báo ở đầu script.
  enableDropZone(layoutEl);
  document.getElementById('clearHistoryBtn').addEventListener('click', function () {
    vscode.postMessage({ type: 'clearHistory' });
  });
  document.getElementById('newSessionBtn').addEventListener('click', function () {
    setButtonLoading(newSessionBtnEl, true, 'session');
    vscode.postMessage({ type: 'newSession' });
  });
  document.getElementById('renameSessionBtn').addEventListener('click', function () {
    setButtonLoading(renameSessionBtnEl, true, 'session');
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
    setButtonLoading(deleteSessionBtnEl, true, 'session');
    vscode.postMessage({ type: 'deleteSession' });
  });
  document.getElementById('syncFromWebBtn').addEventListener('click', function () {
    setButtonLoading(syncBtnEl, true, 'sync');
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
      // v0.8.13: lỗi là tín hiệu kết thúc cho mọi nút đang loading
      // (kể cả nút Gửi khi run() thoát sớm) — clear tất cả để không
      // còn đường nào kẹt loading; 'done' sau đó (nếu có) chỉ clear
      // lại nhóm 'send' nên không ảnh hưởng các nhóm khác.
      clearAllButtonLoading();
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
      // v0.8.19: bỏ việc ép scrollTop = 0 của v0.8.11. Banner vẫn nằm
      // ở đầu để user cuộn lên xem, nhưng điểm vào mặc định khi vừa
      // vào chat là tin cuối, như mọi lần vào chat khác.
      scrollMessagesToBottomSettled();
    }
    else if (m.type === 'streamStart') { streamRaw = ''; streamBubble = addBubble('assistant', ''); }
    else if (m.type === 'streamDelta') {
      streamRaw += m.text || '';
      if (streamBubble) { streamBubble.innerHTML = render(streamRaw); scrollMessagesToBottom(); }
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
        scrollMessagesToBottom();
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
    else if (m.type === 'attachDone') { clearLoadingGroup('attach'); }
    else if (m.type === 'syncDone') { clearLoadingGroup('sync'); }
    else if (m.type === 'sessions') {
      // v0.8.13: 'sessions' là tín hiệu hoàn tất của nhóm thao tác
      // session (tạo mới/đổi tên/xóa/mở tab mới/xóa item) — clear
      // nhóm 'session'; các span item cũng bị re-render nên trạng
      // thái loading của chúng mất theo DOM mới, clear nhóm là để
      // dọn các nút sidebar còn tồn tại.
      clearLoadingGroup('session');
      renderAccountFilter(m.accountFilterOptions, m.accountFilter);
      // Khôi phục chiều rộng cột đã lưu (v0.8.10); đang kéo thì không
      // áp để khỏi giật lại chiều rộng giữa chừng.
      if (typeof m.sessionListWidth === 'number' && !sidebarResizing) { applySidebarWidth(m.sessionListWidth); }
      // Khôi phục chiều cao ô nhập đã lưu (v0.8.27): chỉ áp khi giá
      // trị host gửi KHÁC giá trị đã áp lần trước và không đang kéo
      // tay kéo. Quy tắc "khác mới áp" giữ chiều cao user vừa kéo
      // bằng grip native (grip native không lưu nên host vẫn giữ giá
      // trị cũ — áp lại sẽ giật về), đồng thời vẫn khôi phục sau tải
      // lại webview (lần đầu lastAppliedComposerHeight là null) và
      // vẫn đồng bộ khi bề mặt khác đổi chiều cao (giá trị mới khác).
      if (typeof m.composerHeight === 'number' && !composerResizing && m.composerHeight !== lastAppliedComposerHeight) { applyComposerHeight(m.composerHeight); }
      sessionListEl.innerHTML = '';
      var sessions = m.sessions || [];
      if (sessions.length === 0) {
        var empty = document.createElement('div');
        // Lọc mà ra rỗng trong khi tổng số session > 0 thì nói rõ là
        // do bộ lọc, không phải danh sách đã hết.
        empty.textContent = (m.totalSessionCount || 0) > 0
          ? 'Không có hội thoại nào cho tài khoản đang lọc. Đổi bộ lọc tài khoản ở trên để xem hội thoại khác.'
          : 'Chưa có hội thoại nào. Bấm "Hội thoại mới" để bắt đầu.';
        sessionListEl.appendChild(empty);
      }
      if (sessions.length === 0 && !m.currentSession) {
        currentSessionLabel.textContent = 'Chưa có hội thoại nào.';
        if (currentSessionAccountEl) { currentSessionAccountEl.textContent = ''; }
      }
      var currentSessionItem = null;
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
        // Chỉ báo run (v0.8.27): xoay tròn khi đang thực hiện, dấu
        // tích khi run gần nhất đã hoàn thành, dấu cảnh báo khi run
        // gần nhất lỗi — KHÔNG dùng tích cho lỗi. Trạng thái khác
        // (stopped/loggedout) thì không có chỉ báo này. Span xoay
        // để rỗng, hình xoay vẽ bằng CSS animation (muse-spin).
        if (s.runStatus === 'running') {
          var runSpin = document.createElement('span');
          runSpin.className = 'run-indicator run-running';
          runSpin.title = 'Đang thực hiện';
          item.appendChild(runSpin);
        } else if (s.runStatus === 'done') {
          var runDone = document.createElement('span');
          runDone.className = 'run-indicator run-done';
          runDone.textContent = '✓';
          runDone.title = 'Đã hoàn thành';
          item.appendChild(runDone);
        } else if (s.runStatus === 'error') {
          var runErr = document.createElement('span');
          runErr.className = 'run-indicator run-error';
          runErr.textContent = '⚠';
          runErr.title = 'Lỗi khi thực hiện';
          item.appendChild(runErr);
        }
        // Mở tab mới (v0.8.0, việc 3): span (không phải button lồng
        // trong button) để mở session này trong một tab editor riêng,
        // kéo sang nhóm bên cạnh để xem song song. stopPropagation để
        // bấm nút này không đồng thời chuyển session của sidebar/panel
        // hiện tại. Đóng tab không xóa session.
        var openTab = document.createElement('span');
        openTab.className = 'open-tab-btn';
        openTab.textContent = '↗ Tab mới';
        openTab.title = 'Mở hội thoại này trong tab mới (xem song song với hội thoại hiện tại)';
        openTab.addEventListener('click', function (ev) {
          ev.stopPropagation();
          setButtonLoading(openTab, true, 'session');
          vscode.postMessage({ type: 'openInNewTab', id: s.id });
        });
        item.appendChild(openTab);
        // v0.8.2, việc 2a: nút xóa trên từng item (span, không lồng
        // button trong button, như nút Tab mới). Bấm thì xác nhận rồi
        // xóa ĐÚNG session đó, không cần mở nó trước; panel/tab đang
        // mở session đó nhận notify và chuyển đi, không kẹt.
        var delBtn = document.createElement('span');
        delBtn.className = 'delete-session-btn';
        delBtn.textContent = '✕ Xóa';
        delBtn.title = 'Xóa hội thoại này (chỉ xóa trong extension và mapping gateway, thread gốc vẫn còn trên web muse.ai)';
        delBtn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          setButtonLoading(delBtn, true, 'session');
          vscode.postMessage({ type: 'deleteSessionById', id: s.id });
        });
        item.appendChild(delBtn);
        item.addEventListener('click', function () {
          // Cột trái vẫn mở sau khi chuyển session (không còn drawer để đóng).
          vscode.postMessage({ type: 'switchSession', id: s.id });
        });
        sessionListEl.appendChild(item);
        if (s.id === m.currentId) {
          // v0.8.19: lưới an toàn — session đang mở phải thấy ngay
          // trong danh sách mà không cần scroll tay, kể cả khi thứ tự
          // hiển thị đã đổi (mới nhất lên đầu). block 'nearest' chỉ
          // cuộn khi item đang ngoài vùng nhìn thấy.
          currentSessionItem = item;
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
      // v0.8.19: cuộn danh sách tới session đang mở (nếu ngoài vùng
      // nhìn thấy) sau khi render xong cả danh sách.
      if (currentSessionItem && currentSessionItem.scrollIntoView) { currentSessionItem.scrollIntoView({ block: 'nearest' }); }
      // v0.8.8: session đang mở mà bị lọc khỏi danh sách vẫn phải
      // hiện tiêu đề/tài khoản ở header (không dùng sessions đã lọc
      // để suy ra header, mà dùng currentSession ngoài danh sách).
      var currentShown = sessions.some(function (s) { return s.id === m.currentId; });
      if (!currentShown && m.currentSession) {
        currentSessionLabel.textContent = 'Hội thoại hiện tại: ' + (m.currentSession.title || 'Hội thoại');
        if (currentSessionAccountEl) {
          var csDisplay = m.currentSession.accountDisplay || 'Chưa xác định tài khoản';
          currentSessionAccountEl.textContent = 'Tài khoản: ' + csDisplay + (m.currentSession.accountStatus === 'loggedout' ? ' (Đã logout)' : '');
          currentSessionAccountEl.title = csDisplay;
        }
      }
    }
    else if (m.type === 'history') {
      (m.messages || []).forEach(function (h) { addBubble(h.role === 'user' ? 'user' : 'assistant', h.text || ''); });
      // v0.8.19: vừa vào đoạn chat của một hội thoại thì điểm vào
      // mặc định là tin cuối cùng, áp dụng cả lần mở panel đầu tiên
      // lẫn mỗi lần chuyển hội thoại.
      scrollMessagesToBottomSettled();
    }
    else if (m.type === 'historyCleared') { messagesEl.innerHTML = ''; attachmentsEl.innerHTML = ''; streamBubble = null; streamRaw = ''; }
    else if (m.type === 'logLine') { addLogLine(m.time || '', m.text || ''); }
    else if (m.type === 'logs') {
      var t = m.time || '';
      logData = (m.lines || []).map(function (text) { return { time: t, text: text || '' }; });
      renderLogs();
    }
    else if (m.type === 'preset') { inputEl.value = m.text || ''; send(); }
    else if (m.type === 'done') { clearLoadingGroup('send'); statusEl.textContent = 'Sẵn sàng.'; }
  });
})();
