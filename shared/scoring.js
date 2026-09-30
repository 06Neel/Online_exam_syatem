// Scoring rules for Python Adventure.
// Accuracy always outweighs speed: correct-vs-wrong swing is 100+ points,
// the entire speed swing is capped at 40% of the base.

export const BASE_POINTS = { easy: 80, medium: 100, hard: 130 };
export const BOSS_POINTS = 150;
export const SPEED_WEIGHT = 0.4; // up to +40% of base for answering instantly
export const STREAK_BONUS_PER = 10;
export const STREAK_BONUS_CAP = 30;
export const REFRESHER_MULT = 0.8; // auto-revision questions are slightly discounted
export const MINI_BONUS = 10; // consolation for nailing the try-again mini
export const MATCH_PAIR_SHARE = 0.2; // 20% of base per correct pair
export const POWERUP_COSTS = { hint: 15, fifty: 10, extraTime: 10 };

const round = (n) => Math.max(0, Math.round(n));

/**
 * @param {object} p
 * @param {'easy'|'medium'|'hard'} p.difficulty
 * @param {boolean} p.boss
 * @param {boolean} p.correct            main answer correct
 * @param {number}  p.timeLeftFraction   0..1 of the timer still remaining
 * @param {number}  p.streak             consecutive correct BEFORE this answer
 * @param {boolean} [p.refresher]
 * @param {string[]} [p.usedPowerups]    subset of hint|fifty|extraTime
 * @param {number}  [p.matchCorrect]     for match questions: pairs right
 * @param {number}  [p.matchTotal]       for match questions: pairs total
 * @param {boolean} [p.timedOut]
 * @returns {{earned:number, base:number, speed:number, streak:number, penalties:number, breakdown:Array<{label:string, value:number}>}}
 */
export function scoreAnswer(p) {
  const difficulty = p.difficulty in BASE_POINTS ? p.difficulty : 'medium';
  // per-quiz point overrides: { easy, medium, hard, boss }
  const custom = p.points && typeof p.points === 'object' ? p.points : {};
  const pick = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : dflt);
  const base = p.boss
    ? pick(custom.boss, BOSS_POINTS)
    : pick(custom[difficulty], BASE_POINTS[difficulty]);
  const breakdown = [];
  const isMatch = typeof p.matchTotal === 'number' && p.matchTotal > 0;

  let mainPart = 0;
  let mainLabel = 'Correct';

  if (isMatch) {
    const pairs = Math.max(0, Math.min(p.matchCorrect ?? 0, p.matchTotal));
    const ratio = pairs / p.matchTotal;
    mainPart = base * MATCH_PAIR_SHARE * pairs;
    if (pairs === p.matchTotal) {
      mainPart = base;
      mainLabel = 'All pairs matched';
    } else if (pairs > 0) {
      mainLabel = `${pairs}/${p.matchTotal} pairs matched (partial)`;
      mainPart = round(mainPart);
    }
  } else if (p.correct) {
    mainPart = base;
    mainLabel = p.boss ? 'Boss defeated' : 'Correct';
  }

  const correct = isMatch ? mainPart > 0 : !!p.correct;
  breakdown.push({ label: mainLabel, value: round(mainPart) });

  let speed = 0;
  let streak = 0;

  if (correct) {
    const frac = Math.max(0, Math.min(1, p.timeLeftFraction ?? 0));
    speed = mainPart * SPEED_WEIGHT * frac;
    if (speed >= 1) breakdown.push({ label: 'Speed bonus', value: round(speed) });

    const s = Math.max(0, p.streak || 0) + 1;
    streak = Math.min(s * STREAK_BONUS_PER, STREAK_BONUS_CAP);
    if (streak > 0) breakdown.push({ label: `Streak x${s}`, value: streak });
  } else if (p.timedOut) {
    breakdown.push({ label: 'Time ran out', value: 0 });
  } else {
    breakdown.push({ label: isMatch ? 'Not enough pairs' : 'Not this time', value: 0 });
  }

  const used = [...new Set(p.usedPowerups || [])];
  let penalties = 0;
  for (const u of used) {
    const cost = POWERUP_COSTS[u];
    if (cost) {
      penalties += cost;
      breakdown.push({ label: `${powerupLabel(u)} used`, value: -cost });
    }
  }

  let earned = round(mainPart + speed + streak - penalties);
  if (earned < 0) earned = 0;

  const refresher = p.refresher ? Math.round(earned * (REFRESHER_MULT - 1)) : 0;
  if (p.refresher) {
    breakdown.push({ label: 'Refresher adjustment', value: refresher });
    earned = Math.max(0, earned + refresher);
  }

  return { earned, base: round(mainPart), speed: round(speed), streak, penalties, breakdown };
}

export function powerupLabel(id) {
  return { hint: 'Hint', fifty: '50-50', extraTime: 'Extra time', skip: 'Skip' }[id] || id;
}

/**
 * Team score = sum of members, but each member is capped by their own
 * average so one speed-demon cannot carry a whole team alone.
 * (Kept simple and transparent: plain sum + shared accuracy badge.)
 */
export function teamSummary(members) {
  const score = members.reduce((s, m) => s + m.score, 0);
  const correct = members.reduce((s, m) => s + m.correct, 0);
  const wrong = members.reduce((s, m) => s + m.wrong, 0);
  const attempted = correct + wrong;
  return { score, correct, wrong, accuracy: attempted ? correct / attempted : 0, size: members.length };
}

/** Ranks: score desc, then accuracy desc, then total time asc. */
export function comparePlayers(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const aa = a.correct + a.wrong ? a.correct / (a.correct + a.wrong) : 0;
  const bb = b.correct + b.wrong ? b.correct / (b.correct + b.wrong) : 0;
  if (bb !== aa) return bb - aa;
  return (a.totalTime || 0) - (b.totalTime || 0);
}

export function hintsUsed(p) {
  return (p.powerupsUsed || []).filter((u) => u && u.kind === 'hint').length;
}

/**
 * Self-paced (timer off) ranks: score desc, then fewer hints used,
 * then earlier completion (unfinished players sort last). Total time
 * only breaks a remaining tie so the order is always stable.
 */
export function comparePlayersSelfPaced(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const ha = hintsUsed(a);
  const hb = hintsUsed(b);
  if (ha !== hb) return ha - hb;
  const fa = Number.isFinite(a.finishedAt) ? a.finishedAt : Number.POSITIVE_INFINITY;
  const fb = Number.isFinite(b.finishedAt) ? b.finishedAt : Number.POSITIVE_INFINITY;
  if (fa !== fb) return fa - fb;
  return (a.totalTime || 0) - (b.totalTime || 0);
}
