// M3 tests (English-dominant, corpus 99%+ English; CJK kept as routing
// regression cases). Covers: porter stemming / phrases / sanitization / field
// filters / approved gate / per-page cap / graph expansion / read / lazy
// incremental rebuild
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { ensureFresh, openDb } from '../lib/store.mjs';
import { search } from '../lib/query.mjs';
import { readSection, chunkPage } from '../lib/chunk.mjs';
import { readWikiPage } from '../lib/readpage.mjs';
import { buildFrontmatter } from '../lib/frontmatter.mjs';

let kb;
function writePage(rel, fields, body) {
  const abs = path.join(kb, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, buildFrontmatter(fields) + '\n' + body, 'utf8');
}
const src = (id, over = {}) => ({
  type: 'source', status: 'approved', title: id, source_ref: `raw/local/${id}.md`,
  source_url: 'u', source_version: 'v1', content_hash: 'sha256:x',
  updated_at: '2026-07-01T00:00:00+08:00', ...over,
});

before(() => {
  kb = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-search-'));
  writePage('wiki/sources/local-pay.md', src('pay', { title: 'Payment Gateway Requirements', tags: ['payment'] }),
    '## Timeout Retries\n\nThe payment gateway supports timeout retries and compensation.\n\n## Compensation\n\nFailed orders enter the compensation queue.');
  writePage('wiki/sources/local-auth.md', src('auth', { title: 'Auth Service Design', tags: ['auth'] }),
    '## SSO\n\nThe auth service is based on OAuth2 and JWT tokens. See [[sources/local-pay]].');
  writePage('wiki/topics/payment.md', { type: 'topic', status: 'candidate', title: 'Payment Topic (candidate)', sources: ['raw/local/pay.md'] },
    '## Synthesis\n\nCandidate pages must not be indexed. payment payment payment.');
  ensureFresh(kb);
});

test('English terms hit via latin leg', () => {
  const r = search(kb, 'timeout retries');
  assert.deepEqual(r.routed.latin, ['timeout', 'retries']);
  assert.ok(r.preview.some(c => c.page === 'wiki/sources/local-pay.md'));
});

test('porter stemming: retry matches retries, compensate matches compensation', () => {
  const r1 = search(kb, 'retry');
  assert.ok(r1.preview.some(c => c.page === 'wiki/sources/local-pay.md'), 'retry should stem-match retries');
  const r2 = search(kb, 'compensate');
  assert.ok(r2.preview.some(c => c.page === 'wiki/sources/local-pay.md'), 'compensate should stem-match compensation');
});

test('quoted phrase + hyphen sanitization', () => {
  const r = search(kb, '"compensation queue"');
  assert.ok(r.preview.some(c => c.page === 'wiki/sources/local-pay.md'));
  assert.doesNotThrow(() => search(kb, 'sui-memory'));
  assert.equal(search(kb, 'nonexistent-term').preview.length, 0);
});

test('field filters: type/source/tag', () => {
  let r = search(kb, 'tag:auth');
  assert.equal(r.preview.length, 1);
  assert.equal(r.preview[0].page, 'wiki/sources/local-auth.md');
  r = search(kb, 'retries source:local');
  assert.ok(r.preview.length >= 1);
  r = search(kb, 'retries source:jira');
  assert.equal(r.preview.length, 0);
  r = search(kb, 'retries type:topic');
  assert.equal(r.preview.length, 0, 'candidate topic must not be visible');
});

test('≤2 snippets per page + candidate space on disk', () => {
  const r = search(kb, 'payment');
  for (const c of r.preview) assert.ok(c.snippet.length <= 220);
  const file = JSON.parse(fs.readFileSync(path.join(kb, r.candidates_file), 'utf8'));
  const perPage = {};
  for (const c of file.candidates) {
    perPage[c.page] = (perPage[c.page] || 0) + 1;
    assert.ok(perPage[c.page] <= 2, `${c.page} exceeds the per-page limit`);
  }
});

test('wikilink graph expansion (via:link)', () => {
  const r = search(kb, 'OAuth2');
  const link = r.preview.find(c => c.via === 'link');
  assert.ok(link, 'auth page outlink to local-pay should be graph-expanded');
  assert.equal(link.page, 'wiki/sources/local-pay.md');
});

