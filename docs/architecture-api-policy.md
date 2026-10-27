# Mnemosyne: architecture, API, and policy

Mnemosyne is a governed, persistent memory service for AI assistants and LLM
harnesses. It keeps useful context across sessions and projects without
letting session history turn into an untrusted stream of instructions. One
principle runs through the whole system: **the model proposes, the service
decides**. Nothing enters the corpus without passing policy, nothing enters
context without being `accepted`, and nothing is forgotten without leaving a
trace in the ledger.

This document describes the architecture, the API surface, and the policy in
one place. Deeper treatments live in the documents listed at the end.

## 1. Architecture

### 1.1 Layering

CQRS / hexagonal core. PostgreSQL is the canonical source of truth; everything
else is a cache or a derived projection and can be rebuilt.

| Store | Role |
| --- | --- |
| **PostgreSQL 17** (+ pgvector) | **Authoritative.** Memories, revisions, projects, areas, arcs, sessions, events, conflicts, jobs, outbox, forget ledger, embeddings |
| **Redis 7.4** | **Cache only** (API and MCP each own one). Validated against the corpus revision and revalidated row by row on read; losing it loses no data |
| **Memgraph** | **Derived graph projection** of projects, areas, memories and arcs, fed by the outbox. Rebuildable from PostgreSQL at any time |

The graph engine is Memgraph; the env names (`NEO4J_URI`), the driver
(`neo4j-driver`) and the capability key (`projections.neo4j`) kept their
historical names because they are Bolt-protocol wire names, not the engine.

### 1.2 Processes

| Service | Port | Role |
| --- | --- | --- |
| `api` | 3000 | REST. The single external entry point. Health at `/health/ready` |
| `mcp` | 3333 | MCP server (stdio or Streamable HTTP), same policy as the API, own corpus cache |
| `worker` | — | Extraction, consolidation, scheduled retention, capability heartbeat (60 s), graph projection via the outbox. The only process that writes the graph |
| `web` | 18080 (mini) | Static dashboard with a proxy to the API. Never touches the database |
| CLI | — | Host-side `mnemosyne` command over the same REST surface |

Data flow, one direction only:

```text
harness/client → api:3000 or mcp:3333 → PostgreSQL (+ Redis cache)
                                            ↓ outbox
                                          worker → Memgraph
```

Nothing reads the graph as truth, and nothing but the worker writes it.

### 1.3 Data model (v2)

- **Projects** are real roots with a case-insensitive unique name. A memory's
  project is **identity, not content**: immutable by trigger, `ON DELETE
  RESTRICT` — a cascade would delete memories without a forget-ledger row.
- **Areas** group work inside a project; **sessions** declare the areas they
  may read, and session scoping is enforced in the service layer, not the
  adapter.
- **Memories** are versioned: every accepted state is a `memoryRevision` row
  (content ≤ 10,000 chars, kind, scope, epistemic basis, confidence,
  sensitivity, activation, source event ids). Kinds: `fact`, `preference`,
  `instruction`, `decision`, `convention`, `constraint`, `goal`,
  `hypothesis`, `episode`.
- **Arcs** are weighted relations between memories and between projects,
  owner-reviewed (`relates_to` by default; relation types are free-form
  strings). Arc influence may form cycles.
- **Conflicts** are detected (same kind, same sentence word for word with
  exactly one negation, across scopes) and surface for owner resolution.
- **Forget ledger** records every removal; tombstones are permanent.
- **Outbox** feeds the graph projection; processed rows are pruned by
  retention without bumping the corpus revision (it is feed, not content).
- **Embeddings** live in the pgvector index, per provider profile; a corpus
  restore does not rebuild them, and `POST /v1/admin/embeddings/reindex` is
  the explicit reindex.

### 1.4 Derived pipelines

- **Retrieval**: token-aware lexical matching (light stemming, stopwords,
  generic-term weighting) + BM25/IDF over the candidate set, phrase and
  proximity bonuses, local semantic fusion, thresholds, deterministic
  tie-breaking. PostgreSQL uses the GIN content index with a materialized
  revision CTE so the planner scans only matching rows. Details and contract:
  `docs/retrieval-ranking.md`.
- **Semantic pruning**: proposals scored deterministically from existing
  signals, judged by a calibrated local llama.cpp model with a deterministic
  veto; runs inside the retention window. Details: `docs/potatura-semantica.md`.
- **Capability reporting**: `GET /v1/admin/capabilities` reports only what the
  answering process can attest to, named in `reporter`; worker-owned
  capabilities arrive by heartbeat and are trusted for a short TTL. `null`
  means unobserved, never disabled, and every `null` is named in `gaps`.

### 1.5 Degradation behavior

- PostgreSQL unreachable → the service degrades explicitly (`degraded`), it
  never returns an empty context as if the corpus were empty.
- Redis unreachable or unset → startup does not fail; the system works without
  cache and the degradation is visible only in `projections.redis`, which is
  why `reporter` must be read with it.
- Graph down → the worker stops projecting and capabilities show a gap; the
  corpus is unaffected.

### 1.6 Repository layout

