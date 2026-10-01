// Per-teacher unit lists: rename the base seven, add your own (ids 8+),
// delete empty custom units. Stored as JSON under data/teachers/<id>/units.json.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readJsonSync, writeJsonSync, ensureDir } from './filesafe.js';
import { sanitizeId } from './auth.js';
import { TEACHERS_DIR } from './paths.js';
import { UNITS } from '../shared/units.js';

const BASE_IDS = UNITS.map((u) => u.id);
const MAX_ID = 99;
const MAX_UNITS = 30;

function pathFor(owner) {
  const id = owner ? sanitizeId(owner) : null;
  return id ? join(TEACHERS_DIR, id, 'units.json') : null;
}

/** The signed-in teacher's units: base seven (possibly renamed) + their own. */
export function getUnits(owner = null) {
  const out = UNITS.map((u) => ({ id: u.id, name: u.name, custom: false }));
  const path = pathFor(owner);
  const saved = path && existsSync(path) ? readJsonSync(path, null) : null;
  if (!saved || !Array.isArray(saved.units)) return out;
  for (const u of saved.units) {
    if (!u || !Number.isInteger(u.id) || typeof u.name !== 'string') continue;
    const name = u.name.trim().slice(0, 40);
    if (!name) continue;
    const base = out.find((b) => b.id === u.id);
    if (base) base.name = name;
    else if (u.id > BASE_IDS[BASE_IDS.length - 1] && u.id <= MAX_ID) out.push({ id: u.id, name, custom: true });
  }
  return out.sort((a, b) => a.id - b.id);
}

/**
 * Validate a full list and return it in canonical order (base ids first).
 * Pure - throws a user-facing Error, writes nothing.
 */
export function validateUnits(units) {
  if (!Array.isArray(units)) throw new Error('Send { units: [...] }.');
  if (units.length < BASE_IDS.length || units.length > MAX_UNITS) {
    throw new Error(`Keep between ${BASE_IDS.length} and ${MAX_UNITS} units.`);
  }
  const names = new Map();
  for (const u of units) {
    if (!u || !Number.isInteger(u.id) || u.id < 1 || u.id > MAX_ID) {
      throw new Error('Each unit needs an id from 1 to 99.');
    }
    const name = String(u.name || '').trim();
    if (name.length < 2) throw new Error(`Unit ${u.id} needs a name of at least 2 characters.`);
    if (name.length > 40) throw new Error('Unit names are at most 40 characters.');
    if (names.has(u.id)) throw new Error(`Duplicate unit id ${u.id}.`);
    names.set(u.id, name);
  }
  for (const id of BASE_IDS) {
    if (!names.has(id)) throw new Error(`Unit ${id} is built in and cannot be removed.`);
  }
  return [
    ...BASE_IDS.map((id) => ({ id, name: names.get(id) })),
    ...[...names.keys()].filter((id) => !BASE_IDS.includes(id)).sort((a, b) => a - b)
      .map((id) => ({ id, name: names.get(id) })),
  ];
}

/** Validate + persist a full list. Throws a user-facing Error on bad input. */
export function saveUnits(owner, units) {
  const path = pathFor(owner);
  if (!path) throw new Error('Sign in to manage units.');
  const saved = validateUnits(units);
  ensureDir(dirname(path));
  writeJsonSync(path, { version: 1, units: saved });
  return saved;
}
