'use strict';
/**
 * Игровой движок «Эрудит в реальном времени».
 *
 * Сервер — единственный источник истины. Все действия выполняются синхронно в одном
 * потоке Node.js, поэтому каждое из них атомарно: «кто первый дошёл до сервера, тот и прав».
 * Движок не знает про сеть и таймеры — он только меняет объект `room` и бросает GameError.
 */
const crypto = require('crypto');
const C = require('./config');

const R = C.RULES;

class GameError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}
const fail = (code, message) => { throw new GameError(code, message); };

const key = (x, y) => `${x},${y}`;
const inRange = (v, n) => Number.isInteger(v) && v >= 0 && v < n;

function shuffle(arr, rng) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function newStats() {
  return { words: 0, tiles: 0, best: null, longest: '', bingos: 0, exchanges: 0, cancels: 0, timeouts: 0, failed: 0, captures: 0 };
}

function normLetter(l) {
  const s = String(l || '').toLowerCase().replace('ё', 'е');
  return C.TILE_SET[s] ? s : null;
}

function cleanName(name) {
  const s = String(name || '').replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 16);
  if (!s) fail('bad_name', 'Введите имя (до 16 символов)');
  return s;
}

class Engine {
  constructor(dict, rng = Math.random) {
    this.dict = dict;
    this.rng = rng;
  }

  /* ───────────────────────── комнаты и игроки ───────────────────────── */

  newRoom(code, { mode, maxPlayers }, now) {
    const m = C.MODES[mode];
    if (!m) fail('bad_mode', 'Неизвестная длительность игры');
    const max = Math.min(R.maxPlayers, Math.max(R.minPlayers, Number(maxPlayers) || R.maxPlayers));
    return {
      code,
      status: 'lobby',                 // lobby → playing → finished
      rev: 1,
      createdAt: now,
      updatedAt: now,
      settings: { mode, size: m.size, maxPlayers: max, target: C.targetFor(mode, max), timeLimitMs: m.timeLimitMin * 60_000 },
      hostId: null,
      players: [],
      nextPid: 1,
      board: Array.from({ length: m.size }, () => Array(m.size).fill(null)),
      bag: [],
      nextTileId: 1,
      startedAt: 0,
      endsAt: 0,
      finishedAt: 0,
      winnerIds: [],
      endReason: '',
      words: [],
      events: [],
      eventSeq: 0,
      resultSaved: false,
      resultId: null,
    };
  }

  touch(room, now) {
    room.rev += 1;
    room.updatedAt = now;
  }

  addEvent(room, type, data, now) {
    room.events.push({ id: ++room.eventSeq, ts: now, type, ...data });
    if (room.events.length > 40) room.events.splice(0, room.events.length - 40);
  }

  addPlayer(room, rawName, now) {
    if (room.status !== 'lobby') fail('started', 'Игра уже началась');
    if (room.players.length >= room.settings.maxPlayers) fail('full', 'Комната заполнена');
    const name = cleanName(rawName);
    if (room.players.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      fail('name_taken', 'Это имя уже занято в комнате — выберите другое');
    }
    const used = new Set(room.players.map((p) => p.color));
    let color = 0;
    while (used.has(color)) color++;
    const p = {
      id: 'p' + room.nextPid++,
      token: crypto.randomBytes(16).toString('hex'),
      name, color, score: 0,
      rack: [], capture: null,
      cooldownUntil: 0, cooldownKind: '',
      lastSeenAt: now,
      stats: newStats(),
    };
    room.players.push(p);
    if (!room.hostId) room.hostId = p.id;
    this.touch(room, now);
    return p;
  }

  removePlayer(room, pid, now) {
    if (room.status !== 'lobby') fail('started', 'Игра уже началась');
    const i = room.players.findIndex((p) => p.id === pid);
    if (i < 0) return;
    room.players.splice(i, 1);
    if (room.hostId === pid) room.hostId = room.players[0] ? room.players[0].id : null;
    this.touch(room, now);
  }

