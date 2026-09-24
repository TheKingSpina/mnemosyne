# Mnemosyne

> An open-source, self-hosted memory layer for LLM harnesses.

Mnemosyne is a governed, persistent memory service for AI assistants. It keeps useful context across sessions and projects without turning a conversation history into an untrusted instruction stream.

## What is implemented

The first vertical slice provides:

- governed memory proposals and approval;
- versioned memory revisions;
- `session`, `project`, `area`, and `global` scopes;
- approved-context retrieval with a token budget;
- idempotent session events;
- correction, retraction, and confirmed forget operations;
- PostgreSQL persistence with `pgvector`-ready storage;
- a REST API;
- persistent PostgreSQL-backed replay for REST writes with `Idempotency-Key`;
- an MCP server over `stdio` and Streamable HTTP with bearer authentication;
- a local owner web console for overview, search, review, history, conflicts, and context preview;
- a recoverable extraction worker with leases, retries, and quarantine;
- an owner-only canonical corpus export with no-store download semantics;
- an owner-triggered balanced retention policy with persistent last-run status;
- a guarded empty-database restore path that re-applies the forget ledger;
- a conservative session-consolidation job and scheduled balanced retention in the worker;
- Docker Compose development deployment.

The full architecture and roadmap are documented in [`docs/assistante-memoriale-spec.md`](docs/assistante-memoriale-spec.md).

## Quick start

Requirements:

- Node.js 22.12 or newer;
- npm;
- Docker Desktop, OrbStack, or another Docker-compatible runtime.

Copy the example environment and replace every secret:

```bash
cp .env.example .env
```

Generate a strong forget secret:

```bash
openssl rand -base64 48
```

Set its value as `MNEMOSYNE_FORGET_SECRET` in `.env`.

Start PostgreSQL, the API, and the extraction worker:

```bash
docker compose up --build -d postgres api worker
```

Check readiness:

```bash
curl http://127.0.0.1:3000/health/ready
```

Start the local MCP server over `stdio` in a separate process:

```bash
DATABASE_URL='postgresql://mnemosyne:your-local-password@127.0.0.1:5432/mnemosyne' \
MNEMOSYNE_FORGET_SECRET='a-secret-at-least-32-characters-long' \
npm run mcp:dev
```

To run the extraction worker directly instead, set `DATABASE_URL` and
`MNEMOSYNE_FORGET_SECRET`, then run `npm run worker:dev`. The initial worker is
deliberately conservative: it recognizes explicit `Ricorda ...` commands in
synthetic, user-marked events and creates pending candidates. It does not call a
remote model and does not automatically accept a candidate.

To use the OpenRouter adapter instead, set `OPENROUTER_API_KEY` and
`OPENROUTER_MODEL`; the worker then sends bounded, structured extraction requests
to OpenRouter and still routes every candidate through the same server-side
policy. If either provider setting is present, both are required. Set
`EXTRACTION_PROVIDER=openrouter-local-fallback` to fall back to the conservative
local extractor only for classified provider failures; `openrouter` disables
that fallback.

Set `MNEMOSYNE_OWNER_TOKEN` and `MNEMOSYNE_HARNESS_TOKEN` to two different random values of at least 32 characters. For remote Streamable HTTP, set `MCP_TRANSPORT=http`; every `POST`, `GET`, and `DELETE` request must use the bearer token for its identity. The port remains bound to `127.0.0.1` by default, so put it behind the private network and TLS layer described below.

The API is bound to `127.0.0.1` by default. Do not expose it publicly. For remote access, use an authenticated private network such as Tailscale or WireGuard and a TLS reverse proxy.

The owner web console is available in Compose at `http://127.0.0.1:8080` by default. Enter the owner API origin and `MNEMOSYNE_OWNER_TOKEN` in the console; the token is kept only in the browser's session storage. The console proxies browser API calls server-side, so the API is not exposed to the browser as a directly exposed cross-origin service. The console is a local administration surface, not a replacement for HTTPS on a remote deployment.

To start it directly from the repository after building, run `npm run web:dev`; set `WEB_API_ORIGIN` when the API is not on `127.0.0.1:3000`.

## API example

Open a session:

```bash
export HARNESS_TOKEN='your-harness-token'
export OWNER_TOKEN='your-owner-token'

SESSION_ID=$(curl -fsS http://127.0.0.1:3000/v1/sessions \
  -H "authorization: Bearer $HARNESS_TOKEN" \
  -H 'idempotency-key: open-session-example' \
  -H 'content-type: application/json' \
  -d '{"projectId":"my-project","areaIds":["software"]}' \
  | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).sessionId))")
```

