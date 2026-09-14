import { Globe, Server } from "lucide-react";
import { activityTypeLabels, botStatusDurations, botStatusLabels } from "@al-ai/core/browser";
import { STATUS_COLORS, StatusDot } from "@/components/status-picker";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { ActivityType, BotStatus, BotStatusDuration } from "@/types";

/**
 * A live preview of the bot as Discord will actually draw it.
 *
 * The point is to make the scope split visible instead of merely stated. The
 * avatar, banner, bio, status and activity are **global** — Discord gives an
 * application one of each, so they follow the bot into every server. The
 * nickname and the colour/icon of the bot's own role are **per guild**.
 *
 * An operator who sets a nickname thinking it renames the bot everywhere is the
 * predictable mistake, and a preview that shows both scopes together is what
 * prevents it.
 */

export type PreviewIdentity = {
  username: string;
  avatarDataUrl: string | null;
  bannerDataUrl: string | null;
  /**
   * The text fields are nullable because a stored row is the input here, and a
   * stored row is not a validated type: `bio` and `activity_text` are columns
   * that can hold NULL, and `status` is a column that can hold a value a later
   * version of Discord no longer recognises. Typing them as plain `string`
   * pushed the check onto the reader, where the cost of forgetting it is a
   * black screen rather than a blank line. They are normalised once below.
   */
  bio: string | null;
  status: BotStatus | null;
  activityType: ActivityType | null;
  activityText: string | null;
  /**
   * The chosen window, so the preview can show that a status is temporary.
   *
   * Optional because most callers have no window to report, and a required field
   * would force every one of them to invent a `null` — the kind of ceremony that
   * makes a type harder to read without making it safer.
   */
  statusDuration?: BotStatusDuration | null;
};

export type PreviewGuild = {
  nickname: string;
  roleColor: string | null;
  roleIconUrl: string | null;
  guildName: string;
  memberCount: number | null;
};

/**
 * How a status and an activity are spelled.
 *
 * Both come from `@al-ai/core/browser`, which is where the status picker beside
 * this preview already reads them. They used to be re-declared here, and the
 * two copies had already drifted: the preview said «لا تزعجني» and «غير مرئي»
 * while the menu two inches away said «لا تُزعجني» and «غير ظاهر». One status,
 * two words, on one screen — which is exactly what a second copy buys you.
 */

/**
 * How the chosen window reads beside the status.
 *
 * `forever` says so rather than showing nothing, because "no window" and "an
 * open-ended window" are different promises and the operator needs to tell them
 * apart when checking their work.
 */
