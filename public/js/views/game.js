/** Игровой экран: построение DOM (один раз) и обновление при каждом новом состоянии. */
import { h } from '../util.js';
import { S, getMe } from '../state.js';
import { copyLink } from '../room.js';
import {
  askLeave, startSelecting, stopSelecting, openExchange, closeExchange, doExchange,
  commit, cancelCapture, onCell, onRackTile, placeTile,
} from '../actions.js';
import { renderBoard, renderRack } from './board.js';
import { renderTop, renderPlayers, renderHint, renderControls, renderLog } from './hud.js';
import { renderModal } from './modals.js';

export function buildGame(root, key) {
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
  // Стойка перерисовывается часто, поэтому клики и перетаскивание ловим на контейнере (делегирование).
  els.rack.addEventListener('click', (e) => { const b = e.target.closest('.rtile'); if (b) onRackTile(Number(b.dataset.id)); });
  els.rack.addEventListener('dragstart', (e) => {
    const b = e.target.closest('.rtile'); if (!b) return;
    e.dataTransfer.setData('text/plain', b.dataset.id); e.dataTransfer.effectAllowed = 'move';
  });
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

export function updateGame() {
  renderTop(); renderPlayers(); renderBoard(); renderRack(); renderHint(); renderControls(); renderLog(); renderModal();
}
