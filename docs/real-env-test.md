# Real-Environment Acceptance Checklist

First run of the system against the **real intranet** Jira/Confluence (Server/DC). All 125
tests are green against mocks — this checklist covers what mocks cannot: real auth, real
certificates, real CQL/JQL behavior, and above all **real storage-XHTML fidelity** (the
declared main quality risk of M6, see DEVLOG M5 gap 2).

Use a **scratch KB** for this round (not the production one). The KB is a git repository —
raw/ will contain real intranet content, so check your org's policy before committing.

## 0. Prerequisites

```bash
# PATs live ONLY in env vars (kb.json stores the var NAMES, never values)
setx JIRA_PAT "<your-jira-pat>"          # new shell after setx
setx CONFLUENCE_PAT "<your-conf-pat>"

# If the wiki/jira host uses an internal CA (self-signed chain), Node's fetch will reject it:
setx NODE_EXTRA_CA_CERTS "C:\path\to\internal-ca.pem"
# NEVER use NODE_TLS_REJECT_UNAUTHORIZED=0 — that disables verification entirely.
```

`kb.json` in the scratch KB root (adjust base_url / scopes; start with ONE small space and
ONE small project):

```json
{
  "version": 1,
  "connectors": {
    "jira": {
      "base_url": "https://jira.<intranet>",
      "pat_env": "JIRA_PAT",
      "jql": ["project = <SMALLPROJ> ORDER BY updated DESC"]
    },
    "confluence": {
      "base_url": "https://wiki.<intranet>",
      "pat_env": "CONFLUENCE_PAT",
      "spaces": ["<SMALLSPACE>"]
    }
  }
}
```

## 1. Auth smoke (2 min)

```bash
node acquisition/scripts/acquire.mjs jira       --kb <scratch-kb> --check
node acquisition/scripts/acquire.mjs confluence --kb <scratch-kb> --check
```

- [ ] Both return the current-user JSON. If 401: PAT wrong/expired (Server/DC PATs expire).
      If CERT/SELF_SIGNED error: fix `NODE_EXTRA_CA_CERTS`, do not bypass TLS.

## 2. Failure drills (5 min) — verify loud failure, no secret leakage

- [ ] Wrong PAT (`set CONFLUENCE_PAT=wrong` in the current shell only): expect
      `confluence authentication failed HTTP 401` and the message must NOT contain the
      wrong PAT value. Same drill for Jira.
- [ ] Bad scope: `--cql "this is not cql"` → per-scope error in `errors[]`, exit code
      still 0, other scopes unaffected.
- [ ] Network down (disconnect / wrong base_url): expect a fetch error, not a hang
      (AbortSignal.timeout).

## 3. Small pull + eyeball (30–60 min, the core of this round)

```bash
node acquisition/scripts/acquire.mjs confluence --kb <scratch-kb> --max 20
node acquisition/scripts/acquire.mjs jira       --kb <scratch-kb> --max 20
```

- [ ] Summary counts sane; `truncated[]` non-empty is EXPECTED with `--max 20` — confirm it
      reports `{cql, fetched, total}` (no silent caps).
- [ ] Spot-check 3–5 raw files: identity five-tuple (source, source_id quoted, source_url
      clickable, source_version `...Z`, connector id), `extra` fields, log.md lines.
- [ ] **XHTML fidelity audit** (M6's declared risk): open each pulled page side-by-side in
      the Confluence web UI and compare against `raw/confluence/<id>.md`:
  - [ ] headings / lists / tables / code macros render correctly;
  - [ ] `grep -r "\[macro:" raw/confluence/` — collect every unknown-macro placeholder.
        This list is the input for the "XHTML fidelity upgrade" decision (DEVLOG TODO);
  - [ ] `grep -r "\[attachment:" raw/confluence/` — attachments are placeholders by
        design; confirm that's acceptable for your corpus;
  - [ ] fenced code blocks: blank lines and indentation inside code must be preserved
        verbatim (evidence layer).
- [ ] Verify the source language is preserved in raw/ (no translation happens here).

## 4. Incremental behavior (10 min)

- [ ] Re-run the same pull → everything `unchanged`, no writes.
- [ ] Edit one Confluence page in the web UI (body text) → re-run → that page `updated`.
- [ ] Edit the same page twice **on the same day** → second pull still catches it
      (version.number + full-precision timestamp are inside the hashed body).
- [ ] Upload an attachment WITHOUT editing the page → re-run → page stays `unchanged`.
      This is the recorded by-design blind spot; confirm you can live with it.

## 5. Full-scope pull

- [ ] Widen to the real spaces/JQL in kb.json, no `--max`. Check `total` vs the space's
      page count (Confluence UI: Space tools → Content), and `truncated` is empty.
- [ ] Any `errors[]` entries: bad ids, per-scope failures — each must name its scope.

## 6. Governance + retrieval on the real corpus

```bash
node governance/scripts/govern.mjs plan          --kb <scratch-kb>
# ... apply-source / apply-topic flow per governance skill ...
node governance/scripts/govern.mjs rebuild-index --kb <scratch-kb>
node retrieval/scripts/search.mjs --kb <scratch-kb> "a real query term"
```

- [ ] plan lists look sane on real data (pending / anomalies / orphaned_pages / errors).
- [ ] Search finds known content; try a stemmed English term, a phrase, and
      `after:`/`before:` date filters. If the corpus has CJK short terms, check the
      trigram/LIKE fallback actually returns them.
- [ ] Viewer round-trip: `node governance/viewer/serve.mjs --kb <scratch-kb>`, flip one
      candidate in the browser, close viewer, run `govern` — sweep must backfill the flip
      into log.md exactly once.

## 7. Report back

Collect and bring back:

1. The `[macro: ...]` histogram from step 3 (decides XHTML fidelity upgrade).
2. Any page where the markdown is **wrong** (not just degraded) — keep the source XHTML
   (Confluence UI → page → `···` → View storage format) as a fixture.
3. Auth/cert/scope surprises from steps 1–2.
4. Timing for the full-scope pull (drives the ensureFresh full-rehash concern in DEVLOG
   TODO if the KB is large).

Exit criterion: no **wrong** conversions (degraded-with-placeholder is acceptable, silent
corruption is not), incremental skip works on the real servers, and the governance →
retrieval loop closes on real data.
