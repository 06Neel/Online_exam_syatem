// Create a quiz: a 4-step wizard with a progress bar and a sticky action bar.
//   1 Basics      - title + mode cards
//   2 Questions   - bank, upload-in-place, unit chips, count, difficulty
//   3 Timer       - timer switch (off by default) + scoring (marks, costs, negative)
//   4 Options     - grouped toggles + optional class/section/schedule
// Values are kept when moving between steps; "Skip to review" jumps to step 4.
import { h, mount, toast, hintIcon } from '../ui.js';
import { save, store } from '../state.js';
import { go } from '../main.js';
import { emitAck, request } from '../net.js';
import { authToken } from '../auth.js';
import { UNITS as BASE_UNITS } from '../../../shared/units.js';
import { topbar } from '../topbar.js';
import { createUploadWidget } from '../uploadWidget.js';
import { downloadTemplate } from '../questionFiles.js';

export const title = 'Create a quiz';

export const MARKS_DEFAULT = { easy: 1, medium: 1.5, hard: 2 };
export const COSTS_DEFAULT = { hint: 0.5, fifty: 1, extraTime: 0, skip: 0 };
export const NEGATIVE_DEFAULT = 0.25;

/** Fresh config with every sensible default (also used by Quick start). */
export function defaultCfg() {
  return {
    title: 'Python Adventure',
    mode: 'live',
    units: [1, 2, 3, 4, 5, 6, 7],
    count: 20,
    difficulty: 'mixed',
    teamMode: false,
    hideBottomOn: true,
    hideBottom: 3,
    leaderboardToStudents: true,
    useFacts: true,
    timers: { easy: 30, medium: 40, hard: 50, bossExtra: 10 },
    revealSeconds: 8,
    marks: { ...MARKS_DEFAULT },
    costs: { ...COSTS_DEFAULT },
    negativeMarking: false,
    negativeAmount: NEGATIVE_DEFAULT,
    shuffleOptions: true,
    allowHints: true,
    allowPowerups: true,
    lateJoin: true,
    opensAt: null,
    classId: '',
    className: '',
    section: '',
    timerOn: false,          // OFF by default: self-paced
    commonSeconds: null,
    quizSeconds: null,
    allowBack: false,
    allowSkip: true,
  };
}

/** The host:create body for a cfg (shared with Quick start). */
export function payloadFrom(cfg, selectedSet) {
  return {
    token: authToken(),
    setId: selectedSet ? selectedSet.id : undefined,
    title: (cfg.title || 'Python Adventure').trim(),
    mode: cfg.mode,
    units: [...cfg.units].sort((a, b) => a - b),
    count: cfg.count,
    difficulty: cfg.difficulty,
    teamMode: cfg.teamMode,
    hideBottom: cfg.hideBottomOn ? cfg.hideBottom : 0,
    leaderboardToStudents: cfg.leaderboardToStudents,
    useFacts: cfg.useFacts,
    timers: { ...cfg.timers },
    revealSeconds: cfg.revealSeconds,
    marks: { ...cfg.marks },
    costs: { ...cfg.costs },
    negativeMarking: !!cfg.negativeMarking,
    negativeAmount: Number(cfg.negativeAmount) || 0,
    shuffleOptions: cfg.shuffleOptions,
    allowHints: cfg.allowHints,
    allowPowerups: cfg.allowPowerups,
    lateJoin: cfg.lateJoin,
    opensAt: cfg.opensAt,
    classId: cfg.classId,
    className: cfg.className,
    section: cfg.section,
    timerOn: cfg.timerOn,
    commonSeconds: cfg.commonSeconds,
    quizSeconds: cfg.quizSeconds,
    allowBack: cfg.timerOn ? false : cfg.allowBack,
    allowSkip: cfg.timerOn ? true : cfg.allowSkip,
  };
}

/** Create the quiz and jump to the lobby. Returns null on success, Error otherwise. */
export async function createQuizWith(cfg, selectedSet) {
  const res = await emitAck('host:create', payloadFrom(cfg, selectedSet));
  if (res?.error || !res?.ok) throw new Error(res?.error || 'The server did not create the quiz.');
  save({ teacherToken: res.token, teacherCode: res.code, quizBankId: selectedSet?.id ?? store.quizBankId ?? null });
  go(`#/teacher/live${res.code ? `?code=${res.code}` : ''}`);
  return null;
}

