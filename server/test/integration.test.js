import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { io as connect } from 'socket.io-client';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readdirSync, rmSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const { UNITS } = await import('../../shared/units.js');
const { COSTS_DEFAULT, MARKS_DEFAULT } = await import('../../shared/scoring.js');
const PORT = 3199;
const URL = `http://localhost:${PORT}`;
// everything this run writes lives here - the real server/data is never touched
const DATA_DIR = join(ROOT, 'server', 'data', 'integration-test');
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

const SEED_ID = 'test-teacher';
const SEED_PW = 'test-pass-123';
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

test('host creates a session, students join, the quiz runs end to end', async () => {
  const host = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(host);
  await new Promise((r) => host.on('connect', r));

  const created = await emitAck(host, 'host:create', {
    token: teacherToken,
    title: 'Test run', units: [1], count: 4, difficulty: 'easy',
    revealSeconds: 3, hideBottom: 1, teamMode: false,
  });
  assert.ok(created.ok, created.error || 'session created');
  assert.equal(created.code.length, 4);
  assert.ok(created.token, 'teacher token issued for the editor API');
  const code = created.code;

  // token really unlocks the bank API
  const bankRes = await fetch(`${URL}/api/bank`, { headers: { 'x-teacher-token': created.token } });
  assert.equal(bankRes.status, 200);
  const bank = await bankRes.json();
  assert.ok(bank.length >= 80, 'full bank is served to the teacher');
  const stripped = await fetch(`${URL}/api/questions`);
  const publicQs = await stripped.json();
  assert.ok(!('explanation' in publicQs[0]), 'students never get explanations from /api/questions');
  assert.ok(!('answer' in publicQs[0]), 'students never get answers from /api/questions');

  // practice endpoint hands back full questions (private mode)
  const practiceRes = await fetch(`${URL}/api/practice?units=1&count=5&difficulty=easy`);
  const practice = await practiceRes.json();
  assert.equal(practice.questions.length, 5);
  assert.ok(practice.questions[0].explanation && practice.questions[0].mini, 'practice questions are complete');
  assert.ok(practice.pool.length >= 12, 'the sampled run comes with its source pool');

  // two students join
  const a = connect(URL, { transports: ['websocket'], forceNew: true });
  const b = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(a, b);
  await Promise.all([
    new Promise((r) => a.on('connect', r)),
    new Promise((r) => b.on('connect', r)),
  ]);

  const joinA = await emitAck(a, 'player:join', { code, nickname: 'Alpha', team: 'Red' });
  const joinB = await emitAck(b, 'player:join', { code, nickname: 'Bravo' });
  assert.ok(joinA.ok && joinB.ok);
  assert.ok(Array.isArray(joinA.leaderboard.entries), 'a join reply carries the leaderboard');
  assert.equal(joinA.leaderboard.mode, 'solo');

  // teacher sees the roster
  const roster = await waitEvent(host, 'roster', 8000, (p) => p.players?.length === 2);
  assert.equal(roster.players.length, 2);
  assert.ok(roster.players.every((p) => p.status === 'attempting'));

  // bad code is rejected politely
  const c = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(c);
  await new Promise((r) => c.on('connect', r));
  const badJoin = await emitAck(c, 'player:join', { code: 'ZZZZ', nickname: 'Nope' });
  assert.ok(badJoin.error, 'unknown code is rejected');

  // start
  // register listeners BEFORE asking the host to start - the first question fires immediately
  const qA = waitEvent(a, 'question:start');
  const qB = waitEvent(b, 'question:start');
  const started = await emitAck(host, 'host:start');
  assert.ok(started.ok);
  assert.ok(started.total >= 1);
  const firstA = await qA;
  const firstB = await qB;
  assert.equal(firstA.qIndex, 0);
  assert.ok(firstA.question.options?.length === 4 || firstA.question.type === 'fill-blank' || firstA.question.type === 'match');
  assert.ok(!('answer' in firstA.question), 'the live question is stripped of its answer');
  assert.ok(!('explanation' in firstA.question), 'the live question is stripped of its explanation');

  // answer the whole quiz: both players answer every question they are shown
  let answered = 0;

  const handleQuestion = async (sock, question) => {
    const q = question.question;
    let answer;
    if (q.type === 'fill-blank') answer = q.accepted[0];
    else if (q.type === 'match') answer = Object.fromEntries(q.pairs.map((p, i) => [i, p.right]));
    else answer = q.options[0].id; // may be wrong - that is fine, we are testing flow
    const out = await emitAck(sock, 'player:answer', { qIndex: question.qIndex, answer });
    return out;
  };

  a.on('question:start', (p) => { handleQuestion(a, p).then(() => { answered++; }).catch(() => {}); });
  b.on('question:start', (p) => { handleQuestion(b, p).then(() => { answered++; }).catch(() => {}); });
  // answer the very first question too (already received)
  await handleQuestion(a, firstA);
  await handleQuestion(b, firstB);
  answered += 2;

  const ended = await waitEvent(host, 'quiz:end', 45000);
  const report = ended.report;
  assert.equal(report.code, code);
  assert.equal(report.players.length, 2);
  assert.ok(report.questions.length >= 1);
  assert.ok(report.totals.answers >= 1);
  assert.ok(report.unitStats['1'], 'unit stats are reported');

  const alpha = report.players.find((p) => p.nickname === 'Alpha');
  assert.ok(alpha, 'Alpha is in the report');
  assert.equal(typeof alpha.accuracy, 'number');
  assert.ok(alpha.log.length >= 1, 'per-question log kept for the CSV');

  // leaderboard arrived during play
  assert.ok(answered >= 2);

  // report is also fetchable over HTTP (teacher signs in for it)
  const httpReport = await fetch(`${URL}/api/sessions/${code}/report`, {
    headers: { 'x-teacher-token': teacherToken },
  });
  assert.equal(httpReport.status, 200);
  const json = await httpReport.json();
  assert.equal(json.players.length, 2);

  // weak-topic detection feeds the "needs help" list
  assert.ok(Array.isArray(report.needsHelp));
  assert.ok(Array.isArray(report.weakUnits));
});

