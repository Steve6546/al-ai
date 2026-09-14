/**
 * The status picker, shaped like Discord's own.
 *
 * Discord does not put its four presence states in a `<select>`. It shows a
 * compact button carrying the current dot and label, and opens a menu where the
 * three timed states (`idle`, `dnd`, `invisible`) each grow a chevron onto a
 * sub-menu of durations. This component exists to match that, because the
 * difference is not cosmetic: a `<select>` cannot express "dnd, but only for an
 * hour", so the previous control simply could not offer the feature.
 *
 * `online` deliberately has *no* sub-menu. Discord's client does not offer a
 * duration for it, so rendering one here would invent a control the real client
 * refuses — the same mistake as the `supportsDuration` flag on `/ban`, where a
 * key was shown for an option the command could not honour.
 *
 * The dot itself is drawn rather than imported: Discord's four glyphs are a
 * filled circle, a crescent, a circle with a bar, and a hollow ring. A crescent
 * cannot come from a lucide icon at the size this renders, and the colours are
 * Discord's own values, so a shared `StatusDot` is one definition used by the
 * picker, the trigger and the live preview.
 */

import { botStatusDurations, botStatusLabels, botStatuses, type BotStatus, type BotStatusDuration } from "@al-ai/core/browser";
import { Check, ChevronRight } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { cn } from "@/lib/utils";

/**
 * Discord's own presence colours.
 *
 * Named rather than inlined at each use so the picker, the trigger and the
 * preview cannot drift apart — three copies of `#23a55a` is three chances to
 * mistype one of them.
 */
export const STATUS_COLORS: Record<BotStatus, string> = {
  online: "#23a55a",
  idle: "#f0b232",
  dnd: "#f23f43",
  invisible: "#80848e"
};

/** How a status is described in a sentence, beyond its short label. */
const STATUS_DESCRIPTIONS: Record<BotStatus, string> = {
  online: "يظهر متصلاً للجميع",
  idle: "يظهر بجانبه هلال أصفر",
  dnd: "يُظهر أنه لا يريد الإزعاج",
  invisible: "يظهر غير متصل للجميع"
};

const TIMED: BotStatus[] = ["idle", "dnd", "invisible"];

/**
 * Discord's four presence glyphs.
 *
 * `online` and `invisible` are circles that differ only in fill, and `dnd` is a
 * circle with a bar — but `idle` is a *crescent*, which no icon library draws
 * the way Discord does. It is built here from two overlapping shapes so the
 * silhouette matches: a solid disc, with a second disc in the surrounding
 * colour punched out of its top-right.
 *
 * `maskColor` is passed in rather than hardcoded because the crescent's cut-out
 * has to match whatever surface it sits on; a fixed value would show as a pale
 * notch on the menu background and a dark one on the button.
 */
export function StatusDot({
  status,
  size = 10,
  maskColor = "currentColor",
  className
}: {
  status: BotStatus;
  size?: number;
  maskColor?: string;
  className?: string;
}) {
  const color = STATUS_COLORS[status];

  if (status === "invisible") {
    return (
      <span
        aria-hidden
        className={cn("inline-block shrink-0 rounded-full border-2", className)}
        style={{ width: size, height: size, borderColor: color }}
      />
    );
  }

  if (status === "idle") {
    return (
      <span
        aria-hidden
        className={cn("relative inline-block shrink-0", className)}
        style={{ width: size, height: size }}
      >
        <span className="absolute inset-0 rounded-full" style={{ backgroundColor: color }} />
        {/* The bite that turns the disc into a crescent. */}
        <span
          className="absolute rounded-full"
          style={{
            backgroundColor: maskColor,
            width: size * 0.72,
            height: size * 0.72,
            top: -size * 0.22,
            right: -size * 0.24
          }}
        />
      </span>
    );
  }

  return (
    <svg aria-hidden viewBox="0 0 16 16" width={size} height={size} className={cn("shrink-0", className)}>
      <circle cx="8" cy="8" r="8" fill={color} />
      {status === "dnd" ? (
        <rect x="3.2" y="6.9" width="9.6" height="2.2" rx="1.1" fill="#ffffff" />
      ) : null}
    </svg>
  );
}

/**
 * One duration row inside a status sub-menu.
 *
 * `forever` is checked when the status is timed but carries no expiry, which is
 * the only way to distinguish "held indefinitely" from "no duration chosen" —
 * both would otherwise render as an empty selection.
 */
function DurationItem({
  label,
  selected,
  onSelect
}: {
  label: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem className="justify-between gap-3" onSelect={onSelect}>
      <span>{label}</span>
      {selected ? <Check className="size-3.5 text-primary" /> : null}
    </DropdownMenuItem>
  );
}

export function StatusPicker({
  status,
  duration,
  onChange,
  disabled
}: {
  status: BotStatus;
  duration: BotStatusDuration | null;
  onChange: (next: { status: BotStatus; duration: BotStatusDuration | null }) => void;
  disabled?: boolean;
}) {
  // The duration only means something for a status that can carry one, so it is
  // dropped on the way out rather than stored behind `online` where nothing
  // would ever read it.
  const pick = (nextStatus: BotStatus, nextDuration: BotStatusDuration | null = null) =>
    onChange({ status: nextStatus, duration: nextStatus === "online" ? null : nextDuration });

  // `forever` is "timed, no expiry"; any other value is a real countdown.
  const activeDuration: BotStatusDuration | null = status === "online" ? null : duration;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label="حالة البوت"
        className={cn(
          "inline-flex h-8 items-center gap-2 rounded-md border border-input bg-transparent px-2.5 text-sm",
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50"
        )}
      >
        {/* The mask is the trigger's own background so the crescent's bite reads
            as a hole rather than a pale dot. */}
        <StatusDot status={status} maskColor="hsl(var(--background))" />
        <span>{botStatusLabels[status]}</span>
        {activeDuration ? (
          <span className="text-xs text-muted-foreground">
            {botStatusDurations.find(entry => entry.id === activeDuration)?.label}
          </span>
        ) : null}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-56">
        {botStatuses.map(candidate => {
          const description = STATUS_DESCRIPTIONS[candidate];
          const body = (
            <>
              <StatusDot status={candidate} size={11} maskColor="hsl(var(--popover))" />
              <span className="flex-1">{botStatusLabels[candidate]}</span>
            </>
          );

          // Only the three timed states grow a sub-menu, matching Discord.
          if (!TIMED.includes(candidate)) {
            return (
              <DropdownMenuItem
                key={candidate}
                title={description}
                className="justify-start gap-2"
                onSelect={() => pick(candidate)}
              >
                {body}
                {status === candidate ? <Check className="size-3.5 text-primary" /> : null}
              </DropdownMenuItem>
            );
          }

          return (
            <DropdownMenuSub key={candidate}>
              <DropdownMenuSubTrigger className="justify-start gap-2" title={description}>
                {body}
                {status === candidate ? <Check className="size-3.5 text-primary" /> : null}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48">
                {botStatusDurations.map(entry => (
                  <DurationItem
                    key={entry.id}
                    label={entry.label}
                    selected={status === candidate && activeDuration === entry.id}
                    onSelect={() => pick(candidate, entry.id)}
                  />
                ))}
              </DropdownMenuSubContent>
            </DropdownMenuSub>
          );
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
