import { useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  Bot,
  Crown,
  Loader2,
  LogOut,
  RefreshCw,
  Search,
  ServerOff,
  Settings,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { formatMemberCount, initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import { tierLabels, tierOrder, type Guild, type HealthSnapshot, type SessionInfo } from "@/types";

/**
 * The guild selector — the first screen after signing in.
 *
 * It answers one question: which server am I here to manage? Two lists, split by
 * whether the bot is already there, because that is the only thing that changes
 * what the operator can do next. A guild where AL AI is present opens its
 * dashboard; one where it is not can only be invited, and offering a dashboard
 * link for it would lead somewhere that cannot work yet.
 *
 * The split and the search are pure functions so they can be tested directly.
 */

export type GuildGroups = { active: Guild[]; eligible: Guild[] };

/**
 * Splits the administrable guilds into the two lists the screen shows.
 *
 * `botPresent` is the whole test: the server has already established that the
 * caller may administer each of these, so the only remaining question is whether
 * AL AI is in there to be configured.
 */
export function splitGuilds(guilds: Guild[]): GuildGroups {
  return {
    active: guilds.filter(guild => guild.botPresent),
    eligible: guilds.filter(guild => !guild.botPresent)
  };
}

/**
 * Instant search over the loaded list.
 *
 * Matching is local and synchronous — the list is already in memory, so a round
 * trip per keystroke would only add latency and a loading state to something
 * that should feel immediate. The id is searchable too, because pasting a server
 * id is how people find a guild whose name they cannot type.
 */
export function filterGuilds(guilds: Guild[], query: string): Guild[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return guilds;
  return guilds.filter(guild => guild.name.toLowerCase().includes(needle) || guild.id.includes(needle));
}

/** The most privileged tier the operator holds anywhere, for the welcome badge. */
export function highestTier(guilds: Guild[]) {
  return tierOrder.find(tier => guilds.some(guild => guild.tier === tier)) ?? null;
}

type Props = {
  user: SessionInfo["user"];
  guilds: Guild[];
  health: HealthSnapshot | null;
  notice: string | null;
  error: string | null;
  refreshing: boolean;
  onRefresh: () => void;
  onSelect: (guildId: string) => void;
  onLogout: () => void;
};

export function GuildSelector({ user, guilds, health, notice, error, refreshing, onRefresh, onSelect, onLogout }: Props) {
  const [query, setQuery] = useState("");

  const { active, eligible } = useMemo(() => splitGuilds(guilds), [guilds]);
  const visibleActive = useMemo(() => filterGuilds(active, query), [active, query]);
  const visibleEligible = useMemo(() => filterGuilds(eligible, query), [eligible, query]);
  const tier = useMemo(() => highestTier(guilds), [guilds]);

  const searching = query.trim().length > 0;
  const nothingFound = searching && visibleActive.length === 0 && visibleEligible.length === 0;

  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-30 flex h-14 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur">
        <div className="flex items-center gap-2.5">
          <div className="grid size-8 place-items-center rounded-lg bg-primary text-primary-foreground">
            <Bot className="size-4" />
          </div>
          <span className="text-sm font-semibold">AL AI</span>
        </div>

        <div className="flex-1" />

        <StatusPill health={health} />

        <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
          <RefreshCw className={cn(refreshing && "animate-spin")} />
          <span className="hidden sm:inline">تحديث</span>
        </Button>

        <Button variant="ghost" size="sm" onClick={onLogout}>
          <LogOut />
          <span className="hidden sm:inline">خروج</span>
        </Button>
      </header>

      <main className="mx-auto w-full max-w-5xl space-y-6 p-4 lg:p-8">
        {/* Welcome ---------------------------------------------------- */}
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
          <Avatar className="size-14 ring-2 ring-border">
            {user?.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
            <AvatarFallback className="text-lg">{initials(user?.username)}</AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1 space-y-1">
            <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
              <span className="truncate">مرحباً، {user?.username ?? "—"}! 👑</span>
              {tier && (
                <Badge variant="secondary" className="gap-1">
                  <Crown className="size-3" />
                  {tierLabels[tier]}
                </Badge>
              )}
            </h1>
            <p className="text-sm text-muted-foreground">اختر سيرفراً لإدارة إعدادات البوت</p>
          </div>
        </div>

        {notice && (
          <div className="rounded-lg border border-border bg-card px-4 py-3 text-sm text-muted-foreground">{notice}</div>
        )}
        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {error}
          </div>
        )}

        {/* Search ----------------------------------------------------- */}
        <div className="relative">
          <Search className="pointer-events-none absolute start-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder="ابحث عن سيرفر... 🔭"
            aria-label="ابحث عن سيرفر"
            className="h-11 ps-9"
          />
        </div>

        {nothingFound && (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
              <div className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
                <ServerOff className="size-5" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">لا نتائج مطابقة</p>
                <p className="text-xs text-muted-foreground">
                  لا يوجد سيرفر باسم «{query.trim()}». جرّب جزءاً من الاسم أو معرّف السيرفر.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                مسح البحث
              </Button>
            </CardContent>
          </Card>
        )}

        {!nothingFound && visibleActive.length > 0 && (
          <GuildSection
            title="السيرفرات النشطة"
            description="AL AI موجود فيها ويمكنك إدارتها الآن."
            count={visibleActive.length}
            guilds={visibleActive}
            renderAction={guild => (
              <Button size="sm" className="w-full" onClick={() => onSelect(guild.id)}>
                <Settings />
                إدارة ⚙️
              </Button>
            )}
          />
        )}

        {!nothingFound && visibleEligible.length > 0 && (
          <GuildSection
            title="سيرفرات أخرى مؤهلة"
            description="تملك صلاحية الإدارة فيها، لكن AL AI ليس مضافاً بعد."
            count={visibleEligible.length}
            guilds={visibleEligible}
            renderAction={guild => (
              <Button size="sm" variant="outline" className="w-full" asChild>
                <a href={`/api/guilds/${guild.id}/invite`}>
                  <Sparkles />
                  إضافة البوت ✨
                </a>
              </Button>
            )}
          />
        )}

        {guilds.length === 0 && !searching && (
          <Card>
            <CardContent className="flex flex-col items-center gap-3 p-10 text-center">
              <div className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
                <ServerOff className="size-5" />
              </div>
              <div className="space-y-1">
                <p className="text-sm font-medium">لا توجد سيرفرات مؤهلة</p>
                <p className="text-xs text-muted-foreground">
                  تظهر هنا السيرفرات التي تملك فيها صلاحية «إدارة السيرفر» أو «Administrator» فقط.
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
                <RefreshCw className={cn(refreshing && "animate-spin")} />
                تحديث القائمة
              </Button>
            </CardContent>
          </Card>
        )}

        {refreshing && guilds.length === 0 && (
          <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
            <Loader2 className="size-4 animate-spin" />
            جارٍ تحميل السيرفرات
          </div>
        )}
      </main>
    </div>
  );
}

