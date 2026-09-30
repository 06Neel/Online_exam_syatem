// Practice mode engine: runs entirely on the client, same scoring rules as live.
import { scoreAnswer } from '../../../shared/scoring.js';
import { evaluateBadges, badgeById, ENCOURAGEMENTS } from '../../../shared/badges.js';
import { chooseRefreshers, timerFor, strengthMap, BAND_INFO, MAX_REFRESHERS_PER_LEVEL } from '../../../shared/quiz.js';
import { request } from '../net.js';

export class LocalEngine {
  constructor(config) {
    this.config = config;
    this.paced = config.timerOn === false; // practice question timer OFF
    this.listeners = new Map();
    this.questions = [];
    this.index = 0;
    this.finished = false;
    this.player = {
      id: 'me', nickname: 'You', score: 0, correct: 0, wrong: 0, streak: 0, bestStreak: 0,
      totalTime: 0, events: [], badges: [], powerupsUsed: [], skipped: 0,
    };
    this.roundStarted = 0;
    this.duration = 40000;
    this.hintUsed = false;
    this.removed = [];
    this.answeredThis = false;
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(cb);
    return () => this.listeners.get(event)?.delete(cb);
  }

  emit(event, payload) {
    for (const cb of this.listeners.get(event) || []) cb(payload);
  }

  async init() {
    const units = this.config.units?.length ? this.config.units : [1, 2, 3, 4, 5, 6, 7];
    const data = await request(
      `/api/practice?units=${units.join(',')}&count=${this.config.count || 12}&difficulty=${this.config.difficulty || 'mixed'}`
    );
    this.questions = data.questions;
    this.pool = data.pool || data.questions;
    return this;
  }

  get current() {
    return this.questions[this.index] || null;
  }

  get total() {
    return this.questions.length;
  }

  start() {
    this._present();
  }

  _present() {
    const q = this.current;
    if (!q) return this.end();
    this.duration = this.paced ? null : timerFor(q, {}) * 1000;
    this.roundStarted = Date.now();
    this.answeredThis = false;
    this.hintUsed = false;
    this.removed = [];
    this.usedPowerups = [];
    this.emit('question', {
      qIndex: this.index,
      total: this.questions.length,
      question: q,
      duration: this.duration,
      endsAt: this.duration ? this.roundStarted + this.duration : null,
      selfPaced: this.paced,
      refresher: !!q.refresher,
      unit: q.unit,
      boss: !!q.boss,
    });
  }

  _timeLeftFraction() {
    if (this.paced) return 0; // no countdown -> no speed bonus
    const left = Math.max(0, this.roundStarted + this.duration - Date.now());
    return left / this.duration;
  }

  async submit(answer) {
    const q = this.current;
    if (!q || this.answeredThis) return { error: 'Already answered.' };
    this.answeredThis = true;
    const timedOut = false;
    const timeMs = this.paced
      ? Math.max(0, Date.now() - this.roundStarted)
      : Math.round(Math.min(this.duration, this.duration - this._timeLeftFraction() * this.duration));

    const judged = judgeLocal(q, answer);
    const res = scoreAnswer({
      difficulty: q.difficulty,
      boss: q.boss,
      correct: judged.correct,
      timeLeftFraction: this._timeLeftFraction(),
      streak: this.player.streak,
      refresher: !!q.refresher,
      usedPowerups: this.usedPowerups,
      matchCorrect: judged.matchCorrect,
      matchTotal: judged.matchTotal,
      timedOut,
    });

    this._record(q, judged.correct, res.earned, timeMs, res.breakdown, judged.given);

    return {
      result: {
        qIndex: this.index,
        correct: judged.correct,
        timedOut,
        earned: res.earned,
        breakdown: res.breakdown,
        correctAnswer: q.answer ?? null,
        accepted: q.accepted ?? null,
        pairs: q.pairs ?? null,
        yourAnswer: judged.given,
        explanation: q.explanation,
        analogy: q.analogy,
        mini: judged.correct ? null : q.mini,
        encouragement: judged.correct ? null : ENCOURAGEMENTS[this.player.events.length % ENCOURAGEMENTS.length],
        streak: this.player.streak,
        score: this.player.score,
        badges: (this.player.newBadges || []).map(badgeById),
        refresher: !!q.refresher,
      },
    };
  }

