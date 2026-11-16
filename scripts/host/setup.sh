#!/usr/bin/env bash
# Install and build the stack once per commit, on a host that has 512 MB of disk.
#
# `boot.sh` calls this on every start. The work is skipped entirely when the
# commit and the lockfile are unchanged, so a restart costs one `git rev-parse`
# and one `sha256sum`. When either moves, the sequence is:
#
#   full install -> client build -> prune dev dependencies
#
# The prune is not optional here: the tree with dev dependencies is ~320 MB and
# a free plan ships 512 MB shared with a ~200 MB PostgreSQL build. The server
# runs TypeScript through `tsx`, which is a *runtime* dependency of both apps,
# so nothing needed after the build is a dev dependency.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"

STATE="${AL_AI_HOST_STATE:-$ROOT/.al-ai-host}"
mkdir -p "$STATE"

fingerprint() {
  {
    git rev-parse HEAD 2>/dev/null || echo "no-git"
    sha256sum package-lock.json | cut -d' ' -f1
    sha256sum package.json | cut -d' ' -f1
  } | tr '\n' '-'
}

want="$(fingerprint)"
have="$(cat "$STATE/setup-fingerprint" 2>/dev/null || true)"

if [ "$want" = "$have" ] \
  && [ -x node_modules/.bin/tsx ] \
  && [ -f apps/dashboard/dist/index.html ]; then
  echo "[setup] up to date ($want)"
  exit 0
fi

echo "[setup] installing and building ($want)"
# npm's own resolver needs more heap than the 256 MB cgroup leaves a Node
# process, and the kernel answers with SIGKILL (just "Killed" in the log). Each
# step gets a ceiling small enough to keep RSS inside the limit; `tsx` and the
# servers get their own caps in boot.sh.
NODE_OPTIONS="--max-old-space-size=144" npm ci --include=dev --ignore-scripts \
  --no-audit --no-fund --no-progress --loglevel=error
NODE_OPTIONS="--max-old-space-size=176" npm run build --workspace=@al-ai/dashboard

# Drop the build toolchain the server never loads. `--omit=dev` is what makes
# the second pass remove vite/React/typescript instead of leaving them behind as
# "extraneous" for the next boot to trip over.
NODE_OPTIONS="--max-old-space-size=144" npm prune --omit=dev \
  --no-audit --no-fund --no-progress --loglevel=error

echo "$want" >"$STATE/setup-fingerprint"
echo "[setup] ready"
