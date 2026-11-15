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
 * There are three kinds of rule here, and the difference is deliberate:
 *
 *   1. `CREDENTIAL_SHAPES` with `prefix` + `body` — a documented prefix plus
 *      the exact character count the vendor specifies.
 *   2. `CREDENTIAL_SHAPES` with `regexp` — fixed-structure families that a
 *      prefix plus a count cannot describe (a fine-grained PAT has an internal
 *      `_`, a Discord token has three dot-separated segments, a JWT has two
 *      `eyJ` headers). These still carry a `prefix` for the report, but it is
 *      a public label rather than a guaranteed literal at the start.
 *   3. `CREDENTIAL_CONTEXT_SHAPES` — patterns that would be far too noisy on
 *      their own. A bare 64-hex string is usually a SHA-256, and a DB URL in a
 *      template usually carries a placeholder password. These require an
 *      assignment / a non-placeholder password to count as a hit.
 *
 * Nothing in this module returns a value. `describeHit` echoes the prefix and
 * nothing else, so a hit can be printed in a terminal, a CI log or a chat
 * transcript without becoming a second copy of the credential. There is no
 * regex matching the words `secret`, `token` or `key` as a standalone signal —
 * that rule is what makes a gate cry over `hmacSecret: string;` twenty-three
 * times, and a gate that noisy gets switched off.
 *
 * All regexes are compiled once, at module load, not once per scanned line.
 */

/** The alphabets the documented formats actually use, with fixture characters. */
const CHARSETS = {
  base62: { re: "[A-Za-z0-9]", sample: "a1B2" },
  /** AWS access key ids are base32 upper case: `A-Z` and `2-7`, never `0189`. */
  base32upper: { re: "[A-Z2-7]", sample: "AB23" },
  base64url: { re: "[A-Za-z0-9_-]", sample: "a1B2" }
};

/** A fixture body of exactly `length` characters, built at runtime. */
function bodyOf(sample, length) {
  return sample.repeat(Math.ceil(length / sample.length)).slice(0, length);
}

/**
 * A password in a connection URL is not a credential when it is a template
 * placeholder or a shell variable. Matching those URLs as incidents would make
 * `.env.example`, `docker-compose.yml` and a regex comment fail the gate, and
 * a gate that fails on documentation gets switched off. Everything else is a
 * real, usable database credential and must block.
 */
const PLACEHOLDER_PASSWORD =
  /^(?:password|passwd|change[-_]?me|changeme|example|placeholder|your[-_]?(?:password|pwd|pass)|x+|al_ai|postgres|test|dev|secret|local|dummy|sample|none|null)$/i;
const INTERPOLATED = /[$%{}<>\[\]]/;

