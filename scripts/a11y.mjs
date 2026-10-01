// Accessibility audit: axe-core (WCAG 2.x A/AA) + custom keyboard, focus-ring,
// target-size and console-error checks across every route, in both themes.
//
//   node scripts/a11y.mjs            human-readable report, exit 1 on failures
//   node scripts/a11y.mjs --json     also write docs/a11y-report.json
//
// Tiers: "fail" blocks CI (WCAG violations, unreachable controls, dead keyboard,
//        missing focus ring, console errors). "warn" is advice (best-practice
//        rules and targets under our stricter 44px design rule).
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const AXE = join(ROOT, 'node_modules', 'axe-core', 'axe.min.js');
const PORT = 3212;
const BASE = `http://localhost:${PORT}`;
const SEED_ID = 'a11y-teacher';
const SEED_PW = 'a11y-pass-123';
const ADMIN_PW = 'a11y-admin-secret';
// everything this run writes lives here - the real server/data is never touched
const DATA_DIR = join(ROOT, 'server', 'data', 'a11y-test');
const THEMES = ['dark', 'light'];
const WCAG_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
const BEST_PRACTICE = ['best-practice'];
const TARGET_MIN = 24;   // WCAG 2.2 AA
const TARGET_OURS = 44;  // this project's design rule
const wantJson = process.argv.includes('--json');

const findings = [];   // { page, theme, tier, rule, impact, help, target }
const audited = new Set();
const consoleErrors = [];
const log = (...a) => console.log(...a);

function note(page, theme, tier, rule, help, target = '', impact = '') {
  findings.push({ page, theme, tier, rule, help, target, impact });
}

// ---------------------------------------------------------------- plumbing
let server;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function startServer() {
  rmSync(DATA_DIR, { recursive: true, force: true });
  server = spawn(process.execPath, [join(ROOT, 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      NODE_ENV: 'production',
      DATA_DIR,
      SEED_TEACHER_ID: SEED_ID,
      SEED_TEACHER_PASSWORD: SEED_PW,
      ADMIN_PASSWORD: ADMIN_PW,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stderr.on('data', (d) => {
    const s = String(d);
    if (!/DeprecationWarning|ExperimentalWarning/.test(s)) process.stderr.write(`[server] ${s}`);
  });
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`${BASE}/api/health`)).ok) return; } catch { /* booting */ }
    await wait(250);
  }
  throw new Error('server did not start');
}

function watch(page, label) {
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const text = m.text();
    if (/favicon|net::ERR_(ABORTED|CONNECTION)|Failed to load resource: the server responded with a status of 4/.test(text)) return;
    consoleErrors.push({ page: label, text });
  });
  page.on('pageerror', (e) => consoleErrors.push({ page: label, text: `pageerror: ${e.message}` }));
}

async function applyTheme(page, theme) {
  await page.evaluate((t) => {
    document.documentElement.setAttribute('data-theme', t);
    document.documentElement.style.colorScheme = t;
    try {
      const s = JSON.parse(localStorage.getItem('python-adventure-v1') || '{}');
      s.theme = t;
      localStorage.setItem('python-adventure-v1', JSON.stringify(s));
    } catch { /* private mode */ }
  }, theme);
  await wait(120);
}

// ---------------------------------------------------------------- axe
async function runAxe(page, label, theme) {
  await page.addScriptTag({ path: AXE });
  const run = async (tags) => page.evaluate(async (tags_) => {
    const res = await window.axe.run(document, {
      runOnly: { type: 'tag', values: tags_ },
      resultTypes: ['violations'],
    });
    return res.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      help: v.help,
      nodes: v.nodes.slice(0, 4).map((n) => ({
        target: (n.target || []).join(' '),
        summary: (n.failureSummary || '').split('\n').slice(0, 3).join(' '),
      })),
    }));
  }, tags);

  for (const v of await run(WCAG_TAGS)) {
    for (const n of v.nodes) note(label, theme, 'fail', v.id, `${v.help} ${n.summary}`.trim(), n.target, v.impact);
  }
  for (const v of await run(BEST_PRACTICE)) {
    for (const n of v.nodes) note(label, theme, 'warn', v.id, `${v.help} ${n.summary}`.trim(), n.target, v.impact);
  }
}

