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

/**
 * How often the screen looks again while a tunnel is coming up.
 *
 * Without this the screen froze on «جارٍ التشغيل…» until a manual reload: the
 * tunnel takes a few seconds to mint a URL, but the operator's one PUT already
 * answered and nothing was going to tell the browser to ask again. An hour-old
 * spinner is what that looked like. Polling stops the moment the status leaves
 * `starting`, so a live tunnel costs one request per interval and a finished
 * one costs none.
 */
const TUNNEL_POLL_MS = 2_000;

/**
 * A mode switch spawns or kills a process; a second click before the first one
 * lands races it. The lock is the whole defence — the buttons are disabled
 * while it is held — and this is the floor on how long it is held after the
 * request resolves, so a fast tunnel start cannot be interrupted by a click
 * that arrives the instant the request returns.
 */
const MODE_SWITCH_LOCK_MS = 1_000;

export function NetworkView() {
  const [snapshot, setSnapshot] = useState<NetworkSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState<RemoteAccessMode | null>(null);
  /**
   * Held for a short beat *after* a switch resolves, separately from
   * `applying`. The tunnel the switch started is still settling — its child
   * process has barely been spawned — and a click in that window would toggle
   * the mode again while the first tunnel is mid-start. Re-entry needs a guard
   * that outlives the request, not one that ends with it.
   */
  const [cooldown, setCooldown] = useState(false);
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

  /**
   * Keeps the screen honest while a tunnel is being created — and afterwards.
   *
   * The effect re-runs whenever the status it reads changes, so it polls only
   * while the tunnel is meant to be up, and stops — clearing its own interval
   * — the moment the mode moves off it. Two cases need it:
   *
   * - `starting`: the URL has not appeared yet, and the spinner must not outlive it.
   * - `running`: the server probes the tunnel's own address on each read, and a
   *   live process with a dead edge (a VPN breaking the handshake to
   *   `*.argotunnel.com`) is downgraded to an error asynchronously. Without
   *   polling, that verdict would only appear on a manual reload, and the
   *   screen would keep offering a link that cannot work.
   */
  useEffect(() => {
    if (snapshot?.mode !== "tunnel") return;
    const poll = setInterval(() => {
      api
        .network()
        .then(result => setSnapshot(result))
        .catch(() => {
          /* A poll failing is not a tunnel failure; the next one retries. */
        });
    }, TUNNEL_POLL_MS);
    return () => clearInterval(poll);
  }, [snapshot?.mode, snapshot?.tunnelStatus]);

  if (error) {
    return <LoadError message={error} />;
  }
  if (!snapshot) {
    return <LoadingRow />;
  }

  const apply = async (mode: RemoteAccessMode) => {
    if (mode === snapshot.mode || applying || cooldown) return;
    setApplying(mode);
    setCooldown(true);
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
      // Outlives the request: see MODE_SWITCH_LOCK_MS.
      setTimeout(() => setCooldown(false), MODE_SWITCH_LOCK_MS);
    }
  };

  // Each address is labelled by the interface it belongs to — a machine answers
  // on several adapters at once (Wi-Fi, a virtual host-only NIC, a VPN), and
  // naming every row «شبكة محلية» told the operator nothing about which was
  // which. The address stays in the row so it stays identifiable at a glance.
  const lanUrls = snapshot.machineHosts.map(({ host, label }) => ({
    url: `http://${host}:${snapshot.port}`,
    label: `شبكة محلية · ${label}`
  }));
  const tunnelUrl = snapshot.tunnelUrl;
  const status = tunnelStatusCopy[snapshot.tunnelStatus];

  // Discord registers HTTPS redirect URIs and loopback only — a plain-HTTP LAN
  // address cannot be saved in the Developer Portal at all, so advertising its
  // callback would be an instruction that can never work. Sign-in from a LAN
  // device hands off to the tunnel automatically instead; the tunnel callback
  // is the one URL an operator needs to add, once per tunnel address.
  // The card asks for a step that is already done once a sign-in has completed
  // through the tunnel address — that round trip is the proof of registration.
  const needsCallbackSetup = Boolean(tunnelUrl) && !snapshot.tunnelCallbackVerified;

  const copyRow = (label: string, value: string, href = value) => (
    <div className="flex h-9 items-center gap-2 rounded-md border border-input bg-background/50 px-3">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      {/* The link is the row's primary affordance: it opens the dashboard at
          that address in a new tab, so an operator verifies a LAN address works
          instead of only copying a string they cannot act on. `rel` keeps the
          new tab unscriptable by the destination. */}
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        className="flex min-w-0 flex-1 items-center gap-1.5 text-xs underline-offset-2 hover:underline"
        dir="ltr"
      >
        <code className="min-w-0 flex-1 truncate">{value}</code>
        <ExternalLink className="size-3.5 shrink-0 text-muted-foreground" />
      </a>
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
              {/* The mode itself is named by the selected option in the list
                  below, so this heading carries the *scope* instead: the one
                  fact that is not visible in the list. */}
              <p className="text-base font-bold">مدى الوصول</p>
              <p className="text-xs text-muted-foreground">إعداد عام لهذه النسخة — ينطبق على كل السيرفرات</p>
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
                // Disabled for the whole of the request *and* the cooldown
                // after it, so a rapid second click cannot race the process
                // switch the first one started.
                disabled={Boolean(applying) || cooldown}
                aria-pressed={selected}
                aria-busy={applying === mode}
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
            يبقى الإعداد محفوظاً بعد إعادة التشغيل.
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
          {/*
            One row per network address, named by the address itself. Naming
            every LAN row «الشبكة المحلية» made several adapters
            indistinguishable — an operator with Wi-Fi and an Ethernet port saw
            two identical labels and could only tell them apart by reading the
            URL they came to copy. The address is the name now; the prefix says
            which kind it is.
          */}
          {lanUrls.map(({ url, label }) => (
            <div key={url}>{copyRow(label, url)}</div>
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

      {needsCallbackSetup && (
        <Card>
          <CardHeader className="flex-row items-center justify-between space-y-0">
            <div className="flex items-center gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-warning/15 text-warning">
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
            {copyRow("رابط الرجوع", `${tunnelUrl}/auth/discord/callback`)}
          </CardContent>
        </Card>
      )}

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