/* -------------------------------------------------------------------- *
 * Pieces
 * -------------------------------------------------------------------- */

function GuildSection({
  title,
  description,
  count,
  guilds,
  renderAction
}: {
  title: string;
  description: string;
  count: number;
  guilds: Guild[];
  renderAction: (guild: Guild) => ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-baseline gap-2">
        <h2 className="text-sm font-semibold">{title}</h2>
        <Badge variant="outline" className="tabular">
          {count}
        </Badge>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {guilds.map(guild => (
          <GuildCard key={guild.id} guild={guild} action={renderAction(guild)} />
        ))}
      </div>
    </section>
  );
}

function GuildCard({ guild, action }: { guild: Guild; action: ReactNode }) {
  return (
    <Card className="transition-colors hover:border-primary/40">
      <CardContent className="space-y-3 p-4">
        <div className="flex items-start gap-3">
          <Avatar className="size-11 rounded-xl">
            {guild.iconUrl && <AvatarImage src={guild.iconUrl} alt="" />}
            <AvatarFallback className="rounded-xl">{initials(guild.name)}</AvatarFallback>
          </Avatar>

          <div className="min-w-0 flex-1 space-y-1">
            <p className="truncate text-sm font-medium" title={guild.name}>
              {guild.name}
            </p>
            <p className="text-xs text-muted-foreground">{formatMemberCount(guild.memberCount)}</p>
          </div>

          {/* Present means manageable; absent means invitable. The badge states
              which, so the action below it is never a surprise. */}
          {guild.botPresent ? (
            <Badge className="shrink-0 gap-1 border-transparent bg-success/15 text-success">
              <ShieldCheck className="size-3" />
              نشط
            </Badge>
          ) : (
            <Badge variant="outline" className="shrink-0 gap-1 text-warning">
              غير مضاف
            </Badge>
          )}
        </div>

        {action}
      </CardContent>
    </Card>
  );
}

function StatusPill({ health }: { health: HealthSnapshot | null }) {
  if (!health) return null;
  const healthy = health.status === "healthy" && health.bot === "connected";
  return (
    <Badge variant={healthy ? "secondary" : "destructive"} className="hidden gap-1.5 sm:inline-flex">
      <Activity className="size-3" />
      {healthy ? "متصل" : health.database === "unreachable" ? "قاعدة البيانات" : "محدود"}
    </Badge>
  );
}
