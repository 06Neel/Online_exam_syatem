// Question bank editor: browse, write, fix, check and download every question.
// Works on ONE selected bank at a time - its questions, units, tags and save
// routes all come from that bank alone (scenario: no cross-bank leakage).
import { h, mount, toast, modal } from '../ui.js';
import { request } from '../net.js';
import { store, save as saveState } from '../state.js';
import { go } from '../main.js';
import { signOut } from '../auth.js';
import { validateQuestions } from '../../../shared/validate.js';
import { UNITS as BASE_UNITS, QUESTION_TYPES, DIFFICULTIES } from '../../../shared/units.js';
import { bankLine, renameBankModal, confirmRemoveBank, duplicateBank } from '../bankui.js';

export const title = 'Question bank';

// the open bank's unit list; refreshed from the server on every bank load.
let unitList = [...BASE_UNITS];

const TYPES = [
  { id: 'mcq', label: 'Multiple choice (mcq)' },
  { id: 'code-output', label: 'What does this code print? (code-output)' },
  { id: 'spot-error', label: 'Spot the error (spot-error)' },
  { id: 'fill-blank', label: 'Fill in the blank (fill-blank)' },
  { id: 'match', label: 'Match the pairs (match)' },
];
const TYPE_IDS = [...QUESTION_TYPES];
const TYPE_SHORT = {
  mcq: 'MCQ',
  'code-output': 'code output',
  'spot-error': 'spot error',
  'fill-blank': 'fill blank',
  match: 'match',
};
const DIFFS = [...DIFFICULTIES];
const OPT_IDS = ['a', 'b', 'c', 'd'];
const ID_RE = /^u\d{1,2}-q\d{2}$/;
const MINI_RADIO = 'pa-mini-answer';

const STYLE = `
.pa-split{display:grid;grid-template-columns:minmax(250px,360px) minmax(0,1fr);gap:16px;align-items:start;}
@media (max-width:900px){.pa-split{grid-template-columns:1fr;}}
.pa-list{display:grid;gap:8px;max-height:64vh;overflow-y:auto;padding-right:4px;}
@media (max-width:900px){.pa-list{max-height:none;}}
.pa-row{display:grid;gap:6px;text-align:left;width:100%;min-height:48px;padding:10px 12px;border-radius:12px;
  background:var(--surface);border:1px solid var(--line);color:var(--text);font:inherit;cursor:pointer;}
.pa-row:hover{border-color:var(--accent);}
.pa-row[aria-current="true"]{border-color:var(--brand);background:rgba(255,209,202,.10);box-shadow:inset 0 0 0 1px var(--brand);}
.pa-row-top{display:flex;gap:6px;flex-wrap:wrap;align-items:center;}
.pa-prompt{font-size:.88rem;color:var(--muted);overflow:hidden;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;}
.pa-opt{display:grid;grid-template-columns:auto auto minmax(0,1fr) auto;gap:8px;align-items:center;
  background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:8px 10px;}
.pa-pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr) auto;gap:8px;align-items:center;
  background:var(--surface);border:1px solid var(--line);border-radius:12px;padding:8px 10px;}
@media (max-width:720px){.pa-pair{grid-template-columns:1fr;}}
.pa-lab{font-weight:700;font-size:.95rem;}
.pa-err{color:var(--bad);font-size:.86rem;font-weight:700;}
.field.has-error input,.field.has-error textarea,.field.has-error select{border-color:var(--bad);}
.pa-sk{display:grid;gap:10px;}
`;

let disposed = true;
let bank = [];          // questions of the bank currently open
let bankInfo = null;    // that bank's own record (name, units, settings, ...)
let bankList = [];      // every bank of this teacher, for the selector
let reviewMap = new Map();
let draft = null;
let baseline = '';
let originalId = '';
let selectedId = '';
let pendingId = '';
let filterUnit = 'all';
let searchTerm = '';
let saving = false;
let styleNode = null;
let uidN = 0;
const cleanups = [];
let els = {};

const uid = (p) => `${p}-${++uidN}`;
const str = (v) => (v == null ? '' : String(v));
const optId = (i) => OPT_IDS[i] || String.fromCharCode(97 + i);
const splitList = (s) => str(s).split(',').map((x) => x.trim()).filter(Boolean);

/**
 * Select an option by value. Uses the `selected` property instead of
 * `select.value =` so it works in every DOM (some test DOMs expose `value`
 * as a getter only). Falls back to the first option when nothing matches.
 */
function selectValue(sel, want) {
  if (!sel) return false;
  const target = str(want);
  const opts = [...sel.querySelectorAll('option')];
  for (const o of opts) o.selected = false; // clear in one pass first
  let matched = false;
  for (const o of opts) {
    if (str(o.value) === target) { o.selected = true; matched = true; }
  }
  if (!matched && opts[0]) opts[0].selected = true;
  return matched;
}

