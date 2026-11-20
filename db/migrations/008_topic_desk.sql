CREATE TABLE topics (
  id text PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  keywords jsonb NOT NULL,
  feeds jsonb NOT NULL,
  window_hours integer NOT NULL CHECK (window_hours BETWEEN 1 AND 168),
  lookback_days integer NOT NULL CHECK (lookback_days BETWEEN 0 AND 30),
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT topics_keywords_array CHECK (jsonb_typeof(keywords) = 'array'),
  CONSTRAINT topics_feeds_array CHECK (jsonb_typeof(feeds) = 'array')
);

CREATE INDEX topics_updated_idx ON topics (updated_at DESC, id);

CREATE TABLE topic_runs (
  id text PRIMARY KEY,
  topic_id text NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  outcome text CHECK (outcome IS NULL OR outcome IN ('ready', 'empty', 'deduped')),
  model_mode text NOT NULL CHECK (model_mode IN ('stub', 'structured')),
  model_label text,
  model_invoked boolean NOT NULL,
  query text NOT NULL,
  source_outcomes jsonb NOT NULL,
  evidence jsonb NOT NULL,
  collected_count integer NOT NULL CHECK (collected_count >= 0),
  keyword_miss_count integer NOT NULL CHECK (keyword_miss_count >= 0),
  dropped_duplicate_count integer NOT NULL CHECK (dropped_duplicate_count >= 0),
  error jsonb,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL,
  CONSTRAINT topic_runs_source_outcomes_array CHECK (jsonb_typeof(source_outcomes) = 'array'),
  CONSTRAINT topic_runs_evidence_array CHECK (jsonb_typeof(evidence) = 'array'),
  CONSTRAINT topic_runs_error_object CHECK (error IS NULL OR jsonb_typeof(error) = 'object')
);

CREATE UNIQUE INDEX topic_runs_one_running_idx
  ON topic_runs (topic_id)
  WHERE status = 'running';

CREATE INDEX topic_runs_topic_created_idx
  ON topic_runs (topic_id, created_at DESC, id);

CREATE TABLE topic_briefings (
  id text PRIMARY KEY,
  run_id text NOT NULL UNIQUE REFERENCES topic_runs (id) ON DELETE CASCADE,
  topic_id text NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  title text NOT NULL,
  markdown text NOT NULL,
  evidence_count integer NOT NULL CHECK (evidence_count >= 0),
  export_path text,
  created_at timestamptz NOT NULL
);

CREATE TABLE topic_seen_evidence (
  topic_id text NOT NULL REFERENCES topics (id) ON DELETE CASCADE,
  fingerprint text NOT NULL,
  title_fingerprint text NOT NULL,
  evidence_id text NOT NULL,
  run_id text NOT NULL REFERENCES topic_runs (id) ON DELETE CASCADE,
  seen_at timestamptz NOT NULL,
  PRIMARY KEY (topic_id, fingerprint)
);

CREATE INDEX topic_seen_evidence_topic_seen_idx
  ON topic_seen_evidence (topic_id, seen_at DESC);
