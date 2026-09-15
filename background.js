// background.js — MV3 service worker (with verification relay).

const OFFSCREEN_PATH = 'offscreen.html';
const OXALPHA_URL = 'https://oxalpha.com/';
const TAB_ALARM = 'mybeam-ensure-tab';
const SWEEP_ALARM = 'mybeam-sweep';
const KEEPWARM_ALARM = 'mybeam-keepwarm';
const RELAY_MAX_ATTEMPTS = 60;
const RELAY_RETRY_MS = 750;

const liveContentTabs = new Set();
let managedTabId = null;
let managedWindowId = null;

function log(...a) { console.log('[MyBeam:bg]', ...a); }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function isOxalphaUrl(url) {
  if (!url) return false;
  try { return /(^|\.)oxalpha\.com$/.test(new URL(url).hostname); } catch { return false; }
}

async function hasOffscreen() {
  if (!chrome.offscreen || !chrome.runtime.getContexts) return false;
  const cs = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)]
  });
  return cs.length > 0;
}
let creatingOffscreen = null;
async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (creatingOffscreen) { await creatingOffscreen; return; }
  creatingOffscreen = chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH, reasons: ['BLOBS'],
    justification: 'Persistent polling + streaming relay to local MyBeam Workstation.'
  }).catch((e) => {
    if (!String(e && e.message || e).includes('Only a single offscreen')) throw e;
  }).finally(() => { creatingOffscreen = null; });
  await creatingOffscreen;
}

async function waitForTabComplete(tabId, timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const t = await chrome.tabs.get(tabId);
      if (t.status === 'complete' && isOxalphaUrl(t.url)) return t;
    } catch { return null; }
    await sleep(500);
  }
  return null;
}

async function findAnyOxalphaTab() {
  const tabs = await chrome.tabs.query({ url: ['https://oxalpha.com/*', 'https://*.oxalpha.com/*'] });
  return tabs[0] || null;
}

async function ensureOxalphaTab() {
  if (managedTabId != null) {
    try {
      const t = await chrome.tabs.get(managedTabId);
      if (t && isOxalphaUrl(t.url)) return managedTabId;
    } catch { managedTabId = null; managedWindowId = null; }
  }
  const existing = await findAnyOxalphaTab();
  if (existing) {
    managedTabId = existing.id;
    managedWindowId = existing.windowId;
    log('adopting existing oxalpha tab', existing.id);
    try { await chrome.scripting.executeScript({ target: { tabId: existing.id }, files: ['content.js'] }); } catch (_) {}
    return managedTabId;
  }
  log('creating managed oxalpha window');
  const win = await chrome.windows.create({ url: 'about:blank', focused: false, state: 'minimized', type: 'normal' });
  managedWindowId = win.id;
  const tab = win.tabs && win.tabs[0];
  if (!tab) return null;
  managedTabId = tab.id;
  try { await chrome.tabs.update(managedTabId, { url: OXALPHA_URL }); } catch (_) {}
  await waitForTabComplete(managedTabId);
  try { await chrome.scripting.executeScript({ target: { tabId: managedTabId }, files: ['content.js'] }); } catch (_) {}
  return managedTabId;
}

async function keepWarm() {
  if (managedTabId == null) return;
  try { await chrome.tabs.sendMessage(managedTabId, { type: 'MYBEAM_PING' }, () => void chrome.runtime.lastError); } catch (_) {}
}

async function boot() {
  try { await ensureOffscreen(); await ensureOxalphaTab(); }
  catch (e) { log('boot failed', String(e && e.message || e)); }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create(TAB_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.create(KEEPWARM_ALARM, { periodInMinutes: 1 / 3 });
  boot();
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create(TAB_ALARM, { periodInMinutes: 1 });
  chrome.alarms.create(SWEEP_ALARM, { periodInMinutes: 0.5 });
  chrome.alarms.create(KEEPWARM_ALARM, { periodInMinutes: 1 / 3 });
  boot();
});
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === TAB_ALARM) ensureOxalphaTab();
  else if (a.name === SWEEP_ALARM) ensureOffscreen();
  else if (a.name === KEEPWARM_ALARM) keepWarm();
});

boot();

async function pickContentTab() {
  if (managedTabId != null) {
    try {
      const t = await chrome.tabs.get(managedTabId);
      if (t && isOxalphaUrl(t.url)) return t;
    } catch { managedTabId = null; }
  }
  return findAnyOxalphaTab();
}

async function relayDomTask(task) {
  for (let attempt = 1; attempt <= RELAY_MAX_ATTEMPTS; attempt++) {
    const tab = await pickContentTab();
    if (!tab) { await ensureOxalphaTab().catch(() => {}); await sleep(RELAY_RETRY_MS); continue; }
    if (!isOxalphaUrl(tab.url)) { await sleep(RELAY_RETRY_MS); continue; }
    const resp = await new Promise((resolve) => {
      chrome.tabs.sendMessage(tab.id, { type: 'MYBEAM_DOM_TASK', task }, (r) => {
        if (chrome.runtime.lastError) resolve({ __err: chrome.runtime.lastError.message });
        else resolve(r);
      });
    });
    if (resp && !resp.__err) { log(`relayed task ${task && task.id} on attempt ${attempt}`); return resp; }
    if (attempt === 1 || attempt % 5 === 0) log(`attempt ${attempt}: ${resp && resp.__err || 'no-response'}`);
    await sleep(RELAY_RETRY_MS);
  }
  return { taskId: task && task.id, ok: false, error: 'no-content-script' };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === 'MYBEAM_HELLO') {
    if (sender && sender.tab && sender.tab.id != null) { liveContentTabs.add(sender.tab.id); log('hello from tab', sender.tab.id); }
    return;
  }
  if (msg.type === 'MYBEAM_STATE') { chrome.runtime.sendMessage(msg).catch(() => {}); return; }
  if (msg.type === 'MYBEAM_STREAM') { chrome.runtime.sendMessage(msg).catch(() => {}); return; }
  if (msg.type === 'MYBEAM_VERIFY') { chrome.runtime.sendMessage(msg).catch(() => {}); return; }
  if (msg.type === 'MYBEAM_DOM_TASK') { relayDomTask(msg.task).then(sendResponse); return true; }
  if (msg.type === 'MYBEAM_DOM_RESULT') { chrome.runtime.sendMessage(msg).catch(() => {}); return; }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  liveContentTabs.delete(tabId);
  if (tabId === managedTabId) { managedTabId = null; managedWindowId = null; }
});
chrome.windows.onRemoved.addListener((winId) => {
  if (winId === managedWindowId) { managedWindowId = null; managedTabId = null; }
});
