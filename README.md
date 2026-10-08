# 🐍 Python Adventure

A fun, game-like MCQ practice system for **first-time Python learners** (first-year B.Tech CS level).
It is deliberately *not* a serious exam: students build confidence, get instant plain-language
explanations, earn badges, and see a topic strength map instead of a scary mark.

**7 syllabus levels · 84 hand-written questions · boss questions · hints & power-ups · live leaderboard · teacher dashboard with reports.**

---

## Screenshots

| Home | Live question (phone) |
|---|---|
| ![Home](docs/shots/1-home.png) | ![Live question](docs/shots/8-play-question-phone.png) |

| Teacher dashboard | Session report |
|---|---|
| ![Teacher live](docs/shots/9-teacher-live.png) | ![Report](docs/shots/11-teacher-report.png) |

| Feedback (phone) | Student results (phone) |
|---|---|
| ![Feedback](docs/shots/10-feedback-phone.png) | ![Results](docs/shots/12-student-results-phone.png) |

| Light mode home | Light mode teacher live |
|---|---|
| ![Light home](docs/shots/13-light-home.png) | ![Light teacher live](docs/shots/17-teacher-live-light.png) |

| Admin panel | Reports history |
|---|---|
| ![Admin](docs/shots/19-admin.png) | ![Reports](docs/shots/22-reports.png) |

---

## Quick start (local / classroom laptop)

```bash
npm install
npm run dev          # server on :3001 + Vite client on :5173
```

Open http://localhost:5173 — create a session as the teacher, share the 4-character code,
students join from their phones using the same Wi-Fi (or the same laptop/browser tabs).

Other commands:

| Command | What it does |
|---|---|
| `npm run validate` | Lint the question bank (schema, explanations, mini questions, coverage) |
| `npm test` | Unit tests (scoring, badges, quiz building) + live-session integration tests + restart-resilience test + DOM screen tests |
| `npm run e2e` | Full browser test: teacher hosts, student joins, answers, controls, report, reports history, practice mode |
| `npm run a11y` | Accessibility audit: axe-core (WCAG 2.1/2.2 A+AA) + keyboard, focus-ring, tap-target and structure checks on 20 screens × dark/light — exits non-zero on failures, writes `docs/a11y-report.json` with `--json` |
| `npm run shots` | Regenerate the screenshots in `docs/shots/` |
| `npm run build` | Production client bundle into `dist/` |
| `npm start` | Run the server only (serves `dist/` if it exists) |

---

## Architecture

```
questions/bank/*.json   84 questions (12 per syllabus unit) + facts.json (fun facts)
questions/validate.mjs  bank linter (also used by npm run lint)
shared/                 game rules used by BOTH client and server
  scoring.js            fixed marks, power-up costs, negative marking, ranking
  badges.js             badge definitions + incremental evaluation
  quiz.js               level/question building, option shuffling, revision picker
  rng.js                seeded randomness (fair, reproducible question order)
  units.js              syllabus unit names/types/levels (renameable per teacher)
  validate.js           question schema validation (upload preview + editor)
server/
  index.js              Express + Socket.IO, rate limits, HTTP API, static hosting
  auth.js               sign-in, scrypt passwords, in-memory tokens, lockouts
  routes/auth.js        /api/auth/* (login, logout, me, change-password)
  routes/admin.js       /api/admin/* (admin-only; 404 for everyone else)
  sessions.js           live session engine: players, timers, stats, controls, report
  snapshots.js          running-session snapshots (survive a server restart)
  reports.js            saved end-of-session reports (history, print, CSV, needs-review)
  bank.js               bank loading + per-teacher edit/upload layers
  classes.js            per-teacher classes & sections
  units.js              per-teacher unit renames
  filesafe.js           atomic JSON writes with locks
  validate.js           server-side question validation for uploads
client/src/
  main.js               hash router
  auth.js / screens/login.js  teacher + admin sign-in
  reporting.js          shared CSV builder for reports
  game/                 local (practice) engine + live (socket) engine + question renderer
  screens/              home, join, lobby, play, practice, results, teacher*, editor,
                        upload, units, reports, report (print), admin
```

The **same scoring and badge code** runs in practice mode (client) and live mode (server),
so the rules never drift apart.

---

## Deployment

### Option A - one host does everything (recommended: Antideploy)

**Deploy the `Dockerfile` at the repository root.** Antideploy detects it and builds the
image itself, which is the whole point: `dist/` and `node_modules` are never uploaded, so a
host that only runs `node server/index.js` would have no website to serve (blank page, while
`/api/health` still answers 200). The Dockerfile runs `npm ci` + `npm run build`, so the
running container always has `dist/`.

