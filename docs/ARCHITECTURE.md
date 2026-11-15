# Architecture

AL AI is an Arabic-first (RTL) Discord management bot with a secure control
dashboard. Three workspaces, three processes, one contract package.

## Processes

```
 Browser (React 19 + Vite, RTL)          Discord Gateway (WebSocket)
 apps/dashboard/src                     apps/bot/src/lib/discord.ts
        │ same-origin fetch                     ▲
        │ httpOnly session cookie              │ owns presence + events
        ▼                                     │
 Fastify BFF :3000  ──REST v10──▶ Discord REST API
 apps/dashboard/server                       │
   │  • session / tier / 2FA                  │ BFF is the ONLY writer of
   │  • TtlCache + RequestThrottle            │ appearance fields
   │  • PostgreSQL repositories
   ▼
 PostgreSQL (55432 locally, 5432 in Compose)
        ▲
        │ signed HMAC heartbeat, every 30s, loopback only
 Integration adapter 127.0.0.1:3400 ── inbound reads from the bot's Gateway cache
```

`packages/core` is the single source of truth for every shape crossing a
process boundary: event schema, permissions, tiers, session policy, crypto,
appearance normalisation, command registry, anti-nuke limits.

## Load-bearing rules

1. **The dashboard never holds a Discord token.** Every write re-resolves the
   caller's tier on the server (`requireTierForGuild`). A guild ID is not a
   secret, so `requireSession` alone would let any signed-in account read any
   guild by pasting its ID.
2. **`apps/bot/src/lib/discord.ts` is the only file importing `discord.js`.**
   The BFF talks REST over `fetch`; the bot owns the Gateway. Enforced by
   `apps/bot/test/governance.test.ts` (rule 2), including a textual import scan.
3. **One writer per field.** The dashboard writes nickname, avatar, banner,
   bio, role colour and role icon. The bot's only write is **presence** (status
   and activity), which has no REST route and lives on the Gateway connection.
4. **The Gateway cache is the cheap read path.** `listChannels` answers from
   `client.guilds.cache` and spends zero REST quota.

## Module map

| Area | Responsibility | Notable modules |
|---|---|---|
| `apps/dashboard/src/lib` | i18n, format, routing | `i18n.tsx` (provider/state only), `i18n.en.ts`, `i18n.ar.ts`, `i18n.de.ts` (pure dictionaries) |
| `apps/dashboard/src/views` | one screen per feature | `settings/*`, `account-settings.tsx`, `security.tsx` |
| `apps/dashboard/src/components` | shell + UI primitives | `app-shell.tsx`, `status-picker.tsx`, `components/ui/*` |
| `apps/dashboard/src/api/client.ts` | all browser HTTP | single entry point, no token ever |
| `apps/dashboard/server/index.ts` | Fastify route registration | 64 routes; guards and services are separate modules |
| `apps/dashboard/server` | security / data / integration | `authorization.ts`, `guild-access.ts`, `db.ts`, `appearance.ts`, `discord.ts`, `network.ts`, `env.ts`, `cache.ts` |
| `apps/bot/src/lib/discord.ts` | Gateway client, embeds, slash builders, event binding | deliberately the only `discord.js` importer |
| `apps/bot/src` | pipeline, anti-nuke, levels, welcome, commands, storage | `events/`, `logging/`, `punishments/`, `security/`, `storage/` |
| `packages/core/src` | shared contracts | `contracts.ts`, `permissions.ts`, `command-registry.ts`, `anti-nuke-registry.ts` |

### Decomposition status

`i18n.tsx` was split first: 3,642 lines → 183, with the English and Arabic
dictionaries moved to pure-data modules and every public export preserved on
the barrel. It is the safest extraction because it is data only, has a German
precedent, and no textual governance test pins the file's contents.

The remaining large modules are **not** split yet, on purpose:

| File | LOC | Why a mechanical split is not yet safe |
|---|---|---|
| `apps/dashboard/server/index.ts` | 3,874 | mutable top-level `app`/`pool`/`db`/`network`; three tests read the file as raw text |
| `apps/bot/src/lib/discord.ts` | 2,940 | governance pins `discord.js` to this exact path and `sendLogEmbed`/`applyBotPresence`/`setNickname` to it |
| `apps/bot/src/index.ts` | 2,761 | mutable cooldown/cache state; two tests scan the file textually |
| `apps/dashboard/src/views/settings/levels.tsx` | 1,720 | hook-bearing parts; render/mount tests catch hook-order regressions |
| `apps/dashboard/server/db.ts` | 1,495 | one cohesive repository layer |
| `apps/bot/src/storage/database.ts` | 1,322 | one cohesive repository layer |
| `apps/dashboard/server/network.ts` | 1,302 | one cohesive state machine |

Split these incrementally, one module at a time, with a green `npm run verify`
after each. A big-bang split would break path-pinned textual tests, the
single-importer rule, module initialisation order and React hook order all at
once, leaving no bisectable diff.

## Cross-cutting concerns

- **Governance:** `docs/GOVERNANCE.md` declares exactly **29** numbered rules,
  enforced by `apps/bot/test/governance.test.ts`. Do not renumber, merge or
  de-bold a rule without updating that test.
- **Single instance:** three fail-closed guards — the `.al-ai-bot.lock` file
  (pid + start-time check), the integration adapter port 3400 (bound before
  `client.login()`), and `PORT` 3000. `npm run dev` is the only Windows
  supervisor; `npm start` is the portable two-child launcher.
- **Rate limits:** a TTL cache with in-flight coalescing, Gateway-cache reads,
  and a 401-vs-429 failure split that keeps a valid session alive.
- **ngrok quota:** liveness is loopback-only; public verification is budgeted.
  See `docs/DEPLOYMENT.md` and `.workbuddy-ai/memory/RULES-NGROK.md`.
- **Memory ceiling:** all tests go through `scripts/test-runner.mjs` (two
  workers, ≤768 MiB heap each). See `docs/DEPLOYMENT.md`.
