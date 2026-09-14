# AL AI — مشروع Discord bot + لوحة تحكم

Monorepo: `apps/bot` (discord.js) + `apps/dashboard` (Fastify BFF + React SPA RTL)
+ `packages/core` (المصدر الوحيد لكل عقد مشترك).

## الأوامر والتحقق
- `npm run verify` = lint + check:schema + test + build. استخدمه دائماً.
  حالياً **457 اختباراً** (158 بوت + 171 لوحة + 128 core).
- **اقرأ `# skipped` لا `# pass`.** `dashboard/test/storage.test.ts` يسجّل
  `{ skip: "no reachable database" }` بلا قاعدة حيّة، و`verify` يرجع **exit 0**
  رغم ذلك. شغّل PostgreSQL على 55432 قبل أي ادّعاء عن النجاح.
- **تشغيل اللوحة** (`apps/dashboard` لا يحمّل `.env` بنفسه):
  `cd apps/dashboard && ../../node_modules/.bin/tsx --env-file=../../.env server/index.ts`
  (البوت يحمّله عبر `import "dotenv/config"`). مسار `tsx` المحلي مباشرة —
  `npx tsx` يضيف عملية وسيطة تكلّف ~70MB لكل خدمة.
- **`node server/index.ts` مباشرة لا يعمل** (Node 22.22 `typescript === "strip"`):
  الكود يستورد `./env.js` والملف `env.ts` — هذه ميزة tsx/esbuild لا type-stripping.
- **`tsx` لا يعيد التحميل الحارّ.** حرّر كود الخادم ⇒ أعد تشغيل العملية وإلا
  خدّمت المسارات القديمة (الجديدة ترجع 404) وأنت تظن أن الإصلاح لم ينجح.
- `check:schema` فحص نحوي سريع بـ`pgsql-ast-parser`، وليس بديلاً عن الترحيل الفعلي.
  **لفحص تخزين حقيقي:** ملف `.mts` مؤقت في `apps/dashboard/test/` يستدعي
  `createDatabase(createPool(process.env.DATABASE_URL!))`. لاحظ أن
  `db.getBotIdentity` **methods على الكائن لا exports على المديول**.

## ⚠️ عرض الملفات على المستخدم
- **تجاوز الخطّافات والنصوص المُبرمَجة لا يعرض الملف.** لعرض ملف: استدعِ
  `present_files` بمسار **مطلق** عند **كل** تسليم. بدونها لا يرى المستخدم شيئاً.
  استدعاء واحد بأولوية عرض، بعد انتهاء العمل — لا لملف قرأته ولا لنتيجة جزئية.
- **إثبات أن الواجهة وصلت المستخدم:** `grep` المخرجات الجديدة على
  `dist/assets/index-*.js` **وعلى الحزمة المخدومة** `GET /assets/…` من الخادم الحيّ.
  المصدر النظيف لا يعني أن الحزمة المخدومة حديثة.

## 🔴 مخاطر المستودع — اقرأ هذا أولاً
`.git` في هذا المشروع **مشترك مع مشروع آخر تماماً**، وفيه فخّان أتلفا عملاً فعلاً:
- **ريموتان في `.git/config`:** `origin` → `Steve6546/al-ai` (مشروعنا) و
  **`glyph-agent` → `Steve6546/glyph-weaver-forge`** (مشروع آخر، `main = 4fdbe11`).
  هذا الخلط جعل مخزن الكائنات يبدو «تالفاً» من منظور AL AI.
- **⛔ لا `git rm`.** `git rm -f` على **ملف واحد** جرّ 46 ملفاً متعقَّباً وأتلف
  **4 ملفات غير متعقَّبة نهائياً** (لا `stash` ولا `fsck --lost-found` يعيدها —
  الملفات غير المتعقَّبة لا نسخة لها في أي مكان).
  1. احذف بـ`rm` عادي، وافحص `git status` **قبل** أن تكمل.
  2. **`git add -A` قبل أي حذف** — لو كان الملف مُفهرَساً لاستُعيد.
  3. `git checkout -- <dir>` يستعيد المتعقَّب **لحالة HEAD لا لحالتك المحسّنة**.
