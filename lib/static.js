// lib/static.js — tiny static file server for the ui/ folder.
// No dependencies. Caches content per-path with mtime checks in dev.

const fs = require('fs');
const path = require('path');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2'
};

const cache = new Map();

function sendFile(res, rootDir, relPath, { noCache = false } = {}) {
  // Normalize and prevent escaping the root.
  const safe = relPath.replace(/\\/g, '/').replace(/^\.\.\//g, '').replace(/\/\.\.\//g, '/');
  const abs = path.resolve(rootDir, safe);
  const rootAbs = path.resolve(rootDir);
  if (!abs.startsWith(rootAbs)) {
    res.writeHead(403, { 'content-type': 'text/plain' });
    return res.end('forbidden');
  }

  let stat;
  try {
    stat = fs.statSync(abs);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }
  if (!stat.isFile()) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end('not found');
  }

  const ext = path.extname(abs).toLowerCase();
  const type = MIME[ext] || 'application/octet-stream';

  const cached = cache.get(abs);
  const fresh = cached && cached.mtime === stat.mtimeMs;

  const headers = {
    'content-type': type,
    'cache-control': noCache ? 'no-store' : 'public, max-age=60',
    'content-length': stat.size
  };

  if (fresh) {
    res.writeHead(200, headers);
    return res.end(cached.body);
  }

  fs.readFile(abs, (err, body) => {
    if (err) {
      res.writeHead(500, { 'content-type': 'text/plain' });
      return res.end('read error');
    }
    cache.set(abs, { mtime: stat.mtimeMs, body });
    res.writeHead(200, headers);
    res.end(body);
  });
}

module.exports = { sendFile, MIME };
