// lib/config.js — global MyBeam config in %APPDATA%\MyBeam\config.json (Windows)
// On non-Windows, uses ~/.config/mybeam/config.json. Falls back to ./config.json if needed.
//
// Shape:
//   {
//     workspaces: [{ path, name, lastOpenedAt }],
//     activeWorkspacePath: string | null,
//     version: 1
//   }

const fs = require('fs');
const path = require('path');
const os = require('os');

const APP = 'MyBeam';

function configDir() {
  if (process.env.MYBEAM_CONFIG_DIR) return process.env.MYBEAM_CONFIG_DIR;
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appdata, APP);
  }
  const xdg = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(xdg, 'mybeam');
}

function configPath() { return path.join(configDir(), 'config.json'); }

const DEFAULT = { version: 1, workspaces: [], activeWorkspacePath: null };

let cache = null;

function ensureDir() {
  const dir = configDir();
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  return dir;
}

function load() {
  if (cache) return cache;
  ensureDir();
  try {
    const raw = fs.readFileSync(configPath(), 'utf8');
    const parsed = JSON.parse(raw);
    cache = Object.assign({}, DEFAULT, parsed);
    if (!Array.isArray(cache.workspaces)) cache.workspaces = [];
  } catch (_) {
    cache = JSON.parse(JSON.stringify(DEFAULT));
  }
  return cache;
}

function save() {
  ensureDir();
  try { fs.writeFileSync(configPath(), JSON.stringify(cache, null, 2), 'utf8'); } catch (e) { /* non-fatal */ }
}

function deriveName(p) {
  if (!p) return 'workspace';
  const parts = String(p).split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] || 'workspace';
}

function getConfig() { const c = load(); return JSON.parse(JSON.stringify(c)); }

function listWorkspaces() { return load().workspaces.slice(); }

function rememberWorkspace(absPath) {
  if (!absPath) return null;
  const c = load();
  const name = deriveName(absPath);
  const now = Date.now();
  const idx = c.workspaces.findIndex((w) => w.path === absPath);
  if (idx >= 0) {
    c.workspaces[idx].name = name;
    c.workspaces[idx].lastOpenedAt = now;
  } else {
    c.workspaces.push({ path: absPath, name, lastOpenedAt: now });
  }
  c.activeWorkspacePath = absPath;
  save();
  return { path: absPath, name };
}

function setActiveWorkspace(absPath) {
  if (!absPath) { clearActiveWorkspace(); return null; }
  return rememberWorkspace(absPath);
}

function clearActiveWorkspace() {
  const c = load();
  c.activeWorkspacePath = null;
  save();
  return true;
}

function forgetWorkspace(absPath) {
  const c = load();
  c.workspaces = c.workspaces.filter((w) => w.path !== absPath);
  if (c.activeWorkspacePath === absPath) c.activeWorkspacePath = null;
  save();
  return true;
}

function getActiveWorkspace() {
  const c = load();
  if (!c.activeWorkspacePath) return null;
  const found = c.workspaces.find((w) => w.path === c.activeWorkspacePath);
  if (!found) return null;
  return { path: found.path, name: found.name };
}

module.exports = {
  configDir, configPath,
  getConfig, listWorkspaces,
  rememberWorkspace, setActiveWorkspace, clearActiveWorkspace, forgetWorkspace,
  getActiveWorkspace
};
