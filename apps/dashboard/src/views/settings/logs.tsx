import { useEffect, useMemo, useState } from "react";
import { isCategoryEnabled, isEventEnabled } from "@al-ai/core/browser";
import { AnimatePresence, motion } from "framer-motion";
import {
  AlertCircle,
  AlertTriangle,
  ArrowDown,
  ArrowRightLeft,
  ArrowUp,
  AtSign,
  AudioLines,
  Ban,
  Bell,
  Bot,
  BotOff,
  Brush,
  CalendarCheck,
  CalendarClock,
  CalendarDays,
  CalendarPlus,
  CalendarX,
  CheckCircle2,
  ChevronsDown,
  ChevronsUp,
  CircleUserRound,
  Clock,
  Delete,
  DoorClosed,
  DoorOpen,
  Ear,
  EarOff,
  Eraser,
  FileX2,
  Frown,
  Gem,
  Hand,
  Hash,
  HeadphoneOff,
  Headphones,
  Hourglass,
  Image,
  ImageOff,
  KeyRound,
  LayoutGrid,
  Link,
  Lock,
  LockOpen,
  LogIn,
  LogOut,
  MailPlus,
  Megaphone,
  Medal,
  Mic,
  Mic2,
  MicOff,
  MessageSquare,
  MessageSquareMore,
  MessageSquareX,
  MessagesSquare,
  Moon,
  PartyPopper,
  PenLine,
  Pencil,
  PhoneOff,
  Pin,
  PinOff,
  Plug,
  Presentation,
  Radio,
  RadioOff,
  Repeat,
  Rocket,
  ScrollText,
  Search,
  Send,
  Settings,
  Shield,
  ShieldAlert,
  ShieldCheck,
  ShieldPlus,
  ShieldX,
  Smile,
  SmilePlus,
  Sparkles,
  SquarePen,
  Sticker,
  Tag,
  Target,
  Timer,
  TimerReset,
  Trash2,
  Type,
  UserCheck,
  UserMinus,
  UserPlus,
  Users,
  UserX,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  Webhook,
  Wrench,
  ZapOff,
  type LucideIcon
} from "lucide-react";
import { api } from "@/api";
import { setOrDeleteKey } from "@/lib/records";
import { useDraftForm } from "@/lib/use-draft-form";
import { ColorPicker } from "@/components/color-picker";
import { RoleSwatch } from "@/components/role-swatch";
import { LoadError, LoadingRow } from "@/components/view-states";
import { SaveBar } from "@/components/save-bar";
import { Toaster, useToasts } from "@/components/toaster";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Switch } from "@/components/ui/switch";
import {
  logCategories,
  type ChannelOption,
  type DiscordRole,
  type Guild,
  type LogCategory,
  type LogDestination,
  type LoggingSettings
} from "@/types";

/** The picker value that means "this record has no channel of its own". */
const INHERIT = "__inherit__";
/** The sidebar entry that is not a section. */
const GENERAL = "__general__";
type Selection = typeof GENERAL | LogDestination;
type Filter = "all" | "enabled" | "disabled";
/** Which of the two long-running channel actions is in flight, if any. */
type ChannelAction = "setup-normal" | "setup-detailed" | "teardown";

/** How long the channel buttons rest after any one of them runs — Discord's
 * creation bucket refills slowly, and a badge counting down beats a disabled
 * button the operator has to guess about. */
const CHANNEL_ACTION_COOLDOWN_MS = 60_000;

/**
 * The icon each section wears in the sidebar and its own header. `bot-log` is
 * included because the type is the full destination union, but it never renders:
 * the operator's sidebar is built from `logCategories`, which excludes the
 * internal destination.
 */
const sectionIcons: Record<LogDestination, LucideIcon> = {
  "member-log": Users,
  "role-log": Medal,
  "channel-log": Hash,
  "message-log": MessagesSquare,
  "voice-log": AudioLines,
  "moderation-log": ShieldAlert,
  "server-log": Settings,
  "invite-log": Send,
  "expression-log": Sparkles,
  "event-log": CalendarDays,
  "integration-log": Plug,
  "automod-log": ShieldCheck,
  "platform-log": Megaphone,
  "bot-log": Bot
};

/**
 * One glance at a record has to tell the operator what it is, not just what it
 * is called. The icon sits beside the name; a record without an entry falls back
 * to the generic glyph rather than rendering nothing.
 */
export const eventIcons: Record<string, LucideIcon> = {
  /* member-log */
  "member.join": ArrowUp,
  "member.leave": ArrowDown,
  "member.nickname-change": Pencil,
  "member.username-change": AtSign,
  "member.avatar-change": CircleUserRound,
  "member.boost-add": Rocket,
  "member.boost-remove": ZapOff,
  "member.suspicious-account": ShieldAlert,
  "moderation.ban": Lock,
  "moderation.unban": LockOpen,
  "moderation.kick": LogOut,
  "moderation.timeout": Clock,
  "moderation.untimeout": TimerReset,
  "moderation.mute": MessageSquareX,
  "moderation.unmute": MessageSquare,
  "moderation.prison": DoorClosed,
  "moderation.unprison": DoorOpen,
  "moderation.remove": FileX2,

  /* role-log */
  "role.create": Tag,
  "role.update": PenLine,
  "role.delete": Trash2,
  "role.managed-change": Wrench,
  "member.role-add": UserPlus,
  "member.role-remove": UserMinus,

  /* channel-log */
  "server.channel-create": Hash,
  "server.channel-update": Settings,
  "server.channel-delete": Trash2,
  "channel.permission-update": KeyRound,
  "thread.create": MessagesSquare,
  "thread.update": MessageSquareMore,
  "thread.delete": FileX2,

  /* message-log */
  "message.delete": Trash2,
  "message.edit": PenLine,
  "message.bulk-delete": Delete,
  "message.delete-attachment": ImageOff,
  "message.pin": Pin,
  "message.unpin": PinOff,
  "message.reaction-add": SmilePlus,
  "message.reaction-remove": Frown,
  "message.reaction-clear": Eraser,

  /* voice-log */
  "voice.join": LogIn,
  "voice.leave": LogOut,
  "voice.move": ArrowRightLeft,
  "voice.self-move": Repeat,
  "voice.disconnect": PhoneOff,
  "voice.server-mute": MicOff,
  "voice.server-unmute": Mic,
  "voice.server-deafen": HeadphoneOff,
  "voice.server-undeafen": Headphones,
  "voice.self-mute": VolumeX,
  "voice.self-unmute": Volume2,
  "voice.self-deafen": EarOff,
  "voice.self-undeafen": Ear,
  "voice.stream-start": Radio,
  "voice.stream-end": RadioOff,
  "voice.camera-on": Video,
  "voice.camera-off": VideoOff,

  /* moderation-log */
  "moderation.warn": AlertTriangle,
  "moderation.delwarn": AlertCircle,
  "moderation.clearwarns": Brush,
  "moderation.block": UserX,
  "moderation.blacklist": Ban,
  "moderation.unblacklist": CheckCircle2,

  /* server-log */
  "server.settings-change": Settings,
  "server.name-change": Type,
  "server.icon-change": Image,
  "server.banner-change": Image,
  "server.vanity-url-change": Link,
  "server.boost-tier-up": ChevronsUp,
  "server.boost-tier-down": ChevronsDown,

  /* invite-log */
  "server.invite-create": MailPlus,
  "invite.delete": Trash2,
  "invite.use": LogIn,

  /* expression-log */
  "server.expression-create": Smile,
  "server.expression-delete": ImageOff,
  "emoji.update": PenLine,
  "sticker.create": Sticker,
  "sticker.update": SquarePen,
  "sticker.delete": FileX2,

  /* event-log */
  "scheduled-event.create": CalendarPlus,
  "scheduled-event.delete": CalendarX,
  "scheduled-event.update": CalendarDays,
  "scheduled-event.start": CalendarCheck,
  "scheduled-event.complete": PartyPopper,
  "scheduled-event.user-add": UserCheck,
  "scheduled-event.user-remove": UserX,

  /* integration-log */
  "integration.update": Plug,
  "webhook.create": Webhook,
  "webhook.delete": Trash2,
  "webhook.update": PenLine,
  "bot.join": Bot,
  "bot.leave": BotOff,
  "bot.role-create": Tag,
  "bot.role-remove": UserMinus,

  /* automod-log */
  "automod.rule-create": ShieldPlus,
  "automod.rule-delete": ShieldX,
  "automod.rule-update": Shield,
  "automod.alert": Bell,
  "automod.block-message": MessageSquareX,
  "automod.timeout": Timer,
  "automod.member-block": Ban,

  /* platform-log */
  "stage.create": Presentation,
  "stage.delete": Trash2,
  "stage.update": Settings,
  "stage.speaker": Mic2,
  "stage.suppress": MicOff,
  "stage.request-speak": Hand
};