export const CREDENTIAL_SHAPES = [
  /*
   * GitHub first, because that is the family this project is most likely to
   * leak. The six `gh*_` families are 36 base62 characters after the prefix.
   * `gho_` is an OAuth access token rather than a personal one, which changes
   * how it is minted and not how dangerous it is.
   */
  { rule: "github-pat-classic", prefix: "ghp_", body: 36, charset: "base62", secret: true },
  { rule: "github-oauth-access", prefix: "gho_", body: 36, charset: "base62", secret: true },
  { rule: "github-app-user-token", prefix: "ghu_", body: 36, charset: "base62", secret: true },
  { rule: "github-app-server-token", prefix: "ghs_", body: 36, charset: "base62", secret: true },
  { rule: "github-oauth-refresh", prefix: "ghr_", body: 36, charset: "base62", secret: true },
  /*
   * A fine-grained PAT is `github_pat_` + 11-character public id + `_` +
   * 59-character secret. The old prefix+71-base62 rule could NEVER match one:
   * the separator `_` is not in base62. An exact structure is the only honest
   * way to detect this family.
   */
  {
    rule: "github-pat-fine-grained",
    prefix: "github_pat_",
    regexp: /github_pat_[A-Za-z0-9]{11}_[A-Za-z0-9]{59}(?![A-Za-z0-9])/g,
    sample: ["github_pat_", bodyOf("a1B2", 11), "_", bodyOf("a1B2", 59)].join(""),
    secret: true
  },
  /*
   * Supabase's pair of keys, measured against the one this repository's history
   * carries rather than guessed at: the prefix plus 31 base64url characters.
   * The difference between them is the whole finding: the publishable key is
   * designed to ship in a browser bundle (`secret: false`), while the secret
   * key bypasses row-level security outright.
   */
  { rule: "supabase-publishable", prefix: "sb_publishable_", body: 31, charset: "base64url", secret: false },
  { rule: "supabase-secret", prefix: "sb_secret_", body: 31, charset: "base64url", secret: true },
  /*
   * The cloud-vendor formats, repeated here on purpose: `secrun` already knows
   * them, but the same gate runs in CI where that CLI is not installed, and a
   * check that quietly degrades to nothing is worse than one that never claimed
   * the coverage.
   */
  { rule: "aws-access-key-id", prefix: "AKIA", body: 16, charset: "base32upper", secret: true },
  { rule: "aliyun-access-key-id", prefix: "LTAI", body: 16, charset: "base62", secret: true },
  { rule: "bailian-api-key", prefix: "sk-", body: 32, charset: "base62", secret: true },
  /* Discord's documented bot/user token shape: three base64url segments. */
  {
    rule: "discord-token",
    prefix: "Discord",
    regexp: /[MN][A-Za-z\d_-]{23}\.[\w-]{6}\.[\w-]{27}(?![\w-])/g,
    sample: ["M", "a".repeat(23), ".", "b".repeat(6), ".", "c".repeat(27)].join(""),
    secret: true
  },
  /* `sk-proj-` is distinct from the classic 32-character `sk-` family above. */
  {
    rule: "openai-project-key",
    prefix: "sk-proj-",
    regexp: /sk-proj-[A-Za-z0-9_-]{40,}(?![A-Za-z0-9_-])/g,
    sample: ["sk-proj-", "a1B2_".repeat(12)].join(""),
    invalid: "sk-proj-short",
    secret: true
  },
  {
    rule: "google-api-key",
    prefix: "AIza",
    regexp: /AIza[A-Za-z0-9_-]{35}(?![A-Za-z0-9_-])/g,
    sample: ["AIza", bodyOf("a1B2_", 35)].join(""),
    secret: true
  },
  {
    rule: "slack-token",
    prefix: "xox",
    regexp: /xox[baprs]-[A-Za-z0-9-]{10,}(?![A-Za-z0-9-])/g,
    sample: ["xoxb-", "1234567890-abcdefghij-ABCDEFGHIJ"].join(""),
    invalid: "xoxb-short",
    secret: true
  },
  /* A JWT / Supabase service-role token: two `eyJ` headers plus a signature. */
  {
    rule: "jwt-service-role",
    prefix: "eyJ",
    regexp: /eyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?![A-Za-z0-9_-])/g,
    sample: ["eyJ", "a".repeat(20), ".eyJ", "b".repeat(20), ".", "c".repeat(20)].join(""),
    invalid: "eyJaaa.eyJbbb.ccc",
    secret: true
  }
];

/**
 * Context-dependent shapes. Each one has an `accept(match)` whitelist guard,
 * because the raw pattern alone would fire on ordinary source code. `invalid`
 * is a near-miss that must NOT be detected, used by the gate's self-test.
 */
