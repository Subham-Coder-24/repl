// Starter projects live in a git repo (see TEMPLATE_REPO_URL): one folder per stack, described by
// templates.json at the repo root. The repo is cloned into a local cache and refreshed from git
// every time a project is created; if git is unreachable the last cached copy is used.
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PYTHON_CMD,
  TEMPLATE_REPO_URL,
  TEMPLATE_REPO_BRANCH,
  TEMPLATE_CACHE_DIR,
} from '../config.js';

const execFileAsync = promisify(execFile);
const git = (args) =>
  execFileAsync('git', args, {
    timeout: 60_000,
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }, // never hang waiting for a login prompt
  });

const MANIFEST = path.join(TEMPLATE_CACHE_DIR, 'templates.json');
const STACK_ID_RE = /^[a-zA-Z0-9_-]+$/;
const LIST_REFRESH_MS = 60_000;

const hasCache = () => fs.existsSync(MANIFEST);
let lastSync = 0;
let inFlight = null;

/**
 * Clone the template repo (first time) or fast-forward the cache to the latest commit.
 * Without `force`, a sync that happened in the last minute is reused.
 */
export function syncTemplates({ force = false } = {}) {
  if (inFlight) return inFlight;
  if (!force && hasCache() && Date.now() - lastSync < LIST_REFRESH_MS) return Promise.resolve();

  inFlight = (async () => {
    try {
      if (!fs.existsSync(path.join(TEMPLATE_CACHE_DIR, '.git'))) {
        fs.rmSync(TEMPLATE_CACHE_DIR, { recursive: true, force: true });
        fs.mkdirSync(path.dirname(TEMPLATE_CACHE_DIR), { recursive: true });
        await git(['clone', '--depth', '1', '--branch', TEMPLATE_REPO_BRANCH, TEMPLATE_REPO_URL, TEMPLATE_CACHE_DIR]);
      } else {
        await git(['-C', TEMPLATE_CACHE_DIR, 'fetch', '--depth', '1', 'origin', TEMPLATE_REPO_BRANCH]);
        await git(['-C', TEMPLATE_CACHE_DIR, 'reset', '--hard', 'FETCH_HEAD']);
      }
      lastSync = Date.now();
    } catch (err) {
      const reason = String(err.stderr || err.message).trim().split('\n').pop();
      if (!hasCache()) {
        throw new Error(`Could not download templates from ${TEMPLATE_REPO_URL}: ${reason}`);
      }
      console.warn(`[templates] git sync failed, using cached copy: ${reason}`);
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

let manifestCache = { mtime: 0, stacks: {} };

/** { stackId: { id, label, description, entry, run, preview } } for every stack whose folder exists. */
export function getManifest() {
  if (!hasCache()) throw new Error('Templates are not available yet — check TEMPLATE_REPO_URL');
  const { mtimeMs } = fs.statSync(MANIFEST);
  if (mtimeMs === manifestCache.mtime) return manifestCache.stacks;

  let raw;
  try {
    // Windows editors often save JSON with a BOM, which JSON.parse rejects
    raw = JSON.parse(fs.readFileSync(MANIFEST, 'utf8').replace(/^﻿/, ''));
  } catch (err) {
    throw new Error(`templates.json in the template repo is not valid JSON: ${err.message}`);
  }
  const stacks = {};
  for (const [id, def] of Object.entries(raw)) {
    if (!STACK_ID_RE.test(id) || !fs.existsSync(path.join(TEMPLATE_CACHE_DIR, id))) continue;
    stacks[id] = { id, label: id, description: '', ...def };
  }
  manifestCache = { mtime: mtimeMs, stacks };
  return stacks;
}

export const getStack = (id) => (Object.hasOwn(getManifest(), id) ? getManifest()[id] : undefined);

export function listStacks() {
  return Object.values(getManifest()).map(({ id, label, description }) => ({ id, label, description }));
}

/** Copy the stack's folder from the template repo into the new project directory. */
export async function scaffoldProject(dir, stackId) {
  const stack = getStack(stackId);
  if (!stack) throw new Error(`Unknown stack: ${stackId}`);
  await fs.promises.cp(path.join(TEMPLATE_CACHE_DIR, stackId), dir, {
    recursive: true,
    filter: (src) => path.basename(src) !== '.git',
  });
}

/**
 * What the "Run" button does for a project: { command, previewUrl, previewType }.
 * command is typed into the terminal; previewUrl is shown in the Preview pane.
 */
export function getRunConfig(project) {
  const stack = getStack(project.stack);
  if (!stack) return { command: null };
  const previewType = stack.preview === 'port' || stack.preview === 'static' ? stack.preview : null;

  const command = stack.run
    ? stack.run.replaceAll('{{PORT}}', String(project.port)).replaceAll('{{PYTHON}}', PYTHON_CMD)
    : null;

  let previewUrl;
  if (stack.preview === 'port') previewUrl = `http://127.0.0.1:${project.port}/`;
  if (stack.preview === 'static') previewUrl = `/preview/${project.id}/${stack.previewPath || 'index.html'}`;
  return { command, previewUrl, previewType };
}
