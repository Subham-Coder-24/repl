import crypto from 'node:crypto';
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

// ---------- Docker (every project runs in its own container) ----------
// On Windows the Docker engine lives in WSL, so the CLI is invoked as `wsl.exe --exec docker`.
// Override with DOCKER_CMD (space-separated), e.g. DOCKER_CMD="docker" or "wsl.exe -d Ubuntu --exec docker".
export const DOCKER_CMD = (
  process.env.DOCKER_CMD || (IS_WINDOWS ? 'wsl.exe --exec docker' : 'docker')
)
  .split(/\s+/)
  .filter(Boolean);
export const DOCKER_DIR = path.resolve(SERVER_ROOT, '..', 'docker'); // Dockerfile per runtime
export const IMAGE_PREFIX = process.env.IMAGE_PREFIX || 'codespace';
// Containers are labelled with this id, and the startup cleanup only ever touches containers carrying it.
// Two backends sharing one Docker daemon (e.g. dev and test) therefore never delete each other's containers.
// Defaults to a hash of the data folder; set CODESPACE_INSTANCE to pin it.
export const INSTANCE_ID =
  process.env.CODESPACE_INSTANCE ||
  crypto.createHash('sha1').update(DATA_DIR).digest('hex').slice(0, 12);
export const DOCKER_NETWORK = process.env.DOCKER_NETWORK || 'codespace-projects';
export const CONTAINER_UID = process.env.CONTAINER_UID || '1000';
export const CONTAINER_MEMORY = process.env.CONTAINER_MEMORY || '1g';
export const CONTAINER_CPUS = process.env.CONTAINER_CPUS || '1';
export const CONTAINER_PIDS = process.env.CONTAINER_PIDS || '512';
export const CONTAINER_IDLE_MINUTES = Number(process.env.CONTAINER_IDLE_MINUTES) || 30;
export const EXEC_TIMEOUT_SECONDS = Number(process.env.EXEC_TIMEOUT_SECONDS) || 30;
export const PYTHON_CMD = process.env.PYTHON_CMD || (IS_WINDOWS ? 'python' : 'python3');
