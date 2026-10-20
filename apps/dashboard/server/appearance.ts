/**
 * Applies the operator's bot identity to Discord.
 *
 * The dashboard performs these writes itself rather than leaving them to the
 * bot's timer, because the operator needs to know *which* field Discord refused
 * and why. A save that returns "done" while the nickname silently failed is the
 * defect class this project treats as a bug, so every field reports its own
 * outcome and the caller surfaces each one.
 *
 * Scope, and where each field is written:
 *
 *   PATCH /guilds/{id}/members/@me   nickname, avatar, banner, bio   per guild
 *   PATCH /guilds/{id}/roles/{role}  colour, icon                    per guild
 *   gateway presence                 status, activity                account-wide, applied by the bot
 *
 * The four member fields share the first call, and that is not a convenience:
 * Modify Current Member accepts them together, so a nickname and a banner
 * changed in one save cost one request instead of four against a rate limit
 * Discord applies per application. There is no longer a `PATCH /users/@me` or a
 * `PATCH /applications/@me` in this file — those write the *account's* profile,
 * which is not a setting this dashboard owns any more.
 *
 * Only the fields that actually changed are sent. Discord rate-limits profile
 * edits per account, so re-sending an unchanged avatar on every save would spend
 * a budget the operator never asked to spend.
 */

import {
  APPEARANCE_FIELD_LABELS_AR,
  MAX_IMAGE_DATA_URL_LENGTH,
  BOT_ROLE_NAME,
  type AppearanceFieldName,
  type CustomizationSettings
} from "@al-ai/core";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { DiscordApiError, fetchGuildRoles, requestJson } from "./discord.js";
import { TtlCache } from "./cache.js";

/** Discord's ceiling for a role icon. Anything larger is refused by the API. */
const MAX_ROLE_ICON_BYTES = 256 * 1024;

/** Discord's numeric "missing permissions". */
const DISCORD_MISSING_PERMISSIONS = 50013;

/**
 * The fields a save can touch.
 *
 * Aliased from core rather than re-listed, so the labels the toast prints and
 * the names the writer reports cannot drift apart — a field renamed here and
 * not there would silently report `undefined` in the operator's message.
 */
export type AppearanceField = AppearanceFieldName;

export type FieldOutcome =
  | { field: AppearanceField; ok: true }
  | { field: AppearanceField; ok: false; code: string; message: string };

/** Arabic labels for the fields, used in every failure message. */
export const APPEARANCE_FIELD_LABELS = APPEARANCE_FIELD_LABELS_AR;

/**
 * What the operator should check when Discord says "no".
 *
 * Each hint names the field it belongs to before the advice, because Discord
 * reports a missing permission per call and the operator is looking at a form
 * with six of them. "البوت يحتاج صلاحية إدارة الرتب" alone does not say whether
 * it was the colour or the icon that failed, and the two are separate controls.
 */
const PERMISSION_HINT: Record<AppearanceField, string> = {
  nickname: "الاسم المستعار: البوت يحتاج صلاحية «إدارة الأسماء المستعارة» (Manage Nicknames) في هذا السيرفر.",
  guildAvatarDataUrl: "صورة السيرفر: البوت يحتاج صلاحية «تغيير الاسم المستعار» (Change Nickname) في هذا السيرفر.",
  bannerDataUrl: "غلاف السيرفر: البوت يحتاج صلاحية «تغيير الاسم المستعار» (Change Nickname) في هذا السيرفر.",
  bio: "نبذة السيرفر: البوت يحتاج صلاحية «تغيير الاسم المستعار» (Change Nickname) في هذا السيرفر.",
  roleColor: "لون الرتبة: البوت يحتاج صلاحية «إدارة الرتب» (Manage Roles)، وأن تكون رتبته أعلى من الرتبة التي يعدّلها.",
  roleIconUrl: "أيقونة الرتبة: البوت يحتاج صلاحية «إدارة الرتب» (Manage Roles)، وأن تكون رتبته أعلى من الرتبة التي يعدّلها."
};

/** Discord's own error code, when the body carried one. */
function discordCode(error: DiscordApiError): number | null {
  try {
    const parsed = JSON.parse(error.message.slice(error.message.indexOf("{"))) as { code?: unknown };
    return typeof parsed.code === "number" ? parsed.code : null;
  } catch {
    return null;
  }
}

