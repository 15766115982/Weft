#!/usr/bin/env bash
# One-click install: retrieval Node dependency + agent/ Python environment.
# (ADR-0012: the three Claude Code skills were retired with the claude CLI
# dependency; services are driven by the UI portal or directly via CLI.)
# Manual equivalent and troubleshooting: docs/installation.md (sections 3-4).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v node >/dev/null || { echo "[ERROR] Node.js not found. Install Node.js >= 20: https://nodejs.org"; exit 1; }
node -e "if (Number(process.versions.node.split('.')[0]) < 20) { console.error('[ERROR] Node.js >= 20 required, found ' + process.version); process.exit(1) }"
command -v python3 >/dev/null || { echo "[ERROR] Python not found. Install Python >= 3.11."; exit 1; }

echo "[1/2] Installing retrieval dependency (better-sqlite3, prebuilt)..."
npm --prefix "$REPO/retrieval/scripts" install

echo "[2/2] Setting up the agent service Python environment (agent/.venv)..."
python3 -m venv "$REPO/agent/.venv"
"$REPO/agent/.venv/bin/python" -m pip install -e "$REPO/agent"

echo
echo "Done. Next: docs/installation.md section 5 (create a knowledge base) and 6 (models.json / PAT)."
echo "Launch the portal: node ui/serve.mjs --kb <kb-root>"
