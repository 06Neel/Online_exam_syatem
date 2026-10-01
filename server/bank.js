// Loads the question bank, merges teacher edits/uploads and provides lookups.
//
// Layers, last one wins for a given id:
//   1. questions/bank/*.json                 shipped bank (shared by everyone)
//   2. data/questions-override.json          legacy global edits (shared)
//   3. data/teachers/<id>/overrides.json     one teacher's own edits & new questions
//   4. data/teachers/<id>/uploads/*.json     that teacher's uploaded batches, in order
//
// Everything under data/ is private: the static server only serves dist/.
import { readFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, readJsonSync, writeJsonSync, withLock } from './filesafe.js';
import { sanitizeId } from './auth.js';
import { getUnits } from './units.js';
import { DATA_DIR, TEACHERS_DIR } from './paths.js';
import { fileUnitList, fileUnitName, DEFAULT_SET_NAME } from '../shared/units.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const BANK_DIR = join(ROOT, 'questions', 'bank');
const FACTS_PATH = join(ROOT, 'questions', 'facts.json');
const EDIT_PATH = join(DATA_DIR, 'questions-override.json');   // legacy, shared

const caches = new Map();  // ownerKey ('' = shared) -> { questions, overrides }

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return fallback;
  }
}

function ownerKey(owner) {
  const id = owner ? sanitizeId(owner) : null;
  return id || '';
}

function ownerDir(owner) {
  const id = ownerKey(owner);
  return id ? join(TEACHERS_DIR, id) : null;
}

function overridesPath(owner) {
  const dir = ownerDir(owner);
  return dir ? join(dir, 'overrides.json') : EDIT_PATH;
}

function uploadsIndexPath(owner) {
  const dir = ownerDir(owner);
  return dir ? join(dir, 'uploads', 'index.json') : null;
}

function loadBase() {
  const base = [];
  for (const f of readdirSync(BANK_DIR).filter((f) => f.endsWith('.json')).sort()) {
    const data = readJson(join(BANK_DIR, f), []);
    if (Array.isArray(data)) base.push(...data);
  }
  return base;
}

function build(owner, { uploads = true } = {}) {
  const byId = new Map(loadBase().map((q) => [q.id, q]));

  // shared layers: legacy global override, then (if an owner) their own files
  const layers = [readJson(EDIT_PATH, {})];
  const dir = ownerDir(owner);
  if (dir) layers.push(readJson(overridesPath(owner), {}));

  for (const overrides of layers) {
    if (!overrides || typeof overrides !== 'object') continue;
    for (const [id, q] of Object.entries(overrides)) {
      if (q && q.__deleted) byId.delete(id);
      else if (byId.has(id)) byId.set(id, { ...byId.get(id), ...q, id });
      else if (q) byId.set(id, { ...q, id });
    }
  }

  // uploaded batches, oldest first so the newest upload wins for a shared id
  const list = uploads ? uploadsFor(owner) : [];
  for (const b of list) {
    const file = setFilePath(owner, b.file);
    if (!file || !existsSync(file)) continue;
    const qs = readJson(file, []);
    if (!Array.isArray(qs)) continue;
    for (const q of qs) {
      if (q && q.id) byId.set(q.id, { ...byId.get(q.id), ...q, id: q.id });
    }
  }

  const overrides = layers[layers.length - 1];
  return { questions: [...byId.values()], overrides, uploads: list.length };
}

/** The raw, time-ordered batch list behind uploads/index.json. */
function uploadsFor(owner) {
  const uploads = uploadsIndexPath(owner);
  const index = uploads ? readJson(uploads, { batches: [] }) : { batches: [] };
  return [...(index.batches || [])].sort((a, b) => (a.uploadedAt || 0) - (b.uploadedAt || 0));
}

/**
 * The merged question bank.
 * scope 'merged' (default) = base + overrides + every upload - what the editor
 * and legacy sessions see. scope 'default' = base + overrides only - the built-in
 * question set, kept free of uploaded questions.
 */
