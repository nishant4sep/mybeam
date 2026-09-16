// content-core/core.js — provider-agnostic task loop.
// v4: buffered reveal start, submit retry, fresh-context-once, snapshot reply detection.

(function () {
  if (window.__MYBEAM_CORE_LOADED__) return;
  window.__MYBEAM_CORE_LOADED__ = true;

  const LOG = (...a) => console.log('[MyBeam:content]', ...a);
  const U = window.MyBeamUtils;

  let contextAlive = true;
  let currentCancel = null;
  let freshContextAttempted = false;

  function safeSend(msg, cb) {
    if (!contextAlive) return;
    try {
      if (cb) chrome.runtime.sendMessage(msg, (r) => { try { if (chrome.runtime.lastError) {} cb(r); } catch (_) { cb(null); } });
      else chrome.runtime.sendMessage(msg);
    } catch (e) {
      if (String(e && e.message || e).includes('context invalidated')) {
        contextAlive = false;
        LOG('extension context invalidated — going silent');
      }
    }
  }

  function pickProvider() {
    const host = location.hostname;
    const map = window.MyBeamProviders || {};
    for (const key of Object.keys(map)) {
      const p = map[key];
      if (p.hosts && p.hosts.some((h) => host === h || host.endsWith('.' + h))) return p;
    }
    return null;
  }

  const provider = pickProvider();
  if (!provider) { LOG('no provider for', location.hostname); return; }
  LOG('provider:', provider.name);

  // ---------- typing ----------
  async function typeIntoComposer(text) {
    const el = provider.findComposer();
    if (!el) throw new Error('composer-not-found');
    if (!text) { el.focus(); return el; }
    el.focus(); el.click();
    try { el.select && el.select(); } catch (_) {}
    try { document.execCommand('delete', false, null); } catch (_) {}
    let inserted = false;
    try { inserted = document.execCommand('insertText', false, text); } catch (_) { inserted = false; }
    if (!inserted || (el.value || '') !== text) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
      setter.call(el, text);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    await U.sleep(150);
    return el;
  }

  async function waitForSendReady(timeoutMs = 4000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const btn = provider.findSendButton();
      const ta = provider.findComposer();
      const hasText = ta && (ta.value || '').trim().length > 0;
      const hasImages = provider.countComposerImagePreviews() > 0;
      if (btn && !btn.disabled && (hasText || hasImages)) return btn;
      if (!btn && (hasText || hasImages)) return null;
      await U.sleep(80);
    }
    return null;
  }

  function composerCleared() {
    const ta = provider.findComposer();
    if (!ta) return true;
    if ((ta.value || '').trim().length > 0) return false;
    if (provider.countComposerImagePreviews() > 0) return false;
    return true;
  }

  async function submitComposer(el) {
    const hasText0 = el && (el.value || '').trim().length > 0;
    const hasImages0 = provider.countComposerImagePreviews() > 0;
    if (!hasText0 && !hasImages0) return false;

    // Attempt 1: click the send button if visible.
    const btn = await waitForSendReady(2500);
    if (btn && !btn.disabled) {
      btn.click();
      await U.sleep(500);
      if (composerCleared()) return true;
    }

    // Attempt 2: Enter keypress on the composer.
    const ta = provider.findComposer();
    if (ta) {
      const opts = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      ta.dispatchEvent(new KeyboardEvent('keydown', opts));
      ta.dispatchEvent(new KeyboardEvent('keypress', opts));
      ta.dispatchEvent(new KeyboardEvent('keyup', opts));
      await U.sleep(500);
      if (composerCleared()) return true;
    }

    // Attempt 3: wait a beat then click the button again (it may have enabled late).
    const btn2 = await waitForSendReady(2000);
    if (btn2 && !btn2.disabled) {
      btn2.click();
      await U.sleep(500);
      if (composerCleared()) return true;
    }

    return false;
  }

  // ---------- attach ----------
  async function waitForUploadSettled(timeoutMs = 8000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const spinner = provider.composerHasSpinner();
      const btn = provider.findSendButton();
      const ready = !btn || !btn.disabled;
      if (!spinner && ready) return { ok: true };
      await U.sleep(150);
    }
    return { ok: false, reason: 'upload-not-settled' };
  }

  async function attachImages(images) {
    if (!images || !images.length) return { ok: false, reason: 'no-images' };
    const files = [];
    images.forEach((img, i) => { const f = U.dataUrlToFile(img.dataUrl, img.name || ('paste-' + i + '.png')); if (f) files.push(f); });
    if (!files.length) return { ok: false, reason: 'decode-failed' };
    const input = provider.findFileInput();
    if (!input) return { ok: false, reason: 'no-file-input' };
    const beforeCount = provider.countComposerImagePreviews();
    try {
      const dt = new DataTransfer();
      files.forEach((f) => dt.items.add(f));
      input.files = dt.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    } catch (e) { LOG('attach failed', String(e)); return { ok: false, reason: 'set-files-failed' }; }
    let previewed = false;
    for (let i = 0; i < 20; i++) {
      await U.sleep(150);
      if (provider.countComposerImagePreviews() > beforeCount) { previewed = true; break; }
    }
    if (!previewed) return { ok: false, reason: 'no-preview' };
    const settled = await waitForUploadSettled(8000);
    if (!settled.ok) return { ok: false, reason: settled.reason };
    await U.sleep(500);
    return { ok: true };
  }

  // ---------- fresh context (once per tab) ----------
  async function tryFreshContextOnce() {
    if (freshContextAttempted) return false;
    freshContextAttempted = true;
    const btn = provider.findNewChatButton();
    if (!btn) { LOG('fresh-context: no New Chat button (skipping, once)'); return false; }
    const before = provider.findAllMessages().length;
    try { btn.click(); } catch (e) { LOG('fresh-context click threw', String(e)); return false; }
    const start = Date.now();
    while (Date.now() - start < 4000) {
      await U.sleep(150);
      const now = provider.findAllMessages().length;
      if (now < before || now === 0) { LOG('fresh-context: cleared'); return true; }
    }
    return true;
  }

  // ---------- streaming ----------
  function emitStream(taskId, text) { safeSend({ type: 'MYBEAM_STREAM', taskId, text }); }
  function emitVerify(taskId, on) { safeSend({ type: 'MYBEAM_VERIFY', taskId, on: !!on }); }

  function snapshotAssistants() {
    const set = new Set();
    const msgs = provider.findAssistantMessages();
    for (let i = 0; i < msgs.length; i++) set.add(msgs[i]);
    return set;
  }
  function findNewAssistant(snapshot) {
    const msgs = provider.findAssistantMessages();
    for (let i = msgs.length - 1; i >= 0; i--) {
      if (!snapshot.has(msgs[i])) return msgs[i];
    }
    return null;
  }

  async function streamReply(snapshot, taskId, urlAtStart, { stableMs = 1400, maxTimeoutMs = 240000, safetyMs = 100, initialWaitMs = 45000 } = {}) {
    const start = Date.now();
    let bubble = null;
    let navigatedAway = false;
    while (true) {
      if (currentCancel && currentCancel.taskId === taskId) throw new Error('cancelled');
      if (location.href !== urlAtStart) { navigatedAway = true; break; }
      if (provider.hasVerification()) { emitVerify(taskId, true); await U.sleep(300); continue; }
      bubble = findNewAssistant(snapshot);
      if (bubble) break;
      if (Date.now() - start >= initialWaitMs) throw new Error('no-assistant-bubble');
      await U.sleep(100);
    }
    if (navigatedAway) {
      LOG('navigated away mid-task — signalling retry');
      throw new Error('navigated-retry');
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

      // Buffered reveal: don't emit until we have enough text or the reply stabilizes.
      const MIN_FIRST_CHUNK = 200;
      let firstEmitDone = false;

      const flush = (force) => {
        if (resolved) return;
        if (currentCancel && currentCancel.taskId === taskId) { resolve({ reply: lastText, retryable: false, cancelled: true }); return; }
        const nowVerify = provider.hasVerification();
        if (nowVerify && !verifyOn) { verifyOn = true; verifyStartedAt = Date.now(); verifyNotifiedOff = false; emitVerify(taskId, true); }
        else if (!nowVerify && verifyOn) { verifyOn = false; if (!verifyNotifiedOff) { emitVerify(taskId, false); verifyNotifiedOff = true; } lastChangeAt = Date.now(); }
        const latest = findNewAssistant(snapshot) || bubble;
        if (!latest) return;
        const text = provider.extractText(latest, U);
        if (!text || U.isPlaceholderText(text)) return;
        if (U.isRetryableProviderError(text)) retryable = true;
        sawRealContent = true;
        if (text !== lastText) { lastText = text; lastChangeAt = Date.now(); }
        if (!firstEmitDone) {
          // Wait for either enough text or a forced emit (reply stable / done).
          if (lastText.length >= MIN_FIRST_CHUNK || force) {
            firstEmitDone = true;
            emitStream(taskId, lastText);
          }
        } else {
          // Already streaming; emit on change.
          if (text !== (resolve._lastEmitted || '')) {
            resolve._lastEmitted = text;
            emitStream(taskId, text);
          }
        }
      };

      const mo = new MutationObserver(() => flush(false));
      mo.observe(bubble, { childList: true, subtree: true, characterData: true });
      const docMo = new MutationObserver(() => flush(false));
      docMo.observe(document.body, { childList: true, subtree: true });
      const tick = setInterval(() => {
        flush(false);
        if (!sawRealContent) return;
        if (verifyOn) return;
        if (Date.now() - lastChangeAt >= stableMs) {
          // Reply looks finished. Force an emit so short replies render.
          flush(true);
          finish();
        }
        if (verifyStartedAt && Date.now() - verifyStartedAt > maxTimeoutMs) { flush(true); finish(true); }
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

  let busy = false;
  function reportState() { safeSend({ type: 'MYBEAM_STATE', connected: provider.pageLooksReady(), busy, provider: provider.name }); }

  async function attemptOnce(task) {
    const snapshot = snapshotAssistants();
    const urlAtStart = location.href;
    let attachFailed = false;
    if (task && task.images && task.images.length) {
      try { const r = await attachImages(task.images); if (!r.ok) { attachFailed = true; LOG('attach failed:', r.reason); } }
      catch (e) { attachFailed = true; LOG('attach threw', String(e)); }
    }
    const el = await typeIntoComposer(task.text || '');
    const sent = await submitComposer(el);
    if (!sent) throw new Error('submit-failed');
    LOG('submitted task', task.id, 'snapshotSize', snapshot.size, 'images', task.images ? task.images.length : 0, 'attachFailed', attachFailed);
    const { reply, retryable, cancelled } = await streamReply(snapshot, task.id, urlAtStart);
    return { reply, retryable, attachFailed, cancelled };
  }

  async function handleTask(task) {
    const taskId = task && task.id;
    if (busy) return { taskId, ok: false, error: 'busy' };
    busy = true;
    reportState();
    try {
      if (task && task.freshContext) {
        try { await tryFreshContextOnce(); } catch (e) { LOG('fresh-context threw', String(e)); }
      }
      let r = await attemptOnce(task);
      if (r.cancelled) return { taskId, ok: false, error: 'cancelled' };
      if (r.retryable) {
        LOG('retryable provider error, retrying once…');
        safeSend({ type: 'MYBEAM_STREAM', taskId, text: '' });
        await U.sleep(900);
        const r2 = await attemptOnce(task);
        if (!r2.retryable) r = r2;
        else r = { reply: r2.reply || r.reply, retryable: true, attachFailed: r2.attachFailed || r.attachFailed };
      }
      const result = { taskId, ok: true, reply: r.reply };
      if (r.attachFailed) result.attachFailed = true;
      return result;
    } catch (err) {
      const msg = String(err && err.message || err);
      if (msg === 'navigated-retry') return { taskId, ok: false, error: 'navigated-retry' };
      return { taskId, ok: false, error: msg };
    } finally {
      busy = false;
      currentCancel = null;
      reportState();
    }
  }

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'MYBEAM_DOM_TASK') {
      handleTask(msg.task).then((result) => {
        safeSend({ type: 'MYBEAM_DOM_RESULT', ...result });
        sendResponse(result);
      });
      return true;
    }
    if (msg.type === 'MYBEAM_CANCEL') {
      currentCancel = { taskId: String(msg.taskId || '') };
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === 'MYBEAM_PING') { sendResponse({ ok: true, ready: provider.pageLooksReady(), busy, provider: provider.name }); return; }
  });

  safeSend({ type: 'MYBEAM_HELLO', provider: provider.name });
  (function waitReady() {
    if (provider.pageLooksReady()) {
      LOG('composer detected @', location.href);
      safeSend({ type: 'MYBEAM_HELLO', provider: provider.name });
      reportState();
      return;
    }
    setTimeout(waitReady, 1000);
  })();

  setInterval(reportState, 5000);
  LOG('core loaded @', location.href);
})();
