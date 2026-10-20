import { useEffect, useMemo, useRef, useState } from "react";
import { CheckCircle2, IdCard, Image as ImageIcon, Loader2, Lock, Palette, Pencil, TriangleAlert, Upload, X } from "lucide-react";
import {
  DEFAULT_CUSTOMIZATION,
  MAX_BIO_LENGTH,
  MAX_IMAGE_DATA_URL_LENGTH,
  MAX_NICKNAME_LENGTH,
  describeAppearanceResult
} from "@al-ai/core/browser";
import { api } from "@/api";
import { useDraftForm } from "@/lib/use-draft-form";
import { cn } from "@/lib/utils";
import { ColorPicker } from "@/components/color-picker";
import { SaveBar } from "@/components/save-bar";
import { Toaster, useToasts } from "@/components/toaster";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { BotLivePreview } from "@/views/settings/bot-preview";
import type { CustomizationSettings, Guild, GuildProfileSnapshot, PermissionStatus, RoleIconGate } from "@/types";

/**
 * The bot's profile in ONE server.
 *
 *   header    — title, and the master switch for THIS server's profile
 *   right     — the form: الهوية, الصور, رتبة البوت
 *   left      — the live preview card, bound to the drafts, never to storage
 *
 * Every field on this screen is scoped to the guild in the address bar, and that
 * is now the whole truth rather than half of it. Discord's Modify Current Member
 * endpoint accepts a nickname, an avatar, a banner and a bio together, so all
 * four are per-server; the role's colour and icon belong to a role that only
 * exists here. Nothing on this form reaches another server, which is why there
 * are no scope chips left to read: a chip that says «هذا السيرفر» beside every
 * field of a one-scope form is noise, and the sentence belongs in the header.
 *
 * The presence is deliberately *not* here. A status lives on the bot's gateway
 * connection and is therefore identical in every server — a control that reaches
 * everywhere cannot sit on a form whose whole promise is «هذا ما يظهر به البوت
 * هنا». It has its own screen, «حالة البوت», and this one says so.
 *
 * Nothing here is optimistic: the row is written first, and what Discord
 * accepted arrives as `applied`/`failed` and is reported per field.
 */

const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

/**
 * Discord's own minimums, used to *warn* rather than to refuse: a smaller
 * image is accepted and scaled, so the operator is told what will happen
 * instead of being blocked by a rule they did not ask for.
 */
const AVATAR_MIN_SIDE = 256;
const BANNER_MIN_SIZE = { width: 600, height: 240 };

type ReadImage = { dataUrl: string; width: number; height: number };

/**
 * Reads an image file into a capped base64 data URL, or fails with a reason.
 *
 * The file's *dimensions* are read as well: a picture that is too small is a
 * fact the operator should see before the save, not after Discord has already
 * scaled it.
 */
function readImageAsDataUrl(file: File): Promise<ReadImage> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith("image/")) {
      reject(new Error("الملف ليس صورة. استخدم PNG أو JPG أو WEBP أو GIF."));
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result);
      if (dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
        reject(new Error("حجم الصورة يتجاوز الحد المسموح (500 كيلوبايت تقريباً بعد الترميز)."));
        return;
      }
      const image = new Image();
      image.onload = () => resolve({ dataUrl, width: image.naturalWidth, height: image.naturalHeight });
      // A picture the browser cannot decode is not one we can send either.
      image.onerror = () => reject(new Error("تعذّر قراءة الصورة. تأكّد أن الملف صورة صحيحة."));
      image.src = dataUrl;
    };
    reader.onerror = () => reject(new Error("تعذّر قراءة الصورة."));
    reader.readAsDataURL(file);
  });
}

/**
 * One image slot: a single drop zone that *is* the preview.
 *
 * It used to render the same image three times over — a thumbnail beside the
 * zone, the zone itself, and a file bar — which read as three controls for one
 * value. Now there is one zone: it shows the stored image or the fallback, and
 * grows استبدال/إزالة only when there is something to replace.
 */
