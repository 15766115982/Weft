// Azure service-principal client-credentials token fetch.
// In-process cache with expiry padding so repeated calls within a session reuse tokens.
const cache = new Map(); // key: tokenUrl, value: { token, expiresOn }

function tokenEndpoint(tenantId) {
  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`;
}

export function getCachedToken(tenantId, clientId) {
  const key = `${tenantId}:${clientId}`;
  const entry = cache.get(key);
  if (entry && entry.expiresOn > Date.now() + 60_000) {
    return entry.token;
  }
  return null;
}

export function setCachedToken(tenantId, clientId, token, expiresIn) {
  const key = `${tenantId}:${clientId}`;
  const expiresOn = Date.now() + expiresIn * 1000;
  cache.set(key, { token, expiresOn });
}

export async function fetchSpnToken({ tenantId, clientId, clientSecret }, fetchImpl = globalThis.fetch) {
  if (!tenantId || !clientId || !clientSecret) {
    throw new Error('Azure SPN config requires tenant_id, client_id, and client_secret');
  }
  const cached = getCachedToken(tenantId, clientId);
  if (cached) return cached;

  const params = new URLSearchParams();
  params.set('client_id', clientId);
  params.set('client_secret', clientSecret);
  params.set('scope', 'https://cognitiveservices.azure.com/.default');
  params.set('grant_type', 'client_credentials');

  const res = await fetchImpl(tokenEndpoint(tenantId), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`SPN token request failed (${res.status}): ${text}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('SPN token response missing access_token');
  }
  setCachedToken(tenantId, clientId, data.access_token, data.expires_in || 3600);
  return data.access_token;
}
