// Retrieval effectiveness evaluation: builds a deterministic scratch KB from
// the fixture corpus (all docs governed, three approved topics), runs the
// golden query set (queries.json) through the REAL kb_search CLI, and scores
// Hit@1 / Hit@5 / MRR plus gate/routing behavior. Writes a markdown report to
// docs/test-reports/retrieval-eval-latest.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SCRIPTS, REPO, sourcePageFor, runCli, copyInbox, makeScratchKb, acquire, govern, applyAllSources, rawRelFor,
} from '../helpers/kb.mjs';

const QUERIES = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'eval', 'queries.json'), 'utf8'));
const HIT5_THRESHOLD = 0.85;

let kb;
const rows = [];
const pageOf = (ref) => ref.startsWith('topic:') ? `wiki/topics/${ref.slice(6)}.md` : sourcePageFor(ref);

before(() => {
  kb = makeScratchKb('kb-eval-');
  copyInbox(kb);
  acquire(kb);
  applyAllSources(kb);
  govern(kb, ['apply-topic', '--slug', 'retry-resilience', '--title', 'Retry Resilience',
    '--sources', [rawRelFor('payment-timeout-retry.md'), rawRelFor('idempotency-design.md'), rawRelFor('订单超时关闭.md')].join(','),
    '--tags', 'retry,resilience'],
    'How PayCore keeps payment calls resilient: bounded retries with exponential backoff, idempotency keys, and order-close interplay. See [[payment-safety]].\n');
  govern(kb, ['apply-topic', '--slug', 'payment-safety', '--title', 'Payment Safety',
    '--sources', [rawRelFor('idempotency-design.md'), rawRelFor('payment-compensation.md')].join(','), '--tags', 'safety,idempotency'],
    'Idempotency keys and saga compensation together prevent double charges and half-applied payments. Related: [[retry-resilience]].\n');
  govern(kb, ['apply-topic', '--slug', 'recon-ops', '--title', 'Reconciliation Operations',
    '--sources', [rawRelFor('reconciliation.md'), rawRelFor('支付对账流程.md')].join(','), '--tags', 'reconciliation,operations'],
    'Daily reconciliation compares settlement files with the ledger; discrepancies follow a two-business-day SLA.\n');
  govern(kb, ['rebuild-index']);
});
after(() => {
  writeReport();
  fs.rmSync(kb, { recursive: true, force: true });
});

function writeReport() {
  const dir = path.join(REPO, 'docs', 'test-reports');
  fs.mkdirSync(dir, { recursive: true });
  const scored = rows.filter((r) => !r.expectEmpty);
  const hit1 = scored.filter((r) => r.firstRank === 0).length / scored.length;
  const hit5 = scored.filter((r) => r.firstRank >= 0 && r.firstRank < 5).length / scored.length;
  const mrr = scored.reduce((s, r) => s + (r.firstRank >= 0 ? 1 / (r.firstRank + 1) : 0), 0) / scored.length;
  const lines = [
    '# Retrieval Evaluation Report',
    '',
    `Date: ${new Date().toISOString()} · KB: fixture corpus (${Object.keys(rows).length ? '' : ''}${scored.length + 1} queries, ${scored.length} scored + 1 negative)`,
    '',
    `**Hit@1 = ${hit1.toFixed(3)} · Hit@5 = ${hit5.toFixed(3)} (threshold ${HIT5_THRESHOLD}) · MRR = ${mrr.toFixed(3)}**`,
    '',
    '| id | query | expected | first-rank | top-5 pages | routed | result |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | \`${r.q}\` | ${r.expect.join('<br>') || '(empty expected)'} | ${r.expectEmpty ? '—' : (r.firstRank < 0 ? 'MISS' : r.firstRank + 1)} | ${r.top5.join('<br>')} | ${r.routed} | ${r.ok ? '✅' : '❌'} |`),
    '',
  ];
  fs.writeFileSync(path.join(dir, 'retrieval-eval-latest.md'), lines.join('\n'));
  console.log(`\n[eval] Hit@1=${hit1.toFixed(3)} Hit@5=${hit5.toFixed(3)} MRR=${mrr.toFixed(3)} → docs/test-reports/retrieval-eval-latest.md`);
}

test('retrieval effectiveness: golden query set', async (t) => {
  for (const q of QUERIES) {
    await t.test(`${q.id} ${q.q}`, () => {
      const res = runCli(SCRIPTS.search, ['search', q.q, '--kb', kb]);
      const preview = res.preview.map((c) => c.page);
      const expectPages = (q.expect || []).map(pageOf);
      const firstRank = preview.findIndex((p) => expectPages.includes(p));
      const row = {
        id: q.id, q: q.q, expect: expectPages, expectEmpty: !!q.expectEmpty,
        firstRank, top5: preview.slice(0, 5).map((p) => p.replace('wiki/', '')),
        routed: Object.entries(res.routed).filter(([, v]) => v.length).map(([k, v]) => `${k}:${v.join('/')}`).join(' ') || '(filters only)',
        ok: true,
      };
      rows.push(row);
      try {
        if (q.expectEmpty) {
          assert.equal(res.total, 0, `negative query must return nothing, got ${JSON.stringify(preview)}`);
          return;
        }
        assert.ok(firstRank >= 0, `none of ${JSON.stringify(expectPages)} in preview ${JSON.stringify(preview)}`);
        for (const abs of (q.absent || []).map(pageOf)) {
          assert.ok(!preview.includes(abs), `${abs} must be absent from preview`);
        }
        if (q.onlyType) {
          for (const p of preview) assert.ok(p.includes(`/${q.onlyType}s/`), `${p} is not a ${q.onlyType} page`);
        }
        if (q.routed) {
          assert.ok(res.routed[q.routed.leg].includes(q.routed.term),
            `term ${q.routed.term} must route to ${q.routed.leg}, got ${JSON.stringify(res.routed)}`);
        }
        if (q.expectViaLink) {
          const full = JSON.parse(fs.readFileSync(path.join(kb, res.candidates_file), 'utf8'));
          const target = pageOf(q.expectViaLink);
          assert.ok(full.candidates.some((c) => c.page === target && c.via === 'link'),
            `${target} must appear via graph expansion`);
        }
      } catch (err) {
        row.ok = false;
        throw err;
      }
    });
  }

  const scored = rows.filter((r) => !r.expectEmpty);
  const hit5 = scored.filter((r) => r.firstRank >= 0 && r.firstRank < 5).length / scored.length;
  assert.ok(hit5 >= HIT5_THRESHOLD, `Hit@5 ${hit5.toFixed(3)} below threshold ${HIT5_THRESHOLD}`);
});
