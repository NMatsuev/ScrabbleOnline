'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const C = require('./config');
const { Dictionary } = require('./dictionary');
const { Engine } = require('./engine');
const { Hub } = require('./hub');
const { openStore } = require('./db');
const { acceptUpgrade } = require('./ws');

const ROOT = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT, 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, 'storage');
const DICT_PATH = process.env.DICT_PATH || path.join(ROOT, 'data', 'dictionary.txt');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

async function createServer({ dictPath = DICT_PATH, dataDir = DATA_DIR, store: injected } = {}) {
  const dict = Dictionary.fromFile(dictPath);
  const store = injected || openStore(dataDir);
  if (store.init) await store.init();
  const engine = new Engine(dict);
  const hub = new Hub({ engine, store });
  const restored = await hub.restore();

  const gzCache = new Map();
  const clients = new Set();

  function sendJson(res, status, body) {
    const data = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': MIME['.json'], 'Cache-Control': 'no-store' });
    res.end(data);
  }

  function serveStatic(req, res, urlPath) {
    let rel = decodeURIComponent(urlPath);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('Не найдено'); return; }
      const ext = path.extname(file).toLowerCase();
      const type = MIME[ext] || 'application/octet-stream';
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff' };
      const compressible = /^(text|application\/json|image\/svg)/.test(type);
      const wantsGzip = /\bgzip\b/.test(String(req.headers['accept-encoding'] || ''));
      fs.readFile(file, (e2, buf) => {
        if (e2) { res.writeHead(500); res.end('Ошибка чтения'); return; }
        if (compressible && wantsGzip) {
          const k = file + ':' + st.mtimeMs;
          let gz = gzCache.get(k);
          if (!gz) { gz = zlib.gzipSync(buf); gzCache.set(k, gz); }
          res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
          res.end(gz);
        } else {
          res.writeHead(200, headers);
          res.end(buf);
        }
      });
    });
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://localhost');
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return; }
    if (url.pathname === '/healthz') return sendJson(res, 200, { ok: true, rooms: hub.rooms.size, words: dict.size });
    if (url.pathname === '/api/config') {
      const targets = {};
      for (const id of Object.keys(C.MODES)) {
        targets[id] = {};
        for (let n = C.RULES.minPlayers; n <= C.RULES.maxPlayers; n++) targets[id][n] = C.targetFor(id, n);
      }
      return sendJson(res, 200, {
        modes: C.MODES, targets, rules: C.RULES, alphabet: C.ALPHABET,
        tiles: C.TILE_SET, blanks: C.BLANKS,
      });
    }
    if (url.pathname === '/api/results') {
      const limit = Math.min(30, Math.max(1, Number(url.searchParams.get('limit')) || 8));
      Promise.resolve(store.listResults(limit))
        .then((rows) => sendJson(res, 200, rows))
        .catch((e) => { console.error('[db] /api/results:', e.message); sendJson(res, 200, []); });
      return undefined;
    }
    return serveStatic(req, res, url.pathname);
  });

  server.on('upgrade', (req, socket) => {
    const url = new URL(req.url, 'http://localhost');
    if (url.pathname !== '/ws') { socket.destroy(); return; }
    const ws = acceptUpgrade(req, socket);
    if (!ws) return;
    const client = hub.addClient(ws);
    clients.add(client);
    ws.on('close', () => clients.delete(client));
  });

  const hbTimer = setInterval(() => hub.heartbeat(clients), 20_000);
  const hkTimer = setInterval(() => hub.housekeeping(), 60_000);
  hbTimer.unref(); hkTimer.unref();

  async function close() {
    clearInterval(hbTimer); clearInterval(hkTimer);
    for (const c of clients) c.ws.terminate();
    await hub.shutdown();
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, hub, store, dict, close, restored };
}

if (require.main === module) {
  createServer().then((app) => {
    app.server.listen(PORT, HOST, () => {
      console.log(`Эрудит запущен: http://localhost:${PORT}`);
      const where = app.store.kind === 'supabase' ? 'Supabase' : `${app.store.kind} (${DATA_DIR})`;
      console.log(`Словарь: ${app.dict.size} слов, хранилище: ${where}, восстановлено комнат: ${app.restored}`);
      if (app.dict.size < 20000) {
        console.log('Внимание: словарь небольшой (' + app.dict.size + ' слов). Положите полный словарь в data/dictionary.txt (UTF-8, одно слово в строке).');
      }
    });
    const stop = () => { app.close().then(() => process.exit(0), () => process.exit(1)); setTimeout(() => process.exit(0), 10_000).unref(); };
    process.on('SIGTERM', stop);
    process.on('SIGINT', stop);
  }).catch((e) => { console.error('Не удалось запустить сервер:', e.message); process.exit(1); });
}

module.exports = { createServer };