- **⛔ لا `git stash`.** `git stash push -- <ملف>` **أتلف مخزن الكائنات**:
  `HEAD` صار غير قابل للحلّ، و`refs/heads/` اختفى، و**88 blob مفقوداً**، مع بقاء
  `pack-*.idx` **بلا `.pack`** بجانبه. (لم يُفقد أي ملف مصدر — شجرة العمل والريموت
  سلِيمان.)
  **لإثبات أن اختباراً يكشف انحداراً:** انسخ الملف إلى `.workbuddy-ai/` بدل تخزينه.
- **إصلاح مخزن كائنات معطوب** (نجح فعلاً؛ `git fetch` العادي **يفشل** بـ
  `error: Could not read <sha>` لأن التفاوض يمشي على الرسم البياني المحلي المعطوب):
  1. احذف `*.idx` اليتيم و`multi-pack-index` من `.git/objects/pack/`.
  2. `git init --bare` **في مستودع منفصل نظيف**، ثم
     `git fetch https://github.com/Steve6546/al-ai.git +refs/heads/main:refs/heads/main`
     ⇒ التاريخ الكامل يقرأ حتى الجذر.
  3. انسخ `pack-*.pack` و`pack-*.idx` إلى `.git/objects/pack/` في المشروع.
  4. تحقّق: `git fsck` **صامت**، و`git ls-files -s | while read ...` بلا أي missing.
- **مراجع التتبّع لا تُحفظ هنا.** `git fetch` و`git update-ref` يطبعان نجاحاً
  ويخرجان 0، لكن `packed-refs` يبقى على قيمة قديمة. الأثر: `git status` يقول
  «ahead N» بعد دفع ناجح.
  - **التحقق من الدفع بـ`git ls-remote origin refs/heads/main` — لا بـ`git status`.**
  - **العملية التي تنجح:** `mkdir -p .git/refs/remotes/origin` و
    `printf '<sha>\n' > .git/refs/remotes/origin/main`، **آخر شيء** ولا تشغّل أي
    أمر git بعده (أي `git update-ref` لاحق **يحذف** المرجع المكتوب يدوياً).
    تحقّق بـ`git rev-parse refs/remotes/origin/main` لا بـ`cat`.
  - **`git push` عبر HTTPS قد يتعلّق أبداً على مطالبة بيانات الاعتماد** ويُقتل
    بـ`SIGTERM` بلا مخرجات. الإصلاح: `gh auth setup-git` مرة واحدة ثم ادفع.

## Discord API — مصائد صامتة (كلّفتنا 3 ميزات ميتة)
- **لا يوجد اختصار `@me` في مسار عضو السيرفر.** `GET /guilds/{id}/members/@me`
  ⇒ **400** `NUMBER_TYPE_COERCE`، و`GET /users/@me/guilds/{id}/member` ⇒ **403**
  `"Bots cannot use this endpoint"` (خاص بـOAuth2). الصحيح لرمز بوت: احلّ معرّف
  البوت من `GET /users/@me` ثم `GET /guilds/{id}/members/{botUserId}` — وهذا يعطي
  **الأدوار والصلاحيات معاً**.
- **حقل `permissions` في كائن العضو يُرجع `0` لرمز بوت** حتى مع Administrator.
  ابنِ الصلاحيات من اتحاد `@everyone` + أدوار العضو (`computeBasePermissions`).
- **Administrator (0x8) يتقدّم على كل صلاحية** — أي فحص بتّي ساذج يقول «مفقودة».
  افحص 0x8 أولاً (`hasPermission`).
- **«مجهول» ليس `false`:** `PermissionStatus.granted` ثلاثي القيمة. `null` = تعذّرت
  القراءة، وتحويله إلى `false` يرفض عملية يستطيع البوت تنفيذها.
