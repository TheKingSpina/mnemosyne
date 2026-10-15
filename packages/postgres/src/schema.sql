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
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_projects_name UNIQUE (name)
);

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
  updated_at timestamptz NOT NULL DEFAULT now()
);

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
