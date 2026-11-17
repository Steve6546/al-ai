# API & Security Contract

The browser talks to **one** origin: the Fastify BFF on `:3000` (or the same
server through the ngrok tunnel). There is no CORS-based cross-origin API and
no Discord token in the browser — ever.

## Authentication model

| Layer | What it proves | Failure |
|---|---|---|
| Host gate (`server/network.ts`) | the `Host` header is loopback, one of this machine's own LAN addresses, or the single configured tunnel host | `403` |
| `requireSession` | an httpOnly, `__Host-` prefixed (in production) session cookie exists in `oauth_sessions` | `401` |
| `requireGuildAccess` | the signed-in user may see **this** guild | `403` |
| `requireTierForGuild` | the user's tier is re-resolved **on the server** for this guild | `403` |
| Admin 2FA | owners / guild admins clear TOTP or a single-use recovery code before the OAuth callback mints a session | pending login, no session |

Administrative sign-ins never mint a session before the second factor is
verified. Every admin is challenged even on a first sign-in (the enrolment
screen is part of the pending-login flow), and an account that already carries
a credential stays challenged even when Discord no longer reports it as an
admin. A replayed TOTP, a spent recovery code, an expired/cancelled login
and an over-guessed login are all refused. Secrets are AES-256-GCM envelopes at
rest; recovery codes are keyed HMACs only.

Sessions carry a `second_factor_satisfied` flag that is set only by a login
which consumed a code. Once an account has a credential, `readSession`
destroys and refuses any session without it: a cookie minted before enrolment
is not a way around the second factor. Confirming a new authenticator marks
the current session (which just proved a fresh code) and revokes the others.

## Route groups

`apps/dashboard/server/index.ts` registers **64** routes. Grouped by job:

| Group | Examples | Notes |
|---|---|---|
| Health & version | `GET /api/health`, `GET /api/version`, `GET /favicon.ico` | `/api/health` exposes verification counts only to a signed-in session |
| Auth | `GET /auth/discord/login`, `GET /auth/discord/callback`, `GET /auth/lan-handoff`, `POST /auth/logout`, `GET /api/session` | `state` cookie, CSRF guard, exact `redirect_uri` match; a LAN origin signs in on the tunnel and is handed back with a 60-second single-use ticket |
| Second factor | `GET /api/2fa/enrollment`, `POST /api/2fa/verify`, `POST /api/2fa/cancel` | pending-login flow; `verify` may answer `redirectTo` for a LAN handoff |
| Account | `GET/PUT /api/me/preferences`, `GET /api/me/security`, `POST /api/me/sessions/revoke-others`, `POST /api/me/2fa/*` | account-wide, not guild-scoped |
| Network reach (owner only) | `GET/PUT /api/network`, `GET/POST /api/network/firewall` | mode `off`/`lan`/`tunnel`; writes have a 3 s cooldown; `POST firewall {elevate:true}` raises the Windows UAC prompt and the rule covers Public+Private+Domain |
| Presence (owner only) | `GET/PUT /api/bot/presence` | `PUT` without `guildId` returns `400 GUILD_ID_REQUIRED` on purpose |
| Guild read/write | `GET /api/guilds`, `/api/guilds/:guildId/{invite,channels,tiers,commands,members,audit,metrics,customization,logging,welcome,security}` and their `PUT`/`POST` counterparts | every guild-scoped route re-checks access on the server |
| Levels | `/api/guilds/:guildId/levels/*` (settings, rewards, sync, members, leaderboard, status) | reward CRUD uses `POST/PATCH/DELETE` |
| Images | `POST /api/image/from-url` | SSRF guard: private hosts, redirects, pinned addresses; PNG/JPEG/GIF/WEBP identified by magic bytes (so animated files are kept byte-for-byte and a host that lies about `content-type` is handled); 2 MB ceiling; one 15 s budget for the whole import (share link → page → preview) so a slow host gets a named timeout instead of a proxy `502`; returns `{ dataUrl, bytes }` |
| Internal | `POST /internal/layer/health` (loopback only, HMAC-signed), adapter `127.0.0.1:3400` | never exposed publicly |

## Error semantics

- `401` = auth failure only; `429` = upstream rate limit only. Conflating them
  used to destroy a valid session on a momentary Discord 429. A 429 keeps the
  session, answers with `retry-after`, and the client retries exactly once
  after `min(retry_after × 1000, 5000)` ms.
- **"Saved" is not "applied".** A save is stored even when Discord refuses it,
  but the response reports each field's outcome separately so the UI can never
  conflate the two.
- `400 INVALID_DOMAIN`, `400 GUILD_ID_REQUIRED`, `403 FORBIDDEN`,
  `429 TOO_MANY_REQUESTS` are deliberate, tested contracts. Do not "fix" them.
- Reads may survive one upstream 5xx retry; writes never do (no double-apply).

## Discord API v10 boundary

- The BFF is the **only** writer of appearance fields. It uses REST `fetch`
  with `PATCH /guilds/{id}/members/@me` for `nick`/`bio`/`banner`/`avatar`.
  `bio` is write-only on the API, so the stored row is the sole read source.
- Presence has no REST route: the bot reads `bot_identity` every 15 s and
  applies status/activity on the Gateway connection.
- The bot's Gateway cache answers channel/role reads with zero REST quota.
- `bot_identity` is a one-row table owned by the deployment (presence only);
  `guild_customization` owns every per-server appearance field.

## Verification

```bash
npm run check:oauth     # OAuth leg, state cookie, CSRF guard, logout
npm run check:2fa       # admin second factor against the live BFF + database
npm run check:load      # latency / event-loop delay / memory, local routes only
npm run check:ui:live   # real pages in a real browser, axe-core included
```

`check:oauth` does not sign a human in — that needs a real Discord account and
authorisation code and remains a manual pre-deployment step.
