/** Всплывающие уведомления и баннер состояния соединения. */
import { $, h } from "./util.js";
import { S } from "./state.js";

export function toast(text, kind = "") {
  const box = $("#toasts");
  const el = h("div", { class: "toast " + kind }, text);
  box.append(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => el.remove(), kind === "err" ? 5000 : 3500);
}

export function renderBanner() {
  const b = $("#banner");
  const relevant = !!(S.G || S.session);
  if (S.conn !== "online" && relevant) {
    b.hidden = false;
    b.className = "";
    b.textContent =
      S.retry > 1
        ? "Нет соединения. Продолжаем пытаться… Ваше состояние сохранено и восстановится после подключения."
        : "Соединение потеряно, переподключаемся…";
  } else if (S.stale && relevant) {
    b.hidden = false;
    b.className = "info";
    b.textContent = "Загружаем актуальное состояние игры…";
  } else {
    b.hidden = true;
  }
  document.body.classList.toggle("offline", S.conn !== "online" && relevant);
}
