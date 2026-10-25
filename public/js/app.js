/**
 * Точка входа клиента: связывает сетевые события с интерфейсом, выбирает экран и запускает приложение.
 *
 *  util.js, state.js      — утилиты и единое состояние (S)
 *  net.js, api.js         — WebSocket с переподключением, отправка команд
 *  notify.js, events.js   — уведомления, баннер связи, события игры
 *  room.js                — сессия, выход, ссылка-приглашение
 *  actions.js             — действия игрока
 *  views/*.js             — экраны и части интерфейса (вход, лобби, игра, доска, панель, окна)
 */
import { $, h } from "./util.js";
import { S, hooks, indexTiles } from "./state.js";
import { net } from "./api.js";
import { toast, renderBanner } from "./notify.js";
import { handleEvents } from "./events.js";
import { clearSession, saveLast } from "./room.js";
import { installKeyboard } from "./actions.js";
import { buildEntry, renderResults } from "./views/entry.js";
import { renderLobby } from "./views/lobby.js";
import { buildGame, updateGame } from "./views/game.js";
import {
  renderClock,
  tickPlayers,
  tickHint,
  renderControls,
} from "./views/hud.js";

/* ───── выбор экрана ───── */

function render() {
  const screen = !S.G
    ? S.session
      ? "connecting"
      : "entry"
    : S.G.status === "lobby"
      ? "lobby"
      : "game";
  const root = $("#app");
  if (screen !== S.screen) {
    S.screen = screen;
    S.els = null;
    root.replaceChildren();
    $("#modal").replaceChildren();
    if (screen === "entry") buildEntry(root);
    if (screen === "connecting")
      root.append(
        h(
          "main",
          { class: "entry" },
          h("p", { class: "tagline" }, "Возвращаемся в игру…"),
        ),
      );
    if (screen === "entry") {
      fetch("/api/results?limit=6")
        .then((r) => r.json())
        .then((rows) => {
          S.results = rows;
          renderResults();
        })
        .catch(() => {});
    }
  }
  if (screen === "lobby") renderLobby(root);
  if (screen === "game") {
    const key = S.G.code + ":" + S.G.size;
    if (!S.els || S.els.key !== key) buildGame(root, key);
    updateGame();
  }
  renderBanner();
}

/* ───── реакция на сообщения сервера ───── */

hooks.render = render;

hooks.onState = (m) => {
  S.offset = m.now - Date.now();
  const prevHost = S.G && S.G.code === m.game.code ? S.G.hostId : null;
  S.G = m.game;
  S.you = m.you;
  S.stale = false;
  if (
    prevHost &&
    prevHost !== m.game.hostId &&
    m.you &&
    m.game.hostId === m.you.id &&
    m.game.status === "lobby"
  ) {
    toast("Создатель вышел — теперь вы создатель комнаты", "ok");
  }
  S.ui.pend.clear();
  indexTiles();
  handleEvents();
  if (S.G.status !== "finished") S.ui.hideResult = false;
  saveLast();
  render();
};

hooks.onLeft = (m) => {
  clearSession();
  if (m && m.reason === "kicked")
    toast("Создатель комнаты удалил вас из игры", "err");
  render();
};

hooks.onResumeFailed = (err) => {
  clearSession();
  toast(err.message || "Не удалось вернуться в игру", "err");
  render();
};

/* ───── запуск ───── */

// Раз в 250 мс обновляем только таймеры (без перерисовки доски)
setInterval(() => {
  if (S.screen !== "game" || !S.els) return;
  renderClock();
  tickPlayers();
  tickHint();
  renderControls();
}, 250);

fetch("/api/config")
  .then((r) => r.json())
  .then((cfg) => {
    S.cfg = { ...S.cfg, ...cfg };
  })
  .catch(() => {});

installKeyboard();
render();
net.start();
