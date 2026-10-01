import test from 'node:test';
import assert from 'node:assert/strict';
import { scoreAnswer, comparePlayers, comparePlayersSelfPaced, hintsUsed, teamSummary, rankTeams, BASE_POINTS, POWERUP_COSTS } from '../../shared/scoring.js';

test('a correct answer always beats any wrong answer, whatever the speed', () => {
  const instant = scoreAnswer({ difficulty: 'medium', correct: true, timeLeftFraction: 1, streak: 0 });
  const lastSecond = scoreAnswer({ difficulty: 'medium', correct: true, timeLeftFraction: 0.001, streak: 0 });
  const instantWrong = scoreAnswer({ difficulty: 'medium', correct: true, timeLeftFraction: 1, streak: 0, usedPowerups: ['hint', 'fifty', 'extraTime'] });
  const wrong = scoreAnswer({ difficulty: 'medium', correct: false, timeLeftFraction: 1, streak: 0 });

  assert.equal(wrong.earned, 0);
  assert.ok(lastSecond.earned >= BASE_POINTS.medium, 'slow correct still gets the full base');
  assert.ok(instant.earned - lastSecond.earned <= BASE_POINTS.medium * 0.4 + 1, 'speed swing capped at 40%');
  // using every power-up cannot drag a correct answer below a wrong one
  assert.ok(instantWrong.earned > wrong.earned);
});

test('speed bonus is capped at 40% of base', () => {
  for (const difficulty of ['easy', 'medium', 'hard']) {
    const full = scoreAnswer({ difficulty, correct: true, timeLeftFraction: 1, streak: 0 });
    assert.ok(full.speed <= BASE_POINTS[difficulty] * 0.4 + 1);
    // base + speed + the first step of the streak ladder (+10 for answer #1)
    assert.equal(full.earned, BASE_POINTS[difficulty] + full.speed + 10);
    // answering slowly strips the speed bonus but keeps the base + streak step
    const slow = scoreAnswer({ difficulty, correct: true, timeLeftFraction: 0, streak: 0 });
    assert.equal(slow.earned, BASE_POINTS[difficulty] + 10);
  }
});

test('boss question pays more than a normal hard question', () => {
  const boss = scoreAnswer({ difficulty: 'hard', boss: true, correct: true, timeLeftFraction: 0, streak: 0 });
  const hard = scoreAnswer({ difficulty: 'hard', boss: false, correct: true, timeLeftFraction: 0, streak: 0 });
  assert.ok(boss.earned > hard.earned);
});

test('streak bonus is capped at 30', () => {
  const s = scoreAnswer({ difficulty: 'medium', correct: true, timeLeftFraction: 0, streak: 99 });
  assert.equal(s.streak, 30);
});

test('power-ups cost points but never push a score below zero', () => {
  const s = scoreAnswer({ difficulty: 'easy', correct: false, timeLeftFraction: 0, usedPowerups: ['hint', 'fifty'] });
  assert.equal(s.earned, 0);
  assert.equal(s.penalties, POWERUP_COSTS.hint + POWERUP_COSTS.fifty);

  const ok = scoreAnswer({ difficulty: 'easy', correct: true, timeLeftFraction: 0, usedPowerups: ['hint'] });
  assert.ok(ok.earned > 0);
});

test('refresher questions are worth slightly less', () => {
  const normal = scoreAnswer({ difficulty: 'medium', correct: true, timeLeftFraction: 0, streak: 0 });
  const refresh = scoreAnswer({ difficulty: 'medium', correct: true, timeLeftFraction: 0, streak: 0, refresher: true });
  assert.ok(refresh.earned < normal.earned);
  assert.ok(refresh.earned > 0);
});

test('match questions give partial credit, full for all pairs', () => {
  const all = scoreAnswer({ difficulty: 'medium', correct: true, timeLeftFraction: 0, matchCorrect: 3, matchTotal: 3 });
  const some = scoreAnswer({ difficulty: 'medium', correct: false, timeLeftFraction: 0, matchCorrect: 1, matchTotal: 3 });
  const none = scoreAnswer({ difficulty: 'medium', correct: false, timeLeftFraction: 0, matchCorrect: 0, matchTotal: 3 });
  assert.equal(all.earned, BASE_POINTS.medium + 10); // full base + first streak step
  assert.ok(some.earned > 0 && some.earned < BASE_POINTS.medium, 'partial credit stays below the full score');
  assert.equal(none.earned, 0);
});

test('timed out answers earn nothing', () => {
  const t = scoreAnswer({ difficulty: 'hard', correct: false, timedOut: true, timeLeftFraction: 0 });
  assert.equal(t.earned, 0);
});

test('ranking: score, then accuracy, then time', () => {
  const a = { score: 100, correct: 5, wrong: 5, totalTime: 1000 };
  const b = { score: 100, correct: 9, wrong: 1, totalTime: 5000 };
  const c = { score: 200, correct: 3, wrong: 7, totalTime: 100 };
  const ranked = [a, b, c].sort(comparePlayers);
  assert.equal(ranked[0], c);
  assert.equal(ranked[1], b); // better accuracy wins the tie
});

