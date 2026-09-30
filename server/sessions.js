// Live quiz sessions: players, timers, scoring, stats, teacher controls.
import { randomInt } from 'node:crypto';
import { loadBank, publicQuestion, getFacts, loadSetQuestions, setDisplayName } from './bank.js';
import { saveReport } from './reports.js';
import { buildQuiz, shuffleOptions, timerFor, MAX_REFRESHERS_PER_LEVEL } from '../shared/quiz.js';
import { scoreAnswer, comparePlayers, comparePlayersSelfPaced, teamSummary } from '../shared/scoring.js';
import { evaluateBadges, badgeById, ENCOURAGEMENTS } from '../shared/badges.js';
import { saveSnapshot, dropSnapshot, loadSnapshots, MAX_AGE_MS } from './snapshots.js';
import { unitName as baseUnitName, DEFAULT_SET_NAME } from '../shared/units.js';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1
const ACTIVE_WINDOW = 12_000;   // heartbeat younger than this = attempting
const IDLE_WINDOW = 30_000;     // older than this = disconnected
const REVEAL_SECONDS = 8;
const EXTEND_SECONDS = 10;

function makeCode(store) {
  for (let i = 0; i < 50; i++) {
    let code = '';
    for (let j = 0; j < 4; j++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    if (!store.has(code)) return code;
  }
  throw new Error('could not allocate session code');
}

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

/** Keep only well-formed {unitId: "Name"} entries; null when there are none. */
function cleanUnitNames(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const id = Number(k);
    const name = typeof v === 'string' ? v.trim().slice(0, 40) : '';
    if (Number.isInteger(id) && id >= 1 && id <= 999 && name.length >= 2) out[id] = name;
  }
  return Object.keys(out).length ? out : null;
}

export class Session {
  constructor(code, config, io) {
    this.io = io;
    this.code = code;

    const mode = config.mode === 'practice' ? 'practice' : 'live';
    const num = (v, lo, hi, dflt) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : dflt);
    const optNum = (v, lo, hi) => (Number.isFinite(Number(v)) && Number(v) > 0
      ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : null);
    const inTimers = config.timers && typeof config.timers === 'object' ? config.timers : {};
    const inPoints = config.points && typeof config.points === 'object' ? config.points : {};
    // practice runs get a calmer clock unless the teacher set seconds by hand
    const PRACTICE_TIMERS = { easy: 45, medium: 60, hard: 75, bossExtra: 15 };
    const timers = Object.keys(inTimers).length
      ? {
        easy: num(inTimers.easy, 5, 300, 30),
        medium: num(inTimers.medium, 5, 300, 40),
        hard: num(inTimers.hard, 5, 300, 50),
        bossExtra: num(inTimers.bossExtra, 0, 120, 10),
      }
      : (mode === 'practice' ? PRACTICE_TIMERS : {});
    const points = {};
    if (Object.keys(inPoints).length) {
      points.easy = num(inPoints.easy, 1, 1000, 80);
      points.medium = num(inPoints.medium, 1, 1000, 100);
      points.hard = num(inPoints.hard, 1, 1000, 130);
      points.boss = num(inPoints.boss, 1, 1000, 150);
    }

    // ---- question set binding: the quiz runs from exactly one set ----
    let setId = typeof config.setId === 'string' ? config.setId.trim().slice(0, 80) : '';
    let setName = String(config.setName || '').trim().slice(0, 90);
    let setCount = Number.isFinite(Number(config.setCount)) ? Math.max(0, Math.round(Number(config.setCount))) : 0;
    let unitNames = cleanUnitNames(config.unitNames);
    let units = Array.isArray(config.units) ? config.units : null;
    if (setId === 'default') {
      if (!setName) setName = DEFAULT_SET_NAME;
      if (!setCount) setCount = loadBank({ owner: config.ownerId || null, scope: 'default' }).questions.length;
      unitNames = null;
    } else if (setId) {
      // resolved fresh here too, so a restored session picks up its own set
      const loaded = loadSetQuestions(config.ownerId || null, setId);
      if (loaded) {
        if (!setName) setName = loaded.batch.name || loaded.batch.file;
        if (!setCount) setCount = loaded.questions.length;
        if (!unitNames) unitNames = Object.fromEntries(loaded.units.map((u) => [u.id, u.name]));
        const setIds = loaded.units.map((u) => u.id);
        const chosen = (units || []).map((x) => Number(x)).filter((x) => setIds.includes(x));
        units = chosen.length ? chosen : setIds;
      }
    }

