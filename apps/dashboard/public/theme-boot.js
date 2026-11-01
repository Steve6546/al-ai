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
