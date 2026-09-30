import { useEffect, useState } from "react";
import { Check, Copy, ExternalLink, Globe, Loader2, ShieldAlert } from "lucide-react";
import { REMOTE_ACCESS_MODES, type RemoteAccessMode } from "@al-ai/core/browser";
import { api } from "@/api";
import { LoadError, LoadingRow } from "@/components/view-states";
import { Toaster, useToasts } from "@/components/toaster";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { useCopy } from "@/lib/use-copy";
import { cn } from "@/lib/utils";
import { remoteAccessDescriptions, remoteAccessLabels, type NetworkSnapshot } from "@/types";

/**
 * The «الوصول للشبكة» screen — where the deployment's reach is chosen.
 *
 * This is an instance-wide switch, not a per-guild setting: it decides whether
 * the dashboard answers this machine only, the router's network, or the open
 * internet through a Cloudflare quick tunnel. The write is gated server-side
 * to operators who administer a server this bot serves, so a screen anyone can
 * read is still a screen only its operator can change.
 *
 * Choices apply immediately — this is process control, not a draft form — and
 * the tunnel URL appears the moment Cloudflare assigns it.
 */

const tunnelStatusCopy: Record<NetworkSnapshot["tunnelStatus"], { label: string; tone: "secondary" | "outline" | "destructive" } | null> = {
  off: null,
  starting: { label: "جارٍ التشغيل…", tone: "secondary" },
  running: { label: "يعمل", tone: "secondary" },
  error: { label: "خطأ", tone: "destructive" }
};

export function NetworkView() {
  const [snapshot, setSnapshot] = useState<NetworkSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<RemoteAccessMode | null>(null);
  const { toasts, push, dismiss } = useToasts();
  const { copied, copy } = useCopy();

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setError(null);
    api
      .network()
      .then(result => !cancelled && setSnapshot(result))
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : "تعذّر التحميل."));
    return () => {
      cancelled = true;
    };
  }, []);

  if (error) {
    return <LoadError message={error} />;
  }
  if (!snapshot) {
    return <LoadingRow />;
  }

  const apply = async (mode: RemoteAccessMode) => {
    if (mode === snapshot.mode || applying) return;
    setApplying(mode);
    try {
      setSnapshot(await api.saveNetwork(mode));
      push({ title: "تم الحفظ", description: remoteAccessLabels[mode], tone: "success" });
    } catch (cause) {
      push({
        title: "تعذّر التغيير",
        description: cause instanceof Error ? cause.message : "حاول مرة أخرى.",
        tone: "error"
      });
    } finally {
      setApplying(null);
    }
  };

  const lanUrls = snapshot.machineHosts.map(host => `http://${host}:${snapshot.port}`);
  const tunnelUrl = snapshot.tunnelUrl;
  const status = tunnelStatusCopy[snapshot.tunnelStatus];

  // Discord registers HTTPS redirect URIs and loopback only — a plain-HTTP LAN
  // address cannot be saved in the Developer Portal at all, so advertising its
  // callback would be an instruction that can never work. Sign-in from a LAN
  // device hands off to the tunnel automatically instead; the tunnel callback
  // is the one URL an operator needs to add, once per tunnel address.
  const callbackUrls = tunnelUrl ? [`${tunnelUrl}/auth/discord/callback`] : [];

  const copyRow = (label: string, value: string) => (
    <div className="flex h-9 items-center gap-2 rounded-md border border-input bg-background/50 px-3">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      <code className="min-w-0 flex-1 truncate text-xs" dir="ltr">
        {value}
      </code>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={`نسخ ${label}`}
        onClick={async () => (await copy(value, value)) && push({ title: "نُسخ الرابط", tone: "success" })}
      >
        {copied === value ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Globe className="size-5" aria-hidden />
            </span>
            <div>
              <p className="text-base font-bold">مدى الوصول</p>
              <p className="text-xs text-muted-foreground">{remoteAccessLabels[snapshot.mode]}</p>
            </div>
          </div>
          {applying && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label="جارٍ التطبيق" />}
        </CardHeader>
        <CardContent className="space-y-2">
          {REMOTE_ACCESS_MODES.map(mode => {
            const selected = mode === snapshot.mode;
            return (
              <button
                key={mode}
                type="button"
                disabled={Boolean(applying)}
                aria-pressed={selected}
                onClick={() => void apply(mode)}
                className={cn(
                  "flex w-full items-start gap-3 rounded-lg border p-3 text-start transition-colors disabled:opacity-60",
                  selected ? "border-primary bg-primary/5" : "border-input hover:bg-accent/50"
                )}
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                    selected ? "border-primary bg-primary text-white" : "border-muted-foreground/40"
                  )}
                >
                  {selected && <Check className="size-2.5" />}
                </span>
                <span className="min-w-0">
                  <span className="block text-sm font-medium">{remoteAccessLabels[mode]}</span>
                  <span className="block text-xs text-muted-foreground">{remoteAccessDescriptions[mode]}</span>
                </span>
              </button>
            );
          })}
          <p className="pt-1 text-xs text-muted-foreground">
            إعداد عام لهذه النسخة — ينطبق على كل السيرفرات، ويبقى محفوظاً بعد إعادة التشغيل.
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <div>
            <p className="text-base font-bold">روابط اللوحة</p>
            <p className="text-xs text-muted-foreground">شارك الرابط المناسب مع من تريد أن يفتح اللوحة.</p>
          </div>
          {status && <Badge variant={status.tone}>{status.label}</Badge>}
        </CardHeader>
        <CardContent className="space-y-2">
          {copyRow("هذا الجهاز", `http://localhost:${snapshot.port}`)}
          {lanUrls.map(url => (
            <div key={url}>{copyRow("الشبكة المحلية", url)}</div>
          ))}
          {tunnelUrl && <div>{copyRow("النفق", tunnelUrl)}</div>}
          <p className="text-xs text-muted-foreground">
            من جهاز على الشبكة المحلية إن لم يفتح الرابط: سمّح بالمنفذ {snapshot.port} في جدار حماية ويندوز (أمر لمسؤول
            الجهاز)، أو افتح رابط النفق مباشرة — يعمل من أي مكان.
          </p>
          {snapshot.tunnelStatus === "starting" && (
            <p className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> يجري إنشاء النفق ويظهر رابطه خلال ثوانٍ…
            </p>
          )}
          {snapshot.tunnelStatus === "error" && snapshot.tunnelError && (
            <p className="text-xs text-destructive">{snapshot.tunnelError}</p>
          )}
        </CardContent>
      </Card>

      {callbackUrls.length > 0 && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-amber-500/15 text-amber-400">
                <ShieldAlert className="size-5" aria-hidden />
              </span>
              <div>
                <p className="text-base font-bold">خطوة واحدة في Discord</p>
                <p className="text-xs text-muted-foreground">
                  ديسكورد يقبل روابط الرجوع المشفّرة (HTTPS) فقط خارج هذا الجهاز — لذلك يُسجَّل رابط النفق أدناه في
                  Developer Portal ← OAuth2 ← Redirects، ويصبح الدخول يعمل من أي جهاز على الإنترنت. من جهاز على الشبكة
                  المحلية، اضغط «تسجيل الدخول» وسيُحوَّل تلقائياً إلى النفق.
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" asChild>
              <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">
                <ExternalLink className="size-3.5" /> فتح البورتال
              </a>
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {callbackUrls.map(url => (
              <div key={url}>{copyRow("رابط الرجوع", url)}</div>
            ))}
          </CardContent>
        </Card>
      )}

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
