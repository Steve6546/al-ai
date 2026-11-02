/**
 * Value-shaped credential detection, for the repository's own secret gate.
 *
 * `secrun scan` covers the cloud-vendor formats it was written for (AWS and
 * Alibaba access keys, Bailian `sk-`, STS temporary credentials, PEM blocks) and
 * a key-name rule. It does **not** know GitHub's token formats, which is the
 * family this project is most likely to leak: the repository is pushed to
 * GitHub, the CLI is authenticated with an OAuth token, and a `ghp_` pasted into
 * a workflow file or a log line is invisible to a rule set that has no pattern
 * for it.
 *
 * So this file holds exactly one kind of pattern: a documented prefix plus the
 * character count that vendor's own documentation specifies. There is no regex
 * here matching the words `secret`, `token` or `key` — that rule is what makes a
 * gate cry over `hmacSecret: string;` twenty-three times, and a gate that noisy
 * gets switched off. A shape that cannot be a real token (wrong length, wrong
 * alphabet) is not reported at all.
 *
 * Nothing in this module returns a value. `matched` is the prefix and nothing
 * else, so a hit can be printed in a terminal, a CI log or a chat transcript
 * without becoming a second copy of the credential.
 */

/**
 * The alphabets the documented formats actually use.
 *
 * Each one carries the fixture characters too, because a self-test that builds
 * an AWS-shaped body out of lowercase letters would test nothing — and `-` and
 * `_` are in base64url but not in base62, which is why Supabase and GitHub are
 * not the same alphabet even though both are "token-ish".
 */
const CHARSETS = {
  base62: { re: "[A-Za-z0-9]", sample: "a1B2" },
  /** AWS access key ids are base32 upper case: `A-Z` and `2-7`, never `0189`. */
  base32upper: { re: "[A-Z2-7]", sample: "AB23" },
  base64url: { re: "[A-Za-z0-9_-]", sample: "a1B2" }
};

/**
 * The credential formats this gate knows, each one a documented prefix plus the
 * character count that format's own documentation specifies.
 *
 * GitHub first, because that is the family this project is most likely to leak.
 *
 * The six `gh*_` families are 36 base62 characters after the prefix; the
 * fine-grained PAT is `github_pat_` + an 11-character public id + `_` + a
 * 59-character secret. `gho_` is an OAuth *access* token rather than a personal
 * one, which changes how it is minted and not how dangerous it is.
 */
export const CREDENTIAL_SHAPES = [
  { rule: "github-pat-classic", prefix: "ghp_", body: 36, charset: "base62", secret: true },
  { rule: "github-oauth-access", prefix: "gho_", body: 36, charset: "base62", secret: true },
  { rule: "github-app-user-token", prefix: "ghu_", body: 36, charset: "base62", secret: true },
  { rule: "github-app-server-token", prefix: "ghs_", body: 36, charset: "base62", secret: true },
  { rule: "github-oauth-refresh", prefix: "ghr_", body: 36, charset: "base62", secret: true },
  { rule: "github-pat-fine-grained", prefix: "github_pat_", body: 11 + 1 + 59, charset: "base62", secret: true },
  /*
   * Supabase's pair of keys, measured against the one this repository's history
   * carries rather than guessed at: the prefix plus 31 base64url characters.
   *
   * Both are listed because the difference between them is the whole finding:
   * the publishable key is the client-side one, designed to ship in a browser
   * bundle and enforced by row-level security, so `secret: false` keeps it out
   * of the failure path while still being reported. The secret key is the
   * server-side one that bypasses row-level security outright, so the same
   * length appearing behind that prefix is an incident.
   */
  { rule: "supabase-publishable", prefix: "sb_publishable_", body: 31, charset: "base64url", secret: false },
  { rule: "supabase-secret", prefix: "sb_secret_", body: 31, charset: "base64url", secret: true },
  /*
   * The cloud-vendor formats, repeated here on purpose.
   *
   * `secrun scan` already knows them and the gate still calls it — but the same
   * gate runs in CI, where that CLI is not installed, and a check that quietly
   * degrades to nothing is worse than one that never claimed the coverage. These
   * four are what the gate can always assert by itself; the scanner adds depth
   * (`STS.` temporary credentials, and whatever its rules grow next).
   */
  { rule: "aws-access-key-id", prefix: "AKIA", body: 16, charset: "base32upper", secret: true },
  { rule: "aliyun-access-key-id", prefix: "LTAI", body: 16, charset: "base62", secret: true },
  { rule: "bailian-api-key", prefix: "sk-", body: 32, charset: "base62", secret: true }
];

/**
 * Formats with no length to pin, so they are matched by their literal header.
 *
 * A PEM envelope is not a keyword hunt: its first line cannot appear in a type
 * declaration, a variable name or a sentence about keys, so this is the rare
 * case where an exact string is a stronger signal than an exact length. The
 * header is written here as an alternation of its own words, which is also why
 * the gate's own source is one of the self-test's cases — a file that spells a
 * marker out in prose would flag itself on every run.
 */
export const CREDENTIAL_MARKERS = [
  { rule: "private-key", marker: "-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED)?PRIVATE KEY-----", secret: true }
];

/**
 * One compiled shape.
 *
 * The trailing boundary is what stops a URL, a truncated paste, or this file's
 * own documentation from matching: the body must be exactly the documented
 * length and must not be followed by another character of its own alphabet.
 */
function shapeRegExp({ prefix, body, charset }) {
  const { re } = CHARSETS[charset];
  return new RegExp(`${prefix}${re}{${body}}(?!${re.slice(1, -1)})`, "g");
}

/**
 * Finds every credential shape and every credential marker in `text`.
 *
 * Returns `{ rule, prefix, secret, line }` — never the match. `line` is the
 * 1-based line number inside the text handed in, so a caller can point at a
 * file and a line without quoting it.
 */
export function findCredentialShapes(text) {
  const hits = [];
  for (const shape of CREDENTIAL_SHAPES) {
    const regexp = shapeRegExp(shape);
    for (const match of text.matchAll(regexp)) {
      hits.push({
        rule: shape.rule,
        prefix: shape.prefix,
        secret: shape.secret,
        line: text.slice(0, match.index).split("\n").length
      });
    }
  }
  for (const marker of CREDENTIAL_MARKERS) {
    for (const match of text.matchAll(new RegExp(marker.marker, "g"))) {
      hits.push({
        rule: marker.rule,
        prefix: "-----BEGIN",
        secret: marker.secret,
        line: text.slice(0, match.index).split("\n").length
      });
    }
  }
  return hits;
}

/**
 * A report line that is safe to print: rule, location, prefix.
 *
 * The prefix is the longest thing any caller of this function is allowed to
 * echo, and every prefix here is public documentation rather than a secret.
 */
export function describeHit(hit, location) {
  return `${location}: ${hit.rule}: ${hit.prefix}****`;
}

/**
 * A fixture for the gate's own self-test.
 *
 * Built by concatenation so the repository never contains a string that looks
 * like a live token — GitHub's push protection scans the diff of every push, and
 * a test fixture that matches its patterns would either block the push or train
 * people to bypass it. Same reason `apps/bot/test/discord-standards.test.ts`
 * builds its snowflakes out of parts.
 */
export function fakeTokenFor(shape) {
  const { sample } = CHARSETS[shape.charset];
  const body = sample.repeat(Math.ceil(shape.body / sample.length)).slice(0, shape.body);
  // The prefix and the body only ever meet at runtime, never in this file.
  return [shape.prefix, body].join("");
}
