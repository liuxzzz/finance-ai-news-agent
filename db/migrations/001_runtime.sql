CREATE TABLE runs (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  report_date text NOT NULL,
  edition text NOT NULL,
  topic text NOT NULL,
  max_revisions integer NOT NULL CHECK (max_revisions >= 0),
  input_hash text NOT NULL,
  config_snapshot jsonb NOT NULL,
  prompt_versions jsonb NOT NULL,
  model_snapshot jsonb NOT NULL,
  scheduled_at timestamptz,
  status text NOT NULL CHECK (
    status IN ('pending', 'running', 'succeeded', 'partial', 'rejected', 'failed')
  ),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  started_at timestamptz,
  finished_at timestamptz,
  error jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT runs_identity_unique UNIQUE (tenant_id, report_date, edition)
);

CREATE TABLE run_stages (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  stage text NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 1),
  status text NOT NULL CHECK (
    status IN ('pending', 'running', 'succeeded', 'failed', 'skipped')
  ),
  input_hash text NOT NULL,
  output jsonb,
  output_refs jsonb NOT NULL DEFAULT '{}'::jsonb,
  error jsonb,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT run_stages_attempt_unique UNIQUE (run_id, stage, attempt)
);

CREATE UNIQUE INDEX run_stages_one_running_per_stage
  ON run_stages (run_id, stage)
  WHERE status = 'running';

CREATE INDEX run_stages_run_created_idx
  ON run_stages (run_id, created_at, attempt);

CREATE TABLE artifacts (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  kind text NOT NULL,
  media_type text NOT NULL,
  content text NOT NULL,
  content_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT artifacts_run_kind_unique UNIQUE (run_id, kind),
  CONSTRAINT artifacts_run_id_id_unique UNIQUE (run_id, id)
);

CREATE INDEX artifacts_run_created_idx
  ON artifacts (run_id, created_at);

CREATE TABLE deliveries (
  id text PRIMARY KEY,
  run_id text NOT NULL,
  artifact_id text NOT NULL,
  delivery_key text NOT NULL UNIQUE,
  plugin_id text NOT NULL,
  target text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  attempt integer NOT NULL CHECK (attempt >= 1),
  receipt jsonb,
  error jsonb,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT deliveries_artifact_fk
    FOREIGN KEY (run_id, artifact_id)
    REFERENCES artifacts (run_id, id)
    ON DELETE CASCADE
);

CREATE INDEX deliveries_run_created_idx
  ON deliveries (run_id, created_at);
