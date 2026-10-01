import { io } from 'socket.io-client';

let socket = null;

// Tests (and any offline render) can set globalThis.__NO_WS__ = true to get a stub.
function stubSocket() {
  const noop = () => {};
  return {
    connected: false,
    on: noop, off: noop, once: noop, emit: noop, close: noop,
    io: { on: noop, off: noop },
  };
}

export function getSocket() {
  if (globalThis.__NO_WS__) return stubSocket();
  if (socket) return socket;
  const base = import.meta.env?.VITE_WS_URL || undefined; // Netlify -> Render/Railway URL
  socket = io(base || '/', {
    path: '/socket.io',
    transports: base ? ['websocket', 'polling'] : ['websocket', 'polling'],
    reconnection: true,
    // keep trying for a long while - a flaky classroom wifi must not boot
    // the dashboard (or a student) out of a running quiz
    reconnectionAttempts: 120,
    reconnectionDelay: 900,
    timeout: 8000,
  });
  socket.on('connect_error', (err) => {
    if (!socket.recovered) console.warn('[ws] connect_error', err?.message);
  });
  return socket;
}

export function emitAck(event, payload = {}, timeout = 9000) {
  if (globalThis.__NO_WS__) return Promise.reject(new Error('Offline mode - no server connection.'));
  return new Promise((resolve, reject) => {
    const s = getSocket();
    if (!s.connected) {
      const wait = setTimeout(() => reject(new Error('Not connected yet - check your internet.')), timeout);
      s.once('connect', () => {
        s.timeout(timeout).emit(event, payload, (err, res) => {
          clearTimeout(wait);
          err ? reject(new Error(err.message || String(err))) : resolve(res);
        });
      });
      return;
    }
    s.timeout(timeout).emit(event, payload, (err, res) => {
      err ? reject(new Error(err?.message || 'The server did not answer.')) : resolve(res);
    });
  });
}

export function on(event, handler) {
  const s = getSocket();
  s.on(event, handler);
  return () => s.off(event, handler);
}

export function request(url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token) headers['x-teacher-token'] = options.token;
  // relative URLs: use the page origin in a browser, or __API_BASE__ in tests
  const origin = globalThis.__API_BASE__ || (typeof location !== 'undefined' && location.origin) || '';
  const target = origin && String(url).startsWith('/') ? origin + url : url;
  return fetch(target, {
    ...options,
    headers: { 'content-type': 'application/json', ...headers },
    body: options.body ? JSON.stringify(options.body) : undefined,
  }).then(async (r) => {
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || `Request failed (${r.status})`);
    return data;
  });
}

/** Heartbeat so the teacher sees us as "attempting". */
export function startHeartbeat() {
  const id = setInterval(() => {
    if (getSocket().connected) getSocket().emit('player:ping');
  }, 5000);
  return () => clearInterval(id);
}
