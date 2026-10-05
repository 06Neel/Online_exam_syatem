// Redeploy resilience with a real DATABASE_URL: the disk is wiped between
// boots (exactly what a host restart/redeploy does) and everything must come
// back from Postgres. Covers the acceptance scenarios a-e:
//   a  admin creates a teacher -> restart -> still exists, can sign in
//   b  restart again -> teachers + banks intact, NOT replaced by defaults
//   c  sign in from a "second device" -> same account, banks and units
//   d  live quiz -> restart + full disk wipe -> session resumed, scores intact
//   e  admin deletes a teacher -> gone, and stays gone after a restart
// Plus: an unreachable DATABASE_URL refuses to start (exit code 1, FATAL log).
// Skipped entirely when DATABASE_URL is not set (local dev / plain CI).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { io as connect } from 'socket.io-client';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 3217;
const URL = `http://localhost:${PORT}`;
const DATA_DIR = join(ROOT, 'server', 'data', 'redeploy-test');
const SEED_ID = 'redeploy-teacher';
const SEED_PW = 'redeploy-pass-123';
const ADMIN_ID = 'admin';
const ADMIN_PW = 'redeploy-admin-123';

// Give this suite its OWN schema (pa_redeploy_test) inside whatever database
// DATABASE_URL points at, and start from empty tables: repeatable runs, and a
// real database's public schema is never read or written.
async function isolatedDatabaseUrl() {
  const raw = process.env.DATABASE_URL;
  if (!raw) return '';
  const { Pool } = await import('pg');
  const schema = 'pa_redeploy_test';
  const probe = new Pool({ connectionString: raw, connectionTimeoutMillis: 8000 });
  try {
    await probe.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await probe.query(`DROP TABLE IF EXISTS ${schema}.files, ${schema}.teachers`);
  } finally {
    await probe.end().catch(() => {});
  }
  // globalThis.URL: this file's `URL` constant is the server address
  const u = new globalThis.URL(raw);
  const existing = u.searchParams.get('options');
  u.searchParams.set('options', existing ? `${existing} -c search_path=${schema}` : `-c search_path=${schema}`);
  return u.toString();
}

const DB_URL = await isolatedDatabaseUrl();
const SKIP = DB_URL ? false : 'needs DATABASE_URL';

const ENV = {
  ...process.env,
  DATABASE_URL: DB_URL,   // '' in file mode: the suite runs on plain files
  PORT: String(PORT),
  NODE_ENV: 'test',
  DATA_DIR,
  SEED_TEACHER_ID: SEED_ID,
  SEED_TEACHER_PASSWORD: SEED_PW,
  ADMIN_PASSWORD: ADMIN_PW,
  ADMIN_USERNAME: ADMIN_ID,
};

let server;
const sockets = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const wipeDisk = () => rmSync(DATA_DIR, { recursive: true, force: true });

function boot(extraEnv = {}) {
  const proc = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    env: { ...ENV, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.log = '';
  proc.errLog = '';
  proc.stdout.on('data', (d) => { proc.log += d.toString(); });
  proc.stderr.on('data', (d) => { proc.errLog += d.toString(); process.stderr.write(d); });
  return proc;
}

async function waitHealthy() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`${URL}/api/health`);
      if (r.ok) return r.json();
    } catch { /* booting */ }
    await wait(200);
  }
  throw new Error('server did not start');
}

async function stop() {
  if (!server) return;
  // the health endpoint waits for every queued mirror write - a deterministic
  // flush point before the process is killed (mirrors are async otherwise)
  try { await fetch(`${URL}/api/health`); } catch { /* not up */ }
  const exited = new Promise((r) => server.once('exit', r));
  server.kill();
  await exited;
  server = null;
}

function track(socket) { sockets.push(socket); return socket; }

function emitAck(socket, event, payload = {}) {
  return new Promise((resolve, reject) => {
    socket.timeout(7000).emit(event, payload, (err, res) => (err ? reject(err) : resolve(res)));
  });
}

function waitEvent(socket, event, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout waiting for ${event}`)), ms);
    socket.once(event, (payload) => { clearTimeout(t); resolve(payload); });
  });
}

async function login(id, password) {
  const r = await fetch(`${URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, password }),
  });
  if (r.status !== 200) return null;
  return (await r.json()).token;
}

async function adminToken() {
  const token = await login(ADMIN_ID, ADMIN_PW);
  assert.ok(token, 'admin can sign in');
  return token;
}

async function getJson(path, token) {
  const r = await fetch(`${URL}${path}`, { headers: { 'x-teacher-token': token } });
  assert.equal(r.status, 200, `GET ${path} -> ${r.status}`);
  return r.json();
}

test.before(async () => {
  wipeDisk();
  server = boot();
  await waitHealthy();
});