export function loadBank({ fresh = false, owner = null, scope = 'merged' } = {}) {
  const key = ownerKey(owner);
  if (fresh) {
    // invalidate every scope for this owner (fresh reads must not leave stale data)
    for (const k of [...caches.keys()]) if (k.startsWith(`${key}#`)) caches.delete(k);
  }
  const cacheKey = `${key}#${scope === 'default' ? 'default' : 'merged'}`;
  let cache = caches.get(cacheKey);
  if (!cache) {
    cache = build(owner || null, { uploads: scope !== 'default' });
    caches.set(cacheKey, cache);
  }
  return cache;
}

export function saveQuestion(question, owner = null) {
  const dir = ownerDir(owner);
  const path = dir ? overridesPath(owner) : EDIT_PATH;
  ensureDir(dirname(path));
  const current = readJson(path, {});
  current[question.id] = question;
  writeJsonSync(path, current);
  loadBank({ fresh: true, owner });
  return question;
}

export function deleteQuestion(id, owner = null) {
  const path = overridesPath(owner);
  if (!existsSync(path)) {
    // deleting a shipped question = tombstone in the teacher's own layer
    if (!ownerKey(owner)) return false;
    return markDeleted(id, owner);
  }
  const current = readJson(path, {});
  if (current[id]) {
    delete current[id];
    writeJsonSync(path, current);
    loadBank({ fresh: true, owner });
    return true;
  }
  return markDeleted(id, owner);
}

function markDeleted(id, owner) {
  if (!ownerKey(owner)) return false;
  const { questions } = loadBank({ owner });
  if (!questions.some((q) => q.id === id)) return false;
  const path = overridesPath(owner);
  ensureDir(dirname(path));
  const current = readJson(path, {});
  current[id] = { id, __deleted: true };
  writeJsonSync(path, current);
  loadBank({ fresh: true, owner });
  return true;
}

export function getQuestion(id, owner = null) {
  return loadBank({ owner }).questions.find((q) => q.id === id);
}

export function getFacts() {
  return readJson(FACTS_PATH, { bugs: [], didYouKnow: [] });
}

/** Strip the answer + teaching material: what a player may see while playing. */
export function publicQuestion(q) {
  if (!q) return null;
  const { explanation, analogy, mini, hint, answer, ...rest } = q;
  return rest;
}

/** Per-unit counts ({total, byDifficulty, types}) for any question list. */
export function summarizeQuestions(questions) {
  const map = {};
  for (const q of questions) {
    const s = (map[q.unit] ||= { total: 0, byDifficulty: { easy: 0, medium: 0, hard: 0 }, types: {} });
    s.total++;
    s.byDifficulty[q.difficulty] = (s.byDifficulty[q.difficulty] || 0) + 1;
    s.types[q.type] = (s.types[q.type] || 0) + 1;
  }
  return map;
}

export function unitsSummary(owner = null, { scope = 'merged' } = {}) {
  return summarizeQuestions(loadBank({ owner, scope }).questions);
}

// ---------------- uploads / question sets ----------------
export function uploadIndexPath(owner) {
  return uploadsIndexPath(owner);
}

const SAFE_FILE = /^[a-z0-9._-]+$/i;

function setFilePath(owner, file) {
  const path = uploadsIndexPath(owner);
  return path && SAFE_FILE.test(String(file || '')) ? join(dirname(path), String(file)) : null;
}

/** One batch (= question set) from the index, or null. */
export function getSet(owner, file) {
  const safe = String(file || '');
  if (!SAFE_FILE.test(safe)) return null;
  return listUploads(owner).find((b) => b.file === safe) || null;
}

/** The set's questions exactly as stored (no cache, no override layer). */
export function readSetFile(owner, file) {
  const path = setFilePath(owner, file);
  if (!path || !existsSync(path)) return null;
  const data = readJson(path, []);
  return Array.isArray(data) ? data : null;
}

