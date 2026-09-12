# AL AI bot image. Runs the long-lived Gateway client under the supervisor.
FROM node:22-bookworm-slim
WORKDIR /app

COPY package*.json ./
COPY apps/bot/package.json apps/bot/package.json
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY packages/core/package.json packages/core/package.json
RUN npm install

COPY packages/core packages/core
COPY apps/bot apps/bot

# exec form so SIGTERM reaches the supervisor for a graceful shutdown
CMD ["npx", "tsx", "apps/bot/src/index.ts"]
