# AL AI — مشروع Discord bot + لوحة تحكم

Monorepo: `apps/bot` (discord.js) + `apps/dashboard` (Fastify BFF + React SPA RTL)
+ `packages/core` (المصدر الوحيد لكل عقد مشترك).

## الأوامر والتحقق
- `npm run verify` = lint + check:schema + test + build. استخدمه دائماً بدل تشغيل
  الخطوات يدوياً. **363 اختباراً** (166 بوت + 100 لوحة + 97 core).
- **9 اختبارات لوحة «تتخطى بصمت» بلا قاعدة بيانات.** `test/storage.test.ts` يقرأ
  `DATABASE_URL` وإن لم يجد قاعدة حيّة يسجّل `{ skip: "no reachable database" }`،
  فيُخرج `verify` **330 نجاحاً + 9 تخطٍّ** بدل 339. هذا ليس فشلاً، لكنه يعني أن
  «339/339 ناجحاً» **لا يتحقق إلا وPostgreSQL شغّالة على 55432**. شغّل القاعدة قبل
  أي ادّعاء عن نسبة النجاح، واقرأ `# skipped` في المخرجات لا `# pass` وحدها.
- `npm run check:schema` يحلّل `infra/schema.sql` بمحلّل PostgreSQL حقيقي
  (`pgsql-ast-parser`). أسرع من الترحيل الفعلي، ويبقى مفيداً كفحص نحوي.
- `apps/dashboard` لا يحمّل `.env` بنفسه. شغّله بـ:
  `cd apps/dashboard && ../../node_modules/.bin/tsx --env-file=../../.env server/index.ts`
  (البوت يحمّله عبر `import "dotenv/config"`). استخدم مسار `tsx` المحلي مباشرة —
  `npx tsx` يضيف عملية وسيطة تكلّف ~70MB لكل خدمة.
- **`node server/index.ts` مباشرة لا يعمل** (Node 22.22 مع `process.features.typescript
  === "strip"`): الكود يستورد `./env.js` والملف `env.ts`، وNode لا يعيد كتابة
  الامتداد — هذه ميزة tsx/esbuild لا ميزة type-stripping. فلا بد من tsx أو بناء
  فعلي بـ`tsc`.
- **للتشغيل الكامل:** PostgreSQL (مهمة خلفية) → اللوحة (مهمة خلفية) → البوت.
  أو `npm run dev:dashboard` / `npm run dev:bot`.

## Discord API — مصائد صامتة (كلّفتنا 3 ميزات ميتة)
- **لا يوجد اختصار `@me` في مسار عضو السيرفر.** `GET /guilds/{id}/members/@me`
  يُرجع **400** `NUMBER_TYPE_COERCE`، و`GET /users/@me/guilds/{id}/member` يُرجع
  **403** `"Bots cannot use this endpoint"` (خاص بـOAuth2).
  الصحيح لرمز بوت: احلّ معرّف البوت من `GET /users/@me` ثم
  `GET /guilds/{id}/members/{botUserId}` — وهذا يعطي **الأدوار والصلاحيات معاً**.
- **حقل `permissions` في كائن العضو يُرجع `0` لرمز بوت** حتى لبوت يملك
  Administrator. لا تعتمد عليه: ابنِ الصلاحيات الأساسية باتحاد `@everyone`
  + أدوار العضو (`computeBasePermissions`).
- **Administrator (0x8) يتقدّم على كل صلاحية** ولا يتوسّع إلى البتات التي يعنيها.
  أي فحص بتّي ساذج يقول «مفقودة» لبوت يملك Administrator. افحص 0x8 أولاً
  (`hasPermission`).
- **الدرس العام:** أي قراءة Discord تُغلَّف بـ`.catch(() => null)` تفشل بصمت —
  لا انهيار ولا سجل، الميزة تصمت للأبد. لذلك `apps/dashboard/test/discord.test.ts`
  يثبّت **شكل الطلب** نفسه (الـURL)، لا النتيجة فقط.
- **«مجهول» ليس `false`:** `PermissionStatus.granted` ثلاثي القيمة
  (`boolean | null`). `null` = تعذّرت القراءة. تحويله إلى `false` يرفض عملية
  يستطيع البوت تنفيذها. مسار الكتابة يرفض فقط عند `false` مؤكدة.

- **الأفاتار/الأيقونة المتحركة:** تجزئة تبدأ بـ`a_` تعني صورة متحركة، وطلبها
  `.png` يعطي **الإطار الأول صامتاً** بلا خطأ. `assetExtension(hash)` تُرجع `gif`،
  والحجم الافتراضي 128. لا تُرجع إلى 64 ولا تُثبّت الامتداد.
- **دعوة البوت رحلة ذهاب وعودة، لا رابط أعمى:** `buildBotInviteUrl` تحمل
  `response_type=code` + `redirect_uri` + `state` (كوكي CSRF يُكتب قبل الدعوة
  ويُتحقق عند العودة). الـcallback يقبل `guild_id`، يُبطل كاش سيرفرات البوت
  (`invalidateBotGuildCache`)، ويحوّل إلى `/?auth=bot_added` فيرجع المشغّل للقائمة.

