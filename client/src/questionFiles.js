// The downloadable question template + field guide, shared by the Question
// Banks screen and the create-quiz wizard's Questions step.
import { h } from './ui.js';
import { UNITS, TYPE_LABELS } from '../../shared/units.js';

export const MAX_PER_UPLOAD = 200;

export const TEMPLATE = [
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

export function guideText(units = UNITS) {
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
  marks       OPTIONAL number that overrides the difficulty marks
              for this question (e.g. 2.5). Default: easy 1,
              medium 1.5, hard 2.
  boss        true or false (boss questions get +10s on the clock
              and the same marks as their difficulty)
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
  The upload preview uses the exact checks used by "npm run validate".
  Fix every numbered error, then import.
`;
}

export function downloadFile(name, text, type = 'application/json') {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: name });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export function downloadTemplate() {
  downloadFile('template.json', JSON.stringify(TEMPLATE, null, 2) + '\n');
}

export function downloadGuide(units) {
  downloadFile('question-file-guide.txt', guideText(units), 'text/plain');
}

/** One row with the two download buttons (template + guide). */
export function templateRow(units) {
  return h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
    h('button', { class: 'btn', type: 'button', onClick: () => downloadTemplate() }, '⬇ Template JSON'),
    h('button', {
      class: 'btn ghost', type: 'button',
      onClick: () => downloadGuide(units && units.length ? units : UNITS),
    }, '⬇ Download template guide'));
}

// re-exported so callers do not need two imports
export { UNITS, TYPE_LABELS };
