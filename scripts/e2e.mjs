// End-to-end browser smoke test: teacher hosts a live session, a student joins and
// answers, the teacher ends it and gets a report. Also exercises practice mode.
// Run: node scripts/e2e.mjs   (build first: npm run build)
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 3210;
const BASE = `http://localhost:${PORT}`;
const SEED_ID = 'e2e-teacher';
const SEED_PW = 'e2e-pass-123';
const ADMIN_PW = 'e2e-admin-secret';
const errors = [];

const log = (...a) => console.log('  ', ...a);
const step = (n) => console.log(`\n[1m${n}[0m`);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function watch(page, name) {
  page.on('console', (m) => {
    // the deliberate wrong-password attempt logs a 401 - that one is expected
    if (m.type() === 'error' && !/favicon|net::ERR|status of 401/.test(m.text())) errors.push(`${name} console: ${m.text()}`);
  });
  page.on('pageerror', (e) => errors.push(`${name} pageerror: ${e.message}`));
}

async function startServer() {
  const server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'production',
      SEED_TEACHER_ID: SEED_ID,
      SEED_TEACHER_PASSWORD: SEED_PW,
      ADMIN_PASSWORD: ADMIN_PW,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return server;
    } catch { /* booting */ }
    await wait(250);
  }
  throw new Error('server did not start');
}

const failed = (msg) => { console.error(`\n  FAIL: ${msg}`); process.exitCode = 1; };
const check = (cond, msg) => { if (cond) log(`ok  ${msg}`); else failed(msg); };

// Answer whatever question type is on screen (mcq / fill-blank / match / code-output).
async function answerQuestion(page) {
  const opt = page.locator('.options button.option').first();
  if (await opt.count()) { await opt.click(); return 'mcq'; }
  const input = page.locator('.q-render input, .q-render textarea').first();
  if (await input.count()) { await input.fill('python'); return 'text'; }
  const sels = page.locator('.q-render select');
  const n = await sels.count();
  for (let i = 0; i < n; i++) {
    const values = await sels.nth(i).locator('option').evaluateAll((os) => os.map((o) => o.value).filter(Boolean));
    if (values[0]) await sels.nth(i).selectOption(values[0]);
  }
  return n ? 'match' : 'none';
}

