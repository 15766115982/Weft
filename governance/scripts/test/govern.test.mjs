// M2 tests (English-first): governance v1 (plan → apply-source → stale detection → orphan detection → rebuild-index)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { plan, applySourcePage, rebuildIndex } from '../lib/govern.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/frontmatter.mjs';

function makeKbWithRaws() {
  const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-gov-'));
  const rawDir = path.join(kbRoot, 'raw', 'local');
  fs.mkdirSync(rawDir, { recursive: true });
  const writeRaw = (name, title, version) => {
    const fm = buildFrontmatter({
      source: 'local', source_id: name, source_url: `file:///inbox/${name}.md`,
      source_version: version, pulled_at: version, content_hash: `sha256:${name}`,
      title, connector: 'local@1.0.0',
    });
    fs.writeFileSync(path.join(rawDir, `${name}.md`), fm + '\nBody text.\n', 'utf8');
    return `raw/local/${name}.md`;
  };
  return { kbRoot, writeRaw };
}

test('governance v1 end-to-end', () => {
  const { kbRoot, writeRaw } = makeKbWithRaws();
  const r1 = writeRaw('aaaa1111-pay', 'Payment Gateway Requirements', '2026-07-01T00:00:00Z');
  const r2 = writeRaw('bbbb2222-timeout', 'Session Timeout Policy', '2026-07-02T00:00:00Z');

  // 1. plan: two pending (new)
  let p = plan(kbRoot);
  assert.equal(p.pending.length, 2);
  assert.equal(p.orphaned_pages.length, 0);

  // 2. apply-source: mechanically generated frontmatter, always approved
  const res = applySourcePage(kbRoot, r1, '## Key Points\n\n- Supports timeout retries\n- Compensation strategy', { tags: ['payment', 'gateway'] });
  assert.equal(res.action, 'auto:create-source');
  const page = parseFrontmatter(fs.readFileSync(path.join(kbRoot, res.page), 'utf8'));
  assert.equal(page.fields.type, 'source');
  assert.equal(page.fields.status, 'approved');
  assert.equal(page.fields.source_ref, r1);
  assert.deepEqual(page.fields.tags, ['payment', 'gateway']);
  assert.match(page.body, /timeout retries/);

  // empty summary rejected
  assert.throws(() => applySourcePage(kbRoot, r2, '   '), /empty summary body/);

  applySourcePage(kbRoot, r2, '## Key Points\n\n- 30 minute timeout');

  // 3. plan again: everything up to date
  p = plan(kbRoot);
  assert.equal(p.pending.length, 0);

  // 4. raw version bump → stale detected; created_at preserved after re-apply
  const before = parseFrontmatter(fs.readFileSync(path.join(kbRoot, res.page), 'utf8')).fields.created_at;
  writeRaw('aaaa1111-pay', 'Payment Gateway Requirements', '2026-07-15T00:00:00Z');
  p = plan(kbRoot);
  assert.equal(p.pending.length, 1);
  assert.equal(p.pending[0].reason, 'stale');
  const res2 = applySourcePage(kbRoot, r1, '## Key Points\n\n- Supports timeout retries and compensation');
  assert.equal(res2.action, 'auto:update-source');
  const after = parseFrontmatter(fs.readFileSync(path.join(kbRoot, res2.page), 'utf8')).fields;
  assert.equal(after.created_at, before, 'created_at should be preserved');
  assert.equal(after.source_version, '2026-07-15T00:00:00Z');

  // 5. raw deleted → orphaned_pages detected (report only)
  fs.unlinkSync(path.join(kbRoot, r2));
  p = plan(kbRoot);
  assert.equal(p.orphaned_pages.length, 1);
  assert.equal(p.orphaned_pages[0].missing_raw, r2);

  // 6. rebuild-index: format per contract §3.4
  const idx = rebuildIndex(kbRoot);
  assert.equal(idx.sources, 2);
  const indexMd = fs.readFileSync(path.join(kbRoot, 'wiki', 'index.md'), 'utf8');
  assert.match(indexMd, /## Sources/);
  assert.match(indexMd, /- \[\[sources\/local-aaaa1111-pay\]\] — Payment Gateway Requirements\(local, 2026-07-15\)/);

  // 7. log: create×2 + update×1 + rebuild×1
  const log = fs.readFileSync(path.join(kbRoot, 'log.md'), 'utf8');
  assert.equal((log.match(/auto:create-source/g) || []).length, 2);
  assert.ok(log.includes('auto:update-source') && log.includes('auto:rebuild-index'));

  fs.rmSync(kbRoot, { recursive: true, force: true });
});

test('apply-source never re-approves a candidate source page (2026-08-12 candidate protection)', () => {
  const { kbRoot, writeRaw } = makeKbWithRaws();
  const r1 = writeRaw('cccc3333-manual', 'Manual Edit Doc', '2026-07-01T00:00:00Z');
  const res = applySourcePage(kbRoot, r1, '## Key Points\n\n- Original summary');
  assert.equal(res.action, 'auto:create-source');
  const pageAbs = path.join(kbRoot, res.page);

  // simulate a portal manual edit (whitelist ⑤): body rewritten, demoted to
  // candidate with a review_note — and the log line the portal appends
  const parsed = parseFrontmatter(fs.readFileSync(pageAbs, 'utf8'));
  const demoted = buildFrontmatter({ ...parsed.fields, status: 'candidate', review_note: 'manual edit via portal @ 2026-08-12' });
  fs.writeFileSync(pageAbs, demoted + '\nHuman-edited body.\n', 'utf8');
  fs.appendFileSync(path.join(kbRoot, 'log.md'),
    `## [2026-08-12T00:00:00Z] portal | candidate:manual | ${res.page} | manual edit via portal\n`, 'utf8');

  // a source-following update must NOT silently re-approve
  writeRaw('cccc3333-manual', 'Manual Edit Doc', '2026-07-20T00:00:00Z');
  const res2 = applySourcePage(kbRoot, r1, '## Key Points\n\n- Regenerated summary');
  assert.equal(res2.action, 'auto:update-source');
  const after = parseFrontmatter(fs.readFileSync(pageAbs, 'utf8')).fields;
  assert.equal(after.status, 'candidate', 're-apply must keep the pending-review candidate status');
  assert.equal(after.review_note, 'manual edit via portal @ 2026-08-12');
  assert.equal(after.source_version, '2026-07-20T00:00:00Z', 'content still follows the source');

  fs.rmSync(kbRoot, { recursive: true, force: true });
});
