import { AsyncLocalStorage } from "node:async_hooks";
import { cookiePolicyFor, parseCookies, type CookieContext } from "./session.js";

/**
 * The request's session id, carried to the query layer.
 *
 * Row policies ask the database "who is asking" before they answer a guild
 * table. The answer has to come from something the request already holds and
 * the caller cannot choose — the session cookie — rather than from a `guild_id`
 * or `user_id` in the URL or body, which are the values an attacker controls.
 *
 * `AsyncLocalStorage` is used instead of a module-level variable because the
 * server handles requests concurrently: a variable would hand one request's
 * identity to another. The store is set by the route wrapper in `index.ts`, so
 * every handler runs under its own identity, and the pool wrapper in `db.ts`
 * reads it per statement.
 */
const store = new AsyncLocalStorage<string | null>();

/** Runs `fn`, and everything it awaits, under one session's identity. */
export function runAsSession<T>(sessionId: string | null, fn: () => T): T {
  return store.run(sessionId, fn);
}

/**
 * The identity of the statement currently executing, or null outside a request
 * (a boot-time read, a timer, the schema pass). Null is not "trusted": the
 * policies treat it as nobody.
 */
export function currentSessionId(): string | null {
  return store.getStore() ?? null;
}

/**
 * Extracts the session cookie without reading the database, so the identity is
 * available before the first query of the request — the session row itself is
 * behind a policy that needs to know which cookie is being resumed.
 *
 * The cookie name depends on the origin (a plain-HTTP LAN host cannot hold a
 * `__Host-` cookie), so the same policy function the rest of the server uses
 * decides it here.
 */
export function sessionIdFromRequest(context: CookieContext): string | null {
  const header = typeof context.headers.cookie === "string" ? context.headers.cookie : undefined;
  const cookies = parseCookies(header);
  return cookies[cookiePolicyFor(context).name] ?? null;
}