/** Display name: the file name plus the upload time, until the teacher renames it. */
export function setDisplayName(batch) {
  const name = String((batch && (batch.name || batch.file)) || 'Question bank').trim() || 'Question bank';
  if (batch && batch.renamed) return name.slice(0, 80);
  const ts = Number(batch && batch.uploadedAt) || 0;
  const stamp = ts ? new Date(ts).toISOString().slice(0, 16).replace('T', ' ') : '';
  return stamp ? `${name.slice(0, 60)} · ${stamp}` : name.slice(0, 80);
}

/**
 * Load one set fresh from disk: questions rewritten to the set's own unit ids,
 * with the teacher's edits (and tombstones) applied on top. Returns null when
 * the set is gone.
 */
export function loadSetQuestions(owner, file) {
  const batch = getSet(owner, file);
  const stored = readSetFile(owner, file);
  if (!batch || !stored) return null;

  const questions = stored.filter((q) => q && q.id).map((q) => ({ ...q }));
  const storedUnits = Array.isArray(batch.units)
    ? batch.units.filter((u) => qSafeUnit(u))
    : null;
  let units;
  if (storedUnits && storedUnits.length) {
    units = storedUnits.map((u) => ({ id: u.id, name: String(u.name).trim() }));
  } else {
    // batches from before sets existed: derive the unit list from the file itself
    const plan = fileUnitList(questions);
    units = plan.units;
    questions.forEach((q, i) => { q.unit = plan.assignments[i]; });
  }

  const byId = new Map(questions.map((q) => [q.id, q]));
  const before = new Map([...byId].map(([id, q]) => [id, q.unit]));
  const layers = [readJson(EDIT_PATH, {}), readJson(overridesPath(owner), {})];
  for (const id of [...byId.keys()]) {
    for (const layer of layers) {
      const patch = layer && typeof layer === 'object' ? layer[id] : null;
      if (!patch) continue;
      if (patch.__deleted) { byId.delete(id); break; }
      const merged = { ...byId.get(id), ...patch, id };
      // an edit must not smuggle a unit this set does not have
      if (!units.some((u) => u.id === merged.unit)) merged.unit = before.get(id);
      byId.set(id, merged);
    }
  }
  return { batch, units, questions: [...byId.values()] };
}

function qSafeUnit(u) {
  return u && Number.isInteger(u.id) && typeof u.name === 'string' && u.name.trim().length >= 2;
}

/**
 * Every selectable question set for a teacher: the built-in default first,
 * then their uploads (newest first), each with unit counts straight from its file.
 */
export function setSummaries(owner) {
  const defaultQuestions = loadBank({ owner, scope: 'default' }).questions;
  const defaultCounts = summarizeQuestions(defaultQuestions);
  const empty = { total: 0, byDifficulty: { easy: 0, medium: 0, hard: 0 }, types: {} };
  const out = [{
    id: 'default',
    kind: 'default',
    name: DEFAULT_SET_NAME,
    label: DEFAULT_SET_NAME,
    count: defaultQuestions.length,
    uploadedAt: null,
    renamed: true,
    settings: null,
    units: getUnits(owner).map((u) => ({ ...u, ...(defaultCounts[u.id] || empty) })),
  }];
  for (const b of listUploads(owner)) {
    const loaded = loadSetQuestions(owner, b.file);
    if (!loaded) continue;
    const counts = summarizeQuestions(loaded.questions);
    out.push({
      id: b.file,
      kind: 'upload',
      name: b.name || b.file,
      label: setDisplayName(b),
      count: loaded.questions.length,
      uploadedAt: b.uploadedAt || null,
      renamed: !!b.renamed,
      settings: b.settings || null,
      units: loaded.units.map((u) => ({ ...u, ...(counts[u.id] || empty) })),
    });
  }
  return out;
}

