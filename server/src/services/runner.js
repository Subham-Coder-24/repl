import { execFile } from 'node:child_process';
import { IS_WINDOWS } from '../config.js';

/** Kill a process and all of its children. */
export function killTree(pid) {
  if (!pid) return;
  if (IS_WINDOWS) {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], () => {});
  } else {
    try {
      process.kill(-pid, 'SIGKILL'); // negative pid = whole process group
    } catch {
      /* already gone */
    }
  }
}
