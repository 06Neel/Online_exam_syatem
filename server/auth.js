// Teacher accounts, admin sign-in and login tokens.
//
// No database: teacher records live in server/data/teachers.json, one folder per
// teacher in server/data/teachers/<id>/ (private, never served to the browser).
// Passwords are stored only as scrypt hashes. The admin password exists ONLY in
// .env (ADMIN_PASSWORD) - it is never written to disk by this app and never sent
// to the browser.
import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { cpSync, existsSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDir, readJsonSync, updateJson, withLock, writeJsonSync } from './filesafe.js';

const scrypt = promisify(_scrypt);
const HERE = dirname(fileURLToPath(import.meta.url));

export const DATA_DIR = join(HERE, 'data');
export const TEACHERS_FILE = join(DATA_DIR, 'teachers.json');
export const TEACHERS_DIR = join(DATA_DIR, 'teachers');
export const SESSIONS_DIR = join(DATA_DIR, 'sessions');
export const TRASH_DIR = join(DATA_DIR, 'trash');

const ID_RE = /^[a-z0-9._-]{2,40}$/i;
const TOKEN_TTL_MS = 60 * 60 * 1000;   // sliding inactivity window for login tokens
const MAX_FAILS = 5;                   // wrong passwords before a short lockout
const LOCK_MS = 15 * 60 * 1000;
const GENERIC_ERROR = 'Invalid ID or password';

const tokens = new Map();  // token -> { role, id, name, mustChangePassword, lastSeen }
const fails = new Map();   // lowercased id -> { count, lockedUntil }

const sha = (s) => createHash('sha256').update(String(s)).digest();

