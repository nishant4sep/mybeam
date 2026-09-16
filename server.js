// server.js — MyBeam Workstation
// Changes:
//  - Context block wrapped only on first user message of a session (or after idle).
//  - Reply is passed through edits.stripForDisplay before broadcasting.
//  - Existing edit-card rendering intact.

const http = require('http');
const { URL } = require('url');
const path = require('path');
const staticFiles = require('./lib/static');
const config = require('./lib/config');
const workspace = require('./lib/workspace');
const memory = require('./lib/memory');
const provider = require('./lib/provider');
const edits = require('./lib/edits');
const apply = require('./lib/apply');
const cancel = require('./lib/cancel');
const prompt = require('./lib/prompt');
const { pickFolder } = require('./lib/dialog');

const PORT = 3210;
const TASK_TIMEOUT_MS = 900_000;
const HEARTBEAT_FRESH_MS = 4_000;
const STREAM_BROADCAST_MS = 33;
const UI_DIR = path.join(__dirname, 'ui');

let nextTaskId = 1;
let nextSessionId = 1;
const queue = [];
const pending = new Map();
const sessions = new Map();
let defaultSessionId = null;
let runningTaskId = null;
let permissionMode = 'ask';
let lastHeartbeat = 0;
let lastHeartbeatMeta = {};
const listeners = new Set();

