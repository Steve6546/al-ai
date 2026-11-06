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

/** Locale date/time (Arabic by default), or a dash when the value is unparseable. */
export function formatDateTime(value?: string | null, language: "ar" | "en" = "ar"): string {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleString(language === "en" ? "en" : "ar", { dateStyle: "short", timeStyle: "short" });
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
export function formatMemberCount(count: number | null | undefined, language: "ar" | "en" = "ar"): string {
  if (count === null || count === undefined) return language === "en" ? "Unknown" : "غير محدد";
  if (!Number.isFinite(count) || count < 0) return language === "en" ? "Unknown" : "غير محدد";
  const value = Math.trunc(count);
  if (language === "en") {
    if (value === 1) return "1 member";
    return `${value.toLocaleString("en")} members`;
  }
  if (value === 0) return "لا أعضاء";
  if (value === 1) return "عضو واحد";
  if (value === 2) return "عضوان";
  if (value <= 10) return `${value} أعضاء`;
  if (value <= 99) return `${value} عضواً`;
  return `${value} عضو`;
}
