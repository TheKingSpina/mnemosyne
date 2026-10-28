# Mnemosyne Mac Mini Agent Instructions

## Mission

Operate Mnemosyne on an Apple M1 Mac mini with 8 GB RAM using Docker Compose and private Tailscale access. The detailed runbook is [`docs/macos-mini-tailscale.md`](docs/macos-mini-tailscale.md).

## Current handoff — 2026-10-28 (revises the 2026-10-26 handoff)

### Repository and Git

- `main` tracks `origin/main`; the per-client token work (`9567535`, `310dca3`) and the credential-path fix are merged.
- Retrieval commits: `8b5becc` (hybrid ranking), `7de9187` (dashboard/MCP wiring), `29c3ef9` (reviewed relevance judgments), `609e63e` (handoff documentation).
- 2026-09-27 operational commits: `10a128d` (scheduled backup reads the deployment env), `b866f47` (host keep-alive agents and persistence docs), `7d68519` (bounded docker calls, runtime recycle), `ed7274a` (anonymous MCP opt-out), `7552d00` (anonymous callers scoped to harness), `597c671` (opencode config lives in the user profile).
- 2026-10-15/16 graph-model v2 landed on `main` and is pushed to `origin/main`: `fe27cce` (projects/areas first-class), `939e10f` (a memory belongs to a project permanently, `memories.project_id` NOT NULL), `2428ffd` (sessions scope to declared areas only), `de31e63` (memory scope references real rows), `0434e88` (weighted arcs, owner-reviewed), `ead27be` (`global` scope retired in favour of the `personal` project), `4056448`/`7485661` (project/area roots in the Neo4j projection), `5afc21b`/`8561371` (export/restore go along), `a5d357c` (MCP serves browser CORS preflights). Design and handoff: [`docs/v2-graph-model-plan.md`](docs/v2-graph-model-plan.md), [`docs/v2-handoff.md`](docs/v2-handoff.md).
- 2026-10-16/17 semantic pruning landed on `main`: `69a3f3d` (deterministic pruning score from existing signals), `8a5f398` (pruning proposals, ledger, arc deletion in both backends), `09fe8e9` (pruning job inside the retention run), `d980c13` (manual privacy marking), `dc7cce0` (retention prunes terminal jobs and expired idempotency keys), `03144b1`/`94a7a8b` (Gemma analyzer with deterministic veto, same-flag batch composer), `ad583f1` (night window, resume-by-batch, proposer probing), `bcda2bf`/`a8709a9`/`9634ecc` (calibrated LlamaCppPruningJudge, deterministic score fusion, 30-pair golden set, probing harness, host llama-server launchd template, separate `rerankBaseUrl`). The pruning runtime is llama.cpp only; access tracking is deliberately deferred (`aa926b4`).
- 2026-10-20 exploration commits: `05e8ca6` (project and memory exploration tools for both MCP profiles), `97e7577` (cached project directory, project reads moved into SQL). An earlier version of this handoff called them local-only: they are pushed, and the live MCP already serves them.
- 2026-10-23/24 dashboard and follow-rate work: `979c75d`…`84bbabc` (dashboard reshaped: propose/arcs/settings, global search, Timeline + retrieval telemetry, batch review, retention run, export/restore, graph clustering, hygiene panel), `c542e5c`/`127b997`/`b082e6f`/`d7fc947` (follow-rate tracking with `appliedCount`/`lastAppliedAt`, openapi regenerated, dead-memories panel + auto-recall hook generator, project status active/dormant/archived), fix `1e9e180` (duplicate `const projects` in `loadSettings` froze the script).
- 2026-10-27/28 documentation and repository-wide audit fixes (`0316ce6`, `db826e5`, `c5687d5`):
  - Unified architecture, REST/MCP API, and policy reference in [`docs/architecture-api-policy.md`](docs/architecture-api-policy.md).
  - Fixed PostgreSQL pool connection leaks in all 6 arc methods (`finally { client.release(); }`), serialized concurrent schema migrations with `pg_advisory_xact_lock(782910451)`, mapped SQL constraint errors (`23505`, `23514`, `23503`) to domain error codes, and emitted `arc.accepted` / `project_arc.accepted` outbox events when arcs are owner-accepted on creation.
  - Handled case-insensitive `ensureProject` collisions and resolved canonical `project.id` in `openSession`.
  - Updated `restoreCorpus` and `corpusExportSchema` to preserve `projects.status` and `memories.(privacy, appliedCount, lastAppliedAt)`, and restored `memoryArcs`/`projectArcs` in `InMemoryRepository`.
  - Removed memories from `semanticSearchIndex` and cleaned up stale conflicts across `reviewProposal('reject')`, `retractMemory`, `runDeterministicPruning`, and `decidePendingLlmProposals`; pruned incident arcs when LLM proposals expire memories.
  - Fixed batch-wide sigmoid normalization in `LlamaCppPruningJudge.rerank`, isolated cache hits in `RetrievalTelemetryCollector`, wrapped all MCP tool handlers in `runTool`, fixed CLI double JSON serialization and flag parsing, forwarded headers in the Web proxy, fixed dashboard DOM/XSS/graph cluster issues, and aligned `docs/openapi.yaml` (`/v1/admin/projects/{id}/status`, unique `operationId`s).
