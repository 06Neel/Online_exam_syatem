// Admin panel (#/admin): teacher accounts, overview, running sessions.
// Only admins get here - the server answers 404 for everyone else.
import { h, mount, toast, modal } from '../ui.js';
import { store } from '../state.js';
import { go } from '../main.js';
import { signOut, authToken } from '../auth.js';
import { request } from '../net.js';

export const title = 'Administration';

const fmtTime = (ts) => (ts ? new Date(ts).toLocaleString() : 'never');

export function render(root) {
  const overviewBox = h('div', { class: 'empty' }, 'Loading…');
  const teachersBox = h('div', { class: 'empty' }, 'Loading teachers…');
  const sessionsBox = h('div', { class: 'empty' }, 'Loading sessions…');

  // ---------- helpers ----------
  const api = (url, options = {}) => request(url, { token: authToken(), ...options });

  async function copyText(text, label) {
    try {
      await navigator.clipboard.writeText(text);
      toast(`${label} copied.`, '', 1800);
    } catch {
      toast('Could not copy - select the text and copy it manually.', 'bad', 2600);
    }
  }

  function showPassword(heading, password, note) {
    const value = h('div', {
      class: 'mono',
      style: {
        fontSize: '1.2rem', fontWeight: 800, letterSpacing: '.06em', padding: '12px 14px',
        background: 'var(--bg-2)', border: '1px solid var(--line)', borderRadius: '12px', wordBreak: 'break-all',
      },
    }, password);
    modal({
      title: heading,
      body: h('div', null,
        h('p', { class: 'muted' }, note),
        value,
        h('p', { class: 'muted small', style: { marginTop: '10px', marginBottom: 0 } },
          'Give it to the teacher over a private channel. It stops working as soon as they choose their own password.')),
      actions: [
        { label: 'Copy', onClick: () => copyText(password, 'Password'), close: false },
        { label: 'Done', kind: 'primary' },
      ],
    });
  }

  function confirm({ title: head, body, confirmLabel, kind = 'bad', onConfirm }) {
    modal({
      title: head,
      body: h('p', { class: 'muted', style: { marginBottom: 0 } }, body),
      actions: [
        { label: 'Cancel' },
        { label: confirmLabel, kind, onClick: onConfirm },
      ],
    });
  }

  // ---------- overview ----------
  async function loadOverview() {
    try {
      const data = await api('/api/admin/overview');
      overviewBox.textContent = '';
      overviewBox.className = 'grid cols-4';
      overviewBox.append(
        tile('Teacher accounts', `${data.activeTeachers}/${data.teachers}`, data.suspendedTeachers ? `${data.suspendedTeachers} suspended` : 'all active'),
        tile('Live sessions', String(data.liveSessions), data.liveSessions ? 'running now' : 'quiet'),
        tile('Questions in bank', String(data.questions), 'shipped with the app'),
        tile('Admin user', data.adminUser, 'password lives in .env'));
    } catch (e) {
      overviewBox.className = 'empty';
      overviewBox.textContent = e.message || 'Could not load the overview.';
    }
  }

  function tile(k, v, sub = '') {
    return h('div', { class: 'stat' },
      h('div', { class: 'k' }, k),
      h('div', { class: 'v', style: { fontSize: '1.4rem' } }, v),
      sub ? h('div', { class: 'muted small' }, sub) : null);
  }

  // ---------- teachers ----------
  async function loadTeachers() {
    teachersBox.textContent = '';
    teachersBox.className = 'empty';
    teachersBox.textContent = 'Loading teachers…';
    try {
      const list = await api('/api/admin/teachers');
      teachersBox.textContent = '';
      teachersBox.className = '';
      if (!list?.length) {
        teachersBox.append(h('div', { class: 'empty' }, 'No teachers yet - add the first one.'));
        return;
      }
      list.forEach((t) => teachersBox.append(teacherRow(t)));
    } catch (e) {
      teachersBox.className = 'empty';
      teachersBox.textContent = e.message || 'Could not load teachers.';
    }
  }

  function teacherRow(t) {
    const active = t.active !== false;
    const actions = h('div', { class: 'row', style: { gap: '6px', flexWrap: 'wrap', justifyContent: 'flex-end' } },
      h('button', { class: 'btn small ghost', type: 'button', onClick: () => editTeacher(t) }, 'Edit'),
      h('button', { class: 'btn small ghost', type: 'button', onClick: () => resetPassword(t) }, 'Reset password'),
      h('button', {
        class: 'btn small ghost', type: 'button',
        onClick: () => confirm({
          title: active ? `Suspend ${t.name}?` : `Reactivate ${t.name}?`,
          body: active
            ? `${t.id} will not be able to sign in. Their questions and sessions stay exactly as they are.`
            : `${t.id} will be able to sign in again with their current password.`,
          confirmLabel: active ? 'Suspend' : 'Reactivate',
          kind: active ? 'bad' : 'primary',
          onConfirm: () => setStatus(t, !active),
        }),
      }, active ? 'Suspend' : 'Activate'),
      h('button', { class: 'btn small ghost', type: 'button', onClick: () => deleteTeacher(t) }, 'Delete'));

    return h('div', { class: 'card tight', style: { marginTop: '10px' } },
      h('div', { class: 'spread', style: { flexWrap: 'wrap', gap: '10px' } },
        h('div', null,
          h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
            h('span', { class: 'mono', style: { fontWeight: 800 } }, t.id),
            h('span', { class: `chip ${active ? '' : 'bad'}` }, active ? 'Active' : 'Suspended'),
            t.mustChangePassword ? h('span', { class: 'chip topic' }, 'must change password') : null,
            t.department ? h('span', { class: 'chip' }, t.department) : null),
          h('div', { class: 'muted small' },
            `${t.name || t.id}${t.email ? ` · ${t.email}` : ''} · last sign-in ${fmtTime(t.lastLogin)}`)),
        actions));
  }

  function editTeacher(t) {
    const name = h('input', { type: 'text', value: t.name || '', required: true });
    const email = h('input', { type: 'email', value: t.email || '' });
    const dept = h('input', { type: 'text', value: t.department || '' });
    const err = h('p', { role: 'alert', style: { color: 'var(--bad)', minHeight: '1.2em', margin: '0 0 8px', fontWeight: 600 } });

    const back = modal({
      title: `Edit ${t.id}`,
      body: h('div', null,
        err,
        field('Name', name),
        field('Email', email),
        field('Department / class', dept)),
      actions: [{ label: 'Cancel' }],
    });

    const saveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Save changes');
    back.box.querySelector('.row')?.prepend(saveBtn);
    saveBtn.addEventListener('click', async () => {
      err.textContent = '';
      if (!name.value.trim()) { err.textContent = 'A name is required.'; return; }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Saving…';
      try {
        await api(`/api/admin/teachers/${encodeURIComponent(t.id)}`, {
          method: 'PATCH', body: { name: name.value, email: email.value, department: dept.value },
        });
        back.close();
        toast('Teacher updated.', '', 2000);
        loadTeachers();
      } catch (e) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save changes';
        err.textContent = e.message || 'Could not save.';
      }
    });
    setTimeout(() => name.focus(), 40);
  }

  async function resetPassword(t) {
    confirm({
      title: `Reset the password for ${t.id}?`,
      body: 'A fresh one-time password will be created. The old one stops working immediately and the teacher must choose a new one at next sign-in.',
      confirmLabel: 'Create new password',
      kind: 'primary',
      onConfirm: async () => {
        try {
          const res = await api(`/api/admin/teachers/${encodeURIComponent(t.id)}/password`, { method: 'POST', body: {} });
          if (res.password) showPassword(`New password for ${t.id}`, res.password, 'Share it privately, then let them sign in.');
          loadTeachers();
        } catch (e) {
          toast(e.message || 'Could not reset the password.', 'bad');
        }
      },
    });
  }

  async function setStatus(t, active) {
    try {
      await api(`/api/admin/teachers/${encodeURIComponent(t.id)}/status`, { method: 'POST', body: { active } });
      toast(active ? `${t.id} can sign in again.` : `${t.id} is suspended.`, '', 2200);
      loadTeachers();
      loadOverview();
    } catch (e) {
      toast(e.message || 'Could not change the status.', 'bad');
    }
  }

  function deleteTeacher(t) {
    confirm({
      title: `Delete ${t.id}?`,
      body: `The account is removed and ${t.name || t.id}'s folder moves to server/data/trash (recoverable by hand). Questions saved in the shared bank are not deleted.`,
      confirmLabel: 'Delete teacher',
      onConfirm: async () => {
        try {
          await api(`/api/admin/teachers/${encodeURIComponent(t.id)}`, { method: 'DELETE' });
          toast(`${t.id} deleted - the folder is in the trash.`, '', 3000);
          loadTeachers();
          loadOverview();
        } catch (e) {
          toast(e.message || 'Could not delete the teacher.', 'bad');
        }
      },
    });
  }

  async function addTeacher() {
    const id = h('input', { type: 'text', placeholder: 'e.g. ms-patel', autocomplete: 'off', required: true });
    const name = h('input', { type: 'text', placeholder: 'e.g. Priya Patel', autocomplete: 'off', required: true });
    const email = h('input', { type: 'email', placeholder: 'optional', autocomplete: 'off' });
    const dept = h('input', { type: 'text', placeholder: 'e.g. Grade 8', autocomplete: 'off' });
    const pass = h('input', { type: 'text', placeholder: 'leave empty to generate one', autocomplete: 'off' });
    const err = h('p', { role: 'alert', style: { color: 'var(--bad)', minHeight: '1.2em', margin: '0 0 8px', fontWeight: 600 } });

    const back = modal({
      title: 'Add a teacher',
      body: h('div', null,
        err,
        field('Teacher ID (they type this to sign in)', id),
        field('Name', name),
        field('Email', email),
        field('Department / class', dept),
        field('Temporary password (optional)', pass, 'At least 8 characters, or leave it empty and we generate one.')),
      actions: [{ label: 'Cancel' }],
    });

    const box = back.box;
    const saveBtn = h('button', { class: 'btn primary', type: 'button' }, 'Create teacher');
    box.querySelector('.row')?.prepend(saveBtn);
    saveBtn.addEventListener('click', async () => {
      err.textContent = '';
      const value = { id: id.value.trim(), name: name.value.trim(), email: email.value.trim(), department: dept.value.trim() };
      if (!value.id || !value.name) { err.textContent = 'ID and name are both needed.'; return; }
      if (pass.value && pass.value.length < 8) { err.textContent = 'A password you type needs at least 8 characters.'; return; }
      saveBtn.disabled = true;
      saveBtn.textContent = 'Creating…';
      try {
        const res = await api('/api/admin/teachers', {
          method: 'POST',
          body: { ...value, tempPassword: pass.value || undefined },
        });
        back.close();
        loadTeachers();
        loadOverview();
        if (res.password) showPassword(`${value.id} can sign in with`, res.password, 'This is the only time it is shown.');
        else toast(`${value.id} created.`, '', 2200);
      } catch (e) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Create teacher';
        err.textContent = e.message || 'Could not create the teacher.';
      }
    });
    setTimeout(() => id.focus(), 40);
  }

  function field(labelText, input, hint) {
    const id = `f-${Math.random().toString(36).slice(2, 8)}`;
    input.id = id;
    return h('div', { class: 'field' },
      h('label', { for: id }, labelText),
      input,
      hint ? h('span', { class: 'hint' }, hint) : null);
  }

  // ---------- sessions ----------
  async function loadSessions() {
    try {
      const list = await api('/api/admin/sessions');
      sessionsBox.textContent = '';
      if (!list?.length) {
        sessionsBox.append(h('div', { class: 'empty' }, 'No sessions running right now.'));
        return;
      }
      list.forEach((s) => sessionsBox.append(h('div', { class: 'card tight', style: { marginTop: '10px' } },
        h('div', { class: 'spread', style: { flexWrap: 'wrap', gap: '10px' } },
          h('div', null,
            h('div', { class: 'row', style: { gap: '8px' } },
              h('span', { class: 'mono', style: { fontWeight: 900, letterSpacing: '.2em' } }, s.code),
              h('span', { class: 'chip' }, s.status),
              h('span', { class: 'chip topic' }, `${s.players} players`)),
            h('div', { class: 'muted small' }, `${s.title || 'Python Adventure'}${s.ownerName ? ` · ${s.ownerName}` : ''}`)),
          h('button', {
            class: 'btn small ghost', type: 'button',
            onClick: () => go(`#/teacher/live?code=${s.code}`),
          }, 'Open')))));
    } catch (e) {
      sessionsBox.className = 'empty';
      sessionsBox.textContent = e.message || 'Could not load sessions.';
    }
  }

  // ---------- page ----------
  mount(root,
    h('div', { class: 'screen narrow' },
      h('div', { class: 'row', style: { marginBottom: '14px', justifyContent: 'space-between' } },
        h('div', { class: 'row' },
          h('button', { class: 'btn small ghost', onClick: () => go('#/') }, '← Home'),
          h('span', { class: 'chip topic' }, '⚙️ Administration')),
        h('button', {
          class: 'btn small ghost', type: 'button',
          onClick: async () => { await signOut(); go('#/teacher/login'); },
        }, 'Sign out')),

      h('div', { class: 'card' },
        h('h1', null, 'Admin panel'),
        h('p', { class: 'muted' },
          `Signed in as ${store.auth?.name || 'Administrator'}. Teacher accounts, passwords and a view of what is running - nothing else lives here.`),
        h('h2', null, 'Overview'),
        overviewBox),

      h('div', { class: 'card' },
        h('div', { class: 'spread', style: { flexWrap: 'wrap', gap: '10px' } },
          h('h2', { style: { margin: 0 } }, 'Teacher accounts'),
          h('button', { class: 'btn primary', type: 'button', onClick: addTeacher }, '＋ Add teacher')),
        h('p', { class: 'muted small' }, 'Each teacher signs in with their own ID - they only see their own quizzes, questions and reports.'),
        teachersBox),

      h('div', { class: 'card' },
        h('h2', { style: { marginTop: 0 } }, 'Running sessions'),
        sessionsBox)));

  loadOverview();
  loadTeachers();
  loadSessions();
}
