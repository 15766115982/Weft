"""init-config — seed .kb/config/models.json from the repo templates
(port of llm/lib/tasks/init-config.mjs). Never overwrites silently.
"""
import shutil
from pathlib import Path

from ..config import ensure_kb_config_dir, kb_config_path, load_models_config
from ..textutil import REPO_ROOT

TEMPLATES = {
    "azure": "models.example.json",
    "openai": "models.example.openai.json",
}


def run(kb_root, input=None, output_path=None):
    input = input or {}
    provider = input.get("provider") or "azure"
    template_name = TEMPLATES.get(provider)
    if not template_name:
        raise ValueError(f'unknown provider "{provider}" (expected azure|openai)')
    src = REPO_ROOT / "templates" / template_name
    if not src.exists():
        raise FileNotFoundError(f"template missing: {src}")

    ensure_kb_config_dir(kb_root)
    dst = kb_config_path(kb_root)
    if dst.exists() and input.get("force") is not True:
        return {"ok": True, "status": "skipped", "path": str(dst), "provider": provider,
                "hint": "models.json already exists; pass force to overwrite"}
    shutil.copyfile(src, dst)
    load_models_config.cache_clear()
    return {
        "ok": True,
        "status": "overwritten" if input.get("force") is True else "created",
        "path": str(dst),
        "provider": provider,
        "hint": "edit endpoint/model/auth to your values; secrets stay in env vars (the auth.* fields are env var NAMES)",
    }
