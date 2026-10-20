# AL AI

Arabic RTL Discord management bot and secure control dashboard.

- `apps/bot` — the long-lived Discord Gateway client and the integration adapter.
- `apps/dashboard` — the RTL dashboard UI **and** its BFF (Fastify, TypeScript).
- `packages/core` — shared contracts: event schema, permissions, crypto, session
  policy, appearance normalisation. The single source of truth for every shape
  that crosses a process boundary.
- `infra` — Dockerfiles, `docker-compose.yml`, and `schema.sql`.

The rules that keep this codebase coherent are in [`docs/GOVERNANCE.md`](docs/GOVERNANCE.md).
Several of them are enforced by tests in `apps/bot/test/governance.test.ts`.

> **Delivery note.** The working tree holds a large body of work that is *not*
> in Git yet: the PowerShell entry points (`scripts/*.ps1`), the verification
> tools (`scripts/*.mjs`), the theme engine and the new dashboard components,
> and the test files that go with them. **A copy of only the tracked files does
> not build** - the first missing module is `src/lib/theme.ts`. The project
> becomes reproducible the moment those paths are added; the list of what has to
> be included is in the delivery report, and `git status --short` is the
> authority on it. Nothing here is a secret, and `.env` stays out of Git.

## Architecture

```
┌──────────────────────┐
│  Browser (RTL SPA)   │  React 19 + Vite, no token ever reaches it
│  apps/dashboard/src  │
└──────────┬───────────┘
           │ same-origin fetch, httpOnly session cookie
           ▼
┌──────────────────────┐        ┌──────────────────────────────┐
│   Fastify BFF :3000  │───────▶│  PostgreSQL :55432           │
│  apps/dashboard/     │  SQL   │  guilds, logging, commands,  │
│  server/             │        │  bot_identity, audit trail   │
│                      │        └──────────────────────────────┘
│  • session + tier    │
│  • TtlCache 60s      │        ┌──────────────────────────────┐
│  • RequestThrottle   │───────▶│  Discord REST API v10        │
│  • appearance writer │  HTTPS │  (the BFF is the only writer│
└──────────────────────┘        │   of every appearance field) │
           ▲                    └──────────────────────────────┘
           │ signed HMAC heartbeat every 30s  ▲
           │ (/internal/, loopback only)       │
┌──────────┴───────────┐        ┌──────────────┴───────────────┐
│ Integration adapter  │        │  Discord Gateway (WebSocket) │
│ 127.0.0.1:3400       │◀───────│  apps/bot/src/lib/discord.ts │
│ inbound reads only   │        └──────────────────────────────┘
└──────────────────────┘
```

**Data-flow rules that are load-bearing:**

1. **The dashboard never holds a Discord token.** Every write re-resolves the
   caller's tier on the server (`requireTierForGuild`) before it is allowed. A
   guild ID is not a secret — it appears in every invite link — so
   `requireSession` alone would let any signed-in account read any guild by
   pasting its ID.
2. **`apps/bot/src/lib/discord.ts` is the only file that imports `discord.js`**
   (GOVERNANCE rule 2). The BFF talks REST over `fetch`; the bot owns the Gateway.
3. **One writer per field.** The dashboard writes every appearance field
   (nickname, avatar, banner, bio, role colour, role icon). The bot's only write
   is the **presence** — status and activity live on the Gateway connection and
   have no REST route. Claiming otherwise in the UI would be a promise nobody
   keeps.
4. **The bot's Gateway cache is the cheap read path.** `listChannels` on the
   adapter answers from `client.guilds.cache`, which costs no REST quota.

## 1. Configure

```bash
cp .env.example .env
```

