// Shared admin-session helper for UI portal tests (ADR-0009 role gating).
// lib/adminauth.mjs reads WEFT_ADMIN_PASSWORD_HASH at createPortal() time, so
// call useTestAdminEnv() BEFORE createPortal(). Node's fetch does not retain
// the HttpOnly session cookie — capture the set-cookie header from login and
// replay it as the `cookie` header on subsequent requests.
import crypto from 'node:crypto';

export const TEST_ADMIN_PASSWORD = 'test-password-123';
export const TEST_ADMIN_PASSWORD_HASH =
  crypto.createHash('sha256').update(TEST_ADMIN_PASSWORD, 'utf8').digest('hex');

/** Arm admin auth for portals created after this call. */
export function useTestAdminEnv() {
  process.env.WEFT_ADMIN_PASSWORD_HASH = TEST_ADMIN_PASSWORD_HASH;
}

export function clearTestAdminEnv() {
  delete process.env.WEFT_ADMIN_PASSWORD_HASH;
}

/**
 * POST /api/admin/login. Returns { res, cookie } where cookie is the raw
 * set-cookie value ("weft_session=...; HttpOnly; ...") — pass it verbatim as
 * the `cookie` request header on operator endpoint calls.
 */
export async function adminLogin(base, password = TEST_ADMIN_PASSWORD) {
  const res = await fetch(base + '/api/admin/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password }),
  });
  return { res, cookie: res.headers.get('set-cookie') };
}

/** Convenience: login and assert success, returning the cookie header value. */
export async function adminCookie(base) {
  const { res, cookie } = await adminLogin(base);
  if (res.status !== 200 || !cookie) {
    throw new Error(`admin login failed: ${res.status} ${await res.text()}`);
  }
  return cookie;
}