function broadcast(event, data) { const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n'; for (const res of listeners) { try { res.write(payload); } catch (_) {} } }
const streamBuf = new Map();
function broadcastStream(id, text) {
  const cur = streamBuf.get(id); if (cur) { cur.text = text; return; }
  const entry = { text, timer: setTimeout(() => { streamBuf.delete(id); broadcast('stream', { id, text: entry.text }); }, STREAM_BROADCAST_MS) };
  streamBuf.set(id, entry);
}

function workspaceSnapshot() {
  const active = config.getActiveWorkspace();
  if (!active) return { active: null, tree: null, workspaces: config.listWorkspaces() };
  let tree = null;
  try { workspace.setRoot(active.path); tree = workspace.readTree(); }
  catch (e) { return { active: { path: active.path, name: active.name, invalid: true, error: String(e.message || e) }, tree: null, workspaces: config.listWorkspaces() }; }
  return { active: { path: active.path, name: active.name, invalid: false }, tree, workspaces: config.listWorkspaces() };
}
function activateWorkspace(absPath) {
  const entry = config.setActiveWorkspace(absPath);
  workspace.setRoot(entry.path);
  broadcast('workspace', workspaceSnapshot());
  broadcast('memory', memory.memorySnapshot());
  return entry;
}
function sessionSummary(s) { let running = 0, queued = 0; for (const t of s.tasks) { if (t.status === 'queued') queued++; else if (t.status === 'running') running++; } return { id: s.id, title: s.title, createdAt: s.createdAt, updatedAt: s.updatedAt, taskCount: s.tasks.length, running, queued }; }
function allSessionSummaries() { return Array.from(sessions.values()).sort((a, b) => b.updatedAt - a.updatedAt).map(sessionSummary); }
function taskEntrySummary(h) {
  return {
    id: h.id, status: h.status, text: h.text, images: h.images || [], reply: h.reply,
    error: h.error, attachFailed: !!h.attachFailed, verifying: !!h.verifying,
    startedAt: h.startedAt, finishedAt: h.finishedAt,
    durationMs: h.finishedAt && h.startedAt ? (h.finishedAt - h.startedAt) : null,
    provider: h.provider || null,
    edits: h.edits || null
  };
}
function deriveTitle(text) { const t = (text || '').replace(/\s+/g, ' ').trim(); if (!t) return 'New chat'; return t.length > 48 ? t.slice(0, 48) + '…' : t; }
function createSession(title) { const id = String(nextSessionId++); const now = Date.now(); const s = { id, title: title || 'New chat', createdAt: now, updatedAt: now, tasks: [] }; sessions.set(id, s); broadcast('session', { kind: 'created', session: sessionSummary(s) }); return s; }
function findEmptySession() { for (const s of sessions.values()) { if (s.tasks.length === 0) return s; } return null; }
function ensureDefaultSession() { if (defaultSessionId && sessions.has(defaultSessionId)) return sessions.get(defaultSessionId); let s = findEmptySession(); if (!s) s = createSession('New chat'); defaultSessionId = s.id; return s; }

function enqueueTask(text, images, sessionId) {
  const s = (sessionId && sessions.get(sessionId)) || ensureDefaultSession();
  const id = nextTaskId++;
  const imgs = Array.isArray(images) ? images.slice(0, 8) : [];
  const freshContext = s.tasks.length === 0;
  const active = provider.getActive();
  const wsActive = config.getActiveWorkspace();

  // Wrap the context block only when this is the first user message of the
  // session, or when the session has been idle for a long time.
  const wrapIt = prompt.shouldWrap(s);
  const outbound = wrapIt ? prompt.wrapFirst(text, {
    workspaceName: wsActive ? wsActive.name : null,
    workspacePath: wsActive ? wsActive.path : null,
    permissionMode
  }) : text;

  const entry = {
    id, sessionId: s.id, text, images: imgs, status: 'queued', reply: '', error: null,
    startedAt: Date.now(), finishedAt: null, verifying: false, attachFailed: false,
    provider: active.id, edits: null
  };
  s.tasks.push(entry); s.updatedAt = Date.now();
  if (s.title === 'New chat' && text) { s.title = deriveTitle(text); broadcast('session', { kind: 'updated', session: sessionSummary(s) }); }
  try { memory.appendTranscript(s.id, { role: 'user', text, images: imgs.length, provider: active.id }); } catch (_) {}
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const p = pending.get(id); if (!p) return;
      pending.delete(id);
      const i = queue.findIndex((t) => t.id === id);
      if (i >= 0) queue.splice(i, 1);
      entry.status = 'timeout'; entry.error = 'timeout'; entry.finishedAt = Date.now();
      if (runningTaskId === id) runningTaskId = null;
      s.updatedAt = Date.now();
      console.log('[task ' + id + '] TIMEOUT');
      broadcast('task', { id, sessionId: s.id, status: 'timeout', text });
      broadcast('session', { kind: 'updated', session: sessionSummary(s) });
      reject(new Error('timeout'));
    }, TASK_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, text, entry, session: s });
    queue.push({ id, text: outbound, displayText: text, images: imgs, sessionId: s.id, freshContext, provider: active.id, enqueuedAt: Date.now(), wrapIt });
    broadcast('task', { id, sessionId: s.id, status: 'queued', text, images: imgs, startedAt: entry.startedAt, provider: active.id });
    broadcast('session', { kind: 'updated', session: sessionSummary(s) });
  });
}

function takeNextTask() {
  const task = queue.shift(); if (!task) return null;
  const p = pending.get(task.id);
  if (p) {
    p.entry.status = 'running'; p.entry.startedAt = Date.now();
    broadcast('task', { id: task.id, sessionId: task.sessionId, status: 'running', text: task.displayText || task.text, images: task.images, startedAt: p.entry.startedAt, provider: task.provider });
    if (p.session) broadcast('session', { kind: 'updated', session: sessionSummary(p.session) });
  }
  runningTaskId = task.id;
  return task;
}

function deliverStream(id, text) { const p = pending.get(id); if (!p) return false; p.entry.reply = text; broadcastStream(id, text); return true; }
function deliverVerify(id, on) { const p = pending.get(id); if (!p) return false; p.entry.verifying = !!on; broadcast('verify', { id, on: !!on }); return true; }