    this.config = {
      title: config.title || 'Python Adventure',
      mode,
      units: units?.length ? units : [1, 2, 3, 4, 5, 6, 7],
      count: Math.min(40, Math.max(4, Number(config.count) || 20)),
      difficulty: config.difficulty || 'mixed',
      teamMode: !!config.teamMode,
      showLeaderboard: config.showLeaderboard !== false,
      hideBottom: Math.max(0, Number(config.hideBottom ?? 3)),
      leaderboardToStudents: mode === 'practice' ? false : config.leaderboardToStudents !== false,
      revealSeconds: Math.min(30, Math.max(3, Number(config.revealSeconds) || REVEAL_SECONDS)),
      timers,
      points,
      shuffleOptions: config.shuffleOptions !== false,
      allowHints: config.allowHints !== false,
      allowPowerups: config.allowPowerups !== false,
      lateJoin: config.lateJoin !== false,
      opensAt: Number.isFinite(Number(config.opensAt)) && Number(config.opensAt) > 0
        ? Number(config.opensAt) : null,
      classId: String(config.classId || '').slice(0, 40),
      className: String(config.className || '').slice(0, 40),
      section: String(config.section || '').slice(0, 24),
      useFacts: config.useFacts !== false,
      revisionRounds: config.revisionRounds !== false,
      ownerId: config.ownerId || null,
      ownerName: config.ownerName || '',
      questionIds: (Array.isArray(config.questionIds) ? config.questionIds : [])
        .filter((x) => typeof x === 'string').slice(0, 200),
      // ---- question timer (default ON = the classic lockstep clock) ----
      timerOn: config.timerOn !== false,
      commonSeconds: optNum(config.commonSeconds, 5, 300),   // one time for every question
      quizSeconds: optNum(config.quizSeconds, 10, 3 * 3600), // whole-quiz limit (self-paced)
      allowBack: !!config.allowBack,   // students may revisit earlier questions
      allowSkip: config.allowSkip !== false, // students may skip forward and return later
      // ---- which question set this quiz belongs to ----
      setId,
      setName,
      setCount,
      unitNames,
    };
    this.seed = `${code}-${Date.now()}`;
    this.status = 'lobby'; // lobby | running | paused | ended
    this.phase = 'lobby';  // lobby | question | reveal | ended
    this.qIndex = -1;
    this.currentPaced = false; // mode of the question currently on screen
    this.quiz = [];
    this.players = new Map();
    this.stats = {};       // per question index -> {counts, correct, wrong, times, answered}
    this.questionLog = []; // per question -> {id, unit, ...}
    this.classEvents = []; // for class-level refresher picking
    this.timer = null;     // {duration, endsAt}
    this.revealTimer = null;
    this.overallHandle = null; // whole-quiz countdown (self-paced option)
    this.overallEndsAt = null;
    this.pausedRemaining = null;
    this.startedAt = null;
    this.endedAt = null;
    this.lastFacts = { bugs: null, didYouKnow: null };
    this.revisionFor = new Set(); // units that already got a revision round
    this.setBank = null;          // Map id -> question once a set-bound quiz loads
  }

  // ---------- snapshots (survive a server restart) ----------
  snapshot() {
    return {
      v: 1,
      savedAt: Date.now(),
      code: this.code,
      config: this.config,
      seed: this.seed,
      status: this.status,
      phase: this.phase,
      qIndex: this.qIndex,
      quiz: this.quiz,
      // set-bound quizzes carry their own questions: uploads/deletes never touch them
      setBank: this.setBank ? [...this.setBank.values()] : undefined,
      players: [...this.players.values()].map((p) => ({
        ...p,
        seen: [...p.seen],
        socketId: null, // sockets never survive the restart
        status: p.status === 'attempting' ? 'disconnected' : p.status,
      })),
      stats: this.stats,
      questionLog: this.questionLog,
      classEvents: this.classEvents,
      revisionFor: [...this.revisionFor],
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      pausedRemaining: this.pausedRemaining,
      phaseEndsAt: this.phaseEndsAt ?? null,
      overallEndsAt: this.overallEndsAt ?? null,
      currentPaced: this.currentPaced,
      timer: this.timer ? { duration: this.timer.duration, endsAt: this.timer.endsAt } : null,
      lastFacts: this.lastFacts,
    };
  }

  persist() {
    if (this.status === 'ended') return;
    try {
      saveSnapshot(this.code, this.snapshot());
    } catch (e) {
      console.warn(`[sessions] could not snapshot ${this.code}: ${e.message}`);
    }
  }

  unpersist() {
    try { dropSnapshot(this.code); } catch { /* best effort */ }
  }

  /** What a (re)joining teacher needs: phase, clock and the live question. */
  hostState() {
    const st = {
      status: this.status,
      phase: this.phase,
      qIndex: this.qIndex,
      total: this.quiz.length,
      endsAt: this.phase === 'question' ? (this.timer?.endsAt || null) : (this.phaseEndsAt || null),
      selfPaced: this.currentPaced,
      timerOn: this.timerOn(),
    };
    if (this.status !== 'lobby' && this.phase !== 'ended' && this.qIndex >= 0) {
      const q = this.currentQuestion();
      const e = this.currentEntry();
      if (q) {
        st.question = publicQuestion(q);
        st.meta = {
          qIndex: this.qIndex, total: this.quiz.length, refresher: !!e.refresher,
          unit: q.unit, boss: q.boss, unitLabel: this.unitLabel(q.unit),
          duration: this.timer?.duration ?? null, endsAt: this.timer?.endsAt ?? null,
          selfPaced: this.currentPaced, quizEndsAt: this.overallEndsAt ?? null,
        };
      }
    }
    return st;
  }

  /** Rebuild a session (and its timers) from a snapshot taken before a restart. */
  static restore(snap, io) {
    const s = new Session(snap.code, snap.config || {}, io);
    s.seed = snap.seed || s.seed;
    s.status = snap.status || 'lobby';
    s.phase = snap.phase || 'lobby';
    s.qIndex = Number.isInteger(snap.qIndex) ? snap.qIndex : -1;
    s.quiz = Array.isArray(snap.quiz) ? snap.quiz : [];
    if (Array.isArray(snap.setBank)) {
      s.setBank = new Map(snap.setBank.filter((q) => q && q.id).map((q) => [q.id, q]));
    }
    s.stats = snap.stats && typeof snap.stats === 'object' ? snap.stats : {};
    s.questionLog = Array.isArray(snap.questionLog) ? snap.questionLog : [];
    s.classEvents = Array.isArray(snap.classEvents) ? snap.classEvents : [];
    s.revisionFor = new Set(Array.isArray(snap.revisionFor) ? snap.revisionFor : []);
    s.startedAt = snap.startedAt ?? null;
    s.endedAt = snap.endedAt ?? null;
    s.pausedRemaining = snap.pausedRemaining ?? null;
    s.phaseEndsAt = snap.phaseEndsAt ?? null;
    s.overallEndsAt = snap.overallEndsAt ?? null;
    s.currentPaced = snap.currentPaced ?? (snap.config?.timerOn === false);
    s.lastFacts = snap.lastFacts || s.lastFacts;
    s.players = new Map((Array.isArray(snap.players) ? snap.players : []).map((p) => [
      p.id,
      {
        ...p,
        seen: new Set(p.seen || []),
        socketId: null,
        status: p.status === 'attempting' ? 'disconnected' : (p.status || 'disconnected'),
      },
    ]));

    // re-arm whatever clock was running when the server went down
    if (s.status === 'running' && s.phase === 'question' && snap.timer) {
      const remaining = snap.timer.endsAt - Date.now();
      s.timer = { duration: snap.timer.duration, endsAt: snap.timer.endsAt, handle: null };
      if (remaining > 0) {
        s.timer.handle = setTimeout(() => s.reveal('timeout'), remaining + 300);
      } else {
        setTimeout(() => s.reveal('timeout'), 400); // tick over while sockets resubscribe
      }
    } else if (s.status === 'running' && s.phase === 'reveal') {
      const remaining = (snap.phaseEndsAt || 0) - Date.now();
      if (remaining > 0) s.revealTimer = setTimeout(() => s.advance(), remaining);
      else setTimeout(() => s.advance(), 500);
    }

    // re-arm the optional whole-quiz countdown (self-paced quizzes)
    if (s.status === 'running' && s.overallEndsAt) {
      const remaining = s.overallEndsAt - Date.now();
      if (remaining > 0) s.overallHandle = setTimeout(() => { if (s.status === 'running') s.end(); }, remaining + 300);
      else setTimeout(() => { if (s.status === 'running') s.end(); }, 400);
    }
    return s;
  }

  // ---------- question timer ----------
  /** The teacher's switch: ON = shared countdown, OFF = students pace themselves. */
  timerOn() {
    return this.config.timerOn !== false;
  }

  selfPaced() {
    return !this.timerOn();
  }

  /** The question one specific player is on (they can be on different ones). */
  playerQuestion(player) {
    const e = this.quiz[player?.currentQ];
    return e ? this.bankQuestion(e.id) : null;
  }

  // ---------- players ----------
  join({ nickname, team, socketId }) {
    const clean = String(nickname || '').trim().slice(0, 18) || 'Coder';
    const player = {
      id: uid(),
      socketId,
      nickname: clean,
      team: team ? String(team).trim().slice(0, 18) : null,
      score: 0,
      correct: 0,
      wrong: 0,
      skipped: 0,
      streak: 0,
      bestStreak: 0,
      totalTime: 0,
      powerupsUsed: [],
      answered: {},        // qIndex -> {correct, timeMs, earned}
      events: [],
      badges: [],
      seen: new Set(),
      currentQ: 0,
      status: 'attempting',
      lastSeen: Date.now(),
      personalGrace: 0,
      hintUsed: false,
      removed: [],         // option ids removed by 50-50
      hasAnswered: false,
      finished: false,
      finishedAt: null,
      questionStartedAt: Date.now(),
    };
    this.players.set(player.id, player);
    this.persist();
    return player;
  }

  removePlayer(id) {
    const p = this.players.get(id);
    if (p) p.status = 'disconnected';
    this.persist();
    this.broadcastRoster();
  }

  touch(id) {
    const p = this.players.get(id);
    if (p) {
      p.lastSeen = Date.now();
      if (p.status !== 'attempting') {
        p.status = 'attempting';
        this.broadcastRoster();
      }
    }
  }

  bySocket(socketId) {
    return [...this.players.values()].find((p) => p.socketId === socketId);
  }

  // ---------- lifecycle ----------
  bankQuestions() {
    const sid = this.config.setId;
    if (sid === 'default') return loadBank({ owner: this.config.ownerId, scope: 'default' }).questions;
    if (sid) return [...(this.ensureSetBank() || new Map()).values()];
    return loadBank({ owner: this.config.ownerId }).questions;
  }

  /** This quiz's own questions, read fresh from its set file on first use. */
  ensureSetBank() {
    const sid = this.config.setId;
    if (!sid || sid === 'default') return this.setBank;
    if (!this.setBank) {
      const loaded = loadSetQuestions(this.config.ownerId, sid);
      this.setBank = new Map((loaded?.questions || []).map((q) => [q.id, q]));
    }
    return this.setBank;
  }

  /** Unit label for every screen: the set's own names first, then the syllabus. */
  unitLabel(u) {
    const names = this.config.unitNames;
    return (names && names[u]) || baseUnitName(u);
  }

  bankQuestion(id) {
    return this.bankQuestions().find((q) => q.id === id) || null;
  }

  start() {
    if (this.status !== 'lobby' && this.status !== 'ended') return false;
    this.ensureSetBank();  // a set quiz always (re)loads its own file here
    if (!this.config.setId && this.config.questionIds.length) {
      // quiz built from an explicit id list: exactly these questions, in this order
      const byId = new Map(this.bankQuestions().map((q) => [q.id, q]));
      this.quiz = this.config.questionIds
        .map((id) => byId.get(id))
        .filter(Boolean)
        .map((q) => ({ id: q.id, refresher: false, unit: q.unit, difficulty: q.difficulty, boss: q.boss }));
    } else {
      this.quiz = buildQuiz({
        bank: this.bankQuestions(),
        units: this.config.units,
        count: this.config.count,
        difficulty: this.config.difficulty,
        seed: this.seed,
      }).map((q) => ({ id: q.id, refresher: false, unit: q.unit, difficulty: q.difficulty, boss: q.boss }));
    }

    this.status = 'running';
    this.startedAt = Date.now();
    this.qIndex = -1;
    this.stats = {};
    this.questionLog = [];
    this.armOverallTimer();
    this.advance();
    return true;
  }

  currentEntry() {
    return this.quiz[this.qIndex] || null;
  }

  currentQuestion() {
    const e = this.currentEntry();
    return e ? this.bankQuestion(e.id) : null;
  }

  /** One stats bucket + log entry per question index (created the first time). */
  ensureQuestionRecord(idx, q, e) {
    if (!this.stats[idx]) {
      this.stats[idx] = { counts: {}, correct: 0, wrong: 0, times: [], answered: 0, skipped: 0 };
    }
    if (!this.questionLog.some((x) => x.index === idx)) {
      this.questionLog.push({
        index: idx, id: q.id, unit: q.unit, type: q.type,
        difficulty: q.difficulty, boss: q.boss, refresher: !!e.refresher, prompt: q.prompt,
      });
    }
  }

  /** Insert a class revision round when the class crosses into a new level. */
  maybeRefreshers() {
    const entry = this.quiz[this.qIndex + 1];
    if (entry && this.config.revisionRounds && this.qIndex >= 0) {
      const prev = this.quiz[this.qIndex];
      if (prev && entry.unit !== prev.unit && !this.revisionFor.has(entry.unit) && this.quiz.length >= 6) {
        const picks = this.pickClassRefreshers(entry.unit);
        if (picks.length) {
          this.quiz.splice(this.qIndex + 1, 0, ...picks.map((q) => ({
            id: q.id, refresher: true, unit: q.unit, difficulty: q.difficulty, boss: false,
          })));
          this.revisionFor.add(entry.unit);
        }
      }
    }
  }

  advance() {
    this.clearTimers();
    this.maybeRefreshers();

    this.qIndex++;
    if (this.qIndex >= this.quiz.length) return this.end();

    const e = this.quiz[this.qIndex];
    const q = this.bankQuestion(e.id);
    if (!q) return this.end();  // question vanished from the bank mid-session
    this.ensureQuestionRecord(this.qIndex, q, e);

    if (this.selfPaced()) {
      // timer off: everyone gets the same starting question, then runs free
      this.presentAllSelfPaced();
      return;
    }

    const duration = timerFor(q, this.config.timers, this.config.commonSeconds) * 1000;
    this.phase = 'question';
    this.currentPaced = false;
    this.timer = { duration, endsAt: Date.now() + duration };

    for (const p of this.players.values()) {
      p.hasAnswered = false;
      p.hintUsed = false;
      p.removed = [];
      p.currentQ = this.qIndex;
      p.questionStartedAt = Date.now();
      p.status = 'attempting';
      p.lastSeen = Date.now();
      p.seen.add(q.id);
    }

    this.emitQuestion({
      qIndex: this.qIndex, total: this.quiz.length, refresher: e.refresher,
      unit: q.unit, boss: q.boss, unitLabel: this.unitLabel(q.unit),
      duration, endsAt: this.timer.endsAt,
      selfPaced: false, quizEndsAt: this.overallEndsAt,
    });

    this.timer.handle = setTimeout(() => this.reveal('timeout'), duration + 300);
    this.broadcastRoster();
    this.emitAll('phase', { phase: this.phase, qIndex: this.qIndex, endsAt: this.timer.endsAt });
    this.persist();
  }

  /** Each player sees the same question but with their own option order. */
  emitQuestion(meta) {
    const q = this.currentQuestion();
    if (!q) return;
    const players = [...this.players.values()];
    if (!players.length) {
      this.emitAll('question:start', { ...meta, question: publicQuestion(q) });
      return;
    }
    for (const p of players) {
      const shuffled = this.config.shuffleOptions ? shuffleOptions(q, `${this.seed}:${p.id}`) : q;
      this.io.to(p.socketId).emit('question:start', { ...meta, question: publicQuestion(shuffled), playerId: p.id });
    }
    this.io.to(this.teacherRoom).emit('question:start', { ...meta, question: publicQuestion(q) });
  }

  // ---------- self-paced (timer off) ----------
  /** Payload for one player's own question: no countdown, navigation flags. */
  pacedPayload(player, idx, q, e) {
    const shuffled = this.config.shuffleOptions ? shuffleOptions(q, `${this.seed}:${player.id}`) : q;
    const rec = player.answered[idx] || null;
    return {
      qIndex: idx, total: this.quiz.length, refresher: !!e.refresher, unit: q.unit, boss: q.boss,
      unitLabel: this.unitLabel(q.unit),
      question: publicQuestion(shuffled),
      playerId: player.id,
      selfPaced: true,
      duration: null,
      endsAt: null,
      quizEndsAt: this.overallEndsAt,
      allowBack: this.config.allowBack,
      allowSkip: this.config.allowSkip,
      // only set when the student already answered this one (review / resync)
      review: rec ? {
        correct: !!rec.correct,
        yourAnswer: rec.answer ?? null,
        correctAnswer: q.answer ?? q.accepted ?? null,
        accepted: q.accepted || null,
        pairs: q.pairs || null,
      } : null,
    };
  }

  /** Hand one player their question at `idx` (fresh, or as a read-only review). */
  presentTo(player, idx, { review = false } = {}) {
    const e = this.quiz[idx];
    const q = e ? this.bankQuestion(e.id) : null;
    if (!q || !player || player.finished) return false;
    player.currentQ = idx;
    if (!review) {
      player.hasAnswered = false;
      player.hintUsed = false;
      player.removed = [];
      player.questionStartedAt = Date.now();
      player.status = 'attempting';
      player.lastSeen = Date.now();
      player.seen.add(q.id);
    } else {
      player.hasAnswered = true;
    }
    this.io.to(player.socketId).emit('question:start', this.pacedPayload(player, idx, q, e));
    return true;
  }

  /** Called when the class frontier lands on a new question (start / flip to off). */
  presentAllSelfPaced() {
    const e = this.quiz[this.qIndex];
    const q = e ? this.bankQuestion(e.id) : null;
    if (!q) return this.end();
    this.phase = 'question';
    this.currentPaced = true;
    this.timer = null;
    this.emitTeacherQuestion();
    for (const p of this.players.values()) {
      if (p.finished) continue;
      this.presentTo(p, this.qIndex, { review: !!p.answered[this.qIndex] });
    }
    this.broadcastRoster();
    this.broadcastQuestionStats();
    this.emitAll('phase', { phase: this.phase, qIndex: this.qIndex, endsAt: null, selfPaced: true });
    this.persist();
  }

  /** One copy of the current question for the teacher's dashboard. */
  emitTeacherQuestion() {
    const q = this.currentQuestion();
    if (!q) return;
    const e = this.currentEntry();
    this.io.to(this.teacherRoom).emit('question:start', {
      qIndex: this.qIndex, total: this.quiz.length, refresher: !!e?.refresher,
      unit: q.unit, boss: q.boss, unitLabel: this.unitLabel(q.unit),
      duration: this.timer?.duration ?? null, endsAt: this.timer?.endsAt ?? null,
      question: publicQuestion(q),
      selfPaced: this.currentPaced,
      quizEndsAt: this.overallEndsAt,
    });
  }

  /** Next unanswered question after `from`, wrapping to earlier skips; null = done. */
  nextUnansweredFor(player, from) {
    const total = this.quiz.length;
    for (let i = from + 1; i < total; i++) if (!player.answered[i]) return i;
    for (let i = 0; i < from; i++) if (!player.answered[i]) return i;
    return null;
  }

  /** The leading player stepped onto a new question: grow the shared frontier. */
  growFrontier(target) {
    while (this.qIndex < target) {
      this.maybeRefreshers();
      this.qIndex++;
      const e = this.quiz[this.qIndex];
      if (!e) break;
      const q = this.bankQuestion(e.id);
      if (q) this.ensureQuestionRecord(this.qIndex, q, e);
    }
    const q = this.currentQuestion();
    if (q) this.emitTeacherQuestion();
  }

  /** Student taps Next (or Skip): move at their own pace, maybe finish. */
  playerAdvance(player, { skip = false } = {}) {
    if (this.status !== 'running') return { error: 'The quiz is not running right now.' };
    if (!this.currentPaced) return { error: 'The teacher is running this question for the whole class.' };
    if (this.phase !== 'question') return { error: 'Not right now.' };
    if (!player) return { error: 'Unknown player.' };
    if (player.finished) return { error: 'You have finished this quiz.' };

    const cur = player.currentQ;
    const rec = player.answered[cur];
    if (!rec) {
      if (!skip) return { error: 'Answer this question first.' };
      if (!this.config.allowSkip) return { error: 'Skipping is turned off for this quiz.' };
      player.skipped++;
      if (this.stats[cur]) this.stats[cur].skipped++;
      this.broadcastQuestionStats();
    }

    const target = this.nextUnansweredFor(player, cur);
    if (target === null) return this.finishPlayer(player);
    if (target > this.qIndex) this.growFrontier(target);
    this.presentTo(player, target);
    this.broadcastRoster();
    this.persist();
    return { ok: true, qIndex: target, total: this.quiz.length };
  }

  /** Student taps Back: revisit an earlier question (read-only once answered). */
  gotoPlayer(player, qIndex) {
    if (this.status !== 'running') return { error: 'The quiz is not running right now.' };
    if (!this.currentPaced) return { error: 'Going back is only for self-paced quizzes.' };
    if (this.phase !== 'question') return { error: 'Not right now.' };
    if (!player) return { error: 'Unknown player.' };
    if (player.finished) return { error: 'You have finished this quiz.' };
    if (!this.config.allowBack) return { error: 'Going back is turned off for this quiz.' };
    const idx = Number(qIndex);
    if (!Number.isInteger(idx) || idx < 0 || idx >= this.quiz.length) return { error: 'No such question.' };
    if (idx >= player.currentQ) return { error: 'You can only go back to earlier questions.' };
    const review = !!player.answered[idx];
    this.presentTo(player, idx, { review });
    this.broadcastRoster();
    this.persist();
    return { ok: true, qIndex: idx, review };
  }

  finishPlayer(player) {
    if (!player) return { error: 'Unknown player.' };
    if (!player.finished) {
      player.finished = true;
      player.finishedAt = Date.now();
      const before = new Set(player.badges);
      player.badges = evaluateBadges(player.events, { finished: true });
      player.newBadges = player.badges.filter((b) => !before.has(b));
      this.toPlayer(player, 'player:finished', {
        score: player.score, correct: player.correct, wrong: player.wrong,
        answered: Object.keys(player.answered).length, total: this.quiz.length,
        badges: (player.newBadges || []).map(badgeById),
      });
      this.broadcastRoster();
      this.broadcastLeaderboard();
      this.persist();
    }
    return { ok: true, finished: true, score: player.score };
  }

  /** The whole-quiz countdown (self-paced option: a single limit, not per question). */
  armOverallTimer(remainingMs = null) {
    this.clearOverallTimer();
    if (!this.config.quizSeconds || this.status !== 'running') return;
    const ms = remainingMs != null ? Math.max(1000, remainingMs) : this.config.quizSeconds * 1000;
    this.overallEndsAt = Date.now() + ms;
    this.overallHandle = setTimeout(() => { if (this.status === 'running') this.end(); }, ms + 300);
  }

  clearOverallTimer() {
    if (this.overallHandle) clearTimeout(this.overallHandle);
    this.overallHandle = null;
  }

  /**
   * Flip the teacher's Question Timer switch (lobby or mid-run).
   * Off during a running shared question: that question keeps its clock and
   * the next one starts self-paced. On during a self-paced run: the class
   * re-syncs on the furthest question with a fresh countdown.
   */
  setTimerOn(on) {
    const want = on !== false;
    if (want === this.timerOn()) return { ok: true, timerOn: want, unchanged: true };
    if (this.status === 'paused') return { error: 'Resume the quiz before switching the timer.' };
    if (this.status === 'ended') return { error: 'That quiz has already finished.' };

    // lobby / reveal / between phases: nothing mid-question to protect
    if (this.status === 'lobby' || this.phase === 'reveal' || this.phase === 'ended') {
      this.config.timerOn = want;
      this.persist();
      this.emitAll('control', { action: 'timer-changed', timerOn: want });
      return { ok: true, timerOn: want, effective: this.status === 'lobby' ? 'now' : 'next question' };
    }

    if (!want) {
      // running shared question: it keeps its clock; the switch bites from the next one
      this.config.timerOn = false;
      this.persist();
      this.emitAll('control', { action: 'timer-changed', timerOn: false, effective: 'next question' });
      return { ok: true, timerOn: false, effective: 'next question' };
    }

    if (!this.currentPaced) {
      // already a shared question on screen (was flipped off mid-run, now back on)
      this.config.timerOn = true;
      this.persist();
      this.emitAll('control', { action: 'timer-changed', timerOn: true, effective: 'now' });
      return { ok: true, timerOn: true, effective: 'now' };
    }
    return this.resumeLockstep();
  }

  /** Self-paced -> lockstep: re-sync everyone on the furthest question. */
  resumeLockstep() {
    const unfinished = [...this.players.values()].filter((p) => !p.finished);
    if (!unfinished.length) {
      this.config.timerOn = true;
      this.end();
      return { ok: true, timerOn: true, ended: true };
    }
    this.config.timerOn = true;
    const frontier = Math.max(this.qIndex, ...unfinished.map((p) => p.currentQ));
    this.qIndex = Math.max(0, Math.min(frontier, this.quiz.length - 1));
    const e = this.quiz[this.qIndex];
    const q = e ? this.bankQuestion(e.id) : null;
    if (!q) { this.end(); return { ok: true, timerOn: true, ended: true }; }

    this.clearTimers();
    this.phase = 'question';
    this.currentPaced = false;
    this.ensureQuestionRecord(this.qIndex, q, e);
    const duration = timerFor(q, this.config.timers, this.config.commonSeconds) * 1000;
    this.timer = { duration, endsAt: Date.now() + duration };
    const meta = {
      qIndex: this.qIndex, total: this.quiz.length, refresher: !!e.refresher,
      unit: q.unit, boss: q.boss, unitLabel: this.unitLabel(q.unit),
      duration, endsAt: this.timer.endsAt,
      selfPaced: false, quizEndsAt: this.overallEndsAt,
    };

    for (const p of this.players.values()) {
      if (p.finished) continue;
      p.currentQ = this.qIndex;
      p.lastSeen = Date.now();
      const shuffled = this.config.shuffleOptions ? shuffleOptions(q, `${this.seed}:${p.id}`) : q;
      if (p.answered[this.qIndex]) {
        p.hasAnswered = true; // done already - just wait for the reveal
        const rec = p.answered[this.qIndex];
        this.io.to(p.socketId).emit('question:start', {
          ...meta, question: publicQuestion(shuffled), playerId: p.id,
          review: {
            correct: !!rec.correct, yourAnswer: rec.answer ?? null,
            correctAnswer: q.answer ?? q.accepted ?? null,
            accepted: q.accepted || null, pairs: q.pairs || null,
          },
        });
        continue;
      }
      p.hasAnswered = false;
      p.hintUsed = false;
      p.removed = [];
      p.questionStartedAt = Date.now();
      p.status = 'attempting';
      p.seen.add(q.id);
      this.io.to(p.socketId).emit('question:start', { ...meta, question: publicQuestion(shuffled), playerId: p.id });
    }
    this.io.to(this.teacherRoom).emit('question:start', { ...meta, question: publicQuestion(q) });

    this.timer.handle = setTimeout(() => this.reveal('timeout'), duration + 300);
    this.broadcastRoster();
    this.broadcastQuestionStats();
    this.emitAll('phase', { phase: this.phase, qIndex: this.qIndex, endsAt: this.timer.endsAt });
    this.emitAll('control', { action: 'timer-changed', timerOn: true, effective: 'now' });
    this.persist();
    return { ok: true, timerOn: true, effective: 'now' };
  }

  nextFact() {
    if (!this.config.useFacts) return null;
    const facts = getFacts();
    const kinds = [];
    if (facts.bugs?.length) kinds.push('bugs');
    if (facts.didYouKnow?.length) kinds.push('didYouKnow');
    if (!kinds.length) return null;
    const kind = kinds[Math.floor(Math.random() * kinds.length)];
    const list = facts[kind];
    if (list.length === 1) return { kind, text: list[0] };
    let pick = list[Math.floor(Math.random() * list.length)];
    const bucket = this.lastFacts[kind] || [];
    let guardCount = 0;
    while (bucket.includes(pick) && guardCount++ < 10) {
      pick = list[Math.floor(Math.random() * list.length)];
    }
    this.lastFacts[kind] = [...bucket, pick].slice(-3);
    return { kind, text: pick };
  }

  reveal(reason = 'all-answered') {
    if (this.phase !== 'question') return;
    if (this.currentPaced) return; // timer off: no shared reveal, everyone reviews on their own clock
    this.clearTimers();
    this.phase = 'reveal';

    const q = this.currentQuestion();
    const st = this.stats[this.qIndex];
    const now = Date.now();

    // anyone still open gets a timed-out result
    for (const p of this.players.values()) {
      if (!p.hasAnswered) {
        const res = scoreAnswer({ difficulty: q.difficulty, boss: q.boss, correct: false, timedOut: true, streak: p.streak, timeLeftFraction: 0, points: this.config.points });
        this.recordAnswer(p, q, { correct: false, timedOut: true, earned: res.earned, timeMs: 0, breakdown: res.breakdown }, res);
        this.sendResult(p, q, { correct: false, timedOut: true, earned: res.earned, breakdown: res.breakdown });
        st.wrong++;
        st.answered++;
      }
    }

    this.phaseEndsAt = Date.now() + this.config.revealSeconds * 1000;
    this.emitAll('question:reveal', {
      qIndex: this.qIndex,
      reason,
      correctAnswer: q.answer ?? q.accepted ?? null,
      accepted: q.accepted || null,
      pairs: q.pairs || null,
      stats: { ...st },
      distribution: st.counts,
      explanation: q.explanation,
      analogy: q.analogy,
      mini: q.mini,
      fact: this.nextFact(),
      endsAt: this.phaseEndsAt,
    });
    this.emitAll('phase', { phase: this.phase, qIndex: this.qIndex, endsAt: this.phaseEndsAt });
    this.broadcastLeaderboard();
    this.broadcastRoster();
    this.broadcastQuestionStats();

    if (this.status === 'running') {
      this.revealTimer = setTimeout(() => this.advance(), this.config.revealSeconds * 1000);
    }
    this.persist();
  }

  next() {
    if (this.phase === 'question' && this.currentPaced) return false; // students drive themselves
    if (this.phase === 'question') this.reveal('teacher-skip');
    else if (this.phase === 'reveal') this.advance();
    return true;
  }

  togglePause() {
    if (this.status === 'running') {
      // work out what is left BEFORE the timers are torn down
      const remaining = this.phase === 'question'
        ? Math.max(0, (this.timer?.endsAt || Date.now()) - Date.now())
        : Math.max(0, (this.phaseEndsAt || Date.now()) - Date.now());
      this.status = 'paused';
      this.pausedAt = Date.now();
      if (this.overallEndsAt) this.overallPausedRemaining = Math.max(0, this.overallEndsAt - Date.now());
      this.clearOverallTimer();
      this.clearTimers();
      this.pausedRemaining = remaining;
      this.emitAll('control', { action: 'pause', remaining });
      this.persist();
      return true;
    }
    if (this.status === 'paused') {
      this.status = 'running';
      const remaining = this.pausedRemaining ?? 5000;
      if (this.config.quizSeconds && this.overallPausedRemaining != null) {
        this.armOverallTimer(this.overallPausedRemaining);
        this.overallPausedRemaining = null;
      }
      if (this.currentPaced) {
        // no shared clock to rebuild: give everyone back the paused time
        const pausedFor = this.pausedAt ? Date.now() - this.pausedAt : 0;
        if (pausedFor > 0) {
          for (const p of this.players.values()) {
            if (!p.finished && p.questionStartedAt) p.questionStartedAt += pausedFor;
          }
        }
        this.pausedAt = null;
        this.emitAll('control', { action: 'resume' });
        this.persist();
        return true;
      }
      if (this.phase === 'question') {
        // clearTimers() dropped the timer, so rebuild it from what we saved
        this.timer = {
          duration: remaining,
          endsAt: Date.now() + remaining,
          handle: setTimeout(() => this.reveal('timeout'), remaining + 300),
        };
        this.emitAll('question:sync', { endsAt: this.timer.endsAt });
      } else if (this.phase === 'reveal') {
        this.phaseEndsAt = Date.now() + remaining;
        this.revealTimer = setTimeout(() => this.advance(), remaining);
      }
      this.emitAll('control', { action: 'resume' });
      this.persist();
      return true;
    }
    return false;
  }

  extend(seconds = EXTEND_SECONDS) {
    if (this.phase !== 'question' || !this.timer) return false;
    const ms = seconds * 1000;
    this.timer.endsAt += ms;
    this.timer.duration += ms;
    if (this.timer.handle) {
      clearTimeout(this.timer.handle);
      this.timer.handle = setTimeout(() => this.reveal('timeout'), ms + (this.timer.endsAt - Date.now()));
    }
    this.emitAll('question:sync', { endsAt: this.timer.endsAt, extended: ms });
    this.persist();
    return true;
  }

  toggleLeaderboard(show) {
    this.config.leaderboardToStudents = show !== false;
    this.emitAll('control', { action: show ? 'show-leaderboard' : 'hide-leaderboard' });
    this.broadcastLeaderboard();
  }

  end() {
    this.clearTimers();
    this.clearOverallTimer();
    this.status = 'ended';
    this.phase = 'ended';
    this.endedAt = Date.now();
    const report = this.buildReport();
    // keep it: history, print page and CSV re-export all read this file
    try {
      saveReport(this.config.ownerId, report);
    } catch (e) {
      console.warn(`[reports] could not save ${this.code}: ${e.message}`);
    }
    this.unpersist(); // the finished report is the record now, not a live snapshot
    this.emitAll('quiz:end', { report });
    this.emitAll('phase', { phase: 'ended' });
    return report;
  }

  clearTimers() {
    if (this.timer?.handle) clearTimeout(this.timer.handle);
    if (this.revealTimer) clearTimeout(this.revealTimer);
    this.timer = null;
    this.revealTimer = null;
  }

  // ---------- answering ----------
  answer(player, payload) {
    if (this.status !== 'running') return { error: 'The quiz is not running right now.' };
    if (this.phase !== 'question') return { error: 'The question has closed.' };
    if (!player) return { error: 'Unknown player.' };
    if (player.finished) return { error: 'You have finished this quiz.' };

    const paced = this.currentPaced;
    const idx = paced ? player.currentQ : this.qIndex;
    if (payload.qIndex !== idx) return { error: 'That question has already moved on.' };
    if (player.hasAnswered) return { error: 'Already answered this one.' };

    const q = paced ? this.playerQuestion(player) : this.currentQuestion();
    const e = paced ? this.quiz[idx] : this.currentEntry();
    if (!q) return { error: 'That question has already moved on.' };

    const now = Date.now();
    let timedOut = false;
    let timeMs = 0;
    let timeLeftFraction = 0;
    if (paced) {
      // self-paced: no countdown - just record how long they took
      timeMs = Math.max(0, now - (player.questionStartedAt || now));
    } else {
      const deadline = (this.timer?.endsAt || 0) + player.personalGrace;
      timedOut = now > deadline + 400;
      const duration = this.timer?.duration || 1;
      const remaining = this.timer ? Math.max(0, this.timer.endsAt - now) : 0;
      timeMs = Math.round(Math.max(0, Math.min(duration, duration - remaining)));
      timeLeftFraction = timedOut ? 0 : Math.max(0, Math.min(1, remaining / duration));
    }

    const judged = judge(q, payload.answer, player);

    const res = scoreAnswer({
      difficulty: q.difficulty,
      boss: q.boss,
      correct: judged.correct,
      timeLeftFraction,
      streak: player.streak,
      refresher: !!e?.refresher,
      usedPowerups: player.powerupsUsed.filter((p) => p.qIndex === idx).map((p) => p.kind),
      matchCorrect: judged.matchCorrect,
      matchTotal: judged.matchTotal,
      timedOut,
      points: this.config.points,
    });

    const record = { correct: judged.correct, timedOut, earned: res.earned, timeMs, breakdown: res.breakdown, answer: judged.given };
    this.recordAnswer(player, q, record, res, e, idx);

    this.ensureQuestionRecord(idx, q, e);
    const st = this.stats[idx];
    st.answered++;
    st.times.push(timeMs);
    if (judged.correct) st.correct++;
    else st.wrong++;
    if (judged.given != null && !judged.correct) {
      const key = String(judged.given);
      st.counts[key] = (st.counts[key] || 0) + 1;
    }

    this.broadcastLeaderboard();
    this.broadcastQuestionStats();
    this.broadcastRoster();

    // auto-reveal once everybody has answered (lockstep only - paced students review alone)
    if (!paced) {
      const active = [...this.players.values()].filter((p) => p.status !== 'disconnected');
      if (active.length && active.every((p) => p.hasAnswered)) {
        setTimeout(() => this.reveal('all-answered'), 600);
      }
    }

    this.persist();
    return { result: this.buildResult(player, q, { ...judged, ...record }, res, !!e?.refresher, idx) };
  }

  recordAnswer(player, q, record, res, entry = null, idx = this.qIndex) {
    player.hasAnswered = true;
    player.totalTime += record.timeMs;
    player.answered[idx] = record;
    if (record.correct) {
      player.correct++;
      player.streak++;
      player.bestStreak = Math.max(player.bestStreak, player.streak);
    } else {
      player.wrong++;
      if (!record.correct) player.streak = 0;
    }
    player.score += record.earned;

    player.events.push({
      id: q.id, unit: q.unit, type: q.type, difficulty: q.difficulty, boss: q.boss,
      correct: record.correct, refresher: entry?.refresher,
      qIndex: idx,
      timeMs: record.timeMs,
      timeLeftFraction: record.timeMs && this.timer ? Math.max(0, (this.timer.endsAt - Date.now()) / this.timer.duration) : 0,
      streak: player.streak,
      miniPresented: !record.correct,
      miniCorrect: false,
      usedPowerups: player.powerupsUsed.filter((p) => p.qIndex === idx).map((p) => p.kind),
    });

    this.classEvents.push({ id: q.id, unit: q.unit, correct: record.correct, refresher: entry?.refresher, type: q.type });

    const before = new Set(player.badges);
    player.badges = evaluateBadges(player.events);
    player.newBadges = player.badges.filter((b) => !before.has(b));
  }

  usePowerup(player, kind) {
    if (this.status !== 'running' || this.phase !== 'question') return { error: 'Not right now.' };
    if (player.hasAnswered || player.finished) return { error: 'Already answered.' };
    if (kind === 'hint' && !this.config.allowHints) return { error: 'Hints are turned off for this quiz.' };
    if (kind !== 'hint' && !this.config.allowPowerups) return { error: 'Power-ups are turned off for this quiz.' };
    const paced = this.currentPaced;
    const idx = paced ? player.currentQ : this.qIndex;
    const already = player.powerupsUsed.some((p) => p.qIndex === idx && p.kind === kind);
    if (already) return { error: 'Already used that this question.' };
    const q = paced ? this.playerQuestion(player) : this.currentQuestion();
    if (!q) return { error: 'Not right now.' };

    if (kind === 'hint') {
      if (!q.hint) return { error: 'No hint for this one.' };
      player.hintUsed = true;
      player.powerupsUsed.push({ qIndex: idx, kind });
      this.persist();
      return { ok: true, cost: 15, hint: q.hint };
    }
    if (kind === 'fifty') {
      if (!q.options || q.answer?.length !== 1) return { error: 'Not available here.' };
      const wrong = q.options.filter((o) => !q.answer.includes(o.id)).map((o) => o.id);
      const shuffled = [...wrong].sort(() => Math.random() - 0.5).slice(0, 2);
      player.removed = shuffled;
      player.powerupsUsed.push({ qIndex: idx, kind });
      this.persist();
      return { ok: true, cost: 10, remove: shuffled };
    }
    if (kind === 'extraTime') {
      if (paced) return { error: 'There is no countdown on this question.' };
      player.personalGrace += EXTEND_SECONDS * 1000;
      player.powerupsUsed.push({ qIndex: idx, kind });
      this.persist();
      return { ok: true, cost: 10, extraMs: EXTEND_SECONDS * 1000 };
    }
    if (kind === 'skip') {
      if (!player.powerupsUsed.some((p) => p.qIndex === idx && p.kind === 'skip')) {
        player.powerupsUsed.push({ qIndex: idx, kind: 'skip' });
      }
      this.persist();
      return { ok: true, cost: 0, skipped: true };
    }
    return { error: 'Unknown power-up.' };
  }

  buildResult(player, q, judged, res, refresher, idx = this.qIndex) {
    const entryCount = player.events.length;
    return {
      qIndex: idx,
      correct: judged.correct,
      timedOut: !!judged.timedOut,
      earned: res.earned,
      breakdown: res.breakdown,
      correctAnswer: q.answer ?? null,
      accepted: q.accepted ?? null,
      pairs: q.pairs ?? null,
      yourAnswer: judged.given,
      explanation: q.explanation,
      analogy: q.analogy,
      mini: judged.correct ? null : q.mini,
      encouragement: judged.correct ? null : ENCOURAGEMENTS[entryCount % ENCOURAGEMENTS.length],
      streak: player.streak,
      score: player.score,
      badges: (player.newBadges || []).map(badgeById),
      refresher: !!refresher,
      hintUsed: player.hintUsed,
    };
  }

  sendResult(player, q, partial) {
    const e = this.currentEntry();
    const payload = {
      qIndex: this.qIndex,
      correct: partial.correct,
      timedOut: !!partial.timedOut,
      earned: partial.earned,
      breakdown: partial.breakdown || [],
      correctAnswer: q.answer ?? null,
      accepted: q.accepted ?? null,
      pairs: q.pairs ?? null,
      explanation: q.explanation,
      analogy: q.analogy,
      mini: partial.correct ? null : q.mini,
      encouragement: partial.correct ? null : 'Almost! Here is the why.',
      streak: player.streak,
      score: player.score,
      badges: (player.newBadges || []).map(badgeById),
      refresher: !!e?.refresher,
    };
    this.toPlayer(player, 'answer:accepted', payload);
  }

  // ---------- class revision round ----------
  pickClassRefreshers(nextUnit) {
    const bank = this.bankQuestions();
    const inQuiz = new Set(this.quiz.map((q) => q.id));
    const limit = MAX_REFRESHERS_PER_LEVEL;
    const out = [];

    // 1) questions the class actually missed most (earlier levels only)
    const wrongCount = {};
    for (const ev of this.classEvents) {
      if (ev.refresher || ev.correct) continue;
      const q = bank.find((x) => x.id === ev.id);
      if (q && q.unit < nextUnit && !q.boss) wrongCount[ev.id] = (wrongCount[ev.id] || 0) + 1;
    }
    for (const id of Object.entries(wrongCount).sort((a, b) => b[1] - a[1]).map(([id]) => id)) {
      if (out.length >= limit) break;
      const q = bank.find((x) => x.id === id);
      if (q) out.push(q);
    }

    // 2) class-weak units (<60%)
    if (out.length < limit) {
      const stats = this.classUnitStats();
      const weak = Object.entries(stats)
        .filter(([u, s]) => Number(u) < nextUnit && s.total >= 3 && s.accuracy < 0.6)
        .map(([u]) => Number(u));
      const cands = bank.filter(
        (q) => !q.boss && weak.includes(q.unit) && !out.some((o) => o.id === q.id)
      );
      const rng = [...cands].sort(() => Math.random() - 0.5);
      for (const q of rng) {
        if (out.length >= limit) break;
        out.push(q);
      }
    }

    // 3) anything fresh and unseen
    if (out.length < limit) {
      const seenEvents = new Set(this.classEvents.map((e) => e.id));
      const fresh = bank.filter(
        (q) => !q.boss && !inQuiz.has(q.id) && !seenEvents.has(q.id) && !out.some((o) => o.id === q.id)
      );
      for (const q of [...fresh].sort(() => Math.random() - 0.5)) {
        if (out.length >= limit) break;
        out.push(q);
      }
    }

    return out;
  }

  // ---------- broadcasts ----------
  emitAll(event, payload) {
    this.io.to(this.room).emit(event, payload);
  }

  toPlayer(player, event, payload) {
    this.io.to(this.room).emit(event, { ...payload, playerId: player.id });
  }

  roomOf() {
    return `session:${this.code}`;
  }

  ranked() {
    const cmp = this.currentPaced ? comparePlayersSelfPaced : comparePlayers;
    return [...this.players.values()]
      .filter((p) => p.status !== 'disconnected')
      .sort(cmp)
      .map((p, i) => ({ ...p, rank: i + 1 }));
  }

  leaderboardPayload(forPlayer = null) {
    const ranked = this.ranked();
    const entries = ranked.map((p) => ({
      id: p.id, nickname: p.nickname, team: p.team, score: p.score,
      rank: p.rank, correct: p.correct, wrong: p.wrong, streak: p.streak,
      badges: p.badges.length, me: forPlayer ? p.id === forPlayer.id : false,
    }));

    if (this.config.teamMode) {
      const teams = {};
      for (const p of ranked) {
        const name = p.team || 'Solo';
        (teams[name] ||= []).push(p);
      }
      const teamRows = Object.entries(teams)
        .map(([name, ms]) => ({ name, ...teamSummary(ms), members: ms.map((m) => m.nickname) }))
        .sort((a, b) => b.score - a.score)
        .map((t, i) => ({ ...t, rank: i + 1 }));
      return { mode: 'team', teams: teamRows, entries, hidden: 0, visible: this.config.leaderboardToStudents };
    }

    const hide = this.config.hideBottom;
    const visible = entries.slice(0, hide > 0 && entries.length > hide + 2 ? entries.length - hide : entries.length);
    return {
      mode: 'solo',
      entries: this.config.leaderboardToStudents ? visible : [],
      hidden: this.config.leaderboardToStudents ? entries.length - visible.length : entries.length,
      visible: this.config.leaderboardToStudents,
      total: entries.length,
    };
  }

  broadcastLeaderboard() {
    this.io.to(this.room).emit('leaderboard', this.leaderboardPayload());
    this.io.to(this.teacherRoom).emit('leaderboard', this.leaderboardPayload());
  }

  rosterPayload() {
    const now = Date.now();
    const players = [...this.players.values()].map((p) => {
      const age = now - p.lastSeen;
      const status = p.status === 'disconnected' || age > IDLE_WINDOW
        ? 'disconnected'
        : age > ACTIVE_WINDOW ? 'idle' : 'attempting';
      const ranked = this.ranked().find((r) => r.id === p.id);
      return {
        id: p.id, nickname: p.nickname, team: p.team, score: p.score,
        qIndex: p.currentQ, answered: p.hasAnswered, status,
        finished: !!p.finished,
        answeredCount: Object.keys(p.answered).length,
        correct: p.correct, wrong: p.wrong, streak: p.streak,
        rank: ranked ? ranked.rank : null, badges: p.badges,
      };
    });
    return {
      players, phase: this.phase, qIndex: this.qIndex, total: this.quiz.length,
      status: this.status, selfPaced: this.currentPaced, timerOn: this.timerOn(),
    };
  }

  broadcastRoster() {
    this.io.to(this.teacherRoom).emit('roster', this.rosterPayload());
  }

  questionStatsPayload() {
    const st = this.stats[this.qIndex] || { counts: {}, correct: 0, wrong: 0, times: [], answered: 0 };
    const q = this.currentQuestion();
    const missed = Object.entries(this.stats)
      .map(([i, s]) => {
        const total = s.correct + s.wrong;
        return { index: Number(i), id: this.quiz[Number(i)]?.id, missRate: total ? s.wrong / total : 0, total };
      })
      .filter((m) => m.total >= 3 && m.missRate >= 0.4)
      .sort((a, b) => b.missRate - a.missRate);
    const unitStats = this.classUnitStats();
    return {
      qIndex: this.qIndex,
      prompt: q?.prompt,
      type: q?.type,
      counts: st.counts,
      correct: st.correct,
      wrong: st.wrong,
      answered: st.answered,
      options: q?.options || null,
      answer: q?.answer || null,
      missed: missed.slice(0, 5),
      unitStats,
      revealing: this.phase === 'reveal',
      selfPaced: this.currentPaced,
      // self-paced progress across the class
      answeredTotal: [...this.players.values()].reduce((s, p) => s + Object.keys(p.answered).length, 0),
      finishedCount: [...this.players.values()].filter((p) => p.finished).length,
      playersTotal: this.players.size,
    };
  }

  classUnitStats() {
    const out = {};
    for (const ev of this.classEvents) {
      if (ev.refresher) continue;
      const s = (out[ev.unit] ||= { correct: 0, total: 0 });
      s.total++;
      if (ev.correct) s.correct++;
    }
    for (const s of Object.values(out)) s.accuracy = s.total ? s.correct / s.total : 0;
    return out;
  }

  broadcastQuestionStats() {
    this.io.to(this.teacherRoom).emit('question:stats', this.questionStatsPayload());
  }

  // ---------- report ----------
  buildReport() {
    const players = this.ranked().map((p) => {
      const unitStats = {};
      for (const ev of p.events) {
        if (ev.refresher) continue;
        const s = (unitStats[ev.unit] ||= { correct: 0, total: 0, timeMs: 0 });
        s.total++;
        if (ev.correct) s.correct++;
      }
      for (const s of Object.values(unitStats)) s.accuracy = s.total ? s.correct / s.total : 0;
      const attempted = p.correct + p.wrong;
      const accuracy = attempted ? p.correct / attempted : 0;
      const weak = Object.entries(unitStats)
        .filter(([, s]) => s.accuracy < 0.5)
        .map(([u]) => Number(u));
      return {
        id: p.id, nickname: p.nickname, team: p.team, rank: p.rank, score: p.score,
        correct: p.correct, wrong: p.wrong, skipped: p.skipped, accuracy,
        totalTimeMs: p.totalTime, bestStreak: p.bestStreak, badges: p.badges,
        unitStats, weakUnits: weak,
        needsHelp: accuracy < 0.5 || weak.length >= 2,
        finished: !!p.finished,
        finishedAt: p.finishedAt ?? null,
        // ms spent on each question of the run (null = never attempted)
        answerTimes: this.quiz.map((_, i) => (p.answered[i] ? p.answered[i].timeMs ?? null : null)),
        log: p.events.map((e) => ({
          id: e.id, correct: e.correct, refresher: e.refresher,
          qIndex: e.qIndex ?? null, timeMs: e.timeMs ?? null,
        })),
      };
    });

    const questions = this.questionLog.map((entry) => {
      const st = this.stats[entry.index] || { correct: 0, wrong: 0, times: [] };
      const total = st.correct + st.wrong;
      return {
        ...entry,
        correct: st.correct,
        wrong: st.wrong,
        missRate: total ? st.wrong / total : 0,
        avgTimeMs: st.times.length ? Math.round(st.times.reduce((a, b) => a + b, 0) / st.times.length) : 0,
      };
    });

    const unitStats = this.classUnitStats();
    const weakUnits = Object.entries(unitStats)
      .filter(([, s]) => s.total >= 3 && s.accuracy < 0.6)
      .map(([u]) => Number(u))
      .sort((a, b) => a - b);

    return {
      code: this.code,
      title: this.config.title,
      startedAt: this.startedAt,
      endedAt: this.endedAt || Date.now(),
      config: this.config,
      players,
      questions,
      unitStats,
      weakUnits,
      struggling: questions.filter((q) => q.missRate >= 0.5).map((q) => ({ id: q.id, prompt: q.prompt, missRate: q.missRate })),
      needsHelp: players.filter((p) => p.needsHelp).map((p) => p.nickname),
      totals: {
        players: players.length,
        answers: players.reduce((s, p) => s + p.correct + p.wrong, 0),
        correct: players.reduce((s, p) => s + p.correct, 0),
        accuracy: (() => {
          const a = players.reduce((s, p) => s + p.correct, 0);
          const w = players.reduce((s, p) => s + p.wrong, 0);
          return a + w ? a / (a + w) : 0;
        })(),
      },
    };
  }
}