export function render(root, params = {}) {
  disposed = false;
  els = {};
  pendingId = str(params.id);
  if (!store.teacherToken) {
    mount(root, gateCard());
    return;
  }
  injectStyle();
  mount(root, shell());
  const onKey = (e) => {
    if ((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')) {
      if (!draft || !els.form || !document.body.contains(els.form)) return;
      e.preventDefault();
      save();
    }
  };
  document.addEventListener('keydown', onKey);
  cleanups.push(() => document.removeEventListener('keydown', onKey));
  loadBank();
}

export function destroy() {
  disposed = true;
  while (cleanups.length) {
    try { cleanups.pop()(); } catch { /* already gone */ }
  }
  if (styleNode) {
    try { styleNode.remove(); } catch { /* already gone */ }
    styleNode = null;
  }
  bank = [];
  bankInfo = null;
  bankList = [];
  draft = null;
  baseline = '';
  originalId = '';
  selectedId = '';
  pendingId = '';
  els = {};
}

function injectStyle() {
  let node = document.getElementById('pa-editor-style');
  if (!node) {
    node = h('style', { id: 'pa-editor-style' }, STYLE);
    document.head.appendChild(node);
  }
  styleNode = node;
}

function gateCard() {
  return h('div', { class: 'screen narrow' },
    h('div', { class: 'row', style: { marginBottom: '14px' } },
      h('button', { class: 'btn small ghost', type: 'button', onClick: () => go('#/') }, '← Home'),
      h('span', { class: 'chip topic' }, '🎓 Question bank')),
    h('div', { class: 'card center' },
      h('h1', null, 'Sign in to open the question bank'),
      h('p', { class: 'muted' }, 'The editor belongs to a signed-in teacher, so we always know who saved what.'),
      h('div', { class: 'row', style: { justifyContent: 'center' } },
        h('button', { class: 'btn primary', type: 'button', onClick: () => go('#/teacher/login') }, 'Sign in'),
        h('button', { class: 'btn ghost', type: 'button', onClick: () => go('#/') }, 'Back home'))));
}

function skeletonRows(n) {
  const rows = [];
  for (let i = 0; i < n; i++) rows.push(h('div', { class: 'skeleton', style: { height: '62px' } }));
  return rows;
}

function shell() {
  const countChip = h('span', { class: 'chip' }, 'loading…');
  const shownChip = h('span', { class: 'chip' }, '');
  const list = h('div', { class: 'pa-list' }, skeletonRows(5));
  const form = h('section', { class: 'card', 'aria-label': 'Question form' },
    h('div', { class: 'pa-sk' },
      h('div', { class: 'skeleton', style: { height: '26px', width: '45%' } }),
      h('div', { class: 'skeleton', style: { height: '54px' } }),
      h('div', { class: 'skeleton', style: { height: '54px' } }),
      h('div', { class: 'skeleton', style: { height: '130px' } }),
      h('div', { class: 'skeleton', style: { height: '54px' } })));
  const chipsRow = h('div', { class: 'row', style: { gap: '6px' }, role: 'group', 'aria-label': 'Filter by unit' });
  const searchId = uid('search');

  const clearOnEdit = (e) => {
    const t = e.target;
    if (!t || typeof t.closest !== 'function') return;
    if (t.type === 'checkbox' || t.type === 'radio') return;
    const f = t.closest('.field');
    if (!f) return;
    f.classList.remove('has-error');
    f.querySelectorAll('.pa-err').forEach((el) => { el.textContent = ''; el.classList.add('hide'); });
  };
  form.addEventListener('input', clearOnEdit);
  cleanups.push(() => {
    form.removeEventListener('input', clearOnEdit);
    form.removeEventListener('change', clearOnEdit);
  });

  els = {
    count: countChip,
    shown: shownChip,
    list,
    form,
    chipsRow,
    saveBtn: null,
    search: null,
    bankSel: null,
    bankLine: null,
    renameBtn: null,
    dupBtn: null,
    delBtn: null,
  };

  const toolbar = h('div', { class: 'controls' },
    h('span', { class: 'chip topic' }, '🎓 Question bank'),
    countChip,
    h('span', { class: 'grow' }),
    h('button', { class: 'btn small', type: 'button', onClick: checkWholeBank }, '✔ Validate whole bank'),
    h('button', { class: 'btn small', type: 'button', onClick: downloadBank }, '⬇ Export bank JSON'),
    h('button', { class: 'btn small ghost', type: 'button', onClick: () => loadBank(selectedId) }, '↻ Refresh'),
    h('button', {
      class: 'btn small ghost', type: 'button', 'aria-label': 'Sign out of the teacher account',
      onClick: async () => { await signOut(); go('#/teacher/login'); },
    }, '⎋ Sign out'));

  // ---- pick ONE bank: everything below (questions, units, tags, saves) ----
  // comes from the selected bank alone.
  const bankSel = h('select', {
    id: 'bank-select',
    'aria-label': 'Select Question Bank',
    onChange: (e) => switchBank(e.target.value),
  });
  const bankLineEl = h('div', {
    class: 'small',
    style: { fontWeight: 700, margin: '4px 0 12px' },
  });
  const renameBtn = h('button', {
    class: 'btn small ghost', type: 'button', 'aria-label': 'Rename this question bank',
    onClick: () => { if (bankInfo) renameBankModal({ bank: bankInfo, onDone: () => loadBank(selectedId) }); },
  }, '✎ Rename');
  const dupBtn = h('button', {
    class: 'btn small ghost', type: 'button', 'aria-label': 'Duplicate this question bank',
    onClick: async () => {
      if (!bankInfo) return;
      const res = await duplicateBank(bankInfo);
      if (res && res.set && res.set.id) switchBank(res.set.id, true);
    },
  }, '⧉ Duplicate');
  const delBtn = h('button', {
    class: 'btn small ghost', type: 'button', 'aria-label': 'Remove this question bank',
    onClick: () => {
      if (!bankInfo || currentBankId() === 'default') return;
      confirmRemoveBank({
        bank: bankInfo,
        onDone: () => {
          saveState({ editorBankId: 'default' });
          searchTerm = '';
          filterUnit = 'all';
          selectedId = '';
          originalId = '';
          draft = null;
          loadBank();
        },
      });
    },
  }, '🗑 Remove');
  Object.assign(els, { bankSel, bankLine: bankLineEl, renameBtn, dupBtn, delBtn });

  const bankBar = h('div', { class: 'controls', style: { flexWrap: 'wrap', gap: '8px' } },
    h('label', { for: 'bank-select', class: 'pa-lab' }, 'Select Question Bank'),
    bankSel,
    h('span', { class: 'grow' }),
    renameBtn,
    dupBtn,
    delBtn);

  const left = h('section', { class: 'card', 'aria-label': 'Question list' },
    h('div', { class: 'spread' },
      h('h2', { style: { margin: 0 } }, 'Questions'),
      shownChip),
    h('button', { class: 'btn primary block', type: 'button', style: { marginTop: '10px' }, onClick: () => startNew(false) }, '＋ New question'),
    h('div', { class: 'field', style: { marginTop: '12px', marginBottom: '6px' } },
      h('div', { class: 'pa-lab' }, 'Filter by unit'),
      chipsRow),
    h('div', { class: 'field', style: { marginBottom: '10px' } },
      labelFor(searchId, 'Search'),
      h('input', {
        id: searchId, type: 'text', value: searchTerm,
        placeholder: 'prompt, id or tag', autocomplete: 'off',
        onInput: (e) => { searchTerm = e.target.value; renderList(); },
      }),
      h('span', { class: 'hint' }, 'Type part of a question, an id like u4-q07, or a tag.')),
    list);
  els.search = left.querySelector(`#${searchId}`);

  renderChips();

  return h('div', { class: 'screen wide' },
    h('h1', { class: 'sr-only' }, 'Question bank editor'),
    h('div', { class: 'row', style: { marginBottom: '14px' } },
      h('button', { class: 'btn small ghost', type: 'button', onClick: () => go('#/') }, '← Home'),
      h('button', { class: 'btn small ghost', type: 'button', onClick: () => go('#/teacher') }, '← Dashboard')),
    toolbar,
    bankBar,
    bankLineEl,
    h('div', { class: 'pa-split' }, left, form));
}

function renderChips() {
  const row = els.chipsRow;
  if (!row) return;
  row.textContent = '';
  const items = [{ v: 'all', label: 'All', aria: 'All units' }];
  for (const u of unitList) items.push({ v: String(u.id), label: String(u.id), aria: `Unit ${u.id}, ${u.name}`, title: u.name });
  for (const it of items) {
    const on = String(filterUnit) === it.v;
    row.append(h('button', {
      class: on ? 'chip topic' : 'chip',
      type: 'button',
      'aria-pressed': String(on),
      'aria-label': it.aria,
      title: it.title || null,
      onClick: () => { filterUnit = it.v; renderChips(); renderList(); },
    }, on ? '✓ ' : '', it.label));
  }
}

function visible() {
  const term = searchTerm.trim().toLowerCase();
  return bank.filter((q) => {
    if (filterUnit !== 'all' && Number(q.unit) !== Number(filterUnit)) return false;
    if (!term) return true;
    const hay = [q.id, q.prompt, ...(Array.isArray(q.tags) ? q.tags : [])].join(' ').toLowerCase();
    return hay.includes(term);
  });
}

function rowEl(q) {
  const on = q.id === selectedId;
  return h('button', {
    class: 'pa-row',
    type: 'button',
    'aria-current': on ? 'true' : 'false',
    onClick: () => selectQuestion(q.id),
  },
    h('div', { class: 'pa-row-top' },
      h('span', { class: 'chip mono' }, q.id),
      h('span', { class: 'chip topic' }, TYPE_SHORT[q.type] || str(q.type)),
      h('span', { class: 'chip' }, str(q.difficulty)),
      q.boss ? h('span', { class: 'chip boss' }, '👑 boss') : null,
      reviewMap.has(q.id)
        ? h('span', {
          class: 'chip bad',
          title: `The class missed ${Math.round((reviewMap.get(q.id) || 0) * 100)}% of recent answers to this question.`,
        }, '⚠ needs review')
        : null),
    h('div', { class: 'pa-prompt' }, str(q.prompt) || '(no prompt)'));
}

function renderList() {
  const list = els.list;
  if (!list) return;
  if (list.dataset.ready !== '1') return;
  const rows = visible();
  if (els.shown) els.shown.textContent = `${rows.length} of ${bank.length}`;
  list.textContent = '';
  if (!bank.length) {
    list.append(h('div', { class: 'empty' }, 'No questions yet - press “＋ New question” to write the first one.'));
    return;
  }
  if (!rows.length) {
    list.append(h('div', { class: 'empty' }, 'Nothing matches this filter. Try another unit or clear the search.'));
    return;
  }
  rows.forEach((q) => list.append(rowEl(q)));
}

function showErrorCard(msg) {
  const expired = /token|403|forbidden|session/i.test(str(msg));
  const head = expired ? 'Your teacher session has ended.' : 'We could not load the question bank.';
  const actions = h('div', { class: 'row', style: { justifyContent: 'center' } },
    expired
      ? h('button', { class: 'btn primary', type: 'button', onClick: () => go('#/teacher') }, 'Create a session')
      : h('button', { class: 'btn', type: 'button', onClick: () => loadBank() }, 'Try again'),
    h('button', { class: 'btn ghost', type: 'button', onClick: () => go('#/') }, 'Back home'));
  if (els.list) {
    els.list.dataset.ready = '';
    els.list.textContent = '';
    els.list.append(h('div', { class: 'empty' }, h('div', null, head), h('p', { class: 'muted small' }, str(msg)), actions));
  }
  if (els.form) {
    els.form.textContent = '';
    els.form.append(h('div', { class: 'empty' }, 'The editor stays locked until the bank loads.'));
  }
}

/** The bank this editor session is working on ('default' = built-in). */
function currentBankId() {
  return str(store.editorBankId) || 'default';
}

function fillBankSelector() {
  const sel = els.bankSel;
  if (!sel) return;
  const cur = currentBankId();
  sel.textContent = '';
  const list = bankList.length
    ? bankList
    : [{ id: 'default', name: 'Default question bank', label: 'Default question bank', count: bank.length }];
  for (const s of list) {
    const label = s.label || s.name || s.id;
    const suffix = typeof s.count === 'number' ? ` · ${s.count} questions` : '';
    sel.append(h('option', { value: s.id }, `${label}${suffix}`));
  }
  selectValue(sel, list.some((s) => s.id === cur) ? cur : (list[0] && list[0].id));
}

function paintBankLine() {
  const el = els.bankLine;
  if (!el) return;
  if (!bankInfo) { el.textContent = ''; return; }
  let text = bankLine({ name: bankInfo.name, count: bank.length, units: unitList });
  const s = bankInfo.settings;
  if (s) {
    const bits = [];
    if (s.points) bits.push(`${s.points.easy}/${s.points.medium}/${s.points.hard}/${s.points.boss} pts`);
    if (s.timers && s.timerOn !== false) bits.push(`${s.timers.easy}/${s.timers.medium}/${s.timers.hard}s`);
    if (s.timerOn === false) bits.push('timer off');
    if (bits.length) text += ` · defaults: ${bits.join(' · ')}`;
  }
  el.textContent = text;
  const isDefault = currentBankId() === 'default';
  if (els.renameBtn) els.renameBtn.disabled = isDefault;
  if (els.dupBtn) els.dupBtn.disabled = isDefault;
  if (els.delBtn) els.delBtn.disabled = isDefault;
}

function resetWorkingSet() {
  searchTerm = '';
  filterUnit = 'all';
  selectedId = '';
  originalId = '';
  draft = null;
  baseline = '';
  pendingId = '';
  if (els.search) els.search.value = '';
  renderChips();
}

/** Switch the editor to another bank: everything on screen is rebuilt. */
function switchBank(id, force) {
  const next = str(id);
  if (!next) return;
  if (next === currentBankId()) {
    selectValue(els.bankSel, next);
    if (!force) return;
  }
  const run = () => {
    saveState({ editorBankId: next });
    resetWorkingSet();
    loadBank();
  };
  if (!force && isDirty()) {
    confirmDiscard(run, () => selectValue(els.bankSel, currentBankId()));
    return;
  }
  run();
}

async function loadBank(preferId, retried) {
  if (disposed || !store.teacherToken) return;
  const first = !els.list || els.list.dataset.ready !== '1';
  if (first && els.list) {
    els.list.dataset.ready = '';
    els.list.textContent = '';
    els.list.append(...skeletonRows(5));
  }
  try {
    const bankId = currentBankId();
    const [summaries, content, reviewRows] = await Promise.all([
      request('/api/sets', { token: store.teacherToken }).catch(() => null),
      request(`/api/sets/${encodeURIComponent(bankId)}/questions`, { token: store.teacherToken }),
      request('/api/needs-review', { token: store.teacherToken }).catch(() => null),
    ]);
    if (disposed) return;
    if (!content || !Array.isArray(content.questions)) {
      throw new Error('That question bank no longer exists.');
    }
    bankList = Array.isArray(summaries) ? summaries : [];
    reviewMap = new Map((Array.isArray(reviewRows) ? reviewRows : []).map((r) => [r.id, r.missRate]));
    bankInfo = content;
    unitList = Array.isArray(content.units) && content.units.length ? content.units : [...BASE_UNITS];
    bank = content.questions;
    fillBankSelector();
    paintBankLine();
    renderChips();
    if (els.list) els.list.dataset.ready = '1';
    if (els.count) els.count.textContent = `${bank.length} question${bank.length === 1 ? '' : 's'}`;
    const want = preferId || pendingId || selectedId;
    pendingId = '';
    let q = want ? bank.find((x) => x.id === want) : null;
    if (!q) q = bank[0] || null;
    if (q) {
      selectedId = q.id;
      originalId = q.id;
      draft = fromQuestion(q);
    } else {
      const unit = unitForNew();
      selectedId = '';
      originalId = '';
      draft = newDraft(unit);
    }
    baseline = snap();
    renderList();
    renderForm();
  } catch (e) {
    if (disposed) return;
    // the picked bank is gone (removed elsewhere): fall back to the built-in one
    if (!retried && currentBankId() !== 'default') {
      saveState({ editorBankId: 'default' });
      return loadBank(preferId, true);
    }
    const msg = (e && e.message) || 'Could not load the question bank.';
    toast(msg, 'bad');
    showErrorCard(msg);
  }
}

function unitForNew() {
  if (filterUnit !== 'all') return Number(filterUnit) || 1;
  const cur = draft || bank.find((q) => q.id === selectedId);
  const n = cur ? Number(cur.unit) : 0;
  return unitList.some((u) => u.id === n) ? n : (unitList[0] ? unitList[0].id : 1);
}

/** Unit choices: the open bank's own units, plus "add a new one". */
function unitOptions() {
  return [
    ...unitList.map((u) => ({ value: u.id, label: `${u.id} · ${u.name}` })),
    { value: '__add__', label: '＋ Add a new unit to this bank…' },
  ];
}

/** Add a unit to the CURRENT bank only (never to the shared list). */
async function addUnit() {
  const raw = typeof prompt === 'function'
    ? prompt('Name for the new unit in this bank:', '')
    : null;
  const name = str(raw).trim().slice(0, 40);
  if (name.length < 2) { renderForm(); return; }
  try {
    if (currentBankId() === 'default') {
      const nextId = Math.max(7, ...unitList.map((u) => Number(u.id) || 0)) + 1;
      if (nextId > 99) {
        toast('The built-in bank can hold units 1-99 only.', 'bad');
        renderForm();
        return;
      }
      const res = await request('/api/units/list', {
        method: 'PUT',
        token: store.teacherToken,
        body: { units: [...unitList.map((u) => ({ id: u.id, name: u.name })), { id: nextId, name }] },
      });
      if (res && Array.isArray(res.units)) unitList = res.units;
      toast(`Unit added to the built-in bank.`, 'good');
    } else {
      const nextId = Math.max(99, ...unitList.map((u) => Number(u.id) || 0)) + 1;
      const res = await request(`/api/sets/${encodeURIComponent(currentBankId())}`, {
        method: 'PUT',
        token: store.teacherToken,
        body: { units: [...unitList.map((u) => ({ id: u.id, name: u.name })), { id: nextId, name }] },
      });
      const units = res && res.set && res.set.units;
      if (Array.isArray(units) && units.length) {
        unitList = units;
        if (bankInfo) bankInfo.units = units;
      }
      toast('Unit added to this bank.', 'good');
    }
    renderChips();
    renderForm();
  } catch (e) {
    toast((e && e.message) || 'Could not add that unit.', 'bad');
    renderForm();
  }
}

function nextFreeId(unit) {
  const used = new Set();
  for (const q of bank) {
    const m = /^u(\d{1,3})-q(\d{2})$/.exec(str(q.id));
    if (m && Number(m[1]) === Number(unit)) used.add(Number(m[2]));
  }
  let max = 0;
  used.forEach((n) => { if (n > max) max = n; });
  for (let n = max + 1; n <= 99; n++) if (!used.has(n)) return `u${unit}-q${String(n).padStart(2, '0')}`;
  for (let n = 1; n <= 99; n++) if (!used.has(n)) return `u${unit}-q${String(n).padStart(2, '0')}`;
  return `u${unit}-q99`;
}

function newDraft(unit) {
  return {
    id: nextFreeId(unit),
    unit: Number(unit) || 1,
    difficulty: 'easy',
    type: 'mcq',
    boss: false,
    prompt: '',
    code: '',
    options: [
      { text: '', correct: true },
      { text: '', correct: false },
      { text: '', correct: false },
      { text: '', correct: false },
    ],
    blank: '',
    accepted: '',
    pairs: [{ left: '', right: '' }, { left: '', right: '' }],
    explanation: '',
    analogy: '',
    hint: '',
    tags: '',
    mini: {
      prompt: '',
      type: 'mcq',
      options: [{ text: '' }, { text: '' }, { text: '' }, { text: '' }],
      answerIndex: 0,
      accepted: '',
      explanation: '',
    },
  };
}

function fromQuestion(q) {
  const type = TYPE_IDS.includes(q.type) ? q.type : 'mcq';
  const answer = Array.isArray(q.answer) ? q.answer : (q.answer ? [q.answer] : []);
  const options = (Array.isArray(q.options) ? q.options : []).map((o) => ({
    text: str(o && o.text),
    correct: answer.includes(o && o.id),
  }));
  while (options.length < 4) options.push({ text: '', correct: false });

  const m = q.mini || {};
  const mtype = m.type === 'fill-blank' ? 'fill-blank' : 'mcq';
  const moptions = (Array.isArray(m.options) ? m.options : []).map((o) => ({ text: str(o && o.text) }));
  while (moptions.length < 2) moptions.push({ text: '' });
  let answerIndex = moptions.findIndex((o, i) => optId(i) === str(m.answer));
  if (answerIndex < 0) answerIndex = 0;

  const pairs = Array.isArray(q.pairs) && q.pairs.length
    ? q.pairs.map((p) => ({ left: str(p && p.left), right: str(p && p.right) }))
    : [{ left: '', right: '' }, { left: '', right: '' }];

  return {
    id: str(q.id),
    unit: Number(q.unit) || 1,
    difficulty: DIFFS.includes(q.difficulty) ? q.difficulty : 'easy',
    type,
    boss: !!q.boss,
    prompt: str(q.prompt),
    code: str(q.code),
    options,
    blank: str(q.blank),
    accepted: (Array.isArray(q.accepted) ? q.accepted : []).join(', '),
    pairs,
    explanation: str(q.explanation),
    analogy: str(q.analogy),
    hint: str(q.hint),
    tags: (Array.isArray(q.tags) ? q.tags : []).join(', '),
    mini: {
      prompt: str(m.prompt),
      type: mtype,
      options: moptions,
      answerIndex,
      accepted: (Array.isArray(m.accepted) ? m.accepted : []).join(', '),
      explanation: str(m.explanation),
    },
  };
}

function buildQuestion() {
  const d = draft;
  const q = {
    id: str(d.id).trim(),
    unit: Number(d.unit),
    difficulty: d.difficulty,
    type: d.type,
    boss: !!d.boss,
    prompt: str(d.prompt).trim(),
  };
  if (d.type === 'fill-blank') {
    q.blank = str(d.blank).trim();
    q.accepted = splitList(d.accepted);
  } else if (d.type === 'match') {
    q.pairs = d.pairs.map((p) => ({ left: str(p.left).trim(), right: str(p.right).trim() }));
  } else {
    if (d.type === 'code-output' || d.type === 'spot-error') q.code = str(d.code);
    q.options = d.options.map((o, i) => ({ id: optId(i), text: str(o.text).trim() }));
    q.answer = d.options.map((o, i) => (o.correct ? optId(i) : null)).filter(Boolean);
  }
  q.explanation = str(d.explanation).trim();
  q.analogy = str(d.analogy).trim();
  q.hint = str(d.hint).trim();
  q.tags = splitList(d.tags);
  q.mini = buildMini();
  return q;
}

function buildMini() {
  const m = draft.mini;
  const out = {
    prompt: str(m.prompt).trim(),
    type: m.type === 'fill-blank' ? 'fill-blank' : 'mcq',
    explanation: str(m.explanation).trim(),
  };
  if (out.type === 'fill-blank') {
    out.accepted = splitList(m.accepted);
  } else {
    out.options = m.options.map((o, i) => ({ id: optId(i), text: str(o.text).trim() }));
    const idx = Math.min(Math.max(0, m.answerIndex || 0), Math.max(0, out.options.length - 1));
    out.answer = optId(idx);
  }
  return out;
}

function snap() {
  try { return JSON.stringify(buildQuestion()); } catch { return ''; }
}

function isDirty() {
  if (!draft) return false;
  return snap() !== baseline;
}

function confirmDiscard(then, onCancel) {
  modal({
    title: 'Discard your changes?',
    body: h('p', null, 'You have edits that are not saved yet. If you carry on, they are lost.'),
    actions: [
      { label: 'Keep editing', kind: 'ghost', onClick: () => { if (onCancel) onCancel(); } },
      { label: 'Discard changes', kind: 'danger', onClick: then },
    ],
  });
}

function applySelection(q) {
  selectedId = q.id;
  originalId = q.id;
  draft = fromQuestion(q);
  baseline = snap();
  renderList();
  renderForm();
}

function selectQuestion(id, force) {
  const q = bank.find((x) => x.id === id);
  if (!q) return;
  if (!force && isDirty()) { confirmDiscard(() => selectQuestion(id, true)); return; }
  applySelection(q);
}

function startNew(force) {
  if (!force && isDirty()) { confirmDiscard(() => startNew(true)); return; }
  const unit = unitForNew();
  selectedId = '';
  originalId = '';
  draft = newDraft(unit);
  baseline = snap();
  renderList();
  renderForm();
}

function cancel() {
  if (originalId) {
    const q = bank.find((x) => x.id === originalId);
    if (q) { applySelection(q); toast('Changes reverted'); return; }
  }
  startNew(true);
  toast('Changes reverted');
}

function errSpan(key) {
  return h('div', { class: 'pa-err hide', dataset: { err: key } });
}

function labelFor(id, text) {
  const el = h('label', null, text);
  el.setAttribute('for', id);
  return el;
}

function fld(o) {
  return h('div', { class: 'field' },
    o.id ? labelFor(o.id, o.label) : h('div', { class: 'pa-lab' }, o.label),
    o.input,
    o.hint ? h('span', { class: 'hint' }, o.hint) : null,
    errSpan(o.errKey));
}

function textField(key, label, value, opts = {}) {
  const id = uid('f');
  const input = h('input', {
    id,
    type: 'text',
    value: str(value),
    placeholder: opts.placeholder || null,
    pattern: opts.pattern || null,
    list: opts.list || null,
    autocomplete: 'off',
    onInput: (e) => { if (opts.onInput) opts.onInput(e.target.value); },
    onChange: opts.onChange || null,
  });
  const wrap = fld({ id, label, hint: opts.hint, input, errKey: key });
  if (opts.listEl) wrap.append(opts.listEl);
  return wrap;
}

function areaField(key, label, value, opts = {}) {
  const id = uid('f');
  const input = h('textarea', {
    id,
    rows: opts.rows || 3,
    value: str(value),
    placeholder: opts.placeholder || null,
    onInput: (e) => { if (opts.onInput) opts.onInput(e.target.value); },
    onChange: opts.onChange || null,
  });
  if (opts.code) input.spellcheck = false;
  return fld({ id, label, hint: opts.hint, input, errKey: key });
}

function selectField(key, label, value, options, onChange, hint) {
  const id = uid('f');
  const sel = h('select', { id, onChange: (e) => onChange(e.target.value) },
    options.map((o) => h('option', { value: String(o.value) }, o.label)));
  selectValue(sel, value);
  return fld({ id, label, hint, input: sel, errKey: key });
}

function setSectionError(key, msg) {
  const card = els.form;
  if (!card) return;
  const el = card.querySelector(`[data-err="${key}"]`);
  if (!el) return;
  el.textContent = msg || '';
  el.classList.toggle('hide', !msg);
  const f = el.closest('.field');
  if (f) f.classList.toggle('has-error', !!msg);
}

function clearErrors() {
  const card = els.form;
  if (!card) return;
  card.querySelectorAll('.pa-err').forEach((el) => { el.textContent = ''; el.classList.add('hide'); });
  card.querySelectorAll('.field').forEach((el) => el.classList.remove('has-error'));
}

function showErrors(list) {
  clearErrors();
  const card = els.form;
  if (!card || !list.length) return;
  const seen = new Set();
  for (const p of list) {
    if (seen.has(p.key)) continue;
    seen.add(p.key);
    setSectionError(p.key, p.msg);
  }
  const first = card.querySelector(`[data-err="${list[0].key}"]`);
  const box = first && first.closest('.field') && first.closest('.field').querySelector('input, textarea, select');
  if (box) {
    if (typeof box.focus === 'function') box.focus();
    if (box.scrollIntoView) box.scrollIntoView({ block: 'center' });
  }
}

const ID_HINT = 'Use the pattern u4-q07: u, the unit number 1-99, -q, then two digits.';

function idIssue() {
  const id = str(draft.id).trim();
  if (!id) return 'Every question needs an id.';
  if (currentBankId() === 'default') {
    if (!ID_RE.test(id)) return ID_HINT;
  } else if (id.length > 60) {
    return 'Keep the id to 60 characters or fewer.';
  }
  if (bank.some((x) => x.id === id && x.id !== originalId)) return `The id ${id} is already used by another question.`;
  return null;
}

function bossIssue() {
  if (!draft.boss) return null;
  const other = bank.find((x) => Number(x.unit) === Number(draft.unit) && x.boss && x.id !== originalId);
  return other
    ? `Unit ${draft.unit} already has a boss (${other.id}). Only one boss per unit - it plays last.`
    : null;
}

function pairsIssue() {
  const rights = draft.pairs.map((p) => str(p.right).trim()).filter(Boolean);
  if (new Set(rights).size !== rights.length) {
    return 'Two pairs share the same right-hand text - every right side must be unique.';
  }
  return null;
}

function checkOne(q) {
  const out = [];
  const add = (key, msg) => out.push({ key, msg });

  if (!q.id) add('id', 'Every question needs an id.');
  else if (currentBankId() === 'default' && !ID_RE.test(q.id)) add('id', ID_HINT);
  else if (currentBankId() !== 'default' && q.id.length > 60) add('id', 'Keep the id to 60 characters or fewer.');
  else if (bank.some((x) => x.id === q.id && x.id !== originalId)) add('id', `The id ${q.id} is already used by another question.`);

  if (!unitList.some((u) => u.id === q.unit)) add('unit', 'Pick a unit from the list.');
  if (!TYPE_IDS.includes(q.type)) add('type', 'Pick one of the five question types.');
  if (!DIFFS.includes(q.difficulty)) add('difficulty', 'Pick easy, medium or hard.');
  if (typeof q.boss !== 'boolean') add('boss', 'Boss has to be switched on or off.');
  if (q.boss) {
    const other = bank.find((x) => Number(x.unit) === Number(q.unit) && x.boss && x.id !== originalId);
    if (other) add('boss', `Unit ${q.unit} already has a boss (${other.id}). Only one boss per unit - it plays last.`);
  }
  if (!q.prompt || q.prompt.length < 5) add('prompt', 'Write the question itself - at least 5 characters.');
  if (!q.explanation || q.explanation.length < 20) add('explanation', 'Explain the answer in at least 20 characters.');
  if (!q.analogy || q.analogy.length < 15) add('analogy', 'Add a real-life analogy of at least 15 characters.');
  if (!q.hint || q.hint.length < 8) add('hint', 'Give a helpful hint of at least 8 characters.');
  if (!Array.isArray(q.tags) || q.tags.length < 1) add('tags', 'Add at least one tag, separated by commas.');

  if (q.type === 'fill-blank') {
    if (!q.blank) add('blank', 'Write the sentence that contains ___.');
    if (!Array.isArray(q.accepted) || q.accepted.length < 1) add('accepted', 'List at least one accepted answer, separated by commas.');
  } else if (q.type === 'match') {
    if (!Array.isArray(q.pairs) || q.pairs.length < 2) {
      add('pairs', 'A match question needs at least 2 pairs.');
    } else {
      q.pairs.forEach((p, i) => {
        if (!p.left || !p.right) add('pairs', `Pair ${i + 1} needs both a left and a right side.`);
      });
      const rights = new Set(q.pairs.map((p) => p.right));
      if (rights.size !== q.pairs.length) add('pairs', 'Every right-hand side must be unique.');
    }
  } else {
    if (!Array.isArray(q.options) || q.options.length !== 4) {
      add('options', 'A question needs exactly 4 options.');
    } else {
      q.options.forEach((o, i) => { if (!o.text) add('options', `Option ${optId(i)} is empty.`); });
      if (!Array.isArray(q.answer) || q.answer.length < 1) add('options', 'Tick “Correct” on at least one option.');
      else {
        const ids = new Set(q.options.map((o) => o.id));
        q.answer.forEach((a) => { if (!ids.has(a)) add('options', `Answer ${a} is not one of the options.`); });
      }
    }
    if ((q.type === 'code-output' || q.type === 'spot-error') && (!q.code || q.code.length < 3)) {
      add('code', 'This type needs a code snippet of at least 3 characters.');
    }
  }

  const m = q.mini;
  if (!m) add('mini', 'The try-again question is missing.');
  else {
    if (!m.prompt || m.prompt.length < 5) add('mini.prompt', 'Write the mini question - at least 5 characters.');
    if (!m.explanation || m.explanation.length < 10) add('mini.explanation', 'Explain the mini answer in at least 10 characters.');
    if (m.type === 'fill-blank') {
      if (!Array.isArray(m.accepted) || !m.accepted.length) add('mini.accepted', 'List at least one accepted answer, separated by commas.');
    } else if (!Array.isArray(m.options) || m.options.length < 2) {
      add('mini.options', 'The mini question needs at least 2 options.');
    } else {
      m.options.forEach((o, i) => { if (!o.text) add('mini.options', `Mini option ${optId(i)} is empty.`); });
      if (!m.options.some((o) => o.id === m.answer)) add('mini.options', 'Pick which mini option is correct.');
    }
  }
  return out;
}

function checkBank(list) {
  // shared with npm run validate and the upload screen - one set of rules,
  // checked against THIS bank's own unit list only (no cross-bank units).
  const errors = validateQuestions(list, { units: unitList }).flat;
  const { warnings } = validateQuestions(list, { coverage: true, units: unitList });
  return { errors, warnings };
}

/** Unique tags inside the open bank - offered on the tags field. */
function bankTags() {
  const set = new Set();
  for (const q of bank) {
    for (const t of Array.isArray(q.tags) ? q.tags : []) {
      const v = str(t).trim();
      if (v) set.add(v);
    }
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}

function renderForm() {
  const card = els.form;
  if (!card) return;
  card.textContent = '';
  if (!draft) {
    card.append(h('div', { class: 'empty' }, 'Pick a question on the left, or press “＋ New question”.'));
    return;
  }
  const editing = !!originalId;
  const d = draft;
  const tagListId = uid('tags');

  card.append(
    h('div', { class: 'spread' },
      h('h2', { style: { margin: 0 } }, editing ? `Edit ${originalId}` : 'New question'),
      h('span', { class: editing ? 'chip topic' : 'chip' }, editing ? 'saved question' : 'not saved yet')),
    errSpan('form'));

  card.append(h('div', { class: 'grid cols-2', style: { marginTop: '12px' } },
    textField('id', 'Question id', d.id, {
      placeholder: 'u4-q07',
      pattern: currentBankId() === 'default' ? 'u[1-7]-q[0-9]{2}' : null,
      hint: currentBankId() === 'default'
        ? 'Pattern: u, the unit number 1-99, -q, then two digits.'
        : 'Any id unique within this bank, up to 60 characters.',
      onInput: (v) => { d.id = v; },
      onChange: () => setSectionError('id', idIssue()),
    }),
    selectField('unit', 'Unit', d.unit, unitOptions(), (v) => {
      if (v === '__add__') { addUnit(); return; }
      d.unit = Number(v);
      if (!originalId) {
        d.id = nextFreeId(d.unit);
        const idEl = card.querySelector('[data-err="id"]');
        const input = idEl && idEl.closest('.field') && idEl.closest('.field').querySelector('input');
        if (input) input.value = d.id;
        setSectionError('id', null);
      }
      setSectionError('boss', bossIssue());
    }, 'Which topic this question belongs to.')));

  card.append(h('div', { class: 'grid cols-2' },
    difficultyField(),
    selectField('type', 'Question type', d.type, TYPES, (v) => {
      d.type = v;
      renderForm();
    }, 'Decides how students answer.')));

  card.append(bossField());

  card.append(areaField('prompt', 'Question prompt', d.prompt, {
    rows: 3,
    placeholder: 'What is the output of this code?',
    hint: 'What students read first - at least 5 characters.',
    onInput: (v) => { d.prompt = v; },
  }));

  if (d.type === 'code-output' || d.type === 'spot-error') {
    card.append(areaField('code', 'Python code', d.code, {
      rows: 6,
      code: true,
      placeholder: 'total = 0\nfor n in range(1, 6):\n    total = total + n\nprint(total)',
      hint: 'The exact snippet students see - at least 3 characters.',
      onInput: (v) => { d.code = v; },
    }));
  }

  if (d.type === 'fill-blank') card.append(fillBlankSection());
  else if (d.type === 'match') card.append(matchSection());
  else card.append(optionsSection());

  card.append(areaField('explanation', 'Explanation', d.explanation, {
    rows: 3,
    placeholder: 'Why the right answer is right…',
    hint: 'Shown after the reveal. At least 20 characters.',
    onInput: (v) => { d.explanation = v; },
  }));

  card.append(areaField('analogy', 'Analogy', d.analogy, {
    rows: 2,
    placeholder: 'It is like…',
    hint: 'A real-life comparison students can picture. At least 15 characters.',
    onInput: (v) => { d.analogy = v; },
  }));

  card.append(h('div', { class: 'grid cols-2' },
    textField('hint', 'Hint', d.hint, {
      placeholder: 'Count from the first number up to…',
      hint: 'At least 8 characters. Students see it when they ask for help.',
      onInput: (v) => { d.hint = v; },
    }),
    textField('tags', 'Tags', d.tags, {
      placeholder: 'for loop, range',
      hint: 'Comma separated - at least one tag.',
      list: tagListId,
      listEl: h('datalist', { id: tagListId }, bankTags().map((t) => h('option', { value: t }))),
      onInput: (v) => { d.tags = v; },
    })));

  card.append(miniSection());

  const saveBtn = h('button', { class: 'btn primary', type: 'button', onClick: () => save() }, '💾 Save question');
  const deleteBtn = editing
    ? h('button', { class: 'btn danger', type: 'button', onClick: askDelete }, '🗑 Delete')
    : null;
  els.saveBtn = saveBtn;
  card.append(h('div', { class: 'row', style: { marginTop: '18px' } },
    saveBtn,
    h('button', { class: 'btn ghost', type: 'button', onClick: cancel }, 'Cancel'),
    deleteBtn,
    h('span', { class: 'muted small' }, 'Tip: Ctrl + S saves.')));
}

function difficultyField() {
  const d = draft;
  const btns = DIFFS.map((diff) => h('button', {
    type: 'button',
    'aria-pressed': String(d.difficulty === diff),
    onClick: () => {
      d.difficulty = diff;
      btns.forEach((b, i) => b.setAttribute('aria-pressed', String(DIFFS[i] === diff)));
      setSectionError('difficulty', null);
    },
  }, diff[0].toUpperCase() + diff.slice(1)));
  return h('div', { class: 'field', role: 'group', 'aria-label': 'Difficulty' },
    h('div', { class: 'pa-lab' }, 'Difficulty'),
    h('div', { class: 'segmented' }, btns),
    h('span', { class: 'hint' }, 'Easy is quick, hard gives more points.'),
    errSpan('difficulty'));
}

function bossField() {
  const d = draft;
  const box = h('input', {
    type: 'checkbox',
    checked: d.boss,
    onChange: (e) => {
      d.boss = e.target.checked;
      row.classList.toggle('on', e.target.checked);
      setSectionError('boss', bossIssue());
    },
  });
  const row = h('label', { class: d.boss ? 'check on' : 'check', style: { width: '100%' } },
    box,
    h('span', null, '👑 This question is the unit boss'));
  return h('div', { class: 'field' },
    row,
    h('span', { class: 'hint' }, 'Only one boss per unit - it plays last.'),
    errSpan('boss'));
}

function optionsSection() {
  const d = draft;
  const rows = d.options.map((o, i) => {
    const id = optId(i);
    const box = h('input', {
      type: 'checkbox',
      checked: !!o.correct,
      'aria-label': `Option ${id} is a correct answer`,
      onChange: (e) => { o.correct = e.target.checked; },
    });
    return h('div', { class: 'pa-opt' },
      h('span', { class: 'chip mono', 'aria-hidden': 'true' }, id),
      h('label', { class: 'check', style: { padding: '6px 10px' } }, box, h('span', null, 'Correct')),
      h('input', {
        type: 'text',
        value: o.text,
        placeholder: `Option ${id} text`,
        'aria-label': `Text for option ${id}`,
        onInput: (e) => { o.text = e.target.value; },
      }),
      h('button', {
        class: 'btn small ghost',
        type: 'button',
        'aria-label': `Remove option ${id}`,
        title: 'Remove this option',
        onClick: () => { d.options.splice(i, 1); renderForm(); },
      }, '✕'));
  });

  const restore = d.options.length !== 4
    ? h('button', {
      class: 'btn small ghost',
      type: 'button',
      onClick: () => {
        while (d.options.length > 4) d.options.pop();
        while (d.options.length < 4) d.options.push({ text: '', correct: false });
        renderForm();
      },
    }, '↺ Reset to the 4 options')
    : null;

  return h('div', { class: 'field' },
    h('div', { class: 'pa-lab' }, 'Answer options'),
    h('span', { class: 'hint' }, 'Exactly 4 options. Tick “Correct” for every option that is right.'),
    h('div', { class: 'col', style: { gap: '8px', marginTop: '8px' } }, rows),
    restore ? h('div', { class: 'row', style: { marginTop: '8px' } }, restore) : null,
    errSpan('options'));
}

function fillBlankSection() {
  const d = draft;
  return h('div', null,
    areaField('blank', 'Sentence with the blank', d.blank, {
      rows: 2,
      placeholder: 'range(1, 5) produces 1, 2, 3, ___ and stops before the 5.',
      hint: 'Write the whole sentence and mark the gap with three underscores: ___.',
      onInput: (v) => { d.blank = v; },
    }),
    textField('accepted', 'Accepted answers', d.accepted, {
      placeholder: '4, four',
      hint: 'Separate every accepted answer with a comma - at least one.',
      onInput: (v) => { d.accepted = v; },
    }));
}

function matchSection() {
  const d = draft;
  const rows = d.pairs.map((p, i) => h('div', { class: 'pa-pair' },
    h('input', {
      type: 'text',
      value: p.left,
      placeholder: 'Left side',
      'aria-label': `Left side of pair ${i + 1}`,
      onInput: (e) => { p.left = e.target.value; },
    }),
    h('input', {
      type: 'text',
      value: p.right,
      placeholder: 'Right side',
      'aria-label': `Right side of pair ${i + 1}`,
      onInput: (e) => { p.right = e.target.value; },
      onChange: (e) => { p.right = e.target.value; setSectionError('pairs', pairsIssue()); },
    }),
    h('button', {
      class: 'btn small ghost',
      type: 'button',
      'aria-label': `Remove pair ${i + 1}`,
      disabled: d.pairs.length <= 2,
      onClick: () => { d.pairs.splice(i, 1); renderForm(); },
    }, '✕')));

  return h('div', { class: 'field' },
    h('div', { class: 'pa-lab' }, 'Match pairs'),
    h('span', { class: 'hint' }, 'At least 2 pairs, and no two right-hand sides may repeat.'),
    h('div', { class: 'col', style: { gap: '8px', marginTop: '8px' } }, rows),
    h('div', { class: 'row', style: { marginTop: '8px' } },
      h('button', {
        class: 'btn small ghost',
        type: 'button',
        onClick: () => { d.pairs.push({ left: '', right: '' }); renderForm(); },
      }, '＋ Add pair')),
    errSpan('pairs'));
}

function miniSection() {
  const d = draft.mini;
  const body = [
    areaField('mini.prompt', 'Mini question', d.prompt, {
      rows: 2,
      placeholder: 'What is the point of a parameter such as name?',
      hint: 'Shown to students who got it wrong - at least 5 characters.',
      onInput: (v) => { d.prompt = v; },
    }),
    selectField('mini.type', 'Mini type', d.type, [
      { value: 'mcq', label: 'Multiple choice (mcq)' },
      { value: 'fill-blank', label: 'Fill in the blank (fill-blank)' },
    ], (v) => { d.type = v; renderForm(); }, 'The mini question is always one of these two types.'),
  ];

  if (d.type === 'fill-blank') {
    body.push(textField('mini.accepted', 'Accepted answers', d.accepted, {
      placeholder: '0, zero',
      hint: 'Comma separated - at least one accepted answer.',
      onInput: (v) => { d.accepted = v; },
    }));
  } else {
    const rows = d.options.map((o, i) => {
      const id = optId(i);
      const radio = h('input', {
        type: 'radio',
        name: MINI_RADIO,
        checked: i === d.answerIndex,
        'aria-label': `Mini option ${id} is the correct answer`,
        onChange: () => { d.answerIndex = i; },
      });
      return h('div', { class: 'pa-opt' },
        h('span', { class: 'chip mono', 'aria-hidden': 'true' }, id),
        h('label', { class: 'check', style: { padding: '6px 10px' } }, radio, h('span', null, 'Answer')),
        h('input', {
          type: 'text',
          value: o.text,
          placeholder: `Mini option ${id}`,
          'aria-label': `Text for mini option ${id}`,
          onInput: (e) => { o.text = e.target.value; },
        }),
        h('button', {
          class: 'btn small ghost',
          type: 'button',
          'aria-label': `Remove mini option ${id}`,
          disabled: d.options.length <= 2,
          onClick: () => {
            d.options.splice(i, 1);
            if (d.answerIndex >= d.options.length) d.answerIndex = d.options.length - 1;
            renderForm();
          },
        }, '✕'));
    });
    body.push(h('div', { class: 'field' },
      h('div', { class: 'pa-lab' }, 'Mini options'),
      h('span', { class: 'hint' }, 'Between 2 and 4 options. Pick the one that is correct.'),
      h('div', { class: 'col', style: { gap: '8px', marginTop: '8px' } }, rows),
      h('div', { class: 'row', style: { marginTop: '8px' } },
        d.options.length < 4
          ? h('button', {
            class: 'btn small ghost',
            type: 'button',
            onClick: () => { d.options.push({ text: '' }); renderForm(); },
          }, '＋ Add option')
          : h('span', { class: 'muted small' }, 'A mini question can have up to 4 options.')),
      errSpan('mini.options')));
  }

  body.push(areaField('mini.explanation', 'Mini explanation', d.explanation, {
    rows: 2,
    placeholder: 'Why the mini answer is right…',
    hint: 'At least 10 characters.',
    onInput: (v) => { d.explanation = v; },
  }));
  body.push(errSpan('mini'));

  return h('div', { class: 'mini' },
    h('div', { class: 'spread' },
      h('div', { class: 'mini-tag' }, 'Try again - mini question'),
      h('span', { class: 'chip refresher' }, '2nd chance')),
    h('p', { class: 'muted small' }, 'A short second-chance question shown right after a wrong answer.'),
    body);
}

async function save() {
  if (!draft || saving) return;
  const q = buildQuestion();
  const problems = checkOne(q);
  if (problems.length) {
    showErrors(problems);
    toast(`Fix ${problems.length} problem${problems.length === 1 ? '' : 's'} before saving.`, 'bad');
    return;
  }
  clearErrors();
  saving = true;
  if (els.saveBtn) { els.saveBtn.disabled = true; els.saveBtn.textContent = 'Saving…'; }
  try {
    // save routes through the OPEN bank: default edits the built-in bank,
    // set banks upsert their own copy of the question.
    const target = currentBankId() === 'default'
      ? '/api/bank'
      : `/api/sets/${encodeURIComponent(currentBankId())}/questions`;
    await request(target, { token: store.teacherToken, method: 'POST', body: q });
    if (disposed) return;
    toast('Saved ✔', 'good');
    const savedId = q.id;
    if (originalId && originalId !== savedId) {
      toast(`${originalId} was kept too - the new id made this a separate question.`, 'gold', 4200);
    }
    await loadBank(savedId);
  } catch (e) {
    if (disposed) return;
    const msg = (e && e.message) || 'Could not save that question.';
    toast(msg, 'bad');
    showErrors([{ key: 'form', msg }]);
  } finally {
    saving = false;
    if (els.saveBtn) {
      els.saveBtn.disabled = false;
      els.saveBtn.textContent = '💾 Save question';
    }
  }
}

function askDelete() {
  const id = originalId;
  if (!id) return;
  modal({
    title: 'Delete this question?',
    body: h('div', null,
      h('p', null, `Delete ${id}? It disappears from every quiz straight away.`),
      h('p', { class: 'muted small' }, 'This cannot be undone - you would have to type it in again.')),
    actions: [
      { label: 'Keep it', kind: 'ghost' },
      { label: 'Yes, delete it', kind: 'danger', onClick: () => doDelete(id) },
    ],
  });
}

async function doDelete(id) {
  try {
    const target = currentBankId() === 'default'
      ? `/api/bank/${encodeURIComponent(id)}`
      : `/api/sets/${encodeURIComponent(currentBankId())}/questions/${encodeURIComponent(id)}`;
    const res = await request(target, {
      token: store.teacherToken,
      method: 'DELETE',
    });
    if (disposed) return;
    if (res && res.ok === false) {
      toast('That question is part of the built-in bank - it cannot be removed here.', 'bad', 4000);
      return;
    }
    toast('Question deleted', 'good');
    selectedId = '';
    originalId = '';
    draft = null;
    await loadBank();
  } catch (e) {
    if (disposed) return;
    toast((e && e.message) || 'Could not delete that question.', 'bad');
  }
}

function checkWholeBank() {
  const { errors, warnings } = checkBank(bank);
  const line = (text, mark) => h('div', { class: 'small' }, `${mark} ${text}`);
  const listing = (items, mark, limit) => h('div', { class: 'col', style: { gap: '4px', maxHeight: '38vh', overflowY: 'auto' } },
    items.slice(0, limit).map((t) => line(t, mark)),
    items.length > limit ? h('div', { class: 'muted small' }, `…and ${items.length - limit} more`) : null);

  modal({
    title: 'Whole bank check',
    body: h('div', null,
      h('p', null, `${bank.length} question${bank.length === 1 ? '' : 's'} checked against the bank rules.`),
      h('div', { class: 'row' },
        h('span', { class: errors.length ? 'chip bad' : 'chip good' }, `${errors.length} error${errors.length === 1 ? '' : 's'}`),
        h('span', { class: warnings.length ? 'chip' : 'chip good' }, `${warnings.length} warning${warnings.length === 1 ? '' : 's'}`)),
      errors.length ? h('div', { style: { marginTop: '12px' } }, listing(errors, '✗', 40)) : null,
      errors.length ? null : h('p', { class: 'chip good', style: { marginTop: '12px' } }, '✔ No errors - every question follows the rules.'),
      warnings.length ? h('div', { style: { marginTop: '12px' } },
        h('div', { class: 'pa-lab' }, 'Warnings'),
        listing(warnings, '!', 20)) : null),
    actions: [{ label: 'Close', kind: 'primary' }],
  });
}

function downloadBank() {
  try {
    const payload = {
      title: (bankInfo && bankInfo.name) || 'Question bank',
      units: unitList,
      settings: (bankInfo && bankInfo.settings) || undefined,
      questions: bank,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const slug = str(payload.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'question-bank';
    const a = h('a', { href: url, download: `${slug}.json` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
    toast('Bank JSON downloaded', 'good');
  } catch (e) {
    toast(`Could not download: ${(e && e.message) || 'unknown error'}`, 'bad');
  }
}