  /**
   * Выход из комнаты. В лобби место просто освобождается. Во время игры игрок выбывает навсегда:
   * его отрезок освобождается, буквы возвращаются в мешок, очки остаются в итогах.
   * Если не вышедших игроков осталось меньше двух, игра заканчивается.
   */
  leaveGame(room, pid, now) {
    if (room.status === 'lobby') { this.removePlayer(room, pid, now); return; }
    if (room.status !== 'playing') return;
    this.settle(room, now);
    if (room.status !== 'playing') return;
    const p = room.players.find((x) => x.id === pid);
    if (!p || p.left) return;
    this.releaseCapture(p);
    for (const t of p.rack) {
      if (t.blank) t.ch = '?';
      room.bag.splice(Math.floor(this.rng() * (room.bag.length + 1)), 0, t);
    }
    p.rack = [];
    p.left = true;
    p.cooldownUntil = 0;
    this.addEvent(room, 'left', { pid }, now);
    if (room.hostId === pid) {
      const next = room.players.find((x) => !x.left);
      if (next) room.hostId = next.id;
    }
    const active = room.players.filter((x) => !x.left);
    if (active.length < R.minPlayers) this.finish(room, active.length ? 'last_player' : 'abandoned', now);
    this.touch(room, now);
  }

  kick(room, hostPid, targetPid, now) {
    if (room.hostId !== hostPid) fail('not_host', 'Только создатель комнаты может удалять игроков');
    if (targetPid === hostPid) fail('bad_request', 'Нельзя удалить себя');
    this.removePlayer(room, targetPid, now);
  }

  /* ───────────────────────── старт игры ───────────────────────── */

  startGame(room, pid, now) {
    if (room.status !== 'lobby') fail('started', 'Игра уже началась');
    if (room.hostId !== pid) fail('not_host', 'Начать игру может только создатель комнаты');
    if (room.players.length < R.minPlayers) fail('few_players', `Нужно минимум ${R.minPlayers} игрока`);

    const s = room.settings;
    s.target = C.targetFor(s.mode, room.players.length);
    room.bag = this.makeBag(room);
    this.placeFirstWord(room);
    for (const p of room.players) { p.rack = []; p.score = 0; p.capture = null; p.cooldownUntil = 0; this.refill(room, p); }
    room.status = 'playing';
    room.startedAt = now;
    room.endsAt = now + s.timeLimitMs;
    this.addEvent(room, 'start', {}, now);
    this.touch(room, now);
  }

  makeBag(room) {
    const bag = [];
    for (const [ch, [count, pts]] of Object.entries(C.TILE_SET)) {
      for (let i = 0; i < count; i++) bag.push({ id: room.nextTileId++, ch, pts, blank: false });
    }
    for (let i = 0; i < C.BLANKS; i++) bag.push({ id: room.nextTileId++, ch: '?', pts: 0, blank: true });
    return shuffle(bag, this.rng);
  }

  /** Первое слово по центру: случайное, фиксированной длины, буквы берутся из общего мешка. */
  placeFirstWord(room) {
    const n = room.settings.size;
    const L = C.MODES[room.settings.mode].firstWordLen;
    const y = (n - 1) / 2;
    const x0 = (n - L) / 2;
    const available = new Map();
    for (const t of room.bag) if (!t.blank) available.set(t.ch, (available.get(t.ch) || 0) + 1);

    let word = null;
    for (let attempt = 0; attempt < 300 && !word; attempt++) {
      const w = this.dict.randomStarter(L, this.rng);
      if (!w) break;
      const need = new Map();
      for (const ch of w) need.set(ch, (need.get(ch) || 0) + 1);
      if ([...need].every(([ch, k]) => (available.get(ch) || 0) >= k + 1)) word = w;
    }
    if (!word) {
      const list = C.FALLBACK_STARTERS[L] || C.FALLBACK_STARTERS[5];
      word = list[Math.floor(this.rng() * list.length)];
    }

    [...word].forEach((ch, i) => {
      const idx = room.bag.findIndex((t) => !t.blank && t.ch === ch);
      const tile = idx >= 0 ? room.bag.splice(idx, 1)[0] : { id: room.nextTileId++, ch, pts: C.TILE_SET[ch][1], blank: false };
      room.board[y][x0 + i] = { ch, pts: tile.pts, blank: false, by: null, tid: tile.id };
    });
  }

