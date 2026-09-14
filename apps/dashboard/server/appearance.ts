/**
 * Applies the operator's bot identity to Discord.
 *
 * The dashboard performs these writes itself rather than leaving them to the
 * bot's timer, because the operator needs to know *which* field Discord refused
 * and why. A save that returns "done" while the nickname silently failed is the
 * defect class this project treats as a bug, so every field reports its own
 * outcome and the caller surfaces each one.
 *
 * Scope, and who owns each half:
 *
 *   PATCH /guilds/{id}/members/@me   nickname        per guild
 *   PATCH /guilds/{id}/roles/{role}  colour, icon    per guild
 *   PATCH /users/@me                 avatar, banner  global
 *   PATCH /applications/@me          bio             global
 *   gateway presence                 status, activity global — applied by the bot
 *
 * Only the fields that actually changed are sent. Discord rate-limits profile
 * edits per account, so re-sending an unchanged avatar on every save would spend
 * a budget the operator never asked to spend.
 */

import {
  APPEARANCE_FIELD_LABELS_AR,
  BOT_ROLE_NAME,
  type AppearanceFieldName,
  type BotIdentitySettings,
  type CustomizationSettings
} from "@al-ai/core";
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
  avatarDataUrl: "الصورة الرمزية: توكن البوت لا يملك صلاحية تعديل حساب التطبيق. تحقّق من صلاحيات التطبيق في بوابة المطوّرين.",
  bannerDataUrl: "البانر: توكن البوت لا يملك صلاحية تعديل حساب التطبيق. تحقّق من صلاحيات التطبيق في بوابة المطوّرين.",
  bio: "النبذة التعريفية: توكن البوت لا يملك صلاحية تعديل بيانات التطبيق. تحقّق من صلاحيات التطبيق في بوابة المطوّرين.",
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
 * Downloads a role icon and returns it as a data URL.
 *
 * Discord's role endpoint takes image *data*, not a link, so a URL has to be
 * fetched first. Returns null when the value cannot be used, which the caller
 * reports rather than silently dropping.
 */
export async function fetchRoleIconAsDataUrl(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { redirect: "follow" });
    if (!response.ok) return null;
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.startsWith("image/")) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength === 0 || buffer.byteLength > MAX_ROLE_ICON_BYTES) return null;
    // Keep the type Discord declared, normalised to the ones it accepts.
    const mime = contentType.split(";")[0].trim().toLowerCase();
    const safe = /^image\/(png|jpeg|jpg|webp|gif)$/.test(mime) ? mime : "image/png";
    return `data:${safe};base64,${buffer.toString("base64")}`;
  } catch {
    return null;
  }
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
export async function findBotRoleId(token: string, guildId: string): Promise<string | null> {
  const roles = await fetchGuildRoles(token, guildId).catch(() => []);
  return roles.find(role => role.name === BOT_ROLE_NAME && !role.managed)?.id ?? null;
}

export type AppearancePlan = {
  token: string;
  guildId: string;
  previous: { customization: CustomizationSettings; identity: BotIdentitySettings };
  next: { customization: CustomizationSettings; identity: BotIdentitySettings };
};

/**
 * Which fields a save would actually send, in the order they are applied.
 *
 * Extracted so the "only send what changed" rule can be asserted directly — the
 * bug it prevents (re-uploading an avatar on every save, and burning Discord's
 * per-account rate limit) is invisible in the response otherwise.
 */
