import type { LogDestination } from "./event-schema.js";

/**
 * The visual identity of every log embed.
 *
 * One row per event id: the emoji that leads the title, the embed colour, and
 * the Arabic title the operator reads in the log channel. Colours follow the
 * product palette — green for things that were added or restored, red for
 * things that were removed or punitive, amber for edits and neutral changes,
 * blue for informational events, pink for boost moments.
 *
 * The emoji doubles as the thumbnail: `twemojiThumbnailUrl` turns it into a
 * Twemoji PNG on jsDelivr (CC-BY 4.0), a stable CDN Discord can render as an
 * embed thumbnail — SVG is not rendered by Discord, hence the 72x72 PNG.
 */

export const LOG_COLOR_GREEN = 0x22c55e;
export const LOG_COLOR_RED = 0xef4444;
export const LOG_COLOR_AMBER = 0xf59e0b;
export const LOG_COLOR_BLUE = 0x3b82f6;
export const LOG_COLOR_PINK = 0xeb459e;

export type LogVisual = { emoji: string; color: number; title: string };

export const LOG_EVENT_VISUALS: Record<string, LogVisual> = {
  /* member-log — الأعضاء */
  "member.join": { emoji: "👋", color: LOG_COLOR_GREEN, title: "دخول عضو" },
  "member.leave": { emoji: "🚪", color: LOG_COLOR_RED, title: "خروج عضو" },
  "moderation.ban": { emoji: "🔨", color: LOG_COLOR_RED, title: "حظر عضو" },
  "moderation.unban": { emoji: "🔓", color: LOG_COLOR_GREEN, title: "فك حظر عضو" },
  "moderation.kick": { emoji: "🥾", color: LOG_COLOR_RED, title: "طرد عضو" },
  "moderation.prison": { emoji: "🔒", color: LOG_COLOR_RED, title: "سجن عضو" },
  "moderation.unprison": { emoji: "🔓", color: LOG_COLOR_GREEN, title: "إخراج من السجن" },
  "moderation.timeout": { emoji: "⏳", color: LOG_COLOR_RED, title: "عزل عضو (تايم أوت)" },
  "moderation.untimeout": { emoji: "⏱️", color: LOG_COLOR_GREEN, title: "إزالة العزل" },
  "moderation.mute": { emoji: "🔇", color: LOG_COLOR_RED, title: "إسكات كتابي" },
  "moderation.unmute": { emoji: "🔊", color: LOG_COLOR_GREEN, title: "إلغاء الإسكات" },
  "member.nickname-change": { emoji: "📛", color: LOG_COLOR_AMBER, title: "تغيير الاسم المستعار" },
  "member.avatar-change": { emoji: "🖼️", color: LOG_COLOR_AMBER, title: "تغيير الصورة" },
  "member.username-change": { emoji: "📝", color: LOG_COLOR_AMBER, title: "تغيير اسم المستخدم" },
  "member.boost-add": { emoji: "💎", color: LOG_COLOR_PINK, title: "بوست السيرفر" },
  "member.boost-remove": { emoji: "💔", color: LOG_COLOR_RED, title: "إزالة البوست" },
  "moderation.remove": { emoji: "🧾", color: LOG_COLOR_AMBER, title: "حذف عقوبة من السجل" },
  "member.suspicious-account": { emoji: "🕵️", color: LOG_COLOR_RED, title: "حساب مشبوه" },

  /* role-log — الرتب */
  "role.create": { emoji: "🆕", color: LOG_COLOR_GREEN, title: "إنشاء رتبة" },
  "role.delete": { emoji: "🗑️", color: LOG_COLOR_RED, title: "حذف رتبة" },
  "role.update": { emoji: "✏️", color: LOG_COLOR_AMBER, title: "تعديل رتبة" },
  "member.role-add": { emoji: "➕", color: LOG_COLOR_GREEN, title: "إضافة رتبة لعضو" },
  "member.role-remove": { emoji: "➖", color: LOG_COLOR_RED, title: "إزالة رتبة من عضو" },
  "role.managed-change": { emoji: "🛡️", color: LOG_COLOR_AMBER, title: "تعديل رتبة خاصة" },

  /* channel-log — القنوات */
  "server.channel-create": { emoji: "📁", color: LOG_COLOR_GREEN, title: "إنشاء قناة" },
  "server.channel-delete": { emoji: "🗑️", color: LOG_COLOR_RED, title: "حذف قناة" },
  "server.channel-update": { emoji: "✏️", color: LOG_COLOR_AMBER, title: "تعديل قناة" },
  "channel.permission-update": { emoji: "🔐", color: LOG_COLOR_AMBER, title: "تعديل صلاحيات قناة" },
  "thread.create": { emoji: "🧵", color: LOG_COLOR_GREEN, title: "إنشاء ثريد" },
  "thread.delete": { emoji: "🗑️", color: LOG_COLOR_RED, title: "حذف ثريد" },
  "thread.update": { emoji: "✏️", color: LOG_COLOR_AMBER, title: "تعديل ثريد" },

  /* message-log — الرسائل */
  "message.delete": { emoji: "🗑️", color: LOG_COLOR_RED, title: "حذف رسالة" },
  "message.delete-attachment": { emoji: "🖼️", color: LOG_COLOR_RED, title: "حذف صورة" },
  "message.edit": { emoji: "✏️", color: LOG_COLOR_AMBER, title: "تعديل رسالة" },
  "message.bulk-delete": { emoji: "🧹", color: LOG_COLOR_RED, title: "حذف جماعي للرسائل" },
  "message.pin": { emoji: "📌", color: LOG_COLOR_GREEN, title: "تثبيت رسالة" },
  "message.unpin": { emoji: "📤", color: LOG_COLOR_AMBER, title: "إلغاء تثبيت رسالة" },
  "message.reaction-add": { emoji: "➕", color: LOG_COLOR_GREEN, title: "إضافة تفاعل" },
  "message.reaction-remove": { emoji: "➖", color: LOG_COLOR_RED, title: "إزالة تفاعل" },
  "message.reaction-clear": { emoji: "🧹", color: LOG_COLOR_RED, title: "مسح جميع التفاعلات" },

  /* voice-log — الصوت */
  "voice.join": { emoji: "🎤", color: LOG_COLOR_GREEN, title: "دخول روم صوتي" },
  "voice.leave": { emoji: "🚪", color: LOG_COLOR_RED, title: "خروج من روم صوتي" },
  "voice.move": { emoji: "🔀", color: LOG_COLOR_AMBER, title: "نقل بين الرومات" },
  "voice.self-move": { emoji: "🔀", color: LOG_COLOR_AMBER, title: "تبديل الرومات" },
  "voice.server-mute": { emoji: "🔇", color: LOG_COLOR_RED, title: "كتم عضو" },
  "voice.server-unmute": { emoji: "🔊", color: LOG_COLOR_GREEN, title: "إلغاء كتم عضو" },
  "voice.server-deafen": { emoji: "🔇", color: LOG_COLOR_RED, title: "إصمات عضو" },
  "voice.server-undeafen": { emoji: "🔊", color: LOG_COLOR_GREEN, title: "إلغاء إصمات عضو" },
  "voice.self-mute": { emoji: "🔇", color: LOG_COLOR_AMBER, title: "سيلف ميوت" },
  "voice.self-unmute": { emoji: "🔊", color: LOG_COLOR_AMBER, title: "إلغاء السيلف ميوت" },
  "voice.self-deafen": { emoji: "🔇", color: LOG_COLOR_AMBER, title: "سيلف ديفن" },
  "voice.self-undeafen": { emoji: "🔊", color: LOG_COLOR_AMBER, title: "إلغاء السيلف ديفن" },
  "voice.stream-start": { emoji: "📡", color: LOG_COLOR_GREEN, title: "بدء بث" },
  "voice.stream-end": { emoji: "📴", color: LOG_COLOR_RED, title: "إنهاء بث" },
  "voice.camera-on": { emoji: "📷", color: LOG_COLOR_GREEN, title: "تشغيل الكاميرا" },
  "voice.camera-off": { emoji: "📷", color: LOG_COLOR_RED, title: "إيقاف الكاميرا" },
  "voice.disconnect": { emoji: "🔌", color: LOG_COLOR_RED, title: "فصل من الصوتية" },

  /* moderation-log — الإشراف */
  "moderation.warn": { emoji: "⚠️", color: LOG_COLOR_AMBER, title: "إعطاء تحذير" },
  "moderation.delwarn": { emoji: "🧾", color: LOG_COLOR_GREEN, title: "إزالة تحذير" },
  "moderation.clearwarns": { emoji: "🧹", color: LOG_COLOR_GREEN, title: "مسح التحذيرات" },
  "moderation.clearallwarns": { emoji: "🧹", color: LOG_COLOR_GREEN, title: "مسح جميع التحذيرات" },
  "moderation.block": { emoji: "🚫", color: LOG_COLOR_RED, title: "إعطاء بلوك" },
  "moderation.unblock": { emoji: "✅", color: LOG_COLOR_GREEN, title: "إزالة بلوك" },
  "moderation.blacklist": { emoji: "⛔", color: LOG_COLOR_RED, title: "إضافة بلاك لست" },
  "moderation.unblacklist": { emoji: "✅", color: LOG_COLOR_GREEN, title: "إزالة بلاك لست" },
  "moderation.down": { emoji: "⬇️", color: LOG_COLOR_RED, title: "إزالة الرتب الإدارية" },
  "moderation.undown": { emoji: "⬆️", color: LOG_COLOR_GREEN, title: "استرجاع الرتب الإدارية" },
  "moderation.down-expired": { emoji: "⏬", color: LOG_COLOR_AMBER, title: "انتهاء مدة الداون" },
  "moderation.clearallpunishments": { emoji: "🧹", color: LOG_COLOR_GREEN, title: "مسح جميع العقوبات" },

  /* server-log — السيرفر */
  "server.settings-change": { emoji: "🏰", color: LOG_COLOR_AMBER, title: "تعديل السيرفر" },
  "server.name-change": { emoji: "🏰", color: LOG_COLOR_AMBER, title: "تغيير اسم السيرفر" },
  "server.icon-change": { emoji: "🖼️", color: LOG_COLOR_AMBER, title: "تغيير أيقونة السيرفر" },
  "server.banner-change": { emoji: "🖼️", color: LOG_COLOR_AMBER, title: "تغيير بانر السيرفر" },
  "server.vanity-url-change": { emoji: "🔗", color: LOG_COLOR_AMBER, title: "تغيير رابط الفانيتي" },
  "server.boost-tier-up": { emoji: "🔼", color: LOG_COLOR_PINK, title: "رفع مستوى البوست" },
  "server.boost-tier-down": { emoji: "🔽", color: LOG_COLOR_RED, title: "انخفاض مستوى البوست" },
  "server.afk-change": { emoji: "⏲️", color: LOG_COLOR_AMBER, title: "تعديل قناة AFK" },
  "server.system-channel-change": { emoji: "📢", color: LOG_COLOR_AMBER, title: "تعديل قناة النظام" },

  /* invite-log — الدعوات */
  "server.invite-create": { emoji: "🔗", color: LOG_COLOR_GREEN, title: "إنشاء دعوة" },
  "invite.delete": { emoji: "✂️", color: LOG_COLOR_RED, title: "حذف دعوة" },
  "invite.use": { emoji: "📥", color: LOG_COLOR_BLUE, title: "استخدام دعوة" },
  "invites.member-join": { emoji: "🤝", color: LOG_COLOR_GREEN, title: "انضمام عبر دعوة" },
  "invites.member-leave": { emoji: "📤", color: LOG_COLOR_RED, title: "مغادرة مُحال" },
  "invites.milestone": { emoji: "🏅", color: LOG_COLOR_PINK, title: "رتبة إحالات" },
  "invites.admin-adjust": { emoji: "⚖️", color: LOG_COLOR_AMBER, title: "تعديل يدوي للإحالات" },

  /* expression-log — الإيموجي والستيكرز */
  "server.expression-create": { emoji: "😀", color: LOG_COLOR_GREEN, title: "إضافة إيموجي" },
  "server.expression-delete": { emoji: "🗑️", color: LOG_COLOR_RED, title: "حذف إيموجي" },
  "emoji.update": { emoji: "✏️", color: LOG_COLOR_AMBER, title: "تعديل إيموجي" },
  "sticker.create": { emoji: "🏷️", color: LOG_COLOR_GREEN, title: "إضافة ستيكر" },
  "sticker.delete": { emoji: "🗑️", color: LOG_COLOR_RED, title: "حذف ستيكر" },
  "sticker.update": { emoji: "✏️", color: LOG_COLOR_AMBER, title: "تعديل ستيكر" },

  /* event-log — الأحداث */
  "scheduled-event.create": { emoji: "📅", color: LOG_COLOR_GREEN, title: "إنشاء حدث" },
  "scheduled-event.delete": { emoji: "🗑️", color: LOG_COLOR_RED, title: "حذف حدث" },
  "scheduled-event.update": { emoji: "✏️", color: LOG_COLOR_AMBER, title: "تعديل حدث" },
  "scheduled-event.start": { emoji: "▶️", color: LOG_COLOR_GREEN, title: "بدء حدث" },
  "scheduled-event.complete": { emoji: "⏹️", color: LOG_COLOR_RED, title: "انتهاء حدث" },
  "scheduled-event.user-add": { emoji: "🙋", color: LOG_COLOR_BLUE, title: "اشتراك في حدث" },
  "scheduled-event.user-remove": { emoji: "🙅", color: LOG_COLOR_AMBER, title: "إلغاء اشتراك" },

  /* integration-log — التكاملات */
  "integration.update": { emoji: "🔌", color: LOG_COLOR_AMBER, title: "تعديل تكامل" },
  "webhook.create": { emoji: "🪝", color: LOG_COLOR_GREEN, title: "إنشاء ويب هوك" },
  "webhook.delete": { emoji: "🗑️", color: LOG_COLOR_RED, title: "حذف ويب هوك" },
  "webhook.update": { emoji: "✏️", color: LOG_COLOR_AMBER, title: "تعديل ويب هوك" },
  "bot.join": { emoji: "📥", color: LOG_COLOR_GREEN, title: "إضافة بوت للسيرفر" },
  "bot.leave": { emoji: "📤", color: LOG_COLOR_RED, title: "إزالة بوت من السيرفر" },
  "bot.role-create": { emoji: "🤖", color: LOG_COLOR_GREEN, title: "إنشاء رتبة بوت" },
  "bot.role-remove": { emoji: "🗑️", color: LOG_COLOR_RED, title: "حذف رتبة بوت" },

  /* automod-log — الأوتو مود */
  "automod.rule-create": { emoji: "🤖", color: LOG_COLOR_GREEN, title: "إنشاء قاعدة أوتو مود" },
  "automod.rule-delete": { emoji: "🗑️", color: LOG_COLOR_RED, title: "حذف قاعدة أوتو مود" },
  "automod.rule-update": { emoji: "✏️", color: LOG_COLOR_AMBER, title: "تعديل قاعدة أوتو مود" },
  "automod.alert": { emoji: "🚨", color: LOG_COLOR_RED, title: "تنبيه أوتو مود" },
  "automod.block-message": { emoji: "🛑", color: LOG_COLOR_RED, title: "حجب محتوى تلقائياً" },
  "automod.timeout": { emoji: "⏳", color: LOG_COLOR_RED, title: "عزل تلقائي" },
  "automod.member-block": { emoji: "🚫", color: LOG_COLOR_RED, title: "حجب عضو تلقائياً" },

  /* platform-log — المنصة */
  "stage.create": { emoji: "🎙️", color: LOG_COLOR_GREEN, title: "إنشاء منصة صوتية" },
  "stage.delete": { emoji: "🗑️", color: LOG_COLOR_RED, title: "حذف منصة" },
  "stage.update": { emoji: "✏️", color: LOG_COLOR_AMBER, title: "تعديل منصة" },
  "stage.speaker": { emoji: "🗣️", color: LOG_COLOR_GREEN, title: "إضافة متحدث" },
  "stage.suppress": { emoji: "🔇", color: LOG_COLOR_RED, title: "إزالة متحدث" },
  "stage.request-speak": { emoji: "✋", color: LOG_COLOR_BLUE, title: "طلب التحدث" },

  /* bot-log — الداخلية (ويب هوك المطور فقط) */
  "bot.command-success": { emoji: "✅", color: LOG_COLOR_BLUE, title: "تنفيذ أمر" },
  "bot.command-failure": { emoji: "❌", color: LOG_COLOR_RED, title: "فشل أمر" },
  "bot.gateway-throttle": { emoji: "🚦", color: LOG_COLOR_AMBER, title: "تباطؤ Gateway" },
  "bot.security-rejection": { emoji: "🛡️", color: LOG_COLOR_RED, title: "رفض أمني" },
  "bot.health": { emoji: "💓", color: LOG_COLOR_BLUE, title: "نبضة البوت" },
  "security.invalid-role-attempt": { emoji: "🛡️", color: LOG_COLOR_RED, title: "محاولة صلاحية غير صالحة" },
  "security.hmac-invalid": { emoji: "🔐", color: LOG_COLOR_RED, title: "توقيع غير صالح" },
  "security.abnormal-request": { emoji: "🚨", color: LOG_COLOR_RED, title: "طلب شاذ" },
  "security.revoked-credential": { emoji: "🔒", color: LOG_COLOR_RED, title: "اعتماد مُلغى" },
  "security.audit-tamper": { emoji: "🚨", color: LOG_COLOR_RED, title: "عبث بسجل التدقيق" },
  "security.watchdog-down": { emoji: "💀", color: LOG_COLOR_RED, title: "سقوط المراقب" },
  "security.nuke-prevented": { emoji: "🛡️", color: LOG_COLOR_RED, title: "إحباط تخريب" }
};