test('provenance expansion: approved topic covers a hit source (via:provenance, forward + reverse)', () => {
  // ADR-0007: an approved topic's sources: frontmatter yields derived edges —
  // forward (topic→source) and read-time reverse (source→topic). A source hit
  // must pull in its covering topic tagged via:'provenance' (distinct from
  // authored via:'link').
  writePage('wiki/topics/pay-synthesis.md', {
    type: 'topic', status: 'approved', title: 'Pay Synthesis',
    sources: ['raw/local/pay.md'], updated_at: '2026-08-01T00:00:00Z',
  }, '## Umbrella\n\nSynthesis across the payment materials.');
  ensureFresh(kb);
  const r = search(kb, 'timeout');
  const prov = r.preview.find(c => c.via === 'provenance');
  assert.ok(prov, 'covering topic must be pulled in via provenance');
  assert.equal(prov.page, 'wiki/topics/pay-synthesis.md');
  // forward: the topic hit expands to its covered source ('synthesis' is only
  // in the topic body, so the source arrives solely via provenance, not search)
  const r2 = search(kb, 'synthesis');
  assert.ok(r2.preview.some(c => c.via === 'provenance' && c.page === 'wiki/sources/local-pay.md'),
    'topic hit expands to its covered source (forward)');
  fs.unlinkSync(path.join(kb, 'wiki', 'topics', 'pay-synthesis.md'));
  ensureFresh(kb);
});

test('read #anchor returns section', () => {
  const body = '## A\n\nfoo\n\n## B\n\nbar\n';
  assert.equal(readSection(body, 'B'), '## B\n\nbar\n');
  assert.equal(readSection(body), body);
  assert.throws(() => readSection(body, 'C'), /anchor not found/);
});

test('--within restricts scope', () => {
  const r = search(kb, 'payment', { within: ['wiki/sources/local-auth.md'] });
  assert.equal(r.preview.filter(c => c.via === 'search').length, 0);
});

test('CJK regression: long term → trigram, 2-char term → LIKE fallback', () => {
  writePage('wiki/sources/local-cjk.md', src('cjk', { title: 'CJK Regression Doc' }),
    '## 超时\n\n支付网关支持超时重试与补偿机制。');
  ensureFresh(kb);
  const long = search(kb, '超时重试');
  assert.equal(long.routed.cjk.length, 1);
  assert.ok(long.preview.some(c => c.page === 'wiki/sources/local-cjk.md'));
  const short = search(kb, '支付');
  assert.deepEqual(short.routed.like, ['支付']);
  assert.ok(short.preview.some(c => c.page === 'wiki/sources/local-cjk.md'));
  fs.unlinkSync(path.join(kb, 'wiki', 'sources', 'local-cjk.md'));
});

test('H1 regression: approved page under wiki/archive/ is never indexed', () => {
  writePage('wiki/archive/old-pay.md', src('oldpay', { title: 'Old Payment Doc' }),
    '## Legacy\n\nunique-zebra-term from a superseded approved page.');
  ensureFresh(kb);
  const r = search(kb, 'unique-zebra-term');
  assert.equal(r.preview.filter(c => c.via === 'search').length, 0, 'archive page must not enter candidates');
  fs.unlinkSync(path.join(kb, 'wiki', 'archive', 'old-pay.md'));
  ensureFresh(kb);
});

test('date filters: after:/before: compare the effective date (updated_at fallback)', () => {
  writePage('wiki/sources/local-new.md', src('new', { title: 'Fresh Doc', updated_at: '2026-07-29T09:00:00+08:00' }),
    '## Freshness\n\nquokka-marker for date filtering.');
  ensureFresh(kb);
  const recent = search(kb, 'quokka-marker after:2026-07-15');
  assert.ok(recent.preview.some(c => c.page === 'wiki/sources/local-new.md'));
  const old = search(kb, 'quokka-marker before:2026-07-15');
  assert.equal(old.preview.filter(c => c.via === 'search').length, 0);
  fs.unlinkSync(path.join(kb, 'wiki', 'sources', 'local-new.md'));
  ensureFresh(kb);
});

test('--within tolerates Windows backslashes', () => {
  const r = search(kb, 'retries', { within: ['wiki\\sources\\local-pay.md'] });
  assert.ok(r.preview.some(c => c.page === 'wiki/sources/local-pay.md'));
});

test('.kb/candidates is pruned to the latest 20 files', () => {
  for (let i = 0; i < 25; i++) search(kb, 'payment');
  const dir = path.join(kb, '.kb', 'candidates');
  const n = fs.readdirSync(dir).filter(f => f.endsWith('.json')).length;
  assert.ok(n <= 20, `candidate files should be capped at 20, got ${n}`);
});

