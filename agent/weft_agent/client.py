"""LLM transport: chat completions, streaming and non-streaming (port of llm/lib/openai.mjs).
Two providers, selected by models.json "provider" (default "azure"):
  azure  — Azure OpenAI: /openai/deployments/<d>/chat/completions, api-key
           header or SPN bearer token.
  openai — any OpenAI-compatible endpoint (Kimi, DeepSeek, vLLM, …):
           <base>/chat/completions, Authorization: Bearer <api_key>, "model" in body.
Retry with exponential backoff; basic rate-limit sleep between calls.

Transport is raw httpx (not the openai SDK): the two providers differ in auth
headers and URL shape, and we parse SSE ourselves — the SDK adds no value here
(spike S1/S2 proved raw HTTP against the Kimi gateway).
"""
import json
import time
from collections.abc import Callable, Iterator

import httpx

from .auth import fetch_spn_token
from .config import resolve_secret

DEFAULT_RETRIES = 3
DEFAULT_BACKOFF_S = [1.0, 2.0, 4.0]
DEFAULT_RATE_LIMIT_S = 0.2

_last_call = 0.0

# Shared client: a govern run makes ~200-300 sequential calls; per-call clients
# would pay a fresh TCP+TLS handshake to the gateway each time. The graph is
# sequential, so one pooled sync client per process is safe.
_shared: httpx.Client | None = None


def _shared_client() -> httpx.Client:
    global _shared
    if _shared is None or _shared.is_closed:
        _shared = httpx.Client(timeout=httpx.Timeout(120.0, connect=30.0))
    return _shared


def rate_limit_sleep(seconds: float = DEFAULT_RATE_LIMIT_S) -> None:
    global _last_call
    elapsed = time.monotonic() - _last_call
    if elapsed < seconds:
        time.sleep(seconds - elapsed)
    _last_call = time.monotonic()


def provider_of(config: dict) -> str:
    return config.get("provider") or "azure"


def build_endpoint(config: dict) -> str:
    base = (config.get("endpoint") or "").rstrip("/")
    if not base:
        raise ValueError("models.json requires endpoint")
    if provider_of(config) == "openai":
        return f"{base}/chat/completions"
    if not config.get("deployment"):
        raise ValueError("Azure OpenAI config requires endpoint and deployment")
    v = config.get("api_version") or "2025-01-01-preview"
    return f"{base}/openai/deployments/{config['deployment']}/chat/completions?api-version={v}"


def get_auth_header(config: dict) -> dict[str, str]:
    provider = provider_of(config)
    auth = config.get("auth") or {}
    if auth.get("type") == "api_key" and auth.get("api_key"):
        secret = resolve_secret(auth["api_key"])
        if not secret:
            raise RuntimeError(f"API key env var not set: {auth['api_key']}")
        # Azure uses the api-key header; OpenAI-compatible providers use Bearer.
        if provider == "openai":
            return {"Authorization": f"Bearer {secret[1]}"}
        return {"api-key": secret[1]}
    if provider == "azure" and auth.get("type") == "spn":
        cs = resolve_secret(auth.get("client_secret"))
        if not cs:
            raise RuntimeError(f"SPN secret env var not set: {auth.get('client_secret')}")
        token = fetch_spn_token(auth.get("tenant_id"), auth.get("client_id"), cs[1])
        return {"Authorization": f"Bearer {token}"}
    raise RuntimeError(
        f'models.json auth misconfigured for provider "{provider}" '
        f'(need api_key{" or spn" if provider == "azure" else ""})'
    )


def build_body(config: dict, messages: list[dict], stream: bool,
               temperature=None, max_tokens=None) -> dict:
    body: dict = {"messages": messages, "stream": stream}
    if provider_of(config) == "openai":
        if not config.get("model"):
            raise ValueError('OpenAI-compatible provider requires "model" in models.json')
        body["model"] = config["model"]
    if temperature is not None:
        body["temperature"] = temperature
    if max_tokens is not None:
        body["max_tokens"] = max_tokens
    return body


class HttpStatusError(RuntimeError):
    """Non-200 LLM response; carries the status so the retry loop can tell
    permanent failures (4xx auth/config) from transient ones (429/5xx)."""

    def __init__(self, status_code: int, text: str):
        super().__init__(f"LLM request failed ({status_code}): {text}")
        self.status_code = status_code


def chat_completion(config: dict, messages: list[dict], *, stream: bool = False,
                    temperature=None, max_tokens=None,
                    http: httpx.Client | None = None):
    """Non-stream: returns the parsed response JSON.
    Stream: returns an iterator of delta-content strings (SSE parsed) over the
    shared client; request errors surface on first iteration (the NDJSON tasks
    turn them into error frames), unlike non-stream where they are retried here.
    `http` is a test injection point; the shared pooled client is used otherwise.
    """
    endpoint = build_endpoint(config)
    headers = {"Content-Type": "application/json", **get_auth_header(config)}
    body = build_body(config, messages, stream, temperature, max_tokens)

    if stream:
        if http is not None:
            return _do(http, endpoint, headers, body, True)
        client = _shared_client()

        def owned():
            # stream errors surface on first iteration (the NDJSON tasks turn
            # them into error frames), unlike non-stream where they are retried
            rate_limit_sleep()
            yield from _do(client, endpoint, headers, body, True)

        return owned()

    last_err: Exception | None = None
    for attempt in range(DEFAULT_RETRIES + 1):
        try:
            rate_limit_sleep()
            return _do(http if http is not None else _shared_client(), endpoint, headers, body, False)
        except Exception as err:  # noqa: BLE001
            last_err = err
            # permanent failures gain nothing from a retry (2026-08-12 audit):
            # 4xx other than 429 (auth/config), and a 200 whose body won't parse
            if isinstance(err, HttpStatusError) and err.status_code != 429 and 400 <= err.status_code < 500:
                raise
            if isinstance(err, json.JSONDecodeError):
                raise
            if attempt < DEFAULT_RETRIES:
                time.sleep(DEFAULT_BACKOFF_S[min(attempt, len(DEFAULT_BACKOFF_S) - 1)])
    raise last_err  # type: ignore[misc]


def _do(client: httpx.Client, endpoint: str, headers: dict, body: dict, stream: bool):
    if not stream:
        res = client.post(endpoint, headers=headers, json=body)
        if res.status_code != 200:
            raise HttpStatusError(res.status_code, res.text)
        return res.json()

    def deltas() -> Iterator[str]:
        with client.stream("POST", endpoint, headers=headers, json=body) as res:
            if res.status_code != 200:
                res.read()
                raise RuntimeError(f"LLM request failed ({res.status_code}): {res.text}")
            for line in res.iter_lines():
                line = line.strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if not payload or payload == "[DONE]":
                    continue
                try:
                    parsed = json.loads(payload)
                except json.JSONDecodeError:
                    continue  # ignore malformed SSE lines
                delta = (parsed.get("choices") or [{}])[0].get("delta", {}).get("content") or ""
                if delta:
                    yield delta

    return deltas()
