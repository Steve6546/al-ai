import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  Activity,
  ChevronDown,
  Database,
  FileClock,
  Globe,
  LayoutDashboard,
  Link2,
  Menu,
  MessageSquareHeart,
  PanelRightClose,
  PanelRightOpen,
  Palette,
  Radio,
  RefreshCw,
  ScrollText,
  Settings,
  ShieldAlert,
  SquareTerminal,
  Trophy,
  UserCog,
  UserPlus
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { GuildRail } from "@/components/guild-rail";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccountMenu } from "@/components/account-menu";
import { PageHeader } from "@/components/page-header";
import { BrandMark } from "@/components/brand-mark";
import { navText, useI18n, type TranslationKey } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { type Guild, type HealthSnapshot, type SessionInfo } from "@/types";

/**
 * The application frame: sidebar, header and the slot the active view renders
 * into. It owns navigation and identity only — no view-specific state lives here.
 */

export type ViewKey =
  | "dashboard"
  | "commands"
  | "customization"
  | "presence"
  | "welcome"
  | "welcome-messages"
  | "roles"
  | "levels"
  | "invites"
  | "logs"
  | "audit"
  | "security"
  | "network"
  | "settings";

/**
 * Every view key, in one place.
 *
 * The router accepts a view straight from the address bar, so it needs a way to
 * tell a real screen from a typo. Deriving the list from the navigation below
 * would be circular — the navigation needs the type, and this needs the values —
 * so the values are stated once here and a test asserts they match the nav.
 */
const viewKeys: readonly ViewKey[] = [
  "dashboard",
  "commands",
  "customization",
  "presence",
  "welcome",
  "welcome-messages",
  "roles",
  "levels",
  "invites",
  "logs",
  "audit",
  "security",
  "network",
  "settings"
] as const;

export function isViewKey(value: unknown): value is ViewKey {
  return typeof value === "string" && (viewKeys as readonly string[]).includes(value);
}

type NavItem = {
  key: ViewKey;
  label: string;
  icon: typeof LayoutDashboard;
  /** A boolean flag on the selected guild that must be true for access. */
  needs?: keyof Guild;
  /** Hidden entirely while the bot is not a member of the selected guild. */
  requiresBot?: boolean;
  /**
   * A platform-owner surface: hidden unless the session says the signed-in
   * account is the deployment's OWNER_ID. The server re-checks every gated
   * route, so this only decides what the sidebar advertises.
   */
  ownerOnly?: boolean;
};

/**
 * Navigation is data, not markup, so adding a screen means adding one entry.
 *
 * The groups follow the operator's mental model rather than the code layout:
 * what the server is doing now and what protects it (عام), what you configure
 * once per module (إعدادات الأنظمة), and the two instance-wide surfaces that
 * belong to the deployment's owner (النظام). Each titled group is a collapsible
 * header — open by default, foldable to the groups in use — with one row per
 * screen inside it.
 *
 * Every screen the project actually has is here, once. A screen that exists
 * but is unreachable is a bug to fix, not a reason to hide it — and a screen
 * that does not exist must not be advertised.
 */
