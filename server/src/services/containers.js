// Per-project Docker containers. Every project gets exactly one container (`codespace-<projectId>`)
// that mounts only that project's workspace. All user code — terminal, Run, npm, pip — runs in it;
// nothing user-supplied is ever executed on the host.
import fs from 'node:fs';
import path from 'node:path';
import { db, saveDb } from '../db.js';
import {
  CONTAINER_CPUS,
  CONTAINER_IDLE_MINUTES,
  CONTAINER_MEMORY,
  CONTAINER_PIDS,
  CONTAINER_UID,
  DOCKER_DIR,
  DOCKER_NETWORK,
  EXEC_TIMEOUT_SECONDS,
  IMAGE_PREFIX,
  INSTANCE_ID,
  IS_WINDOWS,
} from '../config.js';
import { docker, dockerArgv, dockerRun, toDockerPath } from './docker.js';
import { getStack } from './templates.js';
import { projectDir } from './workspace.js';

const RUNTIME_RE = /^[a-z0-9_-]+$/;
const nameOf = (project) => `codespace-${project.id}`;
const imageOf = (runtime) => `${IMAGE_PREFIX}/${runtime}:latest`;

// ---------------------------------------------------------------- per-project lock
// Lifecycle operations on one project run one at a time, so two requests can never create duplicates.
const locks = new Map();
function withLock(projectId, fn) {
  const tail = locks.get(projectId) || Promise.resolve();
  const run = tail.then(fn);
  const next = run.catch(() => {});
  locks.set(projectId, next);
  next.then(() => locks.get(projectId) === next && locks.delete(projectId));
  return run;
}

// ---------------------------------------------------------------- images
function runtimeOf(project) {
  let runtime = 'node';
  try {
    runtime = getStack(project.stack)?.runtime || 'node';
  } catch {
    /* templates unavailable — fall back to the default runtime */
  }
  if (!RUNTIME_RE.test(runtime) || !fs.existsSync(path.join(DOCKER_DIR, runtime, 'Dockerfile'))) {
    throw new Error(`No Docker runtime "${runtime}" (expected docker/${runtime}/Dockerfile)`);
  }
  return runtime;
}

const builds = new Map();
/** Build the runtime image the first time it is needed. */
export function ensureImage(runtime) {
  if (builds.has(runtime)) return builds.get(runtime);
  const tag = imageOf(runtime);
  const promise = (async () => {
    const found = await dockerRun(['image', 'inspect', '--format', '{{.Id}}', tag]);
    if (found.code === 0) return tag;
    console.log(`[docker] building ${tag} — first run only, this can take a few minutes`);
    await docker(['build', '--pull', '-t', tag, toDockerPath(path.join(DOCKER_DIR, runtime))], {
      timeoutMs: 20 * 60_000,
      maxBytes: 64 * 1024,
    });
    console.log(`[docker] built ${tag}`);
    return tag;
  })().catch((err) => {
    builds.delete(runtime);
    throw err;
  });
  builds.set(runtime, promise);
  return promise;
}

// Projects share one bridge network with inter-container communication disabled, so a project
// can reach the internet (npm, pip) but not other projects' containers.
let networkReady = null;
function ensureNetwork() {
  networkReady ||= (async () => {
    const found = await dockerRun(['network', 'inspect', DOCKER_NETWORK]);
    if (found.code !== 0) {
      await docker([
        'network', 'create', '--driver', 'bridge',
        '-o', 'com.docker.network.bridge.enable_icc=false',
        DOCKER_NETWORK,
      ]);
    }
  })().catch((err) => {
    networkReady = null;
    throw err;
  });
  return networkReady;
}

// ---------------------------------------------------------------- inspect / bookkeeping
async function inspect(name) {
  const res = await dockerRun([
    'inspect', '--format', '{{.Id}}|{{.State.Status}}|{{.Config.Image}}|{{.State.ExitCode}}', name,
  ]);
  if (res.code !== 0) {
    if (/no such (object|container)/i.test(res.stderr)) return null;
    throw new Error(res.stderr.trim() || 'docker inspect failed');
  }
  const [id, status, image, exitCode] = res.stdout.trim().split('|');
  return { id, status, image, exitCode: Number(exitCode) };
}

const activity = new Map(); // projectId -> last activity (ms)
const sessions = new Map(); // projectId -> open terminal count

export const touch = (projectId) => activity.set(projectId, Date.now());
export function sessionOpened(projectId) {
  sessions.set(projectId, (sessions.get(projectId) || 0) + 1);
  touch(projectId);
}
export function sessionClosed(projectId) {
  sessions.set(projectId, Math.max(0, (sessions.get(projectId) || 1) - 1));
  touch(projectId);
}

