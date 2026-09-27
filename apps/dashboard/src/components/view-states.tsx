/**
 * The two states every settings view renders before it can show anything: the
 * load it is still waiting on, and the load that failed.
 *
 * Every screen had its own copy of these, which is how they began to drift —
 * the same spinner with three different paddings, and error alerts that
 * swallowed the message in some views and showed it raw in others. The
 * failure text matters more than it looks: an operator who sees a generic
 * "failed" reloads and gets a generic failure back, while one who sees
 * Discord's actual 403 wording knows the bot is missing a permission.
 */

import { Loader2 } from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";

/** One labelled spinner, for the moment between the fetch and the answer. */
export function LoadingRow({ label = "جارٍ التحميل" }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}

/**
 * The fetch failed. Shows the message rather than a generic wording.
 *
 * The message is already in the operator's language or is Discord's own error
 * text; either is more useful than anything this component could substitute.
 */
export function LoadError({ message }: { message: string }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}
