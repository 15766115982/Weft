# Retrieval as Interface Design: Scripts Own Recall and Bounding, Claude Owns Precision, Vectors Off by Default

The retrieval service does not offer LLM consumers the traditional RAG interface where "top-k
snippets decide life and death"; instead it returns a **bounded, repeatedly traversable
candidate space** (top-10 preview + full top-K persisted to disk + `--within` iterative
digging + `read #anchor` for whole sections); reranking, query rewriting, and full-text
reading are carried out by the Claude session. The vector leg is off by default (configurable
to an OpenAI-compatible endpoint or local GGUF); the baseline is dual FTS5 tables
(unicode61/trigram routed by CJK) + structured field queries. Query expansion allows only CSQE
(extract terms from hit snippets, rewrite, re-query); **HyDE is forbidden**.

**Context and evidence** (deep research 2026-07, 25 sources, 21 adversarial verifications
passed):
- For agent consumers, retrieval is an interface design problem, not a retriever design
  problem; direct corpus interaction beats vector retrieval (DCI: NDCG@10 +21.5; same model
  69%→80% with cost -29%, arxiv 2605.05242), but unbounded exploration does not scale and
  needs BM25 bounding (RISE, arxiv 2606.06880);
- Pure lexical + LLM-constructed structured queries can tie hybrid retrieval (KILT 0.717 vs
  0.716, arxiv 2605.27123);
- With no corpus prior, CSQE significantly outperforms HyDE (EACL 2024, mAP 30.1→47.2);
- FTS5 unicode61 fails on Chinese; trigram is structurally correct for mixed Chinese-English
  technical text (Hermes/zenn practice); FTS5 treats hyphens as NOT — queries must be
  sanitized;
- The intranet may have no embedding service; local vectors for CJK corpora require
  Qwen3-Embedding-0.6B (embeddinggemma has poor CJK coverage, per qmd docs).

**Considered Options**: vector-first traditional RAG (low payoff when the consumer is a strong
LLM; heavy intranet dependencies); offline GraphRAG graph-building pipeline (advantageous only
for complex multi-hop; wiki backlinks + index.md are already a free explicit structure that
agentic iterative retrieval can approximate).

**Consequences**: retrieval is fully usable without embeddings; scripts stay small and
deterministic; precision logic (CSQE loop, multi-hop) settles into the retrieval skill's
prompt rather than into code.
