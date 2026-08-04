CREATE TABLE source_runs (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  source_id text NOT NULL,
  source_url_fingerprint text NOT NULL,
  attempt integer NOT NULL CHECK (attempt >= 1),
  status text NOT NULL CHECK (status IN ('succeeded', 'failed')),
  item_count integer NOT NULL CHECK (item_count >= 0),
  error jsonb,
  started_at timestamptz NOT NULL,
  finished_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT source_runs_attempt_unique UNIQUE (run_id, source_id, attempt)
);

CREATE INDEX source_runs_run_created_idx
  ON source_runs (run_id, created_at, source_id, attempt);

CREATE TABLE raw_source_items (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  source_run_id text NOT NULL REFERENCES source_runs (id) ON DELETE CASCADE,
  source_id text NOT NULL,
  external_id text,
  url text NOT NULL,
  title text NOT NULL,
  excerpt text NOT NULL,
  published_at timestamptz NOT NULL,
  collected_at timestamptz NOT NULL,
  content_hash text NOT NULL,
  raw jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT raw_source_items_run_url_unique UNIQUE (run_id, url)
);

CREATE INDEX raw_source_items_run_published_idx
  ON raw_source_items (run_id, published_at DESC, source_id);