- Use `main` as the base for new work and preserve any uncommitted changes before switching branches.
- Host tools: Node `v25.8.2`, npm `11.11.1`, OrbStack/Docker, Tailscale App `1.88.3` (an update is available). The repository requires Node `>=22.12`; npm may print an engine warning for Node 25 even though verification passes.

### Running deployment

- **The live deployment working directory is `/Users/spina/mnemosyne-experiment`**, and `/Users/spina/Mnemosyne` is also aligned to `origin/main` (`c5687d5`). The active Compose project is `mnemosyne-empty` (`mnemosyne-empty-{api,web,mcp,worker,postgres,redis,memgraph}-1`). Read the working directory and the compose project from the running containers before acting:
  - `docker inspect mnemosyne-empty-api-1 --format '{{index .Config.Labels "com.docker.compose.project.working_dir"}} | {{index .Config.Labels "com.docker.compose.project"}}'` gives the directory and project name the stack was started with.
- Full stack is running: PostgreSQL, Redis, Memgraph, API, worker, MCP, and web. API/web/postgres/redis/memgraph report healthy; MCP/worker report running.
- Loopback bindings only: API `127.0.0.1:3000`, web `127.0.0.1:18080`, MCP `127.0.0.1:3333`, PostgreSQL `127.0.0.1:5432`, Redis `127.0.0.1:6379`, Memgraph `127.0.0.1:7474->7687` (Bolt only, the container publishes no HTTP port for the graph).
- Host lazy `llama.cpp` daemon (`com.mnemosyne.llama` via [`ops/host/llama-lazy-manager.mjs`](ops/host/llama-lazy-manager.mjs)) listens on `127.0.0.1:8081` (`gemma-3-4b-it-Q4_K_M.gguf` -> internal `8181`) and `127.0.0.1:8082` (`bge-reranker-v2-m3-Q4_K_M.gguf` -> internal `8182`), spawning `llama-server` on demand and stopping after 300s idle. Both endpoints are reachable from Docker containers via `http://host.docker.internal:8081` and `http://host.docker.internal:8082`.
- The graph engine is **Memgraph** since `45072e0`; the Compose service is `memgraph` and there is no `neo4j` service, so a command naming `neo4j` fails with "no such service". The env names (`NEO4J_URI`, `NEO4J_USERNAME`), the driver (`neo4j-driver`) and the capability key (`projections.neo4j`) kept their names: they are the wire names of the Bolt protocol, not the engine.
- The active graph and database data live in `mnemosyne-empty_memgraph_data` and `mnemosyne-empty_postgres_data`. Older volumes (`mnemosyne-experiment_*`, `mnemosyne_*`) are preserved: leave them alone unless the owner asks, and never delete them with a `down -v`.
- Port 18080 is intentional: port 8080 is used by an unrelated Open WebUI process that must not be stopped.
- Private Tailscale Serve only, never Funnel:
  - dashboard: `https://<tailscale-host>/`
  - MCP: `https://<tailscale-host>:8443/mcp`
- `.env` remains local with mode `0600`; it was not modified, printed, or committed. OpenRouter remains disabled.
- Rebuild with `env -u OPENROUTER_API_KEY -u OPENROUTER_MODEL docker compose -p mnemosyne-empty up --build -d api worker mcp web` from `/Users/spina/mnemosyne-experiment`. Over SSH the build fails on the Docker credential helper because the login keychain cannot be unlocked in a non-interactive session: back up `~/.docker/config.json`, delete `credsStore` and `credHelpers`, build, then restore the file. A public base image needs no credentials.
- The host is reached with `ssh mnemosyne-mini`; the alias uses a dedicated ed25519 key, not a password. The `docker` binary is not on the default non-interactive `PATH`: export `/usr/local/bin` and `/opt/homebrew/bin` before using it over SSH.

### Seed cleanup status

