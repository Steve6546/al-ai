# AL AI Governance Contract

These rules are enforced in code, reviewed in pull requests, and covered by tests.  
Breaking one is a defect, not a style preference.

They bind every contributor, human or automated. An agent that adds a feature is
subject to the same reading of the official documentation, the same enum
requirement and the same caching obligation as a person is; "the model did it"
is not a category of exemption. If a rule cannot be satisfied, say so in the pull
request rather than working around it quietly.

Code that implements a rule carries a `GOVERNANCE rule N` comment. The  
`governance.test.ts` suite fails if a comment cites a rule that does not exist  
here, so this file and the source cannot drift apart. It also fails if the count
below stops matching, which is why adding a rule means editing this file and that
test together.

1. **Slash commands only.** Prefix commands are forbidden. Every command is  
   registered in packages/core/src/command-registry.ts; an unregistered  
   command name is rejected before any Discord call is made.
2. **One Discord access point per runtime.**
   - The bot's Discord calls live only in apps/bot/src/lib/discord.ts, the only  
     module allowed to import discord.js. Handlers receive normalised plain  
     objects, never Discord classes.
   - The dashboard's OAuth exchange and read-only guild lookups live only in  
     apps/dashboard/server/discord.ts. It never mutates a guild.
3. **permission-guard.ts is the sole permission decision point.** The two  
   configurable tiers bind to **Role IDs**, never to User IDs, and no role ID is  
   ever hard-coded. The owner tier is not configurable at all: it is derived  
   from Discord's own guild ownership and the Administrator permission bit, so a  
   guild that has configured nothing still has a working owner. Every operation  
   is re-checked on the server.
4. **Exactly seven log destinations.** Channel IDs appear only in  
   config/channels.json, the channel registry, and guild_log_channels —  
   never scattered through the code. The channel registry is the only module that  
   turns a destination into a channel ID, and it reads guild_logging. The  
   guild_log_channels table is a write-only mirror that the dashboard maintains  
   so the database itself enforces one channel per destination; it is never a  
   read source.
5. **logEvent() is the only log router.** Event IDs are registered in  
   event-schema.ts, are unique, and use the domain.action form.
6. **Zero duplication across the seven rooms.** Each event is written once, to  
   one destination. The Category value is a field inside the embed; it is  
   never a reason to copy the same event into a second room. "Executed by" is  
   likewise a field, not a second entry.
7. **The audit trail is append-only, and the database enforces it.** Triggers  
   reject UPDATE, DELETE and TRUNCATE; an attempted mutation is itself a  
   security.audit-tamper event. Security failures return a generic message to  
   the user and log the detail internally only.
8. **Never request GUILD_PRESENCES.** Member presence is out of scope, so  
   online/idle state is never recorded.
9. **Slash commands are never re-published at runtime.** Deployment happens only  
   through npm run deploy-commands --workspace=@al-ai/bot, a separate process.  
   Importing the deploy helper into the bot runtime is forbidden.
10. **Zero trust between layers.** Every inter-layer call is HMAC-signed with a  
    single-use nonce that expires after five minutes. A layer is never trusted  
    because of where it runs.
11. **An event is never silently dropped or truncated.** Discord allows 25 embed  
    fields and 10 embeds per message; an oversized event is split across several  
    embeds that share one correlationId. A throttled job is rescheduled, not  
    discarded.
12. **Intrusion detection is independent of the feature path.** Invalid role  
    attempts (including failed ones), invalid HMACs, abnormal request patterns  
    and revoked credentials produce security.* events. Every security.* event  
    is critical and goes to bot-log **and** the audit trail.
13. **A silent security component is itself a security event.** The watchdog  
    requires the intrusion detector and the audit trail to check in; a component  
    that goes quiet raises security.watchdog-down.
14. **The privileged-intent budget is monitored, not assumed.** The limit is  
    10,000 unique users across all guilds (not servers), warning at 8,000, with  
    yearly renewal of verification.
15. **Operational state lives in config/, never in code and never guessed.**  
    A value the owner has not decided stays null with an explicit  
    // TODO: يحتاج قرار صريح من المالك and blocks a production deploy.
16. **The integration adapter is a local control surface, not a public API.** It  
    binds to 127.0.0.1 only, refuses non-loopback peers, requires a signed  
    single-use nonce, and accepts only an allowlist of config keys.
17. **The message log must be able to answer "what was said".** Discord sends  
    message content only on creation, so a bounded, in-memory, non-persistent  
    cache backs message.delete and message.edit.
18. **A setting the dashboard can save must be one the bot actually applies.**  
    Every per-guild field has exactly four links — the form, the save route, the  
    reader in apps/bot/src, and the Discord call — and a break in the last link  
    is a defect, not a missing feature. Two consequences:
    - No field is offered for something Discord cannot express per guild. A  
      per-server avatar and banner are impossible (an application has one global  
      image), so those controls were removed rather than left to save with no  
      effect.
    - Both sides normalise with the same helper from @al-ai/core. The dashboard  
      validates on write and the bot normalises on read using the *same*  
      function, so a stored value cannot mean two different things. A shape  
      declared twice is a shape that will drift.