  refill(room, p) {
    while (p.rack.length < R.rackSize && room.bag.length) p.rack.push(room.bag.pop());
  }

  /* ───────────────────────── время ───────────────────────── */

  /** Применяет всё, что «просрочилось»: истёкшие захваты и общий лимит времени. */
  settle(room, now) {
    if (room.status !== 'playing') return false;
    let changed = false;
    for (const p of room.players) {
      if (p.capture && now >= p.capture.deadline) {
        this.releaseCapture(p);
        p.cooldownUntil = now + R.cooldownMoveMs;
        p.cooldownKind = 'move';
        p.stats.timeouts++;
        this.addEvent(room, 'timeout', { pid: p.id }, now);
        changed = true;
      }
    }
    if (now >= room.endsAt) { this.finish(room, 'time', now); changed = true; }
    if (changed) this.touch(room, now);
    return changed;
  }

  releaseCapture(p) {
    if (!p.capture) return;
    for (const t of Object.values(p.capture.placed)) this.toRack(p, t);
    p.capture = null;
  }

  toRack(p, tile) {
    if (tile.blank) tile.ch = '?';   // бланк «вернулся» — выбранная буква сбрасывается
    p.rack.push(tile);
  }

  finish(room, reason, now) {
    if (room.status !== 'playing') return;
    for (const p of room.players) this.releaseCapture(p);
    room.status = 'finished';
    room.finishedAt = now;
    room.endReason = reason;
    // Вышедшие игроки не претендуют на победу (если остался хотя бы один не вышедший).
    const active = room.players.filter((p) => !p.left);
    const pool = active.length ? active : room.players;
    const max = Math.max(...pool.map((p) => p.score));
    room.winnerIds = pool.filter((p) => p.score === max).map((p) => p.id);
    this.addEvent(room, 'end', { reason, winnerIds: room.winnerIds }, now);
  }

  /** Контекст для игровых действий: сначала «догоняем» время, потом проверяем статус. */
  ctx(room, pid, now) {
    this.settle(room, now);
    if (room.status !== 'playing') fail('not_playing', room.status === 'finished' ? 'Игра уже завершена' : 'Игра ещё не началась');
    const p = room.players.find((x) => x.id === pid);
    if (!p) fail('no_player', 'Вас нет в этой игре');
    if (p.left) fail('left', 'Вы вышли из этой игры');
    return p;
  }

  checkCooldown(p, now) {
    if (now < p.cooldownUntil) {
      fail('cooldown', `Подождите ещё ${Math.ceil((p.cooldownUntil - now) / 1000)} с`);
    }
  }

  /* ───────────────────────── захват отрезка ───────────────────────── */

