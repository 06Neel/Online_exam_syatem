import { h, mount, toast } from '../ui.js';
import { store, save } from '../state.js';
import { go } from '../main.js';
import { LocalEngine } from '../game/localEngine.js';
import { setActiveGame, clearActive } from '../game/session.js';

export const title = 'Practice setup';

const TOPICS = [
  { id: 1, name: '🚀 Setup', desc: 'Python versions, terminal, Hello World' },
  { id: 2, name: '📦 Variables', desc: 'Names, types, operators, comments' },
  { id: 3, name: '🔀 Conditionals', desc: '%, random, booleans, if/elif/else' },
  { id: 4, name: '🔁 Loops', desc: 'while, for, range, nested loops' },
  { id: 5, name: '🔤 Strings', desc: 'len, slices, find, loops over text' },
  { id: 6, name: '📚 Lists', desc: 'Indexing, methods, nested lists' },
  { id: 7, name: '🗝️ Tuples & Dicts', desc: 'Immutability, keys, aliasing' },
];

export function render(root) {
  const cfg = { ...store.practiceConfig };
  cfg.units = [...(cfg.units || [1, 2, 3, 4, 5, 6, 7])];

  const startBtn = h('button', { class: 'btn primary big block', onClick: () => start() }, 'Start practicing →');

  const unitChecks = TOPICS.map((t) => {
    const box = h('input', {
      type: 'checkbox',
      checked: cfg.units.includes(t.id),
      onChange: (e) => {
        if (e.target.checked) cfg.units = [...new Set([...cfg.units, t.id])].sort();
        else cfg.units = cfg.units.filter((u) => u !== t.id);
        row.classList.toggle('on', e.target.checked);
        updateCount();
        updateBtn();
      },
    });
    const row = h('label', { class: `check ${cfg.units.includes(t.id) ? 'on' : ''}`, style: { width: '100%' } },
      box,
      h('span', null, h('b', null, t.name), h('div', { class: 'muted small', style: { fontWeight: 400 } }, t.desc)));
    return row;
  });

  const countRange = h('input', {
    type: 'range', min: '4', max: '30', step: '1', value: String(cfg.count || 12),
    'aria-label': 'How many questions',
    onInput: (e) => { cfg.count = Number(e.target.value); countLabel.textContent = `${cfg.count} questions`; },
    style: { width: '100%' },
  });
  const countLabel = h('b', null, `${cfg.count} questions`);

  const diffBtns = ['mixed', 'easy', 'medium', 'hard'].map((d) => h('button', {
    type: 'button',
    'aria-pressed': String(cfg.difficulty === d),
    onClick: () => {
      cfg.difficulty = d;
      diffBtns.forEach((b) => b.setAttribute('aria-pressed', String(b.textContent.toLowerCase().startsWith(d.slice(0, 4)))));
    },
  }, d === 'mixed' ? 'Mixed 🎲' : d[0].toUpperCase() + d.slice(1)));

  // Question timer: a switch, not a checkbox (the practice screen keeps its checkbox count)
  if (cfg.timerOn === undefined) cfg.timerOn = true;
  const timerBtns = [[true, 'On ⏱️'], [false, 'Off 🐢']].map(([on, label]) => h('button', {
    type: 'button',
    'aria-pressed': String(cfg.timerOn === on),
    onClick: () => {
      cfg.timerOn = on;
      timerBtns.forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0) === on)));
    },
  }, label));

  function updateCount() {
    const per = cfg.units.length || 1;
    countRange.max = String(Math.min(40, per * 7));
    if (Number(countRange.value) < per * 2) countRange.value = String(per * 2);
    cfg.count = Number(countRange.value);
    countLabel.textContent = `${cfg.count} questions`;
  }

  function updateBtn() {
    startBtn.disabled = cfg.units.length === 0;
    startBtn.textContent = cfg.units.length === 0
      ? 'Pick at least one topic'
      : `Start practicing → (${cfg.count} questions)`;
  }
  updateCount();
  updateBtn();

  async function start() {
    startBtn.disabled = true;
    startBtn.textContent = 'Loading questions…';
    try {
      save({ practiceConfig: { units: cfg.units, count: cfg.count, difficulty: cfg.difficulty, timerOn: cfg.timerOn, marks: cfg.marks, costs: cfg.costs, negativeMarking: cfg.negativeMarking, negativeAmount: cfg.negativeAmount } });
      const engine = new LocalEngine({ units: cfg.units, count: cfg.count, difficulty: cfg.difficulty, timerOn: cfg.timerOn, marks: cfg.marks, costs: cfg.costs, negativeMarking: cfg.negativeMarking, negativeAmount: cfg.negativeAmount });
      await engine.init();
      clearActive();
      setActiveGame(engine, { mode: 'practice', marks: cfg.marks, costs: cfg.costs, negativeMarking: cfg.negativeMarking, negativeAmount: cfg.negativeAmount });
      go('#/play');
      setTimeout(() => engine.start(), 40);
    } catch (e) {
      toast(e.message || 'Could not load questions.', 'bad');
      startBtn.disabled = false;
      updateBtn();
    }
  }

  mount(root,
    h('div', { class: 'screen narrow' },
      h('div', { class: 'row', style: { marginBottom: '14px' } },
        h('button', { class: 'btn small ghost', onClick: () => go('#/') }, '← Home'),
        h('span', { class: 'chip topic' }, '🌱 Private practice')),

      h('div', { class: 'card' },
        h('h1', null, 'Practice your way'),
        h('p', { class: 'muted' }, 'No leaderboard, no timer pressure on marks - one clean run through the questions you choose.'),

        h('h2', null, 'Pick your levels'),
        h('div', { class: 'col', style: { gap: '8px' } }, unitChecks),

        h('div', { class: 'divider' }),
        h('div', { class: 'spread' }, h('h2', { style: { margin: 0, fontSize: '1.1rem' } }, 'How many?'), countLabel),
        countRange,

        h('div', { class: 'divider' }),
        h('h2', null, 'Difficulty'),
        h('div', { class: 'segmented' }, diffBtns),

        h('div', { class: 'divider' }),
        h('h2', null, 'Question timer'),
        h('div', { class: 'segmented' }, timerBtns),
        h('p', { class: 'muted small', style: { margin: '8px 0 0' } },
          'Off means no countdown - answer at your own pace.'),

        h('div', { style: { marginTop: '18px' } }, startBtn)),

      h('p', { class: 'muted small center' }, 'Tip: keep the first run short - you can always start another one from more topics.')
    )
  );
}
