import "dotenv/config";
import { buildAllCommands, compareCommandRegistry, deploySlashCommands } from "../src/lib/discord.js";

/**
 * GOVERNANCE rule 9: command deployment is a separate process, never the runtime.
 *
 * Global command propagation can take up to one hour, so this is deliberately
 * not part of startup. Run it only when the registry changes:
 *   npm run deploy-commands --workspace=@al-ai/bot
 */

const token = process.env.BOT_TOKEN;
const clientId = process.env.DISCORD_CLIENT_ID;
if (!token || !clientId) throw new Error("BOT_TOKEN and DISCORD_CLIENT_ID are required.");

const published = buildAllCommands();

// The registry is the authority: publishing something absent from it, or
// forgetting something present in it, is a defect rather than a preference.
const { missing, extra } = compareCommandRegistry(published);
if (missing.length || extra.length) {
  throw new Error(
    `Command registry and published commands disagree. Not published: ${missing.join(", ") || "—"}. Not registered: ${extra.join(", ") || "—"}.`
  );
}

await deploySlashCommands(token, clientId);
console.log(`Deployed ${published.length} commands: ${published.map(command => (command as { name: string }).name).join(", ")}`);
console.log("Global propagation can take up to one hour.");