- `apps/` — `api`, `mcp`, `worker`, `web`, `cli`.
- `packages/` — `contracts` (Zod schemas shared by every surface), `core`
  (domain service, policy, access, conflicts, cache logic), `postgres` and
  `redis` (adapters), `cozodb` (experimental embedded backend: repository,
  token and idempotency stores).
- `ops/` — host keep-alive, hooks, backup scripts. `scripts/` — load test,
  profiling, benchmarks, evals. `evals/` — governance and retrieval gates.

### 1.7 Deployment shape

Everything runs in Docker Compose on loopback only. On the Mac mini the live
deployment is `~/mnemosyne-experiment` (dashboard on 18080, remote access via
private Tailscale Serve, never Funnel), kept alive by launchd agents for
runtime, health and encrypted backup. See `docs/macos-mini-tailscale.md`.

## 2. API

### 2.1 Surfaces and profiles

Four surfaces over one policy: REST, MCP, CLI, dashboard (which only proxies
the API). Auth profiles:

- **Owner** — bearer token, reads and governs the whole corpus, review and
  admin rights. A supplied `Authorization` header is always verified; a
  per-client token escalates to `owner`, an invalid or revoked one gets `401`.
- **Harness** — session-scoped: reads only accepted memories its session can
  reach; writes stay `pending_approval` until reviewed.
- **Anonymous** — opt-in HTTP mode (`MNEMOSYNE_MCP_REQUIRE_TOKEN=false` with
  `MNEMOSYNE_MCP_ANONYMOUS_PROFILE=harness`): the tailnet ACL is the perimeter
  and the owner-only tools are not registered at all. The anonymous profile is
  never set to `owner`.
- **Per-client tokens** are minted client-side (`npm run token:client`) against
  `POST /v1/admin/client-tokens`; only the SHA-256 hash and a prefix are
  stored.

### 2.2 REST endpoints

| Group | Endpoints |
| --- | --- |
| Sessions | `POST /v1/sessions`, `POST /v1/sessions/{id}/events`, `POST /v1/sessions/{id}/close` |
| Reading | `GET /v1/memories` (search), `GET /v1/memories/{id}`, `GET /v1/projects`, `GET /v1/projects/{id}`, `GET /v1/projects/{id}/memories`, `POST /v1/context/resolve` |
| Writing | `POST /v1/proposals`, `POST /v1/proposals/{id}/decision`, `POST /v1/memories/{id}/corrections`, `POST /v1/memories/{id}/retractions`, `POST /v1/memories/feedback` |
| Forget | `POST /v1/memories/{id}/forget/prepare`, `POST /v1/memories/{id}/forget` |
| Arcs | `POST /v1/arcs` (memory↔memory), `POST /v1/project-arcs` |
| Jobs | `GET /v1/jobs/{id}` |
| Admin | `GET /v1/admin/overview`, `GET /v1/admin/capabilities`, `GET /v1/admin/telemetry/retrieval`, `GET /v1/admin/embeddings/health`, `POST /v1/admin/embeddings/reindex`, `GET /v1/admin/memories`, `GET /v1/admin/memories/{id}`, `GET /v1/admin/projects`, `PUT /v1/admin/projects/{id}/privacy`, `POST /v1/admin/pruning/analyze`, `GET /v1/admin/conflicts`, `POST /v1/admin/conflicts/{id}/resolution`, `GET /v1/admin/arcs`, `POST /v1/admin/arcs/{arc_id}/review`, `GET /v1/admin/sessions`, `GET /v1/admin/sessions/{id}`, `GET /v1/admin/jobs`, `GET /v1/admin/jobs/{id}/attempts`, `GET /v1/admin/retention`, `POST /v1/admin/retention/run`, `POST /v1/admin/exports/corpus`, `POST /v1/admin/restore/corpus`, `POST /v1/admin/client-tokens`, `POST /v1/admin/client-tokens/{name}/revoke` |

### 2.3 MCP tools

Reading and session tools are registered for both profiles; governance and
admin tools exist only for the owner profile.

| Group | Tools |
| --- | --- |
| Reading | `memory_search`, `memory_context`, `memory_list_projects`, `memory_get_project`, `memory_list_project_memories`, `memory_get_memory` |
| Sessions | `memory_open_session`, `memory_close_session`, `memory_record_events`, `memory_feedback` |
| Writing | `memory_propose` (harness, pending), `memory_propose_owner`, `memory_propose_arc` |
| Governance | `memory_pending_review`, `memory_review_decision`, `memory_review_arc`, `memory_list_conflicts`, `memory_resolve_conflict`, `memory_correct`, `memory_retract`, `memory_prepare_forget`, `memory_forget`, `memory_export`, `memory_restore`, `memory_retention_status`, `memory_run_retention` |
| Admin | `memory_admin_capabilities`, `memory_admin_overview`, `memory_admin_memories`, `memory_admin_sessions`, `memory_admin_jobs`, `memory_get_job`, `memory_admin_retrieval_telemetry`, `memory_admin_embedding_health`, `memory_admin_reindex_embeddings` |

### 2.4 Conventions

