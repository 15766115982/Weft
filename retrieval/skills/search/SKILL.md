---
name: kb-search
description: Retrieval service — searches knowledge in the governed wiki/. Use when the user asks knowledge-base questions ("look up/search/how is XXX designed/is there any documentation about XXX"). Use kb-acquire for acquisition and kb-govern for governance.
---

# kb-search · Retrieval

Searches within `wiki/` (approved pages only). **You (Claude) own precision; the script owns
recall** — the script returns a candidate space; reranking, rewriting, and full-text reading
are your job (ADR-0003).

Script: `kb_search.mjs`, located in the `scripts/` directory **two levels up from the
directory containing this SKILL.md** (`<skill-dir>/../../scripts/kb_search.mjs`). When
invoking it in any session, first assemble the absolute path from this file's actual install
location — **do not assume cwd is some code repository**.
KB location: `--kb` > `KB_PATH`.

## The retrieval loop (precision is your responsibility)

1. **For broad questions, read `wiki/index.md` first** (Tier 0 navigation): one line per page
   with a one-sentence summary; it often locates 3-5 candidate pages directly — just Read
   their full text and answer, no script call needed.
2. **For specific questions, construct a structured query and call kb_search**:
   ```bash
   node <skill-dir>/../../scripts/kb_search.mjs search "timeout retries type:source" --kb <kb>
   ```
   - Bare terms are AND semantics; `"phrases"` match exactly; field filters `type:` `source:`
     `tag:`; date filters `after:2026-07-01` / `before:2026-07-15` (**filter by "the
     document's own update time"**: source pages take the source-system time `source_version`
     (when in ISO format); everything else falls back to governance time `updated_at`; after
     includes the day itself);
   - Note: `source:` only matches source pages (1:1 lineage); topic pages' `sources:` lists
     do not participate in that filter;
   - **The KB's primary language is English** (governance.md §1): construct queries with
     English terms first; the porter stemmer automatically merges singular/plural and tenses
     (retry↔retries);
   - You construct the query: break the user's colloquial question into proper
     nouns/terms/ticket numbers (keep the original wording — do not translate into synonyms
     you assume are right); source-language terms (e.g. Chinese) are a CSQE fallback, not for
     the first round.
3. **CSQE iteration (HyDE forbidden)**: when the first round's hits are unsatisfying,
   **extract key terms from the hit snippets** and splice them into the query to re-query;
   never fabricate a "hypothetical answer" to search with (with no corpus prior, HyDE
   actually hurts — see the evidence in ADR-0003).
4. **Read full text**: for hit pages, use `read <page>#<anchor>` to fetch the complete section
   before answering (the returned content **includes all subsections beneath it**, truncated
   at a same-or-higher-level heading; read and search share the same gate: only approved pages
   are served — candidate/archived pages are refused); when you need source-level detail,
   follow the source page's frontmatter `source_ref` to read the raw original.
5. **Multi-hop**: pages marked `via: "link"` among the candidates are graph-expansion
   neighbors; for complex questions keep walking the wikilinks (search --within on a neighbor
   page, or Read it directly).

## Interpreting the output

- `preview`: top-10 (page + anchor + ~200-char snippet + score), ≤2 snippets per page;
  **score is a heuristic ranking signal with mixed units** (BM25/LIKE counts/graph expansion
  interleaved) — use it only for relative ordering, never interpret absolute values;
- `candidates_file`: the disk path of the full top-K; when the preview is not enough, Read it
  and keep digging;
- `routed`: which leg your query terms were routed to (latin/cjk/like); all empty means the
  query had only field filters;
- When hits are empty: switch synonyms / drop field filters / shorten the query — try once
  more before reporting "not found".

## Red lines

1. Retrieval results may only come from approved pages — **do not** read raw/ as retrieval
   corpus just to "find more" (raw is unadjudicated evidence; tracing provenance along
   source_ref is allowed — that's a different thing);
2. Answers must carry citations (wikilink or source_url);
3. If it isn't found, say so honestly, and suggest the user run governance (kb-govern) first.
