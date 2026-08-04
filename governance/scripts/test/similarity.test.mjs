// Conflict-signal unit tests (plan 0001 §2). Covers: CJK-aware body similarity
// (P1-6 — Latin token ∪ CJK shingles), the three pre-filter conditions, the
// exact-duplicate hash rule (both sides must carry content_hash), the same-title
// collision non-signal (Overview), and the bucket-cap O(n²) guard (P0-2).
// The last test calibrates the DEFAULT threshold against a fixture set: version
// pairs must clear it, same-title parallel documents must not (plan §2.2.3).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {
  findGroups, jaccard, normalizeBody, deVersionFilename, tokenize, titleTokensOverlap,
  DEFAULT_SIMILARITY_THRESHOLD,
} from '../lib/similarity.mjs';

const doc = (rel, title, body, hash) => ({ rel, title, filename: path.basename(rel), body, content_hash: hash });

const latinV1 = 'The payment gateway must support timeout retries with exponential backoff.';
const latinV2 = 'The payment gateway must support timeout retries with exponential backoff and implement connection jitter.';
const cjkV1 = '支付网关需要支持超时重试和指数退避策略，确保请求在失败后能够自动恢复。';
const cjkV2 = cjkV1 + '并增加连接抖动控制。';

test('body similarity: latin + CJK + mixed version pairs score above the default threshold', () => {
  const latin = jaccard(normalizeBody(latinV1), normalizeBody(latinV2));
  const cjk = jaccard(normalizeBody(cjkV1), normalizeBody(cjkV2));
  const mixed = jaccard(
    normalizeBody('Payment timeout handling: 支付超时重试策略采用指数退避，确保请求自动恢复。'),
    normalizeBody('Payment timeout handling: 支付超时重试策略采用指数退避，确保请求自动恢复，并加入连接抖动。'),
  );
  assert.ok(latin >= DEFAULT_SIMILARITY_THRESHOLD, `latin version pair ${latin} must be flagged`);
  assert.ok(cjk >= DEFAULT_SIMILARITY_THRESHOLD, `CJK version pair ${cjk} must be flagged (P1-6)`);
  assert.ok(mixed >= DEFAULT_SIMILARITY_THRESHOLD, `mixed pair ${mixed} must be flagged`);
});

test('pre-filter conditions: same title / token overlap / de-versioned filename', () => {
  assert.equal(deVersionFilename('pay-timeout-v1.md'), 'pay-timeout');
  assert.equal(deVersionFilename('pay-timeout-v2.md'), 'pay-timeout');
  assert.equal(deVersionFilename('pay-timeout (1).md'), 'pay-timeout');
  assert.equal(deVersionFilename('pay-timeout.md'), 'pay-timeout');
  assert.equal(deVersionFilename('http-404.md'), 'http-404', 'a bare numeric tail is NOT a version marker');
  assert.equal(titleTokensOverlap(tokenize('Payment'), tokenize('Payment Timeout')), true, 'containment counts');
  assert.equal(titleTokensOverlap(tokenize('Payment Gateway Requirements'), tokenize('Payment Gateway Requirements v2')), true);
});

test('findGroups: version pair via title-token pre-filter → similar group with score', () => {
  const { groups } = findGroups([
    doc('raw/local/a-pay-v1.md', 'Payment Gateway Requirements', latinV1, 'sha256:1'),
    doc('raw/local/b-pay-v2.md', 'Payment Gateway Requirements v2', latinV2, 'sha256:2'),
  ]);
  const g = groups.find((x) => x.category === 'similar');
  assert.ok(g, 'similar group must exist');
  assert.deepEqual(g.raws, ['raw/local/a-pay-v1.md', 'raw/local/b-pay-v2.md']);
  assert.ok(g.score >= DEFAULT_SIMILARITY_THRESHOLD);
});

