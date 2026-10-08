// Question Banks tab: one place for everything about questions - list of
// banks, upload JSON, template downloads, open editor, rename, export, delete.
import { h, mount, toast } from '../ui.js';
import { go } from '../main.js';
import { request } from '../net.js';
import { authToken } from '../auth.js';
import { save } from '../state.js';
import { topbar } from '../topbar.js';
import { renameBankModal, confirmRemoveBank } from '../bankui.js';
import { createUploadWidget } from '../uploadWidget.js';
import { downloadFile, UNITS } from '../questionFiles.js';

export const title = 'Question banks';

export function render(root) {
  let unitList = [...UNITS];
  let setList = [];

  request('/api/units/list', { token: authToken() })
    .then((list) => { if (Array.isArray(list) && list.length) unitList = list; })
    .catch(() => { /* base seven is fine */ });

  const listBox = h('div', null, h('div', { class: 'empty' }, 'Loading question banks…'));
  const countChip = h('span', { class: 'chip' }, '…');

  const upload = createUploadWidget({
    showTemplate: true,
    onImported: () => renderSets(),
  });

  async function renderSets() {
    try {
      const list = await request('/api/sets', { token: authToken() });
      if (Array.isArray(list)) {
        setList = list;
        countChip.textContent = `${list.length} bank${list.length === 1 ? '' : 's'}`;
        listBox.textContent = '';
        if (!list.length) {
          listBox.append(h('div', { class: 'empty' },
            'No question banks yet - upload a JSON file above to create your first one.'));
          return;
        }
        list.forEach((s) => listBox.append(setRow(s)));
        return;
      }
    } catch { /* fall through */ }
    listBox.textContent = '';
    listBox.append(h('div', { class: 'empty' }, 'Question banks are unavailable right now.'));
  }

  async function exportSet(s) {
    try {
      const full = await request(`/api/sets/${encodeURIComponent(s.id)}/questions`, { token: authToken() });
      if (!full || !Array.isArray(full.questions)) throw new Error('That bank could not be read.');
      const wrapper = {
        title: full.name,
        settings: full.settings || undefined,
        units: full.units || undefined,
        questions: full.questions,
      };
      const name = `${(full.name || 'bank').replace(/[^\w.-]+/g, '-').toLowerCase()}.json`;
      downloadFile(name, JSON.stringify(wrapper, null, 2) + '\n');
      toast('Bank exported.', 'good');
    } catch (e) {
      toast(e.message || 'Could not export that bank.', 'bad');
    }
  }

  function setRow(s) {
    const units = (s.units || []).map((u) => u.name).join(', ');
    const editable = s.kind === 'upload';
    return h('div', { class: 'bank-row' },
      h('div', { class: 'bank-row-main' },
        h('b', null, s.label || s.name),
        h('span', { class: 'muted small' },
          `${s.count} question${s.count === 1 ? '' : 's'}${units ? ` · ${units}` : ''}`)),
      h('div', { class: 'bank-row-actions' },
        h('button', {
          class: 'btn small', type: 'button',
          'aria-label': `Open ${s.name} in the question editor`,
          onClick: () => { save({ editorBankId: s.id }); go('#/teacher/edit'); },
        }, 'Open editor'),
        editable ? h('button', {
          class: 'btn small ghost', type: 'button',
          'aria-label': `Rename bank ${s.name}`,
          onClick: () => renameBankModal({ bank: s, onDone: renderSets }),
        }, 'Rename') : null,
        h('button', {
          class: 'btn small ghost', type: 'button',
          'aria-label': `Export bank ${s.name} as JSON`,
          onClick: () => exportSet(s),
        }, 'Export'),
        editable ? h('button', {
          class: 'btn small ghost', type: 'button',
          'aria-label': `Delete bank ${s.name}`,
          onClick: () => confirmRemoveBank({ bank: s, onDone: renderSets }),
        }, 'Delete') : h('span', { class: 'chip' }, 'built in')));
  }
  renderSets();

  mount(root,
    h('div', { class: 'screen narrow pro' },
      topbar('banks'),
      h('div', { class: 'page-head' },
        h('div', { class: 'spread' },
          h('div', null,
            h('h1', null, 'Question banks'),
            h('p', { class: 'muted' }, 'Everything about your questions lives here - upload, edit, rename, export or delete.')),
          h('button', {
            class: 'btn small ghost', type: 'button',
            onClick: () => go('#/teacher/units'),
          }, 'Manage units'))),

      h('div', { class: 'card' },
        h('div', { class: 'spread' },
          h('h2', { style: { margin: 0 } }, 'Your banks'),
          countChip),
        listBox),

      h('div', { class: 'card' },
        h('h2', { style: { marginTop: 0 } }, 'Upload new questions'),
        h('p', { class: 'muted small' },
          'Nothing is saved until you see the preview and press Import - the file is checked with the same rules as npm run validate.'),
        upload.node)));
}
