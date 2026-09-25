# Mnemosyne Mac Mini Agent Instructions

## Mission

Operate Mnemosyne on an Apple M1 Mac mini with 8 GB RAM using Docker Compose and private Tailscale access. The detailed runbook is [`docs/macos-mini-tailscale.md`](docs/macos-mini-tailscale.md).

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
