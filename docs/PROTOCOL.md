# Python Adventure - internal contracts

Read this before touching client or server code. Everything below is already implemented.

## File map

| File | Purpose |
|---|---|
| `shared/scoring.js` | `scoreAnswer()`, `teamSummary()`, `comparePlayers()`, `comparePlayersSelfPaced()`, `hintsUsed()`, point constants |
| `shared/badges.js` | `BADGES`, `TOPIC_BADGES`, `evaluateBadges()`, `badgeById()`, `ENCOURAGEMENTS` |
| `shared/quiz.js` | `buildQuiz()`, `chooseRefreshers()`, `shuffleOptions()`, `timerFor()`, `strengthMap()`, `BAND_INFO` |
| `shared/rng.js` | seeded RNG |
| `shared/units.js` | `UNITS`, `unitName()`, `DEFAULT_SET_NAME`, `UNCATEGORIZED`, `fileUnitName()`, `fileUnitList()`, `QUESTION_TYPES`, `DIFFICULTIES` |
| `shared/validate.js` | `validateQuestions()` - upload preview + editor validation (`fileUnits:true` mode accepts named/unlisted units; optional per-question `unitName` ≤60 chars names a numeric unit) |
| `server/bank.js` | `loadBank()`, `saveQuestion()`, `deleteQuestion()`, `getFacts()`, `unitsSummary()`, `publicQuestion()`, `ownerDirFor()` (per-teacher layering), question-bank helpers (`getSet/setSummaries/recordUpload/appendSet/renameSet/loadSetQuestions/setDisplayName/sanitizeSettings/saveSetQuestion/removeSetQuestion/duplicateSet/clearOwnerOverride/writeSetFile`) |
| `server/auth.js` | scrypt passwords, in-memory tokens (60-min sliding), lockouts, admin via `ADMIN_PASSWORD` |
| `server/routes/auth.js` | `/api/auth/*` (login, logout, me, change-password) |
| `server/routes/admin.js` | `/api/admin/*` (admin-only, 404 otherwise) |
| `server/sessions.js` | `Session`, `SessionStore` (`restoreAll()`), `judge()` |
| `server/snapshots.js` | running-session snapshots under `data/sessions/` (`PA_SESSIONS_DIR` overrides) |
| `server/reports.js` | saved reports: `saveReport/listReports/getReport/deleteReport/needsReview` |
| `server/classes.js` | per-teacher classes & sections; `server/units.js` | per-teacher unit renames |
| `server/filesafe.js` | `withLock`, atomic `writeJsonSync/writeJson/updateJson` |
| `server/index.js` | express + socket.io, HTTP API, rate limits |
| `client/src/ui.js` | `h(tag, props, ...kids)`, `mount(root, ...nodes)`, `toast()`, `confetti()`, `climbToast()`, `modal()`, `fmtClock()`, `pct()` |
| `client/src/net.js` | `getSocket()`, `emitAck(event, payload)`, `on(event, cb)`, `request(url, {token, body, method})` |
| `client/src/state.js` | `store`, `save(patch)` - persisted keys: `nickname, team, code, playerId, teacherToken, teacherCode, practiceConfig, lastReport, editorBankId, quizBankId` |
| `client/src/bankui.js` | `bankLine()`, `renameBankModal()`, `confirmRemoveBank()`, `duplicateBank()` - the shared question-bank dialogs (upload + editor) |
| `client/src/auth.js` | token storage, `authToken()/isTeacher()/isAdmin()`, 30-min idle sign-out |
| `client/src/reporting.js` | `csvOf(report, unitLabel)`, `downloadCsv()` - shared CSV export |
| `client/src/main.js` | `go(hash)` router. Routes: `#/`, `#/join`, `#/lobby`, `#/play`, `#/results`, `#/practice`, `#/teacher/login`, `#/teacher`, `#/teacher/live`, `#/teacher/edit`, `#/teacher/upload`, `#/teacher/units`, `#/teacher/reports`, `#/teacher/report/:code`, `#/admin` |
| `client/src/game/*` | `session.js` (`setActiveGame/getActive/clearActive`), `localEngine.js`, `liveEngine.js`, `questionView.js` |

