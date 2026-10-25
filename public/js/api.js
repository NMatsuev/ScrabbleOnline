/** Подключение к серверу: экземпляр Net и обёртка req() для команд игрока. */
import { Net } from "./net.js";
import { LS, lsSet } from "./util.js";
import { S, hooks } from "./state.js";
import { toast, renderBanner } from "./notify.js";

export const net = new Net({
  getSession: () => S.session,
  onStatus(status, attempt) {
    S.conn = status;
    S.retry = attempt || 0;
    renderBanner();
  },
  onJoined(m) {
    S.session = { room: m.room, token: m.token, name: m.name };
    lsSet(LS.session, S.session);
    lsSet(LS.name, m.name);
    history.replaceState(null, "", "#" + m.room);
  },
  onState: (m) => hooks.onState(m),
  onLeft: (m) => hooks.onLeft(m),
  onResumeFailed: (err) => hooks.onResumeFailed(err),
});

/** Отправляет команду; при ошибке показывает сообщение и пробрасывает её дальше. */
export function req(type, payload) {
  return net.request(type, payload).catch((e) => {
    if (e.network) {
      S.ui.pend.clear();
      hooks.render();
    }
    toast(e.message, "err");
    throw e;
  });
}