export function changedAppearanceFields(plan: Omit<AppearancePlan, "token" | "guildId">): AppearanceField[] {
  const changed: AppearanceField[] = [];
  if (plan.next.customization.nickname !== plan.previous.customization.nickname) changed.push("nickname");

  const roleChanged =
    plan.next.customization.roleColor !== plan.previous.customization.roleColor ||
    plan.next.customization.roleIconUrl !== plan.previous.customization.roleIconUrl;
  if (roleChanged) {
    // Reported as two fields but written in one call, so the operator still sees
    // which half of the role appearance was involved.
    if (plan.next.customization.roleColor !== plan.previous.customization.roleColor) changed.push("roleColor");
    if (plan.next.customization.roleIconUrl !== plan.previous.customization.roleIconUrl) changed.push("roleIconUrl");
  }

  if (plan.next.identity.avatarDataUrl !== plan.previous.identity.avatarDataUrl) changed.push("avatarDataUrl");
  if (plan.next.identity.bannerDataUrl !== plan.previous.identity.bannerDataUrl) changed.push("bannerDataUrl");
  if (plan.next.identity.bio !== plan.previous.identity.bio) changed.push("bio");
  return changed;
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

  if (next.customization.nickname !== previous.customization.nickname) {
    outcomes.push(
      await attempt("nickname", () =>
        // No `@me` resolution is needed: unlike the member *read* route, which
        // rejects `@me` outright, Discord accepts it on this PATCH. Verified
        // against the live API before this was written.
        requestJson(`/guilds/${guildId}/members/@me`, {
          token,
          method: "PATCH",
          // An empty nickname means "fall back to the application's own name",
          // which is how Discord spells a cleared nickname.
          body: { nick: next.customization.nickname || null }
        })
      )
    );
  }

  if (next.identity.avatarDataUrl !== previous.identity.avatarDataUrl) {
    outcomes.push(
      await attempt("avatarDataUrl", () =>
        requestJson("/users/@me", {
          token,
          method: "PATCH",
          body: { avatar: next.identity.avatarDataUrl }
        })
      )
    );
  }

  if (next.identity.bannerDataUrl !== previous.identity.bannerDataUrl) {
    outcomes.push(
      await attempt("bannerDataUrl", () =>
        requestJson("/users/@me", {
          token,
          method: "PATCH",
          body: { banner: next.identity.bannerDataUrl }
        })
      )
    );
  }

  if (next.identity.bio !== previous.identity.bio) {
    outcomes.push(
      await attempt("bio", () =>
        // The application description, not `PATCH /users/@me {bio}`: that field is
        // accepted with a 200 for a bot token and then silently discarded, so the
        // only route that actually changes the bot's "About me" is this one.
        requestJson("/applications/@me", {
          token,
          method: "PATCH",
          body: { description: next.identity.bio }
        })
      )
    );
  }

  const roleColorChanged = next.customization.roleColor !== previous.customization.roleColor;
  const roleIconChanged = next.customization.roleIconUrl !== previous.customization.roleIconUrl;

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
        if (!next.customization.roleIconUrl) {
          iconPayload = null; // cleared on purpose
        } else {
          const resolved = await resolveRoleIcon(next.customization.roleIconUrl);
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
                primary_color: next.customization.roleColor
                  ? Number.parseInt(next.customization.roleColor.slice(1), 16)
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

/** Everything the operator can change, for the response body. */
export type AppearanceSnapshot = {
  username: string;
  avatar: string | null;
  banner: string | null;
  bio: string;
};

/**
 * Reads what Discord currently holds, so the preview shows reality not intent.
 *
 * Returns raw hashes, not URLs: turning a hash into a CDN address is the one job
 * `userAvatarUrl` owns, and a second implementation here is how the animated-
 * avatar rule (`a_` hashes need `.gif`) would get forgotten in one of the two
 * places. The route resolves them on the way out.
 */
export async function fetchAppearanceSnapshot(token: string): Promise<AppearanceSnapshot> {
  const user = await requestJson<{ username: string; avatar: string | null; banner: string | null }>("/users/@me", {
    token,
    method: "GET"
  });
  // Advisory: the description is one field of the snapshot, and losing it must
  // not cost the caller the avatar and banner that did arrive.
  const application = await requestJson<{ description: string | null }>("/applications/@me", {
    token,
    method: "GET"
  }).catch(() => ({ description: null }));
  return {
    username: user.username,
    avatar: user.avatar,
    banner: user.banner,
    bio: application.description ?? ""
  };
}

/**
 * How long the bot's own profile is trusted.
 *
 * This read used to run on *every* `GET /api/bot/identity` with no cache at
 * all — two Discord calls, on an endpoint Discord rate-limits per application
 * rather than per route. Opening the identity screen fires that route beside
 * the per-guild one, and a second look (another tab, a refresh, a remount) paid
 * the same two calls again. That is the burst the 429 bar is made of.
 *
 * The values only change when the operator saves, and the save invalidates this
 * entry explicitly — so a minute is free correctness-wise, and the interval is
 * measured against the rate-limit window rather than against how fast the
 * profile can change.
 */
const APPEARANCE_CACHE_MS = 60_000;

/**
 * Keyed by bot token, because the token is what the request is authenticated
 * with. There is one bot today, but keying on the credential rather than on a
 * constant means a rotated token cannot be served the previous token's answer.
 */
const appearanceSnapshotCache = new TtlCache<string, AppearanceSnapshot>(APPEARANCE_CACHE_MS);

/**
 * The bot's profile, cached and coalesced.
 *
 * Returns null only when the read failed *and* nothing is cached. A failure
 * deliberately does not overwrite the cache: `TtlCache.resolve` serves the last
 * known snapshot and rethrows only when there is nothing to serve, so a
 * momentary Discord hiccup cannot blank the preview for a minute.
 */
export async function readAppearanceSnapshot(token: string): Promise<AppearanceSnapshot | null> {
  try {
    return await appearanceSnapshotCache.resolve(token, () => fetchAppearanceSnapshot(token));
  } catch {
    return null;
  }
}

/**
 * Drop the memoised profile after a write.
 *
 * Without this the screen would keep showing the old avatar for up to a minute
 * after a successful save — the "saved but not applied" confusion this project
 * treats as a defect, arriving from the cache instead of from Discord.
 */
export function invalidateAppearanceSnapshot() {
  appearanceSnapshotCache.clear();
}
