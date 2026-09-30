// Restart resilience: a live quiz is snapshotted to disk, the server process is
// killed and booted again, and both teacher and student find their session back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { io as connect } from 'socket.io-client';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, rmSync, readFileSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 3205;
const URL = `http://localhost:${PORT}`;
const SESSIONS_DIR = join(ROOT, 'server', 'data', 'sessions-restart-test');
const SEED_ID = 'restart-teacher';
const SEED_PW = 'restart-pass-123';

const ENV = {
  ...process.env,
  PORT: String(PORT),
  NODE_ENV: 'test',
  PA_SESSIONS_DIR: SESSIONS_DIR,
  SEED_TEACHER_ID: SEED_ID,
  SEED_TEACHER_PASSWORD: SEED_PW,
};

let server;
const sockets = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function boot() {
  const proc = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    env: ENV, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.stderr.on('data', (d) => process.stderr.write(d));
  return proc;
}

async function waitHealthy() {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`${URL}/api/health`)).ok) return; } catch { /* booting */ }
    await wait(200);
  }
  throw new Error('server did not start');
}

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

function waitEvent(socket, event, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (payload) => { clearTimeout(t); resolve(payload); });
  });
}

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

const snapshotFor = (code) => {
  if (!existsSync(SESSIONS_DIR)) return null;
  const file = readdirSync(SESSIONS_DIR).find((f) => f.toLowerCase() === `${code.toLowerCase()}.json`);
  return file ? join(SESSIONS_DIR, file) : null;
};

test.before(async () => {
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
  server = boot();
  await waitHealthy();
});

test.after(() => {
  for (const s of sockets) { try { s.close(); } catch { /* already gone */ } }
  try { server?.stderr?.destroy(); server?.stdout?.destroy(); } catch { /* closed */ }
  server?.kill();
  rmSync(SESSIONS_DIR, { recursive: true, force: true });
});

test('a restarted server restores the running quiz for teacher and student', async () => {
  const token = await signIn();

  const host = track(connect(URL, { transports: ['websocket'], forceNew: true }));
  await new Promise((r) => host.on('connect', r));
  const created = await emitAck(host, 'host:create', {
    token, units: [4], count: 6, difficulty: 'easy', revealSeconds: 3,
    className: 'Year 7', section: 'Blue',
  });
  assert.ok(created.ok, created.error || 'session created');
  const code = created.code;

  const p1 = track(connect(URL, { transports: ['websocket'], forceNew: true }));
  await new Promise((r) => p1.on('connect', r));
  const joined = await emitAck(p1, 'player:join', { code, nickname: 'Rex' });
  assert.ok(joined.ok, joined.error || 'student joined');
  const originalId = joined.playerId;

  const firstQuestion = waitEvent(p1, 'question:start');
  await emitAck(host, 'host:start');
  const q = await firstQuestion;
  assert.equal(q.qIndex, 0);

  // answer, then wait for the auto-reveal so the snapshot catches a settled state
  const revealed = waitEvent(p1, 'question:reveal');
  const answer = q.question.type === 'fill-blank'
    ? q.question.accepted[0]
    : q.question.type === 'match'
      ? Object.fromEntries(q.question.pairs.map((x, i) => [i, x.right]))
      : q.question.options[0].id;
  await emitAck(p1, 'player:answer', { qIndex: 0, answer });
  await revealed;

  const snapPath = snapshotFor(code);
  assert.ok(snapPath, 'a snapshot file exists while the quiz is live');
  const snap = JSON.parse(readFileSync(snapPath, 'utf8'));
  assert.equal(snap.status, 'running');
  assert.equal(snap.players.length, 1);
  assert.equal(snap.players[0].nickname, 'Rex');
  assert.ok((snap.players[0].correct || 0) + (snap.players[0].wrong || 0) >= 1, 'the answer was recorded');

  // ---------------- kill the process, boot a fresh one ----------------
  const exited = new Promise((r) => server.once('exit', r));
  server.kill();
  await exited;
  server = boot();
  await waitHealthy();

  // the snapshot came back with the store
  assert.ok(snapshotFor(code), 'the snapshot survived the restart');

  const token2 = await signIn(); // tokens are in-memory: sign in again
  const host2 = track(connect(URL, { transports: ['websocket'], forceNew: true }));
  await new Promise((r) => host2.on('connect', r));
  const rejoined = await emitAck(host2, 'host:join', { code, token: token2 });
  assert.ok(rejoined.ok, rejoined.error || 'teacher rejoins after the restart');
  assert.equal(rejoined.state?.status, 'running', 'quiz still running');
  assert.ok(['question', 'reveal'].includes(rejoined.state?.phase), `mid-question phase kept (${rejoined.state?.phase})`);
  assert.ok(rejoined.state?.qIndex >= 0, 'question index kept');
  assert.ok(JSON.stringify(rejoined.roster || {}).includes('Rex'), 'roster survived');

  // the student takes their old seat back instead of appearing twice
  const p2 = track(connect(URL, { transports: ['websocket'], forceNew: true }));
  await new Promise((r) => p2.on('connect', r));
  const rebind = await emitAck(p2, 'player:join', { code, nickname: 'rex' });
  assert.ok(rebind.ok, rebind.error || 'student rejoins after the restart');
  assert.equal(rebind.playerId, originalId, 'same player id - the seat was rebound, not duplicated');

  // ending writes the report and clears the snapshot
  const ended = await emitAck(host2, 'host:end');
  assert.ok(ended.ok, ended.error || 'session ended');
  assert.equal(ended.report.players[0].nickname, 'Rex', 'report keeps the player');
  assert.equal((ended.report.players[0].correct || 0) + (ended.report.players[0].wrong || 0) >= 1, true,
    'the pre-restart answer is still in the report');
  assert.equal(snapshotFor(code), null, 'snapshot dropped once the report exists');
});
