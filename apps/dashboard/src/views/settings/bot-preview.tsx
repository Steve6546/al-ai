import { Globe, Server } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import type { ActivityType, BotStatus } from "@/types";

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
  bio: string;
  status: BotStatus;
  activityType: ActivityType;
  activityText: string;
};

export type PreviewGuild = {
  nickname: string;
  roleColor: string | null;
  roleIconUrl: string | null;
  guildName: string;
  memberCount: number | null;
};

/**
 * Discord spells the activity as a verb, not an enum name.
 *
 * Kept as a lookup rather than a switch so the preview and any other reader
 * cannot disagree about an activity type added later.
 */
const ACTIVITY_LABELS: Record<ActivityType, string> = {
  playing: "يلعب",
  listening: "يستمع إلى",
  watching: "يشاهد",
  competing: "يتنافس في"
};

const STATUS_LABELS: Record<BotStatus, string> = {
  online: "متصل",
  idle: "خامل",
  dnd: "لا تزعجني",
  invisible: "غير مرئي"
};

/** The dot Discord paints on the avatar — same colours, same meaning. */
const STATUS_DOTS: Record<BotStatus, string> = {
  online: "#23a55a",
  idle: "#f0b232",
  dnd: "#f23f43",
  invisible: "#80848e"
};

export function statusLabel(status: BotStatus): string {
  return STATUS_LABELS[status] ?? STATUS_LABELS.online;
}

export function activityLabel(type: ActivityType): string {
  return ACTIVITY_LABELS[type] ?? ACTIVITY_LABELS.playing;
}

export function BotLivePreview({ identity, guild }: { identity: PreviewIdentity; guild: PreviewGuild }) {
  // A nickname of only spaces is not a nickname: Discord stores it but draws
  // nothing, so the row would read as an unnamed bot.
  const nickname = guild.nickname.trim();
  const displayName = nickname || identity.username;
  const roleColor = guild.roleColor && /^#[0-9a-f]{6}$/i.test(guild.roleColor) ? guild.roleColor : null;
  const activityText = identity.activityText.trim();

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------------- *
       * The profile card — what a member sees when they click the bot.
       * ---------------------------------------------------------------- */}
      <div className="overflow-hidden rounded-xl border border-border bg-card">
        <div
          className="relative h-24 w-full"
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
                style={{ backgroundColor: STATUS_DOTS[identity.status] ?? STATUS_DOTS.online }}
                title={statusLabel(identity.status)}
              />
            </div>
            <Badge variant="secondary" className="mb-1">
              {statusLabel(identity.status)}
            </Badge>
          </div>

          <div className="space-y-1">
            <p className="font-semibold" style={{ color: roleColor ?? undefined }}>
              {displayName}
            </p>
            {activityText ? (
              <p className="text-sm text-muted-foreground">
                {activityLabel(identity.activityType)} <span className="text-foreground">{activityText}</span>
              </p>
            ) : (
              <p className="text-sm text-muted-foreground">لا يوجد نشاط ظاهر</p>
            )}
          </div>

          {identity.bio.trim() ? (
            <>
              <Separator className="my-3" />
              <p className="text-sm whitespace-pre-wrap text-muted-foreground">{identity.bio}</p>
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
              style={{ backgroundColor: STATUS_DOTS[identity.status] ?? STATUS_DOTS.online }}
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
