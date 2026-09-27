/**
 * Small record helpers shared by the settings screens.
 *
 * Both the logging screen's event flags and its channel map, and the security
 * screen's limits, work the same way: the draft is a shallow copy of what the
 * server sent, the operator edits one key at a time, and the save bar appears
 * only when the two genuinely differ. Those three rules were copy-pasted into
 * every screen, which is how one of them would eventually drift — so they live
 * here once.
 */

/**
 * Sets one key, or deletes it when the value is `null`.
 *
 * An unset option is an *absent key*, never `undefined`: `undefined` serialises
 * out of the JSON body, which the server would read as "leave whatever is
 * there" rather than "clear this". The distinction is what makes a toggle that
 * the operator switched off actually switch something off.
 */
export function setOrDeleteKey<V>(
  source: Record<string, V>,
  key: string,
  value: V | null
): Record<string, V> {
  const next = { ...source };
  if (value === null) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}

/**
 * The save bar's one question: does the draft differ from what is saved?
 *
 * The comparison is on the JSON form because that is the form the wire will
 * carry, so a `null` and an absent key differ here exactly when they differ to
 * the server — and a draft that only *looks* different does not light the bar.
 *
 * `JSON.stringify` is key-order-sensitive, which is safe here and not in
 * general: every draft in the dashboard is built by spreading the value the
 * server returned, so key order is inherited and stays stable across edits.
 * Comparing two objects that arrived from different code paths would need a
 * key-normalising comparison instead.
 */
export function wireEqual<T>(left: T, right: T): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
