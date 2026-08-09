"""Prompt file resolution and seeding (port of llm/lib/prompts.mjs).
Defaults live in <repo>/templates/prompts/; editable per-KB copies in .kb/config/prompts/.
"""
import functools
import shutil
from pathlib import Path

from .textutil import REPO_ROOT


def default_prompts_dir() -> Path:
    return REPO_ROOT / "templates" / "prompts"


def kb_prompts_dir(kb_root: Path) -> Path:
    return kb_root / ".kb" / "config" / "prompts"


@functools.lru_cache(maxsize=None)
def resolve_prompt(kb_root: Path, name: str) -> str:
    # cached per process (init-prompts clears after writing)
    kb_path = kb_prompts_dir(kb_root) / f"{name}.md"
    if kb_path.exists():
        return kb_path.read_text(encoding="utf-8")
    default_path = default_prompts_dir() / f"{name}.md"
    if default_path.exists():
        return default_path.read_text(encoding="utf-8")
    raise FileNotFoundError(f"prompt not found: {name}")


def list_prompts() -> list[str]:
    d = default_prompts_dir()
    if not d.is_dir():
        return []
    return sorted(f.stem for f in d.glob("*.md"))


def init_prompts(kb_root: Path, force: bool = False) -> dict:
    src = default_prompts_dir()
    dst = kb_prompts_dir(kb_root)
    dst.mkdir(parents=True, exist_ok=True)
    if not src.is_dir():
        raise FileNotFoundError(f"default prompts directory missing: {src}")

    results = []
    for src_path in sorted(src.glob("*.md")):
        dst_path = dst / src_path.name
        if dst_path.exists() and not force:
            results.append({"file": src_path.name, "status": "skipped"})
            continue
        existed = dst_path.exists()
        shutil.copyfile(src_path, dst_path)
        results.append({"file": src_path.name, "status": "overwritten" if existed else "created"})
    return {"src": str(src), "dst": str(dst), "results": results}
