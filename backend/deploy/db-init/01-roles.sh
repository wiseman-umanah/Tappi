#!/bin/sh
# Runs once, when the database volume is first created. One role per service, each owning its own
# schema: the API's role can't read or write the engine's ledger, and the engine can't touch app data.
set -eu
psql -v ON_ERROR_STOP=1 --username "$POSTGRES_USER" --dbname "$POSTGRES_DB" <<SQL
CREATE ROLE tappi_engine LOGIN PASSWORD '${ENGINE_DB_PASSWORD}';
CREATE ROLE tappi_api LOGIN PASSWORD '${API_DB_PASSWORD}';
CREATE SCHEMA engine AUTHORIZATION tappi_engine;
CREATE SCHEMA app AUTHORIZATION tappi_api;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
REVOKE CREATE ON DATABASE ${POSTGRES_DB} FROM PUBLIC;
-- CREATE lets each service run its own "CREATE SCHEMA IF NOT EXISTS" on start (Postgres checks the
-- privilege even when the schema exists). Neither gets any right on the other's schema.
GRANT CONNECT, CREATE ON DATABASE ${POSTGRES_DB} TO tappi_engine, tappi_api;
SQL
