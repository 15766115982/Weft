// Read-only decision-log access for LLM few-shot context.
import fs from 'node:fs';
import path from 'node:path';

export function decisionsDir(kbRoot) {
  return path.join(kbRoot, '.kb', 'govern', 'decisions');
}

export function listDecisions(kbRoot) {
  const dir = decisionsDir(kbRoot);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => path.join(dir, f));
}

export function readDecision(kbRoot, id) {
  const p = path.join(decisionsDir(kbRoot), `${id}.json`);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

export function decisionsByType(kbRoot, decisionType) {
  const out = [];
  for (const p of listDecisions(kbRoot)) {
    try {
      const rec = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (rec.decision_type === decisionType) out.push(rec);
    } catch { /* skip malformed */ }
  }
  return out.sort((a, b) => (a.ts || '').localeCompare(b.ts || ''));
}
