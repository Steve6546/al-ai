/**
 * Every screen the shell can render.
 *
 * Read-only screens live here; the screens that write configuration live in
 * `./settings` so "what changes state" is obvious from the folder.
 */
export { AuditView } from "./audit";
export { DashboardView } from "./dashboard";
export { SecurityView } from "./security";

export { CommandsView } from "./settings/commands";
export { CustomizationView } from "./settings/customization";
export { LogsView } from "./settings/logs";
export { NetworkView } from "./settings/network";
export { RolesView } from "./settings/roles";
export { WelcomeView } from "./settings/welcome";
