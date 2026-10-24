import { Net } from './net.js';

/* ───────────────────────── утилиты ───────────────────────── */

const $ = (s, r = document) => r.querySelector(s);
const COLORS = ['#e0502d', '#2f7be0', '#26a269', '#9b59d0'];
const PLABEL = { W: '3С', w: '2С', L: '3Б', l: '2Б', c: '★' };
const LS = { session: 'erudit.session', name: 'erudit.name', last: 'erudit.last' };
const FALLBACK_CFG = {
  modes: {
    fast: { id: 'fast', title: 'Быстрая', size: 9, firstWordLen: 3, baseTarget: 50 },
    normal: { id: 'normal', title: 'Обычная', size: 13, firstWordLen: 5, baseTarget: 100 },
    long: { id: 'long', title: 'Долгая', size: 15, firstWordLen: 7, baseTarget: 180 },
  },
  targets: { fast: { 2: 50, 3: 45, 4: 40 }, normal: { 2: 100, 3: 90, 4: 80 }, long: { 2: 180, 3: 160, 4: 145 } },
  rules: { rackSize: 7, captureMs: 30000, cooldownMoveMs: 10000, cooldownExchangeMs: 15000, bingoBonus: 15, minPlayers: 2, maxPlayers: 4 },
  alphabet: [...'абвгдежзийклмнопрстуфхцчшщъыьэюя'],
};

function lsGet(k) { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } }
function lsSet(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* приватный режим */ } }

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style') el.style.cssText = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

/* ───────────────────────── состояние ───────────────────────── */

const S = {
  cfg: FALLBACK_CFG,
  G: null,            // общее состояние игры (с сервера)
  you: null,          // личное: стойка, предпросмотр
  offset: 0,          // серверное время − локальное
  conn: 'connecting',
  retry: 0,
  stale: false,       // показываем сохранённое состояние, актуальное ещё не пришло
  session: lsGet(LS.session),
  screen: '',
  results: [],
  tileMap: new Map(),
  els: null,
  entry: { mode: 'normal', players: 4, code: '' },
  ui: {
    mode: 'idle',     // idle | selecting
    selStart: null, hover: null, cursor: null,
    exch: null,       // Set выбранных для обмена фишек или null
    blank: null,      // { cb } — окно выбора буквы для бланка
    zoom: false,
    pend: new Map(),  // оптимистично поставленные фишки до ответа сервера
    flash: new Map(),
    seen: null,
    hideResult: false,
    confirmLeave: false,
  },
};

const hashCode = location.hash.replace('#', '').toUpperCase();
if (S.session && hashCode && S.session.room !== hashCode) S.session = null; // ссылка на другую комнату
if (hashCode) S.entry.code = hashCode;
{
  const last = lsGet(LS.last);
  if (S.session && last && last.room === S.session.room && last.G) {
    S.G = last.G; S.you = last.you; S.stale = true; indexTiles();
  }
}

const nowMs = () => Date.now() + S.offset;
const secs = (ms) => Math.max(0, Math.ceil(ms / 1000));
const fmtClock = (ms) => { const s = secs(ms); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const playerById = (id) => S.G && S.G.players.find((p) => p.id === id);
const colorOf = (id) => { const p = playerById(id); return p ? COLORS[p.color % COLORS.length] : 'transparent'; };
const getMe = () => (S.G && S.you ? playerById(S.you.id) : null);
function indexTiles() { S.tileMap = new Map((S.G ? S.G.tiles : []).map((t) => [t[0] + ',' + t[1], t])); }
const segCells = (c) => {
  const out = [];
  if (c.dir === 'h') for (let x = c.x1; x <= c.x2; x++) out.push([x, c.y1]);
  else for (let y = c.y1; y <= c.y2; y++) out.push([c.x1, y]);
  return out;
};

/* ───────────────────────── сеть ───────────────────────── */

const net = new Net({
  getSession: () => S.session,
  onStatus(status, attempt) { S.conn = status; S.retry = attempt || 0; renderBanner(); },
  onJoined(m) {
    S.session = { room: m.room, token: m.token, name: m.name };
    lsSet(LS.session, S.session);
    lsSet(LS.name, m.name);
    history.replaceState(null, '', '#' + m.room);
  },
  onState(m) {
    S.offset = m.now - Date.now();
    const prevHost = S.G && S.G.code === m.game.code ? S.G.hostId : null;
    S.G = m.game; S.you = m.you; S.stale = false;
    if (prevHost && prevHost !== m.game.hostId && m.you && m.game.hostId === m.you.id && m.game.status === 'lobby') {
      toast('Создатель вышел — теперь вы создатель комнаты', 'ok');
    }
    S.ui.pend.clear();
    indexTiles();
    handleEvents();
    if (S.G.status !== 'finished') S.ui.hideResult = false;
    saveLast();
    render();
  },
  onLeft(m) {
    clearSession();
    if (m && m.reason === 'kicked') toast('Создатель комнаты удалил вас из игры', 'err');
    render();
  },
  onResumeFailed(err) {
    clearSession();
    toast(err.message || 'Не удалось вернуться в игру', 'err');
    render();
  },
});

function clearSession() {
  S.session = null; S.G = null; S.you = null; S.stale = false;
  lsSet(LS.session, null); lsSet(LS.last, null);
  history.replaceState(null, '', location.pathname);
  S.entry.code = '';
  Object.assign(S.ui, { mode: 'idle', selStart: null, cursor: null, exch: null, blank: null, hideResult: false, seen: null, confirmLeave: false });
  $('#modal').replaceChildren();
  S.ui.pend.clear();
  renderBanner();
}

let saveTimer = null;
function saveLast() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (S.G && S.session) lsSet(LS.last, { room: S.G.code, G: S.G, you: S.you });
  }, 800);
}

function req(type, payload) {
  return net.request(type, payload).catch((e) => {
    if (e.network) { S.ui.pend.clear(); render(); }
    toast(e.message, 'err');
    throw e;
  });
}

/* ───────────────────────── уведомления ───────────────────────── */

