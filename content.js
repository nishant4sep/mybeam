// content.js — DOM automation + markdown reconstruction for oxalpha.com.
// - Rebuilds markdown from DOM (innerText flattens newlines).
// - Detects verification / waiting states; pauses the reply timeout.
// - Detects oxalpha's "temporary problem" placeholder and auto-retries once.
// - Best-effort image attach with verification that a preview appeared.

(function () {
  if (window.__MYBEAM_CONTENT_LOADED__) {
    try { chrome.runtime.sendMessage({ type: 'MYBEAM_HELLO' }); } catch (_) {}
    return;
  }
  window.__MYBEAM_CONTENT_LOADED__ = true;

  const LOG = (...a) => console.log('[MyBeam:content]', ...a);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const FENCE = String.fromCharCode(96, 96, 96);

  // ---------- selectors ----------
  function findComposer() { return document.querySelector('textarea[placeholder="Send a message..."]') || document.querySelector('textarea'); }
  function findSendButton() { return document.querySelector('button.send-btn') || document.querySelector('button[title="Send"]'); }
  function findAssistantMessages() { return Array.from(document.querySelectorAll('.msg.msg-assistant')); }
  function pageLooksReady() { return !!findComposer(); }

  // ---------- verification ----------
  function pageHasVerification() {
    const composerGone = !findComposer();
    const bodyText = (document.body && (document.body.innerText || document.body.textContent) || '').toLowerCase();
    const textHits = [
      'verify you are human','verifying you are human','checking your browser',
      'just a moment','waiting for verification','human verification',
      'complete the challenge','turnstile'
    ].some((needle) => bodyText.indexOf(needle) !== -1);
    const widget = !!document.querySelector(
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], ' +
      '[class*="cf-turnstile"], [class*="turnstile"], [id*="turnstile"], ' +
      '[class*="captcha"], [id*="captcha"], [class*="verif"], [id*="verif"]'
    );
    return composerGone && (textHits || widget);
  }

  // ---------- placeholder / retryable detection ----------
  function isPlaceholderText(s) {
    const t = (s || '').replace(/\s+/g, ' ').trim();
    if (!t) return true;
    if (/^Ox\s*Alpha\s*Thinking[\u2026.]*$/i.test(t)) return true;
    if (/^Thinking[\u2026.]*$/i.test(t)) return true;
    if (/^Ox\s*Alpha$/i.test(t)) return true;
    if (/^Waiting for verification[\u2026.]*$/i.test(t)) return true;
    if (/^Verifying[\u2026.]*$/i.test(t)) return true;
    if (/^Checking[\u2026.]*$/i.test(t)) return true;
    if (/^Please wait[\u2026.]*$/i.test(t)) return true;
    if (/verification/i.test(t) && t.length < 60) return true;
    if (/^Human verification[\u2026.]*$/i.test(t)) return true;
    return false;
  }

  // oxalpha's provider hiccup text — this is retryable.
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

  function stripChrome(s) {
    let t = s;
    t = t.replace(/^\s*Ox\s*Alpha\s*\n?/i, '');
    t = t.replace(/\n?\s*Copy\s*\n?\s*Download\s*$/i, '');
    t = t.replace(/\n?\s*Copy\s*$/i, '');
    t = t.replace(/\n?\s*Download\s*$/i, '');
    return t.trim();
  }

  // ---------- markdown reconstruction ----------
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
    return inner;
  }

  function isChromeNode(node) {
    if (node.nodeType !== Node.ELEMENT_NODE) return false;
    const cls = (node.className && node.className.toString) ? node.className.toString().toLowerCase() : '';
    const aria = (node.getAttribute && (node.getAttribute('aria-label') || '')) + '';
    const txt = (node.textContent || '').trim();
    if (/\bmsg-action|\bmsg-tools|\bactions\b|\bcopy-btn|\bdownload-btn|\bthinking\b/.test(cls)) return true;
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

  function messageToMarkdown(el) {
    const content = el.querySelector('.msg-content .prose') || el.querySelector('.msg-content') || el;
    const parts = [];
    Array.from(content.childNodes).forEach((n) => { parts.push(blockToMd(n, 0)); });
    let md = parts.join('');
    md = md.replace(/\n{3}/g, '\n\n').trim();
    md = stripChrome(md);
    return md;
  }

  // ---------- attachments ----------
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

  // Count how many image-ish previews exist in the input area — used to verify attach worked.
  function countComposerImagePreviews() {
    const area = document.querySelector('.input-area, .input-col') || document.body;
    if (!area) return 0;
    // Images inside the input area that are not part of the message list.
    return area.querySelectorAll('img, [style*="background-image"]').length;
  }

  async function attachImages(images) {
    if (!images || !images.length) return { ok: false, reason: 'no-images' };
    const files = [];
    images.forEach((img, i) => { const f = dataUrlToFile(img.dataUrl, img.name || ('paste-' + i + '.png')); if (f) files.push(f); });
    if (!files.length) return { ok: false, reason: 'decode-failed' };

    const beforeCount = countComposerImagePreviews();

    // 1) file input present?
    let input = document.querySelector('input[type="file"]');
    let revealedInput = false;
    if (!input) {
      const candidates = Array.from(document.querySelectorAll('button, [role="button"]'));
      for (const b of candidates) {
        const aria = (b.getAttribute('aria-label') || '').toLowerCase();
        const title = (b.getAttribute('title') || '').toLowerCase();
        const cls = (b.className && b.className.toString) ? b.className.toString().toLowerCase() : '';
        if (/attach|upload|image|file|photo|paperclip/.test(aria + ' ' + title + ' ' + cls)) {
          try { b.click(); } catch (_) {}
          await sleep(280);
          input = document.querySelector('input[type="file"]');
          if (input) { revealedInput = true; break; }
        }
      }
    }

    let attached = false;
    if (input) {
      try {
        const dt = new DataTransfer();
        files.forEach((f) => dt.items.add(f));
        input.files = dt.files;
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
        // Wait and check whether a preview appeared.
        for (let i = 0; i < 10; i++) {
          await sleep(150);
          if (countComposerImagePreviews() > beforeCount) { attached = true; break; }
        }
        if (!attached) { LOG('file input set but no preview appeared'); attached = countComposerImagePreviews() > beforeCount; }
        else LOG('attached via file input');
      } catch (e) { LOG('file input attach failed', String(e)); }
    }

    if (!attached) {
      try {
        const dropTarget = document.querySelector('.input-area, .input-col, form, textarea') || document.body;
        const dt = new DataTransfer();
        files.forEach((f) => dt.items.add(f));
        ['dragenter','dragover','drop'].forEach((evt) => {
          const ev = new DragEvent(evt, { bubbles: true, cancelable: true, dataTransfer: dt });
          try { dropTarget.dispatchEvent(ev); } catch (_) {}
        });
        for (let i = 0; i < 10; i++) {
          await sleep(150);
          if (countComposerImagePreviews() > beforeCount) { attached = true; break; }
        }
        if (attached) LOG('attached via drop event');
        else LOG('drop event dispatched but no preview appeared');
      } catch (e) { LOG('drop attach failed', String(e)); }
    }

    // Clean up an input we revealed via a fake click.
    if (revealedInput && !attached) {
      try { document.body.click(); } catch (_) {}
    }
    return { ok: attached, reason: attached ? 'ok' : 'no-preview-detected' };
  }

  // ---------- typing / submit ----------
  async function typeIntoComposer(text) {
    const el = findComposer();
    if (!el) throw new Error('composer-not-found');
    el.focus(); el.click();
    try { el.select && el.select(); } catch (_) {}
    try { document.execCommand('delete', false, null); } catch (_) {}
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, text); } catch (_) { inserted = false; }
    if (!inserted || (el.value || '') !== text) {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await sleep(120);
    return el;
  }

  async function waitForSendEnabled(timeoutMs = 2500) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const btn = findSendButton();
      if (btn && !btn.disabled) return btn;
      await sleep(80);
    }
    return null;
  }

  async function submitComposer(el) {
    const btn = await waitForSendEnabled(2500);
    if (btn) {
      btn.click();
      await sleep(280);
      if (!findComposer()) return true;
      const ta = findComposer();
      if (ta && !(ta.value || '').trim()) return true;
    }
    const ta = findComposer();
    if (ta) {
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      ta.dispatchEvent(new KeyboardEvent('keydown', opts));
      ta.dispatchEvent(new KeyboardEvent('keypress', opts));
      ta.dispatchEvent(new KeyboardEvent('keyup', opts));
      await sleep(280);
      if (!findComposer()) return true;
      const ta2 = findComposer();
      if (ta2 && !(ta2.value || '').trim()) return true;
    }
    return false;
  }

  // ---------- streaming ----------
  function emitStream(taskId, text) { try { chrome.runtime.sendMessage({ type: 'MYBEAM_STREAM', taskId, text }); } catch (_) {} }
  function emitVerify(taskId, on) { try { chrome.runtime.sendMessage({ type: 'MYBEAM_VERIFY', taskId, on: !!on }); } catch (_) {} }

  // Returns { reply, retryable } — retryable=true if the placeholder was a provider error we should resend.
  async function streamReply(prevCount, taskId, { stableMs = 1000, maxTimeoutMs = 240000, safetyMs = 80 } = {}) {
    const start = Date.now();
    let bubble = null;
    while (true) {
      if (pageHasVerification()) { emitVerify(taskId, true); await sleep(300); continue; }
      const msgs = findAssistantMessages();
      if (msgs.length > prevCount) { bubble = msgs[msgs.length - 1]; break; }
      if (Date.now() - start >= 20000) throw new Error('no-assistant-bubble');
      await sleep(100);
    }

    return await new Promise((resolve, reject) => {
      let lastText = '';
      let lastChangeAt = Date.now();
      let resolved = false;
      let sawRealContent = false;
      let verifyOn = false;
      let verifyNotifiedOff = false;
      let verifyStartedAt = 0;
      let retryable = false;

      const flush = () => {
        if (resolved) return;
        const nowVerify = pageHasVerification();
        if (nowVerify && !verifyOn) { verifyOn = true; verifyStartedAt = Date.now(); verifyNotifiedOff = false; emitVerify(taskId, true); }
        else if (!nowVerify && verifyOn) { verifyOn = false; if (!verifyNotifiedOff) { emitVerify(taskId, false); verifyNotifiedOff = true; } lastChangeAt = Date.now(); }
        const msgs = findAssistantMessages();
        const latest = msgs[msgs.length - 1];
        if (!latest) return;
        const text = messageToMarkdown(latest);
        if (!text || isPlaceholderText(text)) return;
        if (isRetryableProviderError(text)) {
          retryable = true;
          // Treat as stable if unchanged for a short beat, then finish with retryable=true.
        }
        sawRealContent = true;
        if (text !== lastText) { lastText = text; lastChangeAt = Date.now(); emitStream(taskId, text); }
      };

      const mo = new MutationObserver(flush);
      mo.observe(bubble, { childList: true, subtree: true, characterData: true });
      const docMo = new MutationObserver(flush);
      docMo.observe(document.body, { childList: true, subtree: true });

      const tick = setInterval(() => {
        flush();
        if (!sawRealContent) return;
        if (verifyOn) return;
        if (Date.now() - lastChangeAt >= stableMs) finish();
        if (verifyStartedAt && Date.now() - verifyStartedAt > maxTimeoutMs) finish(true);
      }, safetyMs);

      const finish = (timedOut) => {
        if (resolved) return;
        resolved = true;
        clearInterval(tick);
        try { mo.disconnect(); } catch (_) {}
        try { docMo.disconnect(); } catch (_) {}
        if (verifyOn) emitVerify(taskId, false);
        if (timedOut && !lastText) reject(new Error('reply-timeout'));
        else resolve({ reply: lastText, retryable });
      };
    });
  }

  // ---------- task ----------
  let busy = false;
  function reportState() { try { chrome.runtime.sendMessage({ type: 'MYBEAM_STATE', connected: pageLooksReady(), busy }); } catch (_) {} }

  // Send one attempt; returns { ok, reply, error, retryable, attachFailed }.
  async function attemptOnce(task) {
    const prevCount = findAssistantMessages().length;
    let attachFailed = false;
    if (task && task.images && task.images.length) {
      try {
        const r = await attachImages(task.images);
        if (!r.ok) { attachFailed = true; LOG('attach failed:', r.reason); }
      } catch (e) { attachFailed = true; LOG('attach threw', String(e)); }
    }
    const el = await typeIntoComposer(task.text || '');
    const sent = await submitComposer(el);
    if (!sent) throw new Error('submit-failed');
    LOG('submitted task', task.id, 'prevCount', prevCount, 'images', task.images ? task.images.length : 0, 'attachFailed', attachFailed);
    const { reply, retryable } = await streamReply(prevCount, task.id);
    return { reply, retryable, attachFailed };
  }

  async function handleTask(task) {
    const taskId = task && task.id;
    if (busy) return { taskId, ok: false, error: 'busy' };
    busy = true;
    reportState();
    try {
      let r = await attemptOnce(task);
      // Auto-retry once if the provider placeholder came back.
      if (r.retryable) {
        LOG('detected retryable provider error, retrying once…');
        try { chrome.runtime.sendMessage({ type: 'MYBEAM_STREAM', taskId, text: '' }); } catch (_) {}
        await sleep(900);
        const r2 = await attemptOnce(task);
        if (!r2.retryable) r = r2;
        else r = { reply: r2.reply || r.reply, retryable: true, attachFailed: r2.attachFailed || r.attachFailed };
      }
      const result = { taskId, ok: true, reply: r.reply };
      if (r.attachFailed) result.attachFailed = true;
      return result;
    } catch (err) {
      return { taskId, ok: false, error: String(err && err.message || err) };
    } finally {
      busy = false;
      reportState();
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'MYBEAM_DOM_TASK') {
      handleTask(msg.task).then((result) => {
        chrome.runtime.sendMessage({ type: 'MYBEAM_DOM_RESULT', ...result }).catch(() => {});
        sendResponse(result);
      });
      return true;
    }
    if (msg.type === 'MYBEAM_PING') { sendResponse({ ok: true, ready: pageLooksReady(), busy }); return; }
  });

  try { chrome.runtime.sendMessage({ type: 'MYBEAM_HELLO' }); } catch (_) {}
  (function waitReady() {
    if (pageLooksReady()) {
      LOG('composer detected @', location.href);
      try { chrome.runtime.sendMessage({ type: 'MYBEAM_HELLO' }); } catch (_) {}
      reportState();
      return;
    }
    setTimeout(waitReady, 1000);
  })();

  setInterval(reportState, 5000);
  LOG('content script loaded @', location.href);
})();
