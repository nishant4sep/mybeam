// lib/provider.js — active provider + auto-switch fallback.

const fs = require('fs');
const path = require('path');
const config = require('./config');

const PROVIDERS = [
  { id: 'oxalpha',  label: 'Ox Alpha',  hosts: ['oxalpha.com', 'www.oxalpha.com'] },
  { id: 'deepseek', label: 'DeepSeek',  hosts: ['chat.deepseek.com'] }
];

function list() { return PROVIDERS.slice(); }

function getConfigFile() {
  return path.join(config.configDir(), 'config.json');
}

function readCfg() {
  try { return JSON.parse(fs.readFileSync(getConfigFile(), 'utf8')); } catch (_) { return {}; }
}
function writeCfg(c) {
  try { fs.mkdirSync(config.configDir(), { recursive: true }); fs.writeFileSync(getConfigFile(), JSON.stringify(c, null, 2), 'utf8'); } catch (_) {}
}

function getActive() {
  const c = readCfg();
  const id = c.activeProvider || 'oxalpha';
  return PROVIDERS.find((p) => p.id === id) || PROVIDERS[0];
}

function setActive(id) {
  const p = PROVIDERS.find((x) => x.id === id);
  if (!p) throw new Error('unknown-provider: ' + id);
  const c = readCfg();
  c.activeProvider = id;
  c.autoSwitch = c.autoSwitch !== false;
  writeCfg(c);
  return p;
}

function getAutoSwitch() {
  const c = readCfg();
  return c.autoSwitch !== false;
}
function setAutoSwitch(on) {
  const c = readCfg();
  c.autoSwitch = !!on;
  writeCfg(c);
  return c.autoSwitch;
}

// Track consecutive errors per provider to trigger fallback.
const failStreak = {};
function recordSuccess(providerId) { failStreak[providerId] = 0; }
function recordFailure(providerId) {
  failStreak[providerId] = (failStreak[providerId] || 0) + 1;
  return failStreak[providerId];
}
function failCount(providerId) { return failStreak[providerId] || 0; }

function maybeAutoSwitch(currentId) {
  if (!getAutoSwitch()) return null;
  if (failCount(currentId) < 2) return null;
  const next = PROVIDERS.find((p) => p.id !== currentId);
  if (!next) return null;
  setActive(next.id);
  failStreak[currentId] = 0;
  return next;
}

module.exports = {
  list, getActive, setActive,
  getAutoSwitch, setAutoSwitch,
  recordSuccess, recordFailure, failCount, maybeAutoSwitch
};
