# Deploying AL AI on Bot-Hosting.net

The panel's free tier is the only target this document treats as real: **one
deployment, 256 MB RAM, 25 % of a CPU, 512 MB disk, renewed by hand every four
days**. Everything below was measured against that container, not inferred from
a plan table.

The paid layout (three deployments, one of them `runtime: postgresql`) is kept
at the end as the alternative. It is not the active path and nothing below
depends on it.

## The free plan, as it actually behaves

| Property | Value | Consequence |
| --- | --- | --- |
| Slots | 1 | an app and a database cannot be two deployments |
| RAM | 256 MB | three processes share one cgroup limit; there is no second budget |
| CPU | 25 % of a core | a V8 heap with no ceiling will be OOM-killed before it is slow |
| Disk | 512 MB | the source tree, `node_modules`, the build and PostgreSQL all fit in one budget |
| Lifetime | 4 active days + 3-day grace | the deployment is **suspended** until an operator renews it in Billing |
| Runtime | Node.js 24, npm 12, git, `gcc` | native modules and a compiled shim are possible |
| Missing | `sudo`, `unshare`, `/etc/passwd` entry for uid 999 | no namespace tricks, and `initdb` needs a `getpwuid` answer |

Suspension is not an error state: `deployments_shell` answers `suspended: This
deployment is suspended.`, the panel shows *Renew free plan*, and the same
deployment comes back untouched after renewal. If the grace window closes, the
panel deletes the deployment and keeps a backup for one day.

## Accepted layout: one deployment, three processes

```
bash scripts/host/boot.sh                     <- startup command
├── scripts/host/setup.sh                     install + client build, once per commit
├── PostgreSQL 18.6 (scripts/host/pg.mjs)     127.0.0.1:5432, data in .al-ai-pg/
├── dashboard                                 0.0.0.0:$PORT, served behind the platform proxy
└── bot                                       Discord gateway, no port
```

Why each piece exists:

- **One slot** rules out `runtime: postgresql`, so the database lives inside the
  deployment. `@embedded-postgres/linux-x64` ships the official PostgreSQL
  build; `pg.mjs` does the four things that build needs in this container:
  unpack once, recreate the `lib*.so.N` symlinks npm drops, compile a
  `getpwuid`/`getgrgid` shim for uid 999, and `initdb` with 256 MB tuning
  (`shared_buffers=16MB`, 1 MB WAL segments, `max_wal_senders=0`).
- **`infra/schema.sql`** is applied on every boot and is idempotent, so a fresh
  volume and an existing one take the same path — 29 tables, 50 indexes, one
  function.
- **`AL_AI_PLATFORM_HOST`** is what makes the dashboard answer at all. The
  platform terminates TLS and forwards to the container port from its own
  network, so the request's TCP peer is never loopback. The Host gate accepts
  exactly the configured hostname and keeps refusing everything else; ports
  are still checked.
- **`boot.sh`** starts the database, waits for it, starts the dashboard, waits
  for its port, then starts the bot, and ends the whole deployment (`wait -n`)
  when any of the three dies. A half stack that serves a dashboard with no bot
  is worse than a restart: the platform's restart is the only reliable recovery
  for parts that share one database and one memory budget.

