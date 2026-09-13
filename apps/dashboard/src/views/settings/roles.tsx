import { useCallback, useEffect, useState } from "react";
import { Check, Info, Loader2, ShieldCheck, TriangleAlert, UserCog } from "lucide-react";
import { api } from "@/api";
import { SaveBar } from "@/components/save-bar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { tierDescriptions, tierLabels, type DiscordRole, type Guild, type TierConfig, type TierRoles } from "@/types";

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
  const [draft, setDraft] = useState<TierRoles | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await api.tiers(guild.id);
      setConfig(result);
      setDraft(result.configured ?? EMPTY_TIERS);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذّر التحميل.");
    }
  }, [guild.id]);

  useEffect(() => {
    setConfig(null);
    setDraft(null);
    void load();
  }, [load]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error}</AlertDescription>
      </Alert>
    );
  }

  if (!config || !draft) {
    return (
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
        جارٍ التحميل
      </div>
    );
  }

  const dirty = JSON.stringify(normalise(config.configured ?? EMPTY_TIERS)) !== JSON.stringify(normalise(draft));

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
    <div className="space-y-4">
      {/* The automatic tier is stated plainly, because "where do I configure the
          owner?" is the first question this screen used to raise. */}
      <Alert>
        <ShieldCheck />
        <AlertDescription>
          <span className="font-medium">{tierLabels.owner}</span> — {tierDescriptions.owner}
        </AlertDescription>
      </Alert>

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
        <div className="grid gap-4 lg:grid-cols-2">
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
        تُقرأ هذه الرتب من Discord مباشرة، وتُفحص على الخادم عند كل إجراء — لا تعتمد الواجهة على نفسها في المصادقة. الرتبة
        التي تعلو رتبة البوت لا يمكن منحها، وتظهر هنا بعلامة تحذير.
      </p>

      {dirty && (
        <SaveBar
          onCancel={() => setDraft(config.configured ?? EMPTY_TIERS)}
          onSave={async () => {
            const result = await api.saveTiers(guild.id, draft);
            setConfig(current => (current ? { ...current, configured: result.configured } : current));
            setDraft(result.configured);
            await load();
          }}
        />
      )}
    </div>
  );
}

const EMPTY_TIERS: TierRoles = { adminRoleIds: [], moderatorRoleIds: [] };

/** Sorted copies, so a reordered list is not mistaken for a change. */
function normalise(roles: TierRoles): TierRoles {
  return {
    adminRoleIds: [...roles.adminRoleIds].sort(),
    moderatorRoleIds: [...roles.moderatorRoleIds].sort()
  };
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
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-base">
            <UserCog className="size-4" />
            {title}
          </CardTitle>
          <Badge variant={chosen.size ? "secondary" : "outline"} className="tabular">
            {chosen.size}
          </Badge>
        </div>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent>
        <ScrollArea className="h-72 rounded-md border border-border p-2">
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
                  <span
                    className="size-2.5 shrink-0 rounded-full border border-border"
                    style={role.color ? { backgroundColor: `#${role.color.toString(16).padStart(6, "0")}` } : undefined}
                    aria-hidden
                  />
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
        <Separator className="my-3" />
        <p className="text-xs text-muted-foreground">{chosen.size === 0 ? "لا رتب مختارة." : `${chosen.size} رتبة مختارة.`}</p>
      </CardContent>
    </Card>
  );
}
