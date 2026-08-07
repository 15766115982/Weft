// Internal retrieval loop used by chat and deep-research.
// The LLM service must not import retrieval code directly (service decoupling);
// it spawns `kb_search.mjs` through the CLI contract.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const KB_SEARCH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..', '..', 'retrieval', 'scripts', 'kb_search.mjs',
);
function runKbSearch(kbRoot, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [KB_SEARCH, ...args, '--kb', kbRoot], { shell: false });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`kb_search failed (code ${code}): ${stderr || stdout.slice(0, 500)}`));
      }
      try { resolve(JSON.parse(stdout)); }
      catch { resolve({ raw: stdout }); }
    });
  });
}

export async function searchPages(kbRoot, query, { limit = 10 } = {}) {
  return runKbSearch(kbRoot, ['search', query, '--limit', String(limit)]);
}

// Conversational questions ("retry 策略是怎么设计的?") defeat the index's
// cross-leg AND: question stopwords become CJK trigrams no page contains.
// Fallback ladder, cheapest first:
//   1. full query
//   2. query with question stopwords/punctuation stripped
//   3. each remaining term searched separately, merged by hit frequency
const STOP_PHRASES = [
  '是怎么设计的', '是什么意思', '是什么', '为什么', '怎么', '怎样', '如何',
  '哪些', '哪个', '请问', '一下', '有没有', '是不是', '能不能', '可以',
  '的', '了', '吗', '呢', '吧', '啊', '呀', '嘛', '么',
];

