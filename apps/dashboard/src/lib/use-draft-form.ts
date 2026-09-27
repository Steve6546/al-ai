import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { wireEqual } from "@/lib/records";

/**
 * The dashboard's one unsaved-changes pattern, in one place.
 *
 * Every settings screen is shaped the same way: the server owns a *saved* value,
 * the operator edits a *draft* of it, and the floating "حفظ التغييرات" bar
 * appears for exactly as long as the two genuinely differ. Reverting a control
 * by hand has to clear the bar at once — the operator can see the switch is back
 * where it started, and a bar that disagrees with what is on screen is a bar
 * that gets ignored.
 *
 * That rules out storing a boolean alongside the draft. `dirty` is *derived*
 * from the two values on every render, so it can never be left behind by an
 * edit that forgot to set it. The bar appears and disappears by the same rule
 * everywhere: `!equals(saved, draft)`.
 *
 * The comparison defaults to {@link wireEqual}, which is what most screens want
 * because both values share one origin and therefore one key order. A screen
 * whose draft can legitimately reorder its keys passes its own `equals`.
 */
export interface DraftForm<T> {
  /** What the server last confirmed. The bar's point of reference. */
  saved: T;
  /** What the operator is looking at. */
  draft: T;
  /** Whether the draft has moved away from the saved value. */
  dirty: boolean;
  /** Direct draft mutation, for edits a shallow merge cannot express. */
  setDraft: Dispatch<SetStateAction<T>>;
  /** Merges one field into an object draft: `patch({ enabled: true })`. */
  patch: (next: Partial<NonNullable<T>>) => void;
  /** Puts the draft back to the saved value. The bar's "إعادة ضبط". */
  reset: () => void;
  /** Rebases both values on what a save returned. The bar disappears. */
  commit: (next: T) => void;
}

/**
 * Tracks a draft against a saved value.
 *
 * @param source - The value the screen considers saved. **Referentially
 *   stable**, please: it must come from a `useState` the fetch writes once, not
 *   an object built inline. The hook rebases the whole form when this reference
 *   changes, so an unstable source would discard every edit on the next render.
 *   A screen with a loading state passes `T | null` here and the form stays
 *   inert (never dirty) until the data lands.
 * @param equals - How to decide the draft matches the saved value. Defaults to
 *   {@link wireEqual}.
 */
export function useDraftForm<T>(
  source: T,
  equals: (left: NonNullable<T>, right: NonNullable<T>) => boolean = wireEqual
): DraftForm<T> {
  const [saved, setSaved] = useState<T>(source);
  const [draft, setDraft] = useState<T>(source);
  const loaded = useRef(source);

  // A new source means a new guild, a refetch, or the load finishing. React's
  // documented way to adjust state when a prop changes is to do it during the
  // render rather than in an effect, so the draft is never painted against a
  // source it does not belong to. React discards this render's output and
  // retries immediately; the guard is what keeps that from looping.
  // https://react.dev/learn/you-might-not-need-an-effect
  if (loaded.current !== source) {
    loaded.current = source;
    setSaved(source);
    setDraft(source);
  }

  // `saved` is read here, not closed over from the render the callback was made
  // in, so a commit in the same tick and the reset that follows it agree about
  // what "the saved value" is. A null source is the loading state, and a
  // loading form is never dirty.
  const reset = useCallback(() => setDraft(saved), [saved]);
  const commit = useCallback(
    (next: T) => {
      setSaved(next);
      setDraft(next);
    },
    []
  );
  const patch = useCallback(
    (next: Partial<NonNullable<T>>) => setDraft(current => (current ? { ...current, ...next } : current)),
    []
  );

  const dirty = saved !== null && draft !== null && !equals(saved as NonNullable<T>, draft as NonNullable<T>);

  return { saved, draft, dirty, setDraft, patch, reset, commit };
}