## تصنيف أخطاء Discord — غيابه كان يُتلف الجلسات
- `DiscordApiError` (في `apps/dashboard/server/discord.ts`) تحمل `status` و
  `retryAfterSeconds`، ومصنّفان صريحان: `isAuthFailure` (**401 فقط**) و
  `isRateLimited` (**429 فقط**). **قبل ذلك كان كل خطأ Discord يُعامل «توكن منتهٍ»**
  ⇒ حدّ المعدل (429) يُتلِف جلسة سليمة ويُرمي المشغّل لشاشة الدخول بلا سبب. كان هذا
  أصل «الجليتش عند تكرار التحديث»: كل تحديث = نداءان = 429 أسرع = إتلاف = دخول.
- `loadUserGuilds` هي **المصدر الوحيد** لقرار قائمة سيرفرات المستخدم:
  401 ⇒ إتلاف + `SESSION_EXPIRED`، 429 ⇒ `429 RATE_LIMITED` + ترويسة `retry-after`
  **والجلسة سليمة**، غير ذلك ⇒ `503 DISCORD_UNAVAILABLE`.
- `/api/guilds` يستخدم **`Promise.allSettled` لا `Promise.all`**: فشل نداء ثانوي
  (كاش سيرفرات البوت) يجب ألا يُسقط المسار كله ولا يكتب في `reply` بعد الرد
  (`FST_ERR_REP_ALREADY_SENT`). خُذ `const guildList = userGuilds.value;` قبل
  الاستخدام ليقبل TypeScript التضييق.
- `fetchBotGuildIds` مكاشفة **15 ثانية** مع **دمج الطلبات الجارية**
  (`botGuildInFlight`) و«القديم أفضل من الخطأ» عند فشل التحديث. العميل
  (`src/api/client.ts`) يعيد المحاولة **مرة واحدة بالضبط** بعد
  `min(retry_after*1000, 5000)`.

## قواعد معمارية يفرضها المشروع
- `discord.js` يُستورد في ملف واحد فقط: `apps/bot/src/lib/discord.ts`.
  (GOVERNANCE rule 2)
- معالج الأوامر في `apps/bot/src/index.ts` **لا يسجّل العقوبات** — الـ gateway
  يسجّلها مرة واحدة من audit log. تسجيلها هنا ينتج مدخلين لفعل واحد.
  الاستثناء: `moderation.warn` و`moderation.clearwarns` لأنهما سجلان لا تعديل Discord.
- السبب (reason) يُقرأ من `AuditLogEntry.reason` في `createActorResolver`،
  لا من خيار الأمر.
- `config/channels.json` يجب أن يطابق السكيما **بالضبط** وإلا رفض البوت الإقلاع
  (GOVERNANCE rule 15). أضف حدثاً → حدّث الملف + `channels.json` معاً.
- `command-registry.ts` هو سلطة الأوامر: أمر غير مسجّل يُرفض قبل أي نداء Discord.
  كل أمر مُسجَّل **يجب** أن يكون له builder في `buildModerationCommands`.
- مفتاح تكوين غير مدعوم لأمر ما يُجبَر على القيمة الافتراضية في
  `normaliseCommandConfig` — لا تُخزّن مفتاحاً لا يفعل شيئاً.
- **ملكية البيانات:** البوت يملك `guilds.member_count` و`ping_ms`؛ اللوحة تبذر
  الصف فقط (`ensureGuild` = `ON CONFLICT DO NOTHING`). لا تستخدم `upsertGuild`
  من اللوحة — كان يصفّر العدد عند كل فتح.
- **لا تعرض رقماً لا تعرفه:** `pingMs`/`online` تُشتق من نبضة حديثة، لا من وجود
  توكن. `members.online` من ودجت السيرفر فقط (قاعدة 8 تمنع `GUILD_PRESENCES`).
- **محرّك مضاد التخريب مُسلَّح افتراضياً** (`enabled: true` في core وفي السكيما).
  تغيير الـdefault **لا يعيد كتابة الصفوف**، فمن أطفأه عمداً يبقى مطفيّاً.
  `normaliseEnabled` تُبقي `false` صريحاً في كل الأشكال.
- **`CREATE TABLE IF NOT EXISTS` لا يُحدِّث default قائماً** — أي قلب لافتراضي
  يحتاج `ALTER TABLE ... ALTER COLUMN ... SET DEFAULT` صريحاً في `infra/schema.sql`.
- **كل مسار مرتبط بسيرفر يجب أن يتحقق من الوصول للسيرفر نفسه، لا من الجلسة فقط.**
  `requireGuildAccess` للقراءة، `requireTierForGuild` للكتابة. معرّف السيرفر ليس
  سراً (في كل رابط دعوة)، فـ`requireSession` وحده يعني أن أي حساب مسجَّل يقرأ
  أي سيرفر بلصق معرّفه. `test/route-guards.test.ts` يفحص جدول المسارات نصياً
  لأن نمط الفشل **استدعاء غائب** لا نتيجة خاطئة.
