---
name: kb-acquire
description: Acquisition service — pulls/normalizes documents from each source into the knowledge base raw/ zone. Use when the user asks to "pull/acquire/import documents into the knowledge base", "sync Jira/Confluence documents", or "bring local files into the KB".
---

# kb-acquire · Acquisition

Acquires documents from each data source into the knowledge base's `raw/` zone. This skill
only acquires — it does not govern (use kb-govern for that) and does not search (use
kb-search).

Contract: `schema/contract.md` (raw/ spec, identity quintuple, log.md format).

## Locating the knowledge base

KB root resolution order: `--kb <path>` argument > `KB_PATH` environment variable.
If neither is set, ask the user first — do not guess.

## Usage

Script: `acquire.mjs`, located in the `scripts/` directory **two levels up from the directory
containing this SKILL.md** (`<skill-dir>/../../scripts/acquire.mjs`). When invoking it in any
session, first assemble the absolute path from this file's actual install location — **do not
assume cwd is some code repository**.

```bash
# Local-file fallback connector: scan inbox → raw/local/
node <skill-dir>/../../scripts/acquire.mjs local --kb <kb-root>
# Custom inbox location (overrides kb.json's connectors.local.inbox)
node <skill-dir>/../../scripts/acquire.mjs local --kb <kb-root> --inbox <dir>
# Clean up orphan documents (raw files whose inbox source has disappeared) — reports only by default; --prune actually deletes
node <skill-dir>/../../scripts/acquire.mjs local --kb <kb-root> --prune

# Jira connector (Server/DC, PAT auth): pull the JQL scopes configured in kb.json
node <skill-dir>/../../scripts/acquire.mjs jira --kb <kb-root>
# One-off scope override (does not edit kb.json) / result cap / PAT sanity check
node <skill-dir>/../../scripts/acquire.mjs jira --kb <kb-root> --jql "project = PROJ ORDER BY updated DESC" --max 100
node <skill-dir>/../../scripts/acquire.mjs jira --kb <kb-root> --check
```

Jira setup (contract §6): `kb.json` holds only non-sensitive config —

```json
{ "connectors": { "jira": {
  "base_url": "https://jira.example.com",
  "pat_env": "JIRA_PAT",
  "jql": ["project = PROJ ORDER BY updated DESC"]
} } }
```

The PAT itself lives **only** in the environment variable named by `pat_env` (default
`JIRA_PAT`) — never in kb.json (the KB is a Git repository; checked-in secrets would enter
history). Ask the user to set it in their shell before the first pull. Issues land in
`raw/jira/<ISSUE-KEY>.md`; re-pulling skips unchanged documents by content_hash.

Intranet deployment note: Node's fetch rejects self-signed certificates. If the Jira host
uses an internal CA, set `NODE_EXTRA_CA_CERTS=<path-to-ca.pem>` in the environment before
running — do NOT work around it with `NODE_TLS_REJECT_UNAUTHORIZED=0` (that disables
certificate verification entirely).

The confluence connector is not yet implemented (milestone M6); invoking it returns a clear
not-implemented error.

## Interpreting the output

stdout is JSON:

```json
{
  "connector": "local",
  "kb": "D:\\kb\\work",
  "created":   ["raw/local/8b9bede6-session-timeout.md"],
  "updated":   [],
  "unchanged": ["raw/local/1a2b3c4d-old-document.md"],
  "unsupported": ["manual.docx"],
  "errors":    []
}
```

- `created`/`updated` are already written to log.md (`acquire` actor); `unchanged` is an
  incremental skip (content_hash unchanged) — normal, not a failure;
- `orphaned`: raw documents whose inbox source has disappeared (deleted/renamed/moved).
  **Reported only, not deleted**; after confirmation, rerun with `--prune` to clean up
  (pruned entries are recorded in the log). In rename/move scenarios the new document is
  already on disk and the old one lands in orphaned — after --prune the "rename" is complete;
- `unsupported`: no converter for that extension yet (currently only md/markdown/txt).
  Explain to the user: when docx/pdf is needed, convert to markdown manually first and drop it
  into the inbox;
- the jira summary has the same `created`/`updated`/`unchanged`/`errors` lists plus `total`
  (unique issues matched across the JQL scopes, before per-issue write errors) and
  `truncated` — a scope appears there when the server reported more hits than were fetched
  (`--max` cap); **always surface truncation to the user**, a capped pull is not full
  coverage. A failed scope (bad JQL, transient 500) lands in `errors` with its `jql` and
  the remaining scopes still run; an auth failure (401/403) aborts the whole run loudly;
- When `errors` is non-empty you must report it to the user — never swallow it silently.

## Behavioral rules

1. After a run, report the four counts to the user; don't just paste the JSON;
2. **raw/ keeps the source language; the acquisition service does not translate** (the KB's
   primary language is English, but translation is the governance layer's job when writing
   summaries; raw is the evidence layer and must be preserved as-is — see governance.md §1);
3. After acquisition completes, suggest the user may run governance (kb-govern) — **do not**
   trigger governance automatically; governance is a human-triggered batch operation;
4. This service never writes `wiki/` and never modifies any file inside `wiki/`;
5. Re-pulling the same document overwrites the old raw/ file (contract: raw keeps only the
   latest version) — this is not an error.