- **الدروس العام:** كل قراءة Discord تُغلَّف بـ`.catch(() => null)` تفشل **بصمت**،
  لذلك `test/discord.test.ts` يثبّت **شكل الطلب** (الـURL) لا النتيجة فقط.
  **وخطّاف الاختبار يطابق بـ`includes`** ⇒ مسار `/guilds/{id}` العاري يبتلع
  `/guilds/{id}/channels` (`channels.filter is not a function`). رتّب الأكثر
  تحديداً أولاً.
- **الأفاتار المتحرك:** تجزئة `a_` ⇒ طلبها `.png` يعطي **الإطار الأول صامتاً**.
  `assetExtension(hash)` تُرجع `gif`، والحجم الافتراضي 128.
- **دعوة البوت رحلة ذهاب وعودة** لا رابط أعمى: `response_type=code` +
  `redirect_uri` + `state` (كوكي CSRF)، والـcallback يُبطل `invalidateBotGuildCache`.
- **`Presence Intent` ممنوع** (حوكمة 8) و`AL_AI_INTENTS` لا يطلبه. **لا تُفعّله** في
  بوابة المطوّر وإن طُلب منك — يوسّع سطح البيانات بلا فائدة.

## تصنيف أخطاء Discord — غيابه كان يُتلف الجلسات
- `DiscordApiError` (في `server/discord.ts`) تحمل `status` و`retryAfterSeconds`،
  ومصنّفان صريحان: `isAuthFailure` (**401 فقط**) و`isRateLimited` (**429 فقط**).
  **قبل ذلك كان كل خطأ يُعامل «توكن منتهٍ»** ⇒ 429 يُتلِف جلسة سليمة.
- `loadUserGuilds` هي **المصدر الوحيد** لقائمة سيرفرات المستخدم: 401 ⇒ إتلاف +
  `SESSION_EXPIRED`، 429 ⇒ `429 RATE_LIMITED` + `retry-after` **والجلسة سليمة**،
  غير ذلك ⇒ `503 DISCORD_UNAVAILABLE`. أي نداء مباشر جديد لـ`fetchUserGuilds`
  يُسقط `route-guards.test.ts`.
- `/api/guilds` يستخدم **`Promise.allSettled` لا `Promise.all`** (فشل نداء ثانوي
  يجب ألا يُسقط المسار كله ولا يكتب في `reply` بعد الرد ⇒ `FST_ERR_REP_ALREADY_SENT`).
  خُذ `const list = x.value;` قبل الاستخدام ليقبل TypeScript التضييق.

## منع 429 — كاش + دمج + خنّاق (الوضع مُصلَح ومُتحقَّق)
`apps/dashboard/server/cache.ts`. إعادة المحاولة في العميل وحدها لا تكفي — الانفجار
نفسه هو المشكلة (ثلاث تابات = 3 نداءات متطابقة في اللحظة نفسها).
- **`TtlCache.resolve(key, load)`**: إصابة طازجة، **دمج الطلبات الجارية** (نداء ثانٍ
  ينتظر الوعد القائم — **هذا ما يقتل الانفجار لا الـTTL**)، «القديم أفضل من الخطأ»،
  و`finally` تُحرّر خانة الـin-flight (بدونها يُسمّم أول فشل كل النداءات اللاحقة).
- **فخّ يتكرّر: الكاش على النتيجة المُحوَّلة لا على القراءة الخام المشتركة.** شاشة
  تخصيص واحدة كلّفت **7 نداءات**، ثلاثة منها `/guilds/{id}/roles` **متطابقة**، لأن
  كل مستهلك (فحص الصلاحيات، الهرم، منتقي الرتب، أعلى رتبة) قرأها بنفسه. الإصلاح
  `guildRoleListCache` + `fetchGuildRoleList` ⇒ **5 نداءات، كل نقطة مرة واحدة**.
  **القاعدة: كاش على الحمولة الخام، وكل مستهلك يُسقط عليها سؤاله.**
