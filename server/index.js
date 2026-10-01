import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import rateLimit from 'express-rate-limit';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadBank, saveQuestion, deleteQuestion, getFacts, unitsSummary, publicQuestion, ownerDirFor, recordUpload, listUploads, deleteUpload, setSummaries, getSet, appendSet, renameSet, setDisplayName, loadSetQuestions, sanitizeSettings, saveSetQuestion, removeSetQuestion, duplicateSet } from './bank.js';
import { SessionStore } from './sessions.js';
import { MAX_AGE_MS } from './snapshots.js';
import { evaluateBadges, badgeById } from '../shared/badges.js';
import { shuffleOptions, buildQuiz } from '../shared/quiz.js';
import { validateQuestions } from '../shared/validate.js';
import { fileUnitList, DEFAULT_SET_NAME } from '../shared/units.js';
import { getUnits, saveUnits, validateUnits } from './units.js';
import { listClasses, createClass, updateClass, deleteClass } from './classes.js';
import { listReports, getReport, deleteReport, needsReview } from './reports.js';
import { ensureDir, writeJsonSync } from './filesafe.js';
import { loadEnv } from './env.js';
import { initAuth, verifyToken, listTeachers } from './auth.js';
import { DATA_DIR } from './paths.js';
import { router as authRouter, requireAuth } from './routes/auth.js';
import { createAdminRouter } from './routes/admin.js';

loadEnv();  // .env first: ADMIN_PASSWORD and friends must be visible below

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DIST = join(ROOT, 'dist');
const PORT = process.env.PORT || 3001;
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'http://localhost:5173,http://localhost:3000')
  .split(',').map((s) => s.trim()).filter(Boolean);

const app = express();
const http = createServer(app);
const io = new Server(http, {
  cors: { origin: (origin, cb) => cb(null, !origin || ORIGINS.includes(origin) || isLocal(origin)), methods: ['GET', 'POST'] },
  maxHttpBufferSize: 16 * 1024,
});

function isLocal(origin = '') {
  if (process.env.NODE_ENV !== 'production') return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);
}

app.disable('x-powered-by');
app.use(express.json({ limit: '512kb' }));  // room for a 200-question upload

const apiLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false });
app.use('/api/', apiLimiter);

const store = new SessionStore(io);

// ---------- HTTP API ----------
app.use('/api/auth', authRouter);
app.use('/api/admin', createAdminRouter(store));

app.get('/api/health', (_req, res) => res.json({ ok: true, sessions: store.list().length }));

// Unit counts for the quiz builder: only the shared built-in bank counts here.
// Uploaded banks keep their own counts inside /api/sets - their questions must
// never show up in this shared per-teacher summary.
app.get('/api/units', (req, res) => {
  const auth = verifyToken(req.get('x-teacher-token') || '');
  res.json(unitsSummary(auth && auth.id ? auth.id : null, { scope: 'default' }));
});

// The teacher's unit list (base seven, possibly renamed + their own additions).
app.get('/api/units/list', requireAuth('teacher', 'admin'), (req, res) => {
  res.json(getUnits(req.auth.id));
});

