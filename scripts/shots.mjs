// Screenshots of every major screen for the README / review.
// Run: npm run build && node scripts/shots.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'docs', 'shots');
const PORT = 3211;
const BASE = `http://localhost:${PORT}`;
const SEED_ID = 'shots-teacher';
const SEED_PW = 'shots-pass-123';
const ADMIN_PW = 'shots-admin-secret';
// everything this run writes lives here - the real server/data is never touched
const DATA_DIR = join(ROOT, 'server', 'data', 'shots-test');
const SESSIONS_DIR = join(DATA_DIR, 'sessions');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
mkdirSync(OUT, { recursive: true });
rmSync(DATA_DIR, { recursive: true, force: true });

const shot = (page, name) => page.screenshot({ path: join(OUT, `${name}.png`), animations: 'disabled', timeout: 15000 });

async function signIn(page) {
  await page.goto(`${BASE}/#/teacher/login`, { waitUntil: 'networkidle' });
  await page.locator('#login-id').fill(SEED_ID);
  await page.locator('#login-pw').fill(SEED_PW);
  await page.getByRole('button', { name: /^Sign in$/ }).click();
  await page.waitForURL(/#\/teacher$/, { timeout: 10000 });
}

let server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
  env: {
    ...process.env,
    DATABASE_URL: '',   // screenshots run file-only - never mirror into a real database
    PORT: String(PORT),
    NODE_ENV: 'production',
    DATA_DIR,
    PA_SESSIONS_DIR: SESSIONS_DIR,
    SEED_TEACHER_ID: SEED_ID,
    SEED_TEACHER_PASSWORD: SEED_PW,
    ADMIN_PASSWORD: ADMIN_PW,
  },
  stdio: ['ignore', 'ignore', 'pipe'],
});
server.stderr.on('data', (d) => process.stderr.write(`[server] ${d}`));

for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`${BASE}/api/health`)).ok) break; } catch { /* booting */ }
  await wait(250);
}

