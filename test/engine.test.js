'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Engine, GameError } = require('../server/engine');
const { Dictionary } = require('../server/dictionary');
const C = require('../server/config');

// Детерминированный генератор случайных чисел
function seeded(seed = 7) { let s = seed; return () => (s = (s * 1664525 + 1013904223) % 4294967296) / 4294967296; }

const WORDS = ['книга', 'кино', 'нота', 'ток', 'кот', 'кит', 'тон', 'ноты', 'рот', 'тор', 'роса', 'коса', 'сок', 'ос', 'он', 'от', 'то', 'ни', 'слово', 'стена', 'ветер'];
function setup(players = 2, mode = 'fast') {
  const dict = new Dictionary(WORDS);
  const eng = new Engine(dict, seeded());
  const room = eng.newRoom('TEST1', { mode, maxPlayers: 4 }, 1000);
  for (let i = 0; i < players; i++) eng.addPlayer(room, 'Игрок' + (i + 1), 1000);
  eng.startGame(room, room.hostId, 1000);
  return { eng, room, a: room.players[0], b: room.players[1], dict };
}
const tile = (room, ch, pts = 1, blank = false) => ({ id: room.nextTileId++, ch: blank ? '?' : ch, pts: blank ? 0 : pts, blank });
const err = (fn) => { try { fn(); } catch (e) { if (e instanceof GameError) return e.code; throw e; } return null; };

/** Кладёт слово «книга» на центральную строку и возвращает индекс строки. */
function putKniga(room, x0) {
  const mid = (room.settings.size - 1) / 2;
  [...'книга'].forEach((ch, i) => { room.board[mid][x0 + i] = { ch, pts: C.TILE_SET[ch][1], blank: false, by: null, tid: 900 + i }; });
  return mid;
}
function clearCenter(room) {
  for (const row of room.board) row.fill(null);
}

test('старт: первое слово в центре, стойки по 7 букв, число очков зависит от игроков', () => {
  const { room, a, b } = setup(2, 'normal');
  const n = room.settings.size;
  const mid = (n - 1) / 2;
  const word = room.board[mid].filter(Boolean).map((c) => c.ch).join('');
  assert.equal(word.length, 5);
  assert.equal(a.rack.length, 7);
  assert.equal(b.rack.length, 7);
  assert.equal(room.settings.target, 200);
  assert.equal(setup(3, 'normal').room.settings.target, 180);
  assert.equal(room.status, 'playing');
});

test('размер доски зависит от режима', () => {
  assert.equal(setup(2, 'fast').room.board.length, 9);
  assert.equal(setup(2, 'normal').room.board.length, 13);
  assert.equal(setup(2, 'long').room.board.length, 15);
});

test('раскладка премиальных клеток симметрична, в центре ×2 слово', () => {
  for (const n of [9, 13, 15]) {
    const g = C.premiumGrid(n);
    const c = (n - 1) / 2;
    assert.equal(g[c][c], 'c');
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      assert.equal(g[y][x], g[x][y]);
      assert.equal(g[y][x], g[n - 1 - y][x]);
      assert.equal(g[y][x], g[y][n - 1 - x]);
    }
  }
});

test('захват отрезка: нужен «якорь», пустые клетки, прямая линия', () => {
  const { eng, room, a } = setup();
  clearCenter(room); putKniga(room, 2); // «книга» в строке 4, столбцы 2..6
  assert.equal(err(() => eng.beginCapture(room, a.id, { x1: 0, y1: 0, x2: 3, y2: 0 }, 2000)), 'no_anchor');
  assert.equal(err(() => eng.beginCapture(room, a.id, { x1: 0, y1: 0, x2: 3, y2: 1 }, 2000)), 'bad_segment');
  assert.equal(err(() => eng.beginCapture(room, a.id, { x1: 0, y1: 0, x2: 30, y2: 0 }, 2000)), 'bad_segment');
  assert.equal(err(() => eng.beginCapture(room, a.id, { x1: 2, y1: 4, x2: 6, y2: 4 }, 2000)), 'no_empty');
  const cap = eng.beginCapture(room, a.id, { x1: 4, y1: 8, x2: 4, y2: 3 }, 2000); // переданы «задом наперёд»
  assert.equal(cap.dir, 'v');
  assert.equal(cap.y1, 3); assert.equal(cap.y2, 8);
  assert.equal(cap.deadline, 2000 + C.RULES.captureMs);
  assert.equal(err(() => eng.beginCapture(room, a.id, { x1: 3, y1: 2, x2: 3, y2: 5 }, 2000)), 'busy');
});

