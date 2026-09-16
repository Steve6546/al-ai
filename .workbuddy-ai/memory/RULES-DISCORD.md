# RULES-DISCORD — واجهة Discord وتصنيف الأخطاء ومنع 429

مرافق لـ`MEMORY.md`. اقرأه قبل أي نداء لـDiscord أو أي مسار يستدعيه.

## واجهة Discord
- **لا `@me` في مسار عضو السيرفر** (GET ⇒ 400/403): `/users/@me` ثم `/guilds/{id}/members/{botUserId}`.
  الاستثناء `PATCH .../members/@me`.
- **`permissions` = `0` لرمز بوت** حتى مع Administrator ⇒ ابنِها من `@everyone` (معرّفه = معرّف السيرفر) + أدوار
  العضو **وافحص 0x8 أولاً**. **«مجهول» ليس `false`:** `granted` ثلاثي.
- كل قراءة بـ`.catch(() => null)` تفشل **بصمت** ⇒ الاختبار يثبّت **شكل الطلب** لا النتيجة؛ والخطّاف يطابق
  بـ`includes` ⇒ رتّب الأكثر تحديداً أولاً.
- **النبذة عبر `PATCH /applications/@me {description}`**؛ `/users/@me {bio}` يُهمَل صامتاً بـ200.
  **`Presence Intent` ممنوع** (حوكمة 8).
- **🔴 الأحداث: `Events.*` لا نصّاً.** discord.js **يبعث بالقيمة** و**مفتاح ≠ قيمة**: `Events.GuildEmojiCreate`
  قيمته `emojiCreate` ⇒ `client.on("guildEmojiCreate")` **ميت**. **لا تستنتج «ميت» من نمط ثابت — شغّل السلوك.**
- **تغيير رتبة واحدة لكل نداء:** Discord يرفض **الطلب كله** إن كانت رتبة واحدة أعلى من البوت ⇒ نداء جماعي
  يُلغي الباقي بصمت. لهذا `applyRoleChange` تأخذ رتبة واحدة وتعيد `changed`/`failed`، و`NO_ROLE_APPLIED` إن لم
  يقع شيء. **ولا يمكن سؤال Discord أي الرتب أزالها البوت** ⇒ الحالة تُلتقط **قبل** التغيير في
  `guild_member_states.role_ids`، والتراجع يقرأ **اللقطة** لا الإعداد الحالي.

## تصنيف الأخطاء
- `isAuthFailure` **401 فقط** و`isRateLimited` **429 فقط** — قبلها كل خطأ صار «توكن منتهٍ» ⇒ 429 يُتلف جلسة.
- `loadUserGuilds` **المصدر الوحيد** لسيرفرات المستخدم: 401 ⇒ إتلاف + `SESSION_EXPIRED`؛ 429 ⇒ `429
  RATE_LIMITED` + `retry-after` **والجلسة سليمة**؛ غير ذلك ⇒ 503. نداء مباشر جديد لـ`fetchUserGuilds` يُسقط
  `route-guards.test.ts`. و`/api/guilds` بـ**`Promise.allSettled`** (لا كتابة في `reply` بعد الرد).

## منع 429
- **الانفجار نفسه هو المشكلة**، **وحدّ Discord لكل تطبيق لا لكل مسار.** `TtlCache.resolve(key, load)`
  **تدمج الطلبات الجارية** (نداء ثانٍ ينتظر الوعد القائم — **هذا ما يقتل الانفجار لا الـTTL**).
  **`fetchBotMemberShared` بلا TTL عن قصد.**