const browser = await chromium.launch({ channel: 'chrome', headless: true });
try {
  // ---- static screens ----
  const t = await (await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: 'dark' })).newPage();
  await t.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await shot(t, '1-home');
  await t.goto(`${BASE}/#/join`, { waitUntil: 'networkidle' });
  await shot(t, '2-join');
  await t.goto(`${BASE}/#/practice`, { waitUntil: 'networkidle' });
  await shot(t, '3-practice');
  await t.goto(`${BASE}/#/teacher/login`, { waitUntil: 'networkidle' });
  await shot(t, '18-teacher-login');
  await signIn(t);
  await t.goto(`${BASE}/#/teacher`, { waitUntil: 'networkidle' });
  await shot(t, '4-teacher-home');
  await t.goto(`${BASE}/#/teacher/edit`, { waitUntil: 'networkidle' });
  await t.waitForSelector('.pa-split', { timeout: 8000 });
  await shot(t, '5-editor');

  await t.goto(`${BASE}/#/teacher/upload`, { waitUntil: 'networkidle' });
  await t.waitForSelector('input[type="file"]', { timeout: 8000 });
  await shot(t, '20-upload');

  await t.goto(`${BASE}/#/teacher/units`, { waitUntil: 'networkidle' });
  await t.waitForSelector('.card', { timeout: 8000 });
  await shot(t, '21-units');

  // ---- the same screens in light mode (fresh context, no saved choice yet) ----
  const lt = await (await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: 'light' })).newPage();
  await lt.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await shot(lt, '13-light-home');
  await lt.goto(`${BASE}/#/practice`, { waitUntil: 'networkidle' });
  await shot(lt, '14-light-practice');
  await signIn(lt);
  await lt.goto(`${BASE}/#/teacher`, { waitUntil: 'networkidle' });
  await shot(lt, '15-light-teacher-home');
  await lt.context().close();

  // ---- a live session in progress ----
  await t.goto(`${BASE}/#/teacher`, { waitUntil: 'networkidle' });
  await t.getByRole('button', { name: /Create & open lobby/i }).click();
  await t.waitForURL(/#\/teacher\/live/);
  await t.waitForSelector('.controls .mono');
  const code = (await t.locator('.controls .mono').first().textContent()).trim();
  await shot(t, '6-teacher-lobby');

  const s = await (await browser.newContext({ viewport: { width: 430, height: 900 }, colorScheme: 'dark' })).newPage();
  await s.goto(`${BASE}/#/join`, { waitUntil: 'networkidle' });
  await s.locator('[aria-label="Game code"]').fill(code);
  await s.locator('[aria-label="Nickname"]').fill('Ada');
  await s.getByRole('button', { name: /Join the game/i }).click();
  await s.waitForURL(/#\/lobby/);
  await shot(s, '7-student-lobby-phone');

  await t.getByRole('button', { name: /Start the quiz/i }).click();
  await s.waitForURL(/#\/play/);
  await s.waitForSelector('.q-render', { timeout: 10000 });
  await shot(s, '8-play-question-phone');
  await shot(t, '9-teacher-live');

  const opt = s.locator('.options button.option').first();
  if (await opt.count()) await opt.click();
  else {
    const input = s.locator('.q-render input').first();
    if (await input.count()) await input.fill('python');
    else {
      const sel = s.locator('.q-render select').first();
      const vals = await sel.locator('option').evaluateAll((o) => o.map((x) => x.value).filter(Boolean));
      if (vals[0]) await sel.selectOption(vals[0]);
    }
  }
  await s.getByRole('button', { name: /Lock in my answer/i }).click();
  await s.waitForSelector('.explain', { timeout: 8000 });
  await shot(s, '10-feedback-phone');

  // the same screen in light mode (flip the theme without a reload)
  await s.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.style.colorScheme = 'light';
  });
  await wait(150);
  await shot(s, '16-feedback-phone-light');
  await t.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'light');
    document.documentElement.style.colorScheme = 'light';
  });
  await wait(150);
  await shot(t, '17-teacher-live-light');
  await t.evaluate(() => {
    document.documentElement.setAttribute('data-theme', 'dark');
    document.documentElement.style.colorScheme = 'dark';
  });

  await t.locator('[aria-label="End the quiz and open the report"]').click();
  await t.getByRole('button', { name: /^End quiz$/ }).click();
  await t.waitForSelector('text=Ada', { timeout: 10000 });
  await shot(t, '11-teacher-report');
  await s.waitForURL(/#\/results/, { timeout: 10000 });
  await shot(s, '12-student-results-phone');

  // ---- saved reports: history + printable page (this run just finished) ----
  await t.goto(`${BASE}/#/teacher/reports`, { waitUntil: 'networkidle' });
  await t.getByRole('button', { name: /^Open$/ }).first().waitFor({ timeout: 8000 });
  await shot(t, '22-reports');
  await t.getByRole('button', { name: /^Open$/ }).first().click();
  await t.waitForSelector('table', { timeout: 8000 });
  await shot(t, '23-report-print');

  // ---- admin panel (separate context: only the admin role gets in) ----
  const aCtx = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: 'dark' });
  const a = await aCtx.newPage();
  await a.goto(`${BASE}/#/teacher/login`, { waitUntil: 'networkidle' });
  await a.locator('#login-id').fill('admin');
  await a.locator('#login-pw').fill(ADMIN_PW);
  await a.getByRole('button', { name: /^Sign in$/ }).click();
  await a.waitForURL(/#\/admin/, { timeout: 10000 });
  await a.getByText('Teacher accounts').first().waitFor({ timeout: 8000 });
  await shot(a, '19-admin');
  await aCtx.close();

  console.log(`\nScreenshots written to ${OUT}`);
} catch (e) {
  console.error('shots failed:', e.message);
  process.exitCode = 1;
} finally {
  await browser.close();
  try { server?.stderr?.destroy(); server?.stdout?.destroy(); } catch { /* closed */ }
  server?.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
