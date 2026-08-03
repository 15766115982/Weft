// J9 search-result feedback loop: 👍/👎 votes on result cards, one JSON line
// per vote in the portal's own derived dir (whitelist ④). 👎 queries are
// curated from this file into the tests/eval golden set — the living loop:
// retrieval → human feedback → regression corpus (with K's judge as the
// in-product complement, and the Hit@5 gate as the CI backstop).
import fs from 'node:fs';
import path from 'node:path';
import { normalizeWikiRel } from './review.mjs';

const FEEDBACK_FILE = path.join('.kb', 'ui', 'feedback.jsonl');

export function feedbackJob(kb, { q, page, vote }) {
  if (!['up', 'down'].includes(vote)) throw new Error(`vote must be up|down: ${vote}`);
  if (!q || !String(q).trim()) throw new Error('feedback requires the original query');
  normalizeWikiRel(page); // results are wiki pages; the gate double-checks shape
  return {
    type: 'feedback',
    label: `${vote === 'up' ? '👍' : '👎'} ${page}`,
    run: async () => {
      const abs = path.join(kb, FEEDBACK_FILE);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.appendFileSync(abs, JSON.stringify({
        ts: new Date().toISOString(), q: String(q).slice(0, 300), page, vote,
      }) + '\n', 'utf8');
      return { recorded: true };
    },
  };
}

// Read side for the 👎 panel: newest first, capped.
export function readFeedback(kb, { vote, limit = 20 } = {}) {
  const abs = path.join(kb, FEEDBACK_FILE);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const line of fs.readFileSync(abs, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const e = JSON.parse(line);
      if (!vote || e.vote === vote) out.push(e);
    } catch { /* a torn line at the tail is not fatal */ }
  }
  return out.reverse().slice(0, limit);
}
