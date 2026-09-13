import type { ReactNode } from "react";
import { useState } from "react";
import {
  Activity,
  Bot,
  Check,
  ChevronsUpDown,
  CirclePlus,
  Copy,
  EllipsisVertical,
  ExternalLink,
  FileClock,
  LayoutDashboard,
  LayoutGrid,
  LogOut,
  Menu,
  Palette,
  RefreshCw,
  ScrollText,
  ShieldAlert,
  SquareTerminal,
  UserCog
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
import { initials } from "@/lib/format";
import { useCopy } from "@/lib/use-copy";
import { cn } from "@/lib/utils";
import { tierLabels, type Guild, type HealthSnapshot, type SessionInfo } from "@/types";

/**
 * The application frame: sidebar, header and the slot the active view renders
 * into. It owns navigation and identity only — no view-specific state lives here.
 */

export type ViewKey = "dashboard" | "commands" | "customization" | "roles" | "logs" | "audit" | "security";

/**
 * Every view key, in one place.
 *
 * The router accepts a view straight from the address bar, so it needs a way to
 * tell a real screen from a typo. Deriving the list from the navigation below
 * would be circular — the navigation needs the type, and this needs the values —
 * so the values are stated once here and a test asserts they match the nav.
 */
export const viewKeys: readonly ViewKey[] = [
  "dashboard",
  "commands",
  "customization",
  "roles",
  "logs",
  "audit",
  "security"
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
};

/**
 * Navigation is data, not markup, so adding a screen means adding one entry.
 *
 * The four sections mirror the operator's mental model rather than the code
 * layout: what the server is doing now (Overview), what you configure once
 * (General Settings), what protects the server day to day (Moderation &
 * Protection), and what happened in the past (Logs & Monitoring).
 */
const navSections: { id: string; title: string | null; items: NavItem[] }[] = [
  {
    id: "overview",
    title: null,
    items: [{ key: "dashboard", label: "لوحة التحكم", icon: LayoutDashboard }]
  },
  {
    id: "general",
    title: "الإعدادات العامة",
    items: [
      { key: "roles", label: "رتب الإدارة والمشرفين", icon: UserCog, needs: "canManageTiers", requiresBot: true },
      { key: "customization", label: "هوية البوت بالسيرفر", icon: Palette, needs: "canManageIdentity", requiresBot: true }
    ]
  },
  {
    id: "moderation",
    title: "الإشراف والحماية",
    items: [
      { key: "commands", label: "أوامر المشرفين", icon: SquareTerminal, needs: "canManageCommands", requiresBot: true },
      { key: "security", label: "الحماية والأمان", icon: ShieldAlert }
    ]
  },
  {
    id: "monitoring",
    title: "السجلات والمراقبة",
    items: [
      { key: "logs", label: "سجلات السيرفر", icon: ScrollText, needs: "canManageLogging", requiresBot: true },
      { key: "audit", label: "سجل تدقيق اللوحة", icon: FileClock }
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
  const { copied, copy } = useCopy();

  const inviteUrl = `/api/guilds/${guild.id}/invite`;

  const allowed = (item: NavItem) => {
    if (item.requiresBot && !guild.botPresent) return false;
    if (!item.needs) return true;
    return Boolean(guild[item.needs]);
  };

  const denyReason = (item: NavItem) => {
    if (item.requiresBot && !guild.botPresent) return "أضف AL AI إلى هذا السيرفر أولاً.";
    if (!allowed(item)) return "رتبتك لا تسمح بهذا القسم.";
    return null;
  };

  const nav = (
    <SidebarNav
      guild={guild}
      view={view}
      allowed={allowed}
      denyReason={denyReason}
      onView={key => {
        onView(key);
        setMobileOpen(false);
      }}
    />
  );

  return (
    <div className="grid min-h-dvh grid-cols-1 lg:grid-cols-[17rem_1fr]">
      {/* ---------------------------------------------------------------- *
       * Sidebar (desktop)
       * ---------------------------------------------------------------- */}
      <aside className="hidden border-e border-sidebar-border bg-sidebar lg:flex lg:flex-col">
        <Brand />
        <Separator />
        <GuildSwitcher
          guilds={guilds}
          guild={guild}
          selectedGuildId={selectedGuildId}
          onSelectGuild={onSelectGuild}
          onBrowseAll={onBrowseAll}
          inviteUrl={inviteUrl}
        />
        <ScrollArea className="flex-1">{nav}</ScrollArea>
        <Separator />
        <ProfileMenu user={user} guild={guild} onLogout={onLogout} />
      </aside>

      {/* ---------------------------------------------------------------- *
       * Content
       * ---------------------------------------------------------------- */}
      <div className="flex min-w-0 flex-col">
        <header className="sticky top-0 z-30 flex h-14 items-center gap-2 border-b border-border bg-background/85 px-3 backdrop-blur lg:px-4">
          {/* Mobile navigation: the sidebar is desktop-only. */}
          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="lg:hidden" aria-label="القائمة">
                <Menu />
              </Button>
            </SheetTrigger>
            <SheetContent side="right" className="w-72 p-0">
              <SheetHeader className="border-b border-border p-4">
                <SheetTitle className="text-sm">AL AI</SheetTitle>
              </SheetHeader>
              <ScrollArea className="h-[calc(100dvh-4rem)]">{nav}</ScrollArea>
            </SheetContent>
          </Sheet>

          <div className="flex min-w-0 flex-1 items-center gap-2">
            <h1 className="truncate text-sm font-semibold">{viewTitle(view)}</h1>
            <Badge variant="outline" className="hidden shrink-0 gap-1 text-[10px] sm:inline-flex">
              <Avatar className="size-3.5 rounded-sm">
                {guild.iconUrl && <AvatarImage src={guild.iconUrl} alt="" />}
                <AvatarFallback className="rounded-sm text-[6px]">{initials(guild.name)}</AvatarFallback>
              </Avatar>
              <span className="max-w-32 truncate">{guild.name}</span>
            </Badge>
          </div>

          <StatusBadge health={health} />

          <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
            <RefreshCw className={cn(refreshing && "animate-spin")} />
            <span className="hidden sm:inline">تحديث</span>
          </Button>

          <HeaderMenu
            guild={guild}
            inviteUrl={inviteUrl}
            refreshing={refreshing}
            copied={copied}
            onRefresh={onRefresh}
            onCopy={copy}
            onLogout={onLogout}
          />
        </header>

        <main className="min-w-0 flex-1 p-4 pb-24 lg:p-6">{children}</main>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------- *
 * Sidebar pieces
 * -------------------------------------------------------------------- */

function Brand() {
  return (
    <div className="flex items-center gap-2.5 px-4 py-4">
      <div className="grid size-9 place-items-center rounded-xl bg-primary text-primary-foreground">
        <Bot className="size-5" />
      </div>
      <div className="leading-tight">
        <p className="text-sm font-semibold">AL AI</p>
        <p className="text-xs text-muted-foreground">Discord Management</p>
      </div>
    </div>
  );
}

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
  inviteUrl
}: {
  guilds: Guild[];
  guild: Guild;
  selectedGuildId: string | null;
  onSelectGuild: (guildId: string) => void;
  onBrowseAll: () => void;
  inviteUrl: string;
}) {
  return (
    <div className="p-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" className="w-full justify-between px-2.5" disabled={guilds.length === 0}>
            <span className="flex min-w-0 items-center gap-2">
              <Avatar className="size-6 rounded-md">
                {guild.iconUrl && <AvatarImage src={guild.iconUrl} alt="" />}
                <AvatarFallback className="rounded-md text-[10px]">{initials(guild.name)}</AvatarFallback>
              </Avatar>
              <span className="truncate text-sm">{guild.name}</span>
            </span>
            <ChevronsUpDown className="size-4 opacity-60" />
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
  allowed,
  denyReason,
  onView
}: {
  guild: Guild;
  view: ViewKey;
  allowed: (item: NavItem) => boolean;
  denyReason: (item: NavItem) => string | null;
  onView: (key: ViewKey) => void;
}) {
  const [openSections, setOpenSections] = useState<Record<string, boolean>>({ general: true, moderation: true, monitoring: true });

  return (
    <nav className="space-y-3 px-3 pb-4">
      {navSections.map(section => {
        const items = section.items.map(item => (
          <NavButton
            key={item.key}
            label={item.label}
            icon={item.icon}
            active={view === item.key}
            disabled={!allowed(item)}
            reason={denyReason(item)}
            onClick={() => onView(item.key)}
          />
        ));

        // The first section has no heading and is always visible.
        if (!section.title) return <div key={section.id} className="space-y-1">{items}</div>;

        const open = openSections[section.id] ?? true;
        return (
          <Collapsible
            key={section.id}
            open={open}
            onOpenChange={value => setOpenSections(current => ({ ...current, [section.id]: value }))}
          >
            <CollapsibleTrigger asChild>
              <button className="flex w-full items-center justify-between rounded-md px-3 py-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground transition-colors hover:text-foreground">
                {section.title}
                <ChevronsUpDown className={cn("size-3.5 transition-transform", open && "rotate-180")} />
              </button>
            </CollapsibleTrigger>
            <CollapsibleContent className="space-y-1 pt-1">{items}</CollapsibleContent>
          </Collapsible>
        );
      })}

      {!guild.botPresent && (
        <p className="px-3 pt-2 text-[11px] leading-relaxed text-muted-foreground">
          أقسام الإعدادات تُفتح بعد إضافة AL AI إلى السيرفر.
        </p>
      )}
    </nav>
  );
}

function NavButton({
  label,
  icon: Icon,
  active,
  disabled,
  reason,
  onClick
}: {
  label: string;
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
        "flex w-full items-center gap-2.5 rounded-md px-3 py-2 text-sm transition-colors",
        "hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        active && "bg-sidebar-accent font-medium text-sidebar-accent-foreground",
        disabled && "cursor-not-allowed opacity-40 hover:bg-transparent"
      )}
    >
      <Icon className="size-4 shrink-0" />
      <span className="truncate">{label}</span>
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

/**
 * The signed-in operator: real Discord avatar, display name and their tier in the
 * selected guild. Clicking the row opens the account menu.
 */
function ProfileMenu({ user, guild, onLogout }: { user: SessionInfo["user"]; guild: Guild; onLogout: () => void }) {
  const { copied, copy } = useCopy();

  return (
    <div className="p-3">
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex w-full items-center gap-2 rounded-md p-1.5 text-start transition-colors hover:bg-sidebar-accent">
            <Avatar className="size-8">
              {user?.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
              <AvatarFallback>{initials(user?.username)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 flex-1 leading-tight">
              <p className="truncate text-sm">{user?.username ?? "—"}</p>
              <p className="text-xs text-muted-foreground">{guild.tier ? tierLabels[guild.tier] : "لا توجد رتبة"}</p>
            </div>
            <ChevronsUpDown className="size-4 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" side="top" className="w-60">
          <DropdownMenuLabel className="flex flex-col gap-0.5">
            <span className="truncate">{user?.username ?? "—"}</span>
            <span className="text-xs font-normal text-muted-foreground" dir="ltr">
              {user?.id ?? "—"}
            </span>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void copy(user?.id ?? "", "owner-id")} className="gap-2">
            {copied === "owner-id" ? <Check className="size-4" /> : <Copy className="size-4" />}
            نسخ معرّف Discord
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={`https://discord.com/users/${user?.id ?? ""}`} target="_blank" rel="noreferrer" className="gap-2">
              <ExternalLink className="size-4" />
              فتح الحساب في Discord
            </a>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={onLogout} className="gap-2">
            <LogOut className="size-4" />
            تسجيل الخروج
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

/**
 * The header's overflow menu. Every entry performs a real action — nothing here
 * is decorative.
 */
function HeaderMenu({
  guild,
  inviteUrl,
  refreshing,
  copied,
  onRefresh,
  onCopy,
  onLogout
}: {
  guild: Guild;
  inviteUrl: string;
  refreshing: boolean;
  copied: string | null;
  onRefresh: () => void;
  onCopy: (value: string, key?: string) => Promise<boolean>;
  onLogout: () => void;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" size="icon" aria-label="خيارات">
          <EllipsisVertical />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-60">
        <DropdownMenuLabel className="truncate">{guild.name}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onRefresh} disabled={refreshing} className="gap-2">
          <RefreshCw className={cn(refreshing && "animate-spin")} />
          تحديث البيانات
        </DropdownMenuItem>
        <DropdownMenuItem onSelect={() => void onCopy(guild.id, "guild-id")} className="gap-2">
          {copied === "guild-id" ? <Check className="size-4" /> : <Copy className="size-4" />}
          نسخ معرّف السيرفر
        </DropdownMenuItem>
        <DropdownMenuItem asChild>
          <a href={`https://discord.com/channels/${guild.id}`} target="_blank" rel="noreferrer" className="gap-2">
            <ExternalLink className="size-4" />
            فتح السيرفر في Discord
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem asChild>
          <a href={inviteUrl} className="gap-2">
            <CirclePlus className="size-4" />
            {guild.botPresent ? "إعادة إضافة البوت" : "إضافة البوت"}
          </a>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onLogout} className="gap-2">
          <LogOut className="size-4" />
          تسجيل الخروج
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/* -------------------------------------------------------------------- *
 * Status
 * -------------------------------------------------------------------- */

function StatusBadge({ health }: { health: HealthSnapshot | null }) {
  if (!health) return <Badge variant="secondary">…</Badge>;
  const healthy = health.status === "healthy" && health.bot === "connected";
  const label = healthy ? "متصل" : health.database === "unreachable" ? "قاعدة البيانات" : "محدود";
  return (
    <Badge variant={healthy ? "secondary" : "destructive"} className="gap-1.5">
      <Activity className="size-3" />
      {label}
    </Badge>
  );
}

/** Header title for a view, taken from the navigation definition. */
export function viewTitle(view: ViewKey): string {
  return navIndex.get(view)?.label ?? "لوحة التحكم";
}
