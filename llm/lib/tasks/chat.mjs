// chat — page-level Q&A, streaming NDJSON. Every level retrieves (the product
// promise is "answers are KB-grounded"); they differ in depth:
//   quick         top-3 snippet grounding, single LLM call, fastest
//   deep          top-5 snippet grounding, single LLM call
//   deep-research multi-round search→read loop with full reasoning trace
// Context assembly (C3): full wiki page bodies instead of match snippets, and
// for source pages the raw evidence is followed via source_ref (llm reads of
// wiki/ + raw/ are in-contract) — the summary stays the discovery layer, the
// raw becomes the grounding layer.
import fs from 'node:fs';
import path from 'node:path';
import { createNdjsonWriter } from '../stream.mjs';
import { runPrompt, runJsonPrompt } from '../runner.mjs';
import { searchSmart } from '../research.mjs';

const LEVEL_LIMIT = { quick: 3, deep: 5, 'deep-research': 8 };
const PAGE_BUDGET = 2500;   // per wiki page body
const RAW_BUDGET = 3500;    // per source page's raw excerpt
const TOTAL_BUDGET = 16000; // whole context

function readPageFull(kbRoot, pageRel) {
  const abs = path.join(kbRoot, pageRel);
  if (!fs.existsSync(abs)) return null;
  const text = fs.readFileSync(abs, 'utf8');
  const fmEnd = text.startsWith('---') ? text.indexOf('\n---', 3) : -1;
  const fm = fmEnd > 0 ? text.slice(3, fmEnd) : '';
  const body = (fmEnd > 0 ? text.slice(fmEnd + 4) : text).trim();
  const sourceRef = fm.match(/^source_ref:\s*"?([^"\n]+)"?/m)?.[1]?.trim() || null;
  return { body, sourceRef };
}

function readRawEvidence(kbRoot, sourceRef) {
  if (!sourceRef || sourceRef.includes('..')) return '';
  const abs = path.join(kbRoot, sourceRef);
  if (!abs.startsWith(path.join(kbRoot, 'raw')) || !fs.existsSync(abs)) return '';
  const text = fs.readFileSync(abs, 'utf8');
  const fmEnd = text.startsWith('---') ? text.indexOf('\n---', 3) : -1;
  return (fmEnd > 0 ? text.slice(fmEnd + 4) : text).trim();
}

export async function run({ kbRoot, input, outputPath }) {
  const writer = createNdjsonWriter(outputPath);
  const level = input?.level || 'quick';
  const question = input?.question || '';
  let context = '';
  const hits = []; // { page, title } — citation candidates, resolved against the answer

  writer.write({ type: 'meta', level, kb: kbRoot });

  try {
    const limit = LEVEL_LIMIT[level] || LEVEL_LIMIT.quick;
    writer.write({ type: 'search', query: question, round: 1 });
    // quick stays single-call cheap; deep / deep-research add a listwise
    // rerank over the fused pool (ADR-0010 R2)
    const isDeep = level !== 'quick';
    const result = await searchSmart(kbRoot, question, {
      limit,
      rewrite: (q) => runJsonPrompt(kbRoot, 'query-rewrite', { question: q }),
      rerank: isDeep ? (q, candidates) => runJsonPrompt(kbRoot, 'rerank', { question: q, candidates }) : undefined,
    });
    const previews = Array.isArray(result?.preview) ? result.preview : [];
    const parts = [];
    let budget = TOTAL_BUDGET;
    for (const hit of previews.slice(0, limit)) {
      writer.write({ type: 'read', page: hit.page, round: 1 });
      hits.push({ page: hit.page, title: hit.title || '' });
      // C3: full page body; source pages also contribute their raw evidence
      const full = readPageFull(kbRoot, hit.page);
      let part = `## ${hit.title || hit.page}\n${(full?.body || hit.snippet || '').slice(0, PAGE_BUDGET)}`;
      if (full?.sourceRef) {
        const raw = readRawEvidence(kbRoot, full.sourceRef);
        if (raw) {
          part += `\n\n### 原始证据(${full.sourceRef})\n${raw.slice(0, RAW_BUDGET)}`;
          writer.write({ type: 'read', page: full.sourceRef, round: 1, kind: 'raw' });
        }
      }
      if (part.length > budget) part = part.slice(0, Math.max(budget, 0));
      if (!part) break;
      budget -= part.length;
      parts.push(part);
    }
    context = parts.join('\n\n---\n\n');
  } catch (err) {
    writer.write({ type: 'error', message: err.message });
  }

  let answer = '';
  // R3 (CRAG-style quality gate): zero hits means no LLM call at all — a fixed,
  // honest refusal costs nothing and can never hallucinate.
  if (!hits.length) {
    answer = '这座知识库里没有与该问题相关的内容。可以换个问法,或先采集/治理相关文档。';
    writer.write({ type: 'chunk', text: answer });
    writer.write({ type: 'done', citations: [] });
    writer.end();
    await writer.finish();
    return { level, tokens_in: 0, tokens_out: 0, refused: true };
  }

  try {
    const res = await runPrompt(kbRoot, 'chat', { question, context }, {
      stream: true,
      onDelta: (delta) => writer.write({ type: 'chunk', text: delta }),
    });
    answer = res.content || '';
  } catch (err) {
    writer.write({ type: 'error', message: err.message });
  }

  const cited = (text) => hits.filter((h) => {
    const slug = h.page.split('/').pop().replace(/\.md$/, '');
    return text.includes(`[[${h.title}]]`) || text.includes(`[[${slug}]]`)
      || (h.title && text.includes(h.title)) || text.includes(slug);
  }).map((h) => h.page);

  let citations = cited(answer);

  // C1 (ADR-0011): faithfulness guard for deep levels — when the answer drifts
  // from the context (judge score < 0.8), regenerate once with a stricter
  // instruction. quick keeps its single call.
  if (level !== 'quick' && answer && hits.length) {
    try {
      const { data } = await runJsonPrompt(kbRoot, 'judge-faithfulness', {
        context: context.slice(0, 6000), answer,
      });
      if (typeof data?.score === 'number' && data.score < 0.8) {
        writer.write({ type: 'regenerate', reason: `faithfulness ${data.score}` });
        const retry = await runPrompt(kbRoot, 'chat', {
          question: `${question}\n\n(只使用上下文中明确支持的陈述回答;上下文没有就说明知识库未涵盖。)`,
          context,
        }, {
          stream: true,
          onDelta: (delta) => writer.write({ type: 'chunk', text: delta }),
        });
        answer = retry.content || answer;
        citations = cited(answer);
      }
    } catch { /* guard failure keeps the first answer */ }
  }

  writer.write({ type: 'done', citations, ...(citations.length === 0 && answer && hits.length ? { uncited_reads: hits.map((h) => h.page) } : {}) });
  writer.end();
  await writer.finish();

  return { level, tokens_in: 0, tokens_out: 0 };
}
