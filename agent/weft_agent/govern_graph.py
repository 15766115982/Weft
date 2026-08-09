"""Graph-constrained governance run (ADR-0012 §4).

Fixed skeleton — sweep → plan → per-document → synthesis → rebuild-index → report.
Graph nodes call `govern.mjs` subcommands via subprocess: the governance CLI
stays the ONLY write path (frontmatter, decision log, tombstones, conflict
fail-closed rules all keep enforcing). The LLM never picks the flow and never
touches the filesystem; it produces structured per-node judgments only:

- per document: govern-source-page prompt → {title, tags, related_topics, summary_body}
- per synthesis cluster: govern-synthesis prompt → {slug, title, body, sources}
- update safety: semantic-check against the existing synthesis body; conflict → --candidate

Human-owned plan lists (anomalies, errors, orphaned_pages, review_queue,
dangling_links, conflicts) are REPORTED, never auto-adjudicated (skill red
line 6: archive is a human decision).

Every node boundary is a checkpoint (JsonFileSaver under .kb/agent/, see
checkpoints.py for why not SqliteSaver), so a crashed run resumes at the exact
node via the same thread_id.
"""
import os
import re
from operator import add
from pathlib import Path
from typing import Annotated, TypedDict

from langgraph.graph import END, START, StateGraph

from .config import load_models_config
from .governcli import run_govern, write_body_file
from .runner import run_json_prompt
from .textutil import strip_frontmatter as _strip_frontmatter

MAX_SYNTH_CLUSTERS = 10   # per run; anything beyond is reported, not silently dropped
SYNTH_SOURCE_CAP = 6      # source page bodies fed to the drafting prompt
SYNTH_PAGE_BUDGET = 2500  # chars per source page body
MIN_CLUSTER_RAWS = 2      # a topic hook needs ≥2 sources to become a synthesis


class GovernState(TypedDict, total=False):
    queue: list[dict]                       # pending plan items, processed one per node visit
    results: Annotated[list[dict], add]     # per-doc apply outcomes
    doc_errors: Annotated[list[dict], add]
    hooks: Annotated[list[dict], add]       # {raw, page, topics} for synthesis clustering
    syntheses: Annotated[list[dict], add]
    synth_errors: Annotated[list[dict], add]
    plan_report: dict                       # human-owned lists, reported verbatim



def _slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")[:60] or "untitled"


def _model_version(kb_root: Path) -> str:
    if os.environ.get("WEFT_LLM_STUB"):
        return "stub"
    try:
        cfg = load_models_config(kb_root) or {}
    except Exception:  # noqa: BLE001
        return "unknown"
    return cfg.get("model") or cfg.get("deployment") or "unknown"


