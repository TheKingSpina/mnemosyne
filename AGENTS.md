# Mnemosyne Mac Mini Agent Instructions

## Mission

Operate Mnemosyne on an Apple M1 Mac mini with 8 GB RAM using Docker Compose and private Tailscale access. The detailed runbook is [`docs/macos-mini-tailscale.md`](docs/macos-mini-tailscale.md).

## Current handoff — 2026-09-27

### Repository and Git

- `main` tracks `origin/main` with no local divergence and no side branches; the per-client token work (`9567535`, `310dca3`) and the credential-path fix are merged.
- Retrieval commits: `8b5becc` (hybrid ranking), `7de9187` (dashboard/MCP wiring), `29c3ef9` (reviewed relevance judgments), `609e63e` (handoff documentation).
- 2026-09-27 operational commits: `10a128d` (scheduled backup reads the deployment env), `b866f47` (host keep-alive agents and persistence docs), `7d68519` (bounded docker calls, runtime recycle), `ed7274a` (anonymous MCP opt-out), `7552d00` (anonymous callers scoped to harness), `597c671` (opencode config lives in the user profile).
- Use `main` as the base for new work and preserve any uncommitted changes before switching branches.
- Host tools: Node `v25.8.2`, npm `11.11.1`, OrbStack/Docker, Tailscale App `1.88.3` (an update is available). The repository requires Node `>=22.12`; npm may print an engine warning for Node 25 even though verification passes.

### Running deployment

- Full stack is running: PostgreSQL, Redis, Neo4j, API, worker, MCP, and web. API/web report healthy; MCP/worker report running.
- Loopback bindings only: API `127.0.0.1:3000`, web `127.0.0.1:18080`, MCP `127.0.0.1:3333`, PostgreSQL `127.0.0.1:5432`, Redis `127.0.0.1:6379`, Neo4j `127.0.0.1:7474`.
- Port 18080 is intentional: port 8080 is used by an unrelated Open WebUI process that must not be stopped.
- Private Tailscale Serve only, never Funnel:
  - dashboard: `https://mac-mini-di-alessandro-2.tail82e37f.ts.net/`
  - MCP: `https://mac-mini-di-alessandro-2.tail82e37f.ts.net:8443/mcp`
- `.env` remains local with mode `0600`; it was not modified, printed, or committed. OpenRouter remains disabled.
- Rebuild with `env -u OPENROUTER_API_KEY -u OPENROUTER_MODEL docker compose up --build -d api worker mcp`; add `web` for the dashboard. Over SSH the build fails on the Docker credential helper because the login keychain cannot be unlocked in a non-interactive session: back up `~/.docker/config.json`, delete `credsStore` and `credHelpers`, build, then restore the file. A public base image needs no credentials.
- The host is reached with `ssh mnemosyne-mini`; the alias uses a dedicated ed25519 key, not a password.

### Seed cleanup status

- The temporary `project:seed-repository-2026` seed was removed with explicit user approval: all 1,500 manifest-listed IDs were forgotten through the confirmed owner procedure, the private manifest was deleted, and zero removed IDs remain in the semantic index.
- The project retains exactly one pre-existing `pending_approval` record. It was not part of the seed and must be preserved unless the user explicitly approves its removal.
- Forget-ledger tombstones remain by design; do not delete or rewrite them.
- The historical live benchmark below was measured before seed cleanup and remains useful only as a ranking baseline.
- `restoreCorpus` does not rebuild embeddings; any future restore requires a separate explicit reindex procedure, not an improvised migration.

### Retrieval status

