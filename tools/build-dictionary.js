'use strict';
/**
 * Собирает data/dictionary.txt (одно слово в строке) из:
 *   1) tools/seed-*.txt — встроенный стартовый список существительных;
 *   2) любых файлов, переданных аргументами: node tools/build-dictionary.js путь/к/russian_nouns.txt
 *      (строки вида «слово» или «слово частота»; регистр и «ё» не важны).
 * Остаются только слова из русских букв длиной 2–15.
 *
 * Полный словарь существительных можно взять, например, здесь (любой список «одно слово в строке» подойдёт):
 *   https://github.com/Harrix/Russian-Nouns  (russian_nouns.txt)
 *   https://github.com/danakt/russian-words  (russian.txt, windows-1251 → перекодируйте в UTF-8)
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BLACKLIST = new Set('где два ждать бить каждый бесеница коричневый горький нигде тут хоть над'.split(' '));

const words = new Set();
function addFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#')) continue;
    for (const tok of line.trim().split(/\s+/)) {
      const w = tok.toLowerCase().replace(/ё/g, 'е');
      if (/^[а-я]{2,15}$/.test(w) && !BLACKLIST.has(w)) words.add(w);
    }
  }
}

const seeds = fs.readdirSync(__dirname).filter((f) => /^seed-.*\.txt$/.test(f)).sort();
for (const f of seeds) addFile(path.join(__dirname, f));
const extra = process.argv.slice(2);
for (const f of extra) addFile(path.resolve(f));

const out = path.join(ROOT, 'data', 'dictionary.txt');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, [...words].sort().join('\n') + '\n');
console.log(`Словарь собран: ${words.size} слов → ${path.relative(ROOT, out)} (встроенных файлов: ${seeds.length}, внешних: ${extra.length})`);
