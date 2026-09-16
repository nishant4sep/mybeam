// lib/memory.js — per-workspace memory tree.
//
// Layout inside <workspace>/.mybeam/:
//   memory/
//     PROJECT_MAP.md    high-level project description
//     FILES.md          one-line summary per file
//     CHANGES.md        log of writes/edits
//     DECISIONS.md      technical decisions
//     CONTEXT.md        current focus for the session
//   transcripts/
//     <session-id>.jsonl   every message, one JSON object per line
//   history/
//     <timestamp>/<relpath>  backups before writes
//
// This module is read/write only for metadata + transcripts. It does NOT write
// project source files — that arrives in Block B.

const fs = require('fs');
const path = require('path');
const workspace = require('./workspace');

const DIR = '.mybeam';
const FILES = ['PROJECT_MAP.md', 'FILES.md', 'CHANGES.md', 'DECISIONS.md', 'CONTEXT.md'];

function root() {
  const r = workspace.getRoot();
  if (!r) throw new Error('no-workspace');
  return path.join(r, DIR);
}

function ensureDirs() {
  const r = root();
  fs.mkdirSync(path.join(r, 'memory'), { recursive: true });
  fs.mkdirSync(path.join(r, 'transcripts'), { recursive: true });
  fs.mkdirSync(path.join(r, 'history'), { recursive: true });
}

function readMemoryFile(name) {
  try {
    const abs = path.join(root(), 'memory', name);
    return fs.readFileSync(abs, 'utf8');
  } catch (_) { return null; }
}

function writeMemoryFile(name, content) {
  ensureDirs();
  const abs = path.join(root(), 'memory', name);
  fs.writeFileSync(abs, String(content == null ? '' : content), 'utf8');
}

function memorySnapshot() {
  if (!workspace.getRoot()) return null;
  try { ensureDirs(); } catch (_) { return null; }
  const out = {};
  for (const f of FILES) out[f] = readMemoryFile(f);
  return out;
}

function appendTranscript(sessionId, entry) {
  if (!sessionId) return;
  try {
    ensureDirs();
    const abs = path.join(root(), 'transcripts', String(sessionId) + '.jsonl');
    const line = JSON.stringify(Object.assign({ ts: Date.now() }, entry)) + '\n';
    fs.appendFileSync(abs, line, 'utf8');
  } catch (_) {}
}

function readTranscript(sessionId) {
  try {
    const abs = path.join(root(), 'transcripts', String(sessionId) + '.jsonl');
    const raw = fs.readFileSync(abs, 'utf8');
    return raw.split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

module.exports = {
  root, ensureDirs,
  readMemoryFile, writeMemoryFile, memorySnapshot,
  appendTranscript, readTranscript,
  FILES
};
