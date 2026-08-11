// Frontend syntax guard (2026-08-12, audit follow-up): the 2026-08-11 blank-
// portal incident (govern.js had a literal newline inside a string literal)
// was invisible to every node unit test because none of them parse public/.
// Playwright catches it, but it needs a browser install and is not in the
// documented default regression — this test closes the gap at zero cost by
// running `node --check` (parse-only, no execution) over every public/**/*.js.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

function* walk(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* walk(p);
    else if (e.isFile() && e.name.endsWith('.js')) yield p;
  }
}

test('every public/**/*.js parses (node --check)', () => {
  const files = [...walk(PUBLIC_DIR)].filter((f) => !f.includes(`${path.sep}vendor${path.sep}`));
  assert.ok(files.length >= 10, `guard should cover the whole frontend, found only ${files.length} files`);
  const failures = [];
  for (const f of files) {
    try {
      execFileSync(process.execPath, ['--check', f], { stdio: ['ignore', 'ignore', 'pipe'] });
    } catch (err) {
      failures.push(`${path.relative(PUBLIC_DIR, f)}: ${String(err.stderr).split('\n')[0]}`);
    }
  }
  assert.deepEqual(failures, [], `unparseable frontend files:\n${failures.join('\n')}`);
});
