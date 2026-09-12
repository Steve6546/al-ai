import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, ServerOff } from "lucide-react";
import { api, ApiError } from "@/api";
import { AppShell, viewRequiresBot, type ViewKey } from "@/components/app-shell";
import { EmptyState } from "@/components/empty-state";
import { InviteBotPanel } from "@/components/invite-bot";
import { LoginScreen } from "@/components/login-screen";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { AuditView, CommandsView, CustomizationView, DashboardView, LogsView, RolesView, SecurityView, TokensView } from "@/views";
import type { Guild, HealthSnapshot, SessionInfo } from "@/types";

/**
 * Application root.
 *
 * Nothing here is mock data: every value comes from the BFF after a real Discord
 * sign-in, and the screens are only reachable when the session, the guild and the
 * bot's membership actually allow them.
 */

/** Messages the OAuth callback can hand back through `?auth=`. */
const authMessages: Record<string, string> = {
  ok: "تم تسجيل الدخول.",
  denied: "لا تملك رتبة إدارية في أي سيرفر مضاف.",
  state_mismatch: "فشل التحقق من حالة OAuth.",
  failed: "تعذّر إكمال تسجيل الدخول."
};

export function App() {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [health, setHealth] = useState<HealthSnapshot | null>(null);
  const [selectedGuildId, setSelectedGuildId] = useState<string | null>(null);
  const [view, setView] = useState<ViewKey>("dashboard");
  const [booting, setBooting] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const sessionInfo = await api.session();
      setSession(sessionInfo);
      const healthResult = await api.health().catch(() => null);
      setHealth(healthResult);

      if (!sessionInfo.authenticated) {
        setGuilds([]);
        setSelectedGuildId(null);
        return;
      }

      const result = await api.guilds();
      setGuilds(result.guilds);
      setSelectedGuildId(current =>
        current && result.guilds.some(item => item.id === current) ? current : (result.guilds[0]?.id ?? null)
      );
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
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
      window.history.replaceState({}, "", window.location.pathname);
    }
    void load().finally(() => setBooting(false));
  }, [load]);

  const guild = useMemo(() => guilds.find(item => item.id === selectedGuildId) ?? null, [guilds, selectedGuildId]);

  // Switching to a guild the bot is not in must not leave the operator on a
  // settings screen that can no longer do anything.
  useEffect(() => {
    if (guild && !guild.botPresent && viewRequiresBot(view)) setView("dashboard");
  }, [guild, view]);

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
    setSession({ authenticated: false, user: null });
    setGuilds([]);
    setSelectedGuildId(null);
    setView("dashboard");
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

  if (!guild) {
    return (
      <div className="mx-auto flex min-h-dvh max-w-md flex-col items-center justify-center gap-4 p-6">
        <EmptyState
          icon={ServerOff}
          title="لا يوجد سيرفر"
          description="سجّل الدخول بحساب يملك رتبة إدارية في سيرفر، ثم أضف AL AI إليه. لا تظهر هنا إلا السيرفرات التي تملك عليها صلاحية الإدارة."
          action={
            <div className="flex gap-2">
              <Button asChild>
                <a href="/auth/discord/login">تحديث السيرفرات</a>
              </Button>
              <Button variant="outline" onClick={() => void logout()}>
                تسجيل الخروج
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  const showInviteGate = !guild.botPresent;

  return (
    <AppShell
      guilds={guilds}
      guild={guild}
      selectedGuildId={selectedGuildId}
      onSelectGuild={setSelectedGuildId}
      view={view}
      onView={setView}
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

      {showInviteGate ? (
        <InviteBotPanel guild={guild} refreshing={refreshing} onRefresh={() => void refresh()} />
      ) : (
        <>
          {view === "dashboard" && <DashboardView guild={guild} health={health} />}
          {view === "commands" && <CommandsView guild={guild} />}
          {view === "roles" && <RolesView guild={guild} />}
          {view === "customization" && <CustomizationView guild={guild} />}
          {view === "logs" && <LogsView guild={guild} />}
          {view === "audit" && <AuditView guild={guild} />}
          {view === "security" && <SecurityView guild={guild} />}
          {view === "tokens" && <TokensView guilds={guilds} />}
        </>
      )}
    </AppShell>
  );
}