function toast(text, kind = '') {
  const box = $('#toasts');
  const el = h('div', { class: 'toast ' + kind }, text);
  box.append(el);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => el.remove(), kind === 'err' ? 5000 : 3500);
}

function eventText(e) {
  const nm = (playerById(e.pid) || {}).name || 'Игрок';
  switch (e.type) {
    case 'start': return 'Игра началась';
    case 'word': return `${nm}: «${e.word.toUpperCase()}» +${e.score}${e.bingo ? ' (все 7 букв!)' : ''}`;
    case 'exchange': return `${nm} меняет буквы (${e.count})`;
    case 'timeout': return `У игрока ${nm} вышло время`;
    case 'left': return `${nm} вышел из игры`;
    case 'end': return 'Игра окончена';
    default: return '';
  }
}

function handleEvents() {
  const evs = S.G.events || [];
  const lastId = evs.length ? evs[evs.length - 1].id : 0;
  if (S.ui.seen == null) { S.ui.seen = lastId; return; }
  const fresh = evs.filter((e) => e.id > S.ui.seen).slice(-3);
  S.ui.seen = lastId;
  for (const e of fresh) {
    const t = eventText(e);
    if (t && e.type !== 'end') toast(t, e.type === 'word' ? 'ok' : '');
    if (e.type === 'word' && S.G.size) {
      const until = Date.now() + 1900;
      for (const [x, y] of e.cells) S.ui.flash.set(y * S.G.size + x, until);
      setTimeout(() => S.els && renderBoard(), 1950);
    }
  }
}

function renderBanner() {
  const b = $('#banner');
  const relevant = !!(S.G || S.session);
  if (S.conn !== 'online' && relevant) {
    b.hidden = false; b.className = '';
    b.textContent = S.retry > 1
      ? 'Нет соединения. Продолжаем пытаться… Ваше состояние сохранено и восстановится после подключения.'
      : 'Соединение потеряно, переподключаемся…';
  } else if (S.stale && relevant) {
    b.hidden = false; b.className = 'info';
    b.textContent = 'Загружаем актуальное состояние игры…';
  } else {
    b.hidden = true;
  }
  document.body.classList.toggle('offline', S.conn !== 'online' && relevant);
}

/* ───────────────────────── маршрутизация экранов ───────────────────────── */

function render() {
  const screen = !S.G ? (S.session ? 'connecting' : 'entry') : S.G.status === 'lobby' ? 'lobby' : 'game';
  const root = $('#app');
  if (screen !== S.screen) {
    S.screen = screen; S.els = null;
    root.replaceChildren();
    $('#modal').replaceChildren();
    if (screen === 'entry') buildEntry(root);
    if (screen === 'connecting') root.append(h('main', { class: 'entry' }, h('p', { class: 'tagline' }, 'Возвращаемся в игру…')));
    if (screen === 'entry') {
      fetch('/api/results?limit=6').then((r) => r.json()).then((rows) => { S.results = rows; renderResults(); }).catch(() => {});
    }
  }
  if (screen === 'lobby') renderLobby(root);
  if (screen === 'game') {
    const key = S.G.code + ':' + S.G.size;
    if (!S.els || S.els.key !== key) buildGame(root, key);
    updateGame();
  }
  renderBanner();
}

/* ───────────────────────── экран входа ───────────────────────── */

function logoTiles() {
  const pts = { Э: 8, Р: 1, У: 2, Д: 2, И: 1, Т: 1 };
  return h('div', { class: 'logo', 'aria-label': 'Эрудит' }, [...'ЭРУДИТ'].map((c) => h('div', { class: 'tile-glyph' }, c, h('i', {}, pts[c]))));
}

