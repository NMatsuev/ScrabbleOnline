/** Экран входа: имя, создание комнаты, вход по коду, правила, недавние игры. */
import { $, h, LS, lsGet } from "../util.js";
import { S } from "../state.js";
import { req } from "../api.js";
import { toast } from "../notify.js";

function logoTiles() {
  const pts = { Э: 8, Р: 1, У: 2, Д: 2, И: 1, Т: 1 };
  return h(
    "div",
    { class: "logo", "aria-label": "Эрудит" },
    [..."ЭРУДИТ"].map((c) =>
      h("div", { class: "tile-glyph" }, c, h("i", {}, pts[c])),
    ),
  );
}

export function buildEntry(root) {
  const cfg = S.cfg;
  const e = S.entry;
  const nameInput = h("input", {
    class: "field",
    id: "name",
    maxlength: 16,
    placeholder: "Как вас называть?",
    value: lsGet(LS.name) || "",
    autocomplete: "nickname",
  });
  const codeInput = h("input", {
    class: "field",
    id: "code",
    maxlength: 5,
    placeholder: "Код комнаты",
    value: e.code,
    autocapitalize: "characters",
    autocomplete: "off",
    style: "text-transform:uppercase;letter-spacing:.2em;font-weight:700",
  });

  const modeBtns = Object.values(cfg.modes).map((m) =>
    h(
      "button",
      {
        class: "opt",
        type: "button",
        "aria-pressed": String(e.mode === m.id),
        dataset: { mode: m.id },
        onClick: () => {
          e.mode = m.id;
          refreshOpts();
        },
      },
      h("b", {}, m.title),
      h("small", { dataset: { sub: m.id } }),
    ),
  );
  const playerBtns = [2, 3, 4].map((n) =>
    h(
      "button",
      {
        class: "opt",
        type: "button",
        "aria-pressed": String(e.players === n),
        dataset: { players: n },
        onClick: () => {
          e.players = n;
          refreshOpts();
        },
      },
      h("b", {}, n + " игрока"),
      h("small", {}, n === 2 ? "дуэль" : n === 3 ? "втроём" : "до четырёх"),
    ),
  );
  function refreshOpts() {
    modeBtns.forEach((b) => {
      const m = cfg.modes[b.dataset.mode];
      b.setAttribute("aria-pressed", String(e.mode === m.id));
      b.querySelector("small").textContent =
        `доска ${m.size}×${m.size}, до ${cfg.targets[m.id][e.players]} очков`;
    });
    playerBtns.forEach((b) =>
      b.setAttribute(
        "aria-pressed",
        String(e.players === Number(b.dataset.players)),
      ),
    );
  }

  const getName = () => {
    const v = nameInput.value.trim();
    if (!v) {
      toast("Введите имя", "err");
      nameInput.focus();
      return null;
    }
    return v;
  };
  const create = h(
    "button",
    {
      class: "btn big",
      type: "button",
      onClick: () => {
        const name = getName();
        if (!name) return;
        req("create", { name, mode: e.mode, maxPlayers: e.players }).catch(
          () => {},
        );
      },
    },
    "Создать комнату",
  );
  const join = h(
    "button",
    {
      class: "btn big",
      type: "button",
      onClick: () => {
        const name = getName();
        if (!name) return;
        const code = codeInput.value.trim().toUpperCase();
        if (code.length < 4) {
          toast("Введите код комнаты", "err");
          codeInput.focus();
          return;
        }
        req("join", { room: code, name }).catch(() => {});
      },
    },
    "Войти",
  );
  codeInput.addEventListener("input", () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
    e.code = codeInput.value;
  });

  const R = cfg.rules;
  const rules = h(
    "details",
    { class: "panel rules" },
    h("summary", {}, "Как играть"),
    h(
      "ul",
      {},
      h(
        "li",
        {},
        "Первое слово появляется в центре доски само (3, 5 или 7 букв — зависит от длительности). Дальше все играют одновременно, по очереди ходить не нужно.",
      ),
      h(
        "li",
        {},
        `Нажмите «Собрать слово» и отметьте на доске первую и последнюю клетки отрезка. Отрезок обязан пройти хотя бы через одну букву, уже лежащую на доске. Клетки, которые заняли другие, выбрать нельзя.`,
      ),
      h(
        "li",
        {},
        `Поставьте буквы из стойки в пустые клетки (на телефоне — нажимайте буквы, на компьютере можно печатать с клавиатуры) и подтвердите. На всё есть ${R.captureMs / 1000} секунд, отменить сбор можно в любой момент.`,
      ),
      h(
        "li",
        {},
        `После удачного слова паузы нет. Если вы отменили сбор или время вышло, нужно подождать ${R.cooldownMoveMs / 1000} секунд. Обмен букв доступен вне сбора слова и даёт паузу ${R.cooldownExchangeMs / 1000} секунд.`,
      ),
      h(
        "li",
        {},
        "Слово должно быть в словаре (существительное в именительном падеже). Буквы, соседние с вашими, тоже образуют слова — они тоже проверяются и приносят очки.",
      ),
      h(
        "li",
        {},
        `Бланк (✦) — любая буква, но 0 очков. Если выложить все ${R.rackSize} букв стойки сразу, бонус +${R.bingoBonus}.`,
      ),
      h(
        "li",
        {},
        "Игра идёт до заданного числа очков; кто набрал первым — победил. Если время игры вышло или кончились буквы, побеждает лидер.",
      ),
      h(
        "li",
        {},
        "Клетки: 2Б/3Б — буква ×2/×3, 2С/3С — слово ×2/×3, ★ — центр (×2 слово).",
      ),
    ),
  );

  root.append(
    h(
      "main",
      { class: "entry" },
      logoTiles(),
      h(
        "p",
        { class: "tagline" },
        "Русский «Эрудит» онлайн: все играют одновременно",
      ),
      h(
        "section",
        { class: "panel stack" },
        h(
          "div",
          {},
          h("label", { class: "lab", for: "name" }, "Ваше имя"),
          nameInput,
        ),
      ),
      h(
        "section",
        { class: "panel stack", id: "sec-create" },
        h("h2", {}, "Новая игра"),
        h(
          "div",
          {},
          h("div", { class: "lab" }, "Длительность"),
          h("div", { class: "seg-row three" }, modeBtns),
        ),
        h(
          "div",
          {},
          h("div", { class: "lab" }, "Игроков не больше"),
          h("div", { class: "seg-row three-p" }, playerBtns),
        ),
        create,
      ),
      h(
        "section",
        { class: "panel stack", id: "sec-join" },
        h("h2", {}, "Войти по коду"),
        h(
          "div",
          { class: "row" },
          h("div", { class: "grow" }, codeInput),
          join,
        ),
      ),
      rules,
      h("section", { class: "panel", id: "recent" }),
    ),
  );
  refreshOpts();
  renderResults();
  if (e.code)
    setTimeout(() => (lsGet(LS.name) ? codeInput : nameInput).focus(), 50);
}

export function renderResults() {
  const box = $("#recent");
  if (!box) return;
  const rows = S.results || [];
  box.replaceChildren(
    h("h2", { style: "font-size:1.1rem;margin-bottom:6px" }, "Недавние игры"),
  );
  if (!rows.length) {
    box.append(
      h(
        "p",
        { class: "muted", style: "margin:0" },
        "Пока нет завершённых игр. Результаты сохраняются в базе данных.",
      ),
    );
    return;
  }
  box.append(
    h(
      "ul",
      { class: "recent" },
      rows.map((r) => {
        const d = new Date(r.finishedAt);
        const top = r.ranking.map((p) => `${p.name} ${p.score}`).join(", ");
        return h(
          "li",
          {},
          h(
            "b",
            {},
            r.winners.length === 1 ? "Победил " + r.winners[0] : "Ничья",
          ),
          h("span", { class: "muted" }, top),
          h(
            "span",
            { class: "muted" },
            `${S.cfg.modes[r.mode] ? S.cfg.modes[r.mode].title : r.mode} ${r.size}×${r.size}, ${d.toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })}`,
          ),
        );
      }),
    ),
  );
}
