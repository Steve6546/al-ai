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
import { useI18n, type TranslationKey } from "@/lib/i18n";
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

/**
 * Discord's four presence glyphs, on one grid.
 *
 * All four are drawn in a 16×16 box with the same outer radius, so the picker,
 * the trigger and the preview cannot show a small dot next to a large one — the
 * defect that made the menu look hand-assembled. The shapes are Discord's own:
 *
 * - **online** — a filled circle;
 * - **idle** — a crescent, cut with a mask so its bite is a hole rather than a
 *   disc the colour of whatever surface it sits on (the mask makes it correct on
 *   the card, the menu *and* the preview with no caller passing a background);
 * - **dnd** — the same circle with Discord's white bar across the middle;
 * - **invisible** — a hollow ring of the same outer radius, drawn with a stroke
 *   instead of a CSS border so its thickness is a fraction of the glyph and
 *   stays proportional at 9 px and at 32 px.
 *
 * The crescent's cut circle is placed by geometry, not by eye: outer r=8, cut
 * r=6.4, cut centre at (13.6, 2.4). The centres are then d = 5.6·√2 ≈ 7.92
 * apart, so the cut reaches 7.92 − 6.4 = 1.52 units past the disc's centre and
 * the body is 8 − 1.52 = 6.48 units thick at its deepest, with the horn tips at
 * the top and the right.
 * (Six cut-circle placements were rendered at 9, 14 and 32 px and compared
 * against Discord's own menu before this one was chosen.)
 */
export function StatusDot({ status, size = 10, className }: { status: BotStatus; size?: number; className?: string }) {
  const color = STATUS_COLORS[status];
  // useId keeps the mask id unique per rendered glyph; an id collision across
  // two dots on one page would make both crescents read the first mask.
  const maskId = `status-crescent-${useId().replace(/[^a-zA-Z0-9-]/g, "")}`;

  return (
    <svg
      aria-hidden
      viewBox="0 0 16 16"
      width={size}
      height={size}
      // `block` rather than `inline-block`: an inline SVG keeps a text baseline
      // under it, which pushed the dot 1–2 px below the label it sits beside.
      className={cn("block shrink-0", className)}
    >
      {status === "invisible" ? (
        // Outer edge at r=8 with a 3-unit stroke: the ring is 19% of the radius
        // at every size, and the inside stays transparent.
        <circle cx="8" cy="8" r="6.5" fill="none" stroke={color} strokeWidth="3" />
      ) : status === "idle" ? (
        <>
          <defs>
            <mask id={maskId}>
              <rect width="16" height="16" fill="#fff" />
              {/* The bite, toward the top-right — Discord's crescent opens that way. */}
              <circle cx="13.6" cy="2.4" r="6.4" fill="#000" />
            </mask>
          </defs>
          <circle cx="8" cy="8" r="8" fill={color} mask={`url(#${maskId})`} />
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="8" fill={color} />
          {/* Discord's bar is white on both themes, not the surface colour. */}
          {status === "dnd" ? <rect x="3" y="6.8" width="10" height="2.4" rx="1.2" fill="#ffffff" /> : null}
        </>
      )}
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
  disabled,
  className
}: {
  status: BotStatus;
  duration: BotStatusDuration | null;
  onChange: (next: { status: BotStatus; duration: BotStatusDuration | null }) => void;
  disabled?: boolean;
  /** The trigger sizes itself to its content by default; a form that pairs it
   * with a full-width control passes `w-full` so the two read as one generation. */
  className?: string;
}) {
  // The duration only means something for a status that can carry one, so it is
  // dropped on the way out rather than stored behind `online` where nothing
  // would ever read it.
  const pick = (nextStatus: BotStatus, nextDuration: BotStatusDuration | null = null) =>
    onChange({ status: nextStatus, duration: nextStatus === "online" ? null : nextDuration });

  const { t } = useI18n();

  // `forever` is "timed, no expiry"; any other value is a real countdown.
  const activeDuration: BotStatusDuration | null = status === "online" ? null : duration;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        aria-label={t("presence.status")}
        className={cn(
          // `h-9` is the design system's control height — input, select and the
          // default button all share it, and this trigger sits beside a Select
          // in «الحالة والنشاط». At the old h-8 the pair read as two different
          // generations of control.
          // The same field surface every other control on the screen uses: a
          // transparent trigger on a card inherits the card's colour and reads
          // as a label, not as something to press.
          "inline-flex h-9 items-center gap-2 rounded-md border border-input bg-background px-3 text-sm transition-colors hover:border-ring/60 data-[state=open]:border-ring",
          "hover:bg-accent focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          "disabled:cursor-not-allowed disabled:opacity-50",
          className
        )}
      >
        {/* The mask is the trigger's own background so the crescent's bite reads
            as a hole rather than a pale dot. The theme tokens are plain oklch
            values since Tailwind 4 — wrapping them in hsl() produced an invalid
            colour and a black bite. */}
        <StatusDot status={status} size={10} className="me-0.5" />
        <span>{t(`presence.status.${status}` as TranslationKey)}</span>
        {activeDuration ? (
          <span className="text-xs text-muted-foreground">
            {t(`presence.duration.${activeDuration}` as TranslationKey)}
          </span>
        ) : null}
      </DropdownMenuTrigger>

      <DropdownMenuContent align="start" className="w-64">
        {botStatuses.map(candidate => {
          const description = t(`presence.describe.${candidate}` as TranslationKey);
          // Two-line rows, the way Discord's own status menu draws them: the
          // name, and the explanation underneath rather than hidden in a
          // tooltip the operator has to hover to discover.
          const body = (
            <>
              {/* A fixed-height box, so the glyph centres on the first line of
                  the row rather than on the two-line block; `mt-*` guessed at
                  that and drifted with the type size. */}
              <span className="flex h-5 items-center">
                <StatusDot status={candidate} size={14} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium leading-tight">{t(`presence.status.${candidate}` as TranslationKey)}</span>
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
                {status === candidate ? <Check className="size-3.5 shrink-0 self-center text-primary" /> : null}
              </DropdownMenuItem>
            );
          }

          return (
            <DropdownMenuSub key={candidate}>
              <DropdownMenuSubTrigger className="items-start justify-start gap-2.5 py-2">
                {body}
                {status === candidate ? <Check className="size-3.5 shrink-0 self-center text-primary" /> : null}
              </DropdownMenuSubTrigger>
              <DropdownMenuSubContent className="w-48 max-w-[calc(100vw-1.5rem)]">
                {botStatusDurations.map(entry => (
                  <DurationItem
                    key={entry.id}
                    label={t(`presence.duration.${entry.id}` as TranslationKey)}
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
