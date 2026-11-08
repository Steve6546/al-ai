import { useEffect, useMemo, useRef, useState } from "react";
import { Check, IdCard, Loader2, Lock, Palette, Pencil, TriangleAlert, Upload, X } from "lucide-react";
import {
  DEFAULT_CUSTOMIZATION,
  MAX_BIO_LENGTH,
  MAX_IMAGE_UPLOAD_BYTES,
  MAX_NICKNAME_LENGTH,
  describeAppearanceResult
} from "@al-ai/core/browser";
import { api } from "@/api";
import { useI18n, type Translate } from "@/lib/i18n";
import { useDraftForm } from "@/lib/use-draft-form";
import { fitImageUnder } from "@/lib/image-fit";
import { cn } from "@/lib/utils";
import { SaveBar } from "@/components/save-bar";
import { Toaster, useToasts } from "@/components/toaster";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { BotLivePreview } from "@/views/settings/bot-preview";
import type { CustomizationSettings, Guild, GuildProfileSnapshot, PermissionStatus, RoleIconGate } from "@/types";

/**
 * The bot's profile in ONE server — an interactive card, saved the project's way.
 *
 * The side form is gone. The preview card *is* the editor: an «تعديل» button
 * turns it on, and then the picture and the banner are click targets, the name
 * and the bio are inline fields, and the role colour opens a picker — all in
 * place. Nothing is written until the operator presses «حفظ التعديلات» on the
 * same unsaved-changes bar every other settings screen uses, and «إلغاء» puts
 * the card back. The card is a *draft*; the bar is the commit.
 *
 * What is NOT here is deliberate: the presence lives on the bot's gateway
 * connection and is identical in every server, so it keeps its own screen.
 */

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

/** Discord's own minimums, used to *warn* rather than to refuse. */
const AVATAR_MIN_SIDE = 256;
const BANNER_MIN_SIZE = { width: 600, height: 240 };

type ReadImage = { dataUrl: string; width: number; height: number };

/**
 * The picked file as a data URL inside the image budget.
 *
 * A file that fits is stored byte-for-byte; a larger one is re-encoded down to
 * the budget instead of being refused — the operator picked a picture, not a
 * file size, and a phone photo is 3–8 MB by default. Only an animated GIF over
 * the budget is refused, because shrinking it would silently drop the motion.
 */
async function readImageAsDataUrl(file: File, t: Translate): Promise<ReadImage> {
  if (!file.type.startsWith("image/")) {
    throw new Error(t("customization.imageNotImage"));
  }
  try {
    const fitted = await fitImageUnder(file, MAX_IMAGE_UPLOAD_BYTES);
    return { dataUrl: fitted.dataUrl, width: fitted.width, height: fitted.height };
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : "";
    if (reason === "animated-gif-too-large") throw new Error(t("customization.gifTooLarge"));
    if (reason === "cannot-fit") throw new Error(t("customization.imageTooLarge"));
    throw new Error(t("customization.imageUndecodable"));
  }
}

