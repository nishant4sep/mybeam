// content-core/utils.js — shared helpers for every provider adapter.
// Loaded before content-core/core.js in manifest.json.

window.MyBeamUtils = window.MyBeamUtils || (function () {
  const FENCE = String.fromCharCode(96, 96, 96);

  function inline(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    const tag = node.tagName.toLowerCase();
    const inner = Array.from(node.childNodes).map(inline).join('');
    if (tag === 'strong' || tag === 'b') return '**' + inner + '**';
    if (tag === 'em' || tag === 'i') return '*' + inner + '*';
    if (tag === 'code') { const c = String.fromCharCode(96); return c + inner + c; }
    if (tag === 'a') { const href = node.getAttribute('href') || ''; return '[' + inner + '](' + href + ')'; }
    if (tag === 'br') return '\n';
    if (tag === 'img') { const src = node.getAttribute('src') || ''; const alt = node.getAttribute('alt') || 'image'; if (src) return '![' + alt + '](' + src + ')'; }
    return inner;
  }

  function isChromeNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const cls = (node.className && node.className.toString) ? node.className.toString().toLowerCase() : '';
    const aria = (node.getAttribute && (node.getAttribute('aria-label') || '')) + '';
    const txt = (node.textContent || '').trim();
    if (/\bmsg-action|\bmsg-tools|\bactions\b|\bcopy-btn|\bdownload-btn|\bthinking\b|ds-icon/.test(cls)) return true;
    if (/^Copy$|^Download$|^Regenerate$|^Good response$|^Bad response$/i.test(txt)) return true;
    if (/thinking/i.test(aria)) return true;
    return false;
  }

  function blockToMd(node, depth) {
    depth = depth || 0;
    if (node.nodeType === Node.TEXT_NODE) return (node.nodeValue || '').trim();
    if (node.nodeType !== Node.ELEMENT_NODE) return '';
    if (isChromeNode(node)) return '';
    const tag = node.tagName.toLowerCase();
    if (/^h[1-6]$/.test(tag)) { const level = +tag[1]; return '#'.repeat(level) + ' ' + Array.from(node.childNodes).map(inline).join('').trim() + '\n\n'; }
    if (tag === 'p') return Array.from(node.childNodes).map(inline).join('').trim() + '\n\n';
    if (tag === 'pre') {
      const codeEl = node.querySelector('code') || node;
      const raw = codeEl.textContent || '';
      let lang = '';
      const cls = ((codeEl.className || '') + ' ' + (node.className || '')).toString();
      const m = cls.match(/language-([\w+.-]+)/) || cls.match(/lang-([\w+.-]+)/);
      if (m) lang = m[1].toLowerCase();
      else if (/^\s*<!?doctype html/i.test(raw) || /^\s*<html[\s>]/i.test(raw)) lang = 'html';
      else if (/^\s*[.#]?[a-z-]+\s*\{[^}]*\}/m.test(raw) && !/[;<]/.test(raw.slice(0, 40))) lang = 'css';
      else if (/^\s*(function|const|let|var|=>)/.test(raw)) lang = 'js';
      return FENCE + lang + '\n' + raw.replace(/\n+$/, '') + '\n' + FENCE + '\n\n';
    }
    if (tag === 'ul' || tag === 'ol') {
      const items = Array.from(node.children).filter((c) => c.tagName.toLowerCase() === 'li');
      let out = '';
      items.forEach((li, idx) => {
        const body = Array.from(li.childNodes).map((c) => blockToMd(c, depth + 1)).join('').trim().replace(/\n+/g, ' ');
        out += (tag === 'ol' ? (idx + 1) + '. ' : '- ') + body + '\n';
      });
      return out + '\n';
    }
    if (tag === 'blockquote') {
      const body = Array.from(node.childNodes).map((c) => blockToMd(c, depth + 1)).join('').trim();
      return body.split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
    }
    if (tag === 'hr') return '---\n\n';
    if (tag === 'table') {
      const rows = Array.from(node.querySelectorAll('tr'));
      if (!rows.length) return '';
      let out = '';
      rows.forEach((tr, i) => {
        const cells = Array.from(tr.children).map((td) => Array.from(td.childNodes).map(inline).join('').trim().replace(/\|/g, '\\|'));
        out += '| ' + cells.join(' | ') + ' |\n';
        if (i === 0) out += '| ' + cells.map(() => '---').join(' | ') + ' |\n';
      });
      return out + '\n';
    }
    if (tag === 'div' || tag === 'section' || tag === 'article') return Array.from(node.childNodes).map((c) => blockToMd(c, depth)).join('');
    const t = Array.from(node.childNodes).map(inline).join('').trim();
    return t ? t + '\n\n' : '';
  }

  function stripChrome(s) {
    let t = s;
    t = t.replace(/^\s*Ox\s*Alpha\s*\n?/i, '');
    t = t.replace(/^\s*DeepSeek\s*\n?/i, '');
    t = t.replace(/\n?\s*Copy\s*\n?\s*Download\s*$/i, '');
    t = t.replace(/\n?\s*Copy\s*$/i, '');
    t = t.replace(/\n?\s*Download\s*$/i, '');
    return t.trim();
  }

  function isPlaceholderText(s) {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    if (!t) return true;
    if (/^Ox\s*Alpha\s*Thinking[\u2026.]*$/i.test(t)) return true;
    if (/^Thinking[\u2026.]*$/i.test(t)) return true;
    if (/^Ox\s*Alpha$/i.test(t)) return true;
    if (/^DeepSeek$/i.test(t)) return true;
    if (/^Waiting for verification[\u2026.]*$/i.test(t)) return true;
    if (/^Verifying[\u2026.]*$/i.test(t)) return true;
    if (/^Checking[\u2026.]*$/i.test(t)) return true;
    if (/^Please wait[\u2026.]*$/i.test(t)) return true;
    if (/verification/i.test(t) && t.length < 60) return true;
    if (/^Human verification[\u2026.]*$/i.test(t)) return true;
    return false;
  }

  function isRetryableProviderError(s) {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    if (!t) return false;
    if (/temporary problem/i.test(t) && t.length < 400) return true;
    if (/provider had a temporary/i.test(t)) return true;
    if (/^the model provider/i.test(t)) return true;
    if (/please try again/i.test(t) && t.length < 200) return true;
    if (/something went wrong/i.test(t) && t.length < 200) return true;
    if (/try again later/i.test(t) && t.length < 200) return true;
    return false;
  }

  function dataUrlToFile(dataUrl, name) {
    try {
      const comma = dataUrl.indexOf(',');
      const meta = dataUrl.slice(0, comma);
      const b64 = dataUrl.slice(comma + 1);
      const mimeMatch = meta.match(/data:([^;]+)/);
      const mime = mimeMatch ? mimeMatch[1] : 'application/octet-stream';
      const binary = atob(b64);
      const len = binary.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
      return new File([bytes], name || ('image.' + (mime.split('/')[1] || 'png')), { type: mime });
    } catch (e) { return null; }
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  return {
    inline, blockToMd, stripChrome, isPlaceholderText, isRetryableProviderError,
    dataUrlToFile, sleep, FENCE, isChromeNode
  };
})();