// ------------------------------------------------- custom: tap targets
async function checkTargets(page, label, theme) {
  const small = await page.evaluate(({ min, ours }) => {
    const sel = 'a[href], button, input, select, textarea, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])';
    const out = [];
    for (const el of document.querySelectorAll(sel)) {
      if (el.closest('[aria-hidden="true"]')) continue;
      // for a checkbox/radio the real target is the label the user clicks
      let target = el;
      if (el.type === 'checkbox' || el.type === 'radio') {
        const lab = (el.labels && el.labels[0]) || el.closest('label');
        if (lab) target = lab;
      }
      const r = target.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || cs.display === 'none') continue;
      const w = Math.round(r.width);
      const h = Math.round(r.height);
      if (Math.min(w, h) < ours) {
        out.push({
          target: (el.getAttribute('aria-label') || el.textContent || el.tagName).trim().slice(0, 48),
          w, h, tier: Math.min(w, h) < min ? 'fail' : 'warn',
        });
      }
    }
    return out;
  }, { min: TARGET_MIN, ours: TARGET_OURS });

  for (const s of small) {
    note(label, theme, s.tier, 'target-size',
      `interactive target is ${s.w}x${s.h}px (minimum ${s.tier === 'fail' ? TARGET_MIN : TARGET_OURS}px)`,
      s.target, 'serious');
  }
}

// ------------------------------------------------- custom: heading + landmarks
async function checkStructure(page, label, theme) {
  const info = await page.evaluate(() => ({
    h1: document.querySelectorAll('h1').length,
    main: document.querySelectorAll('main').length,
    title: document.title,
    lang: document.documentElement.getAttribute('lang'),
    desc: !!document.querySelector('meta[name="description"]'),
    live: document.querySelectorAll('[aria-live]').length,
  }));
  if (info.h1 !== 1) note(label, theme, 'warn', 'page-has-one-h1', `found ${info.h1} <h1> elements, expected exactly 1`, '', 'moderate');
  if (info.main !== 1) note(label, theme, 'fail', 'landmark-one-main', `found ${info.main} <main> elements`, '', 'serious');
  if (!info.lang) note(label, theme, 'fail', 'html-has-lang', 'the <html> element has no lang attribute', '', 'serious');
  if (!info.title) note(label, theme, 'fail', 'document-title', 'the page has no <title>', '', 'serious');
  if (!info.desc) note(label, theme, 'warn', 'meta-description', 'no meta description', '', 'minor');
}

// ------------------------------------------------- custom: keyboard + focus ring
async function checkKeyboard(page, label, theme, primary) {
  await page.evaluate(() => { if (document.activeElement) document.activeElement.blur(); });
  let reached = false;
  let noRing = 0;
  const seen = [];

  for (let i = 0; i < 160; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body || el === document.documentElement) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const ringed = (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0)
        || (cs.boxShadow && cs.boxShadow !== 'none');
      const name = (el.getAttribute('aria-label') || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 60);
      return { tag: el.tagName.toLowerCase(), name, ringed, visible: r.width > 0 && r.height > 0 };
    });
    if (!info || !info.visible) continue;
    seen.push(info);
    if (!info.ringed) noRing++;
    if (primary.test(info.name)) { reached = true; break; }
  }

  if (!reached) {
    note(label, theme, 'fail', 'keyboard-reachable',
      `Tab never reached the primary control ${primary} (focused ${seen.length} elements: ${seen.map((s) => s.name || s.tag).slice(0, 8).join(' | ')})`, '', 'serious');
  }
  if (noRing > 0) {
    note(label, theme, 'fail', 'focus-visible',
      `${noRing} of ${seen.length} keyboard-focused elements had no visible focus ring`, '', 'serious');
  }
  return { reached, tabbed: seen.length };
}

// ------------------------------------------------- orchestrator
async function audit(page, label, opts = {}) {
  audited.add(label);
  for (const theme of THEMES) {
    await applyTheme(page, theme);
    // keyboard walk first: on timed screens the countdown keeps running meanwhile
    if (opts.primary) await checkKeyboard(page, label, theme, opts.primary);
    await runAxe(page, label, theme);
    await checkTargets(page, label, theme);
    await checkStructure(page, label, theme);
    log(`   checked  ${label.padEnd(22)} ${theme}`);
  }
}