- **المذكرة على الوعد لا على النتيجة.** `if (cached) return cached` **لا يمنع**
  نداءين في نفس التكة من كلٍّ رؤية `null`. أمسك الوعد (`botUserIdInFlight`) وحرّره
  في `finally` (وعد مرفوض محتفَظ به يسمّم كل نداء لاحق للأبد).
- **كائن العضو: دمج بلا TTL عن قصد** (`fetchBotMemberShared`). هو يجيب فحص الصلاحية
  على **مسار كتابة**، وبتة قديمة تحوّل «البوت فقد الصلاحية» إلى «البوت يملكها».
- `GUILD_READ_CACHE_MS = 45_000` / `BOT_GUILD_CACHE_MS = 15_000`.
  **`invalidateGuildReadCache(guildId)` بعد أي كتابة** وإلا بقي العرض قديماً 45 ثانية.
  `resetGuildReadCaches()` منفذ اختبار — **نادِه في `beforeEach`** وإلا تسرّبت
  الحالة بين الاختبارات. (سقوط اختبار فور إدخال كاش جديد = **سببه الكاش غالباً**،
  والاختبار محقّ. صلّح الكاش لا التأكيد.)
- **`RequestThrottle` نافذة منزلقة لا ثابتة** — الثابتة تسمح بضعف الحصة عبر حدّها.
- الخطّاف يستثني الجلسات الموثَّقة و`/internal/`. **ليس ثغرة:** كوكي مزوّر يعطي
  `401 UNAUTHENTICATED` — افحص الرقم الثالث دائماً.

## عقود المسارات — مفتاح ردّ لا يقرأه أحد = عطل صامت
- **كل مسار إعدادات يجيب `{ settings, ... }`.** لا استثناء ولا اسم بديل.
  `GET/PUT /api/bot/identity` أجابا `{ identity }` بينما العميل يقرأ `result.settings`
  ⇒ المسودة بقيت `null` ⇒ **شاشة سوداء** على `Object.keys(null)`. الحالة كانت
  **200 سليمة** تحمل مفتاحاً لا يقرأه أحد: لا 500، ولا سطر في السجل.
- **أي انحراف بين اسم مفتاح الخادم وحقل العميل يظهر كخطأ عميل لا كخطأ خادم.**
  عند إضافة مسار: افتح `src/api/client.ts` وطابق الاسم حرفياً.

## محرّك الأوامر
- **`CommandCategory`** = `moderation | channels | general` (كان `CommandModule`).
  `/al-status` **داخل السجل الآن** — كان يتجاوز خط أنابيب التكوين كله.
- **كل قسم مُبوَّب على راية قدرة حقيقية** (`supportsReason`, `supportsDuration`,
  `maxDurationSeconds`, `supportsPurge`, `supportsNotify`). لا تعرض مفتاحاً لا
  يستطيع الأمر تنفيذه.
- **المدد الـ11:** `permanent/5m/30m/1h/6h/12h/1d/3d/7d/14d/30d`.
  **`permanent` قيمته `null` لا `0`** — الصفر يُقرأ «بلا مدة» فينهار إلى ثانية.
  `TIMEOUT_MAX_SECONDS` (28 يوماً) تُقصّ **عند التحويل إلى ثوانٍ فقط**.
- `CommandConfig`: `allowedRoleIds` (كان `customRoleIds`)، `deniedRoleIds`،
  `allowedChannelIds`، `deniedChannelIds`، `cooldownSeconds`،
  `autoDeleteResponseSeconds`، `requireReason`، `defaultDuration`، `presetReasons`.
- `assessCommandScope`: **المنع يتقدّم على السماح** في الرتب والقنوات معاً.
- **⛔ لا تفرض في Discord ما يجب أن يقرّره المشغّل.** `required` في خيار Slash
  **يُجمَّد وقت التسجيل** ⇒ يجعل الإعداد **باتجاه واحد**. خيار السبب و`minutes`
  غير مطلوبَين أبداً. الفرض في البوت.
