import { lazy, Suspense, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { BrandMark } from "@/components/brand-mark";
import { DiscordIcon } from "@/components/discord-icon";
import { useI18n } from "@/lib/i18n";
import { ShieldCheck } from "lucide-react";

/*
 * The particle sky is the heaviest thing on this screen and the only part that
 * is pure decoration, so it loads as its own chunk: the button and the brand
 * paint first, the stars fade in when the engine arrives.
 */
const LoginStarfield = lazy(() => import("@/components/login-starfield"));

export function LoginScreen({ notice }: { notice: string | null }) {
  const { t } = useI18n();
  const [signingIn, setSigningIn] = useState(false);

  /*
   * Sign-in is a full-page hand-off to Discord, so the button shows its loading
   * state until the browser actually leaves. The navigation runs in an effect
   * (after paint) rather than in the click handler, so the spinner is on screen
   * for the whole wait instead of being skipped by an immediate redirect.
   */
  useEffect(() => {
    if (signingIn) window.location.assign("/auth/discord/login");
  }, [signingIn]);

  // Coming back with the browser's back button can restore this page from the
  // cache with the spinner still latched; the hand-off is over, so release it.
  useEffect(() => {
    const release = () => setSigningIn(false);
    window.addEventListener("pageshow", release);
    return () => window.removeEventListener("pageshow", release);
  }, []);

  return (
    /*
     * The document no longer scrolls, so this screen scrolls itself.
     *
     * The content is centred with `my-auto` on the child rather than
     * `items-center` on the parent: with `items-center` content taller than the
     * viewport — a long notice, or a phone in landscape — is centred *past* the
     * top edge and the part above it cannot be scrolled back into view.
     * `my-auto` centres it when there is room and behaves like `margin: 0`
     * when there is not.
     *
     * The sky is always dark, in either theme: stars only read against night,
     * so this screen carries its own palette instead of the page tokens.
     */
    <div className="relative flex h-full justify-center overflow-y-auto overscroll-contain bg-[#060913] p-6">
      <div aria-hidden className="pointer-events-none absolute inset-0">
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_60%_50%_at_50%_-10%,rgba(59,130,246,0.22),transparent_70%)]" />
        <div className="absolute inset-0 bg-[radial-gradient(ellipse_50%_40%_at_85%_110%,rgba(139,92,246,0.16),transparent_70%)]" />
        <Suspense fallback={null}>
          <LoginStarfield />
        </Suspense>
      </div>

      <div className="relative my-auto flex w-full max-w-sm flex-col items-center text-center">
        <BrandMark className="mb-5 size-16 text-sky-300 drop-shadow-[0_0_28px_rgba(56,189,248,0.4)]" />
        <h1 className="text-3xl font-bold tracking-tight text-white">AL AI</h1>
        <p className="mt-2 text-sm text-slate-400">{t("login.subtitle")}</p>

        <Button
          className="mt-8 h-12 w-full rounded-xl text-base shadow-[0_8px_30px_rgba(59,130,246,0.35)]"
          loading={signingIn}
          onClick={() => setSigningIn(true)}
        >
          <DiscordIcon />
          {t("login.button")}
        </Button>

        <p className="mt-4 flex items-center justify-center gap-2 text-xs text-slate-500">
          <ShieldCheck className="size-3.5" />
          {t("login.restricted")}
        </p>
        {notice && <p className="mt-3 text-xs text-red-300">{notice}</p>}
      </div>
    </div>
  );
}