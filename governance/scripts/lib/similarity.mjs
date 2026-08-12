// Conflict detection signals (plan 0001 §2). Pure functions — no fs access.
// Three categories are produced here:
//   duplicate — identical content_hash (deterministic, zero false positives).
//               Only compared when BOTH sides carry content_hash (the field is
//               not in RAW_REQUIRED and may be absent; null == null is never a dup).
//   similar   — title-based pre-filter (normalized-title equality / title-token
//               overlap / de-versioned filename equality) + CJK-aware body
//               similarity confirmation (Latin token set ∪ CJK char bigram/trigram
//               shingles; P1-6). Threshold is calibrated by fixture, not hand-picked.
//
// The pre-filter is cheap (titles/filenames only, never the body) and deliberately
// generous: a wrong pre-filter match is refuted by the body-similarity confirmation,
// while a missed pre-filter match silently loses a version pair. P0-2 removed the
// "same source" pre-filter (source is the connector name and degrades to all-KB on
// local).

const CJK = /[㐀-䶿一-鿿豈-﫿]/;
// Pre-filter token overlap / semantic-check trigger (title vs title/alias).
const TITLE_OVERLAP_THRESHOLD = 0.3;
// Body-similarity confirmation threshold. Calibrated by the fixture tests
// (test/similarity.test.mjs): version pairs must clear it, same-title parallel
// documents must not. See the fixture test for the measured separation.
export const DEFAULT_SIMILARITY_THRESHOLD = 0.5;
// Degeneration guard: a pre-filter bucket larger than this is skipped (with a
// warning) instead of comparing pairwise — 2000 same-title docs must not go O(n²).
const DEFAULT_BUCKET_CAP = 400;

function cjkRuns(text) {
  const runs = [];
  let cur = '';
  for (const ch of text) {
    if (CJK.test(ch)) cur += ch;
    else { if (cur) { runs.push(cur); cur = ''; } }
  }
  if (cur) runs.push(cur);
  return runs;
}

function cjkShingles(run) {
  const set = new Set();
  for (let i = 0; i + 1 < run.length; i++) set.add(run.slice(i, i + 2));
  for (let i = 0; i + 2 < run.length; i++) set.add(run.slice(i, i + 3));
  return set;
}

/** Tokenize one string into a set: Latin words (≥2 chars, lowercased) ∪ CJK
 *  bigram/trigram shingles. Prefixes namespace latin vs cjk so a latin word can
 *  never collide with a CJK shingle. Shared by body similarity and title overlap. */
export function tokenize(text) {
  const set = new Set();
  for (const run of cjkRuns(String(text))) {
    for (const s of cjkShingles(run)) set.add(`cjk:${s}`);
  }
  const latin = String(text).replace(CJK, ' ');
  for (const tok of latin.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (tok.length >= 2) set.add(`latin:${tok}`);
  }
  return set;
}

/** Strip YAML frontmatter, then tokenize the body. (Reuses the shared regex shape
 *  of frontmatter.mjs — kept local so this module stays dependency-free.) */
export function normalizeBody(text) {
  const body = String(text ?? '').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
  return tokenize(body);
}

export function jaccard(a, b) {
  let inter = 0;
  for (const t of a) if (b.has(t)) inter++;
  const union = a.size + b.size - inter;
  // Both empty after normalization → no distinguishing content → treat as identical
  // (fail-closed: it surfaces for review rather than silently fusing).
  return union === 0 ? 1 : inter / union;
}

