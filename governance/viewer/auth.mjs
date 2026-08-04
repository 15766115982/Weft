// Localhost write security for the thin viewer (CONTEXT.md thin-tools red
// line 2 — shared by portal and viewer). INTENTIONAL near-copy of
// ui/lib/auth.mjs: the viewer must not import the portal's code (ADR-0004
// dumb-consumer separation; CONTEXT.md's shared red lines), so the discipline
// is duplicated by hand, like the three frontmatter.mjs copies. If one side
// changes, change the other.
//
// Binding 127.0.0.1 does NOT stop a malicious web page from POSTing to this
// server (simple requests are not CORS-preflighted; CORS only blocks reading
// the response) — so every write request must carry the per-startup token and
// pass Origin/Host checks. The token is generated per launch, injected into
// the first-page HTML meta, never written to disk, never logged.
import crypto from 'node:crypto';

export function createAuth() {
  const token = crypto.randomBytes(24).toString('base64url');
  // Port-agnostic on purpose: the process binds 127.0.0.1 only, so any port on
  // a loopback host is this server; the check exists against DNS rebinding
  // (a non-loopback Host), not against port numbers (which also breaks tests
  // on ephemeral port 0).
  const hostRe = /^(127\.0\.0\.1|localhost)(:\d+)?$/;
  const originRe = /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/;

  // Returns null when the request may proceed, or {code, error} to refuse.
  function checkWrite(req) {
    if (req.headers['x-viewer-token'] !== token) {
      return { code: 403, error: 'write requests require the per-startup token (x-viewer-token)' };
    }
    const badHost = checkHost(req);
    if (badHost) return badHost;
    const origin = req.headers.origin;
    if (origin && !originRe.test(origin)) {
      return { code: 403, error: `refused cross-origin write (Origin: ${origin})` };
    }
    return null;
  }

  // Reads need the Host check too. CORS blocks cross-origin reads but NOT DNS
  // rebinding — a malicious domain resolving to 127.0.0.1 is same-origin to
  // the browser and could read the whole KB (and the injected token from
  // index.html). Every request, read or write, must arrive with a loopback Host.
  function checkHost(req) {
    const host = req.headers.host || '';
    if (!hostRe.test(host)) {
      return { code: 403, error: `refused Host: ${host} (DNS-rebinding guard)` };
    }
    return null;
  }

  return { token, checkWrite, checkHost };
}