const navSections: { id: string; title: TranslationKey | null; items: NavItem[] }[] = [
  {
    id: "general",
    title: "nav.section.general",
    items: [
      { key: "dashboard", label: "لوحة التحكم", icon: LayoutDashboard },
      { key: "security", label: "الحماية", icon: ShieldAlert },
      { key: "logs", label: "سجلات البوت", icon: ScrollText, needs: "canManageLogging", requiresBot: true },
      { key: "audit", label: "سجل تدقيق اللوحة", icon: FileClock }
    ]
  },
  {
    id: "modules",
    title: "nav.section.modules",
    items: [
      { key: "commands", label: "الأوامر", icon: SquareTerminal, needs: "canManageCommands", requiresBot: true },
      { key: "roles", label: "رتب الإدارة والمشرفين", icon: UserCog, needs: "canManageTiers", requiresBot: true },
      { key: "welcome", label: "الرتبة التلقائية", icon: UserPlus, needs: "canManage", requiresBot: true },
      { key: "welcome-messages", label: "رسائل الترحيب", icon: MessageSquareHeart, needs: "canManage", requiresBot: true },
      { key: "customization", label: "هوية البوت", icon: Palette, needs: "canManageIdentity", requiresBot: true },
      { key: "levels", label: "المستويات والخبرة", icon: Trophy, needs: "canManage", requiresBot: true },
      { key: "invites", label: "الإحالات والدعوات", icon: Link2, needs: "canManage", requiresBot: true }
    ]
  },
  {
    id: "system",
    title: "nav.section.system",
    // Both of these are instance-wide rather than per guild, and both are the
    // platform owner's. The server enforces OWNER_ID on every gated route, and
    // the sidebar hides what its caller cannot reach.
    //
    // «حالة البوت» belongs here and not under «إعدادات الأنظمة» for a reason
    // that is Discord's, not a preference: a status lives on the bot's gateway
    // connection, so it is one value for every server the bot is in. It was on
    // the identity screen, where everything else is scoped to one server — the
    // one control that reached everywhere on a form that promised it did not.
    items: [
      { key: "presence", label: "حالة البوت", icon: Radio, ownerOnly: true },
      // Instance-wide, not per guild: the reach of this deployment itself.
      { key: "network", label: "الوصول للشبكة", icon: Globe, ownerOnly: true }
    ]
  }
];

/**
 * Settings is an ACCOUNT surface reached from the account menu, not a guild
 * section in the sidebar. It still needs a header title and a route, so it is
 * added to the flat lookup without being advertised as a guild section.
 */
const settingsNavItem: NavItem = {
  key: "settings",
  label: "الإعدادات",
  icon: Settings
};

/** Flat lookup used by the header title. */
const navIndex = new Map(
  [...navSections.flatMap(section => section.items), settingsNavItem].map(item => [item.key, item])
);

type ShellProps = {
  guilds: Guild[];
  guild: Guild;
  selectedGuildId: string | null;
  onSelectGuild: (guildId: string) => void;
  /** Returns to the guild selector. */
  onBrowseAll: () => void;
  view: ViewKey;
  onView: (view: ViewKey) => void;
  /** Opens the signed-in account's own settings screen. */
  onOpenSettings?: () => void;
  health: HealthSnapshot | null;
  user: SessionInfo["user"];
  refreshing: boolean;
  onRefresh: () => void;
  onLogout: () => void;
  children: ReactNode;
};

const RAIL_STORAGE_KEY = "al-ai.sidebar.collapsed";

export function AppShell({
  guilds,
  guild,
  selectedGuildId,
  onSelectGuild,
  onBrowseAll,
  view,
  onView,
  onOpenSettings,
  health,
  user,
  refreshing,
  onRefresh,
  onLogout,
  children
}: ShellProps) {
  const { t } = useI18n();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem(RAIL_STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  });

  // The rail's state is a layout preference of this machine, so it is stored
  // the same way the appearance is: locally, and never on the server.
  useEffect(() => {
    try {
      window.localStorage.setItem(RAIL_STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      /* a blocked store must not break the layout */
    }
  }, [collapsed]);

  const isOwner = user?.isPlatformOwner === true;
  const allowed = (item: NavItem) => {
    if (item.ownerOnly && !isOwner) return false;
    if (item.requiresBot && !guild.botPresent) return false;
    if (!item.needs) return true;
    return Boolean(guild[item.needs]);
  };

  const denyReason = (item: NavItem) => {
    if (item.ownerOnly && !isOwner) return t("nav.denyOwner");
    if (item.requiresBot && !guild.botPresent) return t("nav.denyBot");
    if (!allowed(item)) return t("nav.denyTier");
    return null;
  };

  const nav = (collapsed: boolean) => (
    <SidebarNav
      guild={guild}
      view={view}
      collapsed={collapsed}
      allowed={allowed}
      denyReason={denyReason}
      hide={item => Boolean(item.ownerOnly && !isOwner)}
      onView={key => {
        onView(key);
        setMobileOpen(false);
      }}
    />
  );

  return (
    /*
     * The frame is one viewport tall and does not scroll. `grid-rows-[minmax(0,1fr)]`
     * states the single row's height explicitly rather than relying on an `auto`
     * row stretching to fill — with `minmax(0,1fr)` the row can also be *smaller*
     * than its content, which is what lets the scroll areas inside it scroll
     * instead of pushing the frame taller.
     */
    <div
      /*
       * `--sidebar-width` and `--rail-width` are published here so that the
       * floating save bar can span the content column and stop at the rail's
       * edge: a `fixed` element with `inset-x-0` would otherwise stretch over
       * the navigation. The values are the same widths the grid's columns use.
       */
      style={
        {
          "--sidebar-width": collapsed ? "4.75rem" : "16.5rem",
          "--rail-width": "4.5rem"
        } as React.CSSProperties
      }
      className={cn(
        "grid h-full grid-cols-1 grid-rows-[minmax(0,1fr)] transition-ui",
        collapsed ? "lg:grid-cols-[4.5rem_4.75rem_1fr]" : "lg:grid-cols-[4.5rem_16.5rem_1fr]"
      )}
    >
      {/* ---------------------------------------------------------------- *
       * Server rail — a frame column on desktop, the drawer's leading column
       * on a phone
       *
       * On a monitor the rail is the first column of the frame: every
       * administrable server on screen, one click away, never behind a menu.
       * Below `lg` it is not a column of the frame at all — a strip that ate a
       * permanent slice of a 375px content area — but the leading column of the
       * navigation drawer, so opening the menu reveals the servers beside the
       * settings nav. Both placements render the same `GuildRail`; the frame
       * that surrounds it is the only thing that differs.
       * ---------------------------------------------------------------- */}
      <div className="hidden min-h-0 overflow-hidden border-e border-sidebar-border bg-sidebar/60 lg:flex lg:flex-col">
        <GuildRail
          guilds={guilds}
          selectedGuildId={selectedGuildId}
          onSelect={onSelectGuild}
          onBrowseAll={onBrowseAll}
        />
      </div>

      {/* ---------------------------------------------------------------- *
       * Sidebar (desktop)
       *
       * `overflow-hidden` + `min-h-0` keep it exactly as tall as the frame: the
       * nav scrolls inside the ScrollArea, and a long nav can never stretch the
       * column and take the account menu off the bottom.
       * ---------------------------------------------------------------- */}
      <aside
        className={cn(
          "hidden min-h-0 overflow-hidden border-e border-sidebar-border bg-sidebar lg:flex lg:flex-col",
          collapsed && "lg:items-center"
        )}
      >
        <div className={cn("flex items-center gap-2.5 px-4 py-4", collapsed && "lg:justify-center lg:px-0")}>
          <BrandMark className="size-9 shrink-0 text-primary" />
          {!collapsed ? (
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-semibold">AL AI</p>
              <p className="truncate text-mini text-muted-foreground">{t("login.subtitle")}</p>
            </div>
          ) : null}
        </div>
        <Separator />
        <ScrollArea className="min-h-0 flex-1">{nav(collapsed)}</ScrollArea>
        <Separator />
        <div className={cn("flex items-center gap-1 p-2", collapsed && "lg:flex-col lg:justify-center")}>
          {collapsed ? (
            <AccountMenu
              user={user}
              guild={guild}
              onLogout={onLogout}
              onOpenSettings={onOpenSettings}
              variant="compact"
            />
          ) : (
            <AccountMenu
              user={user}
              guild={guild}
              onLogout={onLogout}
              onOpenSettings={onOpenSettings}
              className="flex-1"
            />
          )}
        </div>
        <div className={cn("px-2 pb-2", collapsed && "lg:flex lg:justify-center")}>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(value => !value)}
            aria-label={collapsed ? t("nav.expand") : t("nav.collapse")}
            className="size-9 text-muted-foreground"
          >
            {collapsed ? <PanelRightOpen className="size-4" /> : <PanelRightClose className="size-4" />}
          </Button>
        </div>
      </aside>

      {/* ---------------------------------------------------------------- *
       * Content
       *
       * A fixed header above a single scrolling region. The header is no longer
       * `sticky`: it sits in a column that never scrolls, so "sticky" had
       * nothing to stick to — and the padding the old layout needed at the
       * bottom of the page (to clear the floating save bar) now belongs to the
       * scroll container, where it scrolls with the content.
       * ---------------------------------------------------------------- */}
      <div className="flex min-h-0 min-w-0 flex-col">
        <header className="z-30 flex h-16 shrink-0 items-center gap-3 border-b border-border bg-background/85 px-3 backdrop-blur lg:px-5">
          {/* Mobile navigation: the sidebar is desktop-only. */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label={t("nav.menu")}>
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="flex h-full w-[22rem] max-w-[92vw] flex-col p-0">
              {/* pr-12 reserves the corner where the sheet's absolute close
                  button (right-4) sits — without it the X lands on the brand
                  mark, which starts the title row from the same edge in RTL. */}
              <SheetHeader className="shrink-0 border-b border-border p-4 pr-12">
                <SheetTitle className="flex items-center gap-2 text-sm">
                  <BrandMark className="size-6 text-primary" />
                  AL AI
                </SheetTitle>
              </SheetHeader>
              {/* The rail leads the drawer: a `flex` row puts its first child on
                  the right edge in RTL, so the server list sits against the
                  reading edge with the settings nav immediately beside it — the
                  same relationship the desktop frame has, folded into the sheet.
                  Below `lg` the frame has no rail of its own; this is the only
                  copy on a phone. */}
              <div className="flex min-h-0 flex-1">
                <div className="flex w-[4.5rem] shrink-0 flex-col border-e border-sidebar-border bg-sidebar/60">
                  <GuildRail
                    guilds={guilds}
                    selectedGuildId={selectedGuildId}
                    onSelect={guildId => {
                      onSelectGuild(guildId);
                      setMobileOpen(false);
                    }}
                    onBrowseAll={() => {
                      setMobileOpen(false);
                      onBrowseAll();
                    }}
                  />
                </div>
                {/* `min-h-0 flex-1` is what keeps the account row at the bottom
                    of the drawer instead of pushing it below the viewport on a
                    short phone. */}
                <ScrollArea className="min-h-0 flex-1">{nav(false)}</ScrollArea>
              </div>
              <div className="shrink-0 border-t border-border p-2">
                <AccountMenu
                  user={user}
                  guild={guild}
                  onLogout={onLogout}
                  onOpenSettings={() => {
                    setMobileOpen(false);
                    onOpenSettings?.();
                  }}
                />
              </div>
            </SheetContent>
          </Sheet>

          {/* The path, so the reader always knows where they are: the server
              they are in, and the screen inside it. The screen's own title
              lives in the content area, not here - two titles for one page is
              one too many. */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            <nav aria-label={t("nav.breadcrumb")} className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              {/* Below `sm` the view label is the useful half of the path; the
                  server name is already in the drawer and the page content. */}
              <span className="hidden min-w-0 truncate sm:inline">{guild.name}</span>
              <span aria-hidden="true" className="hidden sm:inline">/</span>
              <span className="min-w-0 truncate text-foreground">{navText(t, view).label}</span>
            </nav>
          </div>

          <StatusChips health={health} />

          {/* The appearance panel and the account menu live in the sidebar on
              desktop and in the drawer on a phone - one home each. They used to
              also sit here below `lg`, which put two light/dark switches and
              two account buttons on every phone screen. The drawer is where
              they belong now, exactly as the sidebar is on desktop. */}

          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
            loading={refreshing}
            aria-label={t("nav.refreshData")}
            className="gap-2"
          >
            <RefreshCw className={cn(refreshing && "animate-spin")} />
            <span className="hidden sm:inline">{t("nav.refresh")}</span>
          </Button>
        </header>

        {/*
         * The one scrolling element on every settings screen. `min-h-0` is what
         * makes `flex-1` mean "take the remaining height" rather than "grow to
         * fit the content"; `overscroll-contain` stops a trackpad flick at the
         * end of the list from rubber-banding the whole frame behind it.
         *
         * Content is capped to a centered max-width container: a settings
         * panel stretched across a 4K monitor reads as scattered stripes, not
         * as a dashboard.
         */}
        {/* The one scroll container is a tab stop: a keyboard user on a screen
            with no interactive content (the audit trail, for one) must still be
            able to scroll it. This is the fix axe asks for, and it changes no
            layout class the scrolling guard asserts. */}
        <main tabIndex={0} className="min-h-0 min-w-0 flex-1 overflow-y-auto overflow-x-hidden overscroll-contain p-3 pb-24 sm:p-4 lg:p-6">
          {/*
           * `mx-auto` is load-bearing, not cosmetic.
           *
           * A capped width without auto margins is pinned to the *start* edge,
           * which in this RTL product is the right — so every screen narrower
           * than the cap left one wide dead column down the left of the page,
           * and the wider the monitor the more of the window was empty. Centring
           * splits that slack instead, and the cap below is set high enough that
           * a normal desktop window is filled rather than letterboxed.
           *
           * 1920 and not the 1600 it started at: the whole interface is now
           * rendered at a 112.5% root, so the same number of pixels holds ~11%
           * less content. Leaving the cap alone would have made every screen
           * *narrower* than before in real terms while the request was to make
           * it larger; raising it keeps the cards as wide as they were and
           * gives the bigger type the room it needs.
           */}
          <div className="mx-auto w-full max-w-[1920px] px-0.5 py-1 sm:px-1 lg:px-4 lg:py-2">
            {/* The screen's own title and one line of context, taken from the
                navigation so the menu and the page can never describe the same
                screen differently. */}
            <PageHeader
              title={navText(t, view).label}
              description={navText(t, view).hint}
            />
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- *
 * Sidebar pieces
 * -------------------------------------------------------------------- */

function SidebarNav({
  guild,
  view,
  collapsed,
  allowed,
  denyReason,
  hide,
  onView
}: {
  guild: Guild;
  view: ViewKey;
  collapsed: boolean;
  allowed: (item: NavItem) => boolean;
  denyReason: (item: NavItem) => string | null;
  /** Owner-only entries vanish from the list; guild gates stay disabled with a reason. */
  hide: (item: NavItem) => boolean;
  onView: (key: ViewKey) => void;
}) {
  const { t } = useI18n();
  // Which groups are open. Every group starts open so a first visit shows the
  // whole menu; the toggle is there to collapse the ones an operator does not
  // use, and the choice lives for the life of the mount.
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(navSections.map(section => [section.id, true]))
  );

  if (collapsed) {
    // The collapsed sidebar shows the same screens as icons, in the same order,
    // so it is the same product rather than a different one.
    return (
      <nav className="flex flex-col items-center gap-1 px-2 py-3">
        {navSections.flatMap(section => section.items).filter(item => !hide(item)).map(item => {
          const disabled = !allowed(item);
          const reason = denyReason(item);
          const label = navText(t, item.key).label;
          const button = (
            <button
              type="button"
              onClick={() => onView(item.key)}
              disabled={disabled}
              aria-current={view === item.key ? "page" : undefined}
              aria-label={label}
              className={cn(
                "relative grid size-9 place-items-center rounded-lg transition-ui",
                view === item.key
                  ? "bg-sidebar-primary/15 text-sidebar-primary"
                  : "text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                disabled && "cursor-not-allowed opacity-40 hover:bg-transparent"
              )}
            >
              <item.icon className="size-4" />
            </button>
          );
          if (!disabled || !reason) return <div key={item.key}>{button}</div>;
          return (
            <Tooltip key={item.key}>
              <TooltipTrigger asChild>
                <span>{button}</span>
              </TooltipTrigger>
              <TooltipContent side="right">{reason}</TooltipContent>
            </Tooltip>
          );
        })}
      </nav>
    );
  }

  return (
    <nav className="space-y-4 px-3 py-3">
      {navSections.map(section => {
        // Owner-only entries vanish outright — the sidebar must not advertise a
        // surface the caller cannot reach — while guild-level gates stay as
        // disabled rows that name their reason ("أضف AL AI أولاً"…).
        const items = section.items.filter(item => !hide(item));

        // A group left with nothing (the owner-only «النظام» for a non-owner)
        // advertises nothing: rendering its heading with zero entries would read
        // as a broken drawer rather than as "not for you".
        if (items.length === 0) return null;

        return (
          <Collapsible
            key={section.id}
            open={openSections[section.id] ?? true}
            onOpenChange={value => setOpenSections(current => ({ ...current, [section.id]: value }))}
          >
            {section.title ? (
              <CollapsibleTrigger asChild>
                <button
                  type="button"
                  className="group flex w-full items-center justify-between rounded-md px-3 py-2 text-mini font-semibold tracking-wide text-muted-foreground transition-ui hover:text-foreground"
                >
                  {t(section.title)}
                  <ChevronDown
                    className={cn(
                      "size-3.5 shrink-0 transition-transform",
                      (openSections[section.id] ?? true) && "rotate-180"
                    )}
                  />
                </button>
              </CollapsibleTrigger>
            ) : null}
            {/* One row per screen, grouped under a heading that opens and closes.
                The heading is a real toggle so a long menu can be folded down to
                the groups in use rather than scrolled past in full. */}
            <CollapsibleContent className="space-y-0.5 pt-1">
              {items.map(item => (
                <NavButton
                  key={item.key}
                  label={navText(t, item.key).label}
                  icon={item.icon}
                  active={view === item.key}
                  reachable={allowed(item)}
                  reason={denyReason(item)}
                  onClick={() => onView(item.key)}
                />
              ))}
            </CollapsibleContent>
          </Collapsible>
        );
      })}

      {!guild.botPresent ? (
        <p className="px-3 text-mini leading-relaxed text-muted-foreground">{t("nav.settingsAfterBot")}</p>
      ) : null}
    </nav>
  );
}

function NavButton({
  label,
  icon: Icon,
  active,
  reachable,
  reason,
  onClick
}: {
  label: string;
  icon: typeof LayoutDashboard;
  active: boolean;
  reachable: boolean;
  reason?: string | null;
  onClick: () => void;
}) {
  const disabled = !reachable;
  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-current={active ? "page" : undefined}
      className={cn(
        "group relative flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-start text-sm transition-ui",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent"
      )}
    >
      {/* The active marker is a bar on the reading edge, so the current screen
          is findable without reading the labels. */}
      <span
        aria-hidden="true"
        className={cn(
          "absolute inset-y-1.5 start-0 w-0.5 rounded-full bg-sidebar-primary transition-ui",
          active ? "opacity-100" : "opacity-0"
        )}
      />
      <Icon className="size-4 shrink-0" />
      <span className="min-w-0 flex-1 truncate">{label}</span>
    </button>
  );

  // A disabled item always explains itself rather than just refusing to respond.
  if (!disabled || !reason) return button;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span>{button}</span>
      </TooltipTrigger>
      <TooltipContent>{reason}</TooltipContent>
    </Tooltip>
  );
}

