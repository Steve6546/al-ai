# Deploying AL AI

One start command covers every host: **`bash scripts/host/boot.sh`** (or
`node index.js`, which delegates to it). It starts the embedded PostgreSQL when
`DATABASE_URL` is blank, waits for it, starts the dashboard, waits for its port,
then starts the bot. If any of the three dies the whole deployment ends on
purpose, because the platform restart is the only reliable recovery for parts
that share one database and one memory budget.

| Target | Start command | Database |
| --- | --- | --- |
| Bot-Hosting (Free/Starter) | `bash scripts/host/boot.sh` | embedded (blank `DATABASE_URL`) |
| Any VPS / Pterodactyl | `node index.js` | embedded, or your own |
| Docker | `infra/docker-compose.yml` | a real PostgreSQL service |
| PaaS (Railway/Render) | `node index.js` | managed; set `DATABASE_URL` |
| Local workstation | `npm run dev` | the local cluster on 55432 |

The rest of this document treats **Bot-Hosting's free tier as the real target**:
one deployment, 256 MB RAM, 25 % of a CPU, 512 MB disk, renewed by hand every
four days. Everything below was measured against that container, not inferred
from a plan table. For local development see [DEPLOYMENT.md](DEPLOYMENT.md); for
the portal and panel walkthroughs see the [README](../README.md).

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

Per-process heap ceilings, as `boot.sh` actually sets them: `24` (PostgreSQL's
supervisor), `80` (dashboard), `96` (bot). The bot is the largest consumer
(guild cache, image rendering), so it gets the largest ceiling. PostgreSQL's own
main process measured **≈ 16 MB RSS** on this image; the dashboard stays under
100 MB during the load check. 96 + 80 + 24 = 200 MB of ceiling across three
processes that never all peak at once, which keeps the cgroup under ~175 MiB in
practice. Measured on this plan: **130 MiB** shortly after boot, **144–170 MiB**
after hours of gateway traffic. Override with `AL_AI_HEAP_*` on a larger plan;
never raise them past the plan's RAM, or the ceiling stops protecting anything.

## Environment

Set with `env_set` on the deployment (`secret: true` for the five credentials),
never as a committed `.env`. **The variable list is `.env.example`** — three
sections, one contract, enforced by `env-template.test.ts`. This section lists
only what is *specific to this host*; anything not mentioned takes the default
documented in the template.

| Key | Value here | Why |
| --- | --- | --- |
| `NODE_ENV` | `production` | makes a missing operational setting a startup failure |
| `PORT` | `25880` | the panel's published port |
| `DATABASE_URL` | *blank* | `boot.sh` starts the embedded cluster and exports it |
| `DASHBOARD_URL` | `https://<subdomain>.apps.bot-hosting.cloud` | the public HTTPS origin |
| `DASHBOARD_INTERNAL_URL` | `http://127.0.0.1:25880` | keeps health telemetry off the public proxy |
| `AL_AI_PLATFORM_HOST` | `<subdomain>.apps.bot-hosting.cloud` | exact host, no scheme, no port |
| `DISCORD_REDIRECT_URI` | `https://<subdomain>/auth/discord/callback` | must match the portal exactly |
| `KEY_ROTATION_DAYS` / `AUDIT_RETENTION_DAYS` | `90` / `90` | required in production; keep them equal to the panel |
| `AL_AI_REMOTE_ACCESS` | *unset* | the platform replaces ngrok; no tunnel on this host |
| `BOT_LOCK_FILE` | `/tmp/al-ai-bot.lock` | one bot per container |
| `POSTGRES_PASSWORD` | optional | unset means the first boot mints one into `.al-ai-pg/password` |

Everything else — the nine core keys, the three secrets, `OWNER_ID`, the heap
ceilings, the backup retention and the log caps — is Section 1 or Section 3 of
`.env.example` and is identical on every host.

If an operator ever has a real database, setting `DATABASE_URL` skips the
embedded cluster entirely: `boot.sh` starts no PostgreSQL and downloads nothing.

### The Packages tab is not a dependency list

The panel's **Packages** tab reads `/package.json` and lists what it finds. On
this repository that is the workspace *root*, so it shows five **build-time**
`devDependencies` — `axe-core`, `esbuild`, `knip`, `pgsql-ast-parser`,
`typescript`. None of them is installed in the container: `setup.sh` runs
`npm ci --omit=dev` for the two workspaces and the root installs nothing at all.

Two consequences worth knowing before touching it:

- An entry there does **not** mean the package is present, and a package the
  bot or dashboard actually uses is **not** listed — the runtime dependencies
  live in `apps/*/package.json`, which the tab does not read.
- **Do not add or remove packages from that tab.** It edits the manifest (and
  may leave the lockfile behind), and the next `setup.sh` then fails on
  `npm ci` — which surfaces as a container that restarts with no dependencies
  and a dashboard answering 502. Change dependencies in the workspace manifest,
  commit `package.json` and `package-lock.json` together, and let
  `npm run check:lock` catch a disagreement before it reaches the host.