function ImageSlot({
  label,
  hint,
  dataUrl,
  savedDataUrl,
  fallbackLabel,
  fileName,
  urlText = "",
  onUrlText,
  onPick,
  onDrop,
  onRemove,
  shape = "square",
  disabled = false,
  state = "saved"
}: {
  label: string;
  hint: string;
  dataUrl: string | null;
  /** What is stored right now - the slot says whether the shown image is new. */
  savedDataUrl?: string | null;
  fallbackLabel: string;
  fileName: string;
  urlText?: string;
  onUrlText?: (next: string) => void;
  onPick: () => void;
  onDrop: (file: File | undefined) => void;
  onRemove: () => void;
  /** The preview's shape: the picture is square, the banner is a 5:2 strip. */
  shape?: "square" | "banner";
  disabled?: boolean;
  /** The state of the image itself: stored, changed, saving, or refused. */
  state?: "saved" | "pending" | "saving" | "failed";
}) {
  const pending = state === "pending" || state === "saving";
  const shown = dataUrl ?? savedDataUrl ?? null;
  const isNew = Boolean(dataUrl) && dataUrl !== (savedDataUrl ?? null);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5 text-xs font-medium">{label}</Label>
        {/*
          The state of the image, said plainly. The old badge said "جاهزة
          للحفظ" for any image that existed - including the one that was
          stored a week ago - which is a statement about nothing.
        */}
        {state === "failed" ? (
          <span className="flex items-center gap-1 text-[11px] text-destructive">
            <TriangleAlert className="size-3.5" aria-hidden />
            فشل الحفظ
          </span>
        ) : state === "saving" ? (
          <span className="flex items-center gap-1 text-[11px] text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" aria-hidden />
            جارٍ الحفظ…
          </span>
        ) : pending ? (
          <span className="flex items-center gap-1 text-[11px] text-warning">
            <Pencil className="size-3.5" aria-hidden />
            تغيير غير محفوظ
          </span>
        ) : shown ? (
          <span className="flex items-center gap-1 text-[11px] text-success">
            <CheckCircle2 className="size-3.5" aria-hidden />
            محفوظة
          </span>
        ) : null}
      </div>

      <div
        className={cn(
          "flex items-start gap-3 rounded-xl border border-dashed border-border p-3 transition-colors",
          !disabled && "hover:border-primary/50 hover:bg-primary/5"
        )}
        onDragOver={event => event.preventDefault()}
        onDrop={event => {
          event.preventDefault();
          if (!disabled) onDrop(event.dataTransfer.files?.[0]);
        }}
      >
        {/*
          The picture itself, big enough to judge: the square picture is
          rendered large, and the banner as the wide strip Discord draws it in.
        */}
        <span
          className={cn(
            "relative shrink-0 overflow-hidden border border-border bg-muted text-center leading-tight text-muted-foreground",
            shape === "square" ? "size-28 rounded-full" : "h-16 w-40 rounded-lg"
          )}
        >
          {shown ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={shown} alt="" className="size-full object-cover" />
          ) : (
            <span className={cn("grid size-full place-items-center", shape === "square" ? "text-[10px]" : "text-[9px]")}>
              {fallbackLabel}
            </span>
          )}
          {isNew ? (
            <span className="absolute inset-x-0 bottom-0 bg-warning/90 py-0.5 text-center text-[9px] font-medium text-warning-foreground">
              لم يُحفظ بعد
            </span>
          ) : null}
        </span>

        <div className="min-w-0 flex-1 space-y-2">
          <p className="text-[11px] leading-relaxed text-muted-foreground">{hint}</p>
          <div className="flex flex-wrap items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={onPick} disabled={disabled}>
              <Upload className="size-3.5" />
              {shown ? "استبدال" : "اختر صورة"}
            </Button>
            {shown ? (
              <>
                <span className="max-w-40 truncate text-[11px] text-muted-foreground" dir="ltr">
                  {fileName}
                </span>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="hover:text-destructive"
                  disabled={disabled}
                  aria-label={`إزالة ${label}`}
                  onClick={onRemove}
                >
                  <X className="size-3.5" />
                  إزالة
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </div>

      <Input
        dir="ltr"
        value={urlText}
        onChange={event => onUrlText?.(event.target.value)}
        placeholder="أو الصق رابط صورة مباشر (https://…)"
        className="h-8 rounded-lg text-xs"
        aria-label={`رابط ${label}`}
        disabled={disabled}
      />
    </div>
  );
}

/** The `n/max` counter that sits opposite a card title. */
function Counter({ value, max }: { value: number; max: number }) {
  return (
    <span className="tabular text-xs text-muted-foreground">
      {value}/{max}
    </span>
  );
}

