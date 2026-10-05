// Finished-session reports, saved per teacher under data/teachers/<id>/reports/.
// Written the moment a quiz ends, so history survives restarts and the teacher
// can reopen, print or re-export any past class run.
import { readdirSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { readJsonSync, removeFileSync, writeJsonSync } from './filesafe.js';
import { ownerDirFor } from './bank.js';

const CODE_RE = /^[A-Za-z0-9]{4}$/;

function reportsDir(owner) {
  const dir = ownerDirFor(owner);
  return dir ? join(dir, 'reports') : null;
}

function safeCode(code) {
  const c = String(code || '');
  return CODE_RE.test(c) ? c : null;
}

export function saveReport(owner, report) {
  const dir = reportsDir(owner);
  const code = safeCode(report?.code);
  if (!dir || !code) return false;
  writeJsonSync(join(dir, `${code}.json`), report);
  return true;
}

export function listReports(owner) {
  const dir = reportsDir(owner);
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  for (const file of readdirSync(dir)) {
    if (!/^[A-Za-z0-9]{4}\.json$/.test(file)) continue;
    const report = readJsonSync(join(dir, file), null);
    if (!report || !report.code) continue;
    out.push({
      code: report.code,
      title: report.title || 'Python Adventure',
      startedAt: report.startedAt || null,
      endedAt: report.endedAt || null,
      players: report.totals?.players ?? (report.players || []).length,
      accuracy: report.totals?.accuracy ?? 0,
      questionCount: (report.questions || []).length,
      className: report.config?.className || '',
      section: report.config?.section || '',
      mode: report.config?.mode || 'live',
    });
  }
  return out.sort((a, b) => (b.endedAt || 0) - (a.endedAt || 0));
}

export function getReport(owner, code) {
  const dir = reportsDir(owner);
  const c = safeCode(code);
  if (!dir || !c) return null;
  const path = join(dir, `${c}.json`);
  if (!existsSync(path)) return null;
  const report = readJsonSync(path, null);
  return report && report.code === c ? report : null;
}

export function deleteReport(owner, code) {
  const dir = reportsDir(owner);
  const c = safeCode(code);
  if (!dir || !c) return false;
  const path = join(dir, `${c}.json`);
  if (!existsSync(path)) return false;
  try { removeFileSync(path); } catch { return false; }
  return true;
}

/**
 * Questions the class repeatedly missed - the editor shows these as
 * "needs review". Aggregated over the most recent runs.
 */
export function needsReview(owner, { maxSessions = 30, minAsks = 4 } = {}) {
  const dir = reportsDir(owner);
  if (!dir || !existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => /^[A-Za-z0-9]{4}\.json$/.test(f))
    .map((f) => ({ f, m: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .slice(0, maxSessions);

  const byId = new Map();
  for (const { f } of files) {
    const report = readJsonSync(join(dir, f), null);
    if (!report) continue;
    for (const q of report.questions || []) {
      if (!q.id) continue;
      const agg = byId.get(q.id) || {
        id: q.id, prompt: q.prompt || '', unit: q.unit, sessions: 0, asks: 0, wrong: 0,
      };
      agg.sessions++;
      agg.asks += (q.correct || 0) + (q.wrong || 0);
      agg.wrong += q.wrong || 0;
      agg.prompt = q.prompt || agg.prompt;
      byId.set(q.id, agg);
    }
  }

  return [...byId.values()]
    .map((a) => ({ ...a, missRate: a.asks ? a.wrong / a.asks : 0 }))
    .filter((a) => a.asks >= minAsks && a.missRate >= 0.5)
    .sort((a, b) => b.missRate - a.missRate || b.sessions - a.sessions)
    .slice(0, 50);
}
