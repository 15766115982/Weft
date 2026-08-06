// GF-01..12 — Governance flow behavior tests (catalog docs/plans/test-catalog.md §A).
// Deterministic (no network, stubbed summaries via stdin); drives the REAL
// acquisition/governance CLIs against scratch KBs built from the fixture corpus
// plus tests/fixtures/scenarios/. Writes docs/test-reports/govern-flow-latest.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO, FIXTURES, SCRIPTS, rawRelFor, sourcePageFor, runCli,
  makeScratchKb, acquire, govern, copyInbox, applyAllSources,
} from '../helpers/kb.mjs';

const SCEN = path.join(FIXTURES, 'scenarios');
const results = [];
function record(id, ok, detail = '') { results.push({ id, ok, detail }); }

function statusOf(kb, pageRel) {
  const text = fs.readFileSync(path.join(kb, pageRel), 'utf8');
  return text.match(/^status:\s*(\S+)/m)?.[1];
}
function fmOf(kb, pageRel) {
  const text = fs.readFileSync(path.join(kb, pageRel), 'utf8');
  const end = text.indexOf('\n---', 4);
  return text.slice(0, end > 0 ? end : 400);
}
function setStatus(kb, pageRel, status) {
  const abs = path.join(kb, pageRel);
  const text = fs.readFileSync(abs, 'utf8');
  fs.writeFileSync(abs, text.replace(/^status:\s*\S+/m, `status: ${status}`), 'utf8');
}
function decisionsOf(kb, filters = []) {
  return govern(kb, ['decisions', ...filters]);
}
function stageInbox(kb, files) {
  const inbox = path.join(kb, 'inbox');
  fs.mkdirSync(inbox, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(SCEN, f), path.join(inbox, f));
}
function listWiki(kb) {
  const out = [];
  for (const sub of ['sources', 'entities', 'concepts', 'syntheses']) {
    const dir = path.join(kb, 'wiki', sub);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) if (f.endsWith('.md')) out.push(`wiki/${sub}/${f}`);
  }
  return out.sort();
}

// ---------- GF-01 全链路 happy path ----------
test('GF-01 acquire→summarize→candidate→approve→reindex→retrievable', () => {
  const kb = makeScratchKb('kb-gf01-');
  try {
    stageInbox(kb, ['faq-retry.md']);
    acquire(kb);
    const p1 = govern(kb, ['plan']);
    assert.equal(p1.pending.length, 1, 'one pending raw');
    const rawRel = p1.pending[0].raw;
    // apply-source with a human/stub summary — low-risk sources auto-approve
    govern(kb, ['apply-source', '--raw', rawRel], '# FAQ Retry\n重试相关的问答:为什么会重试,失败怎么办。\n');
    const page = p1.pending[0].page;
    assert.equal(statusOf(kb, page), 'approved');
    govern(kb, ['rebuild-index']);
    const hit = runCli(SCRIPTS.search, ['search', '重试', '--kb', kb]);
    assert.ok(hit.total > 0, 'page retrievable after rebuild-index');
    record('GF-01', true, `page=${page}`);
  } catch (err) { record('GF-01', false, err.message); throw err; }
  finally { fs.rmSync(kb, { recursive: true, force: true }); }
});

// ---------- GF-02 完全重复 → auto-dedup + tombstone + decision ----------
test('GF-02 identical content auto-dedups without a candidate', () => {
  const kb = makeScratchKb('kb-gf02-');
  try {
    stageInbox(kb, ['dup-retry-a.md', 'dup-retry-b.md']);
    acquire(kb);
    const p = govern(kb, ['plan']);
    assert.equal(p.pending.length, 2);
    // structural scan flags the duplicate pair in the conflicts side-channel
    assert.ok(p.conflicts.some((g) => g.category === 'duplicate' && g.raws.length === 2),
      `duplicate group flagged: ${JSON.stringify(p.conflicts)}`);
    const [a, b] = p.pending.map((i) => i.raw).sort();
    govern(kb, ['apply-source', '--raw', a], '# Dup\nbody\n');
    const r2 = govern(kb, ['apply-source', '--raw', b], '# Dup\nbody\n');
    assert.equal(r2.action, 'auto:dedup-source');
    assert.equal(listWiki(kb).length, 1, 'no second page created');
    const dec = decisionsOf(kb, ['--action', 'auto:dedup-source']);
    assert.ok(dec.length >= 1, 'dedup decision recorded');
    // raw b is tombstoned: plain apply refuses, --force revives
    const refuse = runCli(SCRIPTS.govern, ['apply-source', '--raw', b, '--kb', kb], { stdin: '# x\n', expectFail: true });
    assert.match(refuse.stderr, /tombstoned/);
    record('GF-02', true, `decision=${dec[0].action}`);
  } catch (err) { record('GF-02', false, err.message); throw err; }
  finally { fs.rmSync(kb, { recursive: true, force: true }); }
});