function buildEntry(root) {
  const cfg = S.cfg; const e = S.entry;
  const nameInput = h('input', { class: 'field', id: 'name', maxlength: 16, placeholder: 'Как вас называть?', value: lsGet(LS.name) || '', autocomplete: 'nickname' });
  const codeInput = h('input', { class: 'field', id: 'code', maxlength: 5, placeholder: 'Код комнаты', value: e.code, autocapitalize: 'characters', autocomplete: 'off', style: 'text-transform:uppercase;letter-spacing:.2em;font-weight:700' });

  const modeBtns = Object.values(cfg.modes).map((m) => h('button', {
    class: 'opt', type: 'button', 'aria-pressed': String(e.mode === m.id), dataset: { mode: m.id },
    onClick: () => { e.mode = m.id; refreshOpts(); },
  }, h('b', {}, m.title), h('small', { dataset: { sub: m.id } })));
  const playerBtns = [2, 3, 4].map((n) => h('button', {
    class: 'opt', type: 'button', 'aria-pressed': String(e.players === n), dataset: { players: n },
    onClick: () => { e.players = n; refreshOpts(); },
  }, h('b', {}, n + ' игрока'), h('small', {}, n === 2 ? 'дуэль' : n === 3 ? 'втроём' : 'до четырёх')));
  function refreshOpts() {
    modeBtns.forEach((b) => {
      const m = cfg.modes[b.dataset.mode];
      b.setAttribute('aria-pressed', String(e.mode === m.id));
      b.querySelector('small').textContent = `доска ${m.size}×${m.size}, до ${cfg.targets[m.id][e.players]} очков`;
    });
    playerBtns.forEach((b) => b.setAttribute('aria-pressed', String(e.players === Number(b.dataset.players))));
  }

  const getName = () => {
    const v = nameInput.value.trim();
    if (!v) { toast('Введите имя', 'err'); nameInput.focus(); return null; }
    return v;
  };
  const create = h('button', { class: 'btn big', type: 'button', onClick: () => {
    const name = getName(); if (!name) return;
    req('create', { name, mode: e.mode, maxPlayers: e.players }).catch(() => {});
  } }, 'Создать комнату');
  const join = h('button', { class: 'btn big', type: 'button', onClick: () => {
    const name = getName(); if (!name) return;
    const code = codeInput.value.trim().toUpperCase();
    if (code.length < 4) { toast('Введите код комнаты', 'err'); codeInput.focus(); return; }
    req('join', { room: code, name }).catch(() => {});
  } }, 'Войти');
  codeInput.addEventListener('input', () => { codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); e.code = codeInput.value; });

  const R = cfg.rules;
  const rules = h('details', { class: 'panel rules' },
    h('summary', {}, 'Как играть'),
    h('ul', {},
      h('li', {}, 'Первое слово появляется в центре доски само (3, 5 или 7 букв — зависит от длительности). Дальше все играют одновременно, по очереди ходить не нужно.'),
      h('li', {}, `Нажмите «Собрать слово» и отметьте на доске первую и последнюю клетки отрезка. Отрезок обязан пройти хотя бы через одну букву, уже лежащую на доске. Клетки, которые заняли другие, выбрать нельзя.`),
      h('li', {}, `Поставьте буквы из стойки в пустые клетки (на телефоне — нажимайте буквы, на компьютере можно печатать с клавиатуры) и подтвердите. На всё есть ${R.captureMs / 1000} секунд, отменить сбор можно в любой момент.`),
      h('li', {}, `После удачного слова паузы нет. Если вы отменили сбор или время вышло, нужно подождать ${R.cooldownMoveMs / 1000} секунд. Обмен букв доступен вне сбора слова и даёт паузу ${R.cooldownExchangeMs / 1000} секунд.`),
      h('li', {}, 'Слово должно быть в словаре (существительное в именительном падеже). Буквы, соседние с вашими, тоже образуют слова — они тоже проверяются и приносят очки.'),
      h('li', {}, `Бланк (✦) — любая буква, но 0 очков. Если выложить все ${R.rackSize} букв стойки сразу, бонус +${R.bingoBonus}.`),
      h('li', {}, 'Игра идёт до заданного числа очков; кто набрал первым — победил. Если время игры вышло или кончились буквы, побеждает лидер.'),
      h('li', {}, 'Клетки: 2Б/3Б — буква ×2/×3, 2С/3С — слово ×2/×3, ★ — центр (×2 слово).'),
    ));

  root.append(h('main', { class: 'entry' },
    logoTiles(),
    h('p', { class: 'tagline' }, 'Русский «Эрудит» онлайн: все играют одновременно'),
    h('section', { class: 'panel stack' },
      h('div', {}, h('label', { class: 'lab', for: 'name' }, 'Ваше имя'), nameInput)),
    h('section', { class: 'panel stack', id: 'sec-create' },
      h('h2', {}, 'Новая игра'),
      h('div', {}, h('div', { class: 'lab' }, 'Длительность'), h('div', { class: 'seg-row three' }, modeBtns)),
      h('div', {}, h('div', { class: 'lab' }, 'Игроков не больше'), h('div', { class: 'seg-row three-p' }, playerBtns)),
      create),
    h('section', { class: 'panel stack', id: 'sec-join' },
      h('h2', {}, 'Войти по коду'),
      h('div', { class: 'row' }, h('div', { class: 'grow' }, codeInput), join)),
    rules,
    h('section', { class: 'panel', id: 'recent' }),
  ));
  refreshOpts();
  renderResults();
  if (e.code) setTimeout(() => (lsGet(LS.name) ? codeInput : nameInput).focus(), 50);
}

function renderResults() {
  const box = $('#recent');
  if (!box) return;
  const rows = S.results || [];
  box.replaceChildren(h('h2', { style: 'font-size:1.1rem;margin-bottom:6px' }, 'Недавние игры'));
  if (!rows.length) { box.append(h('p', { class: 'muted', style: 'margin:0' }, 'Пока нет завершённых игр. Результаты сохраняются в базе данных.')); return; }
  box.append(h('ul', { class: 'recent' }, rows.map((r) => {
    const d = new Date(r.finishedAt);
    const top = r.ranking.map((p) => `${p.name} ${p.score}`).join(', ');
    return h('li', {}, h('b', {}, r.winners.length === 1 ? 'Победил ' + r.winners[0] : 'Ничья'), h('span', { class: 'muted' }, top),
      h('span', { class: 'muted' }, `${S.cfg.modes[r.mode] ? S.cfg.modes[r.mode].title : r.mode} ${r.size}×${r.size}, ${d.toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`));
  })));
}

/* ───────────────────────── лобби ───────────────────────── */

function copyLink() {
  const url = `${location.origin}/#${S.G.code}`;
  const done = () => toast('Ссылка скопирована — отправьте её друзьям', 'ok');
  if (navigator.clipboard && window.isSecureContext) navigator.clipboard.writeText(url).then(done, () => toast(url));
  else {
    const t = h('textarea', { style: 'position:fixed;opacity:0' }, url);
    document.body.append(t); t.select();
    try { document.execCommand('copy'); done(); } catch { toast(url); }
    t.remove();
  }
}

function renderLobby(root) {
  const G = S.G; const myId = S.you ? S.you.id : null;
  const isHost = G.hostId === myId;
  const canStart = G.players.length >= (S.cfg.rules.minPlayers || 2);
  root.replaceChildren(h('main', { class: 'lobby' },
    h('h1', {}, 'Комната ожидания'),
    h('section', { class: 'panel stack' },
      h('div', { class: 'codebox' }, h('span', { class: 'code' }, G.code),
        h('button', { class: 'btn ghost', type: 'button', onClick: copyLink }, 'Скопировать ссылку')),
      h('p', { class: 'muted', style: 'margin:0' }, `Игра «${G.modeTitle}»: доска ${G.size}×${G.size}, победа при ${G.target} очках (зависит от числа игроков). Мест: ${G.maxPlayers}.`)),
    h('section', { class: 'panel stack' },
      h('h2', {}, `Игроки ${G.players.length}/${G.maxPlayers}`),
      h('ul', { class: 'plist' }, G.players.map((p) => h('li', { style: `--pc:${COLORS[p.color % COLORS.length]}` },
        h('span', { class: 'nm' }, p.name, p.id === myId ? ' (вы)' : ''),
        p.id === G.hostId ? h('span', { class: 'badge' }, 'создатель') : null,
        !p.connected ? h('span', { class: 'badge' }, 'не в сети') : null,
        isHost && p.id !== myId ? h('button', { class: 'btn ghost', type: 'button', onClick: () => req('kick', { target: p.id }).catch(() => {}) }, 'Удалить') : null)))),
    isHost
      ? h('div', { class: 'stack' },
        h('button', { class: 'btn big', type: 'button', disabled: !canStart, onClick: () => req('start').catch(() => {}) }, 'Начать игру'),
        canStart ? null : h('p', { class: 'muted', style: 'margin:0' }, 'Нужно минимум два игрока — отправьте им ссылку или код.'))
      : h('p', { class: 'muted' }, 'Ждём, пока создатель комнаты начнёт игру…'),
    h('button', { class: 'btn ghost', type: 'button', onClick: () => req('leave').catch(() => {}) }, 'Выйти из комнаты'),
  ));
}

