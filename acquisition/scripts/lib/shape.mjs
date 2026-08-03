// Shape diagnostics WITHOUT values (user-ruled 2026-08-03: intranet data never
// leaves the intranet; shape mismatches come back only as relayed text). Every
// new parser that consumes an unverified intranet API shape (ZAPI teststep,
// .gliffy attachments, ...) reports mismatches through these helpers, so the
// relayed message alone is enough to fix the parser: types, key names, counts
// — never content values.

/** Structural summary of a value. Keys capped at 10 (enough to recognize the
 *  envelope, small enough to relay). */
export function describeShape(v) {
  if (v === null) return { type: 'null' };
  if (Array.isArray(v)) {
    const d = { type: 'array', length: v.length };
    if (v.length && typeof v[0] === 'object' && v[0] !== null) {
      d.keys = Object.keys(v[0]).slice(0, 10);
    }
    return d;
  }
  const t = typeof v;
  if (t === 'object') return { type: 'object', keys: Object.keys(v).slice(0, 10) };
  return { type: t };
}

function fmt(d) {
  let s = d.type;
  const bits = [];
  if (d.keys) bits.push(`keys=${d.keys.join(',')}`);
  if (d.length !== undefined) bits.push(`length=${d.length}`);
  return bits.length ? `${s}(${bits.join(' ')})` : s;
}

/** Error naming what was expected vs the shape actually found — no values.
 *  `shapeSafe` marks the message as relay-safe (degrade paths may quote it). */
export function shapeError(what, expected, got) {
  const err = new Error(`${what}: expected ${expected}, got ${fmt(describeShape(got))}`);
  err.shapeSafe = true;
  return err;
}