- `command-registry.ts` هو سلطة الأوامر؛ كل أمر مُسجَّل **يجب** أن يكون له builder
  في `buildModerationCommands`. ومفتاح غير مدعوم يُجبَر على الافتراضي في
  `normaliseCommandConfig`.
- `config/channels.json` يجب أن يطابق السكيما **بالضبط** وإلا رفض البوت الإقلاع
  (rule 15). أضف حدثاً → حدّث الملفَين معاً.

## تخصيص البوت — نطاقان + كاتب واحد
- **الهوية العامة** في `bot_identity` (صف واحد، `id BOOLEAN PRIMARY KEY CHECK (id)`)
  = أفاتار/بانر/نبذة + **الحالة والنشاط**. **هوية لكل سيرفر** في
  `guild_customization` = اسم مستعار/لون رتبة/أيقونة رتبة.
- **اللوحة هي الكاتب الوحيد لكل حقل ظهور، والبوت لا يكتب الظهور إطلاقاً** —
  كتابته الوحيدة **النبضة عبر الـgateway** (`presence-sync.ts`، كل 15 ثانية؛
  `customization-sync.ts` **حُذف**). مثبَّت في `governance.test.ts`.
- **`server/appearance.ts` هو الكاتب الوحيد في اللوحة:** `PATCH /guilds/{id}/members/`
  (الاسم)، `/guilds/{id}/roles/{role}` (اللون والأيقونة)، `/users/@me` (الأفاتار
  والبانر)، `/applications/@me` (النبذة). **النبضة لا تُكتب هنا.**
- **`FieldOutcome` تُبلَّغ لكل حقل ولا تُبلع أبداً.** الحفظ يحدث **حتى لو رفض
  Discord** — والرد يفصل «محفوظ» عن «منفّذ» صراحةً. جوهر «محفوظ ≠ منفّذ».
- **`changedAppearanceFields` ترسل المتغيّر فقط**؛ مسح قيمة يُحتسب تغييراً والنبضة
  مستثناة. **`resolveRoleIcon()`** تمرّر `data:` كما هي وتجلب `https:` فقط
  (`undefined` = اتركها).
- **أرسل قيمة فشلت التحقق كـ400 لا كـ`null` صامت** — الصمت يمحو صورة أراد
  المشغّل استبدالها ويبدو النموذج محفوظاً.
- **الشاشة بعمودين:** النموذج (`الهوية العالمية` + `هذا السيرفر فقط` + الصلاحيات)،
  وعمود لاصق (`lg:sticky`) يحمل `ImageCropper` و`BotLivePreview`. النطاقان
  **يُحفظان بمسارين ويُبلَّغان منفصلين** لأن لكل نطاق كاتباً مختلفاً.
- **`dirty` بمقارنة حقلاً حقلاً لا `JSON.stringify`** — ترتيب المفاتيح وحده يجعل
  نموذجاً لم يُلمس يبدو معدّلاً فيظهر شريط التحذير بلا سبب.
- `MAX_IMAGE_DATA_URL_LENGTH = 500_000`، `IMAGE_TARGET_SIZES = { avatar: 256×256,
  banner: 600×240, roleIcon: 128×128 }`، `BOT_ROLE_NAME = "AL AI"`،
  `MAX_BIO_LENGTH = 400`، `MAX_ACTIVITY_TEXT_LENGTH = 128`.
- أدوات الواجهة **بلا اعتماديات خارجية**: `image-cropper.tsx` (Canvas)،
  `color-picker.tsx` (HSV)، `toaster.tsx` (الفشل `role="alert"` ولا يختفي)،
  `bot-preview.tsx` (معاينة حيّة) — كلها في `src/components/` و`src/views/settings/`.