function record(project, info, runtime) {
  const prev = project.container || {};
  project.container = {
    id: info?.id ?? prev.id ?? null,
    name: nameOf(project),
    status: info?.status ?? 'missing',
    image: info?.image ?? prev.image ?? imageOf(runtime || 'node'),
    workspacePath: projectDir(project),
    createdAt: prev.createdAt || new Date().toISOString(),
    lastActivityAt: new Date(activity.get(project.id) || Date.now()).toISOString(),
  };
  saveDb();
  return project.container;
}

// ---------------------------------------------------------------- lifecycle
async function create(project, runtime) {
  const image = await ensureImage(runtime);
  await ensureNetwork();

  const workspace = projectDir(project);
  await fs.promises.mkdir(workspace, { recursive: true });
  const mountSource = toDockerPath(workspace);
  if (/[:,]/.test(mountSource)) throw new Error('The workspace path must not contain ":" or ","');

  const uid = String(CONTAINER_UID);
  await docker([
    'create',
    '--name', nameOf(project),
    '--hostname', 'codespace',
    '--init', // reap zombie processes
    // ---- privileges
    '--user', `${uid}:${uid}`,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges',
    '--read-only',
    '--tmpfs', '/tmp:rw,nosuid,nodev,size=512m',
    '--tmpfs', `/home/dev:rw,nosuid,nodev,size=512m,uid=${uid},gid=${uid},mode=0755`,
    // ---- resources
    '--memory', CONTAINER_MEMORY,
    '--memory-swap', CONTAINER_MEMORY, // no swap
    '--cpus', String(CONTAINER_CPUS),
    '--pids-limit', String(CONTAINER_PIDS),
    // ---- network: isolated bridge; only this project's own port is published, on loopback only
    '--network', DOCKER_NETWORK,
    '--publish', `127.0.0.1:${project.port}:${project.port}`,
    // ---- the only host path the container can see is this project's workspace
    '--volume', `${mountSource}:/workspace`,
    '--workdir', '/workspace',
    '--log-opt', 'max-size=10m',
    '--log-opt', 'max-file=2',
    '--label', 'codespace.managed=true',
    '--label', `codespace.instance=${INSTANCE_ID}`,
    '--label', `codespace.project=${project.id}`,
    '--label', `codespace.user=${project.userId}`,
    '--env', `PORT=${project.port}`,
    image,
  ]);
}

async function startContainer(project, info) {
  if (info.status === 'paused') {
    await docker(['unpause', nameOf(project)]);
    return;
  }
  const res = await dockerRun(['start', nameOf(project)], { timeoutMs: 60_000 });
  if (res.code !== 0) {
    const stderr = res.stderr.trim();
    // The useful line is not always the last one, so look at all of it
    if (/port is already allocated|address already in use/i.test(stderr)) {
      throw new Error(`Port ${project.port} is already in use on this machine`);
    }
    const reason = stderr.split('\n').find((l) => l.trim()) || 'unknown error';
    throw new Error(`Could not start the environment: ${reason.replace(/^Error response from daemon: /, '')}`);
  }
}

/** Create the container if it doesn't exist and make sure it is running. Safe to call repeatedly. */
export function ensureRunning(project) {
  return withLock(project.id, async () => {
    const runtime = runtimeOf(project);
    let info = await inspect(nameOf(project));

    if (info?.status === 'dead') {
      await dockerRun(['rm', '-f', nameOf(project)]);
      info = null;
    }
    if (!info) {
      try {
        await create(project, runtime);
      } catch (err) {
        builds.delete(runtime); // in case the image was removed behind our back
        throw err;
      }
      info = await inspect(nameOf(project));
    }
    if (info.status !== 'running') {
      await startContainer(project, info);
      info = await inspect(nameOf(project));
      if (info?.status !== 'running') {
        const logs = await dockerRun(['logs', '--tail', '10', nameOf(project)]);
        throw new Error(`Environment stopped right after starting: ${(logs.stderr || logs.stdout).trim()}`);
      }
    }
    touch(project.id);
    return record(project, info, runtime);
  });
}

export function stop(project) {
  return withLock(project.id, async () => {
    const info = await inspect(nameOf(project));
    if (info && info.status !== 'exited' && info.status !== 'created') {
      await docker(['stop', '--time', '5', nameOf(project)], { timeoutMs: 30_000 });
    }
    return record(project, await inspect(nameOf(project)));
  });
}

export async function restart(project) {
  await stop(project);
  return ensureRunning(project);
}

export async function status(project) {
  const info = await inspect(nameOf(project));
  return record(project, info);
}

/** Delete the container (and, on Linux, the files it created, which may be owned by the container user). */
export function remove(project) {
  return withLock(project.id, async () => {
    const info = await inspect(nameOf(project));
    if (info?.status === 'running' && !IS_WINDOWS) {
      await dockerRun(
        ['exec', '--user', String(CONTAINER_UID), nameOf(project), 'sh', '-c',
          'rm -rf /workspace/* /workspace/.[!.]* 2>/dev/null; true'],
        { timeoutMs: 120_000 },
      );
    }
    await dockerRun(['rm', '-f', nameOf(project)], { timeoutMs: 30_000 });
    delete project.container;
    activity.delete(project.id);
    sessions.delete(project.id);
  });
}

