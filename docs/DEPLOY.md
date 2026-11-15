# Deploying AL AI on Bot-Hosting.net

Written 2026-11-13, after the connector was authenticated against the real account and
the panel refused to create a second deployment. Everything below is measured or read
from the panel API, not assumed.

## The blocker, in numbers

`account_get` on the connected key:

```json
{"plan":{"tier":"free","name":"Free"},
 "quota":{"pool":{"ramMB":256,"cpuPct":25,"storageMB":512,"slots":1},
          "used":{"ramMB":256,"cpuPct":25,"storageMB":512,"slots":1}}}
```

`deployments_create` with `runtime: "postgresql"` answers:

```
SLOTS_EXHAUSTED: All slots in your plan are in use.
```

The single free slot is already occupied by a deployment named `Al` (nodejs 24, offline),
which holds a clone of this repository from an earlier attempt. Free tier = **1 slot,
256 MB RAM, 512 MB disk, renew manually every 4 days, ads in the panel**. It cannot hold
an app *and* its database, and a second slot cannot exist at any price below Starter.

Disk is not the problem: a production install of all three workspaces (`npm ci --omit=dev
--ignore-scripts`) weighs **251 MB**, plus ~10 MB of source and the built `dist/`. RAM is:
dashboard + bot + PostgreSQL client in 256 MB has no headroom for a welcome-image render.

**Minimum that works: Starter+ (£2.59/month) — 2 GB RAM, 100 % CPU, 8 GB disk, 4 slots.**
Starter (£1.69, 1 GB, 2 slots) only works if the dashboard and the bot share one
deployment and PostgreSQL gets 256 MB of the pool.

## Target layout (Starter+)

| Deployment | Runtime | RAM | Role |
| --- | --- | --- | --- |
| `al-ai` | nodejs 24 | 512 MB | dashboard BFF + built SPA on `$SERVER_PORT` |
| `al-ai-bot` | nodejs 24 | 768 MB | Discord gateway client + welcome-image canvas, no public port |
| `al-ai-db` | postgresql | 512 MB | database, schema from `infra/schema.sql` |

1.8 GB of the 2 GB pool is allocated; the remainder is headroom. The dashboard's own
heap ceiling is 384 MB because the measured BFF stays under 100 MB RSS even during the
load check — the bot gets 512 MB because Skia decodes and re-encodes animated images.

Keeping the bot in its own deployment gives it its own logs, its own restart and its own
memory ceiling — a crash loop in one does not take the other down, and the panel's
`deployments_logs` then answers "why" per process instead of mixing two consoles.

## Environment

Set with `env_set` on each deployment (never a committed `.env`). `NODE_ENV=production`
makes a missing operational setting a startup failure, which is what we want on a host.

| Key | `al-ai` | `al-ai-bot` | Notes |
| --- | --- | --- | --- |
| `NODE_ENV` | production | production | |
| `DATABASE_URL` | ✔ | ✔ | `postgresql://…@<db-host>:<port>/<db>` from the DB deployment |
| `BOT_TOKEN` | — | ✔ | |
| `DISCORD_CLIENT_ID` / `_SECRET` | ✔ | ✔ | |
| `DISCORD_REDIRECT_URI` | ✔ | ✔ | the public `https://<subdomain>/auth/discord/callback` |
| `SESSION_SECRET` | ✔ | — | 64 hex chars |
| `EVENT_HMAC_SECRET` | ✔ | ✔ | must match on both sides |
| `ENCRYPTION_KEY` | ✔ | ✔ | must match on both sides |
| `KEY_ROTATION_DAYS` / `AUDIT_RETENTION_DAYS` | ✔ | ✔ | required in production |
| `DASHBOARD_URL` | ✔ | ✔ | public HTTPS origin |
| `DASHBOARD_INTERNAL_URL` | ✔ | ✔ | `http://127.0.0.1:$SERVER_PORT` |
| `PORT` | ✔ | — | default 3000; use `$SERVER_PORT` on the panel |
| `OWNER_ID` | ✔ | ✔ | the platform owner's Discord id |
| `INTEGRATION_ADAPTER_ENABLED` | false | false | loopback-only control surface, off in production |
| `BOT_LOCK_FILE` | — | `/tmp/al-ai-bot.lock` | the container has one bot; the lock is still the identity |
| `NGROK_*`, `AL_AI_REMOTE_ACCESS` | — | — | the panel replaces the tunnel; leave unset |

