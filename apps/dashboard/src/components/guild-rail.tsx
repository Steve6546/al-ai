import { Check, CirclePlus, LayoutGrid } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { initials } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Guild } from "@/types";

/**
 * The server rail: every server the signed-in account may administer, always
 * on screen.
 *
 * It replaces the dropdown that used to sit at the top of the sidebar. A
 * dropdown answers "which server am I in?" only after a click, and it hides the
 * other servers entirely — so an operator watching one server had no way to see
 * the rest, or to notice that the bot is missing from one of them. The rail
 * shows all of them at once, marks each one's bot state, and switches on a
 * single click.
 *
 * The guild list is the server's answer, not a client guess: a guild the caller
 * cannot administer never reaches this component.
 */

type Props = {
  guilds: Guild[];
  selectedGuildId: string | null;
  onSelect: (guildId: string) => void;
  onBrowseAll: () => void;
  /**
   * `rail` is the desktop strip of round icons; `list` is the same data as
   * labelled rows inside the phone drawer, where a 4.5rem column would be a
   * waste of the screen.
   */
  variant?: "rail" | "list";
};

export function GuildRail({ guilds, selectedGuildId, onSelect, onBrowseAll, variant = "rail" }: Props) {
  const { t } = useI18n();

  if (variant === "list") {
    return (
      <nav aria-label={t("nav.bots")} className="p-3">
        <p className="px-3 pb-2 text-mini font-semibold tracking-wide text-muted-foreground">{t("nav.bots")}</p>
        <div className="space-y-0.5">
          {guilds.map(guild => {
            const selected = guild.id === selectedGuildId;
            return (
              <button
                key={guild.id}
                type="button"
                onClick={() => onSelect(guild.id)}
                aria-current={selected ? "page" : undefined}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-3 py-2 text-start text-sm transition-ui",
                  "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                  selected && "bg-sidebar-accent font-medium text-sidebar-accent-foreground"
                )}
              >
                <Avatar className="size-7 rounded-lg">
                  {guild.iconUrl && <AvatarImage src={guild.iconUrl} alt="" />}
                  <AvatarFallback className="rounded-lg text-micro">{initials(guild.name)}</AvatarFallback>
                </Avatar>
                <span className="min-w-0 flex-1 truncate">{guild.name}</span>
                <BotStateBadge guild={guild} />
                {selected && <Check className="size-3.5 shrink-0 text-muted-foreground" />}
              </button>
            );
          })}
          {guilds.length === 0 && (
            <p className="px-3 py-2 text-mini text-muted-foreground">{t("nav.noBotGuild")}</p>
          )}
          <Separator className="my-2" />
          <button
            type="button"
            onClick={onBrowseAll}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-start text-sm text-muted-foreground transition-ui hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <LayoutGrid className="size-4" />
            {t("nav.browseGuilds")}
          </button>
        </div>
      </nav>
    );
  }

  return (
    <nav aria-label={t("nav.bots")} className="hidden min-h-0 flex-col border-e border-sidebar-border bg-sidebar/60 lg:flex">
      <div className="flex shrink-0 items-center justify-center px-1 py-3">
        <span className="text-micro font-semibold tracking-wide text-muted-foreground">{t("nav.bots")}</span>
      </div>
      <Separator />
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col items-center gap-2 px-2 py-3">
          {guilds.map(guild => (
            <RailItem
              key={guild.id}
              guild={guild}
              selected={guild.id === selectedGuildId}
              onSelect={() => onSelect(guild.id)}
            />
          ))}
          {guilds.length === 0 && (
            <p className="px-1 py-2 text-center text-micro leading-relaxed text-muted-foreground">
              {t("nav.noBotGuild")}
            </p>
          )}
        </div>
      </ScrollArea>
      <Separator />
      <div className="flex shrink-0 justify-center p-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onBrowseAll}
              aria-label={t("nav.browseGuilds")}
              className="grid size-10 place-items-center rounded-xl text-muted-foreground transition-ui hover:scale-105 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <LayoutGrid className="size-4" />
            </button>
          </TooltipTrigger>
          <TooltipContent side="left" sideOffset={12}>
            {t("nav.browseGuilds")}
          </TooltipContent>
        </Tooltip>
      </div>
    </nav>
  );
}

/**
 * One server in the rail.
 *
 * The icon grows slightly on hover — the "it is about to be pressed" cue the
 * Discord rail has taught everyone — and the tooltip is the card that names the
 * server and says, in words, whether the bot is there. A missing bot is not
 * just a red dot: the card spells it out and the click lands on the invite
 * panel.
 */
function RailItem({ guild, selected, onSelect }: { guild: Guild; selected: boolean; onSelect: () => void }) {
  const { t } = useI18n();
  const present = guild.botPresent;
  const state = present ? t("nav.botAdded") : t("nav.botMissing");

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onSelect}
          aria-current={selected ? "page" : undefined}
          aria-label={`${guild.name} — ${state}`}
          className={cn(
            "group relative grid size-12 shrink-0 place-items-center rounded-2xl outline-none transition-ui",
            "hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring",
            selected && "bg-sidebar-accent"
          )}
        >
          <Avatar
            className={cn(
              "size-10 rounded-2xl ring-1 ring-border transition-transform duration-200 ease-out",
              "group-hover:scale-110 group-focus-visible:scale-110",
              selected && "ring-2 ring-primary"
            )}
          >
            {guild.iconUrl && <AvatarImage src={guild.iconUrl} alt="" />}
            <AvatarFallback className="rounded-2xl text-micro" data-initials={initials(guild.name)} />
          </Avatar>
          <span
            aria-hidden="true"
            className={cn(
              "absolute bottom-0 end-0 size-3 rounded-full ring-2 ring-sidebar",
              present ? "bg-success" : "bg-warning"
            )}
          />
        </button>
      </TooltipTrigger>
      <TooltipContent
        side="left"
        sideOffset={14}
        className="w-60 rounded-xl border border-border bg-card p-3 text-card-foreground shadow-xl"
      >
        <div className="flex items-center gap-3">
          <Avatar className="size-10 rounded-xl">
            {guild.iconUrl && <AvatarImage src={guild.iconUrl} alt="" />}
            <AvatarFallback className="rounded-xl text-sm">{initials(guild.name)}</AvatarFallback>
          </Avatar>
          <div className="min-w-0 flex-1">
            <p className="truncate text-sm font-semibold">{guild.name}</p>
            <p
              className={cn(
                "flex items-center gap-1 text-mini",
                present ? "text-success" : "text-warning"
              )}
            >
              {present ? <Check className="size-3" /> : <CirclePlus className="size-3" />}
              {state}
            </p>
          </div>
        </div>
        <p className="mt-2 text-mini leading-relaxed text-muted-foreground">
          {present ? t("nav.botAddedHint") : t("nav.botMissingHint")}
        </p>
      </TooltipContent>
    </Tooltip>
  );
}

/** The compact bot-state label used by the phone list. */
function BotStateBadge({ guild }: { guild: Guild }) {
  const { t } = useI18n();
  return guild.botPresent ? (
    <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-micro text-success">
      {t("nav.botAdded")}
    </Badge>
  ) : (
    <Badge variant="outline" className="shrink-0 px-1.5 py-0 text-micro text-warning">
      {t("nav.botMissing")}
    </Badge>
  );
}
