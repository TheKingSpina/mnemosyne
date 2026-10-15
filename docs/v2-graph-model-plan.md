# Migration plan — graph model: projects, areas, weighted arcs

- **Status:** Proposed
- **Date:** 2026-10-15
- **Branch:** `feat/v2-graph-model`
- **Scope:** This project is parallel and separate. The Mac mini deployment and its
  corpus are explicitly out of scope: no backfill of existing string scopes, no
  dual-read period, no backward compatibility. The schema is designed clean.

## 1. Decisions

| #   | Decision                                                                                                 | Rationale                                                                                                                                                                                                                                                                                                                                 |
| --- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1  | Identifiers stay UUIDs in `text`, exactly as they are now                                                | No requirement forces numeric identifiers: ordering comes from `created_at`, and semantic search over names works the same. Changing them would touch every table, every Zod contract, the OpenAPI document, the dashboard URLs, the MCP tool inputs and the Neo4j `MERGE` key, all for no functional gain. UUIDs are also not guessable. |
| D2  | `projects` and `areas` are first-class entities                                                          | Today `scope_id` is free text with no referential integrity, so nothing guarantees the referenced project exists.                                                                                                                                                                                                                         |
| D3  | `name` is unique per project, case-insensitively, and is **not** part of the primary key                 | Renaming a project must be a plain `UPDATE`. Coupling the name into the PK would make renames cascade to every referencing row, effectively freezing names.                                                                                                                                                                               |
| D4  | The reserved project `personal` replaces `scope_type = 'global'`                                         | `global` is not a scope family: it is the single hardcoded pair `{type:'global', id:'personal'}`. Making it a project row keeps `project_id NOT NULL` on every memory, so referential integrity is total and no query has a null-project branch. Visibility becomes a policy rule attached to that project.                               |
| D5  | Arcs are governed data in PostgreSQL; Neo4j remains a derived projection                                 | ADR 0003 establishes PostgreSQL as authoritative and `neo4j-driver` is a dependency of `apps/worker` only. Authoritative arcs in Neo4j would put them outside export, retention, and forget, and would require the API to gain a Neo4j client.                                                                                            |
| D6  | Nodes and arcs are proposed by clients and land `pending_approval`; the owner path inserts them accepted | Extends the existing `memory_propose` / `memory_propose_owner` split rather than inventing a second governance path.                                                                                                                                                                                                                      |
| D7  | Arcs connect memory to memory; scope edges stay derived                                                  | Today `IN_SCOPE` is the only structural edge. The request adds node-to-node arcs; scope membership is not user-authored and stays derived from `project_id` / `area_id`.                                                                                                                                                                  |

### Superseded

`scope_type` shrinks to `project | area | session`. For a memory the scope becomes
**derived**: `area_id IS NOT NULL` means area scope, otherwise project scope. Sessions
keep their own reference because a session is a separate governed entity with a
lifecycle.

This is deliberately _not_ the three-nullable-column shape of the PHP design. That shape
needs a mutual-exclusion CHECK because it can express an ambiguous scope. Deriving the
scope from `area_id` cannot be ambiguous, so the CHECK is unnecessary.

## 2. Order of work

Identifier shape is untouched, so the work starts directly with the entities.

1. `feat: projects and areas as first-class entities`
2. `feat: proposals carry nodes and arcs`
3. `feat: governed weighted arcs`
4. `feat: project and area roots in the Neo4j projection`
5. `docs: retire the global scope in favour of the personal project`

Commit 2 is the largest contract change and is isolated for that reason: one proposal
carrying nodes and arcs alters the Zod schemas, the OpenAPI document and the governance
tests at once, and that is not something to debug alongside a schema change.

## 3. Schema

`gen_random_uuid()` is built in from PostgreSQL 13 onwards, so no extension is required
on the `pg17` image in use.

```sql
CREATE TABLE projects (
  id text PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  description text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_projects_name UNIQUE (name)
);

CREATE UNIQUE INDEX uq_projects_name_ci ON projects (lower(name));
CREATE INDEX idx_projects_name_fts ON projects
  USING gin (to_tsvector('simple', name));

CREATE TABLE areas (
  id text PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_areas_project_name UNIQUE (project_id, name),
  CONSTRAINT uq_areas_project_id UNIQUE (project_id, id)
);

CREATE INDEX idx_areas_project ON areas (project_id);
```

The `(project_id, id)` unique constraint on `areas` exists only to carry the composite
foreign key below. It is not a second identity.

```sql
ALTER TABLE memories ADD COLUMN project_id text NOT NULL
  REFERENCES projects(id) ON DELETE CASCADE;
ALTER TABLE memories ADD COLUMN area_id text;
```

`area_id` deliberately carries **no** foreign key of its own. An earlier draft gave it
`REFERENCES areas(id)`, which is redundant: the composite constraint below already
references `areas`, so it enforces existence as well as project membership. Verified on
PostgreSQL 17 — with both constraints present the deletion of an in-use area is refused by
`memories_area_id_fkey`, which is the wrong explanation; with only the composite one it is
refused by `fk_memories_area_same_project`, which is the right one.

