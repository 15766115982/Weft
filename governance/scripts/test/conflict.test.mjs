// Conflict detection tests (plan 0001 / ADR-0008): plan conflicts + suppressed +
// dismissal + side-channel; apply-source exact-duplicate auto-dedup + tombstone
// gate + --force revive; apply-topic fail-closed candidate + side-channel
// fingerprint degradation + in-topic collapse + semantic_check_required;
// reject-and-restore; and the bug-0001 / P0-1 integration scenarios.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import {
  plan, applySourcePage, applyTopicPage, rejectPage, archivePage, sweep,
  addDismissal, addTombstone, readTombstones, readDismissals, readConflicts,
} from '../lib/govern.mjs';
import { buildFrontmatter, parseFrontmatter } from '../lib/frontmatter.mjs';
import { readStatus } from '../lib/statusflip.mjs';

const V1_BODY = 'The payment gateway must support timeout retries with exponential backoff and honor the retry budget.';
const V2_BODY = V1_BODY + ' It also implements connection jitter between attempts.';

function makeKb() {
  const kbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-conflict-'));
  fs.mkdirSync(path.join(kbRoot, 'raw', 'local'), { recursive: true });
  const writeRaw = (name, over = {}) => {
    const { title, body, version, hash, source_id } = over;
    const fm = buildFrontmatter({
      source: 'local', source_id: source_id ?? name,
      source_url: `file:///inbox/${name}.md`, source_version: version ?? '2026-07-01T00:00:00Z',
      pulled_at: version ?? '2026-07-01T00:00:00Z',
      content_hash: hash ?? `sha256:${name}`, title: title ?? `Doc ${name}`, connector: 'local@1.0.0',
    });
    fs.writeFileSync(path.join(kbRoot, 'raw', 'local', `${name}.md`), fm + '\n' + (body ?? 'Body text.\n') + '\n', 'utf8');
    return `raw/local/${name}.md`;
  };
  const readPage = (rel) => parseFrontmatter(fs.readFileSync(path.join(kbRoot, rel), 'utf8'));
  const log = () => fs.readFileSync(path.join(kbRoot, 'log.md'), 'utf8');
  const cleanup = () => fs.rmSync(kbRoot, { recursive: true, force: true });
  return { kbRoot, writeRaw, readPage, log, cleanup };
}

/** A pair of version-of-one-document raws (distinct hashes, high body similarity). */
function writeVersionPair(kb, suffix) {
  const a = kb.writeRaw(`pay-timeout-v1-${suffix}`, { title: 'Payment Gateway Requirements', body: V1_BODY });
  const b = kb.writeRaw(`pay-timeout-v2-${suffix}`, { title: 'Payment Gateway Requirements v2', body: V2_BODY });
  return [a, b];
}

/* ---------------- plan: conflicts / suppressed / dismissal / side-channel ---------------- */

test('plan detects a similar-version group with provenance and writes the side-channel', () => {
  const kb = makeKb();
  try {
    const [a, b] = writeVersionPair(kb, 'p1');
    const p = plan(kb.kbRoot);
    const g = p.conflicts.find((x) => x.category === 'similar');
    assert.ok(g, 'similar group must be reported');
    assert.deepEqual(g.raws, [a, b].sort());
    assert.ok(g.score >= 0.5);
    assert.equal(g.dismissed, false);
    // provenance: each raw maps to its (would-be) source page; no topics yet
    assert.equal(g.provenance[a].page, 'wiki/sources/local-pay-timeout-v1-p1.md');
    assert.deepEqual(g.provenance[a].topics, []);
    // side-channel persisted with a raw-set fingerprint
    const state = readConflicts(kb.kbRoot);
    assert.ok(state.fingerprint);
    assert.ok(state.raw_hashes[a]);
    assert.equal(state.groups[0].category, 'similar');
  } finally { kb.cleanup(); }
});

test('plan detects an exact-duplicate group; missing content_hash never duplicates', () => {
  const kb = makeKb();
  try {
    const a = kb.writeRaw('dup-a', { hash: 'sha256:SAME', body: 'same' });
    const b = kb.writeRaw('dup-b', { hash: 'sha256:SAME', body: 'same' });
    const c = kb.writeRaw('nohash-c', { hash: undefined, body: 'same as dup-a' });
    const p = plan(kb.kbRoot);
    const dup = p.conflicts.find((x) => x.category === 'duplicate');
    assert.ok(dup);
    assert.deepEqual(dup.raws, [a, b].sort());
    assert.ok(!dup.raws.includes(c), 'null hash on one side ⇒ not a duplicate');
  } finally { kb.cleanup(); }
});

