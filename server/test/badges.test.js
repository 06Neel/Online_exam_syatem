import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateBadges, badgeById, BADGES, TOPIC_BADGES } from '../../shared/badges.js';

const ev = (over = {}) => ({
  id: 'x', unit: 1, type: 'mcq', difficulty: 'easy', boss: false,
  correct: true, refresher: false, timeLeftFraction: 0.5, streak: 1,
  miniPresented: false, miniCorrect: false, usedPowerups: [], ...over,
});

test('every badge id resolves to a name and icon', () => {
  for (const b of [...BADGES, ...Object.values(TOPIC_BADGES)]) {
    const found = badgeById(b.id);
    assert.equal(found.id, b.id);
    assert.ok(found.icon && found.name && found.desc);
  }
});

test('On Fire at a streak of 5', () => {
  const events = Array.from({ length: 5 }, (_, i) => ev({ streak: i + 1 }));
  assert.ok(evaluateBadges(events).includes('on_fire'));
  assert.ok(!evaluateBadges(events.slice(0, 4)).includes('on_fire'));
});

test('Bug Hunter needs 3 correct spot-the-error questions', () => {
  const events = Array.from({ length: 3 }, () => ev({ type: 'spot-error' }));
  assert.ok(evaluateBadges(events).includes('bug_hunter'));
  assert.ok(!evaluateBadges(events.slice(0, 2)).includes('bug_hunter'));
});

test('Comeback Kid: 2 wrong then 3 right', () => {
  const events = [
    ev({ correct: false }), ev({ correct: false }),
    ev(), ev(), ev(),
  ];
  assert.ok(evaluateBadges(events).includes('comeback_kid'));
  assert.ok(!evaluateBadges(events.slice(0, 4)).includes('comeback_kid'));
});

test('Boss Slayer on a correct boss answer', () => {
  assert.ok(evaluateBadges([ev({ boss: true })]).includes('boss_slayer'));
  assert.ok(!evaluateBadges([ev({ boss: true, correct: false })]).includes('boss_slayer'));
});

test('Speedy Coder needs 5 fast correct answers', () => {
  const fast = Array.from({ length: 5 }, () => ev({ timeLeftFraction: 0.9 }));
  assert.ok(evaluateBadges(fast).includes('speed_demon'));
  const slow = Array.from({ length: 9 }, () => ev({ timeLeftFraction: 0.3 }));
  assert.ok(!evaluateBadges(slow).includes('speed_demon'));
});

test('topic badge at 80% with at least 4 questions', () => {
  const good = Array.from({ length: 5 }, (_, i) => ev({ unit: 4, correct: i !== 0 }));
  assert.ok(evaluateBadges(good).includes('loop_master'));
  const tooFew = Array.from({ length: 3 }, () => ev({ unit: 4 }));
  assert.ok(!evaluateBadges(tooFew).includes('loop_master'));
});

test('Sharpshooter is a perfect level (non-refresher only)', () => {
  const perfect = Array.from({ length: 3 }, () => ev({ unit: 6 }));
  assert.ok(evaluateBadges(perfect).includes('sharpshooter'));
  const withRefresherMiss = [...Array.from({ length: 3 }, () => ev({ unit: 6 })), ev({ unit: 6, refresher: true, correct: false })];
  assert.ok(evaluateBadges(withRefresherMiss).includes('sharpshooter'), 'refresher misses do not spoil the level');
});

test('Perseverance when every try-again mini is nailed (3+)', () => {
  const events = Array.from({ length: 3 }, () => ev({ correct: false, miniPresented: true, miniCorrect: true }));
  assert.ok(evaluateBadges(events).includes('perseverance'));
  const slip = events.map((e, i) => (i === 1 ? { ...e, miniCorrect: false } : e));
  assert.ok(!evaluateBadges(slip).includes('perseverance'));
});

test('Trailblazer only when the run is finished', () => {
  assert.ok(evaluateBadges([ev()], { finished: true }).includes('trailblazer'));
  assert.ok(!evaluateBadges([ev()]).includes('trailblazer'));
});
