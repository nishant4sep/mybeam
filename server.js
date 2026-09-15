// server.js — MyBeam Workstation

const http = require('http');
const { URL } = require('url');

const PORT = 3210;
const TASK_TIMEOUT_MS = 900_000;
const HEARTBEAT_FRESH_MS = 4_000;
const STREAM_BROADCAST_MS = 33;

let nextTaskId = 1;
const queue = [];
const pending = new Map();
const history = [];

let lastHeartbeat = 0;
let lastHeartbeatMeta = {};

const listeners = new Set();

const streamBuf = new Map();
function broadcastStream(id, text) {
  const cur = streamBuf.get(id);
  if (cur) { cur.text = text; return; }
  const entry = { text, timer: setTimeout(() => {
    streamBuf.delete(id);
    broadcast('stream', { id, text: entry.text });
  }, STREAM_BROADCAST_MS) };
  streamBuf.set(id, entry);
}

function broadcast(event, data) {
  const payload = 'event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n';
  for (const res of listeners) { try { res.write(payload); } catch (_) {} }
}

function enqueueTask(text, images) {
  const id = nextTaskId++;
  const imgs = Array.isArray(images) ? images.slice(0, 8) : [];
  const entry = { id, text, images: imgs, status: 'queued', reply: '', error: null, startedAt: Date.now(), finishedAt: null, verifying: false };
  history.push(entry);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const p = pending.get(id);
      if (!p) return;
      pending.delete(id);
      const i = queue.findIndex((t) => t.id === id);
      if (i >= 0) queue.splice(i, 1);
      entry.status = 'timeout'; entry.error = 'timeout'; entry.finishedAt = Date.now();
      console.log('[task ' + id + '] TIMEOUT');
      broadcast('task', { id, status: 'timeout', text });
      reject(new Error('timeout'));
    }, TASK_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, text, entry });
    queue.push({ id, text, images: imgs, enqueuedAt: Date.now() });
    console.log('[task ' + id + '] queued: ' + JSON.stringify(text) + (imgs.length ? (' + ' + imgs.length + ' image(s)') : ''));
    broadcast('task', { id, status: 'queued', text, images: imgs, startedAt: entry.startedAt });
  });
}

function deliverStream(id, text) { const p = pending.get(id); if (!p) return false; p.entry.reply = text; broadcastStream(id, text); return true; }
function deliverVerify(id, on) { const p = pending.get(id); if (!p) return false; p.entry.verifying = !!on; broadcast('verify', { id, on: !!on }); return true; }

function deliverResult(id, payload) {
  const p = pending.get(id); if (!p) return false;
  clearTimeout(p.timer); pending.delete(id); p.entry.finishedAt = Date.now(); p.entry.verifying = false;
  if (payload.ok) {
    p.entry.status = 'ok'; p.entry.reply = payload.reply || '';
    console.log('[task ' + id + '] ok');
    broadcast('task', { id, status: 'ok', text: p.text, reply: payload.reply, attachFailed: !!payload.attachFailed, finishedAt: p.entry.finishedAt, durationMs: p.entry.finishedAt - p.entry.startedAt });
    p.resolve(payload.reply);
  } else {
    p.entry.status = 'error'; p.entry.error = payload.error || 'error';
    console.log('[task ' + id + '] error: ' + payload.error);
    broadcast('task', { id, status: 'error', text: p.text, error: payload.error, finishedAt: p.entry.finishedAt });
    p.reject(new Error(payload.error || 'extension-error'));
  }
  return true;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []; req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}
function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
  res.end(body);
}

