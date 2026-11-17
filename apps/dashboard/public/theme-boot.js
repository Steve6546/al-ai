/**
 * The appearance, applied before the first paint.
 *
 * This file is the reason the page never flashes the wrong palette: it runs
 * while the document is still parsing, before the stylesheet is applied, and
 * puts the stored preference on `<html>`.
 *
 * It is a *file* and not an inline script on purpose. The dashboard's own
 * Content-Security-Policy is `script-src 'self'`, which blocks an inline
 * script outright - the page would have loaded with the wrong palette and the
 * preference would have been applied a moment later, as a flash. A file on the
 * same origin is allowed, and it is cached like any other asset.
 *
 * The same preference is applied again by `src/main.tsx` when React starts,
 * so the two can never disagree: this one paints, that one keeps it in sync
 * with the live choice.
 */
(function () {
  // Language first: `dir` changes where the whole layout's start edge is, and
  // applying it after the palette would still be one frame of the wrong
  // direction. The key is the same one `src/lib/i18n.tsx` writes.
  try {
    var language = window.localStorage.getItem("al-ai.language");
    if (language !== "ar" && language !== "en") language = "ar";
    document.documentElement.lang = language;
    document.documentElement.dir = language === "ar" ? "rtl" : "ltr";
    document.documentElement.dataset.language = language;
  } catch (error) {
    document.documentElement.lang = "ar";
    document.documentElement.dir = "rtl";
  }

  try {
    var stored = window.localStorage.getItem("al-ai.appearance");
    var prefs = stored ? JSON.parse(stored) : {};
    var mode = prefs.mode === "light" || prefs.mode === "dark" ? prefs.mode : "system";
    var accent = ["blue", "violet", "emerald", "amber", "rose"].indexOf(prefs.accent) >= 0 ? prefs.accent : "blue";
    var dark =
      mode === "dark" ||
      (mode === "system" && window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches);
    var root = document.documentElement;
    root.classList.toggle("dark", dark);
    root.classList.toggle("light", !dark);
    root.dataset.theme = dark ? "dark" : "light";
    root.dataset.appearance = mode;
    root.dataset.accent = accent;

    // The custom accent and the backdrop paint here, with the same rules
    // `src/lib/theme.ts` applies after React starts: a custom colour replaces
    // the named one, its label colour is computed from its luminance, and a
    // split or gradient background goes on as an image. Without this the page
    // would paint the default palette for a frame and then swap - which is
    // exactly the flash this file exists to prevent.
    var SWATCHES = { blue: "#3b82f6", violet: "#8b5cf6", emerald: "#10b981", amber: "#f59e0b", rose: "#f43f5e" };
    var hex = /^#[0-9a-f]{6}$/i;
    function normalise(value) {
      if (typeof value !== "string") return null;
      var trimmed = value.trim();
      if (/^#[0-9a-f]{3}$/i.test(trimmed)) {
        return ("#" + trimmed[1] + trimmed[1] + trimmed[2] + trimmed[2] + trimmed[3] + trimmed[3]).toLowerCase();
      }
      return hex.test(trimmed) ? trimmed.toLowerCase() : null;
    }
    function luminance(value) {
      var clean = normalise(value);
      if (!clean) return 0;
      function channel(offset) {
        var srgb = parseInt(clean.slice(offset, offset + 2), 16) / 255;
        return srgb <= 0.03928 ? srgb / 12.92 : Math.pow((srgb + 0.055) / 1.055, 2.4);
      }
      return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5);
    }
    var accentColor = normalise(prefs.accentColor) || SWATCHES[accent] || SWATCHES.blue;
    root.style.setProperty("--primary", accentColor);
    root.style.setProperty("--primary-foreground", luminance(accentColor) > 0.179 ? "#0b0b0b" : "#ffffff");
    root.style.setProperty("--ring", accentColor);

    var background = prefs.background || {};
    var from = normalise(background.from);
    var to = normalise(background.to) || from;
    var style = background.style;
    if (from && style && style !== "solid") {
      var direction = style === "split-h" ? "to right" : "to bottom";
      var image =
        style === "gradient"
          ? "linear-gradient(" + direction + ", " + from + ", " + to + ")"
          : "linear-gradient(" + direction + ", " + from + " 0 50%, " + to + " 50% 100%)";
      root.style.setProperty("--app-bg-image", image);
      root.style.removeProperty("--app-bg-color");
    } else if (from) {
      root.style.setProperty("--app-bg-color", from);
      root.style.removeProperty("--app-bg-image");
    }
  } catch (error) {
    /* A blocked or corrupt store must not keep the app from painting. */
    document.documentElement.classList.add("light");
    document.documentElement.dataset.theme = "light";
  }
})();

/**
 * The white-screen guard.
 *
 * A missing or mis-served module leaves the static boot fallback in place: the
 * title is there, but the app is a white rectangle. This turns that failure
 * into a sentence, and names the one action that usually fixes it. It also
 * covers a module that downloads but never mounts (a blocked font cannot do
 * this any more, since the fonts are same-origin).
 */
(function () {
  function showBootProblem(message) {
    var fallback = document.getElementById("boot-fallback");
    if (!fallback) return;
    var title = fallback.querySelector("p");
    var detail = document.getElementById("boot-fallback-detail");
    if (title) title.textContent = "تعذّر تحميل لوحة التحكم";
    if (detail) detail.textContent = message;
  }

  window.addEventListener(
    "error",
    function (event) {
      var target = event.target;
      if (target && (target.tagName === "SCRIPT" || target.tagName === "LINK")) {
        showBootProblem("تعذّر تحميل أحد ملفات الواجهة. حدّث الصفحة، وإن استمر راجع سجل الخادم.");
      }
    },
    true
  );

  window.addEventListener("unhandledrejection", function () {
    showBootProblem("حدث خطأ أثناء تشغيل الواجهة. حدّث الصفحة.");
  });

  window.addEventListener("load", function () {
    window.setTimeout(function () {
      if (document.getElementById("boot-fallback")) {
        showBootProblem("تعذّر تشغيل الواجهة خلال الوقت المتوقع. حدّث الصفحة، وإن استمر راجع سجل الخادم.");
      }
    }, 12000);
  });
})();
