import { useCallback, useEffect, useState } from "react";
import { Check, Info, ShieldCheck, TriangleAlert, UserCog } from "lucide-react";
import { api } from "@/api";
import { wireEqual } from "@/lib/records";
import { useDraftForm } from "@/lib/use-draft-form";
import { SaveBar } from "@/components/save-bar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { RoleSwatch } from "@/components/role-swatch";
import { LoadError, LoadingRow } from "@/components/view-states";
import { ScrollArea } from "@/components/ui/scroll-area";
import { tierDescriptions, tierLabels, type DiscordRole, type Guild, type TierConfig, type TierRoles } from "@/types";
import { EMPTY_TIER_ROLES } from "@al-ai/core/browser";

/**
 * Role mapping — GOVERNANCE rule 3.
 *
 * Two multi-select lists, both of Role IDs. There is no "owner" field because
 * there is nothing to configure: Discord already knows who owns the guild and
 * who it grants Administrator, so those members hold the top tier from the
 * moment they sign in. The old screen demanded four roles before anything
 * worked, which meant a freshly added bot locked its own owner out.
 *
 * Each list is a checkbox group rather than a dropdown because an operator
 * usually grants several roles at once, and a closed dropdown hides what is
 * already selected.
 */
export function RolesView({ guild }: { guild: Guild }) {
  const [config, setConfig] = useState<TierConfig | null>(null);
  const { draft, dirty, reset, commit, setDraft } = useDraftForm(
    config?.configured ?? EMPTY_TIER_ROLES,
    rolesEqual
  );
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.tiers(guild.id);
      setConfig(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذّر التحميل.");
    }
  }, [guild.id]);

  useEffect(() => {
    setConfig(null);
    void load();
  }, [load]);

  if (error) {
    return <LoadError message={error} onRetry={load} />;
  }

  if (!config || !draft) {
    return <LoadingRow />;
  }

  /**
   * Assigning a role to one list removes it from the other. A role in both lists
   * would resolve to admin and leave the moderator entry silently dead, so the
   * server rejects it — moving it here is friendlier than a save-time error.
   */
  const assign = (tier: keyof TierRoles, roleId: string, checked: boolean) => {
    setDraft(current => {
      if (!current) return current;
      const next: TierRoles = { ...current, [tier]: toggle(current[tier], roleId, checked) };
      if (checked) {
        const other: keyof TierRoles = tier === "adminRoleIds" ? "moderatorRoleIds" : "adminRoleIds";
        next[other] = next[other].filter(id => id !== roleId);
      }
      return next;
    });
  };

  const unassignable = new Set(config.unassignable ?? []);

  return (
    <div className="space-y-3">
      {/* The automatic tier is a card like the two pickers below, not a
          full-width alert: it answers "where do I configure the owner?" with a
          title, a state, and one line, in the same visual grammar as the rest. */}
      <Card className="overflow-hidden">
        <div className="flex items-start gap-3 p-4 sm:p-5">
          <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
            <ShieldCheck className="size-4" aria-hidden />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-base font-semibold leading-snug">رتبة المالك</p>
              <Badge variant="secondary" className="text-[10px]">تلقائي</Badge>
            </div>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              تحكم كامل. تُمنح تلقائياً لمالك السيرفر وأي عضو يملك صلاحية{" "}
              <span dir="ltr" className="font-medium text-foreground">Administrator</span>.
            </p>
          </div>
        </div>
      </Card>

      {config.warning && (
        <Alert variant="destructive">
          <AlertDescription>{config.warning}</AlertDescription>
        </Alert>
      )}

      {config.roles.length === 0 ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertDescription>
            تعذّر قراءة رتب السيرفر. تأكّد من أن AL AI مضاف إلى السيرفر وأنه يملك صلاحية إدارة الرتب.
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <RolePicker
            title={tierLabels.admin}
            description={tierDescriptions.admin}
            roles={config.roles}
            selected={draft.adminRoleIds}
            unassignable={unassignable}
            onToggle={(roleId, checked) => assign("adminRoleIds", roleId, checked)}
          />
          <RolePicker
            title={tierLabels.moderator}
            description={tierDescriptions.moderator}
            roles={config.roles}
            selected={draft.moderatorRoleIds}
            unassignable={unassignable}
            onToggle={(roleId, checked) => assign("moderatorRoleIds", roleId, checked)}
          />
        </div>
      )}

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        الرتب تُقرأ من Discord وتُفحص على الخادم. ما يعلو رتبة البوت لا يُمنح.
      </p>


      {dirty && (
        <SaveBar
          onCancel={reset}
          onSave={async () => {
            const result = await api.saveTiers(guild.id, draft);
            commit(result.configured);
            await load();
          }}
        />
      )}
    </div>
  );
}

/** Sorted copies, so a reordered list is not mistaken for a change. */
function normalise(roles: TierRoles): TierRoles {
  return {
    adminRoleIds: [...roles.adminRoleIds].sort(),
    moderatorRoleIds: [...roles.moderatorRoleIds].sort()
  };
}

/**
 * The hook's comparison for this screen: two lists that differ only in order
 * are the same selection, so both sides are sorted before they are compared.
 */
function rolesEqual(a: TierRoles, b: TierRoles): boolean {
  return wireEqual(normalise(a), normalise(b));
}

function toggle(list: readonly string[], id: string, checked: boolean): string[] {
  return checked ? [...list, id] : list.filter(entry => entry !== id);
}

function RolePicker({
  title,
  description,
  roles,
  selected,
  unassignable,
  onToggle
}: {
  title: string;
  description: string;
  roles: DiscordRole[];
  selected: readonly string[];
  unassignable: ReadonlySet<string>;
  onToggle: (roleId: string, checked: boolean) => void;
}) {
  const chosen = new Set(selected);

  return (
    <Card className="overflow-hidden">
      <CardHeader className="flex flex-row items-center gap-3 space-y-0 pb-3 pt-4 sm:px-5">
        <span className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
          <UserCog className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <CardTitle className="text-base">{title}</CardTitle>
            <Badge variant={chosen.size ? "secondary" : "outline"} className="tabular">
              {chosen.size}
            </Badge>
          </div>
          <CardDescription className="mt-0.5 text-xs">{description}</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="pb-3 sm:pb-4">
        <ScrollArea className="h-60 rounded-md border border-border p-2 sm:h-72">
          <div className="space-y-0.5">
            {roles.map(role => {
              const blocked = unassignable.has(role.id);
              return (
                <label
                  key={role.id}
                  className="flex cursor-pointer items-center gap-2.5 rounded px-1.5 py-1.5 text-sm transition-colors hover:bg-accent"
                >
                  <Checkbox
                    checked={chosen.has(role.id)}
                    onCheckedChange={checked => onToggle(role.id, checked === true)}
                  />
                  <RoleSwatch color={role.color} />
                  <span className="min-w-0 flex-1 truncate">{role.name}</span>
                  {blocked && (
                    <Badge variant="destructive" className="shrink-0 text-[10px]">
                      أعلى من رتبة البوت
                    </Badge>
                  )}
                  {chosen.has(role.id) && !blocked && <Check className="size-3.5 shrink-0 text-muted-foreground" />}
                </label>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