test('tombstoned raw: suppressed (not pending); dangling tombstone auto-cleaned', () => {
  const kb = makeKb();
  try {
    const a = kb.writeRaw('tomba', { title: 'Tombstoned' });
    const ghost = 'raw/local/ghost.md';
    addTombstone(kb.kbRoot, a, { reason: 'test', page: 'wiki/sources/x.md' });
    addTombstone(kb.kbRoot, ghost, { reason: 'dangling', page: 'wiki/sources/ghost.md' });
    const p = plan(kb.kbRoot);
    assert.equal(p.pending.length, 0, 'tombstoned raw must not be pending');
    const t = p.suppressed.find((s) => s.raw === a);
    assert.ok(t, 'tombstoned raw reported in suppressed');
    assert.equal(t.reason, 'tombstoned');
    assert.equal(p.tombstones_cleaned, 1, 'dangling tombstone cleaned');
    assert.ok(p.suppressed.some((s) => s.raw === ghost), 'cleaned tombstone kept visible');
    assert.ok(!readTombstones(kb.kbRoot)[ghost], 'dangling entry removed from the state file');
  } finally { kb.cleanup(); }
});

test('dismissed group is still reported but marked; apply-topic skips it', () => {
  const kb = makeKb();
  try {
    const [a, b] = writeVersionPair(kb, 'dm');
    plan(kb.kbRoot);
    addDismissal(kb.kbRoot, [a, b], 'parallel documents');
    const p = plan(kb.kbRoot);
    const g = p.conflicts.find((x) => x.category === 'similar' && x.raws.includes(a));
    assert.equal(g.dismissed, true, 'adjudicated pair surfaced as dismissed, not hidden');
    // apply-topic referencing a dismissed raw must NOT be forced to candidate
    const out = applyTopicPage(kb.kbRoot, { slug: 'ok-topic', title: 'OK Topic', sources: [a] }, 'body');
    assert.equal(out.status, 'approved', 'dismissed group does not force candidate');
  } finally { kb.cleanup(); }
});

test('dismissal written AFTER the last plan is honored without waiting for a re-plan', () => {
  const kb = makeKb();
  try {
    const [a, b] = writeVersionPair(kb, 'gap');
    plan(kb.kbRoot);            // side-channel carries dismissed:false
    addDismissal(kb.kbRoot, [a, b], 'parallel documents');   // no re-plan
    const out = applyTopicPage(kb.kbRoot, { slug: 'ok-topic', title: 'OK Topic', sources: [a] }, 'body');
    assert.equal(out.status, 'approved',
      'a dismissal must take effect immediately — apply-topic consults conflict-dismissals.json directly');
  } finally { kb.cleanup(); }
});

/* ---------------- apply-source: auto-dedup + tombstone gate + --force ---------------- */

test('apply-source auto-dedups an exact duplicate (no page written, tombstone + log)', () => {
  const kb = makeKb();
  try {
    const a = kb.writeRaw('dup-x', { hash: 'sha256:DUP', body: 'identical' });
    const b = kb.writeRaw('dup-y', { hash: 'sha256:DUP', body: 'identical' });
    const first = applySourcePage(kb.kbRoot, a, 'Summary A.');
    assert.equal(first.action, 'auto:create-source');
    const second = applySourcePage(kb.kbRoot, b, 'Summary B.');
    assert.equal(second.action, 'auto:dedup-source');
    assert.equal(second.page, first.page, 'log target = the surviving page');
    assert.ok(!fs.existsSync(path.join(kb.kbRoot, 'wiki', 'sources', 'local-dup-y.md')), 'no redundant page written');
    assert.ok(readTombstones(kb.kbRoot)[b], 'redundant raw tombstoned');
    assert.match(kb.log(), /govern \| auto:dedup-source \| wiki\/sources\/local-dup-x\.md \| redundant raw\/local\/dup-y\.md/);
    // next plan: the deduped raw is suppressed, never re-pended (P0-1)
    const p = plan(kb.kbRoot);
    assert.equal(p.pending.length, 0);
    assert.ok(p.suppressed.some((s) => s.raw === b));
  } finally { kb.cleanup(); }
});