/**
 * Whitelist the quiz-builder settings an uploaded file may carry
 * (points, timers, timer flags). Anything missing or out of range is
 * dropped so a hostile file cannot flip random config; null = none.
 */
export function sanitizeSettings(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const int = (v, min, max) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= min && n <= max ? Math.round(n) : null;
  };
  const out = {};
  const pts = raw.points;
  if (pts && typeof pts === 'object') {
    const p = {
      easy: int(pts.easy, 1, 1000), medium: int(pts.medium, 1, 1000),
      hard: int(pts.hard, 1, 1000), boss: int(pts.boss, 1, 1000),
    };
    if (Object.values(p).every((v) => v !== null)) out.points = p;
  }
  const tm = raw.timers;
  if (tm && typeof tm === 'object') {
    const t = {
      easy: int(tm.easy, 5, 300), medium: int(tm.medium, 5, 300),
      hard: int(tm.hard, 5, 300), bossExtra: int(tm.bossExtra, 0, 120),
    };
    if (Object.values(t).every((v) => v !== null)) out.timers = t;
  }
  const reveal = int(raw.revealSeconds, 3, 30);
  if (reveal !== null) out.revealSeconds = reveal;
  if (raw.timerOn !== undefined && raw.timerOn !== null) out.timerOn = !!raw.timerOn;
  const common = int(raw.commonSeconds, 5, 300);
  if (common !== null) out.commonSeconds = common;
  const quiz = int(raw.quizSeconds, 30, 7200);
  if (quiz !== null) out.quizSeconds = quiz;
  const count = int(raw.count, 4, 40);
  if (count !== null) out.count = count;
  if (['easy', 'medium', 'hard', 'mixed'].includes(raw.difficulty)) out.difficulty = raw.difficulty;
  return Object.keys(out).length ? out : null;
}

export async function recordUpload(owner, { file, name, count, ids, units, settings = null, renamed = false }) {
  const path = uploadsIndexPath(owner);
  if (!path) throw new Error('uploads need a teacher id');
  await withLock(path, async () => {
    const index = readJsonSync(path, { version: 1, batches: [] });
    index.batches = Array.isArray(index.batches) ? index.batches : [];
    index.batches.push({
      file,
      name: name || file,
      count,
      ids: ids || [],
      units: Array.isArray(units) ? units : [],
      settings: sanitizeSettings(settings),
      renamed: !!renamed,
      uploadedAt: Date.now(),
    });
    writeJsonSync(path, index);
  });
  loadBank({ fresh: true, owner });
}

/**
 * Add questions to an existing set. Incoming units join the set's own list
 * (case-insensitive match, new names appended); stored questions that predate
 * sets are rewritten to the derived ids once.
 */
export async function appendSet(owner, file, incoming) {
  const batch = getSet(owner, file);
  const stored = readSetFile(owner, file);
  if (!batch || !stored) return null;

  const hadUnits = Array.isArray(batch.units) && batch.units.length > 0;
  const units = hadUnits
    ? batch.units.filter(qSafeUnit).map((u) => ({ id: u.id, name: String(u.name).trim() }))
    : fileUnitList(stored).units.map((u) => ({ id: u.id, name: u.name }));
  const findUnit = (raw, unitName = null) => {
    const { key, name, id } = fileUnitName(raw, unitName);
    // an exact numeric id this set already uses wins (even if renamed later)
    if (Number.isInteger(id) && units.some((x) => x.id === id)) return id;
    let unit = units.find((x) => x.name.toLowerCase() === key);
    if (!unit) {
      const newId = Number.isInteger(id) && !units.some((x) => x.id === id)
        ? id
        : Math.max(99, ...units.map((x) => x.id)) + 1;
      unit = { id: newId, name };
      units.push(unit);
    }
    return unit.id;
  };

  const base = stored.filter((q) => q && q.id).map((q) => ({ ...q }));
  if (!hadUnits) for (const q of base) q.unit = findUnit(q.unit, q.unitName);
  const added = (incoming || []).filter((q) => q && q.id)
    .map((q) => ({ ...q, unit: findUnit(q.unit, q.unitName) }));
  // ids already in the set are replaced by the incoming copy, order preserved
  const merged = new Map(base.map((q) => [q.id, q]));
  for (const q of added) merged.set(q.id, q);
  const all = [...merged.values()];

  const path = setFilePath(owner, file);
  writeJsonSync(path, all);
  const indexPath = uploadsIndexPath(owner);
  await withLock(indexPath, async () => {
    const index = readJsonSync(indexPath, { version: 1, batches: [] });
    const b = (index.batches || []).find((x) => x.file === file);
    if (b) {
      b.count = all.length;
      b.ids = all.map((q) => q.id);
      b.units = units;
    }
    writeJsonSync(indexPath, index);
  });
  loadBank({ fresh: true, owner });
  return getSet(owner, file);
}

