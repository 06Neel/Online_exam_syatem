// Saved reports history: every finished session stays readable after restarts.
// Open the print page, re-download the CSV, or delete one you no longer need.
import { h, mount, modal, toast, pct } from '../ui.js';
import { go } from '../main.js';
import { request } from '../net.js';
import { authToken } from '../auth.js';
import { topbar } from '../topbar.js';
import { downloadCsv } from '../reporting.js';

export const title = 'Reports';

export function render(root) {
  let rows = [];
  let busy = false;
  const errorBox = h('p', { role: 'alert', style: { color: 'var(--bad)', display: 'none' } });
  const listDivider = h('div', { class: 'divider' });
  const listBox = h('div', null, h('div', { class: 'empty' }, 'Loading reports…'));

  function showError(msg) {
    errorBox.textContent = msg || '';
    errorBox.style.display = msg ? '' : 'none';
  }

  function paint() {
    listBox.textContent = '';
    listDivider.style.display = rows.length ? '' : 'none';
    if (!rows.length) {
      listBox.append(h('div', { class: 'empty' },
        h('div', null, 'No saved reports yet.'),
        h('p', { class: 'muted small' },
          'Finish a live quiz or a practice run and it lands here - printable, exportable and permanent.')));
      return;
    }
    for (const r of rows) listBox.append(rowEl(r));
  }

  function metaLine(r) {
    const bits = [];
    if (r.endedAt) bits.push(new Date(r.endedAt).toLocaleString());
    if (r.className) bits.push(r.section ? `${r.className} · ${r.section}` : r.className);
    bits.push(r.mode === 'practice' ? 'Practice' : 'Live');
    bits.push(`${r.players} player${r.players === 1 ? '' : 's'}`);
    bits.push(`${pct(r.accuracy || 0)} accuracy`);
    return bits.join(' · ');
  }

  function rowEl(r) {
    const open = () => go(`#/teacher/report/${r.code}`);
    return h('div', { class: 'row', style: { padding: '12px 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap', gap: '10px' } },
      h('div', { style: { flex: '1 1 320px', minWidth: 0 } },
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
          h('span', { class: 'chip topic', style: { fontFamily: 'var(--mono, monospace)' } }, r.code),
          h('b', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' } }, r.title || 'Python Adventure'),
          r.mode === 'practice' ? h('span', { class: 'chip' }, 'Practice') : null),
        h('div', { class: 'muted small', style: { marginTop: '4px' } }, metaLine(r))),
      h('div', { class: 'row', style: { gap: '8px' } },
        h('button', { class: 'btn primary small', type: 'button', onClick: open }, 'Open'),
        h('button', { class: 'btn small', type: 'button', onClick: () => exportCsv(r) }, '⬇️ CSV'),
        h('button', { class: 'btn small ghost', type: 'button', onClick: () => confirmDelete(r) }, '🗑 Delete')));
  }

  async function exportCsv(r) {
    if (busy) return;
    busy = true;
    showError('');
    try {
      const report = await request(`/api/reports/${encodeURIComponent(r.code)}`, { token: authToken() });
      downloadCsv(report);
    } catch (e) {
      showError(e.message || 'Could not load that report.');
    } finally {
      busy = false;
    }
  }

  function confirmDelete(r) {
    modal({
      title: 'Delete this report?',
      body: h('p', null, `Session ${r.code} will be removed from your history. Your question bank and units are untouched.`),
      actions: [
        { label: 'Keep it' },
        {
          label: 'Delete report', kind: 'primary', onClick: async () => {
            if (busy) return;
            busy = true;
            showError('');
            try {
              await request(`/api/reports/${encodeURIComponent(r.code)}`, { method: 'DELETE', token: authToken() });
              rows = rows.filter((x) => x.code !== r.code);
              toast('Report deleted.', 'ok');
              paint();
            } catch (e) {
              showError(e.message || 'Could not delete the report.');
            } finally {
              busy = false;
            }
          },
        },
      ],
    });
  }

  async function load() {
    showError('');
    listBox.textContent = '';
    listBox.append(h('div', { class: 'empty' }, 'Loading reports…'));
    try {
      rows = await request('/api/reports', { token: authToken() });
      if (!Array.isArray(rows)) rows = [];
    } catch (e) {
      rows = [];
      showError(e.message || 'Could not load your reports.');
    }
    paint();
  }

  mount(root,
    h('div', { class: 'screen narrow pro' },
      topbar('reports'),
      h('div', { class: 'page-head' },
        h('h1', null, 'Reports'),
        h('p', { class: 'muted' },
          'Every finished session, kept on this account. Open one to print it or re-export the CSV - '
          + 'deleting a report never touches your questions.')),

      h('div', { class: 'card' },
        errorBox,
        listDivider,
        listBox)));

  load();
}
