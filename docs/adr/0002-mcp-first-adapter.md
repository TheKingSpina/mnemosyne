# ADR 0002 — MCP is a first-class adapter

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

LLM harnesses need a standard way to request memory, propose candidates, and receive structured context. REST remains useful for administration and integration, but it should not create a second policy engine.

## Decision

Implement MCP as a first-class adapter over the same Memory Core used by REST and the future CLI. The initial transport is `stdio`; the contract also targets Streamable HTTP. Harness and owner profiles expose different tool sets.

## Consequences

- A harness can use Mnemosyne as a normal MCP server.
- REST and MCP cannot diverge in policy behavior.
- Owner-only tools are not present in the harness profile.
- The MCP contract must remain versioned and avoid exposing raw database queries.
