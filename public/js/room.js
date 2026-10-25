/** Сессия и комната: запоминание состояния, выход, ссылка-приглашение. */
import { $, h, LS, lsSet } from "./util.js";
import { S, hooks } from "./state.js";
import { req } from "./api.js";
import { toast, renderBanner } from "./notify.js";

export function clearSession() {
  S.session = null;
  S.G = null;
  S.you = null;
  S.stale = false;
  lsSet(LS.session, null);
  lsSet(LS.last, null);
  history.replaceState(null, "", location.pathname);
  S.entry.code = "";
  Object.assign(S.ui, {
    mode: "idle",
    selStart: null,
    cursor: null,
    exch: null,
    blank: null,
    hideResult: false,
    seen: null,
    confirmLeave: false,
  });
  $("#modal").replaceChildren();
  S.ui.pend.clear();
  renderBanner();
}

let saveTimer = null;
/** Копия последнего состояния в localStorage — чтобы страница не была пустой без сети. */
export function saveLast() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (S.G && S.session)
      lsSet(LS.last, { room: S.G.code, G: S.G, you: S.you });
  }, 800);
}

export function doLeave() {
  const finished = !!S.G && S.G.status === "finished";
  S.ui.confirmLeave = false;
  req("leave").catch(() => {
    if (finished) {
      clearSession();
      hooks.render();
    }
  });
}

export function copyLink() {
  const url = `${location.origin}/#${S.G.code}`;
  const done = () => toast("Ссылка скопирована — отправьте её друзьям", "ok");
  if (navigator.clipboard && window.isSecureContext)
    navigator.clipboard.writeText(url).then(done, () => toast(url));
  else {
    const t = h("textarea", { style: "position:fixed;opacity:0" }, url);
    document.body.append(t);
    t.select();
    try {
      document.execCommand("copy");
      done();
    } catch {
      toast(url);
    }
    t.remove();
  }
}