- The temporary `project:seed-repository-2026` seed was removed with explicit user approval: all 1,500 manifest-listed IDs were forgotten through the confirmed owner procedure, the private manifest was deleted, and zero removed IDs remain in the semantic index.
- The project retains exactly one pre-existing `pending_approval` record. It was not part of the seed and must be preserved unless the user explicitly approves its removal.
- Forget-ledger tombstones remain by design; do not delete or rewrite them.
- The historical live benchmark below was measured before seed cleanup and remains useful only as a ranking baseline.
- `restoreCorpus` does not rebuild embeddings; any future restore requires a separate explicit reindex procedure, not an improvised migration.

### Project-memory alignment — 2026-10-26

- An audit on 26 October 2026 found the `Mnemosyne` project inside Mnemosyne itself had stopped at 27 September 2026; the only later record was a rejected test memory. Five owner-direct `decision` memories were accepted to realign it: `mem_54427b4a` (graph-model v2 on `main`, 15–16 Oct), `mem_0b6ee95f` (semantic pruning, 16–17 Oct), `mem_eb8db6fb` (exploration tools, 20 Oct), `mem_b7f70a55` (dashboard reshaping, 23–24 Oct) and `mem_b2a69398` (follow-rate, 23–24 Oct), plus an accepted `relates_to` arc from follow-rate to the dashboard decision.
- Read those five before re-deriving October history from the repo. The Lume "Mnemosyne archive" copies stop at the 2026-09-27 snapshot and are marked "not revalidated": never cite them as the current state of this project.

### Retrieval status

- Search and context use token-aware lexical matching, minimal Italian/English stemming, stopwords, generic-term weighting, BM25/IDF over the candidate set, phrase/proximity bonuses, local semantic fusion, score thresholds, and deterministic `memoryId` tie-breaking.
- PostgreSQL uses the existing GIN content index with `websearch_to_tsquery`, `ts_rank_cd`, scope predicates, bounded candidates, and cache revalidation before any full scan. The in-memory repository preserves the same ranking contract.
- Documentation: [`docs/retrieval-ranking.md`](docs/retrieval-ranking.md).
- Historical pre-cleanup live benchmark, using 12 distinctive three-word probes: keyword hit@1 `83.3%`, hit@5 `83.3%`, hit@10 `91.7%`, MRR@10 `0.847`; noisy probes have the same values; verbatim is `100%` top-1/top-10; no-match queries return zero results; top-10 Jaccard mean `0.068`, max `0.818`; search p50/p95 `7.45/18.59 ms`; context p50/p95 `12.89/33.67 ms`.
- One live probe remains genuinely ambiguous because several memories share the same evidence. This is measured and accepted as a known relevance limit, not an infrastructure failure.
- Offline gates: `npm run verify` passes 39 test files (296 tests) with 1 skipped (`neo4j-runtime.test.ts` when `MNEMOSYNE_TEST_NEO4J_URI` is unset; passes when pointed at a live Memgraph instance); `npm run eval:all` passes governance `9/9` and retrieval `11/11` with nDCG `1.0`, including four reviewed judgment queries. The deliberate `node scripts/eval-retrieval.mjs --legacy-order` check fails, proving the gate detects broken ordering.

### Dashboard and MCP status

- The dashboard graph no longer uses `vis-network` at all. The dependency, the path resolution, the `visNetworkPath` option and the `/vis-network.min.js` route are gone, along with the dead SVG renderer. It uses a native canvas renderer with non-overlapping scope clusters, stable hover behavior, no hover tooltip, zoom/pan, filtering, and persistent clicked-node highlighting.
- MCP uses the local deterministic embedding provider and PostgreSQL semantic index. On the Mac mini, `MNEMOSYNE_MCP_REQUIRE_TOKEN=false` with `MNEMOSYNE_MCP_ANONYMOUS_PROFILE=harness` disables HTTP authentication so clients need only the URL; the tailnet ACL is the perimeter, and the owner-only tools (forget, export, correct, retract, review, `memory_admin_*`) are not registered for that profile at all. Never set the anonymous profile to `owner` without an explicit reason. A supplied `Authorization` header is always verified: a per-client token escalates to `owner`, an invalid or revoked one gets `401` instead of a silent downgrade.
- Per-client credentials are minted from the client side with `npm run token:client -- --base-url <api> --name <slug> [--out <file> | --list | --revoke <slug>]`, talking to `POST /v1/admin/client-tokens` with `MNEMOSYNE_OWNER_TOKEN`. Only the SHA-256 hash and a displayable prefix are stored, the plaintext is returned once, and every token currently has the `owner` role.
- MCP DNS-rebinding protection remains configured for the Tailscale hostname; do not broaden `MCP_ALLOWED_HOSTS` or `MCP_ALLOWED_ORIGINS` without an explicit reason.

