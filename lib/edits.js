// lib/edits.js — parse write directives + clean site chrome from replies.

const FENCE = String.fromCharCode(96, 96, 96);

const CODE_LANGS = new Set([
  'code', 'copy', 'download',
  'js', 'jsx', 'javascript',
  'ts', 'tsx', 'typescript',
  'py', 'python',
  'rb', 'ruby',
  'go', 'rust', 'java', 'kotlin', 'swift',
  'html', 'css', 'scss', 'less',
  'json', 'yaml', 'yml', 'toml', 'xml', 'svg',
  'sh', 'bash', 'shell', 'zsh', 'powershell', 'ps1',
  'sql', 'md', 'markdown',
  'c', 'h', 'cpp', 'c++', 'cs', 'csharp', 'php',
  'dart', 'lua', 'perl', 'scala', 'clojure', 'haskell', 'r',
  'text', 'plain', 'txt'
]);

function isFence(line) { return /^\s*`{3}\s*[\w+.-]*\s*$/.test(line); }
function isChromeToken(line) {
  const t = line.trim().toLowerCase();
  if (!t) return false;
  return CODE_LANGS.has(t);
}

// Clean a body extracted from a <<<NEW/<<<EDIT block.
// Rules:
//   - Always drop fence delimiter lines.
//   - Drop leading lines that are chrome tokens (text, html, code, Copy, ...).
//   - Drop trailing lines that are chrome tokens or Copy/Download chrome.
//   - Never drop a chrome-looking line in the middle of real content.
//   - Collapse 3+ blank lines to 2. Trim leading/trailing blanks.
function cleanBody(lines) {
  // Step 1: drop fences entirely.
  let kept = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (isFence(line)) continue;
    kept.push(line);
  }
  // Step 2: drop leading chrome tokens (only while we haven't hit real content).
  while (kept.length && isChromeToken(kept[0])) kept.shift();
  // Step 3: drop trailing chrome tokens (only while we haven't hit real content from the end).
  while (kept.length && (isChromeToken(kept[kept.length - 1]) || /^(copy|download)$/i.test(kept[kept.length - 1].trim()))) {
    kept.pop();
  }
  // Step 4: collapse blank runs.
  const out = [];
  let blankRun = 0;
  for (const line of kept) {
    if (!line.trim()) {
      blankRun++;
      if (blankRun <= 1) out.push(line);
    } else {
      blankRun = 0;
      out.push(line);
    }
  }
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out.join('\n');
}

// Clean an assistant reply's visible text: strip interleaved site chrome
// (lines that are just "html", "text", "Copy", "Download", etc.) that show up
// between real paragraphs. Keeps markdown structure.
function cleanReplyText(text) {
  if (!text) return '';
  const lines = text.split(/\r?\n/);
  const out = [];
  let inFence = false;
  for (const line of lines) {
    if (isFence(line)) { inFence = !inFence; out.push(line); continue; }
    if (!inFence) {
      // Standalone chrome tokens: blank out. But only if the entire line is
      // exactly the token, so "html" appearing inside prose is safe.
      const t = line.trim().toLowerCase();
      if (t && (CODE_LANGS.has(t) || t === 'copy' || t === 'download')) {
        // Skip it entirely (don't leave a blank either, so paragraphs re-flow).
        continue;
      }
    }
    out.push(line);
  }
  let s = out.join('\n');
  s = s.replace(/\n{3}/g, '\n\n');
  return s.trim();
}

function parseDirectives(text) {
  const out = [];
  if (!text) return out;
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    let m = line.match(/^\s*<<<NEW\s+(\S.*?)\s*$/);
    if (m) {
      const path = m[1].trim();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*>>>END\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      const content = cleanBody(body);
      if (content) out.push({ kind: 'new', path, content });
      else out.push({ kind: 'new', path, content, _emptyAfterClean: true });
      continue;
    }
    m = line.match(/^\s*<<<EDIT\s+(\S.*?)\s*$/);
    if (m) {
      const path = m[1].trim();
      const rest = lines.slice(i + 1);
      if (!/^\s*<<<FIND\s*$/.test(rest[0] || '')) { i++; continue; }
      const bodyLines = rest.slice(1);
      let find = [], replace = [], phase = 'find', j = 0;
      while (j < bodyLines.length) {
        const l = bodyLines[j];
        if (phase === 'find' && /^\s*===\s*$/.test(l)) { phase = 'replace'; j++; continue; }
        if (phase === 'replace' && /^\s*>>>END\s*$/.test(l)) { j++; break; }
        if (phase === 'find') find.push(l);
        else replace.push(l);
        j++;
      }
      i = i + 1 + 1 + j;
      out.push({ kind: 'edit', path, find: cleanBody(find), replace: cleanBody(replace) });
      continue;
    }
    m = line.match(/^\s*<<<DELETE\s+(\S.*?)\s*$/);
    if (m) {
      const path = m[1].trim();
      i++;
      while (i < lines.length && !/^\s*>>>END\s*$/.test(lines[i])) i++;
      i++;
      out.push({ kind: 'delete', path });
      continue;
    }
    i++;
  }
  return out;
}

function parseCheckpoints(text) {
  const out = [];
  if (!text) return out;
  const idx = [];
  let from = 0;
  while (true) {
    const at = text.indexOf('CODEGEN_CHECKPOINT', from);
    if (at === -1) break;
    idx.push(at);
    from = at + 1;
  }
  for (let k = 0; k < idx.length; k++) {
    const start = idx[k];
    const end = (k + 1 < idx.length) ? idx[k + 1] : text.length;
    const chunk = text.slice(start, end);
    const openIdx = chunk.indexOf(FENCE + 'codegen');
    if (openIdx === -1) continue;
    const afterOpen = chunk.indexOf('\n', openIdx);
    if (afterOpen === -1) continue;
    const closeIdx = chunk.indexOf(FENCE, afterOpen + 1);
    if (closeIdx === -1) continue;
    const raw = chunk.slice(afterOpen + 1, closeIdx).trim();
    let parsed = null;
    try { parsed = JSON.parse(raw); } catch (_) {
      try { parsed = JSON.parse(raw.replace(/,(\s*[}\]])/g, '$1')); } catch (_) {}
    }
    if (!parsed || !Array.isArray(parsed.files)) continue;
    for (const f of parsed.files) {
      if (!f || typeof f.path !== 'string' || typeof f.content !== 'string') continue;
      out.push({ kind: 'new', path: f.path, content: f.content });
    }
  }
  return out;
}

function parse(text) {
  const a = parseDirectives(text);
  const b = parseCheckpoints(text);
  return a.concat(b);
}

function describe(edit) {
  if (!edit) return '';
  if (edit.kind === 'new') return 'Create ' + edit.path;
  if (edit.kind === 'edit') return 'Edit ' + edit.path;
  if (edit.kind === 'delete') return 'Delete ' + edit.path;
  return 'Change ' + edit.path;
}

// Strip only the directive envelopes from a reply. Does NOT touch the rest.
// Use cleanReplyText for the general chrome pass.
function stripForDisplay(text) {
  if (!text) return '';
  let s = text;
  s = s.replace(/<<<NEW\s+[\s\S]*?>>>END/g, '');
  s = s.replace(/<<<EDIT\s+[\s\S]*?>>>END/g, '');
  s = s.replace(/<<<DELETE\s+[\s\S]*?>>>END/g, '');
  s = s.replace(/CODEGEN_CHECKPOINT[\s\S]*?```/g, '');
  s = s.replace(/\n{3}/g, '\n\n');
  return s.trim();
}

module.exports = { parse, parseDirectives, parseCheckpoints, describe, stripForDisplay, cleanBody, cleanReplyText };
