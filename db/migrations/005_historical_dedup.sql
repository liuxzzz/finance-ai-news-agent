ALTER TABLE normalized_content_items
  ADD COLUMN title_fingerprint text;

UPDATE normalized_content_items
SET title_fingerprint = fingerprint
WHERE title_fingerprint IS NULL;

ALTER TABLE normalized_content_items
  ALTER COLUMN title_fingerprint SET NOT NULL;

CREATE INDEX normalized_content_title_fingerprint_idx
  ON normalized_content_items (title_fingerprint);

CREATE INDEX normalized_content_history_lookup_idx
  ON normalized_content_items (fingerprint, title_fingerprint, run_id);
