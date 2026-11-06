/**
 * Live check for the admin second factor: `npm run check:2fa`.
 *
 * A real Discord sign-in cannot be automated, so this drives the same HTTP
 * surface the browser drives, against the running BFF and the real database.
 * It creates ONE fake admin (a unique id, never a real Discord account), a
 * pending login row per case, and removes every row it created in `finally` —
 * including the session minted by a successful verification. Nothing about the
 * deployment's data or settings is changed.
 *
 * It proves the parts a unit test cannot: that no session is issued before
 * verification, that the CSRF guard covers the pending cookie, that the
 * enrolment secret is stable across retries, that a wrong code is counted,
 * that a replayed TOTP is refused, that a recovery code is single-use, and
 * that an expired/cancelled/over-guessed login is dead.
 */
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { encryptSecret } from "../packages/core/src/security.ts";
import { totpCodeAt } from "../packages/core/src/two-factor.ts";
import { SESSION_COOKIE_NAME } from "../packages/core/src/session-policy.ts";

const require = createRequire(new URL("../apps/dashboard/package.json", import.meta.url));
const { Client } = require("pg") as typeof import("pg");

const databaseUrl = process.env.DATABASE_URL;
const encryptionKey = process.env.ENCRYPTION_KEY;
if (!databaseUrl || !encryptionKey) {
  console.error("check:2fa: DATABASE_URL and ENCRYPTION_KEY must be set (run through npm so --env-file=.env applies).");
  process.exit(1);
}

