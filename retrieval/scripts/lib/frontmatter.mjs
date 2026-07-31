// Frontmatter serialize/parse (contract §2/§3).
// NOTE: this file is identical across all three services' scripts/lib/ —
// a **deliberate duplicate**: zero code dependency between services (ADR-0001);
// each copy is synced by hand when the contract evolves, never shared.
// Deliberately zero-dependency: supports only the YAML subset this contract
// uses (scalars, string arrays, one level of nested objects).
// The parser only needs to read back the format we ourselves write — not
// general-purpose YAML.

function needsQuote(s) {
  return /[:#\[\]{}"\n]|^\s|\s$|^$/.test(s) || /^(true|false|null|\d)/i.test(s);
}

function scalar(v) {
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  const s = String(v);
  return needsQuote(s) ? JSON.stringify(s) : s;
}

export function buildFrontmatter(fields) {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || v === null) continue;
    // Empty arrays/objects get the same treatment as undefined: skip them,
    // to avoid emitting bare keys (malformed YAML, and our own parser would
    // read a bare key back as {} causing type confusion)
    if (Array.isArray(v) && v.length === 0) continue;
    if (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0) continue;
    if (Array.isArray(v)) {
      lines.push(`${k}:`);
      for (const item of v) lines.push(`  - ${scalar(item)}`);
    } else if (typeof v === 'object') {
      lines.push(`${k}:`);
      for (const [ek, ev] of Object.entries(v)) lines.push(`  ${ek}: ${scalar(ev)}`);
    } else {
      lines.push(`${k}: ${scalar(v)}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

function unquote(s) {
  if (s.startsWith('"') && s.endsWith('"')) {
    try { return JSON.parse(s); } catch { /* fall through */ }
  }
  return s;
}

export function parseFrontmatter(text) {
  // Tolerates CRLF line endings and BOM (common from Windows editors);
  // the BOM is counted in m[0], so body slicing is unaffected
  const m = text.match(/^(?:\uFEFF)?---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { fields: {}, body: text };
  const fields = {};
  let currentKey = null;
  for (const line of m[1].replace(/\r/g, '').split('\n')) {
    const list = line.match(/^\s{2}- (.*)$/);
    const nested = line.match(/^(\w[\w-]*):$/);
    const pair = line.match(/^(\w[\w-]*): (.*)$/);
    const subPair = line.match(/^\s{2}(\w[\w-]*): (.*)$/);
    if (subPair && currentKey && typeof fields[currentKey] === 'object' && !Array.isArray(fields[currentKey])) {
      fields[currentKey][subPair[1]] = unquote(subPair[2]);
    } else if (list && currentKey) {
      if (!Array.isArray(fields[currentKey])) fields[currentKey] = [];
      fields[currentKey].push(unquote(list[1]));
    } else if (nested) {
      currentKey = nested[1];
      fields[currentKey] = {}; // may be turned into an array by later "- item" lines
    } else if (pair) {
      currentKey = pair[1];
      fields[pair[1]] = unquote(pair[2]);
    }
  }
  return { fields, body: text.slice(m[0].length) };
}
