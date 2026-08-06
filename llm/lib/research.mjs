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
