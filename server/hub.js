'use strict';
/**
 * Hub связывает сеть, движок и хранилище:
 *  - принимает команды клиентов и применяет их к комнатам;
 *  - рассылает каждому игроку актуальное состояние сразу после любого изменения;
 *  - держит таймеры (истечение захватов и общего времени);
 *  - сохраняет комнаты в БД и восстанавливает их после перезапуска.
 */
const { GameError } = require('./engine');
const C = require('./config');

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_MSGS_PER_SEC = 60;

class Client {
  constructor(ws) {
    this.ws = ws;
    this.room = null;
    this.pid = null;
    this.alive = true;
    this.windowStart = Date.now();
    this.count = 0;
  }
  send(obj) { this.ws.send(JSON.stringify(obj)); }
}

class Hub {
  constructor({ engine, store, log = console }) {
    this.engine = engine;
    this.store = store;
    this.log = log;
    this.rooms = new Map();      // code → room
    this.live = new Map();       // code → Set<Client>
    this.timers = new Map();     // code → Timeout
    this.dirty = new Set();      // комнаты, ожидающие рассылки
    this.saveQueue = new Set();  // комнаты, ожидающие записи в БД
    this.saveTimer = null;
    this.deleteQueue = new Set(); // комнаты, которые нужно удалить из БД
    this.drainP = null;           // идущая сейчас запись в БД
  }

  /* ───────────────────────── запуск / остановка ───────────────────────── */

  /** Загружает комнаты из БД (хранилище может быть синхронным или сетевым, как Supabase). */
  async restore() {
    const now = Date.now();
    let count = 0;
    for (const room of await this.store.loadRooms()) {
      for (const p of room.players) p.lastSeenAt = now;
      this.rooms.set(room.code, room);
      this.engine.settle(room, now);  // догоняем время, пока сервер был выключен
      this.schedule(room);
      if (room.status === 'finished') this.onFinished(room);
      count++;
    }
    return count;
  }

  /** Мягкая остановка: дописываем в БД всё, что ещё не записано (но не дольше 6 секунд). */
  async shutdown() {
    for (const t of this.timers.values()) clearTimeout(t);
    if (this.saveTimer) clearTimeout(this.saveTimer);
    for (const room of this.rooms.values()) this.saveQueue.add(room.code);
    await Promise.race([this.drainSaves(), new Promise((r) => setTimeout(r, 6000))]);
    await this.store.close();
  }

  /* ───────────────────────── соединения ───────────────────────── */

  addClient(ws) {
    const client = new Client(ws);
    ws.on('message', (raw) => this.onMessage(client, raw));
    ws.on('pong', () => { client.alive = true; });
    ws.on('close', () => this.detach(client));
    return client;
  }

  isConnected(code, pid) {
    const set = this.live.get(code);
    if (!set) return false;
    for (const c of set) if (c.pid === pid) return true;
    return false;
  }

  attach(client, room, player) {
    this.detach(client);
    client.room = room;
    client.pid = player.id;
    if (!this.live.has(room.code)) this.live.set(room.code, new Set());
    this.live.get(room.code).add(client);
    player.lastSeenAt = Date.now();
    this.markDirty(room);
  }

  detach(client) {
    const room = client.room;
    if (!room) return;
    const set = this.live.get(room.code);
    if (set) { set.delete(client); if (!set.size) this.live.delete(room.code); }
    const p = room.players.find((x) => x.id === client.pid);
    if (p) p.lastSeenAt = Date.now();
    client.room = null;
    client.pid = null;
    if (this.rooms.has(room.code)) this.markDirty(room);
  }

  /** Вся рассылка за один «тик» цикла событий склеивается в один пакет состояния. */
  markDirty(room) {
    if (this.dirty.has(room.code)) return;
    this.dirty.add(room.code);
    setImmediate(() => {
      this.dirty.delete(room.code);
      this.flush(room);
    });
  }

  flush(room) {
    const set = this.live.get(room.code);
    if (!set || !set.size) return;
    const now = Date.now();
    const common = this.engine.commonView(room, now, (pid) => this.isConnected(room.code, pid));
    for (const c of set) {
      c.send({ t: 'state', now, game: common, you: this.engine.youView(room, c.pid) });
    }
  }

  sendState(client) {
    const room = client.room;
    if (!room) return;
    const now = Date.now();
    client.send({
      t: 'state', now,
      game: this.engine.commonView(room, now, (pid) => this.isConnected(room.code, pid)),
      you: this.engine.youView(room, client.pid),
    });
  }

  /* ───────────────────────── обработка сообщений ───────────────────────── */

