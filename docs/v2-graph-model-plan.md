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

### Project membership is identity, not content

A memory does not change project, ever. That settles where the column lives: project is
an attribute of the **memory**, not of a revision, because a revision that could change it
would let history contradict identity.

- `memories.project_id` is `NOT NULL` and immutable.
- `memory_revisions.area_id` and `memory_revisions.session_id` are nullable and **may**
  change between revisions: re-classifying a memory inside its own root is a revision,
  moving it to another root is not.

Immutability is enforced by a trigger, not only by the absence of an update path, so a
future code path cannot quietly break the invariant.

Relations between different projects are expressed with arcs, never by moving a memory:

- `project_arcs` for project to project, including hierarchical relations;
- `memory_arcs` for memory to memory, and it **may cross projects**, since a memory in one
  project can legitimately depend on a memory in another.

Two tables rather than one polymorphic pair, because a polymorphic `from_id`/`to_id` can
carry no foreign key at all, and then forgetting a memory leaves dangling arcs.

`global` disappears as a scope type. It is not a family of scopes but one hardcoded pair,
and it becomes the reserved `personal` project: visibility from every session is a policy
attached to that project rather than a scope kind.

## 2. Order of work

1. `feat: projects and areas as first-class entities` — **done, `fe27cce`**
2. `feat: a memory belongs to a project, permanently`
3. `feat: proposals carry nodes and arcs`
4. `feat: governed weighted arcs, within and across projects`
5. `feat: project and area roots in the Neo4j projection`
6. `docs: retire the global scope in favour of the personal project`

Commit 2 is a breaking schema change: `memories.project_id` is `NOT NULL`, and an
existing corpus cannot be migrated mechanically, because the old `scope_id` was free text
with nothing to map it against. It therefore requires an empty or reset database, which is
recorded here rather than discovered at deploy time. The Mac mini is out of scope and
stays on `main`, so nothing in production depends on it.

Commit 3 is the largest contract change and is isolated for that reason: one proposal
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
-- Breaking: NOT NULL with no default, so it applies to an empty database.
ALTER TABLE memories ADD COLUMN project_id text NOT NULL
  REFERENCES projects(id) ON DELETE RESTRICT;
ALTER TABLE memory_revisions ADD COLUMN area_id text;
ALTER TABLE memory_revisions ADD COLUMN session_id text
  REFERENCES sessions(id) ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;
```

`memories.project_id` carries `ON DELETE RESTRICT`, not `CASCADE`. A cascade would delete
memories without writing a forget-ledger row, and the ledger is the record that a memory
was ever removed; silently cascading would make it incomplete. Deleting a project that
still holds memories has to be an explicit, governed act.

### The area rule needs a trigger, not a foreign key

The rule "the area of a memory belongs to that memory's project" spans two tables:
`memories.project_id` and `memory_revisions.area_id`. A foreign key cannot reference
columns from two relations, so the composite constraint an earlier draft of this plan used
is **not expressible** once project became immutable identity on `memories`.

That is a direct consequence of the decision above rather than an oversight, and it is why
the two columns cannot simply be colocated:

- colocating them would put `project_id` on `memory_revisions`, where a later revision
  could name a different project and contradict the memory identity;
- keeping them apart means the rule can only be enforced by a trigger.

```sql
CREATE OR REPLACE FUNCTION memoria_areas_tiene_progetto() RETURNS trigger AS $$
DECLARE memoria_progetto text;
BEGIN
  IF NEW.area_id IS NULL THEN RETURN NEW; END IF;
  SELECT project_id INTO memoria_progetto FROM memories WHERE id = NEW.memory_id;
  IF NOT EXISTS (
    SELECT 1 FROM areas WHERE id = NEW.area_id AND project_id = memoria_progetto
  ) THEN
    RAISE EXCEPTION 'area_not_in_project: % is not an area of project %',
      NEW.area_id, memoria_progetto USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_memoria_areas_tiene_progetto
  BEFORE INSERT OR UPDATE OF area_id ON memory_revisions
  FOR EACH ROW EXECUTE FUNCTION memoria_areas_tiene_progetto();
```

`23503` is deliberate: it is the SQLSTATE a foreign key violation raises, so the API maps
it to `409` through the existing path instead of needing a new branch.

A trigger is less visible than a constraint and it is the honest tool here, but the cost is
that nothing in a schema listing shows the rule. It therefore has to be covered by a test,
or it is decoration.

Deleting an area that is still the scope of some memory fails at commit with `23503`,
because the session reference above is deferrable and evaluated at commit.

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
| memory whose area belongs to another project     | refused by `trg_memoria_areas_tiene_progetto`             |
| duplicate area name within a project             | refused by `uq_areas_project_name`                        |
| deleting an area still used as a scope           | refused by `23503` at commit                              |
| arc with a valid weight                          | accepted                                                  |
| duplicate `(from, to, type)` triple              | refused by `uq_arcs_triple`                               |
| arc from a node to itself                        | refused by `chk_arcs_distinct`                            |
| weight outside `0..1`                            | refused by `chk_arcs_weight`                              |
| lifecycle outside the allowed set                | refused by the lifecycle check                            |
| area created after the memory in one transaction | accepted — confirms `DEFERRABLE INITIALLY DEFERRED` works |
| deleting a project that holds memories           | refused by `RESTRICT`                                     |

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
