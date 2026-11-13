# AL AI bot image. Runs the long-lived Gateway client under the supervisor.
FROM node:24.22.0-bookworm-slim
WORKDIR /app

COPY package*.json ./
COPY apps/bot/package.json apps/bot/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/core/package.json packages/core/package.json
# `npm ci`, not `npm install`: the lock is copied in above, and `npm install`
# is free to rewrite it. That mattered here — every manifest used to declare
# `latest`, so an image built a month later silently got a newer `tsx`, which is
# the program that runs the bot. `npm ci` installs exactly the locked tree and
# fails the build if the lock and the manifests disagree.
RUN npm ci

COPY packages/core packages/core
COPY apps/bot apps/bot

# The loader runs in-process (`--import tsx`), not through the `tsx` shim: the
# shim adds a wrapper process, so the SIGTERM an orchestrator sends reaches the
# wrapper instead of the supervisor and the graceful shutdown never runs, and it
# also costs a third process for esbuild. One process, one signal target.
# A heap ceiling, so a leak restarts the container instead of
# consuming the host's memory.
ENV NODE_OPTIONS="--max-old-space-size=2048"

CMD ["node", "--import", "tsx", "apps/bot/src/index.ts"]
