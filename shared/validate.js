// Question validation - the single source of truth used by:
//   npm run validate (questions/validate.mjs), the upload screen and the
//   server-side upload endpoint. Errors come back per question, numbered, so a
//   40-question file can be fixed line by line.
import { UNITS, QUESTION_TYPES, DIFFICULTIES } from './units.js';

/**
 * Validate one question.
 * @param {object} q
 * @param {Set<string>} [seenIds] ids already used earlier in the same batch
 * @param {{id:number}[]} [units] allowed units (teacher's list; defaults to the base seven)
 * @param {{fileUnits?:boolean}} [opts] fileUnits: the unit comes from an uploaded
 *   file - a name ("Loops") is fine and a missing unit falls back to
 *   "Uncategorized"; unknown numeric ids are still refused
 * @returns {string[]} empty array = the question is fine
 */
export function questionErrors(q, seenIds = new Set(), units = UNITS, opts = {}) {
  const errs = [];
  const add = (msg) => errs.push(msg);
  const isBlanket = q.type === 'fill-blank';
  const isMatch = q.type === 'match';

  if (!q || typeof q !== 'object') return ['question must be an object'];
  if (!q.id) { add('every question needs an id'); return errs; }
  if (seenIds.has(q.id)) add('duplicate id');
  seenIds.add(q.id);

  // optional per-question unit name (bank-owned naming for numeric units)
  if (q.unitName !== undefined && q.unitName !== null && q.unitName !== '') {
    const n = typeof q.unitName === 'string' ? q.unitName.trim() : null;
    if (n === null || !n) add('unit name is empty');
    else if (n.length > 60) add('unit name too long (60 characters max)');
  }

  if (opts.fileUnits) {
    const raw = q.unit;
    if (raw !== undefined && raw !== null && raw !== '') {
      if (typeof raw === 'string') {
        const t = raw.trim();
        if (!t) add('unit name is empty');
        else if (t.length > 60) add('unit name too long (60 characters max)');
        else if (/^\d+$/.test(t) && !units.some((allowed) => allowed.id === Number(t))) add(`unknown unit ${t}`);
      } else if (typeof raw === 'number' && Number.isFinite(raw)) {
        if (!units.some((allowed) => allowed.id === raw)) add(`unknown unit ${raw}`);
      } else {
        add(`unknown unit ${raw}`);
      }
    }
    // no unit at all is fine: the file's questions land in "Uncategorized"
  } else if (!units.some((u) => u.id === q.unit)) add(`unknown unit ${q.unit}`);
  if (!QUESTION_TYPES.includes(q.type)) add(`unknown type ${q.type}`);
  if (!DIFFICULTIES.includes(q.difficulty)) add(`unknown difficulty ${q.difficulty}`);
  if (typeof q.boss !== 'boolean') add('boss must be boolean');
  if (!q.prompt || q.prompt.length < 5) add('prompt too short');
  if (q.timeLimit !== undefined && q.timeLimit !== null && q.timeLimit !== '') {
    const t = Number(q.timeLimit);
    if (!Number.isFinite(t) || t < 5 || t > 300) add('timeLimit must be 5-300 seconds');
  }
  if (!q.explanation || q.explanation.length < 20) add('explanation missing/too short');
  if (!q.analogy || q.analogy.length < 15) add('analogy missing/too short');
  if (!q.hint || q.hint.length < 8) add('hint missing/too short');
  if (!Array.isArray(q.tags) || q.tags.length < 1) add('tags required');

  if (isBlanket) {
    if (!Array.isArray(q.accepted) || q.accepted.length < 1) add('fill-blank needs accepted[]');
    if (!q.blank) add('fill-blank needs "blank" (the sentence with ___)');
  } else if (isMatch) {
    if (!Array.isArray(q.pairs) || q.pairs.length < 2) add('match needs pairs[] (>=2)');
    else {
      q.pairs.forEach((p, i) => {
        if (!p || !p.left || !p.right) add(`pair ${i} needs left and right`);
      });
      const rights = new Set(q.pairs.map((p) => p && p.right));
      if (rights.size !== q.pairs.length) add('match right-hand values must be unique');
    }
  } else if (QUESTION_TYPES.includes(q.type)) {
    if (!Array.isArray(q.options) || q.options.length !== 4) add('needs exactly 4 options');
    else {
      const oids = new Set(q.options.map((o) => o && o.id));
      if (oids.size !== 4) add('option ids must be unique (a,b,c,d)');
      for (const o of q.options) if (!o || !o.text) add(`option ${o && o.id} empty`);
      if (!Array.isArray(q.answer) || q.answer.length < 1) add('answer[] required');
      else for (const a of q.answer) if (!oids.has(a)) add(`answer ${a} not in options`);
    }
    if ((q.type === 'code-output' || q.type === 'spot-error') && (!q.code || q.code.length < 3)) {
      add(`${q.type} needs a code snippet`);
    }
  }

  const m = q.mini;
  if (!m) add('mini (try again) question missing');
  else {
    if (!m.prompt || m.prompt.length < 5) add('mini.prompt too short');
    if (!m.explanation || m.explanation.length < 10) add('mini.explanation missing');
    if (m.type === 'fill-blank') {
      if (!Array.isArray(m.accepted) || !m.accepted.length) add('mini fill-blank needs accepted[]');
    } else if (!Array.isArray(m.options) || m.options.length < 2) add('mini needs >=2 options');
    else if (!m.options.some((o) => o.id === m.answer)) add('mini.answer not in mini.options');
  }

  return errs;
}

