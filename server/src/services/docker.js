// Thin wrapper around the Docker CLI. Arguments are always passed as an argv array — never through a
// shell — so nothing a user types can alter the docker command itself.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { DOCKER_CMD, IS_WINDOWS } from '../config.js';

const [DOCKER_FILE, ...DOCKER_PREFIX] = DOCKER_CMD;

/** argv for starting the docker CLI with these args (used by node-pty for interactive terminals). */
export const dockerArgv = (args) => ({ file: DOCKER_FILE, args: [...DOCKER_PREFIX, ...args] });

/**
 * Translate a host path into the path the Docker daemon sees.
 * Linux/macOS: unchanged. Windows + WSL: C:\a\b -> /mnt/c/a/b, \\wsl.localhost\Ubuntu\home\x -> /home/x
 */
export function toDockerPath(hostPath) {
  if (!IS_WINDOWS) return path.resolve(hostPath);
  const p = path.resolve(hostPath);
  let m = /^([a-zA-Z]):[\\/](.*)$/.exec(p);
  if (m) return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`;
  m = /^\\\\(?:wsl\.localhost|wsl\$)\\[^\\]+\\(.*)$/i.exec(p);
  if (m) return `/${m[1].replace(/\\/g, '/')}`;
  throw new Error(`Cannot map "${p}" into WSL — keep workspaces on a local drive`);
}

/**
 * Run `docker <args>` and always resolve with { code, stdout, stderr, timedOut, truncated }
 * (a non-zero exit code is a result, not an exception). Rejects only if docker cannot be started.
 */
export function dockerRun(args, { timeoutMs = 60_000, maxBytes = 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(DOCKER_FILE, [...DOCKER_PREFIX, ...args], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let truncated = false;

    const take = (current, chunk) => {
      const next = current + chunk.toString('utf8');
      if (next.length <= maxBytes) return next;
      truncated = true;
      return next.slice(0, maxBytes);
    };
    child.stdout.on('data', (d) => (stdout = take(stdout, d)));
    child.stderr.on('data', (d) => (stderr = take(stderr, d)));

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);

    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new Error(`Docker is not available (${err.message}). Is Docker running?`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : code, stdout, stderr, timedOut, truncated });
    });
  });
}

/** Like dockerRun but throws a readable error on a non-zero exit code. */
export async function docker(args, opts) {
  const res = await dockerRun(args, opts);
  if (res.code !== 0) {
    const detail = (res.stderr || res.stdout).trim().split('\n').slice(-3).join(' ');
    const err = new Error(res.timedOut ? 'Docker command timed out' : detail || `docker exited with ${res.code}`);
    err.result = res;
    throw err;
  }
  return res;
}
