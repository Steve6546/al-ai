/**
 * Derived state Discord announces without detail.
 *
 * `webhooksUpdate` arrives with only a guild id and a channel id: it does not say
 * whether a webhook was created, changed or removed, and it does not carry the
 * webhook itself. `guildIntegrationsUpdate` is the same, minus even the channel.
 * Both are answered the same way — the caller fetches the truth, this module
 * diffs it against the last fetch and reports the difference.
 *
 * Deliberately free of any discord.js type so it can live outside the one module
 * GOVERNANCE rule 2 allows to import the library: the caller maps a Discord
 * object onto the two-field shape below, and the diff is tested at that
 * boundary instead of against a library payload.
 *
 * The snapshot is keyed by guild, and it is deliberately not seeded at boot: a
 * fetch on every guild at startup would spend a request per guild to answer a
 * question nobody asked, and the first webhook change in each guild would
 * instead report as one `create` per webhook the guild already had. Starting
 * empty means the first event in a guild is unclassified rather than
 * misclassified, which is the honest reading of "the bot was not watching
 * before".
 *
 * Volume is low by nature — webhook and integration changes are configuration,
 * not chatter — so one REST call per event is the right price. High-frequency
 * events never touch this path.
 */
export type TrackedWebhook = { id: string; channelId: string | null };

export type TrackedIntegration = { id: string; name: string | null };

export type WebhookDiff = {
  created: TrackedWebhook[];
  updated: TrackedWebhook[];
  deleted: TrackedWebhook[];
};

/**
 * Classifies a webhook change against the last snapshot for that guild.
 *
 * A webhook that moved channel counts as an update of the webhook, not a create
 * and a delete — Discord reuses the id, and reporting two halves of one change
 * would make a rename look like a replacement.
 */
export function classifyWebhooks(
  current: TrackedWebhook[],
  previous: Map<string, TrackedWebhook> | undefined
): WebhookDiff {
  const before = previous ?? new Map();
  const diff: WebhookDiff = { created: [], updated: [], deleted: [] };
  const seen = new Set<string>();

  for (const webhook of current) {
    seen.add(webhook.id);
    const prior = before.get(webhook.id);
    if (!prior) diff.created.push(webhook);
    else if (prior.channelId !== webhook.channelId) diff.updated.push(webhook);
  }
  for (const [id, webhook] of before) {
    if (!seen.has(id)) diff.deleted.push(webhook);
  }
  return diff;
}

/**
 * Reports which integration ids changed, in arrival order.
 *
 * `name` is advisory only: discord.js reports an integration's name just when the
 * application behind it is public, so two integrations that both report `null`
 * are told apart by id, which is what the log carries. The classifier therefore
 * never uses the name to decide *whether* something changed when it has no id to
 * compare against — it does, and the name only refines it.
 */
export function classifyIntegrations(
  current: TrackedIntegration[],
  previous: Map<string, TrackedIntegration> | undefined
): { added: TrackedIntegration[]; changed: TrackedIntegration[]; removed: TrackedIntegration[] } {
  const before = previous ?? new Map();
  const result: { added: TrackedIntegration[]; changed: TrackedIntegration[]; removed: TrackedIntegration[] } = {
    added: [],
    changed: [],
    removed: []
  };
  const seen = new Set<string>();

  for (const integration of current) {
    seen.add(integration.id);
    const prior = before.get(integration.id);
    if (!prior) result.added.push(integration);
    else if (prior.name !== integration.name) result.changed.push(integration);
  }
  for (const [id, integration] of before) {
    if (!seen.has(id)) result.removed.push(integration);
  }
  return result;
}

/**
 * One guild's snapshot of its webhooks and integrations.
 *
 * `undefined` for a key means "not yet watching this guild"; an empty map means
 * "watching, and the guild has none". Keeping those distinct is what stops the
 * first webhook change from reporting every webhook the guild already had.
 */
export type DerivedStateStore = {
  webhooks: Map<string, Map<string, TrackedWebhook>>;
  integrations: Map<string, Map<string, TrackedIntegration>>;
};

export function createDerivedState(): DerivedStateStore {
  return { webhooks: new Map(), integrations: new Map() };
}
