import { useEffect, useState, type ReactNode } from "react";
import { activityTypeLabels, activityTypeShortLabels, botStatusDurations, botStatusLabels } from "@al-ai/core/browser";
import { Separator } from "@/components/ui/separator";
import { useI18n, type Language, type Translate, type TranslationKey } from "@/lib/i18n";
import type { ActivityType, BotStatus, BotStatusDuration } from "@/types";

/**
 * A live preview of the bot as Discord draws it *in one server*.
 *
 * Everything it draws is the guild's: the nickname, the picture, the banner, the
 * bio and the role's colour and icon all reach this server and nowhere else. The
 * two account values it can fall back to are here for one reason — they are what
 * members see where this server has no override — and they are drawn, never
 * offered: nothing on the identity screen can write them.
 *
 * The account picture winning over the server's would be the wrong way round,
 * and the server picture winning is what Discord does — so the operator sees the
 * face their own members see, not the account default.
 *
 * The presence is deliberately absent. A status is set on the bot's gateway
 * connection and is the same in every server, so it is edited on its own screen
 * and this card says so rather than drawing a status dot nothing here can change.
 *
 * Every field is bound to a draft, never to storage, so the card answers the
 * instant something is typed or picked. When a value is missing the card says so
 * ("لا يوجد غلاف", "لا توجد نبذة") rather than leaving a blank — an empty box is
 * indistinguishable from a broken one.
 */

export type PreviewProfile = {
  username: string;
  /** The nickname typed on this screen. Empty means "the account's own name". */
  nickname: string;
  /** The picture uploaded for THIS server, or null. */
  serverAvatarDataUrl: string | null;
  /** The banner uploaded for THIS server, or null. */
  serverBannerDataUrl: string | null;
  /** What members see where this server has no override, or null. */
  accountAvatarUrl: string | null;
  accountBannerUrl: string | null;
  /**
   * Nullable because a stored row is the input here, and a stored row is not a
   * validated type: `bio` is a column that can hold NULL, and a column can hold
   * a value a later version of Discord no longer recognises. Typing it as a
   * plain `string` pushed the check onto the reader, where the cost of
   * forgetting it is a black screen rather than a blank line. Normalised once
   * below.
   */
  bio: string | null;
  roleColor: string | null;
  roleIconUrl: string | null;
};

/**
 * How a status and an activity are spelled.
 *
 * Both come from `@al-ai/core/browser`, which is where the presence screen's
 * pickers already read them. They used to be re-declared here, and the two
 * copies had already drifted: the preview said «لا تزعجني» and «غير مرئي» while
 * the menu two inches away said «مشغول» and «غير ظاهر». One status, two words,
 * on one screen — which is exactly what a second copy buys you.
 */
export function durationLabel(
  duration: BotStatusDuration | null | undefined,
  t?: Translate
): string | null {
  if (!duration) return null;
  if (t) return t(`presence.duration.${duration}` as TranslationKey);
  return botStatusDurations.find(entry => entry.id === duration)?.label ?? null;
}

/**
 * A status Discord still recognises, or `online`.
 *
 * A stored row can carry a value a later version of Discord dropped, and this
 * value is used as a lookup key for both the colour and the label. Resolving it
 * once keeps those two from disagreeing — and stops an unknown string from
 * indexing a record that has no entry for it.
 */
export function statusLabel(status: BotStatus, t?: Translate): string {
  if (t) return t(`presence.status.${status}` as TranslationKey);
  return botStatusLabels[status] ?? botStatusLabels.online;
}

export function activityLabel(type: ActivityType, t?: Translate): string {
  if (t) return t(`presence.kind.${type}` as TranslationKey);
  return activityTypeShortLabels[type] ?? activityTypeShortLabels.playing;
}

/**
 * The activity kind as the summary line spells it.
 *
 * Arabic keeps Discord's own term beside the verb — «يستمع إلى (Listening)» —
 * so a sentence that begins with the kind reads unambiguously. English does not
 * need the gloss: «Listening to السجلات» already says which kind it is, and a
 * trailing «(Listening)» would repeat the verb the operator just read.
 */
export function activitySummaryLabel(type: ActivityType, t: Translate, language: Language): string {
  if (language === "ar") return activityTypeLabels[type] ?? activityTypeLabels.playing;
  return activityLabel(type, t);
}

