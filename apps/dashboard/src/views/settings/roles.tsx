import { useCallback, useEffect, useState } from "react";
import { Info, ShieldCheck, Sparkles, TriangleAlert, UserCog, X } from "lucide-react";
import { api } from "@/api";
import { wireEqual } from "@/lib/records";
import { cn } from "@/lib/utils";
import { useDraftForm } from "@/lib/use-draft-form";
import { SaveBar } from "@/components/save-bar";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { RoleSwatch } from "@/components/role-swatch";
import { LoadError, LoadingRow } from "@/components/view-states";
import { ScrollArea } from "@/components/ui/scroll-area";
import { commandsUnlockedBy, type Tier } from "@al-ai/core/browser";
import { useI18n, type TranslationKey } from "@/lib/i18n";
import type { DiscordRole, Guild, TierConfig, TierRoles } from "@/types";
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
  const { t } = useI18n();
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
  }, [guild.id, t]);

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

  /**
   * The roles that already *are* staff, by what Discord says they can do.
   *
   * A role holding BAN_MEMBERS is an administrator of this server whether or not
   * anyone typed it into a box; a role holding MODERATE_MEMBERS is a moderator.
   * Deriving the suggestion from the permission bits the server already read
   * turns the screen from "guess which of these ten rows you meant" into
   * "here is what your server already grants — confirm or change it".
   */
  const suggestedFor = (tier: Tier) =>
    config.roles
      .filter(role => !unassignable.has(role.id) && (role.powers ?? []).some(power => power.tier === tier))
      .map(role => role.id);

  const applySuggestion = (tier: keyof TierRoles) =>
    setDraft(current => {
      if (!current) return current;
      const ids = suggestedFor(tier === "adminRoleIds" ? "admin" : "moderator");
      const keep = new Set(ids);
      // The other list loses every role this one takes, which is the same rule
      // `assign` applies one row at a time: a role in both would resolve to
      // admin and leave its moderator entry silently dead.
      const other: keyof TierRoles = tier === "adminRoleIds" ? "moderatorRoleIds" : "adminRoleIds";
      return { ...current, [tier]: ids, [other]: current[other].filter(id => !keep.has(id)) };
    });

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
              <p className="text-base font-semibold leading-snug">{t("roles.owner")}</p>
              <Badge variant="secondary" className="text-[10px]">{t("roles.auto")}</Badge>
            </div>
            <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
              {t("roles.ownerBody")}
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
            {t("roles.readFailed")}
          </AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-3 lg:grid-cols-2">
          <RolePicker
            title={t("roles.tier.admin")}
            description={t("roles.tier.adminBody")}
            roles={config.roles}
            selected={draft.adminRoleIds}
            unassignable={unassignable}
            unlocked={commandsUnlockedBy("admin")}
            suggested={suggestedFor("admin")}
            onSuggest={() => applySuggestion("adminRoleIds")}
            onToggle={(roleId, checked) => assign("adminRoleIds", roleId, checked)}
          />
          <RolePicker
            title={t("roles.tier.moderator")}
            description={t("roles.tier.moderatorBody")}
            roles={config.roles}
            selected={draft.moderatorRoleIds}
            unassignable={unassignable}
            unlocked={commandsUnlockedBy("moderator")}
            suggested={suggestedFor("moderator")}
            onSuggest={() => applySuggestion("moderatorRoleIds")}
            onToggle={(roleId, checked) => assign("moderatorRoleIds", roleId, checked)}
          />
        </div>
      )}

      <p className="flex items-start gap-1.5 text-xs text-muted-foreground">
        <Info className="mt-0.5 size-3.5 shrink-0" />
        {t("roles.discordNote")}
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
  unlocked,
  suggested,
  onSuggest,
  onToggle
}: {
  title: string;
  description: string;
  roles: DiscordRole[];
  selected: readonly string[];
  unassignable: ReadonlySet<string>;
  /** How many commands this tier actually runs, counted from the registry. */
  unlocked: number;
  /** The roles whose Discord permissions already mark them as this tier. */
  suggested: readonly string[];
  onSuggest: () => void;
  onToggle: (roleId: string, checked: boolean) => void;
}) {
  const { t } = useI18n();
  const powerLabel = (key: string, fallback: string) => {
    const translationKey = `roles.power.${key}` as TranslationKey;
    const value = t(translationKey);
    return value === translationKey ? fallback : value;
  };
  const chosen = new Set(selected);
  const byId = new Map(roles.map(role => [role.id, role] as const));
  const chosenRoles = selected
    .map(id => byId.get(id))
    .filter((role): role is DiscordRole => Boolean(role));
  const suggestionIsUseful = suggested.length > 0 && !suggested.every(id => chosen.has(id));

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
            {/* The size of the choice. Counted from the command registry the bot
                actually serves, so it cannot disagree with it. */}
            <Badge variant="outline" className="tabular text-[10px] text-muted-foreground">
              {t("roles.unlocked", { count: unlocked })}
            </Badge>
          </div>
          <CardDescription className="mt-0.5 text-xs">{description}</CardDescription>
        </div>
        {suggestionIsUseful ? (
          <Button type="button" variant="outline" size="sm" className="shrink-0 gap-1.5" onClick={onSuggest}>
            <Sparkles className="size-3.5" aria-hidden />
            {t("roles.suggest", { count: suggested.length })}
          </Button>
        ) : null}
      </CardHeader>
      <CardContent className="space-y-2 pb-3 sm:pb-4">
        {/*
          What the list is *for*, stated before the list rather than after it.
          The resolver (packages/core/src/permissions.ts:72) gives this tier to
          whoever holds one of these roles and to nobody else, so an empty list
          is not a neutral state — it is "only the owner can do this", and the
          screen has to say so while the operator is looking at it.
        */}
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {chosenRoles.length
            ? t("roles.everyoneHas", { description })
            : t("roles.noRoles")}
        </p>

        {/* The selection, out of the list and where it can be read at a glance.
            A choice that scrolls away inside a 60-row list is a choice nobody
            can audit, and the count badge alone says only "2". */}
        {chosenRoles.length ? (
          <div className="flex flex-wrap gap-1.5">
            {chosenRoles.map(role => (
              <button
                key={role.id}
                type="button"
                onClick={() => onToggle(role.id, false)}
                aria-label={t("roles.remove", { role: role.name, title })}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] transition-colors hover:border-destructive/60 hover:text-destructive"
              >
                <RoleSwatch color={role.color} />
                <span className="max-w-36 truncate">{role.name}</span>
                <X className="size-3 shrink-0" aria-hidden />
              </button>
            ))}
          </div>
        ) : null}

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
                  {/* What Discord already grants this role. The row used to be a
                      name and a box, which asks the operator to remember what
                      they configured in a different app months ago; the
                      permissions are in the payload we read from Discord, so
                      there is no reason to make them guess.
                      The `?? []` is for the one window where a freshly built
                      bundle meets a server that has not restarted yet — it
                      showed up as a dead screen, not a missing chip, because a
                      missing array is read before it is checked. */}
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{role.name}</span>
                    {(role.powers ?? []).length ? (
                      <span className="mt-0.5 flex flex-wrap gap-1">
                        {(role.powers ?? []).map(power => (
                          <span
                            key={power.key}
                            className={cn(
                              "rounded px-1 py-px text-[10px]",
                              power.tier === "admin" ? "bg-primary/15 text-primary" : "bg-accent text-accent-foreground"
                            )}
                          >
                            {powerLabel(power.key, power.label)}
                          </span>
                        ))}
                      </span>
                    ) : (
                      <span className="block text-[10px] text-muted-foreground">{t("roles.noModPowers")}</span>
                    )}
                  </span>
                  {blocked && (
                    <Badge variant="destructive" className="shrink-0 text-[10px]">
                      {t("roles.aboveBot")}
                    </Badge>
                  )}
                </label>
              );
            })}
          </div>
        </ScrollArea>
      </CardContent>
    </Card>
  );
}
