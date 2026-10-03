-- Additive migration: existing version.content and legacy jobs remain readable.
ALTER TABLE jobs DROP CONSTRAINT jobs_status_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_status_check CHECK(status IN ('queued','running','awaiting_outline','succeeded','failed','cancelled'));
DROP INDEX jobs_one_active_trip;
CREATE UNIQUE INDEX jobs_one_active_trip ON jobs(trip_id) WHERE status IN ('queued','running','awaiting_outline');
ALTER TABLE jobs ADD COLUMN schema_version integer NOT NULL DEFAULT 1;
ALTER TABLE jobs ADD COLUMN stage text NOT NULL DEFAULT 'outline';
ALTER TABLE jobs ADD COLUMN outline jsonb;
ALTER TABLE jobs ADD COLUMN outline_hash text;
ALTER TABLE jobs ADD COLUMN outline_version integer NOT NULL DEFAULT 0;
ALTER TABLE jobs ADD COLUMN approved_outline_hash text;
ALTER TABLE jobs ADD COLUMN approved_at timestamptz;
ALTER TABLE jobs ADD COLUMN checkpoint jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE jobs ADD COLUMN possible_charge boolean NOT NULL DEFAULT false;
ALTER TABLE jobs ADD COLUMN resume_attempt integer NOT NULL DEFAULT 0;
ALTER TABLE versions ADD COLUMN schema_version integer NOT NULL DEFAULT 1;
ALTER TABLE versions ADD COLUMN guide jsonb;
ALTER TABLE versions ADD COLUMN research_packs jsonb;
ALTER TABLE versions ADD COLUMN artifact_html text;
ALTER TABLE versions ADD COLUMN artifact_hash text;
ALTER TABLE versions ADD COLUMN qa_status text CHECK(qa_status IN ('pending','passed'));
ALTER TABLE versions ADD COLUMN review jsonb;
CREATE TABLE job_operations (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  operation_key text NOT NULL, input_hash text NOT NULL,
  status text NOT NULL CHECK(status IN ('started','completed','ambiguous')),
  result jsonb, started_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz,
  UNIQUE(job_id,operation_key)
);
CREATE INDEX job_operations_job_idx ON job_operations(job_id,status);
CREATE TABLE job_events (
  id uuid PRIMARY KEY, job_id uuid NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  stage text NOT NULL, event text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
