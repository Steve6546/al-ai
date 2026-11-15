#!/usr/bin/env bash
# Linux runner for the AL AI stack.
#
# The repository ships Windows PowerShell entry points; this is the equivalent
# for a Linux host or container. Order matters:
#   docker daemon -> PostgreSQL -> dashboard -> loopback relay -> bot
# Every long-lived process is started with setsid so it survives the shell that
# launched it (a plain `nohup ... &` is killed when the launching session ends).
#
#   ./scripts/run-linux-stack.sh            # dashboard + database + relay
#   ./scripts/run-linux-stack.sh --with-bot # also start the Discord bot
set -u
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
LOG_DIR="${AL_AI_LOG_DIR:-/tmp/al-ai}"
mkdir -p "$LOG_DIR"

env_value() { grep -E "^$1=" .env 2>/dev/null | head -1 | cut -d= -f2-; }

# 1. Docker daemon — PostgreSQL runs as a container.
if ! docker info >/dev/null 2>&1; then
  echo "starting dockerd..."
  setsid sudo nohup dockerd >"$LOG_DIR/dockerd.log" 2>&1 </dev/null &
  for _ in $(seq 1 30); do docker info >/dev/null 2>&1 && break; sleep 1; done
  sudo chmod 666 /var/run/docker.sock 2>/dev/null || true
fi

# 2. PostgreSQL on the port DATABASE_URL names.
POSTGRES_HOST_PORT="$(env_value POSTGRES_HOST_PORT)"; POSTGRES_HOST_PORT="${POSTGRES_HOST_PORT:-55432}"
POSTGRES_HOST_PORT="$POSTGRES_HOST_PORT" docker compose -f infra/docker-compose.yml up -d postgres >>"$LOG_DIR/postgres.log" 2>&1
for _ in $(seq 1 40); do
  [ "$(docker inspect --format='{{.State.Health.Status}}' infra-postgres-1 2>/dev/null)" = "healthy" ] && break
  sleep 2
done

# 3. Dashboard BFF + SPA. It does not read .env on its own.
#
# `node --import tsx`, not the `tsx` shim: the shim spawns a second Node process
# for the loader and a third for esbuild, so one service costs three processes
# and ~220MB. Running the loader in-process keeps it to one process (~100MB),
# and the SIGTERM an orchestrator sends reaches the server itself.
PORT_VALUE="$(env_value PORT)"; PORT_VALUE="${PORT_VALUE:-3000}"
if ! curl -s --noproxy '*' -o /dev/null "http://127.0.0.1:${PORT_VALUE}/api/health"; then
  ( cd apps/dashboard && setsid nohup node --import tsx --env-file="$ROOT/.env" server/index.ts >"$LOG_DIR/dashboard.log" 2>&1 </dev/null & )
  for _ in $(seq 1 30); do
    curl -s --noproxy '*' -o /dev/null "http://127.0.0.1:${PORT_VALUE}/api/health" && break
    sleep 1
  done
fi

# 4. Loopback relay. The dashboard's reach gate answers its deployment hostname
#    only for a loopback peer (the rule it applies to ngrok's agent); a platform
#    that publishes the app on its own port needs a relay that connects over
#    loopback and presents that hostname. LISTEN_PORT accepts a comma-separated
#    list so a host publishing several ports still costs one relay process.
#    Both come from the environment, so a local run simply skips this step.
RELAY_PORTS="${AL_AI_RELAY_LISTEN_PORTS:-${AL_AI_RELAY_LISTEN_PORT:-}}"
if [ -n "$RELAY_PORTS" ] && [ -n "${AL_AI_TUNNEL_HOST:-}" ]; then
  FIRST_PORT="${RELAY_PORTS%%,*}"
  if ! curl -s --noproxy '*' -o /dev/null "http://127.0.0.1:${FIRST_PORT}/api/health"; then
    setsid nohup node "$ROOT/scripts/linux/port-forward.mjs" \
      "$RELAY_PORTS" "$PORT_VALUE" "$AL_AI_TUNNEL_HOST" \
      >"$LOG_DIR/relay.log" 2>&1 </dev/null &
    sleep 2
  fi
fi

# 5. The bot only connects when real secrets are present; without them it prints
#    what is missing and exits, by design.
if [ "${1:-}" = "--with-bot" ]; then
  ( cd apps/bot && setsid nohup node --import tsx --env-file="$ROOT/.env" src/index.ts >"$LOG_DIR/bot.log" 2>&1 </dev/null & )
  sleep 5
  tail -5 "$LOG_DIR/bot.log" 2>/dev/null || true
fi

echo "dashboard: http://127.0.0.1:${PORT_VALUE}"
curl -s --noproxy '*' "http://127.0.0.1:${PORT_VALUE}/api/health" || true
echo
