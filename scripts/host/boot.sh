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

# Every phase line goes to stdout (the platform's log view) *and* to
# `.al-ai-host/logs/boot.log` with a monotonic offset from the first line. The
# 502 this deployment showed for ~40 s per restart could not be attributed: the
# platform's own log stream is a rolling buffer of request lines, so "was the
# port closed for 6 s or for 40 s, and was that us or the pull?" had no answer.
# One number per phase makes the next incident a measurement instead of a guess.
BOOT_T0=$(date +%s%3N)
log() {
  local now offset line
  now=$(date +%s%3N)
  offset=$(( (now - BOOT_T0) / 1000 ))
  line="[boot +${offset}s] $*"
  echo "$line"
  printf '%s %s\n' "$(date -u +%FT%T.%3NZ)" "$line" >>"$LOG_DIR/boot.log" 2>/dev/null || true
}

log "start: pid $$, HEAD $(git rev-parse --short HEAD 2>/dev/null || echo no-git), port $PORT, compiled=$COMPILED"

# --- bounded logs ----------------------------------------------------------
# Every service is launched through `tee -a`, so a log file grows until the
# disk is gone: a crash loop can write hundreds of MB in minutes, and the
# platform quota does not warn before it fills. `.al-ai-host/backups/` was
# already bounded (5 snapshots, sidecars removed with them); the logs were not.
#
# Truncate, never rename. `tee -a` holds an O_APPEND descriptor on the live
# file, so a rename would leave it writing into the rotated copy forever while
# the new file stayed empty — the classic rotation bug. Truncating in place
# keeps the descriptor valid and the next write lands at offset 0.
LOG_MAX_BYTES="${AL_AI_LOG_MAX_BYTES:-5242880}"   # 5 MiB per file
LOG_KEEP_LINES="${AL_AI_LOG_KEEP_LINES:-400}"

rotate_logs() {
  for file in "$LOG_DIR"/*.log; do
    [ -f "$file" ] || continue
    size=$(wc -c < "$file" 2>/dev/null || echo 0)
    [ "$size" -gt "$LOG_MAX_BYTES" ] 2>/dev/null || continue
    tail -n "$LOG_KEEP_LINES" "$file" > "$file.1" 2>/dev/null || true
    : > "$file" 2>/dev/null || true
    log "rotated $(basename "$file") (was $((size / 1024)) KiB, kept $LOG_KEEP_LINES lines)"
  done
}

# A previous run may have died with a full log; cap before starting, not after.
rotate_logs

bash scripts/host/setup.sh

pids=()
cleanup() {
  trap - INT TERM
  [ -n "${MAINT_LOOP_PID:-}" ] && kill "$MAINT_LOOP_PID" 2>/dev/null || true
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
  # The owner connection is only for the bootstrap: it starts nothing, it names
  # the role that will apply the schema. The services get the least-privilege
  # URL once PostgreSQL is ready (below), so the application never runs as the
  # cluster superuser it was initialised with.
  ADMIN_DATABASE_URL="$(node scripts/host/pg.mjs --print-url)"
  # The backup script reads this instead of `DATABASE_URL`: a scoped role would
  # otherwise export the row-policied tables empty and lose the account rows
  # silently on the next restore.
  export AL_AI_ADMIN_DATABASE_URL="$ADMIN_DATABASE_URL"

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

  # `--print-app-url` answers with `al_ai_app` (DML only, NOBYPASSRLS) and falls
  # back to the owner URL with a warning when the role cannot log in. The
  # fallback is deliberate: a role problem must not stop the deployment, and the
  # warning is what makes it visible instead of silent.
  #
  # The answer is validated before it becomes a connection string. pg.mjs keeps
  # stdout to one line, but a future log line on stdout would be captured here
  # and pg's parser would turn it into `host: "base"` instead of failing — an
  # outage that names nothing real. Last line, known scheme, or no change.
  APP_URL="$(node scripts/host/pg.mjs --print-app-url 2>/dev/null | tail -n 1)"
  case "$APP_URL" in
    postgres://*|postgresql://*)
      DATABASE_URL="$APP_URL"
      if [ "$DATABASE_URL" = "$ADMIN_DATABASE_URL" ]; then
        log "WARNING: the services are connecting as the database owner"
      else
        log "the services connect as the least-privilege application role"
      fi
      ;;
    *)
      DATABASE_URL="$ADMIN_DATABASE_URL"
      log "WARNING: the application role URL was unusable; the services connect as the database owner"
      ;;
  esac
  export DATABASE_URL

  # The bot is a separate identity: it serves every guild and has no session, so
  # the panel's row policies cannot describe it. `al_ai_bot` is that identity
  # (DML only, no DDL, BYPASSRLS) and it is handed to the bot process alone —
  # the dashboard above keeps the scoped application role. A role problem falls
  # back to the application URL instead of stopping the deployment.
  BOT_URL="$(node scripts/host/pg.mjs --print-bot-url 2>/dev/null | tail -n 1)"
  case "$BOT_URL" in
    postgres://*|postgresql://*) export BOT_DATABASE_URL="$BOT_URL" ;;
    *) log "WARNING: the bot role URL was unusable; the bot connects as the application role" ;;
  esac
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
  DATABASE_URL="${BOT_DATABASE_URL:-$DATABASE_URL}" NODE_OPTIONS="--max-old-space-size=$HEAP_BOT" node "$ROOT/host-build/bot.mjs" \
    > >(tee -a "$LOG_DIR/bot.log") 2>&1 &
else
  DATABASE_URL="${BOT_DATABASE_URL:-$DATABASE_URL}" NODE_OPTIONS="--max-old-space-size=$HEAP_BOT" node --import tsx apps/bot/src/index.ts \
    > >(tee -a "$LOG_DIR/bot.log") 2>&1 &
fi
pids+=($!)

# One maintenance loop does both jobs, so the deployment runs one extra bash
# child rather than two. A minute tick keeps a runaway log from ever reaching
# the cap for long; every 720 ticks (12 h) it takes a portable snapshot, so a
# crash between the platform's own backups never costs more than half a day of
# rows. The sleep runs in bash, so this costs no Node RSS while it waits.
(
  ticks=0
  while sleep 60; do
    ticks=$((ticks + 1))
    rotate_logs
    if [ $((ticks % 720)) -eq 0 ]; then
      node "$ROOT/scripts/db-export.mjs" --quiet >/dev/null 2>&1 || true
    fi
  done
) &
MAINT_LOOP_PID=$!

# One process dying ends the deployment on purpose: the platform restarts the
# whole slot, which is the only reliable recovery for a stack whose parts share
# one database and one 256 MB budget. Keeping a half-stack alive would serve a
# dashboard with no bot and hide the failure.
wait -n
status=$?
log "a service exited ($status); stopping the rest"
cleanup
exit "$status"
