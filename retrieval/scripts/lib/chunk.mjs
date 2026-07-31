// Heading-aware chunking: split sections at markdown heading boundaries;
// over-long sections are re-split at paragraph boundaries; code fences and
// tables are never cut (approach follows the old ingest.py and
// markdown-vault-mcp).
const MAX_CHUNK = 1200; // chars

function splitSections(body) {
  const lines = body.split('\n');
  const sections = [];
  let cur = { heading: '', anchor: '', level: 0, lines: [] };
  let fence = null; // {char,len}: both ``` and ~~~ are legal; closing requires the same char and length ≥ opening fence
  const flush = () => {
    if (cur.lines.length) sections.push({ ...cur, text: cur.lines.join('\n') });
  };
  for (const line of lines) {
    const fm = line.match(/^\s*(`{3,}|~{3,})/);
    if (fm) {
      if (!fence) {
        // the same char appearing again later on the opening-fence line =
        // inline code (```code```), not a fence (CommonMark: the info string
        // of a backtick fence must not contain backticks)
        const rest = line.slice(fm[0].length);
        if (!rest.includes(fm[1][0])) fence = { char: fm[1][0], len: fm[1].length };
      } else if (fm[1][0] === fence.char && fm[1].length >= fence.len) {
        fence = null;
      }
    }
    const h = !fence && line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      flush();
      cur = { heading: h[2].trim(), anchor: h[2].trim(), level: h[1].length, lines: [line] };
    } else {
      cur.lines.push(line);
    }
  }
  flush();
  return sections;
}

// over-long sections are re-split at blank lines (paragraph boundaries); a
// single over-long paragraph is kept whole (rather long than broken)
function splitLong(text) {
  if (text.length <= MAX_CHUNK) return [text];
  const paras = text.split(/\n{2,}/);
  const out = [];
  let buf = '';
  for (const p of paras) {
    if (buf && buf.length + p.length + 2 > MAX_CHUNK) { out.push(buf); buf = p; }
    else buf = buf ? buf + '\n\n' + p : p;
  }
  if (buf) out.push(buf);
  return out;
}

/** @returns [{anchor, heading, text}] */
export function chunkPage(body) {
  const chunks = [];
  for (const s of splitSections(body)) {
    for (const t of splitLong(s.text)) {
      if (t.trim()) chunks.push({ anchor: s.anchor, heading: s.heading, text: t });
    }
  }
  return chunks;
}

/** read #anchor: return the section matching the heading text (including all
 *  its subsections, truncated at a same-or-higher-level heading); without an
 *  anchor return the full body */
export function readSection(body, anchor) {
  if (!anchor) return body;
  const sections = splitSections(body);
  const i = sections.findIndex(s => s.anchor === anchor);
  const j = i >= 0 ? i : sections.findIndex(s => s.anchor.toLowerCase() === anchor.toLowerCase());
  if (j < 0) {
    const available = sections.map(s => s.anchor).filter(Boolean);
    const err = new Error(`anchor not found: "${anchor}"`);
    err.available = available;
    throw err;
  }
  const out = [];
  for (let k = j; k < sections.length; k++) {
    if (k > j && sections[k].level <= sections[j].level) break;
    out.push(sections[k].text);
  }
  return out.join('\n');
}

/** Remove fenced code blocks and inline code spans: a [[link]] inside code is a code
 * sample, not a graph edge (agrees with the governance plan's dangling-link scan —
 * duplicated by hand across the service boundary, same rules as splitSections). */
function stripCode(text) {
  const out = [];
  let fence = null; // {char,len}
  for (const line of text.split('\n')) {
    const fm = line.match(/^\s*(`{3,}|~{3,})/);
    if (fm) {
      if (!fence) {
        const rest = line.slice(fm[0].length);
        if (!rest.includes(fm[1][0])) { fence = { char: fm[1][0], len: fm[1].length }; continue; }
      } else if (fm[1][0] === fence.char && fm[1].length >= fence.len) {
        fence = null;
        continue;
      }
    }
    if (fence) continue;
    out.push(line);
  }
  return out.join('\n').replace(/`[^`\n]*`/g, '');
}

/** extract wikilink targets from the body (aliases stripped): [[a|b]]→a, [[a]]→a;
 *  code fences and inline code are stripped first */
export function extractWikilinks(text) {
  const out = new Set();
  for (const m of stripCode(text).matchAll(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g)) {
    out.add(m[1].trim());
  }
  return [...out];
}
