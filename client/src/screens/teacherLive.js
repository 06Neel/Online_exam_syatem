// Teacher live screen: lobby + live dashboard + end-of-session report in one view.
import { h, mount, toast, modal, pct } from '../ui.js';
import { store, save } from '../state.js';
import { go } from '../main.js';
import { emitAck, on, request } from '../net.js';
import { authToken } from '../auth.js';
import { topbar } from '../topbar.js';
import { badgeById } from '../../../shared/badges.js';
import { rankTeams, fmtMarks } from '../../../shared/scoring.js';
import { unitName as baseUnitName, TYPE_LABELS } from '../../../shared/units.js';
import { downloadCsv } from '../reporting.js';
import { joinUrl, qrImg, copyText } from '../qrcodeUi.js';

export const title = 'Live session';

// the session owner's unit names, filled in at boot (falls back to the base seven)
let unitNames = null;
// the running quiz's own bank unit names - they win over the syllabus
let sessionUnitNames = null;

const clamp2 = {
  display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden',
};

let cleanup = [];
let rotateHandle = null;
let destroyed = false;
let busy = false;

export function render(root, params = {}) {
  const code = String(params.code || store.teacherCode || '').trim().toUpperCase();
  if (!code) { go('#/teacher'); return; }

  cleanup = [];
  destroyed = false;
  busy = false;
  sessionUnitNames = null;
  clearInterval(rotateHandle);
  rotateHandle = null;
  save({ teacherCode: code });

  const view = {
    code,
    joined: false,
    joinFailed: false,
    config: null,
    status: 'lobby',
    phase: 'lobby',
    qIndex: -1,
    total: 0,
    players: [],
    stats: null,
    qmeta: null,
    shown: null, // the "Show answer" payload for the question on screen
    missed: [],
    unitStats: {},
    lb: null,
    lbHidden: false,
    lbView: 'teams', // team mode: 'teams' or 'players' (the Individuals view)
    ended: false,
    report: null,
    bank: null,
    hosts: 1, // how many dashboards are driving this session (host:count)
  };

  const isLobby = () => view.status === 'lobby' || view.phase === 'lobby';
  const isOver = () => view.status === 'ended' || view.phase === 'ended';
  const onQuestion = () => !isLobby() && !isOver() && (view.phase === 'question' || view.phase === 'reveal');
  const timerOn = () => view.config?.timerOn !== false;
  // timer off during a running quiz: students drive themselves
  const pacedRun = () => view.config?.timerOn === false && !isLobby() && !isOver();

  // ---------- sticky control bar ----------
  const codeEl = h('span', {
    class: 'mono',
    style: { fontWeight: 900, fontSize: 'clamp(1.05rem, 3vw, 1.5rem)', letterSpacing: '.24em' },
  }, code);
  const copyBtn = h('button', {
    class: 'btn small', type: 'button', 'aria-label': 'Copy the session code', onClick: copyCode,
  }, '📋 Copy');
  const shareBtn = h('button', {
    class: 'btn small', type: 'button', 'aria-label': 'Show the join code and QR code',
    onClick: shareSession,
  }, '🔗 Share');
  const playersChip = h('span', { class: 'chip' }, '👥 0');
  const statusChip = h('span', { class: 'chip' }, '🎮 Lobby');
  const openChip = h('span', { class: 'chip refresher hide' }, '🖥 also open elsewhere');

  const startBtn = mkBtn('▶ Start', 'Start the quiz', () => control('start'));
  const pauseBtn = mkBtn('⏸ Pause', 'Pause the quiz', () => control(view.status === 'paused' ? 'resume' : 'pause'));
  const nextBtn = mkBtn('⏭ Next', 'Move on to the next question', () => control('next'));
  const extendBtn = mkBtn('➕ +10s', 'Give everyone 10 more seconds', () => control('extend'));
  const answerBtn = mkBtn('📊 Show answer', 'Show the correct answer to the class', () => control('show-answer'));
  const lbBtn = mkBtn('🙈 Hide leaderboard', 'Hide the leaderboard from students', () => control(view.lbHidden ? 'show-leaderboard' : 'hide-leaderboard'));
  const mistakeBtn = mkBtn('🐞 Reveal class mistake', 'Reveal the most chosen wrong answer', () => control('reveal-mistake'));
  const endBtn = mkBtn('⏹ End quiz', 'End the quiz and open the report', () => confirmEnd());
  // the question timer switch: works in the lobby and mid-run (from the next question)
  const timerBtn = mkBtn('⏱ Timer on', 'Turn the question timer off - students go at their own pace',
    () => flipTimer());
  const controlBtns = [startBtn, pauseBtn, nextBtn, extendBtn, answerBtn, timerBtn, lbBtn, mistakeBtn, endBtn];

  const controls = h('div', { class: 'controls' },
    codeEl, copyBtn, shareBtn, playersChip, statusChip, openChip,
    h('div', { class: 'row', style: { marginLeft: 'auto' } }, controlBtns));

  // ---------- content slots ----------
  const statsSlot = h('div', { class: 'grid cols-4', style: { marginBottom: '16px' } });
  const rosterCard = h('div', { class: 'card' });
  const questionCard = h('div', { class: 'card' });
  const struggleCard = h('div', { class: 'card' });
  const lbCard = h('div', { class: 'card' });
  const lobbyCard = h('div', { class: 'card hide' });
  const lobbyNames = h('div', { class: 'row', style: { justifyContent: 'center', marginTop: '12px' } });
  const lobbyMeta = h('div', { class: 'row', style: { justifyContent: 'center', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } });
  const setLine = h('div', { class: 'small', style: { fontWeight: 700, marginBottom: '10px' } });
  const bodySlot = h('div', null, setLine, statsSlot, rosterCard, questionCard, struggleCard, lbCard, lobbyCard);
  const srTitle = h('h1', { class: 'sr-only' }, 'Live session dashboard');

  mount(root, h('div', { class: 'screen pro' }, topbar('home'), srTitle, controls, bodySlot));

  lobbyCard.append(
    h('div', { class: 'center' },
      h('div', { class: 'muted small' }, 'Share this code with your class'),
      h('div', { class: 'bigcode' }, code),
      h('div', { style: { display: 'flex', justifyContent: 'center', marginTop: '8px' } }, qrImg(joinUrl(code), 132)),
      h('div', { class: 'muted small', style: { marginTop: '4px' } }, 'Scan to join · or type the code')),
    lobbyMeta,
    h('p', { class: 'center muted', style: { marginTop: '10px' } },
      'Students open Python Adventure, choose "Join a live game" and type the code - no accounts needed.'),
    lobbyNames,
    h('p', { class: 'center muted small', style: { marginTop: '12px', marginBottom: 0 } },
      'Press Start when you are ready. Questions run in level order and end with a boss.'));

  function paintLobbyMeta() {
    const c = view.config;
    lobbyMeta.textContent = '';
    if (!c) return;
    const chips = [];
    if (c.className) chips.push(h('span', { class: 'chip topic' }, `🏫 ${c.className}${c.section ? ` · ${c.section}` : ''}`));
    if (c.mode === 'practice') chips.push(h('span', { class: 'chip' }, '🐢 practice run'));
    if (c.timerOn === false) chips.push(h('span', { class: 'chip refresher' }, '🐢 question timer off'));
    if (c.opensAt) chips.push(h('span', { class: 'chip' }, `🕒 opens ${new Date(c.opensAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`));
    if (!c.lateJoin) chips.push(h('span', { class: 'chip' }, '🚪 no late joins'));
    lobbyMeta.append(...chips);
  }

  // the confirmation line: exactly which question bank feeds this quiz
  function paintSetLine() {
    const c = view.config;
    if (!c || !c.setId) { setLine.textContent = ''; return; }
    const names = (c.units || []).map((u) => (c.unitNames && c.unitNames[u]) || unitName(u));
    setLine.textContent = `Using question bank: ${c.setName} | ${c.setCount} questions | Units: ${names.join(', ')}`;
  }

  // ---------- paints ----------
  function tile(k, v, tone = '') {
    return h('div', { class: `stat ${tone}` }, h('div', { class: 'k' }, k), h('div', { class: 'v' }, v));
  }

  function paintStats() {
    const players = view.players;
    const st = view.stats && view.stats.qIndex === view.qIndex ? view.stats : null;
    const paced = !timerOn() && !isLobby() && !isOver();
    const answered = st && !paced
      ? st.answered
      : players.filter((p) => p.answered && view.qIndex >= 0).length;
    const answersTotal = st?.answeredTotal
      ?? players.reduce((s, p) => s + (p.answeredCount || 0), 0);
    const finished = st?.finishedCount ?? players.filter((p) => p.finished).length;
    const right = players.reduce((s, p) => s + (p.correct || 0), 0);
    const wrong = players.reduce((s, p) => s + (p.wrong || 0), 0);
    const acc = right + wrong ? right / (right + wrong) : null;
    const remaining = view.total > 0
      ? Math.max(0, view.total - (view.qIndex + 1))
      : (view.config?.count ?? '—');
    statsSlot.textContent = '';
    statsSlot.append(
      tile('Joined players', players.length, 'brand'),
      paced
        ? tile('Answers so far', `${answersTotal}${view.total ? ` of ${players.length * view.total}` : ''}`)
        : tile('Answered this question', answered),
      tile('Class accuracy', acc === null ? '—' : pct(acc), acc !== null ? (acc >= 0.7 ? 'good' : acc < 0.5 ? 'bad' : '') : ''),
      paced
        ? tile('Finished', `${finished} of ${players.length}`, finished === players.length && players.length > 0 ? 'good' : '')
        : tile('Questions remaining', remaining));
  }

  function paintRoster() {
    const players = view.players;
    rosterCard.textContent = '';
    rosterCard.append(
      h('div', { class: 'spread' },
        h('h2', { style: { margin: 0 } }, '👩‍🎓 Students'),
        h('span', { class: 'chip' }, `${players.length} joined`)));

    if (!players.length) {
      rosterCard.append(h('div', { class: 'empty', style: { marginTop: '12px' } },
        'Nobody has joined yet - the code above is all they need.'));
      return;
    }

    rosterCard.append(h('div', { class: 'roster', style: { marginTop: '12px' } },
      players.map((p) => {
        const paced = !timerOn() && view.qIndex >= 0;
        const myQ = paced ? (p.qIndex ?? view.qIndex) : view.qIndex;
        const here = view.qIndex >= 0 && myQ === view.qIndex;
        const mark = p.finished
          ? '🏁 finished'
          : !here && paced
            ? `own Q${myQ + 1}`
            : !here ? '·' : (p.answered ? '✓ answered' : '✗ not yet');
        const metaLine = [
          p.finished ? 'finished' : p.status,
          view.qIndex >= 0 ? `Q${myQ + 1}${view.total ? `/${view.total}` : ''}` : 'lobby',
          p.rank ? `#${p.rank}` : 'unranked',
          mark,
        ].join(' · ');
        return h('div', { class: 'p' },
          h('span', { class: `dot ${p.status}`, title: p.status, 'aria-hidden': 'true' }),
          h('span', { style: { minWidth: 0, flex: '1' } },
            h('b', null, p.team ? `${p.nickname} · ${p.team}` : p.nickname),
            h('div', { class: 'meta' }, metaLine)),
          h('span', { class: 'score' }, fmtMarks(p.score ?? 0)));
      })));

    const head = ['Name', 'Team', 'Q#', 'Correct', 'Wrong', 'Marks', 'Rank', 'Status'];
    const pacedTable = !timerOn() && view.qIndex >= 0;
    rosterCard.append(h('div', { class: 'table-wrap', style: { marginTop: '12px' } },
      h('table', null,
        h('thead', null, h('tr', null, head.map((t, i) =>
          h('th', { scope: 'col', class: i >= 3 && i <= 6 ? 'num' : '' }, t)))),
        h('tbody', null, players.map((p) => h('tr', { class: p.status === 'disconnected' ? 'needs' : null },
          h('td', null, h('b', null, p.nickname)),
          h('td', null, p.team || '—'),
          h('td', null, p.finished
            ? '🏁 done'
            : view.qIndex >= 0
              ? `Q${(pacedTable ? (p.qIndex ?? view.qIndex) : view.qIndex) + 1} ${p.answered ? '✓' : '✗'}`
              : '—'),
          h('td', { class: 'num' }, p.correct ?? 0),
          h('td', { class: 'num' }, p.wrong ?? 0),
          h('td', { class: 'num' }, fmtMarks(p.score ?? 0)),
          h('td', { class: 'num' }, p.rank ? `#${p.rank}` : '—'),
          h('td', null, p.finished ? 'finished' : p.status)))))));
  }

  function paintQuestion() {
    questionCard.textContent = '';
    const meta = view.qmeta && view.qmeta.qIndex === view.qIndex ? view.qmeta : null;
    const st = view.stats && view.stats.qIndex === view.qIndex ? view.stats : null;
    const q = meta?.question || null;
    const entry = view.bank && q?.id ? view.bank.get(q.id) : null;
    const prompt = st?.prompt || q?.prompt;

    questionCard.append(h('div', { class: 'spread' },
      h('h2', { style: { margin: 0 } }, '❓ Current question'),
      h('span', { class: 'chip' },
        view.qIndex >= 0
          ? `Question ${view.qIndex + 1}${view.total ? ` of ${view.total}` : ''}`
          : 'not started')));

    if (!prompt) {
      questionCard.append(h('div', { class: 'empty', style: { marginTop: '12px' } },
        view.qIndex < 0 ? 'Press Start and the first question lands here.' : 'Getting the next question ready…'));
      return;
    }

    if (meta) {
      const chips = h('div', { class: 'q-meta', style: { margin: '10px 0 0' } });
      if (meta.boss) chips.append(h('span', { class: 'chip boss' }, '👑 Boss question'));
      if (meta.refresher) chips.append(h('span', { class: 'chip refresher' }, '🔄 Revision round'));
      if (meta.unit) chips.append(h('span', { class: 'chip topic' }, meta.unitLabel || unitName(meta.unit)));
      if (q?.type) chips.append(h('span', { class: 'chip' }, TYPE_LABELS[q.type] || q.type));
      if (meta.selfPaced ?? !timerOn()) chips.append(h('span', { class: 'chip refresher' }, '🐢 own pace'));
      questionCard.append(chips);
    }

    questionCard.append(h('p', { class: 'prompt', style: { marginTop: '10px' } }, prompt));

    // the code sample is part of the question - students see it as a block, so does the board
    const code = st?.code || q?.code || '';
    if (code) {
      questionCard.append(h('div', { class: 'code-block', style: { marginTop: '10px' } },
        h('span', { class: 'lang' }, q?.type === 'spot-error' ? 'spot the bug' : 'python'),
        h('pre', { class: 'code' }, code)));
    }

    const right = st?.correct || 0;
    const wrong = st?.wrong || 0;
    const sum = right + wrong;
    const goodPct = sum ? Math.round((right / sum) * 100) : 0;
    questionCard.append(
      h('div', { class: 'spread', style: { marginTop: '12px' } },
        h('b', null, sum ? `${right} correct ✓` : 'no answers yet'),
        h('span', { class: 'muted small' }, sum ? `${wrong} wrong ✗ · ${pct(right / sum)} correct` : 'waiting for the class')),
      h('div', { class: 'bar-track', style: { display: 'flex', height: '18px', marginTop: '6px' } },
        h('span', { class: 'good', style: { width: `${goodPct}%` } }),
        h('span', { class: 'bad', style: { width: `${100 - goodPct}%` } })));

    // answer-option distribution
    const shown = view.shown && view.shown.qIndex === view.qIndex ? view.shown : null;
    const opts = st?.options || q?.options || shown?.options || null;
    const answerIds = new Set();
    if (st?.answer) (Array.isArray(st.answer) ? st.answer : [st.answer]).forEach((a) => answerIds.add(a));
    else if (shown?.answer) (Array.isArray(shown.answer) ? shown.answer : [shown.answer]).forEach((a) => answerIds.add(a));
    else if (entry?.answer) (Array.isArray(entry.answer) ? entry.answer : [entry.answer]).forEach((a) => answerIds.add(a));

    if (st && opts?.length) {
      const votes = opts.map((o) => ({
        o,
        n: answerIds.has(o.id) ? (st.correct || 0) : (st.counts?.[o.id] || 0),
      }));
      const totalVotes = votes.reduce((s, v) => s + v.n, 0) || 1;
      questionCard.append(h('div', { class: 'divider' }), h('h2', { style: { fontSize: '1.1rem' } }, 'Where the votes went'));
      votes.forEach(({ o, n }) => {
        const good = answerIds.has(o.id);
        questionCard.append(h('div', { class: 'bar-row' },
          h('span', { class: 'label', title: o.text }, `${good ? '✓ ' : ''}${o.text}`),
          h('span', { class: 'val' }, n),
          h('div', { class: 'bar-track' },
            h('span', { class: good ? 'good' : 'bad', style: { width: `${Math.round((n / totalVotes) * 100)}%` } }))));
      });
    }

    // the answer panel: the timer ran out, or the teacher pressed "Show answer"
    const revealing = !!st?.revealing || view.phase === 'reveal' || !!shown;
    if (revealing) {
      const correctText = answerIds.size
        ? [...answerIds].map((id) => opts?.find((o) => o.id === id)?.text || id).join(' · ')
        : entry?.accepted?.join(' / ')
          || shown?.accepted?.join(' / ')
          || (entry?.pairs || shown?.pairs || []).map((p) => `${p.left} → ${p.right}`).join(' · ')
          || '';
      questionCard.append(h('div', { class: 'explain', style: { marginTop: '14px' } },
        h('h2', null, '✅ Official answer'),
        correctText
          ? h('p', { style: { margin: '0 0 8px', fontWeight: 700 } },
            'Correct answer: ', h('span', { class: 'chip good' }, correctText))
          : h('p', { class: 'muted', style: { margin: '0 0 8px' } }, 'Check the question bank for the accepted answers.'),
        entry?.explanation || shown?.explanation
          ? h('p', { style: { margin: 0 } }, entry?.explanation || shown?.explanation)
          : h('p', { class: 'muted small', style: { margin: 0 } },
            view.bank === null ? 'Loading the explanation from your question bank…' : 'No explanation stored for this one.')));
    }
  }

  function paintStruggling() {
    struggleCard.textContent = '';
    struggleCard.append(h('h2', null, '⚠️ Where the class is struggling'));
    const missed = view.missed || [];
    const units = view.unitStats || {};

    if (!missed.length && !Object.keys(units).length) {
      struggleCard.append(h('div', { class: 'empty' },
        'Whole-class weak spots show up here after a few answers.'));
      return;
    }

    if (missed.length) {
      struggleCard.append(h('h3', null, 'Most missed questions'));
      missed.forEach((m) => {
        struggleCard.append(h('div', { class: 'spread', style: { padding: '8px 0', borderBottom: '1px solid var(--line)' } },
          h('div', null,
            h('b', null, `Q${(m.index ?? 0) + 1}${m.id ? ` · ${m.id}` : ''}`),
            h('div', { class: 'muted small' }, `${pct(m.missRate || 0)} missed of ${m.total || 0} answers`))));
      });
    }

    if (Object.keys(units).length) {
      struggleCard.append(h('h3', { style: { marginTop: '16px' } }, 'Class accuracy by level'));
      unitBars(units).forEach((row) => struggleCard.append(row));
      struggleCard.append(h('p', { class: 'muted small', style: { margin: '8px 0 0' } },
        '🟢 80%+ solid · 🟡 50-79% shaky · 🔴 under 50% needs love'));
    }
  }

  function paintLeaderboard() {
    lbCard.textContent = '';
    const lb = view.lb;
    const teamMode = lb?.mode === 'team';
    lbCard.append(h('div', { class: 'spread' },
      h('h2', { style: { margin: 0 } }, teamMode ? '👥 Teams' : '🏆 Leaderboard'),
      teamMode
        ? h('div', { class: 'row', style: { gap: '6px' } },
          lbToggle('teams', '👥 Teams'),
          lbToggle('players', '🚶 Individuals'))
        : h('span', { class: 'chip' }, `${lb?.total ?? (lb?.entries || []).length} players`)));

    if (!lb) {
      lbCard.append(h('div', { class: 'empty', style: { marginTop: '12px' } },
        'Marks land here as soon as the first answers come in.'));
      return;
    }

    const entryRow = (e) => h('div', { class: 'lb-row' },
      h('span', { class: 'rank' }, medal(e.rank)),
      h('span', { class: 'who' },
        h('b', null, e.nickname),
        h('span', null, [
          e.team ? `👥 ${e.team}` : (teamMode ? '🚶 Solo' : null),
          `${e.correct ?? 0} right`,
          (e.streak || 0) >= 2 ? `🔥${e.streak}` : null,
        ].filter(Boolean).join(' · '))),
      h('span', { class: 'pts' }, fmtMarks(e.score ?? 0)),
      h('span', { class: 'delta' }, e.rank === 1 ? '👑' : ''));

    const teamRow = (t) => {
      const n = t.size ?? (t.members || []).length;
      return h('div', { class: 'lb-row' },
        h('span', { class: 'rank' }, medal(t.rank)),
        h('span', { class: 'who' },
          h('b', null, `👥 ${t.name} · ${n} ${n === 1 ? 'member' : 'members'}`),
          h('span', null, (t.members || []).join(', ') || 'nobody yet'),
          h('span', null, `avg ${fmtMarks(t.avg ?? 0)} · ${t.correct ?? 0} right · ${pct(t.accuracy || 0)}`)),
        h('span', { class: 'pts' }, fmtMarks(t.score ?? 0)),
        h('span', null));
    };

    const showTeams = teamMode && view.lbView !== 'players';
    const rows = showTeams
      ? (lb.teams || []).map(teamRow)
      : (lb.entries || []).map(entryRow);

    lbCard.append(h('div', { class: 'lb', style: { marginTop: '10px' } },
      rows.length ? rows : h('p', { class: 'muted' },
        showTeams ? 'No teams yet - students pick a team when they join.' : 'Nobody on the board yet.')));

    // solo players get their own section (team mode, Teams view)
    if (showTeams) {
      const solos = lb.solo || (lb.entries || []).filter((e) => !e.team);
      if (solos.length) {
        lbCard.append(h('h3', { style: { margin: '14px 0 4px', fontSize: '.95rem' } },
          `🚶 Solo players (${solos.length})`));
        lbCard.append(h('div', { class: 'lb' }, solos.map(entryRow)));
      }
    }

    if (lb.hidden > 0) {
      lbCard.append(h('div', { class: 'lb-hidden' },
        `${lb.hidden} player${lb.hidden > 1 ? 's' : ''} hidden - everyone is learning 🌱`));
    }
    if (lb.visible === false) {
      lbCard.append(h('div', { class: 'lb-hidden' }, 'You have the leaderboard switched off for students.'));
    }
  }

  function lbToggle(key, label) {
    const on = view.lbView === key;
    return h('button', {
      class: 'btn small', type: 'button',
      'aria-pressed': String(on),
      'aria-label': key === 'teams' ? 'Show team standings' : 'Show every player individually',
      style: on ? { fontWeight: 700 } : { opacity: 0.7 },
      onClick: () => { view.lbView = key; paintLeaderboard(); },
    }, label);
  }

  function updateChips() {
    playersChip.textContent = `👥 ${view.players.length}`;
    let label = '🎮 Lobby';
    let tone = '';
    if (view.ended || isOver()) { label = '🏁 Finished'; }
    else if (view.status === 'paused') { label = '⏸ Paused'; tone = 'refresher'; }
    else if (isLobby()) { label = '🎮 Lobby'; tone = 'topic'; }
    else if (view.phase === 'reveal') { label = `👁 Question ${view.qIndex + 1} · reveal`; tone = 'topic'; }
    else { label = `❓ Question ${view.qIndex + 1}`; tone = 'good'; }
    statusChip.textContent = label;
    statusChip.className = `chip ${tone}`;
    if (view.joinFailed) statusChip.textContent = '⚠️ Not connected';
  }

  function updateButtons() {
    const over = isOver() || view.ended;
    const lobby = isLobby();
    const paced = pacedRun();
    startBtn.disabled = busy || view.joinFailed || over || !lobby;
    pauseBtn.disabled = busy || view.joinFailed || over || lobby;
    pauseBtn.textContent = view.status === 'paused' ? '▶ Resume' : '⏸ Pause';
    pauseBtn.setAttribute('aria-label', view.status === 'paused' ? 'Resume the quiz' : 'Pause the quiz');
    nextBtn.disabled = busy || view.joinFailed || over || lobby || paced;
    extendBtn.disabled = busy || view.joinFailed || over || view.status !== 'running' || view.phase !== 'question' || paced;
    answerBtn.disabled = busy || view.joinFailed || over || !onQuestion() || paced;
    lbBtn.textContent = view.lbHidden ? '👁 Show leaderboard' : '🙈 Hide leaderboard';
    lbBtn.setAttribute('aria-label', view.lbHidden ? 'Show the leaderboard to students' : 'Hide the leaderboard from students');
    lbBtn.disabled = busy || view.joinFailed || over || lobby;
    mistakeBtn.disabled = busy || view.joinFailed || over || !onQuestion() || paced;
    endBtn.disabled = busy || view.joinFailed || over || lobby;

    const tOn = timerOn();
    timerBtn.textContent = tOn ? '⏱ Timer on' : '🐢 Timer off';
    timerBtn.setAttribute('aria-label', tOn
      ? 'Turn the question timer off - students go at their own pace'
      : 'Turn the question timer back on - the next question is shared');
    timerBtn.disabled = busy || view.joinFailed || over || view.status === 'paused';
  }

  function paintVisibility() {
    const lobby = isLobby() && !view.ended;
    const over = view.ended;
    lobbyCard.classList.toggle('hide', !lobby);
    rosterCard.classList.toggle('hide', over);
    statsSlot.classList.toggle('hide', over);
    questionCard.classList.toggle('hide', lobby || over);
    struggleCard.classList.toggle('hide', lobby || over);
    lbCard.classList.toggle('hide', lobby || over || !view.lb);
  }

  function sync() {
    updateChips();
    updateButtons();
    paintStats();
    paintVisibility();
  }

  // ---------- actions ----------
  async function copyCode() {
    try {
      await navigator.clipboard.writeText(view.code);
      toast('Code copied');
    } catch {
      toast(`Could not copy - the code is ${view.code}`, 'bad');
    }
  }

  /** The join code, QR and link - reachable from any phase, not just the lobby. */
  function shareSession() {
    const url = joinUrl(view.code);
    modal({
      title: 'Students join with this',
      body: h('div', { class: 'center' },
        h('div', { class: 'muted small' }, 'Type the code, or scan the QR code'),
        h('div', { class: 'bigcode' }, view.code),
        h('div', { style: { display: 'flex', justifyContent: 'center', marginTop: '10px' } }, qrImg(url, 168)),
        h('p', { class: 'muted small', style: { margin: '10px 0 0', wordBreak: 'break-all' } }, url)),
      actions: [
        {
          label: 'Copy code', kind: 'ghost', close: false,
          onClick: async () => { const ok = await copyText(view.code); toast(ok ? 'Code copied.' : `Code is ${view.code}`, ok ? 'good' : 'bad'); },
        },
        {
          label: 'Copy link', kind: 'ghost', close: false,
          onClick: async () => { const ok = await copyText(url); toast(ok ? 'Join link copied.' : 'Copy failed', ok ? 'good' : 'bad'); },
        },
        { label: 'Done', kind: 'primary' },
      ],
    });
  }

  function setBusy(v) { busy = v; updateButtons(); }

  async function control(action, extra = {}) {
    if (busy || view.joinFailed) return;
    setBusy(true);
    try {
      const res = await emitAck('host:control', {
        action, ...extra,
        // what THIS screen thinks is happening - the server refuses to act on
        // a state that has already moved on (another tab, a reconnect, ...)
        expect: { phase: view.phase, qIndex: view.qIndex },
      });
      if (res?.stale) {
        // somebody (or some other tab) already changed things: resync instead
        if (res.roster) applyRoster(res.roster);
        applyHostState(res.state);
        if (res.stats) view.stats = res.stats;
        toast('That had already changed elsewhere - dashboard refreshed', '', 2200);
        return;
      }
      if (res?.error) { toast(res.error, 'bad'); return; }
      if (res && res.ok === false) { toast('That did not work - try again.', 'bad'); return; }
      if (action === 'extend') toast('+10 seconds ⏱️', 'gold', 1500);
      else if (action === 'start') toast('The quiz is live! 🎉', 'gold', 1800);
      else if (action === 'show-answer') toast('Answer shown to the class', '', 1600);
      else if (action === 'reveal-mistake') toast('Class mistake revealed 🐞', '', 1600);
      else if (action === 'next') toast('Moving on →', '', 1200);
    } catch (e) {
      toast(e.message || 'That did not work.', 'bad');
    } finally {
      setBusy(false);
      sync();
    }
  }

  /** The question timer switch (lobby or mid-run). */
  async function flipTimer() {
    if (busy || view.joinFailed || isOver()) return;
    const next = !timerOn();
    setBusy(true);
    try {
      const res = await emitAck('host:control', {
        action: 'timer', on: next, expect: { phase: view.phase, qIndex: view.qIndex },
      });
      if (res?.stale) {
        if (res.roster) applyRoster(res.roster);
        applyHostState(res.state);
        toast('That had already changed elsewhere - dashboard refreshed', '', 2200);
        return;
      }
      if (res?.error) { toast(res.error, 'bad'); return; }
      if (view.config) view.config.timerOn = res.timerOn ?? next;
      if (res?.effective === 'next question') {
        toast('🐢 Timer off from the next question - this one keeps its clock', 'gold', 3000);
      } else if (res?.ended) {
        toast('Everyone had finished - the quiz is closing', 'gold', 2400);
      } else if (res?.timerOn === false) {
        toast('🐢 Timer off - students go at their own pace', 'gold', 2400);
      } else {
        toast('⏱ Timer on - the class is back on one clock', 'gold', 2400);
      }
      sync();
      paintRoster();
      paintQuestion();
      paintLobbyMeta();
    } catch (e) {
      toast(e.message || 'That did not work.', 'bad');
    } finally {
      setBusy(false);
      sync();
    }
  }

  function confirmEnd() {
    modal({
      title: 'End the quiz?',
      body: h('p', { style: { margin: 0 } },
        'Everyone gets their final score and the report opens right here. This cannot be undone.'),
      actions: [
        { label: 'Keep going', kind: 'ghost' },
        { label: 'End quiz', kind: 'danger', onClick: () => endQuiz() },
      ],
    });
  }

  async function endQuiz() {
    if (busy) return;
    setBusy(true);
    try {
      const res = await emitAck('host:end');
      if (res?.error) { toast(res.error, 'bad'); return; }
      showReport(res?.report);
    } catch (e) {
      toast(e.message || 'Could not end the quiz.', 'bad');
    } finally {
      setBusy(false);
    }
  }

  function fetchReport() {
    if (view.report) return;
    request(`/api/sessions/${view.code}/report`, { token: authToken() })
      .then((r) => showReport(r))
      .catch((e) => toast(e.message || 'Could not load the report.', 'bad'));
  }

  function showReport(report) {
    if (destroyed || !report || view.report) return;
    view.report = report;
    view.ended = true;
    clearInterval(rotateHandle);
    rotateHandle = null;
    bodySlot.textContent = '';
    bodySlot.append(reportView(report));
    srTitle.remove();
    controls.classList.add('hide'); // the run is over - the report has its own actions
    sync();
    window.scrollTo({ top: 0, behavior: 'auto' });
  }

  function joinError(msg) {
    view.joinFailed = true;
    srTitle.remove();
    controls.classList.add('hide');
    bodySlot.textContent = '';
    bodySlot.append(h('div', { class: 'card' },
      h('h1', null, 'Could not open this session'),
      h('p', { class: 'muted' }, msg),
      h('button', { class: 'btn primary', type: 'button', onClick: () => go('#/teacher') }, '← Back')));
  }

  // ---------- socket handlers ----------
  function applyRoster(p) {
    if (!p || destroyed || view.ended) return;
    view.players = p.players || [];
    if (p.status) view.status = p.status;
    if (p.phase) view.phase = p.phase;
    if (typeof p.qIndex === 'number') view.qIndex = p.qIndex;
    if (p.total) view.total = p.total;
    paintRoster();
    sync();
    if (view.status === 'ended') fetchReport();
  }

  cleanup.push(on('roster', applyRoster));

  cleanup.push(on('question:stats', (p) => {
    if (destroyed || view.ended || !p) return;
    view.stats = p;
    if (Array.isArray(p.missed)) view.missed = p.missed;
    if (p.unitStats) view.unitStats = p.unitStats;
    if (p.qIndex === view.qIndex) { paintQuestion(); paintStruggling(); paintStats(); }
  }));

  // "Show answer" (from this dashboard or another one) - paint the answer panel now
  cleanup.push(on('answer:shown', (p) => {
    if (destroyed || view.ended || !p) return;
    if (typeof p.qIndex === 'number' && p.qIndex !== view.qIndex) return;
    view.shown = p;
    paintQuestion();
  }));

  cleanup.push(on('leaderboard', (p) => {
    if (destroyed || view.ended || !p) return;
    view.lb = p;
    paintLeaderboard();
    paintVisibility();
  }));

  cleanup.push(on('phase', (p) => {
    if (destroyed || view.ended || !p) return;
    if (p.phase) view.phase = p.phase;
    if (typeof p.qIndex === 'number') view.qIndex = p.qIndex;
    paintQuestion();
    sync();
    if (p.phase === 'ended') fetchReport();
  }));

  cleanup.push(on('control', (p) => {
    if (destroyed || !p) return;
    if (p.action === 'hide-leaderboard') view.lbHidden = true;
    if (p.action === 'show-leaderboard') view.lbHidden = false;
    if (p.action === 'pause') toast('⏸ The quiz is paused', 'gold', 1500);
    if (p.action === 'resume') toast('▶ Back in play', '', 1500);
    if (p.action === 'timer-changed') {
      if (view.config) view.config.timerOn = !!p.timerOn;
      toast(p.timerOn ? '⏱ Timer on - the next question is shared' : '🐢 Timer off - students pace themselves',
        'gold', 2400);
      paintRoster();
      paintQuestion();
      paintStats();
      paintLobbyMeta();
    }
    updateButtons();
    paintLeaderboard();
  }));

  cleanup.push(on('quiz:end', (p) => showReport(p?.report)));

  // several devices can drive the same quiz - say so, and never double-jump
  cleanup.push(on('host:count', (p) => {
    if (destroyed || view.ended || view.joinFailed) return;
    const n = Number(p?.count) || 1;
    const wasAlone = view.hosts <= 1;
    view.hosts = n;
    openChip.classList.toggle('hide', n <= 1);
    if (n > 1 && wasAlone) toast('This dashboard is open on another device too', 'gold', 2600);
  }));

  // the socket dropped and came back: re-bind this dashboard to the session
  cleanup.push(on('connect', () => {
    if (destroyed || view.ended || view.joinFailed || !view.joined) return;
    joinSession(true).catch(() => { /* joinSession reports its own errors */ });
  }));

  cleanup.push(on('question:start', (p) => {
    if (destroyed || view.ended || !p) return;
    view.qmeta = p;
    view.stats = null;
    if (typeof p.qIndex === 'number') view.qIndex = p.qIndex;
    if (p.total) view.total = p.total;
    paintQuestion();
    sync();
  }));

  // ---------- boot ----------
  paintRoster();
  paintQuestion();
  paintStruggling();
  paintLeaderboard();
  sync();

  request('/api/bank', { token: store.teacherToken })
    .then((list) => {
      view.bank = new Map((list || []).map((q) => [q.id, q]));
      if (!destroyed && view.phase === 'reveal') paintQuestion();
    })
    .catch(() => { if (!destroyed) view.bank = new Map(); });

  request('/api/units/list', { token: authToken() })
    .then((list) => {
      if (destroyed || !Array.isArray(list) || !list.length) return;
      unitNames = Object.fromEntries(list.map((u) => [u.id, u.name]));
      paintQuestion();
      paintStruggling();
      paintStats();
    })
    .catch(() => { /* stay with the base names */ });

  paintNames();
  rotateHandle = setInterval(() => { if (!destroyed) paintNames(); }, 2800);

  function paintNames() {
    const names = view.players.map((p) => p.nickname);
    lobbyNames.textContent = '';
    if (!names.length) {
      lobbyNames.append(h('span', { class: 'muted small' }, 'Waiting for the first coder to join…'));
      return;
    }
    const start = paintNames.i = (paintNames.i || 0) % names.length;
    const slice = [];
    for (let i = 0; i < Math.min(6, names.length); i++) slice.push(names[(start + i) % names.length]);
    paintNames.i = (start + 3) % Math.max(1, names.length);
    lobbyNames.append(...slice.map((n) => h('span', { class: 'chip' }, `👋 ${n}`)));
  }

  // ---------- boot: join (and re-join after a dropped connection) ----------
  /** Apply the authoritative session state carried by a join/stale response. */
  function applyHostState(st) {
    if (!st || destroyed || view.ended) return;
    if (st.status) view.status = st.status;
    if (st.phase) view.phase = st.phase;
    if (typeof st.qIndex === 'number') view.qIndex = st.qIndex;
    if (typeof st.total === 'number') view.total = st.total;
    if (st.question && typeof st.qIndex === 'number' && st.qIndex >= 0) {
      view.qmeta = { ...(st.meta || {}), question: st.question, qIndex: st.qIndex, total: st.total };
    }
    paintQuestion();
    paintStruggling();
    paintLeaderboard();
    sync();
  }

  async function joinSession(rebind = false) {
    const res = await emitAck('host:join', { code, token: authToken() });
    if (destroyed) return;
    if (res?.error || !res?.ok) {
      joinError(res?.error || 'That session could not be opened.');
      return;
    }
    view.joined = true;
    // the server is the source of truth for the code this dashboard is driving
    if (res.code && res.code !== view.code) {
      view.code = String(res.code).toUpperCase();
      codeEl.textContent = view.code;
      save({ teacherCode: view.code });
    }
    view.config = res.config || null;
    sessionUnitNames = view.config?.unitNames || null;
    paintLobbyMeta();
    paintSetLine();
    if (res.roster) applyRoster(res.roster);
    if (res.stats) {
      view.stats = res.stats;
      if (Array.isArray(res.stats.missed)) view.missed = res.stats.missed;
      if (res.stats.unitStats) view.unitStats = res.stats.unitStats;
    }
    // resumed mid-run (page refresh, a reconnect, or a server restart):
    // restore phase + question from the server's own view
    applyHostState(res.state);
    paintQuestion();
    paintStruggling();
    paintLeaderboard();
    sync();
    if (view.status === 'ended') fetchReport();
    if (rebind) toast('Dashboard reconnected ✅', '', 1600);
  }

  joinSession(false).catch((e) => {
    if (!destroyed && !view.joinFailed) joinError(e.message || 'Could not reach the server.');
  });
}

