CREATE TABLE users (
  id uuid PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text NOT NULL,
  role text NOT NULL CHECK(role IN ('admin','user')), status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE invites (
  token_hash text PRIMARY KEY, created_by uuid NOT NULL REFERENCES users(id), expires_at timestamptz NOT NULL,
  used_by uuid REFERENCES users(id), created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE sessions (
  token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expiry_idx ON sessions(expires_at);
CREATE TABLE settings (
  user_id uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  provider text NOT NULL CHECK(provider IN ('openai','deepseek','custom')), base_url text NOT NULL, model text NOT NULL,
  key_cipher text, updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trips (
  id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE, title text NOT NULL,
  constraints jsonb NOT NULL, current_version_id uuid, revision integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(id,user_id)
);
CREATE INDEX trips_user_idx ON trips(user_id,updated_at DESC);
CREATE TABLE versions (
  id uuid PRIMARY KEY, trip_id uuid NOT NULL REFERENCES trips(id) ON DELETE CASCADE,
  number integer NOT NULL, status text NOT NULL CHECK(status IN ('candidate','adopted','discarded')),
  base_version_id uuid REFERENCES versions(id), request text NOT NULL, content jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(trip_id,number), UNIQUE(id,trip_id)
);
ALTER TABLE trips ADD CONSTRAINT current_version_same_trip FOREIGN KEY(current_version_id,id) REFERENCES versions(id,trip_id) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE jobs (
  id uuid PRIMARY KEY, trip_id uuid NOT NULL, user_id uuid NOT NULL, idempotency_key uuid NOT NULL,
  request text NOT NULL, mode text NOT NULL CHECK(mode IN ('live','demo')),
  status text NOT NULL CHECK(status IN ('queued','running','succeeded','failed','cancelled')),
  base_version_id uuid REFERENCES versions(id), version_id uuid REFERENCES versions(id),
  error_code text, error_message text, claimed_by uuid, lease_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(trip_id,user_id) REFERENCES trips(id,user_id) ON DELETE CASCADE, UNIQUE(user_id,idempotency_key)
);
CREATE UNIQUE INDEX jobs_one_active_trip ON jobs(trip_id) WHERE status IN ('queued','running');
CREATE INDEX jobs_claim_idx ON jobs(status,created_at);
CREATE INDEX jobs_user_idx ON jobs(user_id,created_at DESC);
CREATE TABLE rate_limits (
  key text PRIMARY KEY, count integer NOT NULL, reset_at timestamptz NOT NULL
);
