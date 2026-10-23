CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS corpus_state (
  id text PRIMARY KEY,
  epoch uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO corpus_state (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS retention_state (
  id text PRIMARY KEY,
  last_run_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO retention_state (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;

-- Projects are graph roots: every session, and every memory through its
-- revisions, belongs to exactly one. `name` is unique so a caller can refer
-- to a project by name, and it is deliberately not part of the primary key
-- so that renaming is a plain UPDATE rather than a cascade.
CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  description text,
  privacy text NOT NULL DEFAULT 'local_only'
    CHECK (privacy IN ('local_only', 'anonymized', 'public')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_projects_name UNIQUE (name)
);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS privacy text NOT NULL DEFAULT 'local_only'
  CHECK (privacy IN ('local_only', 'anonymized', 'public'));

-- Case-insensitive uniqueness, so "Alpha" and "alpha" cannot both exist and
-- make a lookup by name ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_name_ci ON projects (lower(name));

CREATE INDEX IF NOT EXISTS idx_projects_name_fts
  ON projects USING gin (to_tsvector('simple', name));

-- Areas are the optional subgraph roots inside a project. `personal` is the
-- reserved project that replaces scope type `global`, so the reserved id is
-- inserted here and the scope type can then be retired.
INSERT INTO projects (id, name, description)
VALUES ('personal', 'personal', 'Reserved project for memories visible from every session.')
ON CONFLICT (id) DO NOTHING;

-- The composite unique exists only to carry the foreign key from memory
-- revisions, which is what makes an area belong to its project. It is not a
-- second identity.
CREATE TABLE IF NOT EXISTS areas (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_areas_project_name UNIQUE (project_id, name),
  CONSTRAINT uq_areas_project_id UNIQUE (project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_areas_project ON areas (project_id);

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
  area_ids text[] NOT NULL DEFAULT '{}',
  task_title text,
  sequence bigint NOT NULL DEFAULT 0,
  status text NOT NULL CHECK (status IN ('open', 'closed')),
  created_at timestamptz NOT NULL DEFAULT now(),
  closed_at timestamptz
);

CREATE TABLE IF NOT EXISTS events (
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  sequence bigint NOT NULL,
  type text NOT NULL,
  role text NOT NULL,
  content text NOT NULL,
  occurred_at timestamptz NOT NULL,
  explicit_memory_request boolean NOT NULL DEFAULT false,
  PRIMARY KEY (session_id, event_id),
  UNIQUE (session_id, sequence)
);

CREATE TABLE IF NOT EXISTS memories (
  id text PRIMARY KEY,
  current_version integer NOT NULL DEFAULT 1,
  lifecycle text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  privacy text CHECK (privacy IN ('local_only', 'anonymized', 'public'))
);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS privacy text
  CHECK (privacy IN ('local_only', 'anonymized', 'public'));

-- Follow-rate tracking: how many times a memory has actually been applied
-- (included in a resolved context) and when it was last applied. Used to flag
-- "dead" memories that are never used, so the owner can prune them.
ALTER TABLE memories ADD COLUMN IF NOT EXISTS applied_count integer NOT NULL DEFAULT 0;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS last_applied_at timestamptz;

-- Project membership is identity, not content: a memory never changes project.
-- RESTRICT rather than CASCADE, because a cascade would remove memories without
-- writing a forget-ledger row and the ledger is the record that they existed.
ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS project_id text REFERENCES projects(id) ON DELETE RESTRICT;

-- The old scope_id was free text with nothing to map it against, so an existing
-- corpus cannot be migrated mechanically. Fail loudly with a usable message
-- rather than with a bare NOT NULL violation.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM memories WHERE project_id IS NULL) THEN
    RAISE EXCEPTION
      'memories_require_project: existing memories have no project and cannot be migrated; reset the corpus first';
  END IF;
END $$;

ALTER TABLE memories ALTER COLUMN project_id SET NOT NULL;

-- The project directory reads the corpus part of every project with one
-- aggregate, so the aggregate has an index to read: (project_id, lifecycle)
-- answers the grouped count without touching the table, and covers the
-- per-project memory view as well.
CREATE INDEX IF NOT EXISTS idx_memories_project_lifecycle
  ON memories (project_id, lifecycle);

-- Paging through the memories of a project orders by the last update, so the
-- index carries it: without the ordering column the database sorts the whole
-- project before it can return the first page.
CREATE INDEX IF NOT EXISTS idx_memories_project_updated
  ON memories (project_id, updated_at DESC);

-- The structural part of the directory counts the sessions of every project.
-- Without this index the count is a sequential scan per project.
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions (project_id);

-- Enforced by a trigger rather than by the absence of an update path, so a future
-- code path cannot quietly break the invariant. 23514 so the API reports it as a
-- conflict.
CREATE OR REPLACE FUNCTION memoria_progetto_immutabile() RETURNS trigger AS $$
BEGIN
  IF NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'memory_project_immutable: % cannot move from % to %',
      OLD.id, OLD.project_id, NEW.project_id USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_memoria_progetto_immutabile
  BEFORE UPDATE OF project_id ON memories
  FOR EACH ROW EXECUTE FUNCTION memoria_progetto_immutabile();

CREATE TABLE IF NOT EXISTS memory_revisions (
  memory_id text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version integer NOT NULL,
  content text NOT NULL,
  kind text NOT NULL,
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  epistemic_basis text NOT NULL,
  assessment text NOT NULL,
  confidence double precision,
  sensitivity text NOT NULL,
  activation text NOT NULL,
  source_event_ids text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, version)
);

-- Scope references real rows. `area_id` carries no foreign key of its own because
-- the trigger below checks membership, and a redundant second constraint would
-- reject with the wrong explanation.
--
-- `project_id` here is a read-only copy of `memories.project_id`, maintained by
-- the trigger immediately after. It exists so the search filter can stay inside
-- the MATERIALIZED CTE over memory_revisions alone: joining memories in there is
-- exactly what used to make the planner ignore the GIN index, worth 29x at
-- 10,000 memories. It is never written by callers, so it cannot disagree.
ALTER TABLE memory_revisions ADD COLUMN IF NOT EXISTS project_id text;
ALTER TABLE memory_revisions ADD COLUMN IF NOT EXISTS area_id text;
ALTER TABLE memory_revisions
  ADD COLUMN IF NOT EXISTS session_id text REFERENCES sessions(id)
  ON DELETE NO ACTION DEFERRABLE INITIALLY DEFERRED;

CREATE INDEX IF NOT EXISTS idx_memory_revisions_scope
  ON memory_revisions (project_id, area_id, session_id);

CREATE OR REPLACE FUNCTION memoria_revisione_eredita_progetto() RETURNS trigger AS $$
BEGIN
  NEW.project_id := (SELECT project_id FROM memories WHERE id = NEW.memory_id);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_memoria_revisione_eredita_progetto
  BEFORE INSERT OR UPDATE ON memory_revisions
  FOR EACH ROW EXECUTE FUNCTION memoria_revisione_eredita_progetto();

-- "the area of a memory belongs to that memory's project" spans two tables, and a
-- foreign key cannot reference columns from two relations. 23503 so the API maps
-- it to 409 through the existing foreign-key path.
CREATE OR REPLACE FUNCTION memoria_scope_tiene_progetto() RETURNS trigger AS $$
DECLARE memoria_progetto text;
BEGIN
  IF NEW.area_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM areas WHERE id = NEW.area_id AND project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'area_not_in_project: % is not an area of project %',
      NEW.area_id, NEW.project_id USING ERRCODE = '23503';
  END IF;
  IF NEW.session_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM sessions WHERE id = NEW.session_id AND project_id = NEW.project_id
  ) THEN
    RAISE EXCEPTION 'session_not_in_project: % is not a session of project %',
      NEW.session_id, NEW.project_id USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_memoria_scope_tiene_progetto
  BEFORE INSERT OR UPDATE OF area_id, session_id ON memory_revisions
  FOR EACH ROW EXECUTE FUNCTION memoria_scope_tiene_progetto();

-- Scope is derived from those columns now, so the free-text pair is gone. It was
-- never constrained: any string was a valid scope_id, which is the whole reason
-- projects and areas had to become tables.
ALTER TABLE memory_revisions DROP COLUMN IF EXISTS scope_type;
ALTER TABLE memory_revisions DROP COLUMN IF EXISTS scope_id;

-- Arcs are governed rows, like memories: PostgreSQL stays authoritative and
-- Neo4j projects them. Two tables rather than one polymorphic pair, because a
-- polymorphic from_id/to_id can carry no foreign key and then forgetting a
-- memory leaves dangling arcs. memory_arcs may cross projects, because a memory
-- in one project can legitimately depend on a memory in another.

CREATE TABLE IF NOT EXISTS memory_arcs (
  id text PRIMARY KEY DEFAULT gen_random_uuid(),
  from_memory_id text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  to_memory_id text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  type text NOT NULL,
  weight real,
  lifecycle text NOT NULL DEFAULT 'pending_approval'
    CHECK (lifecycle IN ('pending_approval', 'accepted', 'rejected', 'retracted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  -- A memory does not influence itself.
  CONSTRAINT chk_memory_arcs_distinct CHECK (from_memory_id <> to_memory_id),
  -- Duplicate parallel arcs would make the weight ambiguous and retrying a
  -- proposal non-idempotent.
  CONSTRAINT uq_memory_arcs_triple UNIQUE (from_memory_id, to_memory_id, type),
  CONSTRAINT chk_memory_arcs_weight CHECK (weight IS NULL OR weight BETWEEN 0 AND 1)
);

CREATE INDEX IF NOT EXISTS idx_memory_arcs_from ON memory_arcs (from_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_arcs_to ON memory_arcs (to_memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_arcs_lifecycle ON memory_arcs (lifecycle);

CREATE TABLE IF NOT EXISTS project_arcs (
  id text PRIMARY KEY DEFAULT gen_random_uuid(),
  from_project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  to_project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type text NOT NULL,
  weight real,
  lifecycle text NOT NULL DEFAULT 'pending_approval'
    CHECK (lifecycle IN ('pending_approval', 'accepted', 'rejected', 'retracted')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT chk_project_arcs_distinct CHECK (from_project_id <> to_project_id),
  CONSTRAINT uq_project_arcs_triple UNIQUE (from_project_id, to_project_id, type),
  CONSTRAINT chk_project_arcs_weight CHECK (weight IS NULL OR weight BETWEEN 0 AND 1)
);

CREATE INDEX IF NOT EXISTS idx_project_arcs_from ON project_arcs (from_project_id);
CREATE INDEX IF NOT EXISTS idx_project_arcs_to ON project_arcs (to_project_id);
CREATE INDEX IF NOT EXISTS idx_project_arcs_lifecycle ON project_arcs (lifecycle);

-- Cycles are legitimate: two memories that influence each other is ordinary,
-- and so is two projects that depend on each other. A *hierarchy* with a cycle
-- is not a hierarchy, so only relation types listed here have to be acyclic.
-- The set is data, not code: declaring another hierarchical relation is one row.
CREATE TABLE IF NOT EXISTS hierarchical_relation (
  type text PRIMARY KEY,
  description text
);

COMMENT ON TABLE hierarchical_relation IS
  'relation types that must form an acyclic structure; changeable without a migration';

INSERT INTO hierarchical_relation (type, description)
VALUES ('sotto-progetto', 'il progetto di destinazione sta dentro quello di origine'),
       ('sovraprogetto', 'inverse of sotto-progetto, declared explicitly rather than inferred')
ON CONFLICT (type) DO NOTHING;

-- Refuses a project arc that would close a cycle among hierarchical relations.
--
-- UNION and not UNION ALL is deliberate: UNION deduplicates, so the walk still
-- terminates when the existing data already contains a cycle, which is exactly
-- the case a trigger has to report rather than hang on.
--
-- pg_advisory_xact_lock is not an optimisation. Without it two transactions
-- inserting the opposite halves of a cycle both read the pre-commit state, both
-- pass, and the cycle forms anyway. The lock serialises the walk against other
-- hierarchical writes.
CREATE OR REPLACE FUNCTION project_arcs_acyclic() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM hierarchical_relation WHERE type = NEW.type) THEN
    RETURN NEW;
  END IF;
  -- Only accepted arcs take part: a proposal that has not been approved yet
  -- cannot close a cycle.
  IF NEW.lifecycle <> 'accepted' OR NEW.from_project_id = NEW.to_project_id THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('project_arcs_hierarchy'));

  IF EXISTS (
    WITH RECURSIVE raggiungibili(id) AS (
      SELECT NEW.to_project_id
      UNION
      SELECT a.to_project_id
      FROM project_arcs a
      JOIN raggiungibili r ON a.from_project_id = r.id
      JOIN hierarchical_relation h ON h.type = a.type
      WHERE a.lifecycle = 'accepted'
    )
    SELECT 1 FROM raggiungibili WHERE id = NEW.from_project_id
  ) THEN
    RAISE EXCEPTION 'project_arc_would_close_cycle: % -> % of type %',
      NEW.from_project_id, NEW.to_project_id, NEW.type USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_project_arcs_acyclic
  BEFORE INSERT OR UPDATE ON project_arcs
  FOR EACH ROW EXECUTE FUNCTION project_arcs_acyclic();


CREATE INDEX IF NOT EXISTS memory_revisions_current_content_idx
  ON memory_revisions USING gin (to_tsvector('simple', content));

CREATE INDEX IF NOT EXISTS memory_revisions_retention_idx
  ON memory_revisions(created_at, memory_id, version);

CREATE INDEX IF NOT EXISTS memories_lifecycle_idx ON memories(lifecycle);

CREATE TABLE IF NOT EXISTS memory_embeddings (
  memory_id text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  profile text NOT NULL,
  dimensions integer NOT NULL,
  embedding vector(64) NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (memory_id, profile)
);

CREATE INDEX IF NOT EXISTS memory_embeddings_cosine_idx
  ON memory_embeddings
  USING hnsw (embedding vector_cosine_ops)
  WHERE profile = 'deterministic-v1';

CREATE TABLE IF NOT EXISTS jobs (
  id text PRIMARY KEY,
  operation text NOT NULL,
  status text NOT NULL,
  session_id text NOT NULL,
  available_at timestamptz,
  lease_owner text,
  lease_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE jobs ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS available_at timestamptz;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_owner text;
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS jobs_claim_idx
  ON jobs(available_at, created_at)
  WHERE status = 'queued';

CREATE INDEX IF NOT EXISTS jobs_expired_lease_idx
  ON jobs(lease_expires_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS job_attempts (
  id text PRIMARY KEY,
  job_id text NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt integer NOT NULL,
  status text NOT NULL
    CHECK (status IN ('running', 'succeeded', 'failed', 'quarantined')),
  error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  worker_id text NOT NULL DEFAULT 'legacy',
  UNIQUE (job_id, attempt)
);

ALTER TABLE job_attempts ADD COLUMN IF NOT EXISTS worker_id text NOT NULL DEFAULT 'legacy';

CREATE INDEX IF NOT EXISTS job_attempts_job_idx ON job_attempts(job_id, attempt DESC);

CREATE TABLE IF NOT EXISTS corpus_outbox (
  id bigserial PRIMARY KEY,
  event_type text NOT NULL,
  aggregate_id text NOT NULL,
  store_revision bigint NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  claim_token uuid,
  consumer_id text,
  lease_expires_at timestamptz
);

ALTER TABLE corpus_outbox ADD COLUMN IF NOT EXISTS claim_token uuid;
ALTER TABLE corpus_outbox ADD COLUMN IF NOT EXISTS consumer_id text;
ALTER TABLE corpus_outbox ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS corpus_outbox_unprocessed_idx
  ON corpus_outbox(id) WHERE processed_at IS NULL;

CREATE INDEX IF NOT EXISTS corpus_outbox_lease_idx
  ON corpus_outbox(lease_expires_at, id) WHERE processed_at IS NULL;

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key text PRIMARY KEY,
  payload_hash text NOT NULL,
  response_status integer NOT NULL DEFAULT 0,
  response_body jsonb NOT NULL DEFAULT 'null'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS forget_ledger (
  memory_id text PRIMARY KEY,
  forgotten_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS conflicts (
  id text PRIMARY KEY,
  type text NOT NULL DEFAULT 'direct_contradiction',
  memory_ids text[] NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'resolved')),
  detected_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE conflicts ADD COLUMN IF NOT EXISTS type text NOT NULL DEFAULT 'direct_contradiction';

CREATE INDEX IF NOT EXISTS conflicts_memory_ids_idx ON conflicts USING gin (memory_ids);

CREATE TABLE IF NOT EXISTS memory_feedback (
  id text PRIMARY KEY,
  memory_id text NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  session_id text NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('useful', 'not_useful', 'outdated', 'incorrect', 'scope_mismatch')),
  comment text,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS memory_feedback_memory_idx
  ON memory_feedback(memory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS client_tokens (
  id text PRIMARY KEY,
  name text NOT NULL UNIQUE,
  token_hash text NOT NULL,
  token_prefix text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner')),
  created_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE INDEX IF NOT EXISTS client_tokens_token_hash_idx ON client_tokens(token_hash);

-- Heartbeat published by the extraction worker. The API and the MCP server own
-- neither the extraction provider nor the Neo4j projection nor the retention
-- timer, so they read these facts from here instead of reporting them blind.
-- reported_at is what makes staleness detectable: a stopped worker goes quiet
-- and its capabilities read as unknown rather than as disabled.
CREATE TABLE IF NOT EXISTS runtime_capabilities (
  component text PRIMARY KEY,
  capabilities jsonb NOT NULL,
  reported_at timestamptz NOT NULL
);

-- Semantic pruning working state. Proposals reference live rows and are
-- deliberately absent from the corpus export: a restore starts from an empty
-- corpus, where every reference would dangle.
CREATE TABLE IF NOT EXISTS pruning_proposals (
  id text PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id text NOT NULL,
  proposer text NOT NULL CHECK (proposer IN ('deterministic', 'llm')),
  proposal_type text NOT NULL
    CHECK (proposal_type IN ('decay', 'edge', 'redundancy', 'contradiction', 'merge')),
  source_ids text[] NOT NULL,
  source_versions jsonb NOT NULL DEFAULT '{}'::jsonb,
  target_id text,
  rationale text NOT NULL,
  confidence real NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
  score_snapshot jsonb NOT NULL DEFAULT '{}'::jsonb,
  model_version text,
  prompt_hash text,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'accepted', 'rejected', 'stale')),
  decided_at timestamptz,
  decision_reason text,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pruning_proposals_status_idx ON pruning_proposals (status);

-- Every executed cut leaves a row here, whichever stage proposed it. Separate
-- from the forget ledger, which stays for forgets keyed by memory id.
CREATE TABLE IF NOT EXISTS pruning_ledger (
  id text PRIMARY KEY DEFAULT gen_random_uuid(),
  subject_type text NOT NULL CHECK (subject_type IN ('memory', 'arc')),
  subject_id text NOT NULL,
  reason text NOT NULL CHECK (reason IN ('decay', 'edge_weight', 'llm_proposal', 'manual')),
  proposal_id text REFERENCES pruning_proposals(id) ON DELETE SET NULL,
  score real,
  score_components jsonb,
  decided_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS pruning_ledger_subject_idx ON pruning_ledger (subject_id);
