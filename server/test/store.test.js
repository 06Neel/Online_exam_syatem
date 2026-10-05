// store.js - optional Postgres mirror for teacher accounts.
// Runs in its own process (node --test) with DATA_DIR pointed at a temp folder,
// so it never touches server/data. The database-backed round trip only runs
// when DATABASE_URL is set (CI / a local Postgres); the rest proves that
// without DATABASE_URL everything behaves exactly as before.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'store-test-'));
process.env.DATA_DIR = root;   // before any module resolves paths.js

const filesafe = await import('../filesafe.js');
const { TEACHERS_FILE } = await import('../paths.js');
const store = await import('../store.js');
const hadDbUrl = process.env.DATABASE_URL;   // captured after paths.js loaded .env

// Own schema inside the given database, reset on every run: repeatable, and a
// real database's public schema is never touched.
async function isolatedDatabaseUrl() {
  if (!hadDbUrl) return '';
  const { Pool } = await import('pg');
  const schema = 'pa_store_test';
  const probe = new Pool({ connectionString: hadDbUrl, connectionTimeoutMillis: 8000 });
  try {
    await probe.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await probe.query(`DROP TABLE IF EXISTS ${schema}.files, ${schema}.teachers`);
  } finally {
    await probe.end().catch(() => {});
  }
  const u = new URL(hadDbUrl);
  const existing = u.searchParams.get('options');
  u.searchParams.set('options', existing ? `${existing} -c search_path=${schema}` : `-c search_path=${schema}`);
  return u.toString();
}

const dbUrl = await isolatedDatabaseUrl();

test.after(() => {
  rmSync(root, { recursive: true, force: true });
});

test('without DATABASE_URL the store stays off and files keep working', async () => {
  delete process.env.DATABASE_URL;
  assert.equal(await store.initStore(), false);
  assert.equal(store.storeEnabled(), false);

  const doc = { version: 1, teachers: [{ id: 't1', name: 'One' }] };
  filesafe.writeJsonSync(TEACHERS_FILE, doc);
  await filesafe.whenDataWritesDone();
  assert.deepEqual(JSON.parse(readFileSync(TEACHERS_FILE, 'utf8')), doc);
});

test('after-write hooks see every write and flush waits for them', async () => {
  const seen = [];
  const off = filesafe.onDataWritten(async (path, data) => {
    await new Promise((r) => setTimeout(r, 25));
    seen.push({ path, data });
  });

  filesafe.writeJsonSync(TEACHERS_FILE, { version: 1, teachers: [{ id: 'hooked' }] });
  assert.equal(seen.length, 0, 'hook is asynchronous - nothing yet right after the write');
  await filesafe.whenDataWritesDone();
  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, TEACHERS_FILE);
  assert.equal(seen[0].data.teachers[0].id, 'hooked');
  off();
});

test('updateJson resolves only after the mirror hooks have run', async () => {
  let mirrored = false;
  const off = filesafe.onDataWritten(async () => {
    await new Promise((r) => setTimeout(r, 25));
    mirrored = true;
  });

  writeFileSync(TEACHERS_FILE, JSON.stringify({ version: 1, teachers: [{ id: 'a' }] }));
  const next = await filesafe.updateJson(TEACHERS_FILE, (d) => {
    d.teachers.push({ id: 'b' });
    return d;
  });
  assert.equal(next.teachers.length, 2);
  assert.equal(mirrored, true, 'mirror must be durable before updateJson returns');
  assert.equal(JSON.parse(readFileSync(TEACHERS_FILE, 'utf8')).teachers.length, 2);
  off();
});

