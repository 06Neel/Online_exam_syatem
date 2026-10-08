// Shared top bar for the teacher and admin side: app name, 4 section tabs,
// who is signed in, and the only "Sign out" button on each screen.
import { h } from './ui.js';
import { store } from './state.js';
import { signOut } from './auth.js';
import { go } from './main.js';

const TABS = [
  ['home', 'Home', '#/teacher'],
  ['banks', 'Question Banks', '#/teacher/banks'],
  ['reports', 'Reports', '#/teacher/reports'],
  ['classes', 'Classes', '#/teacher/units'],
];

/** active: 'home' | 'banks' | 'reports' | 'classes' | '' (sub-screens keep their parent lit). */
export function topbar(active = '', { admin = false, tabs = true } = {}) {
  const who = admin
    ? 'Administrator'
    : (store.auth?.name || store.auth?.id || 'Teacher');
  const homeHash = admin ? '#/admin' : '#/teacher';

  return h('header', { class: 'topbar' },
    h('a', {
      class: 'topbar-brand', href: homeHash,
      'aria-label': admin ? 'Python Adventure - admin panel' : 'Python Adventure - teacher home',
    },
      h('span', { class: 'topbar-logo', 'aria-hidden': 'true' }, '🐍'),
      h('b', null, 'Python Adventure')),
    tabs && !admin
      ? h('nav', { class: 'tabs', 'aria-label': 'Teacher sections' },
        TABS.map(([id, label, hash]) => h('a', {
          class: `tab${active === id ? ' on' : ''}`,
          href: hash,
          'aria-current': active === id ? 'page' : null,
          onClick: (e) => {
            if (location.hash === hash) { e.preventDefault(); go(hash); }
          },
        }, label)))
      : null,
    h('div', { class: 'topbar-end' },
      h('span', { class: 'topbar-user small' }, who),
      h('button', {
        class: 'btn small ghost', type: 'button', 'aria-label': 'Sign out of this account',
        onClick: async () => { await signOut(); go('#/teacher/login'); },
      }, 'Sign out')));
}
