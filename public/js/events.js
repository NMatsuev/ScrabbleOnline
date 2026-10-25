/** События игры (слово собрано, обмен, выход…): текст для журнала и уведомления. */
import { S, playerById } from "./state.js";
import { toast } from "./notify.js";
import { renderBoard } from "./views/board.js";

export function eventText(e) {
  const nm = (playerById(e.pid) || {}).name || "Игрок";
  switch (e.type) {
    case "start":
      return "Игра началась";
    case "word":
      return `${nm}: «${e.word.toUpperCase()}» +${e.score}${e.bingo ? " (все 7 букв!)" : ""}`;
    case "exchange":
      return `${nm} меняет буквы (${e.count})`;
    case "timeout":
      return `У игрока ${nm} вышло время`;
    case "left":
      return `${nm} вышел из игры`;
    case "end":
      return "Игра окончена";
    default:
      return "";
  }
}

/** Показывает уведомления о новых событиях и подсвечивает только что выложенные буквы. */
export function handleEvents() {
  const evs = S.G.events || [];
  const lastId = evs.length ? evs[evs.length - 1].id : 0;
  if (S.ui.seen == null) {
    S.ui.seen = lastId;
    return;
  }
  const fresh = evs.filter((e) => e.id > S.ui.seen).slice(-3);
  S.ui.seen = lastId;
  for (const e of fresh) {
    const t = eventText(e);
    if (t && e.type !== "end") toast(t, e.type === "word" ? "ok" : "");
    if (e.type === "word" && S.G.size) {
      const until = Date.now() + 1900;
      for (const [x, y] of e.cells) S.ui.flash.set(y * S.G.size + x, until);
      setTimeout(() => S.els && renderBoard(), 1950);
    }
  }
}