### Exploration tools status

- Four exploration tools are registered in **both** MCP profiles: `memory_list_projects` (every project with its size), `memory_get_project` (areas, breakdown by kind/lifecycle/scope, most recent memories, open conflicts, project relations), `memory_list_project_memories` (the memories of one project, filtered and paginated) and `memory_get_memory` (one memory with its arcs and conflicts). The same surface exists over REST (`GET /v1/projects`, `GET /v1/projects/{id}`, `GET /v1/projects/{id}/memories`) and in the CLI (`projects`, `project`, `project-memories`).
- The reason they exist: an agent that can only search has to guess the terms, and a miss looks like an empty corpus. A project id is also what `memory_open_session` needs, so without the directory an agent can only guess that too.
- The scoping rule is the one search already applies, and it is enforced in the service, not in the adapter: a harness reads the accepted memories its session can reach, the owner reads the corpus as it is. The harness schema therefore requires `sessionId` and the owner schema does not, and `session_id_required` is a `400` rather than an empty result.
- Counts in a project summary are corpus-level aggregates with no content in them, so both profiles read the same numbers and never disagree about the size of a project. The memory _content_ behind them is what the profile decides. Do not turn the aggregates into a per-profile view: two numbers for one project is how a reader starts doubting the reader.
- The directory is cached in Redis, but only the part the corpus revision covers: memory counts, open conflicts, arcs, latest memory. **The corpus revision does not cover projects, areas, sessions or the privacy marking** — `ensureProject`, `createArea`, `createSession` and `updateProjectPrivacy` never bump it — so the project rows, the area count and the session count are read fresh on every call. Caching them under the revision alone would hide a project that was just created, which is the one thing the directory exists to show. A test asserts exactly that.
- The aggregates are computed in SQL (`GROUP BY` over `memories`, plus a `unnest` over the conflict and arc endpoints), not by hydrating the corpus in JavaScript. The previous shape of the question was a full table scan with the content of every memory on the wire, only to count rows. `idx_memories_project_lifecycle`, `idx_memories_project_updated` and `idx_sessions_project` exist for these aggregates and for the paging.
- The per-project read paths ask the database for one project: the breakdown is a `GROUP BY`, the recent sample is a `LIMIT`, and the memory list filters and pages in SQL. A project read no longer hydrates every memory of the project. Measured at 10,000 memories in one project: the directory 39.7 ms to 1.8 ms without a cache and 0.3 ms with one, the outline 49.3 ms to 4.9 ms, the first page of the memory list 45.5 ms to 3.0 ms.
- `GET /v1/admin/projects` now answers with the same summaries, which is what finally made the response match its own OpenAPI schema; the dashboard is unaffected because it only reads `id` and `name`.
- Known gap, not fixed here: `GET /v1/memories/{id}` still lets a harness read any memory by id without a session or a scope check. The new `memory_get_memory` is stricter. Fixing the older route changes existing behaviour, so it wants its own decision.

### Capability reporting status

- `GET /v1/admin/capabilities` reports only what the answering process can attest to, and names that process in `reporter`. The values are process-scoped, not deployment-scoped, so read `reporter` before drawing a conclusion about the deployment. API and MCP both own a Redis corpus cache as of the `packages/redis` extraction, so both report `redis: true`; `redis: false` from either one is now a real degradation, not the expected shape. API and MCP do not own the extraction provider, the graph projection or the retention timer, so those come from a worker heartbeat in the new `runtime_capabilities` table, written every `WORKER_CAPABILITY_HEARTBEAT_MS` (default 60s) and trusted only for `MNEMOSYNE_RUNTIME_CAPABILITY_TTL_SECONDS` (default 300). Keep the heartbeat shorter than the TTL, or capabilities read unknown while the worker is alive.
- Capabilities have three states. `null` means unobserved, never disabled, and every `null` is named with a reason in `gaps`. `operations.backupVerified` is always `null` because backups run outside the process. `workerObservedAt` says how fresh the worker's contribution is.
- Previously `neo4j` and `openRouterConfigured` were hardcoded to `false` and pinned with `z.literal`, so the endpoint asserted facts about a process that cannot see them. Do not reintroduce hardcoded capability values, and do not pin a field that some process can genuinely observe differently.
- The live JSONB round trip through Zod is covered by `verifyRuntimeCapabilities` in the synthetic E2E, not by unit tests. That E2E has been executed against real PostgreSQL and pgvector and passes.