### ⚠️ تحويل HSV كان يُبدّل لون المشغّل بصمت (أُصلح 2026-09-14)
`hsvToRgb` استخدم `(h / 60) % 6` بلا التفاف، و`rgbToHsv` كان **يقرّب الدرجة إلى عدد
صحيح**. المنتقي يستدعي `rgbToHsv` لتغذية حالته ⇒ المشغّل يضغط لون Discord ثم يحرّك
التشبّع فيحصل على **لون آخر**: 8 من 20 سواش لم تنجُ، و`#e74c3c`→`#e74d3c`.
الإصلاح: `((h % 360) + 360) % 360`، وترك الدرجة **بلا تقريب**.
الاختبار الحارس: كل `DISCORD_ROLE_SWATCHES` تنجو من `rgbToHex(hsvToRgb(rgbToHsv(x)))`.
**`#e91e63` لا يمكن الوصول إليها من درجة 340** ⇒ أكّد على **ثبات الدورة** لا على قيمة
حدسية. و`hsvToRgb(rgb)` بوسيط خاطئ يعطي `#NaNNaNNaN` بدل خطأ.

## ⚠️ فخّ ترتيب الترحيل: `ADD COLUMN` قبل حارس `RENAME` يُبطله **بصمت**
`ADD COLUMN IF NOT EXISTS allowed_role_ids` **قبل** كتلة إعادة التسمية المحروسة
يعني أن العمود موجود حين يُقيَّم الشرط، **فيُتخطّى `RENAME COLUMN` ويبقى
`custom_role_ids` يتيماً وقوائم السماح مُتجاهَلة — بلا أي خطأ.** الترتيب **حمولة
(load-bearing) لا تنظيم**. الإصلاح: التسمية أولاً، ثم `ADD COLUMN`، ثم كتلة إصلاح.
**الفحص الوحيد الذي يلتقط هذا هو قاعدة جديدة من الصفر** — إعادة التطبيق على قاعدة
سليمة تنجح دائماً ولا تكشف شيئاً.
- `CREATE TABLE IF NOT EXISTS` **لا يُحدِّث default قائماً** — قلب افتراضي يحتاج
  `ALTER TABLE ... ALTER COLUMN ... SET DEFAULT` صريحاً.
- **`FOR EACH ROW` لا يعمل على `TRUNCATE`** (عبارة statement) ولا على جدول فارغ.
  جدول «append-only» يحتاج مشغّلاً ثانياً `BEFORE TRUNCATE ... FOR EACH STATEMENT`
  مع `REVOKE TRUNCATE ... FROM PUBLIC`، وإلا فالضمان شكليّ.

## قواعد معمارية
- `discord.js` يُستورد في ملف واحد فقط: `apps/bot/src/lib/discord.ts` (rule 2).
- معالج الأوامر **لا يسجّل العقوبات** — الـgateway يسجّلها من audit log.
  الاستثناء: `moderation.warn`/`clearwarns` لأنهما سجلان لا تعديل Discord.
- السبب يُقرأ من `AuditLogEntry.reason` في `createActorResolver` لا من خيار الأمر.
- **ملكية البيانات:** البوت يملك `guilds.member_count` و`ping_ms`؛ اللوحة تبذر
  الصف فقط (`ensureGuild` = `ON CONFLICT DO NOTHING`). لا تستخدم `upsertGuild` من
  اللوحة — كان يصفّر العدد عند كل فتح.
- **لا تعرض رقماً لا تعرفه:** `pingMs`/`online` من نبضة حديثة لا من وجود توكن.
  `members.online` من ودجت السيرفر فقط (rule 8 تمنع `GUILD_PRESENCES`).
- **محرّك مضاد التخريب مُسلَّح افتراضياً.** تغيير الـdefault **لا يعيد كتابة
  الصفوف**؛ `normaliseEnabled` تُبقي `false` صريحاً.
