// Saved session report, printable: fetch by code and reuse the live dashboard's
// report layout. Top-bar actions (history, delete, print) never print themselves.
import { h, mount, modal, toast } from '../ui.js';
import { go } from '../main.js';
import { request } from '../net.js';
import { authToken } from '../auth.js';
import { topbar } from '../topbar.js';
import { reportView, setUnitNames } from './teacherLive.js';
import { downloadCsv } from '../reporting.js';

export const title = 'Session report';

export function render(root) {
  const code = (location.hash.match(/^#\/teacher\/report\/([A-Za-z0-9]{4})$/) || [])[1];

  const bar = h('div', { class: 'page-head no-print' },
    h('div', { class: 'spread' },
      h('div', null,
        h('h2', { style: { margin: '0 0 .3em' } }, 'Session report'),
        h('p', { class: 'muted small' }, 'Scores, breakdown and question analysis - printable with Ctrl+P.')),
      h('div', { class: 'row' },
        h('button', { class: 'btn small ghost', onClick: () => go('#/teacher/reports') }, '← History'),
        h('button', { class: 'btn small', type: 'button', onClick: () => window.print() }, '🖨 Print report'),
        code ? h('button', { class: 'btn small ghost', type: 'button', onClick: () => confirmDelete(code) }, '🗑 Delete') : null)));

  const body = h('div', { class: 'card' }, h('p', { class: 'muted' }, 'Loading report…'));
  mount(root, h('div', { class: 'screen narrow print-page pro' }, topbar('reports'), bar, body));

  if (!code) {
    body.replaceWith(notFound('That link has no session code in it.'));
    return;
  }

  Promise.all([
    request(`/api/reports/${encodeURIComponent(code)}`, { token: authToken() }),
    request('/api/units/list', { token: authToken() }).catch(() => null),
  ])
    .then(([report, units]) => {
      setUnitNames(units);
      const view = reportView(report);
      // extra print-only metadata line: class/section/date once, above everything
      const cfg = report.config || {};
      const meta = h('div', { class: 'chips no-print', style: { marginBottom: '10px' } },
        h('span', { class: 'chip' }, report.code),
        cfg.className ? h('span', { class: 'chip' }, `${cfg.className}${cfg.section ? ` · ${cfg.section}` : ''}`) : null,
        h('span', { class: 'chip' }, cfg.mode === 'practice' ? 'Practice' : 'Live'));
      body.replaceWith(h('div', null, meta, view));
    })
    .catch((e) => body.replaceWith(notFound(e.message || 'That report could not be loaded.')));
}

function notFound(msg) {
  return h('div', { class: 'card' },
    h('h1', null, 'Report not found'),
    h('p', { class: 'muted' }, msg),
    h('div', { class: 'row', style: { marginTop: '12px' } },
      h('button', { class: 'btn primary', type: 'button', onClick: () => go('#/teacher/reports') }, 'Browse reports'),
      h('button', { class: 'btn ghost', type: 'button', onClick: () => go('#/teacher') }, 'Dashboard')));
}

function confirmDelete(code) {
  modal({
    title: 'Delete this report?',
    body: h('p', null, `The saved report for session ${code} will be removed. Your question bank and units are untouched.`),
    actions: [
      { label: 'Keep it' },
      {
        label: 'Delete report', kind: 'primary', onClick: async () => {
          try {
            const res = await request(`/api/reports/${encodeURIComponent(code)}`, { method: 'DELETE', token: authToken() });
            if (res && res.ok !== true && res.error) throw new Error(res.error);
            toast('Report deleted.', 'ok');
            go('#/teacher/reports');
          } catch (e) {
            toast(e.message || 'Could not delete the report.', 'bad');
          }
        },
      },
    ],
  });
}