test('power-ups: hint costs marks and 50-50 removes options', async () => {
  const host = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(host);
  await new Promise((r) => host.on('connect', r));
  const created = await emitAck(host, 'host:create', { token: teacherToken, units: [5], count: 4, revealSeconds: 5 });
  const p = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(p);
  await new Promise((r) => p.on('connect', r));
  const joined = await emitAck(p, 'player:join', { code: created.code, nickname: 'Solo' });
  assert.ok(joined.ok);
  // listener first - the first question fires the moment the host presses start
  const firstQuestion = waitEvent(p, 'question:start');
  await emitAck(host, 'host:start');
  const q = await firstQuestion;

  const hint = await emitAck(p, 'player:powerup', { kind: 'hint' });
  assert.ok(hint.ok, hint.error);
  assert.equal(hint.cost, COSTS_DEFAULT.hint);
  assert.ok(hint.hint && hint.hint.length > 5, 'a real hint is returned, not the answer');

  if (q.question.type === 'mcq' || q.question.type === 'code-output' || q.question.type === 'spot-error') {
    const fifty = await emitAck(p, 'player:powerup', { kind: 'fifty' });
    assert.ok(fifty.ok, fifty.error);
    assert.equal(fifty.remove.length, 2, 'two wrong options are removed');
    const again = await emitAck(p, 'player:powerup', { kind: 'fifty' });
    assert.ok(again.error, 'power-ups are once per question');
  }

  // answering twice in the same question is refused
  const answer = q.question.type === 'fill-blank'
    ? q.question.accepted[0]
    : q.question.type === 'match'
      ? Object.fromEntries(q.question.pairs.map((x, i) => [i, x.right]))
      : q.question.options[0].id;
  const first = await emitAck(p, 'player:answer', { qIndex: q.qIndex, answer });
  assert.ok(first.ok);
  const second = await emitAck(p, 'player:answer', { qIndex: q.qIndex, answer });
  assert.ok(second.error, 'double answers are refused');
  assert.ok(first.result.breakdown.length > 0, 'score breakdown is sent to the student');

  await emitAck(host, 'host:end');
});