// ---------- GF-03 相似版本 → similar 冲突组浮出 ----------
test('GF-03 similar version pair surfaces as a conflict group', () => {
  const kb = makeScratchKb('kb-gf03-');
  try {
    stageInbox(kb, ['ver-doc-v1.md', 'ver-doc-v2.md']);
    acquire(kb);
    const p = govern(kb, ['plan']);
    const sim = p.conflicts.find((g) => g.category === 'similar');
    assert.ok(sim, `similar group present: ${JSON.stringify(p.conflicts)}`);
    assert.equal(sim.raws.length, 2);
    record('GF-03', true, `score=${sim.score?.toFixed?.(3)}`);
  } catch (err) { record('GF-03', false, err.message); throw err; }
  finally { fs.rmSync(kb, { recursive: true, force: true }); }
});

// ---------- GF-04 apply-topic 触碰 similar 组 → 强制 candidate ----------
test('GF-04 apply-topic over a similar group is force-candidated', () => {
  const kb = makeScratchKb('kb-gf04-');
  try {
    stageInbox(kb, ['ver-doc-v1.md', 'ver-doc-v2.md']);
    acquire(kb);
    const p = govern(kb, ['plan']);
    for (const item of p.pending) {
      govern(kb, ['apply-source', '--raw', item.raw], '# Settlement\nbody\n');
    }
    govern(kb, ['plan']); // refresh conflicts side-channel fingerprint
    const raws = p.pending.map((i) => i.raw).sort();
    const t = govern(kb, ['apply-topic', '--slug', 'settlement-ops', '--title', 'Settlement Ops',
      '--sources', raws.join(',')], 'Combined settlement notes.\n');
    const page = t.page || 'wiki/syntheses/settlement-ops.md';
    assert.equal(statusOf(kb, page), 'candidate', `topic force-candidated (got ${statusOf(kb, page)})`);
    assert.match(fmOf(kb, page), /forced candidate/);
    record('GF-04', true, page);
  } catch (err) { record('GF-04', false, err.message); throw err; }
  finally { fs.rmSync(kb, { recursive: true, force: true }); }
});

// ---------- GF-05 dismiss-conflict 持久化 ----------
test('GF-05 dismissed conflict stays suppressed on later plans', () => {
  const kb = makeScratchKb('kb-gf05-');
  try {
    stageInbox(kb, ['ver-doc-v1.md', 'ver-doc-v2.md']);
    acquire(kb);
    const p1 = govern(kb, ['plan']);
    const pair = p1.conflicts.find((g) => g.category === 'similar').raws.join(',');
    govern(kb, ['dismiss-conflict', '--pair', pair, '--reason', 'v2 是 v1 的官方修订,平行保留']);
    const p2 = govern(kb, ['plan']);
    // dismissals do not delete the group — they mark it dismissed so adjudication
    // UIs and apply-topic skip it, while the audit trail survives
    const g2 = p2.conflicts.find((g) => g.category === 'similar');
    assert.ok(g2, 'group still visible for audit');
    assert.equal(g2.dismissed, true, 'dismissal marked on the group');
    // and it persists in adjudication memory across plans
    const mem = JSON.parse(fs.readFileSync(path.join(kb, '.kb', 'govern', 'conflict-dismissals.json'), 'utf8'));
    assert.equal(mem.length, 1);
    assert.equal(mem[0].reason, 'v2 是 v1 的官方修订,平行保留');
    record('GF-05', true, `suppressed=${p2.suppressed.length}`);
  } catch (err) { record('GF-05', false, err.message); throw err; }
  finally { fs.rmSync(kb, { recursive: true, force: true }); }
});

