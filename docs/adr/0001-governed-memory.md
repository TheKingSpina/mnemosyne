# ADR 0001 — Governed memory, not chat history

- **Status:** Accepted
- **Date:** 2026-09-24

## Context

Mnemosyne needs continuity across sessions and projects, but a growing conversation transcript is not a reliable memory. It contains temporary statements, unverified inferences, secrets, conflicts, and obsolete decisions.

## Decision

Use a governed memory layer:

- atomic memory revisions;
- explicit scopes: `session`, `project`, `area`, `global`;
- separate content kind, epistemic basis, assessment, confidence, sensitivity, and lifecycle;
- proposals validated by a deterministic policy;
- only approved memories injected into context;
- correction, retraction, confirmed forget, and version history;
- PostgreSQL as the authoritative store.

## Consequences

- The harness cannot turn arbitrary text into an instruction.
- Automatic extraction can be added incrementally without changing the active-context invariant.
- The system can explain why a memory is present and let the owner correct it.
- The implementation is more explicit than a simple vector store or transcript database.
