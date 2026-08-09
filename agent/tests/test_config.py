import json

import pytest

from weft_agent.config import (kb_config_path, load_models_config, resolve_kb_root,
                               resolve_secret)


def test_resolve_kb_root_flag(kb):
    assert resolve_kb_root(str(kb)) == kb.resolve()


def test_resolve_kb_root_env(kb, monkeypatch):
    monkeypatch.setenv("KB_PATH", str(kb))
    assert resolve_kb_root(None) == kb.resolve()


def test_resolve_kb_root_missing(kb_no_config, monkeypatch):
    monkeypatch.delenv("KB_PATH", raising=False)
    with pytest.raises(ValueError, match="no knowledge base"):
        resolve_kb_root(None)
    with pytest.raises(ValueError, match="does not exist"):
        resolve_kb_root(str(kb_no_config / "nope"))


def test_load_models_config(kb):
    cfg = load_models_config(kb)
    assert cfg["provider"] == "openai"
    assert kb_config_path(kb).name == "models.json"


def test_load_models_config_absent(kb_no_config):
    assert load_models_config(kb_no_config) is None


def test_resolve_secret(monkeypatch):
    monkeypatch.setenv("WEFT_TEST_KEY", "sk-test")
    assert resolve_secret("WEFT_TEST_KEY") == ("WEFT_TEST_KEY", "sk-test")
    assert resolve_secret("WEFT_TEST_MISSING") is None
    assert resolve_secret(None) is None
    assert resolve_secret("") is None