/** The visual for an event id, with a severity-neutral fallback for unknowns. */
export function logVisualFor(eventId: string): LogVisual {
  return LOG_EVENT_VISUALS[eventId] ?? { emoji: "📄", color: LOG_COLOR_BLUE, title: eventId };
}

/** Arabic section labels, one per log destination. */
export const LOG_CATEGORY_LABELS: Record<LogDestination, string> = {
  "member-log": "الأعضاء",
  "role-log": "الرتب",
  "channel-log": "القنوات",
  "message-log": "الرسائل",
  "voice-log": "الصوت",
  "moderation-log": "الإشراف",
  "server-log": "السيرفر",
  "invite-log": "الدعوات",
  "expression-log": "الإيموجي والستيكرز",
  "event-log": "الأحداث",
  "integration-log": "التكاملات",
  "automod-log": "الأوتو مود",
  "platform-log": "المنصة",
  "bot-log": "داخلية"
};

/**
 * The Twemoji 72x72 PNG on jsDelivr for an emoji — Discord does not render SVG
 * embed thumbnails, so the raster set is the one that works. Codepoints follow
 * Twemoji's file naming (the variation selector FE0F is dropped).
 */
export function twemojiThumbnailUrl(emoji: string): string {
  const codepoints = [...emoji]
    .map(char => char.codePointAt(0)!.toString(16))
    .filter(code => code !== "fe0f")
    .join("-");
  return `https://cdn.jsdelivr.net/gh/jdecked/twemoji@15.1.0/assets/72x72/${codepoints}.png`;
}
