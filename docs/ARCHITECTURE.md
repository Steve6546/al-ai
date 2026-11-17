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
| `apps/dashboard/server/index.ts` | Fastify route registration | 67 routes; guards and services are separate modules |
| `apps/dashboard/server` | security / data / integration | `authorization.ts`, `guild-access.ts`, `db.ts`, `appearance.ts`, `discord.ts`, `network.ts`, `env.ts`, `cache.ts` |
| `apps/bot/src/lib/discord.ts` | Gateway client, embeds, slash builders, event binding | deliberately the only `discord.js` importer |
| `apps/bot/src` | pipeline, anti-nuke, levels, welcome, commands, storage | `events/`, `logging/`, `punishments/`, `security/`, `storage/` |
| `packages/core/src` | shared contracts | `contracts.ts`, `permissions.ts`, `command-registry.ts`, `anti-nuke-registry.ts` |

### Decomposition status

`i18n.tsx` was split first: 3,642 lines → 182, with all three dictionaries
(`i18n.en.ts`, `i18n.ar.ts`, `i18n.de.ts`) moved to pure-data modules and every
public export preserved on the barrel. It is the safest extraction because it
is data only, has no runtime side effects, and no textual governance test pins
the file's contents.

The remaining large modules are **not** split yet, on purpose:

| File | LOC | Why a mechanical split is not yet safe |
|---|---|---|
| `apps/dashboard/server/index.ts` | 4,322 | mutable top-level `app`/`pool`/`db`/`network`; three tests read the file as raw text |
| `apps/bot/src/lib/discord.ts` | 2,988 | governance pins `discord.js` to this exact path and `sendLogEmbed`/`applyBotPresence`/`setNickname` to it |
| `apps/bot/src/index.ts` | 2,762 | mutable cooldown/cache state; two tests scan the file textually |
| `apps/dashboard/src/views/settings/levels.tsx` | 1,720 | hook-bearing parts; render/mount tests catch hook-order regressions |
| `apps/dashboard/server/db.ts` | 1,515 | one cohesive repository layer |
| `apps/bot/src/storage/database.ts` | 1,323 | one cohesive repository layer |
| `apps/dashboard/server/network.ts` | 1,425 | one cohesive state machine |

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

## Adding a service, a workspace or a host

The repository is wired by three enforced gates. Anything added has to satisfy
them rather than bypass them:

| Gate | What it enforces | Source |
| --- | --- | --- |
| `npm run check:lock` | every manifest appears in `package-lock.json`; the root declares no runtime dependencies | `scripts/check-lockfile-sync.mjs` |
| `env-template.test.ts` | every variable the code reads is documented in `.env.example` (the only list) | `apps/bot/test/` |
| `governance.test.ts` | layering, rule numbers, the single `discord.js` importer | `apps/bot/test/` |

**A new workspace** (`packages/*` or `apps/*`):

1. `package.json` with `name`, `private: true`, `type: module`, and the three
   scripts the root fans out to: `build`, `lint`/`typecheck`, and `test` — the
   last is `node ../../scripts/test-runner.mjs test/*.test.ts`, never
   `node --test` directly: the runner caps workers and heap, and a raw run is
   what OOM-kills this machine.
2. `tsconfig.json` mirroring `packages/core/tsconfig.json`. TypeScript 7 dropped
   `baseUrl`, so cross-package imports go through `paths` and the package's own
   `exports` map.
3. One `npm install` at the root — a nested lockfile is the two-live-copies bug
   — then `npm run check:lock`.
4. If it is a long-running service, add it to `TARGETS` in
   `scripts/build-host.mjs` and to `scripts/host/boot.sh`, with a named heap
   ceiling and `tee -a` into `.al-ai-host/logs/`. Native or optional modules go
   in that script's `EXTERNAL` list so the bundle stays one file.

**A new service or background job:** one start line in `boot.sh` (heap ceiling,
log file), one health endpoint, and a listen order that fails loudly before the
first request. Nothing is scheduled locally: the host's own supervisor restarts
processes, and a Windows task or hidden loop is a second supervisor that fights
it.

**A new host:** add a row to the matrix in `DEPLOY.md`, then satisfy three
things — a persistent volume mounted at the repository root (the embedded
PostgreSQL lives in `.al-ai-pg/`, the import fingerprint in `.al-ai-host/`),
outbound HTTPS for `npm ci` and the Discord API, and the ability to run
`bash scripts/host/boot.sh`. Register that host's `/auth/discord/callback` in
whichever application the deployment uses, then run
`node --env-file=.env scripts/oauth-preflight.mjs --origin https://<host>` and
require exit 0 before calling the deployment live.

## Presence: one writer, three wake-up paths

The bot's status and activity live on the gateway, so the dashboard can only
*store* them. `apps/dashboard/server/db.ts` writes the single `bot_identity` row
and then runs `NOTIFY al_ai_presence`; the bot holds one `LISTEN` connection
(`watchPresence`) and applies the row the moment the notification arrives, so a
status click reaches Discord in milliseconds instead of waiting for a tick.