// ---------- shared bits ----------
function mkBtn(label, aria, onClick) {
  return h('button', { class: 'btn small', type: 'button', 'aria-label': aria, onClick }, label);
}

const unitName = (u) => (sessionUnitNames && sessionUnitNames[u])
  || (unitNames && unitNames[u])
  || baseUnitName(u);
const medal = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`);

function clock(ms) {
  const s = Math.max(0, Math.round((ms || 0) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function unitBars(map, nameFn = unitName) {
  return Object.entries(map || {})
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([u, s]) => {
      const acc = typeof s.accuracy === 'number' ? s.accuracy : (s.total ? s.correct / s.total : 0);
      const tone = acc >= 0.8 ? 'good' : acc >= 0.5 ? 'warn' : 'bad';
      return h('div', { class: 'bar-row' },
        h('span', { class: 'label', title: nameFn(Number(u)) },
          `${nameFn(Number(u))}${s.total ? ` · ${s.correct}/${s.total}` : ''}`),
        h('span', { class: 'val' }, pct(acc)),
        h('div', { class: 'bar-track' },
          h('span', { class: tone, style: { width: `${Math.round(acc * 100)}%` } })));
    });
}

function badgeIcons(ids) {
  const list = (ids || []).map(badgeById);
  if (!list.length) return '—';
  return h('span', { title: list.map((b) => b.name).join(', ') },
    `${list.map((b) => b.icon).join(' ')} ${list.length}`);
}

// ---------- end-of-session report ----------
// Exported: the print page and the history screen reuse this exact layout.
export function setUnitNames(list) {
  if (Array.isArray(list) && list.length) unitNames = Object.fromEntries(list.map((u) => [u.id, u.name]));
}
export const getUnitName = (u) => unitName(u);

export function reportView(report) {
  const totals = report.totals || {};
  const players = report.players || [];
  const sort = { key: 'score', dir: -1 };
  // old reports (pre fixed-marks) keep their original wording/columns
  const marksMode = Number.isFinite(report.maxMarks);
  const scoreLabel = marksMode ? 'Marks' : 'Score';
  const fmtScore = (n) => (marksMode ? fmtMarks(n) : String(n ?? 0));

  const COLS = [
    { label: 'Student' },
    { label: 'Team' },
    { label: scoreLabel, key: 'score' },
    { label: 'Correct', key: 'correct' },
    { label: 'Wrong' },
    { label: 'Accuracy', key: 'accuracy' },
    { label: 'Time (mm:ss)' },
    { label: 'Best streak' },
    { label: 'Badges' },
    { label: 'Needs help' },
  ];

  const thead = h('thead');
  const tbody = h('tbody');

  function paintHead() {
    thead.textContent = '';
    thead.append(h('tr', null, COLS.map((c) => {
      if (!c.key) return h('th', { scope: 'col' }, c.label);
      const active = sort.key === c.key;
      return h('th', { scope: 'col' }, h('button', {
        class: 'btn small ghost',
        type: 'button',
        'aria-label': `Sort by ${c.label}`,
        style: {
          minHeight: '44px', padding: '2px 8px', borderRadius: '8px',
          fontSize: '.8rem', background: 'transparent', borderColor: 'transparent',
        },
        onClick: () => {
          if (sort.key === c.key) sort.dir *= -1;
          else { sort.key = c.key; sort.dir = -1; }
          paintHead();
          paintBody();
        },
      }, `${c.label}${active ? (sort.dir === -1 ? ' ↓' : ' ↑') : ' ↕'}`));
    })));
  }

  function paintBody() {
    const list = [...players];
    if (sort.key) list.sort((a, b) => ((a[sort.key] || 0) - (b[sort.key] || 0)) * sort.dir);
    tbody.textContent = '';
    tbody.append(...list.map((p) => h('tr', { class: p.needsHelp ? 'needs' : null },
      h('td', null, h('b', null, p.nickname)),
      h('td', null, p.team || 'Solo'),
      h('td', { class: 'num' }, fmtScore(p.score)),
      h('td', { class: 'num' }, p.correct ?? 0),
      h('td', { class: 'num' }, p.wrong ?? 0),
      h('td', { class: 'num' }, pct(p.accuracy || 0)),
      h('td', { class: 'num' }, clock(p.totalTimeMs)),
      h('td', { class: 'num' }, badgeIcons(p.badges)),
      h('td', null, p.needsHelp ? '✓ needs help' : '—'))));
  }

  paintHead();
  paintBody();

  const acc = totals.accuracy || 0;
  const struggling = report.struggling || [];
  const needs = report.needsHelp || [];
  const unitStat = report.unitStats || {};
  const hasUnits = Object.keys(unitStat).length > 0;
  const timerChip = report.config?.timerOn === undefined
    ? null
    : h('span', { class: `chip ${report.config.timerOn ? '' : 'refresher'}` },
      report.config.timerOn ? '⏱ Question timer: on' : '🐢 Question timer: off');
  const setChip = report.config?.setId
    ? h('span', { class: 'chip topic' }, `📦 ${report.config.setName || 'Question bank'}`)
    : null;
  const marksChip = marksMode
    ? h('span', { class: 'chip' }, `🎯 ${fmtMarks(report.maxMarks)} marks available`)
    : null;
  const negChip = marksMode && report.config?.negativeMarking
    ? h('span', { class: 'chip bad' }, `−${fmtMarks(report.config.negativeAmount ?? 0.25)} per wrong answer`)
    : null;
  // this run's own unit names first, then whatever the syllabus says
  const reportUnitName = (u) => (report.config?.unitNames && report.config.unitNames[u]) || unitName(u);
  // team standings: prefer what the server stored, recompute for old reports
  const teams = report.config?.teamMode
    ? (Array.isArray(report.teams) && report.teams.length ? report.teams : rankTeams(players))
    : [];
  // self-paced runs: how long each student sat on each question (teacher only)
  const timeRows = players.filter((p) => Array.isArray(p.answerTimes));
  const showTimes = report.config?.timerOn === false
    && timeRows.length
    && (report.questions?.length || timeRows[0].answerTimes?.length);

  return h('div', null,
    h('div', { class: 'spread', style: { flexWrap: 'wrap', gap: '12px', marginBottom: '16px' } },
      h('div', null,
        h('h1', { style: { margin: 0 } }, '📊 Session report'),
        h('div', { class: 'row', style: { flexWrap: 'wrap', gap: '8px', marginTop: '6px' } },
          h('span', { class: 'muted', style: { margin: 0 } },
            `${report.title || 'Python Adventure'} · session ${report.code}${report.endedAt ? ` · ${new Date(report.endedAt).toLocaleString()}` : ''}`),
          timerChip,
          setChip,
          marksChip,
          negChip)),
      h('div', { class: 'row no-print' },
        h('button', { class: 'btn primary', type: 'button', onClick: () => downloadCsv(report, unitName) }, '⬇️ Download CSV'),
        h('button', { class: 'btn', type: 'button', onClick: () => window.print() }, '🖨 Print report'),
        h('button', { class: 'btn ghost', type: 'button', onClick: () => go('#/teacher/reports') }, '📚 History'),
        h('button', { class: 'btn ghost', type: 'button', onClick: () => go('#/teacher') }, 'New quiz'))),

    h('div', { class: 'grid cols-3', style: { marginBottom: '16px' } },
      h('div', { class: 'stat brand' }, h('div', { class: 'k' }, 'Players'), h('div', { class: 'v' }, totals.players ?? players.length)),
      h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Total answers'), h('div', { class: 'v' }, totals.answers ?? 0)),
      h('div', { class: `stat ${acc >= 0.7 ? 'good' : acc < 0.5 ? 'bad' : ''}` },
        h('div', { class: 'k' }, 'Class accuracy'), h('div', { class: 'v' }, pct(acc)))),

    h('div', { class: 'card' },
      h('div', { class: 'spread' },
        h('h2', { style: { margin: 0 } }, '👩‍🎓 Students'),
        h('span', { class: 'chip' }, `${players.length} player${players.length === 1 ? '' : 's'}`)),
      h('p', { class: 'muted small' }, `Click ${scoreLabel}, Correct or Accuracy to sort.`),
      h('div', { class: 'table-wrap', style: { marginTop: '8px' } }, h('table', null, thead, tbody))),

    teams.length
      ? h('div', { class: 'card' },
        h('div', { class: 'spread' },
          h('h2', { style: { margin: 0 } }, '🏆 Team standings'),
          h('span', { class: 'chip' }, `${teams.length} team${teams.length === 1 ? '' : 's'}`)),
        h('p', { class: 'muted small' }, 'Team score is the sum of every member - solo players rank individually in the table above.'),
        h('div', { class: 'table-wrap', style: { marginTop: '8px' } },
          h('table', null,
            h('thead', null, h('tr', null,
              (marksMode
                ? ['Rank', 'Team', 'Marks', 'Avg per member', 'Accuracy', 'Members']
                : ['Rank', 'Team', 'Score', 'Avg per member', 'Accuracy', 'Members'])
                .map((t, i) => h('th', { scope: 'col', class: i === 0 || i === 2 || i === 3 || i === 4 ? 'num' : '' }, t)))),
            h('tbody', null, teams.map((t) => h('tr', null,
              h('td', { class: 'num' }, `#${t.rank}`),
              h('td', null, h('b', null, `👥 ${t.name}`)),
              h('td', { class: 'num' }, fmtScore(t.score)),
              h('td', { class: 'num' }, fmtScore(t.avg)),
              h('td', { class: 'num' }, pct(t.accuracy || 0)),
              h('td', null, (t.members || []).join(', ') || '—')))))))
      : null,

    showTimes
      ? h('div', { class: 'card' },
        h('h2', null, '⏱ Time per question (seconds)'),
        h('p', { class: 'muted small' },
          'How long each student spent on each question - blank means it was never attempted.'),
        h('div', { class: 'table-wrap', style: { marginTop: '8px' } }, h('table', null,
          h('thead', null, h('tr', null,
            h('th', { scope: 'col' }, 'Student'),
            ...(report.questions || []).map((q, i) => h('th', { scope: 'col', class: 'num' }, `Q${i + 1}`)),
            h('th', { scope: 'col', class: 'num' }, 'Total'))),
          h('tbody', null, timeRows.map((p) => h('tr', null,
            h('td', null, h('b', null, p.nickname)),
            ...(report.questions || []).map((_, i) => {
              const ms = p.answerTimes[i];
              return h('td', { class: 'num' }, ms == null ? '—' : String(Math.round(ms / 100) / 10));
            }),
            h('td', { class: 'num' }, clock(p.totalTimeMs))))))))
      : null,

      h('div', { class: 'card' },
        h('h2', null, '🗺️ Level performance'),
        hasUnits
          ? h('div', null, unitBars(unitStat, reportUnitName))
          : h('p', { class: 'muted' }, 'No level data for this run.'),
      h('p', { class: 'muted small', style: { margin: '8px 0 0' } },
        '🟢 80%+ solid · 🟡 50-79% shaky · 🔴 under 50% needs love')),

    h('div', { class: 'grid cols-2' },
      h('div', { class: 'card' },
        h('h2', null, '🔥 Most struggled with'),
        struggling.length
          ? h('div', null, struggling.slice(0, 8).map((s) => h('div', { style: { padding: '8px 0', borderBottom: '1px solid var(--line)' } },
            h('div', { class: 'spread' },
              h('b', null, s.id || 'Question'),
              h('span', { class: 'chip bad' }, `${pct(s.missRate || 0)} missed`)),
            h('div', { class: 'muted small', style: clamp2 }, s.prompt))))
          : h('p', { class: 'muted' }, 'Nothing tripped the class up - lovely run 🌱')),

      h('div', { class: 'card' },
        h('h2', null, '🤝 Needs extra help'),
        needs.length
          ? h('div', null,
            h('p', { class: 'muted small' }, 'These students scored under half or were weak in 2+ levels.'),
            h('div', { class: 'tag-list' }, needs.map((n) => h('span', { class: 'chip bad' }, `💞 ${n}`))))
          : h('p', { class: 'muted' }, 'Nobody needs extra help this time 🌱'))));
}
export function destroy() {
  destroyed = true;
  clearInterval(rotateHandle);
  rotateHandle = null;
  cleanup.forEach((fn) => { try { fn?.(); } catch { /* noop */ } });
  cleanup = [];
}
