// Settings API routes: read/save LLM config, read/save prompts, run llm check,
// seed config/prompts. Open portal (2026-08-06): no role gating — reads are
// public, POSTs rely on the portal-wide write token check in serve.mjs.
// models.json auth fields hold env var NAMES, never secret values, so reads
// return the config verbatim (editing needs the names).
import fs from 'node:fs';
import path from 'node:path';
import { llmJobSpec } from '../lib/jobrunner.mjs';

function configPath(kbRoot) {
  return path.join(kbRoot, '.kb', 'config', 'models.json');
}

function loadModelsConfig(kbRoot) {
  const p = configPath(kbRoot);
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function promptsDir(kbRoot) {
  return path.join(kbRoot, '.kb', 'config', 'prompts');
}

function loadPromptsList(kbRoot) {
  const dir = promptsDir(kbRoot);
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

// Prompt file names are whitelisted: plain basename, .md only, no separators.
function normalizePromptName(name) {
  const n = String(name || '');
  if (!/^[a-z0-9][a-z0-9-_]*\.md$/i.test(n) || n.includes('..')) {
    throw new Error(`bad prompt file name: ${n}`);
  }
  return n;
}

// Validate the shape of a models.json object before it lands on disk.
function validateConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    return 'config must be a JSON object';
  }
  const provider = config.provider || 'azure';
  if (!['azure', 'openai'].includes(provider)) return `provider must be azure|openai: ${provider}`;
  if (!config.endpoint || !String(config.endpoint).startsWith('http')) return 'endpoint must be an https URL';
  if (provider === 'azure' && !config.deployment) return 'provider azure requires deployment';
  if (provider === 'openai' && !config.model) return 'provider openai requires model';
  const type = config.auth?.type;
  if (type === 'api_key') {
    if (!config.auth.api_key) return 'auth.type api_key requires auth.api_key (env var name)';
  } else if (type === 'spn') {
    if (provider !== 'azure') return 'spn auth is only valid for provider azure';
    for (const k of ['tenant_id', 'client_id', 'client_secret']) {
      if (!config.auth[k]) return `auth.type spn requires auth.${k}`;
    }
  } else {
    return `auth.type must be api_key|spn: ${type}`;
  }
  return null;
}

export function settingsRoutes({ jobs, registry }) {
  return async function handle(req, res, url, readBody, json) {
    const kb = registry.resolve(url.searchParams.get('kb')).path;

    // GET /api/settings — config, prompts list, env var status.
    if (req.method === 'GET' && url.pathname === '/api/settings') {
      const config = loadModelsConfig(kb);
      // Report the secret env vars the config references (never their values).
      const env = {};
      for (const name of [config?.auth?.api_key, config?.auth?.client_secret]) {
        if (name) env[name] = !!process.env[name];
      }
      return json(res, 200, { config, prompts: loadPromptsList(kb), env });
    }

    // GET /api/settings/prompt?file=x.md — one prompt file's body.
    if (req.method === 'GET' && url.pathname === '/api/settings/prompt') {
      const name = normalizePromptName(url.searchParams.get('file'));
      const abs = path.join(promptsDir(kb), name);
      if (!fs.existsSync(abs)) return json(res, 404, { error: `prompt does not exist: ${name}` });
      return json(res, 200, { file: name, body: fs.readFileSync(abs, 'utf8') });
    }

    // POST /api/settings/config — save models.json (validated, backup kept).
    if (req.method === 'POST' && url.pathname === '/api/settings/config') {
      const { config } = JSON.parse(await readBody(req) || '{}');
      const problem = validateConfig(config);
      if (problem) return json(res, 400, { error: problem });
      const dst = configPath(kb);
      fs.mkdirSync(path.dirname(dst), { recursive: true });
      if (fs.existsSync(dst)) fs.copyFileSync(dst, dst + '.bak');
      fs.writeFileSync(dst, JSON.stringify(config, null, 2) + '\n', 'utf8');
      return json(res, 200, { path: dst, saved: true });
    }

    // POST /api/settings/prompt — save one prompt file (whitelisted name).
    if (req.method === 'POST' && url.pathname === '/api/settings/prompt') {
      const { file, body } = JSON.parse(await readBody(req) || '{}');
      const name = normalizePromptName(file);
      if (typeof body !== 'string' || !body.trim()) {
        return json(res, 400, { error: 'prompt body must be non-empty text' });
      }
      const dir = promptsDir(kb);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, name), body, 'utf8');
      return json(res, 200, { file: name, saved: true });
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