/** Rename a set and/or relabel its units (ids stay the same). */
export async function renameSet(owner, file, { name, units } = {}) {
  const batch = getSet(owner, file);
  if (!batch) return null;
  const indexPath = uploadsIndexPath(owner);

  let nextUnits = Array.isArray(batch.units) ? batch.units : null;
  if (units !== undefined) {
    if (!Array.isArray(units)) throw new Error('Send { units: [...] } or leave units out.');
    const clean = units
      .filter((u) => u && Number.isInteger(u.id) && String(u.name || '').trim().length >= 2)
      .map((u) => ({ id: u.id, name: String(u.name).trim().slice(0, 40) }));
    if (!clean.length) throw new Error('Each unit needs a name of at least 2 characters.');
    if (new Set(clean.map((u) => u.name.toLowerCase())).size !== clean.length) {
      throw new Error('Unit names must be unique.');
    }
    if (new Set(clean.map((u) => u.id)).size !== clean.length) {
      throw new Error('Unit ids must be unique.');
    }
    // new units may join the bank; removing one that exists is refused
    if (batch.units && batch.units.length) {
      const currentIds = new Set(batch.units.map((u) => u.id));
      const removed = [...currentIds].filter((id) => !clean.some((u) => u.id === id));
      if (removed.length) throw new Error('Unit ids must match this set\'s units.');
    }
    nextUnits = clean.sort((a, b) => a.id - b.id);
  }

  let nextName = batch.name;
  let renamed = !!batch.renamed;
  if (name !== undefined) {
    nextName = String(name || '').trim().slice(0, 60);
    if (nextName.length < 2) throw new Error('A set name needs at least 2 characters.');
    renamed = true;
  }

  await withLock(indexPath, async () => {
    const index = readJsonSync(indexPath, { version: 1, batches: [] });
    const b = (index.batches || []).find((x) => x.file === file);
    if (b) {
      b.name = nextName;
      b.renamed = renamed;
      if (nextUnits) b.units = nextUnits;
      writeJsonSync(indexPath, index);
    }
  });
  loadBank({ fresh: true, owner });
  return getSet(owner, file);
}

// ---- editing questions inside one bank (the editor's save routes) ----

/** Drop a stale teacher-edit patch so the set file itself wins for this id. */
function clearOwnerOverride(owner, id) {
  if (!ownerKey(owner)) return;
  const path = overridesPath(owner);
  if (!existsSync(path)) return;
  const current = readJson(path, {});
  if (current && current[id]) {
    delete current[id];
    writeJsonSync(path, current);
  }
}

function writeSetFile(owner, file, questions, units) {
  const path = setFilePath(owner, file);
  if (!path) return false;
  writeJsonSync(path, questions);
  const indexPath = uploadsIndexPath(owner);
  const index = readJsonSync(indexPath, { version: 1, batches: [] });
  const b = (index.batches || []).find((x) => x.file === file);
  if (b) {
    b.count = questions.length;
    b.ids = questions.map((q) => q.id);
    if (units) b.units = units;
    writeJsonSync(indexPath, index);
  }
  loadBank({ fresh: true, owner });
  return true;
}

