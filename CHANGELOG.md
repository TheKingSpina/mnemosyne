# Changelog

## [Unreleased]

### Added

- Exploration tools for the profiles that were blind to the shape of the corpus: `memory_list_projects` (the directory of every project with its size), `memory_get_project` (areas, breakdown by kind, lifecycle and scope, the most recent memories, the open conflicts, the project relations), `memory_list_project_memories` (the memories of one project, filtered and paginated) and `memory_get_memory` (one memory with its arcs and conflicts). The same surface is exposed over REST as `GET /v1/projects`, `GET /v1/projects/{id}` and `GET /v1/projects/{id}/memories`, plus the CLI commands `projects`, `project` and `project-memories`.
- A harness reads the corpus through a session, exactly as search already did: the exploration tools require `sessionId` in that profile and answer only with the accepted memories its scopes reach, while the owner reads the corpus as it is. The counts in a project summary are corpus-level aggregates and carry no content, so both profiles read the same numbers and never disagree about the size of a project.
- Graph model: projects and areas are first-class entities with real foreign keys. `memories.project_id` is immutable identity, `memory_revisions.area_id` references a declared area of the same project through a trigger, and scope is derived at read time instead of stored. The scope enum is `session | project | area`: `global` is retired in favour of the reserved `personal` project, which stays readable and writable from every session as attached policy rather than as a fourth scope kind.
- Weighted arcs between nodes: `memory_arcs` may cross projects and `project_arcs` link projects, both governed like memories through proposal and owner review, with only accepted arcs reaching the graph. Cycles are legitimate except for relation types declared hierarchical in `hierarchical_relation`, which a trigger keeps acyclic. Corpus export and restore carry both arc tables and the area rows; a restore skips an arc whose endpoint was forgotten rather than failing.
- Neo4j projection draws the roots: every governed project and declared area becomes a node, each memory links to its project with `IN_PROJECT`, area-scoped memories additionally link with `IN_AREA`, and the generic scope nodes are gone. The owner graph view draws accepted memory arcs with the weight in the line width and pending arcs dashed, names type, weight and review state in the inspector, and counts project arcs in the summary.

- Browser-based MCP clients could not connect over Streamable HTTP: the endpoint answered `404` to every preflight, because the path and the method allow-list were checked together and `OPTIONS` was not in the list. Preflight `OPTIONS` is now served for the exact origins in `MCP_ALLOWED_ORIGINS` and refused with `403` for anything else, reusing the same allow-list that DNS-rebinding protection uses, so the rule stays "no wildcards, exact scheme, host and port". An allowed origin also receives `Access-Control-Allow-Origin` on the real request plus `Access-Control-Expose-Headers` for `Mcp-Session-Id`, `Mcp-Protocol-Version` and `WWW-Authenticate`, without which the browser hides the session id from the client even when the request succeeds, and `Access-Control-Request-Private-Network` is answered for clients on the tailnet. A request to any other path is now a `404` before the method check.