/** The pixel size of a data URL, for the same minimum-size warning a file gets. */
function measureDataUrl(dataUrl: string): Promise<{ width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
    image.onerror = () => reject(new Error("undecodable"));
    image.src = dataUrl;
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

  const [editing, setEditing] = useState(false);
  const [imageWarning, setImageWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingTarget = useRef<"avatar" | "banner" | "roleIcon">("avatar");
  // Which picture the picker is open for, and what has been typed into it.
  const [picker, setPicker] = useState<"avatar" | "banner" | "roleIcon" | null>(null);
  const [imageUrl, setImageUrl] = useState("");
  const [urlBusy, setUrlBusy] = useState(false);
  const [urlError, setUrlError] = useState<string | null>(null);
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

  const { draft, patch, dirty, reset, commit } = guildForm;

  const memberPermission = permissions.find(item => item.key === "change_nickname");
  const memberBlocked = memberPermission?.granted === false;
  const memberEditable = guild.canManageIdentity && !memberBlocked && draft.enabled;
  const roleEditable = guild.canManageIdentity;
  // The colour is a role write: without Manage Roles the bot cannot perform it,
  // so the picker is disabled rather than offering a save the server refuses.
  const roleColorLocked = permissions.find(item => item.key === "manage_roles")?.granted === false;
  const permissionsUnreadable = permissions.length > 0 && permissions.every(permission => permission.granted === null);

  /* ---------------- image picking ---------------- */
  const openPicker = (target: "avatar" | "banner" | "roleIcon") => {
    pendingTarget.current = target;
    setImageUrl("");
    setUrlError(null);
    setPicker(target);
  };

  const closePicker = () => {
    setPicker(null);
    setUrlBusy(false);
    setUrlError(null);
  };

  /** Hands over to the OS file dialog; the picker has done its job by then. */
  const chooseFile = () => {
    setPicker(null);
    fileInputRef.current?.click();
  };

  /**
   * Writes the chosen picture into the draft — the one path both sources use.
   *
   * The draft, not the saved row: the card behind the dialog is the live
   * preview, so patching here is what makes a pasted link appear *before* the
   * save bar is pressed, exactly as a picked file already did.
   */
  const applyImage = (target: "avatar" | "banner" | "roleIcon", dataUrl: string, size: { width: number; height: number } | null) => {
    if (target === "avatar") {
      patch({ avatarDataUrl: dataUrl });
      setImageWarning(
        size && (size.width < AVATAR_MIN_SIDE || size.height < AVATAR_MIN_SIDE)
          ? t("customization.avatarTooSmall", { width: size.width, height: size.height })
          : null
      );
    } else if (target === "banner") {
      patch({ bannerDataUrl: dataUrl });
      setImageWarning(
        size && (size.width < BANNER_MIN_SIZE.width || size.height < BANNER_MIN_SIZE.height)
          ? t("customization.bannerTooSmall", { width: size.width, height: size.height })
          : null
      );
    } else {
      patch({ roleIconUrl: dataUrl });
      setImageWarning(null);
    }
  };

  const onFileChosen = async (file: File | undefined) => {
    if (!file) return;
    try {
      const image = await readImageAsDataUrl(file, t);
      applyImage(pendingTarget.current, image.dataUrl, { width: image.width, height: image.height });
    } catch (cause) {
      push({ tone: "error", title: cause instanceof Error ? cause.message : t("customization.imageReadFailed") });
    }
  };

  /**
   * A pasted address, downloaded by the BFF into a data URL.
   *
   * The hop is not a preference: the stored value must be a `data:` URI for
   * Discord, and this page's CSP lets it display images only from its own
   * origin, `data:` and the Discord CDN — so the browser cannot read the
   * remote bytes itself.
   */
  const fetchFromUrl = async () => {
    const trimmed = imageUrl.trim();
    if (!/^https:\/\/\S+$/i.test(trimmed)) {
      setUrlError(t("customization.imageUrlInvalid"));
      return;
    }
    setUrlBusy(true);
    setUrlError(null);
    try {
      const { dataUrl } = await api.imageFromUrl(trimmed);
      const size = await measureDataUrl(dataUrl).catch(() => null);
      applyImage(pendingTarget.current, dataUrl, size);
      closePicker();
    } catch (cause) {
      setUrlError(cause instanceof Error ? cause.message : t("customization.imageReadFailed"));
    } finally {
      setUrlBusy(false);
    }
  };

  /* ---------------- save (the bar's commit) ---------------- */
  const save = async () => {
    const payload: Partial<CustomizationSettings> = { ...draft };
    // A locked icon is omitted, never echoed: the server reads an absent field
    // as "leave it alone" and a null as "clear it".
    if (roleIcon?.locked) delete payload.roleIconUrl;
    const result = await api.saveCustomization(guild.id, payload);
    commit(result.settings);
    // The profile the card falls back to is one save out of date; refetching is
    // what makes a cleared override fall back to the account picture.
    void api
      .customization(guild.id)
      .then(next => setProfile(next.profile ?? null))
      .catch(() => undefined);
    const outcome = describeAppearanceResult(result);
    if (!outcome.ok) throw new Error(outcome.message);
    push({ tone: "success", title: t("customization.savedApplied") });
  };

  const resetAll = () => {
    reset();
    setImageWarning(null);
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
          <CardTitle className="text-base">{t("customization.previewTitle")}</CardTitle>
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
            roleColorLocked={roleColorLocked}
            roleColorReason={t("customization.roleColorLocked")}
          />
          {imageWarning ? (
            <p className="mt-2 flex items-start gap-1.5 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-mini text-warning">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {imageWarning}
            </p>
          ) : null}
          <p className="mt-3 text-mini leading-relaxed text-muted-foreground">{t("customization.presenceNote")}</p>
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
                  <Badge variant="outline" className="gap-1 text-micro" title={roleIcon.reason ?? undefined}>
                    <Lock className="size-3" />
                    {t("customization.locked")}
                  </Badge>
                ) : null}
              </Label>
              {roleIcon?.locked ? (
                <p className="max-w-sm text-mini text-muted-foreground">
                  {roleIcon.reason ?? t("customization.roleIconLocked")}
                </p>
              ) : (
                <p className="text-mini text-muted-foreground">{t("customization.roleIconHint")}</p>
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
            <p className="text-mini text-muted-foreground">{t("customization.permissionsUnreadable")}</p>
          ) : null}
        </CardContent>
      </Card>

      {/*
        One picker for both pictures and the role icon.

        It replaces "click → the OS file dialog appears": that flow had no room
        for the second source, and the second source is the one people reach for
        when the picture is already on the internet. Choosing either path writes
        into the same draft, so the card behind this dialog — which is the live
        preview — updates before anything is saved.
      */}
      <Dialog open={picker !== null} onOpenChange={open => (open ? undefined : closePicker())}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("customization.imageDialogTitle")}</DialogTitle>
            <DialogDescription>{t("customization.imageDialogBody")}</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <Button type="button" variant="outline" className="w-full gap-2" onClick={chooseFile}>
              <Upload className="size-4" aria-hidden />
              {t("customization.imageUpload")}
            </Button>

            <div className="flex items-center gap-3 text-mini text-muted-foreground">
              <span className="h-px flex-1 bg-border" aria-hidden />
              <span>{t("customization.imageOr")}</span>
              <span className="h-px flex-1 bg-border" aria-hidden />
            </div>

            <form
              className="space-y-2"
              onSubmit={event => {
                event.preventDefault();
                void fetchFromUrl();
              }}
            >
              <Label htmlFor="image-url" className="text-xs text-muted-foreground">
                {t("customization.imageUrlLabel")}
              </Label>
              <div className="flex items-center gap-2">
                <Input
                  id="image-url"
                  dir="ltr"
                  inputMode="url"
                  autoComplete="off"
                  spellCheck={false}
                  placeholder={t("customization.imageUrlPlaceholder")}
                  value={imageUrl}
                  disabled={urlBusy}
                  onChange={event => setImageUrl(event.target.value)}
                />
                <Button type="submit" className="shrink-0 gap-1.5" disabled={urlBusy || imageUrl.trim() === ""}>
                  {urlBusy ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
                  {urlBusy ? t("customization.imageUrlFetching") : t("customization.imageUrlFetch")}
                </Button>
              </div>
              <p className="text-micro leading-relaxed text-muted-foreground">{t("customization.imageUrlHint")}</p>
              {urlError ? (
                <p role="alert" className="text-mini text-destructive">
                  {urlError}
                </p>
              ) : null}
            </form>
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={closePicker}>
              {t("common.cancel")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {dirty ? (
        <SaveBar
          message={t("customization.unsaved")}
          saveLabel={t("customization.save")}
          cancelLabel={t("customization.discard")}
          onCancel={resetAll}
          onSave={save}
        />
      ) : null}
    </div>
  );
}
