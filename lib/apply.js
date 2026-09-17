// lib/apply.js — apply parsed edits to disk, safely.
// Refuses empty writes; backs up; atomic rename; logs to CHANGES.md.

const fs = require('fs');
const path = require('path');
const workspace = require('./workspace');
const memory = require('./memory');

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds());
}

function backup(absPath, relPath) {
  try {
    if (!fs.existsSync(absPath)) return null;
    const ts = nowStamp();
    const root = workspace.getRoot();
    if (!root) return null;
    const dir = path.join(root, '.mybeam', 'history', ts);
    fs.mkdirSync(dir, { recursive: true });
    const dest = path.join(dir, relPath.replace(/[\\/]+/g, '__'));
    fs.copyFileSync(absPath, dest);
    return path.relative(root, dest);
  } catch (_) { return null; }
}

function atomicWrite(absPath, content) {
  const dir = path.dirname(absPath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = absPath + '.mybeam.tmp.' + process.pid + '.' + Date.now();
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, absPath);
}

function logChange(edit, action, extra) {
  try {
    const line = '- ' + new Date().toISOString() + '  ' + action + '  `' + edit.path + '`' + (extra ? '  ' + extra : '') + '\n';
    const cur = memory.readMemoryFile('CHANGES.md') || '';
    memory.writeMemoryFile('CHANGES.md', (cur ? cur : '# Changes\n\n') + line);
  } catch (_) {}
}

function applyOne(edit) {
  if (!edit || !edit.path) return { ok: false, reason: 'missing-path' };
  const root = workspace.getRoot();
  if (!root) return { ok: false, reason: 'no-workspace' };

  let abs;
  try { abs = workspace.resolveInside(edit.path); }
  catch (e) { return { ok: false, reason: String(e.message || e) }; }

  const exists = fs.existsSync(abs);

  if (edit.kind === 'new') {
    if (edit._emptyAfterClean) return { ok: false, reason: 'empty-content-after-clean' };
    if (edit.content == null || String(edit.content).trim() === '') {
      return { ok: false, reason: 'empty-content' };
    }
    if (exists) {
      const backupPath = backup(abs, edit.path);
      atomicWrite(abs, edit.content);
      logChange(edit, 'overwrote', backupPath ? '(backup: ' + backupPath + ')' : '');
      return { ok: true, kind: 'overwrite', path: edit.path, backup: backupPath };
    }
    atomicWrite(abs, edit.content);
    logChange(edit, 'created');
    return { ok: true, kind: 'create', path: edit.path };
  }

  if (edit.kind === 'edit') {
    if (!exists) return { ok: false, reason: 'file-not-found' };
    const cur = fs.readFileSync(abs, 'utf8');
    const find = edit.find == null ? '' : edit.find;
    const repl = edit.replace == null ? '' : edit.replace;
    if (!find) return { ok: false, reason: 'empty-find' };

    let count = 0, from = 0;
    while (true) {
      const at = cur.indexOf(find, from);
      if (at === -1) break;
      count++;
      from = at + find.length;
    }
    if (count === 0) return { ok: false, reason: 'find-not-found' };
    if (count > 1) return { ok: false, reason: 'find-ambiguous: ' + count + ' matches' };

    const next = cur.replace(find, repl);
    const backupPath = backup(abs, edit.path);
    atomicWrite(abs, next);
    logChange(edit, 'edited', backupPath ? '(backup: ' + backupPath + ')' : '');
    return { ok: true, kind: 'edit', path: edit.path, backup: backupPath };
  }

  if (edit.kind === 'delete') {
    if (!exists) return { ok: false, reason: 'file-not-found' };
    const backupPath = backup(abs, edit.path);
    fs.unlinkSync(abs);
    logChange(edit, 'deleted', backupPath ? '(backup: ' + backupPath + ')' : '');
    return { ok: true, kind: 'delete', path: edit.path, backup: backupPath };
  }

  return { ok: false, reason: 'unknown-kind' };
}

function applyAll(edits) {
  const results = [];
  for (const e of (edits || [])) {
    results.push(Object.assign({ edit: e }, applyOne(e)));
  }
  return results;
}

module.exports = { applyOne, applyAll };