test.after(async () => {
  for (const s of sockets) { try { s.close(); } catch { /* gone */ } }
  await stop();
  wipeDisk();
});

test('storage is the database and (a) a created teacher survives a restart', { skip: SKIP }, async () => {
  const health = await (await fetch(`${URL}/api/health`)).json();
  assert.equal(health.storage, 'database', 'health reports the database');

  const admin = await adminToken();
  const created = await fetch(`${URL}/api/admin/teachers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-teacher-token': admin },
    body: JSON.stringify({ id: 'deploy-teacher', name: 'Deploy Teacher', tempPassword: 'Deploy@1234' }),
  });
  assert.equal(created.status, 200, `teacher created: ${await created.text()}`);
  assert.ok(await login('deploy-teacher', 'Deploy@1234'), 'created teacher signs in');

  await stop();
  wipeDisk();                      // the redeploy
  server = boot();
  await waitHealthy();

  assert.ok(server.log.includes('[store] data mirrored to Postgres'), 'boot logs the database');
  assert.ok(await login('deploy-teacher', 'Deploy@1234'), 'teacher still exists and signs in');
});

test('(b) banks and accounts are restored, never replaced by defaults', { skip: SKIP }, async () => {
  const teacher = await login(SEED_ID, SEED_PW);
  assert.ok(teacher, 'seed teacher signs in');

  // a custom bank question before the restart
  const custom = {
    id: 'u1-q77',
    type: 'mcq',
    difficulty: 'easy',
    boss: false,
    unit: 1,
    prompt: 'Redeploy probe: which line stores 7 in x?',
    options: [
      { id: 'a', text: 'x = 7' },
      { id: 'b', text: 'x == 7' },
      { id: 'c', text: '7 -> x' },
      { id: 'd', text: 'x: 7 = 7' },
    ],
    answer: ['a'],
    explanation: '= stores, == compares.',
    analogy: 'Box labelled x holds seven.',
    hint: 'Plain equals sign.',
    tags: ['variables'],
    mini: { type: 'mcq', prompt: 'Which compares?', options: [{ id: 'a', text: 'x == 7' }, { id: 'b', text: 'x = 7' }], answer: 'a', explanation: 'Double equals compares.' },
  };
  const save = await fetch(`${URL}/api/bank`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-teacher-token': teacher },
    body: JSON.stringify(custom),
  });
  assert.equal(save.status, 200, `bank edit saved: ${await save.text()}`);

  await stop();
  wipeDisk();
  server = boot();
  await waitHealthy();

  const admin = await adminToken();
  const list = await getJson('/api/admin/teachers', admin);
  const ids = list.map((t) => t.id).sort();
  assert.deepEqual(ids, [SEED_ID, 'deploy-teacher'].sort(), 'exactly the known accounts - no default reset, no duplicates');

  const bank = await getJson('/api/bank', await login(SEED_ID, SEED_PW));
  assert.ok(bank.some((q) => q.id === 'u1-q77'), 'the custom question survived');
});

test('(c) the same account, banks and units appear on a second device', { skip: SKIP }, async () => {
  const device1 = await login(SEED_ID, SEED_PW);
  const device2 = await login(SEED_ID, SEED_PW);   // fresh token = another device
  assert.ok(device1 && device2 && device1 !== device2, 'two independent sessions');

  const bank1 = await getJson('/api/bank', device1);
  const bank2 = await getJson('/api/bank', device2);
  assert.deepEqual(bank2, bank1, 'identical question bank on both devices');
  assert.ok(bank1.some((q) => q.id === 'u1-q77'), 'including the teacher\'s own question');

  const units1 = await getJson('/api/units/list', device1);
  const units2 = await getJson('/api/units/list', device2);
  assert.deepEqual(units2, units1, 'identical units list');
});

test('(d) a live quiz resumes with scores after restart + full disk wipe', { skip: SKIP }, async () => {
  const token = await login(SEED_ID, SEED_PW);

  const host = track(connect(URL, { transports: ['websocket'], forceNew: true }));
  await new Promise((r) => host.on('connect', r));
  const created = await emitAck(host, 'host:create', { token, units: [4], count: 5, difficulty: 'easy', revealSeconds: 3 });
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
  const revealed = waitEvent(p1, 'question:reveal');
  const answer = q.question.type === 'fill-blank'
    ? q.question.accepted[0]
    : q.question.type === 'match'
      ? Object.fromEntries(q.question.pairs.map((x, i) => [i, x.right]))
      : q.question.options[0].id;
  await emitAck(p1, 'player:answer', { qIndex: 0, answer });
  await revealed;

  await stop();
  wipeDisk();                      // redeploy mid-quiz
  server = boot();
  await waitHealthy();

  const token2 = await login(SEED_ID, SEED_PW);
  const host2 = track(connect(URL, { transports: ['websocket'], forceNew: true }));
  await new Promise((r) => host2.on('connect', r));
  const rejoined = await emitAck(host2, 'host:join', { code, token: token2 });
  assert.ok(rejoined.ok, rejoined.error || 'teacher rejoins after the wipe');
  assert.equal(rejoined.state?.status, 'running', 'quiz still running');
  assert.ok(JSON.stringify(rejoined.roster || {}).includes('Rex'), 'roster with scores survived');

  const p2 = track(connect(URL, { transports: ['websocket'], forceNew: true }));
  await new Promise((r) => p2.on('connect', r));
  const rebind = await emitAck(p2, 'player:join', { code, nickname: 'rex' });
  assert.ok(rebind.ok, rebind.error || 'student retakes the seat');
  assert.equal(rebind.playerId, originalId, 'same player - scores were not lost or duplicated');

  const ended = await emitAck(host2, 'host:end');
  assert.ok(ended.ok, ended.error || 'session ended');
  const rex = ended.report.players.find((pl) => pl.nickname === 'Rex');
  assert.ok(rex, 'report keeps the player');
  assert.ok((rex.correct || 0) + (rex.wrong || 0) >= 1, 'the pre-restart answer is in the score');
});

test('(e) a deleted teacher stays deleted after another restart', { skip: SKIP }, async () => {
  const admin = await adminToken();
  const del = await fetch(`${URL}/api/admin/teachers/deploy-teacher`, {
    method: 'DELETE', headers: { 'x-teacher-token': admin },
  });
  assert.equal(del.status, 200, 'admin delete succeeded');
  assert.equal(await login('deploy-teacher', 'Deploy@1234'), null, 'sign-in refused immediately');

  await stop();
  wipeDisk();
  server = boot();
  await waitHealthy();

  assert.equal(await login('deploy-teacher', 'Deploy@1234'), null, 'still gone after the restart');
  const list = await getJson('/api/admin/teachers', await adminToken());
  assert.ok(!list.some((t) => t.id === 'deploy-teacher'), 'not in the list either');
  assert.ok(list.some((t) => t.id === SEED_ID), 'everyone else untouched');
});

test('admin export -> data loss -> restore brings everything back', { skip: SKIP }, async () => {
  const admin = await adminToken();
  const created = await fetch(`${URL}/api/admin/teachers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-teacher-token': admin },
    body: JSON.stringify({ id: 'backup-teacher', name: 'Backup Teacher', tempPassword: 'Backup@1234' }),
  });
  assert.equal(created.status, 200, `teacher created: ${await created.text()}`);

  const exported = await getJson('/api/admin/export', admin);
  const keys = Object.keys(exported.files || {});
  assert.ok(keys.includes('teachers.json'), 'the backup contains the accounts');
  assert.ok(
    exported.files['teachers.json'].teachers.some((t) => t.id === 'backup-teacher'),
    'including the new teacher',
  );
  assert.ok(keys.length >= 3, `backup has the data files (${keys.length})`);

  // data loss: the teacher disappears (deleted, not just lost on disk)
  const del = await fetch(`${URL}/api/admin/teachers/backup-teacher`, {
    method: 'DELETE', headers: { 'x-teacher-token': admin },
  });
  assert.equal(del.status, 200);
  assert.equal(await login('backup-teacher', 'Backup@1234'), null, 'gone before the restore');

  const restored = await fetch(`${URL}/api/admin/import`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-teacher-token': admin },
    body: JSON.stringify({ confirm: 'replace', files: exported.files }),
  });
  assert.equal(restored.status, 200, `restore accepted: ${await restored.text()}`);
  assert.ok(await login('backup-teacher', 'Backup@1234'), 'the restored teacher signs in again');

  // and the restored files were mirrored again: a wipe + restart keeps them
  await stop();
  wipeDisk();
  server = boot();
  await waitHealthy();
  assert.ok(await login('backup-teacher', 'Backup@1234'), 'still there after wipe + restart');
  assert.ok(await login(SEED_ID, SEED_PW), 'everyone else too');
});

test('an unreachable DATABASE_URL refuses to start with a FATAL message', { skip: SKIP }, async () => {
  await stop();
  const proc = boot({ DATABASE_URL: 'postgresql://127.0.0.1:1/none' });
  const code = await new Promise((resolve) => proc.once('exit', resolve));
  assert.equal(code, 1, `exited with code 1 (got ${code})`);
  assert.match(proc.errLog, /FATAL: the database is unreachable/i, 'the console shows the FATAL block');

  // and the app comes back normally once the database is reachable again
  server = boot();
  await waitHealthy();
  assert.ok(await login(SEED_ID, SEED_PW), 'normal boot after the database returns');
});
