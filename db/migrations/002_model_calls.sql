CREATE TABLE model_calls (
  id text PRIMARY KEY,
  run_id text NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal >= 1),
  role text NOT NULL,
  provider_id text NOT NULL,
  request_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
  model text,
  finish_reason text,
  input_tokens integer NOT NULL DEFAULT 0 CHECK (input_tokens >= 0),
  output_tokens integer NOT NULL DEFAULT 0 CHECK (output_tokens >= 0),
  total_tokens integer NOT NULL DEFAULT 0 CHECK (total_tokens >= 0),
  error jsonb,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  CONSTRAINT model_calls_run_ordinal_unique UNIQUE (run_id, ordinal)
);

CREATE INDEX model_calls_run_created_idx
  ON model_calls (run_id, created_at, ordinal);
