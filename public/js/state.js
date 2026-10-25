/**
 * Единое состояние клиента (S) и функции-селекторы поверх него.
 * hooks — точки связи, которые заполняет app.js (так модули не импортируют друг друга по кругу).
 */
import { COLORS, LS, lsGet } from "./util.js";

export const FALLBACK_CFG = {
  modes: {
    fast: {
      id: "fast",
      title: "Быстрая",
      size: 9,
      firstWordLen: 3,
      baseTarget: 50,
    },
    normal: {
      id: "normal",
      title: "Обычная",
      size: 13,
      firstWordLen: 5,
      baseTarget: 100,
    },
    long: {
      id: "long",
      title: "Долгая",
      size: 15,
      firstWordLen: 7,
      baseTarget: 180,
    },
  },
  targets: {
    fast: { 2: 50, 3: 45, 4: 40 },
    normal: { 2: 100, 3: 90, 4: 80 },
    long: { 2: 180, 3: 160, 4: 145 },
  },
  rules: {
    rackSize: 7,
    captureMs: 30000,
    cooldownMoveMs: 10000,
    cooldownExchangeMs: 15000,
    bingoBonus: 15,
    minPlayers: 2,
    maxPlayers: 4,
  },
  alphabet: [..."абвгдежзийклмнопрстуфхцчшщъыьэюя"],
};

export const hooks = {
  render() {},
  onState() {},
  onLeft() {},
  onResumeFailed() {},
};

export const S = {
  cfg: FALLBACK_CFG,
  G: null, // общее состояние игры (с сервера)
  you: null, // личное: стойка, предпросмотр
  offset: 0, // серверное время − локальное
  conn: "connecting",
  retry: 0,
  stale: false, // показываем сохранённое состояние, актуальное ещё не пришло
  session: lsGet(LS.session),
  screen: "",
  results: [],
  tileMap: new Map(),
  els: null,
  entry: { mode: "normal", players: 4, code: "" },
  ui: {
    mode: "idle", // idle | selecting
    selStart: null,
    hover: null,
    cursor: null,
    exch: null, // Set выбранных для обмена фишек или null
    blank: null, // { cb } — окно выбора буквы для бланка
    zoom: false,
    pend: new Map(), // оптимистично поставленные фишки до ответа сервера
    flash: new Map(),
    seen: null,
    hideResult: false,
    confirmLeave: false,
  },
};

export const nowMs = () => Date.now() + S.offset;
export const playerById = (id) => S.G && S.G.players.find((p) => p.id === id);
export const colorOf = (id) => {
  const p = playerById(id);
  return p ? COLORS[p.color % COLORS.length] : "transparent";
};
export const getMe = () => (S.G && S.you ? playerById(S.you.id) : null);
export function indexTiles() {
  S.tileMap = new Map(
    (S.G ? S.G.tiles : []).map((t) => [t[0] + "," + t[1], t]),
  );
}
export const segCells = (c) => {
  const out = [];
  if (c.dir === "h") for (let x = c.x1; x <= c.x2; x++) out.push([x, c.y1]);
  else for (let y = c.y1; y <= c.y2; y++) out.push([c.x1, y]);
  return out;
};

/** Клетка, куда встанет следующая буква: выбранная игроком или первая свободная в его отрезке. */
export function effectiveCursor() {
  const me = getMe();
  const ui = S.ui;
  if (!me || !me.capture) return null;
  const free = segCells(me.capture).filter(
    ([x, y]) =>
      !S.tileMap.has(x + "," + y) &&
      !me.capture.placed.some((p) => p[0] === x && p[1] === y) &&
      !ui.pend.has(x + "," + y),
  );
  if (!free.length) return null;
  const cur = ui.cursor;
  if (cur && free.some(([x, y]) => x === cur.x && y === cur.y)) return cur;
  return { x: free[0][0], y: free[0][1] };
}

// Восстановление состояния после перезагрузки страницы
const hashCode = location.hash.replace("#", "").toUpperCase();
if (S.session && hashCode && S.session.room !== hashCode) S.session = null; // ссылка на другую комнату
if (hashCode) S.entry.code = hashCode;
{
  const last = lsGet(LS.last);
  if (S.session && last && last.room === S.session.room && last.G) {
    S.G = last.G;
    S.you = last.you;
    S.stale = true;
    indexTiles();
  }
}