test('отрезок обязан включать всю цепочку букв (иначе слово длиннее выбранного)', () => {
  const { eng, room, a } = setup();
  clearCenter(room); putKniga(room, 2);
  // строка 4: буквы в 2..6; отрезок 5..8 начинается внутри цепочки
  assert.equal(err(() => eng.beginCapture(room, a.id, { x1: 5, y1: 4, x2: 8, y2: 4 }, 2000)), 'extends');
});

test('конфликт: клетки другого игрока заняты — побеждает первый запрос', () => {
  const { eng, room, a, b } = setup();
  clearCenter(room); putKniga(room, 2);
  eng.beginCapture(room, a.id, { x1: 4, y1: 2, x2: 4, y2: 4 }, 2000); // вертикаль через «и»(4,4)
  assert.equal(err(() => eng.beginCapture(room, b.id, { x1: 4, y1: 4, x2: 4, y2: 7 }, 2000)), 'occupied'); // общая клетка
  assert.equal(err(() => eng.beginCapture(room, b.id, { x1: 4, y1: 1, x2: 4, y2: 3 }, 2000)), 'occupied'); // (4,3) уже в отрезке A
  const ok = eng.beginCapture(room, b.id, { x1: 3, y1: 4, x2: 3, y2: 7 }, 2000); // другая линия
  assert.ok(ok);
  assert.ok(room.players[1].capture);
});

test('время: захват истекает, буквы возвращаются, пауза 10 секунд', () => {
  const { eng, room, a } = setup();
  clearCenter(room); putKniga(room, 2);
  eng.beginCapture(room, a.id, { x1: 4, y1: 4, x2: 4, y2: 6 }, 2000);
  const t = tile(room, 'о'); a.rack.push(t);
  eng.place(room, a.id, { tileId: t.id, x: 4, y: 5 }, 3000);
  assert.equal(a.rack.includes(t), false);
  const late = 2000 + C.RULES.captureMs + 1;
  assert.equal(err(() => eng.commit(room, a.id, late)), 'no_capture');
  assert.equal(a.capture, null);
  assert.ok(a.rack.includes(t));
  assert.equal(a.cooldownUntil, late + C.RULES.cooldownMoveMs);
  assert.equal(err(() => eng.beginCapture(room, a.id, { x1: 4, y1: 4, x2: 4, y2: 6 }, late + 5)), 'cooldown');
});

test('слово собрано: очки, добор до 7, пауза', () => {
  const { eng, room, a } = setup();
  clearCenter(room); putKniga(room, 2);
  a.rack = [tile(room, 'и'), tile(room, 'н'), tile(room, 'о'), tile(room, 'а'), tile(room, 'б'), tile(room, 'в'), tile(room, 'г')];
  eng.beginCapture(room, a.id, { x1: 2, y1: 4, x2: 2, y2: 7 }, 2000); // «к» + 3 новых: к-и-н-о
  assert.equal(err(() => eng.commit(room, a.id, 2100)), 'incomplete');
  const [t1, t2, t3] = a.rack;
  eng.place(room, a.id, { tileId: t1.id, x: 2, y: 5 }, 2100);
  eng.place(room, a.id, { tileId: t2.id, x: 2, y: 6 }, 2100);
  eng.place(room, a.id, { tileId: t3.id, x: 2, y: 7 }, 2100);
  const pv = eng.youView(room, a.id).preview;
  assert.equal(pv.pattern, 'КИНО');
  assert.equal(pv.valid, true);
  const res = eng.commit(room, a.id, 2200);
  assert.equal(res.word, 'кино');
  assert.ok(a.score > 0);
  assert.equal(a.rack.length, 7);
  assert.equal(a.cooldownUntil, 2200 + C.RULES.cooldownMoveMs);
  assert.equal(room.board[5][2].by, a.id);
});

test('слова нет в словаре: ход не принят, можно исправить до конца времени', () => {
  const { eng, room, a } = setup();
  clearCenter(room); putKniga(room, 2);
  a.rack = [tile(room, 'я'), tile(room, 'я'), tile(room, 'н'), tile(room, 'о'), tile(room, 'т'), tile(room, 'б'), tile(room, 'в')];
  eng.beginCapture(room, a.id, { x1: 2, y1: 4, x2: 2, y2: 6 }, 2000);
  eng.place(room, a.id, { tileId: a.rack[0].id, x: 2, y: 5 }, 2100);
  eng.place(room, a.id, { tileId: a.rack[0].id, x: 2, y: 6 }, 2100);
  assert.equal(err(() => eng.commit(room, a.id, 2200)), 'not_in_dictionary');
  assert.ok(a.capture);
  assert.equal(a.stats.failed, 1);
  eng.unplace(room, a.id, { x: 2, y: 5 }, 2300);
  eng.unplace(room, a.id, { x: 2, y: 6 }, 2300);
  const o = a.rack.find((t) => t.ch === 'о'); const t = a.rack.find((x) => x.ch === 'т');
  eng.place(room, a.id, { tileId: o.id, x: 2, y: 5 }, 2400);
  eng.place(room, a.id, { tileId: t.id, x: 2, y: 6 }, 2400);
  assert.equal(eng.commit(room, a.id, 2500).word, 'кот');
});