- **كل مسار مرتبط بسيرفر يتحقق من الوصول للسيرفر نفسه لا من الجلسة فقط.**
  `requireGuildAccess` للقراءة و`requireTierForGuild` للكتابة. معرّف السيرفر ليس
  سراً ⇒ `requireSession` وحده يعني أن أي حساب مسجَّل يقرأ أي سيرفر.
  **مسار الهوية العامة يحمل `guildId` في الجسم** لحاجة الحارس.
  `route-guards.test.ts` يفحص الجدول نصياً لأن نمط الفشل **استدعاء غائب**.
- **`BotIdentitySettings` مقابل `RawBotIdentity`:** `normaliseBotIdentity` تأخذ
  `RawBotIdentity` (حقول `unknown`) — تضييقها يسبب `TS2322` في كل قارئ.

## اللوحة
- `types.ts` يُعيد تصدير كل عقد مشترك من `@al-ai/core/browser`؛ لا تُكرّر شكلاً
  موجوداً في core (انحراف سابق: `CommandFlag` في مكانين).
- `logCategories` تُشتق من `eventsByCategory`. `bot-log` وجهة **داخلية** لا تظهر
  للمشغّل ولا تُربط بقناة (يفلترها `normaliseCategoryChannels`).
- المنطق القابل للاختبار يُستخرج إلى دوال نقية في core (`deriveBotStatus`,
  `summarisePunishments`, `assessRoleHierarchy`, `assessRoleIconGate`,
  `assessNukeAction`, `describeAppearanceResult`) بدل حقنه في المسار.
- **`notice` و`authNotice` منفصلان عمداً.** خلطهما يُظهر «لا تملك صلاحية الوصول
  إلى هذا السيرفر» **على شاشة الدخول** — عطل رآه المستخدم فعلاً.
- **`--primary` يجب أن يبقى نيلياً** `oklch(0.511 0.262 276.966)`. كان شبه أبيض
  فبدا زر الدخول **صندوقاً أبيض يُقرأ كنص مكتوب**. عند تعديل الثيم تحقّق أن الـCSS
  لا يحوي `oklch(.922 0 0)`.

## المعاينة والفحص بلا متصفح
- **`renderToString` لا يكفي:** Radix **لا يُثبّت محتوى `Collapsible` المطويّ**،
  و**التأثيرات لا تجري** ⇒ أي شاشة تجلب بيانات ترسم حالة التحميل فقط. لذلك اختبر
  **الأجزاء النقية منفصلة** — نمط متبع في `render.test.tsx`.
- **بناء معاينة تفاعلية:** مُدخل مؤقت يستدعي `createRoot`، **يستورد
  `./src/index.css`** (بدونه لا CSS إطلاقاً)، و`vite build` بـ`input` = المُدخل
  و`outDir` خارج `dist/` مع `emptyOutDir: false`.
  - **مصيدة البناء:** `@vitejs/plugin-react` مثبّت في `apps/dashboard/node_modules`
    لا الجذر ⇒ إعداد vite في `.workbuddy-ai/preview/` **لا يستطيع استيراده**
    (`ERR_MODULE_NOT_FOUND`). انسخ الإعداد والمُدخل **إلى `apps/dashboard/`**،
    شغّل من هناك، **ثم احذف الملفين المؤقتين**.
- **لا تفتح المعاينة بـ`file://`** (ES + `crossorigin` يفشل) — اخدمها بـ
  `python -m http.server`. اكتب في `.workbuddy-ai/preview/` لأن البناء ينظّف `dist/`.
- **قياس نداءات Discord:** اعترض `globalThis.fetch` في مُدخل المعاينة وعدّ لكل نقطة
  (`.workbuddy-ai/preview/count-calls.mjs`) — هذه الأداة هي التي أثبتت 7→5.
- **فخّان في التأكيد:** قيمة عنصر نموذج **ليست `textContent`** (اقرأ `el.value`)،
  وRadix يرسم `Select` في **portal** (أكّد على `aria-label`). **وأكّد الاتجاهين.**
