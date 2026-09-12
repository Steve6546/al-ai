/**
 * Small presentation helpers shared by the views.
 *
 * Nothing here talks to the network or to Discord: these are pure functions so
 * they can be used in any component without side effects.
 */

/** Two-letter fallback shown when an avatar image is missing or still loading. */
export function initials(name?: string | null): string {
  if (!name) return "—";
  return name.trim().slice(0, 2).toUpperCase();
}

/** Arabic-locale date/time, or a dash when the value is missing or unparseable. */
export function formatDateTime(value?: string | null): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString("ar", { dateStyle: "short", timeStyle: "short" });
}

/** Trims a long identifier for display while keeping both ends recognisable. */
export function shortId(id: string, keep = 6): string {
  if (id.length <= keep * 2 + 1) return id;
  return `${id.slice(0, keep)}…${id.slice(-keep)}`;
}
