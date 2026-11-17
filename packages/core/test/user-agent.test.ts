import test from "node:test";
import assert from "node:assert/strict";
import { describeUserAgent, isUnknownDevice } from "../src/user-agent.js";

/**
 * Real User-Agent strings, taken from the browsers themselves.
 *
 * The security screen used to draw a monitor for every session, so these are the
 * cases that make the icon honest: a phone must not look like a desktop, and an
 * iPad must not look like a Mac (iPadOS sends a macOS string unless the site
 * asks for the mobile one).
 */
const CASES: { name: string; ua: string; device: string; os: string; browser: string }[] = [
  {
    name: "Chrome on Windows",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    device: "desktop",
    os: "windows",
    browser: "chrome"
  },
  {
    name: "Edge on Windows (must not be Chrome)",
    ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    device: "desktop",
    os: "windows",
    browser: "edge"
  },
  {
    name: "Firefox on macOS",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:132.0) Gecko/20100101 Firefox/132.0",
    device: "desktop",
    os: "macos",
    browser: "firefox"
  },
  {
    name: "Safari on macOS (must not be a Chromium browser)",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Safari/605.1.15",
    device: "desktop",
    os: "macos",
    browser: "safari"
  },
  {
    name: "Safari on iPhone",
    ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_6 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
    device: "phone",
    os: "ios",
    browser: "safari"
  },
  {
    name: "Chrome on Android phone",
    ua: "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    device: "phone",
    os: "android",
    browser: "chrome"
  },
  {
    name: "Chrome on Android tablet (no Mobile token)",
    ua: "Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    device: "tablet",
    os: "android",
    browser: "chrome"
  },
  {
    name: "Safari on iPad (desktop-class UA)",
    ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.6 Mobile/15E148 Safari/604.1",
    device: "tablet",
    os: "ipados",
    browser: "safari"
  },
  {
    name: "Samsung Internet on Android",
    ua: "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36",
    device: "phone",
    os: "android",
    browser: "samsung"
  },
  {
    name: "Firefox on Linux",
    ua: "Mozilla/5.0 (X11; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
    device: "desktop",
    os: "linux",
    browser: "firefox"
  }
];

for (const entry of CASES) {
  test(`identifies ${entry.name}`, () => {
    const described = describeUserAgent(entry.ua);
    assert.equal(described.device, entry.device, "device shape");
    assert.equal(described.os, entry.os, "operating system");
    assert.equal(described.browser, entry.browser, "browser");
  });
}

test("a missing or empty header is reported as unknown rather than guessed", () => {
  for (const value of [null, undefined, "", "   "]) {
    const described = describeUserAgent(value);
    assert.equal(described.device, "unknown");
    assert.equal(isUnknownDevice(described), true);
  }
});

test("a header that names nothing recognisable does not claim a device", () => {
  const described = describeUserAgent("curl/8.7.1");
  assert.equal(described.device, "unknown");
  assert.equal(described.os, "unknown");
  assert.equal(described.browser, "unknown");
});
