// /api/admin - everything only the administrator can touch.
// Every route is gated by requireAuth('admin'), which answers 404 for anyone
// else, so the admin surface looks like it does not exist.
import { Router } from 'express';
import { requireAuth } from './auth.js';
import {
  createTeacher, deleteTeacher, generatePassword, listTeachers, resetTeacherPassword,
  setTeacherActive, updateTeacher, adminConfig, teachersFileStats, listTeacherFolders,
} from '../auth.js';
import { loadBank } from '../bank.js';

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

  return router;
}