test('бланк: нужна буква, при снятии возвращается бланком', () => {
  const { eng, room, a } = setup();
  clearCenter(room); putKniga(room, 2);
  const blank = tile(room, '', 0, true); a.rack = [blank, tile(room, 'о')];
  eng.beginCapture(room, a.id, { x1: 2, y1: 4, x2: 2, y2: 6 }, 2000);
  assert.equal(err(() => eng.place(room, a.id, { tileId: blank.id, x: 2, y: 5 }, 2100)), 'need_letter');
  eng.place(room, a.id, { tileId: blank.id, x: 2, y: 5, letter: 'О' }, 2100);
  assert.equal(a.capture.placed['2,5'].ch, 'о');
  eng.unplace(room, a.id, { x: 2, y: 5 }, 2150);
  assert.equal(blank.ch, '?');
  assert.ok(a.rack.includes(blank));
});

test('бланк после подтверждения остаётся буквой и даёт 0 очков', () => {
  const { eng, room, a } = setup();
  clearCenter(room); putKniga(room, 2);
  const blank = tile(room, '', 0, true); const t = tile(room, 'т'); a.rack = [blank, t];
  eng.beginCapture(room, a.id, { x1: 2, y1: 4, x2: 2, y2: 6 }, 2000);
  eng.place(room, a.id, { tileId: blank.id, x: 2, y: 5, letter: 'о' }, 2100);
  eng.place(room, a.id, { tileId: t.id, x: 2, y: 6 }, 2100);
  eng.commit(room, a.id, 2200);
  const cell = room.board[5][2];
  assert.equal(cell.ch, 'о'); assert.equal(cell.blank, true); assert.equal(cell.pts, 0);
});

test('очки: премиальные клетки считаются только для новых букв', () => {
  const { eng, room, a } = setup(2, 'normal');
  clearCenter(room); const mid = putKniga(room, 4);
  a.rack = [tile(room, 'о', 1), tile(room, 'т', 1)];
  eng.beginCapture(room, a.id, { x1: 4, y1: mid, x2: 4, y2: mid + 2 }, 2000);
  eng.place(room, a.id, { tileId: a.rack[0].id, x: 4, y: mid + 1 }, 2000);
  eng.place(room, a.id, { tileId: a.rack[0].id, x: 4, y: mid + 2 }, 2000);
  const prem = C.premiumGrid(room.settings.size);
  const ev = eng.evaluate(room, a);
  const [l1, w1] = C.multipliers(prem[mid + 1][4]);
  const [l2, w2] = C.multipliers(prem[mid + 2][4]);
  assert.equal(ev.valid, true);
  assert.equal(ev.score, (C.TILE_SET['к'][1] + l1 + l2) * w1 * w2);
});

test('перекрёстные слова проверяются, недопустимое склеивание отклоняется', () => {
  const { eng, room, a } = setup(2, 'normal');
  clearCenter(room); const mid = putKniga(room, 4);
  room.board[mid + 1][5] = { ch: 'я', pts: 3, blank: false, by: 'p2', tid: 950 }; // справа от будущего «о»
  a.rack = [tile(room, 'о'), tile(room, 'т')];
  eng.beginCapture(room, a.id, { x1: 4, y1: mid, x2: 4, y2: mid + 2 }, 2000);
  eng.place(room, a.id, { tileId: a.rack[0].id, x: 4, y: mid + 1 }, 2000);
  eng.place(room, a.id, { tileId: a.rack[0].id, x: 4, y: mid + 2 }, 2000);
  assert.equal(err(() => eng.commit(room, a.id, 2100)), 'cross_invalid');
});

