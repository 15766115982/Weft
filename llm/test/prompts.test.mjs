import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, makeKb } from './helpers.mjs';
import { resolvePrompt, initPrompts, listPrompts } from '../lib/prompts.mjs';

test('initPrompts copies defaults into KB', () => {
  const kb = makeKb(tmpDir());
  const result = initPrompts(kb);
  assert.ok(result.results.length > 0);
  assert.ok(result.results.every((r) => r.status === 'created'));
  for (const r of result.results) {
    assert.ok(fs.existsSync(path.join(kb, '.kb', 'config', 'prompts', r.file)));
  }
});

test('initPrompts skips existing files unless forced', () => {
  const kb = makeKb(tmpDir());
  initPrompts(kb);
  const second = initPrompts(kb);
  assert.ok(second.results.every((r) => r.status === 'skipped'));
  const forced = initPrompts(kb, { force: true });
  assert.ok(forced.results.every((r) => r.status === 'overwritten'));
});

test('resolvePrompt prefers KB copy', () => {
  const kb = makeKb(tmpDir());
  initPrompts(kb);
  const p = path.join(kb, '.kb', 'config', 'prompts', 'chat.md');
  fs.writeFileSync(p, '# customized chat prompt\n');
  assert.match(resolvePrompt(kb, 'chat'), /customized/);
});

test('listPrompts returns default names', () => {
  const names = listPrompts();
  assert.ok(names.includes('chat'));
  assert.ok(names.includes('deep-research'));
});
