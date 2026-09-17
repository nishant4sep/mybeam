// lib/projectmap.js — generate PROJECT_MAP.md from the workspace tree.
//
// Strategy:
//   1. Walk the workspace tree (already done by lib/workspace.readTree).
//   2. Build a compact listing: path, size, and (for text files under a
//      size cap) the first few lines as a hint.
//   3. Send a single request to the active provider asking for a short map.
//   4. Write the result to .mybeam/memory/PROJECT_MAP.md.
//
// This module doesn't call the browser extension directly. It enqueues a
// special task through the same path user messages take, so the provider
// routing and edit-card plumbing don't need to know it exists.

const fs = require('fs');
const path = require('path');
const workspace = require('./workspace');
const memory = require('./memory');

const MAX_FILES_IN_PROMPT = 200;
const MAX_HEAD_BYTES = 200; // first ~3 lines of each file for context
const TEXT_EXTS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.h', '.cpp', '.hpp', '.cs',
  '.html', '.htm', '.css', '.scss', '.less',
  '.md', '.txt', '.yml', '.yaml', '.toml', '.ini', '.env',
  '.sh', '.bash', '.zsh', '.ps1',
  '.sql', '.xml', '.svg'
]);

function flattenTree(tree, out) {
  out = out || [];
  for (const node of (tree || [])) {
    if (node.type === 'file') out.push(node);
    else if (node.type === 'dir') flattenTree(node.children, out);
    if (out.length >= MAX_FILES_IN_PROMPT) return out;
  }
  return out;
}

function readHead(relPath) {
  try {
    const abs = workspace.resolveInside(relPath);
    const buf = fs.readFileSync(abs);
    const slice = buf.slice(0, MAX_HEAD_BYTES);
    return slice.toString('utf8').replace(/\r?\n/g, ' \\n ').trim();
  } catch (_) { return ''; }
}

function buildList() {
  const tree = workspace.readTree();
  const files = flattenTree(tree);
  const lines = [];
  const root = workspace.getRoot();
  for (const f of files) {
    const ext = path.extname(f.name).toLowerCase();
    const head = TEXT_EXTS.has(ext) ? readHead(f.path) : '';
    const sizeStr = f.size < 1024 ? f.size + 'B' : Math.round(f.size / 1024) + 'K';
    lines.push('- ' + f.path + '  (' + sizeStr + ')' + (head ? '  :: ' + head.slice(0, 140) : ''));
  }
  return { root, files, listing: lines.join('\n') };
}

function buildPrompt() {
  const { root, files, listing } = buildList();
  const lines = [];
  lines.push('I am generating a project map for a code repository.');
  lines.push('');
  lines.push('Root folder: ' + root);
  lines.push('File count: ' + files.length);
  lines.push('');
  lines.push('Files:');
  lines.push(listing);
  lines.push('');
  lines.push('Please write PROJECT_MAP.md — a short, dense markdown document describing this project.');
  lines.push('Format:');
  lines.push('  # Project Map');
  lines.push('  ## What this is');
  lines.push('  One or two sentences.');
  lines.push('  ## Structure');
  lines.push('  Bullets listing the top-level folders and their purpose.');
  lines.push('  ## Key files');
  lines.push('  Bullets: path — one-line description. Only the ones that matter.');
  lines.push('  ## Notes');
  lines.push('  Anything else a new contributor should know.');
  lines.push('');
  lines.push('Rules:');
  lines.push('- Keep it under 400 words.');
  lines.push('- Do NOT invent files. Only describe what is listed above.');
  lines.push('- Do NOT emit MyBeam write directives. Just output the markdown directly.');
  lines.push('- Start your reply with exactly: # Project Map');
  return lines.join('\n');
}

function writeProjectMap(markdown) {
  const clean = (markdown || '').trim();
  if (!clean) throw new Error('empty-map');
  // Trim any leading prose the model might have added before the header.
  const idx = clean.indexOf('# Project Map');
  const body = idx >= 0 ? clean.slice(idx) : clean;
  memory.writeMemoryFile('PROJECT_MAP.md', body + '\n');
  return body;
}

module.exports = { buildPrompt, writeProjectMap, flattenTree, buildList };