test('конфликт коммитов: второй игрок проверяется уже по обновлённой доске', () => {
  const { eng, room, a, b } = setup(2, 'normal');
  clearCenter(room); const mid = putKniga(room, 4);
  a.rack = [tile(room, 'о'), tile(room, 'т')];
  b.rack = [tile(room, 'о'), tile(room, 'н')];
  eng.beginCapture(room, a.id, { x1: 4, y1: mid, x2: 4, y2: mid + 2 }, 2000);   // «кот» вниз от к
  eng.beginCapture(room, b.id, { x1: 5, y1: mid, x2: 5, y2: mid + 2 }, 2000);   // «ион?» параллельно, соседняя колонка
  eng.place(room, a.id, { tileId: a.rack[0].id, x: 4, y: mid + 1 }, 2000);
  eng.place(room, a.id, { tileId: a.rack[0].id, x: 4, y: mid + 2 }, 2000);
  eng.place(room, b.id, { tileId: b.rack[0].id, x: 5, y: mid + 1 }, 2000);
  eng.place(room, b.id, { tileId: b.rack[0].id, x: 5, y: mid + 2 }, 2000);
  eng.commit(room, a.id, 2100); // A ходит первым
  const code = err(() => eng.commit(room, b.id, 2101)); // у B слово «инон…» не словарное либо склейка «от» — главное: решение принято по новой доске
  assert.ok(code === 'not_in_dictionary' || code === 'cross_invalid');
  assert.ok(b.capture, 'после ошибки B может исправить слово');
});

test('обмен: нельзя во время захвата и в паузе, нельзя если мешок мал, пауза 15 с', () => {
  const { eng, room, a } = setup();
  clearCenter(room); putKniga(room, 2);
  const ids = a.rack.slice(0, 3).map((t) => t.id);
  eng.beginCapture(room, a.id, { x1: 4, y1: 4, x2: 4, y2: 6 }, 2000);
  assert.equal(err(() => eng.exchange(room, a.id, ids, 2100)), 'busy');
  eng.cancel(room, a.id, 2200);
  assert.equal(err(() => eng.exchange(room, a.id, ids, 2300)), 'cooldown');
  const t = 2200 + C.RULES.cooldownMoveMs;
  const bagBefore = room.bag.length;
  eng.exchange(room, a.id, ids, t);
  assert.equal(a.rack.length, 7);
  assert.equal(room.bag.length, bagBefore);
  assert.equal(a.cooldownUntil, t + C.RULES.cooldownExchangeMs);
  assert.equal(err(() => eng.exchange(room, a.id, ids, t + 20_000)), 'no_tile');
  room.bag.length = 1;
  assert.equal(err(() => eng.exchange(room, a.id, a.rack.slice(0, 2).map((x) => x.id), t + 20_000)), 'bag_small');
});

test('победа по очкам: игра завершается, захваты других отменяются', () => {
  const { eng, room, a, b } = setup();
  clearCenter(room); putKniga(room, 2);
  a.score = room.settings.target - 1;
  eng.beginCapture(room, b.id, { x1: 6, y1: 4, x2: 6, y2: 6 }, 2000);
  a.rack = [tile(room, 'о'), tile(room, 'т')];
  eng.beginCapture(room, a.id, { x1: 2, y1: 4, x2: 2, y2: 6 }, 2000);
  eng.place(room, a.id, { tileId: a.rack[0].id, x: 2, y: 5 }, 2000);
  eng.place(room, a.id, { tileId: a.rack[0].id, x: 2, y: 6 }, 2000);
  eng.commit(room, a.id, 2100);
  assert.equal(room.status, 'finished');
  assert.deepEqual(room.winnerIds, [a.id]);
  assert.equal(b.capture, null);
  assert.equal(room.endReason, 'target');
  assert.equal(err(() => eng.beginCapture(room, b.id, { x1: 2, y1: 4, x2: 2, y2: 6 }, 9000)), 'not_playing');
});

test('лимит времени завершает игру', () => {
  const { eng, room } = setup();
  eng.settle(room, room.endsAt + 1);
  assert.equal(room.status, 'finished');
  assert.equal(room.endReason, 'time');
});

test('лобби: имя уникально, лимит игроков, вход после старта запрещён', () => {
  const dict = new Dictionary(WORDS);
  const eng = new Engine(dict, seeded());
  const room = eng.newRoom('LOBBY', { mode: 'fast', maxPlayers: 2 }, 1);
  eng.addPlayer(room, 'Аня', 1);
  assert.equal(err(() => eng.addPlayer(room, ' аня ', 1)), 'name_taken');
  eng.addPlayer(room, 'Боря', 1);
  assert.equal(err(() => eng.addPlayer(room, 'Вика', 1)), 'full');
  assert.equal(err(() => eng.startGame(room, room.players[1].id, 1)), 'not_host');
  eng.startGame(room, room.hostId, 1);
  assert.equal(err(() => eng.addPlayer(room, 'Гоша', 1)), 'started');
});
