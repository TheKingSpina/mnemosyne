# Mnemosyne Mac Mini Agent Instructions

## Mission

Operate Mnemosyne on an Apple M1 Mac mini with 8 GB RAM using Docker Compose and private Tailscale access. The detailed runbook is [`docs/macos-mini-tailscale.md`](docs/macos-mini-tailscale.md).

## Current handoff — 2026-09-25

### Repository and Git

- `main` contains merged PR #4 (merge commit `def4665`); all required CI checks were green before merge.
- Retrieval commits: `8b5becc` (hybrid ranking), `7de9187` (dashboard/MCP wiring), `29c3ef9` (reviewed relevance judgments), `609e63e` (handoff documentation).
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
- Rebuild retrieval changes with `env -u OPENROUTER_API_KEY -u OPENROUTER_MODEL docker compose up --build -d api worker mcp`; rebuild the dashboard with the same environment and `web`.

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
- Offline gates: `npm run verify` passes 116 tests with 1 skipped; `npm run eval:all` passes governance `7/7` and retrieval `11/11` with nDCG `1.0`, including four reviewed judgment queries. The deliberate `node scripts/eval-retrieval.mjs --legacy-order` check fails with nDCG `0.9405` and `9/11`, proving the gate detects broken ordering.

### Dashboard and MCP status

- The dashboard graph no longer loads `vis-network` at runtime. It uses a native canvas renderer with non-overlapping scope clusters, stable hover behavior, no hover tooltip, zoom/pan, filtering, and persistent clicked-node highlighting.
- MCP uses the local deterministic embedding provider and PostgreSQL semantic index. Owner review/forget/export operations require `MNEMOSYNE_OWNER_TOKEN`; harness clients use `MNEMOSYNE_HARNESS_TOKEN` and receive `403` for owner-only actions.
- MCP DNS-rebinding protection remains configured for the Tailscale hostname; do not broaden `MCP_ALLOWED_HOSTS` or `MCP_ALLOWED_ORIGINS` without an explicit reason.

### Recommended follow-up

1. Add privacy-safe retrieval telemetry (candidate counts, FTS/semantic path, score bands) without logging queries or corpus content.
2. Add an explicit embedding reindex/health command for post-restore recovery.
3. Grow the small reviewed live relevance set if a stricter top-1 target is required.
4. Run a concurrency/load test against a future explicitly approved large scope; do not recreate the removed seed.

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