/**
 * Turns a failed call into something the operator can act on.
 *
 * Pure, so the mapping is testable without Discord — which matters because these
 * messages are the only thing standing between a failed write and a silent one.
 */
export function describeAppearanceFailure(field: AppearanceField, error: unknown): { code: string; message: string } {
  const label = APPEARANCE_FIELD_LABELS[field];

  if (!(error instanceof DiscordApiError)) {
    return { code: "UNREACHABLE", message: `تعذّر الوصول إلى Discord أثناء تعديل ${label}. أعد المحاولة.` };
  }

  if (error.status === 401) {
    return { code: "BOT_TOKEN_INVALID", message: `رفض Discord توكن البوت أثناء تعديل ${label}. تحقّق من قيمة BOT_TOKEN ثم أعد تشغيل الخدمة.` };
  }

  if (error.status === 403 || discordCode(error) === DISCORD_MISSING_PERMISSIONS) {
    return { code: "MISSING_PERMISSION", message: PERMISSION_HINT[field] };
  }

  if (error.status === 429) {
    // `retryAfterSeconds` is null when Discord gave no hint, which must not read
    // as "wait zero".
    const wait = error.retryAfterSeconds;
    return {
      code: "RATE_LIMITED",
      message: wait === null
        ? `تجاوزنا حد Discord المؤقت أثناء تعديل ${label}. أعد المحاولة بعد قليل.`
        : `تجاوزنا حد Discord المؤقت أثناء تعديل ${label}. أعد المحاولة بعد ${Math.ceil(wait)} ثانية.`
    };
  }

  if (error.status === 400) {
    return {
      code: "REJECTED",
      message: `${label}: رفض Discord القيمة. تحقّق من الصيغة والحجم ثم أعد المحاولة.`
    };
  }

  return { code: `HTTP_${error.status}`, message: `فشل تعديل ${label} (رمز ${error.status} من Discord).` };
}

/** Runs a write and reports its outcome instead of throwing. */
async function attempt(field: AppearanceField, write: () => Promise<unknown>): Promise<FieldOutcome> {
  try {
    await write();
    return { field, ok: true };
  } catch (error) {
    return { field, ok: false, ...describeAppearanceFailure(field, error) };
  }
}

/**
 * Is a host one this server may fetch an operator-supplied URL from?
 *
 * The icon URL comes from the operator, and the fetch happens from the BFF's
 * network position — which is not the operator's browser's. A loopback,
 * private, link-local or metadata address would answer a request the operator
 * could not have made from their own machine, and the response does not have to
 * be an image to be a leak: issuing the request is the problem. Cloud metadata
 * endpoints sit in `169.254.169.254`, which is why link-local is refused rather
 * than merely unusual.
 */
function isPublicHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) {
    return false;
  }
  // An IPv4-mapped IPv6 address (`::ffff:127.0.0.1`) is another spelling of a
  // private address and has to be checked as one.
  const mapped = /^::(?:ffff:)?(\d{1,3}(?:\.\d{1,3}){3})$/.exec(host);
  if (mapped) return isPublicHost(mapped[1]!);
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    // 0/8 (this network), 10/8, 127/8 (loopback), 169.254/16 (link-local),
    // 172.16/12 and 192.168/16 (private), 100.64/10 (carrier-grade NAT),
    // 198.18/15 (benchmarks), 192.0.0/24 (IETF) and 224/4+ (multicast,
    // reserved, broadcast) are all "this machine or a network that is not the
    // public internet".
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 168 || b === 0)) return false;
    if (a === 198 && (b === 18 || b === 19)) return false;
    return true;
  }
  // IPv6: unspecified and loopback, unique-local `fc00::/7` (`fc`/`fd`) and
  // link-local `fe80::/10` (`fe80`–`febf`).
  return host !== "::" && host !== "::1" && !host.startsWith("fc") && !host.startsWith("fd") && !/^fe[89ab]/.test(host);
}

/**
 * The shapes the image downloader works with.
 *
 * `Resolver` and `Connector` are the two seams that make the policy testable
 * without a network: the resolver answers "where does this name point", the
 * connector answers "what came back". Production passes neither, so the real
 * DNS and a real TLS socket are used; the tests pass a fake resolver and a
 * fake connector, which is how the rebinding case is proved rather than
 * described.
 */
