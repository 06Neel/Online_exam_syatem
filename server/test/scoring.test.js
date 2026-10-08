import test from 'node:test';
import assert from 'node:assert/strict';
import {
  scoreAnswer, marksFor, fmtMarks, round2,
  comparePlayers, comparePlayersSelfPaced, hintsUsed, teamSummary, rankTeams,
  MARKS_DEFAULT, COSTS_DEFAULT, NEGATIVE_DEFAULT,
} from '../../shared/scoring.js';

const quiz = (over = {}) => ({ marks: MARKS_DEFAULT, costs: COSTS_DEFAULT, ...over });

test('fixed marks: easy 1, medium 1.5, hard 2 add up to 4.5', () => {
  const easy = scoreAnswer({ ...quiz(), difficulty: 'easy', correct: true });
  const medium = scoreAnswer({ ...quiz(), difficulty: 'medium', correct: true });
  const hard = scoreAnswer({ ...quiz(), difficulty: 'hard', correct: true });
  assert.equal(easy.earned, 1);
  assert.equal(medium.earned, 1.5);
  assert.equal(hard.earned, 2);
  assert.equal(round2(easy.earned + medium.earned + hard.earned), 4.5);
  // no speed and no streak lines any more
  for (const r of [easy, medium, hard]) {
    assert.ok(!r.breakdown.some((b) => /Speed|Streak/.test(b.label)), 'speed/streak are gone');
  }
});

test('power-up costs: easy+hint = 0.5, medium+50:50 = 0.5', () => {
  const withHint = scoreAnswer({ ...quiz(), difficulty: 'easy', correct: true, usedPowerups: ['hint'] });
  assert.equal(withHint.earned, 0.5);
  assert.equal(withHint.penalties, COSTS_DEFAULT.hint);

  const withFifty = scoreAnswer({ ...quiz(), difficulty: 'medium', correct: true, usedPowerups: ['fifty'] });
  assert.equal(withFifty.earned, 0.5);

  // the chips a student reads spell out what they paid for
  assert.match(withHint.breakdown.map((b) => b.label).join('|'), /Hint used/, 'the hint cost is named');
  assert.match(withFifty.breakdown.map((b) => b.label).join('|'), /50-50 used/, 'the 50-50 cost is named');

  // costs are charged on a wrong answer too, and never silently dropped
  const wrongHint = scoreAnswer({ ...quiz(), difficulty: 'easy', correct: false, usedPowerups: ['hint'] });
  assert.equal(wrongHint.earned, -COSTS_DEFAULT.hint, 'a miss still pays for the hint');
});

test('negative marking: off = 0, on = -0.25, never for timeouts', () => {
  const off = scoreAnswer({ ...quiz(), difficulty: 'easy', correct: false });
  assert.equal(off.earned, 0);

  const on = scoreAnswer({
    ...quiz({ negativeMarking: true, negativeAmount: NEGATIVE_DEFAULT }),
    difficulty: 'easy', correct: false,
  });
  assert.equal(on.earned, -NEGATIVE_DEFAULT);

  // wrong + hint + negative on: -0.25 -0.5 = -0.75
  const withHint = scoreAnswer({
    ...quiz({ negativeMarking: true, negativeAmount: NEGATIVE_DEFAULT }),
    difficulty: 'easy', correct: false, usedPowerups: ['hint'],
  });
  assert.equal(withHint.earned, -0.75);

  // timeouts and skips are never negatively marked
  const timeout = scoreAnswer({
    ...quiz({ negativeMarking: true, negativeAmount: NEGATIVE_DEFAULT }),
    difficulty: 'easy', correct: false, timedOut: true,
  });
  assert.equal(timeout.earned, 0);
  assert.ok(!timeout.breakdown.some((b) => b.label === 'Wrong answer'), 'no negative line for a timeout');
});

test('every question can be skipped for 0 - no marks, no penalty', () => {
  const skipped = scoreAnswer({ ...quiz({ negativeMarking: true }), difficulty: 'hard', correct: false, timedOut: true });
  assert.equal(skipped.earned, 0);
});

test('boss question pays the hard marks, per-question override wins', () => {
  const boss = scoreAnswer({ ...quiz(), difficulty: 'hard', boss: true, correct: true });
  const hard = scoreAnswer({ ...quiz(), difficulty: 'hard', correct: true });
  assert.equal(boss.earned, MARKS_DEFAULT.hard, 'boss = hard marks by default');
  assert.equal(hard.earned, MARKS_DEFAULT.hard);

  const custom = scoreAnswer({ ...quiz(), difficulty: 'easy', correct: true, questionMarks: 3.5 });
  assert.equal(custom.earned, 3.5, 'q.marks beats the difficulty table');
  assert.equal(custom.base, 3.5);

  assert.equal(marksFor('easy', false, { easy: 7 }), 7, 'quiz-level override too');
  assert.equal(marksFor('nope', false, null), MARKS_DEFAULT.medium, 'unknown difficulty falls back');
});

