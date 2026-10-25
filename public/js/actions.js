/** Действия игрока: выбор отрезка, постановка букв, подтверждение, отмена, обмен, выход. */
import { S, getMe, segCells, effectiveCursor } from "./state.js";
import { req } from "./api.js";
import { toast } from "./notify.js";
import { doLeave } from "./room.js";
import { renderBoard, renderRack } from "./views/board.js";
import { renderHint, renderControls } from "./views/hud.js";
import { renderModal } from "./views/modals.js";

export function startSelecting() {
  S.ui.mode = "selecting";
  S.ui.selStart = null;
  S.ui.hover = null;
  renderBoard();
  renderHint();
  renderControls();
}
export function stopSelecting() {
  S.ui.mode = "idle";
  S.ui.selStart = null;
  S.ui.hover = null;
  renderBoard();
  renderHint();
  renderControls();
}

/** Нажатие на клетку доски: выбор границ отрезка или выбор/снятие буквы в своём отрезке. */
export function onCell(x, y) {
  const { G, ui } = S;
  const me = getMe();
  if (!me || G.status !== "playing") return;
  const cap = me.capture;
  if (cap) {
    if (!segCells(cap).some(([cx, cy]) => cx === x && cy === y)) return;
    const k = x + "," + y;
    if (cap.placed.some((p) => p[0] === x && p[1] === y) || ui.pend.has(k)) {
      ui.pend.delete(k);
      req("unplace", { x, y }).catch(() => {});
      ui.cursor = { x, y };
    } else if (!S.tileMap.has(k)) {
      ui.cursor = { x, y };
    }
    renderBoard();
    renderRack();
    return;
  }
  if (ui.mode !== "selecting") return;
  if (!ui.selStart) {
    ui.selStart = { x, y };
    renderBoard();
    renderHint();
    return;
  }
  const a = ui.selStart;
  if (a.x === x && a.y === y) {
    ui.selStart = null;
    renderBoard();
    renderHint();
    return;
  }
  ui.selStart = null;
  ui.hover = null;
  req("capture", { x1: a.x, y1: a.y, x2: x, y2: y })
    .then(() => {
      ui.mode = "idle";
    })
    .catch(() => {})
    .finally(() => {
      renderBoard();
      renderHint();
      renderControls();
    });
}

export function onRackTile(id) {
  const t = S.you && S.you.rack.find((r) => r.id === id);
  if (!t) return;
  const { ui } = S;
  const me = getMe();
  if (ui.exch) {
    if (ui.exch.has(t.id)) ui.exch.delete(t.id);
    else ui.exch.add(t.id);
    S.els.rack._sig = null;
    renderRack();
    renderControls();
    return;
  }
  if (!me || !me.capture) {
    toast("Сначала нажмите «Собрать слово» и выберите отрезок на доске");
    return;
  }
  placeTile(t);
}

export function placeTile(t, cellOverride) {
  const me = getMe();
  if (!me || !me.capture) return;
  const cell = cellOverride || effectiveCursor();
  if (!cell) {
    toast("Все клетки заполнены — подтвердите слово");
    return;
  }
  const k = cell.x + "," + cell.y;
  if (
    !segCells(me.capture).some(([x, y]) => x === cell.x && y === cell.y) ||
    S.tileMap.has(k)
  ) {
    toast("Эта клетка вне вашего отрезка или уже занята");
    return;
  }
  if (t.blank) {
    askBlank((letter) => doPlace(t, cell, letter));
    return;
  }
  doPlace(t, cell);
}

export function doPlace(t, cell, letter) {
  S.ui.pend.set(cell.x + "," + cell.y, {
    id: t.id,
    ch: t.blank ? letter : t.ch,
    pts: t.blank ? 0 : t.pts,
    blank: !!t.blank,
  });
  S.ui.cursor = null;
  renderBoard();
  renderRack();
  req("place", { tileId: t.id, x: cell.x, y: cell.y, letter }).catch(() => {});
}

export function placeByLetter(ch) {
  const me = getMe();
  if (!me || !me.capture || !S.you) return;
  const pendIds = new Set([...S.ui.pend.values()].map((v) => v.id));
  const avail = S.you.rack.filter((t) => !pendIds.has(t.id));
  const real = avail.find((t) => !t.blank && t.ch === ch);
  const blank = avail.find((t) => t.blank);
  const cell = effectiveCursor();
  if (!cell) {
    toast("Все клетки заполнены — подтвердите слово (Enter)");
    return;
  }
  if (real) doPlace(real, cell);
  else if (blank) doPlace(blank, cell, ch);
  else toast(`В стойке нет буквы «${ch.toUpperCase()}»`);
}

export function askBlank(cb) {
  S.ui.blank = { cb };
  renderModal();
}

export function commit() {
  req("commit")
    .then(() => {
      if (navigator.vibrate) navigator.vibrate(25);
    })
    .catch(() => {});
}
export function cancelCapture() {
  S.ui.pend.clear();
  S.ui.cursor = null;
  req("cancel").catch(() => {});
}

export function askLeave() {
  if (S.G && S.G.status === "playing") {
    S.ui.confirmLeave = true;
    renderModal();
  } else doLeave();
}

export function openExchange() {
  S.ui.exch = new Set();
  S.els.rack._sig = null;
  renderRack();
  renderControls();
}
export function closeExchange() {
  S.ui.exch = null;
  S.els.rack._sig = null;
  renderRack();
  renderControls();
}
export function doExchange() {
  const ids = [...S.ui.exch];
  req("exchange", { tileIds: ids })
    .then(() => {
      S.ui.exch = null;
      S.els.rack._sig = null;
    })
    .catch(() => {})
    .finally(() => {
      renderRack();
      renderControls();
    });
}

/** Горячие клавиши: буквы, Backspace, Enter, Esc. */
export function installKeyboard() {
  document.addEventListener("keydown", (e) => {
    if (!S.G || S.G.status !== "playing" || S.screen !== "game") return;
    if (e.target.closest && e.target.closest("input,textarea")) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    const me = getMe();
    const ui = S.ui;
    if (e.key === "Escape") {
      if (ui.confirmLeave) {
        ui.confirmLeave = false;
        renderModal();
      } else if (ui.blank) {
        ui.blank = null;
        renderModal();
      } else if (ui.exch) closeExchange();
      else if (me && me.capture) cancelCapture();
      else if (ui.mode === "selecting") stopSelecting();
      return;
    }
    if (!me || !me.capture || ui.blank) return;
    if (e.key === "Enter") {
      e.preventDefault();
      commit();
      return;
    }
    if (e.key === "Backspace") {
      e.preventDefault();
      const cells = segCells(me.capture).reverse();
      const last = cells.find(
        ([x, y]) =>
          me.capture.placed.some((p) => p[0] === x && p[1] === y) ||
          ui.pend.has(x + "," + y),
      );
      if (last) {
        ui.pend.delete(last[0] + "," + last[1]);
        req("unplace", { x: last[0], y: last[1] }).catch(() => {});
        ui.cursor = { x: last[0], y: last[1] };
        renderBoard();
        renderRack();
      }
      return;
    }
    if (e.key.length === 1 && /[а-яёА-ЯЁ]/.test(e.key)) {
      e.preventDefault();
      placeByLetter(e.key.toLowerCase().replace("ё", "е"));
    }
  });
}
