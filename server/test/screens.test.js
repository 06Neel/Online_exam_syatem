// Renders every screen inside a lightweight DOM to catch runtime errors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';

const html = `<!doctype html><html><body>
  <div id="app"><main id="main"></main></div>
  <div id="toasts"></div><div id="fx"></div>
</body></html>`;

const { window, document } = parseHTML(html);

globalThis.__NO_WS__ = true; // never open a real websocket during DOM tests

globalThis.window = window;
globalThis.document = document;
globalThis.location = { hash: '#/', href: 'http://localhost/' };
globalThis.localStorage = {
  store: {},
  getItem(k) { return this.store[k] ?? null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; },
};
globalThis.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
globalThis.requestAnimationFrame = (cb) => setTimeout(cb, 0);
globalThis.cancelAnimationFrame = (id) => clearTimeout(id);
Object.defineProperty(globalThis, 'navigator', {
  value: { clipboard: { writeText: async () => {} }, userAgent: 'test' },
  configurable: true,
});
globalThis.scrollTo = () => {};
window.scrollTo = () => {};
window.matchMedia = globalThis.matchMedia;
window.location = globalThis.location;
window.addEventListener = window.addEventListener || (() => {});
window.removeEventListener = window.removeEventListener || (() => {});
globalThis.Element = window.Element;
globalThis.Node = window.Node;
globalThis.Event = window.Event;
globalThis.CustomEvent = window.CustomEvent;
window.Element.prototype.scrollIntoView = function () {};
document.readyState = 'complete';

let fetchCalls = [];
globalThis.fetch = async (url) => {
  fetchCalls.push(String(url));
  const json = { bugs: ['Bug of the Day: a typo is still a valid variable name.'], didYouKnow: ['Did you know? Python is named after Monty Python.'] };
  let body = json;
  if (String(url).includes('/api/units/list')) body = [
    { id: 1, name: 'Environment Setup', custom: false },
    { id: 2, name: 'Variables, Expressions & Statements', custom: false },
    { id: 3, name: 'Conditional Statements', custom: false },
    { id: 4, name: 'Iterative Statements', custom: false },
    { id: 5, name: 'Strings', custom: false },
    { id: 6, name: 'Lists', custom: false },
    { id: 7, name: 'Tuples & Dictionaries', custom: false },
  ];
  if (String(url).includes('/api/units')) body = { 1: { total: 12 } };
  if (String(url).includes('/api/sessions')) body = [];
  if (String(url).includes('/api/questions')) body = [];
  if (String(url).includes('/api/practice')) body = { questions: [], pool: [] };
  if (String(url).includes('/api/bank')) body = [];
  if (String(url).includes('/api/needs-review')) body = [];
  if (String(url).includes('/api/uploads')) body = [];
  if (String(url).includes('/api/health')) body = { ok: true };
  if (String(url).includes('/api/reports/TEST')) body = {
    code: 'TEST',
    title: 'Python Adventure',
    startedAt: 1700000000000,
    endedAt: 1700000600000,
    config: { mode: 'live', className: 'Year 7', section: 'A' },
    totals: { players: 1, answers: 4, accuracy: 0.75 },
    players: [{
      nickname: 'Solo', team: '', score: 340, correct: 3, wrong: 1, accuracy: 0.75,
      totalTimeMs: 62000, bestStreak: 2, badges: ['first'], needsHelp: false,
    }],
    questions: [{
      id: 'u7-q01', unit: 7, prompt: 'What does dict.get do?', correct: 3, wrong: 1,
      missRate: 0.25, avgTimeMs: 4200,
    }],
    unitStats: { 7: { correct: 3, total: 4, accuracy: 0.75 } },
    struggling: [],
    needsHelp: [],
  };
  if (String(url).includes('/api/reports') && !String(url).includes('/api/reports/')) body = [];
  return { ok: true, status: 200, json: async () => body };
};

const main = document.getElementById('main');
const render = async (path, screenModule) => {
  main.textContent = '';
  const container = document.createElement('div');
  main.appendChild(container);
  const mod = await screenModule;
  await mod.render(container, {});
  return container;
};

