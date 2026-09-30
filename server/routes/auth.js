// /api/auth - sign in, sign out, change password, who am I.
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { changePassword, login, logoutToken, verifyToken } from '../auth.js';

export const router = Router();

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  // tests sign in several accounts in one run; the real limit stays strict
  limit: process.env.NODE_ENV === 'test' ? 100 : 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many sign-in attempts. Please wait a minute and try again.' },
});

/**
 * Gate a route by role. Roles: 'teacher' | 'admin'.
 * Non-admins asking for admin pages get a plain 404 ("page not found"),
 * everything else gets a friendly 401.
 */
export function requireAuth(...roles) {
  const adminOnly = roles.length === 1 && roles[0] === 'admin';
  return (req, res, next) => {
    const token = req.get('x-teacher-token') || '';
    const auth = verifyToken(token);
    if (!auth || !roles.includes(auth.role)) {
      return res.status(adminOnly ? 404 : 401).json({ error: adminOnly ? 'Not found' : 'Please sign in again.' });
    }
    req.auth = auth;
    req.token = token;
    next();
  };
}

router.post('/login', loginLimiter, async (req, res) => {
  const { id, password } = req.body || {};
  try {
    const result = await login(id, password);
    if (result.error) return res.status(401).json({ error: result.error });
    res.json(result);
  } catch (e) {
    console.error('[auth] login failed:', e);
    res.status(500).json({ error: 'Sign-in failed. Please try again.' });
  }
});

router.post('/logout', (req, res) => {
  logoutToken(req.get('x-teacher-token') || (req.body && req.body.token));
  res.json({ ok: true });
});

router.get('/me', requireAuth('teacher', 'admin'), (req, res) => {
  const { role, id, name, mustChangePassword } = req.auth;
  res.json({ ok: true, role, id, name, mustChangePassword });
});

router.post('/change-password', requireAuth('teacher'), async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    const result = await changePassword(req.token, currentPassword, newPassword);
    if (result.error) return res.status(400).json({ error: result.error });
    res.json(result);
  } catch (e) {
    console.error('[auth] change-password failed:', e);
    res.status(500).json({ error: 'Could not change the password. Please try again.' });
  }
});
