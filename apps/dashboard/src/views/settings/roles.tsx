import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2, ShieldCheck, TriangleAlert, UserCog } from "lucide-react";
import { api } from "@/api";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { SaveBar } from "@/components/save-bar";
import { tierDescriptions, tierLabels, tierOrder, type Guild, type TierConfig, type TierRoles } from "@/types";

const NONE = "__none__";

/**
 * GOVERNANCE rule 3 — tiers bind to Role IDs, never User IDs.
 *
 * This screen is Owner-only because it decides who can do everything else.
 * Until a row is saved every actor resolves to null and the dashboard denies
 * access, so an empty state here is a real blocker, not an empty table.
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
      setDraft(
        result.configured ?? {
          owner: null,
          head_admin: null,
          admin: null,
          moderator: null
        }
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "تعذّر التحميل.");
    }
  }, [guild.id]);

  useEffect(() => {
    setConfig(null);
    setDraft(null);
    void load();
  }, [load]);

  const unassignable = useMemo(() => new Set(config?.unassignable ?? []), [config]);

  const dirty = useMemo(() => {
    if (!config || !draft) return false;
    const saved = config.configured ?? { owner: null, head_admin: null, admin: null, moderator: null };
    return tierOrder.some(tier => saved[tier] !== draft[tier]);
  }, [config, draft]);

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

  const isConfigured = config.configured !== null;

  return (
    <div className="space-y-4">
      {!isConfigured && (
        <Alert>
          <TriangleAlert />
          <AlertDescription>
            لم تُضبط رتب الإدارة بعد — لا أحد يستطيع الدخول أو استخدام الأوامر حتى تحفظ رتبة المالك.
          </AlertDescription>
        </Alert>
      )}

      {config.warning && (
        <Alert variant="destructive">
          <AlertDescription>{config.warning}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <UserCog className="size-4" />
            رتب الإدارة
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-1">
          {tierOrder.map((tier, index) => {
            const value = draft[tier] ?? NONE;
            const selected = config.roles.find(role => role.id === value);
            const blocked = selected ? unassignable.has(selected.id) : false;

            return (
              <div key={tier}>
                {index > 0 && <Separator className="my-1" />}
                <div className="flex flex-wrap items-center gap-3 py-3">
                  <div className="min-w-48 flex-1">
                    <p className="text-sm font-medium">{tierLabels[tier]}</p>
                    <p className="text-xs text-muted-foreground">{tierDescriptions[tier]}</p>
                  </div>

                  {blocked && (
                    <Badge variant="destructive" className="shrink-0">
                      أعلى من رتبة البوت
                    </Badge>
                  )}

                  <Select
                    value={value}
                    onValueChange={next =>
                      setDraft(current => (current ? { ...current, [tier]: next === NONE ? null : next } : current))
                    }
                  >
                    <SelectTrigger className="w-56">
                      <SelectValue placeholder="بدون" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>بدون</SelectItem>
                      {config.roles.map(role => (
                        <SelectItem key={role.id} value={role.id}>
                          {role.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            );
          })}

          <Separator className="my-1" />
          <p className="flex items-center gap-2 pt-2 text-xs text-muted-foreground">
            <ShieldCheck className="size-3.5" />
            الرتبة نفسها لا تُسند إلى مستويين، وكل عملية تُعاد المصادقة عليها على الخادم.
          </p>
        </CardContent>
      </Card>

      {dirty && (
        <SaveBar
          onCancel={() =>
            setDraft(
              config.configured ?? { owner: null, head_admin: null, admin: null, moderator: null }
            )
          }
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