/**
 * The avatar, drawn the moment it has a source.
 *
 * This deliberately does not use Radix's `Avatar.Image`, which holds the
 * picture back until it has *loaded* and shows the fallback meanwhile. That is
 * the right behaviour for a member list and the wrong one for a preview whose
 * entire job is to answer "is my new picture showing yet?" — and it made the
 * drawn avatar invisible to any test that never loads an image, which is every
 * test in this repository.
 *
 * The fallback is now reserved for a source that actually failed, and the
 * failure flag resets when the source changes: without that, replacing a bad
 * URL with a good one would leave the initials on screen forever.
 */
function PreviewAvatar({
  src,
  alt,
  wrapperClassName,
  imageClassName,
  fallbackClassName,
  fallbackText = "AI"
}: {
  src: string | null;
  alt: string;
  wrapperClassName: string;
  imageClassName: string;
  fallbackClassName: string;
  fallbackText?: string;
}) {
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [src]);

  return (
    <span className={wrapperClassName}>
      {src && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={alt} className={imageClassName} onError={() => setBroken(true)} />
      ) : (
        <span className={fallbackClassName}>{fallbackText}</span>
      )}
    </span>
  );
}

/** One `label — value` row of the summary block under the card. */
function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1">
      <span className="shrink-0 text-[11px] text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-end text-[11px] font-medium">{children}</span>
    </div>
  );
}

