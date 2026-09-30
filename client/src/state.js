// Global client state (survives page reloads via localStorage).
const KEY = 'python-adventure-v1';

const defaults = {
  nickname: '',
  team: '',
  code: '',
  playerId: '',
  mode: 'live',          // live | practice
  teacherToken: '',
  teacherCode: '',
  auth: { token: '', role: '', id: '', name: '', mustChangePassword: false },
  theme: '',             // '' = follow the system, or 'dark' | 'light'
  practiceConfig: { units: [1, 2, 3, 4, 5, 6, 7], count: 12, difficulty: 'mixed', timerOn: true },
  lastReport: null,
  soundOn: true,
  // which question bank the editor is working on ('default' = built-in)
  editorBankId: 'default',
  // last bank chosen on the dashboard (re-selected on the next visit)
  quizBankId: null,
};

function load() {
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...defaults };
  }
}

export const store = load();

// older saves only had teacherToken - fold it into the auth record
if (!store.auth?.token && store.teacherToken) {
  store.auth = { token: store.teacherToken, role: 'teacher', id: '', name: '', mustChangePassword: false };
}

export function save(patch = {}) {
  Object.assign(store, patch);
  try {
    localStorage.setItem(KEY, JSON.stringify(store));
  } catch { /* private mode */ }
  return store;
}

// ---------- theme (dark | light | follow system) ----------
export function currentTheme() {
  if (store.theme === 'dark' || store.theme === 'light') return store.theme;
  try {
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: light)').matches) return 'light';
  } catch { /* no matchMedia */ }
  return 'dark';
}

export function applyTheme() {
  const theme = currentTheme();
  try {
    const el = document.documentElement;
    if (el) {
      el.setAttribute('data-theme', theme);
      el.style.colorScheme = theme;
    }
    const m = document.querySelector('meta[name="theme-color"]');
    m?.setAttribute('content', theme === 'light' ? '#f7f7f5' : '#0f1013');
  } catch { /* no document */ }
  return theme;
}

export function setTheme(theme) {
  store.theme = theme === 'light' || theme === 'dark' ? theme : '';
  save();
  return applyTheme();
}

export function toggleTheme() {
  return setTheme(currentTheme() === 'light' ? 'dark' : 'light');
}

if (typeof document !== 'undefined') applyTheme();
