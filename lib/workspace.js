// lib/workspace.js — sandboxed file read + list for the active workspace.
// Every path used here MUST go through resolveInside(). No exceptions.

const fs = require('fs');
const path = require('path');

const IGNORE_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn',
  'dist', 'build', 'out', '.next', '.nuxt', '.cache',
  '.mybeam', '.workspace',
  '__pycache__', 'venv', 'env', '.venv', 'target',
  '.idea', '.vscode'
]);
const IGNORE_FILES = new Set([
  '.DS_Store', 'Thumbs.db'
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2 MB per read
const MAX_TREE_NODES = 5000; // hard cap to keep the tree responsive

let activeRoot = null;

function setRoot(absPath) {
  if (!absPath) { activeRoot = null; return null; }
  const resolved = path.resolve(absPath);
  let st;
  try { st = fs.statSync(resolved); } catch (e) { throw new Error('workspace-not-found: ' + resolved); }
  if (!st.isDirectory()) throw new Error('workspace-not-a-directory: ' + resolved);
  activeRoot = resolved;
  return activeRoot;
}

function getRoot() { return activeRoot; }

// Sandbox: resolve `rel` against activeRoot and refuse escapes.
// Handles '..', absolute paths, and symlinks that leave the root.
function resolveInside(rel) {
  if (!activeRoot) throw new Error('no-workspace');
  const s = String(rel == null ? '' : rel).replace(/\\/g, '/');
  if (s.startsWith('/')) throw new Error('absolute-not-allowed');
  // Reject any segment that is exactly '..'
  const segs = s.split('/');
  for (const seg of segs) {
    if (seg === '..') throw new Error('parent-not-allowed');
  }
  const abs = path.resolve(activeRoot, s);
  // Ensure abs is inside activeRoot
  const relToRoot = path.relative(activeRoot, abs);
  if (relToRoot.startsWith('..') || path.isAbsolute(relToRoot)) throw new Error('outside-workspace');
  // Resolve symlinks for the deepest existing ancestor and re-check.
  try {
    const real = fs.realpathSync(abs);
    const realRoot = fs.realpathSync(activeRoot);
    const relReal = path.relative(realRoot, real);
    if (relReal.startsWith('..') || path.isAbsolute(relReal)) throw new Error('outside-workspace-symlink');
    return real;
  } catch (e) {
    if (String(e.message || '').startsWith('outside-workspace')) throw e;
    // Path doesn't exist yet, or realpath failed — return abs, sandbox still enforced.
    return abs;
  }
}

function shouldIgnoreDir(name) { return IGNORE_DIRS.has(name); }
function shouldIgnoreFile(name) { return IGNORE_FILES.has(name); }

function readTree(maxDepth = 12) {
  if (!activeRoot) throw new Error('no-workspace');
  let nodeCount = 0;
  function walk(absDir, depth) {
    if (depth > maxDepth) return [];
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); }
    catch (_) { return []; }
    entries.sort((a, b) => {
      const ad = a.isDirectory(), bd = b.isDirectory();
      if (ad !== bd) return ad ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    const out = [];
    for (const ent of entries) {
      if (nodeCount >= MAX_TREE_NODES) break;
      const name = ent.name;
      if (ent.isDirectory()) {
        if (shouldIgnoreDir(name)) continue;
        nodeCount++;
        const children = walk(path.join(absDir, name), depth + 1);
        out.push({ type: 'dir', name, path: relFromRoot(path.join(absDir, name)), children });
      } else if (ent.isFile()) {
        if (shouldIgnoreFile(name)) continue;
        nodeCount++;
        let st = null;
        try { st = fs.statSync(path.join(absDir, name)); } catch (_) {}
        out.push({ type: 'file', name, path: relFromRoot(path.join(absDir, name)), size: st ? st.size : 0 });
      }
    }
    return out;
  }
  return walk(activeRoot, 0);
}

function relFromRoot(abs) {
  return path.relative(activeRoot, abs).replace(/\\/g, '/');
}

function readFile(rel) {
  const abs = resolveInside(rel);
  let st;
  try { st = fs.statSync(abs); } catch (e) { throw new Error('not-found'); }
  if (!st.isFile()) throw new Error('not-a-file');
  if (st.size > MAX_FILE_BYTES) throw new Error('file-too-large: ' + st.size);
  const buf = fs.readFileSync(abs);
  return { path: relFromRoot(abs), size: st.size, mtime: st.mtimeMs, content: buf.toString('utf8') };
}

module.exports = {
  setRoot, getRoot,
  resolveInside, readTree, readFile,
  IGNORE_DIRS, MAX_FILE_BYTES
};
