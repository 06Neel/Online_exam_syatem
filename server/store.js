// Optional Postgres for teacher accounts.
//
// With DATABASE_URL set (Antideploy injects it as soon as it sees `pg` in the
// dependencies) every change to teachers.json is mirrored into Postgres, and
// the table is loaded back into the file on boot - so accounts survive
// redeploys, restarts and scale-to-zero.
//
// Without DATABASE_URL nothing changes: the JSON file is the only store, which
// is what local development and the test suite use.
//
// The file stays the working copy (reads stay synchronous and fast); Postgres
// is the durable copy. If the database is unreachable the app keeps running on
// the file and simply retries on the next write.
import { Pool } from 'pg';
import { onDataWritten, readJsonSync, whenDataWritesDone, writeJsonSync } from './filesafe.js';
import { TEACHERS_FILE } from './paths.js';

let pool = null;
let off = false;
let unreachable = false;
let unsubscribe = null;

export function storeEnabled() {
  return Boolean(process.env.DATABASE_URL) && !off;
}

/** Resolves once every queued mirror write has been handed to the database. */
export function flushStore() {
  return whenDataWritesDone();
}

const CREATE_TABLE = `CREATE TABLE IF NOT EXISTS teachers (
  id         text PRIMARY KEY,
  seq        integer NOT NULL DEFAULT 0,
  data       jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
)`;

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
    // hosted databases often insist on TLS - retry once without verifying the cert
    if (!/ssl|certificate/i.test(String(e?.message || ''))) throw e;
    console.warn('[store] retrying the database connection with relaxed TLS checks');
    const p = make({ ssl: { rejectUnauthorized: false } });
    await p.query('SELECT 1');
    return p;
  }
}

/** Whole doc -> table (one transaction): rows are replaced in file order. */
async function saveDoc(doc) {
  if (!pool) return;
  const rows = Array.isArray(doc?.teachers) ? doc.teachers : [];
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM teachers');
    for (let i = 0; i < rows.length; i++) {
      const t = rows[i];
      if (!t || !t.id) continue;
      await client.query(
        'INSERT INTO teachers (id, seq, data, updated_at) VALUES ($1, $2, $3, now())',
        [String(t.id), i, JSON.stringify(t)],
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* already failed */ }
    throw e;
  } finally {
    client.release();
  }
}

/** Fill teachers.json from the database when the local file has nothing yet. */
async function hydrate() {
  const { rows } = await pool.query('SELECT data FROM teachers ORDER BY seq, id');
  if (!rows.length) return 0;
  const local = readJsonSync(TEACHERS_FILE);
  const localCount = local && Array.isArray(local.teachers) ? local.teachers.length : 0;
  if (localCount > 0) return 0;           // local copy wins - never clobber it
  writeJsonSync(TEACHERS_FILE, { version: 1, teachers: rows.map((r) => r.data) });
  return rows.length;
}

/**
 * Connect (if DATABASE_URL is set), restore the file and start mirroring.
 * Returns true when Postgres is in use. Never throws: a missing/broken
 * database leaves the app running on files alone.
 */
export async function initStore() {
  const url = process.env.DATABASE_URL;
  if (!url) return false;
  try {
    pool = await openPool(url);
    await pool.query(CREATE_TABLE);
    const restored = await hydrate();
    unsubscribe?.();                     // never register the mirror twice
    unsubscribe = onDataWritten(async (path, data) => {
      if (String(path) !== TEACHERS_FILE) return;
      try {
        await saveDoc(data);
        unreachable = false;
      } catch (e) {
        if (!unreachable) console.warn(`[store] could not mirror accounts to Postgres: ${e.message}`);
        unreachable = true;
      }
    });
    console.log(`[store] teacher accounts kept in Postgres${restored ? ` (${restored} restored on boot)` : ''}`);
    return true;
  } catch (e) {
    off = true;
    try { await pool?.end(); } catch { /* nothing to close */ }
    pool = null;
    console.warn(`[store] Postgres not used: ${e.message}`);
    console.warn('[store] teacher accounts will live on the local disk only - they are lost on redeploy.');
    return false;
  }
}

/** Close the pool (tests and graceful shutdown). */
export async function closeStore() {
  try { await pool?.end(); } catch { /* already closed */ }
  pool = null;
}