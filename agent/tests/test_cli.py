"""CLI contract tests — spawn the real entry, exactly like the portal does."""
import json

from conftest import run_cli


def test_usage_exit_64(kb):
    proc = run_cli(kb, "no-such-task")
    assert proc.returncode == 64
    assert "tasks:" in proc.stderr


def test_missing_kb_exit_64(tmp_path, monkeypatch):
    monkeypatch.delenv("KB_PATH", raising=False)
    proc = run_cli(tmp_path / "absent", "check")
    assert proc.returncode == 64
    assert json.loads(proc.stderr)["error"]


def test_valueless_option_exit_64(kb):
    """2026-08-12 audit: --input-file with no value used to parse as boolean
    True and the task silently ran on empty input — now a loud usage error."""
    import subprocess, sys, os
    from conftest import AGENT_ROOT
    proc = subprocess.run(
        [sys.executable, "-m", "weft_agent", "summarize-source", "--kb", str(kb), "--input-file"],
        capture_output=True, text=True, encoding="utf-8", cwd=str(AGENT_ROOT),
        env={**os.environ, "PYTHONPATH": str(AGENT_ROOT)},
    )
    assert proc.returncode == 64
    assert "requires a value" in json.loads(proc.stderr)["error"]


def test_init_config_creates_models_json(kb_no_config):
    proc = run_cli(kb_no_config, "init-config", input={"provider": "openai"})
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out["status"] == "created"
    assert out["provider"] == "openai"
    cfg = json.loads((kb_no_config / ".kb" / "config" / "models.json").read_text(encoding="utf-8"))
    assert cfg["provider"] == "openai"


def test_init_config_never_overwrites_silently(kb_no_config):
    run_cli(kb_no_config, "init-config", input={"provider": "openai"})
    proc = run_cli(kb_no_config, "init-config", input={"provider": "openai"})
    assert json.loads(proc.stdout)["status"] == "skipped"
    proc = run_cli(kb_no_config, "init-config", input={"provider": "openai", "force": True})
    assert json.loads(proc.stdout)["status"] == "overwritten"


def test_init_config_unknown_provider_exit_1(kb_no_config):
    proc = run_cli(kb_no_config, "init-config", input={"provider": "nope"})
    assert proc.returncode == 1
    assert "unknown provider" in json.loads(proc.stderr)["error"]


def test_init_prompts_seeds_prompt_dir(kb_no_config):
    proc = run_cli(kb_no_config, "init-prompts")
    assert proc.returncode == 0, proc.stderr
    out = json.loads(proc.stdout)
    assert out["ok"] is True
    names = {p["file"] for p in out["prompts"]}
    assert {"chat.md", "summarize-source.md", "govern-decide.md"} <= names
    # second run skips everything
    out2 = json.loads(run_cli(kb_no_config, "init-prompts").stdout)
    assert all(p["status"] == "skipped" for p in out2["prompts"])


def test_check_reports_unreachable_live_probe(kb):
    proc = run_cli(kb, "check", env={"WEFT_TEST_KEY": "sk-x"})
    out = json.loads(proc.stdout)
    assert out["ok"] is False
    assert out["config"]["provider"] == "openai"
    assert "error" in out


def test_streaming_task_requires_output_file(kb):
    proc = run_cli(kb, "chat", input={"question": "q"}, env={"WEFT_LLM_STUB": "1"})
    assert proc.returncode == 64
    assert "--output-file" in json.loads(proc.stderr)["error"]