/* ───────────────────────── игровой экран: построение ───────────────────────── */

function buildGame(root, key) {
  const G = S.G; const n = G.size;
  const els = { key };
  S.els = els;
  S.ui.mode = 'idle'; S.ui.selStart = null; S.ui.cursor = null; S.ui.exch = null;

  els.goal = h('div', { class: 'goal' });
  els.bag = h('div', { class: 'chip' });
  els.clock = h('div', { class: 'chip', title: 'Общее время игры' });
  els.code = h('button', { class: 'chip', type: 'button', title: 'Скопировать ссылку на комнату', onClick: copyLink }, 'Комната ', h('b', {}, G.code));
  els.leave = h('button', { class: 'chip', type: 'button', onClick: askLeave }, 'Выйти из игры');
  els.top = h('header', { class: 'top' }, h('div', { class: 'brand' }, 'Эрудит'), els.goal, els.bag, els.clock, h('div', { class: 'spacer' }), els.leave, els.code);

  els.players = h('section', { class: 'players', 'aria-label': 'Игроки' });

  els.board = h('div', { class: 'board', style: `--n:${n}`, role: 'grid', 'aria-label': 'Игровая доска' });
  els.cells = [];
  for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
    const c = h('div', { class: 'cell', dataset: { x, y }, role: 'gridcell' });
    els.cells.push(c); els.board.append(c);
  }
  els.boardWrap = h('div', { class: 'board-wrap' }, els.board);
  els.zoom = h('button', { class: 'chip zoom', type: 'button', 'aria-label': 'Увеличить или уменьшить доску', onClick: () => {
    S.ui.zoom = !S.ui.zoom; els.boardWrap.classList.toggle('zoomed', S.ui.zoom);
    els.zoom.textContent = S.ui.zoom ? 'Вся доска' : 'Увеличить';
  } }, 'Увеличить');
  els.top.insertBefore(els.zoom, els.code);
  els.board.addEventListener('click', (e) => {
    const c = e.target.closest('.cell'); if (c) onCell(+c.dataset.x, +c.dataset.y);
  });
  els.board.addEventListener('mouseover', (e) => {
    const c = e.target.closest('.cell');
    if (!c || !S.ui.selStart) return;
    const x = +c.dataset.x; const y = +c.dataset.y; const hv = S.ui.hover;
    if (!hv || hv.x !== x || hv.y !== y) { S.ui.hover = { x, y }; renderBoard(); }
  });
  els.board.addEventListener('dragover', (e) => { if (getMe() && getMe().capture) e.preventDefault(); });
  els.board.addEventListener('drop', (e) => {
    e.preventDefault();
    const c = e.target.closest('.cell'); if (!c) return;
    const id = Number(e.dataTransfer.getData('text/plain'));
    const t = S.you && S.you.rack.find((r) => r.id === id);
    if (t) placeTile(t, { x: +c.dataset.x, y: +c.dataset.y });
  });
  new ResizeObserver(() => {
    const w = els.board.clientWidth;
    els.board.style.setProperty('--cell', Math.max(10, (w - 4 - (n - 1) * 2) / n) + 'px');
  }).observe(els.board);

  els.hintMain = h('div', { class: 'hint-main' });
  els.bar = h('i');
  els.hint = h('section', { class: 'panel hint', 'aria-live': 'polite' }, els.hintMain, h('div', { class: 'bar' }, els.bar));

  els.rack = h('div', { class: 'rack', 'aria-label': 'Ваши буквы' });
  els.btnCapture = h('button', { class: 'btn', type: 'button', onClick: startSelecting }, 'Собрать слово');
  els.btnExchange = h('button', { class: 'btn ghost', type: 'button', onClick: openExchange }, 'Обменять буквы');
  els.btnCommit = h('button', { class: 'btn', type: 'button', onClick: commit }, 'Подтвердить слово');
  els.btnCancel = h('button', { class: 'btn ghost', type: 'button', onClick: cancelCapture }, 'Отменить сбор');
  els.btnSel = h('button', { class: 'btn ghost wide', type: 'button', onClick: stopSelecting }, 'Отменить выбор отрезка');
  els.actions = h('div', { class: 'actions' }, els.btnCapture, els.btnExchange, els.btnCommit, els.btnCancel, els.btnSel);
  els.exchGo = h('button', { class: 'btn', type: 'button', onClick: doExchange }, 'Обменять');
  els.exchClose = h('button', { class: 'btn ghost', type: 'button', onClick: closeExchange }, 'Закрыть');
  els.exchInfo = h('div', { class: 'muted' });
  els.exch = h('div', { class: 'exch panel', hidden: true }, els.exchInfo, h('div', { class: 'row' }, els.exchGo, els.exchClose));
  els.rackPanel = h('section', { class: 'rackpanel' }, els.rack, els.actions, els.exch);

  els.logList = h('ol');
  els.log = h('section', { class: 'panel log' }, h('h3', {}, 'Ход игры'), els.logList);

  root.replaceChildren(h('div', { class: 'game' }, els.top, els.players, els.boardWrap, els.hint, els.rackPanel, els.log));
}

/* ───────────────────────── игровой экран: обновление ───────────────────────── */

function updateGame() {
  renderTop(); renderPlayers(); renderBoard(); renderRack(); renderHint(); renderControls(); renderLog(); renderModal();
}

