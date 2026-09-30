// Renders one question (all types) and collects the player's answer.
import { h, esc } from '../ui.js';

export function renderQuestion(q, { onDirty } = {}) {
  const state = { locked: false, selected: [], text: '', match: {} };
  const multi = Array.isArray(q.answer) && q.answer.length > 1;

  const wrap = h('div', { class: 'q-render' });

  if (q.code) {
    wrap.appendChild(h('div', { class: 'code-block' },
      h('span', { class: 'lang' }, q.type === 'spot-error' ? 'spot the bug' : 'python'),
      h('pre', { class: 'code' }, q.code)
    ));
  }

  if (q.type === 'fill-blank') {
    const input = h('input', {
      type: 'text',
      placeholder: 'Type your answer…',
      'aria-label': 'Your answer',
      autocomplete: 'off',
      autocapitalize: 'off',
      spellcheck: 'false',
      onInput: (e) => { state.text = e.target.value; onDirty?.(); },
      onKeydown: (e) => { if (e.key === 'Enter') e.preventDefault(); },
    });
    wrap.appendChild(h('div', { class: 'card tight', style: { marginTop: '10px' } },
      h('div', { class: 'muted small', style: { marginBottom: '6px' } }, 'Fill in the blank:'),
      h('p', { class: 'prompt mono', html: highlightBlank(q.blank || q.prompt) }),
      input
    ));
    state.focus = () => input.focus();
    state.element = wrap;
    state.getAnswer = () => state.text.trim();
    state.isEmpty = () => !state.text.trim();
    state.lock = () => { state.locked = true; input.disabled = true; };
    return state;
  }

  if (q.type === 'match') {
    const rights = (q.pairs || []).map((p) => p.right);
    const shuffledRights = [...rights].sort(() => Math.random() - 0.5);
    const rows = (q.pairs || []).map((p, i) => {
      const sel = h('select', {
        'aria-label': `Match for ${p.left}`,
        onChange: (e) => { state.match[i] = e.target.value; onDirty?.(); },
      }, h('option', { value: '' }, 'Choose…'),
        shuffledRights.map((r) => h('option', { value: r }, r)));
      state.match[i] = '';
      return h('div', { class: 'match-row' },
        h('span', { class: 'left' }, p.left),
        sel);
    });
    wrap.appendChild(h('div', { class: 'match-list', style: { marginTop: '12px' } }, rows));
    state.element = wrap;
    state.getAnswer = () => ({ ...state.match });
    state.isEmpty = () => Object.values(state.match).every((v) => !v);
    state.lock = () => {
      state.locked = true;
      wrap.querySelectorAll('select').forEach((s) => { s.disabled = true; });
    };
    return state;
  }

  // option-based questions (mcq / code-output / spot-error)
  const keys = ['A', 'B', 'C', 'D'];
  const buttons = (q.options || []).map((opt, i) => {
    const btn = h('button', {
      class: 'option',
      type: 'button',
      dataset: { id: opt.id },
      onClick: () => {
        if (state.locked) return;
        if (multi) {
          const at = state.selected.indexOf(opt.id);
          if (at >= 0) state.selected.splice(at, 1);
          else state.selected.push(opt.id);
        } else {
          state.selected = [opt.id];
        }
        buttons.forEach((b) => b.classList.toggle('selected', state.selected.includes(b.dataset.id)));
        onDirty?.();
      },
    },
      h('span', { class: 'key' }, keys[i]),
      h('span', { class: 'txt' }, opt.text)
    );
    return btn;
  });

  wrap.appendChild(h('div', { class: 'options', role: 'group', 'aria-label': 'Answer options' }, buttons));
  if (multi) wrap.appendChild(h('p', { class: 'muted small', style: { marginTop: '8px' } }, 'Choose all that apply.'));

  state.element = wrap;
  state.buttons = buttons;
  state.getAnswer = () => (multi ? [...state.selected] : state.selected[0] ?? null);
  state.isEmpty = () => state.selected.length === 0;
  state.lock = () => { state.locked = true; buttons.forEach((b) => { b.disabled = true; }); };
  state.setRemoved = (ids = []) => {
    for (const b of buttons) if (ids.includes(b.dataset.id)) b.classList.add('removed');
  };
  state.markResult = (given, correctAnswer) => {
    const givenIds = Array.isArray(given) ? given : [given].filter(Boolean);
    const correctIds = Array.isArray(correctAnswer) ? correctAnswer : [correctAnswer].filter(Boolean);
    for (const b of buttons) {
      const id = b.dataset.id;
      if (correctIds.includes(id)) { b.classList.add('correct'); b.classList.remove('selected'); }
      else if (givenIds.includes(id)) { b.classList.add('wrong'); b.classList.remove('selected'); }
      b.disabled = true;
    }
  };
  state.focus = () => buttons[0]?.focus();
  return state;
}

function highlightBlank(text) {
  return esc(text).replace(/_{3,}/g, '<span style="color:var(--brand);font-weight:800">________</span>');
}

/** Shows the correct answer on the option list / match list after reveal. */
export function markAnswer(view, q, given, correct) {
  if (q.type === 'fill-blank') return;
  if (q.type === 'match') return;
  view.markResult?.(given, q.answer);
}
