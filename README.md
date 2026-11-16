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
npm run dev:restart                    # pick up a backend change (no hot reload)
npm run dev:stop
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

`.env` is gitignored; `.env.example` is the contract. Full table and
production requirements: [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md).

| Required | Purpose |
|---|---|
| `BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Discord credentials |
| `DISCORD_REDIRECT_URI` | exact OAuth callback, registered in the Developer Portal |
| `DATABASE_URL` | PostgreSQL connection string |
| `SESSION_SECRET`, `EVENT_HMAC_SECRET`, `ENCRYPTION_KEY` | 32-byte hex, 32-byte hex, 64 hex |
| `KEY_ROTATION_DAYS`, `AUDIT_RETENTION_DAYS` | mandatory when `NODE_ENV=production`; never guessed |

Generate secrets with
`node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

Portal: enable `SERVER MEMBERS INTENT` + `MESSAGE CONTENT INTENT`, leave
`PRESENCE INTENT` **off**; scopes `bot` + `applications.commands` (dashboard
login uses `identify` + `guilds`); register both redirect URIs exactly.

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

`--fresh` truncates the target first, **except** for append-only tables: the
`audit_trail` `BEFORE TRUNCATE` guard is deliberate, so a restore adds history
with `ON CONFLICT DO NOTHING` instead of rewriting it.

## Discord Developer Portal checklist

- [ ] **Bot → Token** → `BOT_TOKEN`
- [ ] **OAuth2 → Client ID / Client Secret** → `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`
- [ ] **OAuth2 → Redirects** → add **exactly** `https://<your-domain>/auth/discord/callback` (no trailing slash). A mismatch is the cause of `Invalid OAuth2 redirect_uri`.
- [ ] **Bot → Privileged Gateway Intents** → `SERVER MEMBERS` + `MESSAGE CONTENT` **ON**, `PRESENCE` **OFF**
- [ ] **OAuth2 → Scopes** → `bot` + `applications.commands` (dashboard login uses `identify` + `guilds`)

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

| Guide | Covers |
|---|---|
| [ARCHITECTURE.md](docs/ARCHITECTURE.md) | processes, data-flow rules, module map, decomposition status |
| [API.md](docs/API.md) | route groups, guards, error semantics, Discord API boundary |
| [DEPLOYMENT.md](docs/DEPLOYMENT.md) | env reference, ports, single-instance guards, ngrok quota, troubleshooting |
| [DEPLOY.md](docs/DEPLOY.md) | Bot-Hosting free plan: one slot, embedded PostgreSQL, dashboard + bot, renewal |
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