def build_govern_app(kb_root: Path, on_event, *, brief: str = "", checkpointer=None):
    """Build the compiled govern graph. on_event receives dicts (NDJSON frames)."""
    kb_root = Path(kb_root)
    mv = _model_version(kb_root)

    def sweep_node(state: GovernState):
        out = run_govern(kb_root, "sweep")
        on_event({"type": "phase", "phase": "sweep", "result": out})
        return {}

    def plan_node(state: GovernState):
        plan = run_govern(kb_root, "plan")
        queue = list(plan.get("pending") or [])
        on_event({"type": "phase", "phase": "plan", "pending": len(queue)})
        # Human-owned lists: report, never adjudicate (red line 6).
        report = {}
        for name in ("anomalies", "errors", "orphaned_pages", "review_queue", "dangling_links"):
            items = plan.get(name) or []
            report[name] = len(items)
            on_event({"type": "human-list", "name": name, "count": len(items),
                      "items": items[:10], "truncated": max(0, len(items) - 10)})
        live_conflicts = [g for g in (plan.get("conflicts") or []) if not g.get("dismissed")]
        report["conflicts"] = len(live_conflicts)
        on_event({"type": "human-list", "name": "conflicts", "count": len(live_conflicts),
                  "items": [{"raws": g.get("raws"), "kind": g.get("kind") or g.get("type")}
                            for g in live_conflicts[:10]],
                  "truncated": max(0, len(live_conflicts) - 10)})
        report["suppressed"] = len(plan.get("suppressed") or [])
        return {"queue": queue, "plan_report": report}

    def process_doc_node(state: GovernState):
        item = state["queue"][0]
        rest = state["queue"][1:]
        raw_rel, title = item["raw"], item.get("title") or item["raw"]
        try:
            raw_text = (kb_root / raw_rel).read_text(encoding="utf-8")
            body = _strip_frontmatter(raw_text)
            data = run_json_prompt(kb_root, "govern-source-page", {
                "title": title, "source": raw_rel.split("/")[1] if "/" in raw_rel else raw_rel,
                "body": body, "brief": brief,
            })["data"]
            summary_body = (data.get("summary_body") or "").strip()
            if not summary_body:
                raise RuntimeError("model returned empty summary_body")
            body_file = write_body_file(kb_root, f"{Path(item['page']).stem}.md", summary_body)
            tags = [str(t) for t in (data.get("tags") or []) if str(t).strip()]
            args = ["apply-source", "--raw", raw_rel, "--body-file", str(body_file),
                    "--actor", "agent", "--model-version", mv]
            if tags:
                args += ["--tags", ",".join(tags)]
            out = run_govern(kb_root, *args)
            on_event({"type": "doc", "raw": raw_rel, "page": out.get("page"),
                      "action": out.get("action"), "reason": item.get("reason")})
            topics = [t for t in (data.get("related_topics") or []) if str(t).strip()]
            return {
                "queue": rest,
                "results": [{"raw": raw_rel, **out}],
                "hooks": [{"raw": raw_rel, "page": out.get("page"), "topics": topics}],
            }
        except Exception as err:  # noqa: BLE001 — per-doc fault isolation
            on_event({"type": "doc-error", "raw": raw_rel, "error": str(err)})
            return {"queue": rest, "doc_errors": [{"raw": raw_rel, "error": str(err)}]}

    def route_docs(state: GovernState):
        return "synthesize" if not state["queue"] else "process_doc"

    def synthesize_node(state: GovernState):
        # Cluster this run's related-topic hooks; a cluster becomes a synthesis
        # when ≥2 distinct raws share the topic, or a same-slug synthesis page
        # already exists (update path).
        clusters: dict[str, list[dict]] = {}
        for hook in state.get("hooks") or []:
            for topic in hook.get("topics") or []:
                slug = _slugify(str(topic))
                clusters.setdefault(slug, [])
                if all(h["raw"] != hook["raw"] for h in clusters[slug]):
                    clusters[slug].append(hook)

        picked, dropped = [], []
        for slug, hooks in sorted(clusters.items()):
            existing = kb_root / "wiki" / "syntheses" / f"{slug}.md"
            if len(hooks) >= MIN_CLUSTER_RAWS or existing.exists():
                picked.append((slug, hooks, existing))
            else:
                dropped.append(slug)
        if len(picked) > MAX_SYNTH_CLUSTERS:
            dropped += [s for s, _, _ in picked[MAX_SYNTH_CLUSTERS:]]
            picked = picked[:MAX_SYNTH_CLUSTERS]
        if dropped:
            on_event({"type": "synthesis-skipped", "slugs": dropped,
                      "reason": f"single-source hook or over the {MAX_SYNTH_CLUSTERS}-cluster cap"})

        out_synth, out_err = [], []
        for slug, hooks, existing in picked:
            try:
                raws = [h["raw"] for h in hooks]
                pages = []
                for h in hooks[:SYNTH_SOURCE_CAP]:
                    p = kb_root / (h.get("page") or "")
                    if h.get("page") and p.exists():
                        pages.append(f"## {h['page']}\n{_strip_frontmatter(p.read_text(encoding='utf-8'))[:SYNTH_PAGE_BUDGET]}")
                existing_body = _strip_frontmatter(existing.read_text(encoding="utf-8")) if existing.exists() else ""
                data = run_json_prompt(kb_root, "govern-synthesis", {
                    "slug": slug, "topic": slug.replace("-", " "),
                    "existing": existing_body, "sources": "\n\n---\n\n".join(pages),
                    "brief": brief,
                })["data"]
                body = (data.get("body") or "").strip()
                if not body:
                    raise RuntimeError("model returned empty synthesis body")

                candidate, note = _maybe_candidate(kb_root, slug, body, existing, existing_body)

                final_slug = _slugify(data.get("slug") or slug) or slug
                body_file = write_body_file(kb_root, f"synthesis-{final_slug}.md", body)
                args = ["apply-synthesis", "--slug", final_slug,
                        "--title", data.get("title") or slug.replace("-", " "),
                        "--sources", ",".join(raws), "--body-file", str(body_file),
                        "--actor", "agent", "--model-version", mv]
                if candidate:
                    args += ["--candidate", "--note", note or "semantic conflict with existing page"]
                out = run_govern(kb_root, *args)
                on_event({"type": "synthesis", "slug": final_slug, "page": out.get("page"),
                          "action": out.get("action"), "candidate": candidate})
                out_synth.append({"slug": final_slug, "candidate": candidate, **out})
            except Exception as err:  # noqa: BLE001 — per-cluster fault isolation
                on_event({"type": "synthesis-error", "slug": slug, "error": str(err)})
                out_err.append({"slug": slug, "error": str(err)})
        return {"syntheses": out_synth, "synth_errors": out_err}

    def rebuild_node(state: GovernState):
        out = run_govern(kb_root, "rebuild-index")
        on_event({"type": "phase", "phase": "rebuild-index", "result": out})
        return {}

    g = StateGraph(GovernState)
    g.add_node("sweep", sweep_node)
    g.add_node("plan", plan_node)
    g.add_node("process_doc", process_doc_node)
    g.add_node("synthesize", synthesize_node)
    g.add_node("rebuild", rebuild_node)
    g.add_edge(START, "sweep")
    g.add_edge("sweep", "plan")
    # empty queue → skip straight to synthesis (no hooks → no-op there)
    g.add_conditional_edges("plan", lambda s: "process_doc" if s["queue"] else "synthesize",
                            {"process_doc": "process_doc", "synthesize": "synthesize"})
    g.add_conditional_edges("process_doc", route_docs,
                            {"process_doc": "process_doc", "synthesize": "synthesize"})
    g.add_edge("synthesize", "rebuild")
    g.add_edge("rebuild", END)
    return g.compile(checkpointer=checkpointer)


def _maybe_candidate(kb_root: Path, slug: str, body: str, existing: Path, existing_body: str):
    """Update path safety: semantic-check the new body against the existing one;
    a factual conflict forces --candidate with the details in --note."""
    if not existing_body:
        return False, None
    try:
        data = run_json_prompt(kb_root, "semantic-check", {
            "proposed": body,
            "existing": f"## {existing}\n{existing_body}",
        })["data"]
    except Exception:  # noqa: BLE001 — check failure stays non-candidate; script rules still apply
        return False, None
    if data.get("conflict"):
        reason = (data.get("reasoning") or "semantic conflict with existing page")[:300]
        return True, reason
    return False, None