function renderTop() {
  const { G, els } = { G: S.G, els: S.els };
  els.goal.textContent = `До ${G.target} очков`;
  els.bag.textContent = `В мешке: ${G.bag}`;
  renderClock();
}

function renderClock() {
  const G = S.G; const el = S.els.clock;
  el.textContent = G.status === 'playing' ? `Осталось ${fmtClock(G.endsAt - nowMs())}` : 'Игра окончена';
}

function playerStatus(p) {
  const G = S.G;
  if (p.left) return 'вышел из игры';
  if (G.status === 'finished') return '';
  if (!p.connected) return 'не в сети';
  if (p.capture) return `собирает слово, ${secs(p.capture.deadline - nowMs())} с`;
  const cd = p.cooldownUntil - nowMs();
  if (cd > 0) return `${p.cooldownKind === 'exchange' ? 'обмен' : 'пауза'} ${secs(cd)} с`;
  return 'готов';
}

function renderPlayers() {
  const G = S.G; const me = getMe();
  S.els.players.replaceChildren(...G.players.map((p) => {
    const pct = Math.min(100, Math.round((p.score / G.target) * 100));
    return h('div', {
      class: 'prow' + (p.capture ? ' capturing' : '') + (!p.connected ? ' offline' : ''),
      style: `--pc:${COLORS[p.color % COLORS.length]};--prog:${pct}%`, dataset: { pid: p.id },
    },
    h('div', { class: 'nm' }, p.name, me && p.id === me.id ? h('small', {}, 'вы') : null),
    h('div', { class: 'sc' }, p.score),
    h('div', { class: 'st' }, playerStatus(p)));
  }));
}

function tickPlayers() {
  for (const p of S.G.players) {
    const el = S.els.players.querySelector(`[data-pid="${p.id}"] .st`);
    if (el) { const t = playerStatus(p); if (el.textContent !== t) el.textContent = t; }
  }
}

/* ───── доска ───── */

function effectiveCursor() {
  const me = getMe(); const ui = S.ui;
  if (!me || !me.capture) return null;
  const free = segCells(me.capture).filter(([x, y]) => !S.tileMap.has(x + ',' + y)
    && !me.capture.placed.some((p) => p[0] === x && p[1] === y) && !ui.pend.has(x + ',' + y));
  if (!free.length) return null;
  const cur = ui.cursor;
  if (cur && free.some(([x, y]) => x === cur.x && y === cur.y)) return cur;
  return { x: free[0][0], y: free[0][1] };
}

function tileEl(o, cls, byColor, pc) {
  const style = (byColor ? `--by:${byColor};` : '') + (pc ? `--pc:${pc};` : '');
  return h('span', { class: 'tile ' + cls + (o.blank ? ' blank' : ''), style }, h('b', {}, o.ch.toUpperCase()), o.blank || !o.pts ? null : h('i', {}, o.pts));
}

function renderBoard() {
  const { G, ui, els } = S; const n = G.size; const me = getMe();
  const info = Array.from({ length: n * n }, () => ({}));
  for (const [x, y, ch, pts, blank, by] of G.tiles) info[y * n + x].tile = { ch, pts, blank, by };
  for (const p of G.players) {
    const c = p.capture; if (!c) continue;
    const cells = segCells(c);
    cells.forEach(([x, y], i) => { info[y * n + x].seg = { pid: p.id, dir: c.dir, first: i === 0, last: i === cells.length - 1 }; });
    for (const [x, y, ch, pts, blank] of c.placed) info[y * n + x].tent = { pid: p.id, ch, pts, blank };
  }
  if (me) {
    for (const [k, v] of ui.pend) { const [x, y] = k.split(',').map(Number); info[y * n + x].tent = { pid: me.id, ch: v.ch, pts: v.pts, blank: v.blank }; }
  }
  const cur = effectiveCursor();
  const hl = new Set();
  if (ui.selStart && ui.hover && (ui.selStart.x === ui.hover.x || ui.selStart.y === ui.hover.y)) {
    const { x: ax, y: ay } = ui.selStart; const { x: bx, y: by } = ui.hover;
    for (let y = Math.min(ay, by); y <= Math.max(ay, by); y++) for (let x = Math.min(ax, bx); x <= Math.max(ax, bx); x++) hl.add(y * n + x);
  }
  const t = Date.now();
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const i = y * n + x; const o = info[i]; const el = els.cells[i];
      const prem = G.premium[y][x];
      let cls = 'cell p-' + (prem === '.' ? 'n' : prem);
      let style = '';
      if (o.seg) {
        cls += ` seg seg-${o.seg.dir}${o.seg.first ? ' seg-first' : ''}${o.seg.last ? ' seg-last' : ''}${me && o.seg.pid === me.id ? ' seg-mine' : ''}`;
        style = `--pc:${colorOf(o.seg.pid)};`;
      }
      if (cur && cur.x === x && cur.y === y) cls += ' cursor';
      if (ui.selStart && ui.selStart.x === x && ui.selStart.y === y) cls += ' selstart';
      if (hl.has(i)) cls += ' hl';
      if ((ui.flash.get(i) || 0) > t) cls += ' flash';
      let sig = cls + style;
      let content;
      if (o.tile) {
        sig += `|t${o.tile.ch}${o.tile.pts}${o.tile.blank}${o.tile.by}`;
        content = () => tileEl(o.tile, '', o.tile.by ? colorOf(o.tile.by) : '');
      } else if (o.tent) {
        sig += `|e${o.tent.ch}${o.tent.pts}${o.tent.blank}${o.tent.pid}`;
        content = () => tileEl(o.tent, 'tent', '', colorOf(o.tent.pid));
      } else if (PLABEL[prem]) {
        sig += '|p';
        content = () => h('span', { class: 'plabel' }, PLABEL[prem]);
      } else content = null;
      if (el._sig === sig) continue;
      el._sig = sig;
      el.className = cls; el.style.cssText = style;
      el.replaceChildren(...(content ? [content()] : []));
    }
  }
}

/* ───── стойка и кнопки ───── */

