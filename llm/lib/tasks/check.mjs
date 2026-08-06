// check — validate LLM config and SPN token acquisition (Phase 1 stub).
import { loadModelsConfig, resolveSecret } from '../config.mjs';
import { fetchSpnToken } from '../auth.mjs';

export async function run({ kbRoot }) {
  const config = loadModelsConfig(kbRoot);
  if (!config) {
    return { ok: false, error: '.kb/config/models.json not found' };
  }

  const checks = {
    endpoint: !!config.endpoint,
    deployment: !!config.deployment,
    api_version: config.api_version || 'default',
    auth_type: config.auth?.type,
  };

  try {
    if (config.auth?.type === 'spn') {
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
  } catch (err) {
    return { ok: false, config: checks, error: err.message };
  }

  return { ok: true, config: checks };
}
