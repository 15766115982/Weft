"""Shared text helpers for the agent package."""
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent


def strip_frontmatter(text: str) -> str:
    """Body without the leading --- ... --- frontmatter block (offset arithmetic
    mirrors the Node frontmatter.mjs contract)."""
    end = text.find("\n---", 3) if text.startswith("---") else -1
    return (text[end + 4:] if end > 0 else text).strip()