  beginCapture(room, pid, seg, now) {
    const p = this.ctx(room, pid, now);
    if (p.capture) fail('busy', 'Вы уже собираете слово');
    this.checkCooldown(p, now);

    const n = room.settings.size;
    let { x1, y1, x2, y2 } = seg || {};
    if (![x1, y1, x2, y2].every((v) => inRange(v, n))) fail('bad_segment', 'Клетки вне доски');
    let dir;
    if (y1 === y2 && x1 !== x2) dir = 'h';
    else if (x1 === x2 && y1 !== y2) dir = 'v';
    else fail('bad_segment', 'Отрезок должен идти по горизонтали или по вертикали');
    if (dir === 'h' && x1 > x2) [x1, x2] = [x2, x1];
    if (dir === 'v' && y1 > y2) [y1, y2] = [y2, y1];

    const cells = [];
    for (let x = x1, y = y1; x <= x2 && y <= y2; dir === 'h' ? x++ : y++) cells.push([x, y]);

    // Конфликт: клетки уже заняты отрезком другого игрока (кто первый — тот и захватил).
    const taken = new Map();
    for (const o of room.players) {
      if (o.id !== pid && o.capture) for (const [cx, cy] of o.capture.cells) taken.set(key(cx, cy), o);
    }
    for (const [cx, cy] of cells) {
      const o = taken.get(key(cx, cy));
      if (o) fail('occupied', `Часть клеток уже занята: ${o.name} собирает слово`);
    }

    const filled = cells.filter(([cx, cy]) => room.board[cy][cx]).length;
    const empty = cells.length - filled;
    if (filled === 0) fail('no_anchor', 'Слово должно проходить хотя бы через одну букву, уже лежащую на доске');
    if (empty === 0) fail('no_empty', 'В отрезке нет пустых клеток');
    if (empty > p.rack.length) fail('too_long', `В отрезке ${empty} пустых клеток, а в стойке только ${p.rack.length} букв`);

    const dx = dir === 'h' ? 1 : 0;
    const dy = dir === 'v' ? 1 : 0;
    const bx = x1 - dx, by = y1 - dy, ax = x2 + dx, ay = y2 + dy;
    if (inRange(bx, n) && inRange(by, n) && room.board[by][bx]) fail('extends', 'Отрезок должен начинаться с начала цепочки букв — продлите его назад');
    if (inRange(ax, n) && inRange(ay, n) && room.board[ay][ax]) fail('extends', 'Отрезок должен включать всю цепочку букв — продлите его вперёд');

    p.capture = { dir, x1, y1, x2, y2, cells, startedAt: now, deadline: now + R.captureMs, placed: {} };
    p.stats.captures++;
    this.touch(room, now);
    return p.capture;
  }

  findTile(p, tileId) {
    const ri = p.rack.findIndex((t) => t.id === tileId);
    if (ri >= 0) return { tile: p.rack[ri], from: 'rack', ri };
    for (const [k, t] of Object.entries(p.capture.placed)) if (t.id === tileId) return { tile: t, from: k };
    return null;
  }

  place(room, pid, { tileId, x, y, letter }, now) {
    const p = this.ctx(room, pid, now);
    const cap = p.capture;
    if (!cap) fail('no_capture', 'Сначала нажмите «Собрать слово» и выберите отрезок');
    if (!cap.cells.some(([cx, cy]) => cx === x && cy === y)) fail('outside', 'Эта клетка вне вашего отрезка');
    if (room.board[y][x]) fail('filled', 'В этой клетке уже лежит буква');
    const found = this.findTile(p, tileId);
    if (!found) fail('no_tile', 'Такой буквы нет в вашей стойке');
    const { tile, from, ri } = found;
    if (tile.blank) {
      const l = normLetter(letter);
      if (!l) fail('need_letter', 'Выберите букву для бланка');
      tile.ch = l;
    }
    const k = key(x, y);
    const old = cap.placed[k];
    if (from === 'rack') p.rack.splice(ri, 1); else delete cap.placed[from];
    if (old && old.id !== tile.id) this.toRack(p, old);
    cap.placed[k] = tile;
    this.touch(room, now);
  }

  unplace(room, pid, { x, y }, now) {
    const p = this.ctx(room, pid, now);
    if (!p.capture) fail('no_capture', 'Нет активного захвата');
    const k = key(x, y);
    const t = p.capture.placed[k];
    if (!t) return;
    delete p.capture.placed[k];
    this.toRack(p, t);
    this.touch(room, now);
  }