## Disk growth

The 512 MB disk is shared with `node_modules` (~84 MB), the PostgreSQL build
(~99 MB) and `host-build` (~6 MB). Three writers could grow without limit; all
three are capped:

| Writer | Bound |
| --- | --- |
| Snapshots in `.al-ai-host/backups/` | 5 files (~3 KB each); older ones **and their `.sha256` sidecars** are deleted after each export |
| `.al-ai-host/logs/{bot,dashboard,postgres}.log` | 5 MiB per file, truncated in place, last 400 lines kept as `.log.1` |
| npm cache | `setup.sh` runs `npm cache clean --force` after every install |

Truncation rather than rotation-by-rename is deliberate: each service writes
through `tee -a`, which holds an `O_APPEND` descriptor on the live file, so a
rename would leave the writer filling the rotated copy while the new file stayed
empty. Worst case on disk is therefore ~18 MB of logs plus 15 KB of snapshots,
not a number that grows with uptime.

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
5. OAuth — two steps, and the first is the one that actually breaks:
   - `node scripts/oauth-preflight.mjs` must print `REGISTERED` for
     `DISCORD_REDIRECT_URI` and exit 0. Discord matches the callback
     byte-for-byte, and **the API reads that list but cannot write it**: a
     `PATCH /applications/@me` carrying `redirect_uris` returns 200 and changes
     nothing, so the Developer Portal is the only place to add a missing entry.
     The dashboard checks this once at boot and logs a warning naming the exact
     URI when its own callback is not registered — that warning means sign-in
     is already broken, not that it is about to be.
   - then sign in from the public URL; the callback must return to the same
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

## Docker: what compose runs, and moving a PostgreSQL 16 volume to 17

`infra/docker-compose.yml` is the alternative target in the matrix above: three
services (postgres, dashboard, bot), one volume, `npm ci` inside each image. It
is not the measured path — nothing in this document was benchmarked on Docker —
so treat it as a convenience deployment, not as a proven one.

- **`postgres:17-alpine`.** 17 is the major version `infra/schema.sql` is applied
to from scratch on every verification run (`.workbuddy-ai/verify/fresh-schema-check.mjs`);
the hosted deployment embeds 18 through `scripts/host/pg.mjs`.
- **Do not switch this file to the 18 image without moving the volume.** From 18
  on, the official image sets `PGDATA=/var/lib/postgresql/18/docker` and
  `VOLUME /var/lib/postgresql`; the mount below would land where the server does
  not look, and the container would initialise an empty cluster inside the image
  layer instead of failing. 16 and 17 both use `/var/lib/postgresql/data` and the
  same `PGDATA`, which is why this file moves between them without touching the
  volume line.

### Moving an existing 16 volume to 17 (no data loss)

A data directory belongs to the major version that created it. Measured: a
cluster initialised by 16 and started with 17 refuses to start —
`FATAL: database files are incompatible with server … initialized by PostgreSQL
version 16` — and leaves every file untouched. That is fail-closed, not
corruption, but the stack stays down until it is upgraded.

```bash
# The volume is named after the Compose project (the checkout's directory name):
# `<project>_postgres-data`. `docker volume ls` prints the real spelling.

# 1. Dump with the OLD server. The 17 image refuses the 16 directory, and
#    `docker compose down` keeps the volume, so dump from a one-off container.
docker run --rm -v <project>_postgres-data:/var/lib/postgresql/data postgres:16-alpine \
  pg_dumpall -U al_ai > al-ai-pg16.sql

# 2. Restore into a NEW, empty volume.
docker volume create <project>_postgres-data-17
docker run --rm -i -v <project>_postgres-data-17:/var/lib/postgresql/data postgres:17-alpine \
  psql -U al_ai -d postgres -f - < al-ai-pg16.sql

# 3. Point the volume line at the new volume, then bring the stack up.
```

`pg_upgrade` inside a `postgres:17` container is the alternative when the
database is too large to dump; it needs both binaries and a stopped server.

The application-level path was the one measured here, and it restores into an
empty database with the schema applied by the importer itself:

```bash
AL_AI_BACKUP_DIR=/tmp/al-ai node --env-file=.env scripts/db-export.mjs
DATABASE_URL=postgresql://…/al_ai_fresh node scripts/db-import.mjs /tmp/al-ai/db-*.json.gz
# restored 518 rows across 29 tables; all 29 tables matched the source
# row-for-row, 19 foreign keys and 276 columns on both sides, and the
# `audit_trail` contents hashed equal. Re-running the import without --fresh
# left the counts unchanged (518/29).
```

## Two Discord applications: development and production

The project runs against **two different Discord applications** on purpose:

