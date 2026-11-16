# AL AI

Arabic-first (RTL) Discord management bot with a secure control dashboard.
Three workspaces, three processes, one shared contract package.

| Layer | Stack | Path |
|---|---|---|
| Bot | discord.js 14, Gateway + REST v10, PostgreSQL | `apps/bot` |
| Dashboard SPA | React 19, Vite, Tailwind 4, HeroUI, RTL | `apps/dashboard/src` |
| BFF | Fastify 5, TypeScript, session/2FA, repositories | `apps/dashboard/server` |
| Contracts | TypeScript types, permissions, event/crypto schema | `packages/core` |
| Infra | PostgreSQL 17, Docker Compose, schema | `infra` |

Node **24.22** (`.nvmrc`), npm **11**, floor Node >= 22.19.

## Architecture

```
 Browser (RTL SPA) --same-origin/httpOnly cookie--> Fastify BFF :3000 --REST v10--> Discord
                                                      │  ├── PostgreSQL (55432 / 5432 in Compose)
                                                      │  └── signed HMAC heartbeat (loopback)
 Discord Gateway (WebSocket) <--> bot <--> adapter 127.0.0.1:3400
```

`packages/core` is the single source of truth for every shape crossing a
process boundary. The dashboard never holds a Discord token; the bot never
writes appearance fields. Full diagram, data-flow rules and module map:
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Quick start

```bash
cp .env.example .env      # fill in the values (see below)
npm ci
```

**Windows — supervised (database, dashboard, bot, optional tunnel):**

```bash
npm run dev                            # localhost only; supervises and handles Ctrl+C
npm run dev -- -Lan                    # + devices on the same Wi-Fi/router
npm run dev -- -Lan -OpenFirewall      # + Windows Firewall inbound rule (run as Administrator)
npm run dev -- -Tunnel                 # + the ngrok tunnel (public HTTPS)
npm run dev:status                     # what is up, both URLs, and firewall state
npm run dev:restart                    # pick up a backend change (no hot reload); keeps the tunnel
npm run dev:stop                       # stop all of it: services, ngrok agent, and the database
```

The dashboard BFF binds `0.0.0.0`; its **Host gate** is what limits reach.
`-Lan` (or the «الوصول للشبكة» screen → «الشبكة المحلية») opens that gate
without starting ngrok. Both launchers print the exact localhost and LAN URLs
at startup, detected from the live interface table — no address is hardcoded.

**Linux / macOS / VPS — portable, no PowerShell:**

```bash
npm start                   # two Node children; bring your own PostgreSQL
AL_AI_REMOTE_ACCESS=lan npm start      # also answer the router's devices
npm start -- --dry-run      # show the resolved commands and both URLs
npm start -- --service=bot  # one service
```

**Docker Compose (fresh VPS):**

```bash
cp .env.example .env
docker compose -f infra/docker-compose.yml up --build -d   # http://localhost:3000
```

Compose applies `infra/schema.sql` on the first initialisation of a fresh
volume and waits for the database healthcheck. Slash commands are deployed
separately, never at runtime: `npm run deploy-commands --workspace=@al-ai/bot`.

**Publishing a dashboard change:** `npm run deploy` builds, runs the secret
gate over the fresh bundle, and confirms the hash on disk is the one the live
server answers — the step a manual build forgets. `--no-build` only verifies
what is being served.

## Environment variables

`.env` is gitignored; **`.env.example` is the only list**, organised in three
sections. Do not copy a table out of a document — if a variable is not in
`.env.example`, it is not part of the contract (`apps/bot/test/env-template.test.ts`
fails the build for any variable the code reads but the template omits).

