// Retrieval effectiveness evaluation (catalog docs/plans/test-catalog.md §C):
// golden dataset tests/eval/golden/queries.json (~45 queries, categorized,
// graded relevance) against a deterministic scratch KB. CLI AND-semantics path
// for exact/phrase/CJK/filter/negative; conversational queries run through
// searchWithFallback (the chat product path). Report: overall Hit@1/Hit@5/MRR
// plus per-category breakdown; gate Hit@5 ≥ 0.85 on non-conversational.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SCRIPTS, REPO, FIXTURES, sourcePageFor, runCli, copyInbox, makeScratchKb, acquire, govern, applyAllSources, rawRelFor,
} from '../helpers/kb.mjs';
import { searchWithFallback } from '../../llm/lib/research.mjs';

const QUERIES = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'eval', 'golden', 'queries.json'), 'utf8'));
const HIT5_THRESHOLD = 0.85;

let kb;
const rows = [];
const pageOf = (ref) => ref.startsWith('topic:') ? `wiki/syntheses/${ref.slice(6)}.md` : sourcePageFor(ref);

before(() => {
  kb = makeScratchKb('kb-eval-');
  copyInbox(kb);
  // conversational corpus (kept out of the shared inbox so pipeline counts stay
  // stable; deterministic mtimes for the date-filter queries)
  const SCENARIO_MTIMES = {
    'faq-retry.md': '2026-07-26T08:00:00.000Z',
    'incident-settlement-delay.md': '2026-07-29T08:00:00.000Z',
  };
  for (const [f, m] of Object.entries(SCENARIO_MTIMES)) {
    const dst = path.join(kb, 'inbox', f);
    fs.copyFileSync(path.join(FIXTURES, 'scenarios', f), dst);
    const t = new Date(m);
    fs.utimesSync(dst, t, t);
  }
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

function hit5of(rs) { return rs.length ? rs.filter((r) => r.firstRank >= 0 && r.firstRank < 5).length / rs.length : 0; }

function writeReport() {
  const dir = path.join(REPO, 'docs', 'test-reports');
  fs.mkdirSync(dir, { recursive: true });
  const scored = rows.filter((r) => !r.expectEmpty);
  const cli = scored.filter((r) => r.category !== 'conversational');
  const convo = scored.filter((r) => r.category === 'conversational');
  const hit1 = scored.filter((r) => r.firstRank === 0).length / scored.length;
  const hit5 = hit5of(scored);
  const mrr = scored.reduce((s, r) => s + (r.firstRank >= 0 ? 1 / (r.firstRank + 1) : 0), 0) / scored.length;

  const cats = [...new Set(scored.map((r) => r.category))];
  const catLines = cats.map((c) => {
    const rs = scored.filter((r) => r.category === c);
    return `| ${c} | ${rs.length} | ${rs.filter((r) => r.firstRank === 0).length} | ${hit5of(rs).toFixed(2)} |`;
  });

  const exp = scored.filter((r) => r.expansionTotal).map((r) => r.expansionTotal);
  const dilutionLine = exp.length
    ? `expansion per query: avg ${(exp.reduce((s, x) => s + x, 0) / exp.length).toFixed(1)} candidates · max ${Math.max(...exp)}`
    : 'no graph expansion in this run';

  const lines = [
    '# Retrieval Evaluation Report',
    '',
    `Date: ${new Date().toISOString()} · golden set: ${QUERIES.length} queries (${scored.length} scored + ${QUERIES.length - scored.length} negative)`,
    '',
    `**Hit@1 = ${hit1.toFixed(3)} · Hit@5 = ${hit5.toFixed(3)} (gate ≥${HIT5_THRESHOLD}, non-conversational ${hit5of(cli).toFixed(3)}) · MRR = ${mrr.toFixed(3)}**`,
    `**conversational (fallback path, tracked, not gated): Hit@5 = ${hit5of(convo).toFixed(3)} (${convo.length} queries)**`,
    '',
    '## per-category',
    '',
    '| category | n | hit@1 | hit@5 |', '|---|---|---|---|', ...catLines, '',
    `candidate dilution: ${dilutionLine}`,
    '',
    '| id | cat | query | expected | first-rank | top-5 | routed | result |',
    '|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.category} | \`${r.q}\` | ${r.expect.join('<br>') || '(empty expected)'} | ${r.expectEmpty ? '—' : (r.firstRank < 0 ? 'MISS' : r.firstRank + 1)} | ${r.top5.join('<br>')} | ${r.routed} | ${r.ok ? '✅' : '❌'} |`),
    '',
  ];
  fs.writeFileSync(path.join(dir, 'retrieval-eval-latest.md'), lines.join('\n'));
  console.log(`\n[eval] Hit@1=${hit1.toFixed(3)} Hit@5=${hit5.toFixed(3)} MRR=${mrr.toFixed(3)} · conversational Hit@5=${hit5of(convo).toFixed(3)} · ${dilutionLine} → docs/test-reports/retrieval-eval-latest.md`);
}

test('retrieval effectiveness: golden query set', async (t) => {
  for (const q of QUERIES) {
    await t.test(`${q.id} [${q.category}] ${q.q}`, async () => {
      const expectPages = (q.expect || []).map(pageOf);
      let preview, routed, candidatesFile;
      if (q.via === 'fallback') {
        const res = await searchWithFallback(kb, q.q, { limit: 10 });
        preview = (res.preview || []).map((c) => c.page);
        routed = res.relaxed ? `fallback(${res.relaxed_query || (res.relaxed_terms || []).join('|')})` : 'direct';
        candidatesFile = null;
      } else {
        const res = runCli(SCRIPTS.search, ['search', q.q, '--kb', kb]);
        preview = res.preview.map((c) => c.page);
        routed = Object.entries(res.routed).filter(([, v]) => v.length).map(([k, v]) => `${k}:${v.join('/')}`).join(' ') || '(filters only)';
        candidatesFile = res.candidates_file;
      }
      const firstRank = preview.findIndex((p) => expectPages.includes(p));
      const row = {
        id: q.id, category: q.category, q: q.q, expect: expectPages, expectEmpty: !!q.expectEmpty,
        firstRank, top5: preview.slice(0, 5).map((p) => p.replace('wiki/', '')),
        routed, expansionTotal: 0, ok: true,
      };
      rows.push(row);
      try {
        if (q.expectEmpty) {
          assert.equal(preview.length, 0, `negative query must return nothing, got ${JSON.stringify(preview)}`);
          return;
        }
        if (q.knownMiss) {
          // Documented baseline: misses today, and the test FAILS LOUDLY the day
          // query rewriting makes it hit — so the dataset gets re-annotated.
          assert.ok(firstRank < 0,
            `knownMiss baseline flipped — ${q.q} now hits ${JSON.stringify(preview.slice(0, 3))}; promote it to a scored expect`);
          row.routed += ' (knownMiss baseline)';
          return;
        }
        assert.ok(firstRank >= 0, `none of ${JSON.stringify(expectPages)} in preview ${JSON.stringify(preview.slice(0, 8))}`);
        for (const abs of (q.absent || []).map(pageOf)) {
          assert.ok(!preview.includes(abs), `${abs} must be absent from preview`);
        }
        if (q.onlyType) {
          const typeDir = { source: 'sources', entity: 'entities', concept: 'concepts', synthesis: 'syntheses' }[q.onlyType];
          for (const p of preview) assert.ok(p.includes(`/${typeDir}/`), `${p} is not a ${q.onlyType} page`);
        }
        if (q.routed) {
          const res = runCli(SCRIPTS.search, ['search', q.q, '--kb', kb]);
          assert.ok(res.routed[q.routed.leg].includes(q.routed.term),
            `term ${q.routed.term} must route to ${q.routed.leg}, got ${JSON.stringify(res.routed)}`);
        }
        if (q.expectViaLink) {
          const full = JSON.parse(fs.readFileSync(path.join(kb, candidatesFile), 'utf8'));
          const target = pageOf(q.expectViaLink);
          assert.ok(full.candidates.some((c) => c.page === target && c.via === 'link'),
            `${target} must appear via graph expansion`);
        }
        if (candidatesFile) {
          const full = JSON.parse(fs.readFileSync(path.join(kb, candidatesFile), 'utf8'));
          row.expansionTotal = full.candidates.filter((c) => c.via === 'link' || c.via === 'provenance').length;
        }
      } catch (err) {
        row.ok = false;
        throw err;
      }
    });
  }

  const scored = rows.filter((r) => !r.expectEmpty);
  const cli = scored.filter((r) => r.category !== 'conversational');
  const hit5 = hit5of(cli);
  assert.ok(hit5 >= HIT5_THRESHOLD, `non-conversational Hit@5 ${hit5.toFixed(3)} below threshold ${HIT5_THRESHOLD}`);
});
