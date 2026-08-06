import assert from 'node:assert';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, makeKb, writeModelsConfig } from './helpers.mjs';
import { resolveKbRoot, loadModelsConfig, resolveSecret, ensureKbConfigDir } from '../lib/config.mjs';

test('resolveKbRoot prefers --kb over env', () => {
  const kb = makeKb(tmpDir());
  process.env.KB_PATH = '/does/not/exist';
  assert.strictEqual(resolveKbRoot(kb), kb);
  delete process.env.KB_PATH;
});

test('resolveKbRoot falls back to KB_PATH env var', () => {
  const kb = makeKb(tmpDir());
  process.env.KB_PATH = kb;
  assert.strictEqual(resolveKbRoot(undefined), kb);
  delete process.env.KB_PATH;
});

test('resolveKbRoot throws when missing', () => {
  delete process.env.KB_PATH;
  assert.throws(() => resolveKbRoot(undefined), /no knowledge base specified/);
});

test('loadModelsConfig returns null when absent', () => {
  const kb = makeKb(tmpDir());
  assert.strictEqual(loadModelsConfig(kb), null);
});

test('loadModelsConfig reads models.json', () => {
  const kb = makeKb(tmpDir());
  const cfg = { endpoint: 'https://x.openai.azure.com', deployment: 'd' };
  writeModelsConfig(kb, cfg);
  assert.deepStrictEqual(loadModelsConfig(kb), cfg);
});

test('resolveSecret reads env var', () => {
  process.env.WEFT_TEST_SECRET = 'shh';
  const s = resolveSecret('WEFT_TEST_SECRET');
  assert.strictEqual(s.name, 'WEFT_TEST_SECRET');
  assert.strictEqual(s.value, 'shh');
  delete process.env.WEFT_TEST_SECRET;
});

test('ensureKbConfigDir creates nested dir', () => {
  const kb = makeKb(tmpDir());
  ensureKbConfigDir(kb);
  assert.ok(fs.existsSync(path.join(kb, '.kb', 'config')));
});
