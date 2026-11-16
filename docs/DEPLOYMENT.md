# Local development & operations

AL AI runs unchanged on Windows (PowerShell), Linux, macOS, Docker Compose and
a plain VPS. Nothing in the source depends on a sandbox URL or a machine path.

This document covers **running it on a workstation**: ports, LAN reach, the
single-instance guards, the ngrok request budget and troubleshooting. For
deploying to a host see [DEPLOY.md](DEPLOY.md); for the portal and panel
walkthroughs see the [README](../README.md).

## 1. Quick start

```bash
cp .env.example .env          # fill in the values below
npm ci
```

**Windows (supervised, recommended):** `npm run dev` starts PostgreSQL (only
if its port is closed), the dashboard, the bot, and — with `-- -Tunnel` — the
ngrok agent. It owns pid files and graceful Ctrl+C. `scripts/dev.ps1` is
Windows-only and optional.

Nothing in this repository registers a scheduled task, a logon entry or a
background probe loop. The local stack runs only while you are watching it;
unattended keep-alive is the host's job (`scripts/host/boot.sh`), not your
workstation's. A workstation-side watchdog would resurrect a stack nobody asked
for — and on Windows each background re-launch flashes a console window.

**Linux / macOS / VPS (portable):**

```bash
npm start                     # two Node children, no shell, no PowerShell
npm start -- --dry-run        # print the resolved commands without starting
npm start -- --service=bot    # start just one service
```

`npm start` loads `.env` with `process.loadEnvFile` and passes the environment
to both children. It does **not** start PostgreSQL or manage an ngrok agent —
point `DATABASE_URL` at a running database (Compose does this for you).

**Docker Compose (fresh VPS):**

```bash
cp .env.example .env          # set every value in section 2
docker compose -f infra/docker-compose.yml up --build -d
```

Compose publishes 3000, applies `infra/schema.sql` through
`/docker-entrypoint-initdb.d/` on the **first** initialisation of a fresh
volume, and waits for the database healthcheck. Both images run
`node --import tsx` (in-process loader, no `tsx`/`npx` shim) so stop signals
reach the program and one process — not two — is billed to the container.
`env_file: ../.env` is required — copy the template before the first `up`.

## 2. Environment reference

`.env` is gitignored; **`.env.example` is the contract** — three sections, and
the only place the variable list is written down. It is not repeated here,
because a second copy is a second thing to drift: this document used to carry a
table that listed `DATABASE_URL` as required, which stopped being true the day
`boot.sh` started the embedded cluster itself.

Read it in this order:

1. **Section 1 — the 9 core keys.** Nothing boots without them.
2. **Section 2 — `DATABASE_URL`.** Blank means "start the built-in PostgreSQL";
   set means "use this external one and start nothing". `npm run dev` on a
   workstation needs the commented line uncommented, because it does not go
   through `boot.sh`.
3. **Section 3 — everything else.** Every value has a working default; blank
   means "use it". Two of them (`KEY_ROTATION_DAYS`, `AUDIT_RETENTION_DAYS`) are
   additionally required when `NODE_ENV=production`.

`apps/bot/test/env-template.test.ts` enforces the contract in the only direction
that matters: every variable the code reads must appear in `.env.example`. It
covers `process.env`, `process.env["…"]`, the dashboard's `read("…")` wrapper,
the shared `readEnv(source, "…")` accessor, and the `heap("…")` / `pinned("…")`
helpers in `scripts/`.

Generate secrets with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`.

**Discord Developer Portal:** the full tab-by-tab walkthrough is in the
[README](../README.md#discord-developer-portal--every-tab). The short version:
`SERVER MEMBERS` + `MESSAGE CONTENT` intents on, `PRESENCE` off, scopes `bot` +
`applications.commands` (login uses `identify` + `guilds`), and the redirect URI
registered exactly — no trailing slash.

## 3. Ports

| Service | Port | Bind |
|---|---|---|
| Dashboard (BFF + SPA) | 3000 | `0.0.0.0` |
| Integration adapter | 3400 | `127.0.0.1` only |
| PostgreSQL | 55432 locally, 5432 by Compose default | `127.0.0.1` |
| ngrok agent inspection API | 4040 | `127.0.0.1` only |

On this machine PostgreSQL 17 lives at `%USERPROFILE%\.al-ai\pgdata` on
**55432**; port 5432 is occupied by another instance — do not touch it.

### Reaching the dashboard from the router (LAN)

The BFF binds `0.0.0.0`, so the socket is already reachable from every
interface. What limits reach is the **Host gate** (`server/network.ts`): by
default the saved mode is `off` and a request whose `Host` is not loopback is
answered `403 REMOTE_ACCESS_DISABLED`. Two ways to open it:

```bash
# Windows — one run, nothing saved, no ngrok request spent
npm run dev -- -Lan
npm run dev -- -Lan -OpenFirewall       # adds the inbound rule (needs elevation)

# Portable — one run
AL_AI_REMOTE_ACCESS=lan npm start

# Persistent — the «الوصول للشبكة» screen → «الشبكة المحلية»
# writes remote_access_mode = 'lan' to instance_settings.
```

`npm start` and `npm run dev:status` print both ready-to-use URLs at launch,
computed from `os.networkInterfaces()` and the live socket. The «الوصول للشبكة»
screen shows the same addresses, a locally generated QR code, the real bound
host/port, and whether the gate is open. VPN, WSL/Docker/VirtualBox,
APIPA (`169.254/16`) and IPv6 link-local addresses are filtered out of the
display list; the Host gate still accepts every address the machine owns.

On Windows, an inbound TCP rule for the dashboard port is needed once:

```powershell
New-NetFirewallRule -DisplayName 'AL AI Dashboard (LAN port 3000)' `
  -Direction Inbound -Protocol TCP -LocalPort 3000 `
  -Action Allow -Profile Private,Domain
