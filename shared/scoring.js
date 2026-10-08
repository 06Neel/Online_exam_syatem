// Scoring rules for Python Adventure - fixed-marks edition.
// Each question is worth its difficulty's marks (easy/medium/hard, boss =
// hard by default). No speed bonus, no streak bonus. Power-up costs are
// deducted whenever the power-up was used, correct or not. Negative marking
// (optional) deducts a flat amount on a wrong answer - never on timeouts.
// Totals may go negative, are rounded to 2 decimals and never NaN.

export const MARKS_DEFAULT = { easy: 1, medium: 1.5, hard: 2 };
export const COSTS_DEFAULT = { hint: 0.5, fifty: 1, extraTime: 0, skip: 0 };
export const NEGATIVE_DEFAULT = 0.25;
export const REFRESHER_MULT = 0.8; // auto-revision questions are slightly discounted

export const round2 = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n) * 100) / 100 : 0);

/** Merge saved marks over the defaults and resolve one question's worth. */
export function marksFor(difficulty, boss, marks) {
  const m = { ...MARKS_DEFAULT, ...(marks && typeof marks === 'object' ? marks : {}) };
  const pick = (v, dflt) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? round2(v) : dflt);
  if (boss) return pick(m.boss, pick(m.hard, MARKS_DEFAULT.hard));
  const d = difficulty in MARKS_DEFAULT ? difficulty : 'medium';
  return pick(m[d], MARKS_DEFAULT[d]);
}

/**
 * @param {object} p
 * @param {'easy'|'medium'|'hard'} p.difficulty
 * @param {boolean} p.boss
 * @param {boolean} p.correct            main answer correct
 * @param {boolean} [p.refresher]
 * @param {string[]} [p.usedPowerups]    subset of hint|fifty|extraTime|skip
 * @param {number}  [p.matchCorrect]     for match questions: pairs right
 * @param {number}  [p.matchTotal]       for match questions: pairs total
 * @param {boolean} [p.timedOut]
 * @param {object}  [p.marks]            per-quiz marks { easy, medium, hard, boss }
 * @param {object}  [p.costs]            per-quiz power-up costs
 * @param {boolean} [p.negativeMarking]
 * @param {number}  [p.negativeAmount]
 * @param {number}  [p.questionMarks]   per-question override (q.marks)
 * @returns {{earned:number, base:number, penalties:number, breakdown:Array<{label:string, value:number}>}}
 */
export function scoreAnswer(p) {
  const base = (Number.isFinite(Number(p.questionMarks)) && Number(p.questionMarks) >= 0)
    ? round2(p.questionMarks)
    : marksFor(p.difficulty, !!p.boss, p.marks);
  const costs = { ...COSTS_DEFAULT, ...(p.costs && typeof p.costs === 'object' ? p.costs : {}) };
  const breakdown = [];
  const isMatch = typeof p.matchTotal === 'number' && p.matchTotal > 0;

  let mainPart = 0;
  let mainLabel = 'Not this time';

  if (isMatch) {
    const pairs = Math.max(0, Math.min(Number(p.matchCorrect) || 0, p.matchTotal));
    if (pairs === p.matchTotal) {
      mainPart = base;
      mainLabel = 'All pairs matched';
    } else if (pairs > 0) {
      mainPart = round2((base * pairs) / p.matchTotal);
      mainLabel = `${pairs}/${p.matchTotal} pairs matched (partial)`;
    } else {
      mainLabel = 'Not enough pairs';
    }
  } else if (p.correct) {
    mainPart = base;
    mainLabel = p.boss ? 'Boss defeated' : 'Correct';
  } else if (p.timedOut) {
    mainLabel = 'Time ran out';
  }

  breakdown.push({ label: mainLabel, value: round2(mainPart) });

  if (p.refresher && mainPart !== 0) {
    const adj = round2(mainPart * (REFRESHER_MULT - 1));
    if (adj) breakdown.push({ label: 'Refresher (×0.8)', value: adj });
    mainPart = round2(mainPart + adj);
  }

  let penalties = 0;
  for (const u of [...new Set(p.usedPowerups || [])]) {
    const cost = round2(costs[u]);
    if (cost > 0) {
      penalties = round2(penalties + cost);
      breakdown.push({ label: `${powerupLabel(u)} used`, value: -cost });
    }
  }

  let negative = 0;
  const wrongNoCredit = !p.correct && !p.timedOut && mainPart === 0;
  if (p.negativeMarking && wrongNoCredit) {
    negative = round2(Number.isFinite(Number(p.negativeAmount)) && Number(p.negativeAmount) >= 0
      ? p.negativeAmount
      : NEGATIVE_DEFAULT);
    if (negative > 0) breakdown.push({ label: 'Wrong answer', value: -negative });
  }

  return {
    earned: round2(mainPart - penalties - negative),
    base,
    penalties: round2(penalties + negative),
    breakdown,
  };
}