// ---------------------------------------------------------------- passwords
export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(String(password), salt, 64, { N: 16384, r: 8, p: 1 });
  return `s1$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  try {
    const [version, saltB64, keyB64] = String(stored || '').split('$');
    if (version !== 's1' || !saltB64 || !keyB64) return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(keyB64, 'base64');
    const key = await scrypt(String(password), salt, expected.length, { N: 16384, r: 8, p: 1 });
    return key.length === expected.length && timingSafeEqual(key, expected);
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------- admin (.env only)
export function adminConfig() {
  const password = process.env.ADMIN_PASSWORD || '';
  const username = (process.env.ADMIN_USERNAME || 'admin').trim() || 'admin';
  return { username, password, enabled: password.length > 0 };
}

async function isAdminCredentials(id, password) {
  const admin = adminConfig();
  if (!admin.enabled) return false;
  const idOk = timingSafeEqual(sha(id), sha(admin.username));
  const pwOk = timingSafeEqual(sha(password), sha(admin.password));
  return idOk && pwOk;
}

// ---------------------------------------------------------------- teachers file
function blank() {
  return { version: 1, teachers: [] };
}

function ensureShape(data) {
  return data && Array.isArray(data.teachers) ? data : blank();
}

function load() {
  return ensureShape(readJsonSync(TEACHERS_FILE, blank()));
}

function save(data) {
  writeJsonSync(TEACHERS_FILE, data);
}

export function publicTeacher(t) {
  if (!t) return null;
  const { passwordHash, ...rest } = t;
  return rest;
}

export function findTeacher(id) {
  const key = String(id || '').trim().toLowerCase();
  return load().teachers.find((t) => t.id === key) || null;
}

export function listTeachers() {
  return load().teachers.map(publicTeacher);
}

export function sanitizeId(id) {
  const key = String(id || '').trim().toLowerCase();
  return ID_RE.test(key) ? key : null;
}

/** Readable, unambiguous one-time password (no 0/O/1/l). */
export function generatePassword(length = 12) {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(length);
  let out = '';
  for (let i = 0; i < length; i++) out += chars[bytes[i] % chars.length];
  return out;
}

export function teacherDir(id) {
  const key = sanitizeId(id);
  if (!key) throw new Error('That teacher id is not allowed.');
  return join(TEACHERS_DIR, key);
}

// ---------------------------------------------------------------- attempts
function attemptState(key) {
  const rec = fails.get(key);
  if (!rec) return { locked: false };
  if (rec.lockedUntil && rec.lockedUntil > Date.now()) return { locked: true, until: rec.lockedUntil };
  if (rec.lockedUntil && rec.lockedUntil <= Date.now()) fails.delete(key);
  return { locked: false };
}

function bumpAttempt(key) {
  const rec = fails.get(key) || { count: 0, lockedUntil: 0 };
  rec.count += 1;
  if (rec.count >= MAX_FAILS) {
    rec.count = 0;
    rec.lockedUntil = Date.now() + LOCK_MS;
  }
  fails.set(key, rec);
}

function clearAttempts(key) {
  fails.delete(key);
}

export const LOCKOUT_MESSAGE = 'Too many sign-in attempts. Please wait a few minutes and try again.';

// ---------------------------------------------------------------- tokens
function issue(role, profile) {
  const token = randomBytes(24).toString('base64url');
  const entry = {
    role,
    id: profile.id,
    name: profile.name || '',
    mustChangePassword: !!profile.mustChangePassword,
    lastSeen: Date.now(),
  };
  tokens.set(token, entry);
  return {
    token,
    role,
    id: entry.id,
    name: entry.name,
    mustChangePassword: entry.mustChangePassword,
  };
}

export function verifyToken(token) {
  if (!token) return null;
  const entry = tokens.get(token);
  if (!entry) return null;
  if (Date.now() - entry.lastSeen > TOKEN_TTL_MS) {
    tokens.delete(token);
    return null;
  }
  entry.lastSeen = Date.now();
  return { ...entry, token };
}

export function logoutToken(token) {
  if (token) tokens.delete(token);
}

export function clearAllTokens() {
  tokens.clear();
}

// ---------------------------------------------------------------- login
export async function login(id, password) {
  const key = String(id || '').trim().toLowerCase();
  const attempt = attemptState(key);
  if (attempt.locked) return { error: LOCKOUT_MESSAGE };

  if (await isAdminCredentials(id, password)) {
    clearAttempts(key);
    const admin = adminConfig();
    return { ok: true, ...issue('admin', { id: admin.username, name: 'Administrator' }) };
  }

  const teacher = findTeacher(key);
  const passwordOk = teacher ? await verifyPassword(password, teacher.passwordHash) : false;
  if (!teacher || !passwordOk) {
    bumpAttempt(key);
    return { error: GENERIC_ERROR };
  }
  if (teacher.active === false) {
    // right password, switched off account - say so plainly (does not leak anything about other ids)
    return { error: 'This account is switched off. Please contact your administrator.' };
  }

  clearAttempts(key);
  const data = load();
  const row = data.teachers.find((t) => t.id === key);
  if (row) {
    row.lastLogin = Date.now();
    try { save(data); } catch (e) { console.warn(`[auth] could not store last login: ${e.message}`); }
  }
  return { ok: true, ...issue('teacher', {
    id: teacher.id,
    name: teacher.name || teacher.id,
    mustChangePassword: !!teacher.mustChangePassword,
  }) };
}

export async function changePassword(token, currentPassword, newPassword) {
  const auth = verifyToken(token);
  if (!auth) return { error: 'Please sign in again.' };
  if (auth.role !== 'teacher') return { error: 'This account type changes its password in the .env file, not here.' };

  const teacher = findTeacher(auth.id);
  if (!teacher) return { error: 'Please sign in again.' };
  const supplied = String(currentPassword || '');
  if (supplied) {
    if (!(await verifyPassword(supplied, teacher.passwordHash))) return { error: 'Your current password is not right.' };
  } else if (!auth.mustChangePassword) {
    // only the very first sign-in may skip the current password
    return { error: 'Enter your current password.' };
  }
  const next = String(newPassword || '');
  if (next.length < 8) return { error: 'Choose a new password with at least 8 characters.' };
  if (next === String(currentPassword)) return { error: 'Pick a password you have not used here before.' };

  const data = load();
  const row = data.teachers.find((t) => t.id === auth.id);
  if (!row) return { error: 'Please sign in again.' };
  row.passwordHash = await hashPassword(next);
  row.mustChangePassword = false;
  row.passwordChangedAt = Date.now();
  save(data);

  // every open session for this teacher keeps working, minus the password flag
  for (const entry of tokens.values()) {
    if (entry.role === 'teacher' && entry.id === auth.id) entry.mustChangePassword = false;
  }
  return { ok: true };
}

// ---------------------------------------------------------------- admin CRUD
export async function createTeacher({ id, name, email = '', department = '', tempPassword }) {
  const key = sanitizeId(id);
  if (!key) return { error: 'Teacher ID must be 2-40 letters, numbers, dots, dashes or underscores.' };
  if (!String(name || '').trim()) return { error: 'Please give the teacher a name.' };
  if (String(tempPassword || '').length < 8) return { error: 'The temporary password needs at least 8 characters.' };
  if (findTeacher(key)) return { error: 'That teacher ID already exists. Pick another one.' };

  const teacher = {
    id: key,
    name: String(name).trim(),
    email: String(email).trim(),
    department: String(department).trim(),
    passwordHash: await hashPassword(tempPassword),
    active: true,
    mustChangePassword: true,
    createdAt: Date.now(),
    createdBy: 'admin',
    lastLogin: 0,
  };
  await updateJson(TEACHERS_FILE, (data) => {
    const next = ensureShape(data);
    next.teachers.push(teacher);
    return next;
  }, blank());
  ensureDir(teacherDir(key));
  return { ok: true, teacher: publicTeacher(teacher) };
}

export async function updateTeacher(id, patch = {}) {
  const key = sanitizeId(id);
  if (!key || !findTeacher(key)) return { error: 'That teacher no longer exists.' };
  const result = await updateJson(TEACHERS_FILE, (data) => {
    const next = ensureShape(data);
    const row = next.teachers.find((t) => t.id === key);
    if (!row) return null;
    if (patch.name !== undefined) row.name = String(patch.name).trim() || row.name;
    if (patch.email !== undefined) row.email = String(patch.email).trim();
    if (patch.department !== undefined) row.department = String(patch.department).trim();
    row.updatedAt = Date.now();
    return next;
  }, blank());
  if (!result) return { error: 'That teacher no longer exists.' };
  return { ok: true, teacher: publicTeacher(findTeacher(key)) };
}

export async function resetTeacherPassword(id, newPassword) {
  const key = sanitizeId(id);
  if (!key || !findTeacher(key)) return { error: 'That teacher no longer exists.' };
  if (String(newPassword || '').length < 8) return { error: 'The new password needs at least 8 characters.' };
  const hash = await hashPassword(newPassword);
  await updateJson(TEACHERS_FILE, (data) => {
    const next = ensureShape(data);
    const row = next.teachers.find((t) => t.id === key);
    if (!row) return null;
    row.passwordHash = hash;
    row.mustChangePassword = true;
    row.passwordResetAt = Date.now();
    return next;
  }, blank());
  // the old password stops working everywhere
  for (const [token, entry] of [...tokens]) {
    if (entry.role === 'teacher' && entry.id === key) tokens.delete(token);
  }
  return { ok: true };
}

export async function setTeacherActive(id, active) {
  const key = sanitizeId(id);
  if (!key || !findTeacher(key)) return { error: 'That teacher no longer exists.' };
  await updateJson(TEACHERS_FILE, (data) => {
    const next = ensureShape(data);
    const row = next.teachers.find((t) => t.id === key);
    if (!row) return null;
    row.active = !!active;
    row.updatedAt = Date.now();
    return next;
  }, blank());
  if (!active) {
    for (const [token, entry] of tokens) {
      if (entry.role === 'teacher' && entry.id === key) tokens.delete(token);
    }
  }
  return { ok: true };
}

export function deleteTeacher(id) {
  const key = sanitizeId(id);
  if (!key || !findTeacher(key)) return { error: 'That teacher no longer exists.' };
  const folder = teacherDir(key);
  if (existsSync(folder)) {
    // move the whole folder to the trash instead of destroying it
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    ensureDir(TRASH_DIR);
    const target = join(TRASH_DIR, `teacher-${key}-${stamp}`);
    try {
      renameSyncSafe(folder, target);
    } catch (e) {
      return { error: `Could not move the teacher's folder: ${e.message}` };
    }
  }
  const data = load();
  data.teachers = data.teachers.filter((t) => t.id !== key);
  save(data);
  for (const [token, entry] of tokens) {
    if (entry.role === 'teacher' && entry.id === key) tokens.delete(token);
  }
  return { ok: true };
}

