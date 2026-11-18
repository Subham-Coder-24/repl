import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, saveDb } from '../db.js';
import { PREVIEW_PORT_START } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { STACKS, listStacks, scaffoldProject, getRunConfig } from '../services/templates.js';
import { projectDir, resolveSafe, buildTree } from '../services/workspace.js';
import { closeProjectSessions } from '../sockets.js';

const router = Router();
router.use(requireAuth);

// Wrap async handlers so thrown errors reach the error middleware
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MAX_FILE_BYTES = 2 * 1024 * 1024;

function nextPreviewPort() {
  const used = new Set(db.projects.map((p) => p.port));
  let port = PREVIEW_PORT_START;
  while (used.has(port)) port++;
  return port;
}

const withEntry = (p) => ({ ...p, entry: STACKS[p.stack]?.entry });

router.get('/stacks', (_req, res) => res.json({ stacks: listStacks() }));

router.get('/', (req, res) => {
  const projects = db.projects
    .filter((p) => p.userId === req.user.id)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map(withEntry);
  res.json({ projects });
});

router.post(
  '/',
  wrap(async (req, res) => {
    const name = String(req.body?.name || '').trim();
    const stack = String(req.body?.stack || '');
    if (!name || name.length > 50) {
      return res.status(400).json({ error: 'Project name is required (max 50 characters)' });
    }
    if (!STACKS[stack]) return res.status(400).json({ error: 'Pick a valid tech stack' });

    const now = new Date().toISOString();
    const project = {
      id: crypto.randomUUID(),
      userId: req.user.id,
      name,
      stack,
      port: nextPreviewPort(),
      createdAt: now,
      updatedAt: now,
    };
    const dir = projectDir(project);
    await fs.promises.mkdir(dir, { recursive: true });
    await scaffoldProject(dir, stack);

    db.projects.push(project);
    await saveDb();
    res.status(201).json({ project: withEntry(project) });
  }),
);

// ---- Everything below works on a single project owned by the user ----

router.param('id', (req, res, next, id) => {
  const project = db.projects.find((p) => p.id === id && p.userId === req.user.id);
  if (!project) return res.status(404).json({ error: 'Project not found' });
  req.project = project;
  req.root = projectDir(project);
  next();
});

const touch = (project) => {
  project.updatedAt = new Date().toISOString();
  saveDb();
};

router.get('/:id', (req, res) => {
  const { previewUrl } = getRunConfig(req.project, req.root);
  res.json({ project: withEntry(req.project), previewUrl });
});

router.delete(
  '/:id',
  wrap(async (req, res) => {
    closeProjectSessions(req.project.id);
    // On Windows, killed shells/watchers may hold the folder for a moment — retry on EBUSY
    await fs.promises.rm(req.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    db.projects.splice(db.projects.indexOf(req.project), 1);
    await saveDb();
    res.status(204).end();
  }),
);

router.get(
  '/:id/tree',
  wrap(async (req, res) => {
    res.json({ tree: await buildTree(req.root) });
  }),
);

router.get(
  '/:id/file',
  wrap(async (req, res) => {
    const full = resolveSafe(req.root, req.query.path);
    const stat = await fs.promises.stat(full);
    if (!stat.isFile()) return res.status(400).json({ error: 'Not a file' });
    if (stat.size > MAX_FILE_BYTES) return res.status(413).json({ error: 'File too large' });
    res.json({ path: req.query.path, content: await fs.promises.readFile(full, 'utf8') });
  }),
);

router.put(
  '/:id/file',
  wrap(async (req, res) => {
    const { path: relPath, content } = req.body || {};
    if (typeof content !== 'string') return res.status(400).json({ error: 'content is required' });
    const full = resolveSafe(req.root, relPath);
    await fs.promises.mkdir(path.dirname(full), { recursive: true });
    await fs.promises.writeFile(full, content);
    touch(req.project);
    res.json({ ok: true });
  }),
);

// Create a file or folder: { path, type: 'file' | 'folder' }
router.post(
  '/:id/fs',
  wrap(async (req, res) => {
    const { path: relPath, type } = req.body || {};
    if (!relPath) return res.status(400).json({ error: 'path is required' });
    const full = resolveSafe(req.root, relPath);
    if (fs.existsSync(full)) return res.status(409).json({ error: 'Already exists' });
    if (type === 'folder') {
      await fs.promises.mkdir(full, { recursive: true });
    } else {
      await fs.promises.mkdir(path.dirname(full), { recursive: true });
      await fs.promises.writeFile(full, '');
    }
    touch(req.project);
    res.status(201).json({ ok: true });
  }),
);

// Rename / move: { from, to }
router.patch(
  '/:id/fs',
  wrap(async (req, res) => {
    const { from, to } = req.body || {};
    const src = resolveSafe(req.root, from);
    const dest = resolveSafe(req.root, to);
    if (src === req.root) return res.status(400).json({ error: 'Cannot rename the project root' });
    if (fs.existsSync(dest)) return res.status(409).json({ error: 'Target already exists' });
    await fs.promises.mkdir(path.dirname(dest), { recursive: true });
    await fs.promises.rename(src, dest);
    touch(req.project);
    res.json({ ok: true });
  }),
);

router.delete(
  '/:id/fs',
  wrap(async (req, res) => {
    const full = resolveSafe(req.root, req.query.path);
    if (full === req.root) return res.status(400).json({ error: 'Cannot delete the project root' });
    await fs.promises.rm(full, { recursive: true, force: true });
    touch(req.project);
    res.status(204).end();
  }),
);

export default router;
