"use strict";
/**
 * Все числовые правила игры собраны здесь, чтобы их можно было менять в одном месте.
 */

const RULES = Object.freeze({
  rackSize: 7, // букв в стойке
  captureMs: 30_000, // максимум времени на сбор слова
  cooldownMoveMs: 10_000, // пауза после отмены / тайм-аута
  cooldownExchangeMs: 15_000, // пауза после обмена букв
  bingoBonus: 15, // бонус, если за ход выложены все 7 букв стойки
  minPlayers: 2,
  maxPlayers: 4,
  minWordLen: 2,
});

/**
 * Режимы длительности. Для каждого — свой размер доски,
 * базовое число очков для победы и страховочный лимит времени.
 */
const MODES = Object.freeze({
  fast: {
    id: "fast",
    title: "Быстрая",
    size: 9,
    firstWordLen: 5,
    baseTarget: 50,
    timeLimitMin: 15,
  },
  normal: {
    id: "normal",
    title: "Обычная",
    size: 13,
    firstWordLen: 7,
    baseTarget: 100,
    timeLimitMin: 30,
  },
  long: {
    id: "long",
    title: "Долгая",
    size: 15,
    firstWordLen: 9,
    baseTarget: 180,
    timeLimitMin: 60,
  },
});

/** Очки для победы зависят от режима и числа игроков (чем больше игроков, тем меньше нужно каждому). */
function targetFor(modeId, players) {
  const m = MODES[modeId];
  const k = Math.min(RULES.maxPlayers, Math.max(RULES.minPlayers, players));
  return Math.round((m.baseTarget * (1 - 0.1 * (k - 2))) / 5) * 5;
}

/** Классический набор фишек русского «Эрудита»: буква → [количество, очки]. Буквы «ё» нет: она играет как «е». */
const TILE_SET = Object.freeze({
  а: [8, 1],
  б: [2, 3],
  в: [4, 2],
  г: [2, 3],
  д: [4, 2],
  е: [8, 1],
  ж: [1, 5],
  з: [2, 5],
  и: [5, 1],
  й: [1, 4],
  к: [4, 2],
  л: [4, 2],
  м: [3, 2],
  н: [5, 1],
  о: [10, 1],
  п: [4, 2],
  р: [5, 1],
  с: [5, 1],
  т: [5, 1],
  у: [4, 2],
  ф: [1, 10],
  х: [1, 5],
  ц: [1, 5],
  ч: [1, 5],
  ш: [1, 8],
  щ: [1, 10],
  ъ: [1, 10],
  ы: [2, 4],
  ь: [2, 3],
  э: [1, 8],
  ю: [1, 8],
  я: [2, 3],
});
const BLANKS = 3;
const ALPHABET = Object.keys(TILE_SET);

/**
 * Премиальные клетки задаются одной четвертью доски (от угла до центра).
 *  . обычная   l ×2 буква   L ×3 буква   w ×2 слово   W ×3 слово   c центр (×2 слово + старт)
 * Остальные три четверти получаются симметрией.
 */
const QUARTERS = {
  9: ["W..l.", ".w..L", "..w..", "l..L.", ".L..c"],
  13: [
    "W..l..W",
    ".w...L.",
    "..w.l..",
    "l..w..l",
    "..l.L..",
    ".L...L.",
    "W..l..c",
  ],
  15: [
    "W..l...W",
    ".w...L..",
    "..w...l.",
    "l..w...l",
    "....w...",
    ".L...L..",
    "..l...l.",
    "W..l...c",
  ],
};

const premiumCache = new Map();
function premiumGrid(n) {
  if (premiumCache.has(n)) return premiumCache.get(n);
  const q = QUARTERS[n];
  if (!q) throw new Error("Нет раскладки премиальных клеток для доски " + n);
  const rows = [];
  for (let y = 0; y < n; y++) {
    let row = "";
    for (let x = 0; x < n; x++) {
      const a = Math.min(y, n - 1 - y);
      const b = Math.min(x, n - 1 - x);
      row += q[a][b];
    }
    rows.push(row);
  }
  premiumCache.set(n, rows);
  return rows;
}

/** [множитель буквы, множитель слова] для кода премиальной клетки. */
function multipliers(code) {
  switch (code) {
    case "l":
      return [2, 1];
    case "L":
      return [3, 1];
    case "w":
    case "c":
      return [1, 2];
    case "W":
      return [1, 3];
    default:
      return [1, 1];
  }
}

/** Запасные слова на случай, если в словаре не нашлось подходящего первого слова. */
const FALLBACK_STARTERS = {
  5: [
    "книга",
    "слово",
    "стена",
    "ветер",
    "земля",
    "птица",
    "кошка",
    "гроза",
    "лампа",
  ],
  7: ["коробка", "корзина", "картина", "морковь", "пингвин"],
  9: ["коробочка", "картофель", "морковина", "корзинщик", "пингвинка"],
};

module.exports = {
  RULES,
  MODES,
  targetFor,
  TILE_SET,
  BLANKS,
  ALPHABET,
  premiumGrid,
  multipliers,
  FALLBACK_STARTERS,
};
