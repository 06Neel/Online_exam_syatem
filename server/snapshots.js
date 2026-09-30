// Running-session snapshots under data/sessions/<code>.json.
// Every meaningful mutation rewrites the file; ending a session drops it
// (the finished report takes over). On boot the store reloads them, so a
// server restart never swallows a live quiz.
import { readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readJsonSync, writeJsonSync, ensureDir } from './filesafe.js';

const HERE = dirname(fileURLToPath(import.meta.url));
// tests point this at their own folder so parallel servers never share snapshots
const SESSIONS_DIR = process.env.PA_SESSIONS_DIR || join(HERE, 'data', 'sessions');

// half a school day - anything older is abandoned, not resumed
export const MAX_AGE_MS = 12 * 60 * 60 * 1000;

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
  try { unlinkSync(path); } catch { return false; }
  return true;
}
