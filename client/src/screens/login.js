// Sign-in screen - reached at #/teacher/login (not linked from public pages:
// the home page keeps its own "Teacher?" card that lands here too).
// First sign-in with a temporary password switches to "choose a new password".
import { h, mount, toast, themeSwitch } from '../ui.js';
import { store } from '../state.js';
import { go } from '../main.js';
import { signIn, changeMyPassword, signOut, needsPasswordChange } from '../auth.js';

export const title = 'Sign in';

export function render(root) {
  let mode = needsPasswordChange() ? 'change' : 'signin';
  const box = h('div', { class: 'card' });

  const errorLine = h('p', {
    role: 'alert',
    style: { color: 'var(--bad)', minHeight: '1.2em', margin: '0 0 10px', fontWeight: 600 },
  });

  function showError(msg) {
    errorLine.textContent = msg || '';
  }

  function draw() {
    box.textContent = '';
    errorLine.textContent = '';
    box.append(mode === 'change' ? changeForm() : signInForm());
    setTimeout(() => box.querySelector('input')?.focus(), 30);
  }

  function signInForm() {
    const idInput = h('input', { id: 'login-id', type: 'text', autocomplete: 'username', required: true, placeholder: 'e.g. ms-patel' });
    const pwInput = h('input', { id: 'login-pw', type: 'password', autocomplete: 'current-password', required: true });
    const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'Sign in');

    const form = h('form', {
      onSubmit: async (e) => {
        e.preventDefault();
        showError('');
        submit.disabled = true;
        submit.textContent = 'Signing in…';
        try {
          const res = await signIn(idInput.value.trim(), pwInput.value);
          if (res.mustChangePassword) {
            mode = 'change';
            draw();
            return;
          }
          afterSignIn(res);
        } catch (err) {
          showError(err.message || 'Sign-in failed. Please try again.');
          submit.disabled = false;
          submit.textContent = 'Sign in';
          pwInput.select();
        }
      },
    },
    h('div', { class: 'field' },
      h('label', { for: 'login-id' }, 'Teacher ID'),
      idInput,
      h('span', { class: 'hint' }, 'The ID your administrator gave you.')),
    h('div', { class: 'field' },
      h('label', { for: 'login-pw' }, 'Password'),
      pwInput),
    submit);

    return h('div', null,
      h('h1', null, 'Teacher sign in'),
      h('p', { class: 'muted' }, 'Sign in to build quizzes, run them live and see how the class did.'),
      errorLine,
      form);
  }

  function changeForm() {
    const next = h('input', { id: 'pw-next', type: 'password', autocomplete: 'new-password', required: true });
    const again = h('input', { id: 'pw-again', type: 'password', autocomplete: 'new-password', required: true });
    const submit = h('button', { class: 'btn primary block', type: 'submit' }, 'Save password and continue');

    const form = h('form', {
      onSubmit: async (e) => {
        e.preventDefault();
        showError('');
        if (next.value.length < 8) { showError('Choose a password with at least 8 characters.'); next.focus(); return; }
        if (next.value !== again.value) { showError('Both passwords need to match.'); again.focus(); return; }
        submit.disabled = true;
        submit.textContent = 'Saving…';
        try {
          const res = await changeMyPassword('', next.value);
          void res;
          toast('Password saved - you are all set.', '', 2400);
          afterSignIn({ role: store.auth?.role || 'teacher' });
        } catch (err) {
          showError(err.message || 'Could not save the password.');
          submit.disabled = false;
          submit.textContent = 'Save password and continue';
        }
      },
    },
    h('div', { class: 'field' },
      h('label', { for: 'pw-next' }, 'New password'),
      next,
      h('span', { class: 'hint' }, 'At least 8 characters. You will use this from now on.')),
    h('div', { class: 'field' },
      h('label', { for: 'pw-again' }, 'Type it again'),
      again),
    submit);

    return h('div', null,
      h('h1', null, 'Choose your password'),
      h('p', { class: 'muted' },
        `Welcome${store.auth?.name ? `, ${store.auth.name}` : ''}. Your administrator set a temporary password - pick your own to continue.`),
      errorLine,
      form,
      h('div', { style: { marginTop: '14px' } },
        h('button', {
          class: 'btn ghost block', type: 'button',
          onClick: async () => { await signOut({ quiet: true }); mode = 'signin'; draw(); },
        }, 'Use a different account')));
  }

  function afterSignIn(res) {
    if (res?.role === 'admin') go('#/admin');
    else go('#/teacher');
  }

  draw();

  mount(root,
    h('div', { class: 'screen narrow' },
      h('div', { class: 'row', style: { marginBottom: '14px', justifyContent: 'space-between' } },
        h('button', { class: 'btn small ghost', onClick: () => go('#/') }, '← Home'),
        themeSwitch('Light mode')),
      box,
      h('p', { class: 'muted small', style: { textAlign: 'center' } },
        'Not a teacher? Students join with a game code from the home page.')));
}
