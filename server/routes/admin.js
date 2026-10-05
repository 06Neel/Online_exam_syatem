// /api/admin - everything only the administrator can touch.
// Every route is gated by requireAuth('admin'), which answers 404 for anyone
// else, so the admin surface looks like it does not exist.
import { Router } from 'express';
import { join } from 'node:path';
import { requireAuth } from './auth.js';
import {
  createTeacher, deleteTeacher, generatePassword, listTeachers, resetTeacherPassword,
  setTeacherActive, updateTeacher, adminConfig, teachersFileStats, listTeacherFolders,
  revokeAllTokens,
} from '../auth.js';
import { loadBank } from '../bank.js';
import { removeFileSync, whenDataWritesDone, writeJsonSync } from '../filesafe.js';
import { DATA_DIR } from '../paths.js';
import { exportSnapshotFiles, listDataFileRels } from '../store.js';

/** Backup paths are relative, .json and never leave DATA_DIR (no .., no drive letters). */
function safeRelPath(key) {
  if (typeof key !== 'string' || !key) return false;
  if (key.includes('\\') || key.includes('..') || key.startsWith('/') || /^[A-Za-z]:/.test(key)) return false;
  if (!key.toLowerCase().endsWith('.json')) return false;
  if (key.startsWith('trash/') || key.includes('.bak') || key.includes('.tmp')) return false;
  return true;
}

export function createAdminRouter(store) {
  const router = Router();
  router.use(requireAuth('admin'));

  router.get('/overview', (_req, res) => {
    const teachers = listTeachers();
    const stats = teachersFileStats();
    res.json({
      teachers: teachers.length,
      activeTeachers: teachers.filter((t) => t.active !== false).length,
      suspendedTeachers: teachers.filter((t) => t.active === false).length,
      teacherFolders: listTeacherFolders().length,
      liveSessions: store.list().length,
      questions: loadBank().questions.length,
      teachersFileBytes: stats ? stats.size : 0,
      adminUser: adminConfig().username,
    });
  });

  router.get('/teachers', (_req, res) => {
    res.json(listTeachers());
  });

  router.get('/sessions', (_req, res) => {
    res.json(store.list());
  });

  router.post('/teachers', async (req, res) => {
    try {
      const body = req.body || {};
      const generated = !body.tempPassword;
      const tempPassword = body.tempPassword || generatePassword();
      const result = await createTeacher({
        id: body.id,
        name: body.name,
        email: body.email,
        department: body.department,
        tempPassword,
      });
      if (result.error) return res.status(400).json({ error: result.error });
      res.json({ ok: true, teacher: result.teacher, password: generated ? tempPassword : null });
    } catch (e) {
      console.error('[admin] create teacher failed:', e);
      res.status(500).json({ error: 'Could not create the teacher.' });
    }
  });

  router.patch('/teachers/:id', async (req, res) => {
    const result = await updateTeacher(req.params.id, req.body || {});
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ ok: true, teacher: result.teacher });
  });

  router.post('/teachers/:id/password', async (req, res) => {
    try {
      const body = req.body || {};
      const generated = !body.newPassword;
      const newPassword = body.newPassword || generatePassword();
      const result = await resetTeacherPassword(req.params.id, newPassword);
      if (result.error) return res.status(400).json({ error: result.error });
      res.json({ ok: true, password: generated ? newPassword : null });
    } catch (e) {
      console.error('[admin] reset password failed:', e);
      res.status(500).json({ error: 'Could not reset the password.' });
    }
  });

  router.post('/teachers/:id/status', async (req, res) => {
    const active = !!(req.body && req.body.active);
    const result = await setTeacherActive(req.params.id, active);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json({ ok: true, active });
  });

  router.delete('/teachers/:id', async (req, res) => {
    try {
      const result = await deleteTeacher(req.params.id);
      if (result.error) return res.status(400).json({ error: result.error });
      res.json({ ok: true });
    } catch (e) {
      console.error('[admin] delete teacher failed:', e);
      res.status(500).json({ error: 'Could not delete the teacher.' });
    }
  });

  // ---------------------------------------------------------- backup & restore
  // One JSON file with everything private: accounts (hashed), banks, units,
  // classes, reports, settings and session snapshots.
  router.get('/export', (_req, res) => {
    const files = exportSnapshotFiles();
    const stamp = new Date().toISOString().slice(0, 10);
    res.setHeader('Content-Disposition', `attachment; filename="python-adventure-backup-${stamp}.json"`);
    res.json({
      app: 'python-adventure',
      version: 1,
      exportedAt: new Date().toISOString(),
      storage: files['teachers.json'] ? 'ok' : 'empty',
      files,
    });
  });

  router.post('/import', async (req, res) => {
    try {
      const body = req.body || {};
      if (body.confirm !== 'replace') {
        return res.status(400).json({ error: 'Confirm the restore - it replaces all stored data.' });
      }
      const files = body.files;
      if (!files || typeof files !== 'object' || Array.isArray(files)) {
        return res.status(400).json({ error: 'That backup has no "files" object.' });
      }
      const entries = Object.entries(files);
      if (!entries.length) return res.status(400).json({ error: 'That backup is empty.' });
      for (const [key, value] of entries) {
        if (!safeRelPath(key)) return res.status(400).json({ error: `Unsafe path in backup: ${key}` });
        if (value === undefined || typeof value === 'function') {
          return res.status(400).json({ error: `Backup entry ${key} has no data.` });
        }
      }

      // 1) write everything from the backup (each write is mirrored to the database)
      for (const [key, value] of entries) {
        writeJsonSync(join(DATA_DIR, ...key.split('/')), value);
      }
      // 2) remove what is no longer in the backup (mirrored deletions too)
      const incoming = new Set(entries.map(([k]) => k));
      let removed = 0;
      for (const key of listDataFileRels()) {
        if (incoming.has(key)) continue;
        try { removeFileSync(join(DATA_DIR, ...key.split('/'))); removed++; } catch { /* already gone */ }
      }
      await whenDataWritesDone();   // durable before we answer

      // 3) refresh everything held in memory
      const revoked = revokeAllTokens();
      loadBank({ fresh: true });
      const owners = new Set();
      for (const key of incoming) {
        const m = /^teachers\/([^/]+)\//.exec(key);
        if (m) owners.add(m[1]);
      }
      for (const owner of owners) loadBank({ fresh: true, owner });
      const droppedSessions = store.clearAll();
      const restoredSessions = store.restoreAll();

      const teachers = listTeachers().length;
      console.log(`[admin] backup restored: ${entries.length} files (${removed} removed), ${teachers} teachers, ${droppedSessions} live session(s) replaced by ${restoredSessions} restored`);
      res.json({
        ok: true,
        files: entries.length,
        removed,
        teachers,
        sessions: restoredSessions,
        revokedTokens: revoked,
      });
    } catch (e) {
      console.error('[admin] import failed:', e);
      res.status(500).json({ error: `Restore failed: ${e.message}` });
    }
  });

  return router;
}
