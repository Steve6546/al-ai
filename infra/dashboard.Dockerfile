# AL AI dashboard image: builds the RTL dashboard, then serves it from the BFF.
FROM node:24.22.0-bookworm-slim AS build
WORKDIR /app
COPY package*.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY packages/core/package.json packages/core/package.json
# `npm ci` for the same reason as the bot image: the lock is copied in, and the
# image must install the tree that was tested rather than whatever is newest.
RUN npm ci
COPY packages/core packages/core
COPY apps/dashboard apps/dashboard
RUN npm run build --workspace=@al-ai/dashboard

FROM node:24.22.0-bookworm-slim
WORKDIR /app
COPY package*.json ./
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY apps/bot/package.json apps/bot/package.json
COPY packages/core/package.json packages/core/package.json
# `npm ci` for the same reason as the bot image: the lock is copied in, and the
# image must install the tree that was tested rather than whatever is newest.
RUN npm ci
COPY packages/core packages/core
COPY apps/dashboard/server apps/dashboard/server
COPY apps/dashboard/package.json apps/dashboard/package.json
COPY --from=build /app/apps/dashboard/dist apps/dashboard/dist
WORKDIR /app/apps/dashboard
EXPOSE 3000
# The loader runs in-process (`--import tsx`), not through the `tsx` shim - the
# same reason as the bot image: the shim wraps the program, and the wrapper is
# what receives the stop signal. One process also means one heap to bound.
# A heap ceiling, so a leak restarts the container instead of
# consuming the host's memory.
ENV NODE_OPTIONS="--max-old-space-size=512"

CMD ["node", "--import", "tsx", "server/index.ts"]
