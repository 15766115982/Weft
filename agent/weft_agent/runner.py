"""Shared task runner (port of llm/lib/runner.mjs): load model config, render prompt,
call the model, parse structured JSON responses. All non-streaming tasks use this.

E2E / integration stub: when WEFT_LLM_STUB is set, bypass the model and return
deterministic canned output — identical to the Node implementation's, so the
cross-service e2e suite runs against either engine unchanged.
"""
import json
import os
import re
from collections.abc import Callable
from pathlib import Path

from .client import chat_completion, provider_of
from .config import load_models_config
from .prompts import resolve_prompt

SYSTEM_MESSAGE = "You are a helpful knowledge-base assistant. Follow the output format exactly."


def render(template: str, vars: dict) -> str:
    """Simple {{variable}} substitution."""
    def sub(m: re.Match) -> str:
        v = vars.get(m.group(1))
        return "" if v is None else str(v)
    return re.sub(r"\{\{(\w+)\}\}", sub, template)


def load_model_config(kb_root: Path) -> dict:
    config = load_models_config(kb_root)
    if not config:
        raise RuntimeError(".kb/config/models.json not found; run init-prompts/init-config or create it")
    if not config.get("endpoint"):
        raise RuntimeError("models.json requires endpoint")
    if provider_of(config) == "openai":
        if not config.get("model"):
            raise RuntimeError('models.json with provider "openai" requires model')
    elif not config.get("deployment"):
        raise RuntimeError('models.json with provider "azure" requires deployment')
    return config


def run_prompt(kb_root: Path, prompt_name: str, vars: dict, *, stream: bool = False,
               temperature=None, max_tokens=None, http=None,
               on_delta: Callable[[str], None] | None = None) -> dict:
    if os.environ.get("WEFT_LLM_STUB"):
        canned = stub_for(prompt_name, vars)
        if not stream:
            return {"prompt": "[stub]", "content": canned, "config": {"stub": True}}
        full = ""
        for word in re.findall(r"\S+\s*", canned) or [""]:
            full += word
            if on_delta:
                on_delta(word)
        return {"prompt": "[stub]", "content": full, "config": {"stub": True}}

    config = load_model_config(kb_root)
    template = resolve_prompt(kb_root, prompt_name)
    prompt = render(template, vars)
    defaults = config.get("defaults") or {}
    messages = [
        {"role": "system", "content": SYSTEM_MESSAGE},
        {"role": "user", "content": prompt},
    ]
    # Only send sampling params the KB explicitly configured — some providers
    # reject non-default values outright (Kimi k3: "only 1 is allowed").
    res = chat_completion(
        config, messages, stream=stream,
        temperature=temperature if temperature is not None else defaults.get("temperature"),
        max_tokens=max_tokens if max_tokens is not None else defaults.get("max_tokens"),
        http=http,
    )

    if not stream:
        content = ((res.get("choices") or [{}])[0].get("message") or {}).get("content") or ""
        return {"prompt": prompt, "content": content, "config": config}

    full = ""
    for delta in res:  # streaming: iterator of delta strings
        full += delta
        if on_delta:
            on_delta(delta)
    return {"prompt": prompt, "content": full, "config": config}


def extract_json(text: str):
    """Best-effort JSON extraction: strip markdown fences, parse first object/array."""
    trimmed = text.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", trimmed)
    payload = fence.group(1).strip() if fence else trimmed
    m = re.search(r"(\{[\s\S]*\}|\[[\s\S]*\])", payload)
    if not m:
        raise ValueError("no JSON object/array found in model output")
    return json.loads(m.group(1))


def run_json_prompt(kb_root: Path, prompt_name: str, vars: dict, **opts) -> dict:
    res = run_prompt(kb_root, prompt_name, vars, **opts)
    try:
        return {"prompt": res["prompt"], "data": extract_json(res["content"]), "raw": res["content"]}
    except Exception as err:
        raise RuntimeError(
            f"failed to parse JSON from model output: {err}\nraw:\n{res['content']}"
        ) from err


