// LLM transport: chat completions, streaming and non-streaming.
// Two providers, selected by models.json "provider" (default "azure"):
//   azure  — Azure OpenAI: /openai/deployments/<d>/chat/completions, api-key
//            header or SPN bearer token.
//   openai — any OpenAI-compatible endpoint (Kimi, DeepSeek, vLLM, …):
//            <base>/chat/completions, Authorization: Bearer <api_key>, and a
//            "model" field in the request body.
// Retry with exponential backoff; basic rate-limit sleep between calls.
import { fetchSpnToken } from './auth.mjs';
import { resolveSecret } from './config.mjs';

const DEFAULT_RETRIES = 3;
const DEFAULT_BACKOFF_MS = [1000, 2000, 4000];
const DEFAULT_RATE_LIMIT_MS = 200;

let lastCallTime = 0;

export async function rateLimitSleep(ms = DEFAULT_RATE_LIMIT_MS) {
  const now = Date.now();
  const elapsed = now - lastCallTime;
  if (elapsed < ms) {
    await new Promise((r) => setTimeout(r, ms - elapsed));
  }
  lastCallTime = Date.now();
}

export function providerOf(config) {
  return config.provider || 'azure';
}

export function buildEndpoint(config) {
  const base = (config.endpoint || '').replace(/\/$/, '');
  if (!base) throw new Error('models.json requires endpoint');
  if (providerOf(config) === 'openai') {
    return `${base}/chat/completions`;
  }
  if (!config.deployment) {
    throw new Error('Azure OpenAI config requires endpoint and deployment');
  }
  const v = config.api_version || '2025-01-01-preview';
  return `${base}/openai/deployments/${config.deployment}/chat/completions?api-version=${v}`;
}

async function getAuthHeader(config) {
  const provider = providerOf(config);
  if (config.auth?.type === 'api_key' && config.auth.api_key) {
    const secret = resolveSecret(config.auth.api_key);
    if (!secret) throw new Error(`API key env var not set: ${config.auth.api_key}`);
    // Azure uses the api-key header; OpenAI-compatible providers use Bearer.
    return provider === 'openai'
      ? { Authorization: `Bearer ${secret.value}` }
      : { 'api-key': secret.value };
  }
  if (provider === 'azure' && config.auth?.type === 'spn') {
    const tenant = config.auth.tenant_id;
    const client = config.auth.client_id;
    const cs = resolveSecret(config.auth.client_secret);
    if (!cs) throw new Error(`SPN secret env var not set: ${config.auth.client_secret}`);
    const token = await fetchSpnToken({ tenantId: tenant, clientId: client, clientSecret: cs.value });
    return { Authorization: `Bearer ${token}` };
  }
  throw new Error(`models.json auth misconfigured for provider "${provider}" (need api_key${provider === 'azure' ? ' or spn' : ''})`);
}

async function doFetch(endpoint, body, authHeaders, fetchImpl = globalThis.fetch) {
  await rateLimitSleep();
  return fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeaders },
    body: JSON.stringify(body),
  });
}

export async function chatCompletion(config, messages, { stream = false, temperature, max_tokens, fetchImpl } = {}) {
  const endpoint = buildEndpoint(config);
  const authHeaders = await getAuthHeader(config);
  const body = { messages, stream };
  if (providerOf(config) === 'openai') {
    if (!config.model) throw new Error('OpenAI-compatible provider requires "model" in models.json');
    body.model = config.model;
  }
  if (temperature !== undefined) body.temperature = temperature;
  if (max_tokens !== undefined) body.max_tokens = max_tokens;

  let lastErr;
  for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt++) {
    try {
      const res = await doFetch(endpoint, body, authHeaders, fetchImpl);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`LLM request failed (${res.status}): ${text}`);
      }
      if (stream) return res.body || res; // mocks may return the stream directly
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (attempt < DEFAULT_RETRIES) {
        await new Promise((r) => setTimeout(r, DEFAULT_BACKOFF_MS[attempt] || DEFAULT_BACKOFF_MS.at(-1)));
      }
    }
  }
  throw lastErr;
}
