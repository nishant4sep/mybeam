// content-providers/oxalpha.js — DOM adapter for oxalpha.com.

window.MyBeamProviders = window.MyBeamProviders || {};
window.MyBeamProviders.oxalpha = {
  name: 'oxalpha',
  label: 'Ox Alpha',
  hosts: ['oxalpha.com', 'www.oxalpha.com'],

  findComposer() {
    return document.querySelector('textarea[placeholder="Send a message..."]')
        || document.querySelector('textarea');
  },
  findSendButton() {
    return document.querySelector('button.send-btn')
        || document.querySelector('button[title="Send"]');
  },
  findFileInput() {
    return document.querySelector('label.ox-attach input[type="file"]')
        || document.querySelector('input[type="file"]');
  },
  findAssistantMessages() {
    return Array.from(document.querySelectorAll('.msg.msg-assistant'));
  },
  findAllMessages() {
    return Array.from(document.querySelectorAll('.msg'));
  },
  findNewChatButton() {
    return document.querySelector('button.new-chat-btn')
        || document.querySelector('button[title*="New Chat" i]')
        || document.querySelector('button[aria-label*="New Chat" i]');
  },

  hasVerification() {
    const composerGone = !this.findComposer();
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
  },

  extractText(msgEl, utils) {
    const content = msgEl.querySelector('.msg-content .prose') || msgEl.querySelector('.msg-content') || msgEl;
    const parts = [];
    Array.from(content.childNodes).forEach((n) => { parts.push(utils.blockToMd(n, 0)); });
    let md = parts.join('');
    md = md.replace(/\n{3}/g, '\n\n').trim();
    md = utils.stripChrome(md);
    return md;
  },

  countComposerImagePreviews() {
    const area = document.querySelector('.input-area, .input-col') || document.body;
    if (!area) return 0;
    return area.querySelectorAll('img, [style*="background-image"]').length;
  },

  composerHasSpinner() {
    const area = document.querySelector('.input-area, .input-col');
    if (!area) return false;
    if (area.querySelector('[class*="spinner"], [class*="loading"], [class*="progress"], [aria-busy="true"]')) return true;
    return area.querySelectorAll('svg [class*="spin"], svg[class*="spin"]').length > 0;
  },

  pageLooksReady() { return !!this.findComposer(); }
};