test('team summary aggregates the squad', () => {
  const t = teamSummary([
    { score: 100, correct: 4, wrong: 1 },
    { score: 50, correct: 2, wrong: 3 },
  ]);
  assert.equal(t.score, 150);
  assert.equal(t.correct, 6);
  assert.equal(t.wrong, 4);
  assert.equal(t.accuracy, 0.6);
});

test('rankTeams: member names, solo players stay out, fair tie-breaks', () => {
  const players = [
    { nickname: 'Ann', team: 'Pythons', score: 120, correct: 3, wrong: 1 },
    { nickname: 'Bo', team: 'Pythons', score: 80, correct: 2, wrong: 2 },
    { nickname: 'Cy', team: 'Cobras', score: 100, correct: 5, wrong: 0 },
    { nickname: 'Di', team: '', score: 300, correct: 6, wrong: 0 }, // solo: not a team
    { nickname: 'Ed', team: '  ', score: 90, correct: 1, wrong: 1 }, // blank = solo too
  ];

  const teams = rankTeams(players);
  assert.equal(teams.length, 2, 'only real teams are ranked - no fake Solo team');

  // Pythons (200) beat Cobras (100) on total
  assert.equal(teams[0].name, 'Pythons');
  assert.equal(teams[0].score, 200, 'team score is the sum of every member');
  assert.equal(teams[0].rank, 1);
  assert.deepEqual([...teams[0].members].sort(), ['Ann', 'Bo'], 'members are the nicknames');
  assert.equal(teams[0].size, 2);
  assert.equal(teams[0].avg, 100, 'average per member rounds to whole points');

  assert.equal(teams[1].name, 'Cobras');
  assert.equal(teams[1].score, 100);
  assert.equal(teams[1].avg, 100);
  assert.equal(teams[1].accuracy, 1, 'a perfect team shows 100% accuracy');

  // tie-breaks: equal total -> higher average wins
  const avgWins = rankTeams([
    { nickname: 'A', team: 'Few', score: 100, correct: 4, wrong: 0 },
    { nickname: 'B', team: 'Many', score: 50, correct: 2, wrong: 0 },
    { nickname: 'C', team: 'Many', score: 50, correct: 2, wrong: 0 },
  ]);
  assert.equal(avgWins[0].name, 'Few', 'equal totals: the smaller team per head ranks first');

  // equal total AND average -> accuracy decides
  const accWins = rankTeams([
    { nickname: 'A', team: 'Sharp', score: 100, correct: 4, wrong: 0 },
    { nickname: 'B', team: 'Lucky', score: 100, correct: 3, wrong: 1 },
  ]);
  assert.equal(accWins[0].name, 'Sharp', 'equal totals + average: better accuracy ranks first');

  // everything equal -> team name keeps the order deterministic
  const byName = rankTeams([
    { nickname: 'X', team: 'zebras', score: 50, correct: 2, wrong: 0 },
    { nickname: 'Y', team: 'Ants', score: 50, correct: 2, wrong: 0 },
  ]);
  assert.deepEqual(byName.map((t) => t.name), ['Ants', 'zebras'], 'a dead tie falls back to the name');

  // shuffled input always yields the same order
  const shuffled = rankTeams([...players].reverse());
  assert.deepEqual(shuffled.map((t) => t.name), teams.map((t) => t.name), 'input order never changes the ranking');
});

test('self-paced ranking: score, then fewer hints, then earlier finish', () => {
  const mk = (score, hints, finishedAt, totalTime = 0) => ({
    score, correct: 4, wrong: 0, finishedAt, totalTime,
    powerupsUsed: Array.from({ length: hints }, () => ({ kind: 'hint' })),
  });
  const ranked = [mk(100, 1, 3000), mk(100, 0, 9000), mk(100, 0, 1000), mk(150, 3, null)]
    .sort(comparePlayersSelfPaced);
  assert.equal(ranked[0].score, 150, 'the best score leads even with hints spent');
  assert.equal(ranked[1].finishedAt, 1000, 'equal score: no hints + finished earliest');
  assert.equal(ranked[2].finishedAt, 9000, 'same score and hints: later finish ranks lower');
  assert.equal(ranked[3].finishedAt, 3000, 'using hints drops you below the no-hint pair');

  const tie = [mk(100, 0, null), mk(100, 0, 5000)].sort(comparePlayersSelfPaced);
  assert.equal(tie[0].finishedAt, 5000, 'finishing beats still working on it');
  assert.equal(tie[1].finishedAt, null, 'unfinished sorts last');

  assert.equal(hintsUsed({ powerupsUsed: [{ kind: 'hint' }, { kind: 'fifty' }] }), 1);
  assert.equal(hintsUsed({}), 0);
});

test('no speed bonus when the question timer is off', () => {
  const s = scoreAnswer({ difficulty: 'medium', correct: true, timeLeftFraction: 0, streak: 0 });
  assert.ok(!s.breakdown.some((b) => b.label === 'Speed bonus'), 'clock off = no speed line');
  assert.equal(s.speed, 0);
  assert.ok(s.earned >= BASE_POINTS.medium, 'the full base still pays out');
});