Without Docker, the equivalent two lines on any Node host:

```
npm run build     # -> dist/
node server/index.js
```

Environment variables (set in the host's dashboard or `.env`): the table below. No
`VITE_WS_URL`, no CORS origins to juggle - the browser talks to the origin it came from.
Keep it awake with a cron/health check on `GET /api/health` every few minutes.

If `dist/index.html` is missing when the server boots, it logs a warning and shows an
explanatory page instead of a blank screen - check the logs for `client build missing`.

Read **Know what your host keeps** below before you go live: on Antideploy the filesystem is
temporary unless you attach a persistent `DATA_DIR`.

### Option B - split: Netlify + a WebSocket host

Netlify serves the static client; the Node server goes to a second host
(Render / Railway / Fly / any VPS).

#### Client → Netlify
- Build command: `npm run build`
- Publish directory: `dist`
- Environment variable: `VITE_WS_URL` = the URL of your WebSocket server,
  e.g. `https://python-adventure-server.onrender.com`
  (already wired in `vite.config.js` / `client/src/net.js`)

`netlify.toml` ships the SPA redirect and security headers.

#### Server → Render (or similar)
See `render.yaml`. Environment variables:

| Var | Meaning |
|---|---|
| `PORT` | Provided by the host |
| `ALLOWED_ORIGINS` | Comma-separated list of your other-origin URLs (CORS). Not needed when one host serves client + server |
| `NODE_ENV` | `production` |
| `ADMIN_PASSWORD` | The hidden admin sign-in (see **Accounts & roles**). Set it in `.env`, never commit it |
| `SEED_TEACHER_ID` / `SEED_TEACHER_PASSWORD` | Optional: create one teacher on the very first run only — never overwrites an existing account |
| `DATA_DIR` | Where private files live. Default `server/data`. With `DATABASE_URL` set this is the fast local cache — Postgres holds the durable copy |
| `DATABASE_URL` | Postgres connection string: **everything** (teacher accounts, banks, units, classes, reports, settings, running-session snapshots) is mirrored there and restored on boot, so it survives restarts, redeploys and wiped disks. Antideploy provides it automatically (it sees `pg` in the dependencies) — see **Database setup** below. Without it the app runs file-only (fine for local development) |
| `SESSION_MAX_AGE_HOURS` | A quiz with no activity for this long expires (default `12`) |
| `PA_SESSIONS_DIR` | Optional: where running-session snapshots live (tests use their own) |

Students then open the server URL (Option A) or the Netlify URL (Option B), enter the code
shown on the teacher dashboard, and play.

**Persistence**: everything private lives under one folder, `DATA_DIR` (default `server/data/`
in the repo): teacher accounts, banks, classes, reports and running-session snapshots — the
boot log prints the absolute path. With `DATABASE_URL` set (recommended on any cloud host),
every write is **also mirrored into Postgres** and restored from it on boot, so restarts and
redeploys change nothing (boot log: `storage: mirrored to Postgres`). Running quizzes resume
after a server restart (up to `SESSION_MAX_AGE_HOURS`, default 12 hours old).

### One host does everything (Antideploy, Render, any VPS)

The Express server also serves the built client — no second static host and no `VITE_WS_URL`
are needed: one URL, one process, WebSockets included.

```
npm run build     # writes dist/
node server/index.js
```

Keep the free tier awake: the app answers `GET /api/health` with `{ok, sessions, storage}`
(`storage` is `database` or `file`) — point a cron/health-check at `/api/health` every few
minutes (3 cron jobs per app are plenty).

### Database setup (what survives a restart)

The app keeps its data as JSON files and mirrors every write into **Postgres** when
`DATABASE_URL` is set. Tables are created automatically on the first boot — you never run
any database command by hand.

**On Antideploy (this project's host): nothing to do.** It provisions a free Postgres and
injects `DATABASE_URL` as soon as it sees `pg` in `package.json`:

1. Push the repository and deploy as usual.
2. Open the app's environment settings and confirm `DATABASE_URL` is listed (added
   automatically; you can also paste your own — see the Neon steps below).
3. Check the server log for `storage: mirrored to Postgres (N files, …)` — that line is
   the confirmation everything is durable.
4. Redeploy or restart: teachers, banks, units, reports, settings and any running quiz
   come back exactly as they were.

**Portable alternative — Neon free tier, 5 steps:**

1. Go to <https://neon.tech> and sign up (free, no credit card).
2. Click **Create project**, pick any name and region, press **Create**.
3. On the **Connect** screen copy the connection string
   (`postgres://user:password@host/db?sslmode=require`).
4. In your host's environment variables (Antideploy: app → Environment) add
   `DATABASE_URL` = that connection string — or put it in `.env` on a VPS.
5. Redeploy. The app creates its own tables on the next boot.

(Supabase works the same way: create a project → *Connect* → copy the Postgres string →
set `DATABASE_URL`.)

**If the database is unreachable**, the server **refuses to start on purpose**: the console
prints a `FATAL: the database is unreachable` block saying exactly what to fix, and the
host shows its error page instead of a half-working app. It never falls back to default
users silently. Fix `DATABASE_URL` (or restore the database) and restart.

### Classroom (no internet)
Run `npm run dev` on the teacher laptop and let students join via `http://<teacher-ip>:5173`.

---

## The two modes

**Practice (private)** — no leaderboard, no pressure. Picked topics, automatic *refresher*
questions from your own weak areas, unlimited retries, `Fix my weak spots` at the end.

**Live (classroom)** — join with a code + fun nickname (real name optional), one question at a
time (shared countdown when you turn the timer on, otherwise everyone at their own pace),
instant feedback, streaks, badges, team mode, hidden bottom of the
leaderboard (on by default), and an anonymous *"mistake of the class"* reveal for discussion.

---

## Scoring (fixed marks per question)

Every question is worth a fixed number of **marks** - the teacher sets the defaults and can
override the value on any single question. Two students who answer correctly get exactly the
same marks: no speed bonus, no streak bonus.

| Event | Marks |
|---|---|
| Correct | the question's marks - **easy 1 · medium 1.5 · hard 2** (boss = hard) |
| Match-the-following | all pairs = full marks, otherwise `marks × pairs / total` |
| Wrong | **0**, or **−0.25** when negative marking is switched on (off by default) |
| Timed out / skipped | **0** - never negative, never NaN |
| Try-again mini correct | the mini question's difficulty marks |
| Refresher (🔄) | same rules, ×0.8 |
| Hint / 50-50 / Extra time / Skip | **−0.5 / −1 / −0 / −0** by default |

Power-up costs are charged whenever the power-up was used - correct or not. Totals round to
2 decimals and may go negative when negative marking is on. The score screen shows the
breakdown chips that add up to the total. Ranking: **more marks → more correct → fewer
power-ups → earlier finish** (ties never flip between renders).

Per-quiz keys: `marks:{easy,medium,hard,boss}`, `costs:{hint,fifty,extraTime,skip}`,
`negativeMarking`, `negativeAmount`; per-question: `q.marks` (0–1000).

---

## Badges

🐛 Bug Hunter · 🦸 Comeback Kid · 🔥 On Fire · 🎯 Sharpshooter · ⚡ Speedy Coder ·
💪 Perseverance · 🐲 Boss Slayer · 🏁 Trailblazer · 🧠 Solo Thinker ·
plus one mastery badge per level (🚀 Setup Starter, 🥷 Name Ninja, 🧭 Condition Captain,
🔁 **Loop Master**, 📜 String Sage, 📚 List Legend, 📖 Dict Duke) at 80%+ with ≥4 answers.

---

## Question types

`mcq` · `code-output` ("what does this print?") · `spot-error` · `fill-blank` · `match`
— every question carries an `explanation`, a plain-language `analogy`, a `hint`, and a
**try-again mini question** on the same idea. Boss questions close every level.

Shuffle policy: question *order* is fixed per session (so the teacher's per-question stats line
up) while *options* are shuffled per player and stats are keyed by option id.

---

## Teacher features

- **Four tabs in one top bar**: Home (start a quiz), Question Banks, Reports, Classes - the
  session code, a **Share** dialog (big code + scannable **QR** + copy code / copy link) and
  the live roster are one click away from every screen; the lobby shows the join QR too
- **⚡ Quick start** (sensible defaults → straight into the lobby) or the **4-step wizard**:
  Format → Questions → Scoring → Review, with *Skip to review* jumping to the last step
- Create by topic / difficulty / count, or reopen a running session
- Per-quiz settings: live or practice, question timer (**off by default**), marks per
  difficulty *and* per question, power-up costs, negative marking, option shuffle,
  hints/power-ups, late joins, scheduled start time, class + section tag
- Classes & sections, and renameable syllabus units (🗂️ Manage units)
- Live roster with **attempting / idle / disconnected**, per-student question number, marks, rank
- Per-question correct-vs-wrong and answer-option distribution
- Most-missed questions + class topic weakness heatmap
- Controls: start, pause, resume, next/skip, +10s, show/hide leaderboard, **show answer**
  (both in the shared-clock run and a self-paced one - students get it in readable text),
  reveal the anonymous class mistake, end
- Question editor with full validation, bank-wide check, JSON export, **needs-review** flags
  from real class results
- Upload a JSON question file: validate → preview → import (template + download included),
  kept inside your own bank
- Post-session report: student table, topic bars, time taken, **needs-extra-help** list,
  extended CSV (session info, class, units, needs-review column) and print view
- **Reports history** (`Reports` tab): every finished session stays readable, printable and
  exportable, with a confirm dialog before deletion. Saved reports from the old adaptive
  scoring era still open with their original **Score** wording - marks-era runs say **Marks**
  (and `Marks available`) instead

---

## Fairness & accessibility

- No repeated questions inside a run; options shuffled per player
- Bottom of the leaderboard hidden by default ("everyone is learning 🌱")
- 48px tap targets, ≥16px body text, contrast ≥4.5:1, correct/wrong shown with ✓/✗ **and** colour
- `prefers-reduced-motion` respected, focus rings, `aria-live` feedback, keyboard-operable
- One `<h1>` per screen, ordered headings, `lang`/`title`/`main` landmarks, labelled form controls
- Tap targets ≥24px (WCAG 2.2 AA) and 44px+ for buttons, chips, sliders and power-ups
- `npm run a11y` gates it: axe-core WCAG tags (`wcag2a wcag2aa wcag21a wcag21aa wcag22aa`) run on
  20 screens in both themes, plus custom checks (keyboard reachability of the primary control,
  visible focus ring, target size, page structure, console/page errors). Failures exit 1;
  best-practice rules and anything under our stricter 44px rule are printed as advice only.
  Latest run: 0 failures, 0 warnings (`docs/a11y-report.json`)
- Rate limiting on HTTP and per-socket events; answers validated server-side
- Students never receive `explanation / analogy / hint / answer` in live mode (only the practice
  endpoint, which is a private single-player mode, returns them)

---

## Question bank

84 questions (`12 × 7 units`), each with explanation + analogy + mini question.
Edit them in the app (teacher editor) or by hand in `questions/bank/*.json`, then run
`npm run validate`.

Per teacher, the bank is layered (later layers win):

1. `questions/bank/*.json` — the built-in 84 (shared)
2. `$DATA_DIR/questions-override.json` — legacy shared edits
3. `$DATA_DIR/teachers/<id>/overrides.json` — your edits, deletions and new questions
4. `$DATA_DIR/teachers/<id>/uploads/*.json` — your uploaded batches, in order

---

## Accounts, roles & data

**Two roles.** Teachers manage their own bank, sessions, classes and reports. The **admin**
manages teacher accounts (add, suspend, reset password, delete) — and nothing else.

**Signing in.** Everything teacher-side lives behind `#/teacher/login`, one form for both
roles: the server decides from the credentials. The admin account is *not* stored in the
database — it exists only when `ADMIN_PASSWORD` is set in `.env` on the server. To anyone
else, admin pages answer exactly like a broken link (page-not-found), and every sign-in
failure shows the same generic `Invalid ID or password` (plus a shared lockout message
after 5 bad tries in 15 minutes). Teacher passwords are salted scrypt hashes; the server
never stores or transmits them in clear.

**Tokens.** Sign-in returns an in-memory token (60-minute sliding window, refreshed while
you work; the client also signs you out after 30 minutes of inactivity). Restarting the
server clears all tokens — users simply sign in again.

**Data layout** (everything private, never served statically; `$DATA_DIR` = `DATA_DIR` env,
default `server/data`):

```
$DATA_DIR/
  teachers.json                     teacher accounts (scrypt hashes only)
  teachers/<id>/overrides.json    your question edits
  teachers/<id>/uploads/*.json    your uploaded batches
  teachers/<id>/classes.json      classes & sections
  teachers/<id>/units.json        unit renames
  teachers/<id>/reports/*.json    finished reports (history/print/CSV)
  sessions/<code>.json            running sessions (auto-resume, auto-deleted on end)
  questions-override.json         legacy shared edits
  trash/                          deleted teacher folders (recover by hand)
```

Every `*.json` write keeps a `.bak` of the previous good copy; if the main file is ever
unreadable (crash mid-write, full disk), the server boots from the backup instead of
starting empty.

**Backing up and restoring**: sign in as admin → **Administration** → **Data backup** →
*Export all data* downloads one JSON file (accounts with hashed passwords, banks, units,
classes, reports, settings, session history). *Restore from backup* puts everything back on
the same or a fresh install (replaces all stored data, signs everyone out — you confirm
first). The same file also works as a manual backup: keep it somewhere safe. For a
plain-disk install you can still copy `$DATA_DIR` and `questions/bank/` by hand. Deleting a
report or closing a session never touches your question bank. Tests and the
e2e/a11y/shots scripts run against their own throwaway `DATA_DIR`, so they never touch this
folder.
