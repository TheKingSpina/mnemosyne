# Handoff — Mnemosyne v2 (graph model)

- **Branch:** `feat/v2-graph-model`, local only, never pushed
- **`main`:** `a5d357c`, untouched, identical to `origin/main`
- **Working tree:** clean
- **Last updated:** 2026-10-15
- **Design document:** [`v2-graph-model-plan.md`](./v2-graph-model-plan.md) — **partly stale, see Known gaps**

This project is parallel and separate from the deployed system. The Mac mini stays on
`main` and is explicitly out of scope: no backfill, no dual-read period, no backward
compatibility. Schema changes here are breaking and local.

## The three requirements

1. **Projects are real graph roots.** `projects` is a table, `memories.project_id` and
   `sessions.project_id` are real foreign keys, and `memories.project_id` is immutable.
2. **Areas are optional subgraph roots.** `areas` is a table, declared explicitly by
   whoever creates them. `memory_revisions.area_id` references them, and a trigger
   enforces that the area belongs to the memory's project.
3. **Weighted arcs between nodes.** `memory_arcs` and `project_arcs`, governed like
   memories, projected into Neo4j as `LINK`, and part of the corpus export.

## What is done, commit by commit

| Commit    | What it did                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------ |
| `97795af` | The migration plan `CONTRIBUTING.md` requires for a memory model change                                |
| `fe27cce` | `projects` and `areas` as tables, `sessions.project_id` as a foreign key                               |
| `34507ab` | Project membership declared as identity, area rule moved to a trigger                                  |
| `2428ffd` | A session may only scope to declared areas of its own project                                          |
| `939e10f` | `memories.project_id` NOT NULL and immutable; project carried in the export                            |
| `de31e63` | `scope_type`/`scope_id` dropped; scope derived from `area_id`/`session_id`                             |
| `0434e88` | `memory_arcs`, `project_arcs`, `hierarchical_relation`, cycle prevention, projection, export, API, MCP |

## Decisions that are not obvious from the code

**Cycles are allowed, except where a relation type declares itself hierarchical.**
Two memories influencing each other is ordinary, and the request settled this
explicitly. `hierarchical_relation` holds the types that must stay acyclic, so
declaring another one is a row and not a migration. The refusal is a trigger with a
recursive walk using `UNION` and not `UNION ALL`, deliberately: deduplication is what
makes the walk terminate on data that already contains a cycle, which is the case a
trigger has to report rather than hang on. `pg_advisory_xact_lock` serialises the walk,
because without it two transactions inserting the opposite halves of a cycle both read
the pre-commit state and both pass.

**The area rule needs a trigger, not a foreign key.** It spans two tables
(`memories.project_id` and `memory_revisions.area_id`), and a foreign key cannot
reference columns from two relations. It raises `23503`, the SQLSTATE a foreign key
violation raises, so the API maps it to 409 through the existing path.

**`project_id` is denormalised onto `memory_revisions`, and a trigger maintains it.** The
search filter pushes the full-text match into a `MATERIALIZED` CTE over
`memory_revisions` alone; joining `memories` in there is exactly what once made the
planner ignore the GIN index, measured at 69 ms against 2.1 ms for the same filter at
10,000 memories. The copy is written by a trigger that overwrites whatever a caller
supplied, so it cannot disagree. That trade keeps a measured 29x.

**The corpus export carries projects and arcs.** Both are corpus content, not graph
internals. Without them a restore returns a corpus with no roots and no relations and
says nothing about it. This was the bug pattern hit twice while building it: the restore
broke first on missing projects, then on missing project ids.

## Verified state

All green at `0434e88`:

- `npm run verify` — 204 passed, 1 skipped
- `npm run e2e:synthetic` — OK, including psql assertions for the schema constraints,
  project immutability, cross-project scope isolation, influence cycles allowed and
  hierarchy cycles refused
- `npm run eval:all` — governance 9/9, retrieval 11/11 at nDCG 1.0, dataset hash
  unchanged at `618867745ccf`

## Known gaps, in the order they should be closed

1. **The dashboard does not show arcs.** They exist end to end through the API, but the
   graph view loads only `/v1/admin/memories` and `/v1/admin/conflicts`, so arcs never
   appear. Entry points are `loadGraph`, `buildGraphView` and `drawGraphCanvas` in
   `apps/web/src/index.html`.
2. **The design document is stale.** Its schema section still describes one `arcs` table
   and predates the trigger discovery. Its "out of scope" section still says project arcs
   are excluded, which is no longer true. Update it or the next reader will be misled.
3. **The v2 is undocumented.** `docs/assistante-memoriale-spec.md` sections 8.7 and 9
   describe entities and governance and still describe the old model. `AGENTS.md` is the
   Mac mini runbook and deliberately does not mention the v2, because the v2 is parallel
   and separate.
4. **`scope_type = 'global'` still exists** and is derived from the reserved `personal`
   project. Retiring it from the contract is a deliberate separate step, because it
   changes the public scope enum.

## How to work on this

- Work on `feat/v2-graph-model`. `main` is the deployment and must not move.
- **Run `npm run build` after each logical change, not after a batch.** Seven times in
  this work the tree was left broken by batching edits and only compiling at the end; five
  of those would have been caught immediately by a build. `npx vitest run <file>` after
  touching a single test file is the cheap inner loop.
- **Never add a function without calling it.** An E2E check was added and left
  uncalled, so it would have passed forever without running.
- Run the schema through a scratch PostgreSQL before building on it. Applying the DDL
  found a redundant foreign key that would have rejected deletions with the wrong
  explanation, and it is how the deferrable-constraint behaviour was verified rather than
  assumed.
- The local stack runs on the laptop only. The Mac mini is on `a5d357c` and knows nothing
  about any of this.
