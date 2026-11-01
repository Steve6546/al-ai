import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { StateBadge } from "@/components/state-badge";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

/**
 * The master switch of a module, and the one place its state is stated.
 *
 * The module screens used to paint the same fact three times: a badge, a
 * caption under the title, and an alert below the card. That cost vertical
 * space and made a phone screen look broken before it showed a single setting.
 * Here the badge is the state, the switch is the control, and the disabled
 * state offers the same action as a button instead of a separate alert.
 *
 * The switch and the button perform the same transition on purpose: the switch
 * is the conventional control, and the button is the discoverable one on a
 * touch screen. Both flip the *draft*; nothing is saved until the screen's own
 * save bar is used.
 */
export function ModuleStatusCard({
  icon: Icon,
  title,
  description,
  enabled,
  onToggle,
  toggleLabel,
  disabledHint,
  enableLabel = "تفعيل",
  extra,
  className
}: {
  icon: LucideIcon;
  title: string;
  /** One line: what the module does, never its current state. */
  description: string;
  enabled: boolean;
  onToggle: (enabled: boolean) => void;
  /** The accessible name of the switch. */
  toggleLabel: string;
  /** One short line shown only while the module is off. */
  disabledHint: string;
  enableLabel?: string;
  /** Extra controls beside the switch (e.g. the technical info button). */
  extra?: ReactNode;
  className?: string;
}) {
  return (
    <Card className={cn("overflow-hidden", className)}>
      <div className="flex items-start gap-3 p-4 sm:p-5">
        <span
          className={cn(
            "grid size-10 shrink-0 place-items-center rounded-xl",
            enabled ? "bg-primary/15 text-primary" : "bg-muted text-muted-foreground"
          )}
        >
          <Icon className="size-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-base font-semibold leading-tight">{title}</p>
            <StateBadge enabled={enabled} />
          </div>
          <p className="text-sm leading-relaxed text-muted-foreground">{description}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2 pt-0.5">
          {extra}
          <Switch checked={enabled} onCheckedChange={onToggle} aria-label={toggleLabel} />
        </div>
      </div>

      {!enabled ? (
        <div className="flex flex-col gap-3 border-t border-border/70 bg-muted/20 px-4 py-3.5 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p className="min-w-0 text-sm leading-relaxed text-muted-foreground">{disabledHint}</p>
          <Button size="sm" onClick={() => onToggle(true)} className="w-full shrink-0 sm:w-auto">
            {enableLabel}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
