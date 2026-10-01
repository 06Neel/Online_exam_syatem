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

test('with DATABASE_URL a wiped data folder is restored from Postgres', { skip: !hadDbUrl }, async () => {
  process.env.DATABASE_URL = hadDbUrl;
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
  await filesafe.whenDataWritesDone();

  // wipe the local folder entirely - this is what a redeploy does
  rmSync(TEACHERS_FILE, { force: true });
  assert.equal(existsSync(TEACHERS_FILE), false);

  await store.closeStore();
  assert.equal(await store.initStore(), true);          // boot again
  const restored = JSON.parse(readFileSync(TEACHERS_FILE, 'utf8'));
  assert.deepEqual(restored.teachers.map((t) => t.id), ['keep-1', 'keep-2']);
  assert.equal(restored.teachers[0].passwordHash, 'h1');

  // a deleted account stays deleted
  const after = { version: 1, teachers: [restored.teachers[1]] };
  filesafe.writeJsonSync(TEACHERS_FILE, after);
  await filesafe.whenDataWritesDone();
  rmSync(TEACHERS_FILE, { force: true });
  await store.closeStore();
  assert.equal(await store.initStore(), true);
  const again = JSON.parse(readFileSync(TEACHERS_FILE, 'utf8'));
  assert.deepEqual(again.teachers.map((t) => t.id), ['keep-2']);

  await store.closeStore();
});
