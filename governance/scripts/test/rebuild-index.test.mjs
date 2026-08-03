// rebuildIndex no-op guard: a byte-identical regeneration must not rewrite
// wiki/index.md nor append a log line (openwiki-inspired anti-churn).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { rebuildIndex } from '../lib/govern.mjs';
import { buildFrontmatter } from '../lib/frontmatter.mjs';

function makeKb() {
  const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-idx-'));
  fs.mkdirSync(path.join(kbRoot, 'wiki', 'topics'), { recursive: true });
  fs.mkdirSync(path.join(kbRoot, 'wiki', 'sources'), { recursive: true });
  fs.writeFileSync(path.join(kbRoot, 'wiki', 'topics', 'retry-budget.md'), [
    buildFrontmatter({
      type: 'topic', status: 'approved', title: 'Retry Budget',
      created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
      sources: ['raw/local/x1.md'],
    }),
    '',
    'Body.',
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(kbRoot, 'wiki', 'sources', 'local-x1.md'), [
    buildFrontmatter({
      type: 'source', status: 'approved', title: 'Source X1',
      created_at: '2026-08-01T00:00:00Z', updated_at: '2026-08-01T00:00:00Z',
      source_ref: 'raw/local/x1.md', source_url: 'file:///inbox/x1.md',
      source_version: '2026-08-01T00:00:00Z', content_hash: 'sha256:x',
    }),
    '',
    'Summary.',
  ].join('\n'), 'utf8');
  return kbRoot;
}

const indexPath = (kb) => path.join(kb, 'wiki', 'index.md');
const logPath = (kb) => path.join(kb, 'log.md');
const logLines = (kb) => fs.existsSync(logPath(kb)) ? fs.readFileSync(logPath(kb), 'utf8').trim().split('\n').length : 0;

test('rebuildIndex: second identical run skips write + log; change re-writes', () => {
  const kb = makeKb();
  try {
    const first = rebuildIndex(kb);
    assert.equal(first.skipped, false);
    assert.equal(first.topics, 1);
    assert.equal(first.sources, 1);
    assert.ok(fs.existsSync(indexPath(kb)));
    assert.equal(logLines(kb), 1);

    const contentAfterFirst = fs.readFileSync(indexPath(kb), 'utf8');
    const second = rebuildIndex(kb);
    assert.equal(second.skipped, true);
    assert.equal(second.topics, 1);
    assert.equal(fs.readFileSync(indexPath(kb), 'utf8'), contentAfterFirst);
    assert.equal(logLines(kb), 1, 'no log churn on no-op rebuild');

    // change a page title → regeneration differs → write + log resume
    const topicAbs = path.join(kb, 'wiki', 'topics', 'retry-budget.md');
    fs.writeFileSync(topicAbs, fs.readFileSync(topicAbs, 'utf8').replace('Retry Budget', 'Retry Budget v2'), 'utf8');
    const third = rebuildIndex(kb);
    assert.equal(third.skipped, false);
    assert.ok(fs.readFileSync(indexPath(kb), 'utf8').includes('Retry Budget v2'));
    assert.equal(logLines(kb), 2);
  } finally {
    fs.rmSync(kb, { recursive: true, force: true });
  }
});
