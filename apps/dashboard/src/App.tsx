import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Loader2 } from "lucide-react";
import { api, ApiError } from "@/api";
import { AppShell, isViewKey, type ViewKey } from "@/components/app-shell";
import { GuildSelector } from "@/components/guild-selector";
import { InviteBotPanel } from "@/components/invite-bot";
import { LoginScreen } from "@/components/login-screen";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { guildPath, guildsPath, navigate, useRoute } from "@/lib/router";
import { AuditView, CommandsView, CustomizationView, DashboardView, LogsView, RolesView, SecurityView } from "@/views";
import type { Guild, HealthSnapshot, SessionInfo } from "@/types";

/**
 * Application root.
 *
 * Nothing here is mock data: every value comes from the BFF after a real Discord
 * sign-in. The address bar decides what is on screen, so a guild dashboard is a
 * link that can be bookmarked and shared with a colleague — and, because the
 * server only ever returns guilds the caller may administer, a link to a guild
 * they cannot reach resolves to the selector rather than to an error page.
 */

/** Messages the OAuth callback can hand back through `?auth=`. */
const authMessages: Record<string, string> = {
  ok: "تم تسجيل الدخول.",
  denied: "لا تملك رتبة إدارية في أي سيرفر مضاف.",
  state_mismatch: "فشل التحقق من حالة OAuth.",
  failed: "تعذّر إكمال تسجيل الدخول."
};

/** Shown when a link points at a guild this account cannot administer. */
const NO_ACCESS_NOTICE = "لا تملك صلاحية الوصول إلى هذا السيرفر. اختر سيرفراً من القائمة.";

export function App() {
  const route = useRoute();
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [booting, setBooting] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /**
   * The Discord account the loaded guild list belongs to.
   *
   * Held in a ref rather than state because it is never rendered — it exists
   * only to notice that the account changed underneath the list.
   */
  const accountRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const sessionInfo = await api.session();
      setSession(sessionInfo);
      setHealth(await api.health().catch(() => null));

      if (!sessionInfo.authenticated) {
        accountRef.current = null;
        setGuilds([]);
        return;
      }

      // Signing in as somebody else must not leave the previous account's guilds
      // on screen. Clearing them here means a second operator never sees a first
      // operator's servers, even for the moment before the next fetch lands.
      const userId = sessionInfo.user?.id ?? null;
      const switched = accountRef.current !== null && accountRef.current !== userId;
      if (switched) {
        setGuilds([]);
        setNotice("تم تسجيل الدخول بحساب مختلف. حُدِّثت قائمة السيرفرات.");
        navigate(guildsPath(), { replace: true });
      }
      accountRef.current = userId;

      const result = await api.guilds();
      setGuilds(result.guilds);
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        accountRef.current = null;
        setSession({ authenticated: false, user: null });
        setGuilds([]);
      } else {
        setError(cause instanceof Error ? cause.message : "تعذّر تحميل البيانات.");
      }
    }
  }, []);

  useEffect(() => {
    const auth = new URLSearchParams(window.location.search).get("auth");
    if (auth) {
      setNotice(authMessages[auth] ?? null);
      // Drop the query so a refresh does not re-announce a sign-in that already
      // happened. The path is left alone: the callback sends everyone to `/`.
      window.history.replaceState({}, "", window.location.pathname);
    }
    void load().finally(() => setBooting(false));
  }, [load]);

  const routeGuildId = route.kind === "guild" ? route.guildId : null;

  // Resolved from the loaded list rather than fetched per id: the list already
  // carries the server's verdict on what this account may touch, and asking
  // again per guild would let the two answers disagree.
  const guild = useMemo(
    () => (routeGuildId ? (guilds.find(item => item.id === routeGuildId) ?? null) : null),
    [guilds, routeGuildId]
  );

  /**
   * The access guard, client half.
   *
   * A guild id in the address bar that is not in the list means the server
   * refused it — a direct link to somebody else's server, or an account switch.
   * The API answered 403 and omitted the guild, so the only correct response is
   * to go back to the selector with an explanation, never a blank screen.
   */
  useEffect(() => {
    if (booting || !routeGuildId || guild) return;
    setNotice(NO_ACCESS_NOTICE);
    navigate(guildsPath(), { replace: true });
  }, [booting, routeGuildId, guild]);

  // An unrecognised path is a broken link, not a crash.
  useEffect(() => {
    if (booting || route.kind !== "unknown") return;
    navigate(guildsPath(), { replace: true });
  }, [booting, route]);

  const view: ViewKey = route.kind === "guild" && route.view && isViewKey(route.view) ? route.view : "dashboard";

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  async function logout() {
    await api.logout().catch(() => undefined);
    accountRef.current = null;
    setSession({ authenticated: false, user: null });
    setGuilds([]);
    setNotice(null);
    navigate(guildsPath(), { replace: true });
  }

  if (booting) {
    return (
      <div className="flex min-h-dvh items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        جارٍ التحميل
      </div>
    );
  }

  if (!session?.authenticated) {
    return <LoginScreen notice={notice ?? error} />;
  }

  // The selector is the signed-in home. It is also where every guard above
  // lands, which is why it renders whenever no guild is selected.
  if (!guild) {
    return (
      <GuildSelector
        user={session.user}
        guilds={guilds}
        health={health}
        notice={notice}
        error={error}
        refreshing={refreshing}
        onRefresh={() => void refresh()}
        onSelect={guildId => navigate(guildPath(guildId))}
        onLogout={() => void logout()}
      />
    );
  }

  return (
    <AppShell
      guilds={guilds}
      guild={guild}
      selectedGuildId={guild.id}
      onSelectGuild={guildId => navigate(guildPath(guildId))}
      onBrowseAll={() => navigate(guildsPath())}
      view={view}
      onView={key => navigate(guildPath(guild.id, key))}
      health={health}
      user={session.user}
      refreshing={refreshing}
      onRefresh={() => void refresh()}
      onLogout={() => void logout()}
    >
      {error && (
        <Alert variant="destructive" className="mb-4">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {/* The bot leaving mid-session is not an error: the guild is still
          administrable, it simply has nothing to configure until AL AI returns. */}
      {!guild.botPresent ? (
        <InviteBotPanel guild={guild} refreshing={refreshing} onRefresh={() => void refresh()} />
      ) : (
        <>
          {view === "dashboard" && <DashboardView guild={guild} />}
          {view === "commands" && <CommandsView guild={guild} />}
          {view === "roles" && <RolesView guild={guild} />}
          {view === "customization" && <CustomizationView guild={guild} />}
          {view === "logs" && <LogsView guild={guild} />}
          {view === "audit" && <AuditView guild={guild} />}
          {view === "security" && <SecurityView guild={guild} />}
        </>
      )}
    </AppShell>
  );
}
