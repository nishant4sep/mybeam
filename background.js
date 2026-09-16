// background.js — MV3 service worker.
// Adds: retry on 'navigated-retry' by re-relaying to the same tab after the
// SPA finished its navigation.

const OFFSCREEN_PATH = 'offscreen.html';
const TAB_ALARM = 'mybeam-ensure-tab';
const SWEEP_ALARM = 'mybeam-sweep';
const KEEPWARM_ALARM = 'mybeam-keepwarm';
const RELAY_MAX_ATTEMPTS = 20;
const RELAY_RETRY_MS = 750;

const CONTENT_SCRIPTS = [
  'content-core/utils.js',
  'content-providers/oxalpha.js',
  'content-providers/deepseek.js',
  'content-core/core.js'
];

const PROVIDERS = {
  oxalpha: { matches: ['https://oxalpha.com/*', 'https://*.oxalpha.com/*'], home: 'https://oxalpha.com/', test: (host) => /(^|\.)oxalpha\.com$/.test(host) },
  deepseek: { matches: ['https://chat.deepseek.com/*', 'https://deepseek.com/*', 'https://*.deepseek.com/*'], home: 'https://chat.deepseek.com/', test: (host) => /(^|\.)deepseek\.com$/.test(host) }
};

const managedTabs = new Map();
const liveContentTabs = new Set();

function log(...a) { console.log('[MyBeam:bg]', ...a); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function hostOf(url) { try { return new URL(url).hostname; } catch { return ''; } }
function isProviderUrl(providerId, url) { const p = PROVIDERS[providerId]; if (!p) return false; return p.test(hostOf(url)); }

async function hasOffscreen() {
  if (!chrome.offscreen || !chrome.runtime.getContexts) return false;
  const cs = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)] });
  return cs.length > 0;
}
let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH, reasons: ['BLOBS'],
    justification: 'Persistent polling + streaming relay to local MyBeam Workstation.'
  }).catch((e) => { if (!String(e && e.message || e).includes('Only a single offscreen')) throw e; }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const t = await chrome.tabs.get(tabId); if (t.status === 'complete') return t; } catch { return null; }
    await sleep(500);
  }
  return null;
}

async function findProviderTabs(providerId) {
  const p = PROVIDERS[providerId]; if (!p) return [];
  return chrome.tabs.query({ url: p.matches });
}

async function ensureProviderTab(providerId) {
  const p = PROVIDERS[providerId]; if (!p) return null;
  const managed = managedTabs.get(providerId);
  if (managed && managed.tabId != null) {
    try { const t = await chrome.tabs.get(managed.tabId); if (t && isProviderUrl(providerId, t.url)) return t.id; } catch { managedTabs.delete(providerId); }
  }
  const existing = await findProviderTabs(providerId);
  if (existing && existing.length) {
    const t = existing[0];
    managedTabs.set(providerId, { tabId: t.id, windowId: t.windowId });
    log('adopting', providerId, 'tab', t.id, 'url', t.url);
    return t.id;
  }
  log('creating managed', providerId, 'window');
  const win = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'minimized', type: 'normal' });
  const tab = win.tabs && win.tabs[0];
  if (!tab) return null;
  managedTabs.set(providerId, { tabId: tab.id, windowId: win.id });
  try { await chrome.tabs.update(tab.id, { url: p.home }); } catch (_) {}
  await waitForTabComplete(tab.id);
  return tab.id;
}

async function keepWarmAll() {
  for (const [, managed] of managedTabs) {
    if (managed.tabId == null) continue;
    try { await chrome.tabs.sendMessage(managed.tabId, { type: 'MYBEAM_PING' }, () => void chrome.runtime.lastError); } catch (_) {}
  }
}

async function boot() { try { await ensureOffscreen(); } catch (e) { log('boot failed', String(e && e.message || e)); } }
chrome.runtime.onInstalled.addListener(() => { chrome.alarms.create(TAB_ALARM, { periodInMinutes: 1 }); chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 0.5 }); chrome.alarms.create(KEEPWARM_ALARM, { periodInMinutes: 1 / 3 }); boot(); });
chrome.runtime.onStartup.addListener(() => { chrome.alarms.create(TAB_ALARM, { periodInMinutes: 1 }); chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 0.5 }); chrome.alarms.create(KEEPWARM_ALARM, { periodInMinutes: 1 / 3 }); boot(); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === SWEEP_ALARM) ensureOffscreen(); else if (a.name === KEEPWARM_ALARM) keepWarmAll(); });
boot();

async function pickContentTab(providerId) {
  const managed = managedTabs.get(providerId);
  if (managed && managed.tabId != null) {
    try { const t = await chrome.tabs.get(managed.tabId); if (t && isProviderUrl(providerId, t.url)) return t; } catch { managedTabs.delete(providerId); }
  }
  const list = await findProviderTabs(providerId);
  return list[0] || null;
}