function renderRack() {
  const { ui, els, G, you } = S; const me = getMe();
  const pendIds = new Set([...ui.pend.values()].map((v) => v.id));
  const tiles = you ? you.rack.filter((t) => !pendIds.has(t.id)) : [];
  const sig = JSON.stringify([tiles.map((t) => t.id + t.ch), ui.exch ? [...ui.exch] : null, !!(me && me.capture), G.status]);
  if (els.rack._sig === sig) return;
  els.rack._sig = sig;
  const canDrag = !!(me && me.capture);
  els.rack.replaceChildren(...(tiles.length ? tiles.map((t) => h('button', {
    class: 'rtile' + (t.blank ? ' blank' : '') + (ui.exch && ui.exch.has(t.id) ? ' picked' : ''),
    type: 'button', draggable: canDrag ? 'true' : null,
    'aria-label': t.blank ? 'Бланк, любая буква' : `Буква ${t.ch.toUpperCase()}, ${t.pts} очк.`,
    onClick: () => onRackTile(t),
    onDragstart: (e) => { e.dataTransfer.setData('text/plain', String(t.id)); e.dataTransfer.effectAllowed = 'move'; },
  }, h('b', {}, t.blank ? '✦' : t.ch.toUpperCase()), t.blank ? null : h('i', {}, t.pts)))
    : [h('span', { class: 'empty-rack' }, G.status === 'playing' ? 'Стойка пуста' : '')]));
}

function setText(el, t) { if (el.textContent !== t) el.textContent = t; }

function renderControls() {
  const { G, ui, els } = S; const me = getMe();
  const playing = G.status === 'playing' && !!me;
  const cap = playing && me.capture;
  const online = net.open;
  const cd = me ? Math.max(0, me.cooldownUntil - nowMs()) : 0;
  const selecting = playing && !cap && ui.mode === 'selecting';
  const idle = playing && !cap && !selecting && !ui.exch;
  els.btnCapture.hidden = !idle; els.btnExchange.hidden = !idle;
  els.btnCommit.hidden = !cap; els.btnCancel.hidden = !cap;
  els.btnSel.hidden = !selecting;
  els.exch.hidden = !(playing && !cap && ui.exch);
  els.btnCapture.disabled = cd > 0 || !online;
  setText(els.btnCapture, cd > 0 ? `Пауза ${secs(cd)} с` : 'Собрать слово');
  els.btnExchange.disabled = cd > 0 || !online || G.bag < 1;
  els.btnCommit.disabled = !online;
  els.btnCancel.disabled = !online;
  if (ui.exch) {
    const k = ui.exch.size;
    els.exchGo.disabled = !k || !online || G.bag < k || cd > 0;
    setText(els.exchGo, k ? `Обменять (${k})` : 'Обменять');
    setText(els.exchInfo, cd > 0 ? `Подождите ${secs(cd)} с. ` : `Выберите буквы выше (в мешке ${G.bag}). После обмена пауза ${secs(S.cfg.rules.cooldownExchangeMs)} с.`);
  }
}

function renderHint() {
  const { G, els, you } = S; const me = getMe();
  const m = els.hintMain;
  els.bar.style.width = '0';
  if (G.status === 'finished') { m.replaceChildren(h('div', { class: 'hint-text' }, 'Игра окончена. Итоги — в окне результатов.')); return; }
  if (me && me.capture && you && you.preview) {
    const pv = you.preview;
    const msg = pv.valid
      ? (pv.parts.length > 1 ? 'Слово принято: ' + pv.parts.map((p) => `${p.word} +${p.score}`).join(', ') + (pv.bingo ? `, бонус +${S.cfg.rules.bingoBonus}` : '') : 'Слово есть в словаре — подтверждайте!' + (pv.bingo ? ` Бонус +${S.cfg.rules.bingoBonus} за все буквы.` : ''))
      : pv.complete ? pv.error : 'Нажимайте буквы в стойке (или печатайте), чтобы заполнить пустые клетки.';
    const parts = [
      h('div', { class: 'pv-word' }, [...pv.pattern].map((c) => h('span', { class: c === '·' ? 'gap' : '' }, c))),
      pv.valid ? h('div', { class: 'pv-score' }, '+' + pv.score) : h('div', { class: 'pv-time' }, h('span', { dataset: { t: 'cap' } }, secs(me.capture.deadline - nowMs())), ' с'),
      h('div', { class: 'pv-msg ' + (pv.valid ? 'good' : pv.complete ? 'bad' : '') }, msg),
    ];
    if (pv.valid) parts.push(h('div', { class: 'pv-time', style: 'grid-column:1/-1' }, 'Осталось ', h('span', { dataset: { t: 'cap' } }, secs(me.capture.deadline - nowMs())), ' с'));
    m.replaceChildren(...parts);
    return;
  }
  if (S.ui.mode === 'selecting') {
    m.replaceChildren(h('div', { class: 'hint-text', style: 'grid-column:1/-1' }, S.ui.selStart
      ? 'Теперь нажмите последнюю клетку отрезка — по горизонтали или вертикали.'
      : 'Нажмите первую клетку отрезка. Он должен пройти хотя бы через одну букву на доске.'));
    return;
  }
  const cd = me ? me.cooldownUntil - nowMs() : 0;
  if (cd > 0) {
    m.replaceChildren(h('div', { class: 'hint-text', style: 'grid-column:1/-1' }, me.cooldownKind === 'exchange' ? 'Пауза после обмена: ' : 'Пауза: ', h('b', { dataset: { t: 'cd' } }, secs(cd)), ' с'));
    return;
  }
  m.replaceChildren(h('div', { class: 'hint-text', style: 'grid-column:1/-1' }, 'Нажмите «Собрать слово», чтобы занять отрезок на доске. Играем одновременно — успевайте первыми!'));
}