  /** called when the timer runs out without an answer (never in self-paced mode) */
  timeout() {
    const q = this.current;
    if (!q || this.answeredThis || this.paced) return null;
    this.answeredThis = true;
    const res = scoreAnswer({ difficulty: q.difficulty, boss: q.boss, correct: false, timedOut: true, streak: this.player.streak, timeLeftFraction: 0 });
    this._record(q, false, res.earned, this.duration, res.breakdown, null);
    return {
      qIndex: this.index,
      correct: false,
      timedOut: true,
      earned: 0,
      breakdown: res.breakdown,
      correctAnswer: q.answer ?? null,
      accepted: q.accepted ?? null,
      explanation: q.explanation,
      analogy: q.analogy,
      mini: q.mini,
      encouragement: 'Time ran out - the explanation is yours anyway.',
      streak: this.player.streak,
      score: this.player.score,
      badges: (this.player.newBadges || []).map(badgeById),
      refresher: !!q.refresher,
    };
  }

  _record(q, correct, earned, timeMs, breakdown, given) {
    const p = this.player;
    p.score += earned;
    p.totalTime += timeMs;
    if (correct) { p.correct++; p.streak++; p.bestStreak = Math.max(p.bestStreak, p.streak); }
    else { p.wrong++; p.streak = 0; }

    p.events.push({
      id: q.id, unit: q.unit, type: q.type, difficulty: q.difficulty, boss: q.boss,
      correct, refresher: !!q.refresher, timeLeftFraction: this._timeLeftFraction(),
      streak: p.streak, miniPresented: !correct, miniCorrect: false,
      usedPowerups: this.usedPowerups, timeMs, answer: given,
    });

    const before = new Set(p.badges);
    p.badges = evaluateBadges(p.events);
    p.newBadges = p.badges.filter((b) => !before.has(b));
    this.lastEvent = p.events[p.events.length - 1];
  }

  async powerup(kind) {
    const q = this.current;
    if (!q) return { error: 'Not now.' };
    if (kind === 'hint') {
      if (this.hintUsed) return { error: 'Hint already used.' };
      this.hintUsed = true;
      this.usedPowerups = [...(this.usedPowerups || []), 'hint'];
      return { ok: true, cost: 15, hint: q.hint };
    }
    if (kind === 'fifty') {
      if (!q.options || (q.answer || []).length !== 1) return { error: 'Not available here.' };
      if (this.removed.length) return { error: 'Already used.' };
      const wrong = q.options.filter((o) => !q.answer.includes(o.id)).map((o) => o.id);
      this.removed = [...wrong].sort(() => Math.random() - 0.5).slice(0, 2);
      this.usedPowerups = [...(this.usedPowerups || []), 'fifty'];
      return { ok: true, cost: 10, remove: this.removed };
    }
    if (kind === 'extraTime') {
      if (this.paced) return { error: 'There is no countdown on this question.' };
      this.duration += 10000;
      this.roundStarted += 10000;
      this.usedPowerups = [...(this.usedPowerups || []), 'extraTime'];
      this.emit('time-extended', { extraMs: 10000, endsAt: this.roundStarted + this.duration });
      return { ok: true, cost: 10, extraMs: 10000 };
    }
    if (kind === 'skip') {
      this.usedPowerups = [...(this.usedPowerups || []), 'skip'];
      return { ok: true, cost: 0, skipped: true };
    }
    return { error: 'Unknown power-up.' };
  }

