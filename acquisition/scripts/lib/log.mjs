// log.md governance log (contract §5): append-only, uniform prefix, grep-parseable.
// actor ∈ govern | review | acquire
import fs from 'node:fs';
import path from 'node:path';

export function appendLog(kbRoot, actor, action, target, note = '') {
  const ts = new Date().toISOString();
  const line = `## [${ts}] ${actor} | ${action} | ${target}${note ? ` | ${note}` : ''}\n`;
  fs.appendFileSync(path.join(kbRoot, 'log.md'), line, 'utf8');
}
