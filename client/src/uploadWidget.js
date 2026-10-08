// Reusable "upload a question JSON file" widget: file field, live preview with
// per-question errors, duplicate detection, then import. Used by the Question
// Banks screen and by step 2 of the create-quiz wizard (there it also selects
// the freshly created bank).
import { h, toast } from './ui.js';
import { request } from './net.js';
import { authToken } from './auth.js';
import { validateQuestions } from '../../shared/validate.js';
import { TYPE_LABELS, fileUnitList } from '../../shared/units.js';
import { bankLine } from './bankui.js';
import { MAX_PER_UPLOAD, templateRow } from './questionFiles.js';

/**
 * createUploadWidget({ onImported, showTemplate, unitListPromise })
 *   onImported(res)  - called after a successful import with the API response
 *                      ({file: setId, set, added, skipped, appended})
 * returns { node, busy: () => bool }
 */
export function createUploadWidget({ onImported, showTemplate = true, unitListPromise = null } = {}) {
  let busy = false;
  let picked = null;   // { name, questions, check, dupes, overwrite, appendTo, ... }
  let imported = null;
  let unitList = null;
  let setList = [];

  const unitsReady = (unitListPromise || request('/api/units/list', { token: authToken() })
    .then((list) => { if (Array.isArray(list) && list.length) return list; })
    .catch(() => null))
    .then((list) => { if (Array.isArray(list) && list.length) unitList = list; })
    .catch(() => { /* base seven is fine */ });

  const previewBox = h('div', null);
  const resultBox = h('div', null);

  const overwriteBox = h('input', {
    type: 'checkbox',
    onChange: (e) => { if (picked) { picked.overwrite = e.target.checked; renderPreview(); } },
  });

  const appendSel = h('select', {
    id: 'append-set',
    'aria-label': 'Add these questions to an existing question bank',
    style: { width: '100%' },
    onChange: (e) => { if (picked) picked.appendTo = e.target.value || null; },
  });
  function fillAppendSel() {
    appendSel.textContent = '';
    appendSel.append(h('option', { value: '' }, 'New question bank from this file'));
    for (const s of setList) {
      if (s.kind === 'upload') appendSel.append(h('option', { value: s.id }, `Add to “${s.name}” (${s.count} questions)`));
    }
    appendSel.value = picked?.appendTo && setList.some((s) => s.id === picked.appendTo)
      ? picked.appendTo : '';
  }
  request('/api/sets', { token: authToken() })
    .then((list) => { if (Array.isArray(list)) { setList = list; fillAppendSel(); } })
    .catch(() => { /* stay with fresh-set uploads */ });

  const fileInput = h('input', {
    type: 'file',
    accept: '.json,application/json',
    'aria-label': 'Question JSON file',
    onChange: (e) => {
      const file = e.target.files && e.target.files[0];
      if (file) onFile(file);
      e.target.value = '';   // allow re-picking the same file
    },
  });

  async function onFile(file) {
    if (busy) return;
    busy = true;
    previewBox.textContent = '';
    resultBox.textContent = '';
    previewBox.append(h('div', { class: 'empty' }, `Reading ${file.name}…`));
    try {
      await unitsReady;
      const text = await file.text();
      let data;
      let title = '';
      let settings = null;
      let fileNames = {};
      try {
        data = JSON.parse(text);
      } catch (e) {
        throw new Error(`That file is not valid JSON - ${e.message}`);
      }
      if (!Array.isArray(data)) {
        if (data && typeof data === 'object' && Array.isArray(data.questions)) {
          title = typeof data.title === 'string' ? data.title.trim() : '';
          settings = data.settings && typeof data.settings === 'object' ? data.settings : null;
          const rows = Array.isArray(data.units) ? data.units : [];
          fileNames = Object.fromEntries(
            rows.filter((u) => u && Number.isInteger(u.id) && typeof u.name === 'string' && u.name.trim())
              .map((u) => [u.id, u.name.trim().slice(0, 60)]),
          );
          data = data.questions;
        } else {
          throw new Error('The top level must be an array of question objects.');
        }
      }
      if (!data.length) throw new Error('That file has no questions in it.');
      if (data.length > MAX_PER_UPLOAD) {
        throw new Error(`One file can hold at most ${MAX_PER_UPLOAD} questions - this one has ${data.length}.`);
      }

      const check = validateQuestions(data, { units: unitList, fileUnits: true });
      let dupes = new Set();
      try {
        const bank = await request('/api/bank', { token: authToken() });
        const have = new Set((bank || []).map((q) => q.id));
        dupes = new Set(data.filter((q) => q && q.id && have.has(q.id)).map((q) => q.id));
      } catch { /* duplicate hints are optional */ }

      picked = {
        name: title || file.name,
        title,
        settings,
        fileNames,
        questions: data,
        check,
        dupes,
        overwrite: false,
        appendTo: null,
      };
      overwriteBox.checked = false;
      fillAppendSel();
      renderPreview();
    } catch (e) {
      picked = null;
      previewBox.textContent = '';
      previewBox.append(h('p', { role: 'alert', style: { color: 'var(--bad)' } }, e.message || 'Could not read that file.'));
    } finally {
      busy = false;
    }
  }

  function renderPreview() {
    previewBox.textContent = '';
    if (!picked) return;
    const { check, questions } = picked;

    const plan = fileUnitList(questions, picked.fileNames || {});
    const perUnit = {};
    plan.assignments.forEach((uid, i) => {
      const q = questions[i];
      if (!q || typeof q !== 'object') return;
      const u = perUnit[uid] || (perUnit[uid] = { n: 0, easy: 0, medium: 0, hard: 0, types: {} });
      u.n++;
      if (u[q.difficulty] !== undefined) u[q.difficulty]++;
      u.types[q.type] = (u.types[q.type] || 0) + 1;
    });
    const rows = plan.units.map((unit) => {
      const u = perUnit[unit.id] || { n: 0, easy: 0, medium: 0, hard: 0, types: {} };
      const typeBits = Object.entries(u.types).map(([t, n]) => `${TYPE_LABELS[t] || t} ×${n}`).join(', ');
      return h('div', { class: 'spread small', style: { padding: '4px 0', borderBottom: '1px solid var(--line)' } },
        h('span', null, h('b', null, unit.name)),
        h('span', { class: 'muted' }, `${u.n} · ${u.easy}E ${u.medium}M ${u.hard}H${typeBits ? ` · ${typeBits}` : ''}`));
    });

    const errorList = check.errors.length
      ? h('div', { class: 'col', style: { gap: '4px', marginTop: '8px' } },
        h('p', { role: 'alert', style: { color: 'var(--bad)', margin: 0 } },
          `${check.errors.length} question${check.errors.length === 1 ? '' : 's'} need${check.errors.length === 1 ? 's' : ''} fixing before import:`),
        ...check.errors.slice(0, 40).map((e) => h('div', {
          class: 'small', style: { color: 'var(--bad)', fontFamily: 'monospace' },
        }, `#${e.index + 1} (${e.id || 'no id'}): ${e.messages.join('; ')}`)),
        check.errors.length > 40 ? h('div', { class: 'muted small' }, `…and ${check.errors.length - 40} more`) : null)
      : h('p', { class: 'small', style: { color: 'var(--good)', margin: 0 } }, '✓ All checks passed.');

    const dupeNote = picked.dupes.size
      ? h('p', { class: 'muted small' },
        `${picked.dupes.size} of these already exist in your bank (${[...picked.dupes].slice(0, 5).join(', ')}${picked.dupes.size > 5 ? ', …' : ''}). `
        + 'They will be skipped unless you replace them.')
      : null;

    const importBtn = h('button', {
      class: 'btn primary block', type: 'button', disabled: !check.ok,
      onClick: () => doImport(),
    }, check.ok ? `Import ${questions.length} question${questions.length === 1 ? '' : 's'}` : 'Fix the errors above to import');

    previewBox.append(
      h('div', { class: 'card', style: { marginTop: '14px' } },
        h('div', { class: 'spread' },
          h('h2', { style: { margin: 0 } }, 'Preview'),
          h('span', { class: 'chip topic' }, `${questions.length} question${questions.length === 1 ? '' : 's'}`)),
        h('div', { class: 'muted small' }, picked.name),
        h('div', { class: 'divider' }),
        h('div', { class: 'col' }, rows.length ? rows : h('div', { class: 'empty' }, 'No unit info yet')),
        h('div', { class: 'divider' }),
        errorList,
        dupeNote,
        picked.dupes.size
          ? h('label', { class: `check ${picked.overwrite ? 'on' : ''}`, style: { width: '100%', marginTop: '8px' } },
            overwriteBox,
            h('span', null, h('b', null, 'Replace questions I already have'),
              h('div', { class: 'muted small', style: { fontWeight: 400 } }, 'Same id? Use the version from this file.')))
          : null,
        h('div', { style: { marginTop: '12px' } },
          h('label', { class: 'col', style: { gap: '4px' } },
            h('span', { class: 'small', style: { fontWeight: 700 } }, 'Where should these go?'),
            appendSel)),
        h('div', { style: { marginTop: '12px' } }, importBtn)));
  }

  async function doImport() {
    if (busy || !picked) return;
    busy = true;
    const btn = previewBox.querySelector('button.btn.primary');
    if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
    try {
      const res = await request('/api/upload', {
        method: 'POST',
        token: authToken(),
        body: {
          name: picked.title || picked.name.replace(/\.json$/i, ''),
          questions: picked.questions,
          settings: picked.settings || undefined,
          units: picked.fileNames && Object.keys(picked.fileNames).length
            ? Object.entries(picked.fileNames).map(([id, name]) => ({ id: Number(id), name }))
            : undefined,
          overwrite: picked.overwrite,
          appendTo: picked.appendTo || undefined,
        },
      });
      const added = res?.added ?? 0;
      const skippedIds = new Set((res?.skipped || []).map((s) => s.id));
      imported = {
        setId: res?.file || null,
        set: res?.set || null,
        added,
        skipped: (res?.skipped || []).length,
        kept: picked.questions.filter((q) => q && q.id && !skippedIds.has(q.id)).length,
        appended: !!res?.appended,
      };
      picked = null;
      previewBox.textContent = '';
      renderResult();
      toast(`Imported ${added} question${added === 1 ? '' : 's'}.`, 'ok');
      onImported?.(res);
    } catch (e) {
      toast(e.message || 'Could not import that file.', 'bad');
      if (btn) { btn.disabled = false; btn.textContent = 'Import again'; }
    } finally {
      busy = false;
    }
  }

  function renderResult() {
    resultBox.textContent = '';
    if (!imported) return;
    resultBox.append(
      h('div', { class: 'card', style: { marginTop: '14px', borderColor: 'var(--good)' } },
        h('h2', { style: { margin: 0 } }, '✓ Imported'),
        h('p', { class: 'muted' },
          imported.appended
            ? `Added ${imported.added} question${imported.added === 1 ? '' : 's'} to the bank “${imported.set?.name || ''}”`
            : `Added ${imported.added} question${imported.added === 1 ? '' : 's'} as its own question bank`
          + (imported.skipped ? `, skipped ${imported.skipped} duplicate${imported.skipped === 1 ? '' : 's'}` : '')
          + '. They are ready in the next quiz.'),
        imported.set ? h('p', { class: 'small', style: { fontWeight: 700 } }, bankLine(imported.set)) : null,
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
          h('button', {
            class: 'btn block', type: 'button',
            onClick: () => { imported = null; resultBox.textContent = ''; },
          }, 'Upload another file'))));
  }

  const node = h('div', null,
    showTemplate ? templateRow(null) : null,
    h('div', { class: 'field', style: { marginTop: showTemplate ? '10px' : 0 } },
      h('label', { for: 'upload-file' }, 'Choose a .json file'),
      fileInput,
      h('span', { class: 'hint' },
        `Up to ${MAX_PER_UPLOAD} questions per file. An array of questions, or a { title, settings, units, questions } object.`)),
    previewBox,
    resultBox);

  return { node, busy: () => busy };
}
