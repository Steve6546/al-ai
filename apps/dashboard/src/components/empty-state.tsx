import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/**
 * Placeholder for a section with nothing to show.
 *
 * In AL AI an empty screen is usually a real blocker (the bot is not invited,
 * tiers are not bound, the trail has no entries yet) rather than "no data", so
 * every empty state says what to do next instead of only reporting emptiness.
 */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  className
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-border px-6 py-12 text-center", className)}>
      <div className="grid size-11 place-items-center rounded-xl bg-muted text-muted-foreground">
        <Icon className="size-5" />
      </div>
      <div className="space-y-1">
        <p className="text-sm font-medium">{title}</p>
        <p className="max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p>
      </div>
      {action}
    </div>
  );
}
