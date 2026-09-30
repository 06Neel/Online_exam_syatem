import { h, mount, toast, themeSwitch } from '../ui.js';
import { getActive, clearActive } from '../game/session.js';
import { store } from '../state.js';
import { go } from '../main.js';

export const title = 'Lobby';

let unsubs = [];

export function render(root) {
  const active = getActive();
  if (!active) { go('#/'); return; }

  const { engine, meta } = active;
  if (meta.started) { go('#/play'); return; }

  const roster = h('div', { class: 'roster' }, h('div', { class: 'p' }, h('span', null, `${store.nickname} (you)`)));
  const countEl = h('span', { class: 'chip' }, '1 player');

  const tips = [
    '💡 You can use a Hint (-15 pts) if you get stuck - nobody sees it.',
    '🔥 Streaks give bonus points, but a correct answer always beats a fast guess.',
    '🐛 Wrong answers give you a mini "try again" question on the same idea.',
    '🏆 Speed adds at most 40% - understanding is worth far more.',
  ];

  mount(root,
    h('div', { class: 'screen narrow' },
      h('div', { class: 'card center' },
        h('h1', { class: 'muted lobby-title' }, 'Join with this code:'),
        h('div', { class: 'bigcode', 'aria-label': `Game code ${store.code.split('').join(' ')}` }, store.code || '····'),
        h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '6px' } },
          h('span', { class: 'chip topic' }, store.nickname),
          store.team ? h('span', { class: 'chip' }, `👥 ${store.team}`) : null,
          countEl)),

      h('div', { class: 'card' },
        h('div', { class: 'spread', style: { marginBottom: '12px' } },
          h('h2', { style: { margin: 0 } }, 'Players in the room'),
          h('button', { class: 'btn small ghost', onClick: () => leave() }, 'Leave')),
        roster),

      h('div', { class: 'card' },
        h('h3', null, 'How this works'),
        h('ul', { style: { margin: 0, paddingLeft: '20px', color: 'var(--muted)' } },
          tips.map((t) => h('li', { style: { marginBottom: '6px' } }, t))),
        themeSwitch('Light mode', { marginTop: '14px' })),

      h('p', { class: 'center muted', id: 'waiting' }, 'Waiting for the teacher to start…')
    )
  );

  const renderRoster = (names) => {
    roster.textContent = '';
    names.forEach((n, i) => roster.appendChild(
      h('div', { class: 'p' },
        h('span', { class: 'dot attempting' }),
        h('span', null, n + (n === store.nickname ? ' (you)' : '')))));
    countEl.textContent = `${names.length} player${names.length > 1 ? 's' : ''}`;
  };
  const names = [store.nickname];
  renderRoster(names);

  unsubs.push(engine.on('peer-joined', (p) => {
    if (!names.includes(p.nickname)) names.push(p.nickname);
    renderRoster(names);
    document.getElementById('waiting')?.scrollIntoView({ block: 'nearest' });
  }));

  unsubs.push(engine.on('question', () => {
    toast('The game has started!', 'gold');
    go('#/play');
  }));

  unsubs.push(engine.on('control', (p) => {
    if (p.action === 'pause') toast('⏸️ Paused by teacher', 'gold');
  }));

  unsubs.push(engine.on('end', () => {
    clearActive();
    go('#/results');
  }));
}

function leave() {
  getActive()?.engine.leave?.();
  clearActive();
  go('#/');
}

export function destroy() {
  unsubs.forEach((u) => { try { u?.(); } catch { /* noop */ } });
  unsubs = [];
}