const STEPS = ['Basics', 'Questions', 'Timer & scoring', 'Options'];

export function render(root) {
  let busy = false;
  let step = 1;
  let unitList = [...BASE_UNITS];
  let sets = null;
  let selectedSet = null;
  let setsLoading = true;
  let lastCounts = null;
  const cfg = defaultCfg();

  // ---------- shared widgets ----------
  const summaryEl = h('span', { class: 'wizard-summary small muted' });

  function updateSummary() {
    const bits = [`${cfg.count} questions`, `Timer ${cfg.timerOn ? 'on' : 'off'}`];
    if (cfg.teamMode) bits.push('Team mode');
    if (cfg.negativeMarking) bits.push('Negative marking');
    if (cfg.mode === 'practice') bits.push('Practice run');
    summaryEl.textContent = bits.join(' | ');
  }

  function makeNum(label, hint, min, max, get, set, { step = '1', integer = true } = {}) {
    const input = h('input', {
      type: 'number', min: String(min), max: String(max), step, value: String(get()),
      'aria-label': label,
      onInput: (e) => {
        const v = Number(e.target.value);
        if (!Number.isFinite(v)) return;
        const clamped = Math.min(max, Math.max(min, v));
        set(integer ? Math.round(clamped) : clamped);
        updateSummary();
      },
      style: { width: '100%' },
    });
    const node = h('label', { class: 'col field', style: { gap: '4px', flex: '1 1 120px', minWidth: '110px' } },
      h('span', { class: 'small label' }, label),
      input,
      hint ? h('span', { class: 'hint' }, hint) : null);
    return { node, input, sync: () => { input.value = String(get()); } };
  }

  function toggleRow(labelText, initial, apply, hint) {
    const box = h('input', {
      type: 'checkbox',
      checked: initial,
      onChange: (e) => { row.classList.toggle('on', e.target.checked); apply(e.target.checked); updateSummary(); },
    });
    const row = h('label', { class: `check ${initial ? 'on' : ''}`, style: { width: '100%' } },
      box,
      h('span', null, h('b', null, labelText, hint ? hintIcon(hint) : null)));
    return row;
  }

  // ============================================================
  // Step 1 - BASICS
  // ============================================================
  const titleField = h('div', { class: 'field' },
    h('label', { for: 'quiz-title' }, 'Quiz title'),
    h('input', {
      id: 'quiz-title', type: 'text', value: cfg.title, maxlength: '60',
      onInput: (e) => { cfg.title = e.target.value; },
    }));

  const MODES = [
    { id: 'live', label: 'Live quiz', desc: 'Leaderboard and game-show energy - the whole class plays together.' },
    { id: 'practice', label: 'Practice run', desc: 'Relaxed and private - students work at their own pace, no leaderboard.' },
  ];
  const modeCards = MODES.map((m) => h('button', {
    type: 'button',
    class: `mode-card${cfg.mode === m.id ? ' on' : ''}`,
    'aria-pressed': String(cfg.mode === m.id),
    onClick: () => {
      cfg.mode = m.id;
      modeCards.forEach((c, i) => {
        c.classList.toggle('on', MODES[i].id === m.id);
        c.setAttribute('aria-pressed', String(MODES[i].id === m.id));
      });
      cfg.timers = m.id === 'practice'
        ? { easy: 45, medium: 60, hard: 75, bossExtra: 15 }
        : { easy: 30, medium: 40, hard: 50, bossExtra: 10 };
      cfg.leaderboardToStudents = m.id !== 'practice';
      if (rowLeader) setCheckRow(rowLeader, cfg.leaderboardToStudents);
      updateSummary();
    },
  },
  h('b', null, m.id === 'live' ? '🎮 Live quiz' : '🐢 Practice run'),
  h('span', { class: 'mode-desc' }, m.desc)));

  const step1 = h('div', { class: 'wizard-step' },
    h('div', { class: 'col', style: { gap: '14px' } },
      titleField,
      h('div', null,
        h('div', { class: 'step-label' }, 'Mode'),
        h('div', { class: 'mode-grid' }, modeCards))));

  // ============================================================
  // Step 2 - QUESTIONS
  // ============================================================
  const setSel = h('select', {
    id: 'quiz-set',
    'aria-label': 'Select Question Bank',
    onChange: (e) => applySet((sets || []).find((s) => s.id === e.target.value) || null),
  });
  const setField = h('div', { class: 'field' },
    h('label', { for: 'quiz-set' }, 'Question bank'),
    setSel);

  function buildSetPicker() {
    setSel.textContent = '';
    setSel.append(h('option', { value: '' }, 'Choose a question bank…'));
    for (const s of sets || []) {
      setSel.append(h('option', { value: s.id }, `${s.label || s.name} · ${s.count} questions`));
    }
    setSel.style.display = (sets || []).length ? '' : 'none';
  }

  // unit chips (name + count) with Select all
  const unitChips = h('div', { class: 'chip-pick', role: 'group', 'aria-label': 'Units in this quiz' });
  const selAllBtn = h('button', {
    class: 'btn small', type: 'button',
    onClick: () => {
      cfg.units = unitList.map((u) => u.id);
      buildUnitChips();
      updateConfirm();
    },
  }, 'Select all');

  function buildUnitChips() {
    unitChips.textContent = '';
    cfg.units = cfg.units.filter((id) => unitList.some((u) => u.id === id));
    if (!cfg.units.length && unitList.length) cfg.units = unitList.map((u) => u.id);
    for (const u of unitList) {
      const on = cfg.units.includes(u.id);
      const info = lastCounts?.[u.id];
      const count = info ? `${info.total}` : '…';
      const chip = h('button', {
        type: 'button',
        class: `unit-chip${on ? ' on' : ''}`,
        'aria-pressed': String(on),
        onClick: () => {
          cfg.units = on
            ? cfg.units.filter((x) => x !== u.id)
            : [...new Set([...cfg.units, u.id])];
          buildUnitChips();
          updateConfirm();
        },
      }, h('b', null, u.name), h('span', { class: 'unit-n' }, `${count} question${count === '1' ? '' : 's'}`));
      unitChips.append(chip);
    }
    updateCreateState();
  }

  const countLabel = h('b', { class: 'small' }, `${cfg.count} questions`);
  const countRange = h('input', {
    type: 'range', min: '4', max: '40', step: '1', value: String(cfg.count),
    'aria-label': 'Number of questions in the quiz',
    onInput: (e) => { cfg.count = Number(e.target.value); countLabel.textContent = `${cfg.count} questions`; updateSummary(); updateConfirm(); },
    style: { width: '100%' },
  });

  const DIFFS = ['mixed', 'easy', 'medium', 'hard'];
  const diffBtns = DIFFS.map((d) => h('button', {
    type: 'button',
    'aria-pressed': String(cfg.difficulty === d),
    onClick: () => {
      cfg.difficulty = d;
      diffBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(DIFFS[i] === d)));
    },
  }, d === 'mixed' ? 'Mixed 🎲' : d[0].toUpperCase() + d.slice(1)));

  const confirmLine = h('div', { class: 'summary-line small' });
  function updateConfirm() {
    if (!selectedSet) { confirmLine.textContent = ''; return; }
    const names = cfg.units.map((u) => unitList.find((x) => x.id === u)?.name || `Unit ${u}`);
    confirmLine.textContent = `Using ${selectedSet.name} | ${selectedSet.count} questions | Units: ${names.join(', ')}`;
  }

  const upload = createUploadWidget({
    showTemplate: true,
    onImported: async (res) => {
      // the new bank appears in the dropdown and is selected immediately
      try {
        const list = await request('/api/sets', { token: authToken() });
        if (Array.isArray(list)) {
          sets = list;
          buildSetPicker();
          const fresh = list.find((s) => s.id === res?.file) || null;
          if (fresh) applySet(fresh);
        }
      } catch { /* toast already shown by the widget */ }
      updateCreateState();
    },
  });
  const uploadBox = h('div', { class: 'wizard-upload' },
    h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
      h('button', {
        class: 'btn small', type: 'button',
        onClick: () => {
          uploadBox.classList.toggle('open');
          uploadBtn.textContent = uploadBox.classList.contains('open') ? 'Hide upload' : 'Upload new questions (JSON)';
        },
      }, 'Upload new questions (JSON)'),
      h('button', {
        class: 'btn small ghost', type: 'button',
        onClick: () => downloadTemplate(),
      }, 'Download template')),
    h('div', { class: 'wizard-upload-body' }, upload.node));

  const step2 = h('div', { class: 'wizard-step' },
    h('div', { class: 'col', style: { gap: '14px' } },
      setField,
      uploadBox,
      h('div', null,
        h('div', { class: 'step-label' }, 'Units ', selAllBtn),
        unitChips),
      h('div', { class: 'row', style: { gap: '14px', alignItems: 'flex-end', flexWrap: 'wrap' } },
        h('div', { style: { flex: '2 1 220px' } },
          h('div', { class: 'spread' }, h('span', { class: 'step-label' }, 'How many questions'), countLabel),
          countRange),
        h('div', { style: { flex: '1 1 220px' } },
          h('div', { class: 'step-label' }, 'Difficulty'),
          h('div', { class: 'segmented' }, diffBtns))),
      confirmLine));
  const uploadBtn = uploadBox.querySelector('button');

  function applySet(entry) {
    selectedSet = entry || null;
    if (entry) {
      const units = (entry.units || []).map((u) => ({ id: u.id, name: u.name }));
      if (units.length) {
        unitList = units;
        cfg.units = units.map((u) => u.id);
        lastCounts = Object.fromEntries(entry.units.map((u) => [u.id, u]));
      }
      applySettings(entry.settings);
      buildUnitChips();
    }
    if (setSel.value !== (entry?.id || '')) setSel.value = entry?.id || '';
    save({ quizBankId: entry ? entry.id : null });
    updateConfirm();
    updateCreateState();
  }

  // a bank's saved defaults (marks, timers, length, ...) become the quiz cfg
  function applySettings(s) {
    if (!s) return;
    if (s.marks) Object.assign(cfg.marks, s.marks);
    if (s.costs) Object.assign(cfg.costs, s.costs);
    if (typeof s.negativeMarking === 'boolean') cfg.negativeMarking = s.negativeMarking;
    if (typeof s.negativeAmount === 'number') cfg.negativeAmount = s.negativeAmount;
    if (s.timers) Object.assign(cfg.timers, s.timers);
    if (typeof s.revealSeconds === 'number') cfg.revealSeconds = s.revealSeconds;
    if (typeof s.timerOn === 'boolean') cfg.timerOn = s.timerOn;
    if (typeof s.commonSeconds === 'number') cfg.commonSeconds = s.commonSeconds;
    if (typeof s.quizSeconds === 'number') cfg.quizSeconds = s.quizSeconds;
    if (typeof s.count === 'number') {
      cfg.count = s.count;
      countRange.value = String(s.count);
      countLabel.textContent = `${cfg.count} questions`;
    }
    if (s.difficulty) {
      cfg.difficulty = s.difficulty;
      diffBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(DIFFS[i] === s.difficulty)));
    }
    syncStep3();
    updateSummary();
  }

  request('/api/sets', { token: authToken() })
    .then((list) => {
      if (!Array.isArray(list) || !list.length) return legacyCounts();
      sets = list;
      setsLoading = false;
      buildSetPicker();
      const remembered = store.quizBankId ? list.find((s) => s.id === store.quizBankId) : null;
      if (remembered) applySet(remembered);
      else if (list.length === 1) applySet(list[0]);
      else updateCreateState();
    })
    .catch(() => legacyCounts());

  function legacyCounts() {
    setsLoading = false;
    updateCreateState();
    request('/api/units/list', { token: authToken() })
      .then((list) => {
        if (Array.isArray(list) && list.length) { unitList = list; buildUnitChips(); }
        return request('/api/units', { token: authToken() });
      })
      .then((map) => { lastCounts = map; buildUnitChips(); })
      .catch(() => buildUnitChips());
  }

  // ============================================================
  // Step 3 - TIMER AND SCORING
  // ============================================================
  const timerOnBtns = [[true, 'On ⏱️'], [false, 'Off 🐢']].map(([on, label]) => h('button', {
    type: 'button',
    'aria-pressed': String(cfg.timerOn === on),
    onClick: () => {
      cfg.timerOn = on;
      timerOnBtns.forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0) === on)));
      refreshTimerUI();
      updateSummary();
    },
  }, label));

  const commonInput = h('input', {
    type: 'number', min: '5', max: '300', placeholder: 'By difficulty',
    'aria-label': 'Same seconds for every question (optional)',
    style: { width: '100%' },
    onInput: (e) => {
      const v = Number(e.target.value);
      cfg.commonSeconds = e.target.value === '' || !Number.isFinite(v)
        ? null : Math.min(300, Math.max(5, Math.round(v)));
    },
  });
  const commonField = h('label', { class: 'field', style: { flex: '1 1 200px' } },
    h('span', { class: 'small label' }, 'Same time for every question?', hintIcon('Blank = use the easy/medium/hard times below.')),
    commonInput);

  const quizLimitInput = h('input', {
    type: 'number', min: '1', max: '180', placeholder: 'No limit',
    'aria-label': 'Whole quiz time limit in minutes (optional)',
    style: { width: '100%' },
    onInput: (e) => {
      const v = Number(e.target.value);
      cfg.quizSeconds = e.target.value === '' || !Number.isFinite(v)
        ? null : Math.min(180, Math.max(1, Math.round(v))) * 60;
    },
  });

  const rowAllowBack = toggleRow('Let students go back', false, (v) => { cfg.allowBack = v; },
    'They can revisit earlier questions before finishing.');
  const rowAllowSkip = toggleRow('Let students skip ahead', true, (v) => { cfg.allowSkip = v; },
    'Move on now and come back to skipped questions later.');

  const timerCells = [
    makeNum('Easy (seconds)', 'per easy question', 5, 300, () => cfg.timers.easy, (v) => { cfg.timers.easy = v; }),
    makeNum('Medium (seconds)', null, 5, 300, () => cfg.timers.medium, (v) => { cfg.timers.medium = v; }),
    makeNum('Hard (seconds)', null, 5, 300, () => cfg.timers.hard, (v) => { cfg.timers.hard = v; }),
    makeNum('Boss bonus (seconds)', 'added to bosses', 0, 120, () => cfg.timers.bossExtra, (v) => { cfg.timers.bossExtra = v; }),
    makeNum('Reveal pause (seconds)', 'answer stays up', 3, 30, () => cfg.revealSeconds, (v) => { cfg.revealSeconds = v; }),
  ];

  // ---- scoring: negative marking switch + advanced marks/costs ----
  const negAmountInput = h('input', {
    type: 'number', min: '0', max: '10', step: '0.05', value: String(cfg.negativeAmount),
    'aria-label': 'Marks deducted for a wrong answer',
    style: { width: '110px' },
    onInput: (e) => {
      const v = Number(e.target.value);
      cfg.negativeAmount = Number.isFinite(v) && v >= 0 ? v : NEGATIVE_DEFAULT;
    },
  });
  const rowNegative = h('label', { class: `check ${cfg.negativeMarking ? 'on' : ''}`, style: { width: '100%' } },
    h('input', {
      type: 'checkbox',
      checked: cfg.negativeMarking,
      onChange: (e) => {
        cfg.negativeMarking = e.target.checked;
        rowNegative.classList.toggle('on', e.target.checked);
        negWrap.style.display = e.target.checked ? '' : 'none';
        updateSummary();
      },
    }),
    h('span', null, h('b', null, 'Negative marking', hintIcon('On = a wrong answer deducts marks. Timeouts and skips are never penalised.'))));
  const negWrap = h('div', { class: 'row', style: { gap: '8px', alignItems: 'center', paddingLeft: '4px', display: cfg.negativeMarking ? '' : 'none' } },
    h('span', { class: 'muted small' }, 'Wrong answer deducts'),
    negAmountInput,
    h('span', { class: 'muted small' }, 'marks'));

  const markCells = [
    makeNum('Easy marks', 'per correct answer', 0, 1000, () => cfg.marks.easy, (v) => { cfg.marks.easy = v; }, { step: '0.25', integer: false }),
    makeNum('Medium marks', null, 0, 1000, () => cfg.marks.medium, (v) => { cfg.marks.medium = v; }, { step: '0.25', integer: false }),
    makeNum('Hard marks', null, 0, 1000, () => cfg.marks.hard, (v) => { cfg.marks.hard = v; }, { step: '0.25', integer: false }),
  ];
  const costCells = [
    makeNum('Hint cost', null, 0, 1000, () => cfg.costs.hint, (v) => { cfg.costs.hint = v; }, { step: '0.25', integer: false }),
    makeNum('50:50 cost', null, 0, 1000, () => cfg.costs.fifty, (v) => { cfg.costs.fifty = v; }, { step: '0.25', integer: false }),
    makeNum('Extra time cost', '0 = free', 0, 1000, () => cfg.costs.extraTime, (v) => { cfg.costs.extraTime = v; }, { step: '0.25', integer: false }),
    makeNum('Skip cost', '0 = free', 0, 1000, () => cfg.costs.skip, (v) => { cfg.costs.skip = v; }, { step: '0.25', integer: false }),
  ];
  const resetMarksBtn = h('button', {
    class: 'btn small ghost', type: 'button',
    onClick: () => {
      cfg.marks = { ...MARKS_DEFAULT };
      cfg.costs = { ...COSTS_DEFAULT };
      cfg.negativeMarking = false;
      cfg.negativeAmount = NEGATIVE_DEFAULT;
      syncStep3();
      updateSummary();
      toast('Scoring reset to defaults.', '', 1600);
    },
  }, 'Reset to defaults');

  function syncStep3() {
    for (const c of [...timerCells, ...markCells, ...costCells]) c.sync();
    timerOnBtns.forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0) === cfg.timerOn)));
    commonInput.value = cfg.commonSeconds == null ? '' : String(cfg.commonSeconds);
    quizLimitInput.value = cfg.quizSeconds == null ? '' : String(Math.round(cfg.quizSeconds / 60));
    negAmountInput.value = String(cfg.negativeAmount);
    const negBox = rowNegative.querySelector('input');
    if (negBox) negBox.checked = cfg.negativeMarking;
    rowNegative.classList.toggle('on', cfg.negativeMarking);
    negWrap.style.display = cfg.negativeMarking ? '' : 'none';
    refreshTimerUI();
  }

  const timingGroup = h('div', { class: 'timing-group' },
    h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, commonField),
    h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, timerCells.map((c) => c.node)));

  const selfPacedBox = h('details', { class: 'opt-details' },
    h('summary', null, 'Self-paced options'),
    h('div', { class: 'col', style: { gap: '8px', marginTop: '10px' } },
      h('label', { class: 'field' },
        h('span', { class: 'small label' }, 'Whole quiz time limit?'),
        quizLimitInput),
      rowAllowBack,
      rowAllowSkip));

  const pacedOffHint = h('p', { class: 'muted small', style: { margin: '4px 0 0' } });

  function refreshTimerUI() {
    timingGroup.style.display = cfg.timerOn ? '' : 'none';
    selfPacedBox.style.display = cfg.timerOn ? 'none' : '';
    pacedOffHint.textContent = cfg.timerOn
      ? 'One shared countdown per question.'
      : 'Off = students answer when ready. You still see who is on which question, and can end anytime.';
  }

  const step3 = h('div', { class: 'wizard-step' },
    h('div', { class: 'col', style: { gap: '16px' } },
      h('div', null,
        h('div', { class: 'step-label' }, 'Question timer'),
        h('div', { class: 'segmented' }, timerOnBtns),
        pacedOffHint,
        timingGroup,
        selfPacedBox),
      h('div', { class: 'divider' }),
      h('div', { class: 'col', style: { gap: '10px' } },
        h('div', { class: 'step-label' }, 'Scoring'),
        rowNegative,
        negWrap,
        h('details', { class: 'opt-details' },
          h('summary', null, 'Advanced scoring'),
          h('div', { class: 'col', style: { gap: '10px', marginTop: '10px' } },
            h('div', { class: 'muted small' }, 'Marks per correct answer'),
            h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, markCells.map((c) => c.node)),
            h('div', { class: 'muted small', style: { marginTop: '6px' } }, 'Cost of help (subtracted from the score)'),
            h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap' } }, costCells.map((c) => c.node)),
            h('div', null, resetMarksBtn))))));

  // ============================================================
  // Step 4 - OPTIONS AND CLASS
  // ============================================================
  const hideNum = h('input', {
    type: 'number', min: '0', max: '20', value: '3',
    'aria-label': 'How many players to hide from the bottom of the leaderboard',
    style: { width: '90px' },
    onInput: (e) => { cfg.hideBottom = Math.max(0, Math.min(20, Number(e.target.value) || 0)); },
  });

  let rowLeader = null;
  const rowTeam = toggleRow('Team mode', false, (v) => { cfg.teamMode = v; },
    'Students pick a team name and the leaderboard groups them.');
  const rowHideBottom = toggleRow('Hide bottom ranks', cfg.hideBottomOn, (v) => {
    cfg.hideBottomOn = v;
    hideNumWrap.style.display = v ? '' : 'none';
  }, 'Lower scores stay private.');
  const hideNumWrap = h('div', { class: 'row', style: { gap: '8px', paddingLeft: '4px', alignItems: 'center', display: cfg.hideBottomOn ? '' : 'none' } },
    h('span', { class: 'muted small' }, 'Ranks to hide:'), hideNum);
  rowLeader = toggleRow('Show leaderboard to students', cfg.leaderboardToStudents, (v) => { cfg.leaderboardToStudents = v; },
    'Ranks appear on student screens during the game.');

  const step4 = h('div', { class: 'wizard-step' },
    h('div', { class: 'col', style: { gap: '16px' } },
      h('div', null,
        h('div', { class: 'step-label' }, 'Game'),
        h('div', { class: 'col', style: { gap: '8px' } },
          rowTeam,
          toggleRow('Hints allowed', cfg.allowHints, (v) => { cfg.allowHints = v; },
            'Students can reveal a hint, at a small cost to their marks.'),
          toggleRow('Power-ups allowed', cfg.allowPowerups, (v) => { cfg.allowPowerups = v; },
            '50:50, extra time and skip stay on the table.'),
          toggleRow('Fun facts', cfg.useFacts, (v) => { cfg.useFacts = v; },
            'A tiny Python tip while everyone waits.'))),
      h('div', null,
        h('div', { class: 'step-label' }, 'Leaderboard'),
        h('div', { class: 'col', style: { gap: '8px' } },
          rowLeader,
          rowHideBottom,
          hideNumWrap)),
      h('div', null,
        h('div', { class: 'step-label' }, 'Joining'),
        h('div', { class: 'col', style: { gap: '8px' } },
          toggleRow('Let students join late', cfg.lateJoin, (v) => { cfg.lateJoin = v; },
            'New players can enter after the quiz has started.'),
          toggleRow('Shuffle answer choices', cfg.shuffleOptions, (v) => { cfg.shuffleOptions = v; },
            'Options appear in a different order for everyone.'))),
      classDetails()));

  // ---- optional class, section, schedule (collapsed) ----
  function classDetails() {
    let classList = [];
    const classSel = h('select', { 'aria-label': 'Class for this quiz', onChange: (e) => pickClass(e.target.value) });
    const sectionSel = h('select', { 'aria-label': 'Section for this quiz', onChange: (e) => { cfg.section = e.target.value; } });

    function pickClass(id) {
      const c = classList.find((x) => x.id === id);
      cfg.classId = c?.id || '';
      cfg.className = c?.name || '';
      cfg.section = '';
      sectionSel.textContent = '';
      sectionSel.append(h('option', { value: '' }, 'Whole class'));
      for (const s of c?.sections || []) sectionSel.append(h('option', { value: s }, s));
    }
    function fillClassSel() {
      const keep = classSel.value;
      classSel.textContent = '';
      classSel.append(h('option', { value: '' }, 'No class (optional)'));
      for (const c of classList) classSel.append(h('option', { value: c.id }, c.name));
      if (classList.some((c) => c.id === keep)) classSel.value = keep;
      else pickClass(classSel.value);
    }
    request('/api/classes', { token: authToken() }).then((list) => {
      if (Array.isArray(list)) { classList = list; fillClassSel(); }
    }).catch(() => { /* no classes yet is fine */ });

    const whenInput = h('input', {
      type: 'datetime-local',
      'aria-label': 'Opens at, optional',
      onChange: (e) => { cfg.opensAt = e.target.value ? new Date(e.target.value).getTime() : null; },
    });

    return h('details', { class: 'opt-details' },
      h('summary', null, 'Class, section and schedule ', h('span', { class: 'muted small' }, '(optional)')),
      h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap', marginTop: '10px' } },
        h('label', { class: 'field', style: { flex: '1 1 160px' } },
          h('span', { class: 'small label' }, 'Class'), classSel),
        h('label', { class: 'field', style: { flex: '1 1 140px' } },
          h('span', { class: 'small label' }, 'Section'), sectionSel),
        h('label', { class: 'field', style: { flex: '1 1 200px' } },
          h('span', { class: 'small label' }, 'Opens at'), whenInput)));
  }

  // ============================================================
  // navigation, progress, sticky bar
  // ============================================================
  const stepNodes = [step1, step2, step3, step4];
  stepNodes.forEach((n, i) => { n.style.display = i === 0 ? '' : 'none'; });

  const stepItems = STEPS.map((label, i) => h('li', { class: `stp${i + 1 === step ? ' now' : ''}` },
    h('button', {
      type: 'button',
      class: 'stp-btn',
      onClick: () => goTo(i + 1),
      'aria-label': `Step ${i + 1}: ${label}`,
    }, h('span', { class: 'stp-n' }, String(i + 1)), h('span', null, label))));
  const progress = h('ol', { class: 'steps', 'aria-label': 'Create a quiz progress' }, stepItems);

  function paintProgress() {
    stepItems.forEach((li, i) => {
      li.classList.toggle('now', i + 1 === step);
      li.classList.toggle('done', i + 1 < step);
      const btn = li.querySelector('button');
      btn.setAttribute('aria-current', i + 1 === step ? 'step' : 'false');
    });
    stepNodes.forEach((n, i) => { n.style.display = i + 1 === step ? '' : 'none'; });
    backBtn.disabled = step === 1;
    skipBtn.style.display = step < 4 ? '' : 'none';
    nextBtn.style.display = step < 4 ? '' : 'none';
    createBtn.style.display = step === 4 ? '' : 'none';
    updateCreateState();
    updateSummary();
  }

  function goTo(n) {
    if (n < 1 || n > 4) return;
    if (n === step) return;
    if (step === 2 && n > 2) {
      const needSet = Array.isArray(sets) && sets.length > 1 && !selectedSet;
      if (needSet) { toast('Pick a question bank first.', 'bad'); return; }
      if (!cfg.units.length) { toast('Pick at least one unit first.', 'bad'); return; }
    }
    step = n;
    paintProgress();
  }

  const backBtn = h('button', { class: 'btn', type: 'button', onClick: () => goTo(step - 1) }, '← Back');
  const skipBtn = h('button', {
    class: 'btn ghost', type: 'button',
    onClick: () => { step = 4; paintProgress(); },
  }, 'Skip to review');
  const nextBtn = h('button', { class: 'btn primary', type: 'button', onClick: () => goTo(step + 1) }, 'Next →');
  const createBtn = h('button', { class: 'btn primary', type: 'button', onClick: () => doCreate() }, 'Create and open lobby');

  const wizardBar = h('div', { class: 'wizard-bar' },
    backBtn,
    h('div', { class: 'wizard-bar-mid' }, summaryEl, skipBtn),
    h('div', null, nextBtn, createBtn));

  function updateCreateState() {
    if (busy) return;
    const needSet = Array.isArray(sets) && sets.length > 1 && !selectedSet;
    const blocked = setsLoading || needSet || !cfg.units.length;
    createBtn.disabled = blocked;
    nextBtn.disabled = step === 2 ? blocked : false;
    createBtn.textContent = setsLoading
      ? 'Loading question banks…'
      : needSet ? 'Pick a question bank'
        : cfg.units.length ? 'Create and open lobby' : 'Pick at least one unit';
  }

  async function doCreate() {
    if (busy) return;
    if (!cfg.units.length) { toast('Pick at least one unit first.', 'bad'); return; }
    busy = true;
    createBtn.disabled = true;
    createBtn.textContent = 'Opening the lobby…';
    try {
      await createQuizWith(cfg, selectedSet);
    } catch (e) {
      toast(e.message || 'Could not create the quiz.', 'bad');
      busy = false;
      createBtn.textContent = 'Create and open lobby';
      updateCreateState();
    }
  }

  // ---------- page ----------
  mount(root,
    h('div', { class: 'screen narrow pro wizard' },
      topbar('home'),
      h('div', { class: 'page-head' },
        h('h1', null, 'Create a quiz'),
        h('p', { class: 'muted' }, 'Four short steps - you can change anything later by creating a new quiz.')),
      progress,
      h('div', { class: 'card wizard-card' }, stepNodes),
      wizardBar));

  buildUnitChips();
  syncStep3();
  paintProgress();
}
