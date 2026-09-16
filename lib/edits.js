// lib/edits.js — parse write directives out of an AI reply, with strict
// cleanup of site-injected chrome ("code", "python", "Copy", "Download").
//
// Supported:
//   <<<NEW path\n<content>\n>>>END
//   <<<EDIT path\n<<<FIND\n<find>\n===\n<replace>\n>>>END
//   <<<DELETE path\n>>>END
//   plus CODEGEN_CHECKPOINT { ... } (CodeDrop compatibility)

const FENCE = String.fromCharCode(96, 96, 96);

// Lines that are site chrome, not file content. Dropped from extracted bodies.
const CHROME_LINES = new Set([
  'code', 'Code',
  'copy', 'Copy', 'COPY',
  'download', 'Download', 'DOWNLOAD',
  'js', 'jsx', 'javascript', 'JavaScript',
  'ts', 'tsx', 'typescript', 'TypeScript',
  'py', 'python', 'Python',
  'rb', 'ruby', 'Ruby',
  'go', 'Go', 'rust', 'Rust',
  'java', 'Java', 'kotlin', 'Kotlin', 'swift', 'Swift',
  'html', 'HTML', 'css', 'CSS', 'scss', 'less',
  'json', 'JSON', 'yaml', 'YAML', 'yml', 'YML', 'toml', 'TOML',
  'xml', 'XML', 'svg', 'SVG',
  'sh', 'bash', 'shell', 'zsh', 'powershell', 'ps1', 'Powershell',
  'sql', 'SQL', 'md', 'markdown', 'Markdown',
  'c', 'h', 'cpp', 'c++', 'cs', 'csharp', 'php', 'php3', 'php4', 'php5', 'php7',
  'dart', 'lua', 'perl', 'scala', 'clojure', 'haskell', 'r', 'R'
]);

function looksLikeChrome(line) {
  const t = line.trim();
  if (!t) return false;
  if (CHROME_LINES.has(t)) return true;
  return false;
}

function cleanBody(lines) {
  // 1) drop fence delimiters used by the site around the code
  // 2) drop chrome-only lines
  // 3) collapse 3+ blank lines to 2
  const out = [];
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '');
    // Fences with optional language: ``` or ```python
    if (/^\s*`{3}\s*[\w+.-]*\s*$/.test(line)) continue;
    if (looksLikeChrome(line)) continue;
    out.push(line);
  }
  // Collapse excessive blank runs.
  const collapsed = [];
  let blankRun = 0;
  for (const line of out) {
    if (!line.trim()) {
      blankRun++;
      if (blankRun <= 1) collapsed.push(line);
    } else {
      blankRun = 0;
      collapsed.push(line);
    }
  }
  // Trim leading/trailing blanks.
  while (collapsed.length && !collapsed[0].trim()) collapsed.shift();
  while (collapsed.length && !collapsed[collapsed.length - 1].trim()) collapsed.pop();
  return collapsed.join('\n');
}

function parseDirectives(text) {
  const out = [];
  if (!text) return out;
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    // <<<NEW path
    let m = line.match(/^\s*<<<NEW\s+(\S.*?)\s*$/);
    if (m) {
      const path = m[1].trim();
      const body = [];
      i++;
      while (i < lines.length && !/^\s*>>>END\s*$/.test(lines[i])) { body.push(lines[i]); i++; }
      i++;
      out.push({ kind: 'new', path, content: cleanBody(body) });
      continue;
    }

    // <<<EDIT path
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

    // <<<DELETE path
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

// Produce the display version of a reply: strip the directive envelopes so the
// user sees only prose and edit cards.
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

module.exports = { parse, parseDirectives, parseCheckpoints, describe, stripForDisplay, cleanBody };
