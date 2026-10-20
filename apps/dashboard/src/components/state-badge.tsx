import { Badge } from "@/components/ui/badge";

/**
 * The one activation badge, used everywhere a system or option has a master
 * toggle: green with a live dot and «مُفعّل» when armed, neutral grey with
 * «مُعطل» when not. Screens pair it with conditional rendering — sub-settings
 * exist only while the badge is green.
 */
export function StateBadge({
  enabled,
  enabledLabel = "مُفعّل",
  disabledLabel = "مُعطل"
}: {
  enabled: boolean;
  enabledLabel?: string;
  disabledLabel?: string;
}) {
  return (
    <Badge
      variant="outline"
      className={
        enabled
          ? "border-emerald-500/40 bg-emerald-500/10 text-emerald-400"
          : "text-muted-foreground"
      }
    >
      <span
        aria-hidden
        className="me-1 inline-block size-1.5 rounded-full"
        style={{ background: enabled ? "#34d399" : "#71717a" }}
      />
      {enabled ? enabledLabel : disabledLabel}
    </Badge>
  );
}
