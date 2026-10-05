// Safe JSON file storage for server/data.
// - one lock queue per file so two changes never interleave
// - every write goes to x.tmp first, keeps x.bak of the previous copy, then renames
// The folder is private: it is never served to the browser (static serving is dist/ only).
import {
  copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';

const queues = new Map();

// After-write / after-remove hooks: used by store.js to mirror DATA_DIR into
// Postgres. Hooks may return a promise; whenDataWritesDone() waits for all of them.
const listeners = [];
const removeListeners = [];
let pending = Promise.resolve();

/** fn(path, data) runs after every successful write; may be async. Returns an unsubscribe. */
export function onDataWritten(fn) {
  listeners.push(fn);
  return () => {
    const i = listeners.indexOf(fn);
    if (i >= 0) listeners.splice(i, 1);
  };
}

/** fn(path, tree) runs after a file is deleted or a directory moved away.
 * tree=true means "everything under this path is gone". Returns an unsubscribe. */
export function onDataRemoved(fn) {
  removeListeners.push(fn);
  return () => {
    const i = removeListeners.indexOf(fn);
    if (i >= 0) removeListeners.splice(i, 1);
  };
}

/** Resolves when every hook queued so far has settled. */
export function whenDataWritesDone() {
  return pending;
}

function queue(label, fn) {
  let out;
  try {
    out = Promise.resolve(fn());
  } catch (e) {
    out = Promise.reject(e);
  }
  pending = pending.then(() => out).catch((e) => {
    console.warn(`[data] after-write hook failed for ${label}: ${e.message}`);
  });
}

function notify(path, data) {
  for (const fn of listeners) queue(path, () => fn(path, data));
}

function notifyRemoved(path, tree) {
  for (const fn of removeListeners) queue(path, () => fn(path, tree));
}

/** Delete a file and tell remove-hooks (store.js drops its mirror row). */
export function removeFileSync(path) {
  unlinkSync(path);
  notifyRemoved(path, false);
}

/** A directory was moved away (e.g. a teacher folder into trash): drop everything under it. */
export function notifyDirRemoved(dir) {
  notifyRemoved(dir, true);
}

/** Run fn exclusively for this file path (serialises async callers too). */
export function withLock(path, fn) {
  const key = String(path);
  const prev = queues.get(key) || Promise.resolve();
  const run = prev.then(fn, fn);
  queues.set(key, run.then(() => {}, () => {}));
  return run;
}

export function ensureDir(dir) {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  return dir;
}

export function readJsonSync(path, fallback = null) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    if (e && e.code === 'ENOENT') return fallback;
    // main file is unreadable/corrupt (crash mid-write, full disk, ...):
    // every write keeps a .bak of the previous good copy - use it
    try {
      const parsed = JSON.parse(readFileSync(`${path}.bak`, 'utf8'));
      console.warn(`[data] ${path} was unreadable - recovered from the .bak copy`);
      return parsed;
    } catch { /* no usable backup either */ }
    console.warn(`[data] could not read ${path}: ${e.message}`);
    return fallback;
  }
}

export function writeJsonSync(path, data) {
  ensureDir(dirname(path));
  const tmp = `${path}.tmp`;
  const bak = `${path}.bak`;
  writeFileSync(tmp, JSON.stringify(data, null, 2));
  if (existsSync(path)) {
    try { copyFileSync(path, bak); } catch (e) { console.warn(`[data] backup failed for ${path}: ${e.message}`); }
  }
  renameSync(tmp, path);
  notify(path, data);
}

export function readJson(path, fallback = null) {
  return withLock(path, async () => readJsonSync(path, fallback));
}

export function writeJson(path, data) {
  return withLock(path, async () => { writeJsonSync(path, data); return data; });
}

/** Read-modify-write under the file's lock. fn(current) returns the next value. */
export function updateJson(path, fn, fallback = null) {
  return withLock(path, async () => {
    const current = readJsonSync(path, fallback);
    const next = fn(current);
    if (next !== undefined && next !== null) {
      writeJsonSync(path, next);
      // wait for after-write hooks so mirrors are durable before we report success
      await whenDataWritesDone();
    }
    return next;
  });
}