function deliverResult(id, payload) {
  const p = pending.get(id); if (!p) return false;
  clearTimeout(p.timer); pending.delete(id);
  p.entry.finishedAt = Date.now(); p.entry.verifying = false;
  if (runningTaskId === id) runningTaskId = null;
  if (p.session) p.session.updatedAt = Date.now();
  try { memory.appendTranscript(p.entry.sessionId, { role: 'assistant', text: payload.reply || '', error: payload.error || null, ok: !!payload.ok, provider: p.entry.provider || null }); } catch (_) {}

  if (cancel.isCancelled(id)) {
    p.entry.status = 'cancelled'; p.entry.error = 'cancelled';
    broadcast('task', { id, sessionId: p.entry.sessionId, status: 'cancelled', text: p.text, finishedAt: p.entry.finishedAt });
    cancel.clear(id);
    p.reject(new Error('cancelled'));
    if (p.session) broadcast('session', { kind: 'updated', session: sessionSummary(p.session) });
    return true;
  }

  if (payload.ok) {
    p.entry.status = 'ok'; p.entry.reply = payload.reply || ''; p.entry.attachFailed = !!payload.attachFailed;

    // Parse directives and strip them from the display text.
    let parsedEdits = [];
    try { parsedEdits = edits.parse(payload.reply || ''); } catch (_) {}
    p.entry.edits = parsedEdits.length ? parsedEdits.map((e, idx) => ({ idx, kind: e.kind, path: e.path, summary: edits.describe(e), status: 'pending' })) : null;

    // Auto-apply in Auto mode.
    if (parsedEdits.length && permissionMode === 'auto' && config.getActiveWorkspace()) {
      try {
        const results = apply.applyAll(parsedEdits);
        p.entry.edits = results.map((r, idx) => ({ idx, kind: r.edit.kind, path: r.edit.path, summary: edits.describe(r.edit), status: r.ok ? 'applied' : 'error', reason: r.reason || null, backup: r.backup || null }));
      } catch (e) {}
    }

    const displayReply = edits.stripForDisplay(payload.reply || '');

    provider.recordSuccess(p.entry.provider);
    console.log('[task ' + id + '] ok (' + parsedEdits.length + ' edits)');
    broadcast('task', { id, sessionId: p.entry.sessionId, status: 'ok', text: p.text, reply: displayReply, edits: p.entry.edits, attachFailed: !!payload.attachFailed, finishedAt: p.entry.finishedAt, durationMs: p.entry.finishedAt - p.entry.startedAt, provider: p.entry.provider });
    p.resolve(displayReply);
  } else {
    p.entry.status = 'error'; p.entry.error = payload.error || 'error';
    console.log('[task ' + id + '] error: ' + payload.error);
    const failed = provider.recordFailure(p.entry.provider);
    broadcast('task', { id, sessionId: p.entry.sessionId, status: 'error', text: p.text, error: payload.error, finishedAt: p.entry.finishedAt, provider: p.entry.provider });
    if (failed >= 2) {
      const next = provider.maybeAutoSwitch(p.entry.provider);
      if (next) { broadcast('provider', { active: next }); broadcast('toast', { kind: 'info', text: 'Auto-switched to ' + next.label }); }
    }
    p.reject(new Error(payload.error || 'extension-error'));
  }
  if (p.session) broadcast('session', { kind: 'updated', session: sessionSummary(p.session) });
  return true;
}