- Per-client credentials: `POST`, `GET /v1/admin/client-tokens` and `POST /v1/admin/client-tokens/{name}/revoke`, plus `npm run token:client` to mint, list and revoke them from the client machine. Only a SHA-256 hash and a displayable prefix are stored, the plaintext is returned exactly once, and every token has the `owner` role.
- Host keep-alive for the Mac mini: launchd agents that start the container runtime at login, reconcile the Compose project, probe the API and the dashboard every 5 minutes and repair after consecutive failures, plus a scheduled encrypted PostgreSQL backup with verified restore.
- Optional anonymous access for MCP HTTP with `MNEMOSYNE_MCP_REQUIRE_TOKEN=false`, scoped by `MNEMOSYNE_MCP_ANONYMOUS_PROFILE` so a caller without credentials can be given the harness profile while the owner-only tools stay unregistered.
- The Redis corpus cache moved from `apps/api` to `packages/redis`, mirroring `packages/postgres`, and MCP now owns a cache too. Harnesses re-read the same scopes within a task, and the repeated reads were not being cached: 25 MCP searches, 15 of them byte-identical repeats, wrote no Redis keys at all, while one API search wrote one. Both processes resolve the cache through the same `connectCorpusCache`, which degrades to no cache on an unset or unreachable `REDIS_URL` instead of failing startup.
- Deterministic semantic pruning, phase (a): every accepted memory and accepted arc is scored from existing signals only (recency, incident arc weight, kind — access tracking is deliberately not a signal). Proposals are registered in `pruning_proposals`, kept out of the canonical export, and the balanced retention run decides each one on a fresh re-read: anything that moved since it was written goes `stale`, concordant memories decay to the existing `expired` lifecycle instead of direct deletion, weak accepted non-hierarchical arcs are removed, exempt kinds and hierarchical relations are never auto-pruned, and every execution lands in the `pruning_ledger`. Score doubles as the confidence recorded in the ledger.
- Manual privacy marking for pruning analysis: `projects.privacy` and an optional per-node `memories.privacy` override carry three states (`local_only` default, `anonymized`, `public`), moved only by owner action (`POST /v1/admin/projects/{id}/privacy`, CLI `project-privacy`) and never inferred. Export and restore carry both fields. The analysis pipeline is inert by design until something is explicitly marked.
- Stage-1 pruning analyzer entry point: an OpenAI-compatible client (remote BYOK or a local provider) receives same-flag batches composed by the shared service — `local_only` is dropped before any network call, `anonymized` nodes carry kind, scope kind, age bucket and incident arc types but never raw content, and batches never mix flags. Proposals are written as `proposer='llm'` rows with `model_version` plus a SHA-256 `prompt_hash`, hallucinated memory ids are filtered before the table, and the retention run decides them with the deterministic veto: score-concordant decay and edge proposals execute, exact-confirmed contradictions become conflicts, everything else is rejected with a reason. Both API and worker answer `disabled` without an analyzer, and enablement with the flag on but no credentials fails startup.
- Night windows and resume for the analysis: `WORKER_ANALYZER_WINDOW=HH:MM-HH:MM` in container local time gates when the worker ever asks the model, parked at the next window opening instead of arriving an interval late. Batch identity derives from the exact sorted members, so an interrupted run resumes instead of repeating: already-analyzed batches are never sent again (even after their proposals were decided, because the ask is already registered), memories with a pending proposal of any proposer stay out of the batches, and the run reports `skipped.batches`/`skipped.proposals`. `scripts/probe-analyzer.mjs` measures the proposer's output quality against generated same-flag Italian probes with zero writes before anyone enables it in earnest.

### Changed

- The project directory is cached in Redis, but only the part the corpus revision covers: memory counts, open conflicts, arcs and the latest memory. The project rows, the area count and the session count are read fresh on every call, because creating a project, an area or a session does not bump the corpus revision, and a directory cached under the revision alone would hide a project that was just created.
- The corpus part of a project is computed in SQL (`GROUP BY` over `memories`, `unnest` over the conflict and arc endpoints) instead of hydrating every memory with its current revision in JavaScript and counting rows in memory. The per-project read paths ask the database for one project rather than the whole corpus: the breakdown is a `GROUP BY`, the recent sample is a `LIMIT`, and the memory list filters and pages in SQL. Measured at 10,000 memories in a single project, the directory goes from 39.7 ms to 1.8 ms without a cache and 0.3 ms with one, the outline from 49.3 ms to 4.9 ms and the first page of the memory list from 45.5 ms to 3.0 ms. Three indexes back the new reads: `idx_memories_project_lifecycle`, `idx_memories_project_updated` and `idx_sessions_project`.
- `GET /v1/admin/projects` answers with the same project summaries as the new exploration route, so the response finally matches its own OpenAPI schema: the privacy flag and the counts are part of the payload, and the dashboard keeps working because it only reads `id` and `name`.
- A memory view carries its `projectId`: the root project a memory belongs to is identity, and a reader that sees a memory can always say where it lives.
- Credential writes are excluded from the idempotent replay path: the mint response carries a token in plaintext and must not be persisted, and reissuing a live client name returns `409` instead of silently rotating a credential in use.
- A presented `Authorization` header is always verified, including on an anonymous endpoint: a valid per-client token escalates to its profile and an invalid or revoked one gets `401` instead of a silent downgrade.
- `AccessPolicy.authenticate` may return a promise, which is what lets a deployment resolve per-client tokens from PostgreSQL.
- The runbook and README refer to the dashboard port as `WEB_PORT` (8080 by default) because the deployment moved to 18080; the documentation no longer contradicts the running configuration.
- The opencode MCP configuration moved to `~/.config/opencode/opencode.jsonc`; the repository root `opencode.json` is ignored because it carried a per-machine endpoint and home path.

