import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

AGENT_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = AGENT_ROOT.parent


@pytest.fixture()
def kb(tmp_path):
    """Scratch KB root with a models.json (provider openai, dummy values)."""
    kb = tmp_path / "kb"
    (kb / ".kb" / "config").mkdir(parents=True)
    (kb / ".kb" / "config" / "models.json").write_text(json.dumps({
        "provider": "openai",
        "endpoint": "http://localhost:9/unreachable",
        "model": "stub-model",
        "auth": {"type": "api_key", "api_key": "WEFT_TEST_KEY"},
    }), encoding="utf-8")
    return kb


@pytest.fixture()
def kb_no_config(tmp_path):
    kb = tmp_path / "kb"
    kb.mkdir()
    return kb


def run_cli(kb, task, input=None, output_path=None, env=None):
    """Spawn the real CLI exactly as the portal/tests do."""
    args = [sys.executable, "-m", "weft_agent", task, "--kb", str(kb)]
    input_file = None
    if input is not None:
        input_file = Path(kb) / ".kb" / f"pytest-input-{task}.json"
        input_file.parent.mkdir(parents=True, exist_ok=True)
        input_file.write_text(json.dumps(input), encoding="utf-8")
        args += ["--input-file", str(input_file)]
    if output_path:
        args += ["--output-file", str(output_path)]
    proc = subprocess.run(
        args, capture_output=True, text=True,
        cwd=str(AGENT_ROOT),
        env={**os.environ, "PYTHONPATH": str(AGENT_ROOT), **(env or {})},
    )
    return proc
