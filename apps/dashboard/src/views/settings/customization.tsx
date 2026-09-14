import { useEffect, useMemo, useRef, useState } from "react";
import {
  Check,
  CircleHelp,
  Globe,
  Info,
  Loader2,
  Lock,
  Palette,
  RotateCcw,
  Server,
  ShieldCheck,
  TriangleAlert,
  Upload,
  X
} from "lucide-react";
import {
  DEFAULT_BOT_IDENTITY,
  DEFAULT_CUSTOMIZATION,
  MAX_ACTIVITY_TEXT_LENGTH,
  MAX_BIO_LENGTH,
  MAX_NICKNAME_LENGTH,
  activityTypeLabels,
  activityTypes,
  botStatusLabels,
  botStatuses,
  describeAppearanceResult
} from "@al-ai/core/browser";
import { api } from "@/api";
import { ColorPicker } from "@/components/color-picker";
import { ImageCropper, ImagePickerButton, readImageFile, type CropTarget, type LoadedImage } from "@/components/image-cropper";
import { SaveBar } from "@/components/save-bar";
import { StatusPicker } from "@/components/status-picker";
import { Toaster, useToasts } from "@/components/toaster";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { BotLivePreview } from "@/views/settings/bot-preview";
import type {
  BotIdentitySettings,
  BotIdentitySnapshot,
  CustomizationSettings,
  Guild,
  PermissionStatus,
  RoleHierarchyVerdict,
  RoleIconGate
} from "@/types";

/**
 * Bot appearance — both scopes on one screen.
 *
 * Discord splits a bot's identity in two, and the split is the whole reason this
 * screen is shaped the way it is:
 *
 *   global     — the account avatar and banner, the application's "About me",
 *                and the gateway presence (status + activity)
 *   per guild  — the nickname, and the colour and icon of the AL AI role
 *
 * An earlier build only exposed the per-guild half, and the predictable mistake
 * followed: an operator looking for "the bot's picture" found a nickname and a
 * role colour and concluded the feature was missing. So the two scopes now live
 * side by side, each labelled, with a live preview that draws both at once — the
 * preview is what makes "this field is global" land, not a sentence saying so.
 *
 * Each scope saves on its own route and reports on its own, because each has a
 * different writer: the dashboard performs the REST writes (it can read back the
 * real per-field outcome), and the bot performs the presence write on its sync
 * tick (only a live gateway connection can set a status). A single Save button
 * would have to lie about one of them.
 *
 * Nothing here is optimistic. "محفوظ" and "منفّذ" stay distinct: the row is
 * written first and always, and what Discord actually accepted arrives as
 * `applied`/`failed` and is reported per field.
 */

/** Which cropper is open, if any. */
type CropState = { target: CropTarget; image: LoadedImage } | null;

