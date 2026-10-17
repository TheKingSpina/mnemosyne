# 🏛️ Mnemosyne

> **Governed, High-Performance Long-Term Memory & Knowledge Graph Engine for AI Harnesses and Autonomous Agents**

[![License: AGPL-3.0](https://img.shields.io/badge/License-AGPL--3.0-blue.svg)](LICENSE)
[![Node.js Version](https://img.shields.io/badge/Node.js-%3E%3D22.12-brightgreen.svg)](package.json)
[![TypeScript Strict](https://img.shields.io/badge/TypeScript-5.9%20Strict-blue.svg)](tsconfig.json)
[![Memgraph C++](https://img.shields.io/badge/Graph_Engine-Memgraph_C%2B%2B-red.svg)](https://memgraph.com/)
[![Apple Silicon Metal](https://img.shields.io/badge/Local_LLM-Metal_Accelerated-black.svg)](ops/host/)
[![Model Context Protocol](https://img.shields.io/badge/MCP-Streamable_HTTP_%26_stdio-purple.svg)](apps/mcp/)

---

## ⚡ Overview

**Mnemosyne** is a production-grade, self-hosted memory layer designed to give AI coding assistants and autonomous agents long-term, cross-session continuity without corrupting context windows or introducing security vulnerabilities.

### The Problem It Solves

Modern AI coding harnesses ([Claude Code](https://claude.ai/), [Cursor](https://cursor.com/), [OpenCode](https://github.com/opencode-ai), [Windsurf](https://codeium.com/windsurf)) suffer from critical memory limitations:

1. **Context Amnesia**: Every new session starts from zero; decisions, conventions, and architectural trade-offs are forgotten.
2. **Context Window Bloat & Poisoning**: Naive chat dumps waste token budgets and treat untrusted user or tool outputs as authoritative system instructions.
3. **Flat Vector Silos**: Standard vector databases retrieve disconnected fragments without understanding relationships, hierarchies, or scope boundaries.
4. **Silent Contradictions**: As projects evolve, stale memories contradict current ones, causing agent confusion and hallucinations.

### The Mnemosyne Solution

Mnemosyne replaces ad-hoc memory with a **governed, hierarchical, and hardware-efficient architecture**:

- **Authoritative CQRS Core**: PostgreSQL 17 with `pgvector` acts as the single source of truth (append-only revisions, transactional outbox, and cryptographic forget tombstones).
- **Sub-Millisecond Knowledge Graph**: High-performance **Memgraph C++** engine delivers `0.35ms` multi-hop traversals across Projects, Areas, and Governed Arcs while consuming less than 80 MB of RAM.
- **Strict Epistemic Governance**: Untrusted input is strictly treated as data, never instructions. Memories progress through an explicit state machine (`proposed` → `pending` → `approved` → `superseded`/`retracted`/`expired`).
- **Deterministic Conflict Quarantine**: Contradictory statements (such as universal denials vs. affirmations) are detected deterministically, quarantined with `assessment = disputed`, and formatted with in-band safety warnings in agent prompts.
- **On-Demand Local LLMs with 0 MB Idle RAM**: Native `llama.cpp` daemon running with Apple Silicon Metal acceleration wakes on demand for cross-encoder reranking (`bge-reranker-v2-m3`) and consolidation (`gemma-3-4b-it`) in `<1.2s`, instantly freeing unified memory when idle.
- **First-Class MCP Support**: Native Model Context Protocol over `stdio` and Streamable HTTP (SSE) with granular Role-Based Access Control (`owner` vs. `harness`).
- **Private Zero-Trust Perimeter**: Tailscale Serve native integration, loopback-only service bindings, AES-256-GCM encrypted backups, and zero external telemetry.

---

## 🏗️ System Architecture

Mnemosyne is built on a **Command Query Responsibility Segregation (CQRS)** pattern. Write operations are committed to PostgreSQL, which emits events via a transactional outbox to populate read projections and graph topologies.

```mermaid
flowchart TD
    subgraph Clients ["Clients & AI Harnesses"]
        CC["Claude Code"]
        OC["OpenCode"]
        CR["Cursor / Windsurf"]
        WEB["Owner Web Dashboard"]
        CLI["Owner CLI"]
    end

    subgraph Gateway ["Transport & Security Gateway"]
        MCP["MCP Server<br/>(stdio & Streamable HTTP)"]
        REST["REST API<br/>(Express + Zod + Idempotency-Key)"]
        AUTH{"RBAC & Token Guard<br/>(Owner vs Harness)"}
    end

    subgraph Core ["Authoritative Core (PostgreSQL 17)"]
        PG_REV[("Memory Revisions<br/>& Epistemic State")]
        PG_VEC[("pgvector<br/>Semantic Index")]
        PG_OUT[("Transactional Outbox<br/>(SKIP LOCKED Leases)")]
        PG_FORGET[("HMAC-SHA256<br/>Forget Ledger")]
    end

    subgraph Projections ["High-Speed Projections & Caches"]
        REDIS[("Redis 7<br/>Revision-Validated Corpus Cache")]
        MEMGRAPH[("Memgraph C++<br/>Projects, Areas, Governed Arcs")]
    end

    subgraph Workers ["Background Workers & Local Inference"]
        WRK["Worker Process<br/>(Retention, Consolidation, Pruner)"]
        LLAMA["Host llama-lazy-manager<br/>(Apple Silicon Metal)"]
        RERANK["bge-reranker-v2-m3<br/>(Cross-Encoder)"]
        GEMMA["gemma-3-4b-it<br/>(Local Extractor)"]
    end

    Clients --> Gateway
    MCP --> AUTH
    REST --> AUTH
    AUTH --> Core

    Core -.->|"Outbox Stream"| WRK
    WRK -->|"Cypher Projections"| MEMGRAPH
    Core -.->|"Invalidation"| REDIS

    REST & MCP -->|"1.3ms Read"| REDIS
    REST & MCP -->|"0.35ms Traversal"| MEMGRAPH
    REST & MCP -->|"Hybrid Search"| Core

    WRK & REST -->|"On-Demand Socket"| LLAMA
    LLAMA --> RERANK & GEMMA
```

---

## 🌟 Key Capabilities

### 1. Hierarchical Graph Model (V2)

Knowledge is organized into a clean, deterministic hierarchy rather than a flat vector space:

- **Projects (`PROJECT`)**: Immutable root boundaries. A reserved `personal` project is accessible across all sessions.
- **Areas (`AREA`)**: Scoped domain subgraphs within projects (e.g., `software`, `ops`, `legal`).
- **Memories (`MEMORY`)**: Epistemic knowledge nodes connected via directed, weighted **Governed Arcs**:
  - `supersedes`: Explicitly supersedes older revisions.
  - `supports`: Evidential corroboration with weight `0.0` - `1.0`.
  - `depends_on`: Prerequisites and environmental requirements.
  - `relates_to`: Associative knowledge links.

### 2. Epistemic Lifecycle & Anti-Poisoning

Untrusted tool outputs and chat logs cannot silently alter the agent's baseline knowledge:

```
[Proposal] ──> [Pending Review] ──> [Approved] ──┬──> [Superseded]
                      │                           ├──> [Retracted]
                      └──> [Rejected]             └──> [Expired]
```

- Every proposal records its **epistemic basis**: `user_asserted`, `deduced`, or `observed`.
- Harness sessions can only submit proposals; promotion to active memory requires owner governance or approved policy.
- Proposals undergo duplicate deduplication and conflict verification before reaching active status.

### 3. Deterministic Conflict Quarantine

Mnemosyne automatically detects contradictions between new proposals and active memories (e.g., universal denial vs. qualified affirmation):

- Detected conflicts immediately quarantine the memory by setting its assessment to `disputed`.
- Context formatting prepends safety markers directly into the LLM prompt:
  ```text
  [DISPUTED / CONTRADICTION DETECTED - PROCEED WITH CAUTION]
  Memory #mem_abc123 asserts: "The service runs on port 8080"
  Conflict #mem_xyz789 asserts: "Port 8080 is reserved; service must bind to 18080"
  ```
- This prevents agents from blindly following contradictory instructions.

### 4. Multi-Stage Hybrid Retrieval

Context retrieval combines lexical precision, semantic recall, and cross-encoder reranking:

1. **PostgreSQL GIN Full-Text Search**: Optimized `websearch_to_tsquery` and `ts_rank_cd` via `MATERIALIZED` CTEs, executing in under `2.5ms`.
2. **pgvector Semantic Search**: Local cosine similarity matching across embedding vectors.
3. **Lexical Fusion**: BM25 scoring with language-aware stemming, proximity bonuses, and stopwords filtering.
4. **Cross-Encoder Reranking**: `bge-reranker-v2-m3` evaluates query-passage relevance with cross-attention.
5. **Token Budget Fitting**: Formats highest-value memories within the harness's declared token budget.

### 5. On-Demand Metal LLMs (0 MB Idle RAM)

Running continuous LLM instances on a Mac mini wastes valuable unified memory. Mnemosyne includes `llama-lazy-manager.mjs` running via `launchd`:

- **Zero Idle Footprint**: `0 MB` RAM consumed when no inference is occurring.
- **Instant Activation**: Awakens `llama-server` with Apple Silicon Metal acceleration in `<1.2s` upon receiving a request.
- **Auto-Unload**: Automatically terminates the server process after an inactivity timeout (default 300s).

### 6. Cryptographic Forget & Right-to-be-Forgotten

When a memory is forgotten:

- An irreversible HMAC-SHA256 tombstone is written to `forget_ledger`.
- The memory content, revisions, and embeddings are purged from PostgreSQL.
- Derived Redis cache keys, outbox events, and Memgraph edges are purged immediately.
- Corpus restores and backups enforce tombstones, preventing forgotten data from re-emerging.

---

## 📊 Hardware Footprint & Benchmarks

Measured on an **Apple M1 Mac mini (8 GB Unified RAM)** running macOS and Docker:

| Component                | Technology            | Memory (RAM)    | Throughput / Latency                     | Purpose                        |
| :----------------------- | :-------------------- | :-------------- | :--------------------------------------- | :----------------------------- |
| **Memgraph**             | In-Memory C++         | **~50 - 80 MB** | **0.35 ms** p50 traversal, 4,050 nodes/s | Real-time Cypher Graph Engine  |
| **PostgreSQL 17**        | C + pgvector          | **~75 MB**      | **2.3 ms** isolated FTS, 545 writes/s    | Authoritative Source of Truth  |
| **Redis 7**              | In-Memory C           | **~18 MB**      | **1.3 ms** p50 cached query              | Revision-validated read cache  |
| **Node.js Services**     | API, Worker, Web, MCP | **~100 MB**     | Sub-millisecond routing                  | REST, MCP & Background Jobs    |
| **Base Infrastructure**  | _Docker Total_        | **~245 MB**     | **Negligible system overhead**           | **Full 24/7 background stack** |
| **Local LLM (Idle)**     | `llama-lazy-manager`  | **0 MB**        | **0% CPU / 0 MB Unified RAM**            | Completely inactive when idle  |
| **`bge-reranker-v2-m3`** | Metal GGUF (Active)   | ~1.1 GB Unified | ~12 ms batch latency                     | Cross-Encoder Reranking        |
| **`gemma-3-4b-it`**      | Metal GGUF (Active)   | ~2.5 GB Unified | ~42 tokens/s generation                  | Semantic Pruning & Extraction  |

> [!NOTE]
> Replacing Neo4j (JVM ~600 MB) with Memgraph C++ (~60 MB) reduced graph memory consumption by **10x** while accelerating multi-hop traversal speeds by **4x**.

---

## 🚀 Quick Start

### Prerequisites

- [Node.js](https://nodejs.org/) `>= 22.12`
- `npm` `>= 10.0`
- Docker runtime ([OrbStack](https://orbstack.dev/) or Docker Desktop)

### 1. Clone & Bootstrap Environment

```bash
git clone https://github.com/TheKingSpina/mnemosyne.git
cd mnemosyne
npm install
npm run env:init
```

### 2. Start Infrastructure

Launch the full stack with Docker Compose:

```bash
docker compose up --build -d
```

Verify service readiness:

```bash
curl -fsS http://127.0.0.1:3000/health/ready
```

### 3. Open Owner Dashboard

Navigate to `http://127.0.0.1:18080` (or your configured `$WEB_PORT`). Enter your `MNEMOSYNE_OWNER_TOKEN` to inspect:

- Interactive Canvas Knowledge Graph
- Memory and Revision Explorer
- Conflict & Quarantine Management
- Retrieval Context Simulator

---

## 🔌 Harness & MCP Integration

Mnemosyne natively supports the [Model Context Protocol (MCP)](https://modelcontextprotocol.io/).

### Tools Provided

| Tool Name              | Profile | Description                                                    |
| :--------------------- | :------ | :------------------------------------------------------------- |
| `memory_open_session`  | Harness | Starts a session scoped to a project and optional areas        |
| `memory_record_events` | Harness | Records raw conversation events for background extraction      |
| `memory_context`       | Harness | Retrieves token-budgeted approved context and active conflicts |
| `memory_search`        | Harness | Semantic + lexical hybrid memory search                        |
| `memory_propose`       | Harness | Submits candidate memories for governance approval             |
| `memory_close_session` | Harness | Closes the session and triggers consolidation                  |
| `memory_propose_arc`   | Harness | Submits relationships between existing memories                |
| `memory_export`        | Owner   | Canonical JSON corpus export (no-store download)               |
| `memory_forget`        | Owner   | Cryptographic irreversible memory deletion                     |
| `memory_admin_*`       | Owner   | Direct administrative review, retention, and inspection        |

### Configuration Examples

#### Claude Code

Add to your Claude Code configuration:

```bash
claude mcp add mnemosyne http://127.0.0.1:3333/mcp \
  --header "Authorization: Bearer <YOUR_HARNESS_TOKEN>"
```

#### OpenCode (`~/.config/opencode/opencode.jsonc`)

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "mcp": {
    "mnemosyne": {
      "type": "remote",
      "url": "http://127.0.0.1:3333/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_HARNESS_TOKEN>",
      },
    },
  },
}
```

#### Cursor & Windsurf (`mcp.json`)

```json
{
  "mcpServers": {
    "mnemosyne": {
      "url": "http://127.0.0.1:3333/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_HARNESS_TOKEN>"
      }
    }
  }
}
```

#### Local `stdio` Transport

```json
{
  "mcpServers": {
    "mnemosyne": {
      "command": "node",
      "args": ["/path/to/mnemosyne/apps/mcp/dist/index.js"],
      "env": {
        "DATABASE_URL": "postgresql://mnemosyne:secret@127.0.0.1:5432/mnemosyne",
        "MNEMOSYNE_FORGET_SECRET": "your-forget-secret-at-least-32-chars",
        "MCP_PROFILE": "harness"
      }
    }
  }
}
```

---

## 🛠️ CLI & Operations

### Owner CLI

Mnemosyne includes a zero-dependency administrative CLI:

```bash
# Check cluster status and projection health
npm run cli:dev -- status

# List active memories
npm run cli:dev -- memories

# Export canonical corpus
npm run cli:dev -- export ./backup-corpus.json

# Trigger balanced retention run
npm run cli:dev -- retention-run --yes

# Set project privacy classification
npm run cli:dev -- project-privacy my-project local_only --yes
```

### Encrypted Backups

Generate an authenticated, encrypted PostgreSQL archive:

```bash
npm run backup:postgres -- \
  --output /var/backups/mnemosyne-$(date +%Y%m%d).dump \
  --encrypt \
  --passphrase-file ~/.mnemosyne/backup.pass \
  --verify-restore \
  --keep-last 14
```

---

## 🧪 Developer Guide & Quality Gates

Mnemosyne enforces strict CI/CD quality gates across TypeScript types, formatting, license compliance, secret scanning, and end-to-end integration:

```bash
# Verify formatting, linting, typecheck, licenses, secrets, and unit tests
npm run verify

# Run synthetic end-to-end suite with dynamic port allocation & Memgraph verification
npm run e2e:synthetic

# Run governance and retrieval ranking evaluation gates
npm run eval:all

# Generate OpenAPI 3.1 contract from Zod schemas
npm run openapi:generate
```

### Repository Layout

```text
mnemosyne/
├── apps/
│   ├── api/            # REST API (Express, Zod, Idempotency-Key)
│   ├── cli/            # Administrative Owner CLI
│   ├── mcp/            # Model Context Protocol Server (stdio & HTTP)
│   ├── web/            # Owner Web Dashboard (Native Canvas Graph)
│   └── worker/         # Background Worker (Outbox, Retention, Pruner)
├── packages/
│   ├── contracts/      # Shared Zod schemas, OpenAPI metadata & types
│   ├── core/           # Business logic, state machines & policy engine
│   ├── postgres/       # PostgreSQL schema, migrations & pgvector client
│   └── redis/          # Rebuildable derived cache client
├── ops/
│   ├── host/           # macOS LaunchAgent templates & llama-lazy-manager
│   └── backup/         # Backup automation scripts
├── scripts/            # E2E synthetic tests, benchmarks & token tooling
└── docs/               # In-depth architectural & operational manuals
```

---

## 📚 Documentation Reference

For in-depth operational guides and architectural deep dives:

- 📖 **[V2 Architecture Reference Manual](docs/v2-architecture-reference-manual.md)**: Comprehensive guide on CQRS, Memgraph C++, conflict quarantine, and epistemic state machines.
- 🍏 **[macOS M1 & Tailscale Runbook](docs/macos-mini-tailscale.md)**: Operational guide for private Tailscale Serve deployment and LaunchAgents.
- 🎯 **[Retrieval & Hybrid Ranking](docs/retrieval-ranking.md)**: Mathematics and benchmarks for lexical BM25 + pgvector + cross-encoder reranking.
- ✂️ **[Semantic Pruning & Retention](docs/potatura-semantica.md)**: Conservative decay, privacy boundaries, and deterministic pruning vetoes.
- 💾 **[Backup & Disaster Recovery](docs/backup-restore.md)**: AES-256-GCM encrypted dumps, SHA-256 manifests, and empty-state restore.

---

## 🔒 Security & Privacy

- **Perimeter First**: Mnemosyne binds to loopback (`127.0.0.1`) by default. Remote access must always use private VPNs (Tailscale, WireGuard) with TLS reverse proxying. Never expose raw database or service ports to the internet.
- **Untrusted Input Isolation**: Conversation text is data, not instructions. Prompt injection attempts cannot promote candidates to approved status without passing governance.
- **Privacy Tiers**: Projects and memories default to `local_only`. External LLM analyzers (if enabled) only ever receive explicitly marked `anonymized` or `public` items.
- **Zero Telemetry**: No usage metrics, phone-home checks, or corpus content are ever transmitted outside your self-hosted host.

For vulnerability reports, please consult [SECURITY.md](SECURITY.md).

---

## 📄 License

Mnemosyne is licensed under the **GNU Affero General Public License, version 3.0 (AGPL-3.0)**. See [LICENSE](LICENSE) for details.
