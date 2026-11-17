/**
 * What a session's User-Agent actually is.
 *
 * The security screen drew one monitor icon for every session, so an Android
 * phone and a Windows desktop were indistinguishable — the list said "four
 * sessions" without saying *from where*, which is the only question that screen
 * exists to answer.
 *
 * The classification is a pure function over the header string, kept in `core`
 * so the dashboard can label it in three languages while the tests pin the
 * parsing without a browser: no regex here knows a translation.
 *
 * Order matters and is the whole difficulty:
 *
 * - **iPad before Mac.** Since iPadOS 13 Safari sends a desktop macOS UA; only
 *   the touch-point count distinguishes them, and that is not in the header. A
 *   `Macintosh` UA on a device that also says `Mobile` is an iPad.
 * - **Chrome before Safari.** Every Chromium browser contains `Safari/`, so a
 *   Safari test first would report Edge as Safari.
 * - **Edge and Opera before Chrome.** `Edg/` and `OPR/` both contain `Chrome/`.
 * - **Android before Linux.** Android UAs contain `Linux`.
 * - **Tablet before phone.** An Android tablet UA contains `Android` and often
 *   no `Mobile`, which is what separates it from a phone.
 */

/** The three shapes the session list draws differently. */
export type DeviceKind = "desktop" | "laptop" | "tablet" | "phone" | "unknown";

export type UserAgentDescription = {
  device: DeviceKind;
  /** A stable id the UI translates; never a sentence. */
  os: "windows" | "macos" | "linux" | "chromeos" | "android" | "ios" | "ipados" | "unknown";
  browser: "edge" | "opera" | "samsung" | "firefox" | "chrome" | "safari" | "unknown";
};

/** True when nothing identifiable is present, so the caller can fall back. */
export function isUnknownDevice(description: UserAgentDescription): boolean {
  return description.os === "unknown" && description.browser === "unknown";
}

export function describeUserAgent(userAgent: string | null | undefined): UserAgentDescription {
  const ua = (userAgent ?? "").trim();
  if (!ua) return { device: "unknown", os: "unknown", browser: "unknown" };

  const isAndroid = /Android/i.test(ua);
  const isIpadOs = /Macintosh/i.test(ua) && /Mobile/i.test(ua);
  const isIphone = /iPhone|iPod/i.test(ua);
  const isIpad = /iPad/i.test(ua) || isIpadOs;

  // --- operating system -----------------------------------------------------
  const os: UserAgentDescription["os"] = isIpad
    ? "ipados"
    : isIphone
      ? "ios"
      : isAndroid
        ? "android"
        : /CrOS/i.test(ua)
          ? "chromeos"
          : /Windows/i.test(ua)
            ? "windows"
            : /Mac OS X|Macintosh/i.test(ua)
              ? "macos"
              : /Linux|X11/i.test(ua)
                ? "linux"
                : "unknown";

  // --- browser --------------------------------------------------------------
  // The order is the point: every Chromium browser advertises `Safari/`, and
  // Edge and Opera both advertise `Chrome/`.
  const browser: UserAgentDescription["browser"] = /Edg[A-Z]?\//i.test(ua)
    ? "edge"
    : /OPR\/|Opera/i.test(ua)
      ? "opera"
      : /SamsungBrowser/i.test(ua)
        ? "samsung"
        : /Firefox\/|FxiOS/i.test(ua)
          ? "firefox"
          : /CriOS|Chrome\//i.test(ua)
            ? "chrome"
            : /Safari\//i.test(ua)
              ? "safari"
              : "unknown";

  // --- shape ----------------------------------------------------------------
  const device: DeviceKind = isIpad
    ? "tablet"
    : isIphone || (isAndroid && /Mobile/i.test(ua))
      ? "phone"
      : isAndroid
        ? "tablet"
        : os === "unknown"
          ? "unknown"
          : // A desktop OS is a laptop or a desktop and the header does not say
            // which; `laptop` is the honest middle, and the icon is the same
            // family. Windows/Mac/Linux are reported as `desktop` because that
            // is what the user can act on: "sign this device out".
            "desktop";

  return { device, os, browser };
}
