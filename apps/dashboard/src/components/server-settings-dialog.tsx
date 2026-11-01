import type { LucideIcon } from "lucide-react";
import { ChevronLeft, Lock } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { tierLabels, type Guild } from "@/types";
import type { ViewKey } from "@/components/app-shell";

export type ServerSettingEntry = {
  key: ViewKey;
  label: string;
  hint: string;
  group: string;
  icon: LucideIcon;
  disabled: boolean;
  reason: string | null;
};

/**
 * «إعدادات هذا السيرفر» as a menu, not a second copy of the screens.
 *
 * The account-menu item used to jump straight into the first settings screen,
 * which was surprising and hid every other one. This dialog is the index: one
 * row per existing settings screen, in the same groups as the sidebar, with the
 * access verdict the sidebar already computed. Choosing a row opens that
 * screen; nothing is edited or duplicated here.
 */
export function ServerSettingsDialog({
  open,
  onOpenChange,
  guild,
  entries,
  onOpenView
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  guild: Guild;
  entries: ServerSettingEntry[];
  onOpenView: (view: ViewKey) => void;
}) {
  const groups = entries.reduce<{ title: string; items: ServerSettingEntry[] }[]>((all, entry) => {
    const group = all.find(item => item.title === entry.group);
    if (group) group.items.push(entry);
    else all.push({ title: entry.group, items: [entry] });
    return all;
  }, []);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>إعدادات هذا السيرفر</DialogTitle>
          <DialogDescription>
            {guild.name} · {guild.tier ? tierLabels[guild.tier] : "بدون رتبة"} — اختر قسماً لفتحه.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant={guild.botPresent ? "secondary" : "destructive"}>
            {guild.botPresent ? "البوت مضاف" : "البوت غير مضاف"}
          </Badge>
          <span>{guild.memberCount === null ? "عدد الأعضاء غير متاح" : `${guild.memberCount} عضواً`}</span>
        </div>

        {!guild.botPresent ? (
          <div className="flex flex-col gap-2 rounded-xl border border-warning/40 bg-warning/10 p-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-sm text-warning">أضف AL AI إلى السيرفر لفتح الإعدادات.</p>
            <Button asChild size="sm" variant="outline" className="shrink-0 border-warning/50">
              <a href={`/api/guilds/${guild.id}/invite`}>إضافة البوت</a>
            </Button>
          </div>
        ) : null}

        <div className="max-h-[60vh] space-y-4 overflow-y-auto pe-1">
          {groups.map(group => (
            <section key={group.title} className="space-y-2">
              {group.title ? (
                <h3 className="px-1 text-[11px] font-semibold tracking-wide text-muted-foreground">{group.title}</h3>
              ) : null}
              <div className="grid gap-2 sm:grid-cols-2">
                {group.items.map(entry => {
                  const Icon = entry.icon;
                  return (
                    <button
                      key={entry.key}
                      type="button"
                      disabled={entry.disabled}
                      onClick={() => {
                        onOpenView(entry.key);
                        onOpenChange(false);
                      }}
                      className={cn(
                        "group flex min-w-0 items-start gap-3 rounded-xl border border-border/80 p-3 text-start transition-ui",
                        entry.disabled
                          ? "cursor-not-allowed opacity-55"
                          : "hover:border-primary/40 hover:bg-muted/40"
                      )}
                    >
                      <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/12 text-primary">
                        <Icon className="size-4" aria-hidden />
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium leading-tight">{entry.label}</span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                          {entry.disabled ? entry.reason ?? "غير متاح" : entry.hint}
                        </span>
                      </span>
                      {entry.disabled ? (
                        <Lock className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                      ) : (
                        <ChevronLeft className="mt-0.5 size-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-x-0.5" aria-hidden />
                      )}
                    </button>
                  );
                })}
              </div>
            </section>
          ))}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            إغلاق
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