Fill in `BOT_TOKEN`, `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, and generate
the three secrets with:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

`KEY_ROTATION_DAYS` and `AUDIT_RETENTION_DAYS` are required whenever
`NODE_ENV=production`. They are never guessed.

### Discord Developer Portal checklist

The bot will not work with default portal settings. Enable these toggles:

**Bot → Privileged Gateway Intents** (two of the three are required):

| Intent | Required? | Why |
|---|---|---|
| `SERVER MEMBERS INTENT` | **yes** | member joins/leaves, role changes, nickname updates — the member log, the tier resolver, and the anti-nuke join-flood detector all depend on it |
| `MESSAGE CONTENT INTENT` | **yes** | the automod path reads message text; without it those events arrive empty |
| `PRESENCE INTENT` | **no — leave it OFF** | AL AI sets its *own* presence (that is an outbound call and needs no intent) but never reads anyone else's. Reading them is forbidden by GOVERNANCE rule 8, so the toggle is deliberately not requested |

The intents the code actually requests, for reference, are in
`apps/bot/src/lib/discord.ts`: `Guilds`, `GuildMembers`, `GuildMessages`,
`MessageContent`, `GuildVoiceStates`, `GuildModeration`, `GuildInvites`,
`GuildExpressions`.

**OAuth2 → Scopes:** `bot` and `applications.commands`.
The dashboard itself uses the separate `identify` + `guilds` scopes on its own
login flow — that is a different client credential path and needs no intent.

**Recommended permissions:** `permissions=8` (Administrator). AL AI manages
roles, channels, bans and the colour/icon of its own role; the narrower
equivalent is a long list that is easy to get subtly wrong, and a missing bit
shows up as a silent no-op rather than an error. Note that **Administrator
(0x8) supersedes every other bit and does not expand into them** — AL AI's
permission checks test `0x8` first for exactly that reason, so a naive bitwise
test does not report a missing permission for a bot that holds Administrator.

**Redirect URI** must match `DISCORD_REDIRECT_URI` exactly, including the path.

## 2. Run with Docker (recommended)

```bash
docker-compose -f infra/docker-compose.yml up --build
```

Then open <http://localhost:3000>.

If your machine already runs PostgreSQL on 5432, set `POSTGRES_HOST_PORT` in
`.env` to a free port (the compose file publishes the container there).

The images are built on `node:24.22.0-bookworm-slim` - the version in
`.nvmrc`, which is the version the project is developed and verified on. They
run `node_modules/.bin/tsx` rather than `npx tsx`, so the stop signal reaches
the program instead of a wrapper.

## 3. Run against a local PostgreSQL

The stack runs without Docker as well. In this workspace PostgreSQL 17 lives at
`C:\Users\dlwta\.al-ai\pgdata` on port **55432**, and that data directory is
deliberately outside the repository.

### The toolchain

| Tool | Version | Why |
|---|---|---|
| Node | **24.22.0** (`.nvmrc`) | the current LTS; the floor the project supports is 22.19.0 (`engines`), and CI tests both |
| npm | **11.19.1** (`packageManager`) | the npm that ships with that Node, and the one the lock was resolved against |

`npm ci` reproduces the locked tree exactly. It needs the services **stopped**:
the bot holds `@napi-rs/canvas`'s native binary open, and `npm ci` cannot
replace a file that is in use.

### One command

```bash
npm run dev                # database (on demand) + dashboard + bot, then supervise
npm run dev -- -Tunnel     # the same, plus the Cloudflare tunnel
npm run dev -- -Detach      # start and return to the prompt (fire and forget)
npm run dev:status         # what is up, on which ports, and the health verdict
npm run dev:restart        # stop, then start
npm run dev:stop           # graceful stop (a real Ctrl-C to each service)
```

`scripts/dev.ps1` starts the database only if its port is closed and waits for it
before launching anything, sends each service's output to `.al-ai/logs/`, and
records the running pids in `.al-ai/dev.json`. **By default it supervises**: it
stays in the foreground, and a Ctrl+C there stops the whole stack — the trap
turns the interrupt into a graceful stop, so the bot flushes its pipeline and
releases its lock while the dashboard closes its pool. Nothing is orphaned: each
child is named by port owner, command line, and remembered pid rather than
assumed to have died with the shell. A forced kill is the fallback, not the norm.
A quick tunnel the run served is ended as well; a **named** tunnel (started with
`CLOUDFLARED_TUNNEL_TOKEN`) is never touched, so its public ingress and
registered OAuth callback survive. Ownership is decided by the tunnel's birth
time, not just by the port: a `cloudflared` serving the same port that was born
before this run belongs to someone else and is left running.
`-Detach` skips supervision when you want the prompt back; `npm run dev:stop`
then stops that stack later.
Extra flags go after `--`: `-Tunnel`, `-Detach`, `-NoDb`, `-NoDashboard`, `-NoBot`.

The database alone has its own entry point (`npm run db:start`, `db:stop`,
`db:status`, `db:verify`). `db:verify` reads `DATABASE_URL`, connects with those
credentials using the same `pg` driver the dashboard uses, and runs one read-only
query (`SELECT 1`). It exits non-zero on a missing variable, a bad URL, a refused
connection, failed authentication, or a database mismatch, and it never prints
the password or the URL - the right check to gate a deploy or a CI step.
`scripts/postgres.ps1 -Action verify` is the faster protocol-level probe
(`pg_isready`, no login); PostgreSQL documents that it can succeed with wrong
credentials, which is why it is not the deploy gate. To
make the database an auto-starting Windows service instead, run
`scripts/setup-db-service.ps1` once from an elevated shell.

### By hand

```bash
# 1. PostgreSQL — start it as a *background task*, not with pg_ctl.
#    `pg_ctl start` forks a child that the sandbox kills when the command
#    returns, so the server dies silently a second later.
"C:/Program Files/PostgreSQL/17/bin/postgres.exe" \
  -D C:/Users/dlwta/.al-ai/pgdata -p 55432 -c listen_addresses=127.0.0.1