/**
 * One line under the name naming the moment the record fires — the difference
 * between a toggle the operator has to memorise and one they can read. A record
 * without an entry simply renders no line.
 */
export const eventHints: Record<string, string> = {
  /* member-log */
  "member.join": "عند انضمام عضو جديد للسيرفر.",
  "member.leave": "عند مغادرة عضو للسيرفر.",
  "member.nickname-change": "عند تغيير اللقب.",
  "member.username-change": "عند تغيير اليوزرنيم.",
  "member.avatar-change": "عند تغيير صورة البروفايل.",
  "member.boost-add": "عند بوست السيرفر.",
  "member.boost-remove": "عند إزالة البوست.",
  "member.suspicious-account": "عند إسناد رتبة لحساب جديد بسبب عمر الحساب.",
  "moderation.ban": "عند حظر عضو من السيرفر.",
  "moderation.unban": "عند فك حظر عضو.",
  "moderation.kick": "عند طرد عضو من السيرفر.",
  "moderation.prison": "عند سجن عضو.",
  "moderation.unprison": "عند إخراج عضو من السجن.",
  "moderation.timeout": "عند عزل عضو Timeout.",
  "moderation.untimeout": "عند إزالة العزل عن عضو.",
  "moderation.mute": "عند إعطاء ميوت كتابي لعضو.",
  "moderation.unmute": "عند إلغاء الميوت الكتابي.",
  "moderation.remove": "عند حذف عقوبة من سجل عضو عبر أمر remove.",

  /* role-log */
  "role.create": "عند إنشاء رتبة جديدة.",
  "role.delete": "عند حذف رتبة.",
  "role.update": "عند تعديل رتبة.",
  "member.role-add": "عند إعطاء رتبة لعضو.",
  "member.role-remove": "عند إزالة رتبة من عضو.",
  "role.managed-change": "تعديل/حذف رتبة خاصة، نفس أمر rlog.",

  /* channel-log */
  "server.channel-create": "عند إنشاء قناة جديدة.",
  "server.channel-delete": "عند حذف قناة.",
  "server.channel-update": "عند تعديل إعدادات قناة.",
  "channel.permission-update": "عند تعديل صلاحيات قناة.",
  "thread.create": "عند إنشاء ثريد جديد.",
  "thread.delete": "عند حذف ثريد.",
  "thread.update": "عند تعديل ثريد.",

  /* message-log */
  "message.delete": "عند حذف رسالة.",
  "message.delete-attachment": "عند حذف رسالة تحتوي على صورة.",
  "message.edit": "عند تعديل رسالة.",
  "message.bulk-delete": "عند حذف عدة رسائل.",
  "message.pin": "عند تثبيت رسالة.",
  "message.unpin": "عند إلغاء تثبيت رسالة.",
  "message.reaction-add": "عند إضافة تفاعل على رسالة.",
  "message.reaction-remove": "عند إزالة تفاعل من رسالة.",
  "message.reaction-clear": "عند مسح جميع التفاعلات.",

  /* voice-log */
  "voice.join": "عند دخول عضو إلى روم صوتي.",
  "voice.leave": "عند خروج عضو من روم صوتي.",
  "voice.move": "سحب/نقل عضو من قبل مشرف.",
  "voice.self-move": "تبديل العضو بنفسه بين الرومات.",
  "voice.disconnect": "فصل عضو بواسطة مشرف.",
  "voice.server-mute": "كتم عضو Server Mute.",
  "voice.server-unmute": "عند إلغاء كتم عضو.",
  "voice.server-deafen": "إصمات عضو Server Deafen.",
  "voice.server-undeafen": "عند إلغاء إصمات عضو.",
  "voice.self-mute": "تفعيل العضو سيلف ميوت.",
  "voice.self-unmute": "عند إلغاء السيلف ميوت.",
  "voice.self-deafen": "تفعيل العضو سيلف ديفن.",
  "voice.self-undeafen": "عند إلغاء السيلف ديفن.",
  "voice.stream-start": "عند بدء بث مباشر.",
  "voice.stream-end": "عند إنهاء البث.",
  "voice.camera-on": "عند تشغيل الكاميرا.",
  "voice.camera-off": "عند إيقاف الكاميرا.",

  /* moderation-log */
  "moderation.warn": "عند إعطاء عضو تحذيراً.",
  "moderation.delwarn": "عند إزالة تحذير واحد من عضو.",
  "moderation.clearwarns": "عند مسح جميع تحذيرات عضو أو السيرفر.",
  "moderation.block": "عند إعطاء عضو بلوك على رتبة.",
  "moderation.blacklist": "عند إضافة عضو إلى البلاك لست.",
  "moderation.unblacklist": "عند إزالة عضو من البلاك لست.",

  /* server-log */
  "server.settings-change": "عند تعديل إعدادات السيرفر.",
  "server.name-change": "عند تغيير اسم السيرفر.",
  "server.icon-change": "عند تغيير أيقونة السيرفر.",
  "server.banner-change": "عند تغيير بانر السيرفر.",
  "server.vanity-url-change": "عند تغيير رابط الدعوة المخصص.",
  "server.boost-tier-up": "عند رفع مستوى البوست درجة.",
  "server.boost-tier-down": "عند انخفاض مستوى البوست درجة.",

  /* invite-log */
  "server.invite-create": "عند إنشاء رابط دعوة.",
  "invite.delete": "عند حذف رابط دعوة.",
  "invite.use": "عند استخدام رابط دعوة للانضمام.",

  /* expression-log */
  "server.expression-create": "عند إضافة إيموجي للسيرفر.",
  "server.expression-delete": "عند حذف إيموجي.",
  "emoji.update": "عند تعديل إيموجي.",
  "sticker.create": "عند إضافة ستيكر.",
  "sticker.delete": "عند حذف ستيكر.",
  "sticker.update": "عند تعديل ستيكر.",

  /* event-log */
  "scheduled-event.create": "عند إنشاء حدث مجدول.",
  "scheduled-event.delete": "عند حذف حدث.",
  "scheduled-event.update": "عند تعديل حدث.",
  "scheduled-event.start": "عند بدء حدث.",
  "scheduled-event.complete": "عند انتهاء حدث.",
  "scheduled-event.user-add": "عند اشتراك عضو في حدث.",
  "scheduled-event.user-remove": "عند إلغاء اشتراك عضو.",

  /* integration-log */
  "integration.update": "عند تعديل تكامل موجود.",
  "webhook.create": "عند إنشاء ويب هوك.",
  "webhook.delete": "عند حذف ويب هوك.",
  "webhook.update": "عند تعديل ويب هوك.",
  "bot.join": "عند إضافة بوت للسيرفر.",
  "bot.leave": "عند إزالة بوت من السيرفر.",
  "bot.role-create": "عند إنشاء رتبة خاصة ببوت.",
  "bot.role-remove": "عند حذف رتبة خاصة ببوت.",

  /* automod-log */
  "automod.rule-create": "عند إنشاء قاعدة أوتو مود.",
  "automod.rule-delete": "عند حذف قاعدة أوتو مود.",
  "automod.rule-update": "عند تعديل قاعدة أوتو مود.",
  "automod.alert": "عند تنفيذ إجراء أوتو مود.",
  "automod.block-message": "عند حجب محتوى تلقائياً.",
  "automod.timeout": "عزل عضو تلقائياً بواسطة قاعدة.",
  "automod.member-block": "حجب عضو تلقائياً بواسطة قاعدة.",

  /* platform-log */
  "stage.create": "عند إنشاء منصة صوتية.",
  "stage.delete": "عند حذف منصة.",
  "stage.update": "عند تعديل منصة.",
  "stage.speaker": "عند إضافة متحدث للمنصة.",
  "stage.suppress": "عند إزالة متحدث من المنصة.",
  "stage.request-speak": "عند طلب عضو التحدث."
};

