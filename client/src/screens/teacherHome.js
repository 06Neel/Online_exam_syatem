// Teacher Home: live sessions first (code + copy + QR), then quick actions
// to create a quiz, then the latest finished reports.
import { h, mount, toast, modal } from '../ui.js';
import { store, save } from '../state.js';
import { go } from '../main.js';
import { emitAck, request } from '../net.js';
import { authToken } from '../auth.js';
import { topbar } from '../topbar.js';
import { joinUrl, qrImg, copyText } from '../qrcodeUi.js';
import { defaultCfg, createQuizWith } from './quizWizard.js';

export const title = 'Home';

const statusLabel = (s) => ({ lobby: 'Lobby', running: 'Live', paused: 'Paused', ended: 'Finished' }[s] || s);

export function render(root) {
  let busy = false;

  // ---------- live sessions ----------
  const sessionsBox = h('div', { class: 'stack' }, h('div', { class: 'empty' }, 'Loading sessions…'));

  request('/api/sessions', { token: authToken() }).then((list) => {
    sessionsBox.textContent = '';
    if (!list?.length) {
      sessionsBox.append(h('div', { class: 'empty' },
        'No live sessions yet - create your first quiz and its join code appears here.'));
      return;
    }
    list.forEach((s) => sessionsBox.append(sessionRow(s)));
  }).catch((e) => {
    sessionsBox.textContent = '';
    sessionsBox.append(h('div', { class: 'empty' }, e.message || 'Could not load sessions.'));
  });

  function sessionRow(s) {
    const openBtn = h('button', {
      class: 'btn primary', type: 'button', 'aria-label': `Open dashboard for session ${s.code}`,
      onClick: async () => {
        if (busy) return;
        busy = true;
        openBtn.disabled = true;
        openBtn.textContent = 'Opening…';
        try {
          const res = await emitAck('host:join', { code: s.code, token: authToken() });
          if (res?.error || !res?.ok) throw new Error(res?.error || 'That session could not be reopened.');
          save({ teacherCode: res.code });
          go(`#/teacher/live${res.code ? `?code=${res.code}` : ''}`);
        } catch (e) {
          toast(e.message || 'Could not open that session.', 'bad');
          busy = false;
          openBtn.disabled = false;
          openBtn.textContent = 'Open dashboard';
        }
      },
    }, 'Open dashboard');

    const copyCodeBtn = h('button', {
      class: 'btn small ghost', type: 'button',
      'aria-label': `Copy join code ${s.code}`,
      onClick: async () => {
        const ok = await copyText(s.code);
        toast(ok ? 'Code copied.' : `Copy failed - the code is ${s.code}`, ok ? 'good' : 'bad');
      },
    }, 'Copy code');

    const copyLinkBtn = h('button', {
      class: 'btn small ghost', type: 'button',
      'aria-label': `Copy join link for ${s.code}`,
      onClick: async () => {
        const ok = await copyText(joinUrl(s.code));
        toast(ok ? 'Join link copied.' : 'Copy failed', ok ? 'good' : 'bad');
      },
    }, 'Copy link');

    return h('div', { class: 'live-row' },
      h('div', { class: 'live-main' },
        h('span', { class: 'live-code mono' }, s.code),
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } },
          h('span', { class: 'chip' }, statusLabel(s.status)),
          h('span', { class: 'chip topic' }, `${s.players} player${s.players === 1 ? '' : 's'}`)),
        h('div', { class: 'muted small' },
          `${s.title || 'Python Adventure'}${s.startedAt ? ` · started ${new Date(s.startedAt).toLocaleTimeString()}` : ''}`)),
      h('div', { class: 'live-qr' }, qrImg(joinUrl(s.code), 96)),
      h('div', { class: 'live-actions' },
        openBtn,
        h('div', { class: 'row', style: { gap: '8px', flexWrap: 'wrap' } }, copyCodeBtn, copyLinkBtn)));
  }

  // ---------- quick start ----------
  function quickStart() {
    const titleInput = h('input', {
      id: 'qs-title', type: 'text', value: 'Python Adventure', maxlength: '60',
      'aria-label': 'Quiz title',
    });
    const bankSel = h('select', { id: 'qs-bank', 'aria-label': 'Question bank' },
      h('option', { value: '' }, 'Default question bank'));
    const err = h('p', { class: 'small', style: { minHeight: '1.2em', color: 'var(--bad)', margin: '6px 0 0' } });

    let sets = null;
    let selectedSet = null;
    request('/api/sets', { token: authToken() }).then((list) => {
      if (!Array.isArray(list) || !list.length) return;
      sets = list;
      bankSel.textContent = '';
      for (const s of list) bankSel.append(h('option', { value: s.id }, `${s.label || s.name} · ${s.count} questions`));
      const remembered = store.quizBankId ? list.find((s) => s.id === store.quizBankId) : null;
      if (remembered) bankSel.value = remembered.id;
      else if (list.length === 1) bankSel.value = list[0].id;
    }).catch(() => { /* default bank is fine */ });

    const dlg = modal({
      title: 'Quick start',
      body: [
        h('p', { class: 'muted small' },
          'Creates a quiz with sensible defaults and opens the lobby straight away - tweak anything later from the wizard.'),
        h('div', { class: 'field' },
          h('label', { for: 'qs-title' }, 'Quiz title'),
          titleInput),
        h('div', { class: 'field' },
          h('label', { for: 'qs-bank' }, 'Question bank'),
          bankSel),
        err,
      ],
      actions: [
        { label: 'Cancel' },
        {
          label: 'Create and open lobby', kind: 'primary', close: false,
          onClick: async (e) => {
            const btn = e?.currentTarget;
            if (busy) return;
            const name = titleInput.value.trim() || 'Python Adventure';
            selectedSet = sets ? (sets.find((s) => s.id === bankSel.value) || null) : null;
            busy = true;
            if (btn) { btn.disabled = true; btn.textContent = 'Opening the lobby…'; }
            try {
              const cfg = defaultCfg();
              cfg.title = name;
              if (selectedSet) {
                const ids = (selectedSet.units || []).map((u) => u.id).filter((n) => Number.isFinite(Number(n)));
                if (ids.length) cfg.units = ids;
                cfg.count = Math.max(4, Math.min(40, selectedSet.count || 20));
              }
              await createQuizWith(cfg, selectedSet);
              dlg.close();
            } catch (ex) {
              toast(ex.message || 'Could not create the quiz.', 'bad');
              busy = false;
              if (btn) { btn.disabled = false; btn.textContent = 'Create and open lobby'; }
            }
          },
        },
      ],
    });
  }

  // ---------- recent reports ----------
  const reportsBox = h('div', { class: 'stack' }, h('div', { class: 'empty' }, 'Loading reports…'));

  request('/api/reports', { token: authToken() }).then((list) => {
    reportsBox.textContent = '';
    const recent = Array.isArray(list) ? list.slice(0, 3) : [];
    if (!recent.length) {
      reportsBox.append(h('div', { class: 'empty' },
        'No reports yet - finished quizzes appear here with scores and CSV export.'));
      return;
    }
    recent.forEach((r) => reportsBox.append(reportRow(r)));
  }).catch((e) => {
    reportsBox.textContent = '';
    reportsBox.append(h('div', { class: 'empty' }, e.message || 'Could not load reports.'));
  });

  function reportRow(r) {
    const acc = Number.isFinite(r.accuracy) ? `${Math.round(r.accuracy * 100)}%` : null;
    return h('div', { class: 'report-row' },
      h('div', { class: 'report-main' },
        h('b', null, r.title || r.code),
        h('div', { class: 'muted small' },
          `${r.endedAt ? new Date(r.endedAt).toLocaleString() : ''}${acc ? ` · ${acc} accuracy` : ''}`)),
      h('div', { class: 'row', style: { gap: '8px' } },
        h('span', { class: 'chip' }, r.mode === 'practice' ? 'Practice' : 'Live'),
        h('button', {
          class: 'btn small', type: 'button',
          'aria-label': `Open report ${r.title || r.code}`,
          onClick: () => go(`#/teacher/report/${encodeURIComponent(r.code)}`),
        }, 'Open')));
  }

  // ---------- page ----------
  mount(root,
    h('div', { class: 'screen pro' },
      topbar('home'),
      h('div', { class: 'page-head' },
        h('h1', null, 'Teacher dashboard'),
        h('p', { class: 'muted' }, 'Your running quizzes, a new quiz in four steps, and the latest reports.')),

      h('div', { class: 'card' },
        h('div', { class: 'spread' },
          h('h2', { style: { margin: 0 } }, 'Live sessions'),
          h('span', { class: 'chip' }, 'running now')),
        h('p', { class: 'muted small' },
          'The join code, a scannable QR and the dashboard for anything you have running - on any device.'),
        sessionsBox),

      h('div', { class: 'card' },
        h('div', { class: 'spread' },
          h('h2', { style: { margin: 0 } }, 'Create a quiz'),
          h('span', { class: 'chip topic' }, '4 quick steps')),
        h('p', { class: 'muted small' },
          'Mode, questions, timer and scoring, then extras - you are in the lobby in under a minute.'),
        h('div', { class: 'row', style: { gap: '10px', flexWrap: 'wrap', marginTop: '4px' } },
          h('button', {
            class: 'btn primary big', type: 'button',
            onClick: () => go('#/teacher/new'),
          }, '+ Create a quiz'),
          h('button', {
            class: 'btn big', type: 'button',
            onClick: quickStart,
          }, '⚡ Quick start'))),

      h('div', { class: 'card' },
        h('div', { class: 'spread' },
          h('h2', { style: { margin: 0 } }, 'Recent reports'),
          h('button', {
            class: 'btn small ghost', type: 'button',
            onClick: () => go('#/teacher/reports'),
          }, 'View all')),
        h('p', { class: 'muted small' },
          'Finished quizzes, newest first - open one to see scores, print it, or re-export the CSV.'),
        reportsBox)));
}
