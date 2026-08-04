CREATE TABLE normalized_content_items (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  evidence_id text NOT NULL,
  source_id text,
  source text,
  url text NOT NULL,
  canonical_url text NOT NULL,
  title text NOT NULL,
  excerpt text NOT NULL,
  published_at timestamptz,
  fingerprint text NOT NULL,
  cluster_id text NOT NULL,
  created_at timestamptz NOT NULL,
  CONSTRAINT normalized_content_run_evidence_unique UNIQUE (run_id, evidence_id)
);

CREATE INDEX normalized_content_run_cluster_idx
  ON normalized_content_items (run_id, cluster_id, published_at DESC);

CREATE INDEX normalized_content_fingerprint_idx
  ON normalized_content_items (fingerprint);