# 2. Apply the schema (psql hangs without -w and a redirected stdin)
"/c/Program Files/PostgreSQL/17/bin/psql.exe" "$DATABASE_URL" -w -f infra/schema.sql < /dev/null

# 3. Dashboard (background task) — it does NOT read .env on its own
cd apps/dashboard && ../../node_modules/.bin/tsx --env-file=../../.env server/index.ts
#    → http://127.0.0.1:3000

# 4. Bot (background task) — it loads .env through `dotenv/config`
cd apps/bot && ../../node_modules/.bin/tsx --env-file=../../.env src/index.ts
#    → adapter on http://127.0.0.1:3400
```

Use the local `tsx` binary directly rather than through `npx`: `npx` adds a
wrapper process per service, worth roughly 70 MB each while running. The
bootstrapper avoids the wrapper a third way, `node --import tsx`, which loads the
loader in the service's own process so there is nothing extra to orphan.

`node server/index.ts` **does not work** — on Node 22.22 with
`process.features.typescript === "strip"`, the source imports `./env.js` while
the file is `env.ts`, and Node does not rewrite the extension. That is a
tsx/esbuild feature, not type-stripping.

The dashboard binds `0.0.0.0:3000`; set `PORT` to move it. The bot holds a lock
file (`.al-ai-bot.lock`) recording the owning pid, its image, and when the lock
was taken. A lock left by a process that has since exited is reclaimed on the
next start, and so is one whose pid was recycled: the holder must be a Node
process that started no later than the lock was written, so neither an unrelated
program nor *another* Node process that took over the number can wedge startup.
Only a lock held by a still-running bot blocks a second instance.

### Ports

| Service | Port | Bind |
|---|---|---|
| Dashboard (BFF + SPA) | 3000 | `0.0.0.0` |
| Integration adapter | 3400 | `127.0.0.1` only |
| PostgreSQL | 55432 locally, 5432 by Compose default | `127.0.0.1` |

## 4. Deploy slash commands

Slash commands are **never** published at runtime. Deployment is a separate,
deliberate step:

```bash
npm run deploy-commands --workspace=@al-ai/bot
```

`required: true` on a slash option is **frozen at registration time**, so making
an option required in Discord makes the setting one-way — it can never be turned
back off. AL AI therefore marks no option required and enforces the requirement
in the bot instead.

## 5. Verify

```bash
npm run verify   # lint → check:schema → test → build, in that order
```

| Suite | Tests | Covers |
|---|---|---|
| `apps/bot/test` | 301 | crypto, nonces, routing, permissions, pipeline, presence sync, governance, Discord-constant alignment, anti-nuke, adapter, security, the instance lock (including the two starters racing for it), the mention policy |
| `apps/dashboard/test` | 345 | every screen renders without throwing (real jsdom mount, not `renderToString`); the error boundary contains a failure and recovers on retry; a gated role icon is disabled and omitted from the write; the unsaved-changes bar driven through the interface — absent until an edit, cleared by «إعادة ضبط», cleared by a clean save, and kept with the server's reason when the save is refused; Discord read shapes; the upstream retry policy (a read survives one 5xx, a write does not); the image-by-URL policy (private hosts, redirects, pinned addresses, size and type ceilings); storage round-trips; appearance field outcomes; route guards; cache |
| `packages/core/test` | 203 | event schema, tiers, session policy, appearance normalisation, commands, metrics, hierarchy, anti-nuke limits |

**Read `# skipped`, not `# pass`.** `apps/dashboard/test/storage.test.ts` reads
`DATABASE_URL`; with no reachable database it logs
`{ skip: "no reachable database" }` for each case. The suite still *reports* the
same number of tests with every one of them skipped, and `npm run verify`
**still exits 0**. Start PostgreSQL first or the green tick means nothing.

