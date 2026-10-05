// Postgres mirror for everything private under DATA_DIR.
//
// The JSON files stay the working copy (reads stay synchronous and fast);
// Postgres is the durable copy that survives restarts, redeploys and
// scale-to-zero on hosts with a temporary disk (Antideploy).
//
//   DATABASE_URL set    -> on boot: import local files (one-time migration),
//                          restore missing files from the table, then mirror
//                          every write/removal. If the database is unreachable
//                          initStore() THROWS - the server refuses to start
//                          rather than quietly running on defaults.
//   DATABASE_URL absent -> file-only mode (local development, tests): exactly
//                          the behaviour this app had before the database.
//
// Tables are created automatically (CREATE TABLE IF NOT EXISTS) - no manual
// database commands, ever.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, relative, sep } from 'node:path';
import { Pool } from 'pg';
import { onDataRemoved, onDataWritten } from './filesafe.js';
import { DATA_DIR, TRASH_DIR } from './paths.js';

let pool = null;
let mode = 'file';
let unreachable = false;
let unsubscribeW = null;
let unsubscribeR = null;

/** 'database' when DATA_DIR is mirrored to Postgres, 'file' when it is not. */
export function storeEnabled() {
  return mode === 'database';
}

const CREATE_FILES = `CREATE TABLE IF NOT EXISTS files (
  path       text PRIMARY KEY,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

// legacy table from the first accounts-only mirror; migrated into files, then emptied
const CREATE_LEGACY_TEACHERS = `CREATE TABLE IF NOT EXISTS teachers (
  id         text PRIMARY KEY,
  seq        integer NOT NULL DEFAULT 0,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

// ---------------------------------------------------------------- path rules
function rel(abs) {
  return relative(DATA_DIR, abs).split(sep).join('/');
}

function abs(relPath) {
  return join(DATA_DIR, ...relPath.split('/'));
}

/** Only private JSON inside DATA_DIR is mirrored; trash/backups/tmp never are.
 * tree=true means the path is a directory being removed (any extension). */
function mirrorable(absPath, tree = false) {
  const p = String(absPath);
  if (!p.startsWith(DATA_DIR + sep)) return false;
  if (p.startsWith(TRASH_DIR + sep)) return false;
  if (p.endsWith('.bak') || p.endsWith('.tmp')) return false;
  if (!tree && extname(p).toLowerCase() !== '.json') return false;
  return true;
}

function walkLocal() {
  const out = [];
  if (!existsSync(DATA_DIR)) return out;
  const skip = new Set([TRASH_DIR]);
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skip.has(full)) continue;
        walk(full);
      } else if (mirrorable(full)) {
        out.push(full);
      }
    }
  };
  walk(DATA_DIR);
  return out;
}

function parseFile(full) {
  try {
    return { ok: true, data: JSON.parse(readFileSync(full, 'utf8')) };
  } catch (e) {
    // never lose an unreadable file: store its raw text so it can be restored byte-for-byte
    console.warn(`[store] ${full} is not valid JSON (${e.message}) - storing it raw`);
    try { return { ok: true, data: readFileSync(full, 'utf8') }; } catch { return { ok: false }; }
  }
}

// ---------------------------------------------------------------- db actions
async function upsert(relPath, data) {
  await pool.query(
    'INSERT INTO files (path, data, updated_at) VALUES ($1, $2, now()) '
    + 'ON CONFLICT (path) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
    [relPath, JSON.stringify(data)],
  );
}

async function insertIfAbsent(relPath, data) {
  const r = await pool.query(
    'INSERT INTO files (path, data, updated_at) VALUES ($1, $2, now()) ON CONFLICT (path) DO NOTHING RETURNING path',
    [relPath, JSON.stringify(data)],
  );
  return r.rowCount > 0;
}

async function dropPath(relPath, tree) {
  if (tree) {
    await pool.query("DELETE FROM files WHERE path = $1 OR path LIKE $1 || '/%'", [relPath]);
  } else {
    await pool.query('DELETE FROM files WHERE path = $1', [relPath]);
  }
}

// ---------------------------------------------------------------- boot phases
async function migrateLegacyTeachers() {
  const { rows: present } = await pool.query("SELECT 1 FROM files WHERE path = 'teachers.json'");
  if (present.length) return false;
  const { rows } = await pool.query('SELECT data FROM teachers ORDER BY seq, id');
  if (!rows.length) return false;
  const inserted = await insertIfAbsent('teachers.json', { version: 1, teachers: rows.map((r) => r.data) });
  if (inserted) await pool.query('DELETE FROM teachers');   // migrated once, no duplicates
  return inserted;
}