  setBlank(room, pid, { x, y, letter }, now) {
    const p = this.ctx(room, pid, now);
    if (!p.capture) fail('no_capture', 'Нет активного захвата');
    const t = p.capture.placed[key(x, y)];
    if (!t || !t.blank) fail('no_tile', 'В этой клетке нет бланка');
    const l = normLetter(letter);
    if (!l) fail('need_letter', 'Выберите букву для бланка');
    t.ch = l;
    this.touch(room, now);
  }

  cancel(room, pid, now) {
    const p = this.ctx(room, pid, now);
    if (!p.capture) fail('no_capture', 'Нет активного захвата');
    this.releaseCapture(p);
    p.cooldownUntil = now + R.cooldownMoveMs;
    p.cooldownKind = 'move';
    p.stats.cancels++;
    this.touch(room, now);
  }

  /* ───────────────────────── проверка слова и очки ───────────────────────── */

  /**
   * Разбирает текущий захват игрока: слово, перекрёстные слова, очки.
   * Ничего не меняет. Ошибки возвращает в поле `error`, а не бросает.
   */
  evaluate(room, p) {
    const cap = p.capture;
    const n = room.settings.size;
    const prem = C.premiumGrid(n);
    const board = room.board;
    const filled = (x, y) => inRange(x, n) && inRange(y, n) && board[y][x];

    let pattern = '';
    let missing = false;
    let sum = 0;
    let wmul = 1;
    let placedCount = 0;
    const fresh = []; // новые клетки: [x, y, tile]

    for (const [x, y] of cap.cells) {
      const b = board[y][x];
      if (b) { pattern += b.ch; sum += b.pts; continue; }
      const t = cap.placed[key(x, y)];
      if (!t) { pattern += '·'; missing = true; continue; }
      pattern += t.ch;
      const [lm, wm] = C.multipliers(prem[y][x]);
      sum += (t.blank ? 0 : t.pts) * lm;
      wmul *= wm;
      placedCount++;
      fresh.push([x, y, t]);
    }
    if (missing) {
      return { complete: false, pattern, error: { code: 'incomplete', message: 'Заполните все клетки отрезка' } };
    }

    const dx = cap.dir === 'h' ? 1 : 0;
    const dy = cap.dir === 'v' ? 1 : 0;
    const [fx, fy] = cap.cells[0];
    const [lx, ly] = cap.cells[cap.cells.length - 1];
    if (filled(fx - dx, fy - dy) || filled(lx + dx, ly + dy)) {
      return { complete: true, pattern, valid: false, error: { code: 'extends', message: 'Рядом с отрезком появилась буква: слово стало длиннее. Отмените и выберите отрезок заново' } };
    }
    if (!this.dict.has(pattern)) {
      return { complete: true, pattern, valid: false, error: { code: 'not_in_dictionary', message: `Слова «${pattern.toUpperCase()}» нет в словаре` } };
    }

    const parts = [{ word: pattern, score: sum * wmul }];
    let total = sum * wmul;

    // Перекрёстные слова: каждая новая буква может склеиться с буквами по соседству.
    const px = dy, py = dx; // перпендикуляр к направлению слова
    for (const [x, y, t] of fresh) {
      let sx = x, sy = y;
      while (filled(sx - px, sy - py)) { sx -= px; sy -= py; }
      let ex = x, ey = y;
      while (filled(ex + px, ey + py)) { ex += px; ey += py; }
      if (sx === ex && sy === ey) continue;
      let w = '';
      let s = 0;
      for (let cx = sx, cy = sy; ; cx += px, cy += py) {
        if (cx === x && cy === y) {
          const [lm] = C.multipliers(prem[y][x]);
          w += t.ch; s += (t.blank ? 0 : t.pts) * lm;
        } else {
          const b = board[cy][cx]; w += b.ch; s += b.pts;
        }
        if (cx === ex && cy === ey) break;
      }
      if (!this.dict.has(w)) {
        return { complete: true, pattern, valid: false, error: { code: 'cross_invalid', message: `Получается лишнее слово «${w.toUpperCase()}» — его нет в словаре` } };
      }
      const [, wm] = C.multipliers(prem[y][x]);
      s *= wm;
      parts.push({ word: w, score: s });
      total += s;
    }

    const bingo = placedCount >= R.rackSize;
    if (bingo) total += R.bingoBonus;
    return { complete: true, pattern, valid: true, word: pattern, score: total, parts, bingo, placedCount };
  }

