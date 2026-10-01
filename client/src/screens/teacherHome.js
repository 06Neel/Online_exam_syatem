// Teacher dashboard: build a new quiz, or reopen one that is already running.
import { h, mount, toast } from '../ui.js';
import { save, store } from '../state.js';
import { go } from '../main.js';
import { emitAck, request } from '../net.js';
import { authToken, signOut } from '../auth.js';
import { UNITS as BASE_UNITS } from '../../../shared/units.js';

export const title = 'Teacher dashboard';

const statusLabel = (s) => ({ lobby: 'Lobby', running: 'Live', paused: 'Paused', ended: 'Finished' }[s] || s);

export function render(root) {
  let busy = false;
  let unitList = [...BASE_UNITS];   // swapped for the bank's list once it loads
  let sets = null;        // null until /api/sets answers; array = the bank picker flow
  let selectedSet = null; // the entry this quiz will be built from
  let setsLoading = true; // keep Create quiet until we know which flow applies

  const cfg = {
    title: 'Python Adventure',
    mode: 'live',
    units: [1, 2, 3, 4, 5, 6, 7],
    count: 20,
    difficulty: 'mixed',
    teamMode: false,
    hideBottomOn: true,
    hideBottom: 3,
    leaderboardToStudents: true,
    revisionRounds: true,
    useFacts: true,
    timers: { easy: 30, medium: 40, hard: 50, bossExtra: 10 },
    revealSeconds: 8,
    points: { easy: 80, medium: 100, hard: 130, boss: 150 },
    shuffleOptions: true,
    allowHints: true,
    allowPowerups: true,
    lateJoin: true,
    opensAt: null,
    classId: '',
    className: '',
    section: '',
    // ---- question timer (the teacher's switch, default ON) ----
    timerOn: true,
    commonSeconds: null, // one time for every question (blank = per-difficulty)
    quizSeconds: null,   // whole-quiz limit in seconds (self-paced option)
    allowBack: false,    // self-paced: students may revisit earlier questions
    allowSkip: true,     // self-paced: students may skip ahead and return later
  };

  // ---------- mode (live quiz vs practice run) ----------
  const MODES = [
    { id: 'live', label: 'Live quiz', hint: 'Normal clock, leaderboard on - the game show setting.' },
    { id: 'practice', label: 'Practice run', hint: 'Calmer timers, no leaderboard on student screens.' },
  ];
  const modeBtns = MODES.map((m) => h('button', {
    type: 'button',
    'aria-pressed': String(cfg.mode === m.id),
    onClick: () => setMode(m.id),
  }, m.id === 'live' ? '🎮 Live quiz' : '🐢 Practice run'));
  const modeHint = h('div', { class: 'muted small' }, MODES[0].hint);

  function setMode(id) {
    cfg.mode = id;
    modeBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(MODES[i].id === id)));
    modeHint.textContent = (MODES.find((m) => m.id === id) || MODES[0]).hint;
    // preset timing + leaderboard to match the mode (teacher can still edit after)
    cfg.timers = id === 'practice'
      ? { easy: 45, medium: 60, hard: 75, bossExtra: 15 }
      : { easy: 30, medium: 40, hard: 50, bossExtra: 10 };
    cfg.leaderboardToStudents = id !== 'practice';
    syncTimerInputs();
    setCheckRow(rowLeader, cfg.leaderboardToStudents);
  }

  // ---------- topic checkboxes (with live question counts) ----------
  const hints = {};
  const unitBox = h('div', { class: 'col', style: { gap: '8px' } });

  function buildUnitRows() {
    unitBox.textContent = '';
    // drop topics that no longer exist (deleted unit) from the selection
    cfg.units = cfg.units.filter((id) => unitList.some((u) => u.id === id));
    if (!cfg.units.length && unitList.length) cfg.units = unitList.map((u) => u.id);
    for (const u of unitList) {
      const hint = h('div', { class: 'muted small', style: { fontWeight: 400 } }, 'counting the bank…');
      hints[u.id] = hint;
      const on = cfg.units.includes(u.id);
      const box = h('input', {
        type: 'checkbox',
        checked: on,
        onChange: (e) => {
          cfg.units = e.target.checked
            ? [...new Set([...cfg.units, u.id])].sort((a, b) => a - b)
            : cfg.units.filter((x) => x !== u.id);
          row.classList.toggle('on', e.target.checked);
          updateCreateBtn();
        },
      });
      const row = h('label', { class: `check ${on ? 'on' : ''}`, style: { width: '100%' } },
        box,
        h('span', null, h('b', null, `${u.id} · ${u.name}`), hint));
      unitBox.append(row);
    }
    fillCounts(lastCounts);
    updateCreateBtn();
  }

  let lastCounts = null;
  function fillCounts(map) {
    lastCounts = map;
    if (!map) return;
    for (const u of unitList) {
      const el = hints[u.id];
      if (!el) continue;
      const info = map[u.id];
      el.textContent = info
        ? `${info.total} question${info.total === 1 ? '' : 's'} · ${info.byDifficulty?.easy || 0} easy / ${info.byDifficulty?.medium || 0} medium / ${info.byDifficulty?.hard || 0} hard`
        : 'no questions yet';
    }
  }

  // ---------- question bank picker (each bank owns its units + defaults) ----------
  const confirmLine = h('div', {
    class: 'small',
    style: { fontWeight: 700, marginBottom: '10px' },
  });
  const setSel = h('select', {
    id: 'quiz-set',
    'aria-label': 'Select Question Bank',
    onChange: (e) => {
      const found = (sets || []).find((s) => s.id === e.target.value);
      applySet(found || null);
    },
  });
  const setField = h('div', { class: 'field', style: { display: 'none' } },
    h('label', { for: 'quiz-set' }, 'Question bank'),
    setSel,
    h('span', { class: 'hint' },
      'Every question bank keeps its own questions and units - the quiz uses only the bank you pick.'));

  function buildSetPicker() {
    setSel.textContent = '';
    setSel.append(h('option', { value: '' }, 'Choose a question bank…'));
    for (const s of sets || []) {
      setSel.append(h('option', { value: s.id }, `${s.label || s.name} · ${s.count} questions`));
    }
    setField.style.display = (sets || []).length > 1 ? '' : 'none';
  }

  // a bank's saved defaults (points, timers, length, ...) become the quiz cfg
  function applySettings(s) {
    if (!s) return;
    if (s.points) Object.assign(cfg.points, s.points);
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
    timerOnBtns.forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0) === cfg.timerOn)));
    commonInput.value = cfg.commonSeconds == null ? '' : String(cfg.commonSeconds);
    quizLimitInput.value = cfg.quizSeconds == null ? '' : String(Math.round(cfg.quizSeconds / 60));
    syncTimerInputs();
    refreshTimerUI();
  }

  function applySet(entry) {
    selectedSet = entry || null;
    if (entry) {
      const units = (entry.units || []).map((u) => ({ id: u.id, name: u.name }));
      if (units.length) {
        unitList = units;
        cfg.units = units.map((u) => u.id);
        buildUnitRows();
        fillCounts(Object.fromEntries(entry.units.map((u) => [u.id, u])));
      }
      applySettings(entry.settings);
    }
    if (setSel.value !== (entry?.id || '')) setSel.value = entry?.id || '';
    save({ quizBankId: entry ? entry.id : null });
    updateCreateBtn();
  }

  function paintConfirm() {
    if (!selectedSet) { confirmLine.textContent = ''; return; }
    const names = cfg.units.map((u) => {
      const found = unitList.find((x) => x.id === u);
      return found ? found.name : `Unit ${u}`;
    });
    confirmLine.textContent = `Using question bank: ${selectedSet.name} | ${selectedSet.count} questions | Units: ${names.join(', ')}`;
  }

  request('/api/sets', { token: authToken() })
    .then((list) => {
      if (!Array.isArray(list) || !list.length) return legacyCounts();
      sets = list;
      setsLoading = false;
      buildSetPicker();
      // the bank picked last time wins, else only one bank: pick it silently
      const remembered = store.quizBankId ? list.find((s) => s.id === store.quizBankId) : null;
      if (remembered) applySet(remembered);
      else if (list.length === 1) applySet(list[0]);
      else updateCreateBtn();
    })
    .catch(() => legacyCounts());

  function legacyCounts() {
    setsLoading = false;
    updateCreateBtn();
    request('/api/units/list', { token: authToken() })
      .then((list) => {
        if (Array.isArray(list) && list.length) { unitList = list; buildUnitRows(); }
        return request('/api/units', { token: authToken() });
      })
      .then((map) => fillCounts(map))
      .catch(() => {
        for (const u of unitList) if (hints[u.id]) hints[u.id].textContent = 'question counts unavailable right now';
      });
  }

  // ---------- difficulty ----------
  const DIFFS = ['mixed', 'easy', 'medium', 'hard'];
  const diffBtns = DIFFS.map((d) => h('button', {
    type: 'button',
    'aria-pressed': String(cfg.difficulty === d),
    onClick: () => {
      cfg.difficulty = d;
      diffBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(DIFFS[i] === d)));
    },
  }, d === 'mixed' ? 'Mixed 🎲' : d[0].toUpperCase() + d.slice(1)));

  // ---------- numeric settings (timing, scoring) ----------
  function makeNum(label, hint, min, max, get, set) {
    const input = h('input', {
      type: 'number', min: String(min), max: String(max), value: String(get()),
      'aria-label': label,
      onInput: (e) => {
        const v = Number(e.target.value);
        if (!Number.isFinite(v)) return;
        set(Math.min(max, Math.max(min, Math.round(v))));
      },
      style: { width: '100%' },
    });
    const node = h('label', { class: 'col', style: { gap: '4px', flex: '1 1 120px', minWidth: '110px' } },
      h('span', { class: 'small', style: { fontWeight: 700 } }, label),
      input,
      hint ? h('span', { class: 'muted small', style: { fontWeight: 400 } }, hint) : null);
    return { node, input, sync: () => { input.value = String(get()); } };
  }

  const timerCells = [
    makeNum('Easy (seconds)', 'per easy question', 5, 300, () => cfg.timers.easy, (v) => { cfg.timers.easy = v; }),
    makeNum('Medium (seconds)', null, 5, 300, () => cfg.timers.medium, (v) => { cfg.timers.medium = v; }),
    makeNum('Hard (seconds)', null, 5, 300, () => cfg.timers.hard, (v) => { cfg.timers.hard = v; }),
    makeNum('Boss bonus (seconds)', 'added to bosses', 0, 120, () => cfg.timers.bossExtra, (v) => { cfg.timers.bossExtra = v; }),
    makeNum('Reveal pause (seconds)', 'answer stays up', 3, 30, () => cfg.revealSeconds, (v) => { cfg.revealSeconds = v; }),
  ];
  const syncTimerInputs = () => { for (const c of timerCells) c.sync(); };

  const pointCells = [
    makeNum('Easy points', 'base score', 1, 1000, () => cfg.points.easy, (v) => { cfg.points.easy = v; }),
    makeNum('Medium points', null, 1, 1000, () => cfg.points.medium, (v) => { cfg.points.medium = v; }),
    makeNum('Hard points', null, 1, 1000, () => cfg.points.hard, (v) => { cfg.points.hard = v; }),
    makeNum('Boss points', 'for defeating a boss', 1, 1000, () => cfg.points.boss, (v) => { cfg.points.boss = v; }),
  ];

  // ---------- question timer switch + its two modes ----------
  const timerOnBtns = [[true, 'On ⏱️'], [false, 'Off 🐢']].map(([on, label]) => h('button', {
    type: 'button',
    'aria-pressed': String(cfg.timerOn === on),
    onClick: () => {
      cfg.timerOn = on;
      timerOnBtns.forEach((b, i) => b.setAttribute('aria-pressed', String((i === 0) === on)));
      refreshTimerUI();
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
  const commonField = h('label', { class: 'col', style: { gap: '4px', flex: '1 1 200px' } },
    h('span', { class: 'small', style: { fontWeight: 700 } }, 'Same time for every question?'),
    commonInput,
    h('span', { class: 'muted small', style: { fontWeight: 400 } },
      'Blank = the easy/medium/hard times below.'));

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
  const quizLimitField = h('label', { class: 'col', style: { gap: '4px', flex: '1 1 200px' } },
    h('span', { class: 'small', style: { fontWeight: 700 } }, 'Whole quiz time limit?'),
    quizLimitInput,
    h('span', { class: 'muted small', style: { fontWeight: 400 } },
      'Minutes for the whole class. Blank = untimed.'));

  const rowAllowBack = toggleRow('↩️ Let students go back',
    'They can revisit earlier questions before finishing.', false, (v) => { cfg.allowBack = v; });
  const rowAllowSkip = toggleRow('⏭️ Let students skip ahead',
    'Move on now and come back to skipped questions later.', true, (v) => { cfg.allowSkip = v; });

  const pacedBox = h('div', { class: 'col', style: { gap: '8px', marginTop: '10px' } },
    h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '10px' } }, quizLimitField),
    rowAllowBack, rowAllowSkip);

  const pacedOffHint = h('p', { class: 'muted small', style: { margin: '8px 0 0' } },
    'On = one shared countdown per question. Off = students go at their own pace.');

  function refreshTimerUI() {
    commonField.style.display = cfg.timerOn ? '' : 'none';
    pacedBox.style.display = cfg.timerOn ? 'none' : '';
    pacedOffHint.textContent = cfg.timerOn
      ? 'On = one shared countdown per question. Off = students go at their own pace.'
      : 'No countdown - students answer when ready. You still see who is on which question, and can end anytime.';
  }
  refreshTimerUI();

  // ---------- how many ----------
  const countLabel = h('b', null, `${cfg.count} questions`);
  const countRange = h('input', {
    type: 'range', min: '4', max: '40', step: '1', value: String(cfg.count),
    'aria-label': 'Number of questions in the quiz',
    onInput: (e) => { cfg.count = Number(e.target.value); countLabel.textContent = `${cfg.count} questions`; },
    style: { width: '100%' },
  });

  // ---------- toggles ----------
  function toggleRow(labelText, hint, initial, apply) {
    const box = h('input', {
      type: 'checkbox',
      checked: initial,
      onChange: (e) => { row.classList.toggle('on', e.target.checked); apply(e.target.checked); },
    });
    const row = h('label', { class: `check ${initial ? 'on' : ''}`, style: { width: '100%' } },
      box,
      h('span', null, h('b', null, labelText), h('div', { class: 'muted small', style: { fontWeight: 400 } }, hint)));
    return row;
  }

  function setCheckRow(row, on) {
    const box = row.querySelector('input');
    if (box) box.checked = on;
    row.classList.toggle('on', on);
  }

  const hideNum = h('input', {
    type: 'number', min: '0', max: '20', value: '3',
    'aria-label': 'How many players to hide from the bottom of the leaderboard',
    style: { width: '110px' },
    onInput: (e) => { cfg.hideBottom = Math.max(0, Math.min(20, Number(e.target.value) || 0)); },
  });

  // ---------- classroom: classes, sections, schedule ----------
  let classList = [];
  const classSel = h('select', {
    'aria-label': 'Class for this quiz',
    onChange: (e) => pickClass(e.target.value),
  }, h('option', { value: '' }, 'No class (optional)'));
  const sectionSel = h('select', {
    'aria-label': 'Section for this quiz',
    onChange: (e) => { cfg.section = e.target.value; },
  }, h('option', { value: '' }, 'Whole class'));

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

  const classField = h('label', { class: 'col', style: { gap: '4px', flex: '1 1 170px' } },
    h('span', { class: 'small', style: { fontWeight: 700 } }, 'Class'), classSel,
    h('span', { class: 'muted small', style: { fontWeight: 400 } }, 'Tags the session for reports.'));
  const sectionField = h('label', { class: 'col', style: { gap: '4px', flex: '1 1 150px' } },
    h('span', { class: 'small', style: { fontWeight: 700 } }, 'Section'), sectionSel,
    h('span', { class: 'muted small', style: { fontWeight: 400 } }, 'Everyone joins this section.'));
  const whenField = h('label', { class: 'col', style: { gap: '4px', flex: '2 1 220px' } },
    h('span', { class: 'small', style: { fontWeight: 700 } }, 'Opens at (optional)'), whenInput,
    h('span', { class: 'muted small', style: { fontWeight: 400 } }, 'Start stays locked until then.'));

  // ---------- run toggles ----------
  const rowLeader = toggleRow('🏁 Show the leaderboard to students', 'Students see ranks on their own screens during the game.', true, (v) => { cfg.leaderboardToStudents = v; });
  const toggles = [
    toggleRow('👥 Team mode', 'Everyone picks a team name and the leaderboard groups them.', false, (v) => { cfg.teamMode = v; }),
    toggleRow('🙈 Hide the bottom of the leaderboard', 'Lower scores stay private - nobody is put on the spot.', true, (v) => { cfg.hideBottomOn = v; hideNum.disabled = !v; }),
    h('div', { class: 'row', style: { paddingLeft: '4px', gap: '8px' } },
      h('span', { class: 'muted small' }, 'How many to hide:'), hideNum),
    rowLeader,
    toggleRow('🔀 Shuffle answer choices', 'Each student sees the options in a different order.', true, (v) => { cfg.shuffleOptions = v; }),
    toggleRow('💡 Hints allowed', 'Students can spend points on a hint.', true, (v) => { cfg.allowHints = v; }),
    toggleRow('⚡ Power-ups allowed', '50:50, extra time and skip stay on the table.', true, (v) => { cfg.allowPowerups = v; }),
    toggleRow('🚪 Let students join late', 'Off = only the lobby admits players, once started nobody new joins.', true, (v) => { cfg.lateJoin = v; }),
    toggleRow('🔁 Automatic revision rounds', 'Missed questions come back a little later in the run.', true, (v) => { cfg.revisionRounds = v; }),
    toggleRow('🐍 Fun facts between questions', 'A tiny bug story or fact while everyone waits.', true, (v) => { cfg.useFacts = v; }),
  ];

  // ---------- create ----------
  const createBtn = h('button', { class: 'btn primary big block', type: 'button', onClick: () => createQuiz() }, 'Create & open lobby');

  function updateCreateBtn() {
    paintConfirm();
    if (busy) return;
    const needSet = Array.isArray(sets) && sets.length > 1 && !selectedSet;
    createBtn.disabled = setsLoading || needSet || cfg.units.length === 0;
    createBtn.textContent = setsLoading
      ? 'Loading question banks…'
      : needSet ? 'Pick a question bank'
        : cfg.units.length ? 'Create & open lobby' : 'Pick at least one topic';
  }
  buildUnitRows();
  updateCreateBtn();

  async function createQuiz() {
    if (busy) return;
    if (!cfg.units.length) { toast('Pick at least one topic first.', 'bad'); return; }
    busy = true;
    createBtn.disabled = true;
    createBtn.textContent = 'Opening the lobby…';
    try {
      const res = await emitAck('host:create', {
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
        revisionRounds: cfg.revisionRounds,
        useFacts: cfg.useFacts,
        timers: { ...cfg.timers },
        revealSeconds: cfg.revealSeconds,
        points: { ...cfg.points },
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
      });
      if (res?.error || !res?.ok) throw new Error(res?.error || 'The server did not create the quiz.');
      save({ teacherToken: res.token, teacherCode: res.code });
      go('#/teacher/live');
    } catch (e) {
      toast(e.message || 'Could not create the quiz.', 'bad');
      busy = false;
      updateCreateBtn();
    }
  }

  // ---------- reopen ----------
  const sessionsBox = h('div', null, h('div', { class: 'empty' }, 'Loading sessions…'));

  request('/api/sessions', { token: authToken() }).then((list) => {
    sessionsBox.textContent = '';
    if (!list?.length) {
      sessionsBox.append(h('div', { class: 'empty' }, 'No sessions running right now - create one above.'));
      return;
    }
    list.forEach((s) => sessionsBox.append(sessionRow(s)));
  }).catch((e) => {
    sessionsBox.textContent = '';
    sessionsBox.append(h('div', { class: 'empty' }, e.message || 'Could not load sessions.'));
  });

  function sessionRow(s) {
    const btn = h('button', {
      class: 'btn small', type: 'button', 'aria-label': `Reopen session ${s.code}`,
      onClick: async () => {
        if (busy) return;
        busy = true;
        btn.disabled = true;
        btn.textContent = 'Joining…';
        try {
          const res = await emitAck('host:join', { code: s.code, token: authToken() });
          if (res?.error || !res?.ok) throw new Error(res?.error || 'That session could not be reopened.');
          save({ teacherCode: res.code });
          go('#/teacher/live');
        } catch (e) {
          toast(e.message || 'Could not reopen that session.', 'bad');
          busy = false;
          btn.disabled = false;
          btn.textContent = 'Reopen';
        }
      },
    }, 'Reopen');

    return h('div', { class: 'card tight', style: { marginTop: '10px' } },
      h('div', { class: 'spread' },
        h('div', null,
          h('div', { class: 'row', style: { gap: '8px' } },
            h('span', { class: 'mono', style: { fontWeight: 900, letterSpacing: '.2em' } }, s.code),
            h('span', { class: 'chip' }, statusLabel(s.status)),
            h('span', { class: 'chip topic' }, `${s.players} player${s.players === 1 ? '' : 's'}`)),
          h('div', { class: 'muted small' },
            `${s.title || 'Python Adventure'}${s.startedAt ? ` · started ${new Date(s.startedAt).toLocaleTimeString()}` : ''}`)),
        btn));
  }

  // ---------- page ----------
  mount(root,
    h('div', { class: 'screen narrow' },
      h('div', { class: 'row', style: { marginBottom: '14px', justifyContent: 'space-between' } },
        h('div', { class: 'row' },
          h('button', { class: 'btn small ghost', onClick: () => go('#/') }, '← Home'),
          h('span', { class: 'chip topic' }, '🎓 Teacher dashboard')),
        h('button', {
          class: 'btn small ghost', type: 'button',
          onClick: async () => { await signOut(); go('#/teacher/login'); },
        }, 'Sign out')),

      h('div', { class: 'card' },
        h('h1', null, 'Create a quiz'),
        h('p', { class: 'muted' }, 'Pick the levels, set the length, then open the lobby and share the code.'),

        h('div', { class: 'field' },
          h('label', { for: 'quiz-title' }, 'Quiz title'),
          h('input', {
            id: 'quiz-title', type: 'text', value: cfg.title, maxlength: '60',
            onInput: (e) => { cfg.title = e.target.value; },
          }),
          h('span', { class: 'hint' }, 'Students see this while they wait.')),

        h('div', { class: 'divider' }),
        h('h2', null, 'Mode'),
        h('div', { class: 'segmented' }, modeBtns),
        modeHint,

        h('div', { class: 'divider' }),
        h('div', { class: 'spread' },
          h('h2', { style: { margin: 0 } }, 'Which levels?'),
          h('button', {
            class: 'btn small ghost', type: 'button',
            onClick: () => go('#/teacher/units'),
          }, '🗂️ Manage units')),
        setField,
        unitBox,

        h('div', { class: 'divider' }),
        h('div', { class: 'spread' }, h('h2', { style: { margin: 0, fontSize: '1.1rem' } }, 'How many?'), countLabel),
        countRange,

        h('div', { class: 'divider' }),
        h('h2', null, 'Difficulty'),
        h('div', { class: 'segmented' }, diffBtns),

        h('div', { class: 'divider' }),
        h('h2', null, 'Question timer'),
        h('div', { class: 'segmented' }, timerOnBtns),
        pacedOffHint,
        h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '10px', marginTop: '10px' } }, commonField),
        pacedBox,

        h('div', { class: 'divider' }),
        h('h2', null, 'Timing'),
        h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '10px' } },
          timerCells.map((c) => c.node)),
        h('div', { class: 'ticker', style: { marginTop: '10px' } },
          h('b', null, '⏱️ Countdown: '),
          'Everyone sees the same clock for each question. Boss questions get the bonus seconds on top.'),

        h('div', { class: 'divider' }),
        h('h2', null, 'Scoring'),
        h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '10px' } },
          pointCells.map((c) => c.node)),
        h('div', { class: 'muted small', style: { marginTop: '8px' } },
          'Speed and streak bonuses scale from these bases.'),

        h('div', { class: 'divider' }),
        h('h2', null, 'Classroom'),
        h('p', { class: 'muted small' }, 'Manage classes under 🗂️ Manage units - pick one here to group your report.'),
        h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '10px' } },
          classField, sectionField, whenField),

        h('div', { class: 'divider' }),
        h('h2', null, 'How it runs'),
        h('div', { class: 'col', style: { gap: '8px' } }, toggles),

        h('div', { style: { marginTop: '18px' } }, confirmLine, createBtn)),

      h('div', { class: 'card' },
        h('div', { class: 'spread' },
          h('h2', { style: { margin: 0 } }, 'Live sessions'),
          h('span', { class: 'chip' }, 'running now')),
        h('p', { class: 'muted small' }, 'Jump back into a lobby or dashboard you closed earlier - any device, any tab.'),
        sessionsBox),

      h('div', { class: 'card' },
        h('div', { class: 'spread' },
          h('h2', { style: { margin: 0 } }, 'Reports'),
          h('span', { class: 'chip' }, 'finished sessions')),
        h('p', { class: 'muted small' },
          'Every finished quiz stays here - open one to print it, re-export the CSV, or delete it.'),
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
          h('button', { class: 'btn', type: 'button', onClick: () => go('#/teacher/reports') }, '📚 Browse reports'))),

      h('div', { class: 'card' },
        h('h2', null, 'Question bank'),
        h('p', { class: 'muted' }, 'Add, edit or remove questions. Your edits show up in the very next quiz.'),
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
          h('button', { class: 'btn', type: 'button', onClick: () => go('#/teacher/edit') }, '✏️ Open the question bank editor'),
          h('button', { class: 'btn ghost', type: 'button', onClick: () => go('#/teacher/upload') }, '📥 Upload a JSON file'))),

      h('div', { class: 'row', style: { marginTop: '16px', justifyContent: 'center' } },
        h('button', { class: 'btn ghost', type: 'button', onClick: () => go('#/') }, '← Back home'))
    )
  );
}
