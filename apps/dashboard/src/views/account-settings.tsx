/**
 * The account settings centre.
 *
 * This is the one screen in the dashboard that is not scoped to a guild: it
 * answers questions about the signed-in person — their identity, their
 * language, their appearance and their account's security. It lives behind the
 * account menu rather than in the sidebar for that reason.
 *
 * Three rules shape it:
 *
 * 1. **Everything shown is real.** The identity comes from the session, the
 *    language preference from `user_preferences`, and the two-factor state and
 *    session list from `/api/me/security`. Nothing is a placeholder that would
 *    have to be replaced later.
 * 2. **Sensitive actions re-verify a live code.** Changing or disabling the
 *    authenticator, and replacing the recovery codes, all require a current
 *    TOTP or an unused recovery code. The server consumes it, so the client
 *    cannot replay it and no second long-lived credential exists.
 * 3. **Secrets are shown once and drawn locally.** The setup QR is generated in
 *    this browser from the `otpauth://` URI; the recovery codes are displayed
 *    exactly once and require an explicit "I saved these codes" confirmation
 *    before the dialog can close.
 */
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  AlertTriangle,
  Check,
  Copy,
  ExternalLink,
  KeyRound,
  Languages,
  Loader2,
  MonitorSmartphone,
  Moon,
  Palette,
  Power,
  QrCode,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Sun,
  User,
  X
} from "lucide-react";
import { api, ApiError } from "@/api";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import {
  OtpInput,
  QrPanel,
  RecoveryCodeGrid,
  SecretField,
  TotpRing,
  useTotpSeconds
} from "@/components/two-factor-parts";
import { formatDateTime, initials } from "@/lib/format";
import { LANGUAGES, useI18n, type Language } from "@/lib/i18n";
import { Flag } from "@/components/flag";
import { ACCENTS, useThemePrefs, type AccentName, type ThemeMode } from "@/lib/theme";
import { useCopy } from "@/lib/use-copy";
import { cn } from "@/lib/utils";
import type { Guild, SecurityOverview, SecuritySession, SessionInfo, TwoFactorSetup } from "@/types";

type Section = "account" | "appearance" | "language" | "security" | "sessions";
type VerifyIntent = "change" | "disable" | "regenerate";

const MODES: { value: ThemeMode; key: "appearance.light" | "appearance.dark" | "appearance.system"; icon: typeof Sun }[] = [
  { value: "light", key: "appearance.light", icon: Sun },
  { value: "dark", key: "appearance.dark", icon: Moon },
  { value: "system", key: "appearance.system", icon: MonitorSmartphone }
];

/** mm:ss for a setup window, clamped at zero. */
function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** A readable device line from a user-agent string, without claiming more than it says. */
function describeDevice(userAgent: string | null, fallback: string): string {
  if (!userAgent) return fallback;
  const browser = /Edg\//.test(userAgent)
    ? "Edge"
    : /OPR\//.test(userAgent)
      ? "Opera"
      : /Firefox\//.test(userAgent)
        ? "Firefox"
        : /Chrome\//.test(userAgent)
          ? "Chrome"
          : /Safari\//.test(userAgent)
            ? "Safari"
            : null;
  const system = /Windows/.test(userAgent)
    ? "Windows"
    : /Android/.test(userAgent)
      ? "Android"
      : /iPhone|iPad|iPod/.test(userAgent)
        ? "iOS"
        : /Mac OS X/.test(userAgent)
          ? "macOS"
          : /Linux/.test(userAgent)
            ? "Linux"
            : null;
  const label = [browser, system].filter(Boolean).join(" · ");
  return label || userAgent.slice(0, 80);
}

/** Maps the server's stable error codes onto copy in the active language. */
function actionError(cause: unknown, t: ReturnType<typeof useI18n>["t"]): string {
  if (cause instanceof ApiError) {
    switch (cause.code) {
      case "REAUTH_REQUIRED":
        return t("settings.security.reverifyFailed");
      case "CODE_REQUIRED":
        return t("settings.security.uncoded");
      case "SETUP_EXPIRED":
        return t("settings.security.setupExpired");
      case "INVALID_CODE":
        return t("twoFactor.wrongCode");
      case "NOT_ENROLLED":
        return t("settings.security.unprotected");
      default:
        return cause.message;
    }
  }
  return cause instanceof Error ? cause.message : t("common.error");
}

