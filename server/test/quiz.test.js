import test from 'node:test';
import assert from 'node:assert/strict';
import { loadBank } from '../../questions/validate.mjs';
import { buildQuiz, chooseRefreshers, shuffleOptions, timerFor, strengthMap, BAND_INFO } from '../../shared/quiz.js';
import { scoreAnswer, BASE_POINTS, BOSS_POINTS } from '../../shared/scoring.js';

const bank = loadBank();

test('a quiz is built across levels with the boss question last in each level', () => {
  const quiz = buildQuiz({ bank, units: [1, 2], count: 8, seed: 'abc' });
  assert.ok(quiz.length >= 4);
  const units = quiz.map((q) => q.unit);
  assert.deepEqual([...units].sort((a, b) => a - b), units, 'levels run in order');

  // each unit present ends with its boss question
  for (const unit of [1, 2]) {
    const inUnit = quiz.filter((q) => q.unit === unit);
    const last = inUnit[inUnit.length - 1];
    assert.equal(last.boss, true, `unit ${unit} should end with a boss`);
    assert.ok(inUnit.slice(0, -1).every((q) => !q.boss), 'bosses never appear mid-level');
  }
});

test('the same seed gives the same question order (fair for the whole class)', () => {
  const a = buildQuiz({ bank, count: 15, seed: 'class-7' }).map((q) => q.id);
  const b = buildQuiz({ bank, count: 15, seed: 'class-7' }).map((q) => q.id);
  assert.deepEqual(a, b);
  const c = buildQuiz({ bank, count: 15, seed: 'class-8' }).map((q) => q.id);
  assert.notDeepEqual(a, c, 'a different seed shakes things up');
});

test('count is respected and never repeats a question', () => {
  for (const count of [4, 7, 20, 84]) {
    const quiz = buildQuiz({ bank, count, seed: `n${count}` });
    const ids = quiz.map((q) => q.id);
    assert.equal(new Set(ids).size, ids.length, 'no duplicate questions');
    assert.ok(quiz.length >= Math.min(count, 7), 'at least one per selected level');
    assert.ok(quiz.length <= count + 7, 'never wildly over the request');
  }
});

test('difficulty filter still returns questions', () => {
  const quiz = buildQuiz({ bank, units: [4], count: 6, difficulty: 'easy', seed: 'd' });
  assert.ok(quiz.length > 0);
  assert.ok(quiz.every((q) => q.difficulty === 'easy' || q.boss));
});

test('options are shuffled per player but answer ids stay valid', () => {
  const q = bank.find((x) => x.options?.length === 4);
  const mine = shuffleOptions(q, 'player-a');
  const mineAgain = shuffleOptions(q, 'player-a');
  const theirs = shuffleOptions(q, 'player-b');
  assert.equal(mine.options.length, 4);
  assert.deepEqual([...mine.options].map((o) => o.id).sort(), ['a', 'b', 'c', 'd']);
  assert.ok(mine.answer.every((id) => mine.options.some((o) => o.id === id)));
  const ids = (x) => x.options.map((o) => o.id).join('');
  assert.equal(ids(mine), ids(mineAgain), 'same player seed -> same order (deterministic)');
  assert.ok(mine.answer.every((id) => theirs.options.some((o) => o.id === id)),
    'a different order still keeps the answer valid');
});

test('refreshers prefer the learner own earlier mistakes', () => {
  const events = [
    { id: 'u2-q01', unit: 2, correct: false, refresher: false, type: 'mcq' },
    { id: 'u3-q05', unit: 3, correct: false, refresher: false, type: 'mcq' },
    { id: 'u1-q02', unit: 1, correct: true, refresher: false, type: 'mcq' },
  ];
  const picks = chooseRefreshers({ bank, events, currentUnit: 4, seen: new Set(), limit: 2, seed: 'r' });
  assert.ok(picks.length > 0 && picks.length <= 2);
  assert.ok(picks.every((q) => q.unit < 4), 'refresher comes from earlier levels');
  assert.ok(picks.some((q) => q.id === 'u2-q01' || q.id === 'u3-q05'), 'own misses come back');
  assert.ok(picks.every((q) => !q.boss), 'bosses are never used as refreshers');
});

test('refresher avoids questions already in the run', () => {
  const seen = new Set(bank.map((q) => q.id).slice(0, 40));
  const picks = chooseRefreshers({ bank, events: [], currentUnit: 5, seen, limit: 2, seed: 'r2' });
  picks.forEach((q) => assert.ok(!seen.has(q.id)));
});

test('strength map bands match the published thresholds', () => {
  const events = [];
  for (let i = 0; i < 5; i++) events.push({ unit: 1, correct: true, refresher: false });
  for (let i = 0; i < 5; i++) events.push({ unit: 2, correct: i < 3, refresher: false });
  for (let i = 0; i < 5; i++) events.push({ unit: 3, correct: i < 2, refresher: false });
  events.push({ unit: 4, correct: false, refresher: true });

  const map = strengthMap(events);
  assert.equal(map['1'].band, 'strong');
  assert.equal(map['2'].band, 'revise');
  assert.equal(map['3'].band, 'practice');
  assert.equal(map['4'], undefined, 'refresher answers do not affect the map');
  assert.equal(BAND_INFO[map['1'].band].icon, '🟢');
});

test('timers are relaxed and bosses get extra time', () => {
  assert.equal(timerFor({ difficulty: 'easy' }), 30);
  assert.equal(timerFor({ difficulty: 'medium' }), 40);
  assert.equal(timerFor({ difficulty: 'hard' }), 50);
  assert.equal(timerFor({ difficulty: 'medium', boss: true }), 50);
  assert.equal(timerFor({ difficulty: 'easy' }, { easy: 25 }), 25);
});

test('question timer: per-question timeLimit, then one common clock, then defaults', () => {
  assert.equal(timerFor({ difficulty: 'medium' }, {}, 60), 60, 'the common clock replaces the defaults');
  assert.equal(timerFor({ difficulty: 'medium', boss: true }, {}, 60), 60, 'a common clock has no boss extra');
  assert.equal(timerFor({ difficulty: 'medium', timeLimit: 45 }, {}, 60), 45, 'a question can set its own seconds');
  assert.equal(timerFor({ difficulty: 'medium', timeLimit: 999 }, {}, null), 300, 'timeLimit is clamped to 300');
  assert.equal(timerFor({ difficulty: 'medium', timeLimit: 0 }, {}, null), 40, 'timeLimit 0 means unset');
  assert.equal(timerFor({ difficulty: 'easy' }, {}, null), 30, 'no common clock keeps the classic defaults');
});

test('per-quiz point overrides replace the base scores', () => {
  const base = scoreAnswer({ difficulty: 'easy', correct: true, timeLeftFraction: 0, streak: 0 });
  assert.equal(base.base, BASE_POINTS.easy, 'no override = the published table');

  const custom = scoreAnswer({
    difficulty: 'easy', correct: true, timeLeftFraction: 0, streak: 0,
    points: { easy: 111, medium: 112, hard: 113, boss: 114 },
  });
  assert.equal(custom.base, 111);
  assert.ok(custom.earned >= 111, 'streak and speed add on top of the custom base');

  const boss = scoreAnswer({
    difficulty: 'hard', boss: true, correct: true, timeLeftFraction: 0, streak: 0,
    points: { hard: 113, boss: 114 },
  });
  assert.equal(boss.base, 114);
  assert.equal(scoreAnswer({ difficulty: 'hard', boss: true, correct: true, streak: 0 }).base, BOSS_POINTS);
});
