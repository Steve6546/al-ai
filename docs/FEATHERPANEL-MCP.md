# FeatherPanel MCP (panel.quaxly.com)

> **Status: on hold, connector disabled.** Researched and wired on 2026-11-13, then superseded the
> same day by [Bot-Hosting.net](BOT-HOSTING-MCP.md) — the host that actually fits this project.
> The `opencode.jsonc` entry stays as `enabled: false` for the record; the install under
> `%USERPROFILE%\.al-ai\featherpanel-mcp` is intact if it is ever needed again.

How this machine talks to the FeatherPanel control panel, what the connection can
actually do, and where it stops. Written after wiring it up on 2026-11-13.


## What it is

`@featherpanel/mcp` is the official Model Context Protocol server shipped inside the
[`MythicalLTD/FeatherPanel`](https://github.com/MythicalLTD/FeatherPanel) repo under `mcp/`
(package version 1.4.0, MIT). It is a thin HTTP client: every tool maps to a panel REST
route under `/api/user/*` (and `/api/admin/*` when the key holds `admin.*`).

It manages resources that already exist on a panel. It does not create hosting accounts,
allocate nodes, or provision servers.

## Why it runs locally here

Three delivery paths exist upstream:

| Path | Status on this panel |
| --- | --- |
| Remote `https://<panel>/mcp` (OAuth / bearer) | Not deployed — the route answers Cloudflare **502** |
| `npx @featherpanel/mcp` | Not published to npm — `registry.npmjs.org` returns `{"error":"Not found"}` |
| Local stdio build | **Used** |

Installed at `%USERPROFILE%\.al-ai\featherpanel-mcp` (clone → `npm install` → `npm run build`).
Kept outside the repo on purpose: `node_modules` and the API key never enter git.

```
%USERPROFILE%\.al-ai\featherpanel-mcp\
  dist\stdio.js     built MCP entry point
  run.cmd           loads .env, starts node dist/stdio.js
  .env              FEATHERPANEL_URL + FEATHERPANEL_API_KEY  (git-ignored by location)
```

Registered in `%USERPROFILE%\.config\opencode\opencode.jsonc`:

```jsonc
"featherpanel": {
  "type": "local",
  "command": ["cmd.exe", "/c", "C:\\Users\\dlwta\\.al-ai\\featherpanel-mcp\\run.cmd"],
  "enabled": true
}
```

The API key lives only in `.env`. Rotating it is a two-line edit — no config change.

## Verified state of the connected account

`whoami` → user `_shwc` (id 397), Discord `951486082690744412` (matches `OWNER_ID`),
role **user**, `permissions: []`, `webspace_limit: 0`, `list_servers` → **0 servers**.
Panel modules `web` and `vds` are disabled, so their tool groups are not even listed.

## The 104 tools, by group

| Group | What it does | Usable now |
| --- | --- | --- |
| Account | profile, notifications, inbox, SSH keys, sessions | yes |
| Servers | list, details, lifecycle status, activities, live CPU/RAM/disk + history | needs a server |
| Power | start / stop / restart / kill | needs a server |
| Files | list, read, write, mkdir, delete, rename, copy, compress, decompress, remote pull, recursive search, chmod, trash (list/restore/empty) | needs a server |
| Console | send command, short-lived JWT + Wings WebSocket, recent logs, install logs, player list | needs a server |
| Backups | create, list, delete, restore, lock/unlock, download URL, recover stalled | needs a server |
| Databases | list hosts, create/update/delete **MySQL** database, credentials | needs a server |
| Schedules | cron schedules + tasks (power/backup/command) | needs a server |
| Network | allocations, auto-allocate, primary allocation, firewall rules, reverse proxy, subdomains, FastDL | needs a server |
| Startup | startup command, Docker image, spell variables, update server, reinstall, wipe | needs a server |
| Subusers | invite, list, permissions, remove | needs a server |
| Support | ticket categories/priorities/statuses, create/reply/close tickets | yes |
| Knowledgebase | search articles, list categories | yes |
| Webspace / VDS / Admin | omitted — module disabled or key lacks `admin.*` | no |

So: the connection is real and authenticated, but every interesting group (files, console,
power, backups, databases, network, startup) gates on owning at least one server.

## Can the AL AI project be moved onto this panel?

Not as it stands. Four hard blockers:

1. **No server to move into.** The account owns zero servers, and the `user` role cannot
   create one. Servers are provisioned by the panel owner (a paid plan / admin action).
   The MCP cannot buy or create them.
2. **Wrong database.** FeatherPanel's database tooling is MySQL/MariaDB only. AL AI is
   PostgreSQL-only: both apps depend on `pg`, and the schema uses `JSONB`, `ON CONFLICT`,
   `$n` placeholders and `pgsql-ast-parser`. Moving means rewriting the data layer.
3. **Three processes, one container.** A panel server is one Docker container with one
   startup command and one primary port: dashboard (`3000`), bot adapter (`3400`) and
   PostgreSQL (`55432`) would have to be collapsed into one process tree, or paired with an
   external managed Postgres — which the panel does not sell.
4. **Public URL.** The panel exposes one allocation per server. Today the dashboard reaches
   the internet through the ngrok tunnel with a fixed domain; that would be replaced by the
   allocation + reverse proxy, and OAuth redirect URLs would have to be re-registered.

A realistic shape is the opposite direction: keep AL AI where it runs now, and use this MCP
to manage **one hosted bot server** later — upload the built bot with `write_file` /
`pull_file`, set the startup command with `update_server`, watch it with `get_server_logs`
and `send_console_command`, restart it with `server_power_action`, snapshot it with
`create_backup`. The dashboard and Postgres stay on the current machine.

If a server is ever granted or bought on this panel, the closest workable layout is:

- one container running dashboard + bot under one startup command (`node` supervisor
  script), both on loopback inside the container, dashboard listening on the allocation port;
- Postgres **outside** the panel (Neon / Supabase / any managed PG) because the panel only
  provisions MySQL;
- public URL from the panel's own `create_subdomain` + `create_proxy` tools pointed at that
  port, replacing the ngrok tunnel and updating the Discord OAuth redirect;
- night budget: 2 GB RAM / 1 vCPU, ~2 GB disk.

Evidence that provisioning is closed to this account: `POST /api/user/servers/create` → `405`,
`/api/user/store*`, `/api/user/billing`, `/api/user/credits` → `404`, `settings` exposes no
store/billing flags, and the MCP build contains no create/delete/suspend-server tool.

## Environment and resource reality

Measured on this machine while the stack is running:

| Process group | Resident memory |
| --- | --- |
| Node (dashboard + bot + tooling) | ~287 MB across 5 processes |
| PostgreSQL | ~65 MB across 16 processes |
| ngrok tunnel | ~20–30 MB |

CPU is idle-dominated (a few percent); the load spikes come from Discord event bursts, not
from serving pages. Disk: ~1.5–2 GB for `node_modules` + build output, plus the database
cluster.

If the whole stack were ever containerised on a panel node, budget **2 GB RAM and 1 vCPU**
minimum (1 GB only if Postgres were external), with the caveats above unchanged.

## Rotating the API key

The credentials live in panel *API clients*, not in a route called "api-keys":

| Action | Route |
| --- | --- |
| list / create | `GET` / `POST /api/user/api-clients` |
| rename, restrict IPs | `PUT /api/user/api-clients/{id}` |
| **rotate the secret** | `POST /api/user/api-clients/{id}/regenerate` |
| revoke | `DELETE /api/user/api-clients/{id}` |

Current state: one client, id **82** ("SDFSFSFS"), created 2026-11-13.

1. Panel → **Account → API Keys** (`/account/api-keys`) → create a new key (or regenerate
   client 82), copy the private key once — it is never shown again.
2. Edit `%USERPROFILE%\.al-ai\featherpanel-mcp\.env` → replace `FEATHERPANEL_API_KEY`.
3. Restart the MCP client (open a new session) so the process re-reads `.env`.
4. Verify with `whoami` — it must still resolve user 397.
5. Revoke the old key in `/account/api-keys`. Nothing else in the repo refers to it.

The same rotation can be driven from this session against the REST API (`regenerate`
returns the new private key once), which keeps the two steps — new secret and updated
`.env` — inside one action.

Never paste a key into chat or a commit. Keys pasted into a conversation should be treated
as burned and rotated.

## Troubleshooting

- **`tools/list` empty / connection refused** → run
  `node %USERPROFILE%\.al-ai\featherpanel-mcp\dist\stdio.js` manually; a stack trace here
  means the build or `.env` is broken, not the panel.
- **401 / unauthorized** → key revoked or mistyped; re-check step 2 above.
- **`API_ROUTE_NOT_FOUND`** → the panel version does not expose that route; the tool list
  already omits what the panel disables, so this usually means a panel upgrade changed paths.
- **Remote connector** → only works if the panel operator deploys the `mcp` service next to
  the panel; this deployment does not.