// ================================================================ scenarios
let browser;
try {
  await startServer();
  browser = await chromium.launch({ channel: 'chrome', headless: true });

  // ---------- teacher: sign in, then home, editor, live dashboard, report ----------
  const tCtx = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: 'dark' });
  const teacher = await tCtx.newPage();
  watch(teacher, 'teacher');

  await teacher.goto(`${BASE}/#/teacher/login`, { waitUntil: 'networkidle' });
  await audit(teacher, 'login', { primary: /^Sign in$/ });
  await teacher.locator('#login-id').fill(SEED_ID);
  await teacher.locator('#login-pw').fill(SEED_PW);
  await teacher.getByRole('button', { name: /^Sign in$/ }).click();
  await teacher.waitForURL(/#\/teacher$/, { timeout: 10000 });

  await teacher.goto(`${BASE}/#/teacher`, { waitUntil: 'networkidle' });
  await audit(teacher, 'teacher-home', { primary: /Create & open lobby/ });

  // ---------- student: static screens ----------
  const sCtx = await browser.newContext({ viewport: { width: 430, height: 900 }, colorScheme: 'dark' });
  const student = await sCtx.newPage();
  watch(student, 'student');

  await student.goto(`${BASE}/`, { waitUntil: 'networkidle' });
  await audit(student, 'home', { primary: /Enter game code|Continue as/ });

  await student.goto(`${BASE}/#/join`, { waitUntil: 'networkidle' });
  await student.locator('[aria-label="Game code"]').fill('ZZZZ');
  await student.locator('[aria-label="Nickname"]').fill('Ada');
  await audit(student, 'join', { primary: /Join the game/ });

  await student.goto(`${BASE}/#/practice`, { waitUntil: 'networkidle' });
  await audit(student, 'practice-setup', { primary: /Start practicing/ });

  // ---------- live session ----------
  log('\n  live session');
  await teacher.goto(`${BASE}/#/teacher`, { waitUntil: 'networkidle' });
  await teacher.getByRole('button', { name: /Create & open lobby/i }).click();
  await teacher.waitForURL(/#\/teacher\/live/);
  await teacher.waitForSelector('.controls .mono');
  const code = (await teacher.locator('.controls .mono').first().textContent()).trim();
  await audit(teacher, 'teacher-lobby', { primary: /Start the quiz/ });

  await student.goto(`${BASE}/#/join`, { waitUntil: 'networkidle' });
  await student.locator('[aria-label="Game code"]').fill(code);
  await student.locator('[aria-label="Nickname"]').fill('Ada');
  await student.getByRole('button', { name: /Join the game/i }).click();
  await student.waitForURL(/#\/lobby/);
  await audit(student, 'lobby', { primary: /Leave/ });

  await teacher.locator('[aria-label="Start the quiz"]').click();
  await student.waitForURL(/#\/play/);
  await student.waitForSelector('.q-render', { timeout: 10000 });

  // pick an answer first: the submit button stays disabled (and unfocusable) otherwise
  await applyTheme(student, 'dark');
  const opt = student.locator('.options button.option').first();
  if (await opt.count()) await opt.click();
  else {
    const input = student.locator('.q-render input').first();
    if (await input.count()) await input.fill('python');
    else {
      const sel = student.locator('.q-render select').first();
      const vals = await sel.locator('option').evaluateAll((o) => o.map((x) => x.value).filter(Boolean));
      if (vals[0]) await sel.selectOption(vals[0]);
    }
  }
  await audit(student, 'live-question', { primary: /Lock in my answer|Next/ });

  await teacher.waitForSelector('.card');
  await audit(teacher, 'teacher-live-question', { primary: /Pause the quiz|Next/ });

  await student.getByRole('button', { name: /Lock in my answer/i }).click();
  await student.waitForSelector('.explain', { timeout: 8000 });
  await audit(student, 'live-feedback');

  // ---------- end of session: report + results ----------
  await applyTheme(teacher, 'dark');
  await teacher.locator('[aria-label="End the quiz and open the report"]').click();
  await teacher.getByRole('button', { name: /^End quiz$/ }).click();
  await teacher.waitForSelector('text=Ada', { timeout: 10000 });
  await audit(teacher, 'teacher-report');

  await student.waitForURL(/#\/results/, { timeout: 10000 });
  await audit(student, 'results');

  // ---------- teacher question editor (unlocked by the session token) ----------
  await applyTheme(teacher, 'dark');
  await teacher.goto(`${BASE}/#/teacher/edit`, { waitUntil: 'networkidle' });
  await teacher.waitForSelector('form, .card', { timeout: 8000 });
  // open a form so the save button exists, then prove the keyboard can reach it
  await teacher.getByRole('button', { name: /New question/i }).click();
  await teacher.getByRole('button', { name: /Save question/i }).waitFor({ timeout: 8000 });
  await audit(teacher, 'question-editor', { primary: /Save question|Create/ });

  // ---------- upload screen (template, guide, preview) ----------
  log('\n  question upload');
  await applyTheme(teacher, 'dark');
  await teacher.goto(`${BASE}/#/teacher/upload`, { waitUntil: 'networkidle' });
  await teacher.waitForSelector('input[type="file"]', { timeout: 8000 });
  await audit(teacher, 'upload-questions', { primary: /Template JSON/ });

  // ---------- unit management ----------
  log('\n  unit management');
  await applyTheme(teacher, 'dark');
  await teacher.goto(`${BASE}/#/teacher/units`, { waitUntil: 'networkidle' });
  await teacher.waitForSelector('input[aria-label="Unit 1 name"]', { timeout: 8000 });
  await audit(teacher, 'manage-units', { primary: /Save units/ });

  // ---------- saved reports (history + printable page) ----------
  log('\n  saved reports');
  await applyTheme(teacher, 'dark');
  await teacher.goto(`${BASE}/#/teacher/reports`, { waitUntil: 'networkidle' });
  await teacher.waitForSelector('.card', { timeout: 8000 });
  await audit(teacher, 'reports-history', { primary: /Dashboard/ });

  // the print page needs a saved report: seed one straight onto disk
  const reportDir = join(DATA_DIR, 'teachers', SEED_ID, 'reports');
  mkdirSync(reportDir, { recursive: true });
  writeFileSync(join(reportDir, 'A11Y.json'), JSON.stringify({
    code: 'A11Y',
    title: 'Python Adventure',
    startedAt: Date.now() - 600000,
    endedAt: Date.now() - 120000,
    config: { mode: 'live', className: 'Year 7', section: 'Blue' },
    totals: { players: 2, answers: 6, accuracy: 0.58 },
    players: [
      {
        nickname: 'Ada', team: 'Blue', score: 420, correct: 4, wrong: 2, accuracy: 0.67,
        totalTimeMs: 74000, bestStreak: 3, badges: ['on_fire'], needsHelp: false,
      },
      {
        nickname: 'Grace', team: 'Blue', score: 180, correct: 2, wrong: 4, accuracy: 0.33,
        totalTimeMs: 96000, bestStreak: 1, badges: [], needsHelp: true,
      },
    ],
    questions: [
      {
        id: 'u7-q01', unit: 7, prompt: 'What does dict.get("k") return when "k" is missing?',
        correct: 1, wrong: 5, missRate: 0.83, avgTimeMs: 5200,
      },
      {
        id: 'u4-q03', unit: 4, prompt: 'Which loop runs at least once even if the test fails first?',
        correct: 4, wrong: 2, missRate: 0.33, avgTimeMs: 3100,
      },
    ],
    unitStats: {
      7: { correct: 3, total: 6, accuracy: 0.5 },
      4: { correct: 3, total: 6, accuracy: 0.5 },
    },
    struggling: [{ id: 'u7-q01', prompt: 'What does dict.get("k") return when "k" is missing?', missRate: 0.83 }],
    needsHelp: ['Grace'],
  }, null, 2));
  await teacher.goto(`${BASE}/#/teacher/report/A11Y`, { waitUntil: 'networkidle' });
  await teacher.waitForSelector('table', { timeout: 8000 });
  await audit(teacher, 'report-print', { primary: /Print report/ });

  // ---------- admin panel (only the admin role gets in) ----------
  log('\n  admin panel');
  const aCtx = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: 'dark' });
  const adminPage = await aCtx.newPage();
  watch(adminPage, 'admin');
  await adminPage.goto(`${BASE}/#/teacher/login`, { waitUntil: 'networkidle' });
  await adminPage.locator('#login-id').fill('admin');
  await adminPage.locator('#login-pw').fill(ADMIN_PW);
  await adminPage.getByRole('button', { name: /^Sign in$/ }).click();
  await adminPage.waitForURL(/#\/admin/, { timeout: 10000 });
  await adminPage.getByText('Teacher accounts').first().waitFor({ timeout: 8000 });
  await audit(adminPage, 'admin-panel', { primary: /Add teacher/ });

  // ---------- practice mode ----------
  log('\n  practice session');
  const pCtx = await browser.newContext({ viewport: { width: 1360, height: 900 }, colorScheme: 'dark' });
  const practice = await pCtx.newPage();
  watch(practice, 'practice');
  await practice.goto(`${BASE}/#/practice`, { waitUntil: 'networkidle' });
  await practice.getByRole('button', { name: /Start practicing/i }).click();
  await practice.waitForSelector('.q-render', { timeout: 15000 });

  // select an answer first so the keyboard walk can reach the submit button
  const pOpt = practice.locator('.options button.option').first();
  if (await pOpt.count()) await pOpt.click();
  else {
    const input = practice.locator('.q-render input').first();
    if (await input.count()) await input.fill('python');
    else {
      const sel = practice.locator('.q-render select').first();
      const vals = await sel.locator('option').evaluateAll((o) => o.map((x) => x.value).filter(Boolean));
      if (vals[0]) await sel.selectOption(vals[0]);
    }
  }
  await audit(practice, 'practice-question', { primary: /Lock in my answer/ });

  await practice.getByRole('button', { name: /Lock in my answer/i }).click();
  await practice.waitForSelector('.explain', { timeout: 10000 });
  await audit(practice, 'practice-feedback');

  await pCtx.close();
  await sCtx.close();
  await tCtx.close();
} catch (e) {
  note('script', '-', 'fail', 'scenario-crashed', e.message, '', 'critical');
  console.error('\nscenario crashed:', e.message, '\n', e.stack);
} finally {
  await browser?.close();
  try { server?.stderr?.destroy(); server?.stdout?.destroy(); } catch { /* closed */ }
  server?.kill();
  rmSync(DATA_DIR, { recursive: true, force: true });
}

// ================================================================ report
const fails = findings.filter((f) => f.tier === 'fail');
const warns = findings.filter((f) => f.tier === 'warn');

function print(list, title) {
  if (!list.length) return;
  console.log(`\n${title} (${list.length})`);
  const byPage = new Map();
  for (const f of list) {
    const key = `${f.page} · ${f.theme}`;
    if (!byPage.has(key)) byPage.set(key, []);
    byPage.get(key).push(f);
  }
  for (const [key, items] of byPage) {
    console.log(`  ${key}`);
    const seenRule = new Set();
    for (const f of items) {
      const sig = `${f.rule}|${f.target}`;
      if (seenRule.has(sig)) continue;
      seenRule.add(sig);
      console.log(`    - [${f.impact || 'n/a'}] ${f.rule}: ${f.help}${f.target ? `  (${f.target})` : ''}`);
    }
  }
}

console.log('\n==============================================');
console.log(` accessibility: ${fails.length} failures, ${warns.length} warnings`);
console.log('==============================================');
print(fails, 'FAILURES');
print(warns, 'ADVICE');

if (consoleErrors.length) {
  const uniq = [...new Set(consoleErrors.map((c) => `${c.page}: ${c.text}`))];
  console.log(`\nCONSOLE ERRORS (${uniq.length})`);
  uniq.forEach((u) => console.log(`  - ${u}`));
}

const pages = [...audited];
console.log(`\n pages audited: ${pages.length}  (${pages.join(', ')})`);
console.log(` themes: ${THEMES.join(' + ')}   axe tags: ${WCAG_TAGS.join(', ')}`);

if (wantJson) {
  const out = join(ROOT, 'docs', 'a11y-report.json');
  writeFileSync(out, JSON.stringify({
    generatedAt: new Date().toISOString(),
    wcagTags: WCAG_TAGS,
    failures: fails.length,
    warnings: warns.length,
    consoleErrors,
    findings,
  }, null, 2));
  console.log(` json report: ${out}`);
}

process.exit(fails.length || consoleErrors.length ? 1 : 0);
