import { useEffect, useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { Check, Copy, ExternalLink, Globe, Loader2, ShieldAlert } from "lucide-react";
import { REMOTE_ACCESS_MODES, type RemoteAccessMode } from "@al-ai/core/browser";
import { api } from "@/api";
import { LoadError, LoadingRow } from "@/components/view-states";
import { Toaster, useToasts } from "@/components/toaster";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useCopy } from "@/lib/use-copy";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { NetworkSnapshot } from "@/types";

/**
 * The «الوصول للشبكة» screen — where the deployment's reach is chosen.
 *
 * This is an instance-wide switch, not a per-guild setting: it decides whether
 * the dashboard answers this machine only, the router's network, or the open
 * internet through an ngrok tunnel. The write is gated server-side to the
 * platform owner, so a screen anyone can read is still a screen only its owner
 * can change.
 *
 * Choices apply immediately — this is process control, not a draft form — and
 * the tunnel URL appears the moment ngrok assigns it.
 */

const tunnelStatusCopy: Record<
  NetworkSnapshot["tunnelStatus"],
  { labelKey: TranslationKey; tone: "secondary" | "outline" | "destructive" } | null
> = {
  off: null,
  starting: { labelKey: "network.starting", tone: "secondary" },
  running: { labelKey: "network.running", tone: "secondary" },
  error: { labelKey: "network.error", tone: "destructive" }
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
  const { t } = useI18n();
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
  const [domainDraft, setDomainDraft] = useState("");
  const [savingDomain, setSavingDomain] = useState(false);
  const { toasts, push, dismiss } = useToasts();
  const { copied, copy } = useCopy();

  useEffect(() => {
    setDomainDraft(snapshot?.tunnelDomain ?? "");
  }, [snapshot?.tunnelDomain]);

  useEffect(() => {
    let cancelled = false;
    setSnapshot(null);
    setError(null);
    api
      .network()
      .then(result => !cancelled && setSnapshot(result))
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : t("network.loadFailed")));
    return () => {
      cancelled = true;
    };
  }, [t]);

  /**
   * Keeps the screen honest while a tunnel is being created — and afterwards.
   *
   * The effect re-runs whenever the status it reads changes, so it polls only
   * while the tunnel is meant to be up, and stops — clearing its own interval
   * — the moment the mode moves off it. Two cases need it:
   *
   * - `starting`: the URL has not appeared yet, and the spinner must not outlive it.
   * - `running`: the server probes the tunnel's own address on each read, and a
   *   live process with a dead edge (a VPN breaking the handshake to ngrok's
   *   edge) is downgraded to an error asynchronously. Without
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
      push({ title: t("network.saved"), description: t(`network.mode.${mode}` as TranslationKey), tone: "success" });
    } catch (cause) {
      push({
        title: t("network.changeFailed"),
        description: cause instanceof Error ? cause.message : t("network.tryAgain"),
        tone: "error"
      });
    } finally {
      setApplying(null);
      // Outlives the request: see MODE_SWITCH_LOCK_MS.
      setTimeout(() => setCooldown(false), MODE_SWITCH_LOCK_MS);
    }
  };

  const saveDomain = async (event: FormEvent) => {
    event.preventDefault();
    if (savingDomain || cooldown) return;
    setSavingDomain(true);
    setCooldown(true);
    try {
      const next = domainDraft.trim();
      setSnapshot(await api.saveNetwork(snapshot.mode, next === "" ? null : next));
      push({
        title: next ? t("network.domainSaved") : t("network.domainCleared"),
        description: next ? t("network.domainSavedBody") : t("network.domainClearedBody"),
        tone: "success"
      });
    } catch (cause) {
      push({
        title: t("network.domainSaveFailed"),
        description: cause instanceof Error ? cause.message : t("network.tryAgain"),
        tone: "error"
      });
    } finally {
      setSavingDomain(false);
      setTimeout(() => setCooldown(false), MODE_SWITCH_LOCK_MS);
    }
  };

  // Each address is labelled by the interface it belongs to — a machine answers
  // on several adapters at once (Wi-Fi, a virtual host-only NIC, a VPN), and
  // naming every row «شبكة محلية» told the operator nothing about which was
  // which. The address stays in the row so it stays identifiable at a glance.
  // Only addresses that can actually be reached are worth advertising: the
  // server binds IPv4, so an IPv6 link-local (fe80::…) row is dead, a VPN or
  // virtual adapter is not a door onto this machine, and the VirtualBox
  // host-only default (192.168.56.0/24) and APIPA (169.254.0.0/16) are not
  // reachable from another device. Those rows are dropped rather than shown
  // with a link that will not open.
  const unusableAdapter = /wireguard|vpn|tap|virtual|vmware|virtualbox|hyper-?v|vethernet|wsl|docker|loopback|bluetooth/i;
  const unusableHost = (host: string) =>
    host.includes(":") || host.startsWith("169.254.") || host.startsWith("192.168.56.");
  const lanUrls = snapshot.machineHosts
    .filter(({ host, label }) => !unusableHost(host) && !unusableAdapter.test(label))
    .map(({ host, label }) => ({
      url: `http://${host}:${snapshot.port}`,
      label: t("network.localLabel", { label })
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
    <div className="flex min-h-9 flex-wrap items-center gap-2 rounded-md border border-input bg-background/50 px-3 py-2">
      <span className="w-24 shrink-0 text-xs text-muted-foreground">{label}</span>
      {/* The link is the row's primary affordance: it opens the dashboard at
          that address in a new tab, so an operator verifies a LAN address works
          instead of only copying a string they cannot act on. `rel` keeps the
          new tab unscriptable by the destination. The address itself wraps
          instead of truncating: an IPv6 URL is long, and a clipped address is
          a string the operator cannot read. */}
      <a
        href={href}
        target="_blank"
        rel="noreferrer"
        title={value}
        className="flex min-w-0 flex-1 items-start gap-1.5 text-xs underline-offset-2 hover:underline"
        dir="ltr"
      >
        <code className="min-w-0 flex-1 break-all">{value}</code>
        <ExternalLink className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" />
      </a>
      <Button
        variant="ghost"
        size="icon"
        className="size-7"
        aria-label={t("network.copyLabel", { label })}
        onClick={async () => {
          const ok = await copy(value, value);
          push(
            ok
              ? { title: t("network.copied"), tone: "success" }
              : { title: t("settings.security.copyFailed"), tone: "error" }
          );
        }}
      >
        {copied === value ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
      </Button>
    </div>
  );

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex-col gap-2 space-y-0 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <Globe className="size-5" aria-hidden />
            </span>
            <div className="min-w-0">
              {/* The mode itself is named by the selected option in the list
                  below, so this heading carries the *scope* instead: the one
                  fact that is not visible in the list. */}
              <p className="text-base font-bold">{t("network.accessScope")}</p>
              <p className="text-xs text-muted-foreground">{t("network.accessScopeBody")}</p>
            </div>
          </div>
          {applying && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={t("network.applying")} />}
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
                  <span className="block text-sm font-medium">{t(`network.mode.${mode}` as TranslationKey)}</span>
                  <span className="block text-xs text-muted-foreground">{t(`network.mode.${mode}Body` as TranslationKey)}</span>
                </span>
              </button>
            );
          })}
        </CardContent>
      </Card>

      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.25 }}>
        <Card>
          <CardHeader className="flex-col gap-2 space-y-0 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex min-w-0 items-center gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <Globe className="size-5" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-base font-bold">{t("network.publicTunnel")}</p>
                <p className="text-xs text-muted-foreground">{t("network.publicTunnelBody")}</p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={snapshot.tunnelStable ? "secondary" : "outline"}>
                {snapshot.tunnelStable ? t("network.stable") : t("network.temporary")}
              </Badge>
              {status && <Badge variant={status.tone}>{t(status.labelKey)}</Badge>}
            </div>
          </CardHeader>
          <CardContent className="space-y-3">
            {snapshot.mode !== "tunnel" ? (
              <p className="text-sm text-muted-foreground">{t("network.chooseTunnel")}</p>
            ) : null}
            {tunnelUrl ? (
              <div>{copyRow(t("network.publicUrl"), tunnelUrl)}</div>
            ) : (
              <p className="text-sm text-muted-foreground">
                {snapshot.tunnelStatus === "starting" ? t("network.creating") : t("network.noUrl")}
              </p>
            )}
            {snapshot.tunnelStatus === "starting" ? (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> {t("network.creatingBody")}
              </p>
            ) : null}
            {snapshot.tunnelStatus === "error" && snapshot.tunnelError ? (
              <p className="text-xs text-destructive">{snapshot.tunnelError}</p>
            ) : null}

            <form onSubmit={saveDomain} className="space-y-2 rounded-xl border border-border/80 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <Label htmlFor="ngrok-domain" className="text-xs">
                  {t("network.fixedDomain")}
                </Label>
                <a
                  href="https://dashboard.ngrok.com/domains"
                  target="_blank"
                  rel="noreferrer"
                  className="text-[11px] text-primary underline underline-offset-2 dark:text-foreground"
                >
                  {t("network.ngrokDashboard")}
                </a>
              </div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <Input
                  id="ngrok-domain"
                  dir="ltr"
                  value={domainDraft}
                  onChange={event => setDomainDraft(event.target.value)}
                  placeholder="name.ngrok-free.dev"
                  className="min-w-0 flex-1"
                  disabled={savingDomain}
                />
                <Button type="submit" size="sm" loading={savingDomain} disabled={savingDomain || cooldown} className="shrink-0">
                  {t("network.saveDomain")}
                </Button>
              </div>
            </form>
          </CardContent>
        </Card>
      </motion.div>

      <Card>
        <CardHeader className="flex-col gap-2 space-y-0 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <p className="text-base font-bold">{t("network.localLinks")}</p>
            <p className="text-xs text-muted-foreground">{t("network.localLinksBody")}</p>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          {copyRow(t("network.thisDevice"), `http://localhost:${snapshot.port}`)}
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
          <p className="text-xs text-muted-foreground">
            {t("network.firewallHint", { port: snapshot.port })}
          </p>
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
                <p className="text-base font-bold">{t("network.callbackTitle")}</p>
                <p className="text-xs text-muted-foreground">
                  {t("network.callbackBody")}
                </p>
              </div>
            </div>
            <Button variant="outline" size="sm" asChild>
              <a href="https://discord.com/developers/applications" target="_blank" rel="noreferrer">
                <ExternalLink className="size-3.5" /> {t("network.openPortal")}
              </a>
            </Button>
          </CardHeader>
          <CardContent className="space-y-2">
            {copyRow(t("network.callbackUrl"), `${tunnelUrl}/auth/discord/callback`)}
          </CardContent>
        </Card>
      )}

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}
