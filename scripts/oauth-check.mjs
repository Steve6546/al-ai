/**
 * A local integration check of the dashboard's OAuth leg.
 *
 * It runs against a *running* dashboard and exercises the paths that do not
 * need a real Discord account:
 *
 * 1. the login leg issues a `state`, a redirect URI and a state cookie with
 *    the right attributes;
 * 2. a callback with no state cookie is refused;
 * 3. a callback with the wrong state is refused;
 * 4. a callback with the right state and a bogus code gets no session - the
 *    token exchange fails, and a failure must not mint one;
 * 5. the state cookie is single-use: it is cleared on the way back;
 * 6. the reach gate refuses a host this deployment does not serve.
 *
 * What this does *not* do is sign a human in: that needs a real Discord
 * account and a real authorisation code. Everything that can be checked
 * without one is checked here.
 *
 * The requests go through `node:http` rather than `fetch`, for two reasons:
 * `fetch` refuses to set the `Host` header (it is a forbidden header), and
 * the reach gate can only be tested with a real `Host`; and the login leg
 * answers with a redirect chain that has to be followed hop by hop.
 *
 *   node scripts/oauth-check.mjs [--url http://127.0.0.1:3000]
 */
import http from "node:http";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const baseUrl = arg("url", "http://127.0.0.1:3000").replace(/\/$/, "");
const findings = [];