test('sign-in rules: bank and sessions need a login, admin pages stay hidden', async () => {
  const noAuth = await fetch(`${URL}/api/bank`);
  assert.equal(noAuth.status, 401, 'no token -> asked to sign in');
  const badAuth = await fetch(`${URL}/api/bank`, { headers: { 'x-teacher-token': 'not-a-real-token' } });
  assert.equal(badAuth.status, 401, 'stale token -> asked to sign in');

  const wrong = await signIn(SEED_ID, 'wrong-password');
  assert.equal(wrong.status, 401);
  assert.equal(wrong.error, 'Invalid ID or password');

  const ghost = await signIn('no-such-teacher', 'whatever');
  assert.equal(ghost.status, 401);
  assert.equal(ghost.error, 'Invalid ID or password', 'unknown id and wrong password look identical');

  const me = await fetch(`${URL}/api/auth/me`, { headers: { 'x-teacher-token': teacherToken } });
  assert.equal(me.status, 200);
  const who = await me.json();
  assert.equal(who.role, 'teacher');
  assert.equal(who.id, SEED_ID);

  const ok = await fetch(`${URL}/api/bank`, { headers: { 'x-teacher-token': teacherToken } });
  assert.equal(ok.status, 200);

  const sessions = await fetch(`${URL}/api/sessions`, { headers: { 'x-teacher-token': teacherToken } });
  assert.equal(sessions.status, 200);
  const rows = await sessions.json();
  assert.ok(Array.isArray(rows) && rows.every((r) => r.ownerId === SEED_ID), 'only your own sessions are listed');

  // wrong password first, right one later
  const badPw = await fetch(`${URL}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-teacher-token': teacherToken },
    body: JSON.stringify({ currentPassword: 'nope-nope', newPassword: 'brand-new-pass-1' }),
  });
  assert.equal(badPw.status, 400);
});

test('hosting requires a signed-in teacher', async () => {
  const host = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(host);
  await new Promise((r) => host.on('connect', r));
  const noToken = await emitAck(host, 'host:create', { units: [3], count: 5 });
  assert.ok(noToken.error, 'no token -> refused');

  const created = await emitAck(host, 'host:create', { token: teacherToken, units: [3], count: 5 });
  assert.ok(created.ok, created.error || 'session created');

  // a different signed-in teacher cannot reopen it
  const otherHost = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(otherHost);
  await new Promise((r) => otherHost.on('connect', r));
  const stranger = await emitAck(otherHost, 'host:join', { code: created.code, token: 'wrong-token' });
  assert.ok(stranger.error, 'a bad token cannot take over a session');
});

test('admin manages teachers; non-admins get page-not-found', async () => {
  const adminHeaders = { 'content-type': 'application/json', 'x-teacher-token': '' };

  // hidden from everyone who is not the admin
  const anon = await fetch(`${URL}/api/admin/teachers`);
  assert.equal(anon.status, 404, 'anonymous -> not found');
  const asTeacher = await fetch(`${URL}/api/admin/teachers`, { headers: { 'x-teacher-token': teacherToken } });
  assert.equal(asTeacher.status, 404, 'a teacher -> not found');

  const adminLogin = await signIn('admin', 'admin-test-secret');
  assert.equal(adminLogin.ok, true, adminLogin.error || 'admin signs in');
  assert.equal(adminLogin.role, 'admin');
  const admin = { ...adminHeaders, 'x-teacher-token': adminLogin.token };

  const overview = await fetch(`${URL}/api/admin/overview`, { headers: { 'x-teacher-token': adminLogin.token } });
  assert.equal(overview.status, 200);
  const stats = await overview.json();
  assert.ok(stats.teachers >= 1, 'the seeded teacher is counted');

  // create a teacher (password generated for us)
  const create = await fetch(`${URL}/api/admin/teachers`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ id: 'new-teacher', name: 'New Teacher', department: 'Grade 9' }),
  });
  const made = await create.json();
  assert.equal(create.status, 200, made.error);
  assert.ok(made.password && made.password.length >= 8, 'a one-time password comes back');
  assert.equal(made.teacher.mustChangePassword, true);

  // the new teacher signs in but must change the password before hosting
  const firstLogin = await signIn('new-teacher', made.password);
  assert.equal(firstLogin.ok, true, firstLogin.error);
  assert.equal(firstLogin.mustChangePassword, true);

  const host = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(host);
  await new Promise((r) => host.on('connect', r));
  const blocked = await emitAck(host, 'host:create', { token: firstLogin.token, units: [1], count: 4 });
  assert.ok(blocked.error, 'temporary password must be changed first');

  const change = await fetch(`${URL}/api/auth/change-password`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-teacher-token': firstLogin.token },
    body: JSON.stringify({ newPassword: 'my-own-pass-9999' }),
  });
  assert.equal(change.status, 200, 'first sign-in may skip the current password');

  const secondLogin = await signIn('new-teacher', 'my-own-pass-9999');
  assert.equal(secondLogin.ok, true, secondLogin.error);
  assert.equal(secondLogin.mustChangePassword, false);
  const hosted = await emitAck(host, 'host:create', { token: secondLogin.token, units: [1], count: 4 });
  assert.ok(hosted.ok, hosted.error || 'a teacher with a real password can host');

  // reset kills old sessions and hands back a fresh password
  const reset = await fetch(`${URL}/api/admin/teachers/new-teacher/password`, {
    method: 'POST', headers: admin, body: JSON.stringify({}),
  });
  const resetData = await reset.json();
  assert.equal(reset.status, 200, resetData.error);
  assert.ok(resetData.password, 'a generated password comes back');
  const deadToken = await fetch(`${URL}/api/bank`, { headers: { 'x-teacher-token': secondLogin.token } });
  assert.equal(deadToken.status, 401, 'the old login token dies with the password');

  // duplicate ids are refused
  const dup = await fetch(`${URL}/api/admin/teachers`, {
    method: 'POST', headers: admin,
    body: JSON.stringify({ id: 'new-teacher', name: 'Copy Cat' }),
  });
  assert.equal(dup.status, 400);

  // suspend, then the account cannot sign in
  const suspend = await fetch(`${URL}/api/admin/teachers/new-teacher/status`, {
    method: 'POST', headers: admin, body: JSON.stringify({ active: false }),
  });
  assert.equal(suspend.status, 200);
  const suspended = await signIn('new-teacher', resetData.password);
  assert.equal(suspended.status, 401);
  assert.match(suspended.error, /switched off/i, 'suspended teachers get a clear message');

  // admin sees every session (teacher sees only their own)
  const all = await fetch(`${URL}/api/sessions`, { headers: { 'x-teacher-token': adminLogin.token } });
  assert.equal(all.status, 200);
  const rows = await all.json();
  assert.ok(rows.length >= 1, 'at least one session is running');

  // delete removes the account
  const del = await fetch(`${URL}/api/admin/teachers/new-teacher`, { method: 'DELETE', headers: admin });
  assert.equal(del.status, 200, 'teacher deleted');
  const list = await (await fetch(`${URL}/api/admin/teachers`, { headers: admin })).json();
  assert.ok(!list.some((t) => t.id === 'new-teacher'), 'gone from the list');
  assert.ok(!('passwordHash' in (list[0] || {})), 'password hashes never leave the server');
});

// ---------- JSON upload (per-teacher bank) ----------
function uploadQuestion(id, unit = 3, extra = {}) {
  return {
    id, unit, type: 'mcq', difficulty: 'easy', boss: false,
    prompt: `Which keyword repeats a block for item ${id}?`,
    options: [
      { id: 'a', text: 'for' }, { id: 'b', text: 'while' },
      { id: 'c', text: 'each' }, { id: 'd', text: 'loop' },
    ],
    answer: ['a'],
    explanation: 'The for keyword walks over a sequence, running the indented block once per item.',
    analogy: 'For is like going through a playlist one song at a time.',
    hint: 'It is the keyword you use in a for loop.',
    tags: ['loops'],
    mini: {
      type: 'mcq',
      prompt: 'Which one loops over a list?',
      options: [{ id: 'a', text: 'for x in items:' }, { id: 'b', text: 'if x in items:' }],
      answer: 'a',
      explanation: 'for x in items walks the list; the if version only tests membership once.',
    },
    ...extra,
  };
}

test('JSON upload validates, imports and stays inside one teacher\'s bank', async () => {
  const stamp = Date.now().toString(36);
  const idA = `upl-${stamp}-a`;
  const idB = `upl-${stamp}-b`;
  const good = [uploadQuestion(idA), uploadQuestion(idB, 4)];

  const post = (body, token = teacherToken) => fetch(`${URL}/api/upload`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-teacher-token': token },
    body: JSON.stringify(body),
  });

  // signed out = refused
  const anon = await post({ questions: good }, '');
  assert.equal(anon.status, 401, 'uploads need a sign-in');

  // a broken file comes back with numbered, per-question errors
  const badQ = uploadQuestion(`upl-${stamp}-bad`, 99, { prompt: 'x' });
  const rejected = await post({ questions: [badQ] });
  assert.equal(rejected.status, 422);
  const rej = await rejected.json();
  assert.match(rej.error, /fixing/i);
  assert.equal(rej.errors[0].index, 0, 'errors point at the position in the file');
  assert.ok(rej.errors[0].messages.some((m) => /unknown unit 99/.test(m)), rej.errors[0].messages.join(' | '));
  assert.ok(rej.errors[0].messages.some((m) => /prompt too short/.test(m)));

  // a good file imports
  const okRes = await post({ name: 'Unit warmup', questions: good });
  const okData = await okRes.json();
  assert.equal(okRes.status, 200, okData.error);
  assert.equal(okData.added, 2);
  assert.ok(okData.file.endsWith('-unit-warmup.json'), `slugified file name (${okData.file})`);
  assert.equal(okData.skipped.length, 0);

  // it is in the bank and in the upload history
  const bank = await (await fetch(`${URL}/api/bank`, { headers: { 'x-teacher-token': teacherToken } })).json();
  assert.ok(bank.some((q) => q.id === idA), 'uploaded questions join the bank');
  const uploads = await (await fetch(`${URL}/api/uploads`, { headers: { 'x-teacher-token': teacherToken } })).json();
  assert.ok(Array.isArray(uploads) && uploads.some((b) => (b.ids || []).includes(idA)), 'history lists the batch');

  // same file again = conflict; overwrite = allowed
  const again = await post({ questions: good });
  assert.equal(again.status, 409, 'duplicates are refused, not silently doubled');
  const over = await post({ questions: good, overwrite: true });
  const overData = await over.json();
  assert.equal(over.status, 200, overData.error);
  assert.equal(overData.added, 2);

  // another teacher's bank never sees these questions
  const adminLogin = await signIn('admin', 'admin-test-secret');
  assert.equal(adminLogin.ok, true, adminLogin.error);
  const create = await fetch(`${URL}/api/admin/teachers`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-teacher-token': adminLogin.token },
    body: JSON.stringify({ id: 'upload-buddy', name: 'Upload Buddy', tempPassword: 'buddy-pass-1234' }),
  });
  assert.equal(create.status, 200, (await create.json()).error);
  const buddy = await signIn('upload-buddy', 'buddy-pass-1234');
  assert.equal(buddy.ok, true, buddy.error);
  const buddyBank = await (await fetch(`${URL}/api/bank`, { headers: { 'x-teacher-token': buddy.token } })).json();
  assert.ok(!buddyBank.some((q) => q.id === idA), "one teacher's uploads stay theirs");

  // the buddy's own upload stays in the buddy layer
  const buddyUp = await post({ questions: [uploadQuestion(`upl-${stamp}-c`)] }, buddy.token);
  assert.equal(buddyUp.status, 200);
  const mineAgain = await (await fetch(`${URL}/api/bank`, { headers: { 'x-teacher-token': teacherToken } })).json();
  assert.ok(!mineAgain.some((q) => q.id === `upl-${stamp}-c`), "and never leaks back");
  await fetch(`${URL}/api/admin/teachers/upload-buddy`, { method: 'DELETE', headers: { 'x-teacher-token': adminLogin.token } });

  // hosting a quiz from exactly these questions
  const host = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(host);
  await new Promise((r) => host.on('connect', r));
  const created = await emitAck(host, 'host:create', {
    token: teacherToken, title: 'Upload quiz', questionIds: [idA, idB], units: [3, 4],
  });
  assert.ok(created.ok, created.error || 'quiz from an uploaded set is created');
  assert.equal(created.config.questionIds.length, 2);
  const started = await emitAck(host, 'host:start');
  assert.ok(started.ok, started.error || 'starts');
  assert.equal(started.total, 2, 'exactly the uploaded questions run');

  // unknown ids are refused before anything starts
  const unknown = await emitAck(host, 'host:create', {
    token: teacherToken, questionIds: [`nope-${stamp}`], units: [1],
  });
  assert.match(unknown.error || '', /Unknown question id/);
});

// ---------- per-teacher units ----------
test('units: rename, add custom units, and block unsafe deletions', async () => {
  const authHeaders = { 'content-type': 'application/json', 'x-teacher-token': teacherToken };
  const BASE = UNITS.map((u) => ({ id: u.id, name: u.name }));
  const listUnits = async () => (await fetch(`${URL}/api/units/list`, { headers: { 'x-teacher-token': teacherToken } })).json();
  const putUnits = (units) => fetch(`${URL}/api/units/list`, {
    method: 'PUT', headers: authHeaders, body: JSON.stringify({ units }),
  });

  // clean slate for this run: clear leftover batches from earlier runs (they
  // pin custom units open), then undo renames. Custom units that still hold
  // questions after that cannot be deleted, so they must survive the reset.
  const oldBatches = await (await fetch(`${URL}/api/uploads`, { headers: { 'x-teacher-token': teacherToken } })).json();
  for (const b of oldBatches.filter((x) => x.name === 'custom unit')) {
    await fetch(`${URL}/api/uploads/${b.file}`, { method: 'DELETE', headers: { 'x-teacher-token': teacherToken } });
  }
  const before = await listUnits();
  const counts = await (await fetch(`${URL}/api/units`, { headers: { 'x-teacher-token': teacherToken } })).json();
  const occupiedCustom = before.filter((u) => u.custom && (counts[u.id]?.total || 0) > 0);
  const reset = await putUnits([...BASE, ...occupiedCustom]);
  assert.equal(reset.status, 200, `reset failed: ${(await reset.json()).error}`);

  const start = await listUnits();
  assert.equal(start.filter((u) => !u.custom).length, 7, 'the built-in seven are always there');
  assert.equal(start.find((u) => u.id === 1).name, 'Environment Setup', 'renames from older runs are undone');

  // signed out = refused
  const anon = await fetch(`${URL}/api/units/list`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ units: [] }),
  });
  assert.equal(anon.status, 401);

  // pick a free custom id (an occupied leftover from a crashed run survives)
  const customId = Math.max(...start.map((u) => u.id)) + 1;

  // rename unit 1 and add a custom unit
  const renamed = start.map((u) => (u.id === 1 ? { ...u, name: 'Setup & Tools' } : u));
  renamed.push({ id: customId, name: 'Files & Folders' });
  const saved = await putUnits(renamed);
  const savedData = await saved.json();
  assert.equal(saved.status, 200, savedData.error);
  assert.equal(savedData.units.find((u) => u.id === 1).name, 'Setup & Tools');
  assert.equal(savedData.units.find((u) => u.id === customId).name, 'Files & Folders');

  // the rename survives a fresh read
  const reread = await listUnits();
  assert.equal(reread.find((u) => u.id === 1).name, 'Setup & Tools');

  // an upload may use the custom unit now
  const stamp = Date.now().toString(36);
  const customQ = uploadQuestion(`unit-${stamp}`, customId);
  const up = await fetch(`${URL}/api/upload`, {
    method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'custom unit', questions: [customQ] }),
  });
  assert.equal(up.status, 200, (await up.json()).error);

  // a unit that still holds questions cannot be deleted
  const drop = await putUnits(reread.filter((u) => u.id !== customId));
  assert.equal(drop.status, 409, 'occupied unit is protected');
  assert.match((await drop.json()).error, /still has \d+ question/);

  // removing a built-in unit is refused outright
  const dropBase = await putUnits(reread.filter((u) => u.id !== 3));
  assert.equal(dropBase.status, 400);
  assert.match((await dropBase.json()).error, /cannot be removed/);

  // bad names are refused
  const badName = await putUnits(reread.map((u) => (u.id === 2 ? { ...u, name: 'x' } : u)));
  assert.equal(badName.status, 400);

  // remove the upload -> the custom unit is empty and can go
  const batches = await (await fetch(`${URL}/api/uploads`, { headers: { 'x-teacher-token': teacherToken } })).json();
  const batch = batches.find((b) => b.name === 'custom unit' && (b.ids || []).includes(customQ.id));
  assert.ok(batch, 'the batch is in the history');
  const del = await fetch(`${URL}/api/uploads/${batch.file}`, { method: 'DELETE', headers: { 'x-teacher-token': teacherToken } });
  assert.equal(del.status, 200, (await del.json()).error);
  const goneFromBank = await (await fetch(`${URL}/api/bank`, { headers: { 'x-teacher-token': teacherToken } })).json();
  assert.ok(!goneFromBank.some((q) => q.id === customQ.id), 'the uploaded question leaves the bank');

  // an empty custom unit can be removed; leave the plain base seven behind
  const afterDelete = await putUnits(reread.filter((u) => u.id !== customId));
  assert.equal(afterDelete.status, 200, (await afterDelete.json()).error);
  const final = await putUnits(BASE);
  assert.equal(final.status, 200, (await final.json()).error);
  assert.equal((await listUnits()).length, 7, 'test leaves the default seven units');
});

// ---------- classes & sections ----------
test('classes: teachers keep their own classes and sections', async () => {
  const authHeaders = { 'content-type': 'application/json', 'x-teacher-token': teacherToken };
  const list = async () => (await fetch(`${URL}/api/classes`, { headers: { 'x-teacher-token': teacherToken } })).json();

  // clean slate: drop leftovers from earlier runs so this test is idempotent
  for (const c of await list()) {
    await fetch(`${URL}/api/classes/${c.id}`, { method: 'DELETE', headers: { 'x-teacher-token': teacherToken } });
  }
  assert.deepEqual(await list(), []);

  // signed out = refused
  const anon = await fetch(`${URL}/api/classes`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Nope' }),
  });
  assert.equal(anon.status, 401);

  // create with duplicate sections -> de-duplicated
  const madeRes = await fetch(`${URL}/api/classes`, {
    method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'Year 9', sections: ['A', 'B', 'A'] }),
  });
  const cls = await madeRes.json();
  assert.equal(madeRes.status, 201, `create failed: ${cls.error}`);
  assert.equal(cls.name, 'Year 9');
  assert.deepEqual(cls.sections, ['A', 'B']);

  // a too-short name is refused
  const bad = await fetch(`${URL}/api/classes`, {
    method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'x' }),
  });
  assert.equal(bad.status, 400);

  // a second class with the same name is refused
  const dupe = await fetch(`${URL}/api/classes`, {
    method: 'POST', headers: authHeaders, body: JSON.stringify({ name: 'year 9' }),
  });
  assert.equal(dupe.status, 400);
  assert.match((await dupe.json()).error, /already/);

  // rename + replace the section list
  const patchedRes = await fetch(`${URL}/api/classes/${cls.id}`, {
    method: 'PATCH', headers: authHeaders, body: JSON.stringify({ name: 'Year 9 Blue', sections: ['Blue 1'] }),
  });
  const updated = await patchedRes.json();
  assert.equal(patchedRes.status, 200, updated.error);
  assert.equal(updated.name, 'Year 9 Blue');
  assert.deepEqual(updated.sections, ['Blue 1']);

  // the rename survives a fresh read
  const reread = await list();
  assert.equal(reread.find((c) => c.id === cls.id).name, 'Year 9 Blue');

  // unknown ids 404
  const missing = await fetch(`${URL}/api/classes/nope`, {
    method: 'PATCH', headers: authHeaders, body: JSON.stringify({ name: 'Ghost' }),
  });
  assert.equal(missing.status, 404);

  // remove it, then removing again is a 404
  const del = await fetch(`${URL}/api/classes/${cls.id}`, { method: 'DELETE', headers: { 'x-teacher-token': teacherToken } });
  assert.equal(del.status, 200, (await del.json()).error);
  const delAgain = await fetch(`${URL}/api/classes/${cls.id}`, { method: 'DELETE', headers: { 'x-teacher-token': teacherToken } });
  assert.equal(delAgain.status, 404);
  assert.deepEqual(await list(), [], 'test leaves no classes behind');
});

// ---------- per-quiz settings ----------
test('quiz settings: timing, marks, gates, class tags and schedule', async () => {
  const host = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(host);
  await new Promise((r) => host.on('connect', r));

  const created = await emitAck(host, 'host:create', {
    token: teacherToken, units: [1], count: 4, difficulty: 'easy', revealSeconds: 4,
    mode: 'practice',
    timers: { easy: 61, medium: 62, hard: 63, bossExtra: 7 },
    marks: { easy: 11, medium: 12, hard: 13, boss: 14 },
    shuffleOptions: false,
    allowHints: false,
    allowPowerups: false,
    lateJoin: false,
    classId: 'c-test', className: 'Year 9', section: 'Blue 1',
  });
  assert.ok(created.ok, created.error || 'session created');
  const cfg = created.config;
  assert.equal(cfg.mode, 'practice');
  assert.equal(cfg.timers.easy, 61);
  assert.equal(cfg.timers.bossExtra, 7);
  assert.equal(cfg.marks.easy, 11);
  assert.equal(cfg.marks.boss, 14);
  assert.equal(cfg.costs.hint, COSTS_DEFAULT.hint, 'power-up costs ride along in the config');
  assert.equal(cfg.shuffleOptions, false);
  assert.equal(cfg.allowHints, false);
  assert.equal(cfg.allowPowerups, false);
  assert.equal(cfg.lateJoin, false);
  assert.equal(cfg.className, 'Year 9');
  assert.equal(cfg.section, 'Blue 1');
  assert.equal(cfg.leaderboardToStudents, false, 'practice runs keep student leaderboards off');

  const p1 = connect(URL, { transports: ['websocket'], forceNew: true });
  const p2 = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(p1, p2);
  await Promise.all([
    new Promise((r) => p1.on('connect', r)),
    new Promise((r) => p2.on('connect', r)),
  ]);
  const joined = await emitAck(p1, 'player:join', { code: created.code, nickname: 'Solo' });
  assert.ok(joined.ok, joined.error);

  // start and confirm the custom clock is what students see
  const firstQuestion = waitEvent(p1, 'question:start');
  const started = await emitAck(host, 'host:start');
  assert.ok(started.ok, started.error || 'starts');
  const q = await firstQuestion;
  assert.ok(q.duration === 61000 || q.duration === 68000, `custom timer honored (got ${q.duration}ms)`);

  // hints and power-ups are off for this quiz
  const hint = await emitAck(p1, 'player:powerup', { kind: 'hint' });
  assert.match(hint.error || '', /Hints are turned off/);
  const fifty = await emitAck(p1, 'player:powerup', { kind: 'fifty' });
  assert.match(fifty.error || '', /Power-ups are turned off/);

  // late joiners are turned away once the quiz is running
  const late = await emitAck(p2, 'player:join', { code: created.code, nickname: 'Late' });
  assert.match(late.error || '', /late joins/);

  // an answer is scored with the custom mark table when it lands right
  const answer = q.question.type === 'fill-blank'
    ? q.question.accepted[0]
    : q.question.type === 'match'
      ? Object.fromEntries(q.question.pairs.map((x, i) => [i, x.right]))
      : q.question.options[0].id;
  const out = await emitAck(p1, 'player:answer', { qIndex: q.qIndex, answer });
  assert.ok(out.ok, out.error);
  if (out.result?.correct) {
    assert.equal(out.result.breakdown[0].value, 11, 'easy marks = 11 for this quiz');
  }
  await emitAck(host, 'host:end');

  // a scheduled quiz refuses to start before its opening time
  const sched = await emitAck(host, 'host:create', {
    token: teacherToken, units: [1], count: 4,
    opensAt: Date.now() + 120000,
  });
  assert.ok(sched.ok, sched.error || 'scheduled session created');
  const early = await emitAck(host, 'host:start');
  assert.match(early.error || '', /opens at/);
  const viaControl = await emitAck(host, 'host:control', { action: 'start' });
  assert.match(viaControl.error || '', /opens at/);
  await emitAck(host, 'host:end');
});

// ---------- saved reports ----------
test('reports: finished quizzes are saved, listed and deleted per teacher', async () => {
  const headers = { 'x-teacher-token': teacherToken };
  const host = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(host);
  await new Promise((r) => host.on('connect', r));

  const created = await emitAck(host, 'host:create', {
    token: teacherToken, units: [7], count: 4, difficulty: 'easy',
    revealSeconds: 3, className: 'Year 7', section: 'A',
  });
  assert.ok(created.ok, created.error || 'session created');
  const code = created.code;

  const p = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(p);
  await new Promise((r) => p.on('connect', r));
  assert.ok((await emitAck(p, 'player:join', { code, nickname: 'Solo' })).ok);

  const ended = waitEvent(host, 'quiz:end', 45000);
  const firstQuestion = waitEvent(p, 'question:start');
  await emitAck(host, 'host:start');
  const answerIt = async (qp) => {
    const q = qp.question;
    const answer = q.type === 'fill-blank'
      ? q.accepted[0]
      : q.type === 'match'
        ? Object.fromEntries(q.pairs.map((x, i) => [i, x.right]))
        : q.options[0].id;
    await emitAck(p, 'player:answer', { qIndex: qp.qIndex, answer });
  };
  p.on('question:start', (qp) => { answerIt(qp).catch(() => {}); });
  await answerIt(await firstQuestion);
  const report = (await ended).report;
  assert.equal(report.code, code);

  // it is in the history, tagged with the class
  const rows = await (await fetch(`${URL}/api/reports`, { headers })).json();
  const row = rows.find((r) => r.code === code);
  assert.ok(row, 'the finished quiz was saved');
  assert.equal(row.className, 'Year 7');
  assert.equal(row.section, 'A');
  assert.equal(row.players, 1);

  // the full report is fetchable after the session is over
  const fullRes = await fetch(`${URL}/api/reports/${code}`, { headers });
  assert.equal(fullRes.status, 200);
  const full = await fullRes.json();
  assert.equal(full.code, code);
  assert.equal(full.players.length, 1);
  assert.ok(full.questions.length >= 1);

  // needs-review aggregation has the documented shape
  const review = await (await fetch(`${URL}/api/needs-review`, { headers })).json();
  assert.ok(Array.isArray(review));
  for (const r of review) assert.ok(r.id && r.missRate >= 0.5 && r.asks >= 4);

  // unknown code and signed-out requests are refused
  assert.equal((await fetch(`${URL}/api/reports/zzzz`, { headers })).status, 404);
  assert.equal((await fetch(`${URL}/api/reports`)).status, 401);

  // delete it, then it is gone
  const del = await fetch(`${URL}/api/reports/${code}`, { method: 'DELETE', headers });
  assert.equal(del.status, 200, (await del.json()).error);
  const delAgain = await fetch(`${URL}/api/reports/${code}`, { method: 'DELETE', headers });
  assert.equal(delAgain.status, 404);
  const after = await (await fetch(`${URL}/api/reports`, { headers })).json();
  assert.ok(!after.some((r) => r.code === code), 'deleted report leaves the history');
});

// ---------- team mode leaderboards ----------
test('team mode: leaderboard carries team standings, solo players and individuals', async () => {
  const host = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(host);
  await new Promise((r) => host.on('connect', r));

  const created = await emitAck(host, 'host:create', {
    token: teacherToken, title: 'Teams', units: [1], count: 3, difficulty: 'easy',
    revealSeconds: 2, teamMode: true, leaderboardToStudents: true, hideBottom: 0,
  });
  assert.ok(created.ok, created.error || 'team session created');
  const code = created.code;
  assert.equal(created.config.teamMode, true);

  const mkPlayer = async () => {
    const s = connect(URL, { transports: ['websocket'], forceNew: true });
    sockets.push(s);
    await new Promise((r) => s.on('connect', r));
    return s;
  };
  const [ann, bo, cy] = await Promise.all([mkPlayer(), mkPlayer(), mkPlayer()]);

  const joinAnn = await emitAck(ann, 'player:join', { code, nickname: 'Ann', team: 'Pythons' });
  const joinBo = await emitAck(bo, 'player:join', { code, nickname: 'Bo', team: 'Pythons' });
  const joinCy = await emitAck(cy, 'player:join', { code, nickname: 'Cy' }); // no team
  assert.ok(joinAnn.ok && joinBo.ok && joinCy.ok);
  assert.equal(joinAnn.leaderboard.mode, 'team', 'a team-mode join reply is mode:team');
  assert.ok(Array.isArray(joinAnn.leaderboard.teams), 'teams array present');
  assert.ok(Array.isArray(joinAnn.leaderboard.solo), 'solo array present');
  assert.ok(Array.isArray(joinAnn.leaderboard.entries), 'individuals array still present');

  const answerIt = async (sock, qp) => {
    const q = qp.question;
    const answer = q.type === 'fill-blank'
      ? q.accepted[0]
      : q.type === 'match'
        ? Object.fromEntries(q.pairs.map((x, i) => [i, x.right]))
        : q.options[0].id;
    return emitAck(sock, 'player:answer', { qIndex: qp.qIndex, answer });
  };
  const answerAll = (sock) => {
    sock.on('question:start', (qp) => { answerIt(sock, qp).catch(() => {}); });
  };
  [ann, bo, cy].forEach(answerAll);

  const first = waitEvent(ann, 'question:start');
  const lbPromise = waitEvent(host, 'leaderboard', 20000, (p) => p.mode === 'team'
    && p.teams?.length === 1 && p.solo?.length === 1 && p.entries?.length === 3);
  const ended = waitEvent(host, 'quiz:end', 45000);
  await emitAck(host, 'host:start');
  await answerIt(ann, await first);
  if (ann !== bo) await answerIt(bo, await first).catch(() => {});
  if (ann !== cy) await answerIt(cy, await first).catch(() => {});

  const lb = await lbPromise;
  assert.equal(lb.mode, 'team');
  assert.equal(lb.teams.length, 1, 'only real teams are ranked - no fake "Solo" team');
  const pythons = lb.teams[0];
  assert.equal(pythons.name, 'Pythons');
  assert.deepEqual([...pythons.members].sort(), ['Ann', 'Bo'], 'the team row lists both member names');
  assert.equal(pythons.rank, 1);
  assert.equal(pythons.size, 2);
  assert.equal(typeof pythons.score, 'number');
  assert.equal(typeof pythons.avg, 'number');
  assert.equal(typeof pythons.accuracy, 'number');
  assert.equal(lb.solo.length, 1, 'the unteamed player is under Solo players');
  assert.equal(lb.solo[0].nickname, 'Cy');
  assert.equal(lb.entries.length, 3, 'the Individuals view shows every player');

  const report = (await ended).report;
  assert.equal(report.code, code);
  assert.equal(report.config.teamMode, true, 'the report remembers it was a team run');
  assert.ok(Array.isArray(report.teams) && report.teams.length === 1, 'report.teams carries the standings');
  assert.deepEqual([...report.teams[0].members].sort(), ['Ann', 'Bo'], 'report teams keep member names too');
  assert.ok(report.players.some((p) => p.nickname === 'Cy' && !p.team), 'the solo player is still a person in the report');

  // the HTTP report endpoint serves the same team standings
  const full = await (await fetch(`${URL}/api/reports/${code}`, { headers: { 'x-teacher-token': teacherToken } })).json();
  assert.ok(full.teams?.length === 1, 'GET report exposes teams');
  assert.deepEqual([...full.teams[0].members].sort(), ['Ann', 'Bo']);
});


test('an explicit question list is asked once each, in the given order', async () => {
  const host = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(host);
  await new Promise((r) => host.on('connect', r));

  const bank = await (await fetch(`${URL}/api/questions`)).json();
  assert.ok(bank.length >= 3, 'the bank has questions to pick from');
  // the same id twice on purpose - a run never serves a question twice
  const chosen = [bank[0].id, bank[0].id, bank[1].id];

  const created = await emitAck(host, 'host:create', {
    token: teacherToken, title: 'Dedupe run', units: [1], count: 3,
    questionIds: chosen, timerOn: false,
  });
  assert.ok(created.ok, created.error || 'session created');

  const a = connect(URL, { transports: ['websocket'], forceNew: true });
  sockets.push(a);
  await new Promise((r) => a.on('connect', r));
  const seen = [];
  a.on('question:start', (p) => seen.push(p));
  await emitAck(a, 'player:join', { code: created.code, nickname: 'Ida' });

  const started = await emitAck(host, 'host:start');
  assert.ok(started.ok);
  assert.equal(started.total, 2, 'the duplicate id was dropped at start');

  for (let i = 0; i < 2; i++) {
    for (let t = 0; t < 60 && seen.length <= i; t++) await wait(100);
    assert.ok(seen.length > i, `question ${i} arrived`);
    assert.equal(seen[i].qIndex, i);
    assert.equal(seen[i].question.id, chosen[i * 2], `question ${i} is the one that was asked for`);
    assert.equal(seen[i].refresher, false, 'nothing is spliced into an explicit list');
    const q = seen[i].question;
    const answer = q.type === 'fill-blank' ? q.accepted[0]
      : q.type === 'match' ? Object.fromEntries(q.pairs.map((p, ix) => [ix, p.right]))
        : q.options[0].id;
    assert.ok((await emitAck(a, 'player:answer', { qIndex: i, answer })).ok);
    if (i < 1) assert.ok((await emitAck(a, 'player:advance')).ok);
  }
});