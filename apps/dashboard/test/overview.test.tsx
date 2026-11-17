import test from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { buildStats, DashboardView, OverviewContent } from "../src/views/dashboard";
import { I18nProvider } from "../src/lib/i18n";
import { en } from "../src/lib/i18n.en";
import type { Guild, GuildMetrics } from "../src/types";

/**
 * The overview's arithmetic, pinned without a browser.
 *
 * Effects do not run under `renderToString`, so the screen renders its loading
 * state in a smoke test and never computes a card. The numbers are therefore
 * asserted directly — in particular the case the reference design got wrong:
 * a window with no previous data printed `Infinity%` beside a green arrow.
 */

const base = (overrides: Partial<GuildMetrics> = {}): GuildMetrics => ({
  bot: { online: true, pingMs: 141, lastSeenAt: new Date().toISOString() },
  members: { total: 152, online: 30, onlineNote: null },
  punishments24h: { total: 0, ban: 0, kick: 0, timeout: 0, warn: 0 },
  recentActivity: [],
  series: { events: [0, 0, 4, 0], penalties: [0, 0, 0, 0] },
  previous: { events: 0, penalties: 0 },
  ...overrides
});

// The English dictionary is enough: every key used here exists in all three.
const t = ((key: string, params?: Record<string, string | number>) => {
  const template = (en as Record<string, string>)[key] ?? key;
  return params
    ? template.replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? `{${name}}`))
    : template;
}) as Parameters<typeof buildStats>[2];

test("an empty previous window is «new», never Infinity%", () => {
  const stats = buildStats(base(), "en", t);
  assert.equal(stats.eventChange?.kind, "new");
  assert.equal(stats.eventChange?.percent, null, "a percentage against zero does not exist");
  assert.equal(stats.eventChange?.delta, 4);
});

test("a real baseline produces a real percentage in both directions", () => {
  const up = buildStats(base({ previous: { events: 2, penalties: 0 } }), "en", t);
  assert.equal(up.eventChange?.kind, "up");
  assert.equal(up.eventChange?.percent, 100, "4 events against a baseline of 2 is +100%");

  const down = buildStats(
    base({ series: { events: [1, 0, 0, 0], penalties: [0, 0, 0, 0] }, previous: { events: 4, penalties: 0 } }),
    "en",
    t
  );
  assert.equal(down.eventChange?.kind, "down");
  assert.equal(down.eventChange?.percent, -75);
});

test("no change is reported as no change, not as -100%", () => {
  const stats = buildStats(
    base({ series: { events: [0, 0, 0, 0], penalties: [0, 0, 0, 0] } }),
    "en",
    t
  );
  assert.equal(stats.eventChange?.kind, "flat");
  assert.equal(stats.eventChange?.percent, 0);
});

test("the punishment card's total is the chart's own total", () => {
  // A mismatch here was visible in the first layout render: a card printed 0 next
  // to a sparkline with four events in it, because the number came from the
  // counter and the line from the histogram.
  const stats = buildStats(
    base({
      punishments24h: { total: 0, ban: 0, kick: 0, timeout: 0, warn: 0 },
      series: { events: [0, 1, 2, 1], penalties: [0, 1, 2, 1] }
    }),
    "en",
    t
  );
  assert.equal(stats.penalties, 4, "the card prints what its own chart draws");
});

test("a chart that could not be read produces no comparison at all", () => {
  const stats = buildStats(base({ series: { events: [], penalties: [] } }), "en", t);
  assert.equal(stats.eventChange, null, "no series means no claim about yesterday");
  assert.equal(stats.penaltyChange, null);
});

test("the online bar cannot exceed its track", () => {
  // Discord's live widget can report more members online than the bot's last
  // stored count, because the two are refreshed by different things.
  const stats = buildStats(base({ members: { total: 10, online: 14, onlineNote: null } }), "en", t);
  assert.equal(stats.onlineShare, 100, "clamped, so the bar fills its track and no more");
});

test("no members means no division by zero", () => {
  const stats = buildStats(base({ members: { total: 0, online: 0, onlineNote: null } }), "en", t);
  assert.equal(stats.onlineShare, 0);
  assert.equal(stats.members, "0");
});

test("the screen renders its loading state rather than crashing", () => {
  const guild = { id: "1", name: "G", iconUrl: null, memberCount: 1, tier: null, botPresent: true } as unknown as Guild;
  const html = renderToString(
    createElement(
      I18nProvider,
      { initialLanguage: "en", children: createElement(DashboardView, { guild, onOpen: () => {} }) }
    )
  );
  assert.ok(html.includes("Loading the server metrics"), html.slice(0, 200));
});

test("the module grid renders one card per system, with its real state", () => {
  // The grid is the half of the screen that lists what the project actually has.
  // Nine cards existed before this test and none of them was ever rendered: a
  // smoke test under `renderToString` only ever saw the loading row.
  const modules = [
    { key: "security", enabled: true, count: null },
    { key: "logging", enabled: false, count: null },
    { key: "audit", enabled: true, count: 182 },
    { key: "commands", enabled: true, count: 3 },
    { key: "roles", enabled: true, count: 3 },
    { key: "welcome", enabled: false, count: null },
    { key: "welcomeMessages", enabled: false, count: null },
    { key: "customization", enabled: true, count: null },
    { key: "levels", enabled: false, count: null },
    { key: "invites", enabled: false, count: null },
    { key: "presence", enabled: true, count: null }
  ] as GuildModuleState[];

  const guild = { id: "1", name: "G", iconUrl: null, memberCount: 1, tier: null, botPresent: true } as unknown as Guild;
  const opened: string[] = [];
  const html = renderToString(
    createElement(
      I18nProvider,
      {
        initialLanguage: "en",
        children: createElement(OverviewContent, {
          guild,
          metrics: base(),
          modules,
          modulesFailed: false,
          onOpen: (view: string) => opened.push(view)
        })
      }
    )
  );

  for (const title of [
    "Protection",
    "Bot logs",
    "Dashboard audit trail",
    "Commands",
    "Admin and moderator roles",
    "Automatic role",
    "Welcome messages",
    "Levels and XP",
    "Invites and referrals",
    "Bot identity",
    "Bot status"
  ]) {
    assert.ok(html.includes(title), `missing card: ${title}`);
  }

  // The three group headings the request asked for, by name.
  assert.ok(html.includes("Moderation and security"));
  assert.ok(html.includes("Server and member management"));
  assert.ok(html.includes("Bot settings"));

  // State is stated per card, from the payload - six off, five on in this set.
  assert.equal((html.match(/>Off</g) ?? []).length, 5, "logging, welcome, welcome messages, levels, invites");
  assert.equal((html.match(/>On</g) ?? []).length, 6);

  // Counts are the modules' own tallies, and the settings-style cards say
  // «open settings» rather than «manage».
  assert.ok(html.includes("Audit entries: 182"), "the audit card counts the trail");
  assert.ok(html.includes("Disabled commands: 3"), "the commands card counts the flags that are off");
  assert.ok(html.includes("Open settings"), "identity and status are control surfaces");
  assert.equal(opened.length, 0, "rendering does not navigate anywhere");
});

test("a card the server withheld takes its group with it", () => {
  // «Bot status» is instance-wide and the server omits it for anybody who is not
  // the deployment's owner. The group must disappear rather than render a
  // heading over an empty space.
  const guild = { id: "1", name: "G", iconUrl: null, memberCount: 1, tier: null, botPresent: true } as unknown as Guild;
  const html = renderToString(
    createElement(
      I18nProvider,
      {
        initialLanguage: "en",
        children: createElement(OverviewContent, {
          guild,
          metrics: base(),
          modules: [{ key: "security", enabled: true, count: null }] as GuildModuleState[],
          modulesFailed: false,
          onOpen: () => {}
        })
      }
    )
  );
  assert.ok(!html.includes("Bot settings"), "no heading over nothing");
  assert.ok(html.includes("Protection"));
});
