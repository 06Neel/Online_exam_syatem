// Session resilience: the quiz survives teacher disconnects, several dashboards
// can drive one run (stale clicks are refused, pause is idempotent), and a
// student who drops off takes their seat - and score - back.
//
//   (a) host disconnect -> quiz keeps running, a second device host:join controls it
//   (b) host:count tracks every dashboard, stale controls answer {stale:true},
//       double pause never flips the quiz back to running
//   (f) student disconnect -> rejoin with the same nickname -> same player/score
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { io as connect } from 'socket.io-client';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 3216;
const URL = `http://localhost:${PORT}`;
// everything this run writes lives here - the real server/data is never touched
const DATA_DIR = join(ROOT, 'server', 'data', 'resilience-test');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');
const SEED_ID = 'resilience-teacher';
const SEED_PW = 'resilience-pass-123';

let server;
const sockets = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function track(socket) {
  sockets.push(socket);
  return socket;
}

function emitAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(7000).emit(event, payload, (err, res) => {
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

async function newSocket() {
  const s = track(connect(URL, { transports: ['websocket'], forceNew: true }));
  await new Promise((r) => s.on('connect', r));
  return s;
}

let token = '';

async function signIn() {
  const r = await fetch(`${URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id: SEED_ID, password: SEED_PW }),
  });
  const data = await r.json().catch(() => ({}));
  assert.equal(r.status, 200, data.error || 'teacher can sign in');
  return data.token;
}

/** Create a session and start it; returns {code, host, student, playerId, q0}. */
async function startedQuiz({ nickname = 'Rex', ...extra } = {}) {
  const host = await newSocket();
  const created = await emitAck(host, 'host:create', {
    token, units: [1], count: 4, difficulty: 'easy', revealSeconds: 30,
    ...extra,
  });
  assert.ok(created.ok, created.error || 'session created');

  const student = await newSocket();
  const joined = await emitAck(student, 'player:join', { code: created.code, nickname });
  assert.ok(joined.ok, joined.error || 'student joined');

  const first = waitEvent(student, 'question:start');
  const started = await emitAck(host, 'host:start');
  assert.ok(started.ok, started.error || 'quiz started');
  return { code: created.code, host, student, playerId: joined.playerId, q0: await first };
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
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(d));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${URL}/api/health`);
      if (r.ok) break;
    } catch { /* booting */ }
    await wait(250);
  }
  token = await signIn();
});