Screen modules export: `render(root, params)` and optional `destroy()` and `title`.
`report.js` reads its `:code` from `location.hash` (`/#/teacher/report/<CODE>`).
`editor.js` edits **one selected bank at a time** (`store.editorBankId`, default
`'default'`): questions, unit dropdown, tags, id rules, save/delete routes and the
`Select Question Bank` selector all come from `/api/sets/:id/questions` + `/api/sets`
summaries - never from merged lists.

## Auth & roles

- One sign-in form (`POST /api/auth/login {id, password}`) for teachers **and** the admin;
  failures always return `Invalid ID or password` (401). 5 bad tries per id per 15 minutes
  -> shared `LOCKOUT_MESSAGE`. Login route is rate-limited separately.
- Teacher passwords: ≥8 chars, stored as scrypt `s1$<saltB64>$<hashB64>` (N=16384).
  Seed via `SEED_TEACHER_ID`/`SEED_TEACHER_PASSWORD`; `POST /api/auth/change-password`
  for forced first-time changes (`mustChangePassword`).
- Admin: never stored - enabled only by `ADMIN_PASSWORD` in the server's `.env`
  (sha256 + constant-time compare). Admin HTTP routes answer **404** for non-admins,
  same as a missing page; `#/admin` client route bounces to `#/`.
- Tokens: in-memory, 60-min sliding TTL, header `x-teacher-token`. `requireAuth('teacher','admin')`
  attaches `req.auth = {role, id, name, mustChangePassword}`; anon -> 401.
- Socket auth: `host:create`/`host:join` carry `token`; the server stamps `ownerId/ownerName`
  on the session. `host:create` refuses tokens whose profile `mustChangePassword`.

## Files & persistence

- Atomic JSON everywhere via `server/filesafe.js` (tmp -> bak -> rename, per-path locks).
- Per-teacher bank layers (later wins): `questions/bank/*.json` ->
  `server/data/questions-override.json` -> `teachers/<id>/overrides.json`
  (tombstones `__deleted`) -> `teachers/<id>/uploads/*.json`.
- **Question banks**: every upload batch is its own bank (`teachers/<id>/uploads/<file>.json`,
  id = file stem). The pseudo-bank `default` = base + override layers only (never uploads).
  **Banks own their units**: numeric unit ids keep their id but take their display name from
  the bank's own file (`unitName` / wrapper `units:[{id,name}]`), never from the teacher's
  shared list; `GET /api/units/list` and `GET /api/units` cover the shared/default layer only,
  so bank units never leak in and shared names never leak out. Wrapper uploads
  (`{file:{title, settings, units, questions}}`) also store quiz defaults
  (`sanitizeSettings`: points/timers/reveal/timerOn/commonSeconds/quizSeconds/count/difficulty).
  `loadSetQuestions(owner, file)` re-reads the file fresh + applies the same override layers;
  a session snapshots its bank's questions (`setBank`) at create, so a running quiz survives
  bank deletion or server restart. Bank unit ids: file units keep their original numeric ids;
  named/missing units get bank-local ids starting at 100 (syllabus = 1-7, teacher custom = 8-99).
  Missing units collapse into `Uncategorized` (renamable via `PUT /api/sets/:id`).
- **Session snapshots**: every mutating session call writes
  `data/sessions/<code>.json` (`snapshot()` - players with `socketId:null`, quiz entries,
  stats, timers as `endsAt`). `SessionStore.restoreAll()` runs at boot: restores sessions
  <12h old, re-arms question/reveal timers, drops `ended`/stale files. `end()` drops the
  snapshot (the report takes over); `host:close` deletes both memory + file.
  On `player:join`, a player with the same nickname and a dead socket is **rebound**
  (keeps score/id) instead of duplicated - covers page refresh and server restart.