### Corpus cache status

- `RedisCorpusCache` lives in `packages/redis`, mirroring `packages/postgres`, and `connectCorpusCache` is the single entry point both processes use. It returns `undefined` for an unset or unreachable `REDIS_URL` rather than failing startup, and the degradation is only visible through `projections.redis` in the capabilities report. That silence is the reason to read `reporter`, not a reason to add logging.
- MCP did not own a cache until 2026-09-28, while the API had owned one all along. The cost was measured, not assumed: 25 MCP searches, 15 of them byte-identical repeats, wrote **zero** Redis keys, while a single API search wrote one. The repeated reads were the point, because a harness re-reads the same scopes within a task. The cache only pays on exact repeats: on distinct queries it is a small net cost, which is why the win is real here and was not worth chasing for the API alone.
- Cache correctness does not depend on the corpus revision alone being checked. `cachedCorpusResult` compares the stored revision to the live one and `revalidateCachedMemories` re-reads every cached row, so a cache hit cannot serve a memory that was forgotten, retracted or superseded in the meantime.

### Outbox retention status

- `corpus_outbox` rows were marked `processed_at` and never deleted, with no pruning anywhere except a full wipe during a corpus restore. The table grew without bound: 4,720 rows and 2.1 MB after roughly eleven hours on the mini, all of them processed. The in-memory backend removes rows in `markOutboxProcessed`, so the leak was invisible to every test that does not use PostgreSQL.
- The balanced retention run now prunes processed rows older than `processedOutboxEventDays`, default 3, and reports the count as `deleted.processedOutboxEvents`.
- That pruning is deliberately excluded from the corpus revision bump. The outbox is derived projection feed, not corpus content, so bumping would invalidate every cached search in the deployment over rows nobody can see. Two tests assert both halves of that: outbox-only pruning does not bump, corpus-content deletion still does.

### Host keep-alive and backup

- Three launchd agents in `~/Library/LaunchAgents`, all installed and reporting exit 0: `com.mnemosyne.runtime` (RunAtLoad, starts OrbStack when the daemon is silent and reconciles the project), `com.mnemosyne.health` (every 5 minutes, probes the API and the dashboard, repairs after 2 consecutive failures), `com.mnemosyne.backup` (02:00, encrypted dump with verified restore and retention).
- Scripts and templates live in [`ops/host`](../ops/host/README.md) and [`ops/backup`](../ops/backup/README.md); logs are in `~/Library/Logs/mnemosyne/`. The backup env is `~/.mnemosyne/backup.env` (mode `0600`) and its passphrase file is `~/.mnemosyne/backup.pass`; dumps land in `~/Backups/mnemosyne`.
- `run-backup.sh` needs `MNEMOSYNE_DEPLOY_ENV_FILE` in the backup env: `docker compose` interpolates every service even for `exec postgres`, so without the deployment values the run fails on an unrelated service. The documented command in the runbook did not work before this.
- Two real reboot tests were run. The first left the stack unreachable for 18 minutes because OrbStack started its app but not its virtual machine, and the ensure script hung on an unbounded `docker info`. The second, after `7d68519`, recovered automatically in 87 seconds. OrbStack's post-boot start is intermittent; the bounded calls and single recycle are the mitigation, not a fix.
- Backups live on the mini's own disk. The operator decided to keep them there, so a disk failure takes data and backups together.
- The opencode MCP configuration lives in `~/.config/opencode/opencode.jsonc`, not in the repository: the endpoint is a per-machine tailnet host and the credential path is under `$HOME`.

### Retrieval telemetry status

- `GET /v1/admin/telemetry/retrieval` (also `mnemosyne telemetry`, MCP `memory_admin_retrieval_telemetry`) reports aggregate retrieval counters for the process that answers: which path served each query, candidate and result distributions, top score bands, cache hits, and semantic unavailability. Read `reporter` first, because the API and MCP rank independently and keep separate counts.
- Privacy boundary, enforced by the schema shape rather than by convention: every leaf is a count or a score band. No query text, no memory id, no scope, no corpus content can be recorded, because there is no field that could carry one. A test asserts this against the serialized snapshot.
- Counters are in-process only and never persisted, so there is no new storage, no migration, and nothing to forget later. The deliberate cost is no history.

### Load test status

`node scripts/load-test.mjs` runs against throwaway pgvector and Redis containers with random names and random ports, removed on exit. Data is generated, so it needs no approved scope and never recreates the removed seed. Measured on 27 September 2026 with 10,000 memories, `shared_buffers=256MB`, 24 pooled clients:

