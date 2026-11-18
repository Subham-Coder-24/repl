import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db, saveDb } from '../db.js';
import { requireAuth, signToken } from '../middleware/auth.js';

const router = Router();

// Letters, numbers and . _ - @ — so plain names and email addresses both work
const USERNAME_RE = /^[a-zA-Z0-9._@-]{3,50}$/;

const publicUser = (u) => ({ id: u.id, username: u.username, createdAt: u.createdAt });

router.post('/register', async (req, res) => {
  const { username = '', password = '' } = req.body || {};
  if (!USERNAME_RE.test(username)) {
    return res
      .status(400)
      .json({
        error: 'Username must be 3-50 characters with no spaces (letters, numbers, . _ - @ allowed)',
      });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Password must be at least 6 characters' });
  }
  const exists = db.users.some((u) => u.username.toLowerCase() === username.toLowerCase());
  if (exists) return res.status(409).json({ error: 'Username is already taken' });

  const user = {
    id: crypto.randomUUID(),
    username,
    passwordHash: await bcrypt.hash(password, 10),
    createdAt: new Date().toISOString(),
  };
  db.users.push(user);
  await saveDb();
  res.status(201).json({ token: signToken(user), user: publicUser(user) });
});

router.post('/login', async (req, res) => {
  const { username = '', password = '' } = req.body || {};
  const user = db.users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Invalid username or password' });
  }
  res.json({ token: signToken(user), user: publicUser(user) });
});

router.get('/me', requireAuth, (req, res) => {
  const user = db.users.find((u) => u.id === req.user.id);
  if (!user) return res.status(401).json({ error: 'User no longer exists' });
  res.json({ user: publicUser(user) });
});

export default router;