test('findGroups: same-title collision is NOT flagged when bodies diverge (Overview case)', () => {
  const { groups } = findGroups([
    doc('raw/local/a.md', 'Overview', 'Quarterly budget allocation across engineering teams, headcount planning and procurement limits.', 'sha256:1'),
    doc('raw/local/b.md', 'Overview', 'Onboarding guidelines: equipment setup, security training, first-week milestones.', 'sha256:2'),
  ]);
  assert.equal(groups.filter((x) => x.category === 'similar').length, 0, 'parallel same-title docs must not be flagged');
});

test('findGroups: exact duplicate requires BOTH sides to carry content_hash', () => {
  // both present, equal → duplicate
  const withHash = findGroups([
    doc('raw/local/a.md', 'T', 'same body', 'sha256:SAME'),
    doc('raw/local/b.md', 'T', 'same body', 'sha256:SAME'),
  ]);
  assert.equal(withHash.groups.filter((g) => g.category === 'duplicate').length, 1);
  // one side missing the field → not a duplicate (null == null is never a dup, §2.2)
  const missing = findGroups([
    doc('raw/local/a.md', 'T', 'same body', 'sha256:SAME'),
    doc('raw/local/b.md', 'T', 'same body', undefined),
  ]);
  assert.equal(missing.groups.filter((g) => g.category === 'duplicate').length, 0);
});

test('findGroups: duplicate classification wins over similar (a hash-equal pair is one group)', () => {
  const { groups } = findGroups([
    doc('raw/local/a.md', 'T', 'identical', 'sha256:SAME'),
    doc('raw/local/b.md', 'T', 'identical', 'sha256:SAME'),
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].category, 'duplicate');
  assert.equal(groups[0].hash, 'sha256:SAME');
});

test('bucket cap: a same-title bucket above the cap degrades instead of going O(n²) (P0-2)', () => {
  const raws = [];
  for (let i = 0; i < 2000; i++) raws.push(doc(`raw/local/x${i}.md`, 'Overview', `distinct body ${i}`, `sha256:${i}`));
  const { groups, warnings } = findGroups(raws, { bucketCap: 400 });
  assert.equal(groups.length, 0, 'no O(n²) pairwise work for a degenerate bucket');
  assert.ok(warnings.some((w) => w.signal === 'same-title' && w.size === 2000), 'degradation must be reported');
});

test('threshold calibration fixture (plan §2.2.3): versions clear the default, parallels do not', () => {
  const versionPairs = [
    [latinV1, latinV2],
    [cjkV1, cjkV2],
    ['The retry budget is capped at three attempts.', 'The retry budget is capped at three attempts and honors jitter.'],
  ];
  const parallelPairs = [
    ['Quarterly budget allocation across engineering teams, headcount planning and procurement limits.', 'Onboarding guidelines: equipment setup, security training, first-week milestones.'],
    ['Release notes for the payment gateway 3.2 service.', 'Incident report for the 2026-07-01 payment outage.'],
  ];
  let minVersion = 1, maxParallel = 0;
  for (const [a, b] of versionPairs) minVersion = Math.min(minVersion, jaccard(normalizeBody(a), normalizeBody(b)));
  for (const [a, b] of parallelPairs) maxParallel = Math.max(maxParallel, jaccard(normalizeBody(a), normalizeBody(b)));
  // assert a clean gap straddling the default threshold (0.5 sits inside it)
  assert.ok(minVersion > maxParallel, `gap must exist (versions ≥ ${minVersion}, parallels ≤ ${maxParallel})`);
  assert.ok(minVersion >= DEFAULT_SIMILARITY_THRESHOLD, `default ${DEFAULT_SIMILARITY_THRESHOLD} must flag the weakest version pair (${minVersion})`);
  assert.ok(maxParallel < DEFAULT_SIMILARITY_THRESHOLD, `default ${DEFAULT_SIMILARITY_THRESHOLD} must not flag the closest parallel pair (${maxParallel})`);
});