  onMessage(client, raw) {
    client.alive = true;
    const nowMs = Date.now();
    if (nowMs - client.windowStart > 1000) { client.windowStart = nowMs; client.count = 0; }
    if (++client.count > MAX_MSGS_PER_SEC) { client.ws.close(1008); return; }

    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') return;

    if (msg.t === 'ping') { client.send({ t: 'pong', ts: msg.ts, now: nowMs }); return; }

    const ack = (ok, extra) => { if (msg.id != null) client.send({ t: 'ack', id: msg.id, ok, ...extra }); };
    const roomBefore = client.room;
    const revBefore = roomBefore ? roomBefore.rev : 0;

    try {
      const data = this.dispatch(client, msg, nowMs);
      this.afterChange(client.room || roomBefore, revBefore, roomBefore);
      ack(true, data ? { data } : undefined);
    } catch (e) {
      this.afterChange(client.room || roomBefore, revBefore, roomBefore);
      if (e instanceof GameError) {
        ack(false, { code: e.code, error: e.message });
        // Клиент мог действовать по устаревшим данным — присылаем ему свежее состояние.
        if (client.room) this.sendState(client);
      } else {
        this.log.error('[hub] ошибка обработки', msg.t, e);
        ack(false, { code: 'internal', error: 'Внутренняя ошибка сервера' });
      }
    }
  }

