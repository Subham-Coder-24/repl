import { Router } from 'express';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { db, saveDb } from '../db.js';
import { PREVIEW_PORT_START } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import {
  getStack,
  listStacks,
  scaffoldProject,
  getRunConfig,
  syncTemplates,
} from '../services/templates.js';
import { projectDir, resolveSafe, buildTree } from '../services/workspace.js';
import { closeProjectSessions } from '../sockets.js';
import * as containers from '../services/containers.js';

const router = Router();
router.use(requireAuth);

// Wrap async handlers so thrown errors reach the error middleware
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

const MAX_FILE_BYTES = 2 * 1024 * 1024;

// Ports of projects that are being created right now. Without this, two simultaneous creates
// could pick the same port, and Docker can only publish a port once.
const reservedPorts = new Set();

function reservePreviewPort() {
  const used = new Set([...db.projects.map((p) => p.port), ...reservedPorts]);
  let port = PREVIEW_PORT_START;
  while (used.has(port)) port++;
  reservedPorts.add(port);
  return port;
}

// What the browser may see about a project: never host paths or Docker IDs
const publicContainer = (c) =>
  c && { status: c.status, image: c.image, createdAt: c.createdAt, lastActivityAt: c.lastActivityAt };

const withEntry = (p) => {
  const { container, ...rest } = p;
  const pub = { ...rest, container: publicContainer(container) };
  try {
    return { ...pub, entry: getStack(p.stack)?.entry };
  } catch {
    return pub; // templates unavailable — the project can still be opened
  }
};

// Docker problems are not the client's fault: report them as 503 with a readable message
const dockerRoute = (fn) => async (req, res, next) => {
  try {
    await fn(req, res, next);
  } catch (err) {
    if (err.status) return next(err);
    console.warn('[docker]', err.message);
    res.status(503).json({ error: err.message });
  }
};

router.get(
  '/stacks',
  wrap(async (_req, res) => {
    await syncTemplates(); // picks up new stacks pushed to the template repo
    res.json({ stacks: listStacks() });
  }),
);

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
    // Pull the latest templates from git (falls back to the cached copy if git is unreachable)
    try {
      await syncTemplates({ force: true });
    } catch (err) {
      return res.status(502).json({ error: err.message });
    }
    if (!getStack(stack)) return res.status(400).json({ error: 'Pick a valid tech stack' });

    const now = new Date().toISOString();
    const project = {
      id: crypto.randomUUID(),
      userId: req.user.id,
      name,
      stack,
      port: reservePreviewPort(),
      createdAt: now,
      updatedAt: now,
    };
    const dir = projectDir(project);
    try {
      await scaffoldProject(dir, stack); // 1. copy the template into workspaces/<user>/<project-uuid>
      await containers.ensureRunning(project); // 2. create + start the project's own container
    } catch (err) {
      // Roll everything back so a failed create leaves no folder, container or record behind
      await containers.remove(project).catch(() => {});
      await fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {});
      reservedPorts.delete(project.port);
      console.warn('[projects] create failed:', err.message);
      return res.status(503).json({
        error: `Could not set up the project environment: ${err.message}`,
      });
    }

    db.projects.push(project);
    reservedPorts.delete(project.port);
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
  const { command, previewUrl, previewType } = getRunConfig(req.project);
  res.json({ project: withEntry(req.project), previewUrl, previewType, runnable: Boolean(command) });
});

router.delete(
  '/:id',
  wrap(async (req, res) => {
    closeProjectSessions(req.project.id);
    try {
      await containers.remove(req.project); // stops and deletes the project's container
    } catch (err) {
      // Keep going: a container left behind is removed by the orphan cleanup at the next startup
      console.warn(`[docker] could not remove container of ${req.project.id}: ${err.message}`);
    }
    // On Windows, killed shells/watchers may hold the folder for a moment — retry on EBUSY
    await fs.promises.rm(req.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    db.projects.splice(db.projects.indexOf(req.project), 1);
    await saveDb();
    res.status(204).end();
  }),
);

// ---- Container lifecycle & command execution (always inside the project's own container) ----

router.get(
  '/:id/container',
  dockerRoute(async (req, res) => {
    res.json({ container: publicContainer(await containers.status(req.project)) });
  }),
);

for (const action of ['start', 'stop', 'restart']) {
  router.post(
    `/:id/container/${action}`,
    dockerRoute(async (req, res) => {
      const run = { start: containers.ensureRunning, stop: containers.stop, restart: containers.restart }[action];
      res.json({ container: publicContainer(await run(req.project)) });
    }),
  );
}

// Run one command in the container and return its output and exit code (hard timeout inside the container)
router.post(
  '/:id/exec',
  dockerRoute(async (req, res) => {
    const command = req.body?.command;
    if (typeof command !== 'string' || !command.trim() || command.length > 10_000) {
      return res.status(400).json({ error: 'command is required (max 10,000 characters)' });
    }
    res.json(await containers.exec(req.project, command, { timeoutSec: req.body?.timeoutSec }));
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