- Search and context use token-aware lexical matching, minimal Italian/English stemming, stopwords, generic-term weighting, BM25/IDF over the candidate set, phrase/proximity bonuses, local semantic fusion, score thresholds, and deterministic `memoryId` tie-breaking.
- PostgreSQL uses the existing GIN content index with `websearch_to_tsquery`, `ts_rank_cd`, scope predicates, bounded candidates, and cache revalidation before any full scan. The in-memory repository preserves the same ranking contract.
- Documentation: [`docs/retrieval-ranking.md`](docs/retrieval-ranking.md).
- Historical pre-cleanup live benchmark, using 12 distinctive three-word probes: keyword hit@1 `83.3%`, hit@5 `83.3%`, hit@10 `91.7%`, MRR@10 `0.847`; noisy probes have the same values; verbatim is `100%` top-1/top-10; no-match queries return zero results; top-10 Jaccard mean `0.068`, max `0.818`; search p50/p95 `7.45/18.59 ms`; context p50/p95 `12.89/33.67 ms`.
- One live probe remains genuinely ambiguous because several memories share the same evidence. This is measured and accepted as a known relevance limit, not an infrastructure failure.
- Offline gates: `npm run verify` passes 168 tests with 1 skipped; `npm run eval:all` passes governance `9/9` and retrieval `11/11` with nDCG `1.0`, including four reviewed judgment queries. The deliberate `node scripts/eval-retrieval.mjs --legacy-order` check fails, proving the gate detects broken ordering.

### Dashboard and MCP status

- The dashboard graph no longer uses `vis-network` at all. The dependency, the path resolution, the `visNetworkPath` option and the `/vis-network.min.js` route are gone, along with the dead SVG renderer. It uses a native canvas renderer with non-overlapping scope clusters, stable hover behavior, no hover tooltip, zoom/pan, filtering, and persistent clicked-node highlighting.
- MCP uses the local deterministic embedding provider and PostgreSQL semantic index. On the Mac mini, `MNEMOSYNE_MCP_REQUIRE_TOKEN=false` with `MNEMOSYNE_MCP_ANONYMOUS_PROFILE=harness` disables HTTP authentication so clients need only the URL; the tailnet ACL is the perimeter, and the owner-only tools (forget, export, correct, retract, review, `memory_admin_*`) are not registered for that profile at all. Never set the anonymous profile to `owner` without an explicit reason. A supplied `Authorization` header is always verified: a per-client token escalates to `owner`, an invalid or revoked one gets `401` instead of a silent downgrade.
- Per-client credentials are minted from the client side with `npm run token:client -- --base-url <api> --name <slug> [--out <file> | --list | --revoke <slug>]`, talking to `POST /v1/admin/client-tokens` with `MNEMOSYNE_OWNER_TOKEN`. Only the SHA-256 hash and a displayable prefix are stored, the plaintext is returned once, and every token currently has the `owner` role.
- MCP DNS-rebinding protection remains configured for the Tailscale hostname; do not broaden `MCP_ALLOWED_HOSTS` or `MCP_ALLOWED_ORIGINS` without an explicit reason.

### Capability reporting status

- `GET /v1/admin/capabilities` reports only what the answering process can attest to, and names that process in `reporter`. The values are process-scoped, not deployment-scoped: `redis: true` from the API and `redis: false` from MCP are both correct, because the API owns a cache and MCP does not. Read `reporter` before drawing a conclusion about the deployment. API and MCP do not own the extraction provider, the Neo4j projection or the retention timer, so those come from a worker heartbeat in the new `runtime_capabilities` table, written every `WORKER_CAPABILITY_HEARTBEAT_MS` (default 60s) and trusted only for `MNEMOSYNE_RUNTIME_CAPABILITY_TTL_SECONDS` (default 300). Keep the heartbeat shorter than the TTL, or capabilities read unknown while the worker is alive.
- Capabilities have three states. `null` means unobserved, never disabled, and every `null` is named with a reason in `gaps`. `operations.backupVerified` is always `null` because backups run outside the process. `workerObservedAt` says how fresh the worker's contribution is.
- Previously `neo4j` and `openRouterConfigured` were hardcoded to `false` and pinned with `z.literal`, so the endpoint asserted facts about a process that cannot see them. Do not reintroduce hardcoded capability values, and do not pin a field that some process can genuinely observe differently.
- The live JSONB round trip through Zod is covered by `verifyRuntimeCapabilities` in the synthetic E2E, not by unit tests. That E2E has been executed against real PostgreSQL and pgvector and passes.

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