export function powerupLabel(id) {
  return { hint: 'Hint', fifty: '50-50', extraTime: 'Extra time', skip: 'Skip' }[id] || id;
}

/** Format a mark total for display/CSV: up to 2 decimals, no trailing zeros. */
export function fmtMarks(n) {
  return String(round2(n));
}

/**
 * Team score = sum of members (shared accuracy badge).
 */
export function teamSummary(members) {
  const score = round2(members.reduce((s, m) => s + (Number(m.score) || 0), 0));
  const correct = members.reduce((s, m) => s + m.correct, 0);
  const wrong = members.reduce((s, m) => s + m.wrong, 0);
  const attempted = correct + wrong;
  return { score, correct, wrong, accuracy: attempted ? correct / attempted : 0, size: members.length };
}

export function powerupsUsedCount(p) {
  return (p.powerupsUsed || []).length;
}

/**
 * Ranks: marks desc, then more correct answers, then fewer power-ups used,
 * then earlier completion (unfinished players sort last), then total time.
 */
export function comparePlayers(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  if (b.correct !== a.correct) return b.correct - a.correct;
  const pa = powerupsUsedCount(a);
  const pb = powerupsUsedCount(b);
  if (pa !== pb) return pa - pb;
  const fa = Number.isFinite(a.finishedAt) ? a.finishedAt : Number.POSITIVE_INFINITY;
  const fb = Number.isFinite(b.finishedAt) ? b.finishedAt : Number.POSITIVE_INFINITY;
  if (fa !== fb) return fa - fb;
  return (a.totalTime || 0) - (b.totalTime || 0);
}

/** Self-paced runs use the same fair tie-breaks (kept as a named export). */
export const comparePlayersSelfPaced = comparePlayers;

/**
 * Rank a team-mode player list AS TEAMS. Players without a team are left
 * out (they are shown as "Solo players" instead of a fake team).
 * Tie-breaks: total score, then higher average per member, then accuracy,
 * then team name - so the order is always fair and deterministic.
 * @param {Array<{team?: string|null, score?: number, nickname?: string}>} players
 * @returns {Array<{rank:number, name:string, score:number, avg:number, accuracy:number, size:number, members:string[], correct:number, wrong:number}>}
 */
export function rankTeams(players) {
  const groups = new Map();
  for (const p of players || []) {
    const name = p.team ? String(p.team).trim() : '';
    if (!name) continue;
    if (!groups.has(name)) groups.set(name, []);
    groups.get(name).push(p);
  }
  const rows = [...groups.entries()].map(([name, ms]) => {
    const sum = teamSummary(ms);
    const size = ms.length;
    return {
      name,
      ...sum,
      size,
      avg: size ? round2(sum.score / size) : 0,
      members: ms.map((m) => m.nickname),
    };
  });
  rows.sort((a, b) => (b.score - a.score)
    || (b.avg - a.avg)
    || (b.accuracy - a.accuracy)
    || a.name.localeCompare(b.name));
  return rows.map((t, i) => ({ ...t, rank: i + 1 }));
}

export function hintsUsed(p) {
  return (p.powerupsUsed || []).filter((u) => u && u.kind === 'hint').length;
}