/* -------------------------------------------------------------------- *
 * Status
 * -------------------------------------------------------------------- */

/**
 * The three statuses, kept apart.
 *
 * The dashboard being open says nothing about the bot being connected to
 * Discord, and neither says anything about the database being reachable - so
 * they are three chips, each answering one question, and each read from the
 * health payload the server actually returns.
 */
function StatusChips({ health }: { health: HealthSnapshot | null }) {
  const { t } = useI18n();
  if (!health) {
    return (
      <Badge variant="secondary" className="hidden gap-1.5 sm:inline-flex">
        <Activity className="size-3" />
        …
      </Badge>
    );
  }

  const botConnected = health.bot === "connected";
  const databaseUp = health.database === "reachable";

  return (
    <div className="hidden items-center gap-1.5 md:flex">
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="h-6 gap-1.5 px-2 text-mini">
            <Activity className={cn("size-3", health.status === "healthy" ? "text-success" : "text-warning")} />
            {t("nav.statusDashboard")}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          {t("nav.statusDashboard")} {health.status === "healthy" ? t("nav.statusHealthy") : t("nav.statusDegraded")}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="h-6 gap-1.5 px-2 text-mini">
            <span className={cn("size-2 rounded-full", botConnected ? "bg-success" : "bg-muted-foreground/40")} />
            {t("nav.statusBot")}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          {t("nav.statusBot")}{" "}
          {botConnected
            ? t("nav.statusConnected")
            : health.bot === "configured"
              ? t("nav.statusConfigured")
              : t("nav.statusNotConfigured")}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="h-6 gap-1.5 px-2 text-mini">
            <Database className={cn("size-3", databaseUp ? "text-success" : "text-destructive")} />
            {t("nav.statusDatabase")}
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          {t("nav.statusDatabase")} {databaseUp ? t("nav.statusReachable") : t("nav.statusUnreachable")}
        </TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Header title for a view, taken from the navigation definition. */
export function viewTitle(view: ViewKey): string {
  return navIndex.get(view)?.label ?? "لوحة التحكم";
}
