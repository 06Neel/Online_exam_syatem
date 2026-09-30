// Shared question-bank dialogs: rename (bank + its units), duplicate, remove.
// Used by the upload screen and the question editor so every bank-management
// action looks and behaves the same wherever you are.
import { h, toast, modal } from './ui.js';
import { request } from './net.js';
import { authToken } from './auth.js';

const bankId = (bank) => String(bank && (bank.id || bank.file) || '');

/** One-line summary: `Question Bank: <name> | <N> questions | Units: <list>`. */
export function bankLine(bank) {
  if (!bank) return '';
  const names = (bank.units || []).map((u) => u.name).join(', ');
  return `Question Bank: ${bank.name || bank.label || ''} | ${bank.count} questions`
    + (names ? ` | Units: ${names}` : '');
}

export function renameBankModal({ bank, onDone }) {
  const id = bankId(bank);
  const nameInput = h('input', { type: 'text', value: bank.name || '', maxlength: '60', 'aria-label': 'Bank name' });
  const unitInputs = (bank.units || []).filter((u) => u.id !== undefined && u.id !== null).map((u) => ({
    id: u.id,
    input: h('input', { type: 'text', value: u.name, maxlength: '40', 'aria-label': `Unit name for ${u.name}` }),
  }));
  const dlg = modal({
    title: 'Rename this question bank',
    body: h('div', { class: 'col', style: { gap: '8px' } },
      h('label', { class: 'col', style: { gap: '4px' } },
        h('span', { class: 'small', style: { fontWeight: 700 } }, 'Bank name'), nameInput),
      unitInputs.length
        ? h('div', { class: 'col', style: { gap: '6px' } },
          h('span', { class: 'small', style: { fontWeight: 700 } }, 'Unit names in this bank'),
          ...unitInputs.map((u) => h('label', { class: 'col', style: { gap: '4px' } }, u.input)))
        : null),
    actions: [
      { label: 'Cancel' },
      {
        label: 'Save', kind: 'primary', close: false,
        onClick: async () => {
          try {
            await request(`/api/sets/${encodeURIComponent(id)}`, {
              method: 'PUT',
              token: authToken(),
              body: {
                name: nameInput.value,
                units: unitInputs.map((u) => ({ id: u.id, name: u.input.value })),
              },
            });
            toast('Question bank renamed.', 'good');
            dlg.close();
            if (onDone) onDone();
          } catch (e) {
            toast(e.message || 'Could not rename that question bank.', 'bad');
          }
        },
      },
    ],
  });
}

export function confirmRemoveBank({ bank, onDone }) {
  const id = bankId(bank);
  modal({
    title: 'Remove this question bank?',
    body: h('div', null,
      h('p', null, `“${bank.name || bank.file || ''}” and its ${bank.count || 0} question${bank.count === 1 ? '' : 's'} leave your bank.`),
      h('p', { class: 'muted small' }, 'Questions you edited by hand are kept - only the file goes.')),
    actions: [
      { label: 'Keep it' },
      {
        label: 'Remove bank', kind: 'primary',
        onClick: async () => {
          try {
            await request(`/api/sets/${encodeURIComponent(id)}`, { method: 'DELETE', token: authToken() });
            toast('Question bank removed.', 'good');
            if (onDone) onDone();
          } catch (e) {
            toast(e.message || 'Could not remove that question bank.', 'bad');
          }
        },
      },
    ],
  });
}

/** Returns {ok, set} (or null on cancel/failure) so callers can switch to the copy. */
export async function duplicateBank(bank) {
  try {
    const res = await request(`/api/sets/${encodeURIComponent(bankId(bank))}/duplicate`, {
      method: 'POST',
      token: authToken(),
    });
    if (!res || !res.ok) throw new Error((res && res.error) || 'Could not duplicate that bank.');
    toast(`Duplicated as “${res.set?.name || 'copy'}”.`, 'good');
    return res;
  } catch (e) {
    toast(e.message || 'Could not duplicate that question bank.', 'bad');
    return null;
  }
}
