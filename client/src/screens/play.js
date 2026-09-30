// The main game screen: question, timer, power-ups, feedback, leaderboard.
import { h, mount, toast, confetti, climbToast, fmtClock, esc } from '../ui.js';
import { renderQuestion, markAnswer } from '../game/questionView.js';
import { getActive, clearActive } from '../game/session.js';
import { store, save } from '../state.js';
import { go } from '../main.js';
import { startHeartbeat, request } from '../net.js';

let FACTS = null;
function loadFacts() {
  if (FACTS) return;
  request('/api/facts')
    .then((d) => { FACTS = [...(d.bugs || []), ...(d.didYouKnow || [])]; })
    .catch(() => { FACTS = []; });
}

const UNIT_NAMES = {
  1: 'Level 1 · Setup', 2: 'Level 2 · Variables', 3: 'Level 3 · Conditionals',
  4: 'Level 4 · Loops', 5: 'Level 5 · Strings', 6: 'Level 6 · Lists', 7: 'Level 7 · Tuples & Dicts',
};

let cleanup = [];
let stopHeartbeat = null;
let timerHandle = null;
let overallHandle = null;
let current = null; // { engine, meta }
let lastRank = null;
let busy = false;
let paced = false;          // teacher's question timer is OFF for this question
let paceOpts = { allowBack: false, allowSkip: false, quizEndsAt: null };
let visitHistory = [];      // question indexes visited this run (live self-paced)

export const title = 'Play';

