import { h, mount, confetti, esc, pct } from '../ui.js';
import { badgeById } from '../../../shared/badges.js';
import { rankTeams, fmtMarks, comparePlayers } from '../../../shared/scoring.js';
import { BAND_INFO } from '../../../shared/quiz.js';
import { store, save } from '../state.js';
import { go } from '../main.js';

export const title = 'Results';

const UNIT_NAMES = {
  1: 'Setup & running Python', 2: 'Variables & expressions', 3: 'Conditionals',
  4: 'Loops & iteration', 5: 'Strings', 6: 'Lists', 7: 'Tuples & dictionaries',
};

// a live quiz built from an uploaded set ships its own unit names
const namesFor = (report) => report?.config?.unitNames || UNIT_NAMES;

// standalone practice only knows the built-in topics 1-7
const syllabusUnits = (ids) => {
  const keep = (Array.isArray(ids) ? ids : []).map(Number).filter((u) => u >= 1 && u <= 7);
  return [...new Set(keep)];
};

export function render(root) {
  const report = store.lastReport;
  if (!report) {
    mount(root, h('div', { class: 'screen narrow center' },
      h('div', { class: 'card' },
        h('h1', null, 'No results yet'),
        h('p', { class: 'muted' }, 'Play a round first and your strength map will appear here.'),
        h('button', { class: 'btn primary', onClick: () => go('#/') }, 'Back home'))));
    return;
  }

  const me = report.players.find((p) => p.id === report.meId) || report.players[0];
  const isTeam = !!report.code;
  const unitStats = me.unitStats || report.unitStats || {};
  const names = namesFor(report);
  const accuracy = me.accuracy ?? report.totals?.accuracy ?? 0;
  const strong = Object.values(unitStats).filter((s) => s.band === 'strong').length;
  const ranked = report.players.slice().sort(comparePlayers);
  const myRank = ranked.findIndex((p) => p.id === me.id) + 1;

  if (accuracy >= 0.75) confetti(70);

  const unitTiles = Object.keys(names).map((u) => {
    const s = unitStats[u];
    const info = BAND_INFO[s?.band || 'practice'];
    return h('div', { class: `tile ${s ? s.band : 'practice'}` },
      h('div', { class: 'name' }, names[u]),
      h('div', { class: 'pct' }, s ? `${Math.round(s.accuracy * 100)}%` : '—'),
      h('div', { class: 'band' }, `${info.icon} ${info.label}`),
      h('div', { class: 'muted small' }, s ? `${s.correct}/${s.total} right${s.time ? ` · ${Math.round(s.time / 1000)}s` : ''}` : 'not played'),
      h('div', { class: 'muted small' }, info.note));
  });

  const badges = (me.badges || []).map((id) => badgeById(id));

  const journey = (report.questions || []).slice(-14).map((q) =>
    h('span', {
      class: `chip ${q.correct ? 'good' : 'bad'}`,
      title: q.id,
    }, `${q.correct ? '✓' : '✗'} ${q.refresher ? '↻' : ''} ${q.id.replace(/^u(\d)-q(\d+)$/, (_, u, n) => `L${u}.${n}`)}`));

  const weak = (report.weakUnits || []).filter(Boolean);
  // old reports kept their "Score" wording; fixed-marks runs say Marks
  const marksMode = Number.isFinite(report.maxMarks);
  const scoreLabel = marksMode ? 'Marks' : 'Score';
  const fmtScore = (n) => (marksMode ? fmtMarks(n) : String(n ?? 0));
  // team-mode runs: the final team standings (solo players keep their own rank)
  const teams = report.config?.teamMode ? rankTeams(report.players) : [];
  const myTeam = me.team ? teams.find((t) => t.name === me.team) : null;

  const practiceWeak = () => {
    const units = weak.length ? weak : Object.entries(unitStats)
      .filter(([, s]) => s.band !== 'strong').map(([u]) => Number(u));
    const known = syllabusUnits(units);
    save({ practiceConfig: { ...(store.practiceConfig || {}), units: known.length ? known : [1, 2, 3], count: 10, difficulty: 'mixed' } });
    go('#/practice');
  };

  mount(root,
    h('div', { class: 'screen' },
      h('div', { class: 'row', style: { marginBottom: '14px' } },
        h('button', { class: 'btn small ghost', onClick: () => go('#/') }, '← Home'),
        h('span', { class: 'chip topic' }, report.code ? `🎮 Live · session ${report.code}` : '🌱 Practice run')),

      h('div', { class: 'card' },
        h('div', { class: 'spread', style: { flexWrap: 'wrap', gap: '14px' } },
          h('div', null,
            h('h1', { style: { margin: 0 } },
              isTeam ? (myRank === 1 ? 'You topped the board! 🏆' : `You finished #${myRank}`) : 'Practice complete! 🌱'),
            h('p', { class: 'muted', style: { margin: '6px 0 0' } },
              `${me.nickname}${me.team ? ` · 👥 ${me.team}${myTeam ? ` (team #${myTeam.rank})` : ''}` : ''} · ${report.players.length > 1 ? `ranked ${myRank} of ${report.players.length}` : 'private run, no ranking'}`)),
          h('div', { class: 'row' },
            h('div', { class: 'stat brand' }, h('div', { class: 'k' }, scoreLabel),
              h('div', { class: 'v' }, fmtScore(me.score)),
              marksMode ? h('div', { class: 'muted small' }, `of ${fmtMarks(report.maxMarks)}`) : null),
            h('div', { class: `stat ${accuracy >= 0.7 ? 'good' : accuracy < 0.5 ? 'bad' : ''}` },
              h('div', { class: 'k' }, 'Accuracy'), h('div', { class: 'v' }, `${Math.round(accuracy * 100)}%`)),
            h('div', { class: 'stat' }, h('div', { class: 'k' }, 'Best streak'), h('div', { class: 'v' }, `🔥${me.bestStreak || 0}`))))),

      teams.length
        ? h('div', { class: 'card' },
          h('div', { class: 'spread' },
            h('h2', { style: { margin: 0 } }, '🏆 Team standings'),
            h('span', { class: 'chip' }, `${teams.length} team${teams.length === 1 ? '' : 's'}`)),
          h('div', { class: 'roster', style: { marginTop: '10px' } },
            teams.map((t) => h('div', { class: 'p' },
              h('span', { class: `chip ${t.rank === 1 ? 'good' : ''}` }, `#${t.rank}`),
              h('span', { style: { flex: 1, minWidth: 0 } },
                h('b', null, `👥 ${t.name}`, t.name === me.team ? h('span', { class: 'chip topic', style: { marginLeft: '6px' } }, 'your team') : null),
                h('div', { class: 'meta' }, `${(t.members || []).join(', ')} · avg ${fmtScore(t.avg)} · ${pct(t.accuracy)} right`)),
              h('span', { class: 'score' }, fmtScore(t.score))))),
          h('p', { class: 'muted small', style: { margin: '10px 0 0' } },
            'Solo players are ranked individually above - no fake teams here.'))
        : null,

      h('div', { class: 'card' },
        h('div', { class: 'spread' },
          h('h2', { style: { margin: 0 } }, '🗺️ Your strength map'),
          h('span', { class: 'chip' }, `${strong} strong`)),
        h('p', { class: 'muted small' }, '🟢 strong · 🟡 revise · 🔴 needs practice'),
        h('div', { class: 'strength', style: { marginTop: '10px' } }, unitTiles)),

      h('div', { class: 'grid cols-2', style: { marginTop: '16px' } },
        h('div', { class: 'card' },
          h('h2', null, '🏅 Badges earned'),
          badges.length
            ? h('div', { class: 'badges' }, badges.map((b) => h('div', { class: 'badge pop' },
              h('span', { class: 'ico' }, b.icon), h('span', null, b.name, h('small', null, b.desc)))))
            : h('p', { class: 'muted' }, 'No badges this round - a perfect excuse to go again.')),

        h('div', { class: 'card' },
          h('h2', null, '🧭 Next steps'),
          weak.length
            ? h('div', null,
              h('p', { class: 'muted' }, 'These need a little love:'),
              h('div', { class: 'tag-list', style: { marginBottom: '12px' } },
                weak.map((u) => h('span', { class: 'chip bad' }, names[u] || `Unit ${u}`))),
              h('button', { class: 'btn primary block', onClick: practiceWeak }, 'Fix my weak spots →'))
            : h('p', { class: 'muted' }, 'Everything is looking green - try a harder mix or fewer hints next time.'))),

      h('div', { class: 'card', style: { marginTop: '16px' } },
        h('h2', null, '📍 Recent questions'),
        h('div', { class: 'tag-list' }, journey.length ? journey : h('span', { class: 'muted' }, 'Nothing here yet.'))),

      h('div', { class: 'row', style: { marginTop: '18px', justifyContent: 'center' } },
        h('button', { class: 'btn primary big', onClick: () => {
          const played = Object.keys(unitStats).map(Number).filter((u) => unitStats[u].band !== 'strong');
          const known = syllabusUnits(played);
          save({ practiceConfig: { ...store.practiceConfig, units: known.length ? known : store.practiceConfig?.units || [1, 2, 3, 4, 5, 6, 7] } });
          go('#/practice');
        } }, 'Play again'),
        h('button', { class: 'btn big', onClick: () => go('#/') }, 'Home'),

        report.code ? h('button', {
          class: 'btn ghost',
          onClick: () => downloadReport(report),
        }, '⬇️ Download my summary') : null)

    )
  );
}

function downloadReport(report) {
  const marksMode = Number.isFinite(report.maxMarks);
  const rows = [marksMode
    ? ['Student', 'Team', 'Marks', 'Correct', 'Wrong', 'Accuracy', 'Time (s)', 'Best streak', 'Weak units']
    : ['Student', 'Team', 'Score', 'Correct', 'Wrong', 'Accuracy', 'Time (s)', 'Best streak', 'Weak units']];
  for (const p of report.players) {
    rows.push([
      p.nickname, p.team || 'Solo', marksMode ? fmtMarks(p.score) : p.score, p.correct, p.wrong,
      `${Math.round((p.accuracy || 0) * 100)}%`,
      Math.round((p.totalTimeMs || 0) / 1000),
      p.bestStreak || 0,
      (p.weakUnits || []).join(' '),
    ]);
  }
  const csv = rows.map((r) => r.map((c) => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const a = h('a', { href: URL.createObjectURL(blob), download: `python-adventure-${report.code}.csv` });
  document.body.appendChild(a);
  a.click();
  a.remove();
}
