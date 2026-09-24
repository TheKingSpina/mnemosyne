CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS corpus_state (
  id text PRIMARY KEY,
  epoch uuid NOT NULL DEFAULT gen_random_uuid(),
  revision bigint NOT NULL DEFAULT 1,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO corpus_state (id)
VALUES ('default')
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS sessions (
  id text PRIMARY KEY,
  project_id text NOT NULL,
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

CREATE INDEX IF NOT EXISTS memories_lifecycle_idx ON memories(lifecycle);

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
  processed_at timestamptz
);

CREATE INDEX IF NOT EXISTS corpus_outbox_unprocessed_idx
  ON corpus_outbox(id) WHERE processed_at IS NULL;

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