function stripStopwords(query) {
  let q = ` ${query} `;
  for (const s of STOP_PHRASES) q = q.split(s).join(' ');
  return q.replace(/[?,!。?,!;:;:·…—\-()()【】"'"']/g, ' ').replace(/\s+/g, ' ').trim();
}

function terms(query) {
  const out = [];
  for (const tok of query.split(/\s+/).filter(Boolean)) {
    if (/^[-0-9a-zA-Z_.]+$/.test(tok)) {
      if (tok.length >= 2) out.push(tok);
      continue;
    }
    // CJK run: 2-char terms hit the LIKE leg; slide bigrams so a long
    // stopword-stripped run still yields searchable anchors ("重试几次" → 重试).
    if (tok.length === 2) { out.push(tok); continue; }
    for (let i = 0; i < tok.length - 1; i++) out.push(tok.slice(i, i + 2));
  }
  return [...new Set(out)];
}

export async function searchWithFallback(kbRoot, query, { limit = 10 } = {}) {
  const first = await searchPages(kbRoot, query, { limit });
  if ((first?.total ?? 0) > 0) return { ...first, relaxed: false };

  const stripped = stripStopwords(query);
  if (stripped && stripped !== query.trim()) {
    const second = await searchPages(kbRoot, stripped, { limit });
    if ((second?.total ?? 0) > 0) return { ...second, relaxed: true, relaxed_query: stripped };
  }

  const ts = terms(stripped || query);
  if (!ts.length) return first;
  const lanes = [];
  for (const t of ts) lanes.push((await searchPages(kbRoot, t, { limit }))?.preview || []);
  const merged = rrfMerge(lanes, limit);
  if (!merged.length) return first;
  return { query, total: merged.length, preview: merged, relaxed: true, relaxed_terms: ts };
}

/** Reciprocal Rank Fusion over multiple ranked lists (ADR-0010). */
export function rrfMerge(lists, limit = 10, k = 60) {
  const scores = new Map(); // page -> { hit, score }
  for (const list of lists) {
    (list || []).forEach((hit, rank) => {
      const e = scores.get(hit.page) || { hit, score: 0 };
      e.score += 1 / (k + rank + 1);
      scores.set(hit.page, e);
    });
  }
  return [...scores.values()].sort((a, b) => b.score - a.score).slice(0, limit).map((e) => e.hit);
}

/**
 * searchSmart (ADR-0010 R1): fallback first; when hits are scarce, one LLM call
 * rewrites the question into 2-3 keyword queries (bilingual synonyms), each is
 * searched, and every lane — direct, stripped, per-term, rewrite variants — is
 * fused with RRF. Degrades gracefully to the fallback result when no model
 * config exists or the rewrite fails.
 */
export async function searchSmart(kbRoot, question, { limit = 10, minHits = 2, rewrite, rerank, rerankPool = 20 } = {}) {
  const direct = await searchWithFallback(kbRoot, question, { limit: rerank ? rerankPool : limit });
  let result;
  if ((direct?.total ?? 0) >= minHits) {
    result = { ...direct, via: direct.relaxed ? 'fallback' : 'direct' };
  } else {
    let variants = [];
    if (rewrite) {
      try {
        const { data } = await rewrite(question);
        variants = (data?.queries || []).map((q) => String(q).trim()).filter((q) => q && q !== question).slice(0, 3);
      } catch { variants = []; }
    }
    if (!variants.length) {
      result = { ...direct, via: direct.relaxed ? 'fallback' : 'direct' };
    } else {
      const lanes = [direct?.preview || []];
      for (const v of variants) {
        lanes.push((await searchWithFallback(kbRoot, v, { limit: rerank ? rerankPool : limit }))?.preview || []);
      }
      const merged = rrfMerge(lanes, rerank ? rerankPool : limit);
      result = merged.length
        ? { query: question, total: merged.length, preview: merged, relaxed: true, via: 'rewrite', variants }
        : { ...direct, via: 'rewrite-empty' };
    }
  }

  // R2: optional listwise LLM rerank over the fused pool → final top-k.
  if (rerank && (result.preview || []).length > limit) {
    const pool = result.preview.slice(0, rerankPool);
    try {
      const candidates = pool.map((h, i) => `[${i}] ${h.title || h.page}\n${(h.snippet || '').slice(0, 400)}`).join('\n\n');
      const { data } = await rerank(question, candidates);
      const order = (data?.ranking || []).filter((i) => Number.isInteger(i) && i >= 0 && i < pool.length);
      if (order.length) {
        const seen = new Set(order);
        const reranked = [...order.map((i) => pool[i]), ...pool.filter((_, i) => !seen.has(i))];
        result = { ...result, preview: reranked.slice(0, limit), reranked: true };
      }
    } catch { /* rerank failure keeps the fused order */ }
  }
  if ((result.preview || []).length > limit) result = { ...result, preview: result.preview.slice(0, limit), total: limit };
  return result;
}

export async function readPage(kbRoot, pagePath) {
  return runKbSearch(kbRoot, ['read', pagePath]);
}

/** Multi-round research loop.
 *  Rounds are capped; each round searches, reads top pages, and appends findings.
 *  onEvent receives {type, ...} lines that the caller writes to its NDJSON stream.
 */
export async function runResearchLoop({ kbRoot, question, onEvent, opts = {} }) {
  const maxRounds = opts.maxRounds || 3;
  const hitsPerRound = opts.hitsPerRound || 5;
  const readTop = opts.readTop || 3;
  const seen = new Set();
  const citations = [];
  const findings = [];

  onEvent({ type: 'meta', task: 'deep-research', kb: kbRoot, maxRounds });

  for (let round = 1; round <= maxRounds; round++) {
    onEvent({ type: 'search', query: question, round });
    const searchResult = await searchPages(kbRoot, question, { limit: hitsPerRound });
    const hits = Array.isArray(searchResult?.preview) ? searchResult.preview : [];
    if (!hits.length) break;

    const toRead = hits.slice(0, readTop).filter((h) => !seen.has(h.page));
    if (!toRead.length) break;

    for (const hit of toRead) {
      seen.add(hit.page);
      onEvent({ type: 'read', page: hit.page, round });
      try {
        const body = await readPage(kbRoot, hit.page);
        findings.push({ path: hit.page, title: hit.title || hit.page, snippet: hit.snippet || '', body });
        if (!citations.includes(hit.page)) citations.push(hit.page);
      } catch (err) {
        onEvent({ type: 'error', page: hit.page, round, error: err.message });
      }
    }
  }

  const context = findings.map((f) => `## ${f.title} (${f.path})\n${f.body}`).join('\n\n---\n\n');
  return { rounds: maxRounds, findings, context, citations };
}
