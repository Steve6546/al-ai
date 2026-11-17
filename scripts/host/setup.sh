#!/usr/bin/env bash
# Prepare the runtime on a host with 256 MB of RAM and 512 MB of disk.
#
# `boot.sh` calls this on every start; the work is skipped when the dependency
# graph is unchanged, so a restart or a code-only deploy costs one `git
# rev-parse` and two `sha256sum`. When the lockfile moves:
#
#   install runtime dependencies -> verify the prebuilt client -> drop the cache
#
# Two constraints shaped this script, both measured on the real container:
#
#   1. The client bundle is built *here*? No. `vite build` needs ~320 MB of
#      dev dependencies plus a Node heap, and the cgroup kills npm outright
#      (SIGKILL, no message) long before the build starts. The bundle is built
#      on a workstation and uploaded to `apps/dashboard/dist`; this script only
#      refuses to continue when it is missing, because a dashboard that serves
#      404 for every page while /api/health says "healthy" is worse than a
#      failed boot.
#   2. A root `npm ci` OOMs. Even `--omit=dev` resolves the whole lockfile in
#      one ideal tree. Installing one workspace at a time keeps each pass under
#      the limit: the dashboard is ~60 packages now that the client libraries
#      live in devDependencies, the bot 48 (including the prebuilt canvas
#      binaries, so no compiler and no optional-package omission).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

STATE="${AL_AI_HOST_STATE:-$ROOT/.al-ai-host}"
mkdir -p "$STATE"

# The install is a function of the dependency graph, never of the commit.
#
# This used to hash `git rev-parse HEAD` too, so *any* deploy — a docs page, a
# README typo, a comment — re-ran both `npm ci` passes. Measured on this plan
# that is 100–180 s during which nothing listens on $PORT, which the platform's
# proxy answers with `502 App is unreachable` for the whole window. The install
# was not skipped because it was needed; it was re-run because a file changed in
# a directory npm never reads.
#
# `package-lock.json` already pins every workspace dependency, and npm rewrites
# it whenever a workspace `package.json` changes, so this pair is the whole
# input. The commit is still recorded, but as a label — not as a trigger.
fingerprint() {
  {
    sha256sum package-lock.json | cut -d' ' -f1
    sha256sum package.json | cut -d' ' -f1
  } | tr '\n' '-'
}

want="$(fingerprint)"
have="$(cat "$STATE/setup-fingerprint" 2>/dev/null || true)"

# The fingerprint says what was installed; these say it is still there. A
# restart after a partial install, a wiped node_modules or a missing bundle must
# re-run the work even when the lockfile has not moved.
installed() {
  [ -x node_modules/.bin/tsx ] \
    && [ -d node_modules/pg ] \
    && [ -d node_modules/@al-ai/core ] \
    && [ -f apps/dashboard/dist/index.html ]
}

if [ "$want" = "$have" ] && installed; then
  git rev-parse HEAD >"$STATE/setup-commit" 2>/dev/null || true
  echo "[setup] up to date (deps unchanged, $(git rev-parse --short HEAD 2>/dev/null || echo no-git))"
  exit 0
fi

# The bundle is not produced on this host (see the header). Fail loudly and
# early: boot.sh would otherwise start a server whose every page 404s.
if [ ! -f apps/dashboard/dist/index.html ]; then
  echo "[setup] apps/dashboard/dist/index.html is missing." >&2
  echo "[setup] Build the client locally (npm run build --workspace=@al-ai/dashboard)" >&2
  echo "[setup] and upload apps/dashboard/dist to the volume; this host cannot." >&2
  exit 1
fi

echo "[setup] installing runtime dependencies ($want)"
export NODE_OPTIONS="--max-old-space-size=96"

npm ci --omit=dev --omit=optional --workspace=@al-ai/dashboard \
  --ignore-scripts --no-audit --no-fund --no-progress --loglevel=error
# `install`, not a second `ci`: ci deletes node_modules before it links. This
# pass adds the bot's tree next to the dashboard's without touching the lock.
npm install --omit=dev --workspace=@al-ai/bot \
  --ignore-scripts --no-audit --no-fund --no-progress --loglevel=error --no-save

# The npm cache is 100 MB of tarballs this volume does not have room for, and
# a container restart never reuses it.
npm cache clean --force

# Dead native binaries. The host is glibc (Debian 13); npm still installs the
# musl Skia build (30 MB) and it is never loaded. When the precompiled bundle
# is present the host never runs tsx, so its esbuild platform package is dead
# weight too — it is kept only when there is no bundle, because the tsx
# fallback in boot.sh needs it.
rm -rf node_modules/@napi-rs/canvas-linux-x64-musl
if [ -f host-build/bot.mjs ] && [ -f host-build/server.mjs ]; then
  rm -rf node_modules/@esbuild
fi

echo "$want" >"$STATE/setup-fingerprint"
git rev-parse HEAD >"$STATE/setup-commit" 2>/dev/null || true
echo "[setup] ready"