test('with DATABASE_URL a wiped data folder is restored from Postgres', { skip: !dbUrl && 'needs DATABASE_URL' }, async () => {
  process.env.DATABASE_URL = dbUrl;
  assert.equal(await store.initStore(), true);
  assert.equal(store.storeEnabled(), true);

  const doc = {
    version: 1,
    teachers: [
      { id: 'keep-1', name: 'Kept One', passwordHash: 'h1', active: true },
      { id: 'keep-2', name: 'Kept Two', passwordHash: 'h2', active: true },
    ],
  };
  filesafe.writeJsonSync(TEACHERS_FILE, doc);
  const bankPath = join(root, 'teachers', 'keep-1', 'uploads', 'unit-one.json');
  filesafe.writeJsonSync(bankPath, { title: 'My bank', questions: [{ id: 'q1', text: 'print()?' }] });
  const snapPath = join(root, 'sessions', 'AB12.json');
  filesafe.writeJsonSync(snapPath, { v: 1, code: 'AB12', status: 'live', score: 42 });
  await filesafe.whenDataWritesDone();

  // wipe the local folder entirely - this is what a redeploy does
  rmSync(root, { recursive: true, force: true });
  assert.equal(existsSync(TEACHERS_FILE), false);

  await store.closeStore();
  assert.equal(await store.initStore(), true);          // boot again
  const restored = JSON.parse(readFileSync(TEACHERS_FILE, 'utf8'));
  assert.deepEqual(restored.teachers.map((t) => t.id), ['keep-1', 'keep-2']);
  assert.equal(restored.teachers[0].passwordHash, 'h1', 'passwords stay hashed');
  assert.equal(JSON.parse(readFileSync(bankPath, 'utf8')).title, 'My bank');
  assert.equal(JSON.parse(readFileSync(snapPath, 'utf8')).score, 42);

  // a deleted account stays deleted
  const after = { version: 1, teachers: [restored.teachers[1]] };
  filesafe.writeJsonSync(TEACHERS_FILE, after);
  const goneBank = join(root, 'teachers', 'keep-1');
  rmSync(goneBank, { recursive: true, force: true });
  filesafe.notifyDirRemoved(goneBank);
  await filesafe.whenDataWritesDone();
  rmSync(root, { recursive: true, force: true });
  await store.closeStore();
  assert.equal(await store.initStore(), true);
  const again = JSON.parse(readFileSync(TEACHERS_FILE, 'utf8'));
  assert.deepEqual(again.teachers.map((t) => t.id), ['keep-2']);
  assert.equal(existsSync(bankPath), false, 'deleted stays deleted');

  await store.closeStore();
});

test('an unreachable DATABASE_URL throws - the server must not start', async () => {
  process.env.DATABASE_URL = 'postgresql://127.0.0.1:1/none?connect_timeout=1';
  await assert.rejects(store.initStore(), /cannot reach the database/);
  assert.equal(store.storeEnabled(), false, 'never reported as healthy');
  delete process.env.DATABASE_URL;
});

test('legacy accounts-only rows are migrated once, without duplicates', { skip: !dbUrl && 'needs DATABASE_URL' }, async () => {
  const { Pool } = await import('pg');
  process.env.DATABASE_URL = dbUrl;
  const probe = new Pool({ connectionString: dbUrl });
  try {
    await probe.query('DELETE FROM files');
    await probe.query('DELETE FROM teachers');
    // what the previous release (accounts-only mirror) would have left behind
    await probe.query(
      'INSERT INTO teachers (id, seq, data) VALUES ($1, 0, $2), ($3, 1, $4)',
      ['legacy-1', JSON.stringify({ id: 'legacy-1', name: 'Legacy One', passwordHash: 'hh1' }),
        'legacy-2', JSON.stringify({ id: 'legacy-2', name: 'Legacy Two', passwordHash: 'hh2' })],
    );

    rmSync(root, { recursive: true, force: true });   // fresh host: no local file
    assert.equal(await store.initStore(), true);
    const migrated = JSON.parse(readFileSync(TEACHERS_FILE, 'utf8'));
    assert.deepEqual(migrated.teachers.map((t) => t.id), ['legacy-1', 'legacy-2']);
    assert.equal(migrated.teachers[0].passwordHash, 'hh1', 'hashes carried over as-is');

    const { rows } = await probe.query('SELECT count(*)::int AS n FROM teachers');
    assert.equal(rows[0].n, 0, 'legacy table emptied - nothing to import twice');

    // a second boot restores, never duplicates
    await store.closeStore();
    rmSync(root, { recursive: true, force: true });
    assert.equal(await store.initStore(), true);
    const again = JSON.parse(readFileSync(TEACHERS_FILE, 'utf8'));
    assert.equal(again.teachers.length, 2, 'exactly two accounts after the second boot');
  } finally {
    await probe.end().catch(() => {});
    await store.closeStore();
  }
});