/** Formats a remaining cooldown as mm:ss — the badge the operator watches. */
function formatCooldown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

/**
 * The logging screen.
 *
 * Four ideas drive the layout:
 *
 * 1. **A stats banner, an auto-setup card, then the sections.** The banner holds
 *    the four counters; the auto-setup card holds the three guild-level channel
 *    actions with a cooldown badge between runs; the sidebar swaps one section
 *    at a time into the pane. A single scroll of fourteen stacked sections is
 *    unusable at this size.
 * 2. **A record is a card with a state machine.** Off, it is compact: icon,
 *    name, the moment it fires, and its switch. On, it unfolds with a short
 *    animation to offer a channel and a colour of its own; off again, it folds
 *    back to exactly the card it was.
 * 3. **A section's defaults are its own controls, separate from the records.**
 *    The «إعدادات القسم» box holds the channel and colour a record inherits when
 *    it has neither of its own, and "تطبيق على جميع السجلات المفعلة" writes both
 *    of them into every enabled record at once.
 * 4. **Search and filter cut across sections.** The field looks through every
 *    record by label, and the three tabs narrow the pane to the enabled or the
 *    disabled ones. A search that matches records in other sections shows them
 *    too, because "the record I want is in a section I have not opened" is the
 *    failure the field exists to fix.
 *
 * Every section is drawn the same way: same card, same switch, same picker. No
 * section carries a badge marking it as a special tier.
 */