test('date filter semantic: source_version (ISO) wins over governance updated_at', () => {
  // source updated in May, governance ingested it in July: the effective date
  // should follow the source-system time
  writePage('wiki/sources/local-old.md', src('old', {
    title: 'Old Source Doc', source_version: '2026-05-10T08:00:00+08:00', updated_at: '2026-07-29T09:00:00+08:00',
  }), '## Legacy\n\nwombat-marker for date semantics.');
  ensureFresh(kb);
  assert.equal(search(kb, 'wombat-marker after:2026-07-01').preview.filter(c => c.via === 'search').length, 0,
    'source updated in May should not be hit by after:2026-07-01');
  assert.ok(search(kb, 'wombat-marker before:2026-06-01').preview.some(c => c.page === 'wiki/sources/local-old.md'));
  fs.unlinkSync(path.join(kb, 'wiki', 'sources', 'local-old.md'));
  ensureFresh(kb);
});

test('--within tolerates trailing slash (directory scope)', () => {
  const r = search(kb, 'retries', { within: ['wiki/sources/'] });
  assert.ok(r.preview.some(c => c.page === 'wiki/sources/local-pay.md'));
});

test('skips table: candidate page not re-parsed every ensureFresh; flip to approved works', () => {
  let db = openDb(kb);
  assert.ok(db.prepare('SELECT hash FROM skips WHERE path=?').get('wiki/topics/payment.md'),
    'candidate page should be recorded in skips');
  db.close();
  // flip to approved (status change = content change = hash change) → re-parsed and effective
  writePage('wiki/topics/payment.md', { type: 'topic', status: 'approved', title: 'Payment Topic', sources: ['raw/local/pay.md'] },
    '## Synthesis\n\nNow approved. quagga-marker.');
  ensureFresh(kb);
  db = openDb(kb);
  assert.equal(db.prepare('SELECT hash FROM skips WHERE path=?').get('wiki/topics/payment.md'), undefined,
    'should be removed from skips after approval');
  assert.ok(db.prepare('SELECT path FROM docs WHERE path=?').get('wiki/topics/payment.md'), 'should enter docs after approval');
  db.close();
  assert.ok(search(kb, 'quagga-marker').preview.some(c => c.page === 'wiki/topics/payment.md'));
  // restore to candidate to avoid affecting later tests
  writePage('wiki/topics/payment.md', { type: 'topic', status: 'candidate', title: 'Payment Topic (candidate)', sources: ['raw/local/pay.md'] },
    '## Synthesis\n\nCandidate pages must not be indexed. payment payment payment.');
  ensureFresh(kb);
});

test('wikilink with #anchor resolves for graph expansion', () => {
  writePage('wiki/sources/local-linker.md', src('linker', { title: 'Linker Doc' }),
    '## Pointers\n\nSee [[sources/local-pay#timeout]] for details. axolotl-marker.');
  ensureFresh(kb);
  const r = search(kb, 'axolotl-marker');
  const link = r.preview.find(c => c.via === 'link');
  assert.ok(link, 'wikilink with #anchor should also participate in graph expansion');
  assert.equal(link.page, 'wiki/sources/local-pay.md');
  fs.unlinkSync(path.join(kb, 'wiki', 'sources', 'local-linker.md'));
  ensureFresh(kb);
});

test('fences: ~~~ and 4-backtick blocks do not split headings inside', () => {
  const body = '## Real\n\n~~~\n# not a heading\n~~~\n\n````\n```\n# also not a heading\n```\n````\n\ntext';
  const sections = chunkPage(body);
  assert.equal(sections.filter(c => c.heading === 'not a heading').length, 0);
  assert.equal(sections.filter(c => c.heading === 'also not a heading').length, 0);
  assert.ok(sections.some(c => c.heading === 'Real' && c.text.includes('# not a heading')));
});

test('readSection includes subsections, stops at same-or-higher level', () => {
  const body = '## A\n\na\n\n### A1\n\na1\n\n#### A1a\n\na1a\n\n## B\n\nb\n';
  const r = readSection(body, 'A');
  assert.ok(r.includes('a1a'), 'should include deep subsections');
  assert.ok(!r.includes('\nb'), 'should not include the same-level ## B');
  assert.equal(readSection(body, 'A1').includes('a1a'), true);
  assert.equal(readSection(body, 'A1').includes('## A\n'), false);
});

test('candidates_file always exists after pruning (mtime tie safety)', () => {
  for (let i = 0; i < 25; i++) {
    const r = search(kb, 'payment');
    assert.ok(fs.existsSync(path.join(kb, r.candidates_file)), 'the current candidates file must not be pruned');
  }
});

