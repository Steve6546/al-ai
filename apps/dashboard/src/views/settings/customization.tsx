import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, IdCard, Loader2, Lock, Palette, Pencil, TriangleAlert, Upload, X } from "lucide-react";
import {
  DEFAULT_CUSTOMIZATION,
  MAX_BIO_LENGTH,
  MAX_IMAGE_DATA_URL_LENGTH,
  MAX_NICKNAME_LENGTH
} from "@al-ai/core/browser";
import { api } from "@/api";
import { useI18n, type Translate } from "@/lib/i18n";
import { useDraftForm } from "@/lib/use-draft-form";
import { cn } from "@/lib/utils";
import { Toaster, useToasts } from "@/components/toaster";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { BotLivePreview } from "@/views/settings/bot-preview";
import type { CustomizationSettings, Guild, GuildProfileSnapshot, PermissionStatus, RoleIconGate } from "@/types";

/**
 * The bot's profile in ONE server — now an interactive card, not a form.
 *
 * The side form is gone. The preview card *is* the editor: an «تعديل» button
 * turns it on, and then the picture and the banner are click targets, the name
 * and the bio are inline fields, and the role colour opens a picker — all in
 * place. Every change is written to the server in the background, debounced, so
 * there is no save bar to forget and no draft to lose.
 *
 * What is NOT here is deliberate: the presence lives on the bot's gateway
 * connection and is identical in every server, so it keeps its own screen.
 */

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

/** Discord's own minimums, used to *warn* rather than to refuse. */
const AVATAR_MIN_SIDE = 256;
const BANNER_MIN_SIZE = { width: 600, height: 240 };

/** How long to wait after the last keystroke before writing. */
const AUTO_SAVE_MS = 700;

type ReadImage = { dataUrl: string; width: number; height: number };

/** Reads an image file into a capped base64 data URL, or fails with a reason. */
function readImageAsDataUrl(file: File, t: Translate): Promise<ReadImage> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error(t("customization.imageNotImage")));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
        reject(new Error(t("customization.imageTooLarge")));
        return;
      }
      const image = new Image();
      image.onload = () => resolve({ dataUrl, width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => reject(new Error(t("customization.imageUndecodable")));
      image.src = dataUrl;
    };
    reader.onerror = () => reject(new Error(t("customization.imageReadFailed")));
    reader.readAsDataURL(file);
  });
}

/** The first candidate that is actually an image address (skips empty strings). */
function firstImage(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return null;
}

