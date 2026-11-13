# Bot-Hosting.net MCP (replaces FeatherPanel)

Researched and wired on 2026-11-13. Supersedes `docs/FEATHERPANEL-MCP.md` for hosting:
this panel can actually run AL AI, the old one could not.

## What it is

[Bot-Hosting.net](https://bot-hosting.net) is a shared container host (running since 2021)
aimed at Discord/Telegram bots, Node/Python apps, static sites and **databases**. Every
deployment is an isolated, always-on container with no sleep, auto-restart on crash,
dedicated ports, static IP, file manager, SFTP, GitHub sync, backups, logs and console.

It exposes three machine interfaces, all documented:

| Interface | Endpoint | Notes |
| --- | --- | --- |
| REST API v1 | `https://bot-hosting.net/api/v1` | 72 endpoints, 3 categories |
| MCP server | `https://bot-hosting.net/api/mcp` | 72 tools, one per REST operation, Streamable HTTP |
| OAuth 2.1 | `https://bot-hosting.net` | for hosted AI clients; no key needed |

Rate limits: **120 req/min per key**, 300/min per user, sliding 60 s window. Responses carry
`X-RateLimit-Remaining`; over the limit returns `429` + `Retry-After`.

## Auth

- Hosted AI clients (Claude, ChatGPT, Cursor, VS Code, Codex): OAuth 2.1 consent, no key.
- Scripts and older clients: `Authorization: Bearer bhk_…` via the `mcp-remote` bridge.
- `initialize` and `tools/list` are deliberately open, so discovery works before a key
  exists; every `tools/call` returns `-32001 Authentication required` until one is supplied.
- Keys are created in the panel: **Developers → API keys**, with per-key scopes.

Scopes that matter for this project:
`deployments:read|write|power|shell`, `files:read|write`, `env:read|write`,
`backups:read|write`, `packages:read|write`, `projects:read|write`, `account:read`,
`docs:read`. `credits:spend` is only needed to create resources paid from credit balance.

## How it is wired on this machine

Built install at `%USERPROFILE%\.al-ai\bot-hosting-mcp`:

```
run.cmd      loads .env, runs node node_modules/mcp-remote/dist/proxy.js
.env         BOT_HOSTING_MCP_URL + BOT_HOSTING_API_KEY   (git-ignored by location)
```

Registered in `%USERPROFILE%\.config\opencode\opencode.jsonc` as `bot-hosting`; the old
`featherpanel` entry stays present but `enabled: false`.

```
mcp-remote 0.16.6 → node dist/proxy.js https://bot-hosting.net/api/mcp \
  --header "Authorization: Bearer bhk_…" --transport http-only
```

Verified without a key: handshake returns server `Bot-Hosting 1.0.0` and **72 tools**;
`tools/call` is correctly refused. With a key the same tools act on the account.

## Feature surface (72 tools)

| Group | Tools |
| --- | --- |
| Deployments | list, get, create, update, move, delete, power, resize, resources, check, diagnose, apply |
| Startup | get/update startup (runtime, version, entry file, start command, queues rebuild) |
| Logs | last N lines, deep search over the last 20k lines |
| Console | `command` writes to the process stdin; `shell` runs a command inside the container with exit code |
| Files | list, tree, read, readMany, write, writeMany, edit, editMany, search (grep), index (hash+size), mkdir, move, rename, copy, delete, chmod, compress, decompress, downloadUrl, uploadUrl (no size cap), history, restore, outline (symbols without reading) |
| Env | list, set, update, delete, audit (declared vs actually read by the code) |
| Backups | list, get, restore (`replace` = full rollback, `subfolder` = copy aside) |
| Packages | list, add, remove (npm/pip manifest) |
| Databases | create as a deployment (`postgresql`, `mysql`, `mongodb`, `redis`), rotate password |
| Git | get linked repo, sync now, auto-pull on restart |
| Network | enable subdomain, set/remove slug, set/verify/remove custom domain, SFTP credentials |
| Projects | list, create, delete (group of deployments) |
| Account / docs | profile + quota, templates, docs search/get |

Runtimes: `nodejs`, `bun`, `nodemon`, `python`, `java`, `php`, `go`, `rust`, `cpp`, `lua`,
`static`, `phpweb`, `lavalink`, `uptimekuma`, plus the database engines above.

## Plans (pool model: RAM/CPU/disk shared across deployments)

| Plan | £/mo | RAM | CPU | Disk | Deployments |
| --- | --- | --- | --- | --- | --- |
| Free | 0 | 256 MB | 25% | 512 MB | 1 |
| Starter | 1.69 | 1 GB | 50% | 5 GB | 2 |
| **Starter+** | **2.59** | **2 GB** | **100%** | **8 GB** | **4** |
| Advanced | 4.69 | 4 GB | 200% | 15 GB | 8 |
| Pro | 6.79 | 8 GB | 250% | 25 GB | 12 |
| Pro+ | 10.19 | 14 GB | 400% | 40 GB | 25 |
| Enterprise | 16.99 | 20 GB | 600% | 100 GB | 40 |

Free renews manually every 4 days and shows panel ads; the paid tiers are always-on with
per-plan backup retention (15 min → 1 min) and 99.9% target availability.

## Can AL AI move here? Yes — this is the first host that actually fits

Unlike FeatherPanel, nothing here needs rewriting:

1. **PostgreSQL is a first-class runtime** (`deployments.create` with `runtime: postgresql`
   returns host/port/URI). No data-layer port.
2. **Node 24 + tsx** is supported; the two apps can be either two deployments or one
   deployment with a supervisor start command.
3. **Public HTTPS URL comes from the panel** (`enableDomains`), so the ngrok tunnel retires.
4. Everything afterwards is drivable through the 72 tools: upload, env, install, logs,
   power, backups, edits.

Measured footprint of the current stack (Windows, same code): ~287 MB for the Node
processes and ~65 MB for Postgres, CPU near idle. On Linux expect less.

Chosen layout (fits Starter+):

| Deployment | Runtime | RAM | Purpose |
| --- | --- | --- | --- |
| `al-ai` | nodejs 24 | 1024–1280 MB | dashboard (`3000`) + bot, one start command |
| `al-ai-db` | postgresql | 512 MB | schema from `infra/schema.sql` |

Roughly 1.5–2 GB disk for `node_modules` plus the database.

## What changes in the project

- `start` scripts use `--env-file=../../.env`; on the panel the environment comes from
  `env_set`, so the start command drops that flag instead of shipping a `.env` file.
- `scripts/dev.ps1`, `scripts/postgres.ps1`, the watchdog and ngrok are Windows-local
  tooling; they stay behind on the local machine and are not uploaded.
- Discord OAuth redirect + the dashboard's public URL move to the panel subdomain.
- `remote_access_mode`/instance settings get re-seeded from the new public URL.

## Free vs paid, in one line

The free tier (1 deployment, 256 MB) cannot hold app + database. The minimum that works is
**Starter+ at £2.59/month**; Starter (£1.69) only works if the app and database share the
1 GB pool and the app is squeezed into ~700 MB.

## Operations

- Rotation: panel → Developers → API keys → create the replacement, update
  `%USERPROFILE%\.al-ai\bot-hosting-mcp\.env`, restart the client, delete the old key.
- The key never enters the repo; `.env` lives outside the workspace.
- `deployments_diagnose` answers "why is it down" in a single call; `deployments_check`
  fetches the public URL and reports the status code after every deploy.
