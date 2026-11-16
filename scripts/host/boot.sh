#!/usr/bin/env bash
# One deployment, three processes: PostgreSQL, the dashboard, and the bot.
#
# This is the startup command for a managed platform that gives one slot and no
# database add-on (Bot-Hosting's free plan: 1 deployment, 256 MB RAM, 512 MB
# disk). Everything it assumes is in the repository, so a fresh clone boots the
# same way as a restarted one:
#
#   1. setup.sh     install/build once per commit (skipped when unchanged)
#   2. PostgreSQL   scripts/host/pg.mjs, binaries + cluster inside .al-ai-pg/
#   3. dashboard    node --import tsx apps/dashboard/server/index.ts
#   4. bot          node --import tsx apps/bot/src/index.ts
#
# An external database wins: when `DATABASE_URL` is already in the environment
# (an operator who has a real PostgreSQL), step 2 is skipped entirely and
# nothing is downloaded.
#
# Logs go to stdout (the platform's log view) *and* `.al-ai-host/logs/`, so a
# crash can be read after the panel has moved on. Memory caps are per process:
# 256 MB is the whole budget here, and an uncapped V8 heap is what turns a small
# leak into a platform OOM kill that looks like a random restart.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

STATE="${AL_AI_HOST_STATE:-$ROOT/.al-ai-host}"
LOG_DIR="${AL_AI_LOG_DIR:-$STATE/logs}"
PG_HOME="${AL_AI_PG_HOME:-$ROOT/.al-ai-pg}"
PORT="${PORT:-3000}"
mkdir -p "$LOG_DIR"

: "${NODE_ENV:=production}"
export NODE_ENV

log() { echo "[boot] $*"; }

bash scripts/host/setup.sh

pids=()
cleanup() {
  trap - INT TERM
  for pid in "${pids[@]:-}"; do
    kill "$pid" 2>/dev/null || true
  done
  # Give PostgreSQL its `-m fast` shutdown; the other two exit on SIGTERM.
  wait 2>/dev/null || true
}
trap cleanup INT TERM

# --- PostgreSQL ------------------------------------------------------------
# `--print-url` mints/stores the password on first use and prints the URL; the
# password itself never appears in a log or in `env`.
if [ -z "${DATABASE_URL:-}" ]; then
  export PGDATA="$PG_HOME/data"
  export PGPORT="${PGPORT:-5432}"
  DATABASE_URL="$(node scripts/host/pg.mjs --print-url)"
  export DATABASE_URL

  rm -f "$PG_HOME/ready"
  log "starting PostgreSQL (embedded, $PGPORT)"
  NODE_OPTIONS="--max-old-space-size=48" node scripts/host/pg.mjs \
    > >(tee -a "$LOG_DIR/postgres.log") 2>&1 &
  pids+=($!)

  for _ in $(seq 1 180); do
    [ -f "$PG_HOME/ready" ] && break
    if ! kill -0 "${pids[0]}" 2>/dev/null; then
      log "PostgreSQL exited during startup; last lines:"
      tail -n 40 "$LOG_DIR/postgres.log" >&2 || true
      exit 1
    fi
    sleep 1
  done
  if [ ! -f "$PG_HOME/ready" ]; then
    log "PostgreSQL did not become ready within 180s"
    exit 1
  fi
  log "PostgreSQL ready"
else
  log "using the DATABASE_URL from the environment; no local database is started"
fi

# --- dashboard -------------------------------------------------------------
log "starting the dashboard on port $PORT"
NODE_OPTIONS="--max-old-space-size=96" node --import tsx apps/dashboard/server/index.ts \
  > >(tee -a "$LOG_DIR/dashboard.log") 2>&1 &
pids+=($!)

for _ in $(seq 1 120); do
  if (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
    break
  fi
  if ! kill -0 "${pids[-1]}" 2>/dev/null; then
    log "the dashboard exited during startup; last lines:"
    tail -n 40 "$LOG_DIR/dashboard.log" >&2 || true
    exit 1
  fi
  sleep 1
done
if ! (exec 3<>"/dev/tcp/127.0.0.1/$PORT") 2>/dev/null; then
  log "the dashboard did not open port $PORT within 120s"
  exit 1
fi
log "dashboard ready"

# --- bot -------------------------------------------------------------------
log "starting the Discord bot"
NODE_OPTIONS="--max-old-space-size=80" node --import tsx apps/bot/src/index.ts \
  > >(tee -a "$LOG_DIR/bot.log") 2>&1 &
pids+=($!)

# One process dying ends the deployment on purpose: the platform restarts the
# whole slot, which is the only reliable recovery for a stack whose parts share
# one database and one 256 MB budget. Keeping a half-stack alive would serve a
# dashboard with no bot and hide the failure.
wait -n
status=$?
log "a service exited ($status); stopping the rest"
cleanup
exit "$status"
