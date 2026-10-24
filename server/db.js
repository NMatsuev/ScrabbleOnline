'use strict';
/**
 * Хранилище. Основной вариант — встроенный в Node.js SQLite (node:sqlite, Node ≥ 22.5),
 * без внешних пакетов. Если его нет, автоматически используется JSON-файл
 * с атомарной записью (временный файл + rename).
 *
 * Таблицы:
 *   rooms   — полное состояние каждой комнаты (чтобы партии переживали перезапуск сервера)
 *   results — итоги завершённых игр
 */
const fs = require('fs');
const path = require('path');

class SqliteStore {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const { DatabaseSync } = require('node:sqlite');
    this.kind = 'sqlite';
    this.db = new DatabaseSync(path.join(dir, 'erudit.sqlite'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS rooms (
        code TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        room_code TEXT NOT NULL,
        mode TEXT NOT NULL,
        board_size INTEGER NOT NULL,
        target INTEGER NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER NOT NULL,
        end_reason TEXT NOT NULL,
        winners TEXT NOT NULL,
        ranking TEXT NOT NULL,
        words TEXT NOT NULL
      );
    `);
    this.q = {
      upsert: this.db.prepare('INSERT INTO rooms(code, data, updated_at) VALUES(?, ?, ?) ON CONFLICT(code) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at'),
      del: this.db.prepare('DELETE FROM rooms WHERE code = ?'),
      all: this.db.prepare('SELECT data FROM rooms'),
      insertResult: this.db.prepare('INSERT INTO results(room_code, mode, board_size, target, started_at, finished_at, end_reason, winners, ranking, words) VALUES(?,?,?,?,?,?,?,?,?,?)'),
      recent: this.db.prepare('SELECT id, room_code, mode, board_size, target, started_at, finished_at, end_reason, winners, ranking FROM results ORDER BY id DESC LIMIT ?'),
    };
  }

  saveRoom(room) { this.q.upsert.run(room.code, JSON.stringify(room), room.updatedAt || Date.now()); }
  deleteRoom(code) { this.q.del.run(code); }
  loadRooms() { return this.q.all.all().map((r) => JSON.parse(r.data)); }

  saveResult(r) {
    const info = this.q.insertResult.run(
      r.code, r.mode, r.size, r.target, r.startedAt, r.finishedAt, r.reason,
      JSON.stringify(r.winners), JSON.stringify(r.ranking), JSON.stringify(r.words)
    );
    return Number(info.lastInsertRowid);
  }

  listResults(limit = 10) {
    return this.q.recent.all(limit).map((r) => ({
      id: r.id, code: r.room_code, mode: r.mode, size: r.board_size, target: r.target,
      startedAt: r.started_at, finishedAt: r.finished_at, reason: r.end_reason,
      winners: JSON.parse(r.winners), ranking: JSON.parse(r.ranking),
    }));
  }

  flush() { /* запись синхронная */ }
  close() { try { this.db.close(); } catch { /* уже закрыта */ } }
}

class JsonStore {
  constructor(dir) {
    fs.mkdirSync(dir, { recursive: true });
    this.kind = 'json';
    this.file = path.join(dir, 'erudit.json');
    this.data = { rooms: {}, results: [], nextResultId: 1 };
    try {
      this.data = { ...this.data, ...JSON.parse(fs.readFileSync(this.file, 'utf8')) };
    } catch { /* первый запуск */ }
    this.timer = null;
  }

  _schedule() {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 500);
    this.timer.unref();
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data));
    fs.renameSync(tmp, this.file);
  }

  saveRoom(room) { this.data.rooms[room.code] = JSON.parse(JSON.stringify(room)); this._schedule(); }
  deleteRoom(code) { delete this.data.rooms[code]; this._schedule(); }
  loadRooms() { return Object.values(this.data.rooms); }

  saveResult(r) {
    const id = this.data.nextResultId++;
    this.data.results.push({ id, code: r.code, mode: r.mode, size: r.size, target: r.target, startedAt: r.startedAt, finishedAt: r.finishedAt, reason: r.reason, winners: r.winners, ranking: r.ranking, words: r.words });
    this.flush();
    return id;
  }

  listResults(limit = 10) {
    return this.data.results.slice(-limit).reverse().map(({ words, ...rest }) => rest);
  }

  close() { this.flush(); }
}

/**
 * Supabase (PostgreSQL) через REST API (PostgREST) — без SDK, только встроенный fetch.
 * Нужен там, где у хостинга нет постоянного диска (например, бесплатный Render):
 * состояние игр живёт в облачной БД и переживает перезапуски и «засыпание» сервиса.
 * Таблицы создаются скриптом supabase/schema.sql. Ключ service_role используйте ТОЛЬКО на сервере.
 */
class SupabaseStore {
  constructor(url, key) {
    this.kind = 'supabase';
    this.base = url.replace(/\/+$/, '') + '/rest/v1';
    this.headers = { apikey: key, 'Content-Type': 'application/json' };
    // Старые ключи — JWT и передаются ещё и как Bearer; новые sb_secret_… достаточно передать в apikey.
    if (key.startsWith('eyJ')) this.headers.Authorization = 'Bearer ' + key;
  }

  async _req(method, pathQuery, { body, prefer } = {}) {
    const res = await fetch(this.base + pathQuery, {
      method,
      headers: prefer ? { ...this.headers, Prefer: prefer } : this.headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Supabase ${method} ${pathQuery.split('?')[0]}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return text ? JSON.parse(text) : null;
  }

  /** Проверка при старте: есть ли доступ и созданы ли таблицы. */
  async init() {
    try {
      await this._req('GET', '/rooms?select=code&limit=1');
      await this._req('GET', '/results?select=id&limit=1');
    } catch (e) {
      throw new Error(e.message + '\nПроверьте SUPABASE_URL / SUPABASE_SERVICE_KEY и выполните supabase/schema.sql в SQL Editor.');
    }
  }

  async saveRoom(room) {
    await this._req('POST', '/rooms?on_conflict=code', {
      body: { code: room.code, data: room, updated_at: room.updatedAt || Date.now() },
      prefer: 'resolution=merge-duplicates,return=minimal',
    });
  }

  async deleteRoom(code) {
    await this._req('DELETE', '/rooms?code=eq.' + encodeURIComponent(code), { prefer: 'return=minimal' });
  }

  async loadRooms() {
    const rows = await this._req('GET', '/rooms?select=data');
    return (rows || []).map((r) => r.data);
  }

  async saveResult(r) {
    const rows = await this._req('POST', '/results', {
      body: {
        room_code: r.code, mode: r.mode, board_size: r.size, target: r.target,
        started_at: r.startedAt, finished_at: r.finishedAt, end_reason: r.reason,
        winners: r.winners, ranking: r.ranking, words: r.words,
      },
      prefer: 'return=representation',
    });
    return rows && rows[0] ? rows[0].id : null;
  }

  async listResults(limit = 10) {
    const rows = await this._req('GET', '/results?select=id,room_code,mode,board_size,target,started_at,finished_at,end_reason,winners,ranking&order=id.desc&limit=' + Number(limit));
    return (rows || []).map((r) => ({
      id: r.id, code: r.room_code, mode: r.mode, size: r.board_size, target: r.target,
      startedAt: r.started_at, finishedAt: r.finished_at, reason: r.end_reason,
      winners: r.winners, ranking: r.ranking,
    }));
  }

  async close() { /* соединение не держим */ }
}

function openStore(dir) {
  const { SUPABASE_URL, SUPABASE_SERVICE_KEY } = process.env;
  if (SUPABASE_URL && SUPABASE_SERVICE_KEY) return new SupabaseStore(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  try {
    return new SqliteStore(dir);
  } catch (e) {
    console.warn('[db] Встроенный SQLite недоступен (' + e.message + '; нужен Node.js 22.5+). '
      + 'Это не ошибка: игры и результаты сохраняются в JSON-файле ' + dir + '/erudit.json');
    return new JsonStore(dir);
  }
}

module.exports = { openStore, SqliteStore, JsonStore, SupabaseStore };