/** Upsert one question into a set's own file (editor save for a set bank). */
export async function saveSetQuestion(owner, file, q) {
  const batch = getSet(owner, file);
  const stored = readSetFile(owner, file);
  if (!batch || !stored || !q || !q.id) return null;
  const at = stored.findIndex((x) => x && x.id === q.id);
  const next = at >= 0
    ? stored.map((x, i) => (i === at ? { ...q, id: q.id } : x))
    : [...stored, { ...q, id: q.id }];
  writeSetFile(owner, file, next, null);
  clearOwnerOverride(owner, q.id);
  return getSet(owner, file);
}

/** Remove one question from a set's file (and any edit patch hiding it). */
export async function removeSetQuestion(owner, file, id) {
  const batch = getSet(owner, file);
  const stored = readSetFile(owner, file);
  if (!batch || !stored) return false;
  if (!stored.some((q) => q && q.id === id)) return false;
  writeSetFile(owner, file, stored.filter((q) => q && q.id !== id), null);
  clearOwnerOverride(owner, id);
  return true;
}

/**
 * Copy a bank to a new file under a fresh name. Question ids are remapped
 * (<id>-copy) so edit patches shared by id can never bleed between the
 * original and the copy.
 */
export async function duplicateSet(owner, file) {
  const batch = getSet(owner, file);
  const stored = readSetFile(owner, file);
  if (!batch || !stored) return null;
  const seen = new Set();
  const mapped = stored.filter((q) => q && q.id).map((q) => {
    let id = `${q.id}-copy`;
    let n = 2;
    while (seen.has(id)) id = `${q.id}-copy${n++}`;
    seen.add(id);
    return { ...q, id };
  });
  const base = String(batch.name || batch.file).replace(/\s*\(copy\)(\s*\d+)?$/i, '').slice(0, 50);
  const stamp = Date.now().toString(36);
  const slug = (base.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'bank').slice(0, 30);
  const newFile = `${stamp}-${slug}-copy.json`;
  const dir = ownerDir(owner);
  ensureDir(join(dir, 'uploads'));
  writeJsonSync(join(dir, 'uploads', newFile), mapped);
  const units = Array.isArray(batch.units) && batch.units.length
    ? batch.units.filter(qSafeUnit).map((u) => ({ id: u.id, name: String(u.name).trim() }))
    : fileUnitList(mapped).units.map((u) => ({ id: u.id, name: u.name }));
  await recordUpload(owner, {
    file: newFile,
    name: `${base} (copy)`,
    count: mapped.length,
    ids: mapped.map((q) => q.id),
    units,
    settings: sanitizeSettings(batch.settings),
    renamed: true,
  });
  return getSet(owner, newFile);
}

export function listUploads(owner) {
  const path = uploadsIndexPath(owner);
  const index = path ? readJsonSync(path, { batches: [] }) : { batches: [] };
  return [...(index.batches || [])].sort((a, b) => (b.uploadedAt || 0) - (a.uploadedAt || 0));
}

export function deleteUpload(owner, file) {
  const path = uploadsIndexPath(owner);
  if (!path) return false;
  const dir = dirname(path);
  const safe = String(file || '');
  if (!SAFE_FILE.test(safe)) return false;
  let removed = false;
  const index = readJsonSync(path, { batches: [] });
  const batches = (index.batches || []).filter((b) => {
    if (b.file === safe) { removed = true; return false; }
    return true;
  });
  if (removed) {
    writeJsonSync(path, { ...index, batches });
    try { if (existsSync(join(dir, safe))) unlinkSync(join(dir, safe)); } catch { /* already gone */ }
    loadBank({ fresh: true, owner });
  }
  return removed;
}

export function ownerDirFor(owner) {
  return ownerDir(owner);
}