  commit(room, pid, now) {
    const p = this.ctx(room, pid, now);
    const cap = p.capture;
    if (!cap) fail('no_capture', 'Нет активного захвата');
    const ev = this.evaluate(room, p);
    if (!ev.valid) {
      if (ev.complete) p.stats.failed++;
      fail(ev.error.code, ev.error.message);
    }

    const placedCells = [];
    for (const [k, t] of Object.entries(cap.placed)) {
      const [x, y] = k.split(',').map(Number);
      room.board[y][x] = { ch: t.ch, pts: t.blank ? 0 : t.pts, blank: t.blank, by: p.id, tid: t.id };
      placedCells.push([x, y]);
    }
    p.capture = null;
    p.score += ev.score;
    p.stats.words++;
    p.stats.tiles += ev.placedCount;
    if (ev.bingo) p.stats.bingos++;
    if (!p.stats.best || ev.score > p.stats.best.score) p.stats.best = { word: ev.word, score: ev.score };
    if (ev.word.length > p.stats.longest.length) p.stats.longest = ev.word;
    this.refill(room, p);
    // После удачного слова пауза не нужна: можно сразу занимать следующий отрезок.
    p.cooldownUntil = 0;
    p.cooldownKind = '';

    room.words.push({ n: room.words.length + 1, pid: p.id, word: ev.word, score: ev.score, at: now, bingo: ev.bingo, parts: ev.parts });
    this.addEvent(room, 'word', { pid: p.id, word: ev.word, score: ev.score, bingo: ev.bingo, cells: placedCells }, now);

    if (p.score >= room.settings.target) this.finish(room, 'target', now);
    else if (room.bag.length === 0 && p.rack.length === 0) this.finish(room, 'out_of_tiles', now);
    this.touch(room, now);
    return { score: ev.score, word: ev.word };
  }

  /* ───────────────────────── обмен букв ───────────────────────── */

  exchange(room, pid, tileIds, now) {
    const p = this.ctx(room, pid, now);
    if (p.capture) fail('busy', 'Сначала подтвердите или отмените сбор слова');
    this.checkCooldown(p, now);
    const ids = [...new Set((Array.isArray(tileIds) ? tileIds : []).filter(Number.isInteger))];
    if (!ids.length) fail('bad_request', 'Выберите буквы для обмена');
    const tiles = ids.map((id) => p.rack.find((t) => t.id === id));
    if (tiles.some((t) => !t)) fail('no_tile', 'Некоторых букв нет в вашей стойке');
    if (room.bag.length < ids.length) fail('bag_small', `В мешке только ${room.bag.length} букв — столько обменять нельзя`);

    const drawn = [];
    for (let i = 0; i < ids.length; i++) drawn.push(room.bag.pop());
    p.rack = p.rack.filter((t) => !ids.includes(t.id));
    p.rack.push(...drawn);
    for (const t of tiles) {
      if (t.blank) t.ch = '?';
      room.bag.splice(Math.floor(this.rng() * (room.bag.length + 1)), 0, t);
    }
    p.cooldownUntil = now + R.cooldownExchangeMs;
    p.cooldownKind = 'exchange';
    p.stats.exchanges++;
    this.addEvent(room, 'exchange', { pid: p.id, count: ids.length }, now);
    this.touch(room, now);
  }

  /* ───────────────────────── представление для клиентов ───────────────────────── */

  publicStats(p) {
    const s = p.stats;
    return {
      words: s.words, avg: s.words ? Math.round((p.score / s.words) * 10) / 10 : 0,
      best: s.best, longest: s.longest, bingos: s.bingos, exchanges: s.exchanges,
      tiles: s.tiles, cancels: s.cancels, timeouts: s.timeouts, failed: s.failed, captures: s.captures,
    };
  }