| | Development (workstation) | Production (host) |
| --- | --- | --- |
| Application | `1544750141112582187` (`ddas`) | `1570227988602036365` |
| Token | the developer's `.env` | the deployment's environment variables |
| Callback origin | `http://localhost:3000/auth/discord/callback` | `https://ngln5duqvk.apps.bot-hosting.cloud/auth/discord/callback` |
| Second registered URI | the reserved ngrok domain | none needed |

Why two: a bot token belongs to exactly one application, so one application
cannot serve a local gateway client and a hosted one without sharing a token and
a rate-limit budget — and rotating a leaked development token would sign the
deployment out. Roles and guild membership are per-application too, so a
development bot in a live guild is a second member with its own permissions.

Rules that keep the two apart:

- **`DISCORD_CLIENT_ID` must equal the application the bot token belongs to.** A
  mismatch is not cosmetic: the sign-in leg sends the client id from the
  environment and Discord answers an unknown-application or
  `Invalid OAuth2 redirect_uri` page.
- **Each environment registers its own callbacks**; the lists are not shared.
  Portal → OAuth2 → Redirects is the only editor: `PATCH /applications/@me`
  with `redirect_uris` returns 200 and ignores the body.
- **Verify each side separately, with the same script:**
  ```bash
  npm run check:oauth:preflight                                      # local .env
  node --env-file=.env scripts/oauth-preflight.mjs --origin https://<host>
  ```
  Exit 0 = every origin is registered · 1 = at least one is missing · 2 = the
  check could not ask (no token, no network). The dashboard repeats this check
  once at boot and logs a warning naming the missing URI; it never blocks boot.
- **Measured on 2026-11-17:** the production application returns two registered
  URIs — the live host above and one leftover `…all-hands.dev` sandbox origin
  from the platform that built earlier bundles. The leftover grants nothing
  today, but it is an origin that can complete a sign-in, so remove it in the
  portal. The development application returns `localhost:3000` and the reserved
  ngrok domain, which matches its `.env`.

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

## Hosted runtime vs local runtime

One flag separates the two, decided at boot in `server/network.ts`:
`AL_AI_PLATFORM_HOST` set, or a container marker (`/.dockerenv`,
`/run/.containerenv`). `NODE_ENV` is deliberately not a signal — a self-hosted
VPS in production is a machine whose LAN links still work.

| | Local workstation | Hosted (Bot-Hosting, Docker) |
| --- | --- | --- |
| Network screen | reach switch, LAN URLs, Wi-Fi QR, VPN hint, firewall card | one card: the public URL, and a note that the local tools are off |
| Interface table | read for LAN/gate/QR | **not read at all** — internal addresses cannot reach a response |
| `POST /api/network` · `/api/network/firewall` | act | `409 HOSTED_NETWORK`, no ngrok child spawned |
| Presence | same code path | same code path (`NOTIFY` → `LISTEN` → `setPresence`) |

The hosted screen is not a filtered copy of the local one: the server returns
empty interface arrays, so there is nothing to filter.

## Database roles: the services never connect as the owner

`infra/schema.sql` defines two roles, and the difference is the whole point:

| Role | Who uses it | What it can do |
| --- | --- | --- |
| `al_ai` (the `initdb` superuser) | `pg.mjs` at boot: create the database, create the app role, apply the schema | everything — DDL, files, RLS bypass |
| `al_ai_app` | the dashboard and the bot, for every request | `SELECT/INSERT/UPDATE/DELETE` on the feature tables only; no DDL, no `pg_read_file`, **NOBYPASSRLS** |

`boot.sh` starts PostgreSQL with the owner URL, waits for `ready`, then asks
`node scripts/host/pg.mjs --print-app-url` for the least-privilege URL and
exports **that** as `DATABASE_URL`. If the role cannot be prepared, the same
command prints the owner URL instead and logs a warning — the deployment keeps
running, and the log names the downgrade.

`pg.mjs` mints the application password once into `.al-ai-pg/password-app`
(mode 600) beside the owner's `.al-ai-pg/password`. The value never appears in
`env`, in a log, or in the repository.

```bash
# Prove which role the running services use (no secrets printed):
node scripts/host/pg.mjs --print-app-url >/dev/null && echo "app URL available"

# Rotate the application password: delete the file, restart the deployment.
rm .al-ai-pg/password-app        # next boot mints and applies a new one
```

Row-level security is enabled on every table and pinned by
`apps/dashboard/test/schema-rls.test.ts`. `audit_trail` has only SELECT and
INSERT policies plus `REVOKE UPDATE, DELETE`, so the append-only guarantee is
enforced by the database, not only by the code that writes it.

**External database (`DATABASE_URL` set in the panel):** `boot.sh` skips all of
the above. Then the role in that URL is the one the services use — create a
dedicated, non-superuser role there and point `DATABASE_URL` at it. The schema's
DO block grants it DML and the RLS policies when it can create the role; a
managed provider that allows only one role keeps working (with the owner's
privileges) and the schema's `NOTICE` says policies were skipped.