/**
 * Validate a whole list of questions.
 * @param {object[]} questions
 * @param {object} [opts]
 * @param {boolean} [opts.coverage] also run the "every unit needs variety" checks
 * @param {{id:number,name:string}[]} [opts.units] allowed units (teacher's list)
 * @param {boolean} [opts.fileUnits] uploaded-file mode: named/missing units allowed
 * @returns {{
 *   ok: boolean, count: number, perUnit: object,
 *   errors: {index:number,id:string,messages:string[]}[],
 *   flat: string[], warnings: string[]
 * }}
 */
export function validateQuestions(questions, { coverage = false, units = UNITS, fileUnits = false } = {}) {
  const list = Array.isArray(questions) ? questions : [];
  const seen = new Set();
  const errors = [];
  const flat = [];
  const warnings = [];
  const perUnit = {};
  const perUnitType = {};

  list.forEach((q, index) => {
    const id = q && q.id ? q.id : null;
    const messages = questionErrors(q, seen, units, { fileUnits });
    if (messages.length) {
      errors.push({ index, id, messages });
      for (const msg of messages) flat.push(`${id || '(missing id)'}: ${msg}`);
    }
    if (q && q.unit) {
      perUnit[q.unit] = (perUnit[q.unit] || 0) + 1;
      const k = `${q.unit}:${q.type}`;
      perUnitType[k] = (perUnitType[k] || 0) + 1;
    }
  });

  if (coverage) {
    for (const u of units) {
      const n = perUnit[u.id] || 0;
      if (n < 10) warnings.push(`unit ${u.id} (${u.name}) has ${n} questions, want >= 10`);
      if (!perUnitType[`${u.id}:code-output`]) warnings.push(`unit ${u.id} has no code-output questions`);
      if (!perUnitType[`${u.id}:fill-blank`]) warnings.push(`unit ${u.id} has no fill-blank questions`);
      if (!perUnitType[`${u.id}:spot-error`]) warnings.push(`unit ${u.id} has no spot-error questions`);
      if (!perUnitType[`${u.id}:match`]) warnings.push(`unit ${u.id} has no match questions`);
    }
  }

  return { ok: errors.length === 0, count: list.length, perUnit, errors, flat, warnings };
}