| Phase                        | Result                       |
| ---------------------------- | ---------------------------- |
| Governed single-item propose | 212/s                        |
| Bulk repository fill         | 545/s                        |
| Embedding reindex of 10,000  | 17.2 s                       |
| Outbox after 10,000 writes   | 20,000 rows, all unprocessed |

Retrieval latency with and without the Redis cache, 40 distinct queries each, 10,000 memories:

| Shape                                          | p50        | p95        |
| ---------------------------------------------- | ---------- | ---------- |
| No cache, distinct queries                     | 78.6 ms    | 86.7 ms    |
| Cache present, distinct queries, all misses    | 81.2 ms    | 89.8 ms    |
| Cache present, 200 identical queries, all hits | **1.3 ms** | **1.8 ms** |

- The cache is decisive on repeats: 78.6 ms becomes 1.3 ms, roughly 59x. On a miss it costs about 2.6 ms, roughly 3%, which is the price of writing the entry.
- The cache-hit path is not free, and the reason is `revalidateCachedMemories`, which issues one `getMemory` query per cached result. Measured at 10,000 memories, cache hits only: limit 5 gives p50 0.71 ms, limit 20 gives 1.24 ms, limit 50 gives 2.39 ms. That is about 0.035 ms per returned row, so the cost scales with the page size and not with the corpus. It is the dominant part of a cache hit in absolute terms and it is still under 3 ms, so it is worth knowing about rather than worth optimising now.
- **The ranking is not the limit, and the earlier "does not scale" reading was an artifact of this benchmark.** The synthetic corpus put a shared token in every memory, and because the full-text query is an OR, one such token makes every probe match 100% of the corpus. With that token, a 10,000-memory query costs about 91 ms; without it, the same query on the same corpus costs **1.9 ms**, a 48x difference. Query cost is proportional to the size of the full-text match set, so any load test on synthetic text must control how many rows a probe can match, or it measures a pathological shape rather than a real one. `--no-shared-term` exists for exactly that comparison.
- The cache is still worth having on repeats, 78.6 ms to 1.3 ms, and the ranking fix below is still worth having, because both were measured on the pathological corpus and both help regardless. But the honest summary of latency is: about 2 ms for a discriminative query at 10,000 memories, and about 8 ms live on the 96-memory real corpus where the live benchmark probes are also the most discriminative profile available. The slow case is a query whose terms match most of the corpus, which is a property of the query, not of the index.

- Concurrency was only ever measured on the pathological corpus and the numbers are not worth promoting; re-measure with `--no-shared-term` before drawing any conclusion about contention.
- **The load test was broken and is fixed.** Since a memory belongs to a project permanently (`memories.project_id` NOT NULL, commit `939e10f`), the bulk fill wrote rows without a project and the script died on the first batch against PostgreSQL. `scripts/load-test.mjs`, `scripts/profile-retrieval.mjs` and `scripts/eval-governance.mjs` now name the project, and the in-memory repository refuses a memory without one, so the deterministic suite catches the shape the real database rejects. Anyone who reads an older load-test number should check whether it came from a run that actually finished.

### Project exploration latency

The exploration surface is the first thing an agent touches, so its cost was measured rather than argued. Phase F of the load test, 10,000 memories **in a single project** (the pathological shape: a real corpus spreads them over many projects), 24 pooled clients, 20 runs each:

| Path                            | Before  | After  | Gain |
| ------------------------------- | ------- | ------ | ---- |
| Project directory, no cache     | 39.7 ms | 1.8 ms | 22x  |
| Project directory, cache hit    | 39.7 ms | 0.3 ms | 120x |
| Project outline                 | 49.3 ms | 4.9 ms | 10x  |
| Project memory list, first page | 45.5 ms | 3.0 ms | 15x  |