The composite constraint is what enforces that an area belongs to its memory's project:

```sql
ALTER TABLE memories ADD CONSTRAINT fk_memories_area_same_project
  FOREIGN KEY (project_id, area_id) REFERENCES areas(project_id, id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
```

`NO ACTION` plus `DEFERRABLE INITIALLY DEFERRED` is what makes a project cascade delete
work: `projects → areas → memories` removes both sides inside one transaction, and the
check is evaluated at commit when nothing dangling remains. Deleting an area that is
still a live scope fails at commit with `23503`, which the API maps to `409`.

```sql
CREATE TABLE arcs (
  id text PRIMARY KEY DEFAULT gen_random_uuid(),
  from_memory_id text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_memory_id text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  type text NOT NULL,
  weight real,
  lifecycle text NOT NULL DEFAULT 'pending_approval'
    CHECK (lifecycle IN ('pending_approval', 'accepted', 'rejected', 'retracted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_arcs_weight CHECK (weight IS NULL OR weight BETWEEN 0 AND 1),
  CONSTRAINT chk_arcs_distinct CHECK (from_memory_id <> to_memory_id),
  CONSTRAINT uq_arcs_triple UNIQUE (from_memory_id, to_memory_id, type)
);

CREATE INDEX idx_arcs_from ON arcs (from_memory_id);
CREATE INDEX idx_arcs_to ON arcs (to_memory_id);
CREATE INDEX idx_arcs_lifecycle ON arcs (lifecycle);
```

`uq_arcs_triple` is included deliberately. The PHP design chose _not_ to constrain the
triple, which permits duplicate parallel edges; for a weighted graph that makes weight
ambiguous and makes retrying a proposal non-idempotent.

## 4. Governance

Arcs carry the same lifecycle discipline as memories, and the proposal payload changes
shape: one proposal may contain nodes **and** the arcs between them.

- client path: proposal carries `nodes[]` and `arcs[]`, both land `pending_approval`
- owner path: same payload, both land `accepted`
- only `accepted` arcs reach the graph
- forgetting a memory cascades to its arcs in PostgreSQL, and the projection removes the
  Neo4j node with `DETACH DELETE`

## 5. Neo4j projection

Rebuilt from the outbox, never authoritative:

- `(:Project {id, name})`
- `(:Area {id, name, projectId})`
- `(Memory)-[:IN_PROJECT]->(Project)` and `(Memory)-[:IN_AREA]->(Area)`, derived from
  `project_id` / `area_id`
- `(Memory)-[:LINK {id, type, weight}]->(Memory)`, only for `accepted` arcs

## 6. Schema validation

The DDL in section 3 was executed against PostgreSQL 17 on 2026-10-15 and its behaviour
checked case by case, each rejection asserted against the constraint name that produced
it rather than against a bare error:

| Case                                             | Result                                                    |
| ------------------------------------------------ | --------------------------------------------------------- |
| project name duplicated, identical case          | refused by `uq_projects_name`                             |
| project name duplicated, different case          | refused by `uq_projects_name_ci`                          |
| memory whose area belongs to another project     | refused by `fk_memories_area_same_project`                |
| duplicate area name within a project             | refused by `uq_areas_project_name`                        |
| deleting an area still used as a scope           | refused by `fk_memories_area_same_project`                |
| arc with a valid weight                          | accepted                                                  |
| duplicate `(from, to, type)` triple              | refused by `uq_arcs_triple`                               |
| arc from a node to itself                        | refused by `chk_arcs_distinct`                            |
| weight outside `0..1`                            | refused by `chk_arcs_weight`                              |
| lifecycle outside the allowed set                | refused by the lifecycle check                            |
| area created after the memory in one transaction | accepted — confirms `DEFERRABLE INITIALLY DEFERRED` works |
| deleting a project                               | cascades, leaving `0` areas, `0` memories, `0` arcs       |

The deferred-constraint case is the one that justified writing this section down: it is
what makes the cascade work while still refusing to delete a single area out from under a
live memory.

## 7. Risks

- **Export completeness.** `restoreCorpus` does not rebuild embeddings today; after this
  change it must also restore arcs, or a restore silently returns a graph-less corpus.
- **Capability reporting.** `projections.neo4j` must keep being derived from the worker
  heartbeat, not asserted by the API.
- **Scope of the contract change.** Zod schemas, OpenAPI, MCP tool inputs and the
  dashboard all encode the proposal shape.
- **Deferrable constraints are a transaction-level tool.** They are evaluated at commit,
  so a caller that opens a transaction and forgets it will hold locks longer than a
  per-statement check would.

## 8. Out of scope

- The Mac mini deployment and its corpus
- Removing `memory_revisions` or version history
- Making Neo4j authoritative
- Arcs between projects, and hierarchical relations between projects
- Changing identifier shape
