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

## The appearance: a colour engine, a cache, and one write per frame

The theme is not a list of CSS classes. `packages/core/src/theme-engine.ts` is a
pure function — `buildThemeTokens(appearance)` — that turns a choice into the 27
custom properties the stylesheet already reads. Nothing else decides a colour,
so the picker, the preset tiles, the boot script and the server all describe the
same theme instead of four approximations of it.

**OKLCH, not HSL.** HSL lightness is not perceptual: `hsl(60 100% 50%)` is a
screaming yellow and `hsl(240 100% 50%)` is a dark blue at the same "lightness",
so a ladder built on it produces surfaces of wildly different apparent depth per
hue. OKLCH is near-uniform, which is what lets one set of lightness steps work for
every palette. The chosen colours supply **hue and chroma**; the mode supplies
**lightness**:

| Token | dark | light |
| --- | --- | --- |
| `--app-bg-image` (stops) | L 0.130 → 0.270 | L 0.990−0.025·i → −0.085 |
| `--background` | first stop | first stop |
| `--sidebar` | canvas + 0.045 | canvas − 0.022 |
| `--card` | canvas + 0.080 | canvas + 0.020 (≤ 0.995) |
| `--muted` | canvas + 0.130 | canvas − 0.040 |

Two properties of that table are load-bearing:

- **The mode owns the ladder.** A dark preset viewed in light mode is a *light*
  page carrying the same hues — the first implementation reused the picked
  colours' own lightness, so choosing a dark theme in light mode produced a black
  page, and choosing `#3b82f6` (L ≈ 0.62) produced a canvas brighter than the
  panels above it.
- **Intensity scales chroma and nothing else.** `intensity: 0` is a genuinely
  neutral theme (that is what the OLED preset is), with no chroma floor, and the
  light canvas start also moves with intensity so "no tint" lands on white rather
  than on a grey-white.

`scope: "tinted"` lets the colour reach the panels; `scope: "canvas"` keeps the
gradient on the page and leaves every surface at chroma 0. That is the switch the
old system did not have, and the reason cards used to stay black under a themed
page.

**Contrast is computed per surface, never fixed.** `readableText(surface)` picks
near-white or near-black by comparing WCAG contrast; for a gradient it is
`readableOnEvery(stops)`, choosing against the *worst* stop — a white label that
passes on the dark end of a sunset and fails on its orange end is the bug that
rule exists to prevent. Every shipped preset is asserted readable in both modes.

**Three consumers of one shape:**

| Consumer | Role |
| --- | --- |
| `apps/dashboard/server/index.ts` | `normaliseAppearance` on write and again on read; nothing unvalidated reaches the JSONB column or the client |
| `public/theme-boot.js` | paints the **cached tokens** before the first frame, and computes no colour maths |
| `src/lib/theme.ts` | applies the account's value after sign-in, writes the cache back, coalesces live changes |

The boot script deliberately contains **no** colour engine: re-deriving an OKLCH
ladder in plain ES5 would mean two implementations of the contrast rule that
must agree forever. Instead `lib/theme.ts` stores the tokens it derived next to
the choice, keyed by a fingerprint of that choice (`mode|angle|intensity|scope|
accent|stops|side-of-system`). A cache that does not match is discarded rather
than partially applied — a correct unthemed page beats a mismatched one, and
React paints the real palette immediately after. Measured consequence: swapping
the stored preference without the matching cache leaves the page on the
stylesheet defaults until React mounts, which is why `main.tsx` applies the
preference itself.

**One write per frame.** Dragging the angle slider fires ~120 events a second
against a 60 Hz screen. `createAppearanceScheduler().schedule()` keeps the latest
choice and paints it once per `requestAnimationFrame`; `flush()` paints
immediately for discrete changes (a preset, a reset). Each paint is 27
`setProperty` calls — synchronous style invalidation — so uncoalesced it would
make the drag slower the faster the operator moves.

**The picker** is `react-colorful` (2.8 kB, no dependencies) restyled through one
extra class of specificity, because the library injects its own stylesheet after
ours. Beside it: a hex field that accepts `#abc`, `AABBCC`, `rgb()/rgba()` and
bare decimal triples, a copy button, swatches, and the `EyeDropper` API when it
exists — feature-detected, because a button that silently does nothing on Firefox
is worse than no button.

**Limits, stated rather than discovered:** in light mode `--card` stays nearly
white (L ≈ 0.99) by design — a tinted page under white cards is what light UI
does, and there is no room in the gamut above L 0.995 for chroma; the tint is
visible in `--background`, `--sidebar` and every accent surface. The appearance is
stored on the account (`user_preferences.appearance`), not per device, so it
follows the operator between browsers; only the *cache* is per browser.

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

## The overview: two halves, both checkable

The first screen a signed-in operator sees answers two questions with the same
rule — nothing is drawn that a query did not return.

**Live numbers.** `GET /api/guilds/:id/metrics` adds `series` (24 hourly buckets
of `audit_trail`, oldest first) and `previous` (the totals of the 24 hours before
that window). The buckets come from one `date_trunc('hour') … GROUP BY`; the gaps
are filled by `fillHourlySeries` in `packages/core/src/series.ts`, because
"nothing happened at 04:00" and "04:00 is missing from the result" are different
facts and only one of them belongs on a line chart. Each card takes its number
from the same window as its chart, so a card cannot print `0` beside a line with
four events in it.

**The comparison is named, not divided.** `changeSince(now, previous)` returns
`new` when the baseline is zero and `flat` when both are, and only returns a
percentage when a percentage exists. Production on 2026-11-17 was exactly that
case — three events in the window, none in the one before — which is where the
reference design printed `Infinity%` beside a green arrow. Percentages are
clamped to ±999 so a one-event baseline cannot claim `+4900%`.

**Modules.** `GET /api/guilds/:id/modules` answers from each module's own row in
one query (`db.getModuleStates`): `guild_security.enabled` (default **true** —
the engine arms on join), `guild_logging`, `guild_welcome`,
`guild_welcome_messages`, `guild_customization`, `guild_levels`,
`guild_invites`, plus three tallies (`guild_role_tiers`, `audit_trail`,
disabled `guild_command_flags`). `GUILD_MODULE_KEYS` in `packages/core/src/
contracts.ts` is the closed list: a card cannot be added for a system that has no
table to read, which is what keeps a reference design's tickets, backups and
"plus" tiers from appearing on a screen that never implemented them. The
instance-wide «حالة البوت» is omitted for callers who are not the deployment's
owner, and a group whose cards are all withheld renders nothing rather than a
heading over empty space.

## Presence glyphs on one grid

`StatusDot` draws all four of Discord's states in a 16 × 16 box with the same
outer radius, so the picker, the trigger and the preview cannot show a small dot
next to a large one:

| State | Geometry |
| --- | --- |
| online | filled circle, `#23a55a` |
| idle | crescent: circle masked by a cut circle at (13.6, 2.4) r = 6.4 — centres 7.92 apart, body 6.48 thick at its deepest |
| dnd | circle `#f23f43` with a white bar 10 × 2.4, radius 1.2 |
| invisible | ring `#80848e`, r 6.5 with a 3-unit stroke (19% of the glyph at every size) |

The crescent keeps a mask rather than an overlapping disc of the surface colour:
the mask is a hole, so the glyph is correct on the card, in the menu and in the
preview without any caller passing a background. Six cut-circle placements were
rendered at 9, 14 and 32 px and compared against Discord's own menu before the
current one was chosen.
