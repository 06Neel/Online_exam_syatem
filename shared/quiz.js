// Building a quiz run: level order, question sampling, option shuffling
// and the auto-revision ("refresher") picker.
import { makeRng } from './rng.js';

export const DEFAULT_TIMERS = { easy: 30, medium: 40, hard: 50, bossExtra: 10 };
export const MAX_REFRESHERS_PER_LEVEL = 2;

/**
 * Seconds allowed for one question.
 * Precedence: the question's own `timeLimit` (from the JSON) -> one common
 * time set by the teacher -> the per-difficulty default (+ boss bonus).
 * A question's own limit or a common time is exact: no boss bonus on top.
 */
export function timerFor(q, overrides = {}, commonSeconds = null) {
  const own = Number(q?.timeLimit);
  if (Number.isFinite(own) && own > 0) return Math.round(Math.min(300, Math.max(1, own)));
  const common = Number(commonSeconds);
  if (Number.isFinite(common) && common > 0) return Math.round(Math.min(300, Math.max(1, common)));
  const base = overrides[q.difficulty] ?? DEFAULT_TIMERS[q.difficulty] ?? 40;
  return Math.round(base + (q.boss ? (overrides.bossExtra ?? DEFAULT_TIMERS.bossExtra) : 0));
}

/**
 * Pick which questions this session will ask, in order.
 * Levels run in syllabus order; each level ends with its boss question.
 */
export function buildQuiz({ bank, units, count = 20, difficulty = 'mixed', seed = 'seed', teamMode = false }) {
  const rng = makeRng(seed);
  const chosenUnits = (units && units.length ? units : [1, 2, 3, 4, 5, 6, 7])
    .slice()
    .sort((a, b) => a - b);

  const byUnit = {};
  for (const u of chosenUnits) {
    let pool = bank.filter((q) => q.unit === u);
    if (difficulty !== 'mixed') pool = pool.filter((q) => q.difficulty === difficulty);
    if (pool.length === 0) pool = bank.filter((q) => q.unit === u);
    byUnit[u] = rng.shuffle(pool);
  }

  // spread the requested count across levels, always keeping a boss at each level end
  const activeUnits = chosenUnits.filter((u) => byUnit[u].length);
  const perUnit = {};
  const nonBossCount = {};
  let remaining = Math.max(activeUnits.length, count);

  for (const u of activeUnits) nonBossCount[u] = Math.max(1, byUnit[u].filter((q) => !q.boss).length);

  const totalNonBoss = activeUnits.reduce((s, u) => s + nonBossCount[u], 0);
  const wantsAll = count >= totalNonBoss + activeUnits.length;

  if (wantsAll) {
    for (const u of activeUnits) perUnit[u] = nonBossCount[u];
    remaining = 0;
  } else {
    const share = count / activeUnits.length;
    for (const u of activeUnits) perUnit[u] = Math.max(0, Math.floor(share));
    let allocated = activeUnits.reduce((s, u) => s + perUnit[u], 0);
    // distribute leftovers to the units that can still take more
    const order = rng.shuffle(activeUnits);
    while (allocated < count) {
      let placed = false;
      for (const u of order) {
        if (perUnit[u] < nonBossCount[u]) {
          perUnit[u]++;
          allocated++;
          placed = true;
          if (allocated >= count) break;
        }
      }
      if (!placed) break;
    }
  }

  const questions = [];
  for (const u of activeUnits) {
    const all = byUnit[u];
    const boss = all.find((q) => q.boss);
    const normal = all.filter((q) => !q.boss).slice(0, perUnit[u]);
    for (const q of normal) questions.push({ ...q, refresher: false });
    if (boss && (wantsAll || perUnit[u] >= 1)) questions.push({ ...boss, refresher: false });
  }

  return questions;
}

/**
 * Choose up to `limit` refresher questions mid-game.
 * Priority: the player's own wrong answers -> earlier weak units -> unseen.
 */
export function chooseRefreshers({
  bank,
  events = [],        // player's answer history
  currentUnit = 1,
  seen = new Set(),   // question ids already shown to this player
  limit = MAX_REFRESHERS_PER_LEVEL,
  seed = 'r',
}) {
  const rng = makeRng(`${seed}:${events.length}:${currentUnit}`);
  const out = [];
  const used = new Set(seen);

  const wrongIds = [...new Set(events.filter((e) => !e.correct && !e.refresher).map((e) => e.id))];

  // 1) own misses from earlier levels
  for (const id of rng.shuffle(wrongIds)) {
    if (out.length >= limit) break;
    const q = bank.find((x) => x.id === id);
    if (!q || used.has(q.id) || q.boss) continue;
    if (q.unit === currentUnit) continue; // same level still in progress
    out.push(q);
    used.add(q.id);
  }

  if (out.length >= limit) return out;

  // 2) weak units (<60% accuracy) from earlier in the run
  const stats = {};
  for (const e of events) {
    if (e.refresher) continue;
    const s = (stats[e.unit] ||= { right: 0, total: 0 });
    s.total++;
    if (e.correct) s.right++;
  }
  const weakUnits = Object.entries(stats)
    .filter(([u, s]) => Number(u) < currentUnit && s.total >= 3 && s.right / s.total < 0.6)
    .map(([u]) => Number(u));

  const candidates = bank.filter(
    (q) => !used.has(q.id) && !q.boss && (weakUnits.includes(q.unit) || q.unit < currentUnit)
  );
  for (const q of rng.shuffle(candidates)) {
    if (out.length >= limit) break;
    out.push(q);
    used.add(q.id);
  }

  if (out.length >= limit) return out;

  // 3) anything unseen (same or later unit, never a boss)
  const rest = bank.filter((q) => !used.has(q.id) && !q.boss);
  for (const q of rng.shuffle(rest)) {
    if (out.length >= limit) break;
    out.push(q);
    used.add(q.id);
  }

  return out;
}

/** Shuffle the 4 options of a question for one specific player (ids preserved). */
export function shuffleOptions(q, seed) {
  if (!q.options) return q;
  const rng = makeRng(`${seed}:${q.id}`);
  return { ...q, options: rng.shuffle(q.options) };
}

/** Topic strength map: green >= .8, yellow >= .5, red below. */
export function strengthMap(events) {
  const out = {};
  for (const e of events) {
    if (e.refresher) continue;
    const s = (out[e.unit] ||= { correct: 0, total: 0, time: 0 });
    s.total++;
    if (e.correct) s.correct++;
    s.time += e.timeMs || 0;
  }
  const map = {};
  for (const [unit, s] of Object.entries(out)) {
    const acc = s.total ? s.correct / s.total : 0;
    map[unit] = {
      ...s,
      accuracy: acc,
      band: acc >= 0.8 ? 'strong' : acc >= 0.5 ? 'revise' : 'practice',
    };
  }
  return map;
}

export const BAND_INFO = {
  strong: { icon: '🟢', label: 'Strong', note: 'Keep it up!' },
  revise: { icon: '🟡', label: 'Revise', note: 'A quick refresh will lock it in.' },
  practice: { icon: '🔴', label: 'Needs practice', note: 'Try practice mode on this topic.' },
};