```

**Cookies and sign-in.** A browser accepts a `Secure`/`__Host-` cookie on
`http://localhost` but **discards** it on `http://192.168.x.x`. Session, OAuth
state and 2FA-pending cookies therefore follow the request's origin: hardened
on HTTPS/loopback, plain (without `Secure`, without the `__Host-` prefix) on a
plain-HTTP LAN address. `SameSite=Lax`, `HttpOnly`, `Path=/`, no `Domain`, the
same-origin write guard and the exact Host allow-list are identical everywhere.

Discord registers HTTPS redirect URIs (and HTTP `localhost`/`127.0.0.1` for
development) only, so a plain-HTTP LAN address cannot be a callback. A LAN
visitor who clicks sign-in is handed to the tunnel origin when one exists, or
shown an actionable page naming the address they opened. Set
`DISCORD_REDIRECT_URI` to the tunnel callback and register it in the Developer
Portal; sign in once through the HTTPS tunnel URL from the other device. See
`docs/API.md` for the host gate and `docs/GOVERNANCE.md` for the rules.

## 4. Exactly one copy of each service

Three independent guards fail closed:

| Guard | Refuses when |
|---|---|
| `.al-ai-bot.lock` (atomic `open(...,"wx")` + pid/start-time check) | a live bot already owns the lock |
| adapter port 3400 | the port is taken — the bot exits **before** `client.login()` |
| `PORT` 3000 | the port is taken — the dashboard exits, no second ngrok agent |

A stale lock is reclaimed on the next start, including when its pid has been
recycled. `npm run dev` is the only launcher on Windows; `dev:bot` and
`dev:dashboard` delegate to it. There is no `tsx watch`: it would be a second
supervisor. To pick up a change, `npm run dev:restart` — it deliberately keeps the
ngrok agent up so a registered OAuth callback survives. `npm run dev:stop` ends
the agent and the local database too, so nothing of the stack is left running.

## 5. The ngrok request budget

The free plan budgets **20,000 HTTP requests/month**. Every request through the
public URL — a page load, a poll, a self-probe — spends one. When exhausted,
ngrok answers **every** public request with `403 ERR_NGROK_727` while the agent
itself still reports `online`. Rules enforced in `server/network.ts`:

1. Liveness is **loopback only**: `127.0.0.1:4040/api/status`,
   `/api/tunnels` and `:3000/api/health`. Zero quota.
2. End-to-end verification is **one request/hour** (one per 6 h while over
   quota), with `ngrok-skip-browser-warning`. It is the only automatic request
   through the public edge and it is what detects `ERR_NGROK_727`.
3. An exhausted quota **never re-mints the agent**. The healer refuses; a
   two-failure threshold plus a 5-minute cooldown bound all other restarts.
4. Browser polls: 20 s on loopback, 60 s on a public origin, none when the tab
   is hidden. The network screen polls 2 s while `starting`, then 60 s.

An exhausted quota is an **account fact**, not a code defect: wait for the
billing cycle or upgrade at <https://dashboard.ngrok.com/billing>. Use
localhost or LAN in the meantime. ngrok's own config file carries the
authtoken — the dashboard never stores a second copy. See
`.workbuddy-ai/memory/RULES-NGROK.md` for the full rule set.

## 6. Verification

```bash
npm run verify          # lint → check:schema → test → build → check:secrets → audit
npm run typecheck       # tsc --noEmit in every workspace
npx knip                # zero unused files, exports, dependencies
npm run check:dead      # same knip check, wrapped
npm run db:verify       # authenticated SELECT 1 against the real database
npm run check:ui        # real browser, both palettes, axe-core
npm run check:oauth     # OAuth leg + CSRF guard (needs a running stack)
npm run deploy          # build + secret gate on dist + confirm the served hash
```

`npm run deploy` is the publishing step, not a second build command: it reads
the bundle hash the live server is serving, rebuilds, scans the fresh `dist/`
(the one artefact no unit test reads), then compares disk with `/api/version`.
Use `--no-build` to only confirm what is already served, `--port` when the BFF
is not on 3000.

**Read `# skipped`, not `# pass`.** With no reachable database,
`storage.test.ts` skips every case and `npm run verify` still exits 0.
`node --test` defaults its concurrency to the CPU count; on a 20-thread machine
that used 8-15 GiB. All workspaces now run through `scripts/test-runner.mjs`:
at most two workers, ≤768 MiB heap each, and a refusal below 512 MiB free.
Measured peak for a full `npm run verify`: ~1 GiB of Node memory total.

## 7. Troubleshooting

| Symptom | Cause / action |
|---|---|
| `403 ERR_NGROK_727` | monthly quota spent; wait for reset or upgrade. localhost works fine |
| `ERR_NGROK_9040` | ngrok sees a proxy's IP; start the agent with `http_proxy`/`https_proxy` unset |
| `ERR_NGROK_9009` | free plan rejects proxied agents — same fix |
| `ERR_NGROK_6030` | two agents on one domain; adoption kills the stale one before starting a new one |
| `ERR_NGROK_8012` | traffic reached the agent but the upstream is down or bound elsewhere; check `curl --noproxy '*' http://127.0.0.1:3000/api/health` first |
| `EADDRINUSE` on 3000 | the dashboard exits deliberately; another instance is running |
| Tests "pass" with a live DB down | `storage.test.ts` skipped — start PostgreSQL |
| `curl` returns 502 on a loopback URL | the sandbox proxy; always pass `--noproxy '*'` |
