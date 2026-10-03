#!/bin/sh
# Runs only when PostgreSQL initializes a new, empty data directory.
# Never put a real password in this file or print APP_DB_PASSWORD.
set -eu
: "${APP_DB_PASSWORD:?APP_DB_PASSWORD is required}"

# \getenv keeps the secret out of process arguments; :'...' safely quotes it.
# The API owns its own schema objects for migrations but cannot create roles,
# databases or replication sessions, and is not a PostgreSQL superuser.
psql -X --set ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<'SQL'
\getenv app_password APP_DB_PASSWORD
CREATE ROLE travelfolio WITH LOGIN PASSWORD :'app_password'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
REVOKE ALL ON DATABASE travelfolio FROM PUBLIC;
GRANT CONNECT ON DATABASE travelfolio TO travelfolio;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE, CREATE ON SCHEMA public TO travelfolio;
\unset app_password
SQL
