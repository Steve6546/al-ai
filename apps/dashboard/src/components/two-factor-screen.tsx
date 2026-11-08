import { useEffect, useRef, useState, type FormEvent } from "react";
import { AlertTriangle, Check, Clock, Copy, KeyRound, Loader2, ShieldCheck, X } from "lucide-react";
import { api, ApiError } from "@/api";
import {
  compactSecret,
  OtpInput,
  QrPanel,
  RecoveryCodeGrid,
  SecretField,
  TotpRing,
  downloadText,
  useTotpSeconds
} from "@/components/two-factor-parts";
import { useI18n } from "@/lib/i18n";
import type { TwoFactorEnrollment } from "@/types";

/** mm:ss remaining on a pending login, clamped at zero. */
function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The second step of an admin sign-in.
 *
 * OAuth has identified the operator but the BFF has deliberately not issued a
 * session cookie yet: `GET /api/session` reports `secondFactor.required`. This
 * screen either confirms an already-enrolled authenticator with a code, or —
 * when the admin has never confirmed one — walks them through setting it up
 * and confirms enrolment with the first generated code.
 *
 * The visual language is the supplied dark split card: the QR lives on a
 * near-black plate with mint corner brackets, the form sits beside it, and the
 * whole surface is independent of the light/dark theme because a security
 * challenge should look the same everywhere. On a phone the two columns stack.
 *
 * Nothing here invents a success: `onVerified` runs only after
 * `POST /api/2fa/verify` really resolves, and a pending login that lapses (by
 * the countdown or a `PENDING_EXPIRED` reply) calls `onExpired` instead.
 */