Three more checks live beside it, each with its own command:

```bash
npm run check:dead   # knip: unused files, exports and dependencies
npm run check:ui     # a real browser: both palettes, every width, the shell and its panels
npm run check:ui:live # the real pages, against the running stack (needs a session and a guild)
npm run check:oauth  # the OAuth leg and the cross-site guard, against a running stack
npm run check:load   # latency, event-loop delay and memory under local load
npm run db:verify    # an authenticated query against the real database
```

`check:ui` needs a built dashboard (it builds one) and a Chrome or Edge binary;
it writes its screenshots to `.al-ai/ui-check/`. It launches the browser with
extensions disabled, which is what makes a clean console a statement about
this app rather than about whatever the operator has installed. It measures
**both palettes** (the light and the dark one, by emulating the system's
colour preference) at 320, 375, 390, 430, 768, 1024 and 1440 pixels, opens
the account menu and the appearance panel for real - the palette it switches
to is read back off the document, so the check is of the behaviour and not of
a screenshot - and runs **axe-core** over the two main screens, so the
accessibility result is a measurement (WCAG 2.2 A/AA rules, colour-contrast
included) rather than a claim. The findings are in `.al-ai/ui-check/axe.json`.

`check:ui:live` drives the **real** pages - the dashboard, the levels, the
commands, the logs, the welcome messages, the security screen, the audit trail, the
network settings and the bot identity - against the running BFF and the real
database, in both palettes and at 375 and 1440 pixels, with axe-core over each
of them. It signs the browser in with the session the database holds (never
printed) and paces itself, because the dashboard throttles a session to 120
requests a minute and a page load spends five or six of them. It takes about
five minutes.

`check:oauth` and `check:load` need a running stack (`npm run dev -- -Detach`).
`check:oauth` follows the login leg, checks the state cookie's attributes,
refuses a callback with a missing or a wrong state, proves a failed token
exchange mints no session, and checks that a request from another site is
refused. It does **not** sign a human in: that needs a real Discord account
and a real authorisation code, and is still to be done before a public
deployment.

`check:load` measures the local routes only. The guild routes are deliberately
not measured, because every one of them spends Discord's rate-limit budget.

Two more checks are enforced by tests rather than by eye:
`apps/bot/test/governance.test.ts` fails if `docs/GOVERNANCE.md` and the source
disagree about which rules exist, and `apps/bot/test/discord-standards.test.ts`
holds the shared permission and activity-type values against discord.js's own
`PermissionFlagsBits` and `ActivityType`.

## Performance: how the rate limit was eliminated

Discord's REST API answers a burst with `429` and the operator saw a red
"Discord يحدّ عدد الطلبات" bar. Three independent layers now prevent it, and all
three are needed — a retry in the client alone treats the symptom:

