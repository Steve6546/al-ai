# AL AI

Arabic RTL Discord management bot and secure control dashboard.

- `apps/bot` — the long-lived Discord Gateway client.
- `apps/dashboard` — the RTL dashboard UI **and** its BFF (Fastify, TypeScript).
- `packages/core` — shared contracts: event schema, permissions, crypto, session policy.
- `infra` — Dockerfiles, `docker-compose.yml`, and `schema.sql`.

This repository contains AL AI and nothing else. An earlier project that shared
the folder — a Lovable/TanStack icon studio with its own `src/`, `supabase/` and
Cloudflare build output — has been removed, and the root config files it owned
with it. A `package.json` at the root defines the two workspaces and nothing more.

The rules that keep this codebase coherent are in [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md).
Several of them are enforced by tests in `apps/bot/test/governance.test.ts`.

## 1. Configure

```bash
cp .env.example .env
```

Fill in `BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and generate the
three secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`KEY_ROTATION_DAYS` and `AUDIT_RETENTION_DAYS` are required whenever
`NODE_ENV=production`. They are never guessed.

## 2. Run with Docker (recommended)

```bash
docker-compose -f infra/docker-compose.yml up --build
```

Then open <http://localhost:3000>.

If your machine already runs PostgreSQL on 5432, set `POSTGRES_HOST_PORT` in `.env`
to a free port (the compose file publishes the container there).

## 3. Run against a local PostgreSQL

The stack runs without Docker as well. Point `DATABASE_URL` at a reachable
database, apply the schema, then start both processes:

```bash
psql "$DATABASE_URL" -f infra/schema.sql

npm run build --workspace=@al-ai/dashboard
npm run start --workspace=@al-ai/dashboard   # BFF + dashboard on :3000
npm run start --workspace=@al-ai/bot         # Discord client
```

The bot loads `.env` from its working directory. When it runs from the repository
root it picks up the root `.env`; the dashboard reads the process environment.

## 4. Deploy slash commands

Slash commands are **never** published at runtime. Deployment is a separate,
deliberate step:

```bash
npm run deploy-commands --workspace=@al-ai/bot
```

## 5. Verify

```bash
npm test     # 169 tests across three workspaces
npm run lint # type checks across all workspaces
```

| Suite | Covers |
|---|---|
| `apps/bot/test` (112) | crypto, nonces, routing, permissions, pipeline, customization sync, governance |
| `apps/dashboard/test` (16) | every screen renders without throwing |
| `packages/core/test` (41) | event schema, tiers, session policy, appearance normalisation |

The dashboard suite is a render smoke test: `vite build` proves the modules
resolve, but only executing a component catches the blank-page class of crash.

## Behaviour worth knowing

- The bot refuses to connect when any required secret is missing, and says which ones.
- A single-instance lock prevents two bot processes from sharing one token.
- The Gateway ceiling (120 events per 60 seconds) is respected by rescheduling work,
  never by dropping it. Voice churn is debounced for 2 seconds into one entry.
- `warning` and `critical` events are written to an append-only, AES-256-GCM
  encrypted audit trail, because Discord's own audit logs expire after 45 days.
- The dashboard never receives a token. Every write re-resolves the caller's tier
  on the server before it is allowed.

## Per-guild bot appearance

Discord gives an application **one** global avatar and banner, so a per-server
avatar is not something the API can express. What *is* per-guild is the bot's
nickname plus the colour and icon of its own role, and those are the only three
fields the customization screen offers.

The chain has four links, and all four are required for a setting to be real:

```
apps/dashboard/src/views/settings/customization.tsx   the form
  → apps/dashboard/server/index.ts                    the validated save
    → apps/bot/src/storage/database.ts                the read
      → apps/bot/src/lib/discord.ts                   the Discord call
```

Both the BFF (on write) and the bot (on read) normalise with the same helpers in
`packages/core/src/contracts.ts`, so a stored value cannot mean two different
things on the two sides. The bot applies changes on a 60-second tick, so a save
is never instant — see GOVERNANCE rule 18.