// ---------- GF-06 决策日志完整性 ----------
test('GF-06 approve/reject/archive write decision records with reason+actor', () => {
  const kb = makeScratchKb('kb-gf06-');
  try {
    stageInbox(kb, ['faq-retry.md', 'incident-settlement-delay.md']);
    acquire(kb);
    const p = govern(kb, ['plan']);
    for (const item of p.pending) {
      govern(kb, ['apply-source', '--raw', item.raw], '# S\nbody\n');
    }
    govern(kb, ['apply-topic', '--slug', 'ops-notes', '--title', 'Ops Notes',
      '--sources', p.pending.map((i) => i.raw).join(','), '--candidate'], 'Draft.\n');
    const topic = 'wiki/syntheses/ops-notes.md';
    assert.equal(statusOf(kb, topic), 'candidate');
    govern(kb, ['approve', '--page', topic, '--actor', 'human', '--reason', '内容核对无误']);
    assert.equal(statusOf(kb, topic), 'approved');
    const dec = decisionsOf(kb, ['--page', topic]);
    const approve = dec.find((d) => d.action === 'approve');
    assert.ok(approve, 'approve decision recorded');
    assert.equal(approve.actor, 'human');
    assert.ok(approve.reason, 'reason persisted');
    // archive an approved source page (human adjudication requires reason)
    const src = p.pending[0].page;
    govern(kb, ['archive', '--page', src, '--actor', 'human', '--reason', '过期文档']);
    assert.ok(!fs.existsSync(path.join(kb, src)), 'archived page moved out of wiki/sources');
    // archive decision's page is the archive TARGET; meta.from is the source page
    const archDec = decisionsOf(kb, ['--action', 'archive']);
    assert.ok(archDec.some((d) => d.meta?.from === src), `archive decision links back to ${src}`);
    // human mutations without reason fail loudly
    const noReason = runCli(SCRIPTS.govern, ['reject', '--page', topic, '--actor', 'human', '--kb', kb], { expectFail: true });
    assert.match(noReason.stderr, /reason/i);
    record('GF-06', true, `decisions=${dec.length}`);
  } catch (err) { record('GF-06', false, err.message); throw err; }
  finally { fs.rmSync(kb, { recursive: true, force: true }); }
});

// ---------- GF-07 sweep 补录 viewer 翻页 + 归档 rejected ----------
test('GF-07 sweep backfills hand-flips and archives rejected pages', () => {
  const kb = makeScratchKb('kb-gf07-');
  try {
    stageInbox(kb, ['faq-retry.md', 'incident-settlement-delay.md']);
    acquire(kb);
    const p = govern(kb, ['plan']);
    for (const item of p.pending) govern(kb, ['apply-source', '--raw', item.raw], '# S\nbody\n');
    govern(kb, ['apply-topic', '--slug', 't1', '--title', 'T1',
      '--sources', p.pending.map((i) => i.raw).join(','), '--candidate'], 'Draft.\n');
    const topic = 'wiki/syntheses/t1.md';
    // simulate the viewer: hand-flip the frontmatter, no log entry
    setStatus(kb, topic, 'rejected');
    const r = govern(kb, ['sweep']);
    assert.ok(r.backfilled.some((b) => b.page === topic && b.status === 'rejected'),
      `flip backfilled as reject: ${JSON.stringify(r.backfilled)}`);
    assert.ok(r.archived.some((a) => a.from === topic), 'rejected page archived by the same sweep');
    assert.ok(!fs.existsSync(path.join(kb, topic)), 'page left wiki/syntheses');
    const dec = decisionsOf(kb, ['--page', topic]);
    assert.ok(dec.some((d) => d.action === 'reject' && d.actor === 'review'), 'backfill recorded as review reject');
    record('GF-07', true, `archived=${r.archived.length}`);
  } catch (err) { record('GF-07', false, err.message); throw err; }
  finally { fs.rmSync(kb, { recursive: true, force: true }); }
});

