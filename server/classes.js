// Per-teacher class list: data/teachers/<id>/classes.json
// [{ id, name, sections: ['A', 'B'] }] - a quiz can be assigned one class +
// section so reports and CSVs can group students. Teacher-only, JSON on disk.
import { join } from 'node:path';
import { readJsonSync, updateJson } from './filesafe.js';
import { ownerDirFor } from './bank.js';

const MAX_CLASSES = 30;
const MAX_SECTIONS = 20;

function classesPath(owner) {
  const dir = ownerDirFor(owner);
  return dir ? join(dir, 'classes.json') : null;
}

function normalize(input, list, selfId) {
  const name = String(input?.name ?? '').trim();
  if (name.length < 2 || name.length > 40) {
    throw new Error('Class name must be 2-40 characters.');
  }
  const sections = [...new Set(
    (Array.isArray(input?.sections) ? input.sections : [])
      .map((s) => String(s ?? '').trim())
      .filter(Boolean),
  )];
  if (sections.length > MAX_SECTIONS) throw new Error(`A class can have at most ${MAX_SECTIONS} sections.`);
  for (const s of sections) {
    if (s.length > 24) throw new Error('Section names must be 24 characters or fewer.');
  }
  const clash = list.some(
    (c) => c.id !== selfId && String(c.name).toLowerCase() === name.toLowerCase(),
  );
  if (clash) throw new Error('You already have a class with that name.');
  const id = selfId || String(input?.id ?? '').trim() || `c${Date.now().toString(36)}`;
  if (!selfId && list.some((c) => c.id === id)) throw new Error('That class id is taken.');
  return { id, name, sections };
}

export function listClasses(owner) {
  const path = classesPath(owner);
  const raw = path ? readJsonSync(path, []) : [];
  return Array.isArray(raw) ? raw.filter((c) => c && typeof c === 'object' && c.id) : [];
}

export async function createClass(owner, input) {
  if (!classesPath(owner)) throw new Error('Classes need a teacher account.');
  let made = null;
  await updateJson(classesPath(owner), (current) => {
    const list = Array.isArray(current) ? current : [];
    if (list.length >= MAX_CLASSES) throw new Error(`You can keep up to ${MAX_CLASSES} classes.`);
    made = normalize(input, list, null);
    return [...list, made];
  }, []);
  return made;
}

export async function updateClass(owner, id, patch) {
  const path = classesPath(owner);
  if (!path) throw new Error('Classes need a teacher account.');
  let next = null;
  await updateJson(path, (current) => {
    const list = Array.isArray(current) ? current : [];
    const at = list.findIndex((c) => c.id === id);
    if (at === -1) throw new Error('No such class.');
    const prev = list[at];
    next = normalize(
      { name: patch?.name ?? prev.name, sections: patch?.sections ?? prev.sections },
      list,
      id,
    );
    const copy = [...list];
    copy[at] = next;
    return copy;
  }, []);
  return next;
}

export async function deleteClass(owner, id) {
  const path = classesPath(owner);
  if (!path) return false;
  let removed = false;
  await updateJson(path, (current) => {
    const list = Array.isArray(current) ? current : [];
    const next = list.filter((c) => c.id !== id);
    removed = next.length !== list.length;
    return removed ? next : undefined; // undefined = leave the file alone
  }, []);
  return removed;
}
