// Question sets: every uploaded file is its own set, a quiz binds to exactly
// one set, and the set's own units reach the config, the run and the report.
// Covers the (a)-(f) acceptance scenarios from the question-set spec.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { io as connect } from 'socket.io-client';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PORT = 3214;
const URL = `http://localhost:${PORT}`;
// everything this run writes lives here - the real server/data is never touched
const DATA_DIR = join(ROOT, 'server', 'data', 'sets-test');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');

const SEED_ID = 'sets-teacher';
const SEED_PW = 'sets-pass-123';
const ADMIN_PW = 'sets-admin-secret';
const STAMP = Date.now().toString(36);

let server;
let token = '';
let adminToken = '';
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

function waitEvent(socket, event, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      socket.off(event, handler);
      reject(new Error(`timeout waiting for ${event}`));
    }, ms);
    const handler = (payload) => {
      clearTimeout(t);
      socket.off(event, handler);
      resolve(payload);
    };
    socket.on(event, handler);
  });
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function signIn(id, password) {
  const r = await fetch(`${URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, password }),
  });
  const data = await r.json().catch(() => ({}));
  return { status: r.status, ...data };
}

async function api(path, { method = 'GET', body, who = 'teacher' } = {}) {
  const r = await fetch(`${URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      'x-teacher-token': who === 'admin' ? adminToken : token,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await r.json().catch(() => ({}));
  // arrays stay arrays (list endpoints); objects get the status merged in
  const out = Array.isArray(data) ? data : { ...data };
  Object.defineProperty(out, 'status', { value: r.status, enumerable: false });
  return out;
}

function hostSocket() {
  const sock = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(sock);
  return new Promise((resolve, reject) => {
    sock.on('connect', () => resolve(sock));
    sock.on('connect_error', reject);
  });
}

/** Valid MCQ - every rule from shared/validate.js, unique ids per file. */
function mkQ(id, unit, tag) {
  const q = {
    id,
    type: 'mcq',
    difficulty: 'easy',
    boss: false,
    prompt: `Question ${tag}: which line stores a value?`,
    options: [
      { id: 'a', text: 'x = 5' },
      { id: 'b', text: 'x == 5' },
      { id: 'c', text: 'set x to five' },
      { id: 'd', text: 'x: 5' },
    ],
    answer: ['a'],
    explanation: 'The equals sign stores the value on the right into the name on the left.',
    analogy: 'Like putting a label on a box before you seal it shut.',
    hint: 'Look for the single equals sign here.',
    tags: ['values'],
    mini: {
      type: 'mcq',
      prompt: 'Which one compares instead of storing?',
      options: [{ id: 'a', text: 'x == 5' }, { id: 'b', text: 'x = 5' }],
      answer: 'a',
      explanation: 'The double equals sign compares two values instead of storing one.',
    },
  };
  if (unit !== undefined) q.unit = unit;
  return q;
}

const FILE_A = [
  mkQ(`${STAMP}-a1`, 'Loops', 'A1'),
  mkQ(`${STAMP}-a2`, 'Loops', 'A2'),
  mkQ(`${STAMP}-a3`, 'Loops', 'A3'),
];
const FILE_B = [
  mkQ(`${STAMP}-b1`, 'Strings', 'B1'),
  mkQ(`${STAMP}-b2`, 'Strings', 'B2'),
];
const FILE_C = [
  mkQ(`${STAMP}-c1`, 'Basics', 'C1'),
  mkQ(`${STAMP}-c2`, 'Basics', 'C2'),
  mkQ(`${STAMP}-c3`, 'Looping', 'C3'),
  mkQ(`${STAMP}-c4`, 'Strings', 'C4'),
];
const FILE_D = [mkQ(`${STAMP}-d1`, undefined, 'D1'), mkQ(`${STAMP}-d2`, undefined, 'D2')];
const IDS_A = new Set(FILE_A.map((q) => q.id));
const IDS_B = new Set(FILE_B.map((q) => q.id));

async function upload(questions, name, extra = {}) {
  return api('/api/upload', { method: 'POST', body: { name, questions, ...extra } });
}

const listSets = async () => api('/api/sets');

/** Create a session, start it, and hand back the host socket + first question. */
async function startQuiz(payload) {
  const sock = await hostSocket();
  const created = await emitAck(sock, 'host:create', {
    token, revealSeconds: 1, timers: { easy: 30, medium: 40, hard: 50, bossExtra: 10 }, ...payload,
  });
  assert.ok(created.ok, created.error || 'session created');
  const firstWait = waitEvent(sock, 'question:start');
  const started = await emitAck(sock, 'host:start');
  assert.ok(started.ok, started.error || 'quiz started');
  return { sock, created, first: await firstWait };
}

async function bootServer() {
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
      ADMIN_PASSWORD: ADMIN_PW,
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
}

async function restartServer() {
  try { server.kill(); } catch { /* already gone */ }
  await wait(400);
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
      ADMIN_PASSWORD: ADMIN_PW,
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
}

test.before(async () => {
  await bootServer();
  const seed = await signIn(SEED_ID, SEED_PW);
  if (!seed.ok) throw new Error(`seed teacher could not sign in: ${seed.error}`);
  token = seed.token;
  const admin = await signIn('admin', ADMIN_PW);
  if (!admin.ok) throw new Error(`admin could not sign in: ${admin.error}`);
  adminToken = admin.token;
});

test.after(() => {
  sockets.forEach((s) => { try { s.close(); } catch { /* already gone */ } });
  try { server?.stderr?.destroy(); server?.stdout?.destroy(); } catch { /* already gone */ }
  server?.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
});

// ---------- state shared across the scenario ----------
let fileA = '';
let fileB = '';
let unitA = 0;
let defaultCount = 0;

test('(a) an uploaded "Loops" file runs by itself, with its own unit', async () => {
  const res = await upload(FILE_A, `${STAMP} unit warmup`);
  assert.equal(res.status, 200, res.error);
  fileA = res.file;
  assert.equal(res.set.count, 3, 'the set knows its question count');
  assert.equal(res.set.units.length, 1, 'one unit from the file');
  assert.equal(res.set.units[0].name, 'Loops', 'the file\'s own unit name');
  unitA = res.set.units[0].id;

  const sets = await listSets();
  const entry = sets.find((s) => s.id === fileA);
  assert.ok(entry, 'the new set is listed');
  assert.equal(entry.kind, 'upload');
  assert.equal(entry.count, 3);
  assert.ok(entry.label.includes(entry.name), 'label carries the set name');
  const def = sets.find((s) => s.id === 'default');
  assert.ok(def, 'the built-in set is always listed');
  defaultCount = def.count;

  const { sock, created, first } = await startQuiz({ setId: fileA, count: 20, units: [unitA] });
  assert.equal(created.config.setId, fileA);
  assert.equal(created.config.setCount, 3);
  assert.equal(created.config.setName, entry.name);
  assert.equal(created.config.unitNames[unitA], 'Loops');
  assert.equal(first.total, 3, 'only this file\'s questions');
  assert.equal(first.unit, unitA);
  assert.equal(first.unitLabel, 'Loops');
  assert.ok(IDS_A.has(first.question.id), 'the question comes from file A');

  const ended = await emitAck(sock, 'host:end');
  assert.ok(ended.ok, ended.error);
  const report = ended.report;
  assert.equal(report.config.setId, fileA);
  assert.equal(report.config.unitNames[unitA], 'Loops');
  for (const q of report.questions) assert.ok(IDS_A.has(q.id), `${q.id} is from file A`);
  for (const u of Object.keys(report.unitStats)) {
    assert.equal(Number(u), unitA, 'report units are the set\'s units');
  }
  sock.close();
});

test('(b) a second file is its own set and leaves the first untouched', async () => {
  const res = await upload(FILE_B, `${STAMP} strings set`);
  assert.equal(res.status, 200, res.error);
  fileB = res.file;
  assert.equal(res.set.count, 2);
  assert.equal(res.set.units[0].name, 'Strings');

  const { sock, first, created } = await startQuiz({ setId: fileB, count: 10 });
  assert.equal(first.total, 2, 'only file B runs');
  assert.equal(first.unitLabel, 'Strings');
  assert.ok(IDS_B.has(first.question.id), 'the question comes from file B');
  const ended = await emitAck(sock, 'host:end');
  assert.equal(ended.report.config.setId, fileB);
  sock.close();

  const sets = await listSets();
  const a = sets.find((s) => s.id === fileA);
  assert.equal(a.count, 3, 'file A still has its 3 questions');
  assert.equal(a.units.length, 1, 'file A still has one unit');
  assert.equal(a.units[0].name, 'Loops');
  assert.equal(sets.find((s) => s.id === 'default').count, defaultCount, 'the default set never absorbed uploads');
  assert.ok(created.config.setId === fileB);
});

test('(c) a three-unit file reaches the dashboard config and the report', async () => {
  const res = await upload(FILE_C, `${STAMP} three units`);
  assert.equal(res.status, 200, res.error);
  const set = res.set;
  assert.equal(set.units.length, 3, 'all three file units are listed');
  assert.deepEqual(
    set.units.map((u) => u.name).sort(),
    ['Basics', 'Looping', 'Strings'],
    'unit names come from the file, in order of appearance',
  );
  assert.equal(set.units.reduce((s, u) => s + u.total, 0), 4, 'per-unit counts add up');

  const ids = set.units.map((u) => u.id);
  const { sock, created, first } = await startQuiz({ setId: set.id, count: 12, units: ids });
  assert.equal(created.config.setId, set.id);
  assert.deepEqual([...created.config.units].sort((x, y) => x - y), [...ids].sort((x, y) => x - y));
  assert.deepEqual(
    Object.values(created.config.unitNames).sort(),
    ['Basics', 'Looping', 'Strings'],
    'the dashboard shows the file\'s unit names',
  );
  assert.equal(first.total, 4, 'every question of the file is in play');
  assert.ok(['Basics', 'Looping', 'Strings'].includes(first.unitLabel));
  const ended = await emitAck(sock, 'host:end');
  const report = ended.report;
  for (const u of Object.keys(report.unitStats)) {
    assert.ok(ids.includes(Number(u)), `report unit ${u} belongs to the set`);
    assert.ok(report.config.unitNames[u], `unit ${u} has a display name`);
  }
  sock.close();
});

test('(d) a unitless file lands in Uncategorized and can be renamed', async () => {
  const res = await upload(FILE_D, `${STAMP} warmups`);
  assert.equal(res.status, 200, res.error);
  const setId = res.file;
  assert.equal(res.set.units.length, 1);
  assert.equal(res.set.units[0].name, 'Uncategorized', 'missing units fall back together');
  const unitD = res.set.units[0].id;

  const renamed = await api(`/api/sets/${encodeURIComponent(setId)}`, {
    method: 'PUT',
    body: { name: 'Warmups pack', units: [{ id: unitD, name: 'Warmups' }] },
  });
  assert.equal(renamed.status, 200, renamed.error);

  const entry = (await listSets()).find((s) => s.id === setId);
  assert.equal(entry.name, 'Warmups pack');
  assert.equal(entry.renamed, true);
  assert.equal(entry.label, 'Warmups pack', 'a renamed set drops the timestamp');
  assert.equal(entry.units[0].name, 'Warmups');

  const { sock, created, first } = await startQuiz({ setId, count: 8 });
  assert.equal(created.config.setName, 'Warmups pack');
  assert.equal(created.config.unitNames[unitD], 'Warmups');
  assert.equal(first.unitLabel, 'Warmups');
  await emitAck(sock, 'host:end');
  sock.close();
});

test('(e) the chosen set survives a restart and a fresh sign-in', async () => {
  const { sock, created, first } = await startQuiz({ setId: fileA, count: 20, units: [unitA] });
  const code = created.code;
  assert.equal(first.total, 3);

  await restartServer();
  try { sock.close(); } catch { /* the old server is gone anyway */ }
  const fresh = await signIn(SEED_ID, SEED_PW);
  assert.ok(fresh.ok, fresh.error);
  token = fresh.token;
  // tokens live in the server's memory - the admin one died with the old process
  const freshAdmin = await signIn('admin', ADMIN_PW);
  assert.ok(freshAdmin.ok, freshAdmin.error);
  adminToken = freshAdmin.token;

  const sock2 = await hostSocket();
  const joined = await emitAck(sock2, 'host:join', { code, token });
  assert.ok(joined.ok, joined.error || 'reopened after the restart');
  assert.equal(joined.config.setId, fileA, 'the quiz is still bound to file A');
  assert.equal(joined.config.setName, created.config.setName);
  assert.deepEqual(joined.config.unitNames, created.config.unitNames, 'unit names persisted');
  assert.ok(joined.state, 'the running quiz came back');
  assert.equal(joined.state.meta.unitLabel, 'Loops');
  assert.ok(IDS_A.has(joined.state.question.id), 'same set, same question');

  const ended = await emitAck(sock2, 'host:end');
  assert.ok(ended.ok, ended.error);
  assert.equal(ended.report.config.setId, fileA, 'the finished report keeps its set');
  sock2.close();
  sock.close();
});

test('(f) a host that reconnects mid-run keeps the same set', async () => {
  const { sock, created, first } = await startQuiz({ setId: fileB, count: 10 });
  assert.equal(first.total, 2);
  sock.close(); // the teacher closes the laptop mid-question
  await wait(300);

  const sock2 = await hostSocket();
  const joined = await emitAck(sock2, 'host:join', { code: created.code, token });
  assert.ok(joined.ok, joined.error || 'rejoined');
  assert.equal(joined.config.setId, fileB, 'still bound to file B');
  assert.ok(joined.state, 'the run is still live');
  assert.ok(IDS_B.has(joined.state.question.id), 'still asking file B questions');
  assert.equal(joined.state.meta.unitLabel, 'Strings');

  const ended = await emitAck(sock2, 'host:end');
  assert.equal(ended.report.config.setId, fileB);
  sock2.close();
});

test('append: more questions can join an existing set (units merge case-insensitively)', async () => {
  // a quiz already running on A keeps the copy it started with
  const { sock, created, first } = await startQuiz({ setId: fileA, count: 20, units: [unitA] });
  assert.equal(first.total, 3);

  const extra = [
    mkQ(`${STAMP}-a4`, '  LOOPS ', 'A4'),
    mkQ(`${STAMP}-a5`, 'Strings', 'A5'),
  ];
  const res = await upload(extra, `${STAMP} more loops`, { appendTo: fileA });
  assert.equal(res.status, 200, res.error);
  assert.equal(res.appended, true);
  assert.equal(res.set.count, 5, 'the set grew');
  assert.deepEqual(res.set.units.map((u) => u.name).sort(), ['Loops', 'Strings'],
    'whitespace/case-insensitive merge, new unit appended');
  // file A now really contains 5 questions - later tests must accept them
  IDS_A.add(extra[0].id);
  IDS_A.add(extra[1].id);

  const sock2 = await hostSocket();
  const joined = await emitAck(sock2, 'host:join', { code: created.code, token });
  assert.equal(joined.state.total, 3, 'the running quiz still has its original 3');
  await emitAck(sock2, 'host:end');
  sock2.close();
  sock.close();

  const sets = await listSets();
  assert.equal(sets.find((s) => s.id === fileA).count, 5);
  assert.equal(sets.find((s) => s.id === 'default').count, defaultCount, 'default stays untouched');
  assert.equal(sets.find((s) => s.id === fileB).count, 2, 'the other set is untouched');
});

test('default: the built-in set runs the built-in bank, never the uploads', async () => {
  const { sock, created, first } = await startQuiz({ setId: 'default', count: 6 });
  assert.equal(created.config.setId, 'default');
  assert.equal(created.config.setName, 'Default question bank');
  assert.equal(created.config.setCount, defaultCount);
  assert.equal(created.config.unitNames, null, 'the built-in set uses the syllabus names');
  // the built-in bank answers with its own size (one per unit + bosses),
  // never fewer than the count we asked for
  assert.ok(first.total >= 6, `the syllabus bank supplies the quiz (got ${first.total})`);
  assert.ok(!IDS_A.has(first.question.id), 'no uploaded questions leak into the default set');
  assert.ok(first.unit >= 1 && first.unit <= 7, 'default units are the syllabus 1-7');
  await emitAck(sock, 'host:end');
  sock.close();
});

test('isolation: teachers cannot see or use each other\'s sets', async () => {
  const created2 = await api('/api/admin/teachers', {
    method: 'POST', who: 'admin',
    body: { id: `${STAMP}-other`, name: 'Other Teacher' },
  });
  assert.equal(created2.status, 200, created2.error);
  const login2 = await signIn(created2.id || `${STAMP}-other`, created2.password);
  assert.ok(login2.ok, login2.error);
  const change = await fetch(`${URL}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-teacher-token': login2.token },
    body: JSON.stringify({ newPassword: 'other-pass-4242' }),
  });
  assert.equal(change.status, 200);
  const login2b = await signIn(`${STAMP}-other`, 'other-pass-4242');
  assert.ok(login2b.ok, login2b.error);

  token = login2b.token;
  const theirSets = await listSets();
  assert.equal(theirSets.length, 1, 'a fresh teacher only has the default set');
  assert.equal(theirSets[0].id, 'default');
  assert.ok(!theirSets.some((s) => s.id === fileA), 'file A never shows up for another teacher');

  const sock = await hostSocket();
  const blocked = await emitAck(sock, 'host:create', { token: login2b.token, setId: fileA, count: 6 });
  assert.ok(blocked.error, 'a foreign set id is refused');
  assert.match(blocked.error, /no longer exists/i);
  sock.close();
  token = (await signIn(SEED_ID, SEED_PW)).token; // back to our teacher
});

test('delete: removing a set never breaks a quiz that is already using it', async () => {
  const { sock, created, first } = await startQuiz({ setId: fileA, count: 20, units: [unitA] });
  assert.ok(IDS_A.has(first.question.id));

  const del = await api(`/api/sets/${encodeURIComponent(fileA)}`, { method: 'DELETE' });
  assert.equal(del.status, 200, del.error);

  // a brand-new socket tries to start a quiz on the deleted set
  const other = await hostSocket();
  const gone = await emitAck(other, 'host:create', { token, setId: fileA, count: 6 });
  assert.ok(gone.error, 'the deleted set cannot start a new quiz');
  assert.match(gone.error, /no longer exists/i);
  other.close();

  const ended = await emitAck(sock, 'host:end');
  assert.ok(ended.ok, 'the running quiz finishes anyway');
  assert.equal(ended.report.config.setId, fileA);
  assert.ok(ended.report.questions.every((q) => IDS_A.has(q.id)));
  sock.close();

  assert.ok(!(await listSets()).some((s) => s.id === fileA), 'the set is gone from the list');
});

// ---------- bank ownership: every bank owns its units and its edit routes ----------

const IDS_E = new Set([`${STAMP}-e1`, `${STAMP}-e2`, `${STAMP}-e3`]);
let fileE = '';
let fileF = '';
let unitF = 0;

test('bank ownership: numeric units keep the bank\'s own names, never the shared list', async () => {
  // Bank E occupies syllabus unit 4 but names it itself through the file wrapper
  const wrapE = {
    title: `${STAMP} alpha craft`,
    units: [{ id: 4, name: 'Alpha Craft Loops' }],
    questions: [mkQ(`${STAMP}-e1`, 4, 'E1'), mkQ(`${STAMP}-e2`, 4, 'E2'), mkQ(`${STAMP}-e3`, 4, 'E3')],
    settings: { points: { easy: 90, medium: 110, hard: 140, boss: 170 }, timerOn: false, count: 12 },
  };
  const resE = await api('/api/upload', { method: 'POST', body: { file: wrapE } });
  assert.equal(resE.status, 200, resE.error);
  fileE = resE.file;
  assert.equal(resE.set.units.length, 1, 'one numeric unit');
  assert.equal(resE.set.units[0].id, 4, 'the numeric id is kept');
  assert.equal(resE.set.units[0].name, 'Alpha Craft Loops', 'the wrapper names its own numeric unit');
  assert.equal(resE.set.settings.points.easy, 90, 'settings were stored with the bank');

  // Bank F: pure named units -> set-local ids (100+), separate from everything
  const resF = await upload([mkQ(`${STAMP}-f1`, 'Beta Strings', 'F1'), mkQ(`${STAMP}-f2`, 'Beta Strings', 'F2')], `${STAMP} beta pack`);
  assert.equal(resF.status, 200, resF.error);
  fileF = resF.file;
  unitF = resF.set.units[0].id;
  assert.ok(unitF >= 100, `named units get set-local ids (got ${unitF})`);
  assert.equal(resF.set.units[0].name, 'Beta Strings');

  // each bank serves only its own questions, units, name and settings
  const e = await api(`/api/sets/${encodeURIComponent(fileE)}/questions`);
  assert.equal(e.status, 200, e.error);
  assert.equal(e.name, wrapE.title, 'the wrapper title became the bank name');
  assert.equal(e.count, 3);
  assert.deepEqual(e.units.map((u) => u.name), ['Alpha Craft Loops'], 'no syllabus name leaks in');
  assert.ok(e.questions.every((q) => IDS_E.has(q.id)), 'only bank E questions');
  assert.equal(e.settings.timerOn, false, 'settings ride along with the content');

  const f = await api(`/api/sets/${encodeURIComponent(fileF)}/questions`);
  assert.equal(f.status, 200, f.error);
  assert.deepEqual(f.units.map((u) => u.name), ['Beta Strings'], 'bank F never sees bank E units');
  assert.ok(!f.questions.some((q) => IDS_E.has(q.id)), 'no cross-bank question leakage');

  // the shared teacher list and the shared counts stay clean
  const shared = await api('/api/units/list');
  const u4 = shared.find((u) => u.id === 4);
  assert.ok(u4, 'the syllabus unit 4 still exists');
  assert.notEqual(u4.name, 'Alpha Craft Loops', 'a bank never renames the shared unit');
  assert.ok(!shared.some((u) => u.name === 'Beta Strings'), 'bank units never join the shared list');
  const counts = await api('/api/units');
  assert.ok(Object.keys(counts).every((k) => Number(k) <= 99), 'bank-local unit ids stay out of shared counts');
});

test('bank ownership: the editing routes only touch the selected bank', async () => {
  // a unit from ANOTHER bank is refused
  const foreignUnit = mkQ(`${STAMP}-x1`, unitF, 'X1');
  const badF = await api(`/api/sets/${encodeURIComponent(fileE)}/questions`, { method: 'POST', body: foreignUnit });
  assert.equal(badF.status, 422, JSON.stringify(badF.errors || badF.error));
  // a syllabus unit this bank does not own is refused too
  const sharedUnit = mkQ(`${STAMP}-x2`, 5, 'X2');
  const badS = await api(`/api/sets/${encodeURIComponent(fileE)}/questions`, { method: 'POST', body: sharedUnit });
  assert.equal(badS.status, 422, JSON.stringify(badS.errors || badS.error));

  // the bank's OWN unit saves fine
  const good = mkQ(`${STAMP}-x4`, 4, 'X4');
  const ok = await api(`/api/sets/${encodeURIComponent(fileE)}/questions`, { method: 'POST', body: good });
  assert.equal(ok.status, 200, ok.error);
  assert.equal(ok.set.count, 4, 'the bank grew by one');

  // the new question exists ONLY in bank E
  const f = await api(`/api/sets/${encodeURIComponent(fileF)}/questions`);
  assert.ok(!f.questions.some((q) => q.id === `${STAMP}-x4`), 'bank F does not see the new question');
  const e = await api(`/api/sets/${encodeURIComponent(fileE)}/questions`);
  assert.ok(e.questions.some((q) => q.id === `${STAMP}-x4`), 'bank E has it');

  const delQ = await api(`/api/sets/${encodeURIComponent(fileE)}/questions/${encodeURIComponent(`${STAMP}-x4`)}`, { method: 'DELETE' });
  assert.equal(delQ.status, 200, delQ.error);
  const after = await api(`/api/sets/${encodeURIComponent(fileE)}/questions`);
  assert.equal(after.count, 3, 'back to three questions');
  assert.ok(!after.questions.some((q) => q.id === `${STAMP}-x4`), 'the removal really happened');

  // the built-in bank refuses the set-style edit routes (editor-only there)
  const defPost = await api('/api/sets/default/questions', { method: 'POST', body: mkQ(`${STAMP}-z1`, 1, 'Z1') });
  assert.equal(defPost.status, 400, 'default saves through /api/bank');
  const defDel = await api('/api/sets/default/questions/u1-q01', { method: 'DELETE' });
  assert.equal(defDel.status, 400, 'default deletes through /api/bank');
});

test('bank ownership: duplicate makes a full copy without touching the original', async () => {
  const dup = await api(`/api/sets/${encodeURIComponent(fileF)}/duplicate`, { method: 'POST' });
  assert.equal(dup.status, 200, dup.error);
  assert.ok(dup.set && dup.set.id && dup.set.id !== fileF, 'a new bank id');
  assert.match(dup.set.name, /\(copy\)/, 'the copy is labelled');

  const copy = await api(`/api/sets/${encodeURIComponent(dup.set.id)}/questions`);
  assert.equal(copy.status, 200, copy.error);
  assert.equal(copy.questions.length, 2, 'the copy carries every question');
  assert.deepEqual(copy.units.map((u) => u.name), ['Beta Strings'], 'and its units');

  const orig = await api(`/api/sets/${encodeURIComponent(fileF)}/questions`);
  assert.equal(orig.questions.length, 2, 'the original is untouched');

  const rm = await api(`/api/sets/${encodeURIComponent(dup.set.id)}`, { method: 'DELETE' });
  assert.equal(rm.status, 200, rm.error);
});

test('bank ownership: deleting one bank leaves the others and the default intact', async () => {
  const del = await api(`/api/sets/${encodeURIComponent(fileE)}`, { method: 'DELETE' });
  assert.equal(del.status, 200, del.error);

  const gone = await api(`/api/sets/${encodeURIComponent(fileE)}/questions`);
  assert.equal(gone.status, 404, 'the deleted bank 404s');
  assert.match(String(gone.error), /question bank/i, 'the error speaks bank language');

  const sets = await listSets();
  assert.ok(!sets.some((s) => s.id === fileE), 'bank E is gone from the list');
  assert.ok(sets.some((s) => s.id === fileF), 'bank F survives');
  assert.equal(sets.find((s) => s.id === 'default').count, defaultCount, 'the default bank keeps its questions');

  const f = await api(`/api/sets/${encodeURIComponent(fileF)}/questions`);
  assert.equal(f.status, 200, 'bank F still serves');
  assert.equal(f.questions.length, 2, 'with every question it had');
  assert.deepEqual(f.units.map((u) => u.name), ['Beta Strings'], 'and its units');
});

test('bank ownership: an admin sees every teacher\'s banks, a teacher only theirs', async () => {
  const all = await api('/api/sets?all=1', { who: 'admin' });
  assert.ok(Array.isArray(all), 'an array of teachers');
  assert.ok(all.length >= 2, `seed + isolation teacher (got ${all.length})`);
  const mine = all.find((t) => t.id === SEED_ID);
  assert.ok(mine && Array.isArray(mine.sets), 'each row carries that teacher\'s banks');
  assert.ok(mine.sets.some((s) => s.id === fileF), 'the seed teacher\'s bank is listed');
  assert.ok(mine.sets.some((s) => s.id === 'default'), 'including the built-in one');
  const other = all.find((t) => t.id !== SEED_ID);
  assert.ok(other, 'the other teacher appears too');
  assert.ok(!other.sets.some((s) => s.id === fileF), 'banks stay per teacher');

  // a teacher asking with ?all=1 still only gets their own bank list
  const teacherView = await api('/api/sets?all=1');
  assert.ok(Array.isArray(teacherView), 'still an array');
  assert.ok(teacherView.some((s) => s.id === 'default'), 'their own banks');
  assert.ok(!teacherView.some((s) => Array.isArray(s.sets)), 'never other teachers\' rows');
});