// ---------- GF-08 治理幂等 ----------
test('GF-08 a second full governance round changes nothing', () => {
  const kb = makeScratchKb('kb-gf08-');
  try {
    copyInbox(kb);
    acquire(kb);
    applyAllSources(kb);
    govern(kb, ['rebuild-index']);
    const pages1 = listWiki(kb);
    const dec1 = decisionsOf(kb).length;
    // round two: acquire again, plan again
    acquire(kb);
    const p2 = govern(kb, ['plan']);
    assert.equal(p2.pending.length, 0, 'nothing pending after round one');
    assert.equal(p2.review_queue.length, 0, 'no forced candidates');
    assert.deepEqual(listWiki(kb), pages1, 'page set unchanged');
    assert.equal(decisionsOf(kb).length, dec1, 'no new decisions');
    record('GF-08', true, `pages=${pages1.length}`);
  } catch (err) { record('GF-08', false, err.message); throw err; }
  finally { fs.rmSync(kb, { recursive: true, force: true }); }
});

// ---------- GF-09 merge-topic 并源不丢溯源 ----------
test('GF-09 merge-topic unions sources and archives the loser', () => {
  const kb = makeScratchKb('kb-gf09-');
  try {
    stageInbox(kb, ['faq-retry.md', 'incident-settlement-delay.md']);
    acquire(kb);
    const p = govern(kb, ['plan']);
    for (const item of p.pending) govern(kb, ['apply-source', '--raw', item.raw], '# S\nbody\n');
    const [ra, rb] = p.pending.map((i) => i.raw);
    govern(kb, ['apply-topic', '--slug', 't-a', '--title', 'TA', '--sources', ra], 'A.\n');
    govern(kb, ['apply-topic', '--slug', 't-b', '--title', 'TB', '--sources', rb], 'B.\n');
    govern(kb, ['merge-topic', '--from', 't-a', '--to', 't-b', '--actor', 'human', '--reason', '同一主题']);
    const to = 'wiki/syntheses/t-b.md';
    assert.equal(statusOf(kb, to), 'approved');
    const fm = fmOf(kb, to);
    assert.ok(fm.includes(ra) && fm.includes(rb), 'sources unioned, provenance kept');
    assert.ok(!fs.existsSync(path.join(kb, 'wiki/syntheses/t-a.md')), 'loser archived');
    // merge requires both approved: a candidate participant fails loudly
    govern(kb, ['apply-topic', '--slug', 't-c', '--title', 'TC', '--sources', ra, '--candidate'], 'C.\n');
    const bad = runCli(SCRIPTS.govern, ['merge-topic', '--from', 't-c', '--to', 't-b', '--actor', 'human', '--reason', 'x', '--kb', kb], { expectFail: true });
    assert.match(bad.stderr, /non-approved/);
    record('GF-09', true, to);
  } catch (err) { record('GF-09', false, err.message); throw err; }
  finally { fs.rmSync(kb, { recursive: true, force: true }); }
});

// ---------- GF-10 reject → sweep → archive + raw tombstone ----------
test('GF-10 rejected candidates archive on sweep; approved cannot be archived by archive cmd', () => {
  const kb = makeScratchKb('kb-gf10-');
  try {
    stageInbox(kb, ['faq-retry.md']);
    acquire(kb);
    const p = govern(kb, ['plan']);
    govern(kb, ['apply-source', '--raw', p.pending[0].raw], '# S\nbody\n');
    govern(kb, ['apply-topic', '--slug', 't-r', '--title', 'TR', '--sources', p.pending[0].raw, '--candidate'], 'Draft.\n');
    const topic = 'wiki/syntheses/t-r.md';
    // candidates must be rejected, not archived
    const badArchive = runCli(SCRIPTS.govern, ['archive', '--page', topic, '--actor', 'human', '--reason', 'x', '--kb', kb], { expectFail: true });
    assert.match(badArchive.stderr, /only approved pages can be archived/);
    govern(kb, ['reject', '--page', topic, '--actor', 'human', '--reason', '内容不达标']);
    assert.equal(statusOf(kb, topic), 'rejected');
    const r = govern(kb, ['sweep']);
    assert.ok(r.archived.some((a) => a.from === topic), 'rejected topic archived on sweep');
    assert.ok(!fs.existsSync(path.join(kb, topic)));
    record('GF-10', true);
  } catch (err) { record('GF-10', false, err.message); throw err; }
  finally { fs.rmSync(kb, { recursive: true, force: true }); }
});

