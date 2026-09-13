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

/**
 * Member count in Arabic, with the noun agreeing with the number.
 *
 * Arabic counts in three bands — a dual, a small plural, and a singular counted
 * form — so `42 عضو` is wrong in the same way `1 members` is in English. This is
 * display-only copy, which is why it lives here and not in the contract.
 *
 * `null` means the count is not knowable (the bot is not in the guild), which is
 * a different statement from "nobody is in it" and must not be rendered as 0.
 */
export function formatMemberCount(count: number | null | undefined): string {
  if (count === null || count === undefined) return "غير محدد";
  if (!Number.isFinite(count) || count < 0) return "غير محدد";
  const value = Math.trunc(count);
  if (value === 0) return "لا أعضاء";
  if (value === 1) return "عضو واحد";
  if (value === 2) return "عضوان";
  if (value <= 10) return `${value} أعضاء`;
  if (value <= 99) return `${value} عضواً`;
  return `${value} عضو`;
}
