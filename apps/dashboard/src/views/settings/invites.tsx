import { useEffect, useState } from "react";
import { Info, Link2, Plus, Trash2, Users } from "lucide-react";
import { api } from "@/api";
import { useDraftForm } from "@/lib/use-draft-form";
import { LoadError, LoadingRow } from "@/components/view-states";
import { SaveBar } from "@/components/save-bar";
import { Toaster, useToasts } from "@/components/toaster";
import { ModuleStatusCard } from "@/components/module-status-card";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { INVITE_MESSAGE_TOKENS, MAX_FAKE_ACCOUNT_DAYS, normaliseInviteMilestones } from "@al-ai/core/browser";
import { useI18n } from "@/lib/i18n";
import type { DiscordRole, Guild, InviteMilestone, InviteSettings } from "@/types";

const NONE_ROLE = "__none__";

/**
 * The invites module's settings screen.
 *
 * One screen, three cards: the scoring policy (what counts and what logs), the
 * milestone ladder, and the log templates. The draft/save machinery is the
 * shared `useDraftForm` hook — the same unsaved-changes bar every other
 * settings screen carries, never a second copy of it.
 */
export function InvitesView({ guild }: { guild: Guild }) {
  const { t } = useI18n();
  const [settings, setSettings] = useState<InviteSettings | null>(null);
  const [problems, setProblems] = useState<{ code: string; message: string }[]>([]);
  const [roles, setRoles] = useState<DiscordRole[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newMilestone, setNewMilestone] = useState<{ net: string; roleId: string }>({ net: "", roleId: NONE_ROLE });
  const { draft, dirty, patch, reset, commit } = useDraftForm(settings);
  const { toasts, push, dismiss } = useToasts();

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setError(null);
    api
      .invitesSettings(guild.id)
      .then(result => {
        if (cancelled) return;
        setSettings(result.settings);
        setProblems(result.problems ?? []);
        setRoles(result.roles);
      })
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : t("invites.loadFailed")));
    return () => {
      cancelled = true;
    };
  }, [guild.id, t]);

  if (error) return <LoadError message={error} />;
  if (!settings || !draft) return <LoadingRow />;

  const addMilestone = () => {
    const net = Number(newMilestone.net);
    if (!Number.isInteger(net) || net < 1) {
      push({ title: t("invites.invalidThreshold"), tone: "error" });
      return;
    }
    if (newMilestone.roleId === NONE_ROLE) {
      push({ title: t("invites.chooseRoleFirst"), tone: "error" });
      return;
    }
    const next = normaliseInviteMilestones([...draft.milestoneRoles, { id: `ms-${Date.now()}`, net, roleId: newMilestone.roleId }]);
    if (next.length === draft.milestoneRoles.length) {
      push({ title: t("invites.duplicateRule"), tone: "error" });
      return;
    }
    patch({ milestoneRoles: next });
    setNewMilestone({ net: "", roleId: NONE_ROLE });
  };

  const removeMilestone = (milestone: InviteMilestone) => {
    patch({ milestoneRoles: draft.milestoneRoles.filter(rule => rule.id !== milestone.id || rule.roleId !== milestone.roleId) });
  };

  const roleName = (roleId: string) => roles.find(role => role.id === roleId)?.name ?? t("invites.unknownRole");

  return (
    <div className="space-y-4">
      {problems.length > 0 && (
        <Alert>
          <Info className="size-4" />
          <AlertDescription>
            <ul className="list-inside list-disc space-y-1">
              {problems.map(problem => (
                <li key={problem.code + problem.message}>{problem.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}

      <ModuleStatusCard
        icon={Link2}
        title={t("invites.moduleTitle")}
        description={t("invites.moduleBody")}
        enabled={draft.enabled}
        onToggle={enabled => patch({ enabled })}
        toggleLabel={t("invites.moduleToggle")}
        disabledHint={t("invites.moduleDisabled")}
        enableLabel={t("invites.moduleEnable")}
      />

      {draft.enabled ? (
        <>
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("invites.tracking")}</CardTitle>
          <CardDescription>
            {t("invites.trackingBody")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label className="text-xs">{t("invites.fakeAge")}</Label>
              <Input
                type="number"
                min={0}
                max={MAX_FAKE_ACCOUNT_DAYS}
                value={draft.fakeAccountDays}
                onChange={event => patch({ fakeAccountDays: Number(event.target.value) })}
              />
              <p className="text-micro text-muted-foreground">{t("invites.fakeAgeHint")}</p>
            </div>
            <div className="grid grid-cols-1 gap-2 self-end">
              <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-1.5">
                <span className="text-xs">{t("invites.keepRoles")}</span>
                <Switch checked={draft.keepRolesOnLeave} onCheckedChange={keepRolesOnLeave => patch({ keepRolesOnLeave })} />
              </label>
              <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-1.5">
                <span className="text-xs">{t("invites.logSelf")}</span>
                <Switch checked={draft.logSelfInvites} onCheckedChange={logSelfInvites => patch({ logSelfInvites })} />
              </label>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
            <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-1.5">
              <span className="text-xs">{t("invites.logJoins")}</span>
              <Switch checked={draft.logJoins} onCheckedChange={logJoins => patch({ logJoins })} />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-1.5">
              <span className="text-xs">{t("invites.logLeaves")}</span>
              <Switch checked={draft.logLeaves} onCheckedChange={logLeaves => patch({ logLeaves })} />
            </label>
            <label className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-1.5">
              <span className="text-xs">{t("invites.logMilestones")}</span>
              <Switch checked={draft.logMilestones} onCheckedChange={logMilestones => patch({ logMilestones })} />
            </label>
          </div>
          <p className="text-micro text-muted-foreground">
            {t("invites.logChannel")}
          </p>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <Users className="size-4" /> {t("invites.milestones")}
          </CardTitle>
          <CardDescription>
            {t("invites.milestonesBody")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {draft.milestoneRoles.length === 0 && (
            <p className="rounded-lg border border-dashed border-border/80 px-3 py-4 text-center text-xs text-muted-foreground">
              {t("invites.milestonesEmpty")}
            </p>
          )}
          {draft.milestoneRoles.length > 0 && (
            <ul className="space-y-1.5">
              {draft.milestoneRoles.map(milestone => (
                <li
                  key={`${milestone.id}:${milestone.roleId}`}
                  className="flex items-center justify-between gap-2 rounded-lg border border-border/80 px-3 py-1.5"
                >
                  <span className="text-xs">
                    {t("invites.milestoneRule", {
                      count: milestone.net,
                      role: roleName(milestone.roleId)
                    })}
                  </span>
                  <Button variant="ghost" size="icon" className="size-7" onClick={() => removeMilestone(milestone)} aria-label={t("invites.deleteRule")}>
                    <Trash2 className="size-3.5" />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-28 space-y-1">
              <Label className="text-xs">{t("invites.threshold")}</Label>
              <Input
                type="number"
                min={1}
                placeholder={t("invites.thresholdPlaceholder")}
                value={newMilestone.net}
                onChange={event => setNewMilestone(current => ({ ...current, net: event.target.value }))}
              />
            </div>
            <div className="min-w-52 flex-1 space-y-1">
              <Label className="text-xs">{t("invites.role")}</Label>
              <Select
                value={newMilestone.roleId}
                onValueChange={roleId => setNewMilestone(current => ({ ...current, roleId }))}
              >
                <SelectTrigger className="w-full">
                  <SelectValue placeholder={t("invites.chooseRole")} />
                </SelectTrigger>
                <SelectContent>
                  {roles.map(role => (
                    <SelectItem key={role.id} value={role.id}>
                      {role.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <Button type="button" size="sm" onClick={addMilestone}>
              <Plus className="size-3.5" /> {t("invites.add")}
            </Button>
          </div>
          {roles.length === 0 && (
            <p className="text-micro text-muted-foreground">
              {t("invites.roleBelowBot")}
            </p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">{t("invites.templates")}</CardTitle>
          <CardDescription>
            {t("invites.templatesBody")}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap gap-1.5">
            {INVITE_MESSAGE_TOKENS.map(token => (
              <span key={token} className="rounded-md border border-border/80 bg-muted/40 px-2 py-0.5 font-mono text-micro">
                {token}
              </span>
            ))}
          </div>
          {(
            [
              { key: "joinMessage", label: t("invites.joinTemplate"), rows: 4 },
              { key: "leaveMessage", label: t("invites.leaveTemplate"), rows: 3 },
              { key: "milestoneMessage", label: t("invites.milestoneTemplate"), rows: 2 }
            ] as const
          ).map(field => (
            <div key={field.key} className="space-y-1.5">
              <Label className="text-xs">{field.label}</Label>
              <Textarea
                rows={field.rows}
                value={draft[field.key]}
                onChange={event => patch({ [field.key]: event.target.value })}
                className="text-xs"
              />
            </div>
          ))}
        </CardContent>
      </Card>
        </>
      ) : null}


      <Toaster toasts={toasts} onDismiss={dismiss} />

      {dirty && (
        <SaveBar
          message={t("invites.unsaved")}
          saveLabel={t("invites.save")}
          cancelLabel={t("common.cancel")}
          onCancel={reset}
          onSave={async () => {
            const result = await api.saveInvitesSettings(guild.id, draft);
            commit(result.settings);
            push({ title: t("invites.saved"), tone: "success" });
          }}
        />
      )}
    </div>
  );
}
