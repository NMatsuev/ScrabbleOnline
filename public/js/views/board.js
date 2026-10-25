/** Отрисовка доски и стойки. Клики и перетаскивание обрабатываются в views/game.js (делегирование событий). */
import { h, PLABEL } from "../util.js";
import { S, getMe, colorOf, segCells, effectiveCursor } from "../state.js";

function tileEl(o, cls, byColor, pc) {
  const style = (byColor ? `--by:${byColor};` : "") + (pc ? `--pc:${pc};` : "");
  return h(
    "span",
    { class: "tile " + cls + (o.blank ? " blank" : ""), style },
    h("b", {}, o.ch.toUpperCase()),
    o.blank || !o.pts ? null : h("i", {}, o.pts),
  );
}

export function renderBoard() {
  const { G, ui, els } = S;
  const n = G.size;
  const me = getMe();
  const info = Array.from({ length: n * n }, () => ({}));
  for (const [x, y, ch, pts, blank, by] of G.tiles)
    info[y * n + x].tile = { ch, pts, blank, by };
  for (const p of G.players) {
    const c = p.capture;
    if (!c) continue;
    const cells = segCells(c);
    cells.forEach(([x, y], i) => {
      info[y * n + x].seg = {
        pid: p.id,
        dir: c.dir,
        first: i === 0,
        last: i === cells.length - 1,
      };
    });
    for (const [x, y, ch, pts, blank] of c.placed)
      info[y * n + x].tent = { pid: p.id, ch, pts, blank };
  }
  if (me) {
    for (const [k, v] of ui.pend) {
      const [x, y] = k.split(",").map(Number);
      info[y * n + x].tent = {
        pid: me.id,
        ch: v.ch,
        pts: v.pts,
        blank: v.blank,
      };
    }
  }
  const cur = effectiveCursor();
  const hl = new Set();
  if (
    ui.selStart &&
    ui.hover &&
    (ui.selStart.x === ui.hover.x || ui.selStart.y === ui.hover.y)
  ) {
    const { x: ax, y: ay } = ui.selStart;
    const { x: bx, y: by } = ui.hover;
    for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++)
      for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++)
        hl.add(y * n + x);
  }
  const t = Date.now();
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x;
      const o = info[i];
      const el = els.cells[i];
      const prem = G.premium[y][x];
      let cls = "cell p-" + (prem === "." ? "n" : prem);
      let style = "";
      if (o.seg) {
        cls += ` seg seg-${o.seg.dir}${o.seg.first ? " seg-first" : ""}${o.seg.last ? " seg-last" : ""}${me && o.seg.pid === me.id ? " seg-mine" : ""}`;
        style = `--pc:${colorOf(o.seg.pid)};`;
      }
      if (cur && cur.x === x && cur.y === y) cls += " cursor";
      if (ui.selStart && ui.selStart.x === x && ui.selStart.y === y)
        cls += " selstart";
      if (hl.has(i)) cls += " hl";
      if ((ui.flash.get(i) || 0) > t) cls += " flash";
      let sig = cls + style;
      let content;
      if (o.tile) {
        sig += `|t${o.tile.ch}${o.tile.pts}${o.tile.blank}${o.tile.by}`;
        content = () => tileEl(o.tile, "", o.tile.by ? colorOf(o.tile.by) : "");
      } else if (o.tent) {
        sig += `|e${o.tent.ch}${o.tent.pts}${o.tent.blank}${o.tent.pid}`;
        content = () => tileEl(o.tent, "tent", "", colorOf(o.tent.pid));
      } else if (PLABEL[prem]) {
        sig += "|p";
        content = () => h("span", { class: "plabel" }, PLABEL[prem]);
      } else content = null;
      if (el._sig === sig) continue;
      el._sig = sig;
      el.className = cls;
      el.style.cssText = style;
      el.replaceChildren(...(content ? [content()] : []));
    }
  }
}

export function renderRack() {
  const { ui, els, G, you } = S;
  const me = getMe();
  const pendIds = new Set([...ui.pend.values()].map((v) => v.id));
  const tiles = you ? you.rack.filter((t) => !pendIds.has(t.id)) : [];
  const sig = JSON.stringify([
    tiles.map((t) => t.id + t.ch),
    ui.exch ? [...ui.exch] : null,
    !!(me && me.capture),
    G.status,
  ]);
  if (els.rack._sig === sig) return;
  els.rack._sig = sig;
  const canDrag = !!(me && me.capture);
  els.rack.replaceChildren(
    ...(tiles.length
      ? tiles.map((t) =>
          h(
            "button",
            {
              class:
                "rtile" +
                (t.blank ? " blank" : "") +
                (ui.exch && ui.exch.has(t.id) ? " picked" : ""),
              type: "button",
              draggable: canDrag ? "true" : null,
              dataset: { id: t.id },
              "aria-label": t.blank
                ? "Бланк, любая буква"
                : `Буква ${t.ch.toUpperCase()}, ${t.pts} очк.`,
            },
            h("b", {}, t.blank ? "✦" : t.ch.toUpperCase()),
            t.blank ? null : h("i", {}, t.pts),
          ),
        )
      : [
          h(
            "span",
            { class: "empty-rack" },
            G.status === "playing" ? "Стойка пуста" : "",
          ),
        ]),
  );
}
