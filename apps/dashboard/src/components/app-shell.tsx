import type { ReactNode } from "react";
import { useEffect, useState } from "react";
import {
  Activity,
  Check,
  ChevronsUpDown,
  CirclePlus,
  Database,
  FileClock,
  Globe,
  LayoutDashboard,
  LayoutGrid,
  Link2,
  LogOut,
  Menu,
  MessageSquareHeart,
  PanelRightClose,
  PanelRightOpen,
  Palette,
  Radio,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  SquareTerminal,
  Trophy,
  UserCog,
  UserPlus
} from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AccountMenu } from "@/components/account-menu";
import { AppearanceMenu } from "@/components/appearance-menu";
import { PageHeader } from "@/components/page-header";
import { BrandMark } from "@/components/brand-mark";
import { initials } from "@/lib/format";
import { cn } from "@/lib/utils";
import { tierLabels, type Guild, type HealthSnapshot, type SessionInfo } from "@/types";

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
  | "network";

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
  "network"
] as const;

export function isViewKey(value: unknown): value is ViewKey {
  return typeof value === "string" && (viewKeys as readonly string[]).includes(value);
}

type NavItem = {
  key: ViewKey;
  label: string;
  /** One line of context: what the screen is *for*, in the operator's words. */
  hint: string;
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
 * what the server is doing now (الرئيسية), what you configure once (إدارة
 * السيرفر), what protects the server day to day (الإشراف والأوامر), what
 * happened in the past (السجلات), and the two instance-wide surfaces that
 * belong to the deployment's owner (النظام).
 *
 * Every screen the project actually has is here, once. A screen that exists
 * but is unreachable is a bug to fix, not a reason to hide it — and a screen
 * that does not exist must not be advertised.
 */
const navSections: { id: string; title: string | null; items: NavItem[] }[] = [
  {
    id: "home",
    title: null,
    items: [
      {
        key: "dashboard",
        label: "لوحة التحكم",
        hint: "نظرة عامة على حالة السيرفر",
        icon: LayoutDashboard
      }
    ]
  },
  {
    id: "server",
    title: "إدارة السيرفر",
    items: [
      {
        key: "roles",
        label: "رتب الإدارة والمشرفين",
        hint: "من يدير ومن يشرف",
        icon: UserCog,
        needs: "canManageTiers",
        requiresBot: true
      },
      {
        key: "welcome",
        label: "الرتبة التلقائية",
        hint: "رتبة الأعضاء والبوتات",
        icon: UserPlus,
        needs: "canManage",
        requiresBot: true
      },
      {
        key: "welcome-messages",
        label: "رسائل الترحيب",
        hint: "نص الترحيب والصورة والإيمبد",
        icon: MessageSquareHeart,
        needs: "canManage",
        requiresBot: true
      },
      {
        key: "customization",
        label: "هوية البوت",
        hint: "الاسم والصورة والبايو",
        icon: Palette,
        needs: "canManageIdentity",
        requiresBot: true
      },
      {
        key: "levels",
        label: "المستويات والخبرة",
        hint: "النقاط والمكافآت والرتب",
        icon: Trophy,
        needs: "canManage",
        requiresBot: true
      },
      {
        key: "invites",
        label: "الإحالات والدعوات",
        hint: "حالة الدعوات ولوحة النتائج",
        icon: Link2,
        needs: "canManage",
        requiresBot: true
      }
    ]
  },
  {
    id: "moderation",
    title: "الإشراف والأوامر",
    items: [
      {
        key: "commands",
        label: "الأوامر",
        hint: "أوامر الإشراف وإعداداتها",
        icon: SquareTerminal,
        needs: "canManageCommands",
        requiresBot: true
      },
      {
        key: "security",
        label: "الحماية والأمان",
        hint: "حدود الإشراف والحماية التلقائية",
        icon: ShieldAlert
      }
    ]
  },
  {
    id: "logs",
    title: "السجلات",
    items: [
      {
        key: "logs",
        label: "سجلات البوت",
        hint: "ما الذي فعّله البوت",
        icon: ScrollText,
        needs: "canManageLogging",
        requiresBot: true
      },
      {
        key: "audit",
        label: "سجل تدقيق اللوحة",
        hint: "ما الذي غيّره المشغّل",
        icon: FileClock
      }
    ]
  },
  {
    id: "system",
    title: "النظام",
    items: [
      // Both of these are instance-wide rather than per guild, and both are the
      // platform owner's. The server enforces OWNER_ID on every gated route, and
      // the sidebar hides what its caller cannot reach.
      //
      // «حالة البوت» belongs here and not under «إدارة السيرفر» for a reason
      // that is Discord's, not a preference: a status lives on the bot's gateway
      // connection, so it is one value for every server the bot is in. It was on
      // the identity screen, where everything else is scoped to one server — the
      // one control that reached everywhere on a form that promised it did not.
      {
        key: "presence",
        label: "حالة البوت",
        hint: "نشاط البوت على ديسكورد",
        icon: Radio,
        ownerOnly: true
      },
      // Instance-wide, not per guild: the reach of this deployment itself.
      {
        key: "network",
        label: "الوصول للشبكة",
        hint: "من يستطيع فتح اللوحة",
        icon: Globe,
        ownerOnly: true
      }
    ]
  }
];

/** Flat lookup used by the header title. */
const navIndex = new Map(navSections.flatMap(section => section.items).map(item => [item.key, item]));

type ShellProps = {
  guilds: Guild[];
  guild: Guild;
  selectedGuildId: string | null;
  onSelectGuild: (guildId: string) => void;
  /** Returns to the guild selector. */
  onBrowseAll: () => void;
  view: ViewKey;
  onView: (view: ViewKey) => void;
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
  health,
  user,
  refreshing,
  onRefresh,
  onLogout,
  children
}: ShellProps) {
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

  const inviteUrl = `/api/guilds/${guild.id}/invite`;

  const isOwner = user?.isPlatformOwner === true;
  const allowed = (item: NavItem) => {
    if (item.ownerOnly && !isOwner) return false;
    if (item.requiresBot && !guild.botPresent) return false;
    if (!item.needs) return true;
    return Boolean(guild[item.needs]);
  };

  const denyReason = (item: NavItem) => {
    if (item.ownerOnly && !isOwner) return "ميزات مالك المنصة فقط.";
    if (item.requiresBot && !guild.botPresent) return "أضف AL AI إلى هذا السيرفر أولاً.";
    if (!allowed(item)) return "رتبتك لا تسمح بهذا القسم.";
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

  /**
   * Where «إعدادات هذا السيرفر» goes.
   *
   * The server's settings are the group of screens in the sidebar, not one
   * page - so the account menu opens the first of them the caller may reach.
   * Anything else would either promise a page that does not exist or land the
   * operator on a screen they cannot use.
   */
  const openGuildSettings = () => {
    const first = navSections
      .find(section => section.id === "server")
      ?.items.find(item => allowed(item));
    if (first) onView(first.key);
  };

  return (
    /*
     * The frame is one viewport tall and does not scroll. `grid-rows-[minmax(0,1fr)]`
     * states the single row's height explicitly rather than relying on an `auto`
     * row stretching to fill — with `minmax(0,1fr)` the row can also be *smaller*
     * than its content, which is what lets the scroll areas inside it scroll
     * instead of pushing the frame taller.
     */
    <div
      className={cn(
        "grid h-full grid-cols-1 grid-rows-[minmax(0,1fr)] transition-ui",
        collapsed ? "lg:grid-cols-[4.75rem_1fr]" : "lg:grid-cols-[16.5rem_1fr]"
      )}
    >
      {/* ---------------------------------------------------------------- *
       * Sidebar (desktop)
       *
       * `overflow-hidden` + `min-h-0` keep it exactly as tall as the frame: the
       * nav scrolls inside the ScrollArea, and a long guild list can never
       * stretch the column and take the account menu off the bottom.
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
              <p className="truncate text-[11px] text-muted-foreground">إدارة ديسكورد</p>
            </div>
          ) : null}
        </div>
        <Separator />
        <GuildSwitcher
          guilds={guilds}
          guild={guild}
          selectedGuildId={selectedGuildId}
          onSelectGuild={onSelectGuild}
          onBrowseAll={onBrowseAll}
          inviteUrl={inviteUrl}
          collapsed={collapsed}
        />
        <ScrollArea className="min-h-0 flex-1">{nav(collapsed)}</ScrollArea>
        <Separator />
        <div className={cn("flex items-center gap-1 p-2", collapsed && "lg:flex-col lg:justify-center")}>
          <AppearanceMenu iconOnly />
          {collapsed ? (
            <AccountMenu user={user} guild={guild} onLogout={onLogout} variant="compact" />
          ) : (
            <AccountMenu
              user={user}
              guild={guild}
              onLogout={onLogout}
              onOpenGuildSettings={openGuildSettings}
              className="flex-1"
            />
          )}
        </div>
        <div className={cn("px-2 pb-2", collapsed && "lg:flex lg:justify-center")}>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => setCollapsed(value => !value)}
            aria-label={collapsed ? "توسيع القائمة" : "طيّ القائمة"}
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
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="القائمة">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72 p-0">
              <SheetHeader className="border-b border-border p-4">
                <SheetTitle className="flex items-center gap-2 text-sm">
                  <BrandMark className="size-6 text-primary" />
                  AL AI
                </SheetTitle>
              </SheetHeader>
              <ScrollArea className="h-[calc(100dvh-4rem)]">{nav(false)}</ScrollArea>
              <Separator />
              <div className="p-2">
                <AccountMenu
                  user={user}
                  guild={guild}
                  onLogout={onLogout}
                  onOpenGuildSettings={() => {
                    openGuildSettings();
                    setMobileOpen(false);
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
            <nav aria-label="مسار التنقل" className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <span className="truncate">{guild.name}</span>
              <span aria-hidden="true">/</span>
              <span className="truncate text-foreground">{navIndex.get(view)?.label ?? "لوحة التحكم"}</span>
            </nav>
          </div>

          <StatusChips health={health} />

          <Button
            variant="outline"
            size="sm"
            onClick={onRefresh}
            disabled={refreshing}
            loading={refreshing}
            aria-label="تحديث البيانات"
            className="gap-2"
          >
            <RefreshCw className={cn(refreshing && "animate-spin")} />
            <span className="hidden sm:inline">تحديث</span>
          </Button>

          {/* The account menu lives in the sidebar on the desktop; on a phone
              the sidebar is a drawer, so the header carries the account. */}
          <div className="lg:hidden">
            <AccountMenu user={user} guild={guild} onLogout={onLogout} variant="compact" />
          </div>
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
        <main className="min-h-0 min-w-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-24 lg:p-6">
          <div className="mx-auto w-full max-w-6xl px-1 py-2 lg:px-4 lg:py-3">
            {/* The screen's own title and one line of context, taken from the
                navigation so the menu and the page can never describe the same
                screen differently. */}
            <PageHeader
              title={navIndex.get(view)?.label ?? "لوحة التحكم"}
              description={navIndex.get(view)?.hint}
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

/**
 * Server picker. Every row shows the guild's real Discord icon and name, and the
 * invite action is pinned to the currently selected guild so the bot can never be
 * added somewhere the operator did not choose.
 */
function GuildSwitcher({
  guilds,
  guild,
  selectedGuildId,
  onSelectGuild,
  onBrowseAll,
  inviteUrl,
  collapsed
}: {
  guilds: Guild[];
  guild: Guild;
  selectedGuildId: string | null;
  onSelectGuild: (guildId: string) => void;
  onBrowseAll: () => void;
  inviteUrl: string;
  collapsed: boolean;
}) {
  if (collapsed) {
    return (
      <div className="flex justify-center p-2">
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              onClick={onBrowseAll}
              className="rounded-md p-1 transition-ui hover:bg-sidebar-accent"
              aria-label={guild.name}
            >
              <Avatar className="size-8 rounded-lg">
                {guild.iconUrl && <AvatarImage src={guild.iconUrl} alt="" />}
                <AvatarFallback className="rounded-lg text-[10px]">{initials(guild.name)}</AvatarFallback>
              </Avatar>
            </button>
          </TooltipTrigger>
          <TooltipContent side="right">{guild.name}</TooltipContent>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className="p-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="h-auto w-full justify-between gap-2 px-2.5 py-2" disabled={guilds.length === 0}>
            <span className="flex min-w-0 items-center gap-2">
              <Avatar className="size-7 rounded-lg">
                {guild.iconUrl && <AvatarImage src={guild.iconUrl} alt="" />}
                <AvatarFallback className="rounded-lg text-[10px]">{initials(guild.name)}</AvatarFallback>
              </Avatar>
              <span className="min-w-0">
                <span className="block truncate text-sm font-medium">{guild.name}</span>
                <span className="block truncate text-[11px] text-muted-foreground">السيرفر المحدد</span>
              </span>
            </span>
            <ChevronsUpDown className="size-4 shrink-0 opacity-60" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-64">
          {/* Only guilds the bot is in are switchable here: the others have
              nothing to show yet, and the selector is where they are invited. */}
          <DropdownMenuLabel>السيرفرات</DropdownMenuLabel>
          {guilds.map(item => (
            <DropdownMenuItem key={item.id} onSelect={() => onSelectGuild(item.id)} className="gap-2">
              <Avatar className="size-6 rounded-md">
                {item.iconUrl && <AvatarImage src={item.iconUrl} alt="" />}
                <AvatarFallback className="rounded-md text-[10px]">{initials(item.name)}</AvatarFallback>
              </Avatar>
              <span className="min-w-0 flex-1 truncate">{item.name}</span>
              {item.id === selectedGuildId && <Check className="size-3.5 text-muted-foreground" />}
            </DropdownMenuItem>
          ))}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onBrowseAll} className="gap-2">
            <LayoutGrid className="size-4" />
            كل السيرفرات
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={inviteUrl} className="gap-2">
              <CirclePlus className="size-4" />
              إضافة AL AI إلى هذا السيرفر
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

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
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({
    server: true,
    moderation: true,
    logs: true,
    system: true
  });

  if (collapsed) {
    // The rail shows the same screens as icons, in the same order, so the
    // collapsed layout is the same product rather than a different one.
    return (
      <nav className="flex flex-col items-center gap-1 px-2 py-3">
        {navSections.flatMap(section => section.items).filter(item => !hide(item)).map(item => {
          const disabled = !allowed(item);
          const reason = denyReason(item);
          const button = (
            <button
              type="button"
              onClick={() => onView(item.key)}
              disabled={disabled}
              aria-current={view === item.key ? "page" : undefined}
              aria-label={item.label}
              className={cn(
                "grid size-9 place-items-center rounded-lg transition-ui",
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
    <nav className="space-y-1 px-3 py-3">
      {navSections.map(section => {
        // Owner-only entries vanish outright — the sidebar must not advertise a
        // surface the caller cannot reach — while guild-level gates stay as
        // disabled buttons that name their reason ("أضف AL AI أولاً"…).
        const items = section.items
          .filter(item => !hide(item))
          .map(item => (
            <NavButton
              key={item.key}
              label={item.label}
              hint={item.hint}
              icon={item.icon}
              active={view === item.key}
              disabled={!allowed(item)}
              reason={denyReason(item)}
              onClick={() => onView(item.key)}
            />
          ));

        // The first section has no heading and is always visible.
        if (!section.title) return <div key={section.id} className="space-y-1">{items}</div>;

        // A titled section left with nothing (the owner-only «النظام» for a
        // non-owner) advertises nothing: rendering its heading with zero
        // entries would read as a broken drawer rather than as "not for you".
        if (items.length === 0) return null;

        const open = openSections[section.id] ?? true;
        return (
          <Collapsible
            key={section.id}
            open={open}
            onOpenChange={value => setOpenSections(current => ({ ...current, [section.id]: value }))}
          >
            <CollapsibleTrigger asChild>
              <button className="flex w-full items-center justify-between rounded-md px-3 py-2 text-[11px] font-semibold tracking-wide text-muted-foreground transition-ui hover:text-foreground">
                {section.title}
                <ChevronsUpDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-0.5 pt-1">{items}</CollapsibleContent>
          </Collapsible>
        );
      })}

      {!guild.botPresent ? (
        <p className="px-3 pt-3 text-[11px] leading-relaxed text-muted-foreground">
          أقسام الإعدادات تُفتح بعد إضافة AL AI إلى السيرفر.
        </p>
      ) : null}
    </nav>
  );
}

function NavButton({
  label,
  hint,
  icon: Icon,
  active,
  disabled,
  reason,
  onClick
}: {
  label: string;
  hint: string;
  icon: typeof LayoutDashboard;
  active: boolean;
  disabled?: boolean;
  reason?: string | null;
  onClick: () => void;
}) {
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
          <Badge variant="outline" className="h-6 gap-1.5 px-2 text-[11px]">
            <Activity className={cn("size-3", health.status === "healthy" ? "text-success" : "text-warning")} />
            اللوحة
          </Badge>
        </TooltipTrigger>
        <TooltipContent>لوحة التحكم {health.status === "healthy" ? "تعمل" : "متعثرة"}</TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="h-6 gap-1.5 px-2 text-[11px]">
            <span className={cn("size-2 rounded-full", botConnected ? "bg-success" : "bg-muted-foreground/40")} />
            البوت
          </Badge>
        </TooltipTrigger>
        <TooltipContent>
          البوت {botConnected ? "متصل بديسكورد" : health.bot === "configured" ? "مهيأ لكنه غير متصل" : "غير مهيأ"}
        </TooltipContent>
      </Tooltip>
      <Tooltip>
        <TooltipTrigger asChild>
          <Badge variant="outline" className="h-6 gap-1.5 px-2 text-[11px]">
            <Database className={cn("size-3", databaseUp ? "text-success" : "text-destructive")} />
            قاعدة البيانات
          </Badge>
        </TooltipTrigger>
        <TooltipContent>قاعدة البيانات {databaseUp ? "متاحة" : "غير متاحة"}</TooltipContent>
      </Tooltip>
    </div>
  );
}

/** Header title for a view, taken from the navigation definition. */
export function viewTitle(view: ViewKey): string {
  return navIndex.get(view)?.label ?? "لوحة التحكم";
}