test('main router boots and renders the home screen', async () => {
  await import('../../client/src/main.js');
  await new Promise((r) => setTimeout(r, 30));
  const text = main.textContent;
  assert.ok(text.includes('Python Adventure'), 'brand shown');
  assert.ok(text.includes('Join a live game'), 'student entry point shown');
  assert.ok(text.includes('Teacher'), 'teacher entry point shown');
});

test('every screen renders without throwing', async () => {
  const screens = [
    ['join', '../../client/src/screens/join.js'],
    ['practice', '../../client/src/screens/practice.js'],
    ['lobby', '../../client/src/screens/lobby.js'],
    ['results', '../../client/src/screens/results.js'],
    ['home', '../../client/src/screens/home.js'],
    ['teacherHome', '../../client/src/screens/teacherHome.js'],
    ['teacherLive', '../../client/src/screens/teacherLive.js'],
    ['editor', '../../client/src/screens/editor.js'],
    ['upload', '../../client/src/screens/upload.js'],
    ['units', '../../client/src/screens/units.js'],
    ['reports', '../../client/src/screens/reports.js'],
    ['report', '../../client/src/screens/report.js'],
    ['play', '../../client/src/screens/play.js'],
    ['login', '../../client/src/screens/login.js'],
    ['admin', '../../client/src/screens/admin.js'],
  ];

  const redirects = ['lobby', 'play', 'teacherLive']; // need live state -> they bounce home
  for (const [name, path] of screens) {
    const container = await render(`#/`, import(path));
    const rendered = container.innerHTML + main.innerHTML;
    if (!redirects.includes(name)) {
      assert.ok(rendered.length > 40, `${name} rendered something (${rendered.length} chars)`);
    }
    const mod = await import(path);
    assert.equal(typeof mod.render, 'function', `${name} exports render`);
    if (typeof mod.destroy === 'function') mod.destroy();
  }
});

test('reports history lists sessions and the print page fetches one', async () => {
  fetchCalls = [];
  const list = await render('#/', import('../../client/src/screens/reports.js'));
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(fetchCalls.some((u) => u.includes('/api/reports')), 'history fetched the list');
  assert.ok(list.textContent.includes('Reports'), 'history heading shown');

  globalThis.location.hash = '#/teacher/report/TEST';
  fetchCalls = [];
  const page = await render('#/', import('../../client/src/screens/report.js'));
  await new Promise((r) => setTimeout(r, 40));
  assert.ok(fetchCalls.some((u) => u.includes('/api/reports/TEST')), 'print page fetched the report');
  assert.ok(page.textContent.includes('Session report'), 'report layout rendered');
  assert.ok(page.textContent.includes('Solo'), `players rendered | calls: ${JSON.stringify(fetchCalls)} | ${page.textContent.slice(0, 200)}`);
  globalThis.location.hash = '#/';
});

test('join screen validates the game code before talking to the server', async () => {
  fetchCalls = [];
  const container = await render('#/join', import('../../client/src/screens/join.js'));
  const buttons = [...container.querySelectorAll('button')];  const joinBtn = buttons.find((b) => b.textContent.includes('Join'));
  assert.ok(joinBtn, 'join button exists');
  joinBtn.click();
  await new Promise((r) => setTimeout(r, 20));
  const err = [...container.querySelectorAll('p')].map((p) => p.textContent).join(' ');
  assert.match(err, /4-character code/i, 'friendly validation message shown');
  assert.equal(fetchCalls.length, 0, 'no request fired before validation');
});

test('practice screen starts disabled when no topic is picked', async () => {
  const container = await render('#/practice', import('../../client/src/screens/practice.js'));
  const boxes = [...container.querySelectorAll('input[type="checkbox"]')];
  assert.equal(boxes.length, 7, 'all seven syllabus topics listed');
  const start = [...container.querySelectorAll('button')].find((b) => /Start practicing/.test(b.textContent));
  assert.ok(start, 'start button exists');
  assert.equal(start.disabled, false, 'default is all topics -> enabled');

  boxes.forEach((b) => { b.checked = false; b.dispatchEvent(new window.Event('change')); });
  await new Promise((r) => setTimeout(r, 10));
  const startAfter = [...container.querySelectorAll('button')].find((b) => /Start practicing|Pick at least/.test(b.textContent));
  assert.equal(startAfter.disabled, true, 'cannot start with zero topics');
});