- **أكّد على ما يراه المستعمل لا على الافتراضي في المكوّن.** `ColorPicker` افتراضيه
  `unsetLabel = "بلا لون"` والشاشة تمرّر `"لون Discord الافتراضي"`.

## البيئة (Windows)
- PostgreSQL 17 في `C:\Program Files\PostgreSQL\17`. data dir:
  `C:\Users\dlwta\.al-ai\pgdata` (خارج المستودع)، منفذ **55432**.
  `psql` **ليس على `PATH`** — استخدم مساراً كاملاً.
- **`pg_ctl start` يُقتل** مع انتهاء أمر Bash. **الحل: `postgres.exe` كمهمة خلفية**
  (`run_in_background: true`). الإقلاع ~30 ثانية و`pg_isready` يقول "rejecting" خلالها.
  المنفذ **5432 مشغول بتثبيت آخر — لا تلمسه**.
- **أي `curl` لعنوان محلي يحتاج `--noproxy '*'`** — وإلا مرّ عبر الوكيل ورجع
  **502 مضلِّل** حتى مع عدم وجود مستمع. و`000` + exit 7 هو «رفض الاتصال» الحقيقي.
- **لا تقرأ `curl -o /dev/null -w '%{size_download}'`** — يرجع **0** هنا حتى مع
  200 وجسم حقيقي. عُدّ بالـ`grep -c` على المحتوى، أو `content-length` من `curl -I`.
  وانتهاء الجلسة (exit 23) عند قطع الأنبوب بـ`head` ليس عطلاً.
- **`psql` يتعلّق بلا `-w` و`< /dev/null`** في Git Bash (يُقتل بلا مخرجات).
- **لا تُطلق curl في `node -e`** لأي شيء موثَّق: ترويسة تُبنى من `$(cat file)` قد
  تصل فارغة والخادم يردّ 401 بلا سبب. اكتب `.mjs` يستعمل `fetch` بترويسات صريحة.
- Docker CLI موجود لكن الـdaemon متوقف؛ WSL محجوب بسياسة أمنية.
- **`/tmp` يعمل** في Git Bash هنا، لكن `node /tmp/x.mjs` يفشل بـMODULE_NOT_FOUND
  (يترجم إلى `C:\tmp`) — استخدم `node "$(cygpath -w /tmp/x.mjs)"`.
- `scripts/dev-issue-session.mts` يصدر جلسة حقيقية (**يجب أن يكون `.mts`**).
  مسارات **الكتابة** لا تُفحص به. **التوكن المزروع وهمي (`probe-token`)** ⇒ يرجع
  `401 SESSION_EXPIRED`؛ مفيد لإثبات أن الحارس يعمل، لكن **لا يمكن الوصول إلى
  `403 NOT_A_MEMBER` به**.
- **مسار صحة محوّل التكامل `GET /ping` لا `/health`** — `/health` يرجع
  `404 UNKNOWN_ENDPOINT` وهذا **سلوك سليم**. ولا تختبره بـ`x-forwarded-for`؛
  الفحص على `remoteAddress` الحقيقي.
- **`.workbuddy-ai/memory/*.md` مُتتبَّعة ومرفوعة إلى المستودع العام**
  (`Steve6546/al-ai`) — لا أسرار، لكنها ملاحظات داخلية. `backups/` و`preview/`
  **مُتجاهَلان**.
- **عملية خلفية بـ`&` داخل أمر تنتهي بقتلها عند رجوع الأمر.** استخدم
  `run_in_background: true` لتحصل على `task_id` يعيش عبر النداءات.
- **`npx tsc` يُحلّ لكل مجلد.** قد يُثبّت الـworkspace إصداراً مختلفاً تماماً عن
  الجذر (5.2.2 مقابل 7.0.2). شغّل `npx tsc --version` من داخل الحزمة أولاً.
  **TS 7 أزال `baseUrl`** — أبقِ `paths` فقط (تُحلّ نسبةً إلى tsconfig).