export function normalizeTitle(s) {
  return String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Pre-filter: token-set overlap ≥ 0.3, or one set contained in the other. */
export function titleTokensOverlap(aTokens, bTokens) {
  if (aTokens.size === 0 || bTokens.size === 0) return false;
  const bigger = aTokens.size >= bTokens.size ? aTokens : bTokens;
  const smaller = bigger === aTokens ? bTokens : aTokens;
  let contained = true;
  for (const t of smaller) if (!bigger.has(t)) { contained = false; break; }
  if (contained) return true;
  return jaccard(aTokens, bTokens) >= TITLE_OVERLAP_THRESHOLD;
}

/** Strip version-suffix markers from a filename base so pay-timeout-v1.md /
 *  pay-timeout-v2.md / pay-timeout (1).md all reduce to pay-timeout (bug 0001's
 *  naming pattern). A raw numeric tail (-404) is deliberately NOT stripped — too
 *  risky; the body-similarity confirmation would refute a false pre-filter hit. */
const DEVERN = /(?:[-_.\s]*(?:v\d+(?:[._-]\d+)*|\d{4}[-_.]\d{2}[-_.]\d{2}|\d{8}|\(\d+\)|第[一二三四五六七八九十百\d]+版|版本\d*|ver\d+|copy|backup|final|draft|草案|备份|最终版))$/i;
export function deVersionFilename(name) {
  const base = String(name).replace(/\.md$/i, '').toLowerCase();
  const stripped = base.replace(DEVERN, '');
  return stripped || base;
}

function prefilterPairs(rawDocs, { bucketCap, warnings }) {
  // Collect candidate pairs from all three pre-filter signals, deduped via `seen`.
  const pairs = new Map(); // "a\x00b" -> [aIdx, bIdx]
  const addBucket = (bucket, signal) => {
    if (bucket.length < 2) return;
    if (bucket.length > bucketCap) {
      warnings.push({
        signal,
        size: bucket.length,
        note: `pre-filter bucket exceeded cap (${bucketCap}), pairwise comparison skipped`,
      });
      return;
    }
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const [a, b] = bucket[i] < bucket[j] ? [bucket[i], bucket[j]] : [bucket[j], bucket[i]];
        pairs.set(`${a}\x00${b}`, [a, b]);
      }
    }
  };

  const byTitle = new Map();
  const byFileKey = new Map();
  const byToken = new Map();
  for (let i = 0; i < rawDocs.length; i++) {
    const d = rawDocs[i];
    const tKey = normalizeTitle(d.title);
    if (tKey) {
      const list = byTitle.get(tKey) ?? [];
      list.push(i);
      byTitle.set(tKey, list);
    }
    const fKey = d.filename ? deVersionFilename(d.filename) : '';
    if (fKey) {
      const list = byFileKey.get(fKey) ?? [];
      list.push(i);
      byFileKey.set(fKey, list);
    }
    const tokens = tokenize(d.title ?? '');
    for (const t of tokens) {
      const list = byToken.get(t) ?? [];
      list.push(i);
      byToken.set(t, list);
    }
  }
  for (const bucket of byTitle.values()) addBucket(bucket, 'same-title');
  for (const bucket of byFileKey.values()) addBucket(bucket, 'same-de-versioned-filename');
  // Token-overlap buckets need the overlap check to filter pairs (a shared token
  // alone is not enough — "timeout" appears in many titles).
  for (const [token, bucket] of byToken) {
    if (bucket.length < 2) continue;
    if (bucket.length > bucketCap) {
      warnings.push({
        signal: 'title-token-overlap',
        token,
        size: bucket.length,
        note: `pre-filter bucket exceeded cap (${bucketCap}), pairwise comparison skipped`,
      });
      continue;
    }
    for (let i = 0; i < bucket.length; i++) {
      for (let j = i + 1; j < bucket.length; j++) {
        const a = rawDocs[bucket[i]];
        const b = rawDocs[bucket[j]];
        if (titleTokensOverlap(tokenize(a.title ?? ''), tokenize(b.title ?? ''))) {
          const [x, y] = bucket[i] < bucket[j] ? [bucket[i], bucket[j]] : [bucket[j], bucket[i]];
          pairs.set(`${x}\x00${y}`, [x, y]);
        }
      }
    }
  }
  return [...pairs.values()];
}

/**
 * Compute conflict groups over a set of raw docs.
 * rawDocs: [{ rel, title, filename, body, content_hash }]
 *   rel — raw/ relative path (identity); title/filename/body used for signals;
 *   content_hash — may be absent (absent on either side ⇒ that pair is never a dup).
 * Returns { groups, warnings }:
 *   groups: [
 *     { category: 'duplicate', raws: [rel...], score: 1, hash } |
 *     { category: 'similar',   raws: [rel, rel], score: <jaccard> }
 *   ]
 * A pair yields exactly one group: hash-equal ⇒ duplicate (stronger than similar).
 */
export function findGroups(rawDocs, { threshold = DEFAULT_SIMILARITY_THRESHOLD, bucketCap = DEFAULT_BUCKET_CAP } = {}) {
  const warnings = [];
  const groups = [];

  // 1. Exact duplicates: identical content_hash, both sides present.
  const byHash = new Map();
  for (let i = 0; i < rawDocs.length; i++) {
    const h = rawDocs[i].content_hash;
    if (!h) continue;
    const list = byHash.get(h) ?? [];
    list.push(i);
    byHash.set(h, list);
  }
  const dupPairs = new Set();
  for (const [hash, idxs] of byHash) {
    if (idxs.length < 2) continue;
    for (let x = 0; x < idxs.length; x++) {
      for (let y = x + 1; y < idxs.length; y++) {
        dupPairs.add(`${idxs[x]}\x00${idxs[y]}`);
      }
    }
    groups.push({
      category: 'duplicate',
      raws: idxs.map(i => rawDocs[i].rel).sort(),
      score: 1,
      hash,
    });
  }

  // 2. Similar versions: pre-filter candidate pairs, then body-similarity confirmation.
  const candidates = prefilterPairs(rawDocs, { bucketCap, warnings });
  for (const [ai, bi] of candidates) {
    // Skip only pairs already classified as exact duplicates (both sides in the
    // SAME dup group). A doc that is a dup member can still be a similar-version
    // of a THIRD doc — skipping on either-side membership let that escape
    // conflict detection entirely (2026-08-12 audit).
    if (dupPairs.has(ai < bi ? `${ai}\x00${bi}` : `${bi}\x00${ai}`)) continue;
    const a = rawDocs[ai];
    const b = rawDocs[bi];
    const score = jaccard(normalizeBody(a.body), normalizeBody(b.body));
    if (score >= threshold) {
      groups.push({
        category: 'similar',
        raws: [a.rel, b.rel].sort(),
        score: Math.round(score * 100) / 100,
      });
    }
  }

  return { groups, warnings };
}
