"""CLI entry (port of llm/llm.mjs). Usage:
  python -m weft_agent <task> --kb <path> [--input-file <json>] [--output-file <path>]
KB location: --kb > KB_PATH env var. stdout prints a JSON summary; streaming tasks
(chat, deep-research) write NDJSON lines to --output-file.
Usage errors exit 64; task failures print a JSON error to stderr and exit 1.
"""
import importlib
import json
import sys
from pathlib import Path

from .config import resolve_kb_root

TASKS = [
    "check",
    "init-prompts",
    "init-config",
    "summarize-source",
    "classify-page",
    "extract-entity",
    "draft-concept",
    "synthesize",
    "govern-decide",
    "semantic-check",
    "chat",
    "deep-research",
    "complete",
    "govern-run",
    "search-smart",
    "prompt",
    "distill-chat",
]

STREAMING_TASKS = {"chat", "deep-research", "govern-run"}


def parse_args(argv: list[str]) -> dict:
    args: dict = {"_": []}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--"):
            key = a[2:]
            if i + 1 >= len(argv) or argv[i + 1].startswith("--"):
                args[key] = True
            else:
                args[key] = argv[i + 1]
                i += 1
        else:
            args["_"].append(a)
        i += 1
    return args


def usage() -> None:
    print("usage: python -m weft_agent <task> --kb <path> [options]", file=sys.stderr)
    print("tasks: " + ", ".join(TASKS), file=sys.stderr)
    print("options:", file=sys.stderr)
    print("  --input-file <json>    task input payload", file=sys.stderr)
    print("  --output-file <path>   task output (required for streaming tasks)", file=sys.stderr)
    print("  --kb <path>            KB root (or KB_PATH env var)", file=sys.stderr)
    sys.exit(64)


def main() -> None:
    args = parse_args(sys.argv[1:])
    task = args["_"][0] if args["_"] else None

    if not task or task not in TASKS:
        usage()

    try:
        kb_root = resolve_kb_root(args.get("kb") if isinstance(args.get("kb"), str) else None)
    except ValueError as err:
        print(json.dumps({"error": str(err)}), file=sys.stderr)
        sys.exit(64)

    input_path = args.get("input-file")
    output_path = args.get("output-file")
    input_payload = json.loads(Path(input_path).read_text(encoding="utf-8")) if isinstance(input_path, str) else {}

    if task in STREAMING_TASKS and not isinstance(output_path, str):
        print(json.dumps({"error": f"task {task} requires --output-file for NDJSON stream"}), file=sys.stderr)
        sys.exit(64)

    module = importlib.import_module(f".tasks.{task.replace('-', '_')}", package=__package__)
    try:
        result = module.run(kb_root=kb_root, input=input_payload,
                            output_path=output_path if isinstance(output_path, str) else None)
    except Exception as err:  # noqa: BLE001 — CLI boundary: report, don't traceback
        print(json.dumps({"error": str(err)}), file=sys.stderr)
        sys.exit(1)

    if task in STREAMING_TASKS:
        print(json.dumps({"task": task, "kb": str(kb_root), "output": output_path, **result},
                         ensure_ascii=False, indent=2))
    else:
        if isinstance(output_path, str):
            p = Path(output_path)
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
        print(json.dumps({"task": task, "kb": str(kb_root), "output": output_path if isinstance(output_path, str) else None, **result},
                         ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