- "Before" is the shape the question used to have: hydrate every memory with its current revision, in JavaScript, only to count rows. The content of a memory is the bulk of its row, so counting it meant paying for it.
- The directory is the first call an agent makes and the one a cache is for. 0.3 ms on a hit against 1.8 ms on a miss: the miss is the SQL aggregate, the hit is a Redis GET plus the fresh structural read.
- The text filter on the memory list scans the project, because a substring match is a substring match; the default listing has no text filter and pages on the index. `--memories` with the memories spread over many projects is the realistic shape and is faster than the numbers above.
- Three proposed optimisations were tried and **all three were measured to be worthless**, which is the useful result. Reducing the semantic neighbour count from 1,000 to 100 changed p50 by less than the run-to-run noise (144.7/145.4/146.1 before, 143.9/144.8/144.8 after). Running with no semantic index at all gives 142.9 ms against 143.9 ms hybrid, so the whole semantic path costs about 1 ms. Cutting the candidate pool from 400 to 50 gained only 7%.
- Therefore none of the cost is in the ranking code. `scripts/profile-retrieval.mjs` isolates the paths, and `scripts/explain-search.mjs` runs EXPLAIN ANALYZE on the database. The shipping full-text query returns 15 rows in about 69 ms while using its GIN index, and removing `ts_rank_cd` from the ORDER BY changes nothing, so the index is used and the rank is free.
- **The 69 ms turned out to be a join-order defect, and it is fixed.** EXPLAIN showed the GIN index was never used: the planner started from `memories` on the lifecycle index, did one primary-key lookup per row, and applied the text match afterwards as a post-filter. The same filter on `memory_revisions` alone returned the same 15 rows in 2.1 ms. The cause was neither prefix expansion nor query parameterisation, both of which were tested and ruled out. Filtering `memory_revisions` first through a `MATERIALIZED` CTE fixes the plan, and the isolated query is now 2.35 ms, about 29x faster.
- **The end-to-end gain is about 6%, not 29x.** Three load-test runs went from 144.7/145.4/146.1 to 141.2/141.7/140.6, and the isolated lexical path from 142.9 to 136.6. The isolated win does not carry through because a real query is a multi-term OR, so the CTE still materialises and ranks a larger match set. The honest reading is that the constant factor improved modestly while the asymptotics were fixed: the old plan did one primary-key lookup per corpus row per query, the new one scans only matching rows, so the gap widens with corpus size. A test asserts the `MATERIALIZED` form so the plan cannot silently regress.
- This measured latency, not relevance, at scale. Whether ranking accuracy also degrades with 100x more distractors is untested and is a separate question.

### Live relevance benchmark

`node scripts/bench-live-retrieval.mjs` is read-only and generates probes from the corpus, so it prints only aggregates and never content. It runs three profiles because a single number would be misleading. Measured on the live 96-memory corpus on 27 September 2026:

| Profile                                 | hit@1 | hit@5 | hit@10 | MRR@10 |
| --------------------------------------- | ----- | ----- | ------ | ------ |
| `sharp3`, three most distinctive terms  | 100%  | 100%  | 100%   | 1.000  |
| `sharp2`, two distinctive terms         | 100%  | 100%  | 100%   | 1.000  |
| `muted3`, three least distinctive terms | 13.3% | 33.3% | 66.7%  | 0.262  |

- `sharp3` and `sharp2` are close to verbatim, because the probe terms are drawn from the target memory itself. They are a contract check on the ranking, not a relevance result, and the 100% must not be read as one.
- `muted3` is the stress case: terms pushed toward the noise floor, where a lexical system should be expected to struggle.
- The gap between the profiles is the honest shape of a BM25 plus hashed-bag-of-words system, and it is why a hand-judged probe set is still the only way to say where the system actually sits. Only the owner can judge what a real user would type.

### Recommended follow-up

1. Grow the hand-judged relevance set, now that there is a measured gradient to place it against.
2. Decide whether 1,000-candidate ranking plus a JS-side cosine pass is acceptable at the corpus size the system is actually heading towards.

The embedding reindex/health and load-test follow-ups are done; see the sections above.

### Embedding recovery status

- `restoreCorpus` still does not rebuild embeddings, but the degradation is no longer silent. `GET /v1/admin/embeddings/health` (also `mnemosyne embeddings-health`, MCP `memory_admin_embedding_health`) compares the corpus against the index for the active profile and reports `indexedForActiveProfile`, `missingCount`, `needsReindex`, plus any other profiles left over from a provider change.
- `POST /v1/admin/embeddings/reindex` (also `mnemosyne embeddings-reindex --yes`, MCP `memory_admin_reindex_embeddings`) rebuilds every embedding and is idempotent. It throws `semantic_search_unavailable` (409) when no provider is configured rather than reporting an empty success, because a success that indexed nothing is the failure mode this exists to remove. It deliberately does not bump the corpus revision: cached searches are still valid approved memories and self-heal within the cache TTL.
- Embedding counts come from `SemanticSearchIndex.countByProfile()`, not from the corpus repository. That is not cosmetic: in the in-memory backend the index and the repository are separate objects, and asking the repository produced a health report that was structurally always empty.
- After any corpus restore, run the reindex. The synthetic E2E asserts this exact sequence against real PostgreSQL, including that the restore really does leave the index at zero.

### Cross-scope conflict status

