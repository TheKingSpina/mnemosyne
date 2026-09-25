# Retrieval ranking

Mnemosyne orders search and context results with a deterministic hybrid ranker. PostgreSQL remains authoritative; the ranking layer is derived and can be rebuilt.

## Ranking pipeline

1. The session scope is resolved first.
2. The corpus revision is read before the cache lookup.
3. On a cache miss, PostgreSQL uses the existing GIN index on `to_tsvector('simple', content)` with `websearch_to_tsquery`, `ts_rank_cd`, scope predicates and a bounded candidate limit.
4. The in-memory repository keeps the same ranking contract for tests and offline evaluation.
5. Query tokens are normalized with Unicode tokenization, light Italian/English stemming, stopword removal and lower weights for generic terms.
6. Candidates receive a corpus-aware BM25/IDF score, phrase and proximity bonuses, and a small local semantic boost. Deterministic tie-breaking uses `memoryId`.
7. Scores below the minimum threshold are discarded. A query without a meaningful match returns zero results instead of a padded list.
8. Results are sliced by `offset`/`limit` only after ranking.

The semantic index uses the local deterministic provider. A semantic-only candidate requires a high similarity threshold; weaker semantic scores can still refine candidates that already have a lexical match. Index failures degrade to lexical ranking and emit a sanitized diagnostic.

## Cache behavior

Search cache entries are validated against the current corpus revision and revalidated by memory ID. A cache hit therefore avoids the full-corpus scan and cannot return forgotten or non-accepted memories.

## Evaluation

```bash
npm run eval:retrieval
npm run eval:all
```

The retrieval dataset uses graded relevance, distractor memories, multi-relevant queries, stopword-only queries and no-match queries. The runner reports search and context nDCG, pending-context leaks, budget compliance and latency percentiles. Evaluation output contains fixture keys and metrics, not fixture text.

To verify that the gate can detect a broken ordering:

```bash
node scripts/eval-retrieval.mjs --legacy-order
```

The legacy mode intentionally fails the scored gate when the dataset has an order-sensitive case. It must never be used as a production retrieval mode.

## Operational limits

- The PostgreSQL candidate pool is bounded to protect an 8 GB Mac mini; very broad queries may require a narrower scope or more distinctive terms.
- The deterministic embedding provider is a local lexical-semantic baseline, not a hosted model. No OpenRouter provider is enabled.
- `restoreCorpus` does not rebuild derived embeddings. After a restore, verify the semantic projection separately and run an explicit reindex procedure; this ranking change does not add a migration.
- The dashboard graph and Neo4j projection are independent of search ranking and are not rebuilt by this fix.