const origin = `http://127.0.0.1:${process.env.PORT ?? 3000}`;
const pendingCookieName = `${SESSION_COOKIE_NAME}_2fa`;
const testUser = `two-factor-check-${randomUUID()}`;
const client = new Client({ connectionString: databaseUrl });

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = "") {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failed += 1;
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

async function request(
  path: string,
  options: { cookie?: string; method?: string; body?: unknown; originHeader?: boolean | string } = {}
) {
  const headers: Record<string, string> = {};
  if (options.cookie) headers.cookie = options.cookie;
  // A browser always names its origin on a state-changing request. Omitting it
  // is the one case below that is meant to be refused by the CSRF guard; a
  // string names a foreign site, which must be refused just as firmly.
  if (options.method && options.method !== "GET" && options.originHeader !== false) {
    headers.origin = typeof options.originHeader === "string" ? options.originHeader : origin;
  }
  if (options.body !== undefined) headers["content-type"] = "application/json";
  const response = await fetch(`${origin}${path}`, {
    method: options.method ?? "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: "manual"
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  const cookies = (response.headers.getSetCookie?.() ?? []) as string[];
  return { status: response.status, json, cookies };
}

function cookieValue(cookies: string[], name: string): string | null {
  for (const raw of cookies) {
    const [pair] = raw.split(";");
    const index = pair.indexOf("=");
    if (index > 0 && pair.slice(0, index) === name) return decodeURIComponent(pair.slice(index + 1));
  }
  return null;
}

/** One pending login, already past OAuth but with no session cookie issued. */
async function newPending(expiresInMs = 5 * 60 * 1000): Promise<string> {
  const id = randomUUID();
  await client.query(
    `INSERT INTO admin_two_factor_pending
       (id, discord_user_id, discord_username, discord_handle, discord_avatar,
        access_token_ciphertext, scopes, enrollment_ciphertext, expires_at)
     VALUES ($1, $2, $3, $4, NULL, $5, $6, NULL, now() + ($7 || ' milliseconds')::interval)`,
    [
      id,
      testUser,
      "check operator",
      "check-operator",
      encryptSecret(`check-token-${id}`, encryptionKey!),
      "identify guilds",
      String(expiresInMs)
    ]
  );
  return id;
}

async function cleanup() {
  await client.query(`DELETE FROM oauth_sessions WHERE discord_user_id = $1`, [testUser]);
  await client.query(`DELETE FROM admin_two_factor_pending WHERE discord_user_id = $1`, [testUser]);
  // The recovery rows are FK-linked with ON DELETE CASCADE, but deleting them
  // explicitly keeps the check honest if that constraint is ever changed.
  await client.query(`DELETE FROM admin_two_factor_recovery WHERE discord_user_id = $1`, [testUser]);
  await client.query(`DELETE FROM admin_two_factor WHERE discord_user_id = $1`, [testUser]);
}

await client.connect();
try {
  await cleanup();
  console.log(`check:2fa — ${origin} (pending cookie: ${pendingCookieName})`);

  const first = await newPending();
  const firstCookie = `${pendingCookieName}=${first}`;

  const sessionBefore = await request("/api/session", { cookie: firstCookie });
  check("a pending admin login is reported as unauthenticated", sessionBefore.json.authenticated === false);
  check(
    "the session announces the second factor and that enrolment is new",
    (sessionBefore.json.secondFactor as { required?: boolean; enrolled?: boolean } | undefined)?.required === true &&
      (sessionBefore.json.secondFactor as { enrolled?: boolean } | undefined)?.enrolled === false
  );
  check("no session cookie is issued before verification", cookieValue(sessionBefore.cookies, SESSION_COOKIE_NAME) === null);
  const guarded = await request("/api/guilds", { cookie: firstCookie });
  check("a pending cookie alone cannot read a protected route", guarded.status === 401, `status ${guarded.status}`);
  check(
    "the pending verdict discloses neither the user id nor a token",
    !JSON.stringify(sessionBefore.json).includes(testUser) &&
      !JSON.stringify(sessionBefore.json).includes("accessToken")
  );

  const forged = await request("/api/2fa/verify", {
    cookie: firstCookie,
    method: "POST",
    body: { code: "123456" },
    originHeader: false
  });
  check("a write carrying the pending cookie but no origin is refused", forged.status === 403, `status ${forged.status}`);

  const foreign = await request("/api/2fa/verify", {
    cookie: firstCookie,
    method: "POST",
    body: { code: "123456" },
    originHeader: "https://evil.example"
  });
  check("a write from a foreign origin cannot spend a pending login", foreign.status === 403 && foreign.json.error === "CROSS_SITE_REQUEST", `status ${foreign.status}`);

  const anonymous = await request("/api/2fa/enrollment");
  check("enrolment without a pending cookie discloses nothing", anonymous.status === 401 && anonymous.json.secret === undefined);
  const forgedId = await request("/api/2fa/enrollment", { cookie: `${pendingCookieName}=${randomUUID()}` });
  check("a forged pending id addresses no enrolment", forgedId.status === 401 && forgedId.json.error === "PENDING_EXPIRED");

  const enrollment = await request("/api/2fa/enrollment", { cookie: firstCookie });
  const payload = enrollment.json as { enrolled?: boolean; secret?: string | null; otpauthUri?: string | null; recoveryCodes?: string[]; expiresAt?: string };
  check("enrolment answers with a secret and ten recovery codes", payload.enrolled === false && typeof payload.secret === "string" && payload.recoveryCodes?.length === 10);
  check("the otpauth URI is built for an authenticator app", typeof payload.otpauthUri === "string" && payload.otpauthUri.startsWith("otpauth://totp/"));
  check("the pending deadline is published for the countdown", typeof payload.expiresAt === "string");

  const again = await request("/api/2fa/enrollment", { cookie: firstCookie });
  check(
    "a retry reveals the same secret and codes",
    again.json.secret === payload.secret && JSON.stringify(again.json.recoveryCodes) === JSON.stringify(payload.recoveryCodes)
  );

  const wrong = await request("/api/2fa/verify", { cookie: firstCookie, method: "POST", body: { code: "not-a-code" } });
  check("a wrong code is refused and counts down the attempts", wrong.status === 400 && wrong.json.error === "INVALID_CODE" && wrong.json.attemptsRemaining === 4, JSON.stringify(wrong.json));

  const code = totpCodeAt(payload.secret!, Date.now());
  const verified = await request("/api/2fa/verify", { cookie: firstCookie, method: "POST", body: { code } });
  const sessionId = cookieValue(verified.cookies, SESSION_COOKIE_NAME);
  check("a valid TOTP completes the login", verified.status === 200 && verified.json.ok === true, JSON.stringify(verified.json));
  check("the session cookie is issued only now", Boolean(sessionId));
  check(
    "the pending cookie is cleared on success",
    verified.cookies.some(raw => raw.startsWith(`${pendingCookieName}=`) && /Max-Age=0/i.test(raw))
  );

  const sessionRaw = verified.cookies.find(raw => raw.startsWith(`${SESSION_COOKIE_NAME}=`)) ?? "";
  check(
    "the minted session cookie keeps the hardened policy",
    ["HttpOnly", "Secure", "SameSite=Lax", "Path=/"].every(attribute => sessionRaw.includes(attribute)),
    sessionRaw.slice(0, 120)
  );
  const after = await request("/api/session", { cookie: `${SESSION_COOKIE_NAME}=${sessionId}` });
  check("the minted session is the verified admin's", after.json.authenticated === true && (after.json.user as { id?: string } | undefined)?.id === testUser);
  const spent = await request("/api/2fa/verify", { cookie: firstCookie, method: "POST", body: { code } });
  check(
    "a spent pending login cannot mint a second session",
    spent.status === 401 && cookieValue(spent.cookies, SESSION_COOKIE_NAME) === null,
    `status ${spent.status}`
  );

  // Replay: the same TOTP code must not open a second login for this admin.
  const replayId = await newPending();
  const replay = await request("/api/2fa/verify", { cookie: `${pendingCookieName}=${replayId}`, method: "POST", body: { code } });
  check("a replayed TOTP code is refused by its counter", replay.status === 400 && replay.json.error === "INVALID_CODE", JSON.stringify(replay.json));

  // Recovery: one code works once, then is gone.
  const recoveryId = await newPending();
  const recovery = payload.recoveryCodes![0];
  const recoveryOk = await request("/api/2fa/verify", { cookie: `${pendingCookieName}=${recoveryId}`, method: "POST", body: { code: recovery } });
  check("a recovery code completes a login", recoveryOk.status === 200 && recoveryOk.json.ok === true, JSON.stringify(recoveryOk.json));
  const reuseId = await newPending();
  const reuse = await request("/api/2fa/verify", { cookie: `${pendingCookieName}=${reuseId}`, method: "POST", body: { code: recovery } });
  check("a spent recovery code cannot be used twice", reuse.status === 400 && reuse.json.error === "INVALID_CODE", JSON.stringify(reuse.json));

  // Enrolled logins never reveal the secret again.
  const enrolledId = await newPending();
  const enrolledView = await request("/api/2fa/enrollment", { cookie: `${pendingCookieName}=${enrolledId}` });
  check(
    "an enrolled login never re-reveals the key or recovery codes",
    enrolledView.json.enrolled === true && enrolledView.json.secret === null && Array.isArray(enrolledView.json.recoveryCodes) && (enrolledView.json.recoveryCodes as unknown[]).length === 0
  );

  // Expiry, cancellation and the guess ceiling.
  const expiredId = await newPending(-1000);
  const expiredSession = await request("/api/session", { cookie: `${pendingCookieName}=${expiredId}` });
  const expiredEnrollment = await request("/api/2fa/enrollment", { cookie: `${pendingCookieName}=${expiredId}` });
  check("an expired pending login is signed out", expiredSession.json.secondFactor === undefined);
  check("an expired enrolment answers PENDING_EXPIRED", expiredEnrollment.status === 401 && expiredEnrollment.json.error === "PENDING_EXPIRED", JSON.stringify(expiredEnrollment.json));

  const cancelId = await newPending();
  const cancelled = await request("/api/2fa/cancel", { cookie: `${pendingCookieName}=${cancelId}`, method: "POST" });
  const cancelledSession = await request("/api/session", { cookie: `${pendingCookieName}=${cancelId}` });
  check("cancelling clears the pending cookie", cancelled.status === 200 && cancelled.cookies.some(raw => raw.startsWith(`${pendingCookieName}=`) && /Max-Age=0/i.test(raw)));
  check("a cancelled login is no longer announced", cancelledSession.json.secondFactor === undefined);

  const ceilingId = await newPending();
  let last = { status: 0, json: {} as Record<string, unknown> };
  for (let attempt = 0; attempt < 5; attempt += 1) {
    last = await request("/api/2fa/verify", { cookie: `${pendingCookieName}=${ceilingId}`, method: "POST", body: { code: "still-not-a-code" } });
  }
  check("the fifth wrong answer destroys the pending login", last.status === 403 && last.json.error === "TOO_MANY_ATTEMPTS", JSON.stringify(last.json));

  console.log(`\ncheck:2fa — ${passed} passed, ${failed} failed.`);
  process.exitCode = failed ? 1 : 0;
} finally {
  await cleanup();
  await client.end();
}
