// Upload questions from a JSON file: template + guide, live preview with
// per-question numbered errors, duplicate detection, then import.
// The exact same validator runs here, in the server and in npm run validate.
import { h, mount, toast } from '../ui.js';
import { save } from '../state.js';
import { go } from '../main.js';
import { request, emitAck } from '../net.js';
import { authToken, signOut } from '../auth.js';
import { validateQuestions } from '../../../shared/validate.js';
import { UNITS, TYPE_LABELS, unitName, fileUnitList } from '../../../shared/units.js';
import { renameBankModal, confirmRemoveBank, bankLine } from '../bankui.js';

export const title = 'Upload questions';

const MAX_PER_UPLOAD = 200;

const TEMPLATE = [
  {
    id: 'my-q-001',
    unit: 1,
    type: 'mcq',
    difficulty: 'easy',
    boss: false,
    prompt: 'Which command starts the Python interpreter?',
    options: [
      { id: 'a', text: 'python' },
      { id: 'b', text: 'start python' },
      { id: 'c', text: 'run python' },
      { id: 'd', text: 'py start' },
    ],
    answer: ['a'],
    explanation: 'Running python with no arguments opens the interactive interpreter, also called the REPL.',
    analogy: 'It is like starting a conversation with the computer - you talk, it answers.',
    hint: 'It is the language name, nothing more.',
    tags: ['setup', 'repl'],
    mini: {
      type: 'mcq',
      prompt: 'What does the >>> prompt mean?',
      options: [
        { id: 'a', text: 'Python is ready for your next line' },
        { id: 'b', text: 'The program crashed' },
      ],
      answer: 'a',
      explanation: 'The >>> prompt means the interpreter is waiting for your next line of code.',
    },
  },
  {
    id: 'my-q-002',
    unit: 2,
    type: 'fill-blank',
    difficulty: 'easy',
    boss: false,
    prompt: 'Store the number 5 in a variable called count.',
    blank: 'count = ___',
    accepted: ['5'],
    explanation: 'An equals sign with no spaces stores the value on the right into the name on the left.',
    analogy: 'Think of a label on a box - count is the label, 5 is what goes inside.',
    hint: 'Use an equals sign, then the number itself.',
    tags: ['variables', 'assignment'],
    mini: {
      type: 'mcq',
      prompt: 'Which one stores a value?',
      options: [
        { id: 'a', text: 'count = 5' },
        { id: 'b', text: 'count == 5' },
      ],
      answer: 'a',
      explanation: 'A single equals sign assigns; the double equals sign only compares two values.',
    },
  },
];

function guideText(units) {
  return `PYTHON ADVENTURE - QUESTION FILE GUIDE
======================================

A file is a JSON array of question objects (or an object with
title, settings, units and questions). Start from template.json
(this page can download it) and keep the structure.

COMMON FIELDS (every question)
  id          unique text id, e.g. "u3-q42" - never reuse an id
  unit        1..7 (see the unit list below)
  type        mcq | code-output | spot-error | fill-blank | match
  difficulty  easy | medium | hard
  boss        true or false (boss questions get +10s on the clock)
  prompt      the question text, at least 5 characters
  explanation why the answer is right - at least 20 characters
  analogy     everyday comparison - at least 15 characters
  hint        shown when a player uses a hint - at least 8 characters
  tags        array of one or more topic words, e.g. ["loops"]
  mini        the "try again" follow-up (see below)

BY TYPE
  mcq / code-output / spot-error
    options   exactly 4 objects: {id:"a",text:"..."} ids a,b,c,d
    answer    array of option ids that are correct, e.g. ["a"]
    code      (code-output, spot-error) a snippet of at least 3 characters
  fill-blank
    blank     the sentence with ___ where the answer goes
    accepted  array of accepted answers, e.g. ["5", "five"]
  match
    pairs     at least 2 of {left:"...", right:"..."} - right values unique

MINI (the try-again question, required)
  type mcq-like: options (>=2), answer (one option id)
  type fill-blank: accepted array

UNITS
  Numeric ids (unit: 1..7 or your own 8-99) keep that id; use them only for
  units in this list:
${units.map((u) => `  ${u.id}. ${u.name}`).join('\n')}
  Or write any unit name as text (unit: "Loops") - names stay inside this
  file's own bank and never join the shared unit list. An optional top-level
  "units": [{"id":4,"name":"..."}] names numeric units for you.

LIMITS
  Up to ${MAX_PER_UPLOAD} questions per file. Duplicate ids inside one file are
  skipped; ids you already have are skipped unless "replace" is ticked.

VALIDATION
  The upload screen previews the file with the exact checks used by
  "npm run validate". Fix every numbered error, then import.
`;
}

function downloadFile(name, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function render(root) {
  let busy = false;
  let picked = null;    // { name, questions, check, dupes: Set, overwrite, appendTo }
  let imported = null;  // { setId, added, skipped, set }
  let unitList = [...UNITS];   // swapped for the teacher's list once it loads
  let setList = [];     // existing question sets (for "add to existing set")

  const unitsReady = request('/api/units/list', { token: authToken() })
    .then((list) => { if (Array.isArray(list) && list.length) unitList = list; })
    .catch(() => { /* base seven is fine */ });

  const previewBox = h('div', null);
  const resultBox = h('div', null);

  const overwriteBox = h('input', {
    type: 'checkbox',
    onChange: (e) => { if (picked) { picked.overwrite = e.target.checked; renderPreview(); } },
  });

  // "Add to existing bank" - the file's questions join that bank instead of a new one
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
    .then((list) => {
      if (Array.isArray(list)) { setList = list; fillAppendSel(); }
    })
    .catch(() => { /* no sets endpoint? stay with fresh-set uploads */ });

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

  // ---------- read + validate ----------
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
      // accept a bare array, or the full wrapper { title, settings, units, questions }
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
      if (data.length > MAX_PER_UPLOAD) throw new Error(`One file can hold at most ${MAX_PER_UPLOAD} questions - this one has ${data.length}.`);

      // fileUnits: this file may use its own unit names ("Loops") - they stay
      // inside this bank; numeric ids must still match YOUR unit list
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

  // ---------- preview ----------
  function renderPreview() {
    previewBox.textContent = '';
    if (!picked) return;
    const { check, questions } = picked;

    // group by the file's own units: names/topics, counts, difficulty split.
    // Names resolve bank-locally (file map / per-question unitName / "Unit n")
    // - never from the teacher's shared unit list.
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
      : h('p', { class: 'small', style: { color: 'var(--ok, #1a7f37)', margin: 0 } }, '✓ All checks passed.');

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

  // ---------- import ----------
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
      renderSets();
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
    const n = imported.kept || imported.added;
    const startBtn = h('button', {
      class: 'btn primary block', type: 'button',
      onClick: async () => {
        if (busy) return;
        busy = true;
        startBtn.disabled = true;
        startBtn.textContent = 'Opening the lobby…';
        try {
          const res = await emitAck('host:create', {
            token: authToken(),
            setId: imported.setId,
            title: 'Python Adventure',
            count: Math.min(40, Math.max(4, n)),
          });
          if (res?.error || !res?.ok) throw new Error(res?.error || 'The server did not create the quiz.');
          // remember which session this dashboard belongs to (and carry it in the URL)
          if (res.code) save({ teacherCode: res.code });
          go(`#/teacher/live${res.code ? `?code=${res.code}` : ''}`);
        } catch (e) {
          toast(e.message || 'Could not create the quiz.', 'bad');
          busy = false;
          startBtn.disabled = false;
          startBtn.textContent = 'Start a live quiz with these questions';
        }
      },
    }, 'Start a live quiz with these questions');

    resultBox.append(
      h('div', { class: 'card', style: { marginTop: '14px', borderColor: 'var(--ok, #1a7f37)' } },
        h('h2', { style: { margin: 0 } }, '✓ Imported'),
        h('p', { class: 'muted' },
          imported.appended
            ? `Added ${imported.added} question${imported.added === 1 ? '' : 's'} to the bank “${imported.set?.name || ''}”`
            : `Added ${imported.added} question${imported.added === 1 ? '' : 's'} as its own question bank`
          + (imported.skipped ? `, skipped ${imported.skipped} duplicate${imported.skipped === 1 ? '' : 's'}` : '')
          + '. They are ready in the next quiz.'),
        imported.set
          ? h('p', { class: 'small', style: { fontWeight: 700 } }, bankLine(imported.set))
          : null,
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
          startBtn),
        h('div', { class: 'row', style: { gap: '8px', marginTop: '8px' } },
          h('button', { class: 'btn block', type: 'button', onClick: () => { imported = null; resultBox.textContent = ''; } }, 'Upload another file'),
          h('button', { class: 'btn ghost block', type: 'button', onClick: () => go('#/teacher/edit') }, 'Open the question bank'))));
  }

  // ---------- question banks (see / rename / remove) ----------
  const uploadsBox = h('div', null, h('div', { class: 'empty' }, 'Loading…'));
  async function renderSets() {
    try {
      let list = await request('/api/sets', { token: authToken() });
      if (Array.isArray(list)) {
        setList = list;
        fillAppendSel();
        uploadsBox.textContent = '';
        if (!list.length) {
          uploadsBox.append(h('div', { class: 'empty' }, 'No question banks yet - your first file will show up here.'));
          return;
        }
        list.forEach((s) => uploadsBox.append(setRow(s)));
        return;
      }
    } catch { /* fall back to the plain upload history below */ }
    request('/api/uploads', { token: authToken() }).then((list) => {
      uploadsBox.textContent = '';
      if (!list?.length) {
        uploadsBox.append(h('div', { class: 'empty' }, 'No uploads yet - your first file will show up here.'));
        return;
      }
      list.slice(0, 8).forEach((b) => {
        uploadsBox.append(h('div', { class: 'spread small', style: { padding: '6px 0', borderBottom: '1px solid var(--line)' } },
          h('span', null, h('b', null, b.name || b.file), ` · ${b.count} question${b.count === 1 ? '' : 's'}`),
          h('span', { class: 'row', style: { gap: '8px' } },
            h('span', { class: 'muted' }, b.uploadedAt ? new Date(b.uploadedAt).toLocaleString() : ''),
            h('button', {
              class: 'btn small ghost', type: 'button',
              'aria-label': `Remove upload ${b.name || b.file}`,
              onClick: () => confirmRemoveBank({ bank: b, onDone: renderSets }),
            }, 'Remove'))));
      });
    }).catch(() => {
      uploadsBox.textContent = '';
      uploadsBox.append(h('div', { class: 'empty' }, 'Upload history unavailable right now.'));
    });
  }

  function setRow(s) {
    const units = (s.units || []).map((u) => u.name).join(', ');
    const actions = s.kind === 'upload'
      ? h('span', { class: 'row', style: { gap: '8px' } },
        h('button', {
          class: 'btn small ghost', type: 'button',
          'aria-label': `Rename bank ${s.name}`,
          onClick: () => renameBankModal({ bank: s, onDone: renderSets }),
        }, 'Rename'),
        h('button', {
          class: 'btn small ghost', type: 'button',
          'aria-label': `Remove bank ${s.name}`,
          onClick: () => confirmRemoveBank({ bank: s, onDone: renderSets }),
        }, 'Remove'))
      : h('span', { class: 'chip' }, 'built in');
    return h('div', { class: 'spread small', style: { padding: '6px 0', borderBottom: '1px solid var(--line)' } },
      h('span', null,
        h('b', null, s.label || s.name),
        ` · ${s.count} question${s.count === 1 ? '' : 's'}${units ? ` · ${units}` : ''}`),
      actions);
  }
  renderSets();

  // ---------- page ----------
  mount(root,
    h('div', { class: 'screen narrow' },
      h('div', { class: 'row', style: { marginBottom: '14px', justifyContent: 'space-between' } },
        h('div', { class: 'row' },
          h('button', { class: 'btn small ghost', onClick: () => go('#/teacher') }, '← Dashboard'),
          h('span', { class: 'chip topic' }, '📥 Upload questions')),
        h('button', {
          class: 'btn small ghost', type: 'button',
          onClick: async () => { await signOut(); go('#/teacher/login'); },
        }, 'Sign out')),

      h('div', { class: 'card' },
        h('h1', null, 'Import a question file'),
        h('p', { class: 'muted' },
          'Bring questions in as JSON. Nothing is saved until you see the preview and press Import - '
          + 'and the file is checked with the exact same rules as npm run validate.'),
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap', margin: '10px 0' } },
          h('button', {
            class: 'btn', type: 'button',
            onClick: () => downloadFile('template.json', JSON.stringify(TEMPLATE, null, 2) + '\n'),
          }, '⬇ Template JSON'),
          h('button', {
            class: 'btn', type: 'button',
            onClick: () => downloadFile('question-file-guide.txt', guideText(unitList), 'text/plain'),
          }, '⬇ Field guide')),
        h('div', { class: 'field' },
          h('label', { for: 'upload-file' }, 'Choose a .json file'),
          fileInput,
          h('span', { class: 'hint' },
            `Up to ${MAX_PER_UPLOAD} questions per file. An array of questions, or a { title, settings, units, questions } object - each file becomes its own question bank.`)),
        previewBox,
        resultBox),

      h('div', { class: 'card' },
        h('div', { class: 'spread' },
          h('h2', { style: { margin: 0 } }, 'Question banks'),
          h('span', { class: 'chip' }, 'yours only')),
        h('p', { class: 'muted small' },
          'Every uploaded file is its own bank with its own units - pick one when you build a quiz. Rename it or remove it here.'),
        uploadsBox),

      h('div', { class: 'row', style: { marginTop: '16px', justifyContent: 'center' } },
        h('button', { class: 'btn ghost', type: 'button', onClick: () => go('#/teacher') }, '← Back to the dashboard')))
  );
}
