/**
 * Browser-safe surface of @al-ai/core.
 *
 * The dashboard UI needs the shared rules (the seven destinations, the category
 * default, the command registry, the tier weights) but must never pull in the
 * server crypto. `security.ts` is the only module that imports `node:crypto`, so
 * it is deliberately excluded here.
 *
 * The server keeps importing `@al-ai/core`; the browser imports `@al-ai/core/browser`.
 */

export * from "./event-schema.js";
export * from "./permissions.js";
export * from "./command-registry.js";
export * from "./embed-plan.js";
export * from "./session-policy.js";
export * from "./contracts.js";
