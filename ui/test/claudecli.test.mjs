// claudecli spawn-spec tests (real-env finding 2026-08-04): win32 spawns the
// claude.cmd shim through cmd.exe with verbatim quoting; other platforms spawn
// the plain binary. Shape assertions only — no real claude process is launched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { claudeSpawnSpec } from '../lib/claudecli.mjs';

test('win32: cmd.exe /d /s /c with verbatim quoting of every argv slot', { skip: process.platform !== 'win32' }, () => {
  const spec = claudeSpawnSpec(['-p', '--settings', 'D:\\my kb\\.kb\\ui\\agent-settings.json']);
  assert.equal(spec.command.toLowerCase().endsWith('cmd.exe'), true);
  assert.deepEqual(spec.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(spec.options.windowsVerbatimArguments, true);
  // canonical form: one outer quote pair cmd /s strips, quoted args inside —
  // paths with spaces survive cmd's re-parse
  assert.equal(
    spec.args[3],
    '""claude.cmd" "-p" "--settings" "D:\\my kb\\.kb\\ui\\agent-settings.json""',
  );
});

test('win32: quotes/newlines in argv are rejected (prompt must ride stdin)', { skip: process.platform !== 'win32' }, () => {
  assert.throws(() => claudeSpawnSpec(['say "hi"']), /must not contain quotes\/newlines/);
  assert.throws(() => claudeSpawnSpec(['line1\nline2']), /must not contain quotes\/newlines/);
});

test('non-win32: plain claude binary, no shell wrapping', { skip: process.platform === 'win32' }, () => {
  const spec = claudeSpawnSpec(['-p']);
  assert.equal(spec.command, 'claude');
  assert.deepEqual(spec.args, ['-p']);
  assert.deepEqual(spec.options, {});
});