test('refresher questions are worth 80%', () => {
  const normal = scoreAnswer({ ...quiz(), difficulty: 'medium', correct: true });
  const refresh = scoreAnswer({ ...quiz(), difficulty: 'medium', correct: true, refresher: true });
  assert.equal(normal.earned, 1.5);
  assert.equal(refresh.earned, 1.2);
  assert.ok(refresh.breakdown.some((b) => b.label.startsWith('Refresher')), 'the discount is shown');
});

test('match questions pay proportionally, full for all pairs', () => {
  const all = scoreAnswer({ ...quiz(), difficulty: 'medium', correct: true, matchCorrect: 3, matchTotal: 3 });
  const some = scoreAnswer({ ...quiz(), difficulty: 'medium', correct: false, matchCorrect: 1, matchTotal: 3 });
  const none = scoreAnswer({ ...quiz(), difficulty: 'medium', correct: false, matchCorrect: 0, matchTotal: 3 });
  assert.equal(all.earned, 1.5, 'every pair = the full marks');
  assert.equal(some.earned, 0.5, '1 of 3 pairs = a third of the marks');
  assert.equal(none.earned, 0);
});

test('rounding: totals keep at most 2 decimals and never NaN', () => {
  const s = scoreAnswer({
    ...quiz({ marks: { easy: 0.33 }, negativeMarking: true, negativeAmount: 0.1 }),
    difficulty: 'easy', correct: false, usedPowerups: ['fifty'],
  });
  assert.equal(s.earned, -1.1, '0.33 marks never earned - costs 1 - negative 0.1');
  assert.ok(Number.isFinite(s.earned), 'never NaN');
  const weird = scoreAnswer({ difficulty: 'easy', correct: true, questionMarks: 'abc' });
  assert.ok(Number.isFinite(weird.earned), 'garbage marks fall back to the defaults');
});

test('ranking: marks, then more correct, then fewer power-ups, then time', () => {
  const a = { score: 10, correct: 5, wrong: 5, totalTime: 1000, powerupsUsed: [] };
  const b = { score: 10, correct: 9, wrong: 1, totalTime: 5000, powerupsUsed: [] };
  const c = { score: 20, correct: 3, wrong: 7, totalTime: 100, powerupsUsed: [] };
  const ranked = [a, b, c].sort(comparePlayers);
  assert.equal(ranked[0], c, 'more marks always wins');
  assert.equal(ranked[1], b, 'equal marks: more correct answers wins');

  // equal marks + equal correct: fewer power-ups, then earlier finish
  const spent = { score: 10, correct: 5, totalTime: 100, finishedAt: 100, powerupsUsed: [{ kind: 'hint' }] };
  const clean = { score: 10, correct: 5, totalTime: 900, finishedAt: 900, powerupsUsed: [] };
  assert.equal([spent, clean].sort(comparePlayers)[0], clean, 'spending nothing breaks the tie');
});

test('team summary aggregates the squad', () => {
  const t = teamSummary([
    { score: 10, correct: 4, wrong: 1 },
    { score: 5, correct: 2, wrong: 3 },
  ]);
  assert.equal(t.score, 15);
  assert.equal(t.correct, 6);
  assert.equal(t.wrong, 4);
  assert.equal(t.accuracy, 0.6);
});