export function SettingsView({
  user,
  guild
}: {
  user: SessionInfo["user"];
  guild: Guild;
}) {
  const { t, language, setLanguage } = useI18n();
  const { prefs, setMode, setAccent } = useThemePrefs();
  const { copied, copy } = useCopy();

  const [section, setSection] = useState<Section>("account");
  const [notice, setNotice] = useState<{ kind: "success" | "error"; text: string } | null>(null);

  const [overview, setOverview] = useState<SecurityOverview | null>(null);
  const [securityLoading, setSecurityLoading] = useState(true);
  const [securityError, setSecurityError] = useState<string | null>(null);

  const [languageState, setLanguageState] = useState<"idle" | "saving" | "saved" | "error">("idle");

  const [verifyIntent, setVerifyIntent] = useState<VerifyIntent | null>(null);
  const [verifyCode, setVerifyCode] = useState("");
  const [verifyBusy, setVerifyBusy] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);

  const [setup, setSetup] = useState<TwoFactorSetup | null>(null);
  const [setupOpen, setSetupOpen] = useState(false);
  const [setupCode, setSetupCode] = useState("");
  const [setupSaved, setSetupSaved] = useState(false);
  const [setupBusy, setSetupBusy] = useState(false);
  const [setupError, setSetupError] = useState<string | null>(null);
  const [setupLeft, setSetupLeft] = useState(0);

  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const [codesSaved, setCodesSaved] = useState(false);

  const [revokeOpen, setRevokeOpen] = useState(false);
  const [revoking, setRevoking] = useState(false);

  const totpSeconds = useTotpSeconds();

  const loadSecurity = useCallback(async () => {
    setSecurityLoading(true);
    try {
      setOverview(await api.securityOverview());
      setSecurityError(null);
    } catch (cause) {
      setSecurityError(cause instanceof Error ? cause.message : t("settings.security.loadFailed"));
    } finally {
      setSecurityLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void loadSecurity();
  }, [loadSecurity]);

  // A success notice is a receipt, not a banner: it leaves on its own.
  useEffect(() => {
    if (!notice || notice.kind !== "success") return;
    const timer = setTimeout(() => setNotice(null), 5000);
    return () => clearTimeout(timer);
  }, [notice]);

  // Setup deadlines are real server deadlines; the countdown only mirrors them.
  useEffect(() => {
    if (!setup || !setupOpen) return;
    const deadline = new Date(setup.expiresAt).getTime();
    if (Number.isNaN(deadline)) return;
    const tick = () => setSetupLeft(Math.max(0, deadline - Date.now()));
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [setup, setupOpen]);

  const sections: { key: Section; label: string; icon: typeof User }[] = [
    { key: "account", label: t("settings.nav.account"), icon: User },
    { key: "appearance", label: t("settings.nav.appearance"), icon: Palette },
    { key: "language", label: t("settings.nav.language"), icon: Languages },
    { key: "security", label: t("settings.nav.security"), icon: ShieldCheck },
    { key: "sessions", label: t("settings.nav.sessions"), icon: MonitorSmartphone }
  ];

  const enrolled = overview?.twoFactor.enrolled === true;
  const sessions = overview?.sessions ?? [];
  const others = sessions.filter(item => !item.current).length;

  function openVerify(intent: VerifyIntent) {
    setVerifyIntent(intent);
    setVerifyCode("");
    setVerifyError(null);
  }

  async function confirmLanguage(next: Language) {
    if (next === language) return;
    const previous = language;
    setLanguage(next);
    setLanguageState("saving");
    try {
      await api.savePreferences(next);
      setLanguageState("saved");
    } catch {
      // The account is the source of truth across devices. If the write did
      // not land, put the interface back where the server still has it rather
      // than leaving this tab claiming a preference nobody stored.
      setLanguage(previous);
      setLanguageState("error");
    }
  }

  async function submitVerify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!verifyIntent || verifyBusy) return;
    const code = verifyCode.trim();
    if (!code) {
      setVerifyError(t("settings.security.uncoded"));
      return;
    }
    setVerifyBusy(true);
    setVerifyError(null);
    try {
      if (verifyIntent === "change") {
        const next = await api.beginTwoFactorSetup(code);
        setVerifyIntent(null);
        openSetup(next);
        return;
      }
      if (verifyIntent === "disable") {
        await api.disableTwoFactor(code);
        setVerifyIntent(null);
        setNotice({ kind: "success", text: t("settings.security.disableSuccess") });
        await loadSecurity();
        return;
      }
      const result = await api.regenerateRecoveryCodes(code);
      setVerifyIntent(null);
      setCodesSaved(false);
      setNewCodes(result.recoveryCodes);
      await loadSecurity();
    } catch (cause) {
      setVerifyError(actionError(cause, t));
    } finally {
      setVerifyBusy(false);
    }
  }

  function openSetup(next: TwoFactorSetup) {
    setSetup(next);
    setSetupOpen(true);
    setSetupCode("");
    setSetupSaved(false);
    setSetupError(null);
  }

  async function startSetup() {
    setSetupBusy(true);
    setSetupError(null);
    try {
      openSetup(await api.beginTwoFactorSetup());
    } catch (cause) {
      setNotice({ kind: "error", text: actionError(cause, t) });
    } finally {
      setSetupBusy(false);
    }
  }

  async function confirmSetup(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!setup || setupBusy) return;
    if (!setupCode.trim()) {
      setSetupError(t("settings.security.uncoded"));
      return;
    }
    if (!setupSaved) {
      setSetupError(t("twoFactor.savedRequired"));
      return;
    }
    if (setupLeft <= 0) {
      setSetupError(t("settings.security.setupExpired"));
      return;
    }
    setSetupBusy(true);
    setSetupError(null);
    try {
      await api.confirmTwoFactorSetup(setupCode.trim());
      const replacing = setup.replacing;
      setSetupOpen(false);
      setSetup(null);
      setNotice({
        kind: "success",
        text: replacing ? t("settings.security.changeSuccess") : t("settings.security.setupSuccess")
      });
      await loadSecurity();
    } catch (cause) {
      setSetupError(actionError(cause, t));
    } finally {
      setSetupBusy(false);
    }
  }

  async function revokeOthers() {
    if (revoking) return;
    setRevoking(true);
    try {
      const result = await api.revokeOtherSessions();
      setRevokeOpen(false);
      setNotice({ kind: "success", text: t("settings.sessions.revoked", { count: result.revoked }) });
      await loadSecurity();
    } catch (cause) {
      setNotice({ kind: "error", text: actionError(cause, t) });
    } finally {
      setRevoking(false);
    }
  }

  const verifyTitle = useMemo(() => {
    if (verifyIntent === "change") return t("settings.security.changeTitle");
    if (verifyIntent === "disable") return t("settings.security.disableTitle");
    return t("settings.security.regenerateTitle");
  }, [verifyIntent, t]);

  return (
    <div className="space-y-4">
      {notice ? (
        <div
          role="status"
          aria-live="polite"
          className={cn(
            "flex items-start gap-2 rounded-xl border px-3 py-2.5 text-sm",
            notice.kind === "success"
              ? "border-success/30 bg-success/10 text-success"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          )}
        >
          {notice.kind === "success" ? (
            <Check className="mt-0.5 size-4 shrink-0" aria-hidden />
          ) : (
            <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          )}
          <span className="min-w-0 flex-1 leading-relaxed">{notice.text}</span>
          <button
            type="button"
            onClick={() => setNotice(null)}
            aria-label={t("common.close")}
            className="rounded p-0.5 opacity-70 transition hover:opacity-100"
          >
            <X className="size-3.5" aria-hidden />
          </button>
        </div>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
        <nav aria-label={t("settings.title")} className="min-w-0 max-w-full lg:sticky lg:top-4 lg:self-start">
          <div className="scrollbar-none flex gap-1 overflow-x-auto pb-1 lg:flex-col lg:overflow-visible lg:pb-0">
            {sections.map(item => {
              const Icon = item.icon;
              const active = section === item.key;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => setSection(item.key)}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex shrink-0 items-center gap-2.5 rounded-xl border px-3 py-2.5 text-start text-sm transition-ui lg:w-full",
                    active
                      ? "border-primary/35 bg-primary/10 font-medium text-foreground"
                      : "border-transparent text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  )}
                >
                  <Icon className={cn("size-4 shrink-0", active && "text-primary")} aria-hidden />
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.key === "sessions" && sessions.length > 0 ? (
                    <span className="rounded-full bg-muted px-1.5 text-micro tabular text-muted-foreground">
                      {sessions.length}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </nav>

        <div className="min-w-0 space-y-4">
          {section === "account" ? (
            <Card>
              <CardHeader className="flex-row items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
                  <User className="size-5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <CardTitle className="text-base">{t("settings.section.account")}</CardTitle>
                  <CardDescription>{t("settings.section.accountBody")}</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
                  <Avatar className="size-16">
                    {user?.avatarUrl ? <AvatarImage src={user.avatarUrl} alt="" /> : null}
                    <AvatarFallback className="text-lg">{initials(user?.username)}</AvatarFallback>
                  </Avatar>
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-lg font-semibold leading-tight">
                      <bdi>{user?.username ?? "—"}</bdi>
                    </p>
                    {user?.handle ? (
                      <p className="truncate text-xs text-muted-foreground" dir="ltr">
                        @{user.handle}
                      </p>
                    ) : null}
                    <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                      <Badge variant="secondary" className="gap-1">
                        <ShieldCheck className="size-3" aria-hidden />
                        {guild.tier ? t(`tier.${guild.tier}` as "tier.owner") : t("tier.member")}
                      </Badge>
                      {user?.isPlatformOwner ? (
                        <Badge variant="outline" className="border-primary/40 text-primary">
                          {t("settings.account.owner")}
                        </Badge>
                      ) : null}
                    </div>
                  </div>
                  <Button asChild variant="outline" size="sm" className="shrink-0">
                    <a
                      href={user?.id ? `https://discord.com/users/${user.id}` : "https://discord.com"}
                      target="_blank"
                      rel="noreferrer"
                    >
                      <ExternalLink aria-hidden />
                      {t("settings.account.openDiscord")}
                    </a>
                  </Button>
                </div>

                <Separator />

                <dl className="grid gap-3 sm:grid-cols-3">
                  <div className="min-w-0">
                    <dt className="text-mini font-medium text-muted-foreground">{t("settings.account.id")}</dt>
                    <dd className="mt-0.5 flex items-center gap-1 text-sm" dir="ltr">
                      <span className="truncate font-mono text-xs">{user?.id ?? "—"}</span>
                      <button
                        type="button"
                        onClick={() => void copy(user?.id ?? "", "account-id")}
                        aria-label={t("settings.account.copyId")}
                        title={t("settings.account.copyId")}
                        className="rounded p-0.5 text-muted-foreground transition hover:bg-muted hover:text-foreground"
                      >
                        {copied === "account-id" ? (
                          <Check className="size-3.5 text-success" aria-hidden />
                        ) : (
                          <Copy className="size-3.5" aria-hidden />
                        )}
                      </button>
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-mini font-medium text-muted-foreground">{t("settings.account.handle")}</dt>
                    <dd className="mt-0.5 truncate text-sm" dir="ltr">
                      {user?.handle ? `@${user.handle}` : "—"}
                    </dd>
                  </div>
                  <div className="min-w-0">
                    <dt className="text-mini font-medium text-muted-foreground">
                      {t("settings.account.memberSince")}
                    </dt>
                    <dd className="mt-0.5 truncate text-sm">{formatDateTime(user?.expiresAt, language)}</dd>
                  </div>
                </dl>

                <p className="flex items-center gap-1.5 text-mini text-muted-foreground" aria-live="polite">
                  {copied === "account-id" ? (
                    <>
                      <Check className="size-3 text-success" aria-hidden />
                      {t("settings.account.idCopied")}
                    </>
                  ) : null}
                </p>
              </CardContent>
            </Card>
          ) : null}

          {section === "appearance" ? (
            <Card>
              <CardHeader className="flex-row items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
                  <Palette className="size-5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <CardTitle className="text-base">{t("settings.section.appearance")}</CardTitle>
                  <CardDescription>{t("settings.section.appearanceBody")}</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-5">
                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">{t("appearance.mode")}</p>
                  <div className="grid gap-2 sm:grid-cols-3" role="group" aria-label={t("appearance.modeLabel")}>
                    {MODES.map(mode => {
                      const Icon = mode.icon;
                      const active = prefs.mode === mode.value;
                      return (
                        <button
                          key={mode.value}
                          type="button"
                          onClick={() => setMode(mode.value)}
                          aria-pressed={active}
                          className={cn(
                            "flex items-center gap-2 rounded-xl border px-3 py-3 text-sm transition-ui",
                            active
                              ? "border-primary bg-primary/10 font-medium"
                              : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                          )}
                        >
                          <Icon className={cn("size-4", active && "text-primary")} aria-hidden />
                          <span className="min-w-0 flex-1 text-start">{t(mode.key)}</span>
                          {active ? <Check className="size-4 text-primary" aria-hidden /> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-medium text-muted-foreground">{t("appearance.accent")}</p>
                  <div className="flex flex-wrap gap-2.5" role="group" aria-label={t("appearance.accent")}>
                    {ACCENTS.map(accent => {
                      const active = prefs.accent === accent.name;
                      return (
                        <button
                          key={accent.name}
                          type="button"
                          onClick={() => setAccent(accent.name as AccentName)}
                          aria-label={t(`appearance.${accent.name}` as "appearance.blue")}
                          aria-pressed={active}
                          title={t(`appearance.${accent.name}` as "appearance.blue")}
                          className={cn(
                            "grid size-9 place-items-center rounded-full border-2 transition-ui",
                            active ? "border-foreground" : "border-transparent hover:border-muted-foreground/50"
                          )}
                          style={{ backgroundColor: accent.swatch }}
                        >
                          {active ? <Check className="size-4 text-white" aria-hidden /> : null}
                        </button>
                      );
                    })}
                  </div>
                </div>

                <p className="text-mini leading-relaxed text-muted-foreground">{t("settings.appearance.note")}</p>
              </CardContent>
            </Card>
          ) : null}

          {section === "language" ? (
            <Card>
              <CardHeader className="flex-row items-center gap-3">
                <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
                  <Languages className="size-5" aria-hidden />
                </span>
                <div className="min-w-0">
                  <CardTitle className="text-base">{t("settings.section.language")}</CardTitle>
                  <CardDescription>{t("settings.section.languageBody")}</CardDescription>
                </div>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label={t("settings.section.language")}>
                  {LANGUAGES.map(item => {
                    const active = language === item.value;
                    return (
                      <button
                        key={item.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => void confirmLanguage(item.value)}
                        className={cn(
                          "flex items-start gap-3 rounded-xl border p-3 text-start transition-ui",
                          active
                            ? "border-primary bg-primary/10"
                            : "border-border hover:bg-muted/50"
                        )}
                      >
                        <span
                          className={cn(
                            "mt-0.5 grid size-5 shrink-0 place-items-center rounded-full border",
                            active ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40"
                          )}
                          aria-hidden
                        >
                          {active ? <Check className="size-3" /> : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex items-center gap-2">
                            <Flag value={item.value} className="h-4 w-6 shrink-0 rounded-[2px] shadow-sm ring-1 ring-black/10" />
                            <span className="block text-sm font-medium">{t(`settings.language.${item.value === "ar" ? "arabic" : item.value === "en" ? "english" : "german"}` as "settings.language.arabic")}</span>
                          </span>
                          <span className="mt-0.5 block text-mini text-muted-foreground">
                            {t(`settings.language.${item.value === "ar" ? "arabicHint" : item.value === "en" ? "englishHint" : "germanHint"}` as "settings.language.arabicHint")}
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </div>

                <p className="min-h-5 text-mini leading-relaxed" aria-live="polite">
                  {languageState === "saving" ? (
                    <span className="inline-flex items-center gap-1.5 text-muted-foreground">
                      <Loader2 className="size-3 animate-spin" aria-hidden />
                      {t("common.saving")}
                    </span>
                  ) : languageState === "saved" ? (
                    <span className="inline-flex items-center gap-1.5 text-success">
                      <Check className="size-3" aria-hidden />
                      {t("settings.language.saved")}
                    </span>
                  ) : languageState === "error" ? (
                    <span className="inline-flex items-center gap-1.5 text-destructive">
                      <AlertTriangle className="size-3" aria-hidden />
                      {t("settings.language.failed")}
                    </span>
                  ) : null}
                </p>
              </CardContent>
            </Card>
          ) : null}

          {section === "security" ? (
            <>
              <Card>
                <CardHeader className="flex-row items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
                    <ShieldCheck className="size-5" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <CardTitle className="text-base">{t("settings.section.security")}</CardTitle>
                    <CardDescription>{t("settings.section.securityBody")}</CardDescription>
                  </div>
                </CardHeader>
                <CardContent>
                  {securityLoading && !overview ? (
                    <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
                      <Loader2 className="size-4 animate-spin" aria-hidden />
                      {t("common.loading")}
                    </div>
                  ) : securityError && !overview ? (
                    <div className="flex flex-col items-start gap-2 py-4">
                      <p className="text-sm text-destructive">{securityError}</p>
                      <Button variant="outline" size="sm" onClick={() => void loadSecurity()}>
                        <RefreshCw aria-hidden />
                        {t("settings.security.retry")}
                      </Button>
                    </div>
                  ) : (
                    <div className="space-y-4">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
                        <span
                          className={cn(
                            "grid size-11 shrink-0 place-items-center rounded-xl",
                            enrolled ? "bg-success/12 text-success" : "bg-warning/12 text-warning"
                          )}
                        >
                          {enrolled ? (
                            <ShieldCheck className="size-6" aria-hidden />
                          ) : (
                            <ShieldAlert className="size-6" aria-hidden />
                          )}
                        </span>
                        <div className="min-w-0 flex-1">
                          <h3 className="text-sm font-semibold leading-snug">
                            {enrolled ? t("settings.security.protected") : t("settings.security.unprotected")}
                          </h3>
                          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                            {enrolled
                              ? t("settings.security.protectedBody")
                              : t("settings.security.unprotectedBody")}
                          </p>
                          {enrolled ? (
                            <div className="mt-2 flex flex-wrap items-center gap-1.5 text-mini text-muted-foreground">
                              {overview?.twoFactor.confirmedAt ? (
                                <span>
                                  {t("settings.security.confirmedAt", {
                                    date: formatDateTime(overview.twoFactor.confirmedAt, language)
                                  })}
                                </span>
                              ) : null}
                              <span aria-hidden>·</span>
                              <span className="inline-flex items-center gap-1">
                                <KeyRound className="size-3" aria-hidden />
                                {overview && overview.twoFactor.recoveryCodesRemaining > 0
                                  ? t("settings.security.recoveryLeft", {
                                      count: overview.twoFactor.recoveryCodesRemaining
                                    })
                                  : t("settings.security.recoveryNone")}
                              </span>
                            </div>
                          ) : null}
                        </div>
                        <Badge variant={enrolled ? "secondary" : "outline"} className="shrink-0">
                          {enrolled ? t("common.enabled") : t("common.disabled")}
                        </Badge>
                      </div>

                      <Separator />

                      <div className="flex flex-wrap gap-2">
                        {enrolled ? (
                          <>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openVerify("change")}
                              disabled={securityLoading}
                            >
                              <QrCode aria-hidden />
                              {t("settings.security.change")}
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() => openVerify("regenerate")}
                              disabled={securityLoading}
                            >
                              <RefreshCw aria-hidden />
                              {t("settings.security.regenerate")}
                            </Button>
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => openVerify("disable")}
                              disabled={securityLoading}
                              className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                            >
                              <Power aria-hidden />
                              {t("settings.security.disable")}
                            </Button>
                          </>
                        ) : (
                          <Button size="sm" onClick={() => void startSetup()} loading={setupBusy}>
                            <ShieldCheck aria-hidden />
                            {t("settings.security.enable")}
                          </Button>
                        )}
                      </div>

                      <p className="text-mini leading-relaxed text-muted-foreground">
                        {t("settings.security.reverifyBody")}
                      </p>
                      {securityError ? <p className="text-mini text-destructive">{securityError}</p> : null}
                    </div>
                  )}
                </CardContent>
              </Card>

              {enrolled ? (
                <Card>
                  <CardHeader className="flex-row items-center gap-3">
                    <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-warning/12 text-warning">
                      <KeyRound className="size-5" aria-hidden />
                    </span>
                    <div className="min-w-0">
                      <CardTitle className="text-base">
                        {t("settings.security.recoveryCodes", {
                          count: overview?.twoFactor.recoveryCodesRemaining ?? 0
                        })}
                      </CardTitle>
                      <CardDescription>{t("settings.security.oneTimeBody")}</CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent>
                    <p className="text-mini leading-relaxed text-muted-foreground">
                      {t("settings.security.regenerateWarning")}
                    </p>
                    <p className="mt-1 text-mini leading-relaxed text-muted-foreground">
                      {t("settings.security.oneTime")}
                    </p>
                  </CardContent>
                </Card>
              ) : null}
            </>
          ) : null}

          {section === "sessions" ? (
            <Card>
              <CardHeader className="flex-row items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className="grid size-10 shrink-0 place-items-center rounded-xl bg-primary/12 text-primary">
                    <MonitorSmartphone className="size-5" aria-hidden />
                  </span>
                  <div className="min-w-0">
                    <CardTitle className="text-base">{t("settings.section.sessions")}</CardTitle>
                    <CardDescription>{t("settings.section.sessionsBody")}</CardDescription>
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => void loadSecurity()}
                  disabled={securityLoading}
                  aria-label={t("settings.sessions.refresh")}
                  title={t("settings.sessions.refresh")}
                  className="shrink-0"
                >
                  <RefreshCw className={cn(securityLoading && "animate-spin")} aria-hidden />
                </Button>
              </CardHeader>
              <CardContent className="space-y-3">
                {securityLoading && !overview ? (
                  <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground" role="status">
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                    {t("common.loading")}
                  </div>
                ) : securityError && !overview ? (
                  <div className="space-y-2 py-2">
                    <p className="text-sm text-destructive">{securityError}</p>
                    <Button variant="outline" size="sm" onClick={() => void loadSecurity()}>
                      <RefreshCw aria-hidden />
                      {t("settings.security.retry")}
                    </Button>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <p className="text-xs text-muted-foreground">
                        {t("settings.sessions.count", { count: sessions.length })}
                      </p>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => setRevokeOpen(true)}
                        disabled={others === 0 || securityLoading}
                        className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive sm:w-auto"
                      >
                        <Power aria-hidden />
                        {t("settings.sessions.revokeOthers")}
                      </Button>
                    </div>

                    <ul className="space-y-2">
                      {sessions.map((item, index) => (
                        <SessionRow
                          key={`${item.createdAt}-${index}`}
                          session={item}
                          language={language}
                        />
                      ))}
                    </ul>

                    {others === 0 ? (
                      <p className="text-mini text-muted-foreground">{t("settings.sessions.noneOthers")}</p>
                    ) : null}
                  </>
                )}
              </CardContent>
            </Card>
          ) : null}
        </div>
      </div>

      {/* ---------------------------------------------------------------- *
       * Re-verification: change, disable or replace recovery codes
       * ---------------------------------------------------------------- */}
      <Dialog
        open={verifyIntent !== null}
        onOpenChange={open => {
          if (!open && !verifyBusy) {
            setVerifyIntent(null);
            setVerifyCode("");
            setVerifyError(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <form onSubmit={submitVerify} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{verifyTitle}</DialogTitle>
              <DialogDescription>{t("settings.security.reverifyBody")}</DialogDescription>
            </DialogHeader>

            <div className="space-y-3 rounded-2xl border border-white/10 bg-[#080d0b] p-4">
              <label htmlFor="settings-reverify-code" className="block text-mini font-medium text-white/60">
                {t("settings.security.codeLabel")}
              </label>
              <input
                id="settings-reverify-code"
                name="code"
                type="text"
                dir="ltr"
                autoComplete="one-time-code"
                maxLength={128}
                value={verifyCode}
                onChange={event => setVerifyCode(event.target.value)}
                placeholder={t("settings.security.codePlaceholder")}
                disabled={verifyBusy}
                className="h-11 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 text-center font-mono text-sm tracking-widest text-white placeholder:text-white/20 focus:border-[#6ee7b7] focus:outline-none focus:ring-2 focus:ring-[#6ee7b7]/20"
              />
              <div className="flex items-center justify-between gap-2 text-micro text-white/35">
                <span>{t("settings.security.secretWarning")}</span>
                <TotpRing seconds={totpSeconds} />
              </div>
              {verifyIntent === "disable" ? (
                <p className="flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-2.5 py-2 text-micro leading-relaxed text-amber-200/90">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                  {t("settings.security.disableWarning")}
                </p>
              ) : null}
              {verifyIntent === "regenerate" ? (
                <p className="flex items-start gap-2 rounded-lg border border-amber-400/25 bg-amber-400/[0.06] px-2.5 py-2 text-micro leading-relaxed text-amber-200/90">
                  <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden />
                  {t("settings.security.regenerateWarning")}
                </p>
              ) : null}
              {verifyError ? (
                <p role="alert" className="rounded-lg border border-red-400/25 bg-red-400/[0.07] px-2.5 py-2 text-mini text-red-200">
                  {verifyError}
                </p>
              ) : null}
            </div>

            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setVerifyIntent(null)}
                disabled={verifyBusy}
              >
                {t("common.cancel")}
              </Button>
              <Button type="submit" loading={verifyBusy} disabled={verifyBusy}>
                {t("settings.security.verify")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---------------------------------------------------------------- *
       * New authenticator setup
       * ---------------------------------------------------------------- */}
      <Dialog
        open={setupOpen}
        onOpenChange={open => {
          if (!open && !setupBusy) setSetupOpen(false);
        }}
      >
        <DialogContent className="sm:max-w-3xl">
          <form onSubmit={confirmSetup} className="space-y-4">
            <DialogHeader>
              <DialogTitle>{t("settings.security.setupTitle")}</DialogTitle>
              <DialogDescription>
                {setup?.replacing ? t("settings.security.setupReplaceBody") : t("settings.security.setupBody")}
              </DialogDescription>
            </DialogHeader>

            <div className="space-y-4 rounded-2xl border border-white/10 bg-[#080d0b] p-4 sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-2 text-micro text-white/40">
                <span className="inline-flex items-center gap-1.5 rounded-full border border-[#6ee7b7]/25 bg-[#6ee7b7]/[0.07] px-2.5 py-1 text-[#8ff0c5]">
                  <ShieldCheck className="size-3" aria-hidden />
                  {t("settings.security.stepScan")} · {t("settings.security.stepVerify")} ·{" "}
                  {t("settings.security.stepSave")}
                </span>
                <span dir="ltr" className="font-mono tabular">
                  {t("settings.security.countdown", { time: formatCountdown(setupLeft) })}
                </span>
              </div>

              <div className="grid gap-5 md:grid-cols-[minmax(0,0.85fr)_minmax(0,1.15fr)]">
                <div className="space-y-3">
                  {setup ? (
                    <QrPanel
                      value={setup.otpauthUri}
                      label={t("settings.security.qrLabel")}
                      caption={t("twoFactor.guideNote")}
                    />
                  ) : null}
                  <p className="text-center text-micro text-white/35">{t("settings.security.appsHint")}</p>
                </div>

                <div className="min-w-0 space-y-3">
                  {setup ? (
                    <>
                      <SecretField
                        secret={setup.secret}
                        label={t("settings.security.secret")}
                        showLabel={t("settings.security.showSecret")}
                        hideLabel={t("settings.security.hideSecret")}
                        copyLabel={t("settings.security.copySecret")}
                        defaultVisible
                      />

                      <div className="space-y-1.5">
                        <p className="text-mini font-medium text-white/55">{t("settings.security.uri")}</p>
                        <div className="flex items-center gap-1.5">
                          <code
                            dir="ltr"
                            className="min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-micro text-white/55"
                          >
                            {setup.otpauthUri}
                          </code>
                          <button
                            type="button"
                            onClick={() => {
                              void navigator.clipboard?.writeText(setup.otpauthUri).catch(() => undefined);
                            }}
                            aria-label={t("settings.security.copyUri")}
                            title={t("settings.security.copyUri")}
                            className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/10 text-white/55 transition hover:border-[#6ee7b7]/50 hover:text-[#8ff0c5]"
                          >
                            <Copy className="size-4" aria-hidden />
                          </button>
                        </div>
                      </div>

                      {setup.recoveryCodes.length > 0 ? (
                        <RecoveryCodeGrid
                          codes={setup.recoveryCodes}
                          title={t("settings.security.recoveryCodes", { count: setup.recoveryCodes.length })}
                          warning={t("settings.security.oneTime")}
                          copyAllLabel={t("settings.security.copyRecovery")}
                          downloadLabel={t("settings.security.downloadRecovery")}
                          copyEachLabel={t("twoFactor.copyEach")}
                        />
                      ) : null}

                      <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
                        <input
                          type="checkbox"
                          checked={setupSaved}
                          onChange={event => setSetupSaved(event.target.checked)}
                          className="mt-0.5 size-4 accent-[#6ee7b7]"
                        />
                        <span className="text-mini leading-relaxed text-white/60">
                          {t("settings.security.savedCodes")}
                        </span>
                      </label>

                      <div className="space-y-2">
                        <div className="flex items-center justify-between gap-2">
                          <label htmlFor="settings-2fa-code" className="text-mini font-medium text-white/55">
                            {t("settings.security.setupCodeLabel")}
                          </label>
                          <TotpRing seconds={totpSeconds} />
                        </div>
                        <OtpInput
                          id="settings-2fa-code"
                          value={setupCode}
                          onChange={setSetupCode}
                          disabled={setupBusy || setupLeft <= 0}
                          autoFocus
                          ariaLabel={t("settings.security.setupCodeLabel")}
                          describedBy="settings-2fa-hint"
                        />
                        <p id="settings-2fa-hint" className="text-micro leading-relaxed text-white/35">
                          {t("twoFactor.hintSetup")}
                        </p>
                      </div>
                    </>
                  ) : null}
                </div>
              </div>

              {setupError ? (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-red-400/25 bg-red-400/[0.07] px-3 py-2 text-mini leading-relaxed text-red-200/90"
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {setupError}
                </p>
              ) : null}
            </div>

            <DialogFooter className="gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setSetupOpen(false)}
                disabled={setupBusy}
              >
                {t("common.cancel")}
              </Button>
              <Button
                type="submit"
                loading={setupBusy}
                disabled={setupBusy || setupLeft <= 0 || !setupSaved || setupCode.length === 0}
              >
                <ShieldCheck aria-hidden />
                {setup?.replacing ? t("settings.security.confirmChange") : t("settings.security.confirmSetup")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      {/* ---------------------------------------------------------------- *
       * The new recovery codes, shown exactly once
       * ---------------------------------------------------------------- */}
      <Dialog
        open={newCodes !== null}
        onOpenChange={open => {
          if (!open && codesSaved) {
            setNewCodes(null);
            setCodesSaved(false);
          }
        }}
      >
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("settings.security.newCodesTitle")}</DialogTitle>
            <DialogDescription>{t("settings.security.regenerated")}</DialogDescription>
          </DialogHeader>

          {newCodes ? (
            <div className="space-y-3 rounded-2xl border border-white/10 bg-[#080d0b] p-4">
              <RecoveryCodeGrid
                codes={newCodes}
                title={t("settings.security.recoveryCodes", { count: newCodes.length })}
                warning={t("settings.security.oneTime")}
                copyAllLabel={t("settings.security.copyRecovery")}
                downloadLabel={t("settings.security.downloadRecovery")}
                copyEachLabel={t("twoFactor.copyEach")}
              />
              <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
                <input
                  type="checkbox"
                  checked={codesSaved}
                  onChange={event => setCodesSaved(event.target.checked)}
                  className="mt-0.5 size-4 accent-[#6ee7b7]"
                />
                <span className="text-mini leading-relaxed text-white/60">{t("settings.security.savedCodes")}</span>
              </label>
            </div>
          ) : null}

          <DialogFooter>
            <Button
              onClick={() => {
                setNewCodes(null);
                setCodesSaved(false);
              }}
              disabled={!codesSaved}
            >
              {t("settings.security.done")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---------------------------------------------------------------- *
       * Signing out the other sessions
       * ---------------------------------------------------------------- */}
      <Dialog open={revokeOpen} onOpenChange={setRevokeOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("settings.sessions.revokeTitle")}</DialogTitle>
            <DialogDescription>{t("settings.sessions.revokeBody")}</DialogDescription>
          </DialogHeader>
          <div className="flex items-start gap-2 rounded-xl border border-destructive/25 bg-destructive/5 px-3 py-2.5 text-xs leading-relaxed text-destructive">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t("settings.sessions.count", { count: others })}
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setRevokeOpen(false)} disabled={revoking}>
              {t("common.cancel")}
            </Button>
            <Button variant="destructive" onClick={() => void revokeOthers()} loading={revoking}>
              <Power aria-hidden />
              {t("settings.sessions.revokeOthers")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** One live session, as a readable row rather than a table of timestamps. */
function SessionRow({
  session,
  language
}: {
  session: SecuritySession;
  language: Language;
}) {
  const { t } = useI18n();
  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-xl border p-3 sm:flex-row sm:items-center sm:justify-between",
        session.current ? "border-primary/30 bg-primary/[0.04]" : "border-border"
      )}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <span
          className={cn(
            "mt-0.5 grid size-8 shrink-0 place-items-center rounded-lg",
            session.current ? "bg-primary/12 text-primary" : "bg-muted text-muted-foreground"
          )}
        >
          <MonitorSmartphone className="size-4" aria-hidden />
        </span>
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-1.5 text-sm font-medium leading-snug">
            <span className="truncate">{describeDevice(session.userAgent, t("settings.sessions.unknownDevice"))}</span>
            {session.current ? (
              <Badge variant="secondary" className="shrink-0 text-micro">
                {t("settings.sessions.current")}
              </Badge>
            ) : null}
          </p>
          <p className="mt-0.5 flex flex-wrap gap-x-2 gap-y-0.5 text-mini text-muted-foreground">
            <span>{t("settings.sessions.lastSeen", { time: formatDateTime(session.lastSeenAt, language) })}</span>
            <span aria-hidden>·</span>
            <span>{t("settings.sessions.created", { time: formatDateTime(session.createdAt, language) })}</span>
          </p>
        </div>
      </div>
      <p className="shrink-0 text-mini text-muted-foreground sm:text-end">
        {t("settings.sessions.expires", { time: formatDateTime(session.expiresAt, language) })}
      </p>
    </li>
  );
}
