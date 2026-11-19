// Real-time channel for a workspace: interactive terminal, Run/Stop, file-change events.
// The terminal is `docker exec` into the project's own container — the host never runs user code.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Server } from 'socket.io';
import { CLIENT_ORIGIN } from './config.js';
import { db } from './db.js';
import { verifyToken } from './middleware/auth.js';
import { projectDir, IGNORED } from './services/workspace.js';
import { getRunConfig } from './services/templates.js';
import { killTree } from './services/runner.js';
import * as containers from './services/containers.js';

// node-pty provides the pseudo-terminal that the docker CLI attaches to (colors, prompts, arrow keys)
let pty = null;
try {
  pty = createRequire(import.meta.url)('node-pty');
} catch {
  console.warn('[terminal] node-pty is not installed — project terminals are disabled');
}

const room = (projectId) => `project:${projectId}`;

const watchers = new Map(); // projectId -> { watcher, count }
let io = null;

/** Disconnect everyone from a project (kills their shells) and stop watching its folder. */
export function closeProjectSessions(projectId) {
  io?.in(room(projectId)).disconnectSockets(true);
  watchers.get(projectId)?.watcher?.close();
  watchers.delete(projectId);
}

export function attachSockets(httpServer) {
  io = new Server(httpServer, { cors: { origin: CLIENT_ORIGIN } });

  // Authenticate the socket and make sure the user owns the requested project
  io.use((socket, next) => {
    try {
      const user = verifyToken(socket.handshake.auth?.token);
      const project = db.projects.find(
        (p) => p.id === socket.handshake.auth?.projectId && p.userId === user.id,
      );
      if (!project) return next(new Error('Project not found'));
      socket.data.user = user;
      socket.data.project = project;
      next();
    } catch {
      next(new Error('Not authenticated'));
    }
  });

  io.on('connection', (socket) => {
    const { project } = socket.data;
    const cwd = projectDir(project);
    socket.join(room(project.id));
    watchProject(project.id, cwd);

    // ---------- Terminal (one shell per browser tab, inside the project's container) ----------
    let term = null;
    let starting = false;
    let closed = false;
    const say = (text) => socket.emit('terminal:output', text);

    socket.on('terminal:start', async ({ cols = 80, rows = 24 } = {}) => {
      if (term || starting) return;
      starting = true;
      try {
        if (!pty) throw new Error('Terminal support (node-pty) is not installed on the server');
        say('\x1b[90mStarting your environment…\x1b[0m\r\n');
        await containers.ensureRunning(project); // creates / starts the container if needed
        if (closed) return;

        const sessionId = crypto.randomUUID();
        const { file, args } = containers.shellCommand(project, sessionId);
        const proc = pty.spawn(file, args, { name: 'xterm-256color', cols, rows, env: process.env });
        term = {
          lastOutputAt: Date.now(),
          write: (d) => proc.write(d),
          resize: (c, r) => proc.resize(c, r),
          kill: () => {
            killTree(proc.pid); // the local docker client…
            containers.closeSession(project, sessionId); // …and the shell + its children inside the container
          },
        };
        containers.sessionOpened(project.id);
        socket.emit('terminal:mode', { pty: true });
        proc.onData((d) => {
          if (term) term.lastOutputAt = Date.now();
          containers.touch(project.id);
          socket.emit('terminal:output', d);
        });
        proc.onExit(({ exitCode }) => {
          // Whatever the reason the local docker client ended (user typed `exit`, wsl.exe died, …),
          // make sure nothing from this session is left running inside the container.
          containers.closeSession(project, sessionId);
          if (!term) return;
          console.log(`[terminal] shell of project ${project.id} ended (docker client exit code ${exitCode})`);
          term = null;
          containers.sessionClosed(project.id);
          say('\r\n\x1b[33m[shell exited — reopen the workspace to start a new one]\x1b[0m\r\n');
        });
      } catch (err) {
        say(`\r\n\x1b[31m${err.message}\x1b[0m\r\n`);
      } finally {
        starting = false;
      }
    });
    socket.on('terminal:input', (data) => term?.write(data));
    socket.on('terminal:resize', ({ cols, rows }) => {
      if (cols > 0 && rows > 0) term?.resize(cols, rows);
    });

    // ---------- Run / Stop buttons: they just type into the terminal ----------
    socket.on('run:start', () => {
      const { command } = getRunConfig(project);
      const current = term;
      if (!current || !command) return;
      current.write('\x03'); // interrupt whatever is running / clear a half-typed line
      // The terminal driver discards input that arrives together with Ctrl+C, so type the command
      // only once the shell has answered (redrawn its prompt) and gone quiet.
      const sentAt = Date.now();
      const wait = setInterval(() => {
        const quiet = Date.now() - current.lastOutputAt >= 200 && Date.now() - sentAt >= 200;
        if (term !== current) return clearInterval(wait); // terminal closed meanwhile
        if (quiet || Date.now() - sentAt > 2000) {
          clearInterval(wait);
          current.write(`${command}\r`);
        }
      }, 50);
    });
    socket.on('run:stop', () => term?.write('\x03'));

    socket.on('disconnect', (reason) => {
      if (term) console.log(`[terminal] browser disconnected from project ${project.id}: ${reason}`);
      closed = true;
      if (term) {
        term.kill();
        term = null;
        containers.sessionClosed(project.id);
      }
      unwatchProject(project.id);
    });
  });

  // ---------- File watcher: tell clients to refresh the tree when files change ----------
  function watchProject(projectId, dir) {
    const existing = watchers.get(projectId);
    if (existing) {
      existing.count++;
      return;
    }
    let timer = null;
    let watcher = null;
    try {
      watcher = fs.watch(dir, { recursive: true }, (_event, filename) => {
        const first = String(filename || '').split(/[\\/]/)[0];
        if (IGNORED.has(first)) return;
        clearTimeout(timer);
        timer = setTimeout(() => io.to(room(projectId)).emit('fs:changed'), 300);
      });
      watcher.on('error', () => {});
    } catch (err) {
      console.warn('[watch] cannot watch', dir, err.message);
    }
    watchers.set(projectId, { watcher, count: 1 });
  }

  function unwatchProject(projectId) {
    const entry = watchers.get(projectId);
    if (!entry || --entry.count > 0) return;
    entry.watcher?.close();
    watchers.delete(projectId);
  }

  return io;
}