export type PinnedAddress = { address: string; family: number };
export type Resolver = (hostname: string) => Promise<PinnedAddress[]>;
export type ApprovedTarget = { url: URL; addresses: PinnedAddress[] };
export type ImageResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: AsyncIterable<Uint8Array>;
};
export type Connector = (url: URL, pinned: PinnedAddress, timeoutMs: number) => Promise<ImageResponse>;
export type ImageDeps = { resolve?: Resolver; connect?: Connector };

function headerValue(headers: ImageResponse["headers"], name: string): string | undefined {
  const value = headers[name];
  if (Array.isArray(value)) return value[0];
  return value;
}

/**
 * The request options for a *pinned* connection.
 *
 * Two things are decided here, and both matter:
 *
 * - `lookup` is overridden, so the socket connects to the address that was
 *   vetted. The resolver is never asked again: a name that answered with a
 *   public address during the check cannot answer with a private one at
 *   connect time, because the connect does not resolve at all.
 * - `servername` still carries the hostname, and the `Host` header still
 *   carries it, so the certificate is verified against the name the operator
 *   typed. Pinning the address must not cost the hostname check.
 *
 * Exported so a test can assert the options themselves - a test that only
 * checked the *policy* would prove nothing about the socket.
 */
export function buildPinnedRequestOptions(url: URL, pinned: PinnedAddress, timeoutMs: number) {
  return {
    protocol: "https:" as const,
    hostname: url.hostname,
    port: url.port || 443,
    path: `${url.pathname}${url.search}`,
    method: "GET" as const,
    servername: url.hostname,
    headers: { host: url.host, accept: "image/*" },
    lookup: (_hostname: string, _options: unknown, callback: (error: null, address: string, family: number) => void) =>
      callback(null, pinned.address, pinned.family),
    signal: AbortSignal.timeout(timeoutMs)
  };
}

/**
 * The real connection: TLS to a *pinned* address.
 */
const connectPinned: Connector = (url, pinned, timeoutMs) =>
  new Promise<ImageResponse>((resolve, reject) => {
    const request = httpsRequest(buildPinnedRequestOptions(url, pinned, timeoutMs), response => {
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: response as unknown as AsyncIterable<Uint8Array>
      });
    });
    request.on("error", reject);
    request.end();
  });

/**
 * Whether a *name* resolves to a public address.
 *
 * `isPublicHost` only inspects the literal, so `127.0.0.1.nip.io` — a public
 * name for a private address — used to pass. Resolving the name closes that
 * hole; a name that does not resolve is refused because the fetch could only
 * fail.
 */
async function resolveAddresses(hostname: string): Promise<PinnedAddress[]> {
  if (isIP(hostname)) {
    const family = isIP(hostname);
    return [{ address: hostname, family }];
  }
  const entries = await lookup(hostname, { all: true, verbatim: true });
  return entries.map(entry => ({ address: entry.address, family: entry.family }));
}

/**
 * The public addresses a name may be reached at.
 *
 * Every answer has to be public. A name that answers with both a public and a
 * private address is exactly the shape a rebinding attack uses: the check sees
 * the public one, the connection takes the private one.
 */
async function publicAddresses(hostname: string, resolve: Resolver): Promise<PinnedAddress[]> {
  let resolved: PinnedAddress[];
  try {
    resolved = await resolve(hostname);
  } catch {
    return [];
  }
  if (resolved.length === 0) return [];
  return resolved.every(entry => isPublicHost(entry.address)) ? resolved : [];
}

/**
 * An operator-supplied URL the BFF is willing to fetch, with the addresses it
 * is allowed to be reached at.
 *
 * Credentials in the URL are refused rather than forwarded, and the hostname
 * must resolve to a public address: a link to `https://127.0.0.1:8443/...` or
 * its `*.nip.io` spelling is an SSRF attempt, not an image.
 */
async function approvedUrl(raw: string, resolve: Resolver): Promise<ApprovedTarget | null> {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return null;
  const hostname = parsed.hostname.replace(/^\[|\]$/g, "");
  if (!isPublicHost(hostname)) return null;
  const addresses = await publicAddresses(hostname, resolve);
  if (addresses.length === 0) return null;
  return { url: parsed, addresses };
}

