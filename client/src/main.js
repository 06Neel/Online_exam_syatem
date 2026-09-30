import { mount, h, toast } from './ui.js';
import { getSocket } from './net.js';
import { isTeacher, isAdmin, needsPasswordChange, verifySession, authToken } from './auth.js';

import * as home from './screens/home.js';
import * as join from './screens/join.js';
import * as lobby from './screens/lobby.js';
import * as play from './screens/play.js';
import * as results from './screens/results.js';
import * as practice from './screens/practice.js';
import * as teacherHome from './screens/teacherHome.js';
import * as teacherLive from './screens/teacherLive.js';
import * as editor from './screens/editor.js';
import * as upload from './screens/upload.js';
import * as units from './screens/units.js';
import * as reports from './screens/reports.js';
import * as report from './screens/report.js';
import * as login from './screens/login.js';
import * as admin from './screens/admin.js';

// auth: 'teacher' -> needs a teacher sign-in, 'admin' -> admin only.
// Unauthenticated visitors to either are quietly moved to the sign-in screen;
// admin pages answer "not found" for everyone else (same as a bad link).
const ROUTES = [
  { re: /^#?\/?$/, screen: home },
  { re: /^#\/join$/, screen: join },
  { re: /^#\/lobby$/, screen: lobby },
  { re: /^#\/play$/, screen: play },
  { re: /^#\/results$/, screen: results },
  { re: /^#\/practice$/, screen: practice },
  { re: /^#\/teacher\/login$/, screen: login },
  { re: /^#\/teacher$/, screen: teacherHome, auth: 'teacher' },
  { re: /^#\/teacher\/live$/, screen: teacherLive, auth: 'teacher' },
  { re: /^#\/teacher\/edit$/, screen: editor, auth: 'teacher' },
  { re: /^#\/teacher\/upload$/, screen: upload, auth: 'teacher' },
  { re: /^#\/teacher\/units$/, screen: units, auth: 'teacher' },
  { re: /^#\/teacher\/reports$/, screen: reports, auth: 'teacher' },
  { re: /^#\/teacher\/report\/[A-Za-z0-9]{4}$/, screen: report, auth: 'teacher' },
  { re: /^#\/admin$/, screen: admin, auth: 'admin' },
];

let current = null;

export function go(hash) {
  if (location.hash === hash) render();
  else location.hash = hash;
}

function guardFor(match) {
  if (match.auth === 'admin') return isAdmin() ? null : '#/';           // page-not-found for everyone else
  if (match.auth === 'teacher') return isTeacher() && !needsPasswordChange() ? null : '#/teacher/login';
  if (match.screen === login) {                                          // already signed in?
    if (isAdmin()) return '#/admin';
    if (isTeacher() && !needsPasswordChange()) return '#/teacher';
  }
  return null;
}

function render() {
  const hash = location.hash || '#/';
  const match = ROUTES.find((r) => r.re.test(hash)) || ROUTES[0];
  const blocked = guardFor(match);
  if (blocked) return go(blocked);                                        // hashchange re-runs render

  try {
    current?.destroy?.();
  } catch (e) {
    console.warn('cleanup failed', e);
  }
  current = match.screen;
  const main = document.getElementById('main');
  mount(main, h('div', { class: 'route' }));
  const holder = main.firstElementChild;
  const params = Object.fromEntries(new URLSearchParams(hash.split('?')[1] || ''));
  current.render(holder, params);
  document.title = current.title ? `${current.title} · Python Adventure` : 'Python Adventure';

  if (match.auth && authToken()) verifySession();                        // drop stale sessions early
}

window.addEventListener('hashchange', render);

// connection feedback
const socket = getSocket();
socket.on('disconnect', () => toast('Connection lost - trying to reconnect…', 'bad', 3200));

if (document.readyState === 'loading') window.addEventListener('DOMContentLoaded', render, { once: true });
else render();
