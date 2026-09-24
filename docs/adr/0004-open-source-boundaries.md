# ADR 0004 — Public software, private data

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

The software is open source and self-hosted, but a real deployment contains sensitive conversations, memories, embeddings, provider responses, and backups.

## Decision

Publish only source code, synthetic tests, documentation, and configuration examples. Keep `.ori`, `.env`, databases, logs, backups, and real data outside version control and deployment artifacts. The project is distributed under AGPL-3.0 and uses private authenticated administration boundaries.

## Consequences

- Public CI cannot test private deployments.
- The repository must include secret scanning and data-hygiene checks.
- Operators remain responsible for their own backups, retention, and provider policies.
- A public hosted service would require a separate security review.
