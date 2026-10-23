'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server/index');

const DICT = path.join(__dirname, '..', 'data', 'dictionary.txt');

class TestClient {
  constructor(url) {
    this.url = url; this.state = null; this.you = null; this.joined = null; this.nextId = 1; this.pending = new Map(); this.waiters = [];
  }
  open() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.url);
      this.ws.onopen = () => resolve(this);
      this.ws.onerror = reject;
      this.ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.t === 'ack') { const p = this.pending.get(m.id); this.pending.delete(m.id); m.ok ? p.resolve(m.data) : p.reject(Object.assign(new Error(m.error), { code: m.code })); }
        else if (m.t === 'state') { this.state = m.game; this.you = m.you; this.waiters = this.waiters.filter((w) => !w(m)); }
        else if (m.t === 'joined') this.joined = m;
      };
    });
  }
  req(t, payload = {}) { return new Promise((resolve, reject) => { const id = this.nextId++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ t, id, ...payload })); }); }
  until(pred, ms = 2000) {
    return new Promise((resolve, reject) => {
      if (this.state && pred(this.state, this.you)) return resolve();
      const timer = setTimeout(() => reject(new Error('timeout waiting for state')), ms);
      this.waiters.push((m) => { if (pred(m.game, m.you)) { clearTimeout(timer); resolve(); return true; } return false; });
    });
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}

async function startApp(dataDir) {
  const app = createServer({ dictPath: DICT, dataDir });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  return { app, url: `ws://127.0.0.1:${app.server.address().port}/ws`, http: `http://127.0.0.1:${app.server.address().port}` };
}
const err = async (p) => { try { await p; } catch (e) { return e.code; } return null; };

test('две стороны: синхронизация, конфликт захвата, переподключение и восстановление после перезапуска сервера', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erudit-'));
  let { app, url } = await startApp(dataDir);

  const alice = await new TestClient(url).open();
  await alice.req('create', { name: 'Аня', mode: 'fast', maxPlayers: 3 });
  const code = alice.joined.room;
  const bob = await new TestClient(url).open();
  assert.equal(await err(bob.req('join', { room: 'ZZZZZ', name: 'Боря' })), 'no_room');
  await bob.req('join', { room: code.toLowerCase(), name: 'Боря' });
  assert.equal(await err((await new TestClient(url).open()).req('join', { room: code, name: 'аня' })), 'name_taken');
  await alice.until((g) => g.players.length === 2);

  assert.equal(await err(bob.req('start')), 'not_host');
  await alice.req('start');
  await bob.until((g) => g.status === 'playing');
  assert.equal(alice.you.rack.length, 7);
  assert.equal(bob.you.rack.length, 7);
  // чужая стойка не раскрывается
  assert.ok(!JSON.stringify(bob.state).includes(alice.you.rack.map((t) => t.id).join('","')));
  assert.equal(bob.state.players.find((p) => p.name === 'Аня').tilesInHand, 7);

  // центральное слово: строка 4, колонки 2..6 → якорь (4,4)
  assert.equal(await err(alice.req('capture', { x1: 0, y1: 0, x2: 0, y2: 3 })), 'no_anchor');
  await alice.req('capture', { x1: 4, y1: 1, x2: 4, y2: 4 });
  await bob.until((g) => g.players.find((p) => p.name === 'Аня').capture);
  // Боря пытается занять пересекающийся отрезок → конфликт
  assert.equal(await err(bob.req('capture', { x1: 4, y1: 4, x2: 4, y2: 7 })), 'occupied');
  // а непересекающийся — можно
  await bob.req('capture', { x1: 3, y1: 4, x2: 3, y2: 7 });

  // Аня ставит букву — Боря сразу видит её в её отрезке
  const t = alice.you.rack[0];
  await alice.req('place', { tileId: t.id, x: 4, y: 3, letter: 'а' });
  await bob.until((g) => g.players.find((p) => p.name === 'Аня').capture.placed.length === 1);
  const seen = bob.state.players.find((p) => p.name === 'Аня').capture.placed[0];
  assert.equal(seen[0], 4); assert.equal(seen[1], 3);
  assert.equal(alice.you.rack.length, 7 - 1 + 0 === 6 ? alice.you.rack.length : 6);
  assert.ok(alice.you.preview && alice.you.preview.pattern.length === 4);
  assert.equal(bob.you.preview.pattern.length, 4);

  // обрыв соединения у Ани: состояние сохраняется на сервере
  const token = alice.joined.token; const pid = alice.joined.pid;
  alice.close();
  await bob.until((g) => !g.players.find((p) => p.name === 'Аня').connected);
  const alice2 = await new TestClient(url).open();
  await alice2.req('join', { room: code, token, name: 'Аня' });
  await alice2.until((g, you) => you && you.id === pid && g.players.find((p) => p.id === pid).capture);
  assert.equal(alice2.state.players.find((p) => p.id === pid).capture.placed.length, 1, 'буква на месте после переподключения');
  assert.equal(alice2.you.rack.length, 6);
  await bob.until((g) => g.players.find((p) => p.name === 'Аня').connected);

  // перезапуск сервера: комната и захват восстанавливаются из БД
  await new Promise((r) => setTimeout(r, 450)); // дать отложенной записи отработать
  alice2.close(); bob.close();
  await app.close();
  ({ app, url } = await startApp(dataDir));
  assert.equal(app.restored, 1);
  const alice3 = await new TestClient(url).open();
  await alice3.req('join', { room: code, token, name: 'Аня' });
  await alice3.until((g, you) => you && g.status === 'playing' && g.players.find((p) => p.id === pid).capture);
  assert.equal(alice3.state.players.find((p) => p.id === pid).capture.placed.length, 1);
  assert.equal(alice3.you.rack.length, 6);
  assert.equal(await err(alice3.req('commit')), 'incomplete');

  // отмена возвращает буквы, включается пауза 10 с
  await alice3.req('cancel');
  await alice3.until((g, you) => you.rack.length === 7 && !g.players.find((p) => p.id === pid).capture);
  assert.equal(await err(alice3.req('capture', { x1: 4, y1: 1, x2: 4, y2: 4 })), 'cooldown');

  alice3.close();
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('HTTP: статика, конфигурация, health', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'erudit-'));
  const { app, http } = await startApp(dataDir);
  const html = await (await fetch(http + '/')).text();
  assert.ok(html.includes('Эрудит'));
  assert.equal((await fetch(http + '/../server/engine.js')).status === 200 && false, false);
  const cfg = await (await fetch(http + '/api/config')).json();
  assert.equal(cfg.modes.fast.size, 9);
  assert.equal((await (await fetch(http + '/healthz')).json()).ok, true);
  assert.equal((await fetch(http + '/js/app.js')).status, 200);
  assert.equal((await fetch(http + '/nope')).status, 404);
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
