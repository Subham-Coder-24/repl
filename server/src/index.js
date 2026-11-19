import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import cors from 'cors';
import { PORT, CLIENT_ORIGIN, WORKSPACES_DIR } from './config.js';
import { loadDb, db } from './db.js';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import { projectDir, isInsideWorkspace } from './services/workspace.js';
import { attachSockets } from './sockets.js';
import { syncTemplates, listStacks } from './services/templates.js';
import { DOCKER_DIR } from './config.js';
import * as containers from './services/containers.js';

loadDb();
fs.mkdirSync(WORKSPACES_DIR, { recursive: true });

// Docker: sync stored container state, remove orphans, then build the runtime images in the
// background so the first "New project" doesn't wait for them. All non-fatal — if Docker is down
// the API still starts, and creating a project reports a clear error.
containers
  .reconcile()
  .then((r) => console.log(`Docker ready: ${r.containers} project container(s), ${r.orphansRemoved} orphan(s) removed`))
  .then(async () => {
    const runtimes = fs
      .readdirSync(DOCKER_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    for (const runtime of runtimes) await containers.ensureImage(runtime);
  })
  .catch((err) => console.warn('[docker]', err.message));
containers.startIdleReaper();

// Download the starter templates now so the first "New project" is fast (non-fatal if offline)
syncTemplates({ force: true })
  .then(() => console.log('Templates ready:', listStacks().map((s) => s.id).join(', ')))
  .catch((err) => console.warn('[templates]', err.message));

const app = express();
app.use(cors({ origin: CLIENT_ORIGIN }));
app.use(express.json({ limit: '5mb' }));

app.get('/api/health', (_req, res) => res.json({ ok: true }));
app.use('/api/auth', authRoutes);
app.use('/api/projects', projectRoutes);

// Live preview for static HTML projects. Project ids are random UUIDs, so this
// is unlisted rather than private — add auth here before deploying publicly.
app.use('/preview/:projectId', (req, res, next) => {
  const project = db.projects.find((p) => p.id === req.params.projectId);
  if (!project) return res.status(404).send('Project not found');
  const root = projectDir(project);

  // A symlink created inside the container must not expose host files through the preview
  let requested = '/';
  try {
    requested = decodeURIComponent(req.path);
  } catch {
    return res.status(400).send('Bad request');
  }
  if (!isInsideWorkspace(root, path.join(root, requested))) return res.status(403).send('Forbidden');

  express.static(root, { dotfiles: 'deny', etag: false, maxAge: 0 })(req, res, next);
});

app.use((err, _req, res, _next) => {
  const status = err.status || (err.code === 'ENOENT' ? 404 : 500);
  if (status === 500) console.error(err);
  res.status(status).json({ error: status === 404 ? 'Not found' : err.message });
});

const server = http.createServer(app);
attachSockets(server);

server.listen(PORT, () => {
  console.log(`API ready on http://localhost:${PORT}`);
  console.log(`Workspaces folder: ${WORKSPACES_DIR}`);
});

const shutdown = () => process.exit(0);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
