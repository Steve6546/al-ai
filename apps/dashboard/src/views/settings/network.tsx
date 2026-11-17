import { useEffect, useState, type FormEvent } from "react";
import { motion } from "framer-motion";
import { QRCodeSVG } from "qrcode.react";
import { Check, Copy, ExternalLink, Globe, Loader2, ShieldAlert, ShieldCheck, Wifi, WifiOff } from "lucide-react";
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
import type { NetworkFirewall, NetworkSnapshot } from "@/types";

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
 * How often the screen looks again.
 *
 * `starting` needs a short interval: the PUT has already answered and nothing
 * else will tell the browser that ngrok minted a URL. Once the tunnel is up the
 * server does its own liveness checks on loopback, so a slow refresh is enough.
 *
 * The old single 2-second interval kept polling *forever* — 30 requests a
 * minute for every open tab. On the free ngrok plan (20,000 requests a month)
 * that alone spends the whole quota in about eleven hours, and every one of
 * those requests travels through the public edge. Hidden tabs must not spend
 * it at all.
 */
const TUNNEL_STARTING_POLL_MS = 2_000;
const TUNNEL_SETTLED_POLL_MS = 60_000;

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
  /**
   * Windows Firewall is read separately from `/api/network`: it is a property
   * of the host, not of the reach mode, and a check spawns a short PowerShell
   * read that has no business delaying the mode payload.
   */
  const [firewall, setFirewall] = useState<NetworkFirewall | null>(null);
  const [firewallBusy, setFirewallBusy] = useState(false);

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

  // The firewall verdict never changes the reach mode, so it is read once on
  // entry and refreshed only after the operator asks to open the port. A
  // failure here is not a screen failure: the LAN links stay usable and the
  // status simply stays unknown.
  useEffect(() => {
    let cancelled = false;
    api
      .networkFirewall()
      .then(result => !cancelled && setFirewall(result))
      .catch(() => undefined);
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
   * - `running`/`error`: the server checks liveness on loopback every 15s and
   *   verifies the public edge at most once an hour, so a slow refresh is
   *   enough to pick up a downgrade — or the day the ngrok quota resets.
   */
  useEffect(() => {
    if (snapshot?.mode !== "tunnel") return;
    const interval = snapshot.tunnelStatus === "starting" ? TUNNEL_STARTING_POLL_MS : TUNNEL_SETTLED_POLL_MS;
    const poll = setInterval(() => {
      // A background tab must not spend the account's monthly ngrok quota.
      if (typeof document !== "undefined" && document.visibilityState !== "visible") return;
      api
        .network()
        .then(result => setSnapshot(result))
        .catch(() => {
          /* A poll failing is not a tunnel failure; the next one retries. */
        });
    }, interval);
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

  /**
   * Ask Windows for the inbound rule. `elevate: true` raises the UAC prompt on
   * the host; the elevated child writes the rule asynchronously, so the status
   * is polled briefly instead of claiming success the moment UAC appears.
   */
  const openFirewall = async () => {
    if (firewallBusy) return;
    setFirewallBusy(true);
    try {
      let report = await api.ensureNetworkFirewall(true);
      setFirewall(report);
      for (let attempt = 0; attempt < 6 && report.status !== "allowed" && report.elevation?.started; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 1_500));
        report = await api.networkFirewall();
        setFirewall(report);
      }
      push(
        report.status === "allowed"
          ? {
              title: t("network.firewallTitle"),
              description: t("network.firewallAllowed", {
                port: snapshot.port,
                profiles: report.profiles.join(", ") || "Any"
              }),
              tone: "success"
            }
          : { title: t("network.firewallTitle"), description: t("network.firewallFailed"), tone: "error" }
      );
    } catch (cause) {
      push({
        title: t("network.firewallTitle"),
        description: cause instanceof Error ? cause.message : t("network.firewallFailed"),
        tone: "error"
      });
    } finally {
      setFirewallBusy(false);
    }
  };

  // The URLs come from the server, which built them from `server.address()`
  // and the live interface table through the shared `reachableLanEntries`
  // filter. Duplicating that filter here would let the screen advertise an
  // address the host gate refuses — or hide one it accepts. `lanEnabled` is
  // the gate's own verdict, so `off` is labelled instead of offering a link
  // that would answer 403 on the other device.
  const lanEntries = snapshot.lanUrls ?? [];
  const lanUrls = lanEntries.map(({ url, label }) => ({
    url,
    label: t("network.localLabel", { label })
  }));
  /**
   * The address a phone can scan: the server's `primaryLanHost` (already
   * filtered to the physical private LAN adapter), not simply the first row.
   * The payload is trimmed and must be an absolute http(s) URL — iOS/Android
   * cameras only offer "Open in browser" for a real URL, and a stray newline
   * turns the QR into copyable text.
   */
  const primaryLanUrl =
    lanEntries.find(entry => entry.host === snapshot.primaryLanHost)?.url ?? lanUrls[0]?.url ?? null;
  const qrUrl = (primaryLanUrl ?? `http://localhost:${snapshot.port}`).trim();
  const qrPayload = /^https?:\/\/[^\s]+$/.test(qrUrl) ? qrUrl : null;
  /*
   * The subnet a VPN has to let through, derived from the address the phone is
   * told to open. "Turn the VPN off" is advice, not a fix: a full-tunnel client
   * captures 0.0.0.0/0, so the phone's request reaches the machine and the reply
   * leaves through the tunnel — the connection dies on the way back. Allowing
   * this one prefix (split tunnel) keeps the VPN on and the LAN working, which
   * is what the operator actually wants.
   */
  const vpnSubnet = /^\d{1,3}(\.\d{1,3}){3}$/.test(snapshot.primaryLanHost ?? "")
    ? `${(snapshot.primaryLanHost as string).split(".").slice(0, 3).join(".")}.0/24`
    : "";
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
            {snapshot.quotaExceeded ? (
              <p className="text-xs text-warning">
                ERR_NGROK_727 ·{" "}
                <a
                  className="underline"
                  href="https://dashboard.ngrok.com/billing"
                  target="_blank"
                  rel="noreferrer noopener"
                >
                  dashboard.ngrok.com/billing
                </a>
              </p>
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
                  className="text-mini text-primary underline underline-offset-2 dark:text-foreground"
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
          {/* The badge is the host gate's verdict, not a guess from the mode
              label: in `off` the links below are real addresses whose requests
              would be refused, and saying so beats offering a dead link. */}
          <Badge variant={snapshot.lanEnabled ? "secondary" : "outline"} className="shrink-0 gap-1.5">
            {snapshot.lanEnabled ? <Wifi className="size-3" aria-hidden /> : <WifiOff className="size-3" aria-hidden />}
            {snapshot.lanEnabled ? t("network.lanActive") : t("network.lanClosed")}
          </Badge>
        </CardHeader>
        <CardContent className="space-y-3">
          {/*
            A VPN on the host (or on the phone) is the second reason a LAN URL
            fails while the server is healthy: the route to 192.168.x.x is
            captured by the tunnel. The adapter names come from the server's
            live interface table, so this is a measured fact, not a guess.
          */}
          {(snapshot.vpnAdapters ?? []).length > 0 && (
            <div className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs">
              <p className="font-medium text-warning">{t("network.vpnTitle")}</p>
              <p className="mt-0.5 text-muted-foreground">
                {t("network.vpnBody", { adapters: (snapshot.vpnAdapters ?? []).join(", "), host: qrUrl, subnet: vpnSubnet })}
              </p>
            </div>
          )}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            {/*
              Drawn locally from the live URL — no external QR service ever sees
              the address, and the CSP forbids one anyway. A phone on the same
              Wi-Fi scans this instead of typing an IP by hand.
            */}
            <div className="shrink-0 self-start rounded-xl border border-white/10 bg-black p-2">
              {qrPayload ? (
                <QRCodeSVG
                  // White modules on black: the screen is dark, and a phone
                  // camera handles an inverted code at this size. `marginSize`
                  // is the quiet zone the scanner needs — without it the code
                  // touches the border and many cameras refuse it.
                  value={qrPayload}
                  size={112}
                  level="M"
                  marginSize={3}
                  bgColor="#000000"
                  fgColor="#FFFFFF"
                  role="img"
                  aria-label={qrPayload}
                />
              ) : null}
            </div>
            <div className="min-w-0 space-y-1">
              <p className="text-xs font-medium">{t("network.qrTitle")}</p>
              <p className="text-xs text-muted-foreground">{t("network.qrBody")}</p>
              <code className="block break-all text-xs" dir="ltr">{qrUrl}</code>
              <p className="text-xs text-muted-foreground">
                {t("network.boundTo", { host: snapshot.boundHost ?? "—", port: snapshot.port })}
              </p>
            </div>
          </div>
          {copyRow(t("network.thisDevice"), `http://localhost:${snapshot.port}`)}
          {/*
            One row per network address, named by the adapter it came from.
            Several identical «شبكة محلية» rows left an operator with Wi-Fi and
            Ethernet unable to tell which URL belonged to which; the label is
            the interface now, and the address is in the row.
          */}
          {lanUrls.map(({ url, label }) => (
            <div key={url}>{copyRow(label, url)}</div>
          ))}
          {!snapshot.lanEnabled && (
            <p className="text-xs text-warning">{t("network.lanClosedHint")}</p>
          )}
          {/*
            Live firewall verdict. "The switch says LAN but the phone cannot
            connect" was almost always this row: no inbound rule, or a rule
            scoped to Private while Windows classified the Wi-Fi as Public.
          */}
          {firewall ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-input bg-background/50 px-3 py-2">
                <div className="flex min-w-0 items-center gap-2 text-xs">
                  {firewall.status === "allowed" ? (
                    <ShieldCheck className="size-4 shrink-0 text-success" aria-hidden />
                  ) : (
                    <ShieldAlert className="size-4 shrink-0 text-warning" aria-hidden />
                  )}
                  <span className="font-medium">{t("network.firewallTitle")}</span>
                  <span className="text-muted-foreground">
                    {firewall.status === "allowed"
                      ? t("network.firewallAllowed", {
                          port: snapshot.port,
                          profiles: firewall.profiles.join(", ") || "Any"
                        })
                      : t("network.firewallBlocked", { port: snapshot.port })}
                  </span>
                </div>
                {firewall.status !== "allowed" && (
                  <Button size="sm" variant="outline" onClick={() => void openFirewall()} disabled={firewallBusy}>
                    {firewallBusy ? (
                      <Loader2 className="size-3.5 animate-spin" aria-hidden />
                    ) : (
                      <ShieldAlert className="size-3.5" aria-hidden />
                    )}
                    {t("network.firewallOpen")}
                  </Button>
                )}
              </div>
              {firewall.status !== "allowed" && (
                <p className="text-xs text-muted-foreground">{t("network.firewallUac")}</p>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t("network.firewallHint", { port: snapshot.port })}
            </p>
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