| Section | Count | What it is |
|---|---|---|
| 1 — Core required | 9 | `BOT_TOKEN` · `DISCORD_CLIENT_ID` · `DISCORD_CLIENT_SECRET` · `DISCORD_REDIRECT_URI` · `DASHBOARD_URL` · `SESSION_SECRET` · `EVENT_HMAC_SECRET` · `ENCRYPTION_KEY` · `OWNER_ID` |
| 2 — Database mode | 1 | `DATABASE_URL` — blank starts the built-in PostgreSQL, set uses an external one |
| 3 — Advanced | rest | tuning with working defaults: heap ceilings, backup retention, log caps, reach, retention days |

Generate each secret separately with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`:
`SESSION_SECRET` ≥ 32 chars, `ENCRYPTION_KEY` exactly 64 hex chars.

Two values are **additionally required when `NODE_ENV=production`** —
`KEY_ROTATION_DAYS` and `AUDIT_RETENTION_DAYS`. The application never guesses a
retention policy, so production refuses to boot without them. The current
deployment uses `90` for both; keep the panel and the template equal so there is
one number, not two.

**Ports:** 3000 BFF (`0.0.0.0`) · 3400 integration adapter (loopback only) ·
55432 local PostgreSQL (5432 in Compose) · 4040 ngrok agent inspection API
(loopback only) · 5173 Vite dev server (`0.0.0.0`).

**LAN sign-in:** Discord only registers HTTPS redirect URIs (plus HTTP
`localhost`/`127.0.0.1` for local development), so a phone on
`http://<LAN_IP>:3000` cannot complete the OAuth round trip *directly*. The
dashboard and its APIs are reachable there. To sign in, enable the tunnel once:
the LAN login route sends the browser to the tunnel origin, completes OAuth
(and 2FA) there, then returns it to the LAN origin with a 60-second single-use
ticket that mints a cookie the phone can keep. Without a tunnel the route says
so instead of walking into Discord's `Invalid OAuth2 redirect_uri`. Cookies are
origin-aware:
on a plain-HTTP LAN address the session cookie is unprefixed and non-`Secure`,
because a `Secure`/`__Host-` cookie would be silently discarded by the browser.
`SameSite=Lax`, `HttpOnly`, `Path=/`, the same-origin write guard and the exact
Host allow-list are unchanged on every origin.

## Production build & universal hosting

The container runs **plain JavaScript**, not TypeScript. `npm run build:host`
bundles the bot and the dashboard server into `host-build/{bot,server}.mjs`
(committed), so no `tsx`/`esbuild` process is alive at runtime — that was ~31 MB
of the 256 MB budget. Rebuild and commit `host-build/` whenever you change
`apps/` or `packages/` source; `Auto-Pull on Restart` then delivers runnable JS
to a host that cannot build it.

One start command works everywhere: `bash scripts/host/boot.sh` — or `node
index.js`, which delegates to it. It runs PostgreSQL, the dashboard and the bot,
and falls back to `tsx` automatically when no bundle is present (a fresh dev
checkout).

| Target | How it runs |
|---|---|
| Bot-Hosting (Free/Starter) | start command `bash scripts/host/boot.sh`; embedded PostgreSQL when `DATABASE_URL` is unset |
| Any VPS / Pterodactyl | `node index.js` or `bash scripts/host/boot.sh`; embedded DB, or set `DATABASE_URL` |
| Docker | `infra/docker-compose.yml` (a real PostgreSQL service) |
| PaaS (Railway/Render) | `node index.js`; set `DATABASE_URL` to the managed database |

**External database mode:** set `DATABASE_URL` (Supabase, Neon, Railway, a VPS…)
and `boot.sh` skips the embedded PostgreSQL entirely — no download, no ~170 MB
of processes. Unset it and the embedded cluster starts automatically.

### Memory ceilings

`boot.sh` gives each of the three processes an explicit V8 old-space ceiling —
`AL_AI_HEAP_BOT` (96 MB), `AL_AI_HEAP_DASHBOARD` (80 MB), `AL_AI_HEAP_PG`
(24 MB). A ceiling is not a reservation: it makes V8 collect instead of letting
the old generation grow until the cgroup OOM-kills the container, which is what
turns "fine at boot" into "dead on day nine". Measured on the 256 MB plan: 130
MiB shortly after boot, ~170 MiB after 14 hours of uptime. Raise the ceilings
(they are environment variables, see `.env.example`) on a larger plan; do not
raise them past the plan's RAM, or the ceiling stops protecting anything.