- Every write carries an `Idempotency-Key` header (alphanumerics and dashes);
  bodies are capped at 1 MB.
- `POST /v1/proposals/{id}/decision` requires `{ "decision": "accept" |
  "reject", "expectedVersion": n }`; omitting `expectedVersion` is a `400`.
- REST proposals are born `pending_approval` even for the owner; the decision
  call accepts them (version bumps to 2). MCP `memory_propose_owner` accepts
  directly.
- Errors are `ApiProblem`/`ApiError` JSON; internals are not exposed.
- Telemetry endpoints report counts and score bands only — no query text, no
  memory ids, no corpus content, enforced by schema shape.

### 2.5 Known quirks

- **`relatedMemoryIds` on `POST /v1/proposals` is a no-op** in the
  pending→review path: the schema accepts it, no arc is created. Create arcs
  explicitly with `POST /v1/arcs`.
- **`POST /v1/arcs` returns `500 internal_error`** when `fromMemoryId` is a
  freshly accepted memory and succeeds with the reversed direction. Suspected:
  arc validation reads a corpus cache that does not yet contain the new
  memory, turning a clean `404` into a `500`. Until fixed, propose the arc
  in the reverse direction — for `relates_to` the arrow carries no meaning.
- **`ProposeMemoryArcInput` requires `sessionId`** alongside `fromMemoryId`,
  `toMemoryId` and `type`.
- Close dangling sessions (`GET /v1/admin/sessions?status=open`) after any
  failed write sequence.

## 3. Policy

### 3.1 Governance principle

The model proposes, the service decides. Memory lifecycle:

```text
candidate → pending_approval → accepted ─┬→ superseded
                            │            ├→ expired
                            └→ rejected  ├→ retracted
                                         └→ forgotten (ledger row, permanent)
```

Arcs share `pending_approval`, `accepted`, `rejected`, `retracted`. Only
accepted memories enter context; only the forget path removes content, and it
never does so silently.

### 3.2 Corpus policy: the source of truth

Mnemosyne is the single source of truth for project state, written **cold**
at the end of a work stream and read at the start of the next one.

**Belongs here**: decisions with the commits they reference; constraints
(invariant rules); measured facts with caveats and attribution; conventions,
including this policy; episodes with explicit owner approval.

**Does not belong**: mid-session procedural how-to notes (they live in the
harness's operational memory and are never mirrored here); restatements of
repository content an agent can re-derive by reading the repo; mirrored
copies of anything — content enters only through the governed path, and
stale copies marked "not revalidated" are exactly what retrieval should not
have to filter.

**Anti-duplicate check first**: before proposing, search the corpus for the
topic. A lesson written on 2026-10-26 about `Idempotency-Key` duplicated
constraint `mem_e7f8a067` from September. A duplicate in the source of truth
is worse than a missing entry: retrieval then returns two answers where one
is authoritative.

### 3.3 Reading practice

At the start of a task: `memory_get_project` for the outline, scoped `search`
for specifics. Project scoping keeps one project's answer from pulling in
another project's noise, and a harness that can only search has to guess the
terms — the project directory exists so a miss cannot look like an empty
corpus. Measured on 2026-10-26: server-local search p50 1.3–2.6 ms with a
warm cache (180 searches, 168 cache hits), one detailed decision per October
work stream retrieved 5/5 with sharp probes (`mem_f10d1d1d`).

### 3.4 Writing practice

One deliberate batch per finished stream, through the owner-direct MCP path
when the client is healthy. REST fallback from the mini, token read into a
shell variable and never echoed:

1. `POST /v1/sessions` → `sessionId`.
2. `POST /v1/proposals` → `pending_approval`.
3. `POST /v1/proposals/{id}/decision` with `{decision, expectedVersion}` →
   accepted.
4. `POST /v1/sessions/{id}/close`.

If the MCP client hangs ("timeout exceeded when trying to connect"), verify
liveness with a raw `POST initialize` against the MCP endpoint (~0.2 s, 200 =
server fine, the client bridge is the suspect) before restarting anything.

### 3.5 Privacy boundaries

Sensitivity is per memory (`normal`, `private`, `sensitive`, `secret`) and per
project (`PUT /v1/admin/projects/{id}/privacy`). Never print, commit, or
upload `.env` values, tokens, passphrases or corpus content; shell tokens stay
in variables. Services bind to loopback; remote access is private Tailscale
Serve only, never Funnel, and PostgreSQL, Redis and the graph are never
published. The anonymous MCP profile is never `owner`. The local extractor is
the default; remote providers (OpenRouter) stay off unless explicitly enabled.

## 4. Related documents

- `docs/retrieval-ranking.md` — ranking pipeline and contract.
- `docs/potatura-semantica.md` — semantic pruning design.
- `docs/v2-graph-model-plan.md`, `docs/v2-handoff.md` — the v2 graph model.
- `docs/privacy.md`, `docs/threat-model.md` — privacy and threat model.
- `docs/macos-mini-tailscale.md` — deployment and operations runbook.
- `docs/openapi.yaml` — full REST specification.
- `docs/overview.md` — narrative project overview (Italian).
