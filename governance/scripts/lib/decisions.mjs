// Decision log: append-only machine-readable records for every mutating governance
// action (ADR-0009). Lives in .kb/govern/decisions/ — adjudication memory, not
// rebuildable. Human decisions require a reason; LLM decisions cite precedents.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

function decisionsDir(kbRoot) {
  return path.join(kbRoot, '.kb', 'govern', 'decisions');
}

export function makeDecisionId() {
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  return `${ts}-${crypto.randomUUID()}`;
}

/** Write one decision record. Returns the record (including generated id). */
export function writeDecision(kbRoot, {
  actor = 'govern',
  action,
  page,
  reason,
  model_version,
  precedent_ids,
  meta,
} = {}) {
  if (!action) throw new Error('decision action is required');
  const dir = decisionsDir(kbRoot);
  fs.mkdirSync(dir, { recursive: true });
  const id = makeDecisionId();
  const record = {
    id,
    timestamp: new Date().toISOString(),
    actor,
    action,
    page,
  };
  if (reason !== undefined) record.reason = reason;
  if (model_version !== undefined) record.model_version = model_version;
  if (precedent_ids !== undefined && (!Array.isArray(precedent_ids) || precedent_ids.length)) {
    record.precedent_ids = Array.isArray(precedent_ids) ? precedent_ids : [precedent_ids];
  }
  if (meta !== undefined && Object.keys(meta).length) record.meta = meta;
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(record, null, 2) + '\n', 'utf8');
  return record;
}

/** Read all decision records, newest last. Optional filters. */
export function readDecisions(kbRoot, { action, page, actor } = {}) {
  const dir = decisionsDir(kbRoot);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    let r;
    try {
      r = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    } catch { continue; }
    if (action && r.action !== action) continue;
    if (page && r.page !== page) continue;
    if (actor && r.actor !== actor) continue;
    out.push(r);
  }
  return out;
}

/** Latest N precedents for an action, newest last (few-shot context). */
export function findPrecedents(kbRoot, action, limit = 5) {
  return readDecisions(kbRoot, { action }).slice(-limit);
}

/** Throw if a human decision lacks a reason. */
export function requireReason(actor, reason, label = 'decision') {
  if (actor === 'human' && (!reason || !String(reason).trim())) {
    throw new Error(`human ${label} requires --reason`);
  }
}

/** Extract actor/model/precedents from CLI-style options. */
export function decisionContext({ actor = 'govern', model_version, precedents } = {}) {
  const precedent_ids = precedents === undefined ? undefined
    : String(precedents).split(',').map((s) => s.trim()).filter(Boolean);
  return { actor: actor === 'human' ? 'human' : actor, model_version, precedent_ids };
}
