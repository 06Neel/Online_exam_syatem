// Badge logic. Events are per-player answer records:
// { unit, type, difficulty, boss, correct, miniCorrect, miniPresented,
//   timeLeftFraction, streak, consecutiveWrongBefore, usedPowerups, refresher }

export const BADGES = [
  { id: 'bug_hunter', icon: '🐛', name: 'Bug Hunter', desc: 'Spot 3 bugs correctly in one session' },
  { id: 'comeback_kid', icon: '🦸', name: 'Comeback Kid', desc: 'After 2+ wrong in a row, get the next 3 right' },
  { id: 'on_fire', icon: '🔥', name: 'On Fire', desc: 'Build a streak of 5 in a row' },
  { id: 'sharpshooter', icon: '🎯', name: 'Sharpshooter', desc: 'Perfect score on a whole level' },
  { id: 'speed_demon', icon: '⚡', name: 'Speedy Coder', desc: '5 correct answers with over 70% of the timer left' },
  { id: 'perseverance', icon: '💪', name: 'Perseverance', desc: 'Nail every try-again challenge you were given (3+)' },
  { id: 'boss_slayer', icon: '🐲', name: 'Boss Slayer', desc: 'Defeat a boss question' },
  { id: 'trailblazer', icon: '🏁', name: 'Trailblazer', desc: 'Finish the whole adventure' },
  { id: 'no_hint', icon: '🧠', name: 'Solo Thinker', desc: 'Finish a level without using a single hint' },
];

export const TOPIC_BADGES = {
  1: { id: 'setup_starter', icon: '🚀', name: 'Setup Starter', desc: '80%+ in Environment Setup' },
  2: { id: 'name_ninja', icon: '🥷', name: 'Name Ninja', desc: '80%+ in Variables' },
  3: { id: 'condition_captain', icon: '🧭', name: 'Condition Captain', desc: '80%+ in Conditionals' },
  4: { id: 'loop_master', icon: '🔁', name: 'Loop Master', desc: '80%+ in Loops' },
  5: { id: 'string_sage', icon: '📜', name: 'String Sage', desc: '80%+ in Strings' },
  6: { id: 'list_legend', icon: '📚', name: 'List Legend', desc: '80%+ in Lists' },
  7: { id: 'dict_duke', icon: '📖', name: 'Dict Duke', desc: '80%+ in Tuples & Dictionaries' },
};

export const ALL_BADGES = [
  ...BADGES,
  ...Object.values(TOPIC_BADGES),
];

export function badgeById(id) {
  return ALL_BADGES.find((b) => b.id === id) || { id, icon: '🏅', name: id, desc: '' };
}

const TOPIC_PASS = 0.8;
const TOPIC_MIN = 4;

/**
 * Incremental badge evaluation - safe to call after every answer.
 * @returns {string[]} all badge ids earned so far
 */
export function evaluateBadges(events, opts = {}) {
  const earned = new Set();
  const last = events[events.length - 1];

  let run = 0;
  for (const e of events) {
    if (e.correct) run++;
    else run = 0;
    if (run >= 5) earned.add('on_fire');
  }

  const spotErrors = events.filter((e) => e.type === 'spot-error' && e.correct).length;
  if (spotErrors >= 3) earned.add('bug_hunter');

  // comeback: >=2 wrong in a row, then 3 correct afterwards
  let wrongRun = 0;
  let afterComeback = 0;
  for (const e of events) {
    if (!e.correct) {
      wrongRun++;
      afterComeback = 0;
    } else if (wrongRun >= 2) {
      afterComeback++;
      if (afterComeback >= 3) earned.add('comeback_kid');
    } else {
      afterComeback = 0;
    }
  }

  const fast = events.filter((e) => e.correct && !e.refresher && (e.timeLeftFraction ?? 0) > 0.7).length;
  if (fast >= 5) earned.add('speed_demon');

  const minis = events.filter((e) => e.miniPresented);
  if (minis.length >= 3 && minis.every((e) => e.miniCorrect)) earned.add('perseverance');

  if (last?.boss && last.correct) earned.add('boss_slayer');

  // per-level (unit) stats on non-refresher questions
  const byUnit = {};
  for (const e of events) {
    if (e.refresher) continue;
    const u = (byUnit[e.unit] ||= { right: 0, total: 0, hints: 0 });
    u.total++;
    if (e.correct) u.right++;
    if ((e.usedPowerups || []).includes('hint')) u.hints++;
  }
  for (const [unit, s] of Object.entries(byUnit)) {
    if (s.total >= 3 && s.right === s.total) earned.add('sharpshooter');
    if (s.total >= TOPIC_MIN && s.total > 0 && s.right / s.total >= TOPIC_PASS) {
      const tb = TOPIC_BADGES[Number(unit)];
      if (tb) earned.add(tb.id);
    }
    if (s.total >= 3 && s.hints === 0 && s.right === s.total) earned.add('no_hint');
  }

  if (opts.finished) earned.add('trailblazer');

  return [...earned];
}

export const ENCOURAGEMENTS = [
  'No worries - even Guido van Rossum mistypes. 🌱',
  'Great attempt! The explanation below is the real prize.',
  'Wrong today, right tomorrow. Have a peek at the why.',
  'Mistakes are how Python gets into your fingers. 💪',
  'Almost! Read the think-of-it-like hint and try the mini.',
  'Keep going - one wobble never sank a ship. 🚢',
];

export const STREAK_LINES = {
  2: 'Two in a row - nice! 🌤️',
  3: 'Three! You are on a roll 🎸',
  4: 'Four straight - the class can feel it 👀',
  5: 'FIVE! On Fire badge unlocked 🔥',
  7: 'Seven in a row?! Legend behaviour 🏆',
  10: 'TEN! Somebody stop this coder 🛑',
};

export function streakLine(streak) {
  return STREAK_LINES[streak] || '';
}
