// Team portal admin authentication (ADR-0009).
// Single operator login via WEFT_ADMIN_PASSWORD_HASH env var; readers are unauthenticated.
// Sessions are kept in memory (per-process) with a simple signed cookie.
import crypto from 'node:crypto';

const SESSION_COOKIE = 'weft_session';
const SESSION_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours

function sha256(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function createAdminAuth() {
  const sessions = new Map();
  const passwordHash = process.env.WEFT_ADMIN_PASSWORD_HASH || null;

  function isConfigured() {
    return !!passwordHash;
  }

  function login(password) {
    if (!passwordHash) return { ok: false, error: 'admin login is not configured' };
    if (sha256(password) !== passwordHash) return { ok: false, error: 'invalid password' };
    const token = crypto.randomBytes(24).toString('base64url');
    sessions.set(token, { createdAt: Date.now() });
    return { ok: true, token };
  }

  function logout(token) {
    sessions.delete(token);
  }

  function check(req) {
    if (!passwordHash) return { ok: false, error: 'admin login is not configured' };
    const cookie = parseCookie(req.headers.cookie || '')[SESSION_COOKIE];
    if (!cookie || !sessions.has(cookie)) return { ok: false, error: 'admin session required' };
    const s = sessions.get(cookie);
    if (Date.now() - s.createdAt > SESSION_MAX_AGE_MS) {
      sessions.delete(cookie);
      return { ok: false, error: 'admin session expired' };
    }
    return { ok: true };
  }

  function cookieHeader(token) {
    return `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${Math.floor(SESSION_MAX_AGE_MS / 1000)}`;
  }

  function clearCookieHeader() {
    return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Strict; Max-Age=0`;
  }

  return { isConfigured, login, logout, check, cookieHeader, clearCookieHeader };
}

function parseCookie(header) {
  const out = {};
  for (const part of header.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k) out[k] = v || '';
  }
  return out;
}