### Production runtime vs local tooling

| Production (shipped / runs on host) | Local workstation only |
|---|---|
| `apps/bot`, `apps/dashboard/server`, `packages/core` | `scripts/*.ps1` (dev, postgres) |
| `apps/dashboard/dist` (prebuilt client) + `host-build/` | `scripts/{verify,check-*,ui-check,oauth-check,load-check}*` |
| `scripts/host/{boot,setup,pg}.sh/mjs`, `scripts/db-*.mjs`, `index.js` | `docs/`, `evidence/`, `.agents/`, `.workbuddy-ai/`, `.zcode/` |
| `infra/schema.sql`, runtime `node_modules` | test files, `*.ps1`, Vite/Tailwind/HeroUI dev deps |

## Backup & migration

The embedded cluster runs with `fsync=off` (fits the 256 MB cgroup) and ships no
`pg_dump`, so backups are a pure-`pg` logical dump:

```bash
npm run db:export                              # -> .al-ai-host/backups/db-<ts>.json.gz + .sha256 (keep 5)
DATABASE_URL=postgres://… npm run db:export    # snapshot any database
DATABASE_URL=postgres://… npm run db:import .al-ai-host/backups/db-<ts>.json.gz --fresh
```

Every snapshot gets a `db-<ts>.json.gz.sha256` sidecar in `sha256sum` format, so
integrity is verifiable offline with the standard tool:

```bash
cd .al-ai-host/backups && sha256sum -c db-<ts>.json.gz.sha256
```

`db:import` verifies that sidecar **before it connects** and refuses a mismatch,
so a truncated or wrong snapshot can never overwrite live data. A snapshot
without a sidecar still imports, with a warning.

`db:export` runs automatically on graceful shutdown and every 12 hours on the
host. `db:import` restores into the embedded DB or migrates every row into an
external PostgreSQL in one transaction (schema applied when the target is
empty). Foreign keys are read from `pg_constraint` (the `information_schema`
views are filtered by ownership and see nothing under the unprivileged app
role) and inserted parent-first; sequences are reset.

The import **streams** the snapshot instead of buffering it: one pass reads the
`meta` line, a second inserts each chunk as it arrives, `AL_AI_IMPORT_BATCH`
(default 500) rows per statement. Peak memory is one decompressed chunk, not the
dump — a snapshot of 300 000 rows (64 MB decompressed) restores inside a 24 MB
heap. That is the difference between a migration that works on this container
and one that dies once the guild data grows.

`--fresh` truncates the target first, **except** for append-only tables: the
`audit_trail` `BEFORE TRUNCATE` guard is deliberate, so a restore adds history
with `ON CONFLICT DO NOTHING` instead of rewriting it.

## Discord Developer Portal — every tab

Open <https://discord.com/developers/applications> → your application. The tabs
below are in the order the portal shows them; do them once, top to bottom.

### 1. General Information

- **Application ID** is the same value as `DISCORD_CLIENT_ID`. Copy it from here
  (or from OAuth2 → Client ID; they are identical).