const UI_HTML = String.raw`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="color-scheme" content="dark light" />
<title>MyBeam</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    color-scheme: dark light;
    --bg-0: #07080d; --bg-1: #0c0e16; --bg-2: #12141f; --bg-3: #1a1d2b; --bg-code: #0a0c14;
    --line: #1e2233; --line-2: #2a2f45;
    --text: #eef1f8; --text-2: #a9afc4; --text-3: #737a93;
    --accent: #7d6cff; --accent-2: #b39bff;
    --accent-fill: linear-gradient(180deg, #8b7aff, #6248ff);
    --accent-glow: 0 12px 40px -12px rgba(125,108,255,.8);
    --ok: #3ddc97; --err: #ff6b7a; --warn: #ffb454;
    --user-bubble: linear-gradient(180deg, #38325a, #2a2747);
    --bot-bubble: linear-gradient(180deg, #12141f, #0e1018);
    --radius: 18px; --radius-sm: 10px; --radius-pill: 999px;
    --mono: 'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, monospace;
    --shadow-1: 0 1px 0 rgba(255,255,255,.03) inset, 0 1px 2px rgba(0,0,0,.5), 0 12px 32px -16px rgba(0,0,0,.9);
    --shadow-2: 0 1px 0 rgba(255,255,255,.04) inset, 0 2px 4px rgba(0,0,0,.5), 0 24px 60px -24px rgba(0,0,0,.9);
    --shadow-accent: 0 0 0 1px rgba(125,108,255,.35), 0 12px 40px -12px rgba(125,108,255,.6);
    /* layout metrics — single source of truth */
    --page-max: 1200px;       /* outer shell */
    --feed-max: 900px;        /* readable reading column for the message feed */
    --pad-x: clamp(14px, 3vw, 32px);
  }
  @media (prefers-color-scheme: light) {
    :root {
      --bg-0: #f6f7fb; --bg-1: #ffffff; --bg-2: #f3f4f9; --bg-3: #e9ebf3;
      --line: #e4e6ef; --line-2: #d6d9e6;
      --text: #101223; --text-2: #4f5674; --text-3: #7b8199;
      --accent: #6348ff; --accent-2: #7d6cff;
      --accent-fill: linear-gradient(180deg, #7a63ff, #5a3fff);
      --user-bubble: linear-gradient(180deg, #6a51ff, #5336ff);
      --bot-bubble: linear-gradient(180deg, #ffffff, #f7f8fc);
    }
  }

  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0; background: var(--bg-0); color: var(--text);
    font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    font-size: 15px; line-height: 1.55;
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
    overflow: hidden; position: relative;
  }
  body::before {
    content: ''; position: fixed; inset: -30% -20% auto -20%; height: 70vh;
    background:
      radial-gradient(closest-side at 25% 30%, rgba(125,108,255,.18), transparent 70%),
      radial-gradient(closest-side at 75% 20%, rgba(61,220,151,.08), transparent 70%);
    filter: blur(60px); pointer-events: none; z-index: 0;
    animation: drift 26s ease-in-out infinite alternate;
  }
  @keyframes drift { 0% { transform: translate3d(-2%, -1%, 0) scale(1); } 100% { transform: translate3d(3%, 2%, 0) scale(1.06); } }

  .app { position: relative; z-index: 1; display: grid; grid-template-rows: 56px minmax(0, 1fr); height: 100vh; }

  header {
    display: flex; align-items: center; gap: 14px; padding: 0 var(--pad-x);
    border-bottom: 1px solid var(--line);
    background: color-mix(in srgb, var(--bg-1) 72%, transparent);
    backdrop-filter: saturate(180%) blur(22px);
    -webkit-backdrop-filter: saturate(180%) blur(22px);
    position: sticky; top: 0; z-index: 10;
  }
  .brand { display: flex; align-items: center; gap: 11px; font-weight: 600; letter-spacing: -.01em; min-width: 0; }
  .brand-mark {
    width: 30px; height: 30px; border-radius: 10px;
    background: var(--accent-fill); display: grid; place-items: center;
    box-shadow: var(--accent-glow), inset 0 1px 0 rgba(255,255,255,.35);
    position: relative; overflow: hidden; flex: none;
  }
  .brand-mark svg { width: 16px; height: 16px; color: #fff; position: relative; z-index: 1; }
  .brand-mark::after {
    content: ''; position: absolute; inset: 0;
    background: linear-gradient(120deg, transparent 35%, rgba(255,255,255,.55) 50%, transparent 65%);
    transform: translateX(-140%);
    animation: shine 5s ease-in-out infinite;
  }
  @keyframes shine { 0%,72% { transform: translateX(-140%); } 100% { transform: translateX(140%); } }
  .brand-name { font-size: 15px; white-space: nowrap; }
  .brand-sub { color: var(--text-3); font-weight: 400; margin-left: 6px; font-size: 12px; letter-spacing: .02em; white-space: nowrap; }
  .spacer { flex: 1; min-width: 0; }

  .status {
    display: inline-flex; align-items: center; gap: 8px;
    font-size: 12.5px; color: var(--text-2);
    padding: 6px 12px; border-radius: var(--radius-pill);
    background: var(--bg-2); border: 1px solid var(--line);
    transition: color .2s ease, border-color .2s ease, background .2s ease;
    white-space: nowrap; min-width: 0;
  }
  .status .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--err); position: relative; flex: none; }
  .status.on .dot { background: var(--ok); }
  .status.on .dot::after { content: ''; position: absolute; inset: -4px; border-radius: 50%; border: 2px solid var(--ok); opacity: 0; animation: ring 2.4s ease-out infinite; }
  @keyframes ring { 0% { opacity: .9; transform: scale(.6); } 100% { opacity: 0; transform: scale(1.6); } }
  .status.on { color: var(--text); border-color: rgba(61,220,151,.35); }
  .status.verify { border-color: rgba(255,180,84,.55); background: color-mix(in srgb, var(--warn) 12%, var(--bg-2)); color: var(--text); }
  .status.verify .dot { background: var(--warn); }
  .status.verify .dot::after { border-color: var(--warn); }
  .status .meta { color: var(--text-3); font-family: var(--mono); font-size: 11px; }

  .btn-quiet {
    appearance: none; border: 1px solid var(--line); background: var(--bg-2);
    color: var(--text-2); font: inherit; font-size: 13px;
    padding: 7px 13px; border-radius: var(--radius-sm); cursor: pointer;
    transition: color .15s ease, border-color .15s ease, background .15s ease, transform .12s ease;
    white-space: nowrap; flex: none;
  }
  .btn-quiet:hover { color: var(--text); border-color: var(--line-2); background: var(--bg-3); }

  /* two-column shell: feed column + composer column aligned inside --page-max,
     but the feed reading column is capped at --feed-max and centered. */
  main {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    grid-template-rows: minmax(0, 1fr) auto;
    max-width: var(--page-max); width: 100%;
    margin: 0 auto;
    padding: 22px var(--pad-x) 18px;
    min-height: 0; min-width: 0;
  }
  #feed {
    overflow-y: auto; overflow-x: hidden;
    padding: 4px 6px 4px 4px;
    scrollbar-width: thin; scrollbar-color: var(--line-2) transparent;
    scroll-behavior: smooth; min-width: 0; min-height: 0;
    max-width: var(--feed-max); width: 100%;
    margin: 0 auto;
  }
  #feed::-webkit-scrollbar { width: 10px; }
  #feed::-webkit-scrollbar-thumb { background: var(--line-2); border-radius: 8px; }

  .empty { display: grid; place-items: center; height: 100%; color: var(--text-3); text-align: center; }
  .empty h1 { font-size: 24px; font-weight: 700; letter-spacing: -.02em; color: var(--text); margin: 0 0 8px; }
  .empty p { margin: 0; font-size: 14px; max-width: 420px; }

  .turn { display: flex; flex-direction: column; gap: 6px; margin: 22px 0; min-width: 0; }
  .row { display: flex; flex-direction: column; gap: 7px; min-width: 0; }
  .turn.user .row { align-self: flex-end; align-items: flex-end; max-width: 82%; }
  .turn.bot  .row { align-self: flex-start; align-items: flex-start; max-width: 100%; }

  .role { font-size: 11px; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--text-3); padding: 0 8px; }
  .turn.user .role { text-align: right; }

  .bubble {
    border-radius: var(--radius); padding: 13px 17px;
    font-size: 15px; line-height: 1.6;
    background: var(--bot-bubble); color: var(--text);
    border: 1px solid var(--line);
    box-shadow: var(--shadow-1);
    overflow-wrap: anywhere; word-break: break-word;
    min-width: 0; max-width: 100%;
    animation: spring .45s cubic-bezier(.2,1.2,.35,1) both;
    position: relative;
  }
  @keyframes spring { 0% { opacity: 0; transform: translateY(10px) scale(.97); } 60% { opacity: 1; } 100% { opacity: 1; transform: none; } }
  .bubble.user { background: var(--user-bubble); color: #fff; border-color: rgba(255,255,255,.10); border-bottom-right-radius: 6px; }
  .bubble.bot { border-bottom-left-radius: 6px; width: 100%; }
  .bubble.err { color: var(--err); border-color: color-mix(in srgb, var(--err) 40%, var(--line)); background: color-mix(in srgb, var(--err) 8%, var(--bg-1)); }
  .bubble.warn { border-color: rgba(255,180,84,.5); background: color-mix(in srgb, var(--warn) 8%, var(--bg-1)); }

  .bubble.user .utext { white-space: pre-wrap; }
  .attachments {
    display: grid; grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 6px; margin: 0 0 8px;
  }
  .attachment { position: relative; border-radius: 10px; overflow: hidden; border: 1px solid rgba(255,255,255,.15); background: rgba(0,0,0,.2); aspect-ratio: 1/1; }
  .attachment img { width: 100%; height: 100%; object-fit: cover; display: block; }

  .thinking { display: inline-flex; align-items: center; gap: 8px; color: var(--text-2); font-size: 14px; }
  .thinking .orb {
    width: 16px; height: 16px; border-radius: 50%;
    background: conic-gradient(from 0deg, var(--accent), var(--accent-2), var(--ok), var(--accent));
    animation: spin 1.4s linear infinite;
    mask: radial-gradient(circle at center, transparent 4px, black 5px);
    -webkit-mask: radial-gradient(circle at center, transparent 4px, black 5px);
    box-shadow: 0 0 16px rgba(125,108,255,.55);
  }
  @keyframes spin { to { transform: rotate(360deg); } }
  .thinking .word { animation: fadePulse 1.6s ease-in-out infinite; }
  @keyframes fadePulse { 0%,100% { opacity: .55; } 50% { opacity: 1; } }
  .thinking.verify .orb { background: conic-gradient(from 0deg, var(--warn), #ffe28a, var(--warn)); box-shadow: 0 0 16px rgba(255,180,84,.6); }
  .thinking.verify .word { color: var(--warn); }

  .cursor {
    display: inline-block; width: 8px; height: 1.05em;
    background: linear-gradient(180deg, var(--accent-2), var(--accent));
    vertical-align: text-bottom; margin-left: 2px;
    animation: blink 1s steps(2, start) infinite; border-radius: 2px;
    box-shadow: 0 0 12px rgba(125,108,255,.7);
  }
  @keyframes blink { to { visibility: hidden; } }

  .md { min-width: 0; }
  .md > *:first-child { margin-top: 0; }
  .md > *:last-child { margin-bottom: 0; }
  .md p { margin: 0 0 12px; }
  .md h1, .md h2, .md h3, .md h4 { font-weight: 700; letter-spacing: -.01em; margin: 20px 0 8px; line-height: 1.3; }
  .md h1 { font-size: 20px; } .md h2 { font-size: 17px; } .md h3 { font-size: 15.5px; } .md h4 { font-size: 14.5px; color: var(--text-2); }
  .md ul, .md ol { margin: 0 0 12px; padding-left: 22px; }
  .md li { margin: 3px 0; }
  .md a { color: var(--accent-2); text-decoration: none; border-bottom: 1px solid color-mix(in srgb, var(--accent-2) 40%, transparent); }
  .md code.inline { font-family: var(--mono); font-size: .88em; background: var(--bg-2); color: var(--text); padding: 1px 6px; border-radius: 6px; border: 1px solid var(--line); }
  .md hr { border: 0; border-top: 1px solid var(--line); margin: 18px 0; }
  .md blockquote { margin: 0 0 12px; padding: 6px 16px; border-left: 3px solid var(--accent); color: var(--text-2); background: color-mix(in srgb, var(--accent) 6%, transparent); border-radius: 0 8px 8px 0; }

  .cb {
    position: relative; margin: 14px 0; border-radius: 14px;
    background: var(--bg-code); border: 1px solid var(--line);
    overflow: hidden; transition: box-shadow .3s ease, transform .3s ease, border-color .3s ease;
    box-shadow: 0 4px 16px -8px rgba(0,0,0,.6); min-width: 0; max-width: 100%;
  }
  .cb:hover { box-shadow: var(--shadow-accent); border-color: rgba(125,108,255,.4); transform: translateY(-1px); }
  .cb-head { display: flex; align-items: center; gap: 10px; padding: 9px 14px; border-bottom: 1px solid var(--line); background: linear-gradient(180deg, color-mix(in srgb, var(--bg-code) 70%, var(--bg-3)), var(--bg-code)); min-width: 0; flex-wrap: wrap; }
  .cb-dots { display: inline-flex; gap: 6px; margin-right: 6px; flex: none; }
  .cb-dots i { width: 10px; height: 10px; border-radius: 50%; }
  .cb-dots i:nth-child(1) { background: #ff5f57; }
  .cb-dots i:nth-child(2) { background: #febc2e; }
  .cb-dots i:nth-child(3) { background: #28c840; }
  .cb-lang { font-family: var(--mono); font-size: 11px; color: var(--text-3); text-transform: lowercase; padding: 3px 9px; border-radius: 999px; background: color-mix(in srgb, var(--bg-3) 70%, transparent); border: 1px solid var(--line); flex: none; }
  .cb-spacer { flex: 1; min-width: 0; }
  .cb-actions { display: inline-flex; gap: 6px; flex: none; flex-wrap: wrap; }
  .cb-btn {
    appearance: none; border: 1px solid transparent; background: transparent; color: var(--text-2);
    font: inherit; font-size: 12px; padding: 5px 11px; border-radius: 9px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
    transition: background .18s ease, color .18s ease, transform .14s ease, border-color .18s ease, box-shadow .25s ease;
  }
  .cb-btn:hover { background: color-mix(in srgb, var(--accent) 14%, transparent); color: var(--text); border-color: rgba(125,108,255,.4); }
  .cb-btn:active { transform: scale(.95); }
  .cb-btn svg { width: 13px; height: 13px; flex: none; }
  .cb-btn.ok { color: var(--ok); border-color: rgba(61,220,151,.45); background: color-mix(in srgb, var(--ok) 12%, transparent); box-shadow: 0 0 0 4px color-mix(in srgb, var(--ok) 18%, transparent); }

  .cb-body { display: grid; grid-template-columns: auto minmax(0, 1fr); max-height: 520px; overflow: auto; min-width: 0; }
  .cb-gutter { user-select: none; padding: 12px 10px 12px 16px; text-align: right; font-family: var(--mono); font-size: 12.5px; line-height: 1.6; color: var(--text-3); border-right: 1px solid var(--line); background: color-mix(in srgb, var(--bg-code) 65%, var(--bg-3)); position: sticky; left: 0; white-space: pre; }
  .cb-code { margin: 0; padding: 12px 18px; font-family: var(--mono); font-size: 12.5px; line-height: 1.6; color: #e8ebf3; white-space: pre; tab-size: 2; min-width: 0; }

  .tok-k { color: #ff7ab2; } .tok-s { color: #ff8170; } .tok-c { color: #7f8c98; font-style: italic; } .tok-n { color: #d9c97c; } .tok-f { color: #b281eb; } .tok-t { color: #5dd8ff; } .tok-a { color: #ffa14f; }
  @keyframes sparkle { 0% { transform: scale(1); opacity: 1; } 40% { transform: scale(1.3); opacity: .9; } 100% { transform: scale(1); opacity: 1; } }
  .cb-btn.ok svg { animation: sparkle .5s ease; }

  .actions { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; padding: 4px 4px 0; transition: opacity .25s ease; min-width: 0; }
  .act {
    appearance: none; border: 1px solid var(--line); background: var(--bg-2); color: var(--text-2);
    font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 8px; cursor: pointer;
    display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
    transition: color .15s ease, border-color .15s ease, background .15s ease, transform .12s ease;
  }
  .act:hover { color: var(--text); border-color: var(--line-2); background: var(--bg-3); }
  .act:active { transform: scale(.96); }
  .act svg { width: 12px; height: 12px; flex: none; }
  .act.ok { color: var(--ok); border-color: rgba(61,220,151,.45); }

  .meta { display: flex; gap: 8px; align-items: center; padding: 4px 6px 0; font-size: 11.5px; color: var(--text-3); font-variant-numeric: tabular-nums; font-family: var(--mono); flex-wrap: wrap; }
  .turn.user .meta { justify-content: flex-end; }
  .meta .pill { padding: 2px 9px; border-radius: var(--radius-pill); background: var(--bg-2); border: 1px solid var(--line); }
  .meta .pill.ok { color: var(--ok); border-color: rgba(61,220,151,.4); background: color-mix(in srgb, var(--ok) 10%, transparent); }
  .meta .pill.err { color: var(--err); border-color: rgba(255,107,122,.4); background: color-mix(in srgb, var(--err) 10%, transparent); }
  .meta .pill.warn { color: var(--warn); border-color: rgba(255,180,84,.4); background: color-mix(in srgb, var(--warn) 10%, transparent); }

  .composer-wrap { padding-top: 14px; min-width: 0; max-width: var(--feed-max); width: 100%; margin: 0 auto; }
  .composer {
    display: flex; flex-direction: column; gap: 8px;
    background: var(--bg-1); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 10px;
    transition: border-color .2s ease, box-shadow .2s ease;
    box-shadow: var(--shadow-1); min-width: 0;
  }
  .composer:focus-within { border-color: rgba(125,108,255,.55); box-shadow: 0 0 0 4px rgba(125,108,255,.15), var(--shadow-1); }

  .paste-strip { display: flex; gap: 8px; flex-wrap: wrap; padding: 4px; border-radius: 12px; background: var(--bg-2); border: 1px solid var(--line); }
  .paste-strip:empty { display: none; }
  .paste-thumb { position: relative; width: 72px; height: 72px; border-radius: 10px; overflow: hidden; border: 1px solid var(--line-2); background: var(--bg-3); flex: none; }
  .paste-thumb img { width: 100%; height: 100%; object-fit: cover; display: block; }
  .paste-thumb .x { position: absolute; top: 4px; right: 4px; width: 20px; height: 20px; border-radius: 50%; background: rgba(0,0,0,.65); color: #fff; border: 0; cursor: pointer; display: grid; place-items: center; font-size: 12px; line-height: 1; }
  .paste-thumb .x:hover { background: rgba(0,0,0,.85); }

  .composer-row { display: flex; align-items: flex-end; gap: 8px; min-width: 0; }
  textarea#q { flex: 1; resize: none; appearance: none; min-width: 0; min-height: 24px; max-height: 220px; background: transparent; border: 0; outline: 0; color: var(--text); font: inherit; line-height: 1.55; padding: 8px 2px; caret-color: var(--accent-2); }
  textarea#q::placeholder { color: var(--text-3); }

  .send { flex: none; width: 38px; height: 38px; border: 0; border-radius: 12px; cursor: pointer; background: var(--accent-fill); color: #fff; display: grid; place-items: center; transition: filter .15s ease, transform .1s ease, opacity .15s ease; box-shadow: var(--accent-glow), inset 0 1px 0 rgba(255,255,255,.35); position: relative; overflow: hidden; }
  .send::after { content: ''; position: absolute; inset: 0; background: linear-gradient(120deg, transparent 30%, rgba(255,255,255,.5) 50%, transparent 70%); transform: translateX(-130%); transition: transform .7s ease; }
  .send:hover::after { transform: translateX(130%); }
  .send:hover { filter: brightness(1.08); }
  .send:active { transform: scale(.94); }
  .send:disabled { opacity: .35; cursor: not-allowed; box-shadow: none; }
  .send svg { width: 16px; height: 16px; position: relative; z-index: 1; }

  .hint { color: var(--text-3); font-size: 11.5px; margin: 8px 4px 0; text-align: center; }
  .hint kbd { font-family: var(--mono); font-size: 10.5px; padding: 1px 6px; border: 1px solid var(--line); border-radius: 5px; color: var(--text-2); background: var(--bg-2); }

  .toast { position: fixed; bottom: 26px; left: 50%; transform: translateX(-50%) translateY(20px); background: var(--bg-2); color: var(--text); border: 1px solid var(--line-2); border-radius: 12px; padding: 11px 18px; font-size: 13px; box-shadow: var(--shadow-2); opacity: 0; pointer-events: none; transition: opacity .24s ease, transform .24s ease; z-index: 100; max-width: calc(100vw - 32px); }
  .toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

  /* ---------- responsive ---------- */
  @media (max-width: 900px) {
    :root { --feed-max: 100%; }
  }
  @media (max-width: 720px) {
    header { gap: 10px; }
    .brand-sub { display: none; }
    .status { padding: 5px 10px; font-size: 12px; }
    .status .meta { display: none; }
    .turn.user .row { max-width: 92%; }
    .turn.bot  .row { max-width: 100%; }
    .bubble { padding: 12px 14px; font-size: 14.5px; }
    .composer { padding: 8px; }
    .cb-head { padding: 8px 10px; }
    .cb-code, .cb-gutter { font-size: 12px; }
    main { padding: 16px var(--pad-x) 14px; }
  }
  @media (max-width: 480px) {
    .btn-quiet span { display: none; }
    .hint { font-size: 11px; }
    .hint kbd { font-size: 10px; }
  }

  @media (prefers-reduced-motion: reduce) {
    *, *::before, *::after { animation: none !important; transition: none !important; }
    #feed { scroll-behavior: auto; }
  }
</style>
</head>
<body>
<div class="app">
  <header>
    <div class="brand">
      <div class="brand-mark">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12h6M14 12h6M12 4v6M12 14v6"/></svg>
      </div>
      <span class="brand-name">MyBeam</span><span class="brand-sub">Workstation</span>
    </div>
    <div class="spacer"></div>
    <div id="status" class="status"><span class="dot"></span><span id="statusText">Connecting</span><span id="statusMeta" class="meta"></span></div>
    <button id="clear" class="btn-quiet" type="button">Clear</button>
  </header>

  <main>
    <div id="feed">
      <div class="empty" id="empty">
        <div>
          <h1>Ready when you are.</h1>
          <p>Type or paste images to send them with your message.</p>
        </div>
      </div>
    </div>

    <div class="composer-wrap">
      <form id="f" class="composer" autocomplete="off">
        <div id="paste-strip" class="paste-strip"></div>
        <div class="composer-row">
          <textarea id="q" rows="1" placeholder="Message or paste an image…"></textarea>
          <button id="send" class="send" type="submit" title="Send" aria-label="Send">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline></svg>
          </button>
        </div>
      </form>
      <div class="hint"><kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line · Paste images with <kbd>Ctrl</kbd>+<kbd>V</kbd></div>
    </div>
  </main>
</div>

<div id="toast" class="toast"></div>

<script>
(function () {
  'use strict';

  var feed = document.getElementById('feed');
  var empty = document.getElementById('empty');
  var f = document.getElementById('f');
  var q = document.getElementById('q');
  var sendBtn = document.getElementById('send');
  var status = document.getElementById('status');
  var statusText = document.getElementById('statusText');
  var statusMeta = document.getElementById('statusMeta');
  var clearBtn = document.getElementById('clear');
  var toastEl = document.getElementById('toast');
  var pasteStrip = document.getElementById('paste-strip');

  var turns = new Map();
  var pendingImages = [];
  var lastPasteFingerprint = '';
  var lastPasteAt = 0;
  var FENCE = String.fromCharCode(96,96,96);

  var toastTimer = null;
  function toast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, 2200); }

  function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function ensureEmptyGone() { if (empty && empty.parentElement) empty.remove(); }
  function fmtMs(ms) { if (ms == null) return ''; if (ms < 1000) return ms + ' ms'; return (ms/1000).toFixed(2) + ' s'; }

  var autoScroll = true, scrollQueued = false;
  feed.addEventListener('scroll', function () { autoScroll = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80; }, { passive: true });
  function scrollDown() { if (!autoScroll || scrollQueued) return; scrollQueued = true; requestAnimationFrame(function () { scrollQueued = false; feed.scrollTop = feed.scrollHeight; }); }

  // ---------- paste / images (single listener, deduped) ----------
  function pickImagesFromDataTransfer(dt) {
    var files = [];
    if (dt.files && dt.files.length) files = Array.from(dt.files);
    else if (dt.items) { for (var i = 0; i < dt.items.length; i++) { var it = dt.items[i]; if (it.kind === 'file') { var ff = it.getAsFile(); if (ff) files.push(ff); } } }
    return files;
  }
  function fileToDataUrl(file) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader(); r.onload = function () { resolve(r.result); }; r.onerror = function () { reject(r.error); }; r.readAsDataURL(file);
    });
  }
  async function addFiles(files) {
    var added = 0;
    for (var i = 0; i < files.length; i++) {
      var file = files[i];
      if (!/^image\//.test(file.type)) continue;
      if (file.size > 8 * 1024 * 1024) { toast('Image too large (max 8 MB)'); continue; }
      try {
        var du = await fileToDataUrl(file);
        // dedupe exact same dataUrl within this batch
        var dup = pendingImages.some(function (p) { return p.dataUrl === du; });
        if (dup) continue;
        pendingImages.push({ name: file.name || ('paste-' + Date.now() + '.' + (file.type.split('/')[1] || 'png')), type: file.type, dataUrl: du });
        added++;
      } catch (e) { toast('Could not read image'); }
    }
    renderPasteStrip();
    return added;
  }
  function renderPasteStrip() {
    pasteStrip.innerHTML = '';
    pendingImages.forEach(function (img, idx) {
      var th = el('div', 'paste-thumb');
      var im = document.createElement('img'); im.src = img.dataUrl; im.alt = img.name || 'pasted'; th.appendChild(im);
      var x = document.createElement('button'); x.type = 'button'; x.className = 'x'; x.textContent = '×'; x.title = 'Remove';
      x.addEventListener('click', function () { pendingImages.splice(idx, 1); renderPasteStrip(); });
      th.appendChild(x);
      pasteStrip.appendChild(th);
    });
  }

  // ONE paste listener on document (capture). If the user pasted into the textarea,
  // the event still fires here first; we don't add a second listener on the textarea.
  function onPaste(e) {
    var dt = e.clipboardData;
    if (!dt) return;
    var files = pickImagesFromDataTransfer(dt);
    if (!files.length) return; // let normal text paste go through
    e.preventDefault();

    // Fingerprint to swallow the duplicate event (some browsers fire paste twice).
    var fp = files.map(function (file) { return file.name + ':' + file.size + ':' + file.type; }).join('|');
    var now = Date.now();
    if (fp && fp === lastPasteFingerprint && now - lastPasteAt < 400) return;
    lastPasteFingerprint = fp; lastPasteAt = now;

    addFiles(files);
  }
  document.addEventListener('paste', onPaste, true);

  ['dragover','drop'].forEach(function (evt) {
    f.addEventListener(evt, function (e) {
      if (evt === 'dragover') { e.preventDefault(); return; }
      e.preventDefault();
      var files = e.dataTransfer ? pickImagesFromDataTransfer(e.dataTransfer) : [];
      if (files.length) addFiles(files);
    });
  });

  // ---------- highlighter ----------
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
    if (L === 'html' || L === 'xml' || L === 'svg' || L === 'vue') {
      s = s.replace(/(&lt;\/?)([a-zA-Z][\w:-]*)([^&]*?)(&gt;)/g, function (_, open, name, rest, close) {
        var inner = rest.replace(/([a-zA-Z_:][-a-zA-Z0-9_:.]*)(=)(&#39;[^&]*?&#39;|"[^"]*?")/g, function (__, attr, eq, val) { return wrap('a', attr) + eq + wrap('s', val); });
        return open + wrap('t', name) + inner + close;
      });
    }
    s = s.replace(/\b([A-Za-z_$][\w$]*)(?=\s*\()/g, function (m) { return wrap('f', m); });
    var guard = 0;
    while (s.indexOf(PL) !== -1 && guard++ < 20) s = s.replace(new RegExp(PL + '(\\d+)' + PL, 'g'), function (_, i) { return store[+i]; });
    return s;
  }

  function download(filename, text, type) {
    var blob = new Blob([text], { type: type || 'text/plain' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function buildCodeBlock(code, lang) {
    var wrap = el('div', 'cb');
    var head = el('div', 'cb-head');
    var dots = el('div', 'cb-dots'); dots.innerHTML = '<i></i><i></i><i></i>'; head.appendChild(dots);
    head.appendChild(el('span', 'cb-lang', lang || 'code'));
    head.appendChild(el('div', 'cb-spacer'));
    var ext = ({ html: 'html', css: 'css', js: 'js', javascript: 'js', ts: 'ts', typescript: 'ts', py: 'py', python: 'py', json: 'json', md: 'md', markdown: 'md' })[(lang || '').toLowerCase()] || 'txt';
    var actions = el('div', 'cb-actions');
    var copyBtn = document.createElement('button'); copyBtn.className = 'cb-btn'; copyBtn.type = 'button';
    copyBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg><span>Copy</span>';
    copyBtn.addEventListener('click', function () {
      var done = function () { copyBtn.classList.add('ok'); copyBtn.querySelector('span').textContent = 'Copied'; toast('Copied'); setTimeout(function () { copyBtn.classList.remove('ok'); copyBtn.querySelector('span').textContent = 'Copy'; }, 1500); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(code).then(done).catch(function (e) { toast('Copy failed: ' + e.message); });
      else { var ta = document.createElement('textarea'); ta.value = code; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed'); } ta.remove(); }
    });
    actions.appendChild(copyBtn);
    var dlBtn = document.createElement('button'); dlBtn.className = 'cb-btn'; dlBtn.type = 'button';
    dlBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg><span>Download</span>';
    dlBtn.addEventListener('click', function () { download('code.' + ext, code, 'text/plain'); toast('Downloaded'); });
    actions.appendChild(dlBtn);
    if ((lang || '').toLowerCase() === 'html') {
      var runBtn = document.createElement('button'); runBtn.className = 'cb-btn'; runBtn.type = 'button';
      runBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="5 3 19 12 5 21 5 3"></polygon></svg><span>Run</span>';
      runBtn.addEventListener('click', function () { window.open(URL.createObjectURL(new Blob([code], { type: 'text/html' })), '_blank', 'noopener'); });
      actions.appendChild(runBtn);
    }
    head.appendChild(actions); wrap.appendChild(head);
    var body = el('div', 'cb-body');
    var lineCount = code.split('\n').length;
    var gutter = el('div', 'cb-gutter'); var nums = ''; for (var n = 1; n <= lineCount; n++) nums += n + '\n'; gutter.textContent = nums;
    var pre = document.createElement('pre'); pre.className = 'cb-code'; pre.innerHTML = highlight(code, lang);
    body.appendChild(gutter); body.appendChild(pre); wrap.appendChild(body);
    return wrap;
  }

  function inlineInto(node, src) {
    var s = escapeHtml(src); var slots = [];
    s = s.replace(/\u0060([^\u0060]+?)\u0060/g, function (_, c) { slots.push(c); return '\u0000C' + (slots.length - 1) + '\u0000'; });
    s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/\*\*([^*]+?)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/(^|[^*])\*([^*]+?)\*(?!\*)/g, '$1<em>$2</em>');
    s = s.replace(/\u0000C(\d+)\u0000/g, function (_, idx) { return '<code class="inline">' + slots[+idx] + '</code>'; });
    node.innerHTML = s;
  }

  function matchFenceOpen(line) { return line.match(new RegExp('^\\s*' + FENCE + '\\s*([\\w+.-]*)\\s*$')); }
  function isFenceClose(line) { return new RegExp('^\\s*' + FENCE + '\\s*$').test(line); }

  function renderMarkdown(container, text) {
    container.innerHTML = ''; if (!text) return;
    var lines = text.split(/\r?\n/); var i = 0;
    while (i < lines.length) {
      var line = lines[i]; var fence = matchFenceOpen(line);
      if (fence) { var lang = (fence[1] || '').toLowerCase(); var buf = []; i++; while (i < lines.length && /^\s*$/.test(lines[i])) i++; while (i < lines.length && !isFenceClose(lines[i])) { buf.push(lines[i]); i++; } if (i < lines.length) i++; container.appendChild(buildCodeBlock(buf.join('\n'), lang)); continue; }
      if (/^\s*---\s*$/.test(line)) { container.appendChild(el('hr')); i++; continue; }
      var h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) { var level = Math.min(h[1].length, 4); var node = el('h' + level); inlineInto(node, h[2]); container.appendChild(node); i++; continue; }
      if (/^\s*>\s?/.test(line)) { var bqbuf = []; while (i < lines.length && /^\s*>\s?/.test(lines[i])) { bqbuf.push(lines[i].replace(/^\s*>\s?/, '')); i++; } var bq = el('blockquote'); inlineInto(bq, bqbuf.join(' ')); container.appendChild(bq); continue; }
      if (/^\s*[-*+]\s+/.test(line)) { var ul = el('ul'); while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) { var li = el('li'); inlineInto(li, lines[i].replace(/^\s*[-*+]\s+/, '')); ul.appendChild(li); i++; } container.appendChild(ul); continue; }
      if (/^\s*\d+\.\s+/.test(line)) { var ol = el('ol'); while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) { var li2 = el('li'); inlineInto(li2, lines[i].replace(/^\s*\d+\.\s+/, '')); ol.appendChild(li2); i++; } container.appendChild(ol); continue; }
      if (/^\s*$/.test(line)) { i++; continue; }
      var buf2 = [line]; i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !matchFenceOpen(lines[i]) && !/^(#{1,6})\s+/.test(lines[i]) && !/^\s*[-*+]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i]) && !/^\s*>\s?/.test(lines[i]) && !/^\s*---\s*$/.test(lines[i])) { buf2.push(lines[i]); i++; }
      var p = el('p'); inlineInto(p, buf2.join('\n')); container.appendChild(p);
    }
  }

  function buildActions(getText, getHtmlBlock, retryFn) {
    var bar = el('div', 'actions');
    var copyAct = document.createElement('button'); copyAct.className = 'act'; copyAct.type = 'button';
    copyAct.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"></path></svg><span>Copy</span>';
    copyAct.addEventListener('click', function () { var text = getText() || ''; var done = function () { copyAct.classList.add('ok'); toast('Copied'); setTimeout(function () { copyAct.classList.remove('ok'); }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done).catch(function (e) { toast('Copy failed: ' + e.message); });
      else { var ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done(); } catch (e) { toast('Copy failed'); } ta.remove(); } });
    bar.appendChild(copyAct);
    var mdAct = document.createElement('button'); mdAct.className = 'act'; mdAct.type = 'button';
    mdAct.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"></path><polyline points="7 10 12 15 17 10"></polyline><line x1="12" y1="15" x2="12" y2="3"></line></svg><span>Download .md</span>';
    mdAct.addEventListener('click', function () { download('response.md', getText() || '', 'text/markdown'); toast('Downloaded'); });
    bar.appendChild(mdAct);
    var htmlAct = document.createElement('button'); htmlAct.className = 'act'; htmlAct.type = 'button';
    htmlAct.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg><span>Download HTML</span>';
    htmlAct.addEventListener('click', function () { var hb = getHtmlBlock && getHtmlBlock(); if (!hb) return toast('No HTML block found'); download('snippet.html', hb, 'text/html'); toast('Downloaded'); });
    bar.appendChild(htmlAct);
    if (retryFn) { var retryAct = document.createElement('button'); retryAct.className = 'act'; retryAct.type = 'button';
      retryAct.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"></polyline><path d="M20.49 15a9 9 0 11-2.12-9.36L23 10"></path></svg><span>Retry</span>';
      retryAct.addEventListener('click', retryFn); bar.appendChild(retryAct); }
    return bar;
  }

  function extractFirstHtmlBlock(md) {
    var lines = (md || '').split(/\r?\n/); var open = new RegExp('^\\s*' + FENCE + '\\s*html\\s*$', 'i'); var out = []; var on = false;
    for (var i = 0; i < lines.length; i++) { if (!on && open.test(lines[i])) { on = true; continue; } if (on) { if (isFenceClose(lines[i])) return out.join('\n'); out.push(lines[i]); } }
    return null;
  }

  function renderUserBubble(bubble, text, images) {
    bubble.innerHTML = '';
    if (images && images.length) {
      var grid = el('div', 'attachments');
      images.forEach(function (img) {
        var a = el('div', 'attachment');
        var im = document.createElement('img'); im.src = img.dataUrl; im.alt = img.name || 'image'; a.appendChild(im);
        grid.appendChild(a);
      });
      bubble.appendChild(grid);
    }
    if (text) { var t = el('div', 'utext', text); bubble.appendChild(t); }
  }

  function makeTurn(id, text, images) {
    ensureEmptyGone();
    var userTurn = el('div', 'turn user'); userTurn.dataset.id = String(id);
    var userRow = el('div', 'row');
    userRow.appendChild(el('div', 'role', 'You'));
    var userBubble = el('div', 'bubble user');
    renderUserBubble(userBubble, text, images || []);
    userRow.appendChild(userBubble);
    userTurn.appendChild(userRow); feed.appendChild(userTurn);

    var botTurn = el('div', 'turn bot'); botTurn.dataset.id = String(id);
    var botRow = el('div', 'row');
    botRow.appendChild(el('div', 'role', 'Assistant'));
    var botBubble = el('div', 'bubble bot');
    var thinking = el('div', 'thinking');
    thinking.innerHTML = '<span class="orb"></span><span class="word">Thinking…</span>';
    botBubble.appendChild(thinking);
    botRow.appendChild(botBubble);
    var meta = el('div', 'meta'); var pill = el('span', 'pill', 'queued'); meta.appendChild(pill); botRow.appendChild(meta);
    var actionsWrap = el('div', 'actions'); actionsWrap.style.opacity = '0';
    var t = { botBubble: botBubble, metaEl: meta, pill: pill, startedAt: Date.now(), thinking: thinking, textNode: null, cursor: null, revealer: null, currentText: '', actionsWrap: actionsWrap, actions: null, promptText: text, promptImages: images || [], mdMode: false, lastMdRender: 0, verifying: false, attachWarnShown: false };
    var bar = buildActions(function () { return t.currentText; }, function () { return extractFirstHtmlBlock(t.currentText); }, function () { submit(t.promptText, t.promptImages); });
    t.actions = bar; actionsWrap.appendChild(bar); botRow.appendChild(actionsWrap);
    botTurn.appendChild(botRow); feed.appendChild(botTurn);
    scrollDown(); turns.set(id, t); return t;
  }

  function setPill(t, status, extra) {
    if (!t) return;
    t.pill.className = 'pill' + (status === 'ok' ? ' ok' : status === 'error' ? ' err' : status === 'verify' || status === 'retry' ? ' warn' : '');
    t.pill.textContent = status;
    if (extra) { var dur = t.metaEl.querySelector('.pill.dur'); if (!dur) { dur = el('span', 'pill dur'); t.metaEl.appendChild(dur); } dur.textContent = extra; }
  }

  function showThinking(t, mode) {
    if (!t) return;
    if (t.thinking && t.thinking.parentElement) {
      t.thinking.classList.toggle('verify', mode === 'verify');
      var w = t.thinking.querySelector('.word');
      if (w) w.textContent = mode === 'verify' ? 'Waiting for verification…' : 'Thinking…';
      return;
    }
    t.botBubble.textContent = '';
    var th = el('div', 'thinking' + (mode === 'verify' ? ' verify' : ''));
    th.innerHTML = '<span class="orb"></span><span class="word">' + (mode === 'verify' ? 'Waiting for verification…' : 'Thinking…') + '</span>';
    t.botBubble.appendChild(th); t.thinking = th;
  }

  function renderStreamRich(t, text) {
    var now = Date.now(); if (now - t.lastMdRender < 120) return;
    t.lastMdRender = now; t.botBubble.classList.add('md'); renderMarkdown(t.botBubble, text);
    var cur = el('span', 'cursor'); t.botBubble.appendChild(cur); t.cursor = cur;
  }

  function beginStream(id) {
    var t = turns.get(id); if (!t) return null;
    if (t.thinking && t.thinking.parentElement) { t.thinking.remove(); t.thinking = null; }
    if (t.actionsWrap) t.actionsWrap.style.opacity = '1';
    if (t.verifying) { t.verifying = false; setPill(t, 'streaming', null); }
    return t;
  }

  function renderStream(id, text) {
    var t = beginStream(id); if (!t) return;
    t.currentText = text || '';
    var hasFence = t.currentText.indexOf(FENCE) !== -1;
    if (hasFence) { t.mdMode = true; renderStreamRich(t, t.currentText); }
    else {
      if (!t.textNode) { t.botBubble.textContent = ''; t.textNode = document.createTextNode(''); t.botBubble.appendChild(t.textNode); t.cursor = el('span', 'cursor'); t.botBubble.appendChild(t.cursor); t.revealer = { push: function (txt) { t.textNode.nodeValue = txt; }, instant: function (txt) { t.textNode.nodeValue = txt; }, finalize: function () {} }; }
      t.revealer.push(t.currentText);
    }
    scrollDown();
  }

  function renderVerify(id, on) {
    var t = turns.get(id); if (!t) return;
    t.verifying = !!on;
    if (on) { setPill(t, 'verification', null); showThinking(t, 'verify'); }
    else { setPill(t, 'streaming', null); if (!t.currentText) showThinking(t, 'thinking'); }
    scrollDown();
  }

  function renderFinal(id, text, durationMs, attachFailed) {
    var t = turns.get(id); if (!t) return;
    if (t.thinking && t.thinking.parentElement) { t.thinking.remove(); t.thinking = null; }
    t.verifying = false; t.currentText = text || '';
    t.botBubble.classList.add('md'); renderMarkdown(t.botBubble, text || '');
    t.textNode = null; t.cursor = null; t.revealer = null;
    setPill(t, 'ok', durationMs != null ? fmtMs(durationMs) : null);
    if (attachFailed && !t.attachWarnShown) {
      t.attachWarnShown = true;
      t.botBubble.classList.add('warn');
      var warn = el('div', null, 'Note: your image could not be attached on the site. The text was sent without it.');
      warn.style.marginTop = '10px'; warn.style.fontSize = '13px'; warn.style.color = 'var(--warn)';
      t.botBubble.appendChild(warn);
    }
    if (t.actionsWrap) t.actionsWrap.style.opacity = '1';
    scrollDown();
  }

  function renderError(id, msg) {
    var t = turns.get(id); if (!t) return;
    if (t.thinking && t.thinking.parentElement) { t.thinking.remove(); t.thinking = null; }
    t.botBubble.className = 'bubble bot err'; t.botBubble.textContent = msg || 'error';
    t.textNode = null; t.cursor = null; t.revealer = null; t.verifying = false;
    setPill(t, 'error', null); scrollDown();
  }

  var es = new EventSource('/events');
  es.addEventListener('task', function (ev) {
    var t = JSON.parse(ev.data);
    if (t.status === 'queued') makeTurn(t.id, t.text, t.images);
    else if (t.status === 'ok') renderFinal(t.id, t.reply || '', t.durationMs, t.attachFailed);
    else if (t.status === 'error') renderError(t.id, t.error);
    else if (t.status === 'timeout') renderError(t.id, 'Timed out waiting for the extension.');
  });
  es.addEventListener('stream', function (ev) { var d = JSON.parse(ev.data); renderStream(d.id, d.text || ''); });
  es.addEventListener('verify', function (ev) { var d = JSON.parse(ev.data); renderVerify(d.id, d.on); });
  es.addEventListener('status', function (ev) {
    var s = JSON.parse(ev.data);
    status.classList.toggle('on', !!s.connected);
    status.classList.toggle('verify', !!(s.meta && s.meta.verifying));
    statusText.textContent = s.connected ? (s.meta && s.meta.verifying ? 'Waiting for verification' : 'Connected') : 'Disconnected';
    if (s.meta && s.connected) { var bits = []; if (s.meta.busy) bits.push('busy'); if (s.meta.task != null) bits.push('task ' + s.meta.task); statusMeta.textContent = bits.length ? '· ' + bits.join(' · ') : ''; }
    else statusMeta.textContent = '';
  });
  es.onerror = function () { status.classList.remove('on'); statusText.textContent = 'Reconnecting'; statusMeta.textContent = ''; };

  function autosize() { q.style.height = 'auto'; q.style.height = Math.min(q.scrollHeight, 220) + 'px'; }
  q.addEventListener('input', autosize);

  function submit(forcedText, forcedImages) {
    var text = (forcedText != null ? forcedText : q.value).trim();
    var images = forcedImages != null ? forcedImages : pendingImages.slice();
    if (!text && (!images || !images.length)) return;
    if (forcedText == null) { q.value = ''; autosize(); pendingImages = []; renderPasteStrip(); }
    sendBtn.disabled = true;
    fetch('/task', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: text, images: images }) })
      .catch(function (e) { var id = 'local-' + Date.now(); makeTurn(id, text, images); renderError(id, 'Could not reach the local server: ' + e.message); })
      .then(function () { setTimeout(function () { sendBtn.disabled = false; q.focus(); }, 100); });
  }

  f.addEventListener('submit', function (e) { e.preventDefault(); submit(); });
  q.addEventListener('keydown', function (e) { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); } });
  q.focus();

  clearBtn.addEventListener('click', function () {
    turns.clear(); feed.innerHTML = ''; pendingImages = []; renderPasteStrip();
    var d = el('div', 'empty'); d.id = 'empty';
    var inner = el('div');
    inner.appendChild(el('h1', null, 'Ready when you are.'));
    inner.appendChild(el('p', null, 'Type or paste images to send them with your message.'));
    d.appendChild(inner); feed.appendChild(d);
  });
})();
</script>
</body>
</html>`;

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost:' + PORT);
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type', 'access-control-allow-methods': 'GET,POST,OPTIONS' });
    return res.end();
  }

  if (req.method === 'GET' && path === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(UI_HTML); }

  if (req.method === 'GET' && path === '/events') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive', 'access-control-allow-origin': '*', 'x-accel-buffering': 'no' });
    res.write('retry: 2000\n\n');
    listeners.add(res);
    const connected = Date.now() - lastHeartbeat < HEARTBEAT_FRESH_MS;
    res.write('event: status\ndata: ' + JSON.stringify({ connected, meta: lastHeartbeatMeta }) + '\n\n');
    for (const h of history) {
      res.write('event: task\ndata: ' + JSON.stringify({ id: h.id, status: h.status, text: h.text, images: h.images || [], reply: h.reply, error: h.error, durationMs: h.finishedAt && h.startedAt ? (h.finishedAt - h.startedAt) : null }) + '\n\n');
      if (h.reply) res.write('event: stream\ndata: ' + JSON.stringify({ id: h.id, text: h.reply }) + '\n\n');
    }
    req.on('close', () => listeners.delete(res));
    return;
  }

  if (req.method === 'GET' && path === '/work') {
    const task = queue.shift();
    if (!task) { res.writeHead(204); return res.end(); }
    return json(res, 200, task);
  }

  if (req.method === 'POST' && path === '/stream') {
    const body = await readBody(req); let parsed; try { parsed = JSON.parse(body); } catch (e) { return json(res, 400, { error: 'bad-json' }); }
    const ok = deliverStream(parsed.id, String(parsed.text || '')); return json(res, ok ? 200 : 404, { ok });
  }

  if (req.method === 'POST' && path === '/verify') {
    const body = await readBody(req); let parsed; try { parsed = JSON.parse(body); } catch (e) { return json(res, 400, { error: 'bad-json' }); }
    const ok = deliverVerify(parsed.id, !!parsed.on); return json(res, ok ? 200 : 404, { ok });
  }

  if (req.method === 'POST' && path === '/result') {
    const body = await readBody(req); let parsed; try { parsed = JSON.parse(body); } catch (e) { return json(res, 400, { error: 'bad-json' }); }
    const ok = deliverResult(parsed.id, parsed); return json(res, ok ? 200 : 404, { ok });
  }

  if (req.method === 'POST' && path === '/heartbeat') {
    const body = await readBody(req);
    try { lastHeartbeatMeta = JSON.parse(body || '{}'); } catch (e) { lastHeartbeatMeta = {}; }
    lastHeartbeat = Date.now();
    broadcast('status', { connected: true, meta: lastHeartbeatMeta });
    return json(res, 200, { ok: true });
  }

  if (req.method === 'POST' && path === '/task') {
    const body = await readBody(req); let parsed; try { parsed = JSON.parse(body); } catch (e) { return json(res, 400, { error: 'bad-json' }); }
    const text = (parsed && parsed.text || '').trim();
    const images = (parsed && parsed.images) || [];
    if (!text && (!images || !images.length)) return json(res, 400, { error: 'empty' });
    enqueueTask(text, images).then((reply) => json(res, 200, { ok: true, reply })).catch((err) => json(res, 500, { ok: false, error: err.message }));
    return;
  }

  if (req.method === 'GET' && path === '/status') {
    return json(res, 200, {
      connected: Date.now() - lastHeartbeat < HEARTBEAT_FRESH_MS,
      lastHeartbeat, lastHeartbeatMeta,
      queueLength: queue.length, pendingCount: pending.size,
      history: history.map(h => ({ id: h.id, status: h.status, startedAt: h.startedAt, finishedAt: h.finishedAt, verifying: h.verifying, images: (h.images || []).length }))
    });
  }

  res.writeHead(404, { 'content-type': 'text/plain' });
  res.end('not found');
});

server.listen(PORT, () => {
  console.log('MyBeam Workstation running at http://localhost:' + PORT);
});