Two other paths exist, and each covers a case the notification cannot:

| Path | Trigger | Why it exists |
|---|---|---|
| `NOTIFY` | dashboard save | the fast path; no polling at all |
| one-shot timer | `statusExpiresAt` reached | a timed status must revert on its own instant, not up to a tick late |
| 60 s fallback tick | always | a dropped LISTEN connection or a row written by another tool still lands |

A duration is stored as the operator's choice (`statusDuration`) plus the
instant it lapses (`statusExpiresAt`, derived server-side from the duration —
never from a client clock). The reader applies `effectiveBotStatus`, so an
elapsed window reads as `online` without rewriting the stored row: reopening the
screen still shows what was picked.

Durations shipped: 15 m · 30 m · 1 h · 8 h · 24 h · 3 d · forever, for the three
statuses Discord times (`idle`, `dnd`, `invisible`). The database CHECK lists the
same ids — a set the schema does not know about fails at write time with
`23514`, which is exactly how the missing `30m` was caught.

An empty activity text means **no activity** (`activities: []`), not a default:
the field's own hint promises it, and `applyBotPresence` already sent an empty
list for it.

## The image import: one path, four ceilings

Every image an operator brings in — a URL, a file, an avatar, a role icon — passes
through `apps/dashboard/server/appearance.ts`, and the import path is bounded in
four independent ways, because each one fails differently:

| Bound | Value | What it prevents |
| --- | --- | --- |
| Concurrency | **3** imports at once, released in `finally` | ~5 MB per import inside an 80 MB heap; a fourth is a client loop, answered 429 |
| Byte ceiling | 2 MB, enforced *while streaming* | a huge body is never buffered whole; `Content-Length` is not trusted |
| Redirects | 3, each re-vetted like the first URL | a public link walking the request into loopback |
| Time | one 25 s budget for the whole trip | four hops × 10 s of waiting that the operator never asked to spend |

Type is decided by the **bytes** (`imageMimeFromHead`), never by `content-type`:
a real GIF served as `application/octet-stream` is accepted, and HTML served as
`image/png` is refused instead of being stored and failing later inside Discord.
Nothing on this path re-encodes, which is why an animated GIF keeps its frames.

The picker and the save path share one list of types (`lib/image-fit.ts`) so a
format cannot be storable by the server and greyed out in the dialog — the bug
that hid GIF from the welcome-messages file dialog while the URL import accepted
it.

**Discord re-encodes what it stores.** Measured: a 1,001,718-byte GIF uploaded as
the bot avatar was served back from the CDN as 1,030,806 bytes with a different
SHA-256, under an `a_…` hash (animated, accepted). Byte-identity therefore holds
up to Discord's edge, not through it.

## The account's appearance: one shape, three consumers

`user_preferences.appearance` is JSONB, nullable, and validated by
`packages/core/src/appearance.ts` — the same module the browser imports. Three
consumers read that one definition, which is what keeps them from drifting:

| Consumer | Reads it for |
| --- | --- |
| `apps/dashboard/server/index.ts` | `normaliseAppearance` before any write, and again before any read, so nothing unvalidated reaches the column or the client |
| `public/theme-boot.js` | paints the **cached** copy before the first frame; duplicates only the two arithmetic rules (hex normalising, WCAG luminance) because it runs before any module can load |
| `src/lib/theme.ts` | applies the account's value after sign-in and writes the cache back |

The cache (`localStorage["al-ai.appearance"]`) is a copy for speed, never a source
of truth: `App.tsx` overwrites it from the server on every session load. Without
it the page would paint the default palette and repaint once the session resolved.

**Auto-contrast is measured, not fixed.** `readableOn` compares the accent's
relative luminance with 0.1791 — the point where white and black score the same
WCAG contrast. Above it the label is near-black, below it white. A fixed white
label fails on pale amber; a fixed black label fails on deep violet; four of the
five shipped accents sit on the near-black side.

**Backgrounds** are a hard-stop gradient for the two split modes (`0 50%` /
`50% 100%` on the chosen axis) and a smooth interpolation for `gradient`. A solid
backdrop sets `--app-bg-color` and no image, so switching back leaves nothing
behind for the next paint to blend with.

## Sessions: what the screen may know

`oauth_sessions.id` is the session token, so it never appears in JSON. The
overview returns a **handle** — `sha256(id)` truncated to 16 hex characters — and
`POST /api/me/sessions/:handle/revoke` resolves it by re-listing *this account's*
sessions and hashing each one. A handle cannot be replayed as a cookie, a guessed
one matches nothing, and another account's handle is not in the list being
searched. Signing out the current session is refused there: that is the logout
button, and it has a different aftermath.

Device kind comes from `describeUserAgent` (core), which is ordered for the cases
that actually happen: Edge and Opera before Chrome (both advertise `Chrome/`),
iPad before Mac (iPadOS sends a desktop macOS string plus `Mobile`), Android
before Linux, and a tablet is an Android UA without `Mobile`.
