# Handoff — Mnemosyne v2 (graph model)

- **Branch:** `feat/v2-graph-model`, local only, never pushed
- **`main`:** `a5d357c`, untouched, identical to `origin/main`
- **Working tree:** clean
- **Last updated:** 2026-10-16 (gaps closed)
- **Design document:** [`v2-graph-model-plan.md`](./v2-graph-model-plan.md) — current
- **Spec:** [`assistante-memoriale-spec.md`](./assistante-memoriale-spec.md) §§7/8.7/9.2/10.4/12.1/13.2 — current

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
   memories, projected into Neo4j as `LINK`, part of the corpus export, and drawn in
   the owner dashboard graph.

All three are done, including the scope-enum retirement and the projection roots
that were still open at the previous handoff.

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
| `d7849b8` | This handoff, first version                                                                            |
| `97bdc83` | The plan describes the arcs that were actually built                                                   |
| `6ce82f7` | The dashboard draws memory arcs; `GET /v1/admin/arcs` lists them all                                   |
| `ead27be` | Scope type `global` retired in favour of the personal project                                          |
| `4056448` | Project and area roots in the Neo4j projection                                                         |
| `5afc21b` | Areas travel in the corpus export and restore                                                          |
| `0701ffd` | Spec, README and changelog describe the v2 that was built                                              |
| `abcd2fc` | The synthetic flow accounts for the third lifecycle memory                                             |
| `8480e08` | Eval datasets use the personal project instead of global                                               |
| `8561371` | Restored projects keep their names                                                                     |
| `b72ec97` | The dashboard draws projects and the arcs between them                                                 |
| `7485661` | Areas link to their project in the Neo4j projection                                                    |
| `47c9200` | AGENTS.md points at the parallel v2 work                                                               |
| `428748c` | Fix: restore the dropped `resolved` binding in the graph canvas                                        |

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

**The corpus export carries projects, areas and arcs.** All three are corpus content,
not graph internals. Each gap announced itself the same way: the restore broke on
missing projects, then on missing project ids, then — once the first area-scoped
memory went through a restore — on a missing area with a 500 from the area trigger.
A restore that silently drops any of them returns a corpus that fails its own
invariants and says nothing about it.

**Retiring `global` was a rename, not a resemanticisation.** `global` was readable
and writable from every session, so project `personal` stays readable and writable
from every session: the scope list carries it as policy and the write path keeps the
same carve-out. Removing the write path inside a rename would have broken
"ricorda globalmente" with a loud `scope_not_available`, which is a behaviour change
smuggled into a contract change. The scope enum is now `session | project | area`.

**Inline dashboard scripts fail silently through every gate but the browser.**
The memory-arc patch dropped a `const` while keeping its uses. Non-conflict
edges never evaluate that branch, so the draw harness passed without a
conflict edge, and prettier does not check undefined names in inline HTML.
In production every draw reaching a conflict edge threw after painting the
earlier edges: nodes never painted, fit and labels dead, pointer handlers
broke mid-gesture. The console named it in one line. The harness now draws a
conflict edge, which throws on the old code.

**Cypher needs `WITH` between `SET` and `MATCH`.** The area-edge query put `MATCH`
after `SET`, which Neo4j refuses. The write threw on every attempt, the outbox batch
never marked processed, and the Area node never appeared while everything else
looked fine. Build and unit tests cannot see this — there is no Cypher parsing
anywhere — and the synthetic E2E caught it because it polls the live graph. That is
what the E2E is for.

## Verified state

- `npm run verify` — 205 passed, 1 skipped
- `npm run e2e:synthetic` — OK, with a third area-scoped lifecycle memory: one
  Project node, one Area node, three `IN_PROJECT` edges and one `IN_AREA` edge
  polled from the live graph, plus the schema-constraint psql assertions
- `npm run eval:all` — governance 9/9, retrieval 11/11 at nDCG 1.0; the retrieval
  dataset hash moved `618867745ccf` → `fe1369c0cd5e` because the judged sets now
  use project `personal`, and the hash is reported, not pinned
- Projection roots verified live against the laptop stack: scratch project, area
  and two memories created through the API, `rebuild()` asserted node and edge
  counts in Neo4j, every scratch row deleted afterwards

## Known gaps

All four minor gaps named here are closed: project arcs are drawn in a band
of their own above the scope clusters (`GET /v1/admin/projects` feeds it),
restored projects keep their names (full rows upserted, export as truth on
conflict), areas link with `(Area)-[:PART_OF]->(Project)`, and `AGENTS.md`
carries a pointer-only section with the rule that mini operations stay on
`main`.

What remains is future work, not debt:

1. **Merge strategy toward `main`, if ever.** The branch is local-only by
   decision. Merging touches the mini deployment and needs an explicit call,
   a migration story for the existing corpus, and a cutover plan.
2. **Dashboard project layer depth.** Project nodes exist only for projects
   that touch an arc; a corpus with hundreds of arc-less projects shows none.
   Widening that is a product choice about clutter, not a missing piece.

## How to work on this

- Work on `feat/v2-graph-model`. `main` is the deployment and must not move.
- **Run `npm run build` after each logical change, not after a batch.** The tree
  was left broken repeatedly by batching edits and only compiling at the end.
  `npx vitest run <file>` after touching a single test file is the cheap inner loop.
- **Never add a function without calling it.** An E2E check was added and left
  uncalled, so it would have passed forever without running.
- **Run the E2E before declaring a projection change done.** Cypher is
  stringly-typed as far as every other gate is concerned; only the live graph
  checks it.
- Run the schema through a scratch PostgreSQL before building on it.
- The local stack runs on the laptop only. The Mac mini is on `a5d357c` and knows nothing
  about any of this.