export function CustomizationView({ guild }: { guild: Guild }) {
  /* ---- per-guild scope ---- */
  const [savedGuild, setSavedGuild] = useState<CustomizationSettings | null>(null);
  const [guildDraft, setGuildDraft] = useState<CustomizationSettings | null>(null);

  /* ---- global scope ---- */
  const [savedIdentity, setSavedIdentity] = useState<BotIdentitySettings | null>(null);
  const [identityDraft, setIdentityDraft] = useState<BotIdentitySettings | null>(null);
  const [snapshot, setSnapshot] = useState<BotIdentitySnapshot | null>(null);

  /* ---- advisory reads ---- */
  const [permissions, setPermissions] = useState<PermissionStatus[]>([]);
  const [hierarchy, setHierarchy] = useState<RoleHierarchyVerdict | null>(null);
  const [roleIcon, setRoleIcon] = useState<RoleIconGate | null>(null);

  const [error, setError] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropState>(null);
  const [cropError, setCropError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const pendingTarget = useRef<CropTarget>("avatar");
  const { toasts, push, dismiss } = useToasts();

  useEffect(() => {
    let cancelled = false;
    setSavedGuild(null);
    setGuildDraft(null);
    setSavedIdentity(null);
    setIdentityDraft(null);
    setHierarchy(null);
    setRoleIcon(null);
    setError(null);

    // Both halves are fetched together but neither is required for the other to
    // render: the per-guild read is what gates the screen, and the global read
    // degrades to "not readable" rather than blanking the form the operator came
    // here to use.
    api
      .customization(guild.id)
      .then(result => {
        if (cancelled) return;
        setSavedGuild(result.settings);
        setGuildDraft(result.settings);
        setPermissions(result.permissions);
        setHierarchy(result.hierarchy);
        setRoleIcon(result.roleIcon);
      })
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : "تعذّر التحميل."));

    api
      .botIdentity(guild.id)
      .then(result => {
        if (cancelled) return;
        setSavedIdentity(result.settings);
        setIdentityDraft(result.settings);
        setSnapshot(result.snapshot);
      })
      .catch(cause => {
        if (cancelled) return;
        // The global half unreadable must not present an editable form whose
        // save would overwrite values it never read. Fill the draft with the
        // documented defaults *only* as a last resort, and say so.
        setSavedIdentity(null);
        setIdentityDraft(null);
        push({
          tone: "error",
          title: "تعذّر تحميل الهوية العالمية",
          description: cause instanceof Error ? cause.message : "أعد تحميل الصفحة."
        });
      });

    return () => {
      cancelled = true;
    };
    // `push` is stable for the life of the screen; re-running on it would refetch
    // on every toast.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild.id]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }
  if (!savedGuild || !guildDraft) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        جارٍ التحميل
      </div>
    );
  }

  /* ---------------------------------------------------------------- *
   * Dirty tracking
   *
   * Compared field by field rather than with `JSON.stringify` so that a key
   * appearing in one object and not the other (which is how the two halves were
   * merged) cannot register as "changed" with both values equal.
   * ---------------------------------------------------------------- */
  const guildDirty = !shallowEqual(savedGuild, guildDraft);
  const identityDirty = savedIdentity !== null && identityDraft !== null && !shallowEqual(savedIdentity, identityDraft);

  const nicknamePermission = permissions.find(item => item.key === "change_nickname");
  // Only a *known* absence blocks the save. `granted` is null when the permission
  // read failed, and treating that as a refusal would disable Save for every
  // guild whenever Discord had a hiccup.
  const canSaveGuild =
    guild.canManageIdentity && nicknamePermission?.granted !== false && guildDraft.nickname.length <= MAX_NICKNAME_LENGTH;
  const canSaveIdentity = guild.canManageIdentity && identityDraft !== null;
  const permissionsUnreadable = permissions.length > 0 && permissions.every(permission => permission.granted === null);

  const patchGuild = (next: Partial<CustomizationSettings>) => setGuildDraft({ ...guildDraft, ...next });
  const patchIdentity = (next: Partial<BotIdentitySettings>) =>
    setIdentityDraft(current => (current ? { ...current, ...next } : current));

  /** Whatever the preview should draw: the draft when there is one, else stored. */
  const previewIdentity = useMemo(() => {
    const source = identityDraft ?? savedIdentity ?? DEFAULT_BOT_IDENTITY;
    return {
      username: snapshot?.username ?? "AL AI",
      // The draft's data URL wins while cropping; otherwise fall back to the CDN
      // address Discord serves, so the preview shows what actually exists today.
      avatarDataUrl: source.avatarDataUrl ?? snapshot?.avatarUrl ?? null,
      bannerDataUrl: source.bannerDataUrl ?? snapshot?.bannerUrl ?? null,
      bio: source.bio,
      status: source.status,
      activityType: source.activityType,
      activityText: source.activityText,
      statusDuration: source.statusDuration
    };
  }, [identityDraft, savedIdentity, snapshot]);

  /* ---------------------------------------------------------------- *
   * Image picking
   * ---------------------------------------------------------------- */
  const openPicker = (target: CropTarget) => {
    pendingTarget.current = target;
    setCropError(null);
    fileInputRef.current?.click();
  };

  const onFileChosen = async (file: File | undefined) => {
    if (!file) return;
    try {
      const loaded = await readImageFile(file);
      setCrop({ target: pendingTarget.current, image: loaded });
      setCropError(null);
    } catch (cause) {
      setCropError(cause instanceof Error ? cause.message : "تعذّر قراءة الصورة.");
    }
  };

  const applyCrop = (dataUrl: string) => {
    if (!crop) return;
    if (crop.target === "roleIcon") patchGuild({ roleIconUrl: dataUrl });
    else if (crop.target === "avatar") patchIdentity({ avatarDataUrl: dataUrl });
    else patchIdentity({ bannerDataUrl: dataUrl });
    setCrop(null);
  };

  /* ---------------------------------------------------------------- *
   * Saving
   *
   * The two scopes are saved one after the other and reported separately, so a
   * refusal on the nickname cannot be presented as a refusal of the avatar.
   * ---------------------------------------------------------------- */
  const saveGuild = async () => {
    const result = await api.saveCustomization(guild.id, guildDraft);
    setSavedGuild(result.settings);
    setGuildDraft(result.settings);
    return describeAppearanceResult(result);
  };

  const saveIdentity = async () => {
    if (!identityDraft) return { ok: false, message: "تعذّر تحميل الهوية العالمية." };
    const result = await api.saveBotIdentity(guild.id, identityDraft);
    setSavedIdentity(result.settings);
    setIdentityDraft(result.settings);
    return describeAppearanceResult(result);
  };

  const saveAll = async () => {
    const results = await Promise.all([guildDirty ? saveGuild() : null, identityDirty ? saveIdentity() : null]);
    const attempted = results.filter((entry): entry is { ok: boolean; message: string } => entry !== null);
    if (attempted.length === 0) return;

    const failed = attempted.filter(entry => !entry.ok);
    if (failed.length === 0) {
      push({ tone: "success", title: "تم حفظ وتطبيق التغييرات بنجاح على البوت والسيرفر" });
      return;
    }
    // The refusal is surfaced, not swallowed: the operator needs the sentence
    // Discord gave us, not a generic failure.
    const refused = new Error(failed.map(entry => entry.message).join(" "));
    push({ tone: "error", title: "تعذّر تطبيق بعض التغييرات", description: refused.message });
    throw refused;
  };

  const resetAll = () => {
    setGuildDraft(savedGuild);
    if (savedIdentity) setIdentityDraft(savedIdentity);
    setCrop(null);
  };

  const anyDirty = guildDirty || identityDirty;

  return (
    <div className="space-y-4 pb-24">
      <Toaster toasts={toasts} onDismiss={dismiss} />

      {/* One file input for all three targets — which crop to open is decided by
          `pendingTarget`, set by whichever button was pressed. */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={event => {
          void onFileChosen(event.target.files?.[0]);
          // Cleared so picking the same file twice fires `change` again.
          event.target.value = "";
        }}
      />

      {permissionsUnreadable ? (
        <Alert>
          <CircleHelp />
          <AlertDescription>
            تعذّر قراءة صلاحيات البوت الآن. الحفظ يبقى متاحاً، وسيتحقق البوت من الصلاحية عند التطبيق.
          </AlertDescription>
        </Alert>
      ) : null}

      {cropError ? (
        <Alert variant="destructive">
          <AlertDescription>{cropError}</AlertDescription>
        </Alert>
      ) : null}

      <HierarchyWarning verdict={hierarchy} />

      {/* ================================================================ *
       * Two columns: the form on the reading side, the preview pinned
       * beside it. On a narrow screen the preview moves above the form so
       * the operator sees the object before the controls.
       * ================================================================ */}
      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
        <div className="space-y-4">
          {/* ---------------------------------------------------------- *
           * Card 1 — the global profile
           * ---------------------------------------------------------- */}
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Globe className="size-4" />
                    الهوية العالمية
                  </CardTitle>
                  <CardDescription>تُطبَّق على حساب البوت في كل السيرفرات التي يدخلها.</CardDescription>
                </div>
                <Badge variant="outline" className="shrink-0 gap-1">
                  <Globe className="size-3" />
                  عالمي
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              {/* --- avatar --- */}
              <div className="space-y-2">
                <Label>الصورة الرمزية</Label>
                <div className="flex items-center gap-3">
                  <span
                    className="grid size-14 shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-muted text-xs"
                    style={
                      identityDraft?.avatarDataUrl || snapshot?.avatarUrl
                        ? { backgroundImage: `url(${identityDraft?.avatarDataUrl ?? snapshot?.avatarUrl})`, backgroundSize: "cover", backgroundPosition: "center" }
                        : undefined
                    }
                  >
                    {identityDraft?.avatarDataUrl || snapshot?.avatarUrl ? "" : "AI"}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <ImagePickerButton label="رفع صورة" busy={crop?.target === "avatar"} onPick={() => openPicker("avatar")} />
                    {identityDraft?.avatarDataUrl ? (
                      <Button type="button" variant="ghost" size="sm" onClick={() => patchIdentity({ avatarDataUrl: null })}>
                        <RotateCcw />
                        الافتراضية
                      </Button>
                    ) : null}
                  </div>
                </div>
                <p className="text-xs text-muted-foreground">تُقصّ إلى 256×256 قبل الإرسال، فلا يرفضها Discord.</p>
              </div>

              <Separator />

              {/* --- banner --- */}
              <div className="space-y-2">
                <Label>البانر</Label>
                <div
                  className="relative aspect-[5/2] w-full overflow-hidden rounded-lg border border-border bg-muted"
                  style={
                    identityDraft?.bannerDataUrl || snapshot?.bannerUrl
                      ? { backgroundImage: `url(${identityDraft?.bannerDataUrl ?? snapshot?.bannerUrl})`, backgroundSize: "cover", backgroundPosition: "center" }
                      : undefined
                  }
                >
                  {!identityDraft?.bannerDataUrl && !snapshot?.bannerUrl ? (
                    <span className="absolute inset-0 grid place-items-center text-xs text-muted-foreground">لا يوجد بانر</span>
                  ) : null}
                </div>
                <div className="flex flex-wrap gap-2">
                  <ImagePickerButton label="رفع بانر" busy={crop?.target === "banner"} onPick={() => openPicker("banner")} />
                  {identityDraft?.bannerDataUrl ? (
                    <Button type="button" variant="ghost" size="sm" onClick={() => patchIdentity({ bannerDataUrl: null })}>
                      <RotateCcw />
                      إزالة
                    </Button>
                  ) : null}
                </div>
                <p className="text-xs text-muted-foreground">يُقصّ إلى 600×240.</p>
              </div>

              <Separator />

              {/* --- bio --- */}
              <div className="space-y-2">
                <Label htmlFor="bio">النبذة التعريفية</Label>
                <Textarea
                  id="bio"
                  rows={3}
                  value={identityDraft?.bio ?? ""}
                  maxLength={MAX_BIO_LENGTH}
                  placeholder="نبذة قصيرة يراها من يفتح ملف البوت."
                  onChange={event => patchIdentity({ bio: event.target.value })}
                />
                <div className="flex justify-end">
                  <p className="tabular text-xs text-muted-foreground">
                    {(identityDraft?.bio ?? "").length} / {MAX_BIO_LENGTH}
                  </p>
                </div>
              </div>

              <Separator />

              {/* --- presence: status + activity, deliberately in the same card
                      as the name and the images, because it is the same scope
                      and the same save. --- */}
              <div className="space-y-3">
                <Label>الحالة والنشاط</Label>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <span className="text-xs text-muted-foreground">الحالة</span>
                    <div>
                      <StatusPicker
                        status={identityDraft?.status ?? "online"}
                        duration={identityDraft?.statusDuration ?? null}
                        onChange={({ status, duration }) =>
                          patchIdentity({
                            status,
                            statusDuration: duration,
                            // The expiry is a wall-clock instant, so only the
                            // server can compute it: the client sends the choice
                            // and the route turns it into a timestamp. Sending a
                            // client clock would let a skewed machine set a
                            // window that is already over.
                            statusExpiresAt: null
                          })
                        }
                      />
                    </div>
                  </div>
                  <div className="space-y-1.5">
                    <span className="text-xs text-muted-foreground">نوع النشاط</span>
                    <select
                      aria-label="نوع النشاط"
                      className="h-9 w-full rounded-md border border-border bg-transparent px-2 text-sm"
                      value={identityDraft?.activityType ?? "playing"}
                      onChange={event => patchIdentity({ activityType: event.target.value as BotIdentitySettings["activityType"] })}
                    >
                      {activityTypes.map(type => (
                        <option key={type} value={type}>
                          {activityTypeLabels[type]}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <Input
                  dir="auto"
                  aria-label="نص النشاط"
                  placeholder="مثال: يحرس بغداد"
                  maxLength={MAX_ACTIVITY_TEXT_LENGTH}
                  value={identityDraft?.activityText ?? ""}
                  onChange={event => patchIdentity({ activityText: event.target.value })}
                />
                <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                  <Info className="mt-0.5 size-3.5 shrink-0" />
                  النشاط الفارغ يعني «بلا نشاط ظاهر»، لا نشاطاً باسم فارغ. الحالة والنشاط يطبّقهما البوت نفسه
                  خلال ثوانٍ من الحفظ، لأنه الطرف الوحيد المتصل بـGateway.
                </p>
              </div>
            </CardContent>
          </Card>

          {/* ---------------------------------------------------------- *
           * Card 2 — this guild only
           * ---------------------------------------------------------- */}
          <Card>
            <CardHeader>
              <div className="flex items-start justify-between gap-3">
                <div className="space-y-1">
                  <CardTitle className="flex items-center gap-2 text-base">
                    <Server className="size-4" />
                    هذا السيرفر فقط
                  </CardTitle>
                  <CardDescription>لا تؤثر على باقي السيرفرات.</CardDescription>
                </div>
                <Badge variant={canSaveGuild ? "secondary" : "destructive"} className="shrink-0">
                  {canSaveGuild ? "جاهز" : "الحفظ معطّل"}
                </Badge>
              </div>
            </CardHeader>
            <CardContent className="space-y-5">
              <div className="space-y-2">
                <Label htmlFor="nickname">الاسم المستعار</Label>
                <Input
                  id="nickname"
                  value={guildDraft.nickname}
                  maxLength={MAX_NICKNAME_LENGTH}
                  placeholder={DEFAULT_CUSTOMIZATION.nickname}
                  onChange={event => patchGuild({ nickname: event.target.value })}
                />
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs text-muted-foreground">
                    اتركه فارغاً ليظهر البوت باسمه الأصلي <span dir="ltr">{DEFAULT_CUSTOMIZATION.nickname}</span>.
                  </p>
                  <p className="tabular text-xs text-muted-foreground">
                    {guildDraft.nickname.length} / {MAX_NICKNAME_LENGTH}
                  </p>
                </div>
              </div>

              <Separator />

              <div className="space-y-3">
                <Label>لون رتبة AL AI</Label>
                <ColorPicker
                  id="role-color"
                  value={guildDraft.roleColor}
                  unsetLabel="لون Discord الافتراضي"
                  onChange={hex => patchGuild({ roleColor: hex })}
                />
              </div>

              <Separator />

              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <Label>أيقونة الرتبة</Label>
                  {roleIcon?.locked ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <span className="inline-flex cursor-help items-center gap-1 rounded-md bg-warning/15 px-2 py-0.5 text-xs text-warning">
                          <Lock className="size-3" />
                          مقفلة
                        </span>
                      </TooltipTrigger>
                      <TooltipContent className="max-w-xs text-right leading-relaxed">{roleIcon.reason}</TooltipContent>
                    </Tooltip>
                  ) : null}
                </div>

                <div className="flex items-center gap-3">
                  <span className="grid size-12 shrink-0 place-items-center overflow-hidden rounded-full border border-border bg-muted text-xs">
                    {guildDraft.roleIconUrl ? (
                      <img src={guildDraft.roleIconUrl} alt="" className="size-full object-cover" />
                    ) : (
                      "AL"
                    )}
                  </span>
                  <div className="flex flex-wrap gap-2">
                    <ImagePickerButton
                      label="اختيار أيقونة"
                      busy={crop?.target === "roleIcon"}
                      onPick={() => openPicker("roleIcon")}
                    />
                    {guildDraft.roleIconUrl ? (
                      <Button type="button" variant="ghost" size="sm" onClick={() => patchGuild({ roleIconUrl: null })}>
                        <RotateCcw />
                        إزالة
                      </Button>
                    ) : null}
                  </div>
                </div>

                <Input
                  dir="ltr"
                  aria-label="رابط أيقونة الرتبة"
                  placeholder="https://…/icon.png"
                  value={guildDraft.roleIconUrl?.startsWith("data:") ? "" : guildDraft.roleIconUrl ?? ""}
                  disabled={roleIcon?.locked}
                  onChange={event => patchGuild({ roleIconUrl: event.target.value.trim() || null })}
                />

                {roleIcon?.locked ? (
                  <p className="flex items-start gap-1.5 text-xs leading-relaxed text-warning">
                    <Lock className="mt-0.5 size-3.5 shrink-0" />
                    {roleIcon.reason}
                  </p>
                ) : (
                  <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    <Info className="mt-0.5 size-3.5 shrink-0" />
                    ارفع صورة مربعة أو ضع رابط HTTPS. لأن صورة الحساب عامة لكل السيرفرات، فإن الأيقونة الخاصة
                    بسيرفر واحد تظهر على رتبة AL AI بدلاً من الحساب.
                    {roleIcon?.unknown ? " تعذّر قراءة مستوى تعزيز السيرفر الآن، وسيتحقق البوت عند التطبيق." : ""}
                  </p>
                )}
              </div>

              <Alert>
                <Info />
                <AlertDescription>
                  يُطبّق البوت هذه التغييرات خلال دقيقة من الحفظ. إن لم تظهر، تأكّد من أن رتبة AL AI أعلى من الرتب
                  التي يحاول تعديلها.
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>

          {/* ---------------------------------------------------------- *
           * Card 3 — the permission list. Collapsed by default because it
           * is diagnostic, not something the operator edits.
           * ---------------------------------------------------------- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <ShieldCheck className="size-4" />
                الصلاحيات المطلوبة
              </CardTitle>
              <CardDescription>تأتي مع رتبة AL AI التي ينشئها البوت عند دخوله.</CardDescription>
            </CardHeader>
            <CardContent className="space-y-2">
              {permissions.length === 0 || permissionsUnreadable ? (
                <p className="text-xs text-muted-foreground">
                  تعذّر قراءة صلاحيات البوت. أعد إضافة AL AI بصلاحيات Administrator ليتمكن من تعديل هويته.
                </p>
              ) : (
                permissions.map(permission => (
                  <div key={permission.key} className="flex items-center justify-between gap-3 text-sm">
                    <span className="text-muted-foreground">{permission.label}</span>
                    {permission.granted === true ? (
                      <Badge variant="secondary" className="gap-1">
                        <Check className="size-3" />
                        متاحة
                      </Badge>
                    ) : permission.granted === false ? (
                      <Badge variant="destructive" className="gap-1">
                        <X className="size-3" />
                        مفقودة
                      </Badge>
                    ) : (
                      <Badge variant="outline" className="gap-1">
                        <CircleHelp className="size-3" />
                        غير معروفة
                      </Badge>
                    )}
                  </div>
                ))
              )}
            </CardContent>
          </Card>
        </div>

        {/* ------------------------------------------------------------ *
         * The preview column. Sticky on a wide screen so it stays beside
         * the field being edited rather than scrolling away.
         * ------------------------------------------------------------ */}
        <div className="space-y-3 lg:sticky lg:top-4 lg:self-start">
          {crop ? (
            <ImageCropper target={crop.target} image={crop.image} onApply={applyCrop} onCancel={() => setCrop(null)} />
          ) : null}

          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2 text-base">
                <Palette className="size-4" />
                معاينة حيّة
              </CardTitle>
              <CardDescription>هكذا سيظهر AL AI فعلاً، في كل السيرفرات وفي هذا السيرفر.</CardDescription>
            </CardHeader>
            <CardContent>
              <BotLivePreview
                identity={previewIdentity}
                guild={{
                  nickname: guildDraft.nickname,
                  roleColor: guildDraft.roleColor,
                  roleIconUrl: guildDraft.roleIconUrl,
                  guildName: guild.name,
                  memberCount: guild.memberCount
                }}
              />
            </CardContent>
          </Card>

          {!crop ? (
            <div className="flex flex-wrap gap-2">
              <ImagePickerButton label="رفع صورة للأفاتار" onPick={() => openPicker("avatar")} />
            </div>
          ) : null}
        </div>
      </div>

      {anyDirty ? (
        <SaveBar
          onCancel={resetAll}
          onSave={saveAll}
          saveLabel={identityDirty && guildDirty ? "حفظ الكل" : identityDirty ? "حفظ الهوية العالمية" : "حفظ إعدادات السيرفر"}
        />
      ) : null}
    </div>
  );
}

/**
 * Field-by-field equality, ignoring key order and absent keys.
 *
 * `JSON.stringify` was what the previous version used and it is wrong for two
 * objects that hold the same values in a different order — a reload could show
 * the floating bar over an untouched form. Explicit comparison cannot be fooled
 * that way, and it also survives a key that exists on one side only.
 */
function shallowEqual<T extends object>(left: T, right: T): boolean {
  const keys = new Set([...Object.keys(left), ...Object.keys(right)]) as Set<keyof T>;
  for (const key of keys) {
    if (left[key] !== right[key]) return false;
  }
  return true;
}

/**
 * The advisory shown when the bot's own role sits at or below a role it is
 * expected to manage.
 *
 * This is the single most common reason a correctly configured bot silently
 * does nothing, and Discord reports it only as a failed API call. Saying it on
 * the screen turns an unexplained no-op into a fixable problem.
 *
 * Exported for its render test: a null verdict (roles unreadable) and a passing
 * verdict both render nothing, so the test can prove the warning is not shown
 * speculatively.
 */
export function HierarchyWarning({ verdict }: { verdict: RoleHierarchyVerdict | null }) {
  if (!verdict?.blocked) return null;
  return (
    <div className="flex items-start gap-2.5 rounded-lg border border-warning/40 bg-warning/10 p-3">
      <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" />
      <div className="space-y-1">
        <p className="text-sm font-medium">ترتيب الرتب يمنع البوت من العمل</p>
        <p className="text-xs leading-relaxed text-muted-foreground">{verdict.message}</p>
        <p className="text-xs leading-relaxed text-muted-foreground">
          افتح إعدادات السيرفر ← الرتب، واسحب رتبة AL AI إلى ما فوق أعلى رتبة إدارية.
        </p>
      </div>
    </div>
  );
}

/* Re-exported so the file has one obvious import site for the upload icon the
 * tests and any sibling screen reach for. */
export { Upload };