1. **The TTL cache on the BFF** (`apps/dashboard/server/cache.ts`).
   `TtlCache.resolve(key, load)` returns a fresh hit from memory, and — more
   importantly — **coalesces in-flight requests**: a second call for the same key
   awaits the promise already running instead of starting a second HTTP call.
   That coalescing, not the TTL, is what kills the burst when three tabs open at
   once. On a failed refresh it serves the stale value ("old beats wrong"), and a
   `finally` releases the in-flight slot — without it, the first failure would
   poison every later call for that key forever.
   - `GUILD_READ_CACHE_MS = 60_000` for channels and roles.
   - `BOT_GUILD_CACHE_MS = 15_000` for the bot's guild list.
   - Call `invalidateGuildReadCache(guildId)` after any write, or the screen
     shows the old value for the full 60 seconds.
2. **The bot's live Gateway cache.** The adapter's `listChannels` reads
   `client.guilds.cache`, which is already in memory in the connected client and
   spends **zero** REST quota. A read answered from the Gateway can never
   contribute to a 429.
3. **Failure classification.** `isAuthFailure` matches **401 only** and
   `isRateLimited` matches **429 only**. Before that split, every Discord error
   was treated as "token expired", so a momentary rate limit destroyed a
   perfectly valid session and threw the operator back to the sign-in screen —
   that was the real cause of the "glitch when refreshing quickly". A 429 now
   keeps the session and answers with a `retry-after` header; the client retries
   **exactly once** after `min(retry_after × 1000, 5000)` ms.

## Behaviour worth knowing

- The bot refuses to connect when any required secret is missing, and says which ones.
- A single-instance lock prevents two bot processes from sharing one token.
- The Gateway ceiling (120 events per 60 seconds) is respected by rescheduling work,
  never by dropping it. Voice churn is debounced for 2 seconds into one entry.
- `warning` and `critical` events are written to an append-only, AES-256-GCM
  encrypted audit trail, because Discord's own audit logs expire after 45 days.
- The bot does **not** log punishments itself — the Gateway records them once from
  the audit log, so a ban produces one entry and not two.
- **"Saved" is not "applied".** A save is stored even when Discord refuses it (a
  rate limit is momentary; a lost form is not), but the response reports each
  field's outcome separately, so the two can never be conflated in the UI.

## The dashboard's appearance

The dashboard has two palettes and one accent, and the reader picks them.

| Control | Where | What it does |
|---|---|---|
| **الوضع** (light / dark / system) | the sun button next to the account, in the sidebar and in the phone drawer | switches the palette; "system" follows the operating system as it changes |
| **لون التمييز** (five swatches) | the same panel | recolours the brand: the primary button, the active navigation marker, the focus ring |

Both are stored in this browser's `localStorage` (`al-ai.appearance`) and
applied **before the first paint** — an inline script in `index.html` reads the
same value, so the page never flashes the wrong palette. Nothing is stored on
the server: a theme is a preference of the person looking at the screen, not a
setting of the deployment.

The two palettes are one design with the lightness flipped: the same neutrals,
the same spacing, the same radii, and the same accent in both. The tokens live
in `apps/dashboard/src/index.css` (`--background`, `--card`, `--border`,
`--primary`, `--success`, `--warning`, `--destructive`, and the sidebar set);
HeroUI's own variables are bridged through `[data-heroui]`, so the screens
migrated to HeroUI keep the brand colour.

The navigation is grouped by what the operator is doing - overview, the
server's own configuration, moderation and commands, the logs, and the
deployment-wide screens that belong to the platform owner - and every screen
the project has appears exactly once. The sidebar can be folded into an icon
rail on the desktop; the state is a layout preference of this machine and is
stored the same way the appearance is.

## Bot appearance

Discord gives an application **one** global avatar and banner, so a per-server
avatar is not something the API can express. The customization screen is
therefore split by what Discord can actually honour:

**Global** (stored in `bot_identity`, one row, enforced by `CHECK (id)`):
avatar, banner, status, activity, bio.

**Per guild** (stored in `guild_customization`):
nickname, own-role colour, own-role icon.

The writer for every one of those fields is `apps/dashboard/server/appearance.ts`.
The bot reads `bot_identity` on a 15-second tick and applies only the presence;
see GOVERNANCE rule 18.