- **التوكن المرفوض من Discord = جلسة منتهية (401)، لا عطل خادم (500).**
  `loadUserGuilds` هي المصدر الوحيد لقراءة قائمة سيرفرات المستخدم: تُتلف الجلسة
  وتُفرِّغ الكوكي وترد `SESSION_EXPIRED`. كان `/api/guilds` ينادي
  `fetchUserGuilds` مباشرة ⇒ 500 **مع إبقاء الجلسة حيّة**، والمشغّل يرى «خطأ غير
  متوقع» عند كل تحميل بلا طريق للخروج. أي نداء مباشر جديد للدالة الخام يُسقط
  اختبار `route-guards.test.ts`. **وهذا لا يشمل 429** — انظر «تصنيف أخطاء Discord»
  أعلاه: 429 لا يُتلف الجلسة.

## اللوحة
- `types.ts` يُعيد تصدير كل عقد مشترك من `@al-ai/core/browser`؛ لا تُكرّر شكلاً
  موجوداً في core (سبب انحراف سابق: `CommandFlag` كان معرّفاً في مكانين).
- `logCategories` تُشتق من `eventsByCategory` لا تُكتب يدوياً.
- `bot-log` وجهة داخلية: لا تظهر للمشغّل ولا يمكن ربطها بقناة. الـ BFF يفلترها
  عبر `normaliseCategoryChannels`.
- المنطق القابل للاختبار يُستخرج إلى دوال نقية في `@al-ai/core`
  (`deriveBotStatus`, `summarisePunishments`, `assessRoleHierarchy`,
  `assessRoleIconGate`, `assessNukeAction`) بدل حقنه في المسار.
- **`notice` (داخل اللوحة) و`authNotice` (شاشة الدخول) منفصلان عمداً.** خلطهما
  يُظهر «لا تملك صلاحية الوصول إلى هذا السيرفر» **على شاشة الدخول** — وهو عطل
  رآه المستخدم فعلاً. `LoginScreen notice={authNotice ?? error}`.
- **`--primary` يجب أن يبقى نيلياً** `oklch(0.511 0.262 276.966)`. كان
  `oklch(0.922 0 0)` (شبه أبيض) فبدا زر الدخول **صندوقاً أبيض يُقرأ كنص مكتوب**
  لا كزر — وهذا ما شكا منه المستخدم («ليش يطلع مثل نص مكتوب تسجيل دخول؟»).
  عند تعديل الثيم، تحقّق أن الـCSS المبني لا يحوي `oklch(.922 0 0)`.

## البيئة (Windows)
- PostgreSQL 17 في `C:\Program Files\PostgreSQL\17`. نسخة المشروع: data dir
  `C:\Users\dlwta\.al-ai\pgdata` (خارج المستودع)، منفذ **55432**.
- **القاعدة تعمل.** ما كان يُظن قيداً على مستوى النظام هو في الحقيقة:
  `pg_ctl start` يُشغّل عملية فرعية يقتلها الـ sandbox عند انتهاء أمر Bash.
  **الحل: شغّل `postgres.exe` كمهمة خلفية** (`run_in_background: true`).
  الإقلاع يستغرق ~30 ثانية (fsync) و`pg_isready` يقول "rejecting" خلالها.
- المنفذ 5432 مشغول بتثبيت PostgreSQL آخر للمستخدم — **لا تلمسه**.
- **`psql` يتعلّق بلا `-w` و`< /dev/null`** في Git Bash (يُقتل بـSIGTERM بلا مخرجات).
- Docker CLI موجود لكن الـ daemon متوقف؛ WSL محجوب بسياسة أمنية (Program Blacklist).
- `/tmp` في Git Bash يترجم إلى `C:\tmp` لـ node — استخدم مساراً داخل المشروع
  عند تمرير ملف إلى node.
- `scripts/dev-issue-session.mts` يصدر جلسة حقيقية لفحص المسارات المحمية.
  **يجب أن يكون `.mts`** (الجذر بلا `"type": "module"` فـ`.ts` يُترجم CJS).
  مسارات **الكتابة** لا تُفحص به لأنها تحتاج توكن OAuth حقيقي.
  **التوكن المزروع وهمي (`probe-token`)** ⇒ كل مسار يقرأ من Discord يُرجع
  `401 SESSION_EXPIRED` ويحذف الجلسة. مفيد لإثبات أن الحارس يعمل (كان `200`
  قبل إصلاح §2)، لكن **لا يمكن الوصول إلى `403 NOT_A_MEMBER` به** — لذلك يحتاج
  التوكن الحقيقي.
- **ملفات `.workbuddy-ai/memory/*.md` مُتتبَّعة ومرفوعة إلى المستودع العام**
  (`Steve6546/al-ai`). لا أسرار فيها، لكنها ملاحظات داخلية — أُبلغ المستخدم.