test.after(() => {
  sockets.forEach((s) => { try { s.close(); } catch { /* already closed */ } });
  try { server?.stderr?.destroy(); server?.stdout?.destroy(); } catch { /* already closed */ }
  server?.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

test('(a) closing the teacher dashboard keeps the quiz running - another device takes over', async () => {
  const { code, host, student } = await startedQuiz();

  // the teacher's tab dies (socket closes); nothing on the server pauses/ends the quiz
  host.close();
  await wait(300);

  // a second device signs in and rejoins the same session
  const device2 = await newSocket();
  const back = await emitAck(device2, 'host:join', { code, token });
  assert.ok(back.ok, back.error || 'another device can rejoin the session');
  assert.equal(back.state.status, 'running', 'the quiz is still running after the first dashboard died');
  assert.ok(['question', 'reveal'].includes(back.state.phase), `a real phase is live (${back.state.phase})`);
  assert.ok(back.roster.players?.length >= 1, 'the roster came back with the student still in it');

  // the student is still connected and sees progress: listen BEFORE advancing
  const seen = waitEvent(student, 'question:reveal', 15000);
  const moved = await emitAck(device2, 'host:control', {
    action: 'next', expect: { phase: back.state.phase, qIndex: back.state.qIndex },
  });
  assert.ok(moved.ok, moved.error || 'the second device can control the quiz');
  assert.notEqual(moved.stale, true, 'the fresh state was accepted');
  const revealed = await seen;
  assert.equal(revealed.qIndex, back.state.qIndex, 'the student kept receiving events after the teacher tab died');

  await emitAck(device2, 'host:end');
});

test('(b) several dashboards: host:count, stale controls report stale, pause never flips twice', async () => {
  const { code, host } = await startedQuiz();

  // --- host:count tracks every controlling dashboard ---
  const count1 = waitEvent(host, 'host:count', 5000, (p) => p.count >= 2);
  const device2 = await newSocket();
  const joined = await emitAck(device2, 'host:join', { code, token });
  assert.ok(joined.ok, joined.error || 'second dashboard joined');
  assert.ok(joined.roster && joined.state, 'the rejoin carries roster + state');
  const hc = await count1;
  assert.ok(hc.count >= 2, `host:count announced ${hc.count} dashboards`);

  // closing the second dashboard drops the count again
  const drop = waitEvent(host, 'host:count', 5000, (p) => p.count === 1);
  device2.close();
  const hd = await drop;
  assert.equal(hd.count, 1, 'host:count drops when a dashboard closes');

  // --- a stale control (someone else already advanced) reports stale, no double action ---
  const state = joined.state;
  const stale = await emitAck(host, 'host:control', {
    action: 'next', expect: { phase: state.phase === 'question' ? 'reveal' : 'question', qIndex: state.qIndex },
  });
  assert.equal(stale.ok, true, 'the ack is still ok');
  assert.equal(stale.stale, true, 'but flagged stale');
  assert.ok(stale.state && stale.roster, 'and hands back the fresh state + roster to resync');

  // --- pause is directional and idempotent: pausing twice must NOT resume ---
  const firstPause = await emitAck(host, 'host:control', { action: 'pause' });
  assert.equal(firstPause.ok, true, firstPause.error || 'first pause works');
  assert.notEqual(firstPause.unchanged, true);

  const secondPause = await emitAck(host, 'host:control', { action: 'pause' });
  assert.equal(secondPause.ok, true, 'pausing an already paused quiz still acks ok');
  assert.equal(secondPause.unchanged, true, 'and reports it was already paused - no flip');

  const stillPaused = await emitAck(host, 'host:join', { code, token });
  assert.equal(stillPaused.state.status, 'paused', 'the quiz stayed paused after the double pause');

  const resume = await emitAck(host, 'host:control', { action: 'resume' });
  assert.equal(resume.ok, true, resume.error || 'resume works');
  const resumeAgain = await emitAck(host, 'host:control', { action: 'resume' });
  assert.equal(resumeAgain.ok, true, 'resuming a running quiz is a no-op, not an error');
  assert.equal(resumeAgain.unchanged, true, 'and reports it was already running');

  await emitAck(host, 'host:end');
});

test('(f) a student who drops off rejoins with the same seat and score', async () => {
  const { code, host, student, playerId, q0 } = await startedQuiz({ nickname: 'Rex' });

  // answer the first question so the score is not zero
  const q = q0.question;
  const answer = q.type === 'fill-blank'
    ? q.accepted[0]
    : q.type === 'match'
      ? Object.fromEntries(q.pairs.map((p, i) => [i, p.right]))
      : q.options[0].id;
  const out = await emitAck(student, 'player:answer', { qIndex: 0, answer });
  assert.ok(out.result || out.ok, out.error || 'the answer was accepted');

  const roster = await waitEvent(host, 'roster', 8000, (p) => p.players?.some((x) => x.score > 0 || x.answered));
  const before = roster.players.find((p) => p.id === playerId);
  assert.ok(before, 'the player is on the roster');
  const scoreBefore = before.score;

  // connection drops
  student.close();
  await wait(300);

  // same nickname -> same seat, score intact (page refresh / network blip / new device)
  const back = await newSocket();
  const rejoin = await emitAck(back, 'player:join', { code, nickname: 'rex' });
  assert.ok(rejoin.ok, rejoin.error || 'the student can rejoin');
  assert.equal(rejoin.rebind, true, 'the rejoin is flagged as a rebind (no "joined" toast)');
  assert.equal(rejoin.playerId, playerId, 'the same player id - no duplicate seat');

  const roster2 = await waitEvent(host, 'roster', 8000, (p) => p.players?.some((x) => x.id === playerId && x.score === scoreBefore));
  const after = roster2.players.find((p) => p.id === playerId);
  assert.equal(after.score, scoreBefore, 'the score survived the disconnect');
  assert.equal(roster2.players.filter((p) => p.id === playerId).length, 1, 'still exactly one seat');

  await emitAck(host, 'host:end');
});