`node scripts/load-test.mjs` runs against a throwaway pgvector container with a random name and a random port, removed on exit. Data is generated, so it needs no approved scope and never recreates the removed seed. Measured on 27 September 2026 with 10,000 memories, `shared_buffers=256MB`, 24 pooled clients:

| Phase                        | Result                        |
| ---------------------------- | ----------------------------- |
| Governed single-item propose | 74/s, p50 10.4 ms, max 298 ms |
| Bulk repository fill         | 304/s                         |
| Embedding reindex of 10,000  | 22.6 s                        |
| Outbox after 10,000 writes   | 20,000 rows, all unprocessed  |

Search and context latency by concurrency, 40 requests each:

| Concurrency | Search p50 | Search p95 | Context p50 |
| ----------- | ---------- | ---------- | ----------- |
| 1           | 137 ms     | 154 ms     | 153 ms      |
| 4           | 238 ms     | 282 ms     | 285 ms      |
| 8           | 327 ms     | 415 ms     | 347 ms      |
| 16          | 520 ms     | 921 ms     | 550 ms      |

- The headline is the comparison with production, not the concurrency table: the live corpus of 96 memories answers a search in about 9 ms, while 10,000 synthetic memories at concurrency 1 take 137 ms. That is roughly 15x slower for 100x the data, so the current ranking does not degrade gracefully with corpus size.
- The cause is known and structural: the candidate pool is bounded to 1,000, BM25 is recomputed for every candidate, and `PostgresSemanticSearchIndex` selects neighbours with pgvector and then recomputes cosine in JavaScript, so the semantic path pays a JS-side vector pass per query.
- Throughput still improves with concurrency up to about 8 and then plateaus, so this is queueing plus genuinely slower queries, not thrashing. Zero errors at every level.
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

- Do not run `docker compose down -v`, prune Docker volumes, or remove PostgreSQL/Neo4j data.
- Do not recreate the deleted seed manifest or seed project.
- Do not delete the pre-existing pending record or rewrite forget-ledger tombstones without explicit approval.
- Do not print, copy, commit, or upload `.env`, tokens, passwords, provider keys, or corpus contents.
- Do not change Tailscale Serve, enable Funnel, or seed OpenRouter without explicit approval.

## Safety boundaries

- Work only in the repository and the local Mac host unless the user explicitly authorizes another system.
- Never print, paste, commit, or upload `.env` values, database passwords, owner/harness tokens, provider keys, backup passphrases, or corpus data.
- Never run destructive Docker commands such as `docker compose down -v`, `docker volume prune`, `docker system prune`, or delete a PostgreSQL/Neo4j volume without explicit confirmation.
- Prefer the local extractor. Do not enable OpenRouter unless the user explicitly requests it.
- Do not use Tailscale Funnel or public ingress. Use private Tailscale Serve and ACLs.
- Treat web/API/MCP as private services; do not publish PostgreSQL, Redis, Neo4j, or raw service ports.

## Automatic sequence

1. Check the host with `uname -m`, `docker version`, `docker compose version`, `docker info`, `tailscale status`, and available disk/RAM.
2. Verify that required ports are free. Do not stop unrelated containers.
3. If `.env` is absent, run `npm run env:init`. If it exists, inspect permissions and variable names only; never overwrite it.
4. Validate configuration with `docker compose config --quiet`.
5. Start the smallest useful stack:
   - dashboard/API: `docker compose up --build -d postgres redis api web`
   - full worker/projections: `docker compose up --build -d postgres redis neo4j api worker web`
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