type ImageFetch =
  | { ok: true; dataUrl: string }
  | { ok: false; reason: "forbidden" | "unreachable" | "not-image" | "too-large" };

const IMAGE_MIME = /^image\/(png|jpeg|jpg|webp|gif)$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;
const IMAGE_FETCH_TIMEOUT_MS = 10_000;

/**
 * Downloads an image from a URL the operator supplied.
 *
 * The connection is made to an address that was *checked*, not to a name that
 * is *resolved again*: the name is resolved once, every answer is vetted, and
 * the socket is pinned to one of those addresses with `servername` still set to
 * the hostname so the certificate is verified against the name the operator
 * typed. That is the difference between a pre-flight check (which a rebinding
 * attack walks straight through, because the connection resolves a second
 * time) and a pinned connection, which cannot.
 *
 * Every redirect is validated the same way, so a public URL cannot walk the
 * request into loopback after the first check. The body is read with the size
 * ceiling enforced as it streams, so a huge response is never buffered whole.
 */
async function fetchPublicImage(url: string, maxBytes: number, deps: ImageDeps = {}): Promise<ImageFetch> {
  const resolve = deps.resolve ?? resolveAddresses;
  const connect = deps.connect ?? connectPinned;

  let current = await approvedUrl(url, resolve);
  if (!current) return { ok: false, reason: "forbidden" };

  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const response = await connect(current.url, current.addresses[0], IMAGE_FETCH_TIMEOUT_MS);
      if (REDIRECT_STATUSES.has(response.status)) {
        const location = headerValue(response.headers, "location");
        if (!location) return { ok: false, reason: "unreachable" };
        const next = await approvedUrl(new URL(location, current.url).toString(), resolve);
        if (!next) return { ok: false, reason: "forbidden" };
        current = next;
        continue;
      }
      if (response.status < 200 || response.status >= 300) return { ok: false, reason: "unreachable" };

      const mime = (headerValue(response.headers, "content-type") ?? "").split(";")[0].trim().toLowerCase();
      if (!IMAGE_MIME.test(mime)) return { ok: false, reason: "not-image" };

      const chunks: Buffer[] = [];
      let total = 0;
      for await (const chunk of response.body) {
        total += chunk.byteLength;
        if (total > maxBytes) return { ok: false, reason: "too-large" };
        chunks.push(Buffer.from(chunk));
      }
      if (total === 0) return { ok: false, reason: "unreachable" };
      const safeMime = mime === "image/jpg" ? "image/jpeg" : mime;
      return { ok: true, dataUrl: `data:${safeMime};base64,${Buffer.concat(chunks).toString("base64")}` };
    }
    return { ok: false, reason: "unreachable" };
  } catch {
    return { ok: false, reason: "unreachable" };
  }
}

/**
 * Downloads a role icon and returns it as a data URL.
 *
 * Discord's role endpoint takes image *data*, not a link, so a URL has to be
 * fetched first. Returns null when the value cannot be used, which the caller
 * reports rather than silently dropping.
 */
async function fetchRoleIconAsDataUrl(url: string): Promise<string | null> {
  const result = await fetchPublicImage(url, MAX_ROLE_ICON_BYTES);
  return result.ok ? result.dataUrl : null;
}

/**
 * A role icon ready for Discord, from either of the two forms it can arrive in.
 *
 * An uploaded value is already the data URL Discord wants, so it is passed
 * through untouched — re-encoding it would be a round trip that can only lose
 * quality. A link still has to be fetched, which is the one case that can fail
 * on its own; `undefined` in the result means "leave the icon alone" and must
 * never be collapsed into `null`, which Discord reads as "clear it".
 */
async function resolveRoleIcon(value: string): Promise<string | null | undefined> {
  if (value.startsWith("data:")) return value;
  const downloaded = await fetchRoleIconAsDataUrl(value);
  return downloaded ?? undefined;
}

/** Finds the role AL AI created for itself. */
async function findBotRoleId(token: string, guildId: string): Promise<string | null> {
  const roles = await fetchGuildRoles(token, guildId).catch(() => []);
  return roles.find(role => role.name === BOT_ROLE_NAME && !role.managed)?.id ?? null;
}

