/** Модальные окна: выход из игры, выбор буквы для бланка, итоги игры. */
import { $, h, COLORS, fmtClock } from "../util.js";
import { S, playerById } from "../state.js";
import { doLeave } from "../room.js";

const REASONS = {
  target: "Набрано нужное число очков",
  time: "Время игры вышло",
  out_of_tiles: "Буквы в мешке и у игрока закончились",
  abandoned: "Игра заброшена",
  last_player: "Остальные игроки вышли из игры",
};

export function renderModal() {
  const box = $("#modal");
  const { ui, G } = S;
  if (ui.confirmLeave) {
    box.replaceChildren(
      h(
        "div",
        {
          class: "overlay",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "Выход из игры",
          onClick: (e) => {
            if (e.target.classList.contains("overlay")) {
              ui.confirmLeave = false;
              renderModal();
            }
          },
        },
        h(
          "div",
          { class: "dialog" },
          h("h2", {}, "Выйти из игры?"),
          h(
            "p",
            { style: "margin:0" },
            "Вернуться в эту партию будет нельзя: ваш отрезок освободится, а буквы вернутся в мешок. Набранные очки останутся в итогах.",
          ),
          h(
            "div",
            { class: "row" },
            h(
              "button",
              { class: "btn danger", type: "button", onClick: doLeave },
              "Выйти",
            ),
            h(
              "button",
              {
                class: "btn ghost",
                type: "button",
                onClick: () => {
                  ui.confirmLeave = false;
                  renderModal();
                },
              },
              "Остаться",
            ),
          ),
        ),
      ),
    );
    return;
  }
  if (ui.blank) {
    const letters = S.cfg.alphabet.map((l) =>
      h(
        "button",
        {
          type: "button",
          onClick: () => {
            const cb = ui.blank.cb;
            ui.blank = null;
            renderModal();
            cb(l);
          },
        },
        l.toUpperCase(),
      ),
    );
    box.replaceChildren(
      h(
        "div",
        {
          class: "overlay",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "Выбор буквы для бланка",
          onClick: (e) => {
            if (e.target.classList.contains("overlay")) {
              ui.blank = null;
              renderModal();
            }
          },
        },
        h(
          "div",
          { class: "dialog" },
          h("h2", {}, "Какая это буква?"),
          h(
            "p",
            { class: "muted", style: "margin:0" },
            "Бланк станет выбранной буквой, но принесёт 0 очков. После подтверждения слова изменить её нельзя.",
          ),
          h("div", { class: "letters" }, letters),
          h(
            "button",
            {
              class: "btn ghost",
              type: "button",
              onClick: () => {
                ui.blank = null;
                renderModal();
              },
            },
            "Отмена",
          ),
        ),
      ),
    );
    return;
  }
  if (G && G.status === "finished" && G.result && !ui.hideResult) {
    const r = G.result;
    const winners = r.winnerIds
      .map((id) => (playerById(id) || {}).name)
      .filter(Boolean);
    const rows = r.ranking.map((p) =>
      h(
        "tr",
        { style: `--pc:${COLORS[p.color % COLORS.length]}` },
        h("td", { class: "num" }, p.place),
        h(
          "td",
          {},
          h("span", { class: "pn" }),
          p.name,
          p.left ? " (вышел)" : "",
        ),
        h("td", { class: "num" }, h("b", {}, p.score)),
        h("td", { class: "num" }, p.words),
        h(
          "td",
          {},
          p.best ? `${p.best.word.toUpperCase()} (${p.best.score})` : "—",
        ),
        h("td", {}, p.longest ? p.longest.toUpperCase() : "—"),
        h("td", { class: "num" }, p.avg),
        h("td", { class: "num" }, p.bingos),
        h("td", { class: "num" }, p.exchanges),
        h("td", { class: "num" }, p.failed),
      ),
    );
    box.replaceChildren(
      h(
        "div",
        {
          class: "overlay",
          role: "dialog",
          "aria-modal": "true",
          "aria-label": "Итоги игры",
        },
        h(
          "div",
          { class: "dialog" },
          h(
            "div",
            { class: "winner" },
            winners.length === 1
              ? `Победитель: ${winners[0]}`
              : `Ничья: ${winners.join(", ")}`,
          ),
          h(
            "p",
            { class: "muted", style: "margin:0" },
            `${REASONS[r.reason] || ""}. Слов на доске: ${r.words}, длительность: ${fmtClock(r.durationMs)}. Результат сохранён в базе данных.`,
          ),
          h(
            "div",
            { class: "tablewrap" },
            h(
              "table",
              { class: "stats" },
              h(
                "thead",
                {},
                h(
                  "tr",
                  {},
                  [
                    "№",
                    "Игрок",
                    "Очки",
                    "Слов",
                    "Лучшее слово",
                    "Самое длинное",
                    "Среднее",
                    "Бонусов",
                    "Обменов",
                    "Отказов",
                  ].map((t) => h("th", {}, t)),
                ),
              ),
              h("tbody", {}, rows),
            ),
          ),
          h(
            "div",
            { class: "row" },
            h(
              "button",
              { class: "btn", type: "button", onClick: doLeave },
              "Выйти и начать новую",
            ),
            h(
              "button",
              {
                class: "btn ghost",
                type: "button",
                onClick: () => {
                  ui.hideResult = true;
                  renderModal();
                },
              },
              "Смотреть доску",
            ),
          ),
        ),
      ),
    );
    return;
  }
  box.replaceChildren();
  if (G && G.status === "finished" && G.result && S.els && !S.els.resultBtn) {
    S.els.resultBtn = h(
      "button",
      {
        class: "btn ghost wide",
        type: "button",
        onClick: () => {
          ui.hideResult = false;
          renderModal();
        },
      },
      "Показать итоги",
    );
    S.els.actions.append(S.els.resultBtn);
  }
}
