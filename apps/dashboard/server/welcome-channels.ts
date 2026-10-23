/**
 * The one rule a welcome message cannot bend: it needs somewhere to be sent.
 *
 * The route used to hold this inline, and it had two problems that only showed
 * up in production:
 *
 * - **A failed Discord read looked like a missing channel.** The channel list
 *   was loaded with `.catch(() => [])`, so a hiccup in the `/channels` call
 *   became "there are no channels", and every save was then rejected with
 *   "القناة غير موجودة" - blaming the operator for a channel that exists. The
 *   list is now described as *unreadable* and answered with 503, because the
 *   honest answer is "we could not check", not "the channel is gone".
 * - **Every rejection was the same sentence.** The caller could not tell which
 *   field to point at, so the screen could not either. The verdict names the
 *   field, and the route maps it to the answer the screen shows.
 *
 * Pure on purpose: the ids are handed in, so the rule is testable without a
 * database, a token or a network.
 */

export type WelcomeChannelSettings = {
  enabled: boolean;
  channelId: string | null;
  imageEnabled: boolean;
  imageMode: string;
  imageChannelId: string | null;
};

export type WelcomeChannelVerdict =
  | { ok: true }
  | { ok: false; code: "CHANNEL_LIST_UNAVAILABLE"; message: string }
  | { ok: false; code: "CHANNEL_NOT_FOUND"; field: "channel" | "imageChannel"; message: string };

const MISSING = {
  channel: "قناة الترحيب: اختر قناة أولاً.",
  imageChannel: "قناة الصورة: اختر قناة أولاً."
} as const;

const GONE = {
  channel: "قناة الترحيب: القناة المحفوظة لم تعد موجودة في السيرفر - اختر قناة أخرى.",
  imageChannel: "قناة الصورة: القناة المحفوظة لم تعد موجودة في السيرفر - اختر قناة أخرى."
} as const;

export function checkWelcomeChannels(
  settings: WelcomeChannelSettings,
  ids: ReadonlySet<string>,
  options: { listReadable: boolean }
): WelcomeChannelVerdict {
  if (!settings.enabled) return { ok: true };

  if (!options.listReadable) {
    return {
      ok: false,
      code: "CHANNEL_LIST_UNAVAILABLE",
      message: "تعذّر قراءة قنوات السيرفر من ديسكورد الآن، فلم يُحفظ شيء. أعد المحاولة بعد قليل."
    };
  }

  const check = (id: string | null, field: "channel" | "imageChannel"): WelcomeChannelVerdict | null => {
    if (!id) return { ok: false, code: "CHANNEL_NOT_FOUND", field, message: MISSING[field] };
    if (!ids.has(id)) return { ok: false, code: "CHANNEL_NOT_FOUND", field, message: GONE[field] };
    return null;
  };

  const welcome = check(settings.channelId, "channel");
  if (welcome) return welcome;

  // The image channel is only required when the card is sent *elsewhere*; with
  // the message it rides along, and there is nothing extra to validate.
  if (settings.imageEnabled && settings.imageMode === "separate_channel") {
    const image = check(settings.imageChannelId, "imageChannel");
    if (image) return image;
  }

  return { ok: true };
}
