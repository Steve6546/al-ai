/**
 * The appearance, applied before the first paint.
 *
 * This file is the reason the page never flashes the wrong palette: it runs
 * while the document is still parsing, before the stylesheet is applied, and
 * puts the account's theme on `<html>`.
 *
 * It is a *file* and not an inline script on purpose. The dashboard's own
 * Content-Security-Policy is `script-src 'self'`, which blocks an inline script
 * outright — the page would have loaded with the wrong palette and the
 * preference would have been applied a moment later, as a flash. A file on the
 * same origin is allowed, and it is cached like any other asset.
 *
 * The important property of this file is what it does *not* do: it contains no
 * colour maths. The theme engine lives in `@al-ai/core` and needs a module
 * loader; deriving OKLCH ladders here would mean duplicating that engine in
 * plain ES5 and keeping two implementations of the same contrast rule in
 * agreement forever. Instead `src/lib/theme.ts` stores the tokens it derived
 * next to the preference, and this script only puts them back:
 *
 *   al-ai.appearance         the choice (mode, stops, angle, intensity, scope)
 *   al-ai.appearance.tokens  { version, for, tokens } — the derived CSS values
 *
 * `for` is a fingerprint of the choice the tokens were built from. When it does
 * not match the stored choice (an older build, a theme edited on another
 * device, a half-written storage), the cache is ignored and the stylesheet's own
 * defaults paint instead — a correct, unthemed page rather than a mismatched
 * one. React applies the real palette a moment later and rewrites both keys.
 */
(function () {
  var root = document.documentElement;

  /**
   * The languages the product actually ships. `de` is missing from the older
   * version of this file, which meant a German reader got Arabic layout
   * direction on first paint — the state that is worst to get wrong, because
   * `dir` moves every start edge on the page.
   */
  try {
    var language = window.localStorage.getItem("al-ai.language");
    if (language !== "ar" && language !== "en" && language !== "de") language = "ar";
    root.lang = language;
    root.dir = language === "ar" ? "rtl" : "ltr";
    root.dataset.language = language;
  } catch (error) {
    root.lang = "ar";
    root.dir = "rtl";
  }

  var prefs = null;
  try {
    var stored = window.localStorage.getItem("al-ai.appearance");
    prefs = stored ? JSON.parse(stored) : null;
  } catch (error) {
    prefs = null;
  }

  // The mode is the one thing this file must decide itself: it comes from the
  // operating system when the choice is `system`, and the class it sets gates
  // every `dark:` utility in the stylesheet.
  var mode = prefs && (prefs.mode === "light" || prefs.mode === "dark") ? prefs.mode : "system";
  var systemDark =
    typeof window.matchMedia === "function" && window.matchMedia("(prefers-color-scheme: dark)").matches;
  var dark = mode === "dark" || (mode === "system" && systemDark);
  root.classList.toggle("dark", dark);
  root.classList.toggle("light", !dark);
  root.dataset.theme = dark ? "dark" : "light";
  root.dataset.appearance = mode;
  // The old file set `data-accent` for a named accent that no longer exists in
  // the v2 shape; the accent is now a colour, so `data-theme-scope` (which the
  // stylesheet does read) is the only data attribute the tokens need.
  if (prefs && (prefs.scope === "canvas" || prefs.scope === "tinted")) root.dataset.themeScope = prefs.scope;

  /**
   * The cached tokens, when they were built for exactly this choice.
   *
   * The comparison is a string join of the same fields `theme.ts` fingerprints —
   * mode, angle, intensity, scope, accent, stops — because anything looser would
   * paint a gradient at the right colours and the wrong angle.
   */
  function fingerprint(value) {
    var stops = Array.isArray(value.colors) ? value.colors.join(",") : "";
    return [value.mode, value.angle, value.intensity, value.scope, value.accent || "-", stops].join("|");
  }

  try {
    if (!prefs) throw new Error("no preference");
    var rawCache = window.localStorage.getItem("al-ai.appearance.tokens");
    if (!rawCache) throw new Error("no cache");
    var cache = JSON.parse(rawCache);
    // Version 2 is the OKLCH token set. A cache written by the old build has a
    // different version and a different shape, and is discarded rather than
    // partially applied — the two paint different sets of properties.
    if (cache.version !== 2 || cache.for !== fingerprint(prefs) || !cache.tokens) throw new Error("stale cache");
    // The palette the engine resolved for `system` depends on the OS at load
    // time, so a cache built for the other side of that decision is stale even
    // when the choice is identical.
    if (prefs.mode === "system" && cache.dark !== dark) throw new Error("wrong side of system");
    var tokens = cache.tokens;
    for (var name in tokens) {
      if (!Object.prototype.hasOwnProperty.call(tokens, name)) continue;
      if (name.indexOf("--") !== 0) continue;
      var value = tokens[name];
      if (value === "") root.style.removeProperty(name);
      else root.style.setProperty(name, value);
    }
  } catch (error) {
    // No usable cache: the stylesheet's defaults are the correct unthemed page,
    // and `src/lib/theme.ts` paints the real palette as soon as React mounts.
  }
})();
