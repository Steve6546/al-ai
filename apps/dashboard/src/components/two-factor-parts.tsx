/**
 * The pieces the second-factor screens share.
 *
 * They are deliberately presentational: no API call lives here, so the login
 * screen and the account-settings screen cannot drift on how a secret is
 * grouped, how a QR is drawn, or how many recovery codes exist. The QR is
 * generated **locally** from the `otpauth://` URI — a TOTP secret must never
 * be sent to an external image service, and the CSP forbids one anyway.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Check, Copy, Download, Eye, EyeOff, RefreshCw } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";

/** Strip whitespace so a copied key pastes into an authenticator as one token. */
export function compactSecret(secret: string): string {
  return secret.replace(/\s+/g, "");
}

/** Group into four-character chunks so a long base32 key can be read and typed. */
export function groupSecret(secret: string): string {
  return (compactSecret(secret).match(/.{1,4}/g) ?? []).join(" ");
}

/** A downloaded text file, or false when the browser cannot build one. */
export function downloadText(filename: string, text: string): boolean {
  try {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.rel = "noopener";
    document.body.appendChild(link);
    link.click();
    link.remove();
    // Revoking immediately can cancel the download in some browsers; one tick
    // is enough for the click to be handled.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch {
    return false;
  }
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ *
 * QR
 * ------------------------------------------------------------------ */

/**
 * The mockup's dark QR plate: a white code on near-black, framed by four mint
 * corner brackets and a soft glow. The brackets are decoration, so they are
 * `aria-hidden`; the SVG carries the accessible label.
 */
export function QrPanel({ value, label, caption }: { value: string; label: string; caption?: string }) {
  return (
    <div className="relative mx-auto w-full max-w-[16rem]">
      <span aria-hidden className="absolute -inset-3 rounded-[1.75rem] bg-[#6ee7b7]/10 blur-2xl" />
      <div className="relative rounded-2xl bg-white p-3 shadow-[0_0_45px_rgba(110,231,183,0.18)]">
        <QRCodeSVG
          value={value}
          size={224}
          level="M"
          bgColor="#ffffff"
          fgColor="#07100c"
          className="h-auto w-full"
          aria-label={label}
          role="img"
        />
      </div>
      {caption ? <p className="mt-3 text-center text-[11px] leading-relaxed text-white/45">{caption}</p> : null}
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Secret
 * ------------------------------------------------------------------ */

/**
 * The manual key. Hidden by default: a shoulder-surfer at the next desk should
 * not read the second factor off the screen, and the copy action works whether
 * or not the characters are visible.
 */
export function SecretField({
  secret,
  label,
  showLabel,
  hideLabel,
  copyLabel,
  defaultVisible = false
}: {
  secret: string;
  label: string;
  showLabel: string;
  hideLabel: string;
  copyLabel: string;
  /** The enrolment flow starts readable: the key has to be typed somewhere. */
  defaultVisible?: boolean;
}) {
  const { t } = useI18n();
  const [visible, setVisible] = useState(defaultVisible);
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (await copyText(compactSecret(secret))) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    }
  }

  return (
    <div className="space-y-1.5">
      <p className="text-[11px] font-medium text-white/55">{label}</p>
      <div className="flex items-center gap-1.5">
        <code
          dir="ltr"
          className="min-w-0 flex-1 break-all rounded-lg border border-white/10 bg-white/[0.04] px-3 py-2 font-mono text-xs tracking-wider text-white/85"
        >
          {visible ? groupSecret(secret) : "•••• •••• •••• ••••"}
        </code>
        <button
          type="button"
          onClick={() => setVisible(value => !value)}
          aria-label={visible ? hideLabel : showLabel}
          title={visible ? hideLabel : showLabel}
          className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/10 text-white/55 transition hover:border-[#6ee7b7]/50 hover:text-[#8ff0c5]"
        >
          {visible ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
        </button>
        <button
          type="button"
          onClick={() => void copy()}
          aria-label={copyLabel}
          title={copyLabel}
          className="grid size-9 shrink-0 place-items-center rounded-lg border border-white/10 text-white/55 transition hover:border-[#6ee7b7]/50 hover:text-[#8ff0c5]"
        >
          {copied ? <Check className="size-4 text-[#6ee7b7]" aria-hidden /> : <Copy className="size-4" aria-hidden />}
        </button>
      </div>
      <p className="text-[10px] leading-relaxed text-white/35">{t("settings.security.secretWarning")}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Recovery codes
 * ------------------------------------------------------------------ */

/**
 * The ten single-use codes, as cards.
 *
 * Copy-all writes newline-separated codes (what an operator pastes into a
 * password manager); copy-each exists because a single code is often all that
 * is needed at the sign-in screen. The download is a plain text file with no
 * secret in the filename.
 */
export function RecoveryCodeGrid({
  codes,
  title,
  warning,
  copyAllLabel,
  downloadLabel,
  copyEachLabel,
  downloadFilename = "al-ai-recovery-codes.txt"
}: {
  codes: string[];
  title: string;
  warning: string;
  copyAllLabel: string;
  downloadLabel: string;
  copyEachLabel: string;
  downloadFilename?: string;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState<string | null>(null);
  const [downloaded, setDownloaded] = useState(false);

  async function copyOne(code: string, key: string) {
    if (await copyText(code)) {
      setCopied(key);
      setTimeout(() => setCopied(null), 1600);
    }
  }

  function download() {
    const header = `${title}\n${warning}\n\n`;
    if (downloadText(downloadFilename, `${header}${codes.join("\n")}\n`)) {
      setDownloaded(true);
      setTimeout(() => setDownloaded(false), 2000);
    }
  }

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold text-white/85">{title}</p>
          <p className="text-[10px] leading-relaxed text-amber-300/90">{warning}</p>
        </div>
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => void copyOne(codes.join("\n"), "all")}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-white/70 transition hover:border-[#6ee7b7]/50 hover:text-[#8ff0c5]"
          >
            {copied === "all" ? <Check className="size-3 text-[#6ee7b7]" aria-hidden /> : <Copy className="size-3" aria-hidden />}
            {copyAllLabel}
          </button>
          <button
            type="button"
            onClick={download}
            className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-[11px] text-white/70 transition hover:border-[#6ee7b7]/50 hover:text-[#8ff0c5]"
          >
            {downloaded ? <Check className="size-3 text-[#6ee7b7]" aria-hidden /> : <Download className="size-3" aria-hidden />}
            {downloadLabel}
          </button>
        </div>
      </div>

      <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2" aria-label={title}>
        {codes.map((code, index) => (
          <li key={`${index}-${code}`}>
            <button
              type="button"
              onClick={() => void copyOne(code, String(index))}
              aria-label={`${copyEachLabel}: ${code}`}
              className="group flex w-full items-center justify-between gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-2.5 py-2 text-start transition hover:border-[#6ee7b7]/40 hover:bg-white/[0.06]"
            >
              <code dir="ltr" className="font-mono text-[11px] tracking-wide text-white/80">
                {code}
              </code>
              {copied === String(index) ? (
                <Check className="size-3.5 shrink-0 text-[#6ee7b7]" aria-hidden />
              ) : (
                <Copy className="size-3.5 shrink-0 text-white/25 group-hover:text-[#8ff0c5]" aria-hidden />
              )}
            </button>
          </li>
        ))}
      </ul>

      <p className="text-[10px] leading-relaxed text-white/35">{t("settings.security.oneTimeBody")}</p>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * OTP input
 * ------------------------------------------------------------------ */

/**
 * Six boxes backed by one real input.
 *
 * The input is visually hidden but still the only control: it owns the value,
 * the paste, the numeric keyboard and the form semantics. The boxes are a
 * drawing of that value, so a screen reader reads one labelled field rather
 * than six unlabelled digits. The id is supplied by the caller because the
 * login screen and its tests address `#two-factor-code`.
 */
export function OtpInput({
  id,
  value,
  onChange,
  disabled,
  autoFocus,
  ariaLabel,
  describedBy
}: {
  id: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
  ariaLabel: string;
  describedBy?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [focused, setFocused] = useState(false);
  const digits = useMemo(() => value.replace(/\D/g, "").slice(0, 6), [value]);
  const activeIndex = focused ? Math.min(digits.length, 5) : -1;

  return (
    <div className="relative">
      <input
        ref={inputRef}
        id={id}
        name="code"
        type="text"
        dir="ltr"
        inputMode="numeric"
        autoComplete="one-time-code"
        pattern="[0-9]*"
        maxLength={6}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        autoFocus={autoFocus}
        disabled={disabled}
        value={value}
        onChange={event => onChange(event.target.value.replace(/\D/g, "").slice(0, 6))}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="absolute inset-0 z-10 h-full w-full cursor-text bg-transparent p-0 opacity-0 outline-none"
      />
      <div
        aria-hidden="true"
        onClick={() => inputRef.current?.focus()}
        className="grid grid-cols-6 gap-1.5 sm:gap-2"
      >
        {Array.from({ length: 6 }, (_, index) => {
          const digit = digits[index] ?? "";
          const active = index === activeIndex;
          return (
            <span
              key={index}
              className={cn(
                "relative grid h-12 place-items-center rounded-lg border bg-white/[0.03] font-mono text-lg font-semibold text-white transition sm:h-14",
                digit ? "border-[#6ee7b7]/45 bg-[#6ee7b7]/[0.06]" : "border-white/10",
                active && "border-[#6ee7b7] ring-2 ring-[#6ee7b7]/20",
                disabled && "opacity-50"
              )}
            >
              {digit ? (
                digit
              ) : active ? (
                <span className="h-5 w-px animate-pulse bg-[#6ee7b7]" />
              ) : (
                <span className="size-1 rounded-full bg-white/15" />
              )}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * TOTP freshness
 * ------------------------------------------------------------------ */

const TOTP_PERIOD_SECONDS = 30;

/** Seconds until the current TOTP expires, recomputed every tick. */
export function useTotpSeconds(): number {
  const [seconds, setSeconds] = useState(() => TOTP_PERIOD_SECONDS - (Math.floor(Date.now() / 1000) % TOTP_PERIOD_SECONDS));
  useEffect(() => {
    const timer = setInterval(() => {
      setSeconds(TOTP_PERIOD_SECONDS - (Math.floor(Date.now() / 1000) % TOTP_PERIOD_SECONDS));
    }, 1000);
    return () => clearInterval(timer);
  }, []);
  return seconds;
}

/**
 * A tiny freshness ring. It is only a hint — the server is the authority on
 * whether a code is still inside its window — and it never blocks a submit.
 */
export function TotpRing({ seconds }: { seconds: number }) {
  const fraction = Math.max(0, Math.min(1, seconds / TOTP_PERIOD_SECONDS));
  const circumference = 2 * Math.PI * 9;
  return (
    <span className="inline-flex items-center gap-1.5 text-[11px] text-white/40" title={`${TOTP_PERIOD_SECONDS}s`}>
      <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true" className="shrink-0">
        <circle cx="11" cy="11" r="9" fill="none" stroke="rgba(255,255,255,0.10)" strokeWidth="2" />
        <circle
          cx="11"
          cy="11"
          r="9"
          fill="none"
          stroke="#6ee7b7"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          transform="rotate(-90 11 11)"
          className="transition-[stroke-dashoffset] duration-700"
        />
      </svg>
      <span dir="ltr" className="font-mono tabular">
        {seconds}s
      </span>
      <RefreshCw className="size-3 opacity-40" aria-hidden />
    </span>
  );
}
