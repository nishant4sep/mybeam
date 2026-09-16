// ui/app.js — sessions + chat + workspace + memory + provider + permission + edits + cancel.
// v4: sidebar closed by default, thinking shown until first chunk, fade-in final.
(function () {
  'use strict';
  var app = document.getElementById('app-root');
  var sidebarToggle = document.getElementById('sidebar-toggle');
  var sidebarHide = document.getElementById('sidebar-hide');
  var sessionList = document.getElementById('session-list');
  var newChatBtn = document.getElementById('new-chat');
  var feed = document.getElementById('feed');
  var empty = document.getElementById('empty');
  var f = document.getElementById('f');
  var q = document.getElementById('q');
  var sendBtn = document.getElementById('send');
  var stopBtn = document.getElementById('stop');
  var status = document.getElementById('status');
  var statusText = document.getElementById('statusText');
  var statusMeta = document.getElementById('statusMeta');
  var clearBtn = document.getElementById('clear');
  var toastEl = document.getElementById('toast');
  var pasteStrip = document.getElementById('paste-strip');
  var wsOpen = document.getElementById('ws-open');
  var wsCurrent = document.getElementById('ws-current');
  var wsName = document.getElementById('ws-name');
  var wsPath = document.getElementById('ws-path');
  var wsInfo = document.getElementById('ws-info');
  var wsChange = document.getElementById('ws-change');
  var wsClose = document.getElementById('ws-close');
  var filesSection = document.getElementById('files-section');
  var fileTree = document.getElementById('file-tree');
  var filesRefresh = document.getElementById('files-refresh');
  var memorySection = document.getElementById('memory-section');
  var memoryBody = document.getElementById('memory-body');
  var memoryRefresh = document.getElementById('memory-refresh');
  var providerBtn = document.getElementById('provider-btn');
  var providerLabel = document.getElementById('provider-label');
  var providerMenu = document.getElementById('provider-menu');
  var permBtn = document.getElementById('perm-btn');
  var permLabel = document.getElementById('perm-label');
  var filePane = document.getElementById('file-pane');
  var filePaneName = document.getElementById('file-pane-name');
  var filePaneMeta = document.getElementById('file-pane-meta');
  var filePaneLang = document.getElementById('file-pane-lang');
  var filePaneGutter = document.getElementById('file-pane-gutter');
  var filePaneCode = document.getElementById('file-pane-code');
  var filePaneClose = document.getElementById('file-pane-close');
  var filePaneCopy = document.getElementById('file-pane-copy');

  var turns = new Map();
  var pendingImages = [];
  var lastPasteFingerprint = '';
  var lastPasteAt = 0;
  var FENCE = String.fromCharCode(96,96,96);
  var activeSessionId = null;
  var sessionsMap = new Map();
  var activeWorkspace = null;
  var workspaceTree = null;
  var activeFilePath = null;
  var activeFileContent = '';
  var providersList = [];
  var activeProvider = null;
  var permissionMode = 'ask';
  var currentRunningId = null;

  // ---- sidebar state (persisted) ----
  var SIDEBAR_KEY = 'mybeam.sidebarCollapsed';
  function applySidebarState() {
    var stored = null;
    try { stored = localStorage.getItem(SIDEBAR_KEY); } catch (_) {}
    var collapsed = stored === null ? true : stored === '1';
    if (collapsed) app.classList.add('sidebar-collapsed'); else app.classList.remove('sidebar-collapsed');
  }
  function setSidebarCollapsed(collapsed) {
    if (collapsed) app.classList.add('sidebar-collapsed'); else app.classList.remove('sidebar-collapsed');
    try { localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0'); } catch (_) {}
  }
  applySidebarState();

  var toastTimer = null;
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2200); }
  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function ensureEmptyGone() { if (empty && empty.parentElement) empty.remove(); }
  function fmtMs(ms) { if (ms == null) return ''; if (ms < 1000) return ms + ' ms'; return (ms/1000).toFixed(2) + ' s'; }
  function fmtSize(bytes) { if (bytes == null) return ''; if (bytes < 1024) return bytes + ' B'; if (bytes < 1024*1024) return (bytes/1024).toFixed(1) + ' K'; return (bytes/1024/1024).toFixed(1) + ' M'; }
  function fmtWhen(ts) { if (!ts) return ''; var diff = Date.now() - ts; if (diff < 60_000) return 'now'; if (diff < 3_600_000) return Math.floor(diff/60_000) + 'm'; if (diff < 86_400_000) return Math.floor(diff/3_600_000) + 'h'; return Math.floor(diff/86_400_000) + 'd'; }
  function cssEscape(s) { return String(s).replace(/(["\\])/g, '\\$1'); }
  var isNarrow = function () { return window.matchMedia('(max-width: 720px)').matches; };
  function syncSidebarMode() { if (isNarrow()) app.classList.remove('sidebar-collapsed'); }
  sidebarToggle.addEventListener('click', function () {
    if (isNarrow()) app.classList.toggle('sidebar-open');
    else setSidebarCollapsed(!app.classList.contains('sidebar-collapsed'));
  });
  if (sidebarHide) sidebarHide.addEventListener('click', function () {
    if (isNarrow()) app.classList.remove('sidebar-open');
    else setSidebarCollapsed(true);
  });
  window.addEventListener('resize', syncSidebarMode); syncSidebarMode();

  function renderProviderMenu() {
    providerMenu.innerHTML = '';
    providersList.forEach(function (p) {
      var item = el('div', 'provider-item' + (activeProvider && p.id === activeProvider.id ? ' active' : ''));
      item.appendChild(el('span', 'swatch'));
      item.appendChild(el('span', null, p.label || p.id));
      item.addEventListener('click', function () { setProvider(p.id); providerMenu.hidden = true; });
      providerMenu.appendChild(item);
    });
    var sep = el('div', 'provider-sep'); providerMenu.appendChild(sep);
    var auto = el('div', 'provider-item');
    auto.appendChild(el('span', 'swatch'));
    auto.appendChild(el('span', null, 'Auto-switch on failure (2 errors)'));
    auto.addEventListener('click', function (ev) { ev.stopPropagation(); fetch('/provider/autoswitch', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ on: true }) }).then(function () { toast('Auto-switch: on'); }); providerMenu.hidden = true; });
    providerMenu.appendChild(auto);
  }
  async function setProvider(id) {
    try { const r = await fetch('/provider', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id }) }); const data = await r.json(); if (data.ok) { activeProvider = data.active; providerLabel.textContent = activeProvider.label || activeProvider.id; renderProviderMenu(); toast('Provider: ' + (activeProvider.label || activeProvider.id)); } }
    catch (e) { toast('Could not switch provider'); }
  }
  providerBtn.addEventListener('click', function (ev) { ev.stopPropagation(); renderProviderMenu(); providerMenu.hidden = !providerMenu.hidden; });
  document.addEventListener('click', function () { providerMenu.hidden = true; });
  async function loadProvider() { try { const r = await fetch('/provider'); const data = await r.json(); providersList = data.providers || []; activeProvider = data.active || providersList[0]; providerLabel.textContent = activeProvider ? (activeProvider.label || activeProvider.id) : '—'; } catch (_) {} }

  var PERM_CYCLE = ['read', 'ask', 'auto'];
  var PERM_LABEL = { read: 'Read only', ask: 'Ask', auto: 'Auto' };
  function applyPermission(mode) { permissionMode = mode; permLabel.textContent = PERM_LABEL[mode] || mode; permBtn.classList.toggle('perm-read', mode === 'read'); permBtn.classList.toggle('perm-auto', mode === 'auto'); }
  permBtn.addEventListener('click', async function () { var idx = PERM_CYCLE.indexOf(permissionMode); var next = PERM_CYCLE[(idx + 1) % PERM_CYCLE.length]; try { const r = await fetch('/permission', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: next }) }); const d = await r.json(); if (d.ok) { applyPermission(d.mode); toast('Permission: ' + PERM_LABEL[d.mode]); } } catch (e) { toast('Could not change permission'); } });

  function applyWorkspaceSnapshot(snap) {
    if (!snap) return;
    activeWorkspace = snap.active || null; workspaceTree = snap.tree || null;
    if (activeWorkspace && !activeWorkspace.invalid) {
      wsOpen.hidden = true; wsCurrent.hidden = false;
      wsName.textContent = activeWorkspace.name || 'workspace';
      wsPath.textContent = activeWorkspace.path || '';
      wsInfo.title = activeWorkspace.path || '';
      filesSection.hidden = false; renderFileTree(); memorySection.hidden = false;
    } else {
      wsOpen.hidden = false; wsCurrent.hidden = true; filesSection.hidden = true; memorySection.hidden = true;
      fileTree.innerHTML = ''; memoryBody.innerHTML = ''; closeFilePane();
      if (activeWorkspace && activeWorkspace.invalid) toast('Workspace not available: ' + (activeWorkspace.error || 'unknown'));
    }
  }
  function renderFileTree() { fileTree.innerHTML = ''; if (!workspaceTree || !workspaceTree.length) { fileTree.appendChild(el('div', 'tree-row', '(empty)')); return; } workspaceTree.forEach(function (node) { fileTree.appendChild(buildTreeNode(node, 0)); }); }
  function buildTreeNode(node, depth) {
    if (node.type === 'dir') {
      var wrap = document.createElement('div');
      var row = el('div', 'tree-row'); row.dataset.path = node.path;
      var chev = el('span', 'chev'); chev.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 6 15 12 9 18"></polyline></svg>';
      var ic = el('span', 'ic'); ic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7a2 2 0 012-2h4l2 2h8a2 2 0 012 2v8a2 2 0 01-2 2H5a2 2 0 01-2-2z"></path></svg>';
      row.appendChild(chev); row.appendChild(ic); row.appendChild(el('span', 'name', node.name));
      var children = el('div', 'tree-children'); children.hidden = true;
      if (node.children && node.children.length) node.children.forEach(function (c) { children.appendChild(buildTreeNode(c, depth + 1)); });
      row.addEventListener('click', function (ev) { ev.stopPropagation(); row.classList.toggle('open'); children.hidden = !children.hidden; });
      wrap.appendChild(row); wrap.appendChild(children); return wrap;
    }
    var ext = (node.name.match(/\.[^.]+$/) || [''])[0].toLowerCase();
    var frow = el('div', 'tree-row'); frow.dataset.path = node.path; frow.dataset.ext = ext;
    var fic = el('span', 'ic'); fic.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';
    frow.appendChild(el('span', 'chev')); frow.appendChild(fic); frow.appendChild(el('span', 'name', node.name)); frow.appendChild(el('span', 'sz', fmtSize(node.size)));
    frow.addEventListener('click', function () { openFile(node.path); });
    return frow;
  }
  async function openFile(relPath) { try { const res = await fetch('/workspace/file?path=' + encodeURIComponent(relPath)); const data = await res.json(); if (!data.ok) return toast('Cannot open: ' + (data.reason || 'unknown')); showFilePane(data.file); Array.from(fileTree.querySelectorAll('.tree-row.active')).forEach(function (r) { r.classList.remove('active'); }); var row = fileTree.querySelector('.tree-row[data-path="' + cssEscape(relPath) + '"]'); if (row) row.classList.add('active'); } catch (e) { toast('Could not open file: ' + e.message); } }
  function showFilePane(file) { activeFilePath = file.path; activeFileContent = file.content || ''; filePaneName.textContent = file.path.split('/').pop(); filePaneMeta.textContent = fmtSize(file.size) + (file.mtime ? '  ·  ' + new Date(file.mtime).toLocaleTimeString() : ''); var ext = (file.path.match(/\.[^.]+$/) || [''])[0].replace('.', '').toLowerCase() || 'text'; filePaneLang.textContent = ext; var lines = (file.content || '').split('\n'); var nums = ''; for (var i = 1; i <= lines.length; i++) nums += i + '\n'; filePaneGutter.textContent = nums; filePaneCode.innerHTML = highlight(file.content || '', ext); filePane.hidden = false; app.classList.add('file-open'); filePaneCopy.classList.remove('ok'); }
  function closeFilePane() { filePane.hidden = true; app.classList.remove('file-open'); activeFilePath = null; activeFileContent = ''; }
  filePaneClose.addEventListener('click', closeFilePane);
  filePaneCopy.addEventListener('click', function () { var done = function () { filePaneCopy.classList.add('ok'); toast('Copied'); setTimeout(function () { filePaneCopy.classList.remove('ok'); }, 1500); }; if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(activeFileContent).then(done).catch(function (e) { toast('Copy failed: ' + e.message); }); else { var ta = document.createElement('textarea'); ta.value = activeFileContent; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed'); } ta.remove(); } });
  async function refreshWorkspace() { try { const r = await fetch('/workspace'); const snap = await r.json(); applyWorkspaceSnapshot(snap); } catch (e) { toast('Could not refresh workspace'); } }
  async function refreshMemory() { try { const r = await fetch('/memory'); const data = await r.json(); applyMemorySnapshot(data.snapshot); } catch (e) { toast('Could not refresh memory'); } }
  function applyMemorySnapshot(snap) { memoryBody.innerHTML = ''; if (!snap) return; var labels = ['CONTEXT.md', 'PROJECT_MAP.md', 'FILES.md', 'DECISIONS.md', 'CHANGES.md']; var any = false; labels.forEach(function (name) { var content = snap[name]; var sec = el('div', 'memory-section'); sec.appendChild(el('h4', null, name.replace('.md',''))); if (content && content.trim()) { var pre = document.createElement('pre'); pre.textContent = content.trim(); sec.appendChild(pre); any = true; } else sec.appendChild(el('div', 'memory-empty', '(empty)')); memoryBody.appendChild(sec); }); if (!any) memoryBody.appendChild(el('div', 'memory-empty', 'Nothing recorded yet — send a message to start.')); }
  async function pickWorkspace() { toast('Opening folder dialog…'); try { const r = await fetch('/workspace/pick', { method: 'POST' }); const data = await r.json(); if (data.ok) { applyWorkspaceSnapshot(data.snapshot); toast('Workspace: ' + (data.workspace && data.workspace.name || 'set')); } else if (data.reason === 'cancelled') { /* silent */ } else { var manual = prompt('Folder dialog unavailable (' + (data.reason || 'unknown') + ').\nPaste the full path to a folder:'); if (manual) setWorkspacePath(manual.trim()); } } catch (e) { var m2 = prompt('Could not open folder dialog. Paste a full path:'); if (m2) setWorkspacePath(m2.trim()); } }
  async function setWorkspacePath(p) { try { const r = await fetch('/workspace/set', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: p }) }); const data = await r.json(); if (data.ok) { applyWorkspaceSnapshot(data.snapshot); toast('Workspace set'); } else toast('Could not set workspace: ' + (data.reason || 'unknown')); } catch (e) { toast('Could not set workspace'); } }
  async function closeWorkspace() { try { await fetch('/workspace', { method: 'DELETE' }); applyWorkspaceSnapshot({ active: null, tree: null }); applyMemorySnapshot(null); toast('Workspace closed'); } catch (e) { toast('Could not close workspace'); } }
  wsOpen.addEventListener('click', pickWorkspace); wsChange.addEventListener('click', pickWorkspace); wsClose.addEventListener('click', closeWorkspace);
  filesRefresh.addEventListener('click', refreshWorkspace); memoryRefresh.addEventListener('click', refreshMemory);

  function renderSidebar() {
    sessionList.innerHTML = '';
    var list = Array.from(sessionsMap.values()).sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
    list.forEach(function (s) {
      var item = el('div', 'session-item' + (s.id === activeSessionId ? ' active' : ''));
      item.dataset.id = s.id; item.title = s.title || 'Chat';
      var t = el('div', 's-title', s.title || 'Chat');
      var badge = null;
      if (s.running > 0) badge = el('span', 's-badge running');
      else if (s.queued > 0) badge = el('span', 's-badge queued', String(s.queued));
      var m = el('div', 's-meta', fmtWhen(s.updatedAt || s.createdAt));
      var x = document.createElement('button'); x.type = 'button'; x.className = 's-del'; x.textContent = '×'; x.title = 'Delete';
      var confirmState = false; var confirmTimer = null;
      x.addEventListener('click', function (ev) { ev.stopPropagation(); if (!confirmState) { confirmState = true; x.textContent = 'Delete?'; x.classList.add('confirming'); clearTimeout(confirmTimer); confirmTimer = setTimeout(function () { confirmState = false; x.textContent = '×'; x.classList.remove('confirming'); }, 2500); return; } clearTimeout(confirmTimer); deleteSession(s.id); });
      item.appendChild(t); if (badge) item.appendChild(badge); item.appendChild(m); item.appendChild(x);
      item.addEventListener('click', function () { activateSession(s.id); });
      sessionList.appendChild(item);
    });
  }
  function upsertSession(summary) { if (!summary || !summary.id) return; var prev = sessionsMap.get(summary.id) || {}; sessionsMap.set(summary.id, Object.assign({}, prev, summary)); }
  function resetFeed() { turns.clear(); feed.innerHTML = ''; var d = el('div', 'empty'); d.id = 'empty'; var inner = el('div'); inner.appendChild(el('h1', null, 'Ready when you are.')); inner.appendChild(el('p', null, 'Type or paste images to send them with your message.')); d.appendChild(inner); feed.appendChild(d); empty = d; }

  var autoScroll = true;
  var scrollQueued = false;
  var isUserScrolling = false;
  var userScrollTimer = null;
  feed.addEventListener('scroll', function () {
    var nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 150;
    autoScroll = nearBottom;
    isUserScrolling = true;
    clearTimeout(userScrollTimer);
    userScrollTimer = setTimeout(function () { isUserScrolling = false; }, 900);
  }, { passive: true });
  function scrollDown(opts) {
    if (!autoScroll || scrollQueued || isUserScrolling) return;
    scrollQueued = true;
    requestAnimationFrame(function () {
      scrollQueued = false;
      var behavior = opts && opts.smooth ? 'smooth' : 'auto';
      var target = feed.scrollHeight - feed.clientHeight;
      if (behavior === 'smooth' && typeof feed.scrollTo === 'function') feed.scrollTo({ top: target, behavior: 'smooth' });
      else feed.scrollTop = target;
    });
  }

  function pickImagesFromDataTransfer(dt) { var files = []; if (dt.files && dt.files.length) files = Array.from(dt.files); else if (dt.items) { for (var i = 0; i < dt.items.length; i++) { var it = dt.items[i]; if (it.kind === 'file') { var ff = it.getAsFile(); if (ff) files.push(ff); } } } return files; }
  function fileToDataUrl(file) { return new Promise(function (resolve, reject) { var r = new FileReader(); r.onload = function () { resolve(r.result); }; r.onerror = function () { reject(r.error); }; r.readAsDataURL(file); }); }
  async function addFiles(files) { for (var i = 0; i < files.length; i++) { var file = files[i]; if (!/^image\//.test(file.type)) continue; if (file.size > 8 * 1024 * 1024) { toast('Image too large (max 8 MB)'); continue; } try { var du = await fileToDataUrl(file); var dup = pendingImages.some(function (p) { return p.dataUrl === du; }); if (dup) continue; pendingImages.push({ name: file.name || ('paste-' + Date.now() + '.' + (file.type.split('/')[1] || 'png')), type: file.type, dataUrl: du }); } catch (e) { toast('Could not read image'); } } renderPasteStrip(); }
  function renderPasteStrip() { pasteStrip.innerHTML = ''; pendingImages.forEach(function (img, idx) { var th = el('div', 'paste-thumb'); var im = document.createElement('img'); im.src = img.dataUrl; im.alt = img.name || 'pasted'; th.appendChild(im); var x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = '×'; x.title = 'Remove'; x.addEventListener('click', function () { pendingImages.splice(idx, 1); renderPasteStrip(); }); th.appendChild(x); pasteStrip.appendChild(th); }); }
  function onPaste(e) { var dt = e.clipboardData; if (!dt) return; var files = pickImagesFromDataTransfer(dt); if (!files.length) return; e.preventDefault(); var fp = files.map(function (file) { return file.name + ':' + file.size + ':' + file.type; }).join('|'); var now = Date.now(); if (fp && fp === lastPasteFingerprint && now - lastPasteAt < 400) return; lastPasteFingerprint = fp; lastPasteAt = now; addFiles(files); }
  document.addEventListener('paste', onPaste, true);

  var PL = '\u0001';
  function escapeHtml(s) { return s.replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function highlight(code, lang) {
    var L = (lang || '').toLowerCase(); var store = [];
    function stash(html) { store.push(html); return PL + (store.length - 1) + PL; }
    function wrap(kind, text) { return stash('<span class="tok-' + kind + '">' + text + '</span>'); }
    var s = escapeHtml(code);
    var codey = ['js','javascript','ts','typescript','json','java','c','cpp','cs','go','rust','swift','kotlin'];
    var hashy = ['py','python','rb','ruby','sh','bash','zsh','yaml','yml'];
    if (codey.indexOf(L) !== -1) { s = s.replace(/(\/\/[^\n]*)/g, function (m) { return wrap('c', m); }); s = s.replace(/(\/\*[\s\S]*?\*\/)/g, function (m) { return wrap('c', m); }); }
    if (hashy.indexOf(L) !== -1) s = s.replace(/(#[^\n]*)/g, function (m) { return wrap('c', m); });
    if (L === 'html' || L === 'xml' || L === 'svg' || L === 'vue') s = s.replace(/(&lt;!--[\s\S]*?--&gt;)/g, function (m) { return wrap('c', m); });
    if (L === 'css' || L === 'scss' || L === 'less') s = s.replace(/(\/\*[\s\S]*?\*\/)/g, function (m) { return wrap('c', m); });
    s = s.replace(/(&#39;[^&\n]*?&#39;|"[^"\n]*?")/g, function (m) { return wrap('s', m); });
    s = s.replace(/\b(\d+(?:\.\d+)?)\b/g, function (m) { return wrap('n', m); });
    var kw = /\b(const|let|var|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|import|from|export|default|async|await|try|catch|finally|throw|typeof|instanceof|in|of|delete|void|yield|static|public|private|protected|readonly|interface|type|enum|implements|package|fun|val|def|lambda|elif|except|raise|with|as|is|not|and|or|None|True|False|nil|true|false|null|undefined|struct|trait|impl|mut|pub|use|mod|fn|match|where)\b/g;
    s = s.replace(kw, function (m) { return wrap('k', m); });
    if (L === 'html' || L === 'xml' || L === 'svg' || L === 'vue') { s = s.replace(/(&lt;\/?)([a-zA-Z][\w:-]*)([^&]*?)(&gt;)/g, function (_, open, name, rest, close) { var inner = rest.replace(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(=)(&#39;[^&]*?&#39;|"[^"]*?")/g, function (__, attr, eq, val) { return wrap('a', attr) + eq + wrap('s', val); }); return open + wrap('t', name) + inner + close; }); }
    s = s.replace(/\b([A-Za-z_$][\w$]*)(?=\s*\()/g, function (m) { return wrap('f', m); });
    var guard = 0;
    while (s.indexOf(PL) !== -1 && guard++ < 20) s = s.replace(new RegExp(PL + '(\\d+)' + PL, 'g'), function (_, i) { return store[+i]; });
    return s;
  }
  function download(filename, text, type) { var blob = new Blob([text], { type: type || 'text/plain' }); var url = URL.createObjectURL(blob); var a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(function () { URL.revokeObjectURL(url); }, 1000); }
  function buildCodeBlock(code, lang) { var wrap = el('div', 'cb'); var head = el('div', 'cb-head'); var dots = el('div', 'cb-dots'); dots.innerHTML = '<i></i><i></i><i></i>'; head.appendChild(dots); head.appendChild(el('span', 'cb-lang', lang || 'code')); head.appendChild(el('div', 'cb-spacer')); var ext = ({ html: 'html', css: 'css', js: 'js', javascript: 'js', ts: 'ts', typescript: 'ts', py: 'py', python: 'py', json: 'json', md: 'md', markdown: 'md' })[(lang || '').toLowerCase()] || 'txt'; var actions = el('div', 'cb-actions'); var copyBtn = document.createElement('button'); copyBtn.className = 'cb-btn'; copyBtn.type = 'button'; copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg><span>Copy</span>'; copyBtn.addEventListener('click', function () { var done = function () { copyBtn.classList.add('ok'); copyBtn.querySelector('span').textContent = 'Copied'; toast('Copied'); setTimeout(function () { copyBtn.classList.remove('ok'); copyBtn.querySelector('span').textContent = 'Copy'; }, 1500); }; if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done).catch(function (e) { toast('Copy failed: ' + e.message); }); else { var ta = document.createElement('textarea'); ta.value = code; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed'); } ta.remove(); } }); actions.appendChild(copyBtn); var dlBtn = document.createElement('button'); dlBtn.className = 'cb-btn'; dlBtn.type = 'button'; dlBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg><span>Download</span>'; dlBtn.addEventListener('click', function () { download('code.' + ext, code, 'text/plain'); toast('Downloaded'); }); actions.appendChild(dlBtn); head.appendChild(actions); wrap.appendChild(head); var body = el('div', 'cb-body'); var lineCount = code.split('\n').length; var gutter = el('div', 'cb-gutter'); var nums = ''; for (var n = 1; n <= lineCount; n++) nums += n + '\n'; gutter.textContent = nums; var pre = document.createElement('pre'); pre.className = 'cb-code'; pre.innerHTML = highlight(code, lang); body.appendChild(gutter); body.appendChild(pre); wrap.appendChild(body); return wrap; }
  function inlineInto(node, src) { var s = escapeHtml(src); var slots = []; s = s.replace(/\u0060([^\u0060]+?)\u0060/g, function (_, c) { slots.push(c); return '\u0000C' + (slots.length - 1) + '\u0000'; }); s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>'); s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>'); s = s.replace(/(^|[^*])\*([^*]+?)\*(?!\*)/g, '$1<em>$2</em>'); s = s.replace(/\u0000C(\d+)\u0000/g, function (_, idx) { return '<code class="inline">' + slots[+idx] + '</code>'; }); node.innerHTML = s; }
  function matchFenceOpen(line) { return line.match(new RegExp('^\\s*' + FENCE + '\\s*([\\w+.-]*)\\s*$')); }
  function isFenceClose(line) { return new RegExp('^\\s*' + FENCE + '\\s*$').test(line); }
  function renderMarkdown(container, text) { container.innerHTML = ''; if (!text) return; var lines = text.split(/\r?\n/); var i = 0; while (i < lines.length) { var line = lines[i]; var fence = matchFenceOpen(line); if (fence) { var lang = (fence[1] || '').toLowerCase(); var buf = []; i++; while (i < lines.length && /^\s*$/.test(lines[i])) i++; while (i < lines.length && !isFenceClose(lines[i])) { buf.push(lines[i]); i++; } if (i < lines.length) i++; container.appendChild(buildCodeBlock(buf.join('\n'), lang)); continue; } if (/^\s*---\s*$/.test(line)) { container.appendChild(el('hr')); i++; continue; } var h = line.match(/^(#{1,6})\s+(.*)$/); if (h) { var level = Math.min(h[1].length, 4); var node = el('h' + level); inlineInto(node, h[2]); container.appendChild(node); i++; continue; } if (/^\s*>\s?/.test(line)) { var bqbuf = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) { bqbuf.push(lines[i].replace(/^\s*>\s?/, '')); i++; } var bq = el('blockquote'); inlineInto(bq, bqbuf.join(' ')); container.appendChild(bq); continue; } if (/^\s*[-*+]\s+/.test(line)) { var ul = el('ul'); while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { var li = el('li'); inlineInto(li, lines[i].replace(/^\s*[-*+]\s+/, '')); ul.appendChild(li); i++; } container.appendChild(ul); continue; } if (/^\s*\d+\.\s+/.test(line)) { var ol = el('ol'); while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { var li2 = el('li'); inlineInto(li2, lines[i].replace(/^\s*\d+\.\s+/, '')); ol.appendChild(li2); i++; } container.appendChild(ol); continue; } if (/^\s*$/.test(line)) { i++; continue; } var buf2 = [line]; i++; while (i < lines.length && !/^\s*$/.test(lines[i]) && !matchFenceOpen(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !/^\s*---\s*$/.test(lines[i])) { buf2.push(lines[i]); i++; } var p = el('p'); inlineInto(p, buf2.join('\n')); container.appendChild(p); } }

  function buildEditCards(container, taskId, edits) { if (!edits || !edits.length) return; var wrap = el('div', 'edits'); edits.forEach(function (e) { var card = el('div', 'edit-card edit-' + e.kind); var head = el('div', 'edit-head'); var label = el('span', 'edit-summary', e.summary || (e.kind + ' ' + e.path)); var pill = el('span', 'edit-pill', e.status || 'pending'); head.appendChild(label); head.appendChild(pill); card.appendChild(head); if (e.reason) { var r = el('div', 'edit-reason', e.reason); card.appendChild(r); } if (e.status === 'pending' && permissionMode !== 'read') { var actions = el('div', 'edit-actions'); var applyB = el('button', 'edit-btn apply', 'Apply'); applyB.addEventListener('click', function () { fetch('/edit/apply', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: taskId, edit: e }) }).then(function (r) { return r.json(); }).then(function (r) { if (r.ok) toast('Applied: ' + e.path); else toast('Failed: ' + (r.reason || 'unknown')); }).catch(function (err) { toast('Failed: ' + err.message); }); }); var rejectB = el('button', 'edit-btn reject', 'Reject'); rejectB.addEventListener('click', function () { fetch('/edit/reject', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ taskId: taskId, edit: e }) }).then(function () { toast('Rejected'); }); }); actions.appendChild(applyB); actions.appendChild(rejectB); card.appendChild(actions); } wrap.appendChild(card); }); container.appendChild(wrap); }

  function buildActions(getText, retryFn) { var bar = el('div', 'actions'); var copyAct = document.createElement('button'); copyAct.className = 'act'; copyAct.type = 'button'; copyAct.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg><span>Copy</span>'; copyAct.addEventListener('click', function () { var text = getText() || ''; var done = function () { copyAct.classList.add('ok'); toast('Copied'); setTimeout(function () { copyAct.classList.remove('ok'); }, 1200); }; if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(function (e) { toast('Copy failed: ' + e.message); }); else { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed'); } ta.remove(); } }); bar.appendChild(copyAct); var mdAct = document.createElement('button'); mdAct.className = 'act'; mdAct.type = 'button'; mdAct.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg><span>Download .md</span>'; mdAct.addEventListener('click', function () { download('response.md', getText() || '', 'text/markdown'); toast('Downloaded'); }); bar.appendChild(mdAct); if (retryFn) { var retryAct = document.createElement('button'); retryAct.className = 'act'; retryAct.type = 'button'; retryAct.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"></path></svg><span>Retry</span>'; retryAct.addEventListener('click', retryFn); bar.appendChild(retryAct); } return bar; }

  function renderUserBubble(bubble, text, images) { bubble.innerHTML = ''; if (images && images.length) { var grid = el('div', 'attachments'); images.forEach(function (img) { var a = el('div', 'attachment'); var im = document.createElement('img'); im.src = img.dataUrl; im.alt = img.name || 'image'; a.appendChild(im); grid.appendChild(a); }); bubble.appendChild(grid); } if (text) { var t = el('div', 'utext', text); bubble.appendChild(t); } }

  function makeTurn(id, text, images) {
    ensureEmptyGone();
    var userTurn = el('div', 'turn user'); userTurn.dataset.id = String(id);
    var userRow = el('div', 'row'); userRow.appendChild(el('div', 'role', 'You'));
    var userBubble = el('div', 'bubble user'); renderUserBubble(userBubble, text, images || []);
    userRow.appendChild(userBubble); userTurn.appendChild(userRow); feed.appendChild(userTurn);
    var botTurn = el('div', 'turn bot'); botTurn.dataset.id = String(id);
    var botRow = el('div', 'row'); botRow.appendChild(el('div', 'role', 'Assistant'));
    var botBubble = el('div', 'bubble bot');
    var waiting = el('div', 'waiting'); waiting.innerHTML = '<span class="dot-anim"></span><span class="word">Queued</span>'; botBubble.appendChild(waiting); botRow.appendChild(botBubble);
    var meta = el('div', 'meta');
    var pill = el('span', 'pill warn', 'queued'); meta.appendChild(pill);
    var cancelBtn = document.createElement('button'); cancelBtn.className = 'pill-cancel'; cancelBtn.textContent = 'Cancel'; cancelBtn.title = 'Cancel queued message';
    cancelBtn.addEventListener('click', function () { fetch('/task/' + id + '/cancel', { method: 'POST' }).then(function () { toast('Cancelled'); }).catch(function () {}); });
    meta.appendChild(cancelBtn);
    botRow.appendChild(meta);
    var actionsWrap = el('div', 'actions'); actionsWrap.style.opacity = '0';
    var t = { botBubble: botBubble, metaEl: meta, pill: pill, cancelBtn: cancelBtn, startedAt: Date.now(), thinking: null, waiting: waiting, textNode: null, cursor: null, currentText: '', actionsWrap: actionsWrap, promptText: text, promptImages: images || [], streamCommitted: false, lastMdRender: 0, verifying: false, attachWarnShown: false, state: 'queued' };
    var bar = buildActions(function () { return t.currentText; }, function () { submit(t.promptText, t.promptImages); });
    t.actions = bar; actionsWrap.appendChild(bar); botRow.appendChild(actionsWrap);
    botTurn.appendChild(botRow); feed.appendChild(botTurn); scrollDown({ smooth: false }); turns.set(id, t); return t;
  }
  function setPill(t, status, extra) { if (!t) return; t.pill.className = 'pill' + (status === 'ok' ? ' ok' : status === 'error' ? ' err' : status === 'verify' || status === 'retry' || status === 'queued' || status === 'cancelled' ? ' warn' : ''); t.pill.textContent = status; if (extra) { var dur = t.metaEl.querySelector('.pill.dur'); if (!dur) { dur = el('span', 'pill dur'); t.metaEl.appendChild(dur); } dur.textContent = extra; } if (t.cancelBtn) t.cancelBtn.style.display = (status === 'queued') ? '' : 'none'; }
  function showWaiting(t) { if (!t) return; if (t.thinking && t.thinking.parentElement) { t.thinking.remove(); t.thinking = null; } if (t.waiting && t.waiting.parentElement) return; t.botBubble.textContent = ''; var w = el('div', 'waiting'); w.innerHTML = '<span class="dot-anim"></span><span class="word">Queued</span>'; t.botBubble.appendChild(w); t.waiting = w; t.state = 'queued'; }
  function showThinking(t, mode) { if (!t) return; if (t.waiting && t.waiting.parentElement) { t.waiting.remove(); t.waiting = null; } if (t.thinking && t.thinking.parentElement) { t.thinking.classList.toggle('verify', mode === 'verify'); var w = t.thinking.querySelector('.word'); if (w) w.textContent = mode === 'verify' ? 'Waiting for verification…' : 'Thinking…'; t.state = mode; return; } t.botBubble.textContent = ''; var th = el('div', 'thinking' + (mode === 'verify' ? ' verify' : '')); th.innerHTML = '<span class="orb"></span><span class="word">' + (mode === 'verify' ? 'Waiting for verification…' : 'Thinking…') + '</span>'; t.botBubble.appendChild(th); t.thinking = th; t.state = mode; }

  function renderStream(id, text) {
    var t = turns.get(id); if (!t) return;
    if (t.waiting && t.waiting.parentElement) { t.waiting.remove(); t.waiting = null; }
    if (t.thinking && t.thinking.parentElement) { t.thinking.remove(); t.thinking = null; }
    if (t.actionsWrap) t.actionsWrap.style.opacity = '1';
    if (t.verifying) { t.verifying = false; setPill(t, 'streaming', null); }
    t.state = 'streaming';
    t.currentText = text || '';
    if (!t.streamCommitted) {
      t.streamCommitted = true;
      var hasFence = t.currentText.indexOf(FENCE) !== -1;
      t.mdMode = hasFence;
      if (t.mdMode) { t.botBubble.classList.add('md'); }
      else { t.botBubble.textContent = ''; t.textNode = document.createTextNode(''); t.botBubble.appendChild(t.textNode); t.cursor = el('span', 'cursor'); t.botBubble.appendChild(t.cursor); }
    }
    if (t.mdMode) {
      var now = Date.now();
      if (now - t.lastMdRender >= 120) {
        t.lastMdRender = now;
        renderMarkdown(t.botBubble, t.currentText);
        if (t.cursor && t.cursor.parentElement) t.cursor.remove();
        t.cursor = el('span', 'cursor'); t.botBubble.appendChild(t.cursor);
      }
    } else {
      if (t.textNode) t.textNode.nodeValue = t.currentText;
    }
    scrollDown({ smooth: false });
  }

  function renderVerify(id, on) { var t = turns.get(id); if (!t) return; t.verifying = !!on; if (on) { setPill(t, 'verification', null); showThinking(t, 'verify'); } else { setPill(t, 'streaming', null); if (!t.currentText && t.state !== 'queued') showThinking(t, 'thinking'); } scrollDown({ smooth: false }); }
  function renderRunning(id) { var t = turns.get(id); if (!t) return; if (t.currentText) return; setPill(t, 'thinking', null); showThinking(t, 'thinking'); scrollDown({ smooth: false }); }

  function renderFinal(id, text, durationMs, attachFailed, edits) {
    var t = turns.get(id); if (!t) return;
    if (t.waiting && t.waiting.parentElement) { t.waiting.remove(); t.waiting = null; }
    if (t.thinking && t.thinking.parentElement) { t.thinking.remove(); t.thinking = null; }
    t.verifying = false; t.currentText = text || ''; t.state = 'ok';
    // Fade out, re-render as markdown, fade in.
    var applyFinal = function () {
      t.botBubble.classList.add('md');
      renderMarkdown(t.botBubble, text || '');
      if (edits && edits.length) buildEditCards(t.botBubble, id, edits);
      t.textNode = null; t.cursor = null;
      setPill(t, 'ok', durationMs != null ? fmtMs(durationMs) : null);
      if (attachFailed && !t.attachWarnShown) { t.attachWarnShown = true; t.botBubble.classList.add('warn'); var warn = el('div', null, 'Note: your image could not be attached on the site.'); warn.style.marginTop = '10px'; warn.style.fontSize = '13px'; warn.style.color = 'var(--warn)'; t.botBubble.appendChild(warn); }
      if (t.actionsWrap) t.actionsWrap.style.opacity = '1';
      t.botBubble.classList.add('fade-in');
      setTimeout(function () { t.botBubble.classList.remove('fade-in'); }, 200);
      scrollDown({ smooth: false });
    };
    t.botBubble.classList.add('fade-out');
    setTimeout(function () {
      t.botBubble.classList.remove('fade-out');
      applyFinal();
    }, 120);
  }

  function renderError(id, msg) { var t = turns.get(id); if (!t) return; if (t.waiting && t.waiting.parentElement) { t.waiting.remove(); t.waiting = null; } if (t.thinking && t.thinking.parentElement) { t.thinking.remove(); t.thinking = null; } t.botBubble.className = 'bubble bot err'; t.botBubble.textContent = msg || 'error'; t.textNode = null; t.cursor = null; t.verifying = false; t.state = 'error'; setPill(t, 'error', null); scrollDown({ smooth: false }); }
  function renderCancelled(id) { var t = turns.get(id); if (!t) return; if (t.waiting && t.waiting.parentElement) { t.waiting.remove(); t.waiting = null; } if (t.thinking && t.thinking.parentElement) { t.thinking.remove(); t.thinking = null; } t.botBubble.className = 'bubble bot warn'; t.botBubble.textContent = 'Cancelled'; t.state = 'cancelled'; setPill(t, 'cancelled', null); scrollDown({ smooth: false }); }

  async function activateSession(id) { try { const res = await fetch('/sessions/activate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: id }) }); if (!res.ok) throw new Error('activate failed'); activeSessionId = id; renderSidebar(); if (isNarrow()) app.classList.remove('sidebar-open'); await loadSessionTasks(id); scrollDown({ smooth: true }); } catch (e) { toast('Could not switch session'); } }
  async function loadSessionTasks(id) { try { const res = await fetch('/sessions/' + id + '/tasks'); const data = await res.json(); resetFeed(); (data.tasks || []).forEach(function (task) { makeTurn(task.id, task.text, task.images || []); if (task.status === 'running') renderRunning(task.id); if (task.reply) renderFinal(task.id, task.reply, task.durationMs, task.attachFailed, task.edits); else if (task.status === 'error') renderError(task.id, task.error || 'error'); else if (task.status === 'timeout') renderError(task.id, 'Timed out waiting for the extension.'); else if (task.status === 'cancelled') renderCancelled(task.id); }); } catch (e) { toast('Could not load session'); } }
  async function newSession() { try { const res = await fetch('/sessions/new', { method: 'POST' }); const data = await res.json(); if (data && data.session) { upsertSession(data.session); activeSessionId = data.session.id; renderSidebar(); resetFeed(); if (isNarrow()) app.classList.remove('sidebar-open'); } } catch (e) { toast('Could not create session'); } }
  async function deleteSession(id) { try { const res = await fetch('/sessions/' + id, { method: 'DELETE' }); if (!res.ok) throw new Error('delete failed'); sessionsMap.delete(id); renderSidebar(); if (id === activeSessionId) { const r2 = await fetch('/sessions'); const d2 = await r2.json(); if (d2 && d2.activeId) { activeSessionId = d2.activeId; renderSidebar(); await loadSessionTasks(activeSessionId); } else { resetFeed(); } } } catch (e) { toast('Could not delete'); } }
  newChatBtn.addEventListener('click', newSession);

  function showStop(on) { if (on) stopBtn.hidden = false; else stopBtn.hidden = true; }

  var es = new EventSource('/events');
  es.addEventListener('task', function (ev) {
    var t = JSON.parse(ev.data);
    if (t.sessionId && activeSessionId && t.sessionId !== activeSessionId) return;
    if (t.status === 'queued') makeTurn(t.id, t.text, t.images);
    else if (t.status === 'running') { renderRunning(t.id); currentRunningId = t.id; showStop(true); }
    else if (t.status === 'ok') { renderFinal(t.id, t.reply || '', t.durationMs, t.attachFailed, t.edits); if (String(currentRunningId) === String(t.id)) { currentRunningId = null; showStop(false); } }
    else if (t.status === 'error') { renderError(t.id, t.error); if (String(currentRunningId) === String(t.id)) { currentRunningId = null; showStop(false); } }
    else if (t.status === 'timeout') { renderError(t.id, 'Timed out waiting for the extension.'); if (String(currentRunningId) === String(t.id)) { currentRunningId = null; showStop(false); } }
    else if (t.status === 'cancelled') { renderCancelled(t.id); if (String(currentRunningId) === String(t.id)) { currentRunningId = null; showStop(false); } }
  });
  es.addEventListener('stream', function (ev) { var d = JSON.parse(ev.data); renderStream(d.id, d.text || ''); });
  es.addEventListener('verify', function (ev) { var d = JSON.parse(ev.data); renderVerify(d.id, d.on); });
  es.addEventListener('sessions', function (ev) { var d = JSON.parse(ev.data); sessionsMap.clear(); (d.sessions || []).forEach(function (s) { sessionsMap.set(s.id, s); }); if (d.activeId) activeSessionId = d.activeId; renderSidebar(); });
  es.addEventListener('session', function (ev) { var d = JSON.parse(ev.data); if (d.kind === 'created' || d.kind === 'updated') { upsertSession(d.session); renderSidebar(); } });
  es.addEventListener('workspace', function (ev) { var snap = JSON.parse(ev.data); applyWorkspaceSnapshot(snap); });
  es.addEventListener('memory', function (ev) { var snap = JSON.parse(ev.data); applyMemorySnapshot(snap); });
  es.addEventListener('provider', function (ev) { var d = JSON.parse(ev.data); if (d.active) { activeProvider = d.active; providerLabel.textContent = activeProvider.label || activeProvider.id; renderProviderMenu(); } });
  es.addEventListener('permission', function (ev) { var d = JSON.parse(ev.data); applyPermission(d.mode); });
  es.addEventListener('toast', function (ev) { var d = JSON.parse(ev.data); toast(d.text || ''); });
  es.addEventListener('status', function (ev) { var s = JSON.parse(ev.data); status.classList.toggle('on', !!s.connected); status.classList.toggle('verify', !!(s.meta && s.meta.verifying)); statusText.textContent = s.connected ? (s.meta && s.meta.verifying ? 'Waiting for verification' : 'Connected') : 'Disconnected'; if (s.meta && s.connected) { var bits = []; if (s.meta.busy) bits.push('busy'); if (s.meta.task != null) bits.push('task ' + s.meta.task); statusMeta.textContent = bits.length ? '· ' + bits.join(' · ') : ''; } else statusMeta.textContent = ''; });
  es.onerror = function () { status.classList.remove('on'); statusText.textContent = 'Reconnecting'; statusMeta.textContent = ''; };

  function autosize() { q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 220) + 'px'; }
  q.addEventListener('input', autosize);
  stopBtn.addEventListener('click', function () { if (!currentRunningId) return; fetch('/task/' + currentRunningId + '/cancel', { method: 'POST' }).then(function () { toast('Cancelling…'); }).catch(function () { toast('Could not cancel'); }); });
  function submit(forcedText, forcedImages) { var text = (forcedText != null ? forcedText : q.value).trim(); var images = forcedImages != null ? forcedImages : pendingImages.slice(); if (!text && (!images || !images.length)) return; if (forcedText == null) { q.value = ''; autosize(); pendingImages = []; renderPasteStrip(); } sendBtn.disabled = true; fetch('/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text, images: images, sessionId: activeSessionId }) }).catch(function (e) { var id = 'local-' + Date.now(); makeTurn(id, text, images); renderError(id, 'Could not reach the local server: ' + e.message); }).then(function () { setTimeout(function () { sendBtn.disabled = false; q.focus(); }, 100); }); }
  f.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
  q.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
  q.focus();
  clearBtn.addEventListener('click', newSession);

  loadProvider();
  fetch('/permission').then(function (r) { return r.json(); }).then(function (d) { if (d && d.mode) applyPermission(d.mode); }).catch(function () {});
  refreshWorkspace();
  refreshMemory();
})();
