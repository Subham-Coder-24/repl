import fs from 'node:fs';
import path from 'node:path';
import { WORKSPACES_DIR } from '../config.js';

// Folders that are never shown in the file tree (they can be huge)
export const IGNORED = new Set(['node_modules', '.git', '__pycache__', '.venv', 'venv', 'dist']);

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
  const rel = path.relative(root, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    const err = new Error('Path is outside the workspace');
    err.status = 400;
    throw err;
  }
  return full;
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
