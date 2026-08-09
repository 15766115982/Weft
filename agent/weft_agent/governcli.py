"""Subprocess wrapper for the governance CLI (ADR-0012: the graph's only write path).
The agent service never writes wiki/ itself — every mutation goes through
`node govern.mjs <cmd>` so frontmatter, decision log, tombstones, and conflict
fail-closed rules stay enforced in one place.
"""
from pathlib import Path

from .nodecli import run_node_cli
from .textutil import REPO_ROOT

GOVERN = REPO_ROOT / "governance" / "scripts" / "govern.mjs"


def run_govern(kb_root: Path, *args: str) -> dict:
    return run_node_cli(GOVERN, list(args), kb_root)


def write_body_file(kb_root: Path, name: str, body: str) -> Path:
    """Scratch page bodies live in the KB's derived-artifact dir (contract:
    .kb/bodies/), never in the repo and never in wiki/ directly."""
    d = kb_root / ".kb" / "bodies"
    d.mkdir(parents=True, exist_ok=True)
    p = d / name
    p.write_text(body, encoding="utf-8")
    return p
