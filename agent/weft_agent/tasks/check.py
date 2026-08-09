"""check — validate LLM config, credential availability, and REAL reachability
(port of llm/lib/tasks/check.mjs). Credential presence alone proved misleading
(a 404 endpoint passed) — every check ends with a minimal live call so "ok"
actually means "can answer".
"""
from ..auth import fetch_spn_token
from ..client import chat_completion, provider_of
from ..config import load_models_config, resolve_secret


def run(kb_root, input=None, output_path=None):
    config = load_models_config(kb_root)
    if not config:
        return {"ok": False, "error": ".kb/config/models.json not found"}

    provider = provider_of(config)
    checks = {
        "provider": provider,
        "endpoint": bool(config.get("endpoint")),
        "auth_type": (config.get("auth") or {}).get("type"),
    }
    if provider == "openai":
        checks["model"] = config.get("model")
    else:
        checks["deployment"] = bool(config.get("deployment"))
        checks["api_version"] = config.get("api_version") or "default"

    try:
        if provider == "openai" and not config.get("model"):
            raise RuntimeError('provider "openai" requires model')
        if provider == "azure" and not config.get("deployment"):
            raise RuntimeError('provider "azure" requires deployment')
        auth = config.get("auth") or {}
        if auth.get("type") == "spn":
            if provider != "azure":
                raise RuntimeError('spn auth is only valid for provider "azure"')
            secret = resolve_secret(auth.get("client_secret"))
            if not secret:
                raise RuntimeError(f"SPN secret env var not set: {auth.get('client_secret')}")
            fetch_spn_token(auth.get("tenant_id"), auth.get("client_id"), secret[1])
            checks["token"] = True
        elif auth.get("type") == "api_key":
            secret = resolve_secret(auth.get("api_key"))
            checks["token"] = bool(secret)
            if not secret:
                raise RuntimeError(f"API key env var not set: {auth.get('api_key')}")
        else:
            raise RuntimeError("unknown auth.type")

        # Live probe: one minimal completion. This is what makes check meaningful —
        # wrong endpoint paths and bad keys surface here, not at first chat.
        # (Node used max_tokens=1; reasoning models burn the budget on hidden
        # reasoning and return empty content — 32 keeps the probe meaningful.)
        probe = chat_completion(config, [{"role": "user", "content": "ping"}], max_tokens=32)
        checks["live"] = bool(probe.get("choices"))
    except Exception as err:  # noqa: BLE001 — check reports, never raises
        return {"ok": False, "config": checks, "error": str(err)}

    return {"ok": True, "config": checks}