  result(room) {
    const ranking = room.players
      .map((p) => ({ id: p.id, name: p.name, color: p.color, score: p.score, left: !!p.left, ...this.publicStats(p) }))
      .sort((a, b) => b.score - a.score);
    for (const r of ranking) r.place = 1 + ranking.filter((o) => o.score > r.score).length;
    return {
      reason: room.endReason,
      winnerIds: room.winnerIds,
      ranking,
      words: room.words.length,
      durationMs: (room.finishedAt || Date.now()) - room.startedAt,
    };
  }

  /** Часть состояния, одинаковая для всех игроков комнаты. */
  commonView(room, now, isConnected) {
    const s = room.settings;
    const n = s.size;
    const tiles = [];
    for (let y = 0; y < n; y++) {
      for (let x = 0; x < n; x++) {
        const b = room.board[y][x];
        if (b) tiles.push([x, y, b.ch, b.pts, b.blank ? 1 : 0, b.by || '']);
      }
    }
    return {
      code: room.code,
      status: room.status,
      rev: room.rev,
      mode: s.mode,
      modeTitle: C.MODES[s.mode].title,
      size: n,
      maxPlayers: s.maxPlayers,
      target: room.status === 'lobby' ? C.targetFor(s.mode, room.players.length) : s.target,
      hostId: room.hostId,
      premium: C.premiumGrid(n),
      startedAt: room.startedAt,
      endsAt: room.endsAt,
      finishedAt: room.finishedAt,
      endReason: room.endReason,
      winnerIds: room.winnerIds,
      bag: room.bag.length,
      tiles,
      players: room.players.map((p) => ({
        id: p.id,
        name: p.name,
        color: p.color,
        score: p.score,
        connected: isConnected(p.id),
        left: !!p.left,
        tilesInHand: p.rack.length + (p.capture ? Object.keys(p.capture.placed).length : 0),
        cooldownUntil: p.cooldownUntil > now ? p.cooldownUntil : 0,
        cooldownKind: p.cooldownKind,
        capture: p.capture && {
          dir: p.capture.dir, x1: p.capture.x1, y1: p.capture.y1, x2: p.capture.x2, y2: p.capture.y2,
          startedAt: p.capture.startedAt, deadline: p.capture.deadline,
          placed: Object.entries(p.capture.placed).map(([k, t]) => {
            const [x, y] = k.split(',').map(Number);
            return [x, y, t.ch, t.blank ? 0 : t.pts, t.blank ? 1 : 0];
          }),
        },
        stats: this.publicStats(p),
      })),
      words: room.words.slice(-30).map((w) => ({ n: w.n, pid: w.pid, word: w.word, score: w.score, bingo: w.bingo })),
      events: room.events.slice(-30),
      result: room.status === 'finished' ? this.result(room) : null,
    };
  }

  /** Личная часть: стойка и предпросмотр собственного слова (чужие стойки скрыты). */
  youView(room, pid) {
    const p = room.players.find((x) => x.id === pid);
    if (!p) return null;
    let preview = null;
    if (p.capture && room.status === 'playing') {
      const ev = this.evaluate(room, p);
      preview = {
        pattern: ev.pattern.toUpperCase(),
        complete: ev.complete,
        valid: !!ev.valid,
        score: ev.valid ? ev.score : 0,
        parts: ev.valid ? ev.parts.map((x) => ({ word: x.word.toUpperCase(), score: x.score })) : [],
        bingo: !!ev.bingo,
        error: ev.error ? ev.error.message : '',
      };
    }
    return {
      id: p.id,
      rack: p.rack.map((t) => ({ id: t.id, ch: t.ch, pts: t.pts, blank: t.blank })),
      preview,
    };
  }
}

module.exports = { Engine, GameError };