### Fixed

- Search and context results now use deterministic hybrid ranking with token-aware lexical matching, BM25/IDF, phrase and proximity bonuses, local semantic fusion, thresholds and stable tie-breaking.
- PostgreSQL search uses the existing full-text index with bounded scope-aware candidate retrieval; the in-memory backend keeps the same ranking contract.
- Retrieval evaluation now uses graded, order-sensitive cases and fails under the legacy ordering baseline.
- The scheduled PostgreSQL backup could never succeed against a real deployment: the backup command runs `docker compose` with `--env-file /dev/null`, and compose interpolates every service, so the run failed on an unrelated service. `run-backup.sh` now sources the deployment environment and drops the provider key.
- The host keep-alive scripts no longer block on a wedged container runtime: every docker call is bounded with a timeout, the daemon is probed with `docker version` instead of trusting the socket file, and the runtime is recycled at most once per run.
- The runbook named a `neo4j` Compose service that stopped existing when the graph engine moved to Memgraph, so the documented commands failed with "no such service" and the resource notes still budgeted a JVM. The runbook, the architecture overview and the handoff now name `memgraph`, describe the Bolt-only loopback binding, and carry the real footprint. The env names (`NEO4J_URI`, `NEO4J_USERNAME`), the `neo4j-driver` and the capability key `projections.neo4j` keep their names on purpose: they are the wire names of the protocol, not of the engine.
- The handoff pointed at `~/Mnemosyne` on the mini, but the running stack comes from `/Users/spina/mnemosyne-experiment` (Compose project `mnemosyne-experiment`); `~/Mnemosyne` was a stale checkout 59 commits behind. The handoff now says where the deployment really is and how to read it from the running containers.

### Changed

- The dashboard graph uses a lightweight native canvas renderer with separated clusters, stable hover behavior, no hover tooltip and persistent clicked-node highlighting.
- MCP uses the local deterministic embedding provider and PostgreSQL semantic index by default; OpenRouter remains disabled.

## [0.1.0] - 2026-09-25

### Added

- Binding del profilo autenticato alle sessioni MCP Streamable HTTP.
- Backup PostgreSQL con verifica dell’archivio, confronto dei conteggi del restore, manifest SHA-256 e retention controllata.
- Cifratura autenticata opzionale dei backup con AES-256-GCM e chiave derivata tramite scrypt.
- Restore PostgreSQL in un database target esplicito, con checksum, manifest e conferma obbligatoria.
- Audit locale delle licenze npm e gate CI per secret scan, licenze, immagini Docker, E2E e release taggata.
- Documentazione operativa per threat model, privacy, rilascio, migrazioni e disaster recovery.
- Benchmark offline di retrieval con precision, recall, nDCG, budget e latenza.
- SBOM CycloneDX e attestazioni provenance/SBOM nel flusso di release.
- Scan locale dei secret in aggiunta al gate Gitleaks della CI.
- Dashboard con grafo memoria/ambiti/conflitti e layout ispirato al pannello PMB.

### Changed

- Il dump viene verificato prima della pubblicazione definitiva.
- I file temporanei e i manifest sono protetti da permessi restrictivi e cleanup.
- La CI esegue anche il controllo delle licenze e lo scenario E2E sintetico.

### Fixed

- Il forget elimina anche i conflitti che referenziano la memoria dimenticata.
- Il lock PostgreSQL per i conflitti non usa più una stringa contenente il carattere NUL.

### Security

- Le sessioni MCP HTTP non possono essere riutilizzate con un token appartenente a un ruolo diverso.
- I backup cifrati non richiedono passphrase sulla command line e vengono verificati prima della pubblicazione.

## Release notes

La versione `0.1.0` è il primo rilascio candidato. Il tag firmato `v0.1.0` viene creato solo dopo il verde della CI e la verifica manuale della firma.
