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

import {
  botStatusDurations,
  botStatusLabels,
  botStatuses,
  isTimedBotStatus,
  type BotStatus,
  type BotStatusDuration
} from "@al-ai/core/browser";
import { Check } from "lucide-react";
import { useId } from "react";
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

/** How a status is described in the menu, the way Discord's own status menu
 * carries a one-line explanation under each name. */
const STATUS_DESCRIPTIONS: Record<BotStatus, string> = {
  online: "ستظهر متصلاً للجميع",
  idle: "ستظهر خائماً، بجانب اسمك هلال أصفر",
  dnd: "لن تصلك إشعارات سطح المكتب",
  invisible: "ستظهر غير متصل للجميع"
};

/**
 * Discord's four presence glyphs.
 *
 * `online` and `invisible` are circles that differ only in fill, and `dnd` is a
 * circle with a bar — but `idle` is a *crescent*, which no icon library draws
 * the way Discord does. It is cut with an SVG mask instead of an overlapping
 * CSS disc: a mask is self-contained, so the crescent reads correctly on every
 * surface — the card the trigger sits on, the menu, and the live preview — with
 * no caller having to name the background colour. (The previous maskColor
 * approach is also what painted the bite black once the theme's tokens became
 * oklch: `hsl(var(--background))` stopped being a colour at all.)
 */
export function StatusDot({ status, size = 10, className }: { status: BotStatus; size?: number; className?: string }) {
  const color = STATUS_COLORS[status];
  // useId keeps the mask id unique per rendered glyph; an id collision across
  // two dots on one page would make both crescents read the first mask.
  const maskId = `status-crescent-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;

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
      <svg aria-hidden viewBox="0 0 16 16" width={size} height={size} className={cn("shrink-0", className)}>
        <defs>
          <mask id={maskId}>
            <rect width="16" height="16" fill="#fff" />
            {/* The bite, top-right — Discord's crescent opens that way. */}
            <circle cx="14" cy="2" r="6.5" fill="#000" />
          </mask>
        </defs>
        <circle cx="8" cy="8" r="8" fill={color} mask={`url(#${maskId})`} />
      </svg>
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
          // `h-9` is the design system's control height — input, select and the
          // default button all share it, and this trigger sits beside a Select
          // in «الحالة والنشاط». At the old h-8 the pair read as two different
          // generations of control.
          "inline-flex h-9 items-center gap-2 rounded-md border border-input bg-transparent px-3 text-sm",
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50"
        )}
      >
        {/* The mask is the trigger's own background so the crescent's bite reads
            as a hole rather than a pale dot. The theme tokens are plain oklch
            values since Tailwind 4 — wrapping them in hsl() produced an invalid
            colour and a black bite. */}
        <StatusDot status={status} />
        <span>{botStatusLabels[status]}</span>
        {activeDuration ? (
          <span className="text-xs text-muted-foreground">
            {botStatusDurations.find(entry => entry.id === activeDuration)?.label}
          </span>
        ) : null}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        {botStatuses.map(candidate => {
          const description = STATUS_DESCRIPTIONS[candidate];
          // Two-line rows, the way Discord's own status menu draws them: the
          // name, and the explanation underneath rather than hidden in a
          // tooltip the operator has to hover to discover.
          const body = (
            <>
              <span className="mt-1">
                <StatusDot status={candidate} size={12} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium leading-tight">{botStatusLabels[candidate]}</span>
                <span className="block text-xs leading-snug text-muted-foreground">{description}</span>
              </span>
            </>
          );

          // Only the three timed states grow a sub-menu, matching Discord.
          if (!isTimedBotStatus(candidate)) {
            return (
              <DropdownMenuItem
                key={candidate}
                className="items-start justify-start gap-2.5 py-2"
                onSelect={() => pick(candidate)}
              >
                {body}
                {status === candidate ? <Check className="mt-1 size-3.5 shrink-0 text-primary" /> : null}
              </DropdownMenuItem>
            );
          }

          return (
            <DropdownMenuSub key={candidate}>
              <DropdownMenuSubTrigger className="items-start justify-start gap-2.5 py-2">
                {body}
                {status === candidate ? <Check className="mt-1 size-3.5 shrink-0 text-primary" /> : null}
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
