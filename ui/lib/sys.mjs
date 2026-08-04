// Small shared helpers for the portal's lib layer (review 2026-08-04: tail()
// and isGitRepo() each existed in two lib files verbatim).
import { execFileSync } from 'node:child_process';

/** Last n chars of a (possibly huge) job log. */
export function tail(s, n = 4000) {
  s = String(s ?? '');
  return s.length > n ? s.slice(-n) : s;
}

/** Version-management constraint: never assume the KB is a git repository. */
export function isGitRepo(kb) {
  try {
    execFileSync('git', ['-C', kb, 'rev-parse', '--is-inside-work-tree'],
      { stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 });
    return true;
  } catch { return false; }
}