// ---------- answer judging ----------
export function judge(q, given, player) {
  if (given == null) return { correct: false, given: null };

  if (q.type === 'fill-blank') {
    const norm = (s) => String(s ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase();
    const ok = (q.accepted || []).some((a) => norm(a) === norm(given));
    return { correct: ok, given: String(given) };
  }

  if (q.type === 'match') {
    const map = given && typeof given === 'object' ? given : {};
    const pairs = q.pairs || [];
    const correct = pairs.filter((p, i) => map[i] === p.right).length;
    return { correct: correct === pairs.length, matchCorrect: correct, matchTotal: pairs.length, given: map };
  }

  const arr = Array.isArray(given) ? given : [given];
  const target = [...(q.answer || [])].sort();
  const got = [...arr].sort();
  const ok = target.length === got.length && target.every((t, i) => t === got[i]);
  return { correct: ok, given: got.join(',') };
}

// ---------- store ----------
export class SessionStore {
  constructor(io) {
    this.io = io;
    this.sessions = new Map();
  }

  create(config) {
    const code = makeCode(this.sessions);
    const session = new Session(code, config, this.io);
    session.room = `session:${code}`;
    session.teacherRoom = `teacher:${code}`;
    this.sessions.set(code, session);
    session.persist();
    return session;
  }

  get(code) {
    if (!code) return null;
    return this.sessions.get(String(code).toUpperCase().trim()) || null;
  }

  delete(code) {
    this.sessions.delete(code);
    dropSnapshot(code);
  }

  /** Reload snapshots written before a restart; stale or finished ones are dropped. */
  restoreAll() {
    let restored = 0;
    for (const snap of loadSnapshots()) {
      try {
        if (snap.v !== 1 || !snap.code || this.sessions.has(snap.code)) continue;
        if (snap.status === 'ended' || Date.now() - (snap.savedAt || 0) > MAX_AGE_MS) {
          dropSnapshot(snap.code);
          continue;
        }
        const session = Session.restore(snap, this.io);
        session.room = `session:${session.code}`;
        session.teacherRoom = `teacher:${session.code}`;
        this.sessions.set(session.code, session);
        restored++;
        console.log(`[sessions] restored ${session.code} (${session.status}, ${session.players.size} players)`);
      } catch (e) {
        console.warn(`[sessions] could not restore a snapshot: ${e.message}`);
        try { dropSnapshot(snap.code); } catch { /* give up on this one */ }
      }
    }
    return restored;
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      code: s.code, status: s.status, players: s.players.size, title: s.config.title, startedAt: s.startedAt,
      ownerId: s.config.ownerId || null, ownerName: s.config.ownerName || '',
    }));
  }
}