19. **No credential ever enters through the dashboard.** AL AI runs on exactly  
    one master bot token, held in the server environment (BOT_TOKEN). No  
    endpoint may accept, store, or return a bot token, and no screen may ask for  
    one. The bot_tokens and bot_token_guilds tables were dropped rather than  
    left dormant, because an unused credential store is a liability rather than  
    a spare part. A browser session authorises an operator; it never carries a  
    credential that can act as the bot.
20. **Every guild-scoped route re-checks guild access on the server.** A guild ID  
    is not a secret — it appears in every invite link — so `requireSession`  
    alone would let any signed-in account read any guild by pasting its ID.  
    Reads go through `requireGuildAccess`, writes through  
    `requireTierForGuild`. The check is a *call that must be present*, which is  
    why `route-guards.test.ts` asserts the route table textually: the failure  
    mode is a missing guard, not a wrong result.
21. **Session lifetime is bounded and absolute.** A session cookie is httpOnly,  
    SameSite, and rejected past `SESSION_MAX_AGE_SECONDS` regardless of activity  
    — there is no sliding renewal, so a stolen cookie has a fixed window. The  
    dashboard signs a session with `SESSION_SECRET`; rotating that secret  
    invalidates every outstanding session, which is the intended emergency lever.  
    A cookie that fails verification yields `401 UNAUTHENTICATED` — it never buys  
    a free pass through the throttle hook.
22. **A failed Discord read never becomes a confident claim.** Three states must  
    stay distinct: *true*, *false*, and *unknown*. `PermissionStatus.granted` is  
    `boolean | null`, where `null` means the read failed. Collapsing `null` into  
    `false` refuses an operation the bot can actually perform, and — the worse  
    direction — a naive bitwise test reports a missing permission for a bot that  
    holds Administrator, because `0x8` supersedes the other bits rather than  
    expanding into them. Check `0x8` first (`hasPermission`).
23. **Storage never contains a secret.** `.env` is never tracked and its values  
    must not reach a committed file. Images are the one large payload the  
    dashboard accepts, and they are bounded by  
    `MAX_IMAGE_DATA_URL_LENGTH = 500_000`; an oversized upload is refused rather  
    than stored. A value that is read back is normalised again on the way out, so  
    a hand-edited row cannot inject a shape the writer would have rejected.  
    `.workbuddy-ai/backups/` (live `pg_dump` output) and `.workbuddy-ai/preview/`  
    (generated bundles) are git-ignored for this reason.
24. **Every new feature is built from the official documentation, not from  
    memory.** Before writing a line that talks to Discord, read the relevant page  
    of <https://github.com/discord/discord-api-docs> and the matching source in  
    <https://github.com/discordjs/discord.js>. Where the library already exposes  
    the operation, call it — a hand-rolled request, a raw endpoint string or a  
    re-implemented helper is a defect even when it works, because it will not
    track Discord's changes. A workaround is allowed only when the official path
    genuinely does not cover the case, and then the comment must say which
    documented behaviour made it necessary. The standing example is rule 2's
    split: the bot uses `Routes` and the builders, and the BFF uses the REST API
    directly only because a gateway connection is not what it needs.
25. **Discord's own constants come from Discord's own enums.** Permissions come  
    from `PermissionFlagsBits`, activity kinds from `ActivityType`, channel kinds  
    from `ChannelType`, intents from `GatewayIntentBits`, and endpoints from  
    `Routes`. A raw `0x…` literal, a bare `1 << n`, a numeric channel type or a  
    hand-written `/guilds/{id}/…` string is a defect. The one exception is a value  
    a runtime genuinely cannot import — the BFF must not pull in discord.js — and  
    such a value is restated in exactly one place,  
    `packages/core/src/discord-permissions.ts`, and held against the official enum  
    by `apps/bot/test/discord-standards.test.ts`. A restated constant without that  
    test is worse than no constant at all, because it looks authoritative.
26. **A snowflake is a string, from end to end.** Discord IDs exceed  
    `Number.MAX_SAFE_INTEGER`, so a number is a lossy container: `Number(id)`  
    silently returns a different guild. IDs are typed `string` in every contract,  
    read as `string` from the database, and never compared with `==` against a  
    number. A numeric conversion is permitted only where the result is provably  
    bounded — the shard-like `Number((BigInt(id) >> 22n) % 6n)` — and the  
    BigInt arithmetic must come first, so the precision loss happens after the  
    value is already small.
27. **Never spend a Discord request on data this process already holds.** The  
    live bot's gateway cache is authoritative for everything the bot can see: a  
    dashboard route that re-fetches a guild, its channels, its roles or its  
    members from REST instead of asking the running bot is a defect, not a slow  
    path. Where a REST read is genuinely required, the BFF memoises it through  
    `server/cache.ts` — a TTL, plus in-flight coalescing so three concurrent  
    callers produce one request rather than three. The TTL is the bound on  
    staleness, so any write that changes the cached value invalidates it in the  
    same request. Discord rate-limits per *application*, not per route, so a  
    cache is not an optimisation here; it is what keeps the bot's own calls  
    working.