function tickHint() {
  const { G, els } = S; const me = getMe();
  if (!me || G.status !== 'playing') return;
  if (me.capture) {
    const left = me.capture.deadline - nowMs();
    els.hint.querySelectorAll('[data-t="cap"]').forEach((e) => setText(e, String(secs(left))));
    els.bar.style.width = Math.max(0, Math.min(100, (left / S.cfg.rules.captureMs) * 100)) + '%';
    return;
  }
  const cd = me.cooldownUntil - nowMs();
  const total = me.cooldownKind === 'exchange' ? S.cfg.rules.cooldownExchangeMs : S.cfg.rules.cooldownMoveMs;
  const e = els.hint.querySelector('[data-t="cd"]');
  if (cd > 0 && e) { setText(e, String(secs(cd))); els.bar.style.width = Math.min(100, (cd / total) * 100) + '%'; }
  else if (cd <= 0 && e) renderHint();
}

function renderLog() {
  const G = S.G;
  const items = G.events.filter((e) => eventText(e)).slice(-12).reverse();
  S.els.logList.replaceChildren(...items.map((e) => h('li', { style: e.pid ? `--pc:${colorOf(e.pid)}` : '' }, eventText(e))));
}

/* ───────────────────────── действия игрока ───────────────────────── */

function startSelecting() {
  S.ui.mode = 'selecting'; S.ui.selStart = null; S.ui.hover = null;
  renderBoard(); renderHint(); renderControls();
}
function stopSelecting() {
  S.ui.mode = 'idle'; S.ui.selStart = null; S.ui.hover = null;
  renderBoard(); renderHint(); renderControls();
}

function onCell(x, y) {
  const { G, ui } = S; const me = getMe();
  if (!me || G.status !== 'playing') return;
  const cap = me.capture;
  if (cap) {
    if (!segCells(cap).some(([cx, cy]) => cx === x && cy === y)) return;
    const k = x + ',' + y;
    if (cap.placed.some((p) => p[0] === x && p[1] === y) || ui.pend.has(k)) {
      ui.pend.delete(k);
      req('unplace', { x, y }).catch(() => {});
      ui.cursor = { x, y };
    } else if (!S.tileMap.has(k)) {
      ui.cursor = { x, y };
    }
    renderBoard(); renderRack();
    return;
  }
  if (ui.mode !== 'selecting') return;
  if (!ui.selStart) { ui.selStart = { x, y }; renderBoard(); renderHint(); return; }
  const a = ui.selStart;
  if (a.x === x && a.y === y) { ui.selStart = null; renderBoard(); renderHint(); return; }
  ui.selStart = null; ui.hover = null;
  req('capture', { x1: a.x, y1: a.y, x2: x, y2: y }).then(() => { ui.mode = 'idle'; }).catch(() => {}).finally(() => { renderBoard(); renderHint(); renderControls(); });
}

function onRackTile(t) {
  const { ui } = S; const me = getMe();
  if (ui.exch) {
    if (ui.exch.has(t.id)) ui.exch.delete(t.id); else ui.exch.add(t.id);
    S.els.rack._sig = null; renderRack(); renderControls();
    return;
  }
  if (!me || !me.capture) { toast('Сначала нажмите «Собрать слово» и выберите отрезок на доске'); return; }
  placeTile(t);
}

function placeTile(t, cellOverride) {
  const me = getMe();
  if (!me || !me.capture) return;
  const cell = cellOverride || effectiveCursor();
  if (!cell) { toast('Все клетки заполнены — подтвердите слово'); return; }
  const k = cell.x + ',' + cell.y;
  if (!segCells(me.capture).some(([x, y]) => x === cell.x && y === cell.y) || S.tileMap.has(k)) { toast('Эта клетка вне вашего отрезка или уже занята'); return; }
  if (t.blank) { askBlank((letter) => doPlace(t, cell, letter)); return; }
  doPlace(t, cell);
}

function doPlace(t, cell, letter) {
  S.ui.pend.set(cell.x + ',' + cell.y, { id: t.id, ch: t.blank ? letter : t.ch, pts: t.blank ? 0 : t.pts, blank: !!t.blank });
  S.ui.cursor = null;
  renderBoard(); renderRack();
  req('place', { tileId: t.id, x: cell.x, y: cell.y, letter }).catch(() => {});
}

function placeByLetter(ch) {
  const me = getMe(); if (!me || !me.capture || !S.you) return;
  const pendIds = new Set([...S.ui.pend.values()].map((v) => v.id));
  const avail = S.you.rack.filter((t) => !pendIds.has(t.id));
  const real = avail.find((t) => !t.blank && t.ch === ch);
  const blank = avail.find((t) => t.blank);
  const cell = effectiveCursor();
  if (!cell) { toast('Все клетки заполнены — подтвердите слово (Enter)'); return; }
  if (real) doPlace(real, cell);
  else if (blank) doPlace(blank, cell, ch);
  else toast(`В стойке нет буквы «${ch.toUpperCase()}»`);
}

function askBlank(cb) {
  S.ui.blank = { cb };
  renderModal();
}

function commit() {
  req('commit').then(() => { if (navigator.vibrate) navigator.vibrate(25); }).catch(() => {});
}
function cancelCapture() { S.ui.pend.clear(); S.ui.cursor = null; req('cancel').catch(() => {}); }

function askLeave() {
  if (S.G && S.G.status === 'playing') { S.ui.confirmLeave = true; renderModal(); } else doLeave();
}
function doLeave() {
  const finished = !!S.G && S.G.status === 'finished';
  S.ui.confirmLeave = false;
  req('leave').catch(() => { if (finished) { clearSession(); render(); } });
}

function openExchange() { S.ui.exch = new Set(); S.els.rack._sig = null; renderRack(); renderControls(); }
function closeExchange() { S.ui.exch = null; S.els.rack._sig = null; renderRack(); renderControls(); }
function doExchange() {
  const ids = [...S.ui.exch];
  req('exchange', { tileIds: ids }).then(() => { S.ui.exch = null; S.els.rack._sig = null; }).catch(() => {}).finally(() => { renderRack(); renderControls(); });
}