test('a duplicate group converged by auto-dedup no longer flags the surviving copy', () => {
  const kb = makeKb();
  try {
    const a = kb.writeRaw('dup-a', { hash: 'sha256:DUP', body: 'identical' });
    const b = kb.writeRaw('dup-b', { hash: 'sha256:DUP', body: 'identical' });
    plan(kb.kbRoot);                      // side-channel still lists [a, b] as a dup group
    applySourcePage(kb.kbRoot, a, 'Summary A.');       // survivor page
    applySourcePage(kb.kbRoot, b, 'Summary B.');       // auto-dedup → b tombstoned
    // apply-topic for the survivor, WITHOUT re-planning (the stale side-channel window)
    const out = applyTopicPage(kb.kbRoot, { slug: 'invoice', title: 'Invoice Topic', sources: [a] }, 'body');
    assert.equal(out.status, 'approved', 'a group reduced to its surviving copy must not force candidate');
    // and a fresh plan reports the dup group as gone (raw b is out of the comparison space)
    const p = plan(kb.kbRoot);
    assert.ok(!p.conflicts.some((g) => g.category === 'duplicate' && g.raws.includes(b)),
      'tombstoned raws are excluded from the conflict detection space');
    assert.ok(p.suppressed.some((s) => s.raw === b), 'survivor-side visibility via suppressed');
  } finally { kb.cleanup(); }
});

test('apply-source refuses a tombstoned raw; --force revives and clears the tombstone', () => {
  const kb = makeKb();
  try {
    const a = kb.writeRaw('revive-me', { title: 'Revivable' });
    addTombstone(kb.kbRoot, a, { reason: 'loser-archive', page: 'wiki/archive/x.md' });
    assert.throws(() => applySourcePage(kb.kbRoot, a, 'body'),
      /raw is tombstoned \(loser-archive\); use --force to revive/);
    const out = applySourcePage(kb.kbRoot, a, 'Revived summary.', { force: true });
    assert.equal(out.action, 'auto:create-source');
    assert.ok(!readTombstones(kb.kbRoot)[a], 'successful revive clears the tombstone');
  } finally { kb.cleanup(); }
});

/* ---------------- apply-topic: fail-closed + degradation + collapse + semantic ---------------- */

test('apply-topic forces candidate fail-closed when a new source sits in a flagged group', () => {
  const kb = makeKb();
  try {
    const [a, b] = writeVersionPair(kb, 'fc');
    plan(kb.kbRoot); // fresh side-channel
    // no --candidate, no note — the caller is silently trying to approve the fused topic
    const out = applyTopicPage(kb.kbRoot, { slug: 'payment-timeout', title: 'Payment Timeout', sources: [a] }, 'fusion body');
    assert.equal(out.status, 'candidate', 'bug 0001: fused-version approval must be structurally impossible');
    assert.equal(out.action, 'candidate:topic');
    const { fields } = kb.readPage('wiki/topics/payment-timeout.md');
    assert.equal(fields.status, 'candidate');
    assert.match(fields.review_note, /forced candidate/);
  } finally { kb.cleanup(); }
});

test('apply-topic with a stale side-channel degrades to an in-topic check + warning', () => {
  const kb = makeKb();
  try {
    const [a, b] = writeVersionPair(kb, 'st');
    plan(kb.kbRoot);
    kb.writeRaw('late-arrival', { title: 'A Late Raw', body: 'unrelated content that changes the raw set' });
    const out = applyTopicPage(kb.kbRoot, { slug: 'payment-timeout', title: 'Payment Timeout', sources: [a, b] }, 'body');
    assert.match(out.warning, /conflicts side-channel stale, degraded to in-topic check/);
    assert.equal(out.status, 'candidate', 'in-topic check still catches the within-topic pair');
  } finally { kb.cleanup(); }
});

test('a dismissed pair does not force candidate even on the degraded in-topic path', () => {
  const kb = makeKb();
  try {
    const [a, b] = writeVersionPair(kb, 'degdm');
    plan(kb.kbRoot);
    addDismissal(kb.kbRoot, [a, b], 'parallel documents');
    kb.writeRaw('late-arrival', { title: 'A Late Raw', body: 'unrelated content that changes the raw set' });
    const out = applyTopicPage(kb.kbRoot, { slug: 'payment-timeout', title: 'Payment Timeout', sources: [a, b] }, 'body');
    assert.match(out.warning, /conflicts side-channel stale, degraded to in-topic check/);
    assert.equal(out.status, 'approved', 'degraded in-topic check must still honor the persisted dismissal');
  } finally { kb.cleanup(); }
});

