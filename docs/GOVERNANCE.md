# AL AI Governance Contract

These rules are enforced in code, reviewed in pull requests, and covered by tests.
Breaking one is a defect, not a style preference.

Code that implements a rule carries a `GOVERNANCE rule N` comment. The
`governance.test.ts` suite fails if a comment cites a rule that does not exist
here, so this file and the source cannot drift apart.

1. **Slash commands only.** Prefix commands are forbidden. Every command is
   registered in `packages/core/src/command-registry.ts`; an unregistered
   command name is rejected before any Discord call is made.
2. **One Discord access point per runtime.**
   - The bot's Discord calls live only in `apps/bot/src/lib/discord.ts`, the only
     module allowed to import `discord.js`. Handlers receive normalised plain
     objects, never Discord classes.
   - The dashboard's OAuth exchange and read-only guild lookups live only in
     `apps/dashboard/server/discord.ts`. It never mutates a guild.
3. **`permission-guard.ts` is the sole permission decision point.** Tiers are
   bound to **configurable Role IDs**, never to User IDs, and are never
   hard-coded. Every operation is re-checked on the server.
4. **Exactly seven log destinations.** Channel IDs appear only in
   `config/channels.json`, the channel registry, and `guild_log_channels` —
   never scattered through the code. The channel registry is the only module that
   turns a destination into a channel ID, and it reads `guild_logging`. The
   `guild_log_channels` table is a write-only mirror that the dashboard maintains
   so the database itself enforces one channel per destination; it is never a
   read source.
5. **`logEvent()` is the only log router.** Event IDs are registered in
   `event-schema.ts`, are unique, and use the `domain.action` form.
6. **Zero duplication across the seven rooms.** Each event is written once, to
   one destination. The `Category` value is a field inside the embed; it is
   never a reason to copy the same event into a second room. "Executed by" is
   likewise a field, not a second entry.
7. **The audit trail is append-only, and the database enforces it.** Triggers
   reject `UPDATE`, `DELETE` and `TRUNCATE`; an attempted mutation is itself a
   `security.audit-tamper` event. Security failures return a generic message to
   the user and log the detail internally only.
8. **Never request `GUILD_PRESENCES`.** Member presence is out of scope, so
   online/idle state is never recorded.
9. **Slash commands are never re-published at runtime.** Deployment happens only
   through `npm run deploy-commands --workspace=@al-ai/bot`, a separate process.
   Importing the deploy helper into the bot runtime is forbidden.
10. **Zero trust between layers.** Every inter-layer call is HMAC-signed with a
    single-use nonce that expires after five minutes. A layer is never trusted
    because of where it runs.
11. **An event is never silently dropped or truncated.** Discord allows 25 embed
    fields and 10 embeds per message; an oversized event is split across several
    embeds that share one `correlationId`. A throttled job is rescheduled, not
    discarded.
12. **Intrusion detection is independent of the feature path.** Invalid role
    attempts (including failed ones), invalid HMACs, abnormal request patterns
    and revoked credentials produce `security.*` events. Every `security.*` event
    is `critical` and goes to bot-log **and** the audit trail.
13. **A silent security component is itself a security event.** The watchdog
    requires the intrusion detector and the audit trail to check in; a component
    that goes quiet raises `security.watchdog-down`.
14. **The privileged-intent budget is monitored, not assumed.** The limit is
    10,000 unique users across all guilds (not servers), warning at 8,000, with
    yearly renewal of verification.
15. **Operational state lives in `config/`, never in code and never guessed.**
    A value the owner has not decided stays `null` with an explicit
    `// TODO: يحتاج قرار صريح من المالك` and blocks a production deploy.
16. **The integration adapter is a local control surface, not a public API.** It
    binds to `127.0.0.1` only, refuses non-loopback peers, requires a signed
    single-use nonce, and accepts only an allowlist of config keys.
17. **The message log must be able to answer "what was said".** Discord sends
    message content only on creation, so a bounded, in-memory, non-persistent
    cache backs `message.delete` and `message.edit`.
18. **A setting the dashboard can save must be one the bot actually applies.**
    Every per-guild field has exactly four links — the form, the save route, the
    reader in `apps/bot/src`, and the Discord call — and a break in the last link
    is a defect, not a missing feature. Two consequences:
    - No field is offered for something Discord cannot express per guild. A
      per-server avatar and banner are impossible (an application has one global
      image), so those controls were removed rather than left to save with no
      effect.
    - Both sides normalise with the same helper from `@al-ai/core`. The dashboard
      validates on write and the bot normalises on read using the *same*
      function, so a stored value cannot mean two different things. A shape
      declared twice is a shape that will drift.