export const CREDENTIAL_CONTEXT_SHAPES = [
  /*
   * A 64-hex key is only evidence of a credential when it is the value of a
   * KEY/SECRET/TOKEN assignment. A bare 64-hex string is a SHA-256 digest in
   * almost every repository, and flagging those would make the gate useless.
   */
  {
    rule: "hex-key-assignment",
    prefix: "KEY=",
    regexp: /(?:^|[\s"'`{(,])(?:[A-Za-z_][A-Za-z0-9_]*(?:KEY|SECRET|TOKEN)[A-Za-z0-9_]*\s*[:=]\s*["']?)[0-9a-fA-F]{64}(?![0-9a-fA-F])/g,
    sample: ["ENCRYPTION_KEY=", "a1b2".repeat(16)].join(""),
    invalid: "a1b2".repeat(16),
    secret: true
  },
  {
    rule: "database-url-password",
    prefix: "postgres://",
    regexp: /(?:postgres(?:ql)?|mysql):\/\/[^:\s/@]+:([^@\s/]+)@[^\s"'`]+/g,
    sample: ["postgresql://al_ai:", bodyOf("a1B2c3D4", 12), "@127.0.0.1:55432/al_ai"].join(""),
    invalid: ["postgresql://al_ai:", "change-me", "@127.0.0.1:55432/al_ai"].join(""),
    accept: match => !INTERPOLATED.test(match[1]) && !PLACEHOLDER_PASSWORD.test(match[1]),
    secret: true
  }
];

/**
 * Formats with no length to pin, matched by their literal header. A PEM
 * envelope is not a keyword hunt: its first line cannot appear in a type
 * declaration, a variable name or a sentence about keys.
 */
export const CREDENTIAL_MARKERS = [
  {
    rule: "private-key",
    prefix: "-----BEGIN",
    marker: "-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED)?PRIVATE KEY-----",
    secret: true
  }
];

/**
 * One compiled rule. The trailing boundary on prefix shapes stops a URL, a
 * truncated paste, or this file's own documentation from matching: the body
 * must be exactly the documented length and not followed by another character
 * of its own alphabet.
 */
function shapeRegExp(shape) {
  if (shape.regexp) return shape.regexp;
  const { re } = CHARSETS[shape.charset];
  return new RegExp(`${shape.prefix}${re}{${shape.body}}(?!${re})`, "g");
}

const COMPILED = [
  ...CREDENTIAL_SHAPES.map(shape => ({ shape, regexp: shapeRegExp(shape) })),
  ...CREDENTIAL_CONTEXT_SHAPES.map(shape => ({ shape, regexp: shape.regexp })),
  ...CREDENTIAL_MARKERS.map(shape => ({ shape, regexp: new RegExp(shape.marker, "g") }))
];

/**
 * Finds every credential shape in `text`.
 *
 * Returns `{ rule, prefix, secret, line }` — never the match. `line` is the
 * 1-based line number inside the text handed in, so a caller can point at a
 * file and a line without quoting it. `String.matchAll` clones the regexp, so
 * sharing compiled regexps across calls is safe.
 */
export function findCredentialShapes(text) {
  const hits = [];
  for (const { shape, regexp } of COMPILED) {
    regexp.lastIndex = 0;
    for (const match of text.matchAll(regexp)) {
      if (shape.accept && !shape.accept(match)) continue;
      hits.push({
        rule: shape.rule,
        prefix: shape.prefix,
        secret: shape.secret,
        line: text.slice(0, match.index).split("\n").length
      });
    }
  }
  return hits;
}

/**
 * A report line that is safe to print: rule, location, prefix. The prefix is
 * the longest thing any caller is allowed to echo, and every prefix here is
 * public documentation rather than a secret.
 */
export function describeHit(hit, location) {
  return `${location}: ${hit.rule}: ${hit.prefix}****`;
}

/**
 * A fixture for the gate's own self-test. Built by concatenation so the
 * repository never contains a string that looks like a live token — GitHub's
 * push protection scans the diff of every push, and a test fixture that
 * matches its patterns would either block the push or train people to bypass
 * it. Pattern shapes carry a complete fixture; prefix shapes have their body
 * built from the alphabet's sample characters.
 */
export function fakeTokenFor(shape) {
  if (shape.sample) return shape.sample;
  const { sample } = CHARSETS[shape.charset];
  return [shape.prefix, bodyOf(sample, shape.body)].join("");
}
