// Shared connector helpers (review 2026-08-04: normalizeJiraDate /
// normalizeConfluenceDate and the two entity decoders were verbatim copies
// across jira.mjs / confluence.mjs). Both connectors re-export their
// historical names — the test surface imports those, keep them stable.

/** Source-system dates arrive as ISO 8601 with or without the offset colon
 *  (Jira Server emits "+0800"); normalize to strict ISO (Z).
 *  Unparseable values pass through unchanged (kept visible, not invented). */
export function normalizeConnectorDate(s) {
  if (!s) return '';
  const fixed = String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2');
  const d = new Date(fixed);
  return Number.isNaN(d.getTime()) ? String(s) : d.toISOString();
}

/** Minimal HTML entity decode for hand-rolled XHTML/XML handling (zero new
 *  dependencies — the acquisition side's hard constraint). */
export function decodeEntities(s) {
  return String(s)
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&'); // must run last
}
