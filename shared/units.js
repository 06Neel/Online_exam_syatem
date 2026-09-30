// The seven syllabus units plus question type / difficulty vocabularies.
// One source of truth for server, client screens, validators and reports.
export const UNITS = [
  { id: 1, name: 'Environment Setup' },
  { id: 2, name: 'Variables, Expressions & Statements' },
  { id: 3, name: 'Conditional Statements' },
  { id: 4, name: 'Iterative Statements' },
  { id: 5, name: 'Strings' },
  { id: 6, name: 'Lists' },
  { id: 7, name: 'Tuples & Dictionaries' },
];

export const UNIT_IDS = UNITS.map((u) => u.id);

export function unitName(id) {
  return UNITS.find((u) => u.id === Number(id))?.name || `Unit ${id}`;
}

/** Display name of the built-in question set (the shipped bank). */
export const DEFAULT_SET_NAME = 'Default question bank';

/** Fallback label for questions that carry no unit/topic of their own. */
export const UNCATEGORIZED = 'Uncategorized';

/**
 * Normalize one raw `unit` value from an uploaded file into a grouping key,
 * its display name and (when the file used a numeric id) that id.
 * Names resolve per bank, never from the teacher's shared unit list:
 *   the question's own `unitName` > the file's unit-name map > `Unit <n>`.
 * Numbers keep their id so the file can occupy the teacher's own units;
 * names and missing values get a set-local id (100+) instead.
 * @param {*} raw
 * @param {*} [unitName] this question's own display name for a numeric unit
 * @param {Record<number,string>} [fileNames] the file's unit-id -> name map
 * @returns {{key:string,name:string,id:number|null}}
 */
export function fileUnitName(raw, unitName = null, fileNames = {}) {
  const own = typeof unitName === 'string' && unitName.trim() ? unitName.trim().slice(0, 60) : null;
  const fromFile = (n) => {
    const v = fileNames && fileNames[n];
    return typeof v === 'string' && v.trim() ? v.trim().slice(0, 60) : null;
  };
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    const name = own || fromFile(raw) || `Unit ${raw}`;
    return { key: name.toLowerCase(), name, id: raw };
  }
  if (typeof raw === 'string' && raw.trim()) {
    const t = raw.trim();
    if (/^\d+$/.test(t)) {
      const n = Number(t);
      const name = own || fromFile(n) || `Unit ${t}`;
      return { key: name.toLowerCase(), name, id: n };
    }
    return { key: t.toLowerCase(), name: t, id: null };
  }
  if (own) return { key: own.toLowerCase(), name: own, id: null };
  return { key: UNCATEGORIZED.toLowerCase(), name: UNCATEGORIZED, id: null };
}

/**
 * Derive a question bank's unit list from the questions in its file.
 * Numeric ids are kept; named/missing units are grouped
 * case-insensitively and get fresh ids starting at 100, so they never
 * collide with the syllabus units 1-7 or a teacher's custom units 8-99.
 * Names come from each question (unitName) or the file's own map -
 * never from another bank or the shared teacher list.
 * @param {object[]} questions
 * @param {Record<number,string>} [fileNames] the file's unit-id -> name map
 * @returns {{ units: {id:number,name:string}[], assignments: number[] }}
 */
export function fileUnitList(questions, fileNames = {}) {
  const units = [];
  const byKey = new Map();
  const byId = new Map();
  const assignments = [];
  let nextId = 100;
  const put = (key, name, preferredId) => {
    let unit = byKey.get(key);
    if (!unit) {
      let id = null;
      if (Number.isInteger(preferredId) && !byId.has(preferredId)) id = preferredId;
      else {
        while (byId.has(nextId)) nextId++;
        id = nextId++;
      }
      unit = { id, name };
      byKey.set(key, unit);
      byId.set(id, unit);
      units.push(unit);
    }
    return unit.id;
  };
  for (const raw of Array.isArray(questions) ? questions : []) {
    const u = raw && typeof raw === 'object' ? raw.unit : undefined;
    const own = raw && typeof raw === 'object' ? raw.unitName : undefined;
    const { key, name, id } = fileUnitName(u, own, fileNames);
    assignments.push(put(key, name, id));
  }
  return { units, assignments };
}

export const QUESTION_TYPES = ['mcq', 'code-output', 'spot-error', 'fill-blank', 'match'];

export const TYPE_LABELS = {
  mcq: 'Pick one',
  'code-output': 'What runs?',
  'spot-error': 'Bug hunt',
  'fill-blank': 'Fill the blank',
  match: 'Match up',
};

export const TYPE_LABEL = (type) => TYPE_LABELS[type] || type;

export const DIFFICULTIES = ['easy', 'medium', 'hard'];

export const DIFFICULTY_LABELS = { easy: 'Easy', medium: 'Medium', hard: 'Hard' };
