// sources.js — topic `sources:` provenance links. Shared by browse.js and
// queue.js so the link shape lives in ONE place (intranet bug 1: both views
// used to glue 'wiki/sources/' onto raw paths, producing wiki/sources/raw/...
// links that 404). sources entries are raw paths; link to the source summary
// page when one exists (resolved via /api/page's sources_resolved), else to
// the raw viewer (ungoverned raw), else the legacy slug form.
import { esc } from './render.js';

export function sourceLinksHtml(sources, resolved, labelPrefix = '') {
  const r = resolved || [];
  return (sources || []).map((s, i) => {
    const page = r[i] && r[i].page;
    let href;
    if (page) {
      href = `#/page?path=${encodeURIComponent(page)}`;
    } else if (String(s).startsWith('raw/')) {
      href = `#/browse?raw=${encodeURIComponent(String(s))}`;
    } else {
      href = `#/page?path=${encodeURIComponent('wiki/sources/' + s.replace(/^wiki\/sources\//, ''))}`;
    }
    return `<a href="${href}">${labelPrefix}${esc(String(s))}</a>`;
  }).join('<br>');
}