export function TwoFactorScreen({
  enrolled,
  notice,
  onVerified,
  onCancelled,
  onExpired
}: {
  enrolled: boolean;
  notice?: string | null;
  onVerified: () => void;
  onCancelled: () => void;
  onExpired?: () => void;
}) {
  const { t, dir } = useI18n();

  /* ---------------------------------------------------------------- *
   * All hooks live above this point, before any conditional rendering. *
   * ---------------------------------------------------------------- */
  const [useRecovery, setUseRecovery] = useState(false);
  const [code, setCode] = useState("");
  const [verifying, setVerifying] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [remainingMs, setRemainingMs] = useState<number | null>(null);
  const [savedCodes, setSavedCodes] = useState(false);

  const [enrollment, setEnrollment] = useState<TwoFactorEnrollment | null>(null);
  const [enrollmentError, setEnrollmentError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  const totpSeconds = useTotpSeconds();

  // The parent passes fresh inline callbacks on each of its renders. Keep the
  // one the interval uses in a ref so the 1s timer is built once, and guard the
  // expiry so a re-render can never fire `onExpired` twice.
  const onExpiredRef = useRef(onExpired);
  onExpiredRef.current = onExpired;
  const expiredFiredRef = useRef(false);

  // `GET /api/2fa/enrollment` answers with `expiresAt` in BOTH states (the
  // enrolled shape simply nulls the secret and empties the codes), so one read
  // supplies the pending-login deadline for the countdown.
  useEffect(() => {
    let cancelled = false;
    setEnrollment(null);
    setEnrollmentError(null);
    api
      .secondFactorEnrollment()
      .then(result => !cancelled && setEnrollment(result))
      .catch(cause =>
        !cancelled &&
        setEnrollmentError(cause instanceof Error ? cause.message : t("twoFactor.loadFailed"))
      );
    return () => {
      cancelled = true;
    };
    // `t` is intentionally not a dependency: the fetch must not repeat on a
    // language switch, and only the failure sentence uses it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadToken]);

  const expiresAt = enrollment?.expiresAt ?? null;

  useEffect(() => {
    if (!expiresAt) {
      setRemainingMs(null);
      return;
    }
    const deadline = new Date(expiresAt).getTime();
    if (Number.isNaN(deadline)) {
      setRemainingMs(null);
      return;
    }
    const tick = () => {
      const left = deadline - Date.now();
      setRemainingMs(Math.max(0, left));
      if (left <= 0 && !expiredFiredRef.current) {
        expiredFiredRef.current = true;
        setExpired(true);
        onExpiredRef.current?.();
      }
    };
    tick();
    const timer = setInterval(tick, 1000);
    return () => clearInterval(timer);
  }, [expiresAt]);

  /* ---------------------------------------------------------------- *
   * Actions                                                          *
   * ---------------------------------------------------------------- */

  async function copy(text: string, what: string) {
    try {
      if (!navigator.clipboard?.writeText) {
        setCopyStatus(t("twoFactor.copyFailed"));
        return;
      }
      await navigator.clipboard.writeText(text);
      setCopyStatus(t("twoFactor.copySuccess", { what }));
    } catch {
      setCopyStatus(t("twoFactor.copyFailed"));
    }
  }

  async function verify(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (expired || verifying) return;
    const value = code.trim();
    if (!value) {
      setError(t("twoFactor.codeRequired"));
      return;
    }
    if (!enrolled && !useRecovery && !savedCodes) {
      setError(t("twoFactor.savedRequired"));
      return;
    }
    setVerifying(true);
    setError(null);
    try {
      // The server distinguishes a 6-digit TOTP from a recovery code by the
      // shape of `code`; the trimmed value is forwarded unchanged either way.
      await api.verifySecondFactor(value);
      onVerified();
    } catch (cause) {
      if (cause instanceof ApiError) {
        if (cause.code === "PENDING_EXPIRED") {
          expiredFiredRef.current = true;
          setExpired(true);
          setError(cause.message);
          onExpiredRef.current?.();
          return;
        }
        const attempts =
          typeof cause.attemptsRemaining === "number"
            ? ` — ${t("twoFactor.attempts", { count: cause.attemptsRemaining })}`
            : "";
        setError(`${cause.message}${attempts}`);
      } else {
        setError(cause instanceof Error ? cause.message : t("twoFactor.wrongCode"));
      }
    } finally {
      setVerifying(false);
    }
  }

  async function handleCancel() {
    if (cancelling) return;
    setCancelling(true);
    try {
      await api.cancelSecondFactor();
    } catch (cause) {
      // Keep the failure visible, but never trap the operator on a pending
      // login: the parent re-reads /api/session, which is the honest state.
      setError(cause instanceof Error ? cause.message : t("common.error"));
    } finally {
      onCancelled();
    }
  }

  function toggleMode() {
    setUseRecovery(open => !open);
    setCode("");
    setError(null);
  }

  function downloadCodes() {
    if (!enrollment?.recoveryCodes.length) return;
    const header = `${t("twoFactor.recovery", { count: enrollment.recoveryCodes.length })}\n${t("twoFactor.warning")}\n\n`;
    if (downloadText("al-ai-recovery-codes.txt", `${header}${enrollment.recoveryCodes.join("\n")}\n`)) {
      setCopyStatus(t("twoFactor.downloaded"));
    }
  }

  const setupView = !enrolled && enrollment !== null && !enrollment.enrolled;
  const qrReady = setupView && Boolean(enrollment?.otpauthUri);
  const isRecoveryMode = useRecovery && enrolled;

  /* ---------------------------------------------------------------- *
   * Single render — no early returns, so no hook-order black screen.  *
   * ---------------------------------------------------------------- */
  return (
    /*
     * One column, one job: enter a code.
     *
     * The screen used to be a split card — a near-black plate carrying the
     * brand (or the QR) on one side and the form on the other. For a sign-in
     * step that plate was decoration: the operator has already enrolled, so a
     * lock emblem beside the field said nothing the title did not, and on a
     * laptop it halved the width available to six code boxes. The form now owns
     * the card, centred, in the order it is read: what this is, what to type,
     * how long it lasts, then the two actions.
     *
     * Enrolment keeps its QR — it is the only thing that makes a first sign-in
     * possible — but it sits *in* the column above the field instead of beside
     * it, so there is no second layout to maintain.
     */
    <div
      dir={dir}
      className="relative flex h-full justify-center overflow-y-auto overscroll-contain bg-[#050807] p-4 sm:p-6"
    >
      {/* The dithered blue-green texture from the supplied artwork, drawn with
          gradients so no image ever has to be downloaded. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-70"
        style={{
          backgroundImage:
            "radial-gradient(circle at 18% 20%, rgba(56,189,248,0.16), transparent 42%), radial-gradient(circle at 78% 12%, rgba(110,231,183,0.12), transparent 38%), radial-gradient(rgba(255,255,255,0.16) 0.6px, transparent 0.7px)",
          backgroundSize: "auto, auto, 7px 7px"
        }}
      />

      <div className="relative my-auto w-full max-w-md overflow-hidden rounded-3xl border border-white/10 bg-[#080d0b] shadow-[0_30px_120px_rgba(0,0,0,0.65)]">
        <div className="space-y-5 p-6 sm:p-8">
          <header className="space-y-1.5 text-center">
            <h1 className="text-xl font-semibold tracking-tight text-white sm:text-2xl">{t("twoFactor.title")}</h1>
            <p className="text-sm leading-relaxed text-white/50">
              {enrolled ? t("twoFactor.subtitleEnrolled") : t("twoFactor.subtitleSetup")}
            </p>
          </header>

          {notice && (
            <p className="rounded-lg border border-primary/20 bg-primary/[0.06] px-3 py-2 text-center text-mini text-primary">
              {notice}
            </p>
          )}

          {copyStatus && (
            <p role="status" aria-live="polite" className="text-center text-mini text-primary">
              {copyStatus}
            </p>
          )}

          {/* Enrolment material: shown exactly once, never fetched from a
              third-party QR service. It lives in the column because without it
              there is no first code to enter. */}
          {!enrolled && (
            <section aria-label={t("twoFactor.guideTitle")} className="space-y-4">
              <div className="rounded-xl border border-amber-400/25 bg-amber-400/[0.06] px-3 py-2.5">
                <p className="flex items-start gap-2 text-mini leading-relaxed text-amber-200/90">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  <strong className="font-medium">{t("twoFactor.warning")}</strong>
                </p>
              </div>

              {enrollmentError ? (
                <div className="space-y-2 text-center">
                  <p className="rounded-lg border border-red-400/25 bg-red-400/[0.06] px-3 py-2 text-mini text-red-200/85">
                    {enrollmentError}
                  </p>
                  <button
                    type="button"
                    onClick={() => setReloadToken(token => token + 1)}
                    className="text-mini text-primary underline underline-offset-4"
                  >
                    {t("twoFactor.retry")}
                  </button>
                </div>
              ) : enrollment === null ? (
                <div className="flex items-center justify-center gap-2 text-xs text-white/40" role="status">
                  <Loader2 className="size-4 animate-spin" aria-hidden />
                  {t("twoFactor.loading")}
                </div>
              ) : enrollment.enrolled ? (
                <p className="rounded-lg border border-primary/20 bg-primary/[0.06] px-3 py-2 text-center text-mini text-primary">
                  {t("twoFactor.alreadyEnrolled")}
                </p>
              ) : (
                <div className="space-y-4">
                  {/* Narrower than the shared panel's own cap: in a 504px
                      column the default 16rem QR pushed the code field — the
                      thing the operator came here to fill — below the fold. */}
                  {qrReady && enrollment.otpauthUri && (
                    <div className="mx-auto w-full max-w-[14rem]">
                      <QrPanel
                        value={enrollment.otpauthUri}
                        label={t("settings.security.qrLabel")}
                        caption={t("twoFactor.guideNote")}
                      />
                    </div>
                  )}

                  {enrollment.secret && (
                    <SecretField
                      secret={enrollment.secret}
                      label={t("twoFactor.secret")}
                      showLabel={t("twoFactor.showSecret")}
                      hideLabel={t("twoFactor.hideSecret")}
                      copyLabel={t("twoFactor.copySecret")}
                      defaultVisible
                    />
                  )}

                  {enrollment.otpauthUri && (
                    <div className="space-y-1.5">
                      <p className="text-mini font-medium text-white/55">{t("twoFactor.uri")}</p>
                      <div className="flex items-center gap-1.5">
                        <code
                          dir="ltr"
                          className="min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-micro text-white/55"
                        >
                          {enrollment.otpauthUri}
                        </code>
                        <button
                          type="button"
                          onClick={() => void copy(enrollment.otpauthUri ?? "", t("twoFactor.uriCopied"))}
                          aria-label={t("twoFactor.copyUri")}
                          className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/10 text-white/55 transition hover:border-primary/50 hover:text-primary"
                        >
                          <Copy className="size-4" aria-hidden />
                        </button>
                      </div>
                    </div>
                  )}

                  {enrollment.recoveryCodes.length > 0 && (
                    <RecoveryCodeGrid
                      codes={enrollment.recoveryCodes}
                      title={t("twoFactor.recovery", { count: enrollment.recoveryCodes.length })}
                      warning={t("twoFactor.recoveryWarning")}
                      copyAllLabel={t("twoFactor.copyRecovery")}
                      downloadLabel={t("twoFactor.downloadRecovery")}
                      copyEachLabel={t("twoFactor.copyEach")}
                    />
                  )}

                  <label className="flex cursor-pointer items-start gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2.5">
                    <input
                      type="checkbox"
                      checked={savedCodes}
                      onChange={event => setSavedCodes(event.target.checked)}
                      className="mt-0.5 size-4 accent-primary"
                    />
                    <span className="text-mini leading-relaxed text-white/60">{t("twoFactor.recoverySaved")}</span>
                  </label>
                </div>
              )}
            </section>
          )}

          {expired ? (
            <div className="space-y-3">
              <div className="rounded-xl border border-red-400/25 bg-red-400/[0.06] p-3 text-center">
                <p className="text-sm font-medium text-red-200">{t("twoFactor.expiredTitle")}</p>
                <p className="mt-1 text-mini leading-relaxed text-red-200/70">
                  {error ?? t("twoFactor.expiredBody")}
                </p>
              </div>
              <button
                type="button"
                onClick={() => void handleCancel()}
                className="w-full rounded-xl border border-white/10 px-4 py-2.5 text-sm text-white/70 transition hover:border-white/20 hover:text-white"
              >
                {t("twoFactor.backToLogin")}
              </button>
            </div>
          ) : (
            <form onSubmit={verify} className="space-y-4">
              <div className="space-y-2.5">
                {/* The 30-second ring sits on the label line, next to the words
                    it qualifies — «code» and «how long it stays valid». */}
                <div className="flex items-center justify-between gap-2">
                  <label htmlFor="two-factor-code" className="text-mini font-medium text-white/55">
                    {isRecoveryMode
                      ? t("twoFactor.codeLabelRecovery")
                      : enrolled
                        ? t("twoFactor.codeLabelEnrolled")
                        : t("twoFactor.codeLabelSetup")}
                  </label>
                  {!isRecoveryMode && <TotpRing seconds={totpSeconds} />}
                </div>

                {isRecoveryMode ? (
                  <input
                    id="two-factor-code"
                    name="code"
                    type="text"
                    dir="ltr"
                    autoComplete="off"
                    maxLength={128}
                    placeholder={t("twoFactor.recoveryPlaceholder")}
                    autoFocus
                    aria-describedby="two-factor-hint"
                    value={code}
                    onChange={event => setCode(event.target.value)}
                    disabled={verifying || cancelling}
                    className="h-12 w-full rounded-lg border border-white/10 bg-white/[0.04] px-3 text-center font-mono text-sm tracking-widest text-white placeholder:text-white/20 focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary/20"
                  />
                ) : (
                  <OtpInput
                    id="two-factor-code"
                    value={code}
                    onChange={setCode}
                    disabled={verifying || cancelling}
                    // The screen exists to be typed into: the first box takes
                    // focus as soon as it is mounted, in both the sign-in and
                    // the enrolment path.
                    autoFocus
                    ariaLabel={
                      enrolled ? t("twoFactor.codeLabelEnrolled") : t("twoFactor.codeLabelSetup")
                    }
                    describedBy="two-factor-hint"
                  />
                )}

                <p id="two-factor-hint" className="text-center text-micro leading-relaxed text-white/35">
                  {isRecoveryMode
                    ? t("twoFactor.hintRecovery")
                    : enrolled
                      ? t("twoFactor.hintEnrolled")
                      : t("twoFactor.hintSetup")}
                </p>
              </div>

              {/* The pending sign-in is short-lived. Quiet, centred, and below
                  the field because it is a deadline, not an instruction — and
                  worded as one, so it cannot be mistaken for the 30-second
                  ring above the boxes, which is about the code, not the login. */}
              {!expired && remainingMs !== null && (
                <p className="flex items-center justify-center gap-1.5 text-mini text-white/35">
                  <Clock className="size-3.5" aria-hidden />
                  {t("twoFactor.sessionLeft", { time: formatCountdown(remainingMs) })}
                </p>
              )}

              {enrolled && (
                <div className="text-center">
                  <button
                    type="button"
                    onClick={toggleMode}
                    className="text-micro text-white/40 underline underline-offset-4 transition hover:text-white/70"
                  >
                    {isRecoveryMode ? t("twoFactor.useTotp") : t("twoFactor.useRecovery")}
                  </button>
                </div>
              )}

              {error && (
                <p
                  role="alert"
                  className="flex items-start gap-2 rounded-lg border border-red-400/25 bg-red-400/[0.07] px-3 py-2 text-mini leading-relaxed text-red-200/90"
                >
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  {error}
                </p>
              )}

              <div className="space-y-1">
                <button
                  type="submit"
                  disabled={verifying || cancelling}
                  className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-5 py-3 text-sm font-semibold text-primary-foreground shadow-[0_0_30px_rgba(110,231,183,0.22)] transition hover:bg-primary disabled:opacity-60"
                >
                  {verifying ? (
                    <Loader2 className="size-4 animate-spin" aria-hidden />
                  ) : (
                    <ShieldCheck className="size-4" aria-hidden />
                  )}
                  {enrolled ? t("twoFactor.verify") : t("twoFactor.verifySetup")}
                </button>
                <button
                  type="button"
                  onClick={() => void handleCancel()}
                  disabled={verifying || cancelling}
                  className="mx-auto flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm text-white/45 transition hover:text-white/80 disabled:opacity-50"
                >
                  {cancelling ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <X className="size-4" aria-hidden />}
                  {t("common.cancel")}
                </button>
              </div>

              {!enrolled && (
                <p className="flex items-center justify-center gap-1.5 text-micro text-white/25">
                  <KeyRound className="size-3" aria-hidden />
                  {t("twoFactor.guideNote")}
                </p>
              )}
              {enrolled && savedCodes ? (
                <p className="flex items-center justify-center gap-1.5 text-micro text-primary/70">
                  <Check className="size-3" aria-hidden />
                  {t("twoFactor.remainingCodes", { count: 10 })}
                </p>
              ) : null}
            </form>
          )}
        </div>
      </div>
    </div>
  );
}