document.addEventListener('keydown', (e) => {
  if (!S.G || S.G.status !== 'playing' || S.screen !== 'game') return;
  if (e.target.closest && e.target.closest('input,textarea')) return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  const me = getMe(); const ui = S.ui;
  if (e.key === 'Escape') {
    if (ui.confirmLeave) { ui.confirmLeave = false; renderModal(); }
    else if (ui.blank) { ui.blank = null; renderModal(); }
    else if (ui.exch) closeExchange();
    else if (me && me.capture) cancelCapture();
    else if (ui.mode === 'selecting') stopSelecting();
    return;
  }
  if (!me || !me.capture || ui.blank) return;
  if (e.key === 'Enter') { e.preventDefault(); commit(); return; }
  if (e.key === 'Backspace') {
    e.preventDefault();
    const cells = segCells(me.capture).reverse();
    const last = cells.find(([x, y]) => me.capture.placed.some((p) => p[0] === x && p[1] === y) || ui.pend.has(x + ',' + y));
    if (last) { ui.pend.delete(last[0] + ',' + last[1]); req('unplace', { x: last[0], y: last[1] }).catch(() => {}); ui.cursor = { x: last[0], y: last[1] }; renderBoard(); renderRack(); }
    return;
  }
  if (e.key.length === 1 && /[а-яёА-ЯЁ]/.test(e.key)) { e.preventDefault(); placeByLetter(e.key.toLowerCase().replace('ё', 'е')); }
});

/* ───────────────────────── модальные окна ───────────────────────── */

const REASONS = {
  target: 'Набрано нужное число очков',
  time: 'Время игры вышло',
  out_of_tiles: 'Буквы в мешке и у игрока закончились',
  abandoned: 'Игра заброшена',
  last_player: 'Остальные игроки вышли из игры',
};

function renderModal() {
  const box = $('#modal'); const { ui, G } = S;
  if (ui.confirmLeave) {
    box.replaceChildren(h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Выход из игры', onClick: (e) => { if (e.target.classList.contains('overlay')) { ui.confirmLeave = false; renderModal(); } } },
      h('div', { class: 'dialog' },
        h('h2', {}, 'Выйти из игры?'),
        h('p', { style: 'margin:0' }, 'Вернуться в эту партию будет нельзя: ваш отрезок освободится, а буквы вернутся в мешок. Набранные очки останутся в итогах.'),
        h('div', { class: 'row' },
          h('button', { class: 'btn danger', type: 'button', onClick: doLeave }, 'Выйти'),
          h('button', { class: 'btn ghost', type: 'button', onClick: () => { ui.confirmLeave = false; renderModal(); } }, 'Остаться')))));
    return;
  }
  if (ui.blank) {
    const letters = S.cfg.alphabet.map((l) => h('button', { type: 'button', onClick: () => { const cb = ui.blank.cb; ui.blank = null; renderModal(); cb(l); } }, l.toUpperCase()));
    box.replaceChildren(h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Выбор буквы для бланка', onClick: (e) => { if (e.target.classList.contains('overlay')) { ui.blank = null; renderModal(); } } },
      h('div', { class: 'dialog' }, h('h2', {}, 'Какая это буква?'),
        h('p', { class: 'muted', style: 'margin:0' }, 'Бланк станет выбранной буквой, но принесёт 0 очков. После подтверждения слова изменить её нельзя.'),
        h('div', { class: 'letters' }, letters),
        h('button', { class: 'btn ghost', type: 'button', onClick: () => { ui.blank = null; renderModal(); } }, 'Отмена'))));
    return;
  }
  if (G && G.status === 'finished' && G.result && !ui.hideResult) {
    const r = G.result;
    const winners = r.winnerIds.map((id) => (playerById(id) || {}).name).filter(Boolean);
    const rows = r.ranking.map((p) => h('tr', { style: `--pc:${COLORS[p.color % COLORS.length]}` },
      h('td', { class: 'num' }, p.place),
      h('td', {}, h('span', { class: 'pn' }), p.name, p.left ? ' (вышел)' : ''),
      h('td', { class: 'num' }, h('b', {}, p.score)),
      h('td', { class: 'num' }, p.words),
      h('td', {}, p.best ? `${p.best.word.toUpperCase()} (${p.best.score})` : '—'),
      h('td', {}, p.longest ? p.longest.toUpperCase() : '—'),
      h('td', { class: 'num' }, p.avg),
      h('td', { class: 'num' }, p.bingos),
      h('td', { class: 'num' }, p.exchanges),
      h('td', { class: 'num' }, p.failed)));
    box.replaceChildren(h('div', { class: 'overlay', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Итоги игры' },
      h('div', { class: 'dialog' },
        h('div', { class: 'winner' }, winners.length === 1 ? `Победитель: ${winners[0]}` : `Ничья: ${winners.join(', ')}`),
        h('p', { class: 'muted', style: 'margin:0' }, `${REASONS[r.reason] || ''}. Слов на доске: ${r.words}, длительность: ${fmtClock(r.durationMs)}. Результат сохранён в базе данных.`),
        h('div', { class: 'tablewrap' }, h('table', { class: 'stats' },
          h('thead', {}, h('tr', {}, ['№', 'Игрок', 'Очки', 'Слов', 'Лучшее слово', 'Самое длинное', 'Среднее', 'Бонусов', 'Обменов', 'Отказов'].map((t) => h('th', {}, t)))),
          h('tbody', {}, rows))),
        h('div', { class: 'row' },
          h('button', { class: 'btn', type: 'button', onClick: doLeave }, 'Выйти и начать новую'),
          h('button', { class: 'btn ghost', type: 'button', onClick: () => { ui.hideResult = true; renderModal(); } }, 'Смотреть доску')))));
    return;
  }
  box.replaceChildren();
  if (G && G.status === 'finished' && G.result && S.els && !S.els.resultBtn) {
    S.els.resultBtn = h('button', { class: 'btn ghost wide', type: 'button', onClick: () => { ui.hideResult = false; renderModal(); } }, 'Показать итоги');
    S.els.actions.append(S.els.resultBtn);
  }
}

/* ───────────────────────── запуск ───────────────────────── */

setInterval(() => {
  if (S.screen !== 'game' || !S.els) return;
  renderClock(); tickPlayers(); tickHint(); renderControls();
}, 250);

fetch('/api/config').then((r) => r.json()).then((cfg) => {
  S.cfg = { ...FALLBACK_CFG, ...cfg };
}).catch(() => {});

render();
net.start();