- **Reports**: `end()` also writes `teachers/<id>/reports/<code>.json`
  (`saveReport`), powering `GET /api/reports*`, `DELETE /api/reports/:code`
  and `GET /api/needs-review` (questions with missRate ≥50% over recent runs).

## Socket protocol

### Host (teacher)

| Event (client -> server) | Payload | Ack reply |
|---|---|---|
| `host:create` | `{title, units:[1..7], count, difficulty, teamMode, hideBottom, revealSeconds, mode:'live'\|'practice', timers:{easy,medium,hard,bossExtra}, points:{easy,medium,hard,boss}, shuffleOptions, allowHints, allowPowerups, lateJoin, opensAt, classId, className, section, questionIds?, setId?, useFacts, revisionRounds, leaderboardToStudents, timerOn, commonSeconds?, quizSeconds?, allowBack?, allowSkip?, token}` | `{ok, code, token, config}` (server stamps `ownerId/ownerName`; `config` carries the binding `setId/setName/setCount/unitNames` - `unitNames: null` for `default` = syllabus names) |
| `host:join` | `{code, token}` | `{ok, code, config, roster, stats, state}` - `state = hostState()`: `{status, phase, qIndex, total, endsAt, selfPaced, timerOn, question?, meta?}` so a refreshed/restarted teacher lands on the live question; the set binding in `config` never changes while the session lives |
| `host:start` | - | `{ok, total}` |
| `host:control` | `{action, seconds?, on?}` | `{ok, action, report?}` (gates: scheduled `opensAt` blocks start) |
| `host:end` | - | `{ok, report}` (report is saved to `teachers/<id>/reports/<code>.json`) |
| `host:close` | - | `{ok}` (drops the session **and** its snapshot) |

