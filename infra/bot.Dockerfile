# AL AI bot image. Runs the long-lived Gateway client under the supervisor.
FROM node:22-bookworm-slim
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

# exec form so SIGTERM reaches the supervisor for a graceful shutdown
CMD ["npx", "tsx", "apps/bot/src/index.ts"]
