import { useEffect, useState } from "react";

/**
 * The smallest router that does the job.
 *
 * Two routes exist, and both are addresses an operator can bookmark or paste:
 *
 *   /                          the guild selector
 *   /dashboard/:guildId[/view] the shell, optionally on a named screen
 *
 * A routing library would add a dependency and a second source of truth for
 * "where am I" on top of the History API, which already answers that question.
 * The parse and build halves are pure so they can be tested without a DOM.
 */

export type Route =
  | { kind: "guilds" }
  | { kind: "guild"; guildId: string; view: string | null }
  /** Anything unrecognised, including the bare `/` of a mistyped link. */
  | { kind: "unknown"; path: string };

const GUILD_SEGMENT = /^\d{17,20}$/;

/** Turns a pathname into a route. Never throws: bad input is a route, not a crash. */
export function parsePath(pathname: string): Route {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return { kind: "guilds" };
  if (segments[0] !== "dashboard") return { kind: "unknown", path: pathname };

  const guildId = segments[1];
  // A snowflake check rather than a truthiness check: `/dashboard/abc` is a
  // broken link, and treating it as a guild id would send a nonsense id to the
  // API and produce a confusing 404 from Discord.
  if (!guildId || !GUILD_SEGMENT.test(guildId)) return { kind: "unknown", path: pathname };

  return { kind: "guild", guildId, view: segments[2] ?? null };
}

/** The address of the selector. */
export const guildsPath = () => "/";

/** The address of a guild's shell, optionally on a specific screen. */
export function guildPath(guildId: string, view?: string | null): string {
  return view ? `/dashboard/${guildId}/${view}` : `/dashboard/${guildId}`;
}

/**
 * Listeners for `navigate`.
 *
 * `pushState` does not fire `popstate` — that event belongs to back and forward
 * only — so a programmatic navigation has to announce itself. Without this the
 * address bar would change while the screen kept showing the old route.
 */
const listeners = new Set<() => void>();

function announce() {
  for (const listener of listeners) listener();
}

/** Navigates without a reload. A no-op when already there, so it cannot loop. */
export function navigate(to: string, options: { replace?: boolean } = {}) {
  const current = `${window.location.pathname}${window.location.search}`;
  if (current === to) return;
  if (options.replace) window.history.replaceState({}, "", to);
  else window.history.pushState({}, "", to);
  announce();
}

/** The current route, kept in sync with back, forward and `navigate`. */
export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname));

  useEffect(() => {
    const sync = () => setRoute(parsePath(window.location.pathname));
    // `popstate` covers the browser's own navigation; `listeners` covers ours.
    listeners.add(sync);
    window.addEventListener("popstate", sync);
    return () => {
      listeners.delete(sync);
      window.removeEventListener("popstate", sync);
    };
  }, []);

  return route;
}