  dispatch(client, msg, now) {
    const E = this.engine;
    switch (msg.t) {
      case 'create': {
        const room = this.createRoom(msg, now);
        const p = E.addPlayer(room, msg.name, now);
        this.attach(client, room, p);
        client.send({ t: 'joined', room: room.code, token: p.token, pid: p.id, name: p.name });
        this.queueSave(room);
        return null;
      }
      case 'join': {
        const code = String(msg.room || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const room = this.rooms.get(code);
        if (!room) throw new GameError('no_room', 'Комната не найдена — проверьте код');
        let p = msg.token ? room.players.find((x) => x.token === msg.token) : null;
        if (p && p.left) throw new GameError('bad_token', 'Вы вышли из этой игры и не можете вернуться');
        if (!p) {
          if (msg.token && room.status !== 'lobby' && !msg.name) throw new GameError('bad_token', 'Вас нет в этой игре');
          p = E.addPlayer(room, msg.name, now);   // бросит started/full/name_taken при необходимости
          this.queueSave(room);
        }
        this.attach(client, room, p);
        client.send({ t: 'joined', room: room.code, token: p.token, pid: p.id, name: p.name });
        this.markDirty(room);
        return null;
      }
      case 'sync':
        if (client.room) this.sendState(client);
        return null;
      case 'leave': {
        const room = client.room;
        if (!room) return null;
        E.leaveGame(room, client.pid, now);
        this.detach(client);
        if (room.status === 'lobby' && !room.players.length) this.deleteRoom(room);
        client.send({ t: 'left' });
        return null;
      }
      default:
        break;
    }

    const room = client.room;
    if (!room) throw new GameError('no_room', 'Вы не в комнате');
    const pid = client.pid;
    switch (msg.t) {
      case 'start': E.startGame(room, pid, now); this.schedule(room); return null;
      case 'kick': E.kick(room, pid, String(msg.target || ''), now); this.kickClients(room, String(msg.target || '')); return null;
      case 'capture': { E.beginCapture(room, pid, msg, now); this.schedule(room); return null; }
      case 'place': E.place(room, pid, { tileId: msg.tileId, x: msg.x, y: msg.y, letter: msg.letter }, now); return null;
      case 'unplace': E.unplace(room, pid, { x: msg.x, y: msg.y }, now); return null;
      case 'blank': E.setBlank(room, pid, { x: msg.x, y: msg.y, letter: msg.letter }, now); return null;
      case 'cancel': E.cancel(room, pid, now); this.schedule(room); return null;
      case 'commit': { const r = E.commit(room, pid, now); this.schedule(room); return r; }
      case 'exchange': E.exchange(room, pid, msg.tileIds, now); return null;
      default:
        throw new GameError('bad_request', 'Неизвестная команда');
    }
  }

  createRoom(msg, now) {
    let code;
    do {
      code = Array.from({ length: 5 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
    } while (this.rooms.has(code));
    const room = this.engine.newRoom(code, { mode: msg.mode, maxPlayers: msg.maxPlayers }, now);
    this.rooms.set(code, room);
    return room;
  }

  kickClients(room, pid) {
    const set = this.live.get(room.code);
    if (!set) return;
    for (const c of [...set]) {
      if (c.pid === pid) {
        c.room = null; c.pid = null;
        set.delete(c);
        c.send({ t: 'left', reason: 'kicked' });
      }
    }
  }

  deleteRoom(room) {
    const t = this.timers.get(room.code);
    if (t) clearTimeout(t);
    this.timers.delete(room.code);
    this.rooms.delete(room.code);
    this.live.delete(room.code);
    this.saveQueue.delete(room.code);
    this.deleteQueue.add(room.code);
    this.drainSaves();
  }

  /* ───────────────────────── последствия изменений ───────────────────────── */

  afterChange(room, revBefore, roomBefore) {
    if (!room || !this.rooms.has(room.code)) return;
    if (room.rev !== revBefore || room !== roomBefore) {
      this.markDirty(room);
      this.queueSave(room);
      this.schedule(room);
      if (room.status === 'finished') this.onFinished(room);
    }
  }

  /** Один таймер на комнату: просыпается, когда истекает ближайший захват или общее время игры. */
  schedule(room) {
    const old = this.timers.get(room.code);
    if (old) clearTimeout(old);
    this.timers.delete(room.code);
    if (room.status !== 'playing') return;
    let next = room.endsAt;
    for (const p of room.players) if (p.capture) next = Math.min(next, p.capture.deadline);
    const delay = Math.min(Math.max(0, next - Date.now()) + 15, 2 ** 31 - 1);
    const t = setTimeout(() => {
      this.timers.delete(room.code);
      const before = room.rev;
      this.engine.settle(room, Date.now());
      this.afterChange(room, before, room);
      this.schedule(room);
    }, delay);
    this.timers.set(room.code, t);
  }

  onFinished(room) {
    if (room.resultSaved) return;
    room.resultSaved = true;
    const res = this.engine.result(room);
    const payload = {
        code: room.code,
        mode: room.settings.mode,
        size: room.settings.size,
        target: room.settings.target,
        startedAt: room.startedAt,
        finishedAt: room.finishedAt,
        reason: room.endReason,
        winners: room.winnerIds.map((id) => room.players.find((p) => p.id === id).name),
        ranking: res.ranking,
        words: room.words,
    };
    // Запись может быть сетевой: не блокируем игру, а при ошибке повторим в housekeeping().
    Promise.resolve()
      .then(() => this.store.saveResult(payload))
      .then((id) => { room.resultId = id; this.queueSave(room); })
      .catch((e) => {
        room.resultSaved = false;
        this.log.error('[db] не удалось сохранить результат игры (повторим позже):', e.message);
      });
    this.queueSave(room);
  }

  queueSave(room) {
    this.saveQueue.add(room.code);
    if (this.saveTimer || this.drainP) return;
    this.saveTimer = setTimeout(() => { this.saveTimer = null; this.drainSaves(); }, 300);
  }

  /**
   * Записи в БД идут строго по очереди и склеиваются: если пока шла запись комната менялась снова,
   * в БД уйдёт только самое свежее состояние. Ошибка (например, нет сети до Supabase) не теряет данные:
   * комната остаётся в очереди и записывается повторно.
   */
  drainSaves() {
    if (!this.drainP) {
      this.drainP = this.drainLoop().finally(() => { this.drainP = null; });
    }
    return this.drainP;
  }

  async drainLoop() {
    while (this.saveQueue.size || this.deleteQueue.size) {
      let failed = false;
      const codes = [...this.saveQueue];
      this.saveQueue.clear();
      for (const code of codes) {
        const room = this.rooms.get(code);
        if (!room) continue;
        try { await this.store.saveRoom(room); } catch (e) {
          failed = true; this.saveQueue.add(code);
          this.log.error('[db] не удалось сохранить комнату ' + code + ':', e.message);
        }
      }
      for (const code of [...this.deleteQueue]) {
        try { await this.store.deleteRoom(code); this.deleteQueue.delete(code); } catch (e) {
          failed = true;
          this.log.error('[db] не удалось удалить комнату ' + code + ':', e.message);
        }
      }
      if (failed) await new Promise((r) => setTimeout(r, 2000));
    }
  }

  /* ───────────────────────── обслуживание ───────────────────────── */

  /** Раз в минуту: убираем брошенные места в лобби, старые комнаты, зависшие партии. */
  housekeeping() {
    const now = Date.now();
    for (const room of [...this.rooms.values()]) {
      const online = (this.live.get(room.code) || new Set()).size > 0;
      if (room.status === 'lobby') {
        for (const p of [...room.players]) {
          if (!this.isConnected(room.code, p.id) && now - p.lastSeenAt > 5 * 60_000) {
            this.engine.removePlayer(room, p.id, now);
            this.afterChange(room, -1, room);
          }
        }
        if (!room.players.length || (!online && now - room.updatedAt > 6 * 3600_000)) this.deleteRoom(room);
      } else if (room.status === 'playing') {
        if (!online && now - room.updatedAt > 12 * 3600_000) {
          const before = room.rev;
          this.engine.finish(room, 'abandoned', now);
          this.engine.touch(room, now);
          this.afterChange(room, before, room);
        }
      } else if (room.status === 'finished') {
        if (!room.resultSaved) this.onFinished(room); // повтор, если запись результата не удалась
        else if (now - room.finishedAt > 2 * 3600_000 && !online) this.deleteRoom(room);
      }
    }
  }

  /** Рассылка ping и отключение «мёртвых» соединений. */
  heartbeat(clients) {
    for (const c of clients) {
      if (!c.alive) { c.ws.terminate(); continue; }
      c.alive = false;
      c.ws.ping();
    }
  }
}

module.exports = { Hub, C };