test('results screen shows a friendly empty state without a report', async () => {
  const container = await render('#/results', import('../../client/src/screens/results.js'));
  assert.match(container.textContent, /No results yet|strength map/i);
});

test('editor is gated behind a teacher sign-in', async () => {
  const container = await render('#/teacher/edit', import('../../client/src/screens/editor.js'));
  assert.match(container.textContent, /sign in/i, 'editor explains how to unlock');
});

test('teacher screens render', async () => {
  const home = await render('#/teacher', import('../../client/src/screens/teacherHome.js'));
  assert.match(home.textContent, /quiz|session/i);

  // with a stored code the live screen tries to join; offline it must explain, not crash
  const { save } = await import('../../client/src/state.js');
  save({ teacherCode: 'TEST' });
  const live = await render('#/teacher/live', import('../../client/src/screens/teacherLive.js'));
  await new Promise((r) => setTimeout(r, 80));
  assert.ok(live.textContent.length > 20, `live screen produced output (got ${JSON.stringify(live.textContent.slice(0, 80))})`);
  const liveMod = await import('../../client/src/screens/teacherLive.js');
  assert.equal(typeof liveMod.destroy, 'function');
  liveMod.destroy(); // must stop its rotation interval so the process can exit
  save({ teacherCode: '' });
});

test('light mode toggles, persists and renders a switch', async () => {
  const { currentTheme, setTheme, store } = await import('../../client/src/state.js');

  setTheme('light');
  assert.equal(currentTheme(), 'light', 'light theme wins');
  assert.equal(document.documentElement.getAttribute('data-theme'), 'light');
  assert.equal(document.documentElement.style.colorScheme, 'light');
  assert.equal(store.theme, 'light', 'choice is remembered');
  assert.equal(JSON.parse(globalThis.localStorage.getItem('python-adventure-v1')).theme, 'light');

  const home = await render('#/', import('../../client/src/screens/home.js'));
  const row = [...home.querySelectorAll('.spread')].find((el) => (el.textContent || '').includes('Light mode'));
  assert.ok(row, 'home offers the toggle');
  const btn = row.querySelector('button');
  assert.equal((btn.textContent || '').trim(), 'On', 'switch shows it is on');
  btn.dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(currentTheme(), 'dark', 'clicking flips it back to dark');
  assert.equal(document.documentElement.getAttribute('data-theme'), 'dark');

  setTheme('');
  assert.equal(currentTheme(), 'dark', 'empty means follow the system (the test stub says dark)');
});

