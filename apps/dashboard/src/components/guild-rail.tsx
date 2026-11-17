import { Check, CirclePlus, LayoutGrid } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { initials } from "@/lib/format";
import { useI18n } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import type { Guild } from "@/types";

/**
 * The server rail: every server the signed-in account may administer, always on
 * screen, one click away.
 *
 * It is placement-agnostic. On desktop it is the first column of the shell grid;
 * on a phone it is the leading column *inside* the navigation drawer, so opening
 * the menu reveals the servers beside the settings nav rather than a strip that
 * eats a permanent slice of the content. Either way the caller owns the frame
 * (`border`, `background`, width) and this component owns only the list.
 *
 * The guild list is the server's answer, not a client guess: a guild the caller
 * cannot administer never reaches this component.
 */

type Props = {
  guilds: Guild[];
  selectedGuildId: string | null;
  onSelect: (guildId: string) => void;
  onBrowseAll: () => void;
};

export function GuildRail({ guilds, selectedGuildId, onSelect, onBrowseAll }: Props) {
  const { t } = useI18n();

  return (
    <nav aria-label={t("nav.bots")} className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-center px-1 py-3">
        <span className="text-micro font-semibold tracking-wide text-muted-foreground">{t("nav.bots")}</span>
      </div>
      <Separator />
      {/* The rail is one viewport tall and its list is the only thing inside it
          that scrolls: a long list of servers must not push the browse button
          off the bottom of the rail. */}
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
 * just an amber dot: the card spells it out.
 *
 * A server the bot is already in switches the dashboard to it. A server it is
 * *not* in cannot show a single usable setting — every screen there writes state
 * only the bot can apply — so the click is a link straight into the invite flow
 * instead of a settings screen that would silently do nothing.
 */
function RailItem({ guild, selected, onSelect }: { guild: Guild; selected: boolean; onSelect: () => void }) {
  const { t } = useI18n();
  const present = guild.botPresent;
  const state = present ? t("nav.botAdded") : t("nav.botMissing");

  const className = cn(
    "group relative grid size-12 shrink-0 place-items-center rounded-2xl outline-none transition-ui",
    "hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring",
    selected && "bg-sidebar-accent"
  );

  const inner = (
    <>
      <Avatar
        className={cn(
          "size-10 rounded-2xl ring-1 ring-border transition-transform duration-200 ease-out",
          "group-hover:scale-110 group-focus-visible:scale-110",
          selected && "ring-2 ring-primary"
        )}
      >
        {guild.iconUrl && <AvatarImage src={guild.iconUrl} alt="" />}
        <AvatarFallback className="rounded-2xl text-micro">{initials(guild.name)}</AvatarFallback>
      </Avatar>
      {/* The activity indicator: colour plus the words in the tooltip, because a
          dot on its own is not a label. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute bottom-0 end-0 size-3 rounded-full ring-2 ring-sidebar",
          present ? "bg-success" : "bg-warning"
        )}
      />
    </>
  );

  return (
    /* `delayDuration={0}`: the rail is a column of identical icons, so the name
       is the only thing that tells them apart. Waiting 200 ms to find out which
       server a dot belongs to is a delay with nothing to protect — there is no
       accidental-hover cost when the answer is one short line. A nested provider
       is how the shared Tooltip wrapper exposes it. */
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        {present ? (
          <button
            type="button"
            onClick={onSelect}
            aria-current={selected ? "page" : undefined}
            aria-label={`${guild.name} — ${state}`}
            className={className}
          >
            {inner}
          </button>
        ) : (
          /* An anchor, not a button: the invite flow is a server redirect, so it
             works as a plain link (middle-click, open in a new tab) and needs no
             JavaScript to reach. */
          <a href={`/api/guilds/${guild.id}/invite`} aria-label={`${guild.name} — ${state}`} className={className}>
            {inner}
          </a>
        )}
      </TooltipTrigger>
      {/* The name, and nothing else. The card used to carry the server's icon
          (a second copy of the one already under the pointer), a "bot added"
          line, and "click to manage this server" — three things the operator
          already knows, on a target they are already aiming at. What a rail of
          small icons cannot say for itself is *which* server this is. */}
      <TooltipContent side="left" sideOffset={10} className="rounded-lg border border-border bg-card px-2.5 py-1.5 shadow-lg">
        <p className="max-w-52 truncate text-sm font-medium text-card-foreground">{guild.name}</p>
      </TooltipContent>
    </Tooltip>
  );
}
