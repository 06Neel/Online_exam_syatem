// Manage units: rename the built-in seven, add your own, remove empty ones.
// Renames and additions apply to this teacher's quiz builder, editor and uploads.
// Also keeps this teacher's classes + sections (tagged onto quizzes for reports).
import { h, mount, toast, modal } from '../ui.js';
import { request } from '../net.js';
import { authToken } from '../auth.js';
import { topbar } from '../topbar.js';
import { UNITS as BASE_UNITS } from '../../../shared/units.js';

export const title = 'Manage units';

const MAX_UNITS = 30;
const MAX_ID = 99;

export function render(root) {
  let busy = false;
  const baseIds = BASE_UNITS.map((u) => u.id);
  let rows = BASE_UNITS.map((u) => ({ id: u.id, name: u.name, custom: false, count: 0 }));
  let loaded = false;

  const listBox = h('div', null, h('div', { class: 'empty' }, 'Loading units…'));
  const errorBox = h('p', { role: 'alert', style: { color: 'var(--bad)', display: 'none' } });

  const addName = h('input', {
    type: 'text', maxlength: '40', placeholder: 'e.g. Files & folders',
    'aria-label': 'New unit name',
    style: { flex: '1 1 220px' },
  });

  const addBtn = h('button', { class: 'btn', type: 'button', onClick: () => addUnit() }, '＋ Add unit');
  const saveBtn = h('button', { class: 'btn primary', type: 'button', onClick: () => save() }, 'Save units');

  function showError(msg) {
    errorBox.textContent = msg || '';
    errorBox.style.display = msg ? '' : 'none';
  }

  function nextId() {
    const used = new Set(rows.map((r) => r.id));
    for (let i = 8; i <= MAX_ID; i++) if (!used.has(i)) return i;
    return null;
  }

  function addUnit() {
    if (busy) return;
    const name = addName.value.trim();
    if (name.length < 2) { showError('Give the new unit a name of at least 2 characters.'); addName.focus(); return; }
    if (rows.length >= MAX_UNITS) { showError(`Keep it to ${MAX_UNITS} units or fewer.`); return; }
    const id = nextId();
    if (!id) { showError(`No unit ids left (up to ${MAX_ID}).`); return; }
    rows.push({ id, name, custom: true, count: 0 });
    addName.value = '';
    showError('');
    paint();
  }

  function removeUnit(id) {
    const row = rows.find((r) => r.id === id);
    if (!row || !row.custom) return;
    if (row.count > 0) { showError(`Unit ${id} still has ${row.count} question(s). Move or delete them first.`); return; }
    rows = rows.filter((r) => r.id !== id);
    showError('');
    paint();
  }

  async function save() {
    if (busy || !loaded) return;
    for (const r of rows) {
      const name = String(r.name || '').trim();
      if (name.length < 2 || name.length > 40) {
        showError(`Unit ${r.id} needs a name of 2-40 characters.`);
        return;
      }
    }
    for (const id of baseIds) {
      if (!rows.some((r) => r.id === id)) {
        showError(`Unit ${id} is built in and cannot be removed.`);
        return;
      }
    }
    busy = true;
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving…';
    showError('');
    try {
      const res = await request('/api/units/list', {
        method: 'PUT',
        token: authToken(),
        body: { units: rows.map((r) => ({ id: r.id, name: String(r.name).trim() })) },
      });
      if (Array.isArray(res?.units)) rows = mergeCounts(rows, res.units);
      toast('Units saved.', 'ok');
      paint();
      load();   // refresh question counts against the new list
    } catch (e) {
      showError(e.message || 'Could not save the units.');
    } finally {
      busy = false;
      saveBtn.disabled = false;
      saveBtn.textContent = 'Save units';
    }
  }

  function mergeCounts(current, saved) {
    const counts = new Map(current.map((r) => [r.id, r.count]));
    return saved.map((u) => ({
      id: u.id,
      name: u.name,
      custom: !baseIds.includes(u.id),
      count: counts.get(u.id) || 0,
    }));
  }

  function paint() {
    listBox.textContent = '';
    for (const r of [...rows].sort((a, b) => a.id - b.id)) {
      const nameInput = h('input', {
        type: 'text', value: r.name, maxlength: '40',
        'aria-label': `Unit ${r.id} name`,
        onInput: (e) => { r.name = e.target.value; },
      });
      const chip = h('span', { class: 'chip topic', title: r.custom ? 'Your unit' : 'Built in' }, `Unit ${r.id}`);
      const countChip = h('span', { class: 'muted small' },
        `${r.count} question${r.count === 1 ? '' : 's'}`);
      const row = h('div', { class: 'spread', style: { gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' } },
        h('div', { class: 'row', style: { gap: '8px', flex: '1 1 260px' } }, chip, nameInput),
        h('div', { class: 'row', style: { gap: '10px' } },
          countChip,
          r.custom
            ? h('button', {
              class: 'btn small ghost', type: 'button',
              'aria-label': `Remove unit ${r.id}`,
              onClick: () => removeUnit(r.id),
            }, 'Remove')
            : h('span', { class: 'muted small', title: 'Built-in units can be renamed, not removed' }, '🔒')));
      listBox.append(row);
    }
    listBox.append(
      h('div', { class: 'row', style: { gap: '8px', marginTop: '12px', flexWrap: 'wrap' } }, addName, addBtn));
  }

  async function load() {
    try {
      const [list, counts] = await Promise.all([
        request('/api/units/list', { token: authToken() }),
        request('/api/units', { token: authToken() }).catch(() => ({})),
      ]);
      if (Array.isArray(list) && list.length) {
        rows = mergeCounts(rows.length ? rows : BASE_UNITS.map((u) => ({ id: u.id, name: u.name, count: 0 })), list);
        rows = rows.map((r) => ({ ...r, count: counts?.[r.id]?.total || 0 }));
      }
      loaded = true;
      showError('');
    } catch (e) {
      showError(e.message || 'Could not load your units.');
    }
    paint();
  }
  load();

  // ---------- classes & sections ----------
  let classes = [];
  const classListBox = h('div', null, h('div', { class: 'empty' }, 'Loading classes…'));
  const classError = h('p', { role: 'alert', style: { color: 'var(--bad)', display: 'none' } });
  const newClassName = h('input', {
    type: 'text', maxlength: '40', placeholder: 'e.g. Year 9',
    'aria-label': 'New class name', style: { flex: '1 1 200px' },
  });
  const newClassSections = h('input', {
    type: 'text', maxlength: '200', placeholder: 'Sections, comma separated (optional): A, B',
    'aria-label': 'New class sections, comma separated', style: { flex: '2 1 260px' },
  });
  const addClassBtn = h('button', { class: 'btn', type: 'button', onClick: () => addClass() }, '＋ Add class');

  function showClassError(msg) {
    classError.textContent = msg || '';
    classError.style.display = msg ? '' : 'none';
  }

  function parseSections(raw) {
    return [...new Set(String(raw || '').split(',').map((s) => s.trim()).filter(Boolean))];
  }

  function paintClasses() {
    classListBox.textContent = '';
    if (!classes.length) {
      classListBox.append(h('div', { class: 'empty' }, 'No classes yet - add your first one below.'));
    }
    for (const c of classes) {
      const nameInput = h('input', {
        type: 'text', value: c.name, maxlength: '40',
        'aria-label': `Class ${c.name} name`,
        onInput: (e) => { c.name = e.target.value; },
      });
      const secInput = h('input', {
        type: 'text', value: (c.sections || []).join(', '), maxlength: '200',
        'aria-label': `Class ${c.name} sections, comma separated`,
        onInput: (e) => { c._raw = e.target.value; },
      });
      const saveRow = h('button', {
        class: 'btn small', type: 'button',
        onClick: async () => {
          const name = String(c.name || '').trim();
          if (name.length < 2 || name.length > 40) { showClassError('Class name must be 2-40 characters.'); return; }
          showClassError('');
          try {
            const updated = await request(`/api/classes/${encodeURIComponent(c.id)}`, {
              method: 'PATCH',
              token: authToken(),
              body: { name, sections: parseSections(c._raw ?? (c.sections || []).join(', ')) },
            });
            Object.assign(c, updated);
            delete c._raw;
            toast('Class saved.', 'ok');
            paintClasses();
          } catch (e) {
            showClassError(e.message || 'Could not save the class.');
          }
        },
      }, 'Save');
      const delRow = h('button', {
        class: 'btn small ghost', type: 'button',
        'aria-label': `Remove class ${c.name}`,
        onClick: () => {
          modal({
            title: 'Remove this class?',
            body: h('p', null, `"${c.name}" will be removed. Quizzes that already used it keep showing its name in their reports.`),
            actions: [
              { label: 'Keep it' },
              {
                label: 'Remove class', kind: 'primary',
                onClick: async () => {
                  try {
                    await request(`/api/classes/${encodeURIComponent(c.id)}`, { method: 'DELETE', token: authToken() });
                    classes = classes.filter((x) => x.id !== c.id);
                    toast('Class removed.', 'ok');
                    paintClasses();
                  } catch (e) {
                    showClassError(e.message || 'Could not remove the class.');
                  }
                },
              },
            ],
          });
        },
      }, 'Remove');

      classListBox.append(h('div', { class: 'spread', style: { gap: '10px', padding: '8px 0', borderBottom: '1px solid var(--line)', flexWrap: 'wrap' } },
        h('div', { class: 'row', style: { gap: '8px', flex: '1 1 200px' } }, nameInput),
        h('div', { class: 'row', style: { gap: '8px', flex: '2 1 260px' } }, secInput),
        h('div', { class: 'row', style: { gap: '8px' } }, saveRow, delRow)));
    }
    classListBox.append(h('div', { class: 'row', style: { gap: '8px', marginTop: '12px', flexWrap: 'wrap' } },
      newClassName, newClassSections, addClassBtn));
  }

  async function addClass() {
    const name = newClassName.value.trim();
    if (name.length < 2) { showClassError('Give the class a name of at least 2 characters.'); newClassName.focus(); return; }
    showClassError('');
    try {
      const made = await request('/api/classes', {
        method: 'POST',
        token: authToken(),
        body: { name, sections: parseSections(newClassSections.value) },
      });
      classes.push(made);
      newClassName.value = '';
      newClassSections.value = '';
      toast('Class added.', 'ok');
      paintClasses();
    } catch (e) {
      showClassError(e.message || 'Could not add the class.');
    }
  }

  async function loadClasses() {
    try {
      const list = await request('/api/classes', { token: authToken() });
      if (Array.isArray(list)) classes = list;
    } catch {
      /* leave the empty state */
    }
    paintClasses();
  }
  loadClasses();

  mount(root,
    h('div', { class: 'screen narrow pro' },
      topbar('classes'),
      h('div', { class: 'page-head' },
        h('h1', null, 'Units & classes'),
        h('p', { class: 'muted' },
          'Rename the syllabus units your quizzes draw from, add your own, '
          + 'and tag quizzes with a class and section so reports group correctly.')),

      h('div', { class: 'card' },
        h('h2', null, 'Units'),
        h('p', { class: 'muted' },
          'The syllabus units for your quizzes. Rename the built-in seven to match your class, '
          + 'or add your own - they show up in the quiz builder, the editor and uploads right away.'),
        errorBox,
        h('div', { class: 'divider' }),
        listBox,
        h('div', { class: 'spread', style: { marginTop: '14px' } },
          h('span', { class: 'muted small' },
            `Units 1-${baseIds.length} are built in (renamable, never removable). Ids run up to ${MAX_ID}.`),
          saveBtn)),

      h('div', { class: 'card' },
        h('h2', null, 'Classes & sections'),
        h('p', { class: 'muted' },
          'Tag a quiz with a class and section so the report groups your students. '
          + 'Sections are optional - leave them blank for a single group.'),
        classError,
        h('div', { class: 'divider' }),
        classListBox))
  );
}