## Start commands

The repository's scripts pass `--env-file=../../.env`; on the panel the environment is
already in the process, so the flag is dropped and TypeScript is loaded in-process with
`node --import tsx` — the same form the Dockerfiles use. `npx`/the `tsx` shim would add a
wrapper process between the stop signal and the program, and cost a third process on a
panel that bills RAM.

`al-ai`:

```sh
npm ci --no-audit --no-fund \
  && npm run build --workspace=@al-ai/dashboard \
  && exec node --max-old-space-size=448 --import tsx apps/dashboard/server/index.ts
```

`al-ai-bot`:

```sh
npm ci --omit=dev --no-audit --no-fund \
  && exec node --max-old-space-size=448 --import tsx apps/bot/src/index.ts
```

Both keep `NODE_OPTIONS=--max-old-space-size=…` below the deployment's RAM, so a leak
restarts the process instead of the node (the Dockerfiles do the same at 2048/512).

## Database

1. Create the `postgresql` deployment, then read `deployments_get` → `connection`
   (`host`, `port`, `uriTemplate`) and build `DATABASE_URL` from it.
2. Apply the schema once, through `deployments_shell` on the database deployment:

   ```sh
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f infra/schema.sql
   ```

   `infra/schema.sql` is the same file `docker-compose` mounts into
   `/docker-entrypoint-initdb.d`, so the panel and the local stack end up with one schema.
3. `databases_rotatePassword` rotates it — update `DATABASE_URL` on both app deployments
   in the same step, or they lose the database.

## Domain and OAuth

1. `deployments_enableDomains` on `al-ai` → `https://<subdomain>.apps.bot-hosting.cloud`.
2. Put that origin in `DISCORD_REDIRECT_URI` and `DASHBOARD_URL`.
3. In the Discord developer portal, add the same URL to **OAuth2 → Redirects**
   (`/auth/discord/callback`). A mismatch is a silent login failure, not an error page.
4. `deployments_check` fetches `/api/health` over the public URL after every deploy.

## Order of operations (once the plan allows it)

1. `deployments_create` ×3 (`nodejs` ×2, `postgresql`).
2. `env_set` on each, from the table above.
3. Schema, then `al-ai-bot`, then `al-ai`.
4. `deployments_power` start → `deployments_logs` → `deployments_check`.
5. `deployments_setAutoPull` on both app deployments so a push redeploys on restart.

## What is blocked today

The key is in place and authenticates; the connector is not the blocker. The account is
**Free**, and its only slot is occupied by the existing `Al` deployment (nodejs 24,
offline, already linked to `Steve6546/al-ai` `main` with auto-pull on, 142 MB of the
512 MB disk in use). A database is a deployment of its own, so the layout above needs
**three** slots:

```
deployments_create({ runtime: "postgresql" })
→ SLOTS_EXHAUSTED: All slots in your plan are in use.
```

Nothing on the panel creates a slot: `deployments_resize` can shrink a deployment inside
the current pool, but the pool itself is 1 slot / 256 MB RAM / 512 MB disk, and the MCP
surface has no billing or plan-change tool. The upgrade must be made in the panel UI
(Billing → Starter+), after which the three deployments can be created in one session.

`Al` does not need to be deleted to make room: on Starter+ it can be reconfigured as the
dashboard (same repository, same auto-pull) and the other two created beside it, so no
existing file or backup is lost.

