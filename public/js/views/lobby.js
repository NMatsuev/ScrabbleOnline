/** Лобби: код комнаты, список игроков, старт игры. */
import { h, COLORS } from '../util.js';
import { S } from '../state.js';
import { req } from '../api.js';
import { copyLink } from '../room.js';

export function renderLobby(root) {
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
