/**
 * The account menu: who is signed in, and what they can do from here.
 *
 * It is a menu rather than a page because everything in it is an *action* on the
 * current account, not a document. Three rules shape it:
 *
 * 1. **Everything shown is real.** The avatar, the names and the id come from
 *    the session the server issued; the role comes from the selected guild's
 *    own verdict. Nothing here is a placeholder that would have to be
 *    replaced later, and an action that cannot work is not offered.
 * 2. **The three scopes stay apart.** Account (my Discord identity and my
 *    appearance), guild (this server's settings) and the deployment (the
 *    owner's surfaces) are separated by rules, because mixing them is how an
 *    operator ends up changing the whole deployment while thinking they are
 *    changing their own profile.
 * 3. **The platform owner's entries appear only for the platform owner.** The
 *    server re-checks every one of them; the menu simply does not advertise
 *    what the caller cannot reach.
 */
import { Check, Copy, ExternalLink, LogOut, Settings, ShieldCheck } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from "@/components/ui/dropdown-menu";
import { initials } from "@/lib/format";
import { useCopy } from "@/lib/use-copy";
import { cn } from "@/lib/utils";
import { tierLabels, type Guild, type SessionInfo } from "@/types";

export type AccountMenuProps = {
  user: SessionInfo["user"];
  guild: Guild;
  /** Opens the selected guild's own settings screen. */
  onOpenGuildSettings?: () => void;
  onLogout: () => void;
  /** The sidebar renders the trigger as a full row; the header renders a dot. */
  variant?: "row" | "compact";
  className?: string;
};

export function AccountMenu({
  user,
  guild,
  onOpenGuildSettings,
  onLogout,
  variant = "row",
  className
}: AccountMenuProps) {
  const { copied, copy } = useCopy();
  const isOwner = user?.isPlatformOwner === true;
  const role = guild.tier ? tierLabels[guild.tier] : "لا توجد رتبة في هذا السيرفر";

  const trigger =
    variant === "compact" ? (
      <button
        type="button"
        data-account-trigger="compact"
        className={cn(
          "flex size-9 items-center justify-center rounded-full transition-ui hover:bg-accent",
          className
        )}
        aria-label="حساب المستخدم"
      >
        <Avatar className="size-8">
          {user?.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
          <AvatarFallback>{initials(user?.username)}</AvatarFallback>
        </Avatar>
      </button>
    ) : (
      <button
        type="button"
        data-account-trigger="row"
        /* No `aria-label` here on purpose: the row's own text (the name and the
           role) *is* the accessible name, and a label that did not repeat it
           would hide the very information the operator is reading. */
        className={cn(
          "flex w-full items-center gap-2.5 rounded-md p-2 text-start transition-ui hover:bg-accent",
          className
        )}
      >
        <Avatar className="size-9">
          {user?.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
          <AvatarFallback>{initials(user?.username)}</AvatarFallback>
        </Avatar>
        <span className="min-w-0 flex-1 leading-tight">
          <span className="block truncate text-sm font-medium">{user?.username ?? "—"}</span>
          <span className="block truncate text-xs text-muted-foreground">{role}</span>
        </span>
      </button>
    );

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>{trigger}</DropdownMenuTrigger>
      <DropdownMenuContent align="start" side={variant === "row" ? "top" : "bottom"} className="w-64">
        {/* The identity, first and plainly: the avatar, the display name, the
            handle and the id a moderator is asked for in a support thread. */}
        <DropdownMenuLabel className="flex flex-col gap-2 p-2">
          <div className="flex items-center gap-2.5">
            <Avatar className="size-10">
              {user?.avatarUrl && <AvatarImage src={user.avatarUrl} alt="" />}
              <AvatarFallback>{initials(user?.username)}</AvatarFallback>
            </Avatar>
            <div className="min-w-0 leading-tight">
              <p className="truncate text-sm font-semibold">{user?.username ?? "—"}</p>
              <p className="truncate text-xs text-muted-foreground">{role}</p>
            </div>
          </div>
          {user?.handle ? (
            <p className="truncate text-xs text-muted-foreground" dir="ltr">
              @{user.handle}
            </p>
          ) : null}
          <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground" dir="ltr">
            <span className="truncate">{user?.id ?? "—"}</span>
            <button
              type="button"
              onClick={() => void copy(user?.id ?? "", "discord-id")}
              className="rounded p-0.5 transition-ui hover:bg-accent hover:text-accent-foreground"
              aria-label="نسخ معرّف Discord"
            >
              {copied === "discord-id" ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
            </button>
          </p>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />

        <DropdownMenuItem asChild>
          <a
            href={user?.id ? `https://discord.com/users/${user.id}` : "https://discord.com"}
            target="_blank"
            rel="noreferrer"
            className="gap-2"
          >
            <ExternalLink className="size-4" />
            فتح الحساب في Discord
          </a>
        </DropdownMenuItem>

        {onOpenGuildSettings ? (
          <DropdownMenuItem onSelect={onOpenGuildSettings} className="gap-2">
            <Settings className="size-4" />
            إعدادات هذا السيرفر
          </DropdownMenuItem>
        ) : null}

        {isOwner ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuLabel className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <ShieldCheck className="size-3.5" />
              مالك المنصة
            </DropdownMenuLabel>
          </>
        ) : null}

        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={onLogout} className="gap-2 text-destructive focus:text-destructive">
          <LogOut className="size-4" />
          تسجيل الخروج
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/**
 * The sign-out action, as a button rather than a menu item.
 *
 * The login screen has no shell and therefore no account menu, so it gets its
 * own control - and it is a real POST to the server's logout route, which is
 * what destroys the session and clears the cookie.
 */
export function SignOutButton({ onLogout }: { onLogout: () => void }) {
  return (
    <Button variant="ghost" size="sm" onClick={onLogout} className="gap-2">
      <LogOut className="size-4" />
      تسجيل الخروج
    </Button>
  );
}
