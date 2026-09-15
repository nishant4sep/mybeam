// offscreen.js — polling + streaming relay to local MyBeam server.
// Also relays verification state so the UI can show "Waiting for verification".

const SERVER = 'http://localhost:3210';
const POLL_MS = 1000;
const HEARTBEAT_MS = 4000;
const REQUEST_TIMEOUT_MS = 30000;
const DOM_TASK_TIMEOUT_MS = 900000; // 15 min: verification can take a while
const STREAM_FLUSH_MS = 33;

let domReady = false;
let domBusy = false;
let inFlight = false;
let currentTaskId = null;
let verifying = false;

let streamId = null;
let streamText = '';
let streamTimer = null;
let streamInFlight = false;

function log(...a) { console.log('[MyBeam:offscreen]', ...a); }

async function fetchWithTimeout(url, opts, ms) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function beat(payload = {}) {
  try {
    await fetchWithTimeout(`${SERVER}/heartbeat`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ts: Date.now(), ...payload })
    }, 5000);
  } catch (_) {}
}

function sendToBackground(msg, timeoutMs) {
  return new Promise((resolve) => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve({ ok: false, error: 'background-timeout' }); } }, timeoutMs);
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (done) return;
        done = true; clearTimeout(t);
        if (chrome.runtime.lastError) resolve({ ok: false, error: chrome.runtime.lastError.message });
        else resolve(resp || { ok: false, error: 'no-response' });
      });
    } catch (e) {
      if (done) return;
      done = true; clearTimeout(t);
      resolve({ ok: false, error: String(e && e.message || e) });
    }
  });
}

function flushStream() {
  streamTimer = null;
  if (!streamId || !streamText) return;
  if (streamInFlight) { scheduleFlush(); return; }
  const id = streamId;
  const text = streamText;
  streamInFlight = true;
  fetch(`${SERVER}/stream`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    keepalive: true,
    body: JSON.stringify({ id, text })
  }).catch(() => {}).finally(() => {
    streamInFlight = false;
    if (streamText !== text) scheduleFlush();
  });
}

function scheduleFlush() {
  if (streamTimer != null) return;
  streamTimer = setTimeout(flushStream, STREAM_FLUSH_MS);
}

function queueStream(taskId, text) {
  if (taskId !== streamId) { streamId = taskId; streamText = ''; }
  streamText = text || '';
  scheduleFlush();
}

async function postVerify(taskId, on) {
  try {
    await fetchWithTimeout(`${SERVER}/verify`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: taskId, on: !!on })
    }, 5000);
  } catch (_) {}
}

async function pollWork() {
  if (inFlight) return;
  inFlight = true;
  try {
    const res = await fetchWithTimeout(`${SERVER}/work`, { method: 'GET' }, REQUEST_TIMEOUT_MS);
    if (res.status === 204 || res.status === 404) return;
    if (!res.ok) return;
    const task = await res.json().catch(() => null);
    if (!task || !task.id || !task.text) return;

    currentTaskId = task.id;
    streamId = task.id;
    streamText = '';
    verifying = false;
    log('dispatching task', task.id);
    const result = await sendToBackground({ type: 'MYBEAM_DOM_TASK', task }, DOM_TASK_TIMEOUT_MS);
    currentTaskId = null;
    verifying = false;
    log('task result', task.id, result.ok ? 'ok' : result.error);

    await fetchWithTimeout(`${SERVER}/result`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: task.id, ok: !!result.ok, reply: result.reply || null, error: result.error || null })
    }, 10000).catch(() => {});

    streamId = null;
    streamText = '';
  } catch (_) {
  } finally {
    inFlight = false;
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'MYBEAM_STATE') { domReady = !!msg.connected; domBusy = !!msg.busy; }
  else if (msg.type === 'MYBEAM_STREAM' && msg.taskId) { queueStream(msg.taskId, msg.text || ''); }
  else if (msg.type === 'MYBEAM_VERIFY' && msg.taskId) {
    const wasOn = verifying;
    verifying = !!msg.on;
    if (wasOn !== verifying) postVerify(msg.taskId, verifying);
  }
});

setInterval(() => beat({ ready: domReady, busy: domBusy, task: currentTaskId, verifying }), HEARTBEAT_MS);

(function loop() { pollWork().finally(() => setTimeout(loop, POLL_MS)); })();

beat({ ready: false, busy: false, boot: true });
log('offscreen polling started');
