// Settings API routes for Phase 1: read LLM config, run llm check, init prompts.
import fs from 'node:fs';
import path from 'node:path';
import { llmJobSpec } from '../lib/jobrunner.mjs';

function loadModelsConfig(kbRoot) {
  const p = path.join(kbRoot, '.kb', 'config', 'models.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function maskSecrets(config) {
  if (!config || !config.auth) return config;
  const masked = JSON.parse(JSON.stringify(config));
  if (masked.auth.api_key) masked.auth.api_key = `env:${masked.auth.api_key}`;
  if (masked.auth.client_secret) masked.auth.client_secret = `env:${masked.auth.client_secret}`;
  return masked;
}

export function settingsRoutes({ adminAuth, jobs, registry }) {
  return async function handle(req, res, url, readBody, json) {
    const kb = registry.resolve(url.searchParams.get('kb')).path;

    // GET /api/settings — read models.json and env var status.
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const admin = adminAuth.check(req);
      if (!admin.ok) return json(res, 401, { error: admin.error });
      const config = loadModelsConfig(kb);
      const env = {
        WEFT_ADMIN_PASSWORD_HASH: !!process.env.WEFT_ADMIN_PASSWORD_HASH,
        KB_PATH: !!process.env.KB_PATH,
      };
      return json(res, 200, {
        admin_configured: adminAuth.isConfigured(),
        config: maskSecrets(config),
        env,
      });
    }

    // POST /api/settings/check — run llm.mjs check.
    if (req.method === 'POST' && url.pathname === '/api/settings/check') {
      const admin = adminAuth.check(req);
      if (!admin.ok) return json(res, 401, { error: admin.error });
      const spec = llmJobSpec(kb, 'check');
      const job = jobs.enqueue(kb, spec);
      return json(res, 202, { job });
    }

    // POST /api/settings/init-prompts — run llm.mjs init-prompts [--force].
    if (req.method === 'POST' && url.pathname === '/api/settings/init-prompts') {
      const admin = adminAuth.check(req);
      if (!admin.ok) return json(res, 401, { error: admin.error });
      const body = JSON.parse(await readBody(req) || '{}');
      const spec = llmJobSpec(kb, 'init-prompts', { force: body.force === true });
      const job = jobs.enqueue(kb, spec);
      return json(res, 202, { job });
    }

    // POST /api/admin/login
    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      const body = JSON.parse(await readBody(req) || '{}');
      const result = adminAuth.login(body.password);
      if (!result.ok) return json(res, 401, { error: result.error });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': adminAuth.cookieHeader(result.token),
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    // POST /api/admin/logout
    if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
      const cookie = (req.headers.cookie || '').match(/weft_session=([^;]+)/);
      if (cookie) adminAuth.logout(cookie[1]);
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'set-cookie': adminAuth.clearCookieHeader(),
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    return null;
  };
}
