// Chat quality evaluation (catalog docs/plans/test-catalog.md §D, L3).
// Real LLM, report-only (never gates CI). Requires a config donor:
//   set WEFT_EVAL_CONFIG_KB=<kb with .kb/config/models.json>
// Each item runs the real chat task, then auto-checks (behavior, citations,
// must_say) and RAGAS-style LLM-as-judge metrics (faithfulness, relevance,
// context precision). Report: docs/test-reports/chat-eval-latest.md.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  SCRIPTS, REPO, FIXTURES, sourcePageFor, copyInbox, makeScratchKb, acquire, govern, applyAllSources,
  rawRelFor, runLlm,
} from '../helpers/kb.mjs';

const DATASET = JSON.parse(fs.readFileSync(path.join(REPO, 'tests', 'eval', 'chat-eval', 'dataset.json'), 'utf8'));
const DONOR = process.env.WEFT_EVAL_CONFIG_KB;
const REFUSAL_MARKERS = ['没有', '未涵盖', '无法回答', '无相关', 'nothing', 'not in the', 'no information', 'does not cover'];

let kb;
const rows = [];

const pageOf = (ref) => ref.startsWith('topic:') ? `wiki/syntheses/${ref.slice(6)}.md` : sourcePageFor(ref);

before(() => {
  if (!DONOR || !fs.existsSync(path.join(DONOR, '.kb', 'config', 'models.json'))) return;
  kb = makeScratchKb('kb-chateval-');
  copyInbox(kb);
  for (const f of ['faq-retry.md', 'incident-settlement-delay.md']) {
    fs.copyFileSync(path.join(FIXTURES, 'scenarios', f), path.join(kb, 'inbox', f));
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
  govern(kb, ['rebuild-index']);
  // donor config: real models.json + prompts for chat and judge prompts
  fs.mkdirSync(path.join(kb, '.kb', 'config'), { recursive: true });
  fs.copyFileSync(path.join(DONOR, '.kb', 'config', 'models.json'), path.join(kb, '.kb', 'config', 'models.json'));
});

after(() => {
  if (!kb) return;
  writeReport();
  fs.rmSync(kb, { recursive: true, force: true });
});

function runChat(question, level) {
  const out = path.join(kb, '.kb', `eval-${Date.now()}-${Math.floor(Math.random() * 1e6)}.ndjson`);
  runLlm(kb, 'chat', { question, level }, out);
  const frames = fs.readFileSync(out, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  return {
    answer: frames.filter((f) => f.type === 'chunk').map((f) => f.text).join(''),
    citations: frames.find((f) => f.type === 'done')?.citations || [],
    reads: frames.filter((f) => f.type === 'read').map((f) => f.page),
    errors: frames.filter((f) => f.type === 'error').map((f) => f.message),
  };
}

function pageBody(rel, max = 2500) {
  const abs = path.join(kb, rel);
  if (!fs.existsSync(abs)) return '';
  const text = fs.readFileSync(abs, 'utf8');
  return text.slice(text.indexOf('---', 4) + 3).trim().slice(0, max);
}

// ADR-0012: judge prompts run in the Python agent service via the generic
// `prompt` task (the Node llm/lib in-process import is gone).
function judge(promptName, vars) {
  try {
    return runLlm(kb, 'prompt', { prompt_name: promptName, vars }).data;
  } catch (err) {
    return { error: err.message.slice(0, 200) };
  }
}

function writeReport() {
  const dir = path.join(REPO, 'docs', 'test-reports');
  fs.mkdirSync(dir, { recursive: true });
  const avg = (k) => {
    const vals = rows.map((r) => r[k]).filter((v) => typeof v === 'number');
    return vals.length ? (vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(3) : '—';
  };
  const behaviorOk = rows.filter((r) => r.behaviorOk).length;
  const citeOk = rows.filter((r) => r.behavior === 'answer' && r.citeOk).length;
  const answerRows = rows.filter((r) => r.behavior === 'answer');
  const lines = [
    '# Chat Quality Evaluation Report', '',
    `Date: ${new Date().toISOString()} · dataset: ${rows.length} items · judge: same provider as chat`, '',
    `**behavior accuracy = ${behaviorOk}/${rows.length} · citation validity = ${citeOk}/${answerRows.length}**`,
    `**faithfulness = ${avg('faithfulness')} · relevance = ${avg('relevance')} · context precision = ${avg('contextPrecision')}**`, '',
    '| id | q | level | behavior | auto | citations | faithfulness | relevance | ctx-precision |',
    '|---|---|---|---|---|---|---|---|---|',
    ...rows.map((r) => `| ${r.id} | ${r.question.slice(0, 24)} | ${r.level} | ${r.behavior} | ${r.behaviorOk ? '✅' : '❌'} | ${r.citations.map((c) => path.basename(c, '.md')).join('<br>') || '—'} | ${fmt(r.faithfulness)} | ${fmt(r.relevance)} | ${fmt(r.contextPrecision)} |`),
    '',
    '## notes', '',
    ...rows.filter((r) => r.note).map((r) => `- **${r.id}**: ${r.note}`),
    '',
  ];
  fs.writeFileSync(path.join(dir, 'chat-eval-latest.md'), lines.join('\n'));
  console.log(`\n[chat-eval] behavior ${behaviorOk}/${rows.length} · faithfulness ${avg('faithfulness')} · relevance ${avg('relevance')} · ctxPrecision ${avg('contextPrecision')} → docs/test-reports/chat-eval-latest.md`);
}
const fmt = (v) => (typeof v === 'number' ? v.toFixed(2) : '—');

test('chat quality: dataset through real LLM + judge', { timeout: 1_800_000 }, async (t) => {
  if (!kb) {
    t.skip('no WEFT_EVAL_CONFIG_KB donor with .kb/config/models.json — L3 eval is opt-in');
    return;
  }
  for (const item of DATASET) {
    await t.test(`${item.id} ${item.question}`, async () => {
      const r = await runChat(item.question, item.level);
      const row = {
        id: item.id, question: item.question, level: item.level, behavior: item.behavior,
        citations: r.citations, behaviorOk: false, citeOk: true, note: '',
      };
      const problems = [];
      // --- auto checks ---
      if (r.errors.length) problems.push(`error frames: ${r.errors[0].slice(0, 80)}`);
      if (item.behavior === 'refuse') {
        // refusal = the answer says the KB doesn't cover it. Citations may be
        // non-empty (the model can mention pages it judged irrelevant) but each
        // one must still be real and approved.
        const refused = REFUSAL_MARKERS.some((m) => r.answer.toLowerCase().includes(m.toLowerCase()));
        row.behaviorOk = refused;
        if (!refused) problems.push(`expected grounded refusal, got answer="${r.answer.slice(0, 80)}"`);
        for (const c of r.citations) {
          const abs = path.join(kb, c);
          if (!fs.existsSync(abs) || !/^status:\s*approved/m.test(fs.readFileSync(abs, 'utf8'))) {
            row.behaviorOk = false;
            problems.push(`invalid citation on refusal ${c}`);
          }
        }
      } else {
        const expects = (item.must_cite || []).map(pageOf);
        const hit = item.cite_any ? expects.some((p) => r.citations.includes(p)) : expects.every((p) => r.citations.includes(p));
        row.behaviorOk = hit && r.answer.length > 0;
        if (!hit) problems.push(`missing citations (expected ${expects.map((p) => path.basename(p)).join(' or ')})`);
        for (const s of item.must_say || []) {
          if (!r.answer.includes(s)) { row.behaviorOk = false; problems.push(`answer missing "${s}"`); }
        }
        // citation validity: every citation exists and is approved
        for (const c of r.citations) {
          const abs = path.join(kb, c);
          if (!fs.existsSync(abs)) { row.citeOk = false; problems.push(`phantom citation ${c}`); continue; }
          if (!/^status:\s*approved/m.test(fs.readFileSync(abs, 'utf8'))) { row.citeOk = false; problems.push(`citation not approved ${c}`); }
        }
        if (!row.citeOk) row.behaviorOk = false;
      }
      // --- LLM-as-judge (answer rows only) ---
      if (item.behavior === 'answer' && r.answer) {
        const context = r.reads.map((p) => `## ${p}\n${pageBody(p)}`).join('\n\n').slice(0, 6000);
        const [f, rel, cp] = await Promise.all([
          judge('judge-faithfulness', { context, answer: r.answer }),
          judge('judge-relevance', { question: item.question, answer: r.answer }),
          r.reads.length ? judge('judge-context-precision', { question: item.question, context }) : null,
        ]);
        if (typeof f.score === 'number') row.faithfulness = f.score;
        if (typeof rel.score === 'number') row.relevance = rel.score;
        if (cp && typeof cp.score === 'number') row.contextPrecision = cp.score;
        if (f.error) problems.push(`judge-faithfulness error: ${f.error}`);
      }
      row.note = problems.join('; ');
      rows.push(row);
      // L3: report-only — log failures but do not gate the suite
      if (problems.length) t.diagnostic(problems.join(' | '));
    });
  }
  assert.ok(rows.length === DATASET.length, 'every dataset item ran');
});
