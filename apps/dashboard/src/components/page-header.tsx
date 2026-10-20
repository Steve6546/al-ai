import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The header every screen opens with.
 *
 * Three parts, in a fixed order, so the reader always knows what the screen is
 * and what it offers: the title, one line of context, and the actions. The
 * actions belong to the *screen*, not to the frame - the frame's own controls
 * (the server, the status, the refresh) live in the application header, and
 * putting a second refresh button inside a page is how a page ends up with two.
 */
export function PageHeader({
  title,
  description,
  actions,
  className
}: {
  title: string;
  /** One line: what this screen is for, in the operator's words. */
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <header className={cn("mb-5 flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between", className)}>
      <div className="min-w-0">
        {/* The page's own heading, so every screen has exactly one `h1` - the
            frame's breadcrumb is a path, not a title. */}
        <h1 className="text-lg font-semibold leading-tight tracking-tight">{title}</h1>
        {description ? (
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}
