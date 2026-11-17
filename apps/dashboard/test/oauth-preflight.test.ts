import test from "node:test";
import assert from "node:assert/strict";
import {
  checkRedirectRegistration,
  clientIdMismatch,
  describeMissingRegistration
} from "../server/oauth-preflight.js";

/**
 * The boot-time OAuth check.
 *
 * It exists because a production deployment shipped with `localhost` and a
 * stale ngrok hostname registered while the app had moved to its platform
 * domain: every sign-in ended on Discord's «Invalid OAuth2 redirect_uri», and
 * the server log was silent. A second layer made it worse — the redirect *had*
 * been added, but to a different application than the one `DISCORD_CLIENT_ID`
 * and `BOT_TOKEN` name, so the portal looked right and the deployment stayed
 * broken.
 *
 * These cases pin the three answers that matter — registered, missing, and
 * *could not tell* — plus the identity each one carries, because collapsing
 * "could not tell" into "missing" would warn every operator whose token cannot
 * read the field.
 */

const URI = "https://ngln5duqvk.apps.bot-hosting.cloud/auth/discord/callback";
const APP = { id: "1544750141112582187", name: "ddas" };

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test("a registered callback reports registered and still names the application", async () => {
  const state = await checkRedirectRegistration({
    botToken: "t",
    redirectUri: URI,
    fetchImpl: (async () =>
      json({ id: APP.id, name: APP.name, redirect_uris: ["http://localhost:3000/x", URI] })) as typeof fetch
  });
  assert.equal(state.status, "registered");
  assert.deepEqual(state.application, APP);
});

test("a missing callback reports missing and keeps the identity for the page", async () => {
  const state = await checkRedirectRegistration({
    botToken: "t",
    redirectUri: URI,
    fetchImpl: (async () =>
      json({ id: APP.id, name: APP.name, redirect_uris: ["http://localhost:3000/x"] })) as typeof fetch
  });
  assert.equal(state.status, "missing");
  assert.deepEqual(state.application, APP);
  assert.deepEqual(state.registered, ["http://localhost:3000/x"]);
  const sentence = describeMissingRegistration(state);
  assert.match(sentence, /1544750141112582187/);
  assert.match(sentence, /ddas/);
  assert.match(sentence, /ngln5duqvk/);
});

test("an empty registered list is reported, not silently accepted", async () => {
  const state = await checkRedirectRegistration({
    botToken: "t",
    redirectUri: URI,
    fetchImpl: (async () => json({ id: APP.id, name: APP.name, redirect_uris: [] })) as typeof fetch
  });
  assert.equal(state.status, "missing");
  assert.match(describeMissingRegistration(state), /\(none\)/);
});

test("no bot token means no request and an explicit unknown", async () => {
  let called = false;
  const state = await checkRedirectRegistration({
    botToken: null,
    redirectUri: URI,
    fetchImpl: (async () => {
      called = true;
      return json({});
    }) as typeof fetch
  });
  assert.equal(state.status, "unknown");
  assert.equal(state.reason, "BOT_TOKEN is not set");
  assert.equal(called, false, "the check must not call Discord without a token");
});

test("a payload without redirect_uris is undetermined, not a failure", async () => {
  const state = await checkRedirectRegistration({
    botToken: "t",
    redirectUri: URI,
    fetchImpl: (async () => json({ id: APP.id, name: APP.name })) as typeof fetch
  });
  assert.equal(state.status, "unknown");
});

test("a refused request is not a configuration verdict", async () => {
  const state = await checkRedirectRegistration({
    botToken: "t",
    redirectUri: URI,
    fetchImpl: (async () => json({ message: "401: Unauthorized" }, 401)) as typeof fetch
  });
  assert.equal(state.status, "unknown");
});

test("a network failure never breaks the boot", async () => {
  const state = await checkRedirectRegistration({
    botToken: "t",
    redirectUri: URI,
    fetchImpl: (async () => {
      throw new Error("ENOTFOUND discord.com");
    }) as typeof fetch
  });
  assert.equal(state.status, "unknown");
  assert.match(state.reason ?? "", /ENOTFOUND/);
});

test("a client id that names another application is reported", () => {
  const message = clientIdMismatch("1570227988602036365", APP);
  assert.ok(message);
  assert.match(message, /1570227988602036365/);
  assert.match(message, /1544750141112582187/);
});

test("a matching client id says nothing", () => {
  assert.equal(clientIdMismatch(APP.id, APP), null);
});

test("a missing client id or identity is not a mismatch", () => {
  assert.equal(clientIdMismatch(null, APP), null);
  assert.equal(clientIdMismatch(APP.id, null), null);
});