- Set **Name** and **Icon** — these are what members see when they authorise the
  app, not what the bot shows in a guild (that is the bot's own avatar).

### 2. Installation

- Enable **User Install** *and* **Guild Install**.
- **Guild Install → Scopes:** `bot` + `applications.commands`.
- **Guild Install → Permissions:** `Manage Roles`, `Manage Channels`,
  `Moderate Members`, `Send Messages`, `View Audit Log`, `Embed Links`,
  `Read Message History`.
- **Install Link:** `Discord Provided Link`. Copy it; that is the URL you open to
  add the bot to a server (there is no need to hand-build an invite URL).
- `Manage Roles` is the one that matters most: without it the bot cannot create
  its own role and logs `DiscordAPIError[50013] Missing Permissions` at startup.
  The bot still runs — it just never gets the role.

### 3. OAuth2

- **Redirects:** exactly **one** entry, matching `DISCORD_REDIRECT_URI` byte for
  byte — same scheme, same host, **no trailing slash**, no duplicate rows.
  - local: `http://localhost:3000/auth/discord/callback`
  - hosted: `https://<your-domain>/auth/discord/callback`
  - Any difference is the entire cause of `Invalid OAuth2 redirect_uri`. The
    portal also rejects `http://` for anything except `localhost`/`127.0.0.1`.
- **Client ID** → `DISCORD_CLIENT_ID`. **Client Secret** → `DISCORD_CLIENT_SECRET`
  (use *Reset Secret* if it is not visible; the old one stops working).
- **Scopes used by the dashboard login:** `identify` + `guilds`. These are
  requested by the app at sign-in and do not need to be added to the install
  link above.

### 4. Bot

- **Token** → *Reset Token* → copy once → `BOT_TOKEN`. It is shown a single time.
- **Privileged Gateway Intents:**
  - `SERVER MEMBERS INTENT` — **ON** (role and member resolution)
  - `MESSAGE CONTENT INTENT` — **ON** (commands and moderation read message text)
  - `PRESENCE INTENT` — **leave OFF**. The code never subscribes to it
    (`apps/bot/src/lib/discord.ts` requests `GuildMembers` and `MessageContent`
    only). Turning it on changes nothing functionally, adds a stream of presence
    events to a 256 MB container, and drags the app into Discord's verification
    requirement past 100 guilds.
- **Public Bot** — on. **Requires OAuth2 Code Grant** — off.

### 5. Server role hierarchy (in the guild, not the portal)

- Drag the bot's role **above** every role it has to manage — including the
  managed/integration roles it creates for itself.
- A bot can only act on roles strictly **below** its own highest role. This is
  the other half of `50013`: correct permissions with a low position still fail.
- Keep `Manage Roles` granted on the bot's role itself, not only on the invite.

## Bot-Hosting panel — every surface

- [ ] **Startup** → Runtime `nodejs` **24**, Entry file `index.js`, Start command
      `bash scripts/host/boot.sh`, Port `25880`. (`index.js` delegates to
      `boot.sh`, so either entry works; the panel's real command is `boot.sh`.)
- [ ] **GitHub Sync → Auto-Pull on Restart: ON** — this is what makes a `git push`
      reach the host. Verify with `deployments_getGit` (`autoPull: true`) rather
      than trusting the panel label.
- [ ] **Resources** — 256 MB RAM / 25 % CPU / 512 MB disk. The heap ceilings in
      `boot.sh` are sized for exactly this plan; a different plan means changing
      `AL_AI_HEAP_*`, not the code.
- [ ] **Variables** — paste the **9** keys from `.env.example` Section 1, leave
      `DATABASE_URL` **blank** (Section 2) so `boot.sh` starts the embedded
      PostgreSQL, and add `KEY_ROTATION_DAYS=90` + `AUDIT_RETENTION_DAYS=90`
      because `NODE_ENV=production` refuses to boot without them.
- [ ] **Do not edit the Packages tab.** It renders the **root `package.json`
      `devDependencies`** (`axe-core`, `knip`, `pgsql-ast-parser`, `typescript`)
      because that is the file the panel reads. None of them is installed:
      `setup.sh` runs `npm ci --omit=dev` for two workspaces only. Adding or
      removing a package there does not change the container — it only puts
      `package.json` and `package-lock.json` out of sync and breaks the next
      `npm ci`. Dependencies change in `package.json` + lockfile, in a commit.
- [ ] **SFTP / Files** — the volume is the repository root; `node_modules`,
      `.al-ai-pg` and `.al-ai-host` are generated. Never edit them by hand.
- [ ] **Disk headroom** — `node_modules` ~84 MB, `.al-ai-pg` ~99 MB,
      `host-build` ~6 MB, logs capped at 5 MiB per file + 400 lines of history.
      None of the first three is safe to delete; `setup.sh` prunes the rest.
- [ ] **Health after a restart** — `/` and `/api/health` return `200`, the log
      shows `AL AI connected as <name>`, and there is no
      `lock file "postmaster.pid" already exists` (the guard self-heals, but its
      absence is the clean signal).
- [ ] **Renewal** — the free plan is suspended every 4 days and needs a person to
      renew in Billing; nothing in the repository can automate that.

### Disk growth is bounded

| Writer | Bound | Where |
|---|---|---|
| Database snapshots | 5 files, ~3 KB each, older ones and their `.sha256` deleted | `AL_AI_BACKUP_KEEP` in `db-export.mjs` |
| Service logs | 5 MiB per file, last 400 lines kept as `.log.1` | `AL_AI_LOG_MAX_BYTES` / `AL_AI_LOG_KEEP_LINES` in `boot.sh` |
| npm cache | cleaned by `setup.sh` after every install | `npm cache clean --force` |

Logs are truncated **in place**, never renamed: every service writes through
`tee -a`, which holds an `O_APPEND` descriptor, so a rename would leave it
writing into the rotated copy forever while the new file stayed empty.

## Verify

```bash
npm run verify       # lint → check:schema → test → build → check:secrets → audit
npm run typecheck    # tsc --noEmit in every workspace
npx knip             # zero unused files / exports / dependencies
npm run check:ui     # real browser, both palettes, axe-core
npm run check:oauth  # OAuth leg, state cookie, CSRF guard (needs a running stack)
npm run db:verify    # authenticated SELECT 1
```

**Read `# skipped`, not `# pass`**: with no reachable database,
`storage.test.ts` skips every case and `npm run verify` still exits 0. Tests
run through `scripts/test-runner.mjs` (≤2 workers, ≤768 MiB heap each) so a
20-core machine cannot consume 8-15 GiB.

## Documentation

One source of truth per subject — if two documents disagree, the more specific
one below wins, and `.env.example` always wins on environment variables.

| Guide | Scope |
|---|---|
| **this file** | setup, the two portal guides, architecture map, backup/migration |
| [DEPLOY.md](docs/DEPLOY.md) | deploying: host matrix, start commands, Bot-Hosting free plan, renewal, verification |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | running it **locally**: ports, LAN reach, single-instance guards, ngrok budget, troubleshooting |
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | processes, data-flow rules, module map |
| [API.md](docs/API.md) | route groups, guards, error semantics, Discord API boundary |
| [GOVERNANCE.md](docs/GOVERNANCE.md) | 29 test-enforced rules — never renumber without updating the test |
| [BOOK.md](docs/BOOK.md) | illustrated operator guide (Arabic) |
| [docs index](docs/README.md) | full directory, including historical documents |

## Rules worth knowing before you edit

- **One instance only:** `.al-ai-bot.lock` (pid + start-time), adapter port 3400
  bound before `client.login()`, and `PORT` 3000 all fail closed. `dev.ps1` is
  the only Windows supervisor; there is no `tsx watch`.
- **ngrok free plan:** 20,000 HTTP requests/month. Liveness checks are loopback
  only; public verification is one request/hour; `ERR_NGROK_727` is an account
  fact that must never re-mint the agent. See [DEPLOYMENT.md](docs/DEPLOYMENT.md#5-the-ngrok-request-budget).
- **Governance:** `apps/bot/test/governance.test.ts` enforces exactly 29
  numbered rules in `docs/GOVERNANCE.md`, source citations, and that
  `apps/bot/src/lib/discord.ts` is the only `discord.js` importer.
- **No secrets:** `.env`, database dumps and generated previews are ignored;
  `.workbuddy-ai/memory/` holds tracked project rules, not scratch data.
