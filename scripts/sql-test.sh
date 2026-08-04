#!/usr/bin/env bash
#
# Run the SQL suite against a disposable local Postgres.
#
# Why this exists: the balance rules and every pull predicate live in SQL, and Vitest has no
# Postgres — so historically none of it could be tested, and a batch of repair rules once went
# uncovered without `npm test` noticing. This gives that code a real test runner.
#
#   npm run test:sql              # apply migrations to a scratch DB, run every *.test.sql
#   npm run test:sql -- --keep    # leave the DB in place afterwards for poking at with psql
#   npm run test:sql -- --shell   # apply migrations, then drop into psql
#
# It never touches your Supabase project and never touches an existing local cluster: it runs
# its own cluster on port 55432 with its own data directory under $TMPDIR.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PG_BIN="${KWENTA_PG_BIN:-/opt/homebrew/opt/postgresql@14/bin}"
PGDATA_DIR="${KWENTA_SQLTEST_PGDATA:-${TMPDIR:-/tmp}/kwenta-sqltest-pgdata}"
PGPORT="${KWENTA_SQLTEST_PORT:-55432}"
PGHOST="/tmp"
PGUSER="postgres"
DBNAME="kwenta_sqltest"

KEEP=0
SHELL_AFTER=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    --shell) SHELL_AFTER=1; KEEP=1 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

if [ -d "$PG_BIN" ]; then
  export PATH="$PG_BIN:$PATH"
fi

for bin in initdb pg_ctl psql pg_isready; do
  command -v "$bin" >/dev/null 2>&1 || {
    echo "error: '$bin' not found." >&2
    echo "  Install Postgres 14 (brew install postgresql@14) or set KWENTA_PG_BIN." >&2
    exit 1
  }
done

export PGHOST PGPORT PGUSER
# Migrations are written to be re-runnable, so they emit a wall of "does not exist, skipping"
# NOTICEs from DROP ... IF EXISTS. Keep warnings and errors; drop the noise. Individual tests
# re-enable notices so test.note() output is visible.
export PGOPTIONS='-c client_min_messages=warning'

# --- cluster ---------------------------------------------------------------
if [ ! -s "$PGDATA_DIR/PG_VERSION" ]; then
  echo "==> creating scratch cluster at $PGDATA_DIR"
  rm -rf "$PGDATA_DIR"
  initdb -D "$PGDATA_DIR" -U "$PGUSER" --auth=trust >/dev/null
fi

if ! pg_isready -q 2>/dev/null; then
  echo "==> starting Postgres on port $PGPORT"
  pg_ctl -D "$PGDATA_DIR" -o "-p $PGPORT -k $PGHOST -c wal_level=logical" -l "$PGDATA_DIR/server.log" -w start >/dev/null
fi

pg_isready -q || { echo "error: Postgres did not come up; see $PGDATA_DIR/server.log" >&2; exit 1; }

# Confirm we are talking to OUR scratch cluster before dropping and recreating a database on it.
# `pg_isready` answers for ANY server listening on this socket and port, so the header's promise
# that this "never touches an existing local cluster" was not enforced: a developer already
# running Postgres on 55432 — or holding a stale cluster from an aborted `--keep` run — would have
# had migrations applied to it, silently. Comparing data directories is what makes the promise
# real.
running_data_dir="$(psql -d postgres -qtAX -c 'SHOW data_directory;' 2>/dev/null || true)"
expected_data_dir="$(cd "$PGDATA_DIR" 2>/dev/null && pwd -P || echo "$PGDATA_DIR")"
if [ -n "$running_data_dir" ]; then
  running_data_dir="$(cd "$running_data_dir" 2>/dev/null && pwd -P || echo "$running_data_dir")"
fi
if [ "$running_data_dir" != "$expected_data_dir" ]; then
  echo "error: a different Postgres is already listening on $PGHOST:$PGPORT." >&2
  echo "  its data directory: ${running_data_dir:-<unknown>}" >&2
  echo "  this harness owns:  $expected_data_dir" >&2
  echo "  Refusing to run: the suite drops and recreates '$DBNAME' on whatever answers here." >&2
  echo "  Stop that server, or set KWENTA_SQLTEST_PORT to a free port." >&2
  exit 1
fi

# --- schema ----------------------------------------------------------------
echo "==> rebuilding $DBNAME"
psql -d postgres -q -v ON_ERROR_STOP=1 -c "DROP DATABASE IF EXISTS $DBNAME;" >/dev/null
psql -d postgres -q -v ON_ERROR_STOP=1 -c "CREATE DATABASE $DBNAME;" >/dev/null

PSQL=(psql -d "$DBNAME" -q -v ON_ERROR_STOP=1 --no-psqlrc)

echo "==> applying Supabase shim"
"${PSQL[@]}" -f "$REPO_ROOT/supabase/tests/harness/000_supabase_shim.sql"

echo "==> applying migrations"
migration_count=0
# Plain lexical sort is correct here, including the out-of-band 009b/021b files: '_' (0x5F)
# sorts before 'b' (0x62), so 009_ precedes 009b_ and 021_ precedes 021b_.
while IFS= read -r file; do
  if ! "${PSQL[@]}" -f "$file" >/dev/null; then
    echo "FAILED applying $(basename "$file")" >&2
    exit 1
  fi
  migration_count=$((migration_count + 1))
done < <(find "$REPO_ROOT/supabase/migrations" -maxdepth 1 -name '*.sql' | sort)
echo "    $migration_count migrations applied"

echo "==> applying test helpers"
"${PSQL[@]}" -f "$REPO_ROOT/supabase/tests/harness/001_test_helpers.sql"

# --- tests -----------------------------------------------------------------
TEST_DIR="$REPO_ROOT/supabase/tests/sql"
pass=0
fail=0
failed_files=()

if [ -d "$TEST_DIR" ]; then
  while IFS= read -r file; do
    name="$(basename "$file")"
    # Each file runs in ONE transaction that is always rolled back, so tests cannot leak
    # fixtures into each other and cannot depend on execution order.
    output="$(psql -d "$DBNAME" -v ON_ERROR_STOP=1 --no-psqlrc -q \
      -c 'BEGIN;' -f "$file" -c 'ROLLBACK;' 2>&1)" && ok=1 || ok=0
    if [ "$ok" = "1" ]; then
      echo "  PASS  $name"
      pass=$((pass + 1))
    else
      echo "  FAIL  $name"
      echo "$output" | sed 's/^/        /'
      fail=$((fail + 1))
      failed_files+=("$name")
    fi
  done < <(find "$TEST_DIR" -maxdepth 1 -name '*.test.sql' | sort)
else
  echo "    (no $TEST_DIR yet)"
fi

echo
echo "==> SQL suite: $pass passed, $fail failed"

if [ "$SHELL_AFTER" = "1" ]; then
  echo "==> dropping into psql on $DBNAME (\\q to exit)"
  psql -d "$DBNAME"
fi

if [ "$KEEP" = "0" ]; then
  psql -d postgres -q -c "DROP DATABASE IF EXISTS $DBNAME;" >/dev/null 2>&1 || true
  pg_ctl -D "$PGDATA_DIR" -m fast -w stop >/dev/null 2>&1 || true
else
  echo "==> kept: psql -h $PGHOST -p $PGPORT -U $PGUSER -d $DBNAME"
fi

if [ "$fail" -gt 0 ]; then
  printf 'failed: %s\n' "${failed_files[@]}" >&2
  exit 1
fi
