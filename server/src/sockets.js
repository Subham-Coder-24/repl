// Real-time channel for a workspace: interactive terminal, Run output, file-change events.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { Server } from 'socket.io';
import { CLIENT_ORIGIN, IS_WINDOWS } from './config.js';
import { db } from './db.js';
import { verifyToken } from './middleware/auth.js';
import { projectDir, IGNORED } from './services/workspace.js';
import { getRunConfig } from './services/templates.js';
import { killTree } from './services/runner.js';

// node-pty gives a real terminal (colors, prompts, arrow keys). Fall back to plain pipes if
// its native binary is missing on this machine.
let pty = null;
try {
  pty = createRequire(import.meta.url)('node-pty');
} catch {
  console.warn('[terminal] node-pty unavailable, using basic pipe-based shell');
}

const SHELL = IS_WINDOWS ? 'powershell.exe' : process.env.SHELL || 'bash';
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

    // ---------- Terminal (one shell per browser tab) ----------
    let term = null;

    socket.on('terminal:start', ({ cols = 80, rows = 24 } = {}) => {
      if (term) return;
      term = pty ? startPty(cwd, cols, rows) : startPipeShell(cwd);
      socket.emit('terminal:mode', { pty: Boolean(pty) });
      term.onData((d) => socket.emit('terminal:output', d));
      term.onExit(() => {
        socket.emit('terminal:output', '\r\n\x1b[33m[shell exited — reopen the terminal]\x1b[0m\r\n');
        term = null;
      });
    });
    socket.on('terminal:input', (data) => term?.write(data));
    socket.on('terminal:resize', ({ cols, rows }) => {
      if (cols > 0 && rows > 0) term?.resize(cols, rows);
    });

    // ---------- Run / Stop buttons: they just type into the terminal ----------
    socket.on('run:start', () => {
      const { command } = getRunConfig(project, cwd);
      if (!term || !command) return;
      term.write('\x03'); // interrupt whatever is running / clear a half-typed line
      setTimeout(() => term?.write(`${command}\r`), 150);
    });
    socket.on('run:stop', () => term?.write('\x03'));

    socket.on('disconnect', () => {
      term?.kill();
      term = null;
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

function startPty(cwd, cols, rows) {
  // -ExecutionPolicy Bypass applies to this shell only; without it npm.ps1 is blocked on many Windows setups
  const proc = pty.spawn(SHELL, IS_WINDOWS ? ['-NoLogo', '-ExecutionPolicy', 'Bypass'] : [], {
    name: 'xterm-256color',
    cols,
    rows,
    cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  return {
    onData: (cb) => proc.onData(cb),
    onExit: (cb) => proc.onExit(cb),
    write: (d) => proc.write(d),
    resize: (c, r) => proc.resize(c, r),
    kill: () => killTree(proc.pid),
  };
}

// Fallback: no TTY, so the client echoes keystrokes and sends whole lines.
function startPipeShell(cwd) {
  const args = IS_WINDOWS ? ['/Q', '/K'] : ['-i'];
  const proc = spawn(IS_WINDOWS ? 'cmd.exe' : SHELL, args, { cwd, env: process.env });
  const listeners = [];
  const emit = (d) => listeners.forEach((cb) => cb(d.toString().replace(/\r?\n/g, '\r\n')));
  proc.stdout.on('data', emit);
  proc.stderr.on('data', emit);
  return {
    onData: (cb) => listeners.push(cb),
    onExit: (cb) => proc.on('close', cb),
    write: (d) => proc.stdin.writable && proc.stdin.write(d),
    resize: () => {},
    kill: () => killTree(proc.pid),
  };
}