`host:create` with `setId` binds the whole run to that one bank: `config.units` is clamped
to the bank's own units, the bank is `loadSetQuestions()` (404-style ack error
`That question bank no longer exists.` when missing/deleted), and every question event
carries `unitLabel` (the bank's display name for its unit). `setId` wins over `questionIds`;
no `setId` = legacy merged-bank behaviour. The default bank answers from the built-in bank.

`action` is one of:
`start` `pause` `resume` `next` `skip` `extend` `show-leaderboard` `hide-leaderboard`
`reveal-mistake` (anonymous most-chosen wrong answer, emitted as `class:mistake` to everyone)
`show-answer` (emits `answer:shown`) `end`
`timer` (`{on:bool}` flips the Question Timer switch: ack `{ok, timerOn, effective:'now'|'next question', error?}`).

**Question timer**: `timerOn:true` (default) = one shared countdown per question
(`timerFor(q, timers, commonSeconds)`: per-question `timeLimit` (1-300s) > `commonSeconds`
> per-difficulty defaults + boss extra). `timerOn:false` = self-paced: every student drives
their own `player:advance`/`player:goto`, no countdown (`duration:null`), no shared reveal,
no speed bonus, ranked score -> fewer hints -> earlier `finishedAt`. While self-paced,
`next`/`skip`/`extend`/`show-answer`/`reveal-mistake` answer with an error. Flipping the
switch mid-run: OFF bites from the *next* question (the running one keeps its clock -
`currentPaced` tracks what is on screen); ON re-syncs the class on the furthest question
(`resumeLockstep`, `effective:'now'`). Paused quizzes reject the flip.
`quizSeconds` arms a whole-quiz limit at start; `allowBack` (default off) / `allowSkip`
(default on) shape the paced student controls.

**Teacher token**: returned by `host:create`. Send it as header `x-teacher-token` on every
HTTP call to `/api/bank` (GET list, POST save, DELETE /:id). Persist it in `store.teacherToken`.

### Players

| Event | Payload | Notes |
|---|---|---|
| `player:join` | `{code, nickname, team?}` | `{ok, playerId, code, title, teamMode, status, phase, started, leaderboard, players, timerOn, selfPaced, allowBack, allowSkip, quizEndsAt}` + `question:start` (or `player:finished`) when joining mid-question. **Rebind**: same nickname + a dead socket (refresh/restart) returns the *existing* `playerId` with score intact instead of a duplicate. Rejects: unknown code, ended session, `lateJoin:false` while running, full room (200). |
| `player:answer` | `{qIndex, answer}` | `{result}` or `{error}` |
| `player:advance` | `{skip?}` | self-paced Next/Skip: `{ok, qIndex, total}` or `{error}` (answer-first, `allowSkip`, finished and not-currently-paced guards) |
| `player:goto` | `{qIndex}` | self-paced Back: `{ok, qIndex, review}` or `{error}` (`allowBack` guard; answered questions come back read-only; only earlier indexes) |
| `player:powerup` | `{kind:'hint'\|'fifty'\|'extraTime'\|'skip'}` | honours `allowHints`/`allowPowerups` config; `extraTime` is refused while the timer is off |
| `player:ping` / `player:leave` | - | roster heartbeats / explicit leave |

### Server -> clients

| Event | Payload |
|---|---|
| `roster` (teacher room) | `{players:[{id,nickname,team,score,qIndex,answered,finished,answeredCount,status:'attempting'\|'idle'\|'disconnected',correct,wrong,streak,rank,badges}], phase, qIndex, total, status, selfPaced, timerOn}` |
| `question:stats` (teacher) | `{qIndex, prompt, type, counts:{optionId:n}, correct, wrong, answered, options, answer, revealing, selfPaced, answeredTotal, finishedCount, playersTotal, missed:[{index,id,missRate,total}], unitStats:{[unit]:{correct,total,accuracy}}}` |
| `leaderboard` | `{mode:'solo', entries:[{id,nickname,team,score,rank,correct,wrong,streak,badges,me}], hidden, total, visible}` or `{mode:'team', teams:[{name,score,correct,accuracy,members,rank}], entries, ...}` |
| `question:start` | `{qIndex,total,question:{...public},duration,endsAt,refresher,unit,unitLabel,boss,selfPaced,quizEndsAt,playerId?}` - self-paced adds `duration:null, endsAt:null, allowBack, allowSkip` and `review:{correct,yourAnswer,correctAnswer,accepted,pairs}?` when the student already answered this index. `unitLabel` = the set's display name for `unit` (null falls back to the syllabus name client-side) |
| `question:reveal` | `{qIndex,correctAnswer,accepted,pairs,stats,distribution,explanation,analogy,mini,fact:{kind,text},endsAt}` (shared questions only - never in self-paced mode) |
| `question:sync` | `{endsAt, extended?}` |
| `class:mistake` | `{count, option:{id,text}, options, answer, explanation}` |
| `answer:shown` | `{answer, accepted, explanation}` |
| `control` | `{action:'pause'\|'resume'\|'timer-changed'\|'show-leaderboard'\|'hide-leaderboard', remaining?, timerOn?, effective?, ...}` (`timer-changed` carries `{timerOn, effective:'now'\|'next question'}`) |
| `phase` | `{phase:'question'\|'reveal'\|'ended', qIndex, endsAt, selfPaced?}` |
| `player:finished` | `{score, correct, wrong, answered, total, badges:[{id,name,icon,desc}], playerId}` - a self-paced student reached the end |
| `quiz:end` | `{report}` |

`publicQuestion()` strips: `explanation, analogy, mini, hint, answer`. Never send those to students.

## Report shape (`buildReport()` / `quiz:end` / `GET /api/sessions/:code/report`)

```js
{
  code, title, startedAt, endedAt, config,   // config carries timerOn/commonSeconds/quizSeconds/allowBack/allowSkip + setId/setName/setCount/unitNames (null = syllabus names)
  players: [{ id, nickname, team, rank, score, correct, wrong, skipped,
              accuracy, totalTimeMs, bestStreak, badges:[id], unitStats:{[unit]:{correct,total,accuracy}},
              weakUnits:[], needsHelp:bool, finished:bool, finishedAt:ms|null,
              answerTimes:[ms|null per question index],
              log:[{id,correct,refresher,qIndex,timeMs}] }],
  questions: [{ index, id, unit, type, difficulty, boss, refresher, prompt,
                correct, wrong, missRate, avgTimeMs }],
  unitStats: {[unit]:{correct,total,accuracy}},
  weakUnits: [], struggling: [{id,prompt,missRate}],
  needsHelp: [nickname], totals: {players, answers, correct, accuracy}
}
```

## HTTP API

Auth column: `-` public, `t` teacher or admin (`x-teacher-token`, 401 otherwise),
`a` admin only (404 for everyone else). Limits: 120 req/min per IP on `/api` (except
login 10/min and practice 30/min), JSON body cap 512kb.

| Route | Auth | Returns |
|---|---|---|
| `GET /api/health` | - | `{ok, sessions}` |
| `GET /api/units` | - | `{[unit]:{total,byDifficulty,types}}` - shared/default layer only (bank units excluded) |
| `GET /api/units/list` | t | `[{id, name, custom}]` (your renames + built-ins) |
| `PUT /api/units/list` | t | `{ok}` - rename built-ins / add custom units (unsafe deletes rejected) |
| `GET /api/facts` | - | `{bugs:[], didYouKnow:[]}` |
| `GET /api/questions` | - | public questions (no answers) |
| `GET /api/practice?units=1,2&count=12&difficulty=mixed` | - | `{questions, pool}` full questions |
| `POST /api/auth/login` | - | `{token, role, id, name, mustChangePassword}` or `Invalid ID or password` |
| `GET /api/auth/me` | t | current profile (sliding TTL refresh) |
| `POST /api/auth/logout` | t | `{ok}` (drops the token) |
| `POST /api/auth/change-password` | t | `{ok}` (teacher-only: the admin has no stored password; clears `mustChangePassword`) |
| `GET /api/bank` | t | full bank with answers (scoped to your layers) |
| `POST /api/bank` | t | body = question, saves override |
| `DELETE /api/bank/:id` | t | `{ok}` (built-ins can't be deleted, `{ok:false}`) |
| `POST /api/upload` | t | `{ok, added, skipped, file, set, appended?}` - `file` = the bank id, `set` = `setSummaries` entry (name/kind/count/units/label/settings). Validated with `fileUnits:true` (named or missing units accepted; unknown numeric units still rejected). Body is either `{name, questions, appendTo?}` or the file wrapper `{file:{title, units:[{id,name}], settings, questions}}` (wrapper supplies the bank name + unit-name map + sanitized quiz defaults); `appendTo` = add to an existing bank (case/whitespace-insensitive unit merge, units never renumbered); without it each upload becomes its own bank. `422 {error, errors, count}` on schema failures (nothing imported), `409` when all ids already exist |
| `GET /api/uploads` | t | your uploaded batches |
| `DELETE /api/uploads/:file` | t | `{ok}` |
| `GET /api/sets` | t | `[ {id, name, kind:'upload'\|'default', count, units:[{id,name,total,...}], label, renamed?, settings, updatedAt} ]` - your banks + `default`; `label` = `name · YYYY-MM-DD HH:mm` (UTC) unless renamed, then just `name`. `?all=1` (admin) = `[{id, name, sets:[...]}]` across every teacher |
| `PUT /api/sets/:id` | t | `{ok, set}` - rename a bank and/or its units (`{name?, units:[{id, name}]}`); new unit ids may be **added** (set-bank "add unit"), removals of live units are refused; `400` for the `default` bank |
| `DELETE /api/sets/:id` | t | `{ok}` - removes the bank; quizzes already running keep their snapshotted questions, new quizzes on it are refused |
| `GET /api/sets/:id/questions` | t | the editor's view of ONE bank: `{id, kind, name, label, count, settings, units, questions}` (`default` = built-in bank + your overrides + your shared units); `404 That question bank no longer exists.` |
| `POST /api/sets/:id/questions` | t | upsert one question into that bank: `{ok, set}`; `400` for `default` (saves through `POST /api/bank`), `422 {error, errors}` when the unit is not one of **this** bank's units, `404` for unknown banks |
| `DELETE /api/sets/:id/questions/:qid` | t | `{ok}` / `404 That question is not in this bank.`; `400` for `default` (deletes through `DELETE /api/bank/:id`) |
| `POST /api/sets/:id/duplicate` | t | `{ok, set}` - full copy (new id `<id>-copy`, name `<name> (copy)`, units + settings + questions); `400` for `default` |
| `GET/POST /api/classes`, `PATCH/DELETE /api/classes/:id` | t | per-teacher classes & sections (max 30 classes, 20 sections) |
| `GET /api/reports` | t | summaries of finished sessions (newest first) |
| `GET /api/reports/:code` | t | full saved report (404 unknown) |
| `DELETE /api/reports/:code` | t | `{ok}` (404 unknown; bank untouched) |
| `GET /api/needs-review` | t | `[{id, prompt, unit, sessions, asks, wrong, missRate}]` (≥50% missed, ≥4 asks) |
| `GET /api/sessions` | t | your sessions `[{code,status,players,title,startedAt,...}]` |
| `GET /api/sessions/:code/report` | t | live or last report for that code |
| `GET /api/admin/overview` `/teachers` `/sessions` | a | accounts + totals |
| `POST /api/admin/teachers` | a | create account (returns one-time password) |
| `PATCH /api/admin/teachers/:id` | a | rename/reset password flags |
| `POST /api/admin/teachers/:id/password` `/status` | a | one-time password / suspend |
| `DELETE /api/admin/teachers/:id` | a | `{ok}` |

Server-side question validation for uploads (`shared/validate.js`, same code as
`npm run validate` and the browser preview): ids `u<unit>-q<2 digits>`, unit in bank,
≤4 options, ≥1 accepted answer for fill-blank, complete
`explanation/analogy/hint/tags/mini`, boss rules, optional `unitName` (≤60 chars, names a
numeric unit inside the bank) and `timeLimit` (5-300 seconds,
per-question countdown that beats `commonSeconds`). A failed file imports **nothing**.
Uploads run in `fileUnits:true` mode: string units are taken as-is (the bank's own unit
list), missing units collapse into `Uncategorized`, only unknown *numeric* unit ids fail.
`POST /api/sets/:id/questions` validates in non-file mode against **that bank's** units,
so a question can never borrow another bank's (or the shared) unit.

## Question JSON schema

See `questions/validate.mjs`. Types: `mcq | code-output | spot-error | fill-blank | match`.
`fill-blank` uses `blank` + `accepted[]` instead of `options/answer`.
`match` uses `pairs:[{left,right}]` instead of `options/answer`.
Every question MUST have `explanation`, `analogy`, `hint`, `tags`, `mini`.
Ids: `u<unit>-q<2 digits>`. Exactly one `boss:true` per unit (hard, last).

## UI conventions

- Build DOM with `h()` from `client/src/ui.js`; render with `mount(root, ...)`.
- Import CSS classes from `client/src/styles/app.css` (`.card`, `.btn`, `.chip`, `.stat`,
  `.table-wrap`, `.roster`, `.bar-row`, `.controls`, `.segmented`, `.field`, `.empty`, ...).
- Always mobile-friendly and accessible: label inputs, min tap height 48px (`.btn`),
  never rely on colour alone (add ✓/✗/words), respect `prefers-reduced-motion`.
- Beginner-friendly wording everywhere, no unexplained jargon.
