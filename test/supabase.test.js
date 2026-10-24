'use strict';
/**
 * Проверка Supabase-хранилища на локальном «мок-сервере», который повторяет нужную часть REST API PostgREST.
 * (С настоящим Supabase из тестов не соединяемся.)
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createServer } = require('../server/index');
const { SupabaseStore } = require('../server/db');

const DICT = path.join(__dirname, '..', 'data', 'dictionary.txt');
const KEY = 'eyJtest-key';

function mockSupabase() {
  const rooms = new Map();
  const results = [];
  const state = { down: false, calls: 0, badAuth: 0 };
  const server = http.createServer((req, res) => {
    state.calls++;
    if (req.headers.apikey !== KEY || req.headers.authorization !== 'Bearer ' + KEY) state.badAuth++;
    if (state.down) { res.writeHead(503); res.end('down'); return; }
    const url = new URL(req.url, 'http://x');
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      const json = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(obj === undefined ? '' : JSON.stringify(obj)); };
      if (url.pathname === '/rest/v1/rooms') {
        if (req.method === 'POST') { rooms.set(body.code, body); return json(201); }
        if (req.method === 'DELETE') { rooms.delete(url.searchParams.get('code').replace('eq.', '')); return json(204); }
        if (req.method === 'GET') {
          const rows = [...rooms.values()];
          return json(200, url.searchParams.get('select') === 'data' ? rows.map((r) => ({ data: r.data })) : rows.slice(0, 1).map((r) => ({ code: r.code })));
        }
      }
      if (url.pathname === '/rest/v1/results') {
        if (req.method === 'POST') { const row = { id: results.length + 1, ...body }; results.push(row); return json(201, [row]); }
        if (req.method === 'GET') return json(200, [...results].reverse().slice(0, Number(url.searchParams.get('limit') || 10)));
      }
      return json(404, { message: 'not found' });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, rooms, results, state, url: `http://127.0.0.1:${server.address().port}` })));
}

class Client {
  constructor(url) { this.url = url; this.state = null; this.you = null; this.joined = null; this.id = 1; this.pending = new Map(); this.waiters = []; }
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
  req(t, p = {}) { return new Promise((resolve, reject) => { const id = this.id++; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ t, id, ...p })); }); }
  until(pred, ms = 3000) {
    return new Promise((resolve, reject) => {
      if (this.state && pred(this.state, this.you)) return resolve();
      const timer = setTimeout(() => reject(new Error('timeout')), ms);
      this.waiters.push((m) => { if (pred(m.game, m.you)) { clearTimeout(timer); resolve(); return true; } return false; });
    });
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('SupabaseStore: запись, чтение, удаление, результаты', async () => {
  const mock = await mockSupabase();
  const store = new SupabaseStore(mock.url + '/', KEY);
  await store.init();
  await store.saveRoom({ code: 'AAAAA', updatedAt: 5, players: [], status: 'lobby' });
  await store.saveRoom({ code: 'AAAAA', updatedAt: 6, players: [], status: 'playing' });
  const rooms = await store.loadRooms();
  assert.equal(rooms.length, 1);
  assert.equal(rooms[0].status, 'playing');
  const id = await store.saveResult({ code: 'AAAAA', mode: 'fast', size: 9, target: 50, startedAt: 1, finishedAt: 2, reason: 'target', winners: ['Аня'], ranking: [{ name: 'Аня', score: 50 }], words: [] });
  assert.equal(id, 1);
  const list = await store.listResults(5);
  assert.equal(list[0].winners[0], 'Аня');
  assert.equal(list[0].size, 9);
  await store.deleteRoom('AAAAA');
  assert.equal((await store.loadRooms()).length, 0);
  assert.equal(mock.state.badAuth, 0, 'ключ передаётся во всех запросах');
  await new Promise((r) => mock.server.close(r));
});

test('Игра с Supabase: состояние переживает перезапуск, результат пишется в таблицу, сбой сети не теряет данные', async () => {
  const mock = await mockSupabase();
  const mk = () => createServer({ dictPath: DICT, dataDir: os.tmpdir(), store: new SupabaseStore(mock.url, KEY) });
  let app = await mk();
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  let url = `ws://127.0.0.1:${app.server.address().port}/ws`;

  const a = await new Client(url).open();
  await a.req('create', { name: 'Аня', mode: 'fast', maxPlayers: 2 });
  const code = a.joined.room; const token = a.joined.token;
  const b = await new Client(url).open();
  await b.req('join', { room: code, name: 'Боря' });
  await a.req('start');
  await sleep(500);
  assert.equal(mock.rooms.get(code).data.status, 'playing', 'комната записана в Supabase');

  // «сеть до Supabase пропала»: изменения не теряются и записываются после восстановления
  mock.state.down = true;
  await a.req('capture', { x1: 4, y1: 1, x2: 4, y2: 4 });
  await sleep(600);
  assert.equal(mock.rooms.get(code).data.players[0].capture, null, 'пока БД недоступна, запись не прошла');
  mock.state.down = false;
  await sleep(2800);
  assert.ok(mock.rooms.get(code).data.players[0].capture, 'после восстановления записано последнее состояние');

  // перезапуск сервера (как «засыпание» Render): всё поднимается из Supabase
  a.ws.close(); b.ws.close();
  await app.close();
  app = await mk();
  assert.equal(app.restored, 1);
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  url = `ws://127.0.0.1:${app.server.address().port}/ws`;
  const a2 = await new Client(url).open();
  await a2.req('join', { room: code, token, name: 'Аня' });
  await a2.until((g, you) => g.status === 'playing' && g.players[0].capture && you.rack.length === 7);

  // выход второго игрока завершает игру → результат в таблице results
  const b2 = await new Client(url).open();
  await b2.req('join', { room: code, token: b.joined.token, name: 'Боря' });
  await b2.req('leave');
  await a2.until((g) => g.status === 'finished');
  await sleep(500);
  assert.equal(mock.results.length, 1);
  assert.deepEqual(mock.results[0].winners, ['Аня']);
  const api = await (await fetch(`http://127.0.0.1:${app.server.address().port}/api/results`)).json();
  assert.equal(api[0].winners[0], 'Аня');

  a2.ws.close(); b2.ws.close();
  await app.close();
  await new Promise((r) => mock.server.close(r));
});

test('Неверная конфигурация Supabase даёт понятную ошибку при старте', async () => {
  const mock = await mockSupabase();
  mock.state.down = true;
  await assert.rejects(createServer({ dictPath: DICT, dataDir: os.tmpdir(), store: new SupabaseStore(mock.url, KEY) }), /schema\.sql/);
  await new Promise((r) => mock.server.close(r));
});