async function tryInjectContentScripts(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId: tabId, allFrames: false }, files: CONTENT_SCRIPTS });
    log('injected content scripts into tab', tabId);
    return true;
  } catch (e) { log('injection failed for tab', tabId, ':', String(e && e.message || e)); return false; }
}

async function reloadAndWait(tabId, timeoutMs = 20000) {
  try { await chrome.tabs.reload(tabId); } catch (e) { log('reload failed', tabId, String(e && e.message || e)); return false; }
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { const t = await chrome.tabs.get(tabId); if (t && t.status === 'complete') return true; } catch { return false; }
    await sleep(400);
  }
  return false;
}

async function relayDomTask(task) {
  const providerId = (task && task.provider) || 'oxalpha';
  let injectionTried = false;
  let reloadTried = false;
  let navigatedRetries = 0;

  for (let attempt = 1; attempt <= RELAY_MAX_ATTEMPTS; attempt++) {
    let tab = await pickContentTab(providerId);
    if (!tab) {
      const tabId = await ensureProviderTab(providerId).catch(() => null);
      if (tabId) { try { tab = await chrome.tabs.get(tabId); } catch { tab = null; } }
      if (!tab) { await sleep(RELAY_RETRY_MS); continue; }
    }
    if (!isProviderUrl(providerId, tab.url)) { await sleep(RELAY_RETRY_MS); continue; }

    const resp = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'MYBEAM_DOM_TASK', task }, (r) => {
        if (chrome.runtime.lastError) resolve({ __err: chrome.runtime.lastError.message });
        else resolve(r);
      });
    });

    if (resp && !resp.__err) {
      // Content script returned a result. Check for special retry signals.
      if (resp.ok === false && resp.error === 'navigated-retry' && navigatedRetries < 2) {
        navigatedRetries++;
        log('content script was orphaned by SPA navigation; retrying on new page (attempt', navigatedRetries, ')');
        // The tab is now on the conversation URL. Wait for it to settle, then
        // re-relay the same task to the fresh content script.
        await sleep(2500);
        continue;
      }
      log(`relayed task ${task && task.id} to ${providerId} tab ${tab.id} (${tab.url}) on attempt ${attempt}`);
      return resp;
    }

    if (!injectionTried && (resp && resp.__err || '').includes('Receiving end does not exist')) {
      injectionTried = true;
      log('no receiving end; injecting content scripts into tab', tab.id);
      const injected = await tryInjectContentScripts(tab.id);
      if (injected) { await sleep(500); continue; }
    }

    if (injectionTried && !reloadTried && (resp && resp.__err || '').includes('Receiving end does not exist')) {
      reloadTried = true;
      log('injection did not help; reloading tab', tab.id);
      const ok = await reloadAndWait(tab.id);
      if (ok) { await sleep(1500); continue; }
    }

    if (attempt === 1 || attempt % 5 === 0) {
      log(`attempt ${attempt} (${providerId}) tab ${tab.id} url ${tab.url}: ${resp && resp.__err || 'no-response'}`);
    }
    await sleep(RELAY_RETRY_MS);
  }
  return { taskId: task && task.id, ok: false, error: 'no-content-script' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'MYBEAM_HELLO') {
    if (sender && sender.tab && sender.tab.id != null) {
      liveContentTabs.add(sender.tab.id);
      log('hello from tab', sender.tab.id, 'provider', msg.provider || '?', 'url', sender.tab.url || '?');
    }
    return;
  }
  if (msg.type === 'MYBEAM_STATE') { chrome.runtime.sendMessage(msg).catch(() => {}); return; }
  if (msg.type === 'MYBEAM_STREAM') { chrome.runtime.sendMessage(msg).catch(() => {}); return; }
  if (msg.type === 'MYBEAM_VERIFY') { chrome.runtime.sendMessage(msg).catch(() => {}); return; }
  if (msg.type === 'MYBEAM_DOM_TASK') { relayDomTask(msg.task).then(sendResponse); return true; }
  if (msg.type === 'MYBEAM_DOM_RESULT') { chrome.runtime.sendMessage(msg).catch(() => {}); return; }
  if (msg.type === 'MYBEAM_CANCEL_TASK') {
    const taskId = String(msg.taskId || '');
    for (const [, managed] of managedTabs) {
      if (managed.tabId == null) continue;
      chrome.tabs.sendMessage(managed.tabId, { type: 'MYBEAM_CANCEL', taskId }, () => void chrome.runtime.lastError);
    }
    sendResponse({ ok: true });
    return;
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  liveContentTabs.delete(tabId);
  for (const [providerId, managed] of managedTabs) { if (managed.tabId === tabId) managedTabs.delete(providerId); }
});
chrome.windows.onRemoved.addListener((winId) => {
  for (const [providerId, managed] of managedTabs) { if (managed.windowId === winId) managedTabs.delete(providerId); }
});
