"""Shared subprocess wrapper for the repo's plain-node service CLIs
(kb_search.mjs, govern.mjs). One place owns node resolution, the UTF-8 decode
(Windows GBK would corrupt CJK JSON), and error surfacing.
"""
import json
import shutil
import subprocess
from pathlib import Path


def run_node_cli(script: Path, args: list[str], kb_root: Path) -> dict:
    node = shutil.which("node")
    if not node:
        raise RuntimeError(f"node executable not found on PATH ({Path(script).name} is plain node)")
    proc = subprocess.run(
        [node, str(script), *args, "--kb", str(kb_root)],
        capture_output=True, shell=False,
        encoding="utf-8", errors="replace",
    )
    if proc.returncode != 0:
        detail = proc.stderr.strip() or proc.stdout[:500]
        try:
            detail = json.loads(detail).get("error", detail)
        except json.JSONDecodeError:
            pass
        raise RuntimeError(f"{Path(script).stem} {args[0] if args else ''} failed: {detail}")
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"raw": proc.stdout}
