#!/usr/bin/env node
// K4 judge calibration (manual run, zero deps): does the LLM judge agree with
// the golden set? Rebuilds the deterministic fixture KB exactly like
// tests/eval, runs every golden query through the REAL retrieval stack,
// judges each top-5 with the judge backend (default agent), and reports
// agreement metrics to docs/test-reports/judge-calibration-latest.md.
//
//   node ui/script/judge-calibrate.mjs [--backend agent] [--limit N]
//
// Cost: ~1 judge call per query (top-5 batched) × ~25s each — several
// minutes for the full set. This is a calibration tool, not a CI gate:
// the CI regression stays tests/eval (Hit@5), the judge is a complement (K4).
import fs from 'node:fs';
import path from 'node:path';
import {
  REPO, sourcePageFor, copyInbox, makeScratchKb, acquire, govern, applyAllSources, rawRelFor,
} from '../../tests/helpers/kb.mjs';
import { ensureFresh } from '../../retrieval/scripts/lib/store.mjs';
import { search } from '../../retrieval/scripts/lib/query.mjs';
import { judge } from '../lib/judge.mjs';

const args = process.argv.slice(2);
const getArg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const backend = getArg('--backend', 'agent');
const limit = Number(getArg('--limit', 'Infinity'));

const QUERIES = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'eval', 'queries.json'), 'utf8'));
const pageOf = (ref) => ref.startsWith('topic:') ? `wiki/topics/${ref.slice(6)}.md` : sourcePageFor(ref);

const kb = makeScratchKb('kb-judge-cal-');
try {
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
  ensureFresh(kb);

  const rows = [];
  const scored = QUERIES.filter((q) => !q.expectEmpty).slice(0, limit);
  for (const { id, q, expect } of scored) {
    const expected = expect.map(pageOf);
    const result = search(kb, q, { limit: 5 });
    const top5 = result.preview.slice(0, 5);
    const hitExpected = expected.filter((p) => top5.some((c) => c.page === p));
    let verdicts = [], ms = 0, judgeErr = '';
    if (top5.length) {
      try {
        const v = await judge(backend, q, top5.map((c) => ({ page: c.page, title: c.title, snippet: c.snippet })), { kb });
        verdicts = v.verdicts;
        ms = v.ms;
      } catch (err) { judgeErr = err.message; }
    }
    // agreement: judge's highest-scored page is golden (when a golden page is
    // in the top-5 at all); and the mean judge score of golden pages present
    let topJudge = null, meanExpected = null;
    if (verdicts.length) {
      let best = -1;
      verdicts.forEach((v, i) => { if (v.score !== null && v.score > best) { best = v.score; topJudge = top5[i].page; } });
      const expScores = top5.map((c, i) => hitExpected.includes(c.page) ? verdicts[i]?.score : null).filter((s) => s !== null && s !== undefined);
      if (expScores.length) meanExpected = expScores.reduce((a, b) => a + b, 0) / expScores.length;
    }
    rows.push({
      id, q, expected: expected.map((p) => p.split('/').pop()),
      goldenInTop5: hitExpected.length, topJudge: topJudge ? topJudge.split('/').pop() : '—',
      agree: topJudge !== null && expected.includes(topJudge),
      meanExpected, ms, judgeErr,
    });
    console.log(`${id} ${agreeMark(rows.at(-1))} goldenInTop5=${hitExpected.length} topJudge=${rows.at(-1).topJudge} (${(ms / 1000).toFixed(0)}s)`);
  }

  const judged = rows.filter((r) => !r.judgeErr && r.goldenInTop5 > 0);
  const agreeRate = judged.length ? judged.filter((r) => r.agree).length / judged.length : 0;
  const meanScore = judged.length ? judged.reduce((s, r) => s + (r.meanExpected ?? 0), 0) / judged.length : 0;
  const report = [
    '# Judge Calibration Report (K4)', '',
    `Date: ${new Date().toISOString()} · backend: ${backend} · ${rows.length} golden queries (fixture corpus)`, '',
    `**judge↔golden top-1 agreement = ${(agreeRate * 100).toFixed(1)}% (${judged.filter((r) => r.agree).length}/${judged.length}) · mean judge score of golden pages = ${meanScore.toFixed(2)}/3**`, '',
    'Reading: agreement asks whether the judge\'s highest-scored page is a golden',
    'page (only queries where retrieval already placed a golden page in top-5);',
    'mean score asks whether the judge recognizes golden pages as relevant (≥2 good).', '',
    '| id | query | golden in top-5 | judge top pick | agree | golden mean score | note |',
    '|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | \`${r.q}\` | ${r.goldenInTop5} | ${r.topJudge} | ${r.agree ? '✅' : (r.goldenInTop5 ? '❌' : '—')} | ${r.meanExpected?.toFixed(1) ?? '—'} | ${r.judgeErr ? `judge error: ${r.judgeErr.slice(0, 60)}` : ''} |`),
    '',
  ].join('\n');
  const out = path.join(REPO, 'docs', 'test-reports', 'judge-calibration-latest.md');
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, report, 'utf8');
  console.log(`\nagreement ${(agreeRate * 100).toFixed(1)}% · golden mean ${meanScore.toFixed(2)}/3 · report → ${path.relative(REPO, out)}`);
} finally {
  fs.rmSync(kb, { recursive: true, force: true });
}

function agreeMark(r) {
  return r.judgeErr ? 'ERR' : r.agree ? '✓' : r.goldenInTop5 ? '✗' : '—';
}