export function CustomizationView({ guild }: { guild: Guild }) {
  const { t } = useI18n();
  const [guildSettings, setGuildSettings] = useState<CustomizationSettings | null>(null);
  const guildForm = useDraftForm(guildSettings);

  const [profile, setProfile] = useState<GuildProfileSnapshot | null>(null);
  const [permissions, setPermissions] = useState<PermissionStatus[]>([]);
  const [roleIcon, setRoleIcon] = useState<RoleIconGate | null>(null);

  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);
  const [imageWarning, setImageWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingTarget = useRef<"avatar" | "banner" | "roleIcon">("avatar");
  const { toasts, push, dismiss } = useToasts();

  useEffect(() => {
    let cancelled = false;
    setGuildSettings(null);
    setProfile(null);
    setRoleIcon(null);
    setError(null);
    setEditing(false);

    api
      .customization(guild.id)
      .then(result => {
        if (cancelled) return;
        setGuildSettings(result.settings);
        setPermissions(result.permissions);
        setRoleIcon(result.roleIcon);
        setProfile(result.profile ?? null);
      })
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : t("customization.loadFailed")));

    return () => {
      cancelled = true;
    };
  }, [guild.id, t]);

  const preview = useMemo(() => {
    const draft = guildForm.draft ?? guildForm.saved ?? DEFAULT_CUSTOMIZATION;
    const enabled = draft.enabled;
    return {
      username: profile?.username ?? "AL AI",
      nickname: enabled ? draft.nickname : "",
      serverAvatarDataUrl: enabled ? firstImage(draft.avatarDataUrl) : null,
      serverBannerDataUrl: enabled ? firstImage(draft.bannerDataUrl) : null,
      accountAvatarUrl: profile?.accountAvatarUrl ?? null,
      accountBannerUrl: profile?.accountBannerUrl ?? null,
      bio: enabled ? draft.bio : "",
      roleColor: draft.roleColor,
      roleIconUrl: draft.roleIconUrl
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildForm.draft, guildForm.saved, profile]);

  /* ---------------- auto-save ---------------- *
   * Every hook lives above the loading/error returns: a hook after an early
   * return is the "rendered more hooks than the previous render" crash, and a
   * screen with a loading state is exactly where that hides until data lands.
   */
  const inFlight = useRef(false);
  const queued = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persist = useCallback(async () => {
    if (inFlight.current) {
      queued.current = true;
      return;
    }
    const snapshot = guildForm.draft;
    if (!snapshot) return;
    inFlight.current = true;
    setSaving(true);
    try {
      const payload: Partial<CustomizationSettings> = { ...snapshot };
      // A locked icon is omitted, never echoed: the server reads an absent field
      // as "leave it alone" and a null as "clear it".
      if (roleIcon?.locked) delete payload.roleIconUrl;
      const result = await api.saveCustomization(guild.id, payload);
      // Rebase the saved value only — a save that resolves mid-edit must not
      // overwrite what the operator has typed since it was sent.
      guildForm.rebaseSaved(result.settings);
      void api
        .customization(guild.id)
        .then(next => setProfile(next.profile ?? null))
        .catch(() => undefined);
    } catch (cause) {
      push({
        tone: "error",
        title: t("customization.autoSaveFailed"),
        description: cause instanceof Error ? cause.message : undefined
      });
    } finally {
      inFlight.current = false;
      setSaving(false);
      if (queued.current) {
        queued.current = false;
        void persist();
      }
    }
  }, [guild.id, guildForm.draft, guildForm.rebaseSaved, roleIcon, push, t]);

  useEffect(() => {
    if (!guildForm.dirty || saving) return;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void persist(), AUTO_SAVE_MS);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [guildForm.draft, guildForm.dirty, saving, persist]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!guildForm.saved || !guildForm.draft) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        {t("common.loading")}
      </div>
    );
  }

  const { draft, patch, dirty } = guildForm;

  const memberPermission = permissions.find(item => item.key === "change_nickname");
  const memberBlocked = memberPermission?.granted === false;
  const memberEditable = guild.canManageIdentity && !memberBlocked && draft.enabled;
  const roleEditable = guild.canManageIdentity;
  const permissionsUnreadable = permissions.length > 0 && permissions.every(permission => permission.granted === null);

  /* ---------------- image picking ---------------- */
  const openPicker = (target: "avatar" | "banner" | "roleIcon") => {
    pendingTarget.current = target;
    fileInputRef.current?.click();
  };

  const onFileChosen = async (file: File | undefined) => {
    if (!file) return;
    try {
      const image = await readImageAsDataUrl(file, t);
      const target = pendingTarget.current;
      if (target === "avatar") {
        patch({ avatarDataUrl: image.dataUrl });
        setImageWarning(
          image.width < AVATAR_MIN_SIDE || image.height < AVATAR_MIN_SIDE
            ? t("customization.avatarTooSmall", { width: image.width, height: image.height })
            : null
        );
      } else if (target === "banner") {
        patch({ bannerDataUrl: image.dataUrl });
        setImageWarning(
          image.width < BANNER_MIN_SIZE.width || image.height < BANNER_MIN_SIZE.height
            ? t("customization.bannerTooSmall", { width: image.width, height: image.height })
            : null
        );
      } else {
        patch({ roleIconUrl: image.dataUrl });
        setImageWarning(null);
      }
    } catch (cause) {
      push({ tone: "error", title: cause instanceof Error ? cause.message : t("customization.imageReadFailed") });
    }
  };

  return (
    <div className="mx-auto w-full max-w-2xl space-y-4 pb-24">
      <Toaster toasts={toasts} onDismiss={dismiss} />

      <input
        ref={fileInputRef}
        type="file"
        accept={IMAGE_ACCEPT}
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={event => {
          void onFileChosen(event.target.files?.[0]);
          event.target.value = "";
        }}
      />

      {/* Header: the scope sentence, the master switch, and the Edit toggle. */}
      <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
        <p className="min-w-0 text-xs text-muted-foreground">{t("customization.subtitle")}</p>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("customization.enable")}</span>
            <Switch
              checked={draft.enabled}
              onCheckedChange={enabled => patch({ enabled })}
              aria-label={t("customization.enable")}
            />
          </label>
          <Button
            type="button"
            size="sm"
            variant={editing ? "default" : "outline"}
            onClick={() => setEditing(value => !value)}
            className="gap-1.5"
            aria-pressed={editing}
          >
            {editing ? <Check className="size-4" /> : <Pencil className="size-4" />}
            {editing ? t("customization.done") : t("customization.edit")}
          </Button>
        </div>
      </div>

      {!draft.enabled && (
        <Alert>
          <IdCard className="size-4" />
          <AlertDescription>{t("customization.disabledBody")}</AlertDescription>
        </Alert>
      )}

      {memberBlocked && (
        <Alert variant="destructive">
          <Lock className="size-4" />
          <AlertDescription>{t("customization.noPermission")}</AlertDescription>
        </Alert>
      )}

      {/* The card — the whole page. */}
      <Card className="border-primary/20 bg-card/70 shadow-lg shadow-primary/5 backdrop-blur-sm">
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            <span>{t("customization.previewTitle")}</span>
            {saving ? (
              <span className="flex items-center gap-1 text-[11px] font-normal text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" />
                {t("common.saving")}
              </span>
            ) : null}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <BotLivePreview
            profile={preview}
            guildName={guild.name}
            memberCount={guild.memberCount}
            enabled={draft.enabled}
            pending={dirty}
            editable={editing && memberEditable}
            onPickAvatar={() => openPicker("avatar")}
            onPickBanner={() => openPicker("banner")}
            onNicknameChange={value => patch({ nickname: value })}
            onBioChange={value => patch({ bio: value })}
            onRoleColorChange={value => patch({ roleColor: value })}
            nicknameMax={MAX_NICKNAME_LENGTH}
            bioMax={MAX_BIO_LENGTH}
          />
          {imageWarning ? (
            <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {imageWarning}
            </p>
          ) : null}
          <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">{t("customization.presenceNote")}</p>
        </CardContent>
      </Card>

      {/* The one card kept beside the preview: the role icon, which is not part
          of the profile card Discord draws. */}
      <Card className={cn(!draft.enabled && "opacity-70")}>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Palette className="size-4" />
            {t("customization.roleIcon")}
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="space-y-1">
              <Label className="flex items-center gap-1.5 text-xs">
                {t("customization.roleIcon")}
                {roleIcon?.locked ? (
                  <Badge variant="outline" className="gap-1 text-[10px]" title={roleIcon.reason ?? undefined}>
                    <Lock className="size-3" />
                    {t("customization.locked")}
                  </Badge>
                ) : null}
              </Label>
              {roleIcon?.locked ? (
                <p className="max-w-sm text-[11px] text-muted-foreground">
                  {roleIcon.reason ?? t("customization.roleIconLocked")}
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">{t("customization.roleIconHint")}</p>
              )}
            </div>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={roleIcon?.locked || !roleEditable}
                onClick={() => openPicker("roleIcon")}
              >
                <Upload className="size-3.5" /> {t("customization.chooseIcon")}
              </Button>
              {draft.roleIconUrl ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={draft.roleIconUrl} alt="" className="size-8 rounded-lg object-cover" />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="size-8 hover:text-destructive"
                    aria-label={t("customization.removeRoleIcon")}
                    disabled={roleIcon?.locked || !roleEditable}
                    onClick={() => patch({ roleIconUrl: null })}
                  >
                    <X />
                  </Button>
                </>
              ) : null}
            </div>
          </div>

          {permissionsUnreadable ? (
            <p className="text-[11px] text-muted-foreground">{t("customization.permissionsUnreadable")}</p>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
