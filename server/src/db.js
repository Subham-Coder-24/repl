// Minimal JSON-file database. Good enough for local development;
// swap for Postgres/Mongo when you need concurrency or scale.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const DB_FILE = path.join(DATA_DIR, 'db.json');

const data = { users: [], projects: [] };

export function loadDb() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (fs.existsSync(DB_FILE)) {
    Object.assign(data, JSON.parse(fs.readFileSync(DB_FILE, 'utf8')));
  }
}

let writeChain = Promise.resolve();

/** Persist the current state. Writes are serialized so they never interleave. */
export function saveDb() {
  const snapshot = JSON.stringify(data, null, 2);
  const tmp = `${DB_FILE}.tmp`;
  writeChain = writeChain
    .then(() => fs.promises.writeFile(tmp, snapshot))
    .then(() => fs.promises.rename(tmp, DB_FILE))
    .catch((err) => console.error('[db] write failed:', err));
  return writeChain;
}

export const db = data;