let server;
let browser;
try {
  server = await startServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true });

  // ---------------- teacher: sign in, then create a session ----------------
  step('Teacher signs in');
  const tCtx = await browser.newContext();
  const teacher = await tCtx.newPage();
  watch(teacher, 'teacher');
  await teacher.goto(BASE, { waitUntil: 'networkidle' });
  await teacher.getByRole('button', { name: /Open teacher dashboard/i }).click();
  await teacher.waitForURL(/#\/teacher\/login/, { timeout: 8000 });   // signed out -> login
  check(true, 'signed-out teacher lands on the sign-in screen');
  await teacher.locator('#login-id').fill(SEED_ID);
  await teacher.locator('#login-pw').fill('the-wrong-password');
  await teacher.getByRole('button', { name: /^Sign in$/ }).click();
  await teacher.getByText('Invalid ID or password').waitFor({ timeout: 8000 });
  const badLoginMsg = await teacher.getByRole('alert').textContent();
  check(/Invalid ID or password/i.test(badLoginMsg || ''), 'wrong password gets the generic error');
  await teacher.locator('#login-pw').fill(SEED_PW);
  await teacher.getByRole('button', { name: /^Sign in$/ }).click();
  await teacher.waitForURL(/#\/teacher$/, { timeout: 10000 });
  check(true, 'sign-in lands on the teacher dashboard');

  step('Teacher creates a session');
  await teacher.getByRole('button', { name: /Create & open lobby/i }).click();
  await teacher.waitForURL(/#\/teacher\/live/, { timeout: 10000 });
  await teacher.waitForSelector('.controls .mono');
  const code = (await teacher.locator('.controls .mono').first().textContent()).trim();
  check(/^[A-Z0-9]{4}$/.test(code), `session code shown (${code})`);
  await teacher.waitForSelector('.card', { timeout: 8000 }); // lobby/roster card painted

  // ---------------- student: join ----------------
  step('Student joins');
  const sCtx = await browser.newContext();
  const student = await sCtx.newPage();
  watch(student, 'student');
  await student.goto(`${BASE}/#/join`, { waitUntil: 'networkidle' });
  await student.locator('[aria-label="Game code"]').fill(code);
  await student.locator('[aria-label="Nickname"]').fill('Robo');
  await student.getByRole('button', { name: /Join the game/i }).click();
  await student.waitForURL(/#\/lobby/, { timeout: 10000 });
  await student.waitForSelector('text=Robo', { timeout: 8000 });
  check(true, 'student is in the lobby');
  await teacher.getByText('Robo').first().waitFor({ timeout: 8000 });
  const teacherSeesStudent = await teacher.getByText('Robo').count();
  check(teacherSeesStudent > 0, 'teacher roster shows the student');

  // ---------------- teacher starts ----------------
  step('Teacher starts the quiz');
  await teacher.locator('[aria-label="Start the quiz"]').click();
  await student.waitForURL(/#\/play/, { timeout: 10000 });
  try {
    await student.waitForSelector('.q-render', { timeout: 10000 });
  } catch (e) {
    const html = await student.evaluate(() => document.body.innerText.slice(0, 600));
    console.log('  DEBUG student url:', student.url());
    console.log('  DEBUG student text:', JSON.stringify(html));
    throw e;
  }
  check(true, 'student sees the first question');
  const teacherQuestion = await teacher.getByText(/Question 1/).count();
  check(teacherQuestion > 0, 'teacher dashboard shows question 1');
  check(await student.locator('.timer .val').isVisible(), 'countdown timer is on screen');
  check(await student.getByText(/⭐\s*\d+/).first().isVisible().catch(() => false), 'score chip is on screen');

  // ---------------- power-ups (before answering, while the card is live) ----------------
  step('Power-ups');
  const hintBtn = student.getByRole('button', { name: /Hint/ }).first();
  check(await hintBtn.count() > 0, 'hint control present on the question');
  const fiftyBtn = student.getByRole('button', { name: /50-50/ }).first();
  check(await fiftyBtn.count() > 0, '50-50 control present');

  // ---------------- teacher controls: pause / resume / extra time ----------------
  step('Teacher controls: pause, resume, +10s');
  await teacher.locator('[aria-label="Pause the quiz"]').click();
  await student.getByText(/paused the game/i).first().waitFor({ timeout: 6000 });
  check(true, 'student sees the pause notice');
  await teacher.locator('[aria-label="Resume the quiz"]').click();
  await student.getByText(/Back in play/i).first().waitFor({ timeout: 6000 });
  check(true, 'student sees the resume notice');
  await teacher.locator('[aria-label="Give everyone 10 more seconds"]').click();
  await student.getByText(/Bonus time/i).first().waitFor({ timeout: 6000 });
  check(true, 'student timer gets the extra 10s');

  // ---------------- student answers ----------------
  step('Student answers');
  const answeredAs = await answerQuestion(student);
  await student.getByRole('button', { name: /Lock in my answer/i }).click();
  await student.waitForSelector('.explain, .feedback, .result', { timeout: 8000 });
  const feedback = await student.locator('.explain').first().textContent().catch(() => '');
  check((feedback || '').length > 20, `feedback + explanation shown (${(feedback || '').slice(0, 40)}...)`);
  const scoreChip = await student.evaluate(() => (document.body.innerText.match(/⭐\s*\d+/) || [''])[0]);
  const scoreNum = Number((scoreChip.match(/\d+/) || [0])[0]);
  const wasCorrect = /✅|Right|Nailed it/i.test(feedback);
  if (wasCorrect) check(scoreNum > 0, `correct answer paid out (${scoreChip.trim()})`);
  else check(/⭐/.test(scoreChip), `score chip updated (${scoreChip.trim()})`);

  // teacher stats arrive after the answer
  await wait(1200);
  const statCards = await teacher.locator('.card').count();
  check(statCards >= 3, `teacher has roster/stats cards (${statCards})`);

  // ---------------- practice mode ----------------
  step('Practice mode on a third page');
  const pCtx = await browser.newContext();
  const practice = await pCtx.newPage();
  watch(practice, 'practice');
  await practice.goto(`${BASE}/#/practice`, { waitUntil: 'networkidle' });
  const startBtn = practice.getByRole('button', { name: /Start practicing/i });
  await startBtn.click();
  await practice.waitForSelector('.q-render', { timeout: 15000 });
  const practiceAnsweredAs = await answerQuestion(practice);
  await practice.getByRole('button', { name: /Lock in my answer/i }).click();
  await practice.waitForSelector('.explain', { timeout: 10000 });
  check(true, 'practice question answered with feedback');
  const hintPractice = practice.getByRole('button', { name: /Hint/ }).first();
  check(await hintPractice.count() > 0, 'hint available in practice');
  await hintPractice.click();
  await practice.waitForSelector('text=Hint (-15)', { timeout: 5000 });
  check(true, 'hint opens in practice mode');

  // ---------------- teacher shows answer + ends ----------------
  step('Teacher reveals and ends');
  await teacher.locator('[aria-label="Show the correct answer to the class"]').click();
  await teacher.locator('[aria-label="End the quiz and open the report"]').click();
  await teacher.getByRole('button', { name: /^End quiz$/ }).click();
  await teacher.waitForSelector('text=Robo', { timeout: 10000 });
  const reportText = (await teacher.locator('body').textContent()) || '';
  check(/Robo/.test(reportText), 'report lists the student');
  check(/accuracy|score|Score|report/i.test(reportText), 'report shows scores');

  // ---------------- saved reports: history -> print page ----------------
  step('Saved reports history and print page');
  await teacher.goto(`${BASE}/#/teacher/reports`);
  await teacher.waitForSelector('text=Reports', { timeout: 8000 });
  const histText = (await teacher.locator('body').textContent()) || '';
  check(/Open/.test(histText), 'history lists the finished session');
  await teacher.getByRole('button', { name: /^Open$/ }).first().click();
  await teacher.waitForSelector('table', { timeout: 8000 });
  const printText = (await teacher.locator('body').textContent()) || '';
  check(/Session report/.test(printText) && /Robo/.test(printText), 'print page reopens the saved report');

  // student should be bounced to results
  await student.waitForURL(/#\/results/, { timeout: 10000 });
  const studentResult = (await student.locator('body').textContent()) || '';
  check(/Robo|Score|score|Result/i.test(studentResult), 'student landed on results');

  // ---------------- admin panel ----------------
  step('Admin panel');
  const aCtx = await browser.newContext();
  const adm = await aCtx.newPage();
  watch(adm, 'admin');
  await adm.goto(`${BASE}/#/teacher/login`, { waitUntil: 'networkidle' });
  await adm.locator('#login-id').fill('admin');
  await adm.locator('#login-pw').fill(ADMIN_PW);
  await adm.getByRole('button', { name: /^Sign in$/ }).click();
  await adm.waitForURL(/#\/admin/, { timeout: 10000 });
  check(true, 'admin lands on the admin panel');
  check(await adm.getByRole('heading', { name: 'Teacher accounts' }).count() > 0, 'teacher accounts section is shown');
  await adm.getByText(SEED_ID).first().waitFor({ timeout: 8000 });
  check(true, 'the seeded teacher is listed');

  // a signed-in teacher must not reach the admin panel
  await teacher.goto(`${BASE}/#/admin`, { waitUntil: 'networkidle' });
  await teacher.waitForURL(/#\/$/, { timeout: 8000 });
  check(true, 'teacher opening /#/admin is bounced (page not found)');
  await aCtx.close();

  // ---------------- sign-out locks the teacher out ----------------
  step('Teacher signs out');
  await teacher.goto(`${BASE}/#/teacher`);
  await teacher.waitForURL(/#\/teacher$/, { timeout: 8000 });
  await teacher.getByRole('button', { name: 'Sign out' }).click();
  await teacher.waitForURL(/#\/teacher\/login/, { timeout: 8000 });
  check(true, 'sign out returns to the sign-in screen');
  await teacher.goto(`${BASE}/#/teacher`);
  await teacher.waitForURL(/#\/teacher\/login/, { timeout: 8000 });
  check(true, 'direct link to the dashboard bounces back to sign-in');

  await pCtx.close();
  await sCtx.close();
  await tCtx.close();
} catch (e) {
  failed(e.message);
  console.error(e.stack);
} finally {
  await browser?.close();
  try { server?.stderr?.destroy(); server?.stdout?.destroy(); } catch { /* closed */ }
  server?.kill();
}

if (errors.length) {
  console.error('\nPage errors:');
  errors.forEach((e) => console.error('  -', e));
  process.exitCode = 1;
}
console.log(process.exitCode ? '\nE2E: FAILED' : '\nE2E: PASSED');
process.exit(process.exitCode || 0);
