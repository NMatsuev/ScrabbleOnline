"use strict";
const fs = require("fs");
const C = require("./config");

/** Приводим слово к виду, в котором хранятся фишки: строчные, «ё» → «е». */
function normalize(word) {
  return String(word).trim().toLowerCase().replace(/ё/g, "е");
}

class Dictionary {
  constructor(words) {
    this.set = new Set();
    for (const raw of words) {
      const w = normalize(raw);
      if (/^[а-я]{2,15}$/.test(w)) this.set.add(w);
    }
    this.starters = new Map(); // длина → кандидаты для первого слова
  }

  static fromFile(file) {
    const text = fs.readFileSync(file, "utf8");
    const words = [];
    for (const line of text.split(/\r?\n/)) {
      const token = line.trim().split(/\s+/)[0];
      if (token && !token.startsWith("#")) words.push(token);
    }
    return new Dictionary(words);
  }

  get size() {
    return this.set.size;
  }

  has(word) {
    return this.set.has(word);
  }

  /** Случайное слово заданной длины из «лёгких» букв — для автоматического первого слова. */
  randomStarter(len, rng = Math.random) {
    let list = this.starters.get(len);
    if (!list) {
      list = [];
      for (const w of this.set) {
        if (w.length !== len) continue;
        let ok = true;
        for (const ch of w) {
          const t = C.TILE_SET[ch];
          if (!t || t[1] > 3 || ch === "ъ") {
            ok = false;
            break;
          }
        }
        if (ok) list.push(w);
      }
      this.starters.set(len, list);
    }
    if (!list.length) return null;
    return list[Math.floor(rng() * list.length)];
  }
}

module.exports = { Dictionary, normalize };
