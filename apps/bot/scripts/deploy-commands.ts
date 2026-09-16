import "dotenv/config";
import { buildAliasMap, commandFlagsFor } from "@al-ai/core";
import {
  buildAliasCommands,
  buildAllCommands,
  compareCommandRegistry,
  deploySlashCommands
} from "../src/lib/discord.js";
import { createBotDatabase } from "../src/storage/database.js";

/**
 * GOVERNANCE rule 9: command deployment is a separate process, never the runtime.
 *
 * Global command propagation can take up to one hour, so this is deliberately
 * not part of startup. Run it only when the registry changes:
 *   npm run deploy-commands --workspace=@al-ai/bot
 *
 * An alias is a per-guild preference, and Discord has no alias mechanism for it
 * to ride on: `/باند` exists only once a command *named* `باند` has been
 * registered. Registering that per guild makes it appear at once, instead of
 * within the hour a global registration takes — which is the difference between
 * a shortcut and a bug report:
 *   npm run deploy-commands --workspace=@al-ai/bot -- --guild 123456789012345678
 */

const SNOWFLAKE = /^\d{17,20}$/;

/** Reads `--guild <id>` and `--guild=<id>`, rejecting anything else outright. */
function guildArgs(args: readonly string[]): string[] {
  const found: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    let value: string | undefined;
    if (arg === "--guild") {
      value = args[index + 1];
      index += 1;
    } else if (arg.startsWith("--guild=")) {
      value = arg.slice("--guild=".length);
    } else {
      throw new Error(`Unknown argument: ${arg}. Only --guild <id> is accepted.`);
    }
    if (!value || !SNOWFLAKE.test(value)) {
      throw new Error(`--guild needs a Discord guild ID (17 to 20 digits), got: ${value ?? "nothing"}`);
    }
    found.push(value);
  }
  return [...new Set(found)];
}

const token = process.env.BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
if (!token || !clientId) throw new Error("BOT_TOKEN and DISCORD_CLIENT_ID are required.");

const published = buildAllCommands();

// The registry is the authority: publishing something absent from it, or
// forgetting something present in it, is a defect rather than a preference.
//
// Aliases are deliberately outside this comparison. They are per-guild
// preferences rather than registry entries, so counting them here would make
// every guild deploy report itself as having published something unregistered.
const { missing, extra } = compareCommandRegistry(published);
if (missing.length || extra.length) {
  throw new Error(
    `Command registry and published commands disagree. Not published: ${missing.join(", ") || "—"}. Not registered: ${extra.join(", ") || "—"}.`
  );
}

const nameOf = (command: unknown) => (command as { name: string }).name;
const guilds = guildArgs(process.argv.slice(2));

if (guilds.length === 0) {
  const result = await deploySlashCommands(token, clientId);
  console.log(`Deployed ${result.count} commands globally: ${published.map(nameOf).join(", ")}`);
  console.log("Global propagation can take up to one hour.");
} else {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required to read a guild's aliases.");
  const database = createBotDatabase(databaseUrl);
  try {
    for (const guildId of guilds) {
      const flags = commandFlagsFor(await database.loadCommandFlags(guildId));
      const { map, dropped } = buildAliasMap(flags);
      const aliases = buildAliasCommands(map);
      const result = await deploySlashCommands(token, clientId, { guildId, aliases });

      console.log(
        `Guild ${guildId}: deployed ${result.count} commands, of which ${aliases.length} ${aliases.length === 1 ? "is an alias" : "are aliases"}.`
      );
      for (const [alias, target] of map) console.log(`  /${alias} answers as /${target}`);
      for (const entry of dropped) {
        const why =
          entry.reason === "shadows-command"
            ? "it names a published command"
            : "another command claimed it first";
        console.log(`  dropped /${entry.alias} on /${entry.command}: ${why}`);
      }
      if (map.size === 0 && dropped.length === 0) console.log("  no aliases configured for this guild");
    }
  } finally {
    await database.close();
  }
}