app.put('/api/units/list', requireAuth('teacher', 'admin'), (req, res) => {
  const incoming = (req.body && req.body.units) || [];
  try {
    // shape first (400s for bad input), then occupancy (409), then write
    const canonical = validateUnits(incoming);
    const before = getUnits(req.auth.id);
    const nextIds = new Set(canonical.map((u) => u.id));
    const counts = unitsSummary(req.auth.id);
    for (const u of before) {
      if (!nextIds.has(u.id) && counts[u.id] && counts[u.id].total) {
        return res.status(409).json({
          error: `Unit ${u.id} still has ${counts[u.id].total} question(s). Move or delete them first.`,
        });
      }
    }
    saveUnits(req.auth.id, canonical);
    res.json({ ok: true, units: getUnits(req.auth.id) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/api/facts', (_req, res) => res.json(getFacts()));

app.get('/api/questions', (_req, res) => {
  const { questions } = loadBank();
  res.json(questions.map(publicQuestion));
});

// Practice mode: sampled run + full pool (for automatic revision questions).
// Answers are included - practice is a private, no-leaderboard mode.
const practiceLimiter = rateLimit({ windowMs: 60_000, limit: 30, standardHeaders: true, legacyHeaders: false });
app.get('/api/practice', practiceLimiter, (req, res) => {
  const { questions } = loadBank();
  const units = String(req.query.units || '')
    .split(',').map((n) => Number(n.trim())).filter((n) => n >= 1 && n <= 7);
  const count = Math.min(40, Math.max(4, Number(req.query.count) || 12));
  const difficulty = ['easy', 'medium', 'hard'].includes(req.query.difficulty) ? req.query.difficulty : 'mixed';
  const chosenUnits = units.length ? units : [1, 2, 3, 4, 5, 6, 7];
  const pool = questions.filter((q) => chosenUnits.includes(q.unit));
  const run = buildQuiz({ bank: pool, units: chosenUnits, count, difficulty, seed: `${Date.now()}-${Math.random()}` });
  res.json({ questions: run, pool });
});

// The question bank is scoped per teacher: every signed-in teacher sees the
// shared base plus their own edits and uploads (admin sees their own layer too).
app.get('/api/bank', requireAuth('teacher', 'admin'), (req, res) => {
  res.json(loadBank({ owner: req.auth.id }).questions);
});

app.post('/api/bank', requireAuth('teacher', 'admin'), (req, res) => {
  const q = req.body;
  if (!q || !q.id || !q.prompt) return res.status(400).json({ error: 'question needs id and prompt' });
  try {
    saveQuestion(q, req.auth.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/bank/:id', requireAuth('teacher', 'admin'), (req, res) => {
  res.json({ ok: deleteQuestion(req.params.id, req.auth.id) });
});

// ---------- JSON question upload / question sets ----------
// A set = one uploaded file (plus the built-in "default" set). Quizzes bind to
// exactly one set, so uploaded questions only ever run when chosen.
// Question banks. ?all=1 = admin management view across every teacher.
app.get('/api/sets', requireAuth('teacher', 'admin'), (req, res) => {
  if (req.query.all === '1' && req.auth.role === 'admin') {
    return res.json(listTeachers().map((t) => ({
      id: t.id, name: t.name, sets: setSummaries(t.id),
    })));
  }
  res.json(setSummaries(req.auth.id));
});

app.put('/api/sets/:id', requireAuth('teacher', 'admin'), async (req, res) => {
  const id = String(req.params.id || '');
  if (id === 'default') return res.status(400).json({ error: 'The default question bank cannot be renamed.' });
  try {
    const set = await renameSet(req.auth.id, id, req.body || {});
    if (!set) return res.status(404).json({ error: 'No such question bank.' });
    res.json({ ok: true, set: setSummaries(req.auth.id).find((s) => s.id === id) || set });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/api/sets/:id', requireAuth('teacher', 'admin'), (req, res) => {
  const id = String(req.params.id || '');
  if (id === 'default') return res.status(400).json({ error: 'The default question bank cannot be deleted.' });
  const ok = deleteUpload(req.auth.id, id);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'No such question bank.' });
});

// ---- one bank's questions, exactly as the editor works on them ----
function bankSummary(owner, id) {
  return setSummaries(owner).find((s) => s.id === id) || null;
}

app.get('/api/sets/:id/questions', requireAuth('teacher', 'admin'), (req, res) => {
  const id = String(req.params.id || '');
  if (id === 'default') {
    const questions = loadBank({ owner: req.auth.id, scope: 'default' }).questions;
    return res.json({
      id: 'default',
      kind: 'default',
      name: DEFAULT_SET_NAME,
      label: DEFAULT_SET_NAME,
      count: questions.length,
      uploadedAt: null,
      renamed: true,
      settings: null,
      units: getUnits(req.auth.id).map((u) => ({ ...u })),
      questions,
    });
  }
  const loaded = loadSetQuestions(req.auth.id, id);
  if (!loaded) return res.status(404).json({ error: 'That question bank no longer exists.' });
  res.json({
    id,
    kind: 'upload',
    name: loaded.batch.name || loaded.batch.file,
    label: setDisplayName(loaded.batch),
    count: loaded.questions.length,
    uploadedAt: loaded.batch.uploadedAt || null,
    renamed: !!loaded.batch.renamed,
    settings: loaded.batch.settings || null,
    units: loaded.units,
    questions: loaded.questions,
  });
});

app.post('/api/sets/:id/questions', requireAuth('teacher', 'admin'), async (req, res) => {
  const id = String(req.params.id || '');
  if (id === 'default') {
    return res.status(400).json({ error: 'The default question bank saves through the editor directly.' });
  }
  const loaded = loadSetQuestions(req.auth.id, id);
  if (!loaded) return res.status(404).json({ error: 'That question bank no longer exists.' });
  const q = req.body;
  const check = validateQuestions([q], { units: loaded.units, fileUnits: false });
  if (!check.ok) {
    return res.status(422).json({ error: 'This question needs fixing before it can be saved.', errors: check.errors, count: check.count });
  }
  try {
    const set = await saveSetQuestion(req.auth.id, id, q);
    if (!set) return res.status(404).json({ error: 'That question bank no longer exists.' });
    res.json({ ok: true, set: bankSummary(req.auth.id, id) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.delete('/api/sets/:id/questions/:qid', requireAuth('teacher', 'admin'), async (req, res) => {
  const id = String(req.params.id || '');
  if (id === 'default') {
    return res.status(400).json({ error: 'The default question bank deletes through the editor directly.' });
  }
  try {
    const ok = await removeSetQuestion(req.auth.id, id, req.params.qid);
    res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'That question is not in this bank.' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/sets/:id/duplicate', requireAuth('teacher', 'admin'), async (req, res) => {
  const id = String(req.params.id || '');
  if (id === 'default') {
    return res.status(400).json({ error: 'The built-in question bank cannot be duplicated.' });
  }
  try {
    const copy = await duplicateSet(req.auth.id, id);
    if (!copy) return res.status(404).json({ error: 'That question bank no longer exists.' });
    res.json({ ok: true, set: bankSummary(req.auth.id, copy.file) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/uploads', requireAuth('teacher', 'admin'), (req, res) => {
  res.json(listUploads(req.auth.id));
});

app.delete('/api/uploads/:file', requireAuth('teacher', 'admin'), (req, res) => {
  const ok = deleteUpload(req.auth.id, req.params.file);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'No such upload.' });
});

app.post('/api/upload', requireAuth('teacher', 'admin'), async (req, res) => {
  const owner = req.auth.id;
  const body = req.body || {};
  // accept the bare { questions } list or the full file wrapper
  // { title, settings, units, questions } - one uploaded file = one bank
  const wrap = body.file && typeof body.file === 'object' && Array.isArray(body.file.questions)
    ? body.file : body;
  const questions = Array.isArray(wrap.questions) ? wrap.questions : body.questions;
  if (!Array.isArray(questions)) return res.status(400).json({ error: 'Send { questions: [...] }.' });
  if (!questions.length) return res.status(400).json({ error: 'That file has no questions in it.' });
  if (questions.length > 200) return res.status(400).json({ error: 'One upload can hold at most 200 questions.' });

  // same validator as npm run validate and the browser preview - no exceptions.
  // fileUnits: the file's own unit names ("Loops") are accepted, checked against
  // THIS teacher's list only for numeric ids (renames + custom units count).
  const teacherUnits = getUnits(owner);
  const check = validateQuestions(questions, { units: teacherUnits, fileUnits: true });
  if (!check.ok) {
    return res.status(422).json({
      error: 'Some questions need fixing before they can be imported.',
      errors: check.errors,
      count: check.count,
    });
  }

  const appendTo = typeof body.appendTo === 'string' && body.appendTo.trim()
    ? body.appendTo.trim().slice(0, 80) : null;
  if (appendTo && appendTo !== 'default' && !getSet(owner, appendTo)) {
    return res.status(404).json({ error: 'That question bank no longer exists.' });
  }

  const overwrite = body.overwrite === true;
  const current = new Set(loadBank({ owner }).questions.map((q) => q.id));
  const seen = new Set();
  const fresh = [];
  const skipped = [];
  for (const q of questions) {
    if (seen.has(q.id)) { skipped.push({ id: q.id, reason: 'repeated in file' }); continue; }
    seen.add(q.id);
    if (current.has(q.id) && !overwrite) { skipped.push({ id: q.id, reason: 'already in your bank' }); continue; }
    fresh.push(q);
  }
  if (!fresh.length) {
    return res.status(409).json({ error: 'All of these questions are already in your bank.', skipped });
  }

  // the file's own unit-name map (wrapper `units: [{id,name}]`) names numeric
  // units bank-locally - never borrowed from the shared teacher list
  const unitRows = Array.isArray(wrap.units) ? wrap.units : [];
  const fileNames = Object.fromEntries(
    unitRows.filter((u) => u && Number.isInteger(u.id) && typeof u.name === 'string' && u.name.trim())
      .map((u) => [u.id, u.name.trim().slice(0, 60)]),
  );
  const rawName = String(body.name || wrap.title || '').trim();
  const settings = sanitizeSettings(body.settings || wrap.settings);

  try {
    if (appendTo && appendTo !== 'default') {
      const target = await appendSet(owner, appendTo, fresh);
      if (!target) return res.status(404).json({ error: 'That question bank no longer exists.' });
      return res.json({
        ok: true,
        added: fresh.length,
        skipped,
        file: appendTo,
        appended: true,
        bankCount: loadBank({ owner, fresh: true }).questions.length,
        set: setSummaries(owner).find((s) => s.id === appendTo) || null,
      });
    }

    // a new bank: derive its unit list from the file itself and store the
    // questions against those bank-local ids
    const plan = fileUnitList(fresh, fileNames);
    const stored = fresh.map((q, i) => ({ ...q, unit: plan.assignments[i] }));

    const slug = (rawName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)) || 'upload';
    const file = `${Date.now()}-${slug}.json`;
    const dir = ownerDirFor(owner);
    ensureDir(join(dir, 'uploads'));
    writeJsonSync(join(dir, 'uploads', file), stored);
    await recordUpload(owner, {
      file,
      name: rawName || file,
      count: stored.length,
      ids: stored.map((q) => q.id),
      units: plan.units,
      settings,
    });
    res.json({
      ok: true,
      added: fresh.length,
      skipped,
      file,
      bankCount: loadBank({ owner, fresh: true }).questions.length,
      set: setSummaries(owner).find((s) => s.id === file) || null,
    });
  } catch (e) {
    console.error('[upload] failed:', e);
    res.status(500).json({ error: 'Could not save the upload. Please try again.' });
  }
});

// ---------- classes & sections (per teacher) ----------
app.get('/api/classes', requireAuth('teacher', 'admin'), (req, res) => {
  res.json(listClasses(req.auth.id));
});

app.post('/api/classes', requireAuth('teacher', 'admin'), async (req, res) => {
  try {
    res.status(201).json(await createClass(req.auth.id, req.body || {}));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/classes/:id', requireAuth('teacher', 'admin'), async (req, res) => {
  try {
    res.json(await updateClass(req.auth.id, req.params.id, req.body || {}));
  } catch (e) {
    res.status(e.message === 'No such class.' ? 404 : 400).json({ error: e.message });
  }
});

app.delete('/api/classes/:id', requireAuth('teacher', 'admin'), async (req, res) => {
  const ok = await deleteClass(req.auth.id, req.params.id);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'No such class.' });
});

// ---------- finished reports (per teacher) ----------
app.get('/api/reports', requireAuth('teacher', 'admin'), (req, res) => {
  res.json(listReports(req.auth.id));
});

app.get('/api/reports/:code', requireAuth('teacher', 'admin'), (req, res) => {
  const report = getReport(req.auth.id, req.params.code);
  if (!report) return res.status(404).json({ error: 'No saved report with that code.' });
  res.json(report);
});

app.delete('/api/reports/:code', requireAuth('teacher', 'admin'), (req, res) => {
  const ok = deleteReport(req.auth.id, req.params.code);
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'No saved report with that code.' });
});

app.get('/api/needs-review', requireAuth('teacher', 'admin'), (req, res) => {
  res.json(needsReview(req.auth.id));
});

app.get('/api/sessions', requireAuth('teacher', 'admin'), (req, res) => {
  const mine = req.auth.role === 'admin' ? null : req.auth.id;
  res.json(store.list().filter((row) => (mine ? row.ownerId === mine : true)));
});

app.get('/api/sessions/:code/report', requireAuth('teacher', 'admin'), (req, res) => {
  const s = store.get(req.params.code);
  const owner = s && s.config.ownerId;
  const allowed = s && (req.auth.role === 'admin' || (owner && owner === req.auth.id));
  if (!allowed) return res.status(404).json({ error: 'no session' });
  res.json(s.buildReport());
});

// ---------- static client (production) ----------
const INDEX_HTML = join(DIST, 'index.html');
if (existsSync(INDEX_HTML)) {
  app.use(express.static(DIST, { index: false, maxAge: '1h' }));
  app.get(/^\/(?!socket\.io|api\/).*/, (_req, res) => res.sendFile(INDEX_HTML));
} else {
  // No client build in this image/checkout: `dist/` is excluded from deploys
  // and `npm run build` never ran here. Show a real message, never a blank page.
  console.warn(`[web] client build missing at ${INDEX_HTML}`);
  console.warn('[web] run `npm run build` before starting, or deploy the Dockerfile at the repo root.');
  app.get(/^\/(?!socket\.io|api\/).*/, (_req, res) => res.status(200).type('html').send(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Python Adventure - website not built</title>
<style>
  body { font-family: system-ui, sans-serif; background: #0f1013; color: #e8e8ea; margin: 0; min-height: 100vh; display: grid; place-items: center; }
  main { max-width: 34rem; padding: 2rem; line-height: 1.6; }
  h1 { font-size: 1.35rem; }
  code { background: #1b1d22; padding: .15em .45em; border-radius: 6px; }
</style></head>
<body><main>
<h1>The server is running, but the website is not built</h1>
<p>The API on this server answers, but <code>dist/index.html</code> is missing, so there is nothing to show in the browser.</p>
<p><b>Fix:</b> run <code>npm run build</code> before <code>npm start</code>, or deploy the <code>Dockerfile</code> at the repository root.</p>
</main></body></html>`));
}

// ---------- socket rate limiting ----------
function makeBucket(limit = 10, windowMs = 1000) {
  let count = 0;
  let start = Date.now();
  return () => {
    const now = Date.now();
    if (now - start > windowMs) { start = now; count = 0; }
    count++;
    return count <= limit;
  };
}

// ---------- sockets ----------
io.on('connection', (socket) => {
  const take = makeBucket(12, 1000);
  const guard = (fn) => (...args) => {
    if (!take()) return typeof args[args.length - 1] === 'function'
      ? args[args.length - 1]({ error: 'Slow down a moment.' })
      : socket.emit('error:rate', { error: 'Slow down a moment.' });
    return fn(...args);
  };

  let session = null;
  let player = null;
  let hosted = null; // the session this socket's dashboard drives (may differ from `session`)

  socket.on('host:create', guard((payload, cb) => {
    const config = { ...(payload || {}) };
    const token = config.token;
    delete config.token;
    const auth = verifyToken(token);
    if (!auth) return cb?.({ error: 'Please sign in again.' });
    if (auth.mustChangePassword) return cb?.({ error: 'Change your password first, then create the quiz.' });

    // bind the quiz to one question set (default = the built-in bank only)
    if (config.setId !== undefined && config.setId !== null) {
      const sid = String(config.setId || '').trim().slice(0, 80);
      if (!sid) delete config.setId;
      else if (sid === 'default') {
        config.setId = 'default';
        config.setName = DEFAULT_SET_NAME;
        config.setCount = loadBank({ owner: auth.id, scope: 'default' }).questions.length;
        config.unitNames = null;
        delete config.questionIds;
      } else {
        const loaded = loadSetQuestions(auth.id, sid);
        if (!loaded) return cb?.({ error: 'That question bank no longer exists.' });
        config.setId = sid;
        config.setName = loaded.batch.name || loaded.batch.file;
        config.setCount = loaded.questions.length;
        config.unitNames = Object.fromEntries(loaded.units.map((u) => [u.id, u.name]));
        const setIds = loaded.units.map((u) => u.id);
        const chosen = (Array.isArray(config.units) ? config.units : [])
          .map((x) => Number(x)).filter((x) => setIds.includes(x));
        config.units = chosen.length ? chosen : setIds;
        delete config.questionIds;
      }
    }

    // an uploaded set: every id must exist in THIS teacher's bank
    const ids = (Array.isArray(config.questionIds) ? config.questionIds : [])
      .filter((x) => typeof x === 'string').slice(0, 200);
    if (ids.length) {
      const have = new Set(loadBank({ owner: auth.id }).questions.map((q) => q.id));
      const missing = ids.find((id) => !have.has(id));
      if (missing) return cb?.({ error: `Unknown question id: ${missing}` });
      config.questionIds = ids;
    }
    const s = store.create({ ...config, ownerId: auth.id, ownerName: auth.name });
    session = s;
    hosted = s;
    socket.join(s.teacherRoom);
    socket.join(s.room);
    s.addController(socket.id); // -> host:count so every dashboard knows who is driving
    cb?.({ ok: true, code: s.code, token: auth.token, config: s.config });
  }));

  socket.on('host:join', guard((payload, cb) => {
    const code = typeof payload === 'string' ? payload : payload?.code;
    const token = typeof payload === 'string' ? null : payload?.token;
    const auth = verifyToken(token);
    if (!auth) return cb?.({ error: 'Please sign in again.' });
    const s = store.get(code);
    if (!s) return cb?.({ error: 'That session is no longer open - it may have expired. Start a new quiz from your dashboard.' });
    const owner = s.config.ownerId;
    if (owner && auth.role !== 'admin' && auth.id !== owner) {
      return cb?.({ error: 'That session belongs to another teacher.' });
    }
    session = s;
    hosted = s;
    socket.join(s.teacherRoom);
    socket.join(s.room);
    s.addController(socket.id);
    s.broadcastRoster();
    cb?.({
      ok: true, code: s.code, config: s.config, roster: s.rosterPayload(),
      stats: s.questionStatsPayload(), state: s.hostState(),
    });
  }));

  const startGate = (s) => {
    if (s.config.opensAt && Date.now() < s.config.opensAt) {
      return `This quiz opens at ${new Date(s.config.opensAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
    }
    const sid = s.config.setId;
    if (sid && sid !== 'default') {
      const bank = s.ensureSetBank();
      if (!bank || !bank.size) return 'That question bank no longer exists - pick another one.';
    }
    return null;
  };

  socket.on('host:start', guard((_payload, cb) => {
    if (!session) return cb?.({ error: 'not hosting' });
    const gate = startGate(session);
    if (gate) return cb?.({ error: gate });
    const ok = session.start();
    cb?.(ok ? { ok: true, total: session.quiz.length } : { error: 'cannot start' });
  }));

  socket.on('host:control', guard((payload = {}, cb) => {
    if (!session) return cb?.({ error: 'not hosting' });
    const { action } = payload;
    // a dashboard opened elsewhere may be behind (or ahead of) the real state -
    // tell it to resync instead of acting on what it thinks is on screen
    const expect = payload.expect && typeof payload.expect === 'object' ? payload.expect : null;
    if (expect && (expect.phase !== session.phase || Number(expect.qIndex) !== session.qIndex)) {
      return cb?.({
        ok: true, stale: true, action,
        state: session.hostState(), roster: session.rosterPayload(),
        stats: session.questionStatsPayload(),
      });
    }
    let out = { ok: true, action };
    switch (action) {
      case 'start': {
        const gate = startGate(session);
        if (gate) { out = { error: gate, action }; break; }
        out = { ok: session.start(), action };
        if (!out.ok) out = { error: 'cannot start', action };
        break;
      }
      case 'pause': {
        const res = session.pause();
        out = res.error ? { error: res.error, action } : { ...res, action };
        break;
      }
      case 'resume': {
        const res = session.resume();
        out = res.error ? { error: res.error, action } : { ...res, action };
        break;
      }
      case 'next':
      case 'skip': {
        const moved = session.next();
        if (!moved) out = { error: 'Students move at their own pace while the question timer is off.', action };
        break;
      }
      case 'extend': {
        if (session.currentPaced && session.status === 'running') {
          out = { error: 'There is no countdown to extend while the question timer is off.', action };
          break;
        }
        session.extend(Number(payload.seconds) || 10);
        break;
      }
      case 'timer': {
        const res = session.setTimerOn(payload.on);
        out = res.error ? { error: res.error, action } : { ...res, action };
        break;
      }
      case 'show-leaderboard': session.toggleLeaderboard(true); break;
      case 'hide-leaderboard': session.toggleLeaderboard(false); break;
      case 'reveal-mistake': {
        if (session.currentPaced && session.status === 'running') {
          out = { error: 'Reveals are for shared questions - the timer is off.', action };
          break;
        }
        const st = session.stats[session.qIndex] || { counts: {} };
        const entries = Object.entries(st.counts).sort((a, b) => b[1] - a[1]);
        const top = entries[0];
        const q = session.currentQuestion();
        const opt = top && q?.options?.find((o) => o.id === top[0]);
        session.emitAll('class:mistake', {
          count: top ? top[1] : 0,
          option: opt || null,
          options: q?.options || [],
          answer: q?.answer || null,
          explanation: q?.explanation,
        });
        break;
      }
      case 'show-answer': {
        if (session.currentPaced && session.status === 'running') {
          out = { error: 'Students review answers at their own pace - the timer is off.', action };
          break;
        }
        const q = session.currentQuestion();
        session.emitAll('answer:shown', { answer: q?.answer || null, accepted: q?.accepted || null, explanation: q?.explanation });
        break;
      }
      case 'end': out = { ok: true, report: session.end() }; break;
      default: out = { error: 'unknown action' };
    }
    session.broadcastRoster();
    session.broadcastQuestionStats();
    cb?.(out);
  }));

  socket.on('host:end', guard((_p, cb) => {
    if (!session) return cb?.({ error: 'not hosting' });
    cb?.({ ok: true, report: session.end() });
  }));

  socket.on('host:close', guard((_p, cb) => {
    if (session) store.delete(session.code);
    cb?.({ ok: true });
  }));

  // ----- players -----
  socket.on('player:join', guard((payload = {}, cb) => {
    const s = store.get(payload.code);
    if (!s) return cb?.({ error: 'That session code does not exist. It may have expired - ask your teacher for a new code.' });
    if (s.status === 'ended') return cb?.({ error: 'This session has already finished.' });
    if (!s.config.lateJoin && (s.status === 'running' || s.status === 'paused')) {
      return cb?.({ error: 'This quiz does not accept late joins - check with your teacher.' });
    }
    if (s.players.size >= 200) return cb?.({ error: 'The room is full right now.' });

    // a returning player keeps their seat: same nickname + a dead socket
    // (refresh, or the server restarting under them) rebinds instead of duplicating
    const nick = String(payload.nickname || '').trim().slice(0, 18) || 'Coder';
    const ghost = [...s.players.values()].find((p) => p.nickname.toLowerCase() === nick.toLowerCase()
      && (p.socketId == null || p.status === 'disconnected'));
    session = s;
    let rebind = false;
    if (ghost && s.players.size < 200) {
      ghost.socketId = socket.id;
      ghost.status = 'attempting';
      ghost.lastSeen = Date.now();
      player = ghost;
      rebind = true;
      s.persist();
    } else {
      player = s.join({ nickname: payload.nickname, team: payload.team, socketId: socket.id });
    }
    socket.join(s.room);

    cb?.({
      ok: true,
      playerId: player.id,
      code: s.code,
      title: s.config.title,
      teamMode: s.config.teamMode,
      status: s.status,
      phase: s.phase,
      started: s.status === 'running',
      rebind,
      leaderboard: s.leaderboardPayload(player),
      players: s.players.size,
      // question timer contract for the student's screen
      timerOn: s.config.timerOn !== false,
      selfPaced: s.currentPaced,
      allowBack: !!s.config.allowBack,
      allowSkip: s.config.allowSkip !== false,
      quizEndsAt: s.overallEndsAt ?? null,
    });

    s.emitAll('player:joined', { nickname: player.nickname, count: s.players.size, rebind });
    s.broadcastRoster();

    // joining mid-quiz: hand them their question (their own if the timer is off)
    if (s.status === 'running' && s.phase === 'question') {
      if (s.currentPaced) {
        if (player.finished) {
          socket.emit('player:finished', {
            score: player.score, correct: player.correct, wrong: player.wrong,
            answered: Object.keys(player.answered).length, total: s.quiz.length,
            badges: (player.newBadges || []).map(badgeById),
          });
        } else {
          s.presentTo(player, player.currentQ, { review: !!player.answered[player.currentQ] });
        }
      } else {
        const q = s.currentQuestion();
        if (q) {
          const mine = s.config.shuffleOptions ? shuffleOptions(q, `${s.seed}:${player.id}`) : q;
          // a student who already answered (re)joining mid-question gets their
          // own recorded result back instead of a blank, re-answerable card
          const rec = player.answered[s.qIndex];
          socket.emit('question:start', {
            qIndex: s.qIndex, total: s.quiz.length, refresher: s.currentEntry().refresher,
            unit: q.unit, boss: q.boss, question: publicQuestion(mine),
            duration: s.timer?.duration, endsAt: s.timer?.endsAt, lateJoin: !rebind,
            selfPaced: false, quizEndsAt: s.overallEndsAt,
            review: rec ? {
              correct: !!rec.correct, yourAnswer: rec.answer ?? null,
              correctAnswer: q.answer ?? q.accepted ?? null,
              accepted: q.accepted || null, pairs: q.pairs || null,
            } : null,
          });
        }
      }
    }
  }));

  socket.on('player:answer', guard((payload = {}, cb) => {
    if (!session || !player) return cb?.({ error: 'join a session first' });
    session.touch(player.id);
    const out = session.answer(player, payload);
    if (out.error) return cb?.(out);
    cb?.({ ok: true, ...out });
  }));

  // self-paced navigation (timer off): next question / skip forward / go back
  socket.on('player:advance', guard((payload = {}, cb) => {
    if (!session || !player) return cb?.({ error: 'join a session first' });
    session.touch(player.id);
    const out = session.playerAdvance(player, { skip: !!payload.skip });
    if (out.error) return cb?.(out);
    cb?.({ ok: true, ...out });
  }));

  socket.on('player:goto', guard((payload = {}, cb) => {
    if (!session || !player) return cb?.({ error: 'join a session first' });
    session.touch(player.id);
    const out = session.gotoPlayer(player, payload.qIndex);
    if (out.error) return cb?.(out);
    cb?.({ ok: true, ...out });
  }));

  socket.on('player:powerup', guard((payload = {}, cb) => {
    if (!session || !player) return cb?.({ error: 'join a session first' });
    session.touch(player.id);
    cb?.(session.usePowerup(player, payload.kind));
  }));

  socket.on('player:mini', guard((payload = {}, cb) => {
    if (!session || !player) return cb?.({ error: 'join a session first' });
    const ev = player.events[player.events.length - 1];
    if (!ev) return cb?.({ error: 'no question in progress' });
    if (ev.miniCorrect) return cb?.({ ok: true, earned: 0 });
    const ok = !!payload.correct;
    ev.miniPresented = true;
    ev.miniCorrect = ok;
    const earned = ok ? 10 : 0;
    player.score += earned;
    if (ok) {
      const before = new Set(player.badges);
      player.badges = evaluateBadges(player.events);
      player.newBadges = player.badges.filter((b) => !before.has(b));
    }
    session.broadcastLeaderboard();
    cb?.({ ok: true, earned });
  }));

  socket.on('player:ping', guard(() => {
    if (session && player) session.touch(player.id);
  }));

  socket.on('player:leave', guard(() => {
    if (session && player) session.removePlayer(player.id);
  }));

  socket.on('disconnect', () => {
    // a teacher tab closing / losing internet: the quiz keeps running on the
    // server; the remaining dashboards just hear host:count drop
    if (hosted) hosted.removeController(socket.id);
    if (session && player && session.status !== 'ended') {
      const still = [...session.players.values()].filter((p) => p.socketId === socket.id);
      still.forEach((p) => { p.status = 'disconnected'; });
      session.persist();
      session.broadcastRoster();
    }
  });
});

// heartbeat sweep so the teacher sees idle/disconnected states
setInterval(() => {
  for (const s of store.list()) {
    const session = store.get(s.code);
    if (session && session.status !== 'ended') session.broadcastRoster();
  }
}, 8000).unref?.();

// expiry sweep: sessions nobody has touched for SESSION_MAX_AGE_HOURS (12h
// default) are dropped - snapshots older than that are already refused on boot
const SWEEP_MS = Math.max(1000, Math.min(60_000, Math.floor(MAX_AGE_MS / 2)));
setInterval(() => {
  try {
    const dropped = store.sweep();
    if (dropped) console.log(`[sessions] expiry sweep removed ${dropped} session(s)`);
  } catch (e) {
    console.warn(`[sessions] sweep failed: ${e.message}`);
  }
}, SWEEP_MS).unref?.();

async function start() {
  await initAuth();
  store.restoreAll(); // quizzes that were live before a restart pick up where they left off
  http.listen(PORT, () => {
    console.log(`🐍 Python Adventure server on :${PORT}`);
    console.log(`   bank: ${loadBank().questions.length} questions`);
    console.log(`   data folder: ${DATA_DIR}`);
    if (process.env.NODE_ENV !== 'production') console.log(`   ws allowed origins: any (dev)`);
  });
}

start().catch((e) => {
  console.error('[server] failed to start:', e);
  process.exit(1);
});
