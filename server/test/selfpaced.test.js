// Question timer OFF: self-paced play, mid-run timer flips, paced options, whole-quiz limit.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { io as connect } from 'socket.io-client';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 3213;
const URL = `http://localhost:${PORT}`;
// everything this run writes lives here - the real server/data is never touched
const DATA_DIR = join(ROOT, 'server', 'data', 'selfpaced-test');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');

let server;
const sockets = [];

function emitAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`ack timeout: ${event}`)), 8000);
    socket.timeout(7000).emit(event, payload, (err, res) => {
      clearTimeout(t);
      err ? reject(err) : resolve(res);
    });
  });
}

function waitEvent(socket, event, ms = 8000, predicate = () => true) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, ms);
    const handler = (payload) => {
      if (!predicate(payload)) return;
      clearTimeout(t);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const SEED_ID = 'pace-teacher';
const SEED_PW = 'pace-pass-123';
let teacherToken = '';

async function signIn(id, password) {
  const r = await fetch(`${URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, password }),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
}

function answerFor(q) {
  if (q.type === 'fill-blank') return q.accepted[0];
  if (q.type === 'match') return Object.fromEntries(q.pairs.map((p, i) => [i, p.right]));
  return q.options[0].id; // may be wrong - the flow does not care
}

async function newSocket() {
  const s = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(s);
  await new Promise((r) => s.on('connect', r));
  return s;
}

async function createSession(extra = {}) {
  const host = await newSocket();
  const created = await emitAck(host, 'host:create', {
    token: teacherToken,
    title: 'Timer off run', units: [1], count: 4, difficulty: 'easy',
    revealSeconds: 3, ...extra,
  });
  assert.ok(created.ok, created.error || 'session created');
  return { host, code: created.code, config: created.config };
}

test.before(async () => {
  rmSync(DATA_DIR, { recursive: true, force: true });
  server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      DATABASE_URL: '',   // tests run file-only - never mirror into a real database
      PORT: String(PORT),
      NODE_ENV: 'test',
      DATA_DIR,
      PA_SESSIONS_DIR: SESSIONS_DIR,
      SEED_TEACHER_ID: SEED_ID,
      SEED_TEACHER_PASSWORD: SEED_PW,
      ADMIN_PASSWORD: 'admin-test-secret',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(d));

  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${URL}/api/health`);
      if (r.ok) break;
    } catch { /* not up yet */ }
    await wait(250);
  }

  const session = await signIn(SEED_ID, SEED_PW);
  if (!session.ok) throw new Error(`seed teacher could not sign in: ${session.error}`);
  teacherToken = session.token;
});

test.after(() => {
  sockets.forEach((s) => { try { s.close(); } catch { /* already closed */ } });
  try { server?.stderr?.destroy(); server?.stdout?.destroy(); } catch { /* already closed */ }
  server?.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

test('self-paced run: personal questions, own navigation, teacher watches progress', async () => {
  const { host, code, config } = await createSession({
    timerOn: false, allowBack: true, allowSkip: true,
  });
  assert.equal(config.timerOn, false, 'the switch was saved');
  assert.equal(config.allowBack, true);
  assert.equal(config.allowSkip, true);

  const a = await newSocket();
  const b = await newSocket();

  const rosterTwo = waitEvent(host, 'roster', 8000, (p) => p.players?.length === 2);
  const joinA = await emitAck(a, 'player:join', { code, nickname: 'Alpha' });
  const joinB = await emitAck(b, 'player:join', { code, nickname: 'Bravo' });
  assert.ok(joinA.ok && joinB.ok);
  // the join contract every student screen reads
  assert.equal(joinA.timerOn, false);
  assert.equal(joinA.allowBack, true);
  assert.equal(joinA.allowSkip, true);
  assert.equal(joinA.quizEndsAt, null);
  const lobbyRoster = await rosterTwo;
  assert.equal(lobbyRoster.timerOn, false, 'roster carries the switch');
  assert.equal(lobbyRoster.selfPaced, false, 'nobody is on a question yet');

  // start: both students get their own untimed question
  const startedRoster = waitEvent(host, 'roster', 8000, (p) => p.selfPaced === true);
  const qA = waitEvent(a, 'question:start');
  const qB = waitEvent(b, 'question:start');
  const started = await emitAck(host, 'host:start');
  assert.ok(started.ok);
  const firstA = await qA;
  const firstB = await qB;
  for (const q of [firstA, firstB]) {
    assert.equal(q.qIndex, 0);
    assert.equal(q.selfPaced, true, 'the question says it is self-paced');
    assert.equal(q.duration, null, 'no countdown');
    assert.equal(q.endsAt, null, 'no deadline');
    assert.equal(q.quizEndsAt, null, 'no whole-quiz limit was set');
    assert.equal(q.allowBack, true);
    assert.equal(q.allowSkip, true);
    assert.ok(!('answer' in q.question), 'the live question is stripped of its answer');
  }
  assert.equal((await startedRoster).selfPaced, true);

  // shared-clock teacher controls are refused while the timer is off
  const nextTry = await emitAck(host, 'host:control', { action: 'next' });
  assert.match(nextTry.error, /own pace/, 'teacher cannot drive the class');
  const extendTry = await emitAck(host, 'host:control', { action: 'extend', seconds: 10 });
  assert.match(extendTry.error, /countdown/, 'nothing to extend');
  const showTry = await emitAck(host, 'host:control', { action: 'show-answer' });
  assert.match(showTry.error, /own pace/, 'students review on their own clock');

  // Alpha walks the whole quiz at their own speed
  const res0 = await emitAck(a, 'player:answer', { qIndex: 0, answer: answerFor(firstA.question) });
  assert.ok(res0.ok, res0.error);
  assert.ok(Array.isArray(res0.result.breakdown));
  assert.ok(!res0.result.breakdown.some((x) => x.label === 'Speed bonus'),
    'no speed bonus without a countdown');

  const toOne = waitEvent(a, 'question:start', 8000, (p) => p.qIndex === 1);
  assert.ok((await emitAck(a, 'player:advance')).ok);
  const qAtOne = await toOne;
  assert.equal(qAtOne.review, null, 'a fresh question comes with no review');

  // Bravo is still on question 0 - the teacher sees them apart
  const splitRoster = waitEvent(host, 'roster', 8000,
    (p) => p.players.find((x) => x.nickname === 'Alpha')?.qIndex === 1
      && p.players.find((x) => x.nickname === 'Bravo')?.qIndex === 0);
  await emitAck(b, 'player:answer', { qIndex: 0, answer: answerFor(firstB.question) });
  await splitRoster;

  // Alpha skips Q1 and runs forward
  const toTwo = waitEvent(a, 'question:start', 8000, (p) => p.qIndex === 2);
  const skip = await emitAck(a, 'player:advance', { skip: true });
  assert.ok(skip.ok, skip.error);
  const qAtTwo = await toTwo;
  assert.ok((await emitAck(a, 'player:answer', { qIndex: 2, answer: answerFor(qAtTwo.question) })).ok);

  const toThree = waitEvent(a, 'question:start', 8000, (p) => p.qIndex === 3);
  assert.ok((await emitAck(a, 'player:advance')).ok);
  const qAtThree = await toThree;
  assert.ok((await emitAck(a, 'player:answer', { qIndex: 3, answer: answerFor(qAtThree.question) })).ok);

  // wrap: Q1 was skipped, so Next sends Alpha back to it
  const wrap = waitEvent(a, 'question:start', 8000, (p) => p.qIndex === 1);
  assert.ok((await emitAck(a, 'player:advance')).ok);
  const backAt = await wrap;
  assert.equal(backAt.review, null, 'the skipped question is fresh, not a review');

  const alphaDone = waitEvent(a, 'player:finished', 8000, (p) => p.playerId === joinA.playerId);
  const alphaRosterDone = waitEvent(host, 'roster', 8000,
    (p) => p.players.find((x) => x.nickname === 'Alpha')?.finished === true);
  assert.ok((await emitAck(a, 'player:answer', { qIndex: 1, answer: answerFor(backAt.question) })).ok);
  assert.ok((await emitAck(a, 'player:advance')).ok);
  const finA = await alphaDone;
  assert.equal(finA.answered, 4, 'every question of the run was recorded');
  await alphaRosterDone;

  // Bravo moves on, then goes back to review the answered question (allowBack)
  const bTo1 = waitEvent(b, 'question:start', 8000, (p) => p.qIndex === 1);
  assert.ok((await emitAck(b, 'player:advance')).ok);
  const bq1 = await bTo1;

  const review = waitEvent(b, 'question:start', 8000, (p) => p.qIndex === 0 && !!p.review);
  const back = await emitAck(b, 'player:goto', { qIndex: 0 });
  assert.ok(back.ok, back.error);
  assert.equal(back.review, true, 'an answered question comes back as read-only');
  const reviewQ = await review;
  assert.equal(typeof reviewQ.review.correct, 'boolean');
  assert.ok('correctAnswer' in reviewQ.review, 'the review shows the right answer');

  // Next from the review jumps to the next unattempted question
  const bBackTo1 = waitEvent(b, 'question:start', 8000, (p) => p.qIndex === 1);
  assert.ok((await emitAck(b, 'player:advance')).ok);
  await bBackTo1;

  assert.ok((await emitAck(b, 'player:answer', { qIndex: 1, answer: answerFor(bq1.question) })).ok);
  const bTo2 = waitEvent(b, 'question:start', 8000, (p) => p.qIndex === 2);
  assert.ok((await emitAck(b, 'player:advance')).ok);
  const bq2 = await bTo2;
  assert.ok((await emitAck(b, 'player:answer', { qIndex: 2, answer: answerFor(bq2.question) })).ok);

  const bTo3 = waitEvent(b, 'question:start', 8000, (p) => p.qIndex === 3);
  assert.ok((await emitAck(b, 'player:advance')).ok);
  const bq3 = await bTo3;
  assert.ok((await emitAck(b, 'player:answer', { qIndex: 3, answer: answerFor(bq3.question) })).ok);

  const bravoDone = waitEvent(b, 'player:finished', 8000, (p) => p.playerId === joinB.playerId);
  assert.ok((await emitAck(b, 'player:advance')).ok);
  await bravoDone;

  // the teacher ends it and gets a paced-aware report
  const ended = await emitAck(host, 'host:control', { action: 'end' });
  assert.ok(ended.ok);
  const report = ended.report;
  assert.equal(report.code, code);
  assert.equal(report.config.timerOn, false, 'the report remembers the mode');
  assert.equal(report.config.allowBack, true);
  assert.equal(report.players.length, 2);
  for (const p of report.players) {
    assert.equal(p.finished, true, `${p.nickname} finished`);
    assert.equal(typeof p.finishedAt, 'number');
    assert.equal(p.answerTimes.length, 4);
    assert.ok(p.answerTimes.every((t) => typeof t === 'number'), 'time kept for every question');
    assert.equal(p.log.length, 4);
    assert.ok(p.log.every((e) => typeof e.qIndex === 'number' && typeof e.timeMs === 'number'),
      'each log entry knows which question and how long');
  }
  assert.equal(report.totals.answers, 8);

  // and it is fetchable over HTTP like any other report
  const httpReport = await fetch(`${URL}/api/sessions/${code}/report`, {
    headers: { 'x-teacher-token': teacherToken },
  });
  assert.equal(httpReport.status, 200);
  assert.equal((await httpReport.json()).config.timerOn, false);
});

test('flipping the timer mid-run: shared clock now, self-paced from the next question', async () => {
  const { host, code } = await createSession({ timerOn: true, count: 3 }); // ON is the default
  const a = await newSocket();
  const join = await emitAck(a, 'player:join', { code, nickname: 'Flip' });
  assert.ok(join.ok, join.error);
  assert.equal(join.timerOn, true);

  const q0 = waitEvent(a, 'question:start');
  assert.ok((await emitAck(host, 'host:start')).ok);
  const first = await q0;
  assert.equal(first.selfPaced, false, 'the classic shared clock by default');
  assert.equal(typeof first.duration, 'number');
  assert.equal(typeof first.endsAt, 'number');

  // flip OFF mid-question: the switch bites from the next one
  const ctrlOff = waitEvent(a, 'control', 8000,
    (p) => p.action === 'timer-changed' && p.timerOn === false);
  const off = await emitAck(host, 'host:control', { action: 'timer', on: false });
  assert.ok(off.ok, off.error);
  assert.equal(off.timerOn, false);
  assert.equal(off.effective, 'next question', 'this question keeps its mode');
  assert.equal((await ctrlOff).effective, 'next question');

  // students still cannot drive themselves through the shared question
  const advTry = await emitAck(a, 'player:advance');
  assert.match(advTry.error, /whole class/, 'the running question stays lockstep');

  // Alpha answers, the shared reveal still fires, and the NEXT question is paced
  assert.ok((await emitAck(a, 'player:answer', { qIndex: 0, answer: answerFor(first.question) })).ok);
  const paced = await waitEvent(a, 'question:start', 15000, (p) => p.qIndex === 1);
  assert.equal(paced.selfPaced, true, 'the flip took effect on the next question');
  assert.equal(paced.duration, null);

  // flip back ON: the class re-syncs on the frontier with a fresh countdown
  const resync = waitEvent(a, 'question:start', 8000, (p) => p.qIndex === 1 && p.selfPaced === false);
  const on = await emitAck(host, 'host:control', { action: 'timer', on: true });
  assert.ok(on.ok, on.error);
  assert.equal(on.effective, 'now');
  const lock = await resync;
  assert.equal(typeof lock.duration, 'number', 'the countdown is back');

  // shared controls work again while the lockstep question is up
  const ext = await emitAck(host, 'host:control', { action: 'extend', seconds: 10 });
  assert.ok(ext.ok, ext.error);

  // flip OFF again, then the teacher can still reveal and advance THIS question
  const off2 = await emitAck(host, 'host:control', { action: 'timer', on: false });
  assert.ok(off2.ok, off2.error);
  assert.equal(off2.effective, 'next question');
  const reveal = waitEvent(a, 'question:reveal', 10000, (p) => p.qIndex === 1);
  const shown = await emitAck(host, 'host:control', { action: 'next' });
  assert.ok(!shown.error, shown.error || 'teacher can reveal the on-screen shared question');
  await reveal;

  const q2 = waitEvent(a, 'question:start', 8000, (p) => p.qIndex === 2);
  const advanced = await emitAck(host, 'host:control', { action: 'next' });
  assert.ok(!advanced.error, advanced.error || 'reveal advances into the paced question');
  const afterFlip = await q2;
  assert.equal(afterFlip.selfPaced, true, 'paced again after the reveal');

  const ended = await emitAck(host, 'host:control', { action: 'end' });
  assert.ok(ended.ok);
  assert.equal(ended.report.config.timerOn, false, 'the final mode is in the report');
});

test('lobby flip and the paced options: no back, no skip', async () => {
  // created with the default ON, then switched off before the first question
  const { host, code } = await createSession({ allowBack: false, allowSkip: false });
  const lobbyFlip = await emitAck(host, 'host:control', { action: 'timer', on: false });
  assert.ok(lobbyFlip.ok, lobbyFlip.error);
  assert.equal(lobbyFlip.effective, 'now', 'nothing is running yet');

  const a = await newSocket();
  const join = await emitAck(a, 'player:join', { code, nickname: 'Solo' });
  assert.ok(join.ok, join.error);
  assert.equal(join.timerOn, false, 'the switch was already off at join time');

  const q0 = waitEvent(a, 'question:start');
  assert.ok((await emitAck(host, 'host:start')).ok);
  const first = await q0;
  assert.equal(first.selfPaced, true, 'the lobby flip carried into the first question');
  assert.equal(first.allowBack, false);
  assert.equal(first.allowSkip, false);

  // Next needs an answer first
  const needAnswer = await emitAck(a, 'player:advance');
  assert.match(needAnswer.error, /Answer this question first/);

  // Skip is switched off for this quiz
  const noSkip = await emitAck(a, 'player:advance', { skip: true });
  assert.match(noSkip.error, /Skipping is turned off/);

  // Going back is switched off too
  const noBack = await emitAck(a, 'player:goto', { qIndex: 0 });
  assert.match(noBack.error, /Going back is turned off/);

  // Answering opens the door to Next
  assert.ok((await emitAck(a, 'player:answer', { qIndex: 0, answer: answerFor(first.question) })).ok);
  const toOne = waitEvent(a, 'question:start', 8000, (p) => p.qIndex === 1);
  assert.ok((await emitAck(a, 'player:advance')).ok);
  assert.equal((await toOne).qIndex, 1);

  assert.ok((await emitAck(host, 'host:control', { action: 'end' })).ok);
});

test('the whole-quiz limit ends a self-paced run on time', async () => {
  const { host, code, config } = await createSession({ timerOn: false, quizSeconds: 10 });
  assert.equal(config.quizSeconds, 10, 'the limit was saved');

  const a = await newSocket();
  const join = await emitAck(a, 'player:join', { code, nickname: 'Clock' });
  assert.ok(join.ok, join.error);

  const hostEnd = waitEvent(host, 'quiz:end', 15000);
  const studentEnd = waitEvent(a, 'quiz:end', 15000);
  const q0 = waitEvent(a, 'question:start');
  assert.ok((await emitAck(host, 'host:start')).ok);
  const first = await q0;
  assert.equal(first.selfPaced, true);
  assert.equal(typeof first.quizEndsAt, 'number');
  assert.ok(first.quizEndsAt > Date.now(), 'a deadline is handed to the student');

  const report = (await hostEnd).report;
  assert.equal(report.config.quizSeconds, 10);
  assert.equal(report.config.timerOn, false);
  assert.equal(report.players.length, 1);
  assert.equal(report.players[0].finished, false, 'the clock ended the run before the student finished');
  assert.equal(report.players[0].answerTimes.length, 4);
  assert.ok(report.players[0].answerTimes.every((t) => t === null), 'nothing was answered');
  await studentEnd;
});
