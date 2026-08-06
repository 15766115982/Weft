// Azure OpenAI transport: chat completions, streaming and non-streaming.
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

export function buildEndpoint(baseUrl, deployment, apiVersion) {
  if (!baseUrl || !deployment) {
    throw new Error('Azure OpenAI config requires endpoint and deployment');
  }
  const v = apiVersion || '2025-01-01-preview';
  return `${baseUrl.replace(/\/$/, '')}/openai/deployments/${deployment}/chat/completions?api-version=${v}`;
}

async function getAuthHeader(config) {
  if (config.auth?.type === 'api_key' && config.auth.api_key) {
    const secret = resolveSecret(config.auth.api_key);
    if (!secret) throw new Error(`API key env var not set: ${config.auth.api_key}`);
    return { 'api-key': secret.value };
  }
  if (config.auth?.type === 'spn') {
    const tenant = config.auth.tenant_id;
    const client = config.auth.client_id;
    const cs = resolveSecret(config.auth.client_secret);
    if (!cs) throw new Error(`SPN secret env var not set: ${config.auth.client_secret}`);
    const token = await fetchSpnToken({ tenantId: tenant, clientId: client, clientSecret: cs.value });
    return { Authorization: `Bearer ${token}` };
  }
  throw new Error('Azure OpenAI config requires auth.type of api_key or spn');
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
  const endpoint = buildEndpoint(config.endpoint, config.deployment, config.api_version);
  const authHeaders = await getAuthHeader(config);
  const body = { messages, stream };
  if (temperature !== undefined) body.temperature = temperature;
  if (max_tokens !== undefined) body.max_tokens = max_tokens;

  let lastErr;
  for (let attempt = 0; attempt <= DEFAULT_RETRIES; attempt++) {
    try {
      const res = await doFetch(endpoint, body, authHeaders, fetchImpl);
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Azure OpenAI request failed (${res.status}): ${text}`);
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