export function render(root) {
  const active = getActive();
  if (!active) {
    go('#/');
    return;
  }
  current = active;
  lastRank = null;
  busy = false;
  const last = active.meta.mode === 'live' ? active.engine.lastQuestion : null;
  paced = !!(active.meta.selfPaced
    || (active.meta.mode === 'live' ? last?.selfPaced : active.engine.paced));
  paceOpts = {
    allowBack: !!(active.meta.allowBack ?? last?.allowBack),
    allowSkip: (active.meta.allowSkip ?? last?.allowSkip) !== false,
    quizEndsAt: active.meta.quizEndsAt ?? last?.quizEndsAt ?? null,
  };
  visitHistory = [];

  const { engine, meta } = active;
  const isLive = meta.mode === 'live';

  const progressEl = h('div', { class: 'progress' }, h('span', { style: { width: '0%' } }));
  const chipsEl = h('div', { class: 'q-meta' });
  const timerEl = h('div', { class: 'timer' }, h('span', { class: 'dot' }), h('span', { class: 'val' }, '--'), h('span', { class: 'relax' }, 'relax'));
  const overallEl = h('span', { class: 'chip hide' }, '⏳ --:--');
  const scoreEl = h('div', { class: 'chip' }, '⭐ 0');
  const streakEl = h('div', { class: 'streak-pill hide' }, '');
  const qNumberEl = h('span', { class: 'muted small' }, '');

  const questionCard = h('div', { class: 'card' });
  const feedbackSlot = h('div');
  const factSlot = h('div');
  const lbSlot = h('div');

  const header = h('div', { class: 'q-head' },
    h('div', { class: 'q-meta' }, chipsEl),
    h('div', { class: 'row' }, streakEl, scoreEl, overallEl, timerEl)
  );

  const main = h('div', { class: 'grow' },
    h('div', { class: 'spread' },
      h('h1', { class: 'screen-label' }, isLive ? 'LIVE GAME' : 'PRACTICE'),
      qNumberEl
    ),
    progressEl,
    questionCard,
    feedbackSlot,
    factSlot
  );

  const layout = h('div', { class: 'row', style: { alignItems: 'flex-start', gap: '18px' } },
    main,
    isLive ? h('div', { style: { flex: '0 0 300px', minWidth: '260px' } }, lbSlot) : null
  );

  mount(root,
    h('div', { class: 'screen' }, header, layout)
  );

  if (isLive) stopHeartbeat = startHeartbeat();
  else loadFacts();

  // ---------- engine wiring ----------
  let view = null;
  let questionInfo = null;
  let answered = false;

  const setProgress = (idx, total) => {
    progressEl.firstElementChild.style.width = `${Math.round(((idx) / Math.max(1, total)) * 100)}%`;
    qNumberEl.textContent = `Question ${idx + 1} of ${total}`;
  };

  const renderQuestionCard = (payload) => {
    questionInfo = payload;
    answered = false;
    feedbackSlot.textContent = '';
    questionCard.textContent = '';

    // self-paced contract arrives with every question
    if (payload.selfPaced !== undefined) paced = !!payload.selfPaced;
    if (payload.allowBack !== undefined) paceOpts.allowBack = !!payload.allowBack;
    if (payload.allowSkip !== undefined) paceOpts.allowSkip = !!payload.allowSkip;
    if (payload.quizEndsAt !== undefined) paceOpts.quizEndsAt = payload.quizEndsAt ?? null;
    if (meta.mode === 'live' && paced
      && (!visitHistory.length || visitHistory[visitHistory.length - 1] !== payload.qIndex)) {
      visitHistory.push(payload.qIndex);
    }
    timerEl.classList.toggle('hide', paced);
    updateOverallClock();
    if (payload.review) answered = true; // revisiting an answered question

    const q = payload.question;
    chipsEl.textContent = '';
    chipsEl.appendChild(h('span', { class: `chip ${payload.boss ? 'boss' : 'topic'}` },
      payload.boss ? '👑 BOSS QUESTION'
        : payload.unitLabel || UNIT_NAMES[payload.unit] || `Unit ${payload.unit}`));
    if (payload.refresher) chipsEl.appendChild(h('span', { class: 'chip refresher' }, '🔄 Refresher'));
    if (q.type) chipsEl.appendChild(h('span', { class: 'chip' }, typeLabel(q.type)));

    setProgress(payload.qIndex, payload.total);
    scoreEl.textContent = `⭐ ${engine.player?.score ?? currentScore ?? 0}`;

    if (payload.review) {
      questionCard.appendChild(h('div', { class: 'explain', style: { marginTop: 0 } },
        h('h2', null, '✔ Already answered'),
        h('p', { style: { margin: 0 } },
          payload.review.correct ? 'You got this one right. '
            : (payload.review.correctAnswer || payload.review.accepted
              ? `Correct answer: ${answerText(q, payload.review.correctAnswer, payload.review.accepted)}. `
              : ''),
          'Use Next when you are ready to move on.')));
    }

    questionCard.appendChild(h('p', { class: 'prompt' }, q.prompt));
    view = renderQuestion(q, { onDirty: () => updateSubmit() });
    questionCard.appendChild(view.element);
    if (payload.review) {
      view.lock?.();
      if (q.type === 'mcq' || q.type === 'code-output' || q.type === 'spot-error') {
        markAnswer(view, q, payload.review.yourAnswer, payload.review.correctAnswer);
      }
    }

    function updateSubmit() {
      if (submitBtn) submitBtn.disabled = answered || view.isEmpty();
    }

    const powerups = h('div', { class: 'powerups', style: { marginTop: '16px' } });
    const usedHere = new Set();
    const mkPower = (kind, label, cost, icon) => {
      const btn = h('button', {
        class: 'powerup', type: 'button',
        onClick: async () => {
          if (usedHere.has(kind) || busy) return;
          busy = true;
          try {
            const res = await engine.powerup(kind);
            if (res.error) { toast(res.error, 'bad'); return; }
            usedHere.add(kind);
            btn.disabled = true;
            if (kind === 'hint') showHint(res.hint);
            if (kind === 'fifty') view.setRemoved?.(res.remove || []);
            if (kind === 'extraTime') toast('Bonus time added ⏱️', 'gold');
            if (res.cost) toast(`${label} used (-${res.cost} pts)`, '');
          } catch (e) {
            toast(e.message, 'bad');
          } finally { busy = false; }
        },
      }, `${icon} ${label}`, h('span', { class: 'cost' }, cost ? `-${cost}` : 'free'));
      return btn;
    };
    powerups.appendChild(mkPower('hint', 'Hint', 15, '💡'));
    powerups.appendChild(mkPower('fifty', '50-50', 10, '✂️'));
    if (!paced) powerups.appendChild(mkPower('extraTime', 'Extra time', 10, '⏱️'));
    if (meta.mode === 'practice') powerups.appendChild(mkPower('skip', 'Skip once', 0, '⏭️'));

    const hintBox = h('div');
    let submitBtn = h('button', {
      class: 'btn primary big block', type: 'button', disabled: true,
      onClick: () => submit(),
    }, payload.review ? 'Answered ✓' : 'Lock in my answer');

    questionCard.appendChild(h('div', { class: 'divider' }));
    questionCard.appendChild(powerups);
    questionCard.appendChild(hintBox);
    questionCard.appendChild(h('div', { style: { marginTop: '14px' } }, submitBtn));

    // self-paced navigation: Back / Skip before answering, Next after a review
    if (meta.mode === 'live' && paced) {
      const navRow = h('div', { class: 'row', style: { gap: '10px', marginTop: '12px', flexWrap: 'wrap' } });
      const earlier = visitHistory.filter((i) => i < payload.qIndex);
      const backTo = earlier.length ? Math.max(...earlier) : null;
      if (paceOpts.allowBack) {
        const backBtn = h('button', {
          class: 'btn', type: 'button', disabled: backTo === null,
          onClick: async () => {
            if (backTo === null || busy) return;
            busy = true;
            const res = await engine.goto(backTo);
            busy = false;
            if (res?.error) toast(res.error, 'bad');
          },
        }, '← Back');
        navRow.appendChild(backBtn);
      }
      if (paceOpts.allowSkip && !answered) {
        navRow.appendChild(h('button', {
          class: 'btn', type: 'button',
          onClick: async () => {
            if (busy) return;
            busy = true;
            const res = await engine.advance({ skip: true });
            busy = false;
            if (res?.error) toast(res.error, 'bad');
          },
        }, 'Skip →'));
      }
      if (payload.review) {
        navRow.appendChild(h('button', {
          class: 'btn primary', type: 'button',
          onClick: () => advanceLive(),
        }, 'Next question →'));
      }
      questionCard.appendChild(navRow);
    }

    updateSubmit();
    questionCard.appendChild(h('p', { class: 'muted small', style: { margin: '10px 0 0' } },
      meta.mode === 'practice'
        ? 'No leaderboard here - just you and the code.'
        : paced
          ? 'No clock - take your time. Points reward understanding, not speed.'
          : 'Points: speed adds a little, understanding adds the most.'));

    function showHint(text) {
      hintBox.textContent = '';
      hintBox.appendChild(h('div', { class: 'explain', style: { marginTop: '12px' } },
        h('h2', null, '💡 Hint (-15)'), h('p', { style: { margin: 0 } }, text)));
    }

    // timer (self-paced questions have no countdown at all)
    if (paced) clearInterval(timerHandle);
    else startTimer(payload, submit);
    view.focus?.();
  };

  /** Whole-quiz countdown chip (only when the teacher set an overall limit). */
  function updateOverallClock() {
    clearInterval(overallHandle);
    const endsAt = paceOpts.quizEndsAt;
    if (!endsAt) { overallEl.classList.add('hide'); return; }
    overallEl.classList.remove('hide');
    const paint = () => {
      const left = endsAt - Date.now();
      if (left <= 0) { overallEl.textContent = '⏳ time up'; clearInterval(overallHandle); return; }
      overallEl.textContent = `⏳ ${fmtClock(left)}`;
      overallEl.classList.toggle('warn', left <= 60_000);
    };
    paint();
    overallHandle = setInterval(paint, 1000);
  }

  /** Self-paced Next / Skip for the live game. */
  async function advanceLive(skip = false) {
    if (busy) return;
    busy = true;
    try {
      const res = await engine.advance({ skip });
      if (res?.error) toast(res.error, 'bad');
    } catch (e) {
      toast(e.message, 'bad');
    } finally { busy = false; }
  }

  let currentScore = engine.player?.score || 0;
  let endsAt = 0;

  function startTimer(payload, onTimeout) {
    clearInterval(timerHandle);
    endsAt = payload.endsAt || (Date.now() + (payload.duration || 30000));
    const duration = payload.duration || (endsAt - Date.now());
    let announced = false;
    timerHandle = setInterval(() => {
      const left = endsAt - Date.now();
      const secs = Math.max(0, Math.ceil(left / 1000));
      timerEl.querySelector('.val').textContent = fmtClock(left);
      timerEl.classList.toggle('warn', left <= 10_000 && left > 0);
      timerEl.classList.toggle('done', left <= 0);
      if (left <= 10_000 && left > 0 && !announced) {
        announced = true;
        timerEl.querySelector('.relax').textContent = 'take your time';
      }
      if (left <= 0) {
        clearInterval(timerHandle);
        if (!answered && meta.mode === 'practice') onTimeout();
        else if (!answered) timerEl.querySelector('.relax').textContent = 'time is up';
      }
    }, 200);
  }

  const submit = async () => {
    if (!view || answered || busy) return;
    busy = true;
    const answer = view.getAnswer();
    if (view.isEmpty()) { busy = false; return; }
    answered = true;
    view.lock?.();
    try {
      const res = await engine.submit(answer);
      if (res.error) {
        answered = false;
        busy = false;
        toast(res.error, 'bad');
        return;
      }
      showFeedback(res.result, view, questionInfo.question);
    } catch (e) {
      answered = false;
      view.unlock?.();
      toast(e.message, 'bad');
    } finally {
      busy = false;
    }
  };

  const timeoutNow = async () => {
    if (answered) return;
    answered = true;
    view?.lock?.();
    const res = engine.timeout?.();
    if (res) showFeedback(res, view, questionInfo.question);
  };

  function showFeedback(result, activeView, q) {
    clearInterval(timerHandle);
    currentScore = result.score ?? (engine.player?.score ?? currentScore);
    scoreEl.textContent = `⭐ ${currentScore}`;
    if (result.streak >= 2) {
      streakEl.classList.remove('hide');
      streakEl.textContent = `🔥 ${result.streak} in a row`;
    }

    activeView?.markResult?.(result.yourAnswer, result.correctAnswer);

    const good = result.correct;
    if (good) { confetti(result.earned >= 100 ? 60 : 34); }
    else activeView?.element?.classList.add('shake');

    const breakdown = h('div', { class: 'breakdown' },
      (result.breakdown || []).map((b) =>
        h('span', { class: `b ${b.value < 0 ? 'neg' : b.value > 0 ? 'pos' : ''}` },
          `${b.value >= 0 ? '+' : ''}${b.value} ${b.label}`)));

    const badges = (result.badges || []).length
      ? h('div', { class: 'badges', style: { marginTop: '12px' } },
        result.badges.map((b) => h('div', { class: 'badge pop' },
          h('span', { class: 'ico' }, b.icon),
          h('span', null, b.name, h('small', null, b.desc)))))
      : null;

    const correctLine = q?.type === 'match' && result.pairs
      ? h('div', { style: { fontWeight: 700 } },
        h('p', { style: { margin: '4px 0 6px' } }, 'Right pairs:'),
        h('div', { class: 'col', style: { gap: '4px' } },
          result.pairs.map((p) => h('span', { class: 'chip good' }, `${p.left}  →  ${p.right}`))))
      : result.correctAnswer
        ? h('p', { style: { margin: '4px 0 0', fontWeight: 700 } },
          'Correct answer: ',
          h('span', { class: 'chip good' }, answerText(q, result.correctAnswer, result.accepted)))
        : h('p', { style: { margin: '4px 0 0', fontWeight: 700 } },
          'Correct answer: ', h('span', { class: 'chip good' }, result.accepted?.join(' / ') || 'see below'));

    const miniSlot = h('div');
    if (result.mini) {
      const mini = result.mini;
      const miniView = renderQuestion(
        mini.type === 'fill-blank'
          ? { type: 'fill-blank', prompt: mini.prompt, blank: mini.prompt, accepted: mini.accepted }
          : { type: 'mcq', prompt: mini.prompt, options: mini.options, answer: [mini.answer] },
        {}
      );
      const btn = h('button', {
        class: 'btn small', type: 'button', style: { marginTop: '10px' }, disabled: true,
        onClick: async () => {
          btn.disabled = true;
          const given = miniView.getAnswer();
          const correct = mini.type === 'fill-blank'
            ? (mini.accepted || []).some((a) => norm(a) === norm(given))
            : given === mini.answer;
          const out = await engine.mini(correct);
          miniView.lock?.();
          toast(correct ? `Nice comeback! +${out.earned ?? 10}` : 'Almost - read the why below.', correct ? 'good' : 'bad');
          miniSlot.appendChild(h('div', { class: 'explain' },
            h('h2', null, correct ? '✅ Right' : 'Here is the why'),
            h('p', { style: { margin: 0 } }, mini.explanation)));
          nextBtn?.focus();
        },
      }, 'Try again');
      miniView.onDirty = () => { btn.disabled = miniView.isEmpty(); };
      miniSlot.appendChild(h('div', { class: 'mini' },
        h('div', { class: 'mini-tag' }, '🔄 Try again on the same idea'),
        h('p', { class: 'prompt', style: { marginTop: '6px', marginBottom: '6px' } }, mini.prompt),
        miniView.element,
        btn));
    }

    const nextBtn = (meta.mode === 'practice' || (meta.mode === 'live' && paced))
      ? h('button', {
        class: 'btn primary big block', style: { marginTop: '14px' },
        onClick: () => { meta.mode === 'practice' ? next() : advanceLive(); },
      }, 'Next question →')
      : h('p', { class: 'muted small', style: { marginTop: '14px', textAlign: 'center' } }, 'Waiting for the rest of the class…');

    feedbackSlot.textContent = '';
    feedbackSlot.appendChild(h('div', { class: `feedback pop ${good ? 'good' : 'bad'}`, role: 'status' },
      h('p', { class: 'headline' },
        good ? '✅ Nailed it!' : (result.timedOut ? '⏰ Out of time' : '🙂 Not this one'),
        h('span', { class: 'points', style: { marginLeft: 'auto' } }, `+${result.earned}`)),
      good
        ? h('p', { class: 'muted', style: { margin: 0 } }, streakLine(result.streak))
        : h('p', { style: { margin: 0 } }, result.encouragement || 'Have a look at the why below.'),
      breakdown,
      good ? null : h('div', { class: 'explain' }, h('h2', null, 'Why'), correctLine, h('p', { style: { marginBottom: 0 } }, result.explanation)),
      good ? h('div', { class: 'explain' }, h('h2', null, 'Why it works'), h('p', { style: { marginBottom: 0 } }, result.explanation)) : null,
      good ? null : h('div', { class: 'analogy' }, `Think of it like this: ${result.analogy}`),
      badges,
      miniSlot,
      nextBtn
    ));
    feedbackSlot.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function next() {
    // local engine drives its own question events after advance()
    showFact();
    engine.advance();
  }

  function showFact() {
    if (!FACTS?.length) return;
    const fact = FACTS[Math.floor(Math.random() * FACTS.length)];
    factSlot.textContent = '';
    factSlot.appendChild(h('div', { class: 'ticker', style: { marginTop: '14px' } },
      h('b', null, '🐍 '), fact,
      h('button', { class: 'btn small ghost', style: { marginLeft: 'auto' }, onClick: () => { factSlot.textContent = ''; } }, '×')));
    setTimeout(() => { factSlot.textContent = ''; }, 6000);
  }

  // ---------- leaderboard ----------
  let lastLb = null;
  const updateLeaderboard = (lb) => {
    if (!lbSlot) return;
    if (lb && lb.visible === false) {
      lbSlot.appendChild(h('div', { class: 'card tight' }, h('p', { class: 'muted small', style: { margin: 0 } }, 'The teacher has hidden the leaderboard for now.')));
      return;
    }
    const rows = lb.mode === 'team'
      ? (lb.teams || []).map((t) => h('div', { class: 'lb-row' },
        h('span', { class: 'rank' }, t.rank),
        h('span', { class: 'who' }, h('b', null, `${t.name} ${t.members.length > 1 ? '👥' : ''}`),
          h('span', null, `${t.correct} right · ${Math.round(t.accuracy * 100)}%`)),
        h('span', { class: 'pts' }, t.score),
        h('span', null)))
      : (lb.entries || []).map((e) => h('div', { class: `lb-row ${e.me ? 'me' : ''}` },
        h('span', { class: 'rank' }, rankIcon(e.rank)),
        h('span', { class: 'who' }, h('b', null, `${e.nickname}${e.team ? ` · ${e.team}` : ''}`),
          h('span', null, `${e.correct} right${e.streak >= 2 ? ` · 🔥${e.streak}` : ''}`)),
        h('span', { class: 'pts' }, e.score),
        h('span', { class: 'delta' }, deltaFor(e))));

    lbSlot.textContent = '';
    lbSlot.appendChild(h('div', { class: 'card tight' },
      h('div', { class: 'spread', style: { marginBottom: '10px' } },
        h('h2', { style: { margin: 0, fontSize: '1.1rem' } }, lb.mode === 'team' ? '👥 Teams' : '🏆 Leaderboard'),
        h('span', { class: 'chip' }, lb.mode === 'team' ? `${lb.teams.length} teams` : `${lb.total ?? (lb.entries || []).length} players`)),
      h('div', { class: 'lb' }, rows),
      lb.hidden > 0 ? h('div', { class: 'lb-hidden' }, `+ ${lb.hidden} player${lb.hidden > 1 ? 's' : ''} hidden - everyone is learning 🌱`) : null,
      h('p', { class: 'muted small', style: { margin: '10px 0 0' } }, 'Scores reward understanding first, speed second.')
    ));

    // rank climb celebration
    const me = (lb.entries || []).find((e) => e.me) || (lb.teams || []).find((t) => t.me);
    const myRank = me?.rank;
    if (myRank && lastRank && myRank < lastRank) {
      const up = lastRank - myRank;
      if (up >= 2) climbToast(`🚀 Up ${up} places!`);
      else toast(`You moved up to #${myRank}`, 'gold', 1600);
    }
    if (myRank) lastRank = myRank;
    lastLb = lb;
  };

  const deltaFor = (e) => (e.rank === 1 ? '👑' : e.badges ? '🏅'.repeat(Math.min(2, e.badges)) : '');
  const rankIcon = (r) => (r === 1 ? '🥇' : r === 2 ? '🥈' : r === 3 ? '🥉' : `#${r}`);

  function handleQuestion(p) {
    renderQuestionCard(p);
    if (meta.mode === 'live' && p.lateJoin) toast('You joined mid-quiz - good luck!', 'gold');
  }

  function handleReveal(p) {
    if (p.fact) {
      factSlot.textContent = '';
      factSlot.appendChild(h('div', { class: 'ticker', style: { marginTop: '14px' } },
        h('b', null, p.fact.kind === 'bugs' ? '🐛 Bug of the Day: ' : '💡 Did you know? '),
        p.fact.text));
      setTimeout(() => { factSlot.textContent = ''; }, 9000);
    }
  }

  cleanup.push(engine.on('question', handleQuestion));
  cleanup.push(engine.on('reveal', handleReveal));
  cleanup.push(engine.on('leaderboard', updateLeaderboard));
  cleanup.push(engine.on('time-extended', (p) => { endsAt = p.endsAt; }));
  cleanup.push(engine.on('sync', (p) => {
    if (!p?.endsAt) return;
    endsAt = p.endsAt;
    if (p.extended) toast('⏱️ Bonus time from the teacher', 'gold', 2000);
  }));
  cleanup.push(engine.on('pushed-result', (p) => {
    if (answered || !questionInfo) return;
    answered = true;
    showFeedback(p, view, questionInfo.question);
  }));

  if (meta.mode === 'live') {
    // if we joined mid-quiz the question may have arrived before this screen mounted
    if (engine.lastQuestion && !questionInfo) handleQuestion(engine.lastQuestion);
    cleanup.push(engine.on('control', (p) => {
      if (p.action === 'pause') { clearInterval(timerHandle); toast('⏸️ The teacher paused the game', 'gold'); }
      if (p.action === 'resume') {
        toast('▶️ Back in play', '');
        if (!answered && !paced) startTimer({ endsAt }, submit);
      }
      if (p.action === 'hide-leaderboard') lbSlot.textContent = '';
      if (p.action === 'timer-changed') {
        toast(p.timerOn
          ? '⏱️ Question timer back ON - the next question is shared'
          : '🐢 Question timer OFF - go at your own pace', 'gold', 2800);
      }
    }));
    cleanup.push(engine.on('answer-shown', (p) => toast(`Answer: ${p.answer?.join?.(', ') || p.answer || ''}`, 'gold', 4000)));
    cleanup.push(engine.on('class-mistake', (p) => {
      const most = p.option;
      modalish('Anonymous class mistake',
        h('div', null,
          h('p', null, `${p.count} ${p.count === 1 ? 'person picked' : 'people picked'} this answer:`),
          most ? h('p', { class: 'option', style: { pointerEvents: 'none' } }, h('span', { class: 'key' }, '✗'), h('span', null, most.text)) : null,
          h('p', { style: { fontWeight: 700 } }, `Actually: ${p.options.find((o) => p.answer?.includes(o.id))?.text || ''}`),
          h('p', { class: 'muted' }, p.explanation)));
    }));
    cleanup.push(engine.on('end', (report) => {
      save({ lastReport: { ...report, meId: engine.playerId } });
      clearActive();
      go('#/results');
    }));
    cleanup.push(engine.on('finished', (p) => {
      // self-paced: every question answered - park here until the quiz ends
      answered = true;
      clearInterval(timerHandle);
      progressEl.firstElementChild.style.width = '100%';
      qNumberEl.textContent = `Finished · ${p.answered ?? '?'} of ${p.total ?? '?'}`;
      const badgeRow = (p.badges || []).length
        ? h('div', { class: 'badges', style: { marginTop: '12px' } },
          p.badges.map((b) => h('div', { class: 'badge pop' },
            h('span', { class: 'ico' }, b.icon),
            h('span', null, b.name, h('small', null, b.desc)))))
        : null;
      feedbackSlot.textContent = '';
      feedbackSlot.appendChild(h('div', { class: 'feedback good pop', role: 'status' },
        h('p', { class: 'headline' },
          '🏁 You finished!',
          h('span', { class: 'points', style: { marginLeft: 'auto' } }, `⭐ ${p.score ?? engine.player?.score ?? currentScore ?? 0}`)),
        h('p', { class: 'muted', style: { margin: 0 } },
          `${p.correct ?? engine.player?.correct ?? 0} right · ${p.wrong ?? engine.player?.wrong ?? 0} missed`),
        badgeRow,
        h('p', { class: 'muted small', style: { margin: '10px 0 0' } },
          'Great run - hang tight while the rest of the class finishes.')));
      feedbackSlot.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }));
    cleanup.push(engine.on('peer-joined', (p) => toast(`${p.nickname} joined the game 👋`, '', 1800)));
  } else {
    cleanup.push(engine.on('end', (report) => {
      save({ lastReport: { ...report, meId: 'me' } });
      clearActive();
      go('#/results');
    }));
  }

  // pause timer while the tab is hidden (practice only, keeps it fair)
  const onVis = () => { if (document.hidden && meta.mode === 'practice' && !answered) endsAt += 0; };
  document.addEventListener('visibilitychange', onVis);
  cleanup.push(() => document.removeEventListener('visibilitychange', onVis));
}

function modalish(titleText, body) {
  const back = h('div', { class: 'modal-back', onClick: (e) => { if (e.target === back) back.remove(); } });
  back.appendChild(h('div', { class: 'modal' }, h('h2', null, titleText), body,
    h('button', { class: 'btn primary', style: { marginTop: '14px' }, onClick: () => back.remove() }, 'Got it')));
  document.body.appendChild(back);
  setTimeout(() => back.querySelector('button')?.focus(), 30);
}

function answerText(q, correctAnswer, accepted) {
  if (accepted) return accepted.join(' / ');
  if (!q || !correctAnswer) return '';
  const arr = Array.isArray(correctAnswer) ? correctAnswer : [correctAnswer];
  if (!q.options) return arr.join(', ');
  return arr.map((id) => q.options.find((o) => o.id === id)?.text).filter(Boolean).join(' · ');
}

function norm(s) {
  return String(s ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase();
}

function streakLine(streak) {
  return ({
    1: 'First one in - good start!',
    2: 'Two in a row - nice! 🌤️',
    3: 'Three! You are on a roll 🎸',
    4: 'Four straight - the class can feel it 👀',
    5: 'FIVE! On Fire unlocked 🔥',
  })[streak] || (streak >= 6 ? `${streak} in a row?! Absolute legend 🏆` : 'Keep it going!');
}

const typeLabel = (t) => ({
  mcq: 'Pick one', 'code-output': 'What runs?', 'spot-error': 'Bug hunt',
  'fill-blank': 'Fill the blank', match: 'Match up',
}[t] || t);

export function destroy() {
  clearInterval(timerHandle);
  clearInterval(overallHandle);
  cleanup.forEach((fn) => { try { fn?.(); } catch { /* noop */ } });
  cleanup = [];
  stopHeartbeat?.();
  stopHeartbeat = null;
}
