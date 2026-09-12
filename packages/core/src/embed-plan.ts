/**
 * GOVERNANCE rule 11 — an event is never silently dropped or truncated.
 *
 * Discord hard-limits an embed to 25 fields and a message to 10 embeds, and a
 * single field value to 1024 characters. When an event carries more data than
 * one embed can hold, the excess is split across additional embeds that share
 * the same `correlationId`, so the whole record stays reconstructable.
 */

export const EMBED_MAX_FIELDS = 25;
export const EMBED_MAX_VALUE = 1024;
export const EMBED_MAX_NAME = 256;
export const EMBEDS_PER_MESSAGE = 10;

/** Safety valve: 5 messages worth of fields. Beyond this the event is flagged, not silently cut. */
export const MAX_TOTAL_FIELDS = EMBED_MAX_FIELDS * EMBEDS_PER_MESSAGE * 5;

export type EmbedField = { name: string; value: string };

export type EmbedPlan = {
  /** Ready-to-send field groups; each group becomes exactly one embed. */
  pages: EmbedField[][];
  /** True when the event exceeded MAX_TOTAL_FIELDS and could not be fully represented. */
  overflowed: boolean;
  /** Total fields produced, including continuation chunks. */
  totalFields: number;
};

/**
 * Renders a single data value as text without losing structure.
 * Objects and arrays are serialised rather than discarded.
 */
export function renderValue(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function clampName(name: string): string {
  return name.length <= EMBED_MAX_NAME ? name : `${name.slice(0, EMBED_MAX_NAME - 1)}…`;
}

/**
 * Splits one logical field into as many `{ name, value }` chunks as needed so
 * that no value exceeds Discord's 1024-character ceiling. Continuations are
 * labelled `name (2/3)` so the reader can see the value was not cut.
 */
export function chunkField(name: string, raw: string): EmbedField[] {
  const value = raw.length ? raw : "—";
  if (value.length <= EMBED_MAX_VALUE) return [{ name: clampName(name), value }];

  const parts: string[] = [];
  for (let index = 0; index < value.length; index += EMBED_MAX_VALUE) {
    parts.push(value.slice(index, index + EMBED_MAX_VALUE));
  }
  return parts.map((part, index) => ({
    name: clampName(`${name} (${index + 1}/${parts.length})`),
    value: part
  }));
}

/**
 * Turns an arbitrary event payload into a page-per-embed plan.
 * Field order is preserved; nothing is dropped while under the safety valve.
 */
export function planEmbedFields(data: Record<string, unknown>, title = "الحدث"): EmbedPlan {
  const fields: EmbedField[] = [];

  for (const [key, value] of Object.entries(data)) {
    if (value === undefined || value === null) continue;
    fields.push(...chunkField(key, renderValue(value)));
  }

  if (!fields.length) fields.push({ name: title, value: "—" });

  const overflowed = fields.length > MAX_TOTAL_FIELDS;
  const kept = overflowed ? fields.slice(0, MAX_TOTAL_FIELDS) : fields;

  const pages: EmbedField[][] = [];
  for (let index = 0; index < kept.length; index += EMBED_MAX_FIELDS) {
    pages.push(kept.slice(index, index + EMBED_MAX_FIELDS));
  }

  return { pages, overflowed, totalFields: fields.length };
}

/** Groups embed pages into Discord messages (max 10 embeds each). */
export function groupPagesIntoMessages<T>(pages: T[]): T[][] {
  const messages: T[][] = [];
  for (let index = 0; index < pages.length; index += EMBEDS_PER_MESSAGE) {
    messages.push(pages.slice(index, index + EMBEDS_PER_MESSAGE));
  }
  return messages.length ? messages : [[]];
}
