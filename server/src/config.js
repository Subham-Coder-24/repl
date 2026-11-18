import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export const SERVER_ROOT = path.resolve(__dirname, '..');
export const PORT = Number(process.env.PORT) || 4000;
export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
export const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

// Every project is created on disk at <WORKSPACES_DIR>/<userId>/<projectId>
export const WORKSPACES_DIR = path.resolve(
  process.env.WORKSPACES_DIR || path.join(SERVER_ROOT, 'workspaces'),
);
export const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(SERVER_ROOT, 'data'));

// Starter projects are copied from this git repo (a URL or a local path) when a project is created
export const TEMPLATE_REPO_URL =
  process.env.TEMPLATE_REPO_URL || 'https://github.com/Subham-Coder-24/template-repl.git';
export const TEMPLATE_REPO_BRANCH = process.env.TEMPLATE_REPO_BRANCH || 'main';
export const TEMPLATE_CACHE_DIR = path.resolve(
  process.env.TEMPLATE_CACHE_DIR || path.join(DATA_DIR, 'template-cache'),
);

// Dev servers started by "Run" (e.g. React/Vite) get a port from this range
export const PREVIEW_PORT_START = Number(process.env.PREVIEW_PORT_START) || 5300;

export const IS_WINDOWS = process.platform === 'win32';
export const PYTHON_CMD = process.env.PYTHON_CMD || (IS_WINDOWS ? 'python' : 'python3');