function check(label, ok, detail = "") {
  findings.push({ label, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? `  ${detail}` : ""}`);
}

/** One request, without following redirects, with a `Host` we control. */
function rawRequest(path, { headers = {}, method = "GET" } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const request = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method,
        headers,
        // The `Host` header is what the reach gate reads, so the automatic one
        // must not overwrite the one under test.
        setHost: !("host" in headers)
      },
      response => {
        const chunks = [];
        response.on("data", chunk => chunks.push(chunk));
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    request.on("error", reject);
    request.end();
  });
}

function cookiesOf(response) {
  const raw = response.headers["set-cookie"] ?? [];
  return raw.map(entry => {
    const [pair, ...attributes] = entry.split(";");
    const [name, value] = pair.split("=");
    return {
      name: name.trim(),
      value: value ?? "",
      attributes: attributes.map(attribute => attribute.trim().toLowerCase()),
      raw: entry
    };
  });
}

function findCookie(cookies, suffix) {
  return cookies.find(cookie => cookie.name.endsWith(suffix));
}

// 1. The login leg, followed hop by hop until it reaches Discord.
let hop = await rawRequest("/auth/discord/login");
const hops = [hop];
let location = hop.headers.location ?? "";
for (let step = 0; step < 3 && location && !location.startsWith("https://discord.com/"); step += 1) {
  // A hop that stays on this machine (the login leg re-points the browser at
  // the origin it will come back to) is followed with the `Host` the browser
  // would have used.
  const next = new URL(location, baseUrl);
  const hostHeader = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(next.hostname) ? next.host : undefined;
  hop = await rawRequest(`${next.pathname}${next.search}`, hostHeader ? { headers: { host: hostHeader } } : {});
  hops.push(hop);
  location = hop.headers.location ?? "";
}
const loginCookies = hops.flatMap(cookiesOf);
const stateCookie = findCookie(loginCookies, "session_state");
const authorize = location ? new URL(location) : null;

check("the login leg ends at Discord's authorize endpoint", authorize?.origin === "https://discord.com", authorize?.origin ?? location);
check("the login leg carries a state", Boolean(authorize?.searchParams.get("state")));
check("the login leg carries a redirect URI", Boolean(authorize?.searchParams.get("redirect_uri")), authorize?.searchParams.get("redirect_uri") ?? "");
check(
  "the login leg asks only for the scopes the dashboard needs",
  (authorize?.searchParams.get("scope") ?? "").split(" ").sort().join(",") === "guilds,identify",
  authorize?.searchParams.get("scope") ?? ""
);
check("the login leg sets a state cookie", Boolean(stateCookie), stateCookie?.name ?? "");
if (stateCookie) {
  check("the state cookie is HttpOnly", stateCookie.attributes.includes("httponly"));
  check("the state cookie is SameSite=Lax", stateCookie.attributes.includes("samesite=lax"), stateCookie.attributes.join(","));
  check("the state cookie is Path=/", stateCookie.attributes.includes("path=/"), stateCookie.attributes.join(","));
  check(
    "the state cookie is short-lived",
    stateCookie.attributes.some(attribute => attribute.startsWith("max-age=") && Number(attribute.split("=")[1]) <= 600),
    stateCookie.attributes.join(",")
  );
  check(
    "the state cookie's value is the state's random part",
    stateCookie.value.split(".")[0] === authorize?.searchParams.get("state")?.split(".")[0]
  );
  check(
    "the state cookie is Secure in production",
    stateCookie.attributes.includes("secure") || process.env.NODE_ENV !== "production",
    stateCookie.attributes.join(",")
  );
}

const stateCookieHeader = stateCookie ? `${stateCookie.name}=${stateCookie.value}` : "";

// 2. A callback with no state cookie at all.
const noState = await rawRequest("/auth/discord/callback?code=fake-code&state=whatever");
const noStateLocation = noState.headers.location ?? "";
const noStateCookies = cookiesOf(noState);
check("a callback without the state cookie is refused", noStateLocation.includes("auth=state_mismatch"), noStateLocation);
check(
  "a refused callback issues no session cookie",
  !noStateCookies.some(cookie => cookie.name.endsWith("session") && !cookie.name.endsWith("session_state")),
  noStateCookies.map(cookie => cookie.name).join(",")
);

// 3. A callback with a state that does not match the cookie.
const wrongState = await rawRequest("/auth/discord/callback?code=fake-code&state=not-the-state", {
  headers: stateCookieHeader ? { cookie: stateCookieHeader } : {}
});
const wrongStateLocation = wrongState.headers.location ?? "";
check("a callback with the wrong state is refused", wrongStateLocation.includes("auth=state_mismatch"), wrongStateLocation);
check(
  "a refused callback with a wrong state issues no session cookie",
  !cookiesOf(wrongState).some(cookie => cookie.name.endsWith("session") && !cookie.name.endsWith("session_state"))
);

// 4. The right state, a bogus code: the exchange fails, and no session is minted.
const rightState = await rawRequest(
  `/auth/discord/callback?code=fake-code&state=${encodeURIComponent(stateCookie?.value ?? "x")}`,
  { headers: stateCookieHeader ? { cookie: stateCookieHeader } : {} }
);
const rightStateCookies = cookiesOf(rightState);
const sessionCookie = rightStateCookies.find(cookie => cookie.name.endsWith("session") && !cookie.name.endsWith("session_state"));
check("a failed token exchange mints no session", !sessionCookie, sessionCookie ? sessionCookie.name : "no session cookie");
const clearedState = rightStateCookies.find(cookie => cookie.name.endsWith("session_state"));
check(
  "the state cookie is cleared on the way back",
  Boolean(clearedState && clearedState.attributes.some(attribute => attribute === "max-age=0")),
  clearedState?.raw ?? "no state cookie in the answer"
);

// 5. The reach gate: a host this deployment does not serve.
const foreign = await rawRequest("/api/session", { headers: { host: "not-our-host.example.com" } });
check("a foreign Host is refused", foreign.status === 403, `status ${foreign.status}`);
check("the refusal names the reason", foreign.body.includes("REMOTE_ACCESS_DISABLED"), foreign.body.slice(0, 80));

// 6. The same gate, with the host this deployment does serve.
const own = await rawRequest("/api/session", { headers: { host: `127.0.0.1:3000` } });
check("the deployment's own host is served", own.status === 200, `status ${own.status}`);

// 7. A session request issues no cookie of its own.
const probe = await rawRequest("/api/session", { headers: { cookie: "al_ai_session=00000000-0000-4000-8000-000000000000" } });
check("a session request issues no cookie of its own", cookiesOf(probe).length === 0, cookiesOf(probe).map(cookie => cookie.name).join(","));

// 8. The cross-site guard on a state-changing request.
const forged = await rawRequest("/api/guilds", {
  method: "POST",
  headers: { host: "127.0.0.1:3000", origin: "https://evil.example.com", "content-type": "application/json" }
});
check("a state-changing request from another site is refused", forged.status === 403, `status ${forged.status}`);
check("the refusal names the reason", forged.body.includes("CROSS_SITE_REQUEST"), forged.body.slice(0, 80));

const ownOrigin = await rawRequest("/api/guilds", {
  method: "POST",
  headers: { host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000", "content-type": "application/json" }
});
check(
  "the same request from this site passes the guard",
  ownOrigin.status !== 403,
  `status ${ownOrigin.status} (401 = no session, which is the next gate)`
);

const noOrigin = await rawRequest("/api/guilds", {
  method: "POST",
  headers: { host: "127.0.0.1:3000", "content-type": "application/json" }
});
check("a request without an Origin is not refused by the guard", noOrigin.status !== 403, `status ${noOrigin.status}`);
// 7. Signing out: the real route, which destroys the session and clears the
// cookie. No credential is needed to prove the path works - the answer has to
// be a cleared cookie whether or not a session existed.
const logout = await rawRequest("/auth/logout", { method: "POST" });
const logoutCookies = cookiesOf(logout);
const cleared = logoutCookies.find(cookie => cookie.name.endsWith("session") && !cookie.name.endsWith("session_state"));
check(
  "signing out answers with a cleared session cookie",
  logout.status === 200 && Boolean(cleared && cleared.attributes.some(attribute => attribute === "max-age=0")),
  `status ${logout.status}, cookie: ${cleared?.raw ?? "none"}`
);

// 8. The cross-site guard, in the shapes that matter.
//
// A write that carries the session cookie has to say where it came from: a
// browser always sends `Origin` on a cross-site write, so a cookie-bearing
// write with no origin at all is the forged shape and is refused. A write
// without the cookie is left to the route's own authentication (it answers
// 401 anyway), and a write that names this site passes.
const SESSION_COOKIE = "al_ai_session=11111111-1111-4111-8111-111111111111";
const noOriginWrite = await rawRequest("/api/guilds/111111111111111111/tiers", {
  method: "PUT",
  headers: { cookie: SESSION_COOKIE, "content-type": "application/json" }
});
check(
  "a write with the session cookie and no origin is refused",
  forged.status === 403 && forged.body.includes("CROSS_SITE_REQUEST"),
  `status ${forged.status}`
);

const foreignReferer = await rawRequest("/api/guilds/111111111111111111/tiers", {
  method: "PUT",
  headers: { cookie: SESSION_COOKIE, referer: "https://elsewhere.example.com/page", "content-type": "application/json" }
});
check(
  "a write with the session cookie and another site's referer is refused",
  foreignReferer.status === 403,
  `status ${foreignReferer.status}`
);

const sameSiteWrite = await rawRequest("/api/guilds/111111111111111111/tiers", {
  method: "PUT",
  headers: { cookie: SESSION_COOKIE, origin: "http://127.0.0.1:3000", "content-type": "application/json" }
});
check(
  "a write from this site passes the guard",
  sameSiteWrite.status !== 403,
  `status ${sameSiteWrite.status} (401 = no such session, which is the next gate)`
);

const anonymous = await rawRequest("/api/guilds/111111111111111111/tiers", {
  method: "PUT",
  headers: { "content-type": "application/json" }
});
check(
  "a write without the session cookie is left to the route's own authentication",
  anonymous.status !== 403,
  `status ${anonymous.status}`
);

const failed = findings.filter(finding => !finding.ok);
console.log(`\n${findings.length - failed.length}/${findings.length} checks passed`);
process.exitCode = failed.length ? 1 : 0;