function renameSyncSafe(from, to) {
  try {
    renameSync(from, to);
  } catch (e) {
    if (e && e.code === 'EXDEV') {   // different volume: copy then remove
      cpSync(from, to, { recursive: true });
      rmSync(from, { recursive: true, force: true });
      return;
    }
    throw e;
  }
}

// ---------------------------------------------------------------- boot
export async function initAuth() {
  ensureDir(DATA_DIR);
  ensureDir(TEACHERS_DIR);
  ensureDir(SESSIONS_DIR);
  if (!readJsonSync(TEACHERS_FILE)) writeJsonSync(TEACHERS_FILE, blank());

  // Optional test/dev seed - only when the operator sets these variables.
  const seedId = process.env.SEED_TEACHER_ID;
  const seedPw = process.env.SEED_TEACHER_PASSWORD;
  if (seedId && seedPw && !findTeacher(seedId)) {
    const res = await createTeacher({
      id: seedId,
      name: process.env.SEED_TEACHER_NAME || 'Test Teacher',
      department: process.env.SEED_TEACHER_DEPARTMENT || '',
      tempPassword: seedPw,
    });
    if (res.ok) {
      await updateJson(TEACHERS_FILE, (data) => {
        const next = ensureShape(data);
        const row = next.teachers.find((t) => t.id === sanitizeId(seedId));
        if (row) { row.mustChangePassword = false; row.active = true; }
        return next;
      }, blank());
      console.log(`[auth] seeded teacher "${sanitizeId(seedId)}" from SEED_TEACHER_ID / SEED_TEACHER_PASSWORD`);
    }
  }

  const admin = adminConfig();
  if (admin.enabled) {
    console.log(`[admin] admin sign-in enabled for "${admin.username}" (password read from .env)`);
  } else {
    console.log('[admin] ADMIN_PASSWORD is not set in .env - admin access is DISABLED.');
    console.log('[admin] To enable it, add ADMIN_PASSWORD=your-secret to .env and restart the server.');
  }
}

export function teachersFileStats() {
  if (!existsSync(TEACHERS_FILE)) return null;
  const s = statSync(TEACHERS_FILE);
  return { size: s.size, mtime: s.mtimeMs };
}

export function listTeacherFolders() {
  if (!existsSync(TEACHERS_DIR)) return [];
  return readdirSync(TEACHERS_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name);
}
