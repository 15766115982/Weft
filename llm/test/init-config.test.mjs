// init-config task: seeds .kb/config/models.json from provider templates.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpDir, makeKb } from './helpers.mjs';
import { run } from '../lib/tasks/init-config.mjs';

test('init-config seeds the azure template by default', async () => {
  const kb = makeKb(tmpDir());
  const r = await run({ kbRoot: kb, input: {} });
  assert.equal(r.status, 'created');
  const cfg = JSON.parse(fs.readFileSync(path.join(kb, '.kb', 'config', 'models.json'), 'utf8'));
  assert.equal(cfg.provider, 'azure');
  assert.ok(cfg.deployment);
  fs.rmSync(kb, { recursive: true, force: true });
});

test('init-config seeds the openai template on request', async () => {
  const kb = makeKb(tmpDir());
  const r = await run({ kbRoot: kb, input: { provider: 'openai' } });
  assert.equal(r.status, 'created');
  const cfg = JSON.parse(fs.readFileSync(path.join(kb, '.kb', 'config', 'models.json'), 'utf8'));
  assert.equal(cfg.provider, 'openai');
  assert.ok(cfg.model);
  fs.rmSync(kb, { recursive: true, force: true });
});

test('init-config never overwrites without force', async () => {
  const kb = makeKb(tmpDir());
  await run({ kbRoot: kb, input: {} });
  fs.writeFileSync(path.join(kb, '.kb', 'config', 'models.json'), '{"custom":true}');
  const skipped = await run({ kbRoot: kb, input: {} });
  assert.equal(skipped.status, 'skipped');
  assert.equal(JSON.parse(fs.readFileSync(path.join(kb, '.kb', 'config', 'models.json'), 'utf8')).custom, true);
  const forced = await run({ kbRoot: kb, input: { provider: 'openai', force: true } });
  assert.equal(forced.status, 'overwritten');
  assert.equal(JSON.parse(fs.readFileSync(path.join(kb, '.kb', 'config', 'models.json'), 'utf8')).provider, 'openai');
  fs.rmSync(kb, { recursive: true, force: true });
});

test('init-config rejects unknown providers', async () => {
  const kb = makeKb(tmpDir());
  await assert.rejects(run({ kbRoot: kb, input: { provider: 'bedrock' } }), /unknown provider/);
  fs.rmSync(kb, { recursive: true, force: true });
});
