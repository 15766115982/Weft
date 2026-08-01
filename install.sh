#!/usr/bin/env bash
# One-click install: Node dependency + link the three skills into Claude Code.
# Manual equivalent and troubleshooting: docs/installation.md (sections 3-4).
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

command -v node >/dev/null || { echo "[ERROR] Node.js not found. Install Node.js >= 20: https://nodejs.org"; exit 1; }
node -e "if (Number(process.versions.node.split('.')[0]) < 20) { console.error('[ERROR] Node.js >= 20 required, found ' + process.version); process.exit(1) }"

echo "[1/2] Installing retrieval dependency (better-sqlite3, prebuilt)..."
npm --prefix "$REPO/retrieval/scripts" install

echo "[2/2] Linking skills into ~/.claude/skills ..."
mkdir -p "$HOME/.claude/skills"
link() {
  local name="$1" target="$2" dest="$HOME/.claude/skills/$1"
  if [ -e "$dest" ]; then
    echo "  skip $name (already exists)"
  else
    ln -s "$target" "$dest" && echo "  linked $name"
  fi
}
link kb-acquire "$REPO/acquisition/skills/acquire"
link kb-govern  "$REPO/governance/skills/govern"
link kb-search  "$REPO/retrieval/skills/search"

echo
echo "Done. Restart Claude Code, then verify kb-acquire / kb-govern / kb-search appear."
echo "Next: docs/installation.md section 5 (create a knowledge base) and 6 (PAT / kb.json)."
