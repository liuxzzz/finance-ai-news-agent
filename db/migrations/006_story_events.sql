CREATE TABLE story_events (
  id text PRIMARY KEY,
  tenant_id text NOT NULL,
  topic text NOT NULL,
  canonical_headline text NOT NULL,
  normalized_headline text NOT NULL,
  title_fingerprint text NOT NULL,
  latest_headline text NOT NULL,
  first_seen_date date NOT NULL,
  last_seen_date date NOT NULL,
  first_run_id text NOT NULL REFERENCES runs (id),
  latest_run_id text NOT NULL REFERENCES runs (id),
  update_count integer NOT NULL CHECK (update_count >= 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT story_events_exact_identity_unique
    UNIQUE (tenant_id, topic, title_fingerprint)
);

CREATE INDEX story_events_recent_lookup_idx
  ON story_events (tenant_id, topic, last_seen_date DESC);

CREATE TABLE story_event_updates (
  id text PRIMARY KEY,
  event_id text NOT NULL REFERENCES story_events (id) ON DELETE CASCADE,
  run_id text NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  story_id text NOT NULL,
  headline text NOT NULL,
  evidence_ids jsonb NOT NULL,
  observed_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT story_event_updates_run_story_unique UNIQUE (run_id, story_id)
);

CREATE INDEX story_event_updates_event_time_idx
  ON story_event_updates (event_id, observed_at DESC);

CREATE INDEX story_event_updates_run_idx
  ON story_event_updates (run_id, story_id);
