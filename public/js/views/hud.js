/** Информационная панель: цели, часы, игроки, подсказка/предпросмотр слова, кнопки, журнал. */
import { h, secs, fmtClock, COLORS } from "../util.js";
import { S, nowMs, getMe, colorOf } from "../state.js";
import { net } from "../api.js";
import { eventText } from "../events.js";

export function renderTop() {
  const { G, els } = { G: S.G, els: S.els };
  els.goal.textContent = `До ${G.target} очков`;
  els.bag.textContent = `В мешке: ${G.bag}`;
  renderClock();
}

export function renderClock() {
  const G = S.G;
  const el = S.els.clock;
  el.textContent =
    G.status === "playing"
      ? `Осталось ${fmtClock(G.endsAt - nowMs())}`
      : "Игра окончена";
}

function playerStatus(p) {
  const G = S.G;
  if (p.left) return "вышел из игры";
  if (G.status === "finished") return "";
  if (!p.connected) return "не в сети";
  if (p.capture)
    return `собирает слово, ${secs(p.capture.deadline - nowMs())} с`;
  const cd = p.cooldownUntil - nowMs();
  if (cd > 0)
    return `${p.cooldownKind === "exchange" ? "обмен" : "пауза"} ${secs(cd)} с`;
  return "готов";
}

export function renderPlayers() {
  const G = S.G;
  const me = getMe();
  S.els.players.replaceChildren(
    ...G.players.map((p) => {
      const pct = Math.min(100, Math.round((p.score / G.target) * 100));
      return h(
        "div",
        {
          class:
            "prow" +
            (p.capture ? " capturing" : "") +
            (!p.connected ? " offline" : ""),
          style: `--pc:${COLORS[p.color % COLORS.length]};--prog:${pct}%`,
          dataset: { pid: p.id },
        },
        h(
          "div",
          { class: "nm" },
          p.name,
          me && p.id === me.id ? h("small", {}, "вы") : null,
        ),
        h("div", { class: "sc" }, p.score),
        h("div", { class: "st" }, playerStatus(p)),
      );
    }),
  );
}

export function tickPlayers() {
  for (const p of S.G.players) {
    const el = S.els.players.querySelector(`[data-pid="${p.id}"] .st`);
    if (el) {
      const t = playerStatus(p);
      if (el.textContent !== t) el.textContent = t;
    }
  }
}

function setText(el, t) {
  if (el.textContent !== t) el.textContent = t;
}

export function renderControls() {
  const { G, ui, els } = S;
  const me = getMe();
  const playing = G.status === "playing" && !!me;
  const cap = playing && me.capture;
  const online = net.open;
  const cd = me ? Math.max(0, me.cooldownUntil - nowMs()) : 0;
  const selecting = playing && !cap && ui.mode === "selecting";
  const idle = playing && !cap && !selecting && !ui.exch;
  els.btnCapture.hidden = !idle;
  els.btnExchange.hidden = !idle;
  els.btnCommit.hidden = !cap;
  els.btnCancel.hidden = !cap;
  els.btnSel.hidden = !selecting;
  els.exch.hidden = !(playing && !cap && ui.exch);
  els.btnCapture.disabled = cd > 0 || !online;
  setText(els.btnCapture, cd > 0 ? `Пауза ${secs(cd)} с` : "Собрать слово");
  els.btnExchange.disabled = cd > 0 || !online || G.bag < 1;
  els.btnCommit.disabled = !online;
  els.btnCancel.disabled = !online;
  if (ui.exch) {
    const k = ui.exch.size;
    els.exchGo.disabled = !k || !online || G.bag < k || cd > 0;
    setText(els.exchGo, k ? `Обменять (${k})` : "Обменять");
    setText(
      els.exchInfo,
      cd > 0
        ? `Подождите ${secs(cd)} с. `
        : `Выберите буквы выше (в мешке ${G.bag}). После обмена пауза ${secs(S.cfg.rules.cooldownExchangeMs)} с.`,
    );
  }
}

