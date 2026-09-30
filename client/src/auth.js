// Sign-in session for teachers and the admin.
// The token lives in localStorage; the server keeps it in memory for 60 minutes
// of inactivity. Idle for 30 minutes here and we sign out locally too.
import { request } from './net.js';
import { save, store } from './state.js';
import { toast } from './ui.js';
import { go } from './main.js';

const IDLE_MS = 30 * 60 * 1000;

export function authToken() {
  return store.auth?.token || store.teacherToken || '';
}

export function isTeacher() {
  return store.auth?.role === 'teacher' && !!store.auth.token;
}

export function isAdmin() {
  return store.auth?.role === 'admin' && !!store.auth.token;
}

export function needsPasswordChange() {
  return isTeacher() && !!store.auth.mustChangePassword;
}

function applySession(res) {
  const auth = {
    token: res.token || '',
    role: res.role || '',
    id: res.id || '',
    name: res.name || '',
    mustChangePassword: !!res.mustChangePassword,
  };
  save({ auth, teacherToken: auth.token });
  armIdleTimer();
  return auth;
}

export function clearSession() {
  save({
    auth: { token: '', role: '', id: '', name: '', mustChangePassword: false },
    teacherToken: '',
    teacherCode: '',
  });
  disarmIdleTimer();
}

export async function signIn(id, password) {
  const res = await request('/api/auth/login', { method: 'POST', body: { id, password } });
  applySession(res);
  return res;
}

export async function changeMyPassword(currentPassword, newPassword) {
  const res = await request('/api/auth/change-password', {
    method: 'POST',
    token: authToken(),
    body: { currentPassword, newPassword },
  });
  if (store.auth) {
    save({ auth: { ...store.auth, mustChangePassword: false } });
  }
  return res;
}

export async function signOut({ quiet = false } = {}) {
  const token = authToken();
  clearSession();
  try {
    if (token) await request('/api/auth/logout', { method: 'POST', token });
  } catch { /* the token is gone either way */ }
  if (!quiet) toast('Signed out.', '', 1800);
}

/** Ask the server whether our saved session still works; drop it if not. */
export async function verifySession() {
  if (!authToken()) return null;
  try {
    const res = await request('/api/auth/me', { token: authToken() });
    if (res?.role && store.auth) {
      save({ auth: { ...store.auth, role: res.role, id: res.id, name: res.name, mustChangePassword: !!res.mustChangePassword } });
    }
    return res;
  } catch (e) {
    if (/sign in again/i.test(e.message || '')) {
      clearSession();
      toast('Your session ended. Please sign in again.', 'bad', 3200);
      go('#/teacher/login');
    }
    return null;
  }
}

// ---------------- idle auto sign-out ----------------
let idleTimer = null;
const bump = () => armIdleTimer();

export function armIdleTimer() {
  disarmIdleTimer();
  if (!authToken()) return;
  idleTimer = setTimeout(async () => {
    await signOut({ quiet: true });
    toast('Signed out after 30 minutes of inactivity.', 'bad', 3600);
    go('#/teacher/login');
  }, IDLE_MS);
  if (typeof window !== 'undefined') {
    window.addEventListener('pointerdown', bump, { passive: true });
    window.addEventListener('keydown', bump, { passive: true });
  }
}

export function disarmIdleTimer() {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (typeof window !== 'undefined') {
    window.removeEventListener('pointerdown', bump);
    window.removeEventListener('keydown', bump);
  }
}