test('rankTeams: member names, solo players stay out, fair tie-breaks', () => {
  const players = [
    { nickname: 'Ann', team: 'Pythons', score: 12, correct: 3, wrong: 1 },
    { nickname: 'Bo', team: 'Pythons', score: 8, correct: 2, wrong: 2 },
    { nickname: 'Cy', team: 'Cobras', score: 10, correct: 5, wrong: 0 },
    { nickname: 'Di', team: '', score: 30, correct: 6, wrong: 0 }, // solo: not a team
    { nickname: 'Ed', team: '  ', score: 9, correct: 1, wrong: 1 }, // blank = solo too
  ];

  const teams = rankTeams(players);
  assert.equal(teams.length, 2, 'only real teams are ranked - no fake Solo team');

  // Pythons (20) beat Cobras (10) on total
  assert.equal(teams[0].name, 'Pythons');
  assert.equal(teams[0].score, 20, 'team score is the sum of every member');
  assert.equal(teams[0].rank, 1);
  assert.deepEqual([...teams[0].members].sort(), ['Ann', 'Bo'], 'members are the nicknames');
  assert.equal(teams[0].size, 2);
  assert.equal(teams[0].avg, 10, 'average per member stays 2-decimal safe');

  assert.equal(teams[1].name, 'Cobras');
  assert.equal(teams[1].score, 10);
  assert.equal(teams[1].accuracy, 1, 'a perfect team shows 100% accuracy');

  // tie-breaks: equal total -> higher average wins
  const avgWins = rankTeams([
    { nickname: 'A', team: 'Few', score: 10, correct: 4, wrong: 0 },
    { nickname: 'B', team: 'Many', score: 5, correct: 2, wrong: 0 },
    { nickname: 'C', team: 'Many', score: 5, correct: 2, wrong: 0 },
  ]);
  assert.equal(avgWins[0].name, 'Few', 'equal totals: the smaller team per head ranks first');

  // equal total AND average -> accuracy decides
  const accWins = rankTeams([
    { nickname: 'A', team: 'Sharp', score: 10, correct: 4, wrong: 0 },
    { nickname: 'B', team: 'Lucky', score: 10, correct: 3, wrong: 1 },
  ]);
  assert.equal(accWins[0].name, 'Sharp', 'equal totals + average: better accuracy ranks first');

  // everything equal -> team name keeps the order deterministic
  const byName = rankTeams([
    { nickname: 'X', team: 'zebras', score: 5, correct: 2, wrong: 0 },
    { nickname: 'Y', team: 'Ants', score: 5, correct: 2, wrong: 0 },
  ]);
  assert.deepEqual(byName.map((t) => t.name), ['Ants', 'zebras'], 'a dead tie falls back to the name');

  // shuffled input always yields the same order
  const shuffled = rankTeams([...players].reverse());
  assert.deepEqual(shuffled.map((t) => t.name), teams.map((t) => t.name), 'input order never changes the ranking');
});

test('self-paced ranking: marks, then fewer power-ups, then earlier finish', () => {
  const mk = (score, hints, finishedAt, totalTime = 0) => ({
    score, correct: 4, wrong: 0, finishedAt, totalTime,
    powerupsUsed: Array.from({ length: hints }, () => ({ kind: 'hint' })),
  });
  const ranked = [mk(10, 1, 3000), mk(10, 0, 9000), mk(10, 0, 1000), mk(15, 3, null)]
    .sort(comparePlayersSelfPaced);
  assert.equal(ranked[0].score, 15, 'the best score leads even with hints spent');
  assert.equal(ranked[1].finishedAt, 1000, 'equal score: no hints + finished earliest');
  assert.equal(ranked[2].finishedAt, 9000, 'same score and hints: later finish ranks lower');
  assert.equal(ranked[3].finishedAt, 3000, 'using hints drops you below the no-hint pair');

  const tie = [mk(10, 0, null), mk(10, 0, 5000)].sort(comparePlayersSelfPaced);
  assert.equal(tie[0].finishedAt, 5000, 'finishing beats still working on it');
  assert.equal(tie[1].finishedAt, null, 'unfinished sorts last');

  assert.equal(hintsUsed({ powerupsUsed: [{ kind: 'hint' }, { kind: 'fifty' }] }), 1);
  assert.equal(hintsUsed({}), 0);
});

test('fmtMarks shows up to 2 decimals with no trailing zeros', () => {
  assert.equal(fmtMarks(4.5), '4.5');
  assert.equal(fmtMarks(2), '2');
  assert.equal(fmtMarks(-0.75), '-0.75');
  assert.equal(fmtMarks(1.2000001), '1.2');
  assert.equal(fmtMarks('nope'), '0');
});

test('breakdown always lists the main line first and sums to the earned value', () => {
  const s = scoreAnswer({
    ...quiz({ negativeMarking: true }),
    difficulty: 'hard', correct: false, usedPowerups: ['hint', 'extraTime'],
  });
  assert.equal(s.breakdown[0].label, 'Not this time');
  const sum = round2(s.breakdown.reduce((acc, b) => acc + b.value, 0));
  assert.equal(sum, s.earned, 'the chips add up to the total');
  assert.equal(s.earned, -(COSTS_DEFAULT.hint + 0 + NEGATIVE_DEFAULT), 'hard miss pays hint + negative');
});