test('fences: inline code line (```code```) is not a fence', () => {
  const body = '## A\n\n```code```\n\n## B\n\nb\n';
  const sections = chunkPage(body);
  assert.ok(sections.some(c => c.heading === 'B'), 'inline code line must not swallow the following heading');
  assert.equal(readSection(body, 'A').includes('```code```'), true);
});

test('skips rows are cleaned when the candidate page is deleted', () => {
  writePage('wiki/topics/temp-cand.md', { type: 'topic', status: 'candidate', title: 'Temp', sources: ['raw/local/pay.md'] },
    '## S\n\ntemporary candidate.');
  ensureFresh(kb);
  let db = openDb(kb);
  assert.ok(db.prepare('SELECT hash FROM skips WHERE path=?').get('wiki/topics/temp-cand.md'));
  db.close();
  fs.unlinkSync(path.join(kb, 'wiki', 'topics', 'temp-cand.md'));
  ensureFresh(kb);
  db = openDb(kb);
  assert.equal(db.prepare('SELECT hash FROM skips WHERE path=?').get('wiki/topics/temp-cand.md'), undefined,
    'skips row should be cleaned after the candidate page is deleted');
  db.close();
});

test('M4 regression: status rejected is neither indexed nor readable (contract §4 enum)', () => {
  writePage('wiki/topics/rejected-page.md', { type: 'topic', status: 'rejected', title: 'Rejected Topic', sources: ['raw/local/pay.md'] },
    '## Synthesis\n\nnarwhal-marker from a rejected page.');
  ensureFresh(kb);
  assert.equal(search(kb, 'narwhal-marker').preview.filter(c => c.via === 'search').length, 0,
    'rejected page must not be indexed');
  assert.throws(() => readWikiPage(kb, 'wiki/topics/rejected-page.md'), /not approved/,
    'rejected page must not be readable');
  fs.unlinkSync(path.join(kb, 'wiki', 'topics', 'rejected-page.md'));
  ensureFresh(kb);
});

test("N3 regression: wikilinks inside code fences / inline code are not graph edges", () => {
  writePage('wiki/sources/local-codelink.md', src('codelink', { title: 'Code Link Doc' }),
    '## Pointers\n\nProse link [[sources/local-pay]].\n\n```\nsample: [[sources/local-auth]]\n```\n\nInline `[[sources/local-auth]]` mention. meerkat-marker.');
  ensureFresh(kb);
  const r = search(kb, 'meerkat-marker');
  const links = r.preview.filter(c => c.via === 'link').map(c => c.page);
  assert.deepEqual(links, ['wiki/sources/local-pay.md'],
    'only the prose link is a graph edge; fence and inline-code mentions must not expand');
  fs.unlinkSync(path.join(kb, 'wiki', 'sources', 'local-codelink.md'));
  ensureFresh(kb);
});

test('L1 regression: non-Z ISO offsets are normalized to UTC at index time', () => {
  // 2026-07-15T01:00+08:00 is 2026-07-14T17:00Z — a lexicographic comparison
  // against the raw string would mis-sort it into the 07-15 bucket
  writePage('wiki/sources/local-tz.md', src('tz', {
    title: 'Timezone Doc', source_version: '2026-07-15T01:00:00+08:00', updated_at: '2026-07-29T09:00:00+08:00',
  }), '## TZ\n\nnumbat-marker for offset normalization.');
  ensureFresh(kb);
  assert.equal(search(kb, 'numbat-marker after:2026-07-15').preview.filter(c => c.via === 'search').length, 0,
    'UTC day is 07-14: after:2026-07-15 must not match');
  assert.ok(search(kb, 'numbat-marker before:2026-07-15').preview.some(c => c.page === 'wiki/sources/local-tz.md'),
    'UTC day is 07-14: before:2026-07-15 must match');
  fs.unlinkSync(path.join(kb, 'wiki', 'sources', 'local-tz.md'));
  ensureFresh(kb);
});

test('lazy incremental: edit → visible, delete → gone', () => {
  writePage('wiki/sources/local-pay.md', src('pay', { title: 'Payment Gateway Requirements' }),
    '## New Section\n\nRate limiting, circuit breaking and degradation strategy.');
  ensureFresh(kb);
  assert.ok(search(kb, 'circuit breaking').preview.some(c => c.page === 'wiki/sources/local-pay.md'));
  fs.unlinkSync(path.join(kb, 'wiki', 'sources', 'local-auth.md'));
  ensureFresh(kb);
  assert.equal(search(kb, 'OAuth2').preview.length, 0);
  fs.rmSync(kb, { recursive: true, force: true });
});
