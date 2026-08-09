"""KB location and model configuration resolution (port of llm/lib/config.mjs).
Secrets are referenced by env-var name in config; actual values are read from env only.
"""
import json
import os
from pathlib import Path


def resolve_kb_root(flag_value: str | None) -> Path:
    root = flag_value or os.environ.get("KB_PATH")
    if not root:
        raise ValueError("no knowledge base specified: pass --kb <path> or set the KB_PATH env var")
    abs_root = Path(root).resolve()
    if not abs_root.is_dir():
        raise ValueError(f"kb directory does not exist: {abs_root}")
    return abs_root


def kb_config_path(kb_root: Path) -> Path:
    return kb_root / ".kb" / "config" / "models.json"


def load_models_config(kb_root: Path) -> dict | None:
    p = kb_config_path(kb_root)
    if not p.exists():
        return None
    return json.loads(p.read_text(encoding="utf-8"))


def resolve_secret(config_key: str | None) -> tuple[str, str] | None:
    """Resolve a secret referenced by env-var name. Returns (name, value) or None."""
    if not config_key:
        return None
    value = os.environ.get(config_key)
    if not value:
        return None
    return (config_key, value)


def ensure_kb_config_dir(kb_root: Path) -> Path:
    d = kb_root / ".kb" / "config"
    d.mkdir(parents=True, exist_ok=True)
    return d