test('apply-topic with no side-channel degrades with a warning and checks within the topic', () => {
  const kb = makeKb();
  try {
    const [a, b] = writeVersionPair(kb, 'miss'); // no plan() → no conflicts.json
    const out = applyTopicPage(kb.kbRoot, { slug: 'payment-timeout', title: 'Payment Timeout', sources: [a, b] }, 'body');
    assert.match(out.warning, /conflicts side-channel missing, degraded to in-topic check/);
    assert.equal(out.status, 'candidate');
  } finally { kb.cleanup(); }
});

test('apply-topic collapses identical-hash sources to one reference and logs auto:dedup-topic', () => {
  const kb = makeKb();
  try {
    const a = kb.writeRaw('coll-a', { hash: 'sha256:SAME', title: 'Collided', body: 'same content' });
    const b = kb.writeRaw('coll-b', { hash: 'sha256:SAME', title: 'Collided', body: 'same content' });
    const out = applyTopicPage(kb.kbRoot, { slug: 'collapsed', title: 'Collapsed Topic', sources: [a, b] }, 'body');
    const { fields } = kb.readPage('wiki/topics/collapsed.md');
    // neither was previously referenced → lexicographic first survives
    assert.equal(fields.sources.length, 1);
    assert.deepEqual(fields.sources, [a]);
    assert.match(kb.log(), /govern \| auto:dedup-topic \| wiki\/topics\/collapsed\.md \| collapsed raw\/local\/coll-b\.md into raw\/local\/coll-a\.md/);
  } finally { kb.cleanup(); }
});

test('apply-topic emits semantic_check_required when a new source title overlaps an existing topic', () => {
  const kb = makeKb();
  try {
    const base = kb.writeRaw('base-pay', { title: 'Payment Gateway Requirements', body: V1_BODY });
    applyTopicPage(kb.kbRoot, { slug: 'payment-timeout', title: 'Payment Timeout Handling', sources: [base] }, 'topic body');
    const newRaw = kb.writeRaw('new-pay-policy', { title: 'Payment Timeout Policy', body: 'A distinct new document about timeout policy configuration.' });
    const out = applyTopicPage(kb.kbRoot, { slug: 'timeout-policy', title: 'Timeout Policy', sources: [newRaw] }, 'new topic body');
    assert.ok(out.semantic_check_required.includes('payment-timeout'),
      `title overlap must surface the topic for the mandatory semantic self-check: ${out.semantic_check_required}`);
    assert.equal(out.status, 'approved', 'semantic_check_required changes nothing about status');
  } finally { kb.cleanup(); }
});

/* ---------------- reject-and-restore ---------------- */

function gitCommitAll(kbRoot, msg) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '-A'], { cwd: kbRoot });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg], { cwd: kbRoot });
}

test('reject restores the previous git-committed approved version + logs synchronously (P1-5)', () => {
  const kb = makeKb();
  try {
    const a = kb.writeRaw('pay-restore', { title: 'Payment Gateway Requirements', body: V1_BODY });
    applyTopicPage(kb.kbRoot, { slug: 'payment-timeout', title: 'Payment Timeout', sources: [a] }, 'approved version body');
    execFileSync('git', ['init', '-q'], { cwd: kb.kbRoot });
    gitCommitAll(kb.kbRoot, 'approved baseline');
    // overwrite with a wrong candidate (bug 0001 flow)
    applyTopicPage(kb.kbRoot, { slug: 'payment-timeout', title: 'Payment Timeout (fused)', sources: [a], candidate: true, note: 'bad fusion' }, 'wrong fusion body');
    assert.equal(readStatus(path.join(kb.kbRoot, 'wiki', 'topics', 'payment-timeout.md')), 'candidate');
    const out = rejectPage(kb.kbRoot, 'wiki/topics/payment-timeout.md');
    assert.equal(out.restored, true);
    assert.equal(out.status, 'approved');
    const { fields, body } = kb.readPage('wiki/topics/payment-timeout.md');
    assert.equal(fields.title, 'Payment Timeout', 'restored the approved version, not the candidate');
    assert.ok(body.includes('approved version body'));
    // synchronous log keeps lastLogAction = review|reject → sweep backfills nothing
    assert.match(kb.log(), /review \| reject \| wiki\/topics\/payment-timeout\.md \| via session \| restored previous approved version/);
    const s = sweep(kb.kbRoot);
    assert.deepEqual(s.backfilled, [], 'P1-5: restore log must prevent a mis-recorded backfilled approve');
  } finally { kb.cleanup(); }
});