export function LogsView({ guild }: { guild: Guild }) {
  const [settings, setSettings] = useState<LoggingSettings | null>(null);
  const { saved, draft, dirty, patch, reset, commit } = useDraftForm(settings);
  const [channels, setChannels] = useState<ChannelOption[]>([]);
  const [roles, setRoles] = useState<DiscordRole[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [selection, setSelection] = useState<Selection>(GENERAL);
  const [channelAction, setChannelAction] = useState<ChannelAction | null>(null);
  const [confirmTeardown, setConfirmTeardown] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [cooldownEndsAt, setCooldownEndsAt] = useState(0);
  const [nowTick, setNowTick] = useState(() => Date.now());
  const { toasts, push, dismiss } = useToasts();

  useEffect(() => {
    let cancelled = false;
    setSettings(null);
    setError(null);
    api
      .logging(guild.id)
      .then(result => {
        if (cancelled) return;
        setSettings(result.settings);
      })
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : "تعذّر التحميل."));
    api
      .channels(guild.id)
      .then(result => !cancelled && setChannels(result.channels))
      .catch(cause => !cancelled && setError(cause instanceof Error ? cause.message : "تعذّر قراءة القنوات."));
    // The role list is only needed for the ignore picker, so a failure here must
    // not take the whole screen down — the log settings are still usable.
    api
      .tiers(guild.id)
      .then(result => !cancelled && setRoles(result.roles))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [guild.id]);

  // The cooldown ticks once a second while it runs, and stops when it is over —
  // a permanent interval for a badge nobody is watching would be a leak.
  useEffect(() => {
    if (cooldownEndsAt <= nowTick) return;
    const timer = setInterval(() => setNowTick(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [cooldownEndsAt, nowTick]);

  const cooldownRemaining = Math.max(0, cooldownEndsAt - nowTick);
  const coolingDown = cooldownRemaining > 0;

  const textChannels = channels.filter(channel => channel.type === "text");

  /** Every record the schema offers, flattened once for the search and the stats. */
  const allRecords = useMemo(
    () => logCategories.flatMap(category => category.events.map(event => ({ category, event }))),
    []
  );

  if (error) {
    return <LoadError message={error} />;
  }
  if (!saved || !draft) {
    return <LoadingRow />;
  }

  // `categoryColors`/`eventColors` are always present from the route; a hand-built
  // object in a test must not crash the pickers.
  const categoryColors = draft.categoryColors ?? {};
  const eventColors = draft.eventColors ?? {};

  /** The colour one record is drawn in when it has none of its own. */
  const inheritedColor = (categoryId: LogDestination) => categoryColors[categoryId] ?? draft.embedColor;
  /** The channel one record is sent to when it has none of its own. */
  const inheritedChannel = (categoryId: LogDestination) =>
    draft.categoryChannels[categoryId] ?? draft.globalChannelId ?? null;

  const isEnabled = (categoryId: LogDestination, eventId: string) =>
    isEventEnabled(draft.eventFlags, categoryId, eventId);

  const enabledCount = allRecords.filter(record => isEnabled(record.category.id, record.event.id)).length;
  const channelsInUse = new Set([
    ...(draft.globalChannelId ? [draft.globalChannelId] : []),
    ...Object.values(draft.categoryChannels ?? {}),
    ...Object.values(draft.eventChannels ?? {})
  ]).size;

  /** How many events in one section are on, for the sidebar's X/N badge. */
  const enabledInSection = (id: LogDestination) => {
    const category = logCategories.find(entry => entry.id === id);
    return category ? category.events.filter(event => isEnabled(id, event.id)).length : 0;
  };

  /** Writes a single event flag, or removes it to fall back to the destination default. */
  const setEventFlag = (eventId: string, value: boolean | null) =>
    patch({ eventFlags: setOrDeleteKey(draft.eventFlags, eventId, value) });

  /**
   * The channel setup and teardown rebind the whole routing table, so the screen's
   * channel list and its pickers must be re-read after either one.
   */
  const refreshChannels = async () => {
    try {
      const result = await api.channels(guild.id);
      setChannels(result.channels);
    } catch {
      // The settings were committed; a stale picker is a minor issue next to that.
    }
  };

  const runSetup = async (mode: "normal" | "detailed") => {
    setChannelAction(mode === "normal" ? "setup-normal" : "setup-detailed");
    try {
      const result = await api.setupLoggingChannels(guild.id, mode);
      commit(result.settings);
      await refreshChannels();
      if (result.failed.length > 0) {
        push({
          tone: "error",
          title: "لم تُنشأ بعض القنوات",
          description: result.failed.map(entry => `${entry.name ?? "قناة"}: ${entry.message}`).join(" — ")
        });
      } else {
        push({
          tone: "success",
          title: mode === "normal" ? "تم إنشاء قنوات الأقسام وربطها" : "تم إنشاء قنوات السجلات المفصلة وربطها"
        });
      }
    } catch (cause) {
      push({ tone: "error", title: "تعذّر إنشاء القنوات", description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setChannelAction(null);
      setCooldownEndsAt(Date.now() + CHANNEL_ACTION_COOLDOWN_MS);
      setNowTick(Date.now());
    }
  };

  const runTeardown = async () => {
    setConfirmTeardown(false);
    setChannelAction("teardown");
    try {
      const result = await api.deleteLoggingChannels(guild.id);
      commit(result.settings);
      await refreshChannels();
      if (result.failed.length > 0) {
        push({
          tone: "error",
          title: "لم تُحذف بعض القنوات",
          description: result.failed.map(entry => entry.message).join(" — ")
        });
      } else {
        push({ tone: "success", title: "تم حذف قنوات السجلات وتعطيل التسجيل" });
      }
    } catch (cause) {
      push({ tone: "error", title: "تعذّر حذف القنوات", description: cause instanceof Error ? cause.message : undefined });
    } finally {
      setChannelAction(null);
      setCooldownEndsAt(Date.now() + CHANNEL_ACTION_COOLDOWN_MS);
      setNowTick(Date.now());
    }
  };

  /** Every channel the teardown would remove, for its confirmation dialog. */
  const boundChannelCount =
    (draft.globalChannelId ? 1 : 0) +
    Object.values(draft.categoryChannels ?? {}).filter(Boolean).length +
    Object.values(draft.eventChannels ?? {}).filter(Boolean).length;

  const needle = query.trim().toLowerCase();
  /**
   * The records the pane should show right now. A search looks through every
   * section; without one, the pane shows the selected section's records. The
   * filter tab then narrows either set by state.
   */
  const visibleRecords = needle
    ? allRecords.filter(
        record =>
          record.event.label.toLowerCase().includes(needle) || record.event.id.includes(needle)
      )
    : allRecords.filter(record => record.category.id === selection);
  const filteredRecords = visibleRecords.filter(record =>
    filter === "all" ? true : filter === "enabled" ? isEnabled(record.category.id, record.event.id) : !isEnabled(record.category.id, record.event.id)
  );

  const selected = logCategories.find(category => category.id === selection);
  const showSearchResults = needle.length > 0;

  return (
    <div className="space-y-4">
      {/* The stats banner: one card, the section's identity on one side and the
          four counters as pills on the other. They are derived from the draft,
          so they move with the operator's edits and never disagree with the
          switches below them. */}
      <Card>
        <CardContent className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-3">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
              <ScrollText className="size-5" aria-hidden />
            </span>
            <div>
              <p className="text-base font-bold">السجلات</p>
              <p className="text-xs text-muted-foreground">تتبع جميع الأحداث في السيرفر</p>
            </div>
          </div>
          <div className="flex flex-wrap gap-2">
            <StatPill icon={Target} tone="text-sky-400" label="إجمالي السجلات" value={allRecords.length} />
            <StatPill icon={CheckCircle2} tone="text-emerald-400" label="السجلات المفعلة" value={enabledCount} />
            <StatPill icon={LayoutGrid} tone="text-violet-400" label="الأقسام" value={logCategories.length} />
            <StatPill icon={Hash} tone="text-pink-400" label="القنوات المستخدمة" value={channelsInUse} />
          </div>
        </CardContent>
      </Card>

      {/*
        The auto-setup card. Creating and deleting channels is a real change to
        the guild, so it happens through its own endpoints rather than the draft
        form: the response carries the rebound routing table, which is what the
        form needs to commit. The cooldown badge counts the rest between runs.
      */}
      <Card>
        <CardContent className="space-y-3 p-4">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
                <Settings className="size-5" aria-hidden />
              </span>
              <div>
                <p className="text-base font-bold">إعداد تلقائي للقنوات</p>
                <p className="text-xs text-muted-foreground">إنشاء قنوات السجلات تلقائياً لجميع الأقسام بضغطة واحدة</p>
              </div>
            </div>
            {coolingDown && (
              <Badge variant="outline" className="gap-1.5 border-amber-500/40 text-amber-400" dir="ltr">
                <Hourglass className="size-3.5" aria-hidden />
                {formatCooldown(cooldownRemaining)}
              </Badge>
            )}
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <ChannelActionButton
              title="إنشاء قنوات عادية"
              description="قناة واحدة لكل قسم (أعضاء، رسائل، أدوار…) — مناسب لأغلب السيرفرات."
              busy={channelAction === "setup-normal"}
              disabled={channelAction !== null || coolingDown}
              onClick={() => void runSetup("normal")}
            />
            <ChannelActionButton
              title="إنشاء قنوات مفصلة"
              description="قناة منفصلة لكل نوع سجل — للسيرفرات الكبيرة."
              busy={channelAction === "setup-detailed"}
              disabled={channelAction !== null || coolingDown}
              onClick={() => void runSetup("detailed")}
            />
            <ChannelActionButton
              title="حذف قنوات السجلات"
              description="حذف فئة السجلات وجميع القنوات بداخلها وتعطيل السجلات."
              destructive
              busy={channelAction === "teardown"}
              disabled={channelAction !== null || (boundChannelCount === 0 && !draft.enabled)}
              onClick={() => setConfirmTeardown(true)}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex flex-col gap-4 lg:flex-row">
        {/* The sidebar. In RTL it sits at the start of the row, which is the
            reading's natural "first" position. Each row carries the section's
            icon and its enabled/total count, so an operator can see at a glance
            which sections are doing work. */}
        <nav aria-label="أقسام السجلات" className="lg:w-60 lg:shrink-0">
          <Card className="p-1">
            <NavButton active={selection === GENERAL} onClick={() => setSelection(GENERAL)}>
              <span className="flex items-center gap-2">
                <Settings className="size-4 text-muted-foreground" aria-hidden />
                <span className="text-sm font-medium">إعدادات عامة</span>
              </span>
            </NavButton>
            {logCategories.map(category => {
              const Icon = sectionIcons[category.id];
              return (
                <NavButton
                  key={category.id}
                  active={selection === category.id}
                  onClick={() => setSelection(category.id)}
                >
                  <span className="flex items-center gap-2">
                    <Icon className="size-4 text-muted-foreground" aria-hidden />
                    <span className="text-sm">{category.label}</span>
                  </span>
                  <Badge variant="secondary" className="tabular-nums" dir="ltr">
                    {`${enabledInSection(category.id)}/${category.events.length}`}
                  </Badge>
                </NavButton>
              );
            })}
          </Card>
        </nav>

        <div className="min-w-0 flex-1 space-y-4">
          {/*
            The search field and the filter tabs sit above whichever pane is
            open, because they are questions about the records rather than about
            one section. A search hides the section card and shows a flat list of
            matches instead — an operator looking for "البث" should not have to
            know that الصوت is where it lives.
          */}
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="absolute end-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                type="search"
                value={query}
                onChange={event => setQuery(event.target.value)}
                placeholder="ابحث عن سجل..."
                aria-label="ابحث عن سجل"
                className="pe-9"
              />
            </div>
            <div className="flex gap-1 rounded-md border border-border p-1">
              {(["all", "enabled", "disabled"] as const).map(value => (
                <FilterTab
                  key={value}
                  active={filter === value}
                  label={value === "all" ? "الكل" : value === "enabled" ? "المفعلة" : "المعطلة"}
                  onClick={() => setFilter(value)}
                />
              ))}
            </div>
          </div>

          {showSearchResults ? (
            <RecordList
              heading={`نتائج البحث (${filteredRecords.length})`}
              records={filteredRecords}
              eventFlags={draft.eventFlags}
              eventChannels={draft.eventChannels ?? {}}
              eventColors={eventColors}
              categoryColors={categoryColors}
              categoryChannels={draft.categoryChannels ?? {}}
              globalChannelId={draft.globalChannelId}
              channels={textChannels}
              onToggleEvent={setEventFlag}
              onEventChannelChange={(eventId, value) =>
                patch({ eventChannels: setOrDeleteKey(draft.eventChannels ?? {}, eventId, value) })
              }
              onEventColorChange={(eventId, value) =>
                patch({ eventColors: setOrDeleteKey(eventColors, eventId, value || null) })
              }
              onEventColorReset={eventId => patch({ eventColors: setOrDeleteKey<string>(eventColors, eventId, null) })}
            />
          ) : selection === GENERAL ? (
            <Card>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <CardTitle className="text-base">التسجيل المركزي</CardTitle>
                <Switch
                  checked={draft.enabled}
                  aria-label="تفعيل السجلات"
                  onCheckedChange={enabled => patch({ enabled })}
                />
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-2">
                  <Label>وضع التوزيع</Label>
                  <div className="flex gap-2">
                    <ModeButton
                      active={draft.mode === "normal"}
                      title="عادية"
                      hint="قناة واحدة لكل قسم"
                      onClick={() => patch({ mode: "normal" })}
                    />
                    <ModeButton
                      active={draft.mode === "detailed"}
                      title="مفصلة"
                      hint="قناة لكل سجل"
                      onClick={() => patch({ mode: "detailed" })}
                    />
                  </div>
                  <p className="text-xs text-muted-foreground">
                    «عادية» تضع كل قسم في قناة واحدة؛ «مفصلة» تتيح لكل سجل قناة ولوناً مستقلين.
                  </p>
                </div>

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>القناة العامة</Label>
                    <Select
                      value={draft.globalChannelId ?? INHERIT}
                      onValueChange={value => patch({ globalChannelId: value === INHERIT ? null : value })}
                    >
                      <SelectTrigger>
                        <SelectValue placeholder="بدون قناة عامة" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={INHERIT}>بدون قناة عامة</SelectItem>
                        {textChannels.map(channel => (
                          <SelectItem key={channel.id} value={channel.id}>
                            #{channel.name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <p className="text-xs text-muted-foreground">
                      الوجهة الاحتياطية لأي قسم أو سجل لم يُحدّد قنته الخاصة.
                    </p>
                  </div>

                  <ColorField
                    label="لون الـ Embed"
                    value={draft.embedColor}
                    onChange={value => patch({ embedColor: value })}
                    ariaLabel="لون الـ Embed"
                  />
                </div>

                <Separator />

                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label>القنوات المستثناة</Label>
                    <ScrollArea className="h-36 rounded-md border border-border p-2">
                      <div className="space-y-1.5">
                        {textChannels.length === 0 && <p className="text-xs text-muted-foreground">لا توجد قنوات نصية</p>}
                        {textChannels.map(channel => (
                          <label
                            key={channel.id}
                            className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent"
                          >
                            <Checkbox
                              checked={draft.ignoredChannelIds.includes(channel.id)}
                              onCheckedChange={checked =>
                                patch({
                                  ignoredChannelIds: checked
                                    ? [...draft.ignoredChannelIds, channel.id]
                                    : draft.ignoredChannelIds.filter(id => id !== channel.id)
                                })
                              }
                            />
                            #{channel.name}
                          </label>
                        ))}
                      </div>
                    </ScrollArea>
                    <p className="text-xs text-muted-foreground">لا يُسجَّل أي حدث يقع داخل هذه القنوات.</p>
                  </div>

                  <div className="space-y-2">
                    <Label>الرتب المستثناة</Label>
                    <ScrollArea className="h-36 rounded-md border border-border p-2">
                      <div className="space-y-1.5">
                        {roles.length === 0 && <p className="text-xs text-muted-foreground">لا توجد رتب</p>}
                        {roles.map(role => (
                          <label
                            key={role.id}
                            className="flex items-center gap-2 rounded px-1 py-1 text-sm hover:bg-accent"
                          >
                            <Checkbox
                              checked={draft.ignoredRoleIds.includes(role.id)}
                              onCheckedChange={checked =>
                                patch({
                                  ignoredRoleIds: checked
                                    ? [...draft.ignoredRoleIds, role.id]
                                    : draft.ignoredRoleIds.filter(id => id !== role.id)
                                })
                              }
                            />
                            <RoleSwatch color={role.color} />
                            <span className="truncate">{role.name}</span>
                          </label>
                        ))}
                      </div>
                    </ScrollArea>
                    <p className="text-xs text-muted-foreground">
                      من يحمل إحدى هذه الرتب لا يظهر في السجلات — سواء كان الفاعل أو الطرف المتأثر. مفيد لاستثناء البوتات.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          ) : selected ? (
            <SectionCard
              key={selected.id}
              category={selected}
              eventFlags={draft.eventFlags}
              eventChannels={draft.eventChannels ?? {}}
              eventColors={eventColors}
              categoryColors={categoryColors}
              categoryChannels={draft.categoryChannels ?? {}}
              globalChannelId={draft.globalChannelId}
              embedColor={draft.embedColor}
              channels={textChannels}
              visibleRecords={filteredRecords.map(record => record.event.id)}
              onToggleCategory={value => patch({ eventFlags: { ...draft.eventFlags, [selected.id]: value } })}
              onToggleEvent={setEventFlag}
              onEnableAll={() =>
                patch({
                  eventFlags: { ...draft.eventFlags, ...Object.fromEntries(selected.events.map(event => [event.id, true])) }
                })
              }
              onDisableAll={() =>
                patch({
                  eventFlags: { ...draft.eventFlags, ...Object.fromEntries(selected.events.map(event => [event.id, false])) }
                })
              }
              onChannelChange={value =>
                patch({ categoryChannels: setOrDeleteKey(draft.categoryChannels ?? {}, selected.id, value) })
              }
              onColorChange={value =>
                patch({ categoryColors: setOrDeleteKey<string>(categoryColors, selected.id, value || null) })
              }
              onColorReset={() => patch({ categoryColors: setOrDeleteKey<string>(categoryColors, selected.id, null) })}
              onEventChannelChange={(eventId, value) =>
                patch({ eventChannels: setOrDeleteKey(draft.eventChannels ?? {}, eventId, value) })
              }
              onEventColorChange={(eventId, value) =>
                patch({ eventColors: setOrDeleteKey(eventColors, eventId, value || null) })
              }
              onEventColorReset={eventId => patch({ eventColors: setOrDeleteKey<string>(eventColors, eventId, null) })}
            />
          ) : null}

          <Alert>
            <AlertDescription className="text-xs">
              سجلات البوت الداخلية وأحداث الأمان لا تظهر هنا: تُرسَل مباشرة إلى Webhook المطوّر ولا يمكن إسكاتها من اللوحة.
            </AlertDescription>
          </Alert>
        </div>
      </div>

      <Dialog open={confirmTeardown} onOpenChange={setConfirmTeardown}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>حذف قنوات السجلات</DialogTitle>
            <DialogDescription>
              سيتم حذف {boundChannelCount} {boundChannelCount === 1 ? "قناة" : "قنوات"} مربوطة، وكل قناة داخل فئة
              السجلات، ثم تُحذف الفئة ويُعطَّل التسجيل. لا يمكن التراجع عن هذا الإجراء.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmTeardown(false)}>
              إلغاء
            </Button>
            <Button variant="destructive" disabled={channelAction === "teardown"} onClick={() => void runTeardown()}>
              {channelAction === "teardown" ? "جارٍ الحذف…" : "حذف"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {dirty && (
        <SaveBar
          onCancel={reset}
          onSave={async () => {
            const result = await api.saveLogging(guild.id, draft);
            commit(result.settings);
          }}
        />
      )}

      <Toaster toasts={toasts} onDismiss={dismiss} />
    </div>
  );
}

function NavButton({
  active,
  onClick,
  children
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active}
      className={`flex w-full items-center justify-between gap-2 rounded-md px-3 py-2 text-start transition-colors ${
        active ? "bg-accent" : "hover:bg-accent/50"
      }`}
    >
      {children}
    </button>
  );
}

function ModeButton({
  active,
  title,
  hint,
  onClick
}: {
  active: boolean;
  title: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`flex-1 rounded-md border px-3 py-2 text-start transition-colors ${
        active ? "border-primary bg-accent" : "border-border hover:bg-accent/50"
      }`}
    >
      <span className="block text-sm font-medium">{title}</span>
      <span className="block text-xs text-muted-foreground">{hint}</span>
    </button>
  );
}

function FilterTab({
  active,
  label,
  onClick
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`rounded px-3 py-1 text-xs font-medium transition-colors ${
        active ? "bg-accent text-accent-foreground" : "text-muted-foreground hover:bg-accent/50"
      }`}
    >
      {label}
    </button>
  );
}

function StatPill({
  icon: Icon,
  tone,
  label,
  value
}: {
  icon: LucideIcon;
  tone: string;
  label: string;
  value: number;
}) {
  return (
    <span className="flex items-center gap-2 rounded-full border border-border px-3 py-1.5">
      <Icon className={`size-4 ${tone}`} aria-hidden />
      <span className="text-sm font-semibold tabular-nums" dir="ltr">
        {value}
      </span>
      <span className="text-xs text-muted-foreground">{label}</span>
    </span>
  );
}

/**
 * One of the three guild-level channel actions, drawn as its own card: the
 * title, the consequence, and the whole surface clickable. Disabled while any
 * sibling runs or while the cooldown between runs is still counting.
 */
function ChannelActionButton({
  title,
  description,
  destructive,
  busy,
  disabled,
  onClick
}: {
  title: string;
  description: string;
  destructive?: boolean;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || busy}
      className={`rounded-lg border p-3 text-start transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        destructive
          ? "border-red-900/60 hover:border-red-700 hover:bg-red-950/40"
          : "border-border hover:border-primary/60 hover:bg-accent"
      }`}
    >
      <span className={`block text-sm font-bold ${destructive ? "text-red-400" : ""}`}>{title}</span>
      <span className="mt-1 block text-xs text-muted-foreground">{busy ? "جارٍ التنفيذ…" : description}</span>
    </button>
  );
}

/**
 * The compact colour control: a round swatch that opens the full picker in a
 * popover, with the hex value read beside it. The picker component itself is
 * shared with the customization screen; only this trigger is the logs page's.
 */
function ColorField({
  label,
  value,
  onChange,
  onReset,
  resetLabel,
  ariaLabel
}: {
  label: string;
  value: string;
  onChange: (hex: string) => void;
  onReset?: () => void;
  resetLabel?: string;
  ariaLabel: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <button
              type="button"
              className="size-9 shrink-0 rounded-full border-2 border-border shadow-sm transition-transform hover:scale-105"
              style={{ backgroundColor: value }}
              aria-label={ariaLabel}
            />
          </PopoverTrigger>
          <PopoverContent className="w-72" align="start">
            <ColorPicker
              value={value}
              unsetLabel={resetLabel ?? "اللون الافتراضي"}
              onChange={hex => {
                if (hex === null) {
                  onReset?.();
                  setOpen(false);
                } else {
                  onChange(hex);
                }
              }}
            />
          </PopoverContent>
        </Popover>
        <code className="text-sm text-muted-foreground" dir="ltr">
          {value}
        </code>
      </div>
    </div>
  );
}

/**
 * The shared shape of one record's card: an icon and a name in the header with
 * the switch in the corner, and the moment it fires underneath.
 *
 * The card is a state machine. Off, it is compact — the pickers are not on the
 * page at all. On, the fields unfold with a short height-and-fade animation;
 * switched off again, they fold away and the card returns to exactly the shape
 * it had. The animation lives on a wrapper whose height is animated, because
 * framer-motion cannot animate `height: auto` without measuring it for us.
 */
function RecordCard({
  eventId,
  label,
  sectionLabel,
  enabled,
  ownChannelId,
  inheritedChannelId,
  color,
  colorOverridden,
  channels,
  onToggle,
  onChannelChange,
  onColorChange,
  onColorReset
}: {
  eventId: string;
  label: string;
  sectionLabel?: string;
  enabled: boolean;
  ownChannelId: string | null;
  inheritedChannelId: string | null;
  color: string;
  colorOverridden: boolean;
  channels: ChannelOption[];
  onToggle: (value: boolean) => void;
  onChannelChange: (value: string | null) => void;
  onColorChange: (value: string) => void;
  onColorReset: () => void;
}) {
  const Icon = eventIcons[eventId] ?? CircleUserRound;
  const hint = eventHints[eventId];
  const inheritedName = channels.find(channel => channel.id === inheritedChannelId)?.name;

  return (
    <Card className="p-3 transition-colors sm:p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <span
            className={`flex size-8 shrink-0 items-center justify-center rounded-md ${
              enabled ? "bg-primary/15 text-primary" : "bg-accent text-accent-foreground"
            }`}
          >
            <Icon className="size-4" aria-hidden />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-bold">{label}</p>
            {(hint || sectionLabel) && (
              <p className="text-xs text-muted-foreground">
                {sectionLabel ? `${sectionLabel} · ` : ""}
                {hint}
              </p>
            )}
          </div>
        </div>
        <Switch checked={enabled} aria-label={label} onCheckedChange={onToggle} />
      </div>

      <AnimatePresence initial={false}>
        {enabled && (
          <motion.div
            key="fields"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.22, ease: "easeOut" }}
            className="overflow-hidden"
          >
            <div className="mt-3 grid gap-3 border-t border-border pt-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs">قناة السجل</Label>
                <Select
                  value={ownChannelId ?? INHERIT}
                  onValueChange={value => onChannelChange(value === INHERIT ? null : value)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="اختر قناة السجلات" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={INHERIT}>
                      {inheritedName ? `وراثة القسم (#${inheritedName})` : "وراثة القسم"}
                    </SelectItem>
                    {channels.map(channel => (
                      <SelectItem key={channel.id} value={channel.id}>
                        #{channel.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <ColorField
                label="لون السجل"
                value={color}
                onChange={onColorChange}
                onReset={colorOverridden ? onColorReset : undefined}
                resetLabel="وراثة القسم"
                ariaLabel={`لون ${label}`}
              />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Card>
  );
}

/**
 * A flat list of records — the search results view, which is why a record here
 * carries its section's name: without it the operator cannot tell which of the
 * thirteen sections a match belongs to.
 */
function RecordList({
  heading,
  records,
  eventFlags,
  eventChannels,
  eventColors,
  categoryColors,
  categoryChannels,
  globalChannelId,
  channels,
  onToggleEvent,
  onEventChannelChange,
  onEventColorChange,
  onEventColorReset
}: {
  heading: string;
  records: { category: LogCategory; event: { id: string; label: string } }[];
  eventFlags: Record<string, boolean>;
  eventChannels: Record<string, string>;
  eventColors: Record<string, string>;
  categoryColors: Record<string, string>;
  categoryChannels: Record<string, string>;
  globalChannelId: string | null;
  channels: ChannelOption[];
  onToggleEvent: (eventId: string, value: boolean | null) => void;
  onEventChannelChange: (eventId: string, value: string | null) => void;
  onEventColorChange: (eventId: string, value: string) => void;
  onEventColorReset: (eventId: string) => void;
}) {
  if (records.length === 0) {
    return (
      <Card>
        <CardContent className="p-6 text-center text-sm text-muted-foreground">لا توجد سجلات مطابقة.</CardContent>
      </Card>
    );
  }
  return (
    <div className="space-y-3">
      <h3 className="text-sm font-medium">{heading}</h3>
      {/* `items-start` matters: grid rows stretch to the tallest card by default,
          so a compact off record beside an unfolded one would stretch to match
          it and read as a huge empty card. */}
      <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 sm:gap-4">
        {records.map(({ category, event }) => (
          <RecordCard
            key={event.id}
            eventId={event.id}
            label={event.label}
            sectionLabel={category.label}
            enabled={isEventEnabled(eventFlags, category.id, event.id)}
            ownChannelId={eventChannels[event.id] ?? null}
            inheritedChannelId={categoryChannels[category.id] ?? globalChannelId ?? null}
            color={eventColors[event.id] ?? categoryColors[category.id] ?? "#3b82f6"}
            colorOverridden={eventColors[event.id] !== undefined}
            channels={channels}
            onToggle={value => onToggleEvent(event.id, value)}
            onChannelChange={value => onEventChannelChange(event.id, value)}
            onColorChange={value => onEventColorChange(event.id, value)}
            onColorReset={() => onEventColorReset(event.id)}
          />
        ))}
      </div>
    </div>
  );
}

function SectionCard({
  category,
  eventFlags,
  eventChannels,
  eventColors,
  categoryColors,
  categoryChannels,
  globalChannelId,
  embedColor,
  channels,
  visibleRecords,
  onToggleCategory,
  onToggleEvent,
  onEnableAll,
  onDisableAll,
  onChannelChange,
  onColorChange,
  onColorReset,
  onEventChannelChange,
  onEventColorChange,
  onEventColorReset
}: {
  category: LogCategory;
  eventFlags: Record<string, boolean>;
  eventChannels: Record<string, string>;
  eventColors: Record<string, string>;
  categoryColors: Record<string, string>;
  categoryChannels: Record<string, string>;
  globalChannelId: string | null;
  embedColor: string;
  channels: ChannelOption[];
  /** The record ids the current search/filter leaves in this section. */
  visibleRecords: string[];
  onToggleCategory: (value: boolean) => void;
  onToggleEvent: (eventId: string, value: boolean | null) => void;
  onEnableAll: () => void;
  onDisableAll: () => void;
  onChannelChange: (value: string | null) => void;
  onColorChange: (value: string) => void;
  onColorReset: () => void;
  onEventChannelChange: (eventId: string, value: string | null) => void;
  onEventColorChange: (eventId: string, value: string) => void;
  onEventColorReset: (eventId: string) => void;
}) {
  const Icon = sectionIcons[category.id];
  const muted = category.events.filter(event => !isEventEnabled(eventFlags, category.id, event.id)).length;
  const channelId = categoryChannels[category.id] ?? null;
  const color = categoryColors[category.id] ?? embedColor;
  const colorOverridden = categoryColors[category.id] !== undefined;

  // The two defaults are what an enabled record in this section inherits, so
  // "apply to all enabled" is a question about *both* of them at once: writing
  // one and not the other would leave every record half-configured, which is
  // worse than leaving them all to inherit.
  const enabledEvents = category.events.filter(event => isEventEnabled(eventFlags, category.id, event.id));
  const canApply = enabledEvents.length > 0 && (channelId !== null || colorOverridden);

  return (
    <Card>
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <div className="flex min-w-40 flex-1 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
            <Icon className="size-5" aria-hidden />
          </span>
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              {category.label}
              {muted > 0 && <Badge variant="secondary">{`${muted} مكتوم`}</Badge>}
            </CardTitle>
            <p className="text-xs text-muted-foreground">{category.description}</p>
          </div>
        </div>
        <Switch checked={isCategoryEnabled(eventFlags, category.id)} aria-label={category.label} onCheckedChange={onToggleCategory} />
      </CardHeader>

      <CardContent className="space-y-4">
        {/*
          «إعدادات القسم» — the section's defaults in one compact frame. A record
          with neither channel nor colour of its own resolves to these; a record
          with one of its own keeps that one and inherits the other. The apply
          button sits directly beneath them because it writes exactly these two
          values.
        */}
        <div className="space-y-3 rounded-lg border border-border p-3">
          <div>
            <p className="text-sm font-bold">إعدادات القسم</p>
            <p className="text-xs text-muted-foreground">طبّق نفس الإعدادات على جميع السجلات المفعلة</p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2 sm:gap-4">
            <div className="space-y-1.5">
              <Label className="text-xs">القناة الافتراضية</Label>
              <Select value={channelId ?? INHERIT} onValueChange={value => onChannelChange(value === INHERIT ? null : value)}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="اختر قناة للقسم" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={INHERIT}>القناة العامة</SelectItem>
                  {channels.map(channel => (
                    <SelectItem key={channel.id} value={channel.id}>
                      #{channel.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <p className="text-xs text-muted-foreground">يُرسَل إليها كل سجل مفعول في هذا القسم ليس له قناته الخاصة.</p>
            </div>

            <ColorField
              label="اللون الافتراضي"
              value={color}
              onChange={onColorChange}
              onReset={colorOverridden ? onColorReset : undefined}
              resetLabel="اللون العام"
              ariaLabel={`لون ${category.label}`}
            />
          </div>

          <Button className="w-full" size="sm" disabled={!canApply} onClick={() => {
            enabledEvents.forEach(event => {
              if (channelId !== null) onEventChannelChange(event.id, channelId);
              if (colorOverridden) onEventColorChange(event.id, color);
            });
          }}>
            تطبيق على جميع السجلات المفعلة
          </Button>
          <p className="text-xs text-muted-foreground">
            يكتب قناة القسم ولونه في كل سجل مفعول ({enabledEvents.length}) دفعة واحدة.
          </p>
        </div>

        {/*
          The two bulk state moves, side by side and colour-coded: green turns
          every record in the section on, red turns them all off. They use the
          theme's own success/destructive tokens rather than raw palette steps,
          so they shift with the theme like every other semantic colour. They
          write the section flag for every record, which is the coarse move; the
          per-record switch is the fine one.
        */}
        <div className="flex gap-2">
          <Button
            size="sm"
            className="flex-1 bg-success text-white hover:bg-success/85"
            onClick={onEnableAll}
          >
            تفعيل الكل
          </Button>
          <Button
            size="sm"
            className="flex-1 bg-destructive text-white hover:bg-destructive/85"
            onClick={onDisableAll}
          >
            تعطيل الكل
          </Button>
        </div>

        {/*
          The records follow directly: no collapsed list to open first, so an
          operator who picks a section sees its records in the same motion.
        */}
        {visibleRecords.length === 0 ? (
          <p className="rounded-md border border-border p-4 text-center text-xs text-muted-foreground">
            لا توجد سجلات مطابقة في هذا القسم.
          </p>
        ) : (
          <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 sm:gap-4">
            {category.events
              .filter(event => visibleRecords.includes(event.id))
              .map(event => (
                <RecordCard
                  key={event.id}
                  eventId={event.id}
                  label={event.label}
                  enabled={isEventEnabled(eventFlags, category.id, event.id)}
                  ownChannelId={eventChannels[event.id] ?? null}
                  inheritedChannelId={channelId ?? globalChannelId ?? null}
                  color={eventColors[event.id] ?? color}
                  colorOverridden={eventColors[event.id] !== undefined}
                  channels={channels}
                  onToggle={value => onToggleEvent(event.id, value)}
                  onChannelChange={value => onEventChannelChange(event.id, value)}
                  onColorChange={value => onEventColorChange(event.id, value)}
                  onColorReset={() => onEventColorReset(event.id)}
                />
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
