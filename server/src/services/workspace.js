import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACES_DIR } from '../config.js';

// Folders that are never shown in the file tree (they can be huge)
export const IGNORED = new Set([
  'node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist', '.next', '.pythonlibs',
]);

export function projectDir(project) {
  return path.join(WORKSPACES_DIR, project.userId, project.id);
}

/**
 * Resolve a client-supplied relative path inside the project root.
 * Throws if the path tries to escape the workspace (e.g. "../../etc/passwd").
 */
export function resolveSafe(root, relPath = '') {
  const cleaned = String(relPath).replace(/\\/g, '/').replace(/^\/+/, '');
  const full = path.resolve(root, cleaned);
  assertInside(root, full);
  assertRealPathInside(root, full);
  return full;
}

function outside() {
  const err = new Error('Path is outside the workspace');
  err.status = 400;
  return err;
}

function assertInside(root, target) {
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw outside();
}

/**
 * Code running in the project's container can create symlinks inside the workspace, e.g.
 * `ln -s /etc/passwd x`. The host must not follow them out, so the deepest existing part of the
 * path is resolved through symlinks and checked against the real workspace root.
 */
function assertRealPathInside(root, full) {
  let probe = full;
  for (;;) {
    try {
      fs.lstatSync(probe); // lstat: does not follow, so a dangling symlink still counts as existing
      break;
    } catch {
      const parent = path.dirname(probe);
      if (parent === probe) return;
      probe = parent;
    }
  }
  let real;
  try {
    real = fs.realpathSync(probe);
  } catch {
    throw outside(); // dangling symlink — refuse
  }
  assertInside(fs.realpathSync(root), real);
}

/** Same check for a path that is already absolute (used by the static preview). */
export function isInsideWorkspace(root, absPath) {
  try {
    assertInside(root, absPath);
    assertRealPathInside(root, absPath);
    return true;
  } catch {
    return false;
  }
}

export const toPosix = (p) => p.split(path.sep).join('/');

/** Build a nested { name, path, type, children } tree, folders first. */
export async function buildTree(root, rel = '') {
  const dir = path.join(root, rel);
  const entries = await fs.promises.readdir(dir, { withFileTypes: true });
  const nodes = [];
  for (const entry of entries) {
    if (IGNORED.has(entry.name)) continue;
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      nodes.push({
        name: entry.name,
        path: childRel,
        type: 'folder',
        children: await buildTree(root, childRel),
      });
    } else {
      nodes.push({ name: entry.name, path: childRel, type: 'file' });
    }
  }
  return nodes.sort((a, b) =>
    a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'folder' ? -1 : 1,
  );
}