export function BotLivePreview({
  profile,
  guildName,
  memberCount,
  enabled = true,
  pending = false
}: {
  profile: PreviewProfile;
  guildName: string;
  memberCount: number | null;
  /** False while the master switch is off, when Discord shows the defaults. */
  enabled?: boolean;
  /** True while the draft differs from what is stored - nothing is saved yet. */
  pending?: boolean;
}) {
  const { t } = useI18n();

  /*
   * The same resolution Discord walks, for both pictures.
   *
   * A server profile is a set of *overrides* laid on the account's own profile,
   * so where this server has set nothing, members see the account's value. That
   * is true of the avatar and of the banner alike, and the card draws both the
   * same way.
   *
   * The banner used to be the exception — it was left blank while the avatar
   * fell back — which read as "this bot has no banner" for a bot that plainly
   * has one, and was a rule nothing in Discord actually applies. The slot still
   * says so out loud when *neither* level has a banner, because an empty box is
   * indistinguishable from a broken one.
   */
  const serverAvatar = profile.serverAvatarDataUrl ?? null;
  const serverBanner = profile.serverBannerDataUrl ?? null;
  const avatar = serverAvatar ?? profile.accountAvatarUrl;
  const banner = serverBanner ?? profile.accountBannerUrl;

  // Normalised once, at the point a stored row meets the DOM: `bio` is trimmed
  // and would be a TypeError if it arrived as a non-string, and a presentational
  // component that throws takes the whole screen with it.
  const bio = (profile.bio ?? "").trim();
  const nickname = profile.nickname.trim();
  const displayName = nickname || profile.username;
  const roleColor = profile.roleColor && /^#[0-9a-f]{6}$/i.test(profile.roleColor) ? profile.roleColor : null;

  return (
    <div className="space-y-3">
      {!enabled ? (
        <p className="rounded-lg border border-border bg-muted/40 px-2.5 py-1.5 text-[11px] text-muted-foreground">
          {t("preview.disabled")}
        </p>
      ) : null}

      {/*
        The preview shows the *draft*, so it is ahead of Discord until the save
        succeeds. Saying so is the difference between "this is what your members
        will see" and "this is what they will see once you save".
      */}
      {pending ? (
        <p className="rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning">
          {t("preview.pending")}
        </p>
      ) : null}

      {/* ---------------------------------------------------------------- *
       * The profile card — what a member sees when they click the bot.
       * ---------------------------------------------------------------- */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div
          className="relative aspect-[5/2] w-full"
          style={
            banner
              ? { backgroundImage: `url(${banner})`, backgroundSize: "cover", backgroundPosition: "center" }
              : { backgroundColor: roleColor ?? "#4e5058" }
          }
        >
          {!banner ? <span className="absolute inset-0 grid place-items-center text-[11px] text-white/70">{t("preview.noBanner")}</span> : null}
        </div>

        <div className="relative px-4 pb-4">
          <div className="-mt-10 mb-3 flex items-end justify-between gap-2">
            <PreviewAvatar
              src={avatar}
              alt={t("preview.avatarAlt")}
              wrapperClassName="block size-20 overflow-hidden rounded-full border-4 border-card bg-muted"
              imageClassName="size-full object-cover"
              fallbackClassName="grid size-full place-items-center text-lg font-semibold text-muted-foreground"
            />
          </div>

          <div className="space-y-1">
            <p className="font-semibold" style={{ color: roleColor ?? undefined }}>
              {displayName}
            </p>
            <p className="text-sm text-muted-foreground">
              {t("preview.memberOf")} <span className="text-foreground">{guildName}</span>
            </p>
          </div>

          {bio ? (
            <>
              <Separator className="my-3" />
              <p className="text-sm whitespace-pre-wrap text-muted-foreground">{bio}</p>
            </>
          ) : null}
        </div>
      </div>

      {/* ---------------------------------------------------------------- *
       * The member list — where the per-guild values are what people see.
       * ---------------------------------------------------------------- */}
      <div className="rounded-xl border border-border bg-card p-3">
        <p className="mb-2 text-xs font-medium text-muted-foreground">{t("preview.inMemberList", { guild: guildName })}</p>
        <div className="flex items-center gap-2 rounded-md bg-accent/40 px-2 py-1.5">
          <PreviewAvatar
            src={avatar}
            alt=""
            wrapperClassName="block size-8 shrink-0 overflow-hidden rounded-full bg-muted"
            imageClassName="size-full object-cover"
            fallbackClassName="grid size-full place-items-center text-xs font-semibold text-muted-foreground"
          />
          <span className="truncate text-sm font-medium" style={{ color: roleColor ?? undefined }}>
            {displayName}
          </span>
          {profile.roleIconUrl ? (
            <PreviewAvatar
              src={profile.roleIconUrl}
              alt={t("preview.roleIconAlt")}
              wrapperClassName="block size-4 shrink-0 overflow-hidden rounded-full bg-muted"
              imageClassName="size-full object-cover"
              fallbackClassName="grid size-full place-items-center text-[8px] font-semibold text-muted-foreground"
              fallbackText="R"
            />
          ) : null}
          <span className="ms-auto shrink-0 text-xs text-muted-foreground">
            {memberCount === null ? "" : t("preview.memberCount", { count: memberCount })}
          </span>
        </div>
      </div>

      {/* ---------------------------------------------------------------- *
       * The resolved values, in one place.
       *
       * The card above shows what members see; this block states it in words,
       * which is what makes a missing value impossible to miss rather than
       * merely hard to spot in a small disc. It stays deliberately short: the
       * preview is pinned beside a long form, and a column taller than the
       * viewport has nowhere to stick.
       * ---------------------------------------------------------------- */}
      <div className="rounded-xl border border-border bg-card px-3 py-1">
        <InfoRow label={t("preview.displayName")}>{displayName}</InfoRow>
        <InfoRow label={t("preview.bio")}>{bio ? t("preview.saved") : <span className="text-muted-foreground">{t("preview.none")}</span>}</InfoRow>
        <InfoRow label={t("preview.image")}>
          {serverAvatar ? (
            t("preview.serverAvatar")
          ) : profile.accountAvatarUrl ? (
            <span className="text-muted-foreground">{t("preview.accountAvatar")}</span>
          ) : (
            <span className="text-muted-foreground">{t("preview.defaultAvatar")}</span>
          )}
        </InfoRow>
        <InfoRow label={t("preview.banner")}>
          {serverBanner ? (
            t("preview.serverBanner")
          ) : profile.accountBannerUrl ? (
            <span className="text-muted-foreground">{t("preview.accountBanner")}</span>
          ) : (
            <span className="text-muted-foreground">{t("preview.none")}</span>
          )}
        </InfoRow>
        <InfoRow label={t("preview.roleColor")}>
          {roleColor ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block size-3 rounded-full border border-border" style={{ backgroundColor: roleColor }} />
              <span dir="ltr">{roleColor}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">{t("preview.default")}</span>
          )}
        </InfoRow>
      </div>
    </div>
  );
}
