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
# The local `tsx` binary, not `npx` - the same reason as the bot image: `npx`
# wraps the program, and the wrapper is what receives the stop signal.
CMD ["../../node_modules/.bin/tsx", "server/index.ts"]