// ---------- GF-11 冲突侧信道失配 → 降级并告警 ----------
test('GF-11 stale conflicts side-channel degrades apply-topic with a warning', () => {
  const kb = makeScratchKb('kb-gf11-');
  try {
    stageInbox(kb, ['ver-doc-v1.md', 'ver-doc-v2.md']);
    acquire(kb);
    const p = govern(kb, ['plan']);
    for (const item of p.pending) govern(kb, ['apply-source', '--raw', item.raw], '# S\nbody\n');
    govern(kb, ['plan']); // fingerprinted conflicts.json
    // mutate raw/ without re-planning → fingerprint mismatch
    stageInbox(kb, ['faq-retry.md']);
    acquire(kb);
    const raws = p.pending.map((i) => i.raw).sort();
    const t = govern(kb, ['apply-topic', '--slug', 't-w', '--title', 'TW', '--sources', raws.join(',')], 'Body.\n');
    assert.ok(t.warning, `degradation warning surfaced: ${JSON.stringify(t)}`);
    record('GF-11', true, t.warning);
  } catch (err) { record('GF-11', false, err.message); throw err; }
  finally { fs.rmSync(kb, { recursive: true, force: true }); }
});

// ---------- GF-12 rebuild-index 与 approved 集合一致 ----------
test('GF-12 rebuild-index links exactly the approved non-candidate pages', () => {
  const kb = makeScratchKb('kb-gf12-');
  try {
    stageInbox(kb, ['faq-retry.md', 'incident-settlement-delay.md']);
    acquire(kb);
    const p = govern(kb, ['plan']);
    for (const item of p.pending) govern(kb, ['apply-source', '--raw', item.raw], '# S\nbody\n');
    govern(kb, ['apply-topic', '--slug', 't-i', '--title', 'TI', '--sources', p.pending.map((i) => i.raw).join(','), '--candidate'], 'Draft.\n');
    govern(kb, ['rebuild-index']);
    const index = fs.readFileSync(path.join(kb, 'wiki', 'index.md'), 'utf8');
    const approved = listWiki(kb).filter((pg) => statusOf(kb, pg) === 'approved');
    assert.ok(approved.length >= 2);
    for (const pg of approved) {
      const slug = path.basename(pg, '.md');
      assert.ok(index.includes(slug), `index links approved page ${slug}`);
    }
    // index.md is the full navigation tree — candidates ARE listed but must be
    // visibly marked; the retrieval index (not index.md) excludes them
    assert.ok(/\[\[syntheses\/t-i\]\].*\(status:candidate/.test(index),
      'candidate listed with an explicit status marker');
    record('GF-12', true, `approved=${approved.length}`);
  } catch (err) { record('GF-12', false, err.message); throw err; }
  finally { fs.rmSync(kb, { recursive: true, force: true }); }
});

after(() => {
  const dir = path.join(REPO, 'docs', 'test-reports');
  fs.mkdirSync(dir, { recursive: true });
  const pass = results.filter((r) => r.ok).length;
  const lines = [
    '# Govern-flow behavior report', '',
    `Run: ${new Date().toISOString()} · ${pass}/${results.length} passed`, '',
    '| case | result | detail |', '|---|---|---|',
    ...results.map((r) => `| ${r.id} | ${r.ok ? '✅' : '❌'} | ${r.detail.replace(/\|/g, '/').slice(0, 120)} |`),
    '',
  ];
  fs.writeFileSync(path.join(dir, 'govern-flow-latest.md'), lines.join('\n'));
});
