/** Мелкие общие утилиты: DOM-помощники, localStorage, форматирование времени, константы оформления. */

export const $ = (s, r = document) => r.querySelector(s);
export const COLORS = ["#e0502d", "#2f7be0", "#26a269", "#9b59d0"]; // цвета игроков
export const PLABEL = { W: "3С", w: "2С", L: "3Б", l: "2Б", c: "★" }; // подписи премиальных клеток
export const LS = {
  session: "erudit.session",
  name: "erudit.name",
  last: "erudit.last",
};

export function lsGet(k) {
  try {
    return JSON.parse(localStorage.getItem(k));
  } catch {
    return null;
  }
}
export function lsSet(k, v) {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, JSON.stringify(v));
  } catch {
    /* приватный режим */
  }
}

/** Создаёт DOM-элемент: h('div', { class: 'x', onClick: fn }, 'текст', дочерний_элемент). Текст всегда вставляется как text node. */
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "style") el.style.cssText = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on"))
      el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

export const secs = (ms) => Math.max(0, Math.ceil(ms / 1000));
export const fmtClock = (ms) => {
  const s = secs(ms);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
