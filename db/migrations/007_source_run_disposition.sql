ALTER TABLE source_runs
  ADD COLUMN disposition jsonb;

ALTER TABLE source_runs
  ADD CONSTRAINT source_runs_disposition_object
    CHECK (disposition IS NULL OR jsonb_typeof(disposition) = 'object');