  async mini(correct) {
    const ev = this.lastEvent;
    if (!ev || !ev.miniPresented || ev.miniCorrect) return { ok: true, earned: 0 };
    ev.miniCorrect = !!correct;
    const earned = correct ? 10 : 0;
    this.player.score += earned;
    if (correct) {
      const before = new Set(this.player.badges);
      this.player.badges = evaluateBadges(this.player.events);
      this.player.newBadges = this.player.badges.filter((b) => !before.has(b));
    }
    return { ok: true, earned };
  }

  /** advance to next question, inserting refresher questions from weak areas */
  advance() {
    // insert up to 2 refreshers when crossing a level boundary
    const nextQ = this.questions[this.index + 1];
    const cur = this.questions[this.index];
    if (nextQ && cur && nextQ.unit !== cur.unit) {
      const picks = chooseRefreshers({
        bank: this.pool || this.questions,
        events: this.player.events,
        currentUnit: nextQ.unit,
        seen: new Set(this.questions.map((q) => q.id)),
        limit: MAX_REFRESHERS_PER_LEVEL,
        seed: 'practice',
      }).filter((q) => !this.questions.some((x) => x.id === q.id));
      if (picks.length) {
        this.questions.splice(this.index + 1, 0, ...picks.map((q) => ({ ...q, refresher: true })));
      }
    }
    this.index++;
    if (this.index >= this.questions.length) return this.end();
    this._present();
  }

  end() {
    if (this.finished) return;
    this.finished = true;
    this.emit('end', this.buildReport());
  }

  buildReport() {
    const p = this.player;
    const unitStats = strengthMap(p.events);
    const attempted = p.correct + p.wrong;
    const accuracy = attempted ? p.correct / attempted : 0;
    const badges = p.badges.map(badgeById);
    const weakUnits = Object.entries(unitStats)
      .filter(([, s]) => s.band !== 'strong' && s.total >= 2)
      .map(([u]) => Number(u));

    return {
      mode: 'practice',
      code: null,
      startedAt: Date.now() - p.totalTime,
      endedAt: Date.now(),
      players: [{
        id: 'me', nickname: p.nickname || 'You', rank: 1, score: p.score,
        correct: p.correct, wrong: p.wrong, accuracy, totalTimeMs: p.totalTime,
        bestStreak: p.bestStreak, badges: p.badges, unitStats,
        weakUnits, needsHelp: accuracy < 0.5,
        log: p.events.map((e) => ({ id: e.id, correct: e.correct, refresher: e.refresher })),
      }],
      unitStats,
      weakUnits,
      badges,
      questions: p.events.map((e, i) => ({
        index: i, id: e.id, unit: e.unit, correct: e.correct, refresher: e.refresher, missRate: e.correct ? 0 : 1,
      })),
      totals: { players: 1, correct: p.correct, wrong: p.wrong, accuracy, score: p.score },
      bands: unitStats,
    };
  }
}

function judgeLocal(q, given) {
  if (given == null || given === '' || (Array.isArray(given) && !given.length)) return { correct: false, given: null };
  if (q.type === 'fill-blank') {
    const norm = (s) => String(s ?? '').trim().replace(/^["']|["']$/g, '').toLowerCase();
    return { correct: (q.accepted || []).some((a) => norm(a) === norm(given)), given: String(given) };
  }
  if (q.type === 'match') {
    const map = given && typeof given === 'object' ? given : {};
    const pairs = q.pairs || [];
    const ok = pairs.filter((p, i) => map[i] === p.right).length;
    return { correct: ok === pairs.length, matchCorrect: ok, matchTotal: pairs.length, given: map };
  }
  const arr = Array.isArray(given) ? given : [given];
  const target = [...(q.answer || [])].sort();
  const got = [...arr].sort();
  return { correct: target.length === got.length && target.every((t, i) => t === got[i]), given: got.join(',') };
}

export { BAND_INFO, strengthMap };