export type AppearancePlan = {
  token: string;
  guildId: string;
  /** The stored row as it is now. */
  previous: CustomizationSettings;
  /** The row as it will be stored. */
  next: CustomizationSettings;
};

/**
 * A customization as Discord should see it: when the profile's master switch
 * is off, the nickname, the avatar, the banner and the bio all read as "reset to
 * defaults" — Modify Current Member accepts null for every one of them — while
 * the role's colour and icon stay untouched (they belong to the role, not to the
 * profile).
 *
 * Both the change-detector and the writer derive from this one view, so a
 * disabled profile cannot silently re-send its old nickname, and re-saving a
 * disabled profile costs no Discord calls at all.
 */
function effectiveCustomization(settings: CustomizationSettings): CustomizationSettings {
  if (settings.enabled) return settings;
  return { ...settings, nickname: "", avatarDataUrl: null, bannerDataUrl: null, bio: "" };
}

/**
 * Which fields a save would actually send, in the order they are applied.
 *
 * Extracted so the "only send what changed" rule can be asserted directly — the
 * bug it prevents (re-uploading an avatar on every save, and burning Discord's
 * per-account rate limit) is invisible in the response otherwise.
 *
 * Every field it can report is a per-guild one. There is no branch for the
 * presence because there is nothing here that could write it: a status lives on
 * the gateway, the bot owns it, and the presence route never calls this. The
 * absence is structural rather than an oversight, which is why the plan type
 * carries no presence either.
 */
export function changedAppearanceFields(plan: Omit<AppearancePlan, "token" | "guildId">): AppearanceField[] {
  const changed: AppearanceField[] = [];
  const previous = effectiveCustomization(plan.previous);
  const next = effectiveCustomization(plan.next);
  if (next.nickname !== previous.nickname) changed.push("nickname");
  if (next.avatarDataUrl !== previous.avatarDataUrl) changed.push("guildAvatarDataUrl");
  if (next.bannerDataUrl !== previous.bannerDataUrl) changed.push("bannerDataUrl");
  if (next.bio !== previous.bio) changed.push("bio");

  const roleChanged = plan.next.roleColor !== plan.previous.roleColor || plan.next.roleIconUrl !== plan.previous.roleIconUrl;
  if (roleChanged) {
    // Reported as two fields but written in one call, so the operator still sees
    // which half of the role appearance was involved.
    if (plan.next.roleColor !== plan.previous.roleColor) changed.push("roleColor");
    if (plan.next.roleIconUrl !== plan.previous.roleIconUrl) changed.push("roleIconUrl");
  }

  return changed;
}

/**
 * Decides what a role-icon write should store, and whether to report it.
 *
 * Extracted because the rule has three cases that are easy to collapse into one
 * and expensive when they are:
 *
 * - **Not sent** means "leave it alone". Reading an absent field as `null` would
 *   wipe a stored icon — and the screen omits this field entirely below boost
 *   level 2, so that path is the normal one, not an edge case.
 * - **Sent and locked** keeps the stored value and reports the refusal. The
 *   write is dropped, never the request: answering 409 here failed the whole
 *   form, so a valid nickname and colour were lost to a control the operator was
 *   not allowed to touch. That was the bug.
 * - **Sent and allowed** stores what was sent, including an explicit `null`,
 *   which is how the icon is cleared.
 *
 * Pure, so all three are asserted directly instead of inferred from a response.
 */
export function resolveRoleIconWrite(input: {
  /** False when the request did not carry the field at all. */
  sent: boolean;
  /** The normalised value that was sent. Meaningless when `sent` is false. */
  value: string | null;
  /** What the row holds now. */
  stored: string | null;
  /** Whether Discord would refuse an icon for this guild right now. */
  locked: boolean;
  /** Why it is locked, for the operator. */
  reason: string | null;
}): { value: string | null; deferred: { code: string; message: string } | null } {
  if (!input.sent) return { value: input.stored, deferred: null };

  // Only a *change* is doomed. Re-sending the icon already stored is a no-op,
  // and rejecting that would strand the operator: the field is disabled, so
  // they could not clear it either.
  if (input.locked && input.value !== input.stored) {
    return {
      value: input.stored,
      deferred: {
        code: "ROLE_ICON_REQUIRES_BOOST",
        message: input.reason ?? "أيقونة الرتبة غير متاحة في هذا السيرفر."
      }
    };
  }

  return { value: input.value, deferred: null };
}