test('the editor works on one selected question bank at a time', async () => {
  const state = await import('../../client/src/state.js');
  state.save({ teacherToken: 'fake-editor-token', editorBankId: 'default' });

  const mcq = (id, unit, word) => ({
    id,
    type: 'mcq',
    difficulty: 'easy',
    boss: false,
    unit,
    prompt: `${word} question: which line stores a value?`,
    options: [
      { id: 'a', text: 'x = 5' },
      { id: 'b', text: 'x == 5' },
      { id: 'c', text: 'set x to five' },
      { id: 'd', text: 'x: 5' },
    ],
    answer: ['a'],
    explanation: 'The equals sign stores the value on the right into the name on the left.',
    analogy: 'Like putting a label on a box before you seal it shut.',
    hint: 'Look for the single equals sign here.',
    tags: [word.toLowerCase()],
    mini: {
      type: 'mcq',
      prompt: 'Which one compares instead of storing?',
      options: [{ id: 'a', text: 'x == 5' }, { id: 'b', text: 'x = 5' }],
      answer: 'a',
      explanation: 'The double equals sign compares two values instead of storing one.',
    },
  });

  const summaries = [
    { id: 'default', kind: 'default', name: 'Default question bank', label: 'Default question bank', count: 1, settings: null },
    { id: 'B', kind: 'upload', name: 'Beta bank', label: 'Beta bank', count: 1, settings: null },
  ];
  const bankA = {
    id: 'default', kind: 'default', name: 'Default question bank', label: 'Default question bank',
    count: 1, settings: null, units: [{ id: 1, name: 'Alpha One' }],
    questions: [mcq('u1-q01', 1, 'Alpha')],
  };
  const bankB = {
    id: 'B', kind: 'upload', name: 'Beta bank', label: 'Beta bank',
    count: 1, settings: null, units: [{ id: 100, name: 'Beta Unit' }],
    questions: [mcq('beta-q1', 100, 'Beta')],
  };

  const prevFetch = globalThis.fetch;
  const seen = [];
  globalThis.fetch = async (url) => {
    const u = String(url);
    seen.push(u);
    let body;
    if (u.includes('/api/needs-review')) body = [];
    else if (u.includes('/questions')) body = u.includes('/api/sets/B/') ? bankB : bankA;
    else if (u.includes('/api/sets')) body = summaries;
    else body = { bugs: [], didYouKnow: [] };
    return { ok: true, status: 200, json: async () => body };
  };

  const mod = await import('../../client/src/screens/editor.js');
  try {
    const container = await render('#/teacher/edit', mod);
    await new Promise((r) => setTimeout(r, 80));

    const sel = container.querySelector('#bank-select');
    assert.ok(sel, 'the bank selector exists');
    assert.equal(sel.value, 'default', 'the built-in bank opens first');
    assert.match(container.textContent, /Question Bank: Default question bank/, 'the bank line names it');
    assert.ok(container.textContent.includes('Alpha One'), 'default units shown');
    const renameBtn = [...container.querySelectorAll('button')].find((b) => b.textContent.includes('Rename'));
    assert.ok(renameBtn, 'rename action offered');
    assert.equal(renameBtn.disabled, true, 'the default bank cannot be renamed');
    const label = container.querySelector('label[for="bank-select"]');
    assert.ok(label && label.textContent.includes('Select Question Bank'), 'the selector is labelled');

    // ---- switch to bank B: every piece of the screen must follow ----
    const optB = [...sel.querySelectorAll('option')].find((o) => o.value === 'B');
    assert.ok(optB, 'bank B is offered in the selector');
    optB.selected = true;
    sel.dispatchEvent(new window.Event('change'));
    await new Promise((r) => setTimeout(r, 80));

    assert.ok(seen.some((u) => u.includes('/api/sets/B/questions')), 'bank B content was fetched');
    assert.equal(sel.value, 'B', 'the selector shows bank B');
    assert.match(container.textContent, /Question Bank: Beta bank/, 'the bank line follows');
    assert.ok(container.textContent.includes('Beta Unit'), 'bank B units drive the chips');
    assert.ok(!container.textContent.includes('Alpha One'), 'bank A units are gone');
    assert.ok(!container.textContent.includes('Alpha question'), 'bank A questions are gone');
    assert.ok(container.textContent.includes('Beta question'), 'bank B questions listed');
    assert.equal(renameBtn.disabled, false, 'a real bank can be renamed');
    assert.equal(state.store.editorBankId, 'B', 'the picked bank survives logout/refresh');

    // ---- logout and back in: the editor reopens on the same bank ----
    mod.destroy();
    const again = await render('#/teacher/edit', mod);
    await new Promise((r) => setTimeout(r, 80));
    const sel2 = again.querySelector('#bank-select');
    assert.ok(sel2, 'the selector comes back');
    assert.equal(sel2.value, 'B', 'the editor reopens on the same bank');
    assert.match(again.textContent, /Question Bank: Beta bank/, 'and shows its content');
  } finally {
    try { mod.destroy(); } catch { /* already gone */ }
    globalThis.fetch = prevFetch;
    state.save({ teacherToken: '', editorBankId: 'default' });
  }
});
