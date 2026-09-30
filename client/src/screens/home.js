import { h, mount, themeSwitch } from '../ui.js';
import { store } from '../state.js';
import { go } from '../main.js';
import { request } from '../net.js';

export const title = 'Home';

export function render(root) {
  const facts = [];
  request('/api/facts').then((d) => {
    const all = [...(d.bugs || []), ...(d.didYouKnow || [])];
    if (all.length) {
      ticker.querySelector('.t').textContent = all[Math.floor(Math.random() * all.length)];
    }
  }).catch(() => {});

  const ticker = h('div', { class: 'ticker', style: { marginBottom: '18px' } },
    h('b', null, '🐍 '), h('span', { class: 't' }, 'Welcome to Python Adventure - mistakes welcome here.'));

  mount(root,
    h('div', { class: 'screen narrow' },
      h('div', { class: 'brand', style: { marginBottom: '18px' } },
        h('span', { class: 'logo' }, '🐍'),
        h('h1', null, 'Python Adventure',
          h('small', null, 'Learn Python by playing - no scary marks, promise.'))),

      ticker,

      h('div', { class: 'col', style: { gap: '14px' } },

        h('div', { class: 'card' },
          h('h2', null, '🎮 Join a live game'),
          h('p', { class: 'muted' }, 'Your teacher has given a 4-character code. Hop in with a fun nickname - real name optional.'),
          h('button', { class: 'btn primary big block', onClick: () => go('#/join') },
            store.code ? `Continue as ${store.nickname || 'player'}` : 'Enter game code'),
          store.nickname ? h('p', { class: 'muted small', style: { margin: '10px 0 0' } }, `Last time you played as "${store.nickname}".`) : null),

        h('div', { class: 'card' },
          h('h2', null, '🌱 Practice on your own'),
          h('p', { class: 'muted' }, 'Private mode: no leaderboard, unlimited retries, and revision questions from your weak areas.'),
          h('button', { class: 'btn block', onClick: () => go('#/practice') }, 'Start practicing')),

        h('div', { class: 'card' },
          h('h2', null, '🧑‍🏫 Teacher?'),
          h('p', { class: 'muted' }, 'Create a quiz, watch the class live, and download the report afterwards.'),
          h('button', { class: 'btn ghost block', onClick: () => go('#/teacher/login') }, 'Open teacher dashboard')),

        h('div', { class: 'card tight' },
          h('div', { class: 'spread' },
            h('span', null, 'Sound & motion'),
            h('button', {
              class: 'btn small',
              onClick: (e) => {
                const on = !store.soundOn;
                store.soundOn = on;
                localStorage.setItem('python-adventure-v1', JSON.stringify(store));
                e.currentTarget.textContent = on ? 'On' : 'Off';
              },
            }, store.soundOn === false ? 'Off' : 'On')),
          themeSwitch('Light mode', { marginTop: '10px' }),
          h('p', { class: 'muted small', style: { margin: '8px 0 0' } }, 'Animations follow your device setting for reduced motion. Light mode follows your device too, until you switch it here.')),

        h('p', { class: 'muted small center', style: { marginTop: '6px' } },
          '7 levels · 84 questions · badges, streaks and boss battles')
      )
    )
  );
}