/**
 * Downloads a remote image and returns it as a base64 data URL.
 *
 * Discord's own avatar/banner endpoints accept data URIs only — a plain URL
 * cannot be handed to them — so "أو رابط مباشر" means the dashboard fetches
 * the bytes itself. Everything is bounded: a public https URL pinned to the
 * address that was checked, a real image content-type, and the same size
 * ceiling the uploader enforces.
 *
 * `deps` exists for the tests. Production leaves it empty and the real DNS
 * and TLS socket are used; a caller that passes a resolver and a connector
 * gets the same policy with a different transport, which is how the
 * rebinding case is proved without a network.
 */
export async function fetchImageAsDataUrl(
  url: string,
  maxBytes = MAX_IMAGE_DATA_URL_LENGTH,
  deps: ImageDeps = {}
): Promise<string> {
  if (!/^https:\/\//i.test(url.trim())) throw new Error("الرابط يجب أن يبدأ بـ https://");
  const result = await fetchPublicImage(url.trim(), maxBytes, deps);
  if (result.ok) return result.dataUrl;

  switch (result.reason) {
    case "forbidden":
      throw new Error("الرابط غير مسموح: يجب أن يكون رابطاً عاماً عبر https، وليس عنواناً محلياً أو خاصاً.");
    case "too-large":
      throw new Error(`حجم الصورة على الرابط يتجاوز الحد المسموح (${Math.round(maxBytes / 1000)} كيلوبايت تقريباً).`);
    case "not-image":
      throw new Error("الرابط لا يشير إلى صورة (PNG/JPEG/WEBP/GIF).");
    default:
      throw new Error("تعذّر الوصول إلى الصورة على الرابط المحدد.");
  }
}

/**
 * Applies every changed field, one at a time.
 *
 * A failure is recorded against its own field and the rest still run: refusing
 * the whole save because the banner was rejected would leave the operator with
 * no idea which of six changes took effect.
 */
export async function applyAppearance(plan: AppearancePlan): Promise<FieldOutcome[]> {
  const { token, guildId, previous, next } = plan;
  const outcomes: FieldOutcome[] = [];

  // All four member fields share one endpoint — Modify Current Member accepts
  // `nick`, `avatar`, `banner` and `bio` together — so they travel in one PATCH.
  // Four separate requests would spend the member-edit rate limit four times for
  // what Discord treats as one call. A failure reports against every field the
  // combined body carried: one refusal answers for all of them, and splitting a
  // shared verdict into four would be inventing outcomes Discord never gave.
  const previousEffective = effectiveCustomization(previous);
  const nextEffective = effectiveCustomization(next);
  const nickChanged = nextEffective.nickname !== previousEffective.nickname;
  const avatarChanged = nextEffective.avatarDataUrl !== previousEffective.avatarDataUrl;
  const bannerChanged = nextEffective.bannerDataUrl !== previousEffective.bannerDataUrl;
  const bioChanged = nextEffective.bio !== previousEffective.bio;

  if (nickChanged || avatarChanged || bannerChanged || bioChanged) {
    const body: Record<string, unknown> = {};
    if (nickChanged) {
      // An empty nickname means "fall back to the application's own name",
      // which is how Discord spells a cleared nickname.
      body.nick = nextEffective.nickname || null;
    }
    if (avatarChanged) body.avatar = nextEffective.avatarDataUrl;
    if (bannerChanged) body.banner = nextEffective.bannerDataUrl;
    // An empty bio means "clear the override", which is null and not "". Discord
    // reads the empty string as a value and would store a blank about-me.
    if (bioChanged) body.bio = nextEffective.bio || null;

    // The fields this one call answers for, in the order the form lists them.
    // `nickname` leads because a member edit that fails on permissions is nearly
    // always a nickname permission, and the operator should read that first.
    const carried: AppearanceField[] = [];
    if (nickChanged) carried.push("nickname");
    if (avatarChanged) carried.push("guildAvatarDataUrl");
    if (bannerChanged) carried.push("bannerDataUrl");
    if (bioChanged) carried.push("bio");

    const write = await attempt(carried[0]!, () =>
      // No `@me` resolution is needed: unlike the member *read* route, which
      // rejects `@me` outright, Discord accepts it on this PATCH. Verified
      // against the live API before this was written, and verified again for
      // `banner` and `bio` when they moved here — a banner data URI came back as
      // a stored hash on the member object, and an over-long bio came back as
      // 400 BASE_TYPE_MAX_LENGTH rather than the silent 200 that
      // `PATCH /users/@me {bio}` answers with.
      requestJson(`/guilds/${guildId}/members/@me`, {
        token,
        method: "PATCH",
        body
      })
    );

    // The one PATCH served every field in `carried`; the verdict above names the
    // field whose change led it. Mirror it to the rest, so the toast cannot
    // claim a success Discord never separately confirmed.
    for (const field of carried) {
      outcomes.push(write.ok ? { field, ok: true } : { field, ok: false, code: write.code, message: write.message });
    }
  }

  const roleColorChanged = next.roleColor !== previous.roleColor;
  const roleIconChanged = next.roleIconUrl !== previous.roleIconUrl;

  if (roleColorChanged || roleIconChanged) {
    const roleId = await findBotRoleId(token, guildId);
    if (!roleId) {
      for (const field of [roleColorChanged && "roleColor", roleIconChanged && "roleIconUrl"].filter(
        Boolean
      ) as AppearanceField[]) {
        outcomes.push({
          field,
          ok: false,
          code: "BOT_ROLE_MISSING",
          message: `لم يُعثر على رتبة ${BOT_ROLE_NAME} في هذا السيرفر. أعد تشغيل البوت لإنشائها ثم أعد المحاولة.`
        });
      }
    } else {
      // `undefined` means "leave the icon alone". That distinction is the whole
      // point: a download that failed must not fall through to `null`, which
      // Discord reads as "clear the icon" and would destroy the existing one.
      let iconPayload: string | null | undefined;
      let iconFailed = false;

      if (roleIconChanged) {
        if (!next.roleIconUrl) {
          iconPayload = null; // cleared on purpose
        } else {
          const resolved = await resolveRoleIcon(next.roleIconUrl);
          if (resolved) {
            iconPayload = resolved;
          } else {
            iconFailed = true;
            outcomes.push({
              field: "roleIconUrl",
              ok: false,
              code: "ROLE_ICON_UNUSABLE",
              message:
                "تعذّر تجهيز أيقونة الرتبة. ارفعها كصورة من الجهاز، أو استخدم رابط https مباشر لصورة أصغر من 256 كيلوبايت."
            });
          }
        }
      }

      const writeColour = roleColorChanged;
      const writeIcon = roleIconChanged && !iconFailed;

      if (writeColour || writeIcon) {
        const write = await attempt("roleColor", () =>
          requestJson(`/guilds/${guildId}/roles/${roleId}`, {
            token,
            method: "PATCH",
            body: {
              // Colour 0 is Discord's "no colour", which is what a cleared value means.
              colors: {
                primary_color: next.roleColor
                  ? Number.parseInt(next.roleColor.slice(1), 16)
                  : 0
              },
              // Omitted when the icon did not change, so a colour edit cannot clear it.
              ...(writeIcon ? { icon: iconPayload ?? null } : {})
            }
          })
        );

        // One call, but every field it touched gets its own verdict.
        const touched: AppearanceField[] = [];
        if (writeColour) touched.push("roleColor");
        if (writeIcon) touched.push("roleIconUrl");
        for (const field of touched) {
          outcomes.push(
            write.ok ? { field, ok: true } : { field, ok: false, code: write.code, message: write.message }
          );
        }
      }
    }
  }

  return outcomes;
}

/**
 * What Discord currently holds for the bot *inside one guild*.
 *
 * Read from `GET /guilds/{id}/members/{bot}` rather than from the account's own
 * profile, because the preview on the identity screen answers a question about
 * this server: "what do the members here see when they click the bot?" The
 * nickname, the avatar and the banner are the *member's* overrides, and the
 * account's values are only what those overrides fall back to — so the account
 * read is not merely a different source, it is the wrong one.
 *
 * `username` rides along because the member object carries the user, which saves
 * the separate `/users/@me` call this file used to make for it.
 *
 * `accountAvatar` and `accountBanner` are the account's own hashes, and they are
 * here for one reason: they are what a member with no override *falls back to*.
 * Without them the preview would draw the initials for a bot whose picture is
 * perfectly visible to every member — a preview that lies in the one place it
 * exists to be believed.
 *
 * The bio is deliberately absent. Discord validates it on write and never
 * returns it on read — there is no member-bio field in the API at all — so the
 * stored row is the only source for it and the preview takes it from there. A
 * snapshot type carrying a `bio` would have to invent one.
 *
 * Raw hashes, not URLs: turning a hash into a CDN address is the one job
 * `userAvatarUrl` owns, and a second implementation here is how the animated-
 * avatar rule (`a_` hashes need `.gif`) would get forgotten in one of the two
 * places. The route resolves them on the way out.
 */
export type GuildMemberProfile = {
  username: string;
  nickname: string | null;
  avatar: string | null;
  banner: string | null;
  accountAvatar: string | null;
  accountBanner: string | null;
};

/**
 * How long a guild member profile is trusted.
 *
 * This read replaces an account-wide one that ran with no cache at all, on an
 * endpoint Discord rate-limits per *application* rather than per route: opening
 * the identity screen fired it beside every other read, and a second look
 * (another tab, a refresh, a remount) paid the same cost again. That is the
 * burst the 429 bar is made of.
 *
 * The values only change when the operator saves, and every save invalidates
 * the entry explicitly — so a minute is free correctness-wise, and the interval
 * is measured against the rate-limit window rather than against how fast a
 * nickname can change.
 */
const GUILD_MEMBER_CACHE_MS = 60_000;

/**
 * Keyed by token *and* guild, because both are part of what the answer is
 * about. One bot serves many servers, so a cache keyed on the token alone would
 * serve one server's nickname in another — a wrong answer that looks exactly
 * like a right one.
 */
const guildMemberProfileCache = new TtlCache<string, GuildMemberProfile>(GUILD_MEMBER_CACHE_MS);

function guildMemberProfileKey(token: string, guildId: string): string {
  return `${token}:${guildId}`;
}

/**
 * What the bot looks like in one guild, cached and coalesced.
 *
 * Returns null only when the read failed *and* nothing is cached. A failure
 * deliberately does not overwrite the cache: `TtlCache.resolve` serves the last
 * known value and rethrows only when there is nothing to serve, so a momentary
 * Discord hiccup cannot blank the preview for a minute.
 *
 * Two requests, and the second is advisory: the member object carries this
 * server's overrides, and `/users/@me` carries the account values they fall back
 * to. Losing the account read must not cost the caller the member one — the
 * guild's own picture is the answer to the question being asked, and the
 * fallback is what makes it complete.
 */
export async function readGuildMemberProfile(
  token: string,
  guildId: string,
  botUserId: string
): Promise<GuildMemberProfile | null> {
  try {
    return await guildMemberProfileCache.resolve(guildMemberProfileKey(token, guildId), async () => {
      const [member, account] = await Promise.all([
        requestJson<{
          nick?: string | null;
          avatar?: string | null;
          banner?: string | null;
          user: { username: string; avatar: string | null };
        }>(`/guilds/${guildId}/members/${botUserId}`, { token, method: "GET" }),
        requestJson<{ avatar: string | null; banner: string | null }>("/users/@me", { token, method: "GET" }).catch(() => null)
      ]);
      return {
        username: member.user.username,
        nickname: member.nick ?? null,
        avatar: member.avatar ?? null,
        banner: member.banner ?? null,
        // The member's own user object already carries the account avatar, so
        // the fallback survives even when `/users/@me` does not answer.
        accountAvatar: account?.avatar ?? member.user.avatar ?? null,
        accountBanner: account?.banner ?? null
      };
    });
  } catch {
    return null;
  }
}

/**
 * Drop the memoised profile after a write.
 *
 * Per guild, because that is the scope of the values: a nickname saved in one
 * server must not expire every other server's cached read, which would turn one
 * save into a burst of Discord calls on the next screen load.
 *
 * Without this the preview would keep drawing the previous picture for up to a
 * minute after a save that already succeeded — the "saved but not applied"
 * confusion this project treats as a defect, arriving from the cache instead of
 * from Discord.
 */
export function invalidateGuildMemberProfile(token: string, guildId: string) {
  guildMemberProfileCache.clear(guildMemberProfileKey(token, guildId));
}
