// Running-session snapshots under data/sessions/<code>.json.
// Every meaningful mutation rewrites the file; ending a session drops it
// (the finished report takes over). On boot the store reloads them, so a
// server restart never swallows a live quiz.
import { readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ensureDir, readJsonSync, removeFileSync, writeJsonSync } from './filesafe.js';
import { SESSIONS_DIR as DEFAULT_SESSIONS_DIR } from './paths.js';

// tests point this at their own folder so parallel servers never share snapshots
const SESSIONS_DIR = process.env.PA_SESSIONS_DIR || DEFAULT_SESSIONS_DIR;

// how long a session may sit untouched before it is abandoned (default 12h)
const MAX_AGE_HOURS = (() => {
  const h = Number(process.env.SESSION_MAX_AGE_HOURS);
  return Number.isFinite(h) && h > 0 ? h : 12;
})();
export const MAX_AGE_MS = Math.round(MAX_AGE_HOURS * 60 * 60 * 1000);

const okCode = (code) => /^[A-Za-z0-9]{4}$/.test(String(code || ''));

export function saveSnapshot(code, snap) {
  if (!okCode(code)) return false;
  ensureDir(SESSIONS_DIR);
  writeJsonSync(join(SESSIONS_DIR, `${code}.json`), snap);
  return true;
}

export function loadSnapshots() {
  if (!existsSync(SESSIONS_DIR)) return [];
  const out = [];
  for (const file of readdirSync(SESSIONS_DIR)) {
    if (!/^[A-Za-z0-9]{4}\.json$/.test(file)) continue;
    const snap = readJsonSync(join(SESSIONS_DIR, file), null);
    if (snap && snap.code) out.push(snap);
  }
  return out;
}

export function dropSnapshot(code) {
  if (!okCode(code)) return false;
  const path = join(SESSIONS_DIR, `${code}.json`);
  if (!existsSync(path)) return false;
  try { removeFileSync(path); } catch { return false; }
  return true;
}
