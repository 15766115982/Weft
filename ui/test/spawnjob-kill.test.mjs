// 2026-08-12 audit fix: spawnJob must expose job.kill — before this, every
// spawnJob-based job (pull/upload/detect/distill) ignored cancel while running.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnJob } from '../lib/jobs.mjs';

test('spawnJob exposes job.kill; killing a running child rejects the promise', async () => {
  const job = { log: '' };
  const p = spawnJob(job, process.execPath, ['-e', 'setTimeout(() => {}, 60000)']);
  assert.equal(typeof job.kill, 'function');
  job.kill();
  await assert.rejects(p, /exited/);
});
