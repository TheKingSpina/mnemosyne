# ADR 0003 — PostgreSQL authority, derived projections

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

Mnemosyne needs relational consistency, versioning, lexical search, future vector search, outbox events, and a reliable recovery path. Redis and Neo4j are useful derived components, but neither should become an independent source of truth.

## Decision

Use PostgreSQL as the authoritative store. Keep the canonical memory model and relations there. Use the transactional outbox for eventual projections. Treat Neo4j, Redis, and embedding indexes as rebuildable derived data, and re-check memory state against PostgreSQL before returning active context.

## Consequences

- Restore and recovery have one authoritative database.
- A stale graph or cache can lose a result but cannot silently make a forgotten memory active.
- Projection lag is visible and operationally recoverable.
- Neo4j and Redis are not required for the first vertical slice.
