ALTER TABLE job_operations DROP CONSTRAINT job_operations_status_check;
ALTER TABLE job_operations ADD CONSTRAINT job_operations_status_check
  CHECK(status IN ('started','completed','ambiguous','not_sent'));
ALTER TABLE job_operations ADD COLUMN failure_code text;
ALTER TABLE job_operations ADD COLUMN failure_phase text;
ALTER TABLE job_operations ADD COLUMN http_status integer;