/**
 * The first candidate that is actually an image address.
 *
 * `??` is not enough here and the difference is not academic: these columns
 * hold `''` for "no image" on this machine (`role_icon_url`, `status_duration`
 * and the rest were all read back as empty strings), and an empty string is
 * *not* nullish — so `stored ?? snapshot` returned the empty string and the
 * preview drew the initials over a bot that has a perfectly good avatar. The
 * fallback chain has to skip blanks, not just nulls.
 */
function firstImage(...candidates: (string | null | undefined)[]): string | null {
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim() !== "") return candidate;
  }
  return null;
}

export function CustomizationView({ guild }: { guild: Guild }) {
  const [guildSettings, setGuildSettings] = useState<CustomizationSettings | null>(null);
  const guildForm = useDraftForm(guildSettings);

  /**
   * What Discord serves for the bot in this guild right now.
   *
   * The preview needs it for the same reason the form needs the row: the row is
   * what the operator last chose *here*, and this is what members actually see —
   * including a nickname set from Discord itself, and the account's picture
   * wherever this server has no override. It is this server's own data, so there
   * is nothing owner-gated about reading it.
   */
  const [profile, setProfile] = useState<GuildProfileSnapshot | null>(null);

  /* ---- advisory reads ---- */
  const [permissions, setPermissions] = useState<PermissionStatus[]>([]);
  const [roleIcon, setRoleIcon] = useState<RoleIconGate | null>(null);

  /* ---- pending pasted URLs (fetched server-side at save time) ---- */
  const [avatarUrlText, setAvatarUrlText] = useState("");
  const [bannerUrlText, setBannerUrlText] = useState("");
  /* ---- display-only names of the last picked files ---- */
  const [fileNames, setFileNames] = useState<{ avatar?: string; banner?: string; roleIcon?: string }>({});
  /* ---- the state of the images themselves ---- */
  const [saving, setSaving] = useState(false);
  const [failedField, setFailedField] = useState<"avatar" | "banner" | null>(null);
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
    setAvatarUrlText("");
    setBannerUrlText("");

    api
      .customization(guild.id)
      .then(result => {
        if (cancelled) return;
        setGuildSettings(result.settings);
        setPermissions(result.permissions);
        setRoleIcon(result.roleIcon);
        setProfile(result.profile ?? null);
      })
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : "تعذّر التحميل."));

    return () => {
      cancelled = true;
    };
  }, [guild.id]);

  /*
   * The preview draws the drafts — a picked file or a pasted URL lands here the
   * instant it is chosen, with no save and no refetch.
   *
   * The fallback chain is the one Discord itself walks, and it has to walk it in
   * this order: the draft (what you just picked), then what Discord serves for
   * this guild, then the account's picture, which is what a member sees where
   * this server has no override. Skipping the last step would draw the initials
   * over a bot whose face is perfectly visible to everybody.
   *
   * With the master switch off the server's own values are all cleared, so the
   * live per-guild values are skipped as well and the account's show through —
   * which is exactly what the switch means.
   */
  const preview = useMemo(() => {
    const draft = guildForm.draft ?? guildForm.saved ?? DEFAULT_CUSTOMIZATION;
    const enabled = draft.enabled;
    return {
      username: profile?.username ?? "AL AI",
      nickname: enabled ? draft.nickname : "",
      // A pasted URL previews directly: <img> needs no CORS to display. It is a
      // value for THIS server, so it belongs in the server slot and not in the
      // fallback.
      serverAvatarDataUrl: enabled ? firstImage(avatarUrlText, draft.avatarDataUrl) : null,
      serverBannerDataUrl: enabled ? firstImage(bannerUrlText, draft.bannerDataUrl) : null,
      accountAvatarUrl: profile?.accountAvatarUrl ?? null,
      accountBannerUrl: profile?.accountBannerUrl ?? null,
      bio: enabled ? draft.bio : "",
      roleColor: draft.roleColor,
      roleIconUrl: draft.roleIconUrl
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guildForm.draft, guildForm.saved, profile, avatarUrlText, bannerUrlText]);

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
        جارٍ التحميل
      </div>
    );
  }

  const { draft, saved, patch, reset, dirty } = guildForm;

  /*
   * Who may change what, resolved once.
   *
   * `canManageIdentity` is the server's verdict on the screen; the permission
   * read adds the one thing the server cannot know in advance — whether the bot
   * itself may rename a member here. All four member fields travel in one
   * Modify Current Member call and all four need Change Nickname, so a missing
   * permission blocks all four together rather than pretending the avatar might
   * still work.
   */
  const memberPermission = permissions.find(item => item.key === "change_nickname");
  const memberBlocked = memberPermission?.granted === false;
  const memberEditable = guild.canManageIdentity && !memberBlocked && draft.enabled;
  const roleEditable = guild.canManageIdentity;
  const permissionsUnreadable = permissions.length > 0 && permissions.every(permission => permission.granted === null);

  /* A pasted URL is a pending change too — the bar must not hide it. */
  const urlsPending = avatarUrlText.trim() !== "" || bannerUrlText.trim() !== "";
  const anyDirty = dirty || urlsPending;

  /* ---------------- image picking (direct, no crop round-trip) ---------------- */
  const openPicker = (target: "avatar" | "banner" | "roleIcon") => {
    pendingTarget.current = target;
    fileInputRef.current?.click();
  };

  const onFileChosen = async (file: File | undefined) => {
    if (!file) return;
    try {
      const image = await readImageAsDataUrl(file);
      const dataUrl = image.dataUrl;
      const target = pendingTarget.current;
      if (target === "avatar") {
        patch({ avatarDataUrl: dataUrl });
        setFileNames(current => ({ ...current, avatar: file.name }));
        setImageWarning(
          image.width < AVATAR_MIN_SIDE || image.height < AVATAR_MIN_SIDE
            ? `الأبعاد ${image.width}×${image.height} أصغر من 256×256؛ ديسكورد سيصغّرها.`
            : null
        );
      } else if (target === "banner") {
        patch({ bannerDataUrl: dataUrl });
        setFileNames(current => ({ ...current, banner: file.name }));
        setImageWarning(
          image.width < BANNER_MIN_SIZE.width || image.height < BANNER_MIN_SIZE.height
            ? `الأبعاد ${image.width}×${image.height} أصغر من 600×240؛ ديسكورد سيصغّرها.`
            : null
        );
      } else {
        patch({ roleIconUrl: dataUrl });
        setFileNames(current => ({ ...current, roleIcon: file.name }));
        setImageWarning(null);
      }
      setAvatarUrlText("");
      setBannerUrlText("");
    } catch (cause) {
      push({ tone: "error", title: cause instanceof Error ? cause.message : "تعذّر قراءة الصورة." });
    }
  };

  /* ---------------- saving ---------------- */
  const save = async () => {
    const payload: Partial<CustomizationSettings> = { ...draft };
    // A locked icon is omitted rather than echoed back: the server reads an
    // absent field as "leave it alone" and a `null` as "clear it", so sending
    // the stored value would be a no-op at best and a wipe at worst.
    if (roleIcon?.locked) delete payload.roleIconUrl;
    if (avatarUrlText.trim()) Object.assign(payload, { avatarUrl: avatarUrlText.trim() });
    if (bannerUrlText.trim()) Object.assign(payload, { bannerUrl: bannerUrlText.trim() });

    const result = await api.saveCustomization(guild.id, payload);
    guildForm.commit(result.settings);
    setAvatarUrlText("");
    setBannerUrlText("");
    // The profile the preview falls back to is now one save out of date. The
    // refetch is what makes a cleared override fall back to the account picture
    // instead of the picture Discord served a moment ago.
    void api
      .customization(guild.id)
      .then(next => setProfile(next.profile ?? null))
      .catch(() => undefined);
    return { ...describeAppearanceResult(result), result };
  };

  const onSave = async () => {
    setSaving(true);
    setFailedField(null);
    try {
      const { result, ...outcome } = await save();
      if (outcome.ok) {
        push({ tone: "success", title: "تم حفظ وتطبيق التغييرات على البوت في هذا السيرفر" });
        return;
      }
      // Which image failed, so the slot can say so instead of the screen
      // showing a picture as if it had been stored.
      const failed = result.failed.find(
        entry => entry.field === "guildAvatarDataUrl" || entry.field === "bannerDataUrl"
      );
      if (failed) setFailedField(failed.field === "guildAvatarDataUrl" ? "avatar" : "banner");
      const refused = new Error(outcome.message);
      push({ tone: "error", title: "تعذّر تطبيق بعض التغييرات", description: outcome.message });
      throw refused;
    } finally {
      setSaving(false);
    }
  };

  const resetAll = () => {
    reset();
    setAvatarUrlText("");
    setBannerUrlText("");
    setFailedField(null);
    setImageWarning(null);
  };

  /*
   * The state of one image slot, said plainly: stored, changed, saving, or
   * refused. The old badge claimed "ready to save" for any image that existed
   * - including the one stored a week ago - which described nothing.
   */
  const imageState = (target: "avatar" | "banner"): "saved" | "pending" | "saving" | "failed" => {
    if (saving) return "saving";
    if (failedField === target) return "failed";
    const draftValue = target === "avatar" ? draft.avatarDataUrl : draft.bannerDataUrl;
    const savedValue = target === "avatar" ? saved.avatarDataUrl : saved.bannerDataUrl;
    const pasted = target === "avatar" ? avatarUrlText.trim() : bannerUrlText.trim();
    if (pasted !== "") return "pending";
    if ((draftValue ?? null) !== (savedValue ?? null)) return "pending";
    return "saved";
  };

  return (
    <div className="space-y-4 pb-24">
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

      {/* ---------------- Header: title + the per-guild master switch ---------------- */}
      <div className="flex flex-wrap items-start justify-between gap-3 pt-1">
        <div className="space-y-1">
          <h1 className="text-lg font-semibold">هوية البوت</h1>
          <p className="text-xs text-muted-foreground">
            كل ما يظهر به AL AI في <span className="font-medium text-foreground">{guild.name}</span>: اللقب والنبذة والصورة والغلاف، ولون
            الرتبة وأيقونتها. كل حقل هنا يخصّ هذا السيرفر وحده، ولا يظهر في سيرفر آخر.
          </p>
        </div>
        <label className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">تفعيل التخصيص في هذا السيرفر</span>
          <Switch checked={draft.enabled} onCheckedChange={enabled => patch({ enabled })} aria-label="تفعيل التخصيص في هذا السيرفر" />
        </label>
      </div>

      {!draft.enabled && (
        <Alert>
          <IdCard className="size-4" />
          <AlertDescription>
            التخصيص <strong>معطّل</strong> — سيظهر البوت باسمه وصورته الأساسيين في هذا السيرفر. عند الحفظ يُعاد اللقب والصورة والغلاف
            والنبذة إلى الوضع الافتراضي تلقائياً، والقيم المحفوظة تبقى في النموذج.
          </AlertDescription>
        </Alert>
      )}

      {memberBlocked && (
        <Alert variant="destructive">
          <Lock className="size-4" />
          <AlertDescription>
            البوت لا يملك صلاحية «تغيير الاسم المستعار» (Change Nickname) في هذا السيرفر، وهي اللازمة للقب والصورة والغلاف والنبذة معاً —
            فالحفظ سيرفضه Discord. امنح البوت الصلاحية ثم أعد المحاولة.
          </AlertDescription>
        </Alert>
      )}

      {/* ---------------- Two columns: forms (right) / live preview (left) ---------------- */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="min-w-0 space-y-4">
          {/* ------------------------------------------------ CARD 1 · الهوية */}
          <Card className={cn(!draft.enabled && "opacity-70")}>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <IdCard className="size-4" />
                الهوية
              </CardTitle>
              <CardDescription>ما يُعرف به AL AI في هذا السيرفر: الاسم الظاهر، والنبذة التي يقرأها من يفتح ملفه.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="nickname" className="text-xs">
                    اللقب
                  </Label>
                  <Counter value={draft.nickname.length} max={MAX_NICKNAME_LENGTH} />
                </div>
                <Input
                  id="nickname"
                  value={draft.nickname}
                  onChange={event => patch({ nickname: event.target.value })}
                  maxLength={MAX_NICKNAME_LENGTH}
                  placeholder={`مثال: AL AI في ${guild.name}`}
                  disabled={!memberEditable}
                  className="rounded-xl"
                />
                <p className="text-[11px] text-muted-foreground">
                  الاسم الذي يظهر به AL AI في قائمة أعضاء هذا السيرفر. اتركه فارغاً ليظهر باسمه الأصلي{" "}
                  <span dir="ltr">{DEFAULT_CUSTOMIZATION.nickname}</span>.
                </p>
              </div>

              <Separator />

              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <Label htmlFor="bio" className="text-xs">
                    نبذة عني
                  </Label>
                  <Counter value={draft.bio.length} max={MAX_BIO_LENGTH} />
                </div>
                <Textarea
                  id="bio"
                  rows={3}
                  value={draft.bio}
                  maxLength={MAX_BIO_LENGTH}
                  placeholder="ما يميّز AL AI في هذا السيرفر"
                  onChange={event => patch({ bio: event.target.value })}
                  disabled={!memberEditable}
                  className="rounded-xl"
                />
                <p className="text-[11px] text-muted-foreground">
                  ما يقرأه من يفتح ملف البوت في هذا السيرفر. الحد {MAX_BIO_LENGTH} حرفاً — وهو سقف Discord نفسه لهذا الحقل.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* ------------------------------------------------ CARD 2 · الصور */}
          <Card className={cn(!draft.enabled && "opacity-70")}>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <ImageIcon className="size-4" />
                الصور
              </CardTitle>
              <CardDescription>
                الصورة والغلاف اللذان يراهما أعضاء هذا السيرفر. كل منهما يقبل رفعاً من الجهاز أو رابطاً مباشراً، وما تتركه فارغاً يعود
                إلى الصورة الأساسية للبوت.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/*
                The picture and the banner, each with its own value, its own
                preview and its own save - they are two different fields of
                Discord's member edit, and one of them (the picture) falls back
                to the account's picture where the server has no override,
                while the other (the banner) does not.
              */}
              <ImageSlot
                label="الصورة الأساسية"
                hint="الصورة التي يراها أعضاء هذا السيرفر. مربعة 256×256 على الأقل. PNG أو JPG أو WEBP أو GIF — الحد 500 ك.ب بعد الترميز. تُطبَّق على عضوية البوت في هذا السيرفر فقط."
                dataUrl={draft.avatarDataUrl}
                savedDataUrl={saved.avatarDataUrl ?? null}
                fallbackLabel={profile?.accountAvatarUrl ? "صورة الحساب" : "الافتراضية"}
                fileName={fileNames.avatar ?? "guild-avatar.png"}
                urlText={avatarUrlText}
                onUrlText={setAvatarUrlText}
                onPick={() => openPicker("avatar")}
                onDrop={file => {
                  pendingTarget.current = "avatar";
                  void onFileChosen(file);
                }}
                onRemove={() => patch({ avatarDataUrl: null })}
                disabled={!memberEditable}
                shape="square"
                state={imageState("avatar")}
              />

              <Separator />

              <ImageSlot
                label="غلاف البوت"
                hint="الغلاف الذي يراه أعضاء هذا السيرفر، بنسبة 5:2 تقريباً (مثل 600×240). PNG أو JPG أو WEBP أو GIF — الحد 500 ك.ب بعد الترميز. غلاف الحساب العام لا يُعرض هنا: لكل سيرفر غلافه."
                dataUrl={draft.bannerDataUrl}
                savedDataUrl={saved.bannerDataUrl ?? null}
                fallbackLabel="لا يوجد غلاف"
                fileName={fileNames.banner ?? "guild-banner.png"}
                urlText={bannerUrlText}
                onUrlText={setBannerUrlText}
                onPick={() => openPicker("banner")}
                onDrop={file => {
                  pendingTarget.current = "banner";
                  void onFileChosen(file);
                }}
                onRemove={() => patch({ bannerDataUrl: null })}
                disabled={!memberEditable}
                shape="banner"
                state={imageState("banner")}
              />
            </CardContent>
          </Card>

          {/* ------------------------------------------------ CARD 3 · رتبة البوت */}
          <Card className={cn(!draft.enabled && "opacity-70")}>
            <CardHeader className="pb-3">
              <CardTitle className="flex items-center gap-2 text-base">
                <Palette className="size-4" />
                رتبة البوت
              </CardTitle>
              <CardDescription>
                رتبة AL AI في <span className="font-medium text-foreground">{guild.name}</span> — لونها وأيقونتها، وهي رتبة لا توجد إلا
                هنا.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-medium text-muted-foreground">اللون والأيقونة يظهران في قائمة الأعضاء بجانب الاسم.</p>
                {!roleEditable ? (
                  <Badge variant="destructive" className="shrink-0 text-[10px]">
                    الحفظ معطّل
                  </Badge>
                ) : null}
              </div>

              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label className="text-xs">لون رتبة البوت</Label>
                  {/* The controls follow the *same* gate the badge above
                      announces. They used to be gated by the icon's own lock
                      only, so a caller without the identity permission could
                      still pick a colour and a role icon, and the server would
                      refuse the save - the badge and the controls disagreed
                      about what was allowed. */}
                  <div className={cn(!roleEditable && "pointer-events-none opacity-60")} aria-disabled={!roleEditable}>
                    <ColorPicker value={draft.roleColor ?? ""} onChange={value => patch({ roleColor: value || null })} />
                  </div>
                </div>
                <div className="space-y-1.5">
                  <Label className="flex items-center gap-1.5 text-xs">
                    أيقونة الرتبة
                    {roleIcon?.locked ? (
                      <Badge variant="outline" className="gap-1 text-[10px]" title={roleIcon.reason ?? undefined}>
                        <Lock className="size-3" />
                        مقفلة
                      </Badge>
                    ) : null}
                  </Label>
                  <div className="flex items-center gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      disabled={roleIcon?.locked || !roleEditable}
                      onClick={() => openPicker("roleIcon")}
                    >
                      <Upload className="size-3.5" /> اختر أيقونة
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
                          aria-label="إزالة أيقونة الرتبة"
                          disabled={roleIcon?.locked || !roleEditable}
                          onClick={() => patch({ roleIconUrl: null })}
                        >
                          <X />
                        </Button>
                      </>
                    ) : (
                      <span className="text-[11px] text-muted-foreground">اختيارية</span>
                    )}
                  </div>
                  {roleIcon?.locked ? (
                    <p className="text-[11px] text-muted-foreground">{roleIcon.reason ?? "أيقونة الرتبة تتطلب مستوى تعزيز 2."}</p>
                  ) : null}
                </div>
              </div>

              {permissionsUnreadable ? (
                <p className="text-[11px] text-muted-foreground">تعذّر قراءة صلاحيات البوت الآن — الحفظ يبقى متاحاً والبوت يتحقق عند التطبيق.</p>
              ) : null}
            </CardContent>
          </Card>
        </div>

        {/* ---------------- Live preview (left column, sticky) ----------------
         *
         * `lg:sticky` + `lg:self-start` pins the preview beside the form — and
         * that only works while the column is *shorter* than the scrollport: a
         * pinned box taller than the viewport has nowhere to stick and scrolls
         * away with the form. The preview is therefore kept deliberately
         * compact, and `browser-check.mjs` measures that it really does stay
         * put through a 600px scroll.
         * ---------------------------------------------------------------- */}
        <div className="lg:sticky lg:top-6 lg:self-start">
          <Card className="border-primary/20 bg-card/70 shadow-lg shadow-primary/5 backdrop-blur-sm">
            <CardHeader className="pb-3">
              <CardTitle className="text-base">معاينة حيّة</CardTitle>
              <CardDescription>هكذا سيظهر AL AI في هذا السيرفر — تتحدّث مع كل ضغطة دون حفظ.</CardDescription>
            </CardHeader>
            <CardContent>
              <BotLivePreview
                profile={preview}
                guildName={guild.name}
                memberCount={guild.memberCount}
                enabled={draft.enabled}
                pending={anyDirty}
              />
              {imageWarning ? (
                <p className="mt-2 rounded-lg border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[11px] text-warning">
                  {imageWarning}
                </p>
              ) : null}
              <p className="mt-3 text-[11px] leading-relaxed text-muted-foreground">
                الحالة والنشاط لا يظهران هنا: يخصّان البوت كله لا هذا السيرفر، وتُعدَّلان من شاشة «حالة البوت».
              </p>
            </CardContent>
          </Card>
        </div>
      </div>

      {anyDirty ? (
        <SaveBar
          message="لديك تغييرات غير محفوظة"
          saveLabel="حفظ التغييرات"
          cancelLabel="تجاهل"
          onCancel={resetAll}
          onSave={onSave}
        />
      ) : null}
    </div>
  );
}
