// Tiny DOM helpers - no framework, just h() + mount().
import { currentTheme, toggleTheme } from './state.js';

export function h(tag, props = null, ...kids) {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'html') el.innerHTML = v;
      else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (k in el && k !== 'list' && k !== 'type' && typeof v !== 'object') {
        try { el[k] = v; } catch { el.setAttribute(k, v); }
      } else el.setAttribute(k, v);
    }
  }
  append(el, kids);
  return el;
}

function append(el, kids) {
  for (const kid of kids) {
    if (kid == null || kid === false) continue;
    if (Array.isArray(kid)) append(el, kid);
    else if (kid instanceof Node) el.appendChild(kid);
    else el.appendChild(document.createTextNode(String(kid)));
  }
}

export function mount(root, ...nodes) {
  root.textContent = '';
  append(root, nodes);
  root.scrollTop = 0;
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
  return root;
}

export const $ = (sel, scope = document) => scope.querySelector(sel);
export const $$ = (sel, scope = document) => [...scope.querySelectorAll(sel)];

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

let toastHost;
export function toast(message, kind = '', ms = 2600) {
  toastHost ||= document.getElementById('toasts');
  const node = h('div', { class: `toast ${kind}` }, message);
  toastHost.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .3s, transform .3s';
    node.style.opacity = '0';
    node.style.transform = 'translateY(10px)';
    setTimeout(() => node.remove(), 320);
  }, ms);
  return node;
}

const COLORS = ['#ffd166', '#4cc9f0', '#3ddc97', '#ff7b8a', '#b388ff', '#ff9f1c'];
export function confetti(count = 48) {
  if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const host = document.getElementById('fx');
  for (let i = 0; i < count; i++) {
    const piece = h('div', { class: 'confetti' });
    piece.style.left = `${Math.random() * 100}vw`;
    piece.style.top = `${-10 - Math.random() * 20}vh`;
    piece.style.background = COLORS[i % COLORS.length];
    piece.style.animationDuration = `${1.6 + Math.random() * 1.6}s`;
    piece.style.animationDelay = `${Math.random() * 0.4}s`;
    piece.style.transform = `rotate(${Math.random() * 360}deg)`;
    host.appendChild(piece);
    setTimeout(() => piece.remove(), 3600);
  }
}

export function climbToast(text) {
  const node = h('div', { class: 'climb' }, text);
  document.body.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .4s, transform .4s';
    node.style.opacity = '0';
    node.style.transform = 'translateX(-50%) translateY(-16px)';
    setTimeout(() => node.remove(), 450);
  }, 2200);
}

export function modal({ title, body, actions = [] }) {
  const back = h('div', { class: 'modal-back', onClick: (e) => { if (e.target === back) close(); } });
  const box = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title || 'Dialog' },
    title ? h('h2', null, title) : null,
    h('div', null, body),
    actions.length ? h('div', { class: 'row', style: { marginTop: '16px', justifyContent: 'flex-end' } },
      actions.map((a) => h('button', {
        class: `btn ${a.kind || 'ghost'}`,
        onClick: () => { a.onClick?.(); if (a.close !== false) close(); },
      }, a.label))
    ) : null
  );
  back.appendChild(box);
  document.body.appendChild(back);
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  function close() {
    document.removeEventListener('keydown', onKey);
    back.remove();
  }
  setTimeout(() => box.querySelector('button, input, select')?.focus(), 30);
  return { close, box };
}

// Chrome never matches :focus/:focus-visible on datetime inputs (the internal
// field takes focus), so ring them inline from JS or they look unfocusable.
document.addEventListener('focusin', (e) => {
  if (e.target && e.target.type === 'datetime-local') e.target.style.outline = '2px solid var(--focus)';
});
document.addEventListener('focusout', (e) => {
  if (e.target && e.target.type === 'datetime-local') e.target.style.outline = '';
});

export function fmtTime(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function fmtClock(seconds) {
  const s = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function pct(n) {
  return `${Math.round(n * 100)}%`;
}

// A "Light mode" row that flips the theme instantly, no reload needed.
export function themeSwitch(label = 'Light mode', style = {}) {
  const lit = () => currentTheme() === 'light';
  const btn = h('button', {
    class: 'btn small', type: 'button',
    'aria-label': `${label} - currently ${lit() ? 'on' : 'off'}`,
    onClick: () => {
      const t = toggleTheme();
      btn.textContent = t === 'light' ? 'On' : 'Off';
      btn.setAttribute('aria-pressed', String(t === 'light'));
      btn.setAttribute('aria-label', `${label} - currently ${t === 'light' ? 'on' : 'off'}`);
    },
  }, lit() ? 'On' : 'Off');
  btn.setAttribute('aria-pressed', String(lit()));
  return h('div', { class: 'spread', style }, h('span', null, label), btn);
}
