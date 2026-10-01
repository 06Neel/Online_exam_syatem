// End-to-end practice mode: real HTTP server + the client-side LocalEngine.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 3198;
const URL = `http://localhost:${PORT}`;
// everything this run writes lives here - the real server/data is never touched
const DATA_DIR = join(ROOT, 'server', 'data', 'practice-test');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');
globalThis.__API_BASE__ = URL;

let server;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test.before(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: 'test', DATA_DIR, PA_SESSIONS_DIR: SESSIONS_DIR },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${URL}/api/health`);
      if (r.ok) return;
    } catch { /* booting */ }
    await wait(250);
  }
  throw new Error('server did not start');
});

test.after(() => {
  try { server?.stderr?.destroy(); server?.stdout?.destroy(); } catch { /* already closed */ }
  server?.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

function answerFor(q) {
  if (q.type === 'fill-blank') return q.accepted[0];
  if (q.type === 'match') return Object.fromEntries(q.pairs.map((p, i) => [i, p.right]));
  return [...q.answer]; // always the right answer
}

test('a full practice run scores, revises and reports', async () => {
  const { LocalEngine } = await import('../../client/src/game/localEngine.js');

  const engine = new LocalEngine({ units: [1, 2], count: 8, difficulty: 'mixed' });
  await engine.init();
  assert.ok(engine.questions.length >= 4, 'questions were fetched');
  assert.ok(engine.questions[0].explanation, 'practice questions include explanations');
  assert.ok(engine.pool.length >= 24, 'the pool covers both units for revision');

  const seenQuestions = [];
  engine.on('question', (p) => seenQuestions.push(p));
  engine.start();
  assert.equal(seenQuestions.length, 1, 'first question presented');

  let guard = 0;
  while (!engine.finished && guard++ < 40) {
    const payload = seenQuestions[seenQuestions.length - 1];
    const q = payload.question;

    // mix in a wrong answer on the first question so revision has something to chew on
    const answer = guard === 1 && q.options
      ? [q.options.find((o) => !q.answer.includes(o.id)).id]
      : answerFor(q);

    const { result, error } = await engine.submit(answer);
    assert.ok(!error, error);
    assert.ok(typeof result.earned === 'number');
    assert.ok(result.explanation, 'every answer returns an explanation');
    assert.ok(result.analogy, 'every answer returns an analogy');
    if (!result.correct) {
      assert.ok(result.mini, 'a wrong answer offers the try-again mini question');
      const mini = await engine.mini(true);
      assert.equal(mini.earned, 10, 'nailing the mini gives a consolation +10');
    } else {
      assert.ok(result.earned > 0, 'correct answers pay out');
    }

    engine.advance();
    if (!engine.finished) assert.equal(seenQuestions.length, engine.index + 1, 'next question presented');
  }

  assert.ok(engine.finished, 'the run finished');
  assert.ok(engine.player.correct + engine.player.wrong >= 8, 'every question was recorded');

  const report = engine.buildReport();
  assert.equal(report.mode, 'practice');
  assert.equal(report.players.length, 1);
  const me = report.players[0];
  assert.ok(me.accuracy >= 0 && me.accuracy <= 1);
  assert.ok(Object.keys(me.unitStats).length >= 1, 'strength map has entries');
  for (const s of Object.values(me.unitStats)) {
    assert.ok(['strong', 'revise', 'practice'].includes(s.band));
  }
  assert.ok(Array.isArray(me.badges), 'badges come back as ids');
});

test('power-ups work in practice mode and cost points', async () => {
  const { LocalEngine } = await import('../../client/src/game/localEngine.js');
  const engine = new LocalEngine({ units: [5], count: 4, difficulty: 'easy' });
  await engine.init();
  const seen = [];
  engine.on('question', (p) => seen.push(p));
  engine.start();

  const hint = await engine.powerup('hint');
  assert.ok(hint.ok, hint.error);
  assert.equal(hint.cost, 15);
  assert.ok(hint.hint.length > 5);

  const q = seen[0].question;
  if (q.options && q.answer.length === 1) {
    const fifty = await engine.powerup('fifty');
    assert.ok(fifty.ok, fifty.error);
    assert.equal(fifty.remove.length, 2);
  }

  const extra = await engine.powerup('extraTime');
  assert.ok(extra.ok, extra.error);
  assert.equal(extra.extraMs, 10000);

  const { result } = await engine.submit(answerFor(q));
  const labels = result.breakdown.map((b) => b.label).join('|');
  assert.match(labels, /Hint/, 'the hint cost shows up in the breakdown');
  assert.ok(result.earned > 0, 'still scores after the costs');
});

test('practice with the question timer off runs at the student\'s own pace', async () => {
  const { LocalEngine } = await import('../../client/src/game/localEngine.js');
  const engine = new LocalEngine({ units: [1], count: 4, difficulty: 'easy', timerOn: false });
  await engine.init();
  const seen = [];
  engine.on('question', (p) => seen.push(p));
  engine.start();

  assert.equal(engine.paced, true);
  assert.equal(seen[0].duration, null, 'no countdown is handed to the screen');
  assert.equal(seen[0].endsAt, null);
  assert.equal(seen[0].selfPaced, true);

  const extra = await engine.powerup('extraTime');
  assert.ok(extra.error, 'extra time is refused without a countdown');

  let guard = 0;
  while (!engine.finished && guard++ < 20) {
    const payload = seen[seen.length - 1];
    const { result, error } = await engine.submit(answerFor(payload.question));
    assert.ok(!error, error);
    const labels = (result.breakdown || []).map((b) => b.label);
    assert.ok(!labels.includes('Speed bonus'), 'no speed bonus while pacing');
    engine.advance();
  }
  assert.ok(engine.finished, 'the paced run finished');
  assert.ok(engine.player.correct + engine.player.wrong >= 4, 'every question was recorded');

  const report = engine.buildReport();
  assert.equal(report.mode, 'practice');
  assert.equal(report.players.length, 1);
  assert.ok(report.players[0].accuracy >= 0 && report.players[0].accuracy <= 1);
});
