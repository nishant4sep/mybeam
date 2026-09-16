// content-providers/deepseek.js — DOM adapter for chat.deepseek.com.

window.MyBeamProviders = window.MyBeamProviders || {};
window.MyBeamProviders.deepseek = {
  name: 'deepseek',
  label: 'DeepSeek',
  hosts: ['chat.deepseek.com'],

  findComposer() {
    return document.querySelector('textarea[placeholder="Message DeepSeek"]')
        || document.querySelector('textarea[placeholder*="Message" i]')
        || document.querySelector('textarea');
  },
  findSendButton() { return null; }, // Enter-to-send
  findFileInput() { return document.querySelector('input[type="file"]'); },

  // All message wrappers on the page (both user and assistant).
  _allMessages() {
    // Primary selector from the DOM dump.
    const a = Array.from(document.querySelectorAll('div.ds-message'));
    if (a.length) return a;
    // Fallbacks if DeepSeek renames.
    const b = Array.from(document.querySelectorAll('[class*="ds-message"]'));
    return b;
  },

  // A message is "assistant" if it has the assistant markdown container, or
  // — as a looser fallback — if it does NOT have a user-only marker.
  _isAssistant(w) {
    if (w.querySelector('.ds-assistant-message-main-content')) return true;
    if (w.querySelector('.ds-markdown')) return true;
    // Some replies render inside [class*="markdown"] only.
    if (w.querySelector('[class*="markdown" i]')) return true;
    return false;
  },

  findAssistantMessages() {
    return this._allMessages().filter((w) => this._isAssistant(w));
  },

  findAllMessages() { return this._allMessages(); },

  findNewChatButton() {
    return document.querySelector('button[aria-label*="New chat" i]')
        || document.querySelector('button[title*="New chat" i]')
        || document.querySelector('a[href="/"]');
  },

  hasVerification() {
    const composerGone = !this.findComposer();
    const bodyText = (document.body && (document.body.innerText || document.body.textContent) || '').toLowerCase();
    const textHits = [
      'verify you are human','verifying you are human','just a moment',
      'human verification','complete the challenge','turnstile'
    ].some((needle) => bodyText.indexOf(needle) !== -1);
    const widget = !!document.querySelector(
      'iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], ' +
      '[class*="cf-turnstile"], [class*="turnstile"], [id*="turnstile"]'
    );
    return composerGone && (textHits || widget);
  },

  extractText(msgEl, utils) {
    const body = msgEl.querySelector('.ds-assistant-message-main-content')
             || msgEl.querySelector('.ds-markdown')
             || msgEl.querySelector('[class*="markdown" i]')
             || msgEl;
    const parts = [];
    Array.from(body.childNodes).forEach((n) => { parts.push(utils.blockToMd(n, 0)); });
    let md = parts.join('');
    md = md.replace(/\n{3}/g, '\n\n').trim();
    md = utils.stripChrome(md);
    return md;
  },

  countComposerImagePreviews() {
    const ta = this.findComposer();
    if (!ta) return 0;
    let area = ta.parentElement;
    for (let i = 0; i < 3 && area && area.parentElement; i++) area = area.parentElement;
    if (!area) return 0;
    return area.querySelectorAll('img, [style*="background-image"]').length;
  },

  composerHasSpinner() {
    const ta = this.findComposer();
    if (!ta) return false;
    let area = ta.parentElement;
    for (let i = 0; i < 3 && area && area.parentElement; i++) area = area.parentElement;
    if (!area) return false;
    return !!area.querySelector('[class*="spinner"], [class*="loading"], [aria-busy="true"]');
  },

  pageLooksReady() { return !!this.findComposer(); }
};
