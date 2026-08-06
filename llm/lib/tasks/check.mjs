// check — validate LLM config, credential availability, and REAL reachability.
// Credential presence alone proved misleading (a 404 endpoint passed) — every
// check ends with a minimal live call so "ok" actually means "can answer".
import { loadModelsConfig, resolveSecret } from '../config.mjs';
import { fetchSpnToken } from '../auth.mjs';
import { providerOf, chatCompletion } from '../openai.mjs';

export async function run({ kbRoot }) {
  const config = loadModelsConfig(kbRoot);
  if (!config) {
    return { ok: false, error: '.kb/config/models.json not found' };
  }

  const provider = providerOf(config);
  const checks = {
    provider,
    endpoint: !!config.endpoint,
    auth_type: config.auth?.type,
  };
  if (provider === 'openai') {
    checks.model = config.model || null;
  } else {
    checks.deployment = !!config.deployment;
    checks.api_version = config.api_version || 'default';
  }

  try {
    if (provider === 'openai' && !config.model) throw new Error('provider "openai" requires model');
    if (provider === 'azure' && !config.deployment) throw new Error('provider "azure" requires deployment');
    if (config.auth?.type === 'spn') {
      if (provider !== 'azure') throw new Error('spn auth is only valid for provider "azure"');
      const secret = resolveSecret(config.auth.client_secret);
      if (!secret) throw new Error(`SPN secret env var not set: ${config.auth.client_secret}`);
      await fetchSpnToken({
        tenantId: config.auth.tenant_id,
        clientId: config.auth.client_id,
        clientSecret: secret.value,
      });
      checks.token = true;
    } else if (config.auth?.type === 'api_key') {
      const secret = resolveSecret(config.auth.api_key);
      checks.token = !!secret;
      if (!secret) throw new Error(`API key env var not set: ${config.auth.api_key}`);
    } else {
      throw new Error('unknown auth.type');
    }

    // Live probe: one minimal completion. This is what makes check meaningful —
    // wrong endpoint paths and bad keys surface here, not at first chat.
    const probe = await chatCompletion(config, [{ role: 'user', content: 'ping' }], {
      max_tokens: 1, fetchImpl: globalThis.__WEFT_LLM_FETCH_IMPL__,
    });
    checks.live = !!(probe.choices?.length);
  } catch (err) {
    return { ok: false, config: checks, error: err.message };
  }

  return { ok: true, config: checks };
}