function durationLabel(duration: BotStatusDuration | null | undefined): string | null {
  if (!duration) return null;
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
function knownStatus(value: BotStatus | null | undefined): BotStatus {
  return value && value in botStatusLabels ? value : "online";
}

export function statusLabel(status: BotStatus): string {
  return botStatusLabels[status] ?? botStatusLabels.online;
}

export function activityLabel(type: ActivityType): string {
  return activityTypeLabels[type] ?? activityTypeLabels.playing;
}

export function BotLivePreview({ identity, guild }: { identity: PreviewIdentity; guild: PreviewGuild }) {
  // Normalised once, at the point a stored row meets the DOM. `status` is read
  // as a lookup key and `bio`/`activityText` are trimmed, so a missing value
  // would be a TypeError rather than a blank line — and a presentational
  // component that throws takes the whole screen with it.
  const status = knownStatus(identity.status);
  const activityType = identity.activityType ?? "playing";
  const bio = (identity.bio ?? "").trim();
  const activityText = (identity.activityText ?? "").trim();

  // A nickname of only spaces is not a nickname: Discord stores it but draws
  // nothing, so the row would read as an unnamed bot.
  const nickname = guild.nickname.trim();
  const displayName = nickname || identity.username;
  const roleColor = guild.roleColor && /^#[0-9a-f]{6}$/i.test(guild.roleColor) ? guild.roleColor : null;

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------------- *
       * The profile card — what a member sees when they click the bot.
       * ---------------------------------------------------------------- */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div
          className="relative aspect-[5/2] w-full"
          style={
            identity.bannerDataUrl
              ? { backgroundImage: `url(${identity.bannerDataUrl})`, backgroundSize: "cover", backgroundPosition: "center" }
              : { backgroundColor: roleColor ?? "#4e5058" }
          }
        >
          {!identity.bannerDataUrl ? (
            <span className="absolute inset-0 grid place-items-center text-xs text-white/70">لا يوجد بانر</span>
          ) : null}
        </div>

        <div className="relative px-4 pb-4">
          <div className="-mt-10 mb-3 flex items-end justify-between">
            <div className="relative">
              <Avatar className="size-20 border-4 border-card">
                {identity.avatarDataUrl ? <AvatarImage src={identity.avatarDataUrl} alt="الأفاتار" /> : null}
                <AvatarFallback className="text-lg">AI</AvatarFallback>
              </Avatar>
              <span
                className="absolute end-1 bottom-1 size-5 rounded-full border-[3px] border-card"
                style={{ backgroundColor: STATUS_COLORS[status] }}
                title={statusLabel(status)}
              />
            </div>
            <Badge variant="secondary" className="mb-1 gap-1">
              {/* The same glyph the picker draws, so the preview cannot show a
                  green disc for a status the menu renders as a crescent. */}
              <StatusDot status={status} size={9} maskColor="currentColor" />
              {statusLabel(status)}
              {durationLabel(identity.statusDuration) ? (
                <span className="text-muted-foreground">· {durationLabel(identity.statusDuration)}</span>
              ) : null}
            </Badge>
          </div>

          <div className="space-y-1">
            <p className="font-semibold" style={{ color: roleColor ?? undefined }}>
              {displayName}
            </p>
            {activityText ? (
              <p className="text-sm text-muted-foreground">
                {activityLabel(activityType)} <span className="text-foreground">{activityText}</span>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">لا يوجد نشاط ظاهر</p>
            )}
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
        <p className="mb-2 text-xs font-medium text-muted-foreground">
          كما يظهر في قائمة أعضاء «{guild.guildName}»
        </p>
        <div className="flex items-center gap-2 rounded-md bg-accent/40 px-2 py-1.5">
          <div className="relative">
            <Avatar className="size-8">
              {identity.avatarDataUrl ? <AvatarImage src={identity.avatarDataUrl} alt="" /> : null}
              <AvatarFallback className="text-xs">AI</AvatarFallback>
            </Avatar>
            <span
              className="absolute -end-0.5 -bottom-0.5 size-3 rounded-full border-2 border-card"
              style={{ backgroundColor: STATUS_COLORS[status] }}
            />
          </div>
          <span className="truncate text-sm font-medium" style={{ color: roleColor ?? undefined }}>
            {displayName}
          </span>
          {guild.roleIconUrl ? (
            <Avatar className="size-4">
              <AvatarImage src={guild.roleIconUrl} alt="أيقونة الرتبة" />
              <AvatarFallback className="text-[8px]">R</AvatarFallback>
            </Avatar>
          ) : null}
          <span className="ms-auto shrink-0 text-xs text-muted-foreground">
            {guild.memberCount === null ? "" : `${guild.memberCount} عضو`}
          </span>
        </div>
      </div>

      {/* ---------------------------------------------------------------- *
       * The scope legend — the part operators get wrong.
       * ---------------------------------------------------------------- */}
      <div className="space-y-2 rounded-xl border border-border bg-muted/30 p-3 text-xs">
        <div className="flex gap-2">
          <Globe className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">عالمي (كل السيرفرات):</span>{" "}
            الصورة الرمزية، البانر، النبذة، الحالة والنشاط
          </p>
        </div>
        <div className="flex gap-2">
          <Server className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
          <p className="text-muted-foreground">
            <span className="font-medium text-foreground">هذا السيرفر فقط:</span>{" "}
            الاسم المستعار، ولون وأيقونة رتبة AL AI
          </p>
        </div>
      </div>
    </div>
  );
}

/**
 * The footer under the preview that says where the settings will land.
 *
 * Kept separate from the preview itself so the preview can be rendered on its
 * own in tests, and so the advisory wording can change without touching layout.
 */
export function PreviewGuildFooter({
  guildName,
  hasUnsavedChanges
}: {
  guildName: string;
  hasUnsavedChanges: boolean;
}) {
  return (
    <p className={cn("text-xs", hasUnsavedChanges ? "text-amber-500" : "text-muted-foreground")}>
      {hasUnsavedChanges
        ? `المعاينة تعكس تعديلاتك غير المحفوظة على «${guildName}».`
        : `المعاينة تطابق ما هو محفوظ حالياً في «${guildName}».`}
    </p>
  );
}