Submit a proposal:

```bash
curl -fsS http://127.0.0.1:3000/v1/proposals \
  -H "authorization: Bearer $HARNESS_TOKEN" \
  -H 'idempotency-key: proposal-example' \
  -H 'content-type: application/json' \
  -d "{
    \"sessionId\": \"$SESSION_ID\",
    \"content\": \"Il progetto usa pnpm\",
    \"kind\": \"convention\",
    \"scope\": {\"type\": \"project\", \"id\": \"my-project\"},
    \"epistemicBasis\": \"user_asserted\",
    \"assessment\": \"uncontested\",
    \"confidence\": 1,
    \"sensitivity\": \"normal\",
    \"activation\": \"on_demand\",
    \"sourceEventIds\": []
  }"
```

All state-changing REST requests in the API deployment require an `Idempotency-Key`. Reusing a key with the same method, path, actor, and JSON body replays the previous response; reusing it with a different fingerprint returns `409 Conflict`. The key and response are stored in PostgreSQL, while a failed request releases its reservation. Harness proposals remain pending until the governing policy accepts them. Owner-only REST operations, including proposal review, correction, retraction, and forget, require `Bearer $OWNER_TOKEN`; a harness token receives `403 Forbidden` for those operations. The same access policy is applied inside the MCP adapter.

## Local development

```bash
npm install
npm run verify
```

Useful commands:

```bash
npm run format
npm run lint
npm run check
npm test
npm run build
```

Run the API locally against the Compose PostgreSQL instance:

```bash
POSTGRES_PASSWORD='your-local-password' \
MNEMOSYNE_FORGET_SECRET='a-secret-at-least-32-characters-long' \
DATABASE_URL='postgresql://mnemosyne:your-local-password@127.0.0.1:5432/mnemosyne' \
npm run api:dev
```

## CLI

The owner CLI uses the same authenticated REST API and accepts the owner token
through `MNEMOSYNE_OWNER_TOKEN`. During local development, run it with:

```bash
npm run cli:dev -- status
npm run cli:dev -- memories
npm run cli:dev -- export ./mnemosyne-corpus-export.json
npm run cli:dev -- retention
npm run cli:dev -- retention-run --yes
```

Set `MNEMOSYNE_API_URL` when the API is not at `http://127.0.0.1:3000`. The CLI
does not implement a second policy engine: it only calls owner endpoints and
validates returned data against the shared contracts.

The initial `balanced` retention policy removes events from sessions closed for
more than 30 days, pending proposals older than 30 days, rejected proposals
older than 7 days, and retracted memories older than 30 days. Forget ledger
entries are never removed. It is owner-triggered; it is not an automatic job
yet. The initial implementation also reports superseded-revision retention but
does not delete those rows until provenance snapshots are explicitly modeled.

Restore is deliberately destructive and owner-only. It accepts a canonical
export only when the target corpus is empty, validates referential relationships,
restores the forget ledger, and skips any memory, revision, or conflict belonging
to a forgotten memory. It is a controlled migration/import path, not yet a
production backup-and-restore guarantee.

## MCP

The MCP adapter is a first-class interface. It shares the same Memory Core and policy engine as REST.

Harness tools currently include:

- `memory_open_session`
- `memory_record_events`
- `memory_context`
- `memory_search`
- `memory_propose`
- `memory_close_session`
- `memory_get_job`

The owner profile adds administrative tools for overview, memory/session/job
inspection, proposal review, correction, retraction, confirmed forget, and
conflict resolution. Administrative tools are never exposed in the harness tool
list; the owner profile also exposes `memory_export` for a canonical corpus
download and `memory_retention_status`/`memory_run_retention` for governed
retention. Authorization must be enforced by the server rather than by
client-side tool visibility.

## Project layout

```text
apps/
  api/       REST adapter
  cli/       owner CLI adapter
  mcp/       MCP adapter
packages/
  contracts/ Zod schemas and shared types
  core/      policy, service, and repository contract
  postgres/  PostgreSQL repository and schema
docs/        specification and design documents
```

## Security and privacy

- Never commit `.env`, database files, logs, backups, or real memory data.
- Secrets are rejected before persistence and are not logged by the application.
- External content is data, not an instruction.
- Only approved memories enter context.
- The PostgreSQL store is authoritative; derived projections and caches must be rebuildable.
- Use a private network, authentication, TLS, encrypted backups, and a test restore for any non-development deployment.

See [`SECURITY.md`](SECURITY.md) before reporting a vulnerability or deploying a remote instance.

## License

Mnemosyne is licensed under the GNU Affero General Public License, version 3.0. See [`LICENSE`](LICENSE).