export function renderHint() {
  const { G, els, you } = S;
  const me = getMe();
  const m = els.hintMain;
  els.bar.style.width = "0";
  if (G.status === "finished") {
    m.replaceChildren(
      h(
        "div",
        { class: "hint-text" },
        "Игра окончена. Итоги — в окне результатов.",
      ),
    );
    return;
  }
  if (me && me.capture && you && you.preview) {
    const pv = you.preview;
    const msg = pv.valid
      ? pv.parts.length > 1
        ? "Слово принято: " +
          pv.parts.map((p) => `${p.word} +${p.score}`).join(", ") +
          (pv.bingo ? `, бонус +${S.cfg.rules.bingoBonus}` : "")
        : "Слово есть в словаре — подтверждайте!" +
          (pv.bingo ? ` Бонус +${S.cfg.rules.bingoBonus} за все буквы.` : "")
      : pv.complete
        ? pv.error
        : "Нажимайте буквы в стойке (или печатайте), чтобы заполнить пустые клетки.";
    const parts = [
      h(
        "div",
        { class: "pv-word" },
        [...pv.pattern].map((c) =>
          h("span", { class: c === "·" ? "gap" : "" }, c),
        ),
      ),
      pv.valid
        ? h("div", { class: "pv-score" }, "+" + pv.score)
        : h(
            "div",
            { class: "pv-time" },
            h(
              "span",
              { dataset: { t: "cap" } },
              secs(me.capture.deadline - nowMs()),
            ),
            " с",
          ),
      h(
        "div",
        { class: "pv-msg " + (pv.valid ? "good" : pv.complete ? "bad" : "") },
        msg,
      ),
    ];
    if (pv.valid)
      parts.push(
        h(
          "div",
          { class: "pv-time", style: "grid-column:1/-1" },
          "Осталось ",
          h(
            "span",
            { dataset: { t: "cap" } },
            secs(me.capture.deadline - nowMs()),
          ),
          " с",
        ),
      );
    m.replaceChildren(...parts);
    return;
  }
  if (S.ui.mode === "selecting") {
    m.replaceChildren(
      h(
        "div",
        { class: "hint-text", style: "grid-column:1/-1" },
        S.ui.selStart
          ? "Теперь нажмите последнюю клетку отрезка — по горизонтали или вертикали."
          : "Нажмите первую клетку отрезка. Он должен пройти хотя бы через одну букву на доске.",
      ),
    );
    return;
  }
  const cd = me ? me.cooldownUntil - nowMs() : 0;
  if (cd > 0) {
    m.replaceChildren(
      h(
        "div",
        { class: "hint-text", style: "grid-column:1/-1" },
        me.cooldownKind === "exchange" ? "Пауза после обмена: " : "Пауза: ",
        h("b", { dataset: { t: "cd" } }, secs(cd)),
        " с",
      ),
    );
    return;
  }
  m.replaceChildren(
    h(
      "div",
      { class: "hint-text", style: "grid-column:1/-1" },
      "Нажмите «Собрать слово», чтобы занять отрезок на доске. Играем одновременно — успевайте первыми!",
    ),
  );
}

export function tickHint() {
  const { G, els } = S;
  const me = getMe();
  if (!me || G.status !== "playing") return;
  if (me.capture) {
    const left = me.capture.deadline - nowMs();
    els.hint
      .querySelectorAll('[data-t="cap"]')
      .forEach((e) => setText(e, String(secs(left))));
    els.bar.style.width =
      Math.max(0, Math.min(100, (left / S.cfg.rules.captureMs) * 100)) + "%";
    return;
  }
  const cd = me.cooldownUntil - nowMs();
  const total =
    me.cooldownKind === "exchange"
      ? S.cfg.rules.cooldownExchangeMs
      : S.cfg.rules.cooldownMoveMs;
  const e = els.hint.querySelector('[data-t="cd"]');
  if (cd > 0 && e) {
    setText(e, String(secs(cd)));
    els.bar.style.width = Math.min(100, (cd / total) * 100) + "%";
  } else if (cd <= 0 && e) renderHint();
}

export function renderLog() {
  const G = S.G;
  const items = G.events
    .filter((e) => eventText(e))
    .slice(-12)
    .reverse();
  S.els.logList.replaceChildren(
    ...items.map((e) =>
      h("li", { style: e.pid ? `--pc:${colorOf(e.pid)}` : "" }, eventText(e)),
    ),
  );
}
