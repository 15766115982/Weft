"""Subprocess wrapper for the governance CLI (ADR-0012: the graph's only write path).
The agent service never writes wiki/ itself — every mutation goes through
`node govern.mjs <cmd>` so frontmatter, decision log, tombstones, and conflict
fail-closed rules stay enforced in one place.
"""
import json
import shutil
import subprocess
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
GOVERN = REPO_ROOT / "governance" / "scripts" / "govern.mjs"


def run_govern(kb_root: Path, *args: str) -> dict:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("node executable not found on PATH (governance CLI is plain node)")
    proc = subprocess.run(
        [node, str(GOVERN), *args, "--kb", str(kb_root)],
        capture_output=True, shell=False,
        # govern.mjs prints UTF-8 JSON (CJK titles) — never the locale codec.
        encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout[:500]
        try:
            detail = json.loads(detail).get("error", detail)
        except json.JSONDecodeError:
            pass
        raise RuntimeError(f"govern {args[0]} failed: {detail}")
    return json.loads(proc.stdout)


def write_body_file(kb_root: Path, name: str, body: str) -> Path:
    """Scratch page bodies live in the KB's derived-artifact dir (contract:
    .kb/bodies/), never in the repo and never in wiki/ directly."""
    d = kb_root / ".kb" / "bodies"
    d.mkdir(parents=True, exist_ok=True)
    p = d / name
    p.write_text(body, encoding="utf-8")
    return p