test('reject on a non-git KB falls back to plain reject with a distinguishable reason', () => {
  const kb = makeKb();
  try {
    const a = kb.writeRaw('pay-plain', { title: 'Payment' });
    applyTopicPage(kb.kbRoot, { slug: 'cand-one', title: 'Candidate One', sources: [a], candidate: true }, 'body');
    const out = rejectPage(kb.kbRoot, 'wiki/topics/cand-one.md');
    assert.equal(out.restored, false);
    assert.equal(out.restore_reason, 'not-a-git-repo');
    assert.equal(out.status, 'rejected');
  } finally { kb.cleanup(); }
});

test('reject on a git KB with no approved history falls back to plain reject (distinct reason)', () => {
  const kb = makeKb();
  try {
    const a = kb.writeRaw('pay-new', { title: 'Payment' });
    applyTopicPage(kb.kbRoot, { slug: 'never-approved', title: 'Never Approved', sources: [a], candidate: true }, 'body');
    execFileSync('git', ['init', '-q'], { cwd: kb.kbRoot });
    gitCommitAll(kb.kbRoot, 'only candidate exists');
    const out = rejectPage(kb.kbRoot, 'wiki/topics/never-approved.md');
    assert.equal(out.restored, false);
    assert.equal(out.restore_reason, 'no-approved-version-in-git-history');
    assert.equal(out.status, 'rejected');
  } finally { kb.cleanup(); }
});

/* ---------------- integration: bug 0001 repro + P0-1 loser archive ---------------- */

test('bug 0001 repro: two version files fused into one topic now land as candidate, not approved', () => {
  const kb = makeKb();
  try {
    const [v1, v2] = writeVersionPair(kb, 'repro');
    const p = plan(kb.kbRoot);
    assert.ok(p.conflicts.some((g) => g.category === 'similar' && g.raws.includes(v1) && g.raws.includes(v2)),
      'the batch is flagged before any apply');
    // the old flow approved outright; the new flow must fail closed
    const out = applyTopicPage(kb.kbRoot, { slug: 'pay-timeout', title: 'Payment Timeout', sources: [v1, v2] }, 'fused synthesis');
    assert.equal(out.status, 'candidate');
    const { fields } = kb.readPage('wiki/topics/pay-timeout.md');
    assert.equal(fields.status, 'candidate');
    assert.match(fields.review_note, /forced candidate/);
  } finally { kb.cleanup(); }
});

test('P0-1 integration: archived loser is tombstoned → not re-pended, apply-source refuses', () => {
  const kb = makeKb();
  try {
    const [v1, v2] = writeVersionPair(kb, 'loser');
    applySourcePage(kb.kbRoot, v1, 'Summary v1.');
    applySourcePage(kb.kbRoot, v2, 'Summary v2.');
    const loserPage = 'wiki/sources/local-pay-timeout-v2-loser.md';
    assert.ok(fs.existsSync(path.join(kb.kbRoot, loserPage)));
    // adjudication: v2 is the loser → archive its source page (tombstones its raw)
    const arch = archivePage(kb.kbRoot, loserPage, { note: 'loser of conflict group' });
    assert.equal(arch.page, 'wiki/archive/local-pay-timeout-v2-loser.md');
    assert.ok(readTombstones(kb.kbRoot)[v2], 'loser raw tombstoned');
    // next plan: v2 raw suppressed, never pending; apply-source refuses revival
    const p = plan(kb.kbRoot);
    assert.equal(p.pending.length, 0, 'no resurrection of the adjudicated loser');
    assert.ok(p.suppressed.some((s) => s.raw === v2 && s.reason === 'tombstoned'));
    assert.throws(() => applySourcePage(kb.kbRoot, v2, 'revive?'),
      /raw is tombstoned \(loser-archive\); use --force to revive/);
  } finally { kb.cleanup(); }
});

test('CLI dismiss-conflict persists the pair so the next plan reports it dismissed', () => {
  const kb = makeKb();
  try {
    const [a, b] = writeVersionPair(kb, 'cli');
    plan(kb.kbRoot);
    // exercise the library's addDismissal through its public export
    const d = addDismissal(kb.kbRoot, [a, b], 'parallel documents');
    assert.deepEqual(d.raws, [a, b].sort());
    const p = plan(kb.kbRoot);
    const g = p.conflicts.find((x) => x.category === 'similar' && x.raws.includes(a));
    assert.equal(g.dismissed, true);
    assert.ok(readDismissals(kb.kbRoot).length === 1);
  } finally { kb.cleanup(); }
});