async function importLocalFiles() {
  let n = 0;
  for (const full of walkLocal()) {
    const { ok, data } = parseFile(full);
    if (ok && await insertIfAbsent(rel(full), data)) n++;
  }
  return n;
}

async function restoreFromDb() {
  const { rows } = await pool.query('SELECT path, data FROM files');
  let n = 0;
  for (const row of rows) {
    const target = abs(row.path);
    if (existsSync(target)) continue;
    try {
      mkdirSync(dirname(target), { recursive: true });   // fresh boot: DATA_DIR does not exist yet
      writeFileSync(target, typeof row.data === 'string' ? row.data : JSON.stringify(row.data, null, 2));
      n++;
    } catch (e) {
      console.warn(`[store] could not restore ${row.path}: ${e.message}`);
    }
  }
  return n;
}

// ---------------------------------------------------------------- lifecycle
async function openPool(url) {
  const make = (extra) => new Pool({
    connectionString: url,
    max: 4,
    connectionTimeoutMillis: 8000,
    ...extra,
  });
  try {
    const p = make({});
    await p.query('SELECT 1');
    return p;
  } catch (e) {
    if (!/ssl|certificate/i.test(String(e?.message || ''))) throw e;
    console.warn('[store] retrying the database connection with relaxed TLS checks');
    const p = make({ ssl: { rejectUnauthorized: false } });
    await p.query('SELECT 1');
    return p;
  }
}

/**
 * Connect (if DATABASE_URL is set), migrate + restore, start mirroring.
 * Returns true when Postgres is in use.
 * THROWS when DATABASE_URL is set but the database cannot be reached -
 * the caller (server/index.js) must refuse to start; never fall back to
 * default data silently.
 */
export async function initStore() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    mode = 'file';
    return false;
  }
  try {
    pool = await openPool(url);
    await pool.query(CREATE_FILES);
    await pool.query(CREATE_LEGACY_TEACHERS);
    const migrated = await migrateLegacyTeachers();
    const imported = await importLocalFiles();
    const restored = await restoreFromDb();

    unsubscribeW?.();
    unsubscribeR?.();
    unsubscribeW = onDataWritten(async (path, data) => {
      if (!mirrorable(path)) return;
      try {
        await upsert(rel(path), data);
        unreachable = false;
      } catch (e) {
        if (!unreachable) console.error(`[store] lost the database connection, changes are NOT being mirrored: ${e.message}`);
        unreachable = true;
      }
    });
    unsubscribeR = onDataRemoved(async (path, tree) => {
      if (!mirrorable(path, tree)) return;
      try {
        await dropPath(rel(path), tree);
        unreachable = false;
      } catch (e) {
        if (!unreachable) console.error(`[store] lost the database connection, deletions are NOT being mirrored: ${e.message}`);
        unreachable = true;
      }
    });

    mode = 'database';
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM files');
    console.log(`[store] data mirrored to Postgres (${rows[0].n} files${restored ? `, ${restored} restored` : ''}${imported ? `, ${imported} imported from disk` : ''}${migrated ? ', legacy accounts migrated' : ''})`);
    return true;
  } catch (e) {
    const masked = String(url).replace(/\/\/[^@/]*@/, '//***@');
    const err = new Error(
      `cannot reach the database (${e.message}). `
      + `DATABASE_URL is set (${masked}), so every teacher, question bank, report and live session must live there - `
      + 'the server will not start with default data. '
      + 'Check DATABASE_URL / the database, then restart.',
    );
    err.cause = e;
    try { await pool?.end(); } catch { /* nothing to close */ }
    pool = null;
    mode = 'file';
    throw err;
  }
}

/** Close the pool (tests and graceful shutdown). */
export async function closeStore() {
  try { await pool?.end(); } catch { /* already closed */ }
  pool = null;
  mode = 'file';
  unsubscribeW?.(); unsubscribeW = null;
  unsubscribeR?.(); unsubscribeR = null;
}

/** Everything private on disk as { 'relative/path.json': parsed } - admin backup. */
export function exportSnapshotFiles() {
  const files = {};
  for (const full of walkLocal()) {
    const { ok, data } = parseFile(full);
    if (ok) files[rel(full)] = data;
  }
  return files;
}

/** Relative paths of every mirrored file right now - admin import bookkeeping. */
export function listDataFileRels() {
  return walkLocal().map(rel);
}
