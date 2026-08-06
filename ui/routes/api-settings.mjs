// Settings API routes: read LLM config, run llm check, init prompts.
// Open portal (2026-08-06): no role gating — reads are public, POSTs rely on
// the portal-wide write token check in serve.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { llmJobSpec } from '../lib/jobrunner.mjs';

function loadModelsConfig(kbRoot) {
  const p = path.join(kbRoot, '.kb', 'config', 'models.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function loadPromptsList(kbRoot) {
  const dir = path.join(kbRoot, '.kb', 'config', 'prompts');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => {
      const abs = path.join(dir, f);
      const text = fs.readFileSync(abs, 'utf8');
      const title = text.split('\n')[0].replace(/^#+\s*/, '').trim() || f;
      return { file: f, title, size: text.length };
    });
}

function maskSecrets(config) {
  if (!config || !config.auth) return config;
  const masked = JSON.parse(JSON.stringify(config));
  if (masked.auth.api_key) masked.auth.api_key = `env:${masked.auth.api_key}`;
  if (masked.auth.client_secret) masked.auth.client_secret = `env:${masked.auth.client_secret}`;
  return masked;
}

export function settingsRoutes({ jobs, registry }) {
  return async function handle(req, res, url, readBody, json) {
    const kb = registry.resolve(url.searchParams.get('kb')).path;

    // GET /api/settings — read models.json, prompts list, and env var status.
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const config = loadModelsConfig(kb);
      // Report the secret env vars the config references (never their values).
      const env = {};
      for (const name of [config?.auth?.api_key, config?.auth?.client_secret]) {
        if (name) env[name] = !!process.env[name];
      }
      return json(res, 200, {
        config: maskSecrets(config),
        prompts: loadPromptsList(kb),
        env,
      });
    }

    // POST /api/settings/check — run llm.mjs check.
    if (req.method === 'POST' && url.pathname === '/api/settings/check') {
      const spec = llmJobSpec(kb, 'check');
      const job = jobs.enqueue(kb, spec);
      return json(res, 202, { job });
    }

    // POST /api/settings/init-prompts — run llm.mjs init-prompts [--force].
    if (req.method === 'POST' && url.pathname === '/api/settings/init-prompts') {
      const body = JSON.parse(await readBody(req) || '{}');
      const spec = llmJobSpec(kb, 'init-prompts', { force: body.force === true });
      const job = jobs.enqueue(kb, spec);
      return json(res, 202, { job });
    }

    // POST /api/settings/init-config — seed .kb/config/models.json from a
    // provider template ({ provider: 'azure'|'openai', force?: boolean }).
    if (req.method === 'POST' && url.pathname === '/api/settings/init-config') {
      const body = JSON.parse(await readBody(req) || '{}');
      const spec = llmJobSpec(kb, 'init-config', { provider: body.provider, force: body.force === true });
      const job = jobs.enqueue(kb, spec);
      return json(res, 202, { job });
    }

    return null;
  };
}
