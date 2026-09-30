import { h, mount, toast } from '../ui.js';
import { store, save } from '../state.js';
import { go } from '../main.js';
import { emitAck, getSocket, on } from '../net.js';
import { LiveEngine } from '../game/liveEngine.js';
import { setActiveGame, clearActive } from '../game/session.js';

export const title = 'Join';

const NICK_SUGGESTIONS = ['CodeNinja', 'BugHunter', 'LoopLover', 'PyKid', 'IndentIvy', 'SemicolonSam', 'ListLiz', 'TupleTom'];

export function render(root) {
  let busy = false;

  const codeInput = h('input', {
    type: 'text', maxlength: '4', placeholder: 'E.G. K7PD',
    'aria-label': 'Game code', autocomplete: 'off', spellcheck: 'false',
    style: { textTransform: 'uppercase', letterSpacing: '.35em', fontSize: '1.5rem', fontWeight: '800', textAlign: 'center' },
    value: store.code || '',
    onInput: (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 4); },
  });

  const nickInput = h('input', {
    type: 'text', maxlength: '18', placeholder: NICK_SUGGESTIONS[Math.floor(Math.random() * NICK_SUGGESTIONS.length)],
    'aria-label': 'Nickname', autocomplete: 'off',
    value: store.nickname || '',
  });

  const teamInput = h('input', {
    type: 'text', maxlength: '18', placeholder: 'Optional - e.g. Team Py',
    'aria-label': 'Team name (optional)', autocomplete: 'off',
    value: store.team || '',
  });

  const errBox = h('p', { class: 'muted small', style: { minHeight: '1.2em', color: 'var(--bad)', margin: '4px 0 0' } });

  const joinBtn = h('button', { class: 'btn primary big block', onClick: () => join() }, 'Join the game 🚀');

  async function join() {
    if (busy) return;
    const code = codeInput.value.trim().toUpperCase();
    const nickname = nickInput.value.trim();
    if (code.length !== 4) { errBox.textContent = 'Enter the 4-character code from the screen.'; codeInput.focus(); return; }
    if (!nickname) { errBox.textContent = 'Pick a nickname so we can cheer for you.'; nickInput.focus(); return; }

    busy = true;
    joinBtn.disabled = true;
    joinBtn.textContent = 'Joining…';
    try {
      const res = await emitAck('player:join', { code, nickname, team: teamInput.value.trim() || undefined });
      if (res.error) throw new Error(res.error);
      save({ code, nickname, team: teamInput.value.trim(), playerId: res.playerId });

      const engine = new LiveEngine({ code, playerId: res.playerId });
      engine.attach();
      clearActive();
      setActiveGame(engine, {
        mode: 'live', code, teamMode: res.teamMode, started: res.started, title: res.title,
        // question timer contract from the join ack (question:start refines it live)
        timerOn: res.timerOn, selfPaced: res.selfPaced,
        allowBack: res.allowBack, allowSkip: res.allowSkip, quizEndsAt: res.quizEndsAt,
      });

      if (res.started) go('#/play');
      else go('#/lobby');
    } catch (e) {
      errBox.textContent = e.message || 'Could not join. Check the code and try again.';
      joinBtn.disabled = false;
      joinBtn.textContent = 'Join the game 🚀';
      busy = false;
    }
  }

  const onKey = (e) => { if (e.key === 'Enter') join(); };
  codeInput.addEventListener('keydown', onKey);
  nickInput.addEventListener('keydown', onKey);

  mount(root,
    h('div', { class: 'screen narrow' },
      h('div', { class: 'row', style: { marginBottom: '14px' } },
        h('button', { class: 'btn small ghost', onClick: () => go('#/') }, '← Home'),
        h('span', { class: 'chip topic' }, '🎮 Live game')),

      h('div', { class: 'card' },
        h('h1', null, 'Join the adventure'),
        h('p', { class: 'muted' }, 'Your teacher will show a code like this on the board.'),

        h('div', { class: 'field' },
          h('label', null, 'Game code'),
          codeInput),

        h('div', { class: 'field' },
          h('label', null, 'Nickname'),
          nickInput,
          h('span', { class: 'hint' }, 'Real name optional - keep it friendly. It shows on the leaderboard.')),

        h('div', { class: 'field' },
          h('label', null, 'Team (optional)'),
          teamInput,
          h('span', { class: 'hint' }, 'Leave blank to play solo, or type a team name to team up.')),

        errBox,
        h('div', { style: { marginTop: '12px' } }, joinBtn),

        h('div', { class: 'divider' }),
        h('p', { class: 'muted small', style: { margin: 0 } },
          'No account needed. Marks are private-ish: the bottom of the leaderboard can be hidden by your teacher.')
      )
    )
  );

  setTimeout(() => codeInput.focus(), 60);
}
