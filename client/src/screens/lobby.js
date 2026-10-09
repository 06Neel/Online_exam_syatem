import { h, mount, toast, themeSwitch } from '../ui.js';
import { getActive, clearActive } from '../game/session.js';
import { enterSession } from '../game/enterSession.js';
import { store, save } from '../state.js';
import { go } from '../main.js';
import { fmtMarks } from '../../../shared/scoring.js';

export const title = 'Lobby';

let unsubs = [];
let resuming = false;

export function render(root) {
  const active = getActive();
  if (!active) {
    // a reload in the lobby: quietly rejoin so the student keeps their seat
    if (store.code && store.nickname && !resuming) {
      resuming = true;
      mount(root, h('div', { class: 'screen narrow' },
        h('div', { class: 'card center' },
          h('h1', { class: 'muted' }, 'Putting you back in the lobby…'))));
      enterSession({ code: store.code, nickname: store.nickname, team: store.team })
        .then(() => { resuming = false; render(root); })
        .catch((e) => {
          resuming = false;
          save({ code: '' });   // that session is gone - start from Home
          go('#/');
          toast(e.message || 'This session is no longer open.', 'bad', 4500);
        });
      return;
    }
    go('#/');
    return;
  }

  const { engine, meta } = active;
  if (meta.started) { go('#/play'); return; }

  const roster = h('div', { class: 'roster' }, h('div', { class: 'p' }, h('span', null, `${store.nickname} (you)`)));
  const countEl = h('span', { class: 'chip' }, '1 player');

  const costs = { hint: 0.5, fifty: 1, extraTime: 0, skip: 0, ...(meta.costs || {}) };
  const costNote = (n) => (Number(n) > 0 ? ` (-${fmtMarks(n)} marks)` : ' (free)');
  const tips = [
    `💡 You can use a Hint${costNote(costs.hint)} if you get stuck - nobody sees it.`,
    '🏆 Every question is worth its own marks: easy 1, medium 1.5, hard 2 (bosses 2).',
    '🐛 Wrong answers give you a mini "try again" question on the same idea.',
    meta.negativeMarking
      ? `⚠️ Negative marking is ON: a wrong answer costs ${fmtMarks(meta.negativeAmount ?? 0.25)} marks. Timeouts and skips are never penalised.`
      : '✅ No negative marking - a wrong answer simply scores 0 for that question.',
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

  unsubs.push(engine.on('rejoined', (res) => {
    // back online in the lobby: if the quiz started while we were away, follow
    if (res?.started) { meta.started = true; toast('The game has started!', 'gold'); go('#/play'); }
  }));

  unsubs.push(engine.on('session-lost', (msg) => {
    clearActive();
    go('#/join');
    toast(msg || 'This session is no longer open.', 'bad', 4500);
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
