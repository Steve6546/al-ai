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
│  • TtlCache 45s      │        ┌──────────────────────────────┐
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

## 3. Run against a local PostgreSQL

The stack runs without Docker as well. In this workspace PostgreSQL 17 lives at
`C:\Users\dlwta\.al-ai\pgdata` on port **55432**, and that data directory is
deliberately outside the repository.

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
wrapper process per service, worth roughly 70 MB each while running.

`node server/index.ts` **does not work** — on Node 22.22 with
`process.features.typescript === "strip"`, the source imports `./env.js` while
the file is `env.ts`, and Node does not rewrite the extension. That is a
tsx/esbuild feature, not type-stripping.

The dashboard binds `0.0.0.0:3000`; set `PORT` to move it. The bot holds a lock
file (`.al-ai-bot.lock`) and refuses to start if another instance owns it, so a
bot killed uncleanly needs its stale lock removed before it will boot.

### Ports

| Service | Port | Bind |
|---|---|---|
| Dashboard (BFF + SPA) | 3000 | `0.0.0.0` |
| Integration adapter | 3400 | `127.0.0.1` only |
| PostgreSQL | 55432 | `127.0.0.1` |

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
| `apps/bot/test` | 173 | crypto, nonces, routing, permissions, pipeline, presence sync, governance, Discord-constant alignment, anti-nuke, adapter, security |
| `apps/dashboard/test` | 191 | every screen renders without throwing (real jsdom mount, not `renderToString`); the error boundary contains a failure and recovers on retry; Discord read shapes; storage round-trips; appearance field outcomes; route guards; cache |
| `packages/core/test` | 137 | event schema, tiers, session policy, appearance normalisation, commands, metrics, hierarchy, anti-nuke limits |

**Read `# skipped`, not `# pass`.** `apps/dashboard/test/storage.test.ts` reads
`DATABASE_URL`; with no reachable database it logs
`{ skip: "no reachable database" }` for each case. The suite still *reports* 191
tests — it is `# pass 167, # skipped 24` — and `npm run verify` **still exits 0**.
Start PostgreSQL first or the green tick means nothing.

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
   - `GUILD_READ_CACHE_MS = 45_000` for channels and roles.
   - `BOT_GUILD_CACHE_MS = 15_000` for the bot's guild list.
   - Call `invalidateGuildReadCache(guildId)` after any write, or the screen
     shows the old value for the full 45 seconds.
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
