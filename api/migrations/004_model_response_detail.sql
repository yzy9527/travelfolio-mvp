ALTER TABLE job_operations ADD COLUMN failure_detail text
  CHECK (failure_detail IS NULL OR failure_detail ~ '^[A-Za-z0-9_.:-]{1,160}$');