def stub_for(prompt_name: str, vars: dict) -> str:
    """Deterministic canned output for WEFT_LLM_STUB mode — byte-compatible with
    llm/lib/runner.mjs stubFor so e2e assertions hold against either engine."""
    title = (vars or {}).get("title") or "Stub Title"
    question = (vars or {}).get("question") or "the question"
    if prompt_name == "summarize-source":
        return json.dumps({
            "title": title,
            "summary": f"Stub summary for {title}.",
            "key_points": ["Stub point one.", "Stub point two."],
        })
    if prompt_name == "classify-page":
        return json.dumps({
            "classification": "source",
            "confidence": 0.9,
            "reasoning": "Stub classification: default to source in stub mode.",
        })
    if prompt_name == "extract-entity":
        return json.dumps({
            "entities": [{"slug": "stub-entity", "title": "Stub Entity", "kind": "component"}],
            "relations": [{"from": "stub-entity", "to": "stub-system", "type": "part-of"}],
        })
    if prompt_name == "draft-concept":
        slug = (vars or {}).get("slug") or "stub-concept"
        return json.dumps({
            "slug": slug,
            "title": f"Stub concept {(vars or {}).get('slug') or ''}".strip(),
            "body": f"This is a stub concept page for {(vars or {}).get('slug') or 'unknown'}.",
        })
    if prompt_name == "synthesize":
        return json.dumps({
            "slug": (vars or {}).get("slug") or "stub-synthesis",
            "title": f"Stub synthesis {(vars or {}).get('topic') or ''}".strip(),
            "body": f"This is a stub synthesis for {(vars or {}).get('topic') or 'unknown'}.",
            "sources": (vars or {}).get("sources") if isinstance((vars or {}).get("sources"), list) else [],
        })
    if prompt_name == "govern-decide":
        return json.dumps({
            "decision": "candidate",
            "reason": "Stub mode defaults to candidate for safety.",
            "referenced_decisions": [],
        })
    if prompt_name == "semantic-check":
        return json.dumps({
            "conflict": False,
            "severity": "none",
            "reasoning": "Stub mode reports no conflict.",
            "contradicting_pages": [],
        })
    if prompt_name == "query-rewrite":
        words = str((vars or {}).get("question") or "").split()
        queries = [q for q in [(vars or {}).get("question") or "", " ".join(words[:3])] if q]
        return json.dumps({"queries": queries})
    if prompt_name == "rerank":
        n = len(re.findall(r"^\[\d+\]", str((vars or {}).get("candidates") or ""), flags=re.M))
        return json.dumps({"ranking": list(range(n))})
    if prompt_name == "judge-faithfulness":
        return json.dumps({"claims": [], "score": 1})
    if prompt_name == "judge-relevance":
        return json.dumps({"score": 1, "rationale": "stub"})
    if prompt_name == "judge-context-precision":
        return json.dumps({"per_page": [], "score": 1, "rationale": "stub"})
    if prompt_name == "chat":
        m = re.search(r"^## (.+)$", str((vars or {}).get("context") or ""), flags=re.M)
        first = m.group(1) if m else None
        see = f"See [[{first}]]. " if first else ""
        return (f'Stub answer for "{question}". {see}'
                "In real mode this would cite approved wiki pages.")
    if prompt_name == "deep-research":
        return (f'Stub deep-research answer for "{question}". '
                "In real mode this would perform multi-round retrieval.")
    if prompt_name == "distill-chat":
        return json.dumps({
            "title": "Stub 对话整理",
            "body": "Stub distilled point one [T1].\n\nStub distilled point two [T1].",
        })
    if prompt_name == "govern-source-page":
        return json.dumps({
            "title": title,
            "tags": ["stub", "test"],
            "related_topics": ["stub-topic"],
            "summary_body": ("## Key Points\n\n- Stub point one.\n- Stub point two.\n\n"
                             "## Key Details\n\nStub detail.\n\n"
                             "## Related Topics\n\n- stub-topic\n"),
        })
    if prompt_name == "govern-synthesis":
        slug = (vars or {}).get("slug") or "stub-synthesis"
        return json.dumps({
            "slug": slug,
            "title": f"Stub synthesis {(vars or {}).get('topic') or ''}".strip(),
            "body": f"Stub synthesis body for {(vars or {}).get('topic') or 'unknown'}.",
            "sources": [],
        })
    return f"stub answer for {prompt_name}"