- `areDirectlyContradictory` no longer requires matching scopes. It still requires the same `kind` and the same sentence word for word with exactly one negation, which is what keeps the false-positive surface small.
- Two governance cases guard this: `cross-scope-contradiction-is-detected` and `cross-scope-agreement-is-not-a-conflict`. Reintroducing the scope check makes the governance gate fail, so the guard is real rather than decorative.
- The remaining four conflict types are still declared and never produced. That is unchanged and still open.

### Cleanup guardrails

- Do not run `docker compose down -v`, prune Docker volumes, or remove PostgreSQL/graph data.
- Do not recreate the deleted seed manifest or seed project.
- Do not delete the pre-existing pending record or rewrite forget-ledger tombstones without explicit approval.
- Do not print, copy, commit, or upload `.env`, tokens, passwords, provider keys, or corpus contents.
- Do not change Tailscale Serve, enable Funnel, or seed OpenRouter without explicit approval.

## Safety boundaries

- Work only in the repository and the local Mac host unless the user explicitly authorizes another system.
- Never print, paste, commit, or upload `.env` values, database passwords, owner/harness tokens, provider keys, backup passphrases, or corpus data.
- Never run destructive Docker commands such as `docker compose down -v`, `docker volume prune`, `docker system prune`, or delete a PostgreSQL/Neo4j/Memgraph volume without explicit confirmation.
- Prefer the local extractor. Do not enable OpenRouter unless the user explicitly requests it.
- Do not use Tailscale Funnel or public ingress. Use private Tailscale Serve and ACLs.
- Treat web/API/MCP as private services; do not publish PostgreSQL, Redis, the graph, or raw service ports.

## Automatic sequence

1. Check the host with `uname -m`, `docker version`, `docker compose version`, `docker info`, `tailscale status`, and available disk/RAM.
2. Verify that required ports are free. Do not stop unrelated containers.
3. If `.env` is absent, run `npm run env:init`. If it exists, inspect permissions and variable names only; never overwrite it.
4. Validate configuration with `docker compose config --quiet`.
5. Start the smallest useful stack:
   - dashboard/API: `docker compose up --build -d postgres redis api web`
   - full worker/projections: `docker compose up --build -d postgres redis memgraph api worker web`
6. Wait for API and web health. Never report success from `docker compose up` alone.
7. Verify `curl -fsS http://127.0.0.1:3000/health/ready`, the dashboard root, and an authenticated owner proxy request without printing the token.
8. If Tailscale Serve is not configured, show the safe command and ask before changing host-wide Tailscale state. Do not enable Funnel.
9. Report service status, dashboard URL, remaining external steps, and any failure without exposing secrets.

## Environment rules

- Keep `WEB_BIND_HOST=127.0.0.1` when using Tailscale Serve.
- For remote MCP, set `MCP_TRANSPORT=http` and container `MCP_HOST=0.0.0.0`, then expose it only through Tailscale Serve. Configure `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS`.
- Shell environment variables override `.env` in Compose. For local extraction, run Compose with `env -u OPENROUTER_API_KEY -u OPENROUTER_MODEL ...` if stale provider variables are present.
- If an existing PostgreSQL volume rejects a newly generated password, do not delete the volume. Diagnose with `docker compose logs postgres`, connect through the local socket, and synchronize the role password only after confirming the database is the intended Mnemosyne volume.

## Verification standard

A deployment is complete only when the intended containers are running/healthy, `/health/ready` returns 200, the dashboard returns 200 from the Mac, the owner proxy returns valid JSON, and the tailnet route is private. Run the project checks relevant to the change with `npm run verify`; run the full synthetic E2E when Docker changes are involved.

## Documentation

Keep the Mac/Tailscale runbook, `.env.example`, Compose, backup templates, and release documentation synchronized when deployment behavior changes.

## v2 graph-model status (updated 2026-10-26)

The graph-model v2 is no longer a parallel line: it landed on `main` and
`origin/main` between 15 and 16 October 2026 — projects and areas as real
entities, weighted arcs, scope-enum retirement, project/area roots in the
Neo4j projection — and the semantic pruning pipeline followed on `main`
between 16 and 17 October with a local llama.cpp-only runtime (Gemma 3
proposer, calibrated encoder judge). The design docs keep their value:
[`docs/v2-graph-model-plan.md`](docs/v2-graph-model-plan.md),
[`docs/v2-handoff.md`](docs/v2-handoff.md). `main` stays the deployment,
and the live MCP already serves v2-era behaviour: first-class
projects/areas, weighted arcs, the exploration tools, `appliedCount` and
project status. Do not treat a handoff older than the tip of `main` as
deployment truth: read the running containers and the version they serve.
