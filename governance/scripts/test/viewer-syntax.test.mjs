// Viewer frontend syntax guard (2026-08-12, same class as the ui/ guard):
// no viewer test executes or parses public/app.js — a syntax error there
// blanks the viewer with every node test green. `node --check` closes it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'viewer', 'public');

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.js')) yield p;
  }
}

test('every viewer public/**/*.js parses (node --check)', () => {
  const files = [...walk(PUBLIC_DIR)].filter((f) => !f.includes(`${path.sep}vendor${path.sep}`));
  assert.ok(files.length >= 1, 'viewer public/ should contain at least app.js');
  const failures = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      failures.push(`${path.relative(PUBLIC_DIR, f)}: ${String(err.stderr).split('\n')[0]}`);
    }
  }
  assert.deepEqual(failures, [], `unparseable viewer frontend files:\n${failures.join('\n')}`);
});
