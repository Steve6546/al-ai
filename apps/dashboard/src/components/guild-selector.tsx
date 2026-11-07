import { useMemo, useState, type ReactNode } from "react";
import {
  Activity,
  Crown,
  Info,
  Loader2,
  RefreshCw,
  Search,
  ServerOff,
  Settings,
  ShieldCheck,
  Sparkles
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { SignOutButton } from "@/components/account-menu";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { BrandMark } from "@/components/brand-mark";
import { formatMemberCount, initials } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { tierOrder, type Guild, type HealthSnapshot, type SessionInfo } from "@/types";

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
  const { t, language } = useI18n();
  const [query, setQuery] = useState("");

  const { active, eligible } = useMemo(() => splitGuilds(guilds), [guilds]);
  const visibleActive = useMemo(() => filterGuilds(active, query), [active, query]);
  const visibleEligible = useMemo(() => filterGuilds(eligible, query), [eligible, query]);
  const tier = useMemo(() => highestTier(guilds), [guilds]);

  const searching = query.trim().length > 0;
  const nothingFound = searching && visibleActive.length === 0 && visibleEligible.length === 0;

  return (
    /*
     * The same frame the shell uses: one viewport tall, header pinned, and a
     * single scrolling region below it.
     *
     * This screen used to let the *window* scroll, which is no longer possible —
     * `body` is `overflow: hidden` so the shell's sidebar can stay put. Left
     * alone, a long guild list would simply have been clipped with no way to
     * reach the bottom of it.
     */
    <div className="flex h-full flex-col bg-background">
      <header className="z-30 flex h-14 shrink-0 items-center gap-3 border-b border-border bg-background/85 px-4 backdrop-blur">
        <div className="flex items-center gap-2.5">
          <BrandMark className="size-8 text-primary" />
          <span className="text-sm font-semibold">AL AI</span>
        </div>

        <div className="flex-1" />

        <StatusPill health={health} />

        <Button
          variant="outline"
          size="sm"
          onClick={onRefresh}
          disabled={refreshing}
          aria-label={t("guilds.refresh")}
        >
          <RefreshCw className={cn(refreshing && "animate-spin")} />
          <span className="hidden sm:inline">{t("common.refresh")}</span>
        </Button>

        <SignOutButton onLogout={onLogout} />
      </header>

      {/* The scrollbar belongs to the window edge, not to the centred column,
          so the scroll container spans the full width and the column is centred
          inside it. */}
      <main className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
        <div className="mx-auto w-full max-w-5xl space-y-6 p-4 lg:p-8">
          {/* Welcome ---------------------------------------------------- */}
          <div className="flex flex-col gap-4 sm:flex-row sm:items-center">
            <Avatar className="size-14 ring-2 ring-border">
              {user?.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
              <AvatarFallback className="text-lg">{initials(user?.username)}</AvatarFallback>
            </Avatar>

            <div className="min-w-0 flex-1 space-y-1">
              <h1 className="flex flex-wrap items-center gap-2 text-xl font-semibold">
                <span className="truncate">
                  {language === "ar" ? "مرحباً، " : "Welcome, "}
                  <bdi>{user?.username ?? "—"}</bdi>! 👑
                </span>
                {tier && (
                  <Badge variant="secondary" className="gap-1">
                    <Crown className="size-3" />
                    {t(`tier.${tier}` as "tier.owner")}
                  </Badge>
                )}
              </h1>
              <p className="text-sm text-muted-foreground">{t("guilds.choose")}</p>
            </div>
          </div>

          {notice && (
            <p
              aria-live="polite"
              className="-mb-4 flex items-center gap-2 text-sm text-muted-foreground"
            >
              <Info className="size-4 shrink-0" />
              {notice}
            </p>
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
              placeholder={`${t("guilds.search")} 🔭`}
              aria-label={t("guilds.searchLabel")}
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
                  <p className="text-sm font-medium">{t("guilds.noResults")}</p>
                  <p className="text-xs text-muted-foreground">
                    {t("guilds.noResultsBody", { query: query.trim() })}
                  </p>
                </div>
                <Button variant="outline" size="sm" onClick={() => setQuery("")}>
                  {t("guilds.clearSearch")}
                </Button>
              </CardContent>
            </Card>
          )}

          {!nothingFound && visibleActive.length > 0 && (
            <GuildSection
              title={t("guilds.activeTitle")}
              description={t("guilds.activeBody")}
              count={visibleActive.length}
              guilds={visibleActive}
              renderAction={guild => (
                <Button size="sm" className="w-full" onClick={() => onSelect(guild.id)}>
                  <Settings />
                  {t("guilds.manage")} ⚙️
                </Button>
              )}
            />
          )}

          {!nothingFound && visibleEligible.length > 0 && (
            <GuildSection
              title={t("guilds.eligibleTitle")}
              description={t("guilds.eligibleBody")}
              count={visibleEligible.length}
              guilds={visibleEligible}
              renderAction={guild => (
                <Button size="sm" variant="outline" className="w-full" asChild>
                  <a href={`/api/guilds/${guild.id}/invite`}>
                    <Sparkles />
                    {t("guilds.addBot")} ✨
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
                  <p className="text-sm font-medium">{t("guilds.emptyTitle")}</p>
                  <p className="text-xs text-muted-foreground">{t("guilds.emptyBody")}</p>
                </div>
                <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
                  <RefreshCw className={cn(refreshing && "animate-spin")} />
                  {t("guilds.refresh")}
                </Button>
              </CardContent>
            </Card>
          )}

          {refreshing && guilds.length === 0 && (
            <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              {t("guilds.loading")}
            </div>
          )}
        </div>
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
  const { t, language } = useI18n();
  return (
    <Card className="overflow-hidden transition-colors hover:border-primary/40">
      {/* The banner strip: the guild's own icon, blurred, over a brand gradient
          — a header that reads as "this server" without inventing a field the
          summary does not carry. */}
      <div className="relative h-24 w-full overflow-hidden bg-gradient-to-br from-primary/40 via-primary/20 to-accent/30">
        {guild.iconUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={guild.iconUrl} alt="" className="size-full scale-125 object-cover opacity-35 blur-md" />
        ) : null}
        <div className="absolute end-3 top-3">
          {guild.botPresent ? (
            <Badge className="gap-1 border-transparent bg-card/90 text-success backdrop-blur">
              <ShieldCheck className="size-3" />
              {t("guilds.activeBadge")}
            </Badge>
          ) : (
            <Badge className="gap-1 border-transparent bg-card/90 text-warning backdrop-blur">
              {t("guilds.missingBadge")}
            </Badge>
          )}
        </div>
      </div>

      <div className="px-4 pb-4">
        {/* The icon overlaps the banner, ringed in the card's own background so
            it reads as one piece rather than a pasted-on circle. */}
        <div className="-mt-8 flex justify-center">
          <Avatar className="size-16 rounded-2xl ring-4 ring-card">
            {guild.iconUrl && <AvatarImage src={guild.iconUrl} alt="" />}
            <AvatarFallback className="rounded-2xl text-lg">{initials(guild.name)}</AvatarFallback>
          </Avatar>
        </div>

        <div className="mt-2 space-y-0.5 text-center">
          <p className="truncate text-sm font-medium" title={guild.name}>
            {guild.name}
          </p>
          <p className="text-xs text-muted-foreground">{formatMemberCount(guild.memberCount, language)}</p>
        </div>

        <div className="mt-3">{action}</div>
      </div>
    </Card>
  );
}

function StatusPill({ health }: { health: HealthSnapshot | null }) {
  const { t } = useI18n();
  if (!health) return null;
  const healthy = health.status === "healthy" && health.bot === "connected";
  return (
    <Badge variant={healthy ? "secondary" : "destructive"} className="hidden gap-1.5 sm:inline-flex">
      <Activity className="size-3" />
      {healthy ? t("guilds.connected") : health.database === "unreachable" ? t("guilds.database") : t("guilds.limited")}
    </Badge>
  );
}