// ---------------------------------------------------------------- running commands inside the container
/**
 * argv for an interactive shell in the project's container (bash if present, otherwise sh).
 * Every process started from the shell inherits CODESPACE_SESSION, which is how closeSession finds them.
 */
export function shellCommand(project, sessionId) {
  return dockerArgv([
    'exec', '-it',
    '--user', String(CONTAINER_UID),
    '--workdir', '/workspace',
    '--env', 'TERM=xterm-256color',
    '--env', `CODESPACE_SESSION=${sessionId}`,
    nameOf(project),
    'sh', '-c', 'if command -v bash >/dev/null 2>&1; then exec bash; else exec sh; fi',
  ]);
}

// Killing the local `docker exec` client does not end the process inside the container, so when a
// terminal closes we signal everything that belongs to its session (HUP, then KILL after 2s).
const CLOSE_SESSION_SCRIPT = [
  'for sig in HUP KILL; do',
  '  for d in /proc/[0-9]*; do',
  '    p=${d#/proc/}; [ "$p" = "$$" ] && continue',
  '    if tr "\\0" "\\n" < "$d/environ" 2>/dev/null | grep -qx "CODESPACE_SESSION=$1"; then kill -$sig "$p" 2>/dev/null; fi',
  '  done',
  '  if [ "$sig" = HUP ]; then sleep 2; fi',
  'done',
].join('\n');

export async function closeSession(project, sessionId) {
  if (!/^[0-9a-f-]{36}$/.test(sessionId)) return;
  await dockerRun(
    ['exec', '--user', String(CONTAINER_UID), nameOf(project), 'sh', '-c', CLOSE_SESSION_SCRIPT, 'sh', sessionId],
    { timeoutMs: 15_000 },
  ).catch(() => {}); // container may already be gone
}

/** Run one non-interactive command inside the container with a hard timeout. */
export async function exec(project, command, { timeoutSec = EXEC_TIMEOUT_SECONDS } = {}) {
  await ensureRunning(project);
  touch(project.id);
  const seconds = Math.min(Math.max(Math.floor(Number(timeoutSec)) || EXEC_TIMEOUT_SECONDS, 1), 300);
  // `timeout` inside the container kills the process tree; the outer timer only guards the docker client.
  const res = await dockerRun(
    ['exec', '--user', String(CONTAINER_UID), '--workdir', '/workspace', nameOf(project),
      'timeout', '-k', '5', String(seconds), 'sh', '-c', command],
    { timeoutMs: (seconds + 15) * 1000 },
  );
  return {
    exitCode: res.code,
    stdout: res.stdout,
    stderr: res.stderr,
    timedOut: res.timedOut || res.code === 124,
    truncated: res.truncated,
  };
}

// ---------------------------------------------------------------- startup reconciliation & housekeeping
/** Sync stored container state with Docker and remove containers whose project no longer exists. */
export async function reconcile() {
  const res = await dockerRun([
    'ps', '-a', '--filter', `label=codespace.instance=${INSTANCE_ID}`,
    '--format', '{{.Names}}|{{.Label "codespace.project"}}|{{.State}}',
  ]);
  if (res.code !== 0) throw new Error(res.stderr.trim() || 'docker ps failed');

  const seen = new Set();
  let removed = 0;
  for (const line of res.stdout.split('\n').filter(Boolean)) {
    const [name, projectId, state] = line.split('|');
    const project = db.projects.find((p) => p.id === projectId);
    if (!project) {
      await dockerRun(['rm', '-f', name]);
      removed++;
      continue;
    }
    seen.add(projectId);
    if (project.container) project.container.status = state;
  }
  for (const project of db.projects) {
    if (project.container && !seen.has(project.id)) project.container.status = 'missing';
  }
  await saveDb();
  return { containers: seen.size, orphansRemoved: removed };
}

/** Stop containers nobody has used for CONTAINER_IDLE_MINUTES. They restart on the next terminal open. */
export function startIdleReaper() {
  const limit = CONTAINER_IDLE_MINUTES * 60_000;
  const everyMs = Math.min(5 * 60_000, Math.max(10_000, limit / 2));
  const timer = setInterval(async () => {
    for (const project of db.projects) {
      if (project.container?.status !== 'running' || sessions.get(project.id) > 0) continue;
      const last = activity.get(project.id) ?? Date.parse(project.container.lastActivityAt);
      if (Date.now() - last < limit) continue;
      try {
        await stop(project);
        console.log(`[docker] stopped idle environment of project ${project.id}`);
      } catch (err) {
        console.warn(`[docker] could not stop ${project.id}: ${err.message}`);
      }
    }
  }, everyMs);
  timer.unref();
}