Per-process heap ceilings: `48` (PostgreSQL's supervisor), `96` (dashboard),
`80` (bot). PostgreSQL's own main process measured **≈ 16 MB RSS** on this
image; the dashboard stays under 100 MB during the load check. The three
together must stay below 256 MB — `scripts/host/boot.sh` is the place where
that budget is visible, and the first verification run after renewal records
the number.

## Environment

Set with `env_set` on the deployment (`secret: true` for the five credentials),
never as a committed `.env`. `NODE_ENV=production` makes a missing operational
setting a startup failure.

| Key | Value | Notes |
| --- | --- | --- |
| `NODE_ENV` | `production` | |
| `PORT` | `25880` | the panel's published port |
| `DATABASE_URL` | *leave unset* | `boot.sh` builds it from the embedded cluster |
| `POSTGRES_PASSWORD` | optional | when unset the first boot mints one into `.al-ai-pg/password` |
| `BOT_TOKEN` | secret | |
| `DISCORD_CLIENT_ID` / `DISCORD_CLIENT_SECRET` | secret | |
| `DISCORD_REDIRECT_URI` | `https://<subdomain>.apps.bot-hosting.cloud/auth/discord/callback` | must match the developer portal exactly |
| `SESSION_SECRET` | secret, 64 hex | |
| `EVENT_HMAC_SECRET` | secret | both processes |
| `ENCRYPTION_KEY` | secret | both processes; rotating it needs `scripts/rotate-encryption-key.mts` |
| `KEY_ROTATION_DAYS` / `AUDIT_RETENTION_DAYS` | integers | required when `NODE_ENV=production` |
| `DASHBOARD_URL` | the public HTTPS origin | |
| `DASHBOARD_INTERNAL_URL` | `http://127.0.0.1:25880` | |
| `AL_AI_PLATFORM_HOST` | `<subdomain>.apps.bot-hosting.cloud` | exact host, no scheme, no port |
| `OWNER_ID` | the platform owner's Discord id | gates instance-wide surfaces |
| `AL_AI_REMOTE_ACCESS` | unset | the platform replaces ngrok; the tunnel is off |
| `BOT_LOCK_FILE` | `/tmp/al-ai-bot.lock` | one bot per container |
| `NODE_OPTIONS` | unset | heap ceilings are set per process in `boot.sh` |

If an operator ever has a real database, setting `DATABASE_URL` skips the
embedded cluster entirely: `boot.sh` starts no PostgreSQL and downloads nothing.

## First boot on a wiped volume

```sh
git clone https://github.com/Steve6546/al-ai /home/container   # the panel does this
cd /home/container
bash scripts/host/setup.sh      # npm ci, vite build, prune dev dependencies
bash scripts/host/boot.sh       # database + dashboard + bot
```

The order matters only on a cold volume; `setup.sh` is fingerprinted by commit +
`package-lock.json`, so a restart costs one `git rev-parse`. Set the startup
command to `bash scripts/host/boot.sh` and let auto-pull bring new commits in.

`setup.sh` prunes dev dependencies on purpose: the full tree is ~320 MB and the
disk is 512 MB, shared with a ~200 MB PostgreSQL build. Everything needed after
the client build (`tsx`, `fastify`, `pg`) is a runtime dependency.

## Verifying a deployment

1. `deployments_check` → `/api/health` over the public URL.
2. `curl -s https://<subdomain>/api/health` from the panel shell, and
   `deployments_logs` for `[db] ready`, `dashboard ready`, `[boot] starting the
   Discord bot`.
3. Memory: `cat /sys/fs/cgroup/memory.current` after ten minutes of gateway
   traffic, compared with `memory.max` (268435456).
4. Data survives a restart: create a row through the dashboard, `power stop`,
   `power start`, read it again.
5. OAuth: sign in from the public URL; the callback must return to the same
   origin (`DISCORD_REDIRECT_URI`), not to `localhost`.
6. Bot: one slash command round-trip, and `deployments_logs` for the gateway's
   ready line.
7. Auto-pull: push a no-op commit, restart, confirm `git log -1` matches.

## Renewal (every four days)

`https://bot-hosting.net/dash` → **Renew free plan** → complete the Cloudflare
check → **Renew for 4 days**. The check is interactive and cannot be scripted;
it needs a person. The account banner states the deletion deadline while the
deployment is suspended. Renewing during grace restores the same deployment,
volume and database — nothing is re-installed.

## Paid alternative (not the active path)

| Deployment | Runtime | RAM | Role |
| --- | --- | --- | --- |
| `al-ai` | nodejs 24 | 512 MB | dashboard BFF + built SPA |
| `al-ai-bot` | nodejs 24 | 768 MB | gateway client + image rendering |
| `al-ai-db` | postgresql | 512 MB | `infra/schema.sql` |

Starter+ (£2.59/month: 2 GB, 4 slots) fits that table with headroom; Starter
(1 GB, 2 slots) fits only if the dashboard and bot share a deployment. With
three slots, drop `scripts/host/` entirely and point `DATABASE_URL` at the
database deployment, which is the configuration `DEPLOYMENT.md` describes for a
self-hosted machine.

## What this path does not promise

- **256 MB is a ceiling, not a target.** Measured RSS after renewal decides
  whether all three fit; if the cgroup OOM-kills the stack during image
  rendering, the honest fix is fewer features on the free plan or a paid plan,
  not a bigger swap the container does not have.
- **Renewal is manual.** A suspended deployment serves nothing, and no code in
  this repository can change that.
- **`fsync=off`** is deliberate for this throwaway volume: host-crash durability
  is traded for CPU and WAL size. A real database uses the defaults.