function readBody(req) { return new Promise((resolve, reject) => { const chunks = []; req.on('data', (c) => chunks.push(c)); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8'))); req.on('error', reject); }); }
function json(res, code, obj) { const body = JSON.stringify(obj); res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS' }); res.end(body); }

try { const active = config.getActiveWorkspace(); if (active) workspace.setRoot(active.path); } catch (_) {}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const p = url.pathname;

  if (req.method === 'OPTIONS') { res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS' }); return res.end(); }
  if (req.method === 'GET' && p === '/') return staticFiles.sendFile(res, UI_DIR, 'index.html', { noCache: true });
  if (req.method === 'GET' && p.startsWith('/ui/')) return staticFiles.sendFile(res, UI_DIR, p.slice(4), { noCache: true });

  if (req.method === 'GET' && p === '/provider') return json(res, 200, { providers: provider.list(), active: provider.getActive(), autoSwitch: provider.getAutoSwitch() });
  if (req.method === 'POST' && p === '/provider') { const body = await readBody(req); let parsed; try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'bad-json' }); } try { const active = provider.setActive(parsed.id); broadcast('provider', { active }); return json(res, 200, { ok: true, active }); } catch (e) { return json(res, 200, { ok: false, reason: String(e.message || e) }); } }
  if (req.method === 'POST' && p === '/provider/autoswitch') { const body = await readBody(req); let parsed; try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'bad-json' }); } const on = provider.setAutoSwitch(!!parsed.on); return json(res, 200, { ok: true, autoSwitch: on }); }

  if (req.method === 'GET' && p === '/permission') return json(res, 200, { mode: permissionMode });
  if (req.method === 'POST' && p === '/permission') { const body = await readBody(req); let parsed; try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'bad-json' }); } if (['read', 'ask', 'auto'].indexOf(parsed.mode) === -1) return json(res, 400, { error: 'bad-mode' }); permissionMode = parsed.mode; broadcast('permission', { mode: permissionMode }); return json(res, 200, { ok: true, mode: permissionMode }); }

  if (req.method === 'POST' && p === '/edit/apply') { const body = await readBody(req); let parsed; try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'bad-json' }); } const taskId = String(parsed.taskId || ''); const session = [...sessions.values()].find((s) => s.tasks.some((t) => String(t.id) === taskId)); const taskEntry = session ? session.tasks.find((t) => String(t.id) === taskId) : null; if (!taskEntry) return json(res, 404, { error: 'task-not-found' }); if (permissionMode === 'read') return json(res, 200, { ok: false, reason: 'read-only-mode' }); const edit = parsed.edit; const r = apply.applyOne(edit); if (!taskEntry.edits) taskEntry.edits = []; const idx = taskEntry.edits.findIndex((e) => e.path === edit.path && e.kind === edit.kind && e.status === 'pending'); if (idx >= 0) { taskEntry.edits[idx].status = r.ok ? 'applied' : 'error'; taskEntry.edits[idx].reason = r.reason || null; taskEntry.edits[idx].backup = r.backup || null; } broadcast('task', { id: taskId, sessionId: taskEntry.sessionId, status: 'ok', text: taskEntry.text, reply: taskEntry.reply, edits: taskEntry.edits, finishedAt: taskEntry.finishedAt, provider: taskEntry.provider }); return json(res, 200, r); }
  if (req.method === 'POST' && p === '/edit/reject') { const body = await readBody(req); let parsed; try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'bad-json' }); } const taskId = String(parsed.taskId || ''); const session = [...sessions.values()].find((s) => s.tasks.some((t) => String(t.id) === taskId)); const taskEntry = session ? session.tasks.find((t) => String(t.id) === taskId) : null; if (!taskEntry || !taskEntry.edits) return json(res, 404, { error: 'task-or-edits-not-found' }); const edit = parsed.edit; const idx = taskEntry.edits.findIndex((e) => e.path === edit.path && e.kind === edit.kind && e.status === 'pending'); if (idx >= 0) taskEntry.edits[idx].status = 'rejected'; broadcast('task', { id: taskId, sessionId: taskEntry.sessionId, status: 'ok', text: taskEntry.text, reply: taskEntry.reply, edits: taskEntry.edits, finishedAt: taskEntry.finishedAt, provider: taskEntry.provider }); return json(res, 200, { ok: true }); }

  if (req.method === 'POST' && p.startsWith('/task/') && p.endsWith('/cancel')) {
    const id = p.slice('/task/'.length, -'/cancel'.length);
    if (!id) return json(res, 400, { error: 'missing-id' });
    cancel.cancel(id);
    const qi = queue.findIndex((t) => String(t.id) === String(id));
    if (qi >= 0) {
      const dropped = queue.splice(qi, 1)[0];
      const p2 = pending.get(dropped.id);
      if (p2) { clearTimeout(p2.timer); pending.delete(dropped.id); p2.entry.status = 'cancelled'; p2.entry.finishedAt = Date.now(); broadcast('task', { id: dropped.id, sessionId: dropped.sessionId, status: 'cancelled', text: dropped.displayText || dropped.text, finishedAt: p2.entry.finishedAt }); p2.reject(new Error('cancelled')); }
    }
    broadcast('cancel', { id });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'GET' && p === '/memory') return json(res, 200, { snapshot: memory.memorySnapshot() });
  if (req.method === 'GET' && p === '/workspace') return json(res, 200, workspaceSnapshot());
  if (req.method === 'POST' && p === '/workspace/pick') { const r = await pickFolder(); if (!r.ok) return json(res, 200, { ok: false, reason: r.reason || 'cancelled' }); try { const entry = activateWorkspace(r.path); return json(res, 200, { ok: true, workspace: entry, snapshot: workspaceSnapshot() }); } catch (e) { return json(res, 200, { ok: false, reason: String(e.message || e) }); } }
  if (req.method === 'POST' && p === '/workspace/set') { const body = await readBody(req); let parsed; try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'bad-json' }); } const abs = (parsed && parsed.path || '').trim(); if (!abs) return json(res, 400, { error: 'empty-path' }); try { const entry = activateWorkspace(abs); return json(res, 200, { ok: true, workspace: entry, snapshot: workspaceSnapshot() }); } catch (e) { return json(res, 200, { ok: false, reason: String(e.message || e) }); } }
  if (req.method === 'DELETE' && p === '/workspace') { config.clearActiveWorkspace(); workspace.setRoot(null); broadcast('workspace', workspaceSnapshot()); broadcast('memory', null); return json(res, 200, { ok: true, snapshot: workspaceSnapshot() }); }
  if (req.method === 'GET' && p === '/workspace/file') { const rel = url.searchParams.get('path') || ''; if (!rel) return json(res, 400, { error: 'missing-path' }); try { const file = workspace.readFile(rel); return json(res, 200, { ok: true, file }); } catch (e) { return json(res, 200, { ok: false, reason: String(e.message || e) }); } }

  if (req.method === 'GET' && p === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive', 'access-control-allow-origin': '*', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n'); listeners.add(res);
    const connected = Date.now() - lastHeartbeat < HEARTBEAT_FRESH_MS;
    res.write('event: status\ndata: ' + JSON.stringify({ connected, meta: lastHeartbeatMeta }) + '\n\n');
    res.write('event: sessions\ndata: ' + JSON.stringify({ sessions: allSessionSummaries(), activeId: defaultSessionId }) + '\n\n');
    res.write('event: workspace\ndata: ' + JSON.stringify(workspaceSnapshot()) + '\n\n');
    res.write('event: memory\ndata: ' + JSON.stringify(memory.memorySnapshot()) + '\n\n');
    res.write('event: provider\ndata: ' + JSON.stringify({ active: provider.getActive(), providers: provider.list(), autoSwitch: provider.getAutoSwitch() }) + '\n\n');
    res.write('event: permission\ndata: ' + JSON.stringify({ mode: permissionMode }) + '\n\n');
    const active = ensureDefaultSession();
    for (const h of active.tasks) {
      res.write('event: task\ndata: ' + JSON.stringify({ ...taskEntrySummary(h), sessionId: active.id }) + '\n\n');
      if (h.reply) res.write('event: stream\ndata: ' + JSON.stringify({ id: h.id, text: h.reply }) + '\n\n');
    }
    req.on('close', () => listeners.delete(res));
    return;
  }

  if (req.method === 'GET' && p === '/sessions') return json(res, 200, { sessions: allSessionSummaries(), activeId: defaultSessionId });
  if (req.method === 'POST' && p === '/sessions/new') { let s = (defaultSessionId && sessions.get(defaultSessionId)) || null; if (!s || s.tasks.length > 0) s = findEmptySession(); if (!s) s = createSession('New chat'); defaultSessionId = s.id; broadcast('sessions', { sessions: allSessionSummaries(), activeId: defaultSessionId }); return json(res, 200, { session: sessionSummary(s) }); }
  if (req.method === 'POST' && p === '/sessions/activate') { const body = await readBody(req); let parsed; try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'bad-json' }); } const s = sessions.get(String(parsed.id)); if (!s) return json(res, 404, { error: 'not-found' }); defaultSessionId = s.id; broadcast('sessions', { sessions: allSessionSummaries(), activeId: defaultSessionId }); return json(res, 200, { session: sessionSummary(s) }); }
  if (req.method === 'GET' && p.startsWith('/sessions/') && p.endsWith('/tasks')) { const id = p.slice('/sessions/'.length, -'/tasks'.length); const s = sessions.get(id); if (!s) return json(res, 404, { error: 'not-found' }); return json(res, 200, { session: sessionSummary(s), tasks: s.tasks.map(taskEntrySummary) }); }
  if (req.method === 'DELETE' && p.startsWith('/sessions/')) { const id = p.slice('/sessions/'.length); const s = sessions.get(id); if (!s) return json(res, 404, { error: 'not-found' }); sessions.delete(id); if (defaultSessionId === id) { defaultSessionId = null; ensureDefaultSession(); } broadcast('sessions', { sessions: allSessionSummaries(), activeId: defaultSessionId }); return json(res, 200, { ok: true }); }

  if (req.method === 'GET' && p === '/work') { const task = takeNextTask(); if (!task) { res.writeHead(204); return res.end(); } return json(res, 200, task); }
  if (req.method === 'POST' && p === '/stream') { const body = await readBody(req); let parsed; try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'bad-json' }); } const ok = deliverStream(parsed.id, String(parsed.text || '')); return json(res, ok ? 200 : 404, { ok }); }
  if (req.method === 'POST' && p === '/verify') { const body = await readBody(req); let parsed; try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'bad-json' }); } const ok = deliverVerify(parsed.id, !!parsed.on); return json(res, ok ? 200 : 404, { ok }); }
  if (req.method === 'POST' && p === '/result') { const body = await readBody(req); let parsed; try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'bad-json' }); } const ok = deliverResult(parsed.id, parsed); return json(res, ok ? 200 : 404, { ok }); }
  if (req.method === 'POST' && p === '/heartbeat') { const body = await readBody(req); try { lastHeartbeatMeta = JSON.parse(body || '{}'); } catch { lastHeartbeatMeta = {}; } lastHeartbeat = Date.now(); broadcast('status', { connected: true, meta: lastHeartbeatMeta }); return json(res, 200, { ok: true }); }
  if (req.method === 'POST' && p === '/task') { const body = await readBody(req); let parsed; try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: 'bad-json' }); } const text = (parsed && parsed.text || '').trim(); const images = (parsed && parsed.images) || []; const sessionId = parsed && parsed.sessionId || defaultSessionId; if (!text && (!images || !images.length)) return json(res, 400, { error: 'empty' }); enqueueTask(text, images, sessionId).then((reply) => json(res, 200, { ok: true, reply })).catch((err) => json(res, 500, { ok: false, error: err.message })); return; }

  if (req.method === 'GET' && p === '/status') { return json(res, 200, { connected: Date.now() - lastHeartbeat < HEARTBEAT_FRESH_MS, lastHeartbeat, lastHeartbeatMeta, queueLength: queue.length, pendingCount: pending.size, runningTaskId, sessionCount: sessions.size, activeSessionId: defaultSessionId, workspace: config.getActiveWorkspace(), provider: provider.getActive(), permissionMode }); }

  res.writeHead(404, { 'content-type': 'text/plain' }); res.end('not found');
});

ensureDefaultSession();
server.listen(PORT, () => console.log('MyBeam Workstation running at http://localhost:' + PORT));
