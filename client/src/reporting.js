// Shared end-of-report helpers: the CSV builder + download used by the live
// dashboard, the print page and the reports history.
import { h, toast, pct, fmtClock } from './ui.js';
import { badgeById } from '../../shared/badges.js';
import { unitName as baseUnitName } from '../../shared/units.js';

const clock = (ms) => fmtClock((ms || 0) / 1000);

function csvCell(v) {
  return `"${String(v ?? '').replace(/"/g, '""')}"`;
}

/**
 * Two tables in one file: session info + students, then units, then every
 * question with a needs-review flag for the ones the class missed.
 * @param {object} report
 * @param {(unit: number) => string} [unitLabel] teacher's renamed units
 */
export function csvOf(report, unitLabel = baseUnitName) {
  const line = (arr) => arr.map(csvCell).join(',');
  const cfg = report.config || {};
  const totals = report.totals || {};
  // the quiz's own set names win over the syllabus names
  const names = cfg.unitNames;
  const label = (u) => (names && names[u]) || unitLabel(Number(u));
  const out = [];

  out.push(line(['Python Adventure report']));
  out.push(line(['Session', report.code]));
  out.push(line(['Title', report.title || 'Python Adventure']));
  out.push(line(['Started', report.startedAt ? new Date(report.startedAt).toLocaleString() : '']));
  out.push(line(['Ended', report.endedAt ? new Date(report.endedAt).toLocaleString() : '']));
  out.push(line(['Class', cfg.className || '', 'Section', cfg.section || '']));
  out.push(line(['Mode', cfg.mode || 'live']));
  if (cfg.setId) out.push(line(['Question bank', cfg.setName || cfg.setId, 'Questions', cfg.setCount ?? '']));
  if (cfg.timerOn !== undefined) {
    out.push(line([
      'Question timer', cfg.timerOn ? 'on' : 'off',
      'Common time', cfg.commonSeconds ? `${cfg.commonSeconds}s` : 'per difficulty',
      'Whole quiz limit', cfg.quizSeconds ? `${Math.round(cfg.quizSeconds / 60)} min` : 'none',
    ]));
  }
  out.push(line(['Players', totals.players ?? (report.players || []).length, 'Class accuracy', pct(totals.accuracy || 0)]));
  out.push('');

  out.push(line(['Student', 'Team', 'Score', 'Correct', 'Wrong', 'Accuracy', 'Time (mm:ss)', 'Best streak', 'Badges', 'Needs help', 'Finished']));
  for (const p of report.players || []) {
    out.push(line([
      p.nickname, p.team || '', p.score ?? 0, p.correct ?? 0, p.wrong ?? 0,
      pct(p.accuracy || 0), clock(p.totalTimeMs), p.bestStreak || 0,
      (p.badges || []).map((b) => badgeById(b).name).join(' | '),
      p.needsHelp ? 'yes' : 'no',
      p.finished === undefined ? '' : (p.finished ? 'yes' : 'no'),
    ]));
  }
  out.push('');

  out.push(line(['Unit', 'Accuracy', 'Correct', 'Total']));
  for (const [u, s] of Object.entries(report.unitStats || {})) {
    out.push(line([label(Number(u)), pct(s.accuracy || 0), s.correct ?? 0, s.total ?? 0]));
  }
  out.push('');

  out.push(line(['Question id', 'Unit', 'Prompt', 'Correct', 'Wrong', 'Miss rate', 'Avg seconds', 'Needs review']));
  for (const q of report.questions || []) {
    out.push(line([
      q.id, label(q.unit), q.prompt, q.correct ?? 0, q.wrong ?? 0,
      pct(q.missRate || 0), Math.round((q.avgTimeMs || 0) / 100) / 10,
      (q.missRate || 0) >= 0.5 ? 'yes' : 'no',
    ]));
  }

  // self-paced runs: seconds each student spent per question (blank = not attempted)
  if (cfg.timerOn === false && (report.players || []).some((p) => Array.isArray(p.answerTimes))) {
    out.push('');
    out.push(line(['Time per question (seconds)']));
    const cols = report.questions?.length
      || Math.max(0, ...(report.players || []).map((p) => (p.answerTimes || []).length));
    out.push(line(['Student', ...Array.from({ length: cols }, (_, i) => `Q${i + 1}`), 'Total (s)']));
    for (const p of report.players || []) {
      const times = p.answerTimes || [];
      out.push(line([
        p.nickname,
        ...Array.from({ length: cols }, (_, i) => (times[i] == null ? '' : Math.round(times[i] / 100) / 10)),
        Math.round((p.totalTimeMs || 0) / 100) / 10,
      ]));
    }
  }
  return out.join('\r\n');
}

export function downloadCsv(report, unitLabel = baseUnitName) {
  try {
    const blob = new Blob([csvOf(report, unitLabel)], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: `python-adventure-${report.code}.csv` });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
    toast('Report downloaded ⬇️');
  } catch (e) {
    toast(e.message || 'Could not build the CSV.', 'bad');
  }
}
