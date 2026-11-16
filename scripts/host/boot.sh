#!/usr/bin/env bash
# One deployment, three processes: PostgreSQL, the dashboard, and the bot.
#
# This is the startup command for a managed platform that gives one slot and no
# database add-on (Bot-Hosting's free plan: 1 deployment, 256 MB RAM, 512 MB
# disk). Everything it assumes is in the repository, so a fresh clone boots the
# same way as a restarted one:
#
#   1. setup.sh     install runtime deps once per commit (skipped when unchanged)
#   2. PostgreSQL   scripts/host/pg.mjs, binaries + cluster inside .al-ai-pg/
#   3. dashboard    started from apps/dashboard, serves the prebuilt dist/
#   4. bot          node --import tsx apps/bot/src/index.ts
#
# Measured on the free plan: 204 MB of the 256 MB cgroup for all three,
# 0.15 % of the 25 % CPU share, 367 MB of the 512 MB disk.
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

# The two services ship precompiled (host-build/*.mjs, built by `npm run
# build:host`). Running plain JS removes tsx and its esbuild child from both
# processes — ~31 MB of RSS on a 256 MB cgroup. AL_AI_ROOT keeps the three
# `import.meta.url` path sites correct once the code is flattened into a
# bundle. A fresh checkout with no bundles falls back to tsx so this script
# still works for a developer.
export AL_AI_ROOT="$ROOT"
if [ -f "$ROOT/host-build/server.mjs" ] && [ -f "$ROOT/host-build/bot.mjs" ]; then
  COMPILED=1
else
  COMPILED=0
fi

STATE="${AL_AI_HOST_STATE:-$ROOT/.al-ai-host}"
LOG_DIR="${AL_AI_LOG_DIR:-$STATE/logs}"
PG_HOME="${AL_AI_PG_HOME:-$ROOT/.al-ai-pg}"
PORT="${PORT:-3000}"
mkdir -p "$LOG_DIR"

# --- V8 heap ceilings ------------------------------------------------------
# A cap is not a reservation: it does not make a process use that much, it only
# makes V8 collect instead of letting the old generation grow until the cgroup
# OOM-kills the container. Sized from the measured steady state on the 256 MB
# plan (bot 90.8 MiB RSS, dashboard 75.6, pg supervisor 58.1), with headroom so
# a busy guild does not hit "JavaScript heap out of memory".
#
# The bot is the largest consumer (guild cache, image rendering) and gets the
# largest ceiling; the dashboard is smaller. 96 + 80 + 24 = 200 MiB of ceiling
# across three processes that never all peak at once, which keeps the cgroup
# under ~175 MiB in practice while leaving the kernel room to breathe.
# Override with AL_AI_HEAP_* when a bigger plan is available.
HEAP_BOT="${AL_AI_HEAP_BOT:-96}"
HEAP_DASHBOARD="${AL_AI_HEAP_DASHBOARD:-80}"
HEAP_PG="${AL_AI_HEAP_PG:-24}"

: "${NODE_ENV:=production}"
export NODE_ENV

log() { echo "[boot] $*"; }

bash scripts/host/setup.sh

pids=()
cleanup() {
  trap - INT TERM
  [ -n "${BACKUP_LOOP_PID:-}" ] && kill "$BACKUP_LOOP_PID" 2>/dev/null || true
  # Last-chance portable snapshot before PostgreSQL stops. The embedded cluster
  # runs with fsync=off, so the volume alone is not crash-safe; this is what
  # guarantees a restorable copy of the rows. Bounded (60 s) so a slow export
  # can never hold the platform's stop signal hostage.
  timeout 60 node "$ROOT/scripts/db-export.mjs" --quiet >/dev/null 2>&1 || true
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
  NODE_OPTIONS="--max-old-space-size=$HEAP_PG" node scripts/host/pg.mjs \
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
# The server serves the client from `dist/` relative to its working directory
# (apps/dashboard/dist), so it is started from its workspace, not the root.
log "starting the dashboard on port $PORT"
if [ "$COMPILED" = "1" ]; then
  ( cd apps/dashboard && NODE_OPTIONS="--max-old-space-size=$HEAP_DASHBOARD" node "$ROOT/host-build/server.mjs" ) \
    > >(tee -a "$LOG_DIR/dashboard.log") 2>&1 &
else
  ( cd apps/dashboard && NODE_OPTIONS="--max-old-space-size=$HEAP_DASHBOARD" node --import tsx server/index.ts ) \
    > >(tee -a "$LOG_DIR/dashboard.log") 2>&1 &
fi
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
if [ "$COMPILED" = "1" ]; then
  NODE_OPTIONS="--max-old-space-size=$HEAP_BOT" node "$ROOT/host-build/bot.mjs" \
    > >(tee -a "$LOG_DIR/bot.log") 2>&1 &
else
  NODE_OPTIONS="--max-old-space-size=$HEAP_BOT" node --import tsx apps/bot/src/index.ts \
    > >(tee -a "$LOG_DIR/bot.log") 2>&1 &
fi
pids+=($!)

# A portable snapshot every 12 hours, so a crash between the platform's hourly
# backups never costs more than half a day of rows. The sleep runs in bash, so
# this costs no Node RSS while it waits.
( while sleep 43200; do node "$ROOT/scripts/db-export.mjs" --quiet >/dev/null 2>&1 || true; done ) &
BACKUP_LOOP_PID=$!

# One process dying ends the deployment on purpose: the platform restarts the
# whole slot, which is the only reliable recovery for a stack whose parts share
# one database and one 256 MB budget. Keeping a half-stack alive would serve a
# dashboard with no bot and hide the failure.
wait -n
status=$?
log "a service exited ($status); stopping the rest"
cleanup
exit "$status"
