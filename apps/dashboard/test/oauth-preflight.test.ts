import test from "node:test";
import assert from "node:assert/strict";
import { checkRedirectRegistration, redirectRegistrationWarning } from "../server/oauth-preflight.js";

/**
 * The boot-time OAuth check.
 *
 * It exists because a production deployment shipped with `localhost` and a
 * stale ngrok hostname registered while the app had moved to its platform
 * domain: every sign-in ended on Discord's «Invalid OAuth2 redirect_uri», and
 * the server log was silent. These cases pin the three answers that matter —
 * registered, missing, and *could not tell* — because collapsing the last one
 * into "missing" would warn every operator whose token cannot read the field.
 */

const URI = "https://ngln5duqvk.apps.bot-hosting.cloud/auth/discord/callback";

test("a registered callback says nothing", () => {
  assert.equal(redirectRegistrationWarning(["http://localhost:3000/auth/discord/callback", URI], URI), null);
});

test("an unregistered callback names the URI and where to fix it", () => {
  const warning = redirectRegistrationWarning(["http://localhost:3000/auth/discord/callback"], URI);
  assert.ok(warning);
  assert.match(warning, new RegExp(URI.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(warning, /Developer Portal/);
  assert.match(warning, /Invalid OAuth2 redirect_uri/);
});

test("an empty list is reported, not silently accepted", () => {
  const warning = redirectRegistrationWarning([], URI);
  assert.ok(warning);
  assert.match(warning, /\(none\)/);
});

test("an unreadable list is 'could not tell', never 'missing'", () => {
  assert.equal(redirectRegistrationWarning(null, URI), null);
});

test("no bot token means no request and no warning", async () => {
  let called = false;
  const warning = await checkRedirectRegistration({
    botToken: null,
    redirectUri: URI,
    fetchImpl: (async () => {
      called = true;
      return new Response("{}");
    }) as typeof fetch
  });
  assert.equal(warning, null);
  assert.equal(called, false, "the check must not call Discord without a token");
});

test("a registered callback passes through the fetch path", async () => {
  const warning = await checkRedirectRegistration({
    botToken: "test-token",
    redirectUri: URI,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ redirect_uris: [URI] }), { status: 200 })) as typeof fetch
  });
  assert.equal(warning, null);
});

test("a missing callback is reported from the fetch path", async () => {
  const warning = await checkRedirectRegistration({
    botToken: "test-token",
    redirectUri: URI,
    fetchImpl: (async () =>
      new Response(JSON.stringify({ redirect_uris: ["http://localhost:3000/auth/discord/callback"] }), {
        status: 200
      })) as typeof fetch
  });
  assert.ok(warning);
  assert.match(warning, /ngln5duqvk/);
});

test("a payload without redirect_uris is undetermined, not a failure", async () => {
  const warning = await checkRedirectRegistration({
    botToken: "test-token",
    redirectUri: URI,
    fetchImpl: (async () => new Response(JSON.stringify({ id: "1", name: "app" }), { status: 200 })) as typeof fetch
  });
  assert.equal(warning, null);
});

test("a refused request is not a configuration verdict", async () => {
  const warning = await checkRedirectRegistration({
    botToken: "test-token",
    redirectUri: URI,
    fetchImpl: (async () => new Response("nope", { status: 401 })) as typeof fetch
  });
  assert.equal(warning, null);
});

test("a network failure never breaks the boot", async () => {
  const warning = await checkRedirectRegistration({
    botToken: "test-token",
    redirectUri: URI,
    fetchImpl: (async () => {
      throw new Error("ENOTFOUND discord.com");
    }) as typeof fetch
  });
  assert.equal(warning, null);
});
