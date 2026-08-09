"""Azure service-principal client-credentials token fetch (port of llm/lib/auth.mjs).
In-process cache with expiry padding so repeated calls within a session reuse tokens.
"""
import time
import urllib.parse
import urllib.request
import json

_cache: dict[str, tuple[str, float]] = {}  # tokenUrl -> (token, expires_on_ms)

SCOPE = "https://cognitiveservices.azure.com/.default"


def _token_endpoint(tenant_id: str) -> str:
    return f"https://login.microsoftonline.com/{tenant_id}/oauth2/v2.0/token"


def fetch_spn_token(tenant_id: str, client_id: str, client_secret: str, http_post=None) -> str:
    if not tenant_id or not client_id or not client_secret:
        raise ValueError("Azure SPN config requires tenant_id, client_id, and client_secret")
    url = _token_endpoint(tenant_id)
    cached = _cache.get(url)
    now_ms = time.time() * 1000
    if cached and cached[1] > now_ms + 60_000:
        return cached[0]

    body = urllib.parse.urlencode({
        "client_id": client_id,
        "client_secret": client_secret,
        "scope": SCOPE,
        "grant_type": "client_credentials",
    }).encode()

    if http_post is not None:  # test injection point
        status, text = http_post(url, body)
    else:
        req = urllib.request.Request(url, data=body, headers={"Content-Type": "application/x-www-form-urlencoded"}, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=30) as res:
                status, text = res.status, res.read().decode()
        except urllib.error.HTTPError as e:
            status, text = e.code, e.read().decode()
    if status != 200:
        raise RuntimeError(f"SPN token request failed ({status}): {text}")
    data = json.loads(text)
    token = data.get("access_token")
    if not token:
        raise RuntimeError("SPN token response missing access_token")
    _cache[url] = (token, time.time() * 1000 + int(data.get("expires_in", 3600)) * 1000)
    return token
