# AL AI — Discord bot + لوحة تحكم

Monorepo: `apps/bot` (discord.js) + `apps/dashboard` (Fastify BFF + React SPA RTL)
+ `packages/core` (المصدر الوحيد لكل عقد مشترك). **499 اختباراً** (173/189/137).

## التشغيل والتحقق
- `npm run verify` = lint + check:schema + test + build. **اقرأ `# skipped` لا `# pass`**:
  `storage.test.ts` يتخطّى بصمت بلا قاعدة حيّة و`verify` يرجع **exit 0**.
- اللوحة: `cd apps/dashboard && ../../node_modules/.bin/tsx --env-file=../../.env server/index.ts`
  (مسار `tsx` المحلي — `npx` يضيف ~70MB). **`node server/index.ts` لا يعمل**:
  يستورد `./env.js` والملف `env.ts`، وtype-stripping لا يعيد كتابة الامتداد.
  وكذلك أي `node` على ملف يستورد `server/*.ts` ⇒ `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`.
- **`tsx` لا يعيد التحميل الحارّ** — أعد تشغيل العملية بعد كل تعديل خلفي وإلا خدمت
  مسارات قديمة (الجديدة 404) وأنت تظن الإصلاح فشل.
- فحص تخزين حقيقي: `.mts` مؤقت في `apps/dashboard/test/` يستدعي
  `createDatabase(createPool(process.env.DATABASE_URL!))`. `db.getBotIdentity`
  **methods على الكائن لا exports على المديول**.
- **عرض الملفات:** `present_files` بمسار مطلق عند كل تسليم، وإلا لا يرى المستخدم شيئاً.
  **إثبات وصول الواجهة:** طابق اسم الحزمة المخدومة مع `dist/assets/` ثم `grep`
  العلامات الجديدة **على الحزمة المخدومة نفسها**.

## 🔴 مخاطر Git — اقرأ أولاً
`.git` مشترك مع مشروع آخر: `origin` → `Steve6546/al-ai`، و`glyph-agent` →
`Steve6546/glyph-weaver-forge`.
- **⛔ لا `git rm`** (جرّ 46 ملفاً وأتلف 4 غير متعقَّبة نهائياً). احذف بـ`rm`،
  **`git add -A` قبل أي حذف**، وافحص `git status` قبل أن تكمل.
- **⛔ لا `git stash`** (أفقد 88 blob و`HEAD`). **لإثبات انحدار:** انسخ الملف إلى
  `.workbuddy-ai/` ثم `cp` عكسي.
- **مراجع التتبّع لا تُحفظ:** `git status` يقول «ahead N» بعد دفع ناجح ⇒ **تحقّق
  بـ`git ls-remote origin refs/heads/main` فقط.** والحلّ: اكتب
  `.git/refs/remotes/origin/main` يدوياً **آخر شيء** (أي `git update-ref` بعده يحذفه).
- **`git push` قد يتعلّق على مطالبة الاعتماد** ويُقتل بـSIGTERM بلا مخرجات ⇒
  `gh auth setup-git` مرة. **مخزن معطوب:** مهارة `al-ai-git-recovery`.

## Discord API — مصائد صامتة
- **لا اختصار `@me` في مسار عضو السيرفر** (`GET` ⇒ 400/403). الصحيح: معرّف البوت من
  `GET /users/@me` ثم `GET /guilds/{id}/members/{botUserId}` (يعطي الأدوار والصلاحيات).
  استثناء: **`PATCH /guilds/{id}/members/@me` يقبله** Discord (مُتحقَّق حياً).
- **`permissions` في كائن العضو = `0` لرمز بوت** حتى مع Administrator. ابنِها من
  `@everyone` (يحمل **معرّف السيرفر نفسه**) + أدوار العضو. **افحص 0x8 أولاً.**
- **«مجهول» ليس `false`:** `granted` ثلاثي القيمة؛ ارفض الكتابة فقط عند `false` مؤكدة.
- كل قراءة مُغلَّفة بـ`.catch(() => null)` تفشل **بصمت** ⇒ `discord.test.ts` يثبّت
  **شكل الطلب** لا النتيجة. **والخطّاف يطابق بـ`includes`** ⇒ رتّب المسارات الأكثر
  تحديداً أولاً (`/guilds/{id}` يبتلع `/guilds/{id}/channels`).
- **تجزئة `a_` = أفاتار متحرك** ⇒ اطلب `.gif` (`assetExtension`)، وإلا الإطار الأول.
- **النبذة عبر `PATCH /applications/@me {description}`** — `PATCH /users/@me {bio}`
  يُقبل بـ200 ثم يُهمَل صامتاً.
- **`Presence Intent` ممنوع** (حوكمة 8) — لا تُفعّله.

## تصنيف أخطاء Discord
`DiscordApiError` تحمل `status` و`retryAfterSeconds`؛ `isAuthFailure` (**401 فقط**)
و`isRateLimited` (**429 فقط**). قبل ذلك كان كل خطأ «توكن منتهٍ» ⇒ 429 يُتلف جلسة سليمة.
- `loadUserGuilds` **المصدر الوحيد** لقائمة سيرفرات المستخدم: 401 ⇒ إتلاف +
  `SESSION_EXPIRED` / 429 ⇒ `429 RATE_LIMITED` + `retry-after` **والجلسة سليمة** /
  غير ذلك ⇒ 503. أي نداء مباشر جديد لـ`fetchUserGuilds` يُسقط `route-guards.test.ts`.
- `/api/guilds` يستخدم **`Promise.allSettled`** (ولا كتابة في `reply` بعد الرد ⇒
  `FST_ERR_REP_ALREADY_SENT`). خُذ `const list = x.value;` أولاً لتضييق TS.

## منع 429 — كاش + دمج + خنّاق
`server/cache.ts`. **الانفجار نفسه هو المشكلة**، لا التكرار.
- **`TtlCache.resolve(key, load)`**: إصابة طازجة، **دمج الطلبات الجارية** (نداء ثانٍ
  ينتظر الوعد القائم — **هذا ما يقتل الانفجار لا الـTTL**)، «القديم أفضل من الخطأ»،
  و`finally` تُحرّر خانة الـin-flight.
- **الفخّ 1: الكاش على النتيجة المُحوَّلة لا الحمولة الخام** (شاشة كلّفت 7 نداءات، ثلاثة
  `/roles` متطابقة) ⇒ `guildRoleListCache`. **كاش على الحمولة الخام، وكل مستهلك
  يُسقط عليها سؤاله.**
- **الفخّ 2: نسيت الحارس** — `loadUserGuilds` في كل مسار مرتبط بسيرفر ⇒
  `fetchUserGuildsCached`. **مُدخل القياس يحاكي المسار من أوله بحارسه.**
- **الفخّ 3: قراءة بلا كاش على مسار يُفتح دائماً** (2026-09-14): `GET /api/bot/identity`
  كان ينادي `/users/@me` و`/applications/@me` بلا كاش، وحدّ Discord **لكل تطبيق لا
  لكل مسار** ⇒ `appearanceSnapshotCache` (60s، مفتاح = التوكن) +
  `invalidateAppearanceSnapshot()` بعد الحفظ. **قيس حياً: 2.400s ← 0.415s.**
- **الفخّ 4: المذكرة على النتيجة لا على الوعد** ⇒ نداءان في نفس التكة كلٌّ يرى `null`.
- TTL: `GUILD_READ 60_000` / `BOT_GUILD 15_000` / `USER_GUILD 20_000`.
  **`invalidateGuildReadCache(guildId)` بعد أي كتابة**، و`resetGuildReadCaches()` في
  `beforeEach`. (اختبار يسقط فور إدخال كاش = **سببه الكاش**، صلّح الكاش لا التأكيد.)
- **`fetchBotMemberShared` بلا TTL عن قصد**: بتة صلاحية قديمة تحوّل «البوت فقد
  الصلاحية» إلى «البوت يملكها» ⇒ +2 نداءات للفتحة الثانية **مقصودة لا عطل**.
- **`RequestThrottle` نافذة منزلقة** تستثني الجلسات الموثَّقة و`/internal/`
  — **ليس ثغرة:** كوكي مزوّر يعطي `401 UNAUTHENTICATED`.

## 🔴 الشاشة السوداء = hook بعد early return (2026-09-14)
**العَرَض:** «هوية البوت» ⇒ «جارٍ التحميل» ثم **صفحة سوداء تماماً**.
**السبب:** `customization.tsx` نادى `useMemo` (`previewIdentity`) **بعد**
`if (error) return` و`if (!savedGuild || !guildDraft) return` ⇒ تمريرة التحميل 15 hook
وتمريرة البيانات 16 ⇒ `Rendered more hooks than during the previous render` — وهذا
**يُزيل الشجرة كلها** لا يتدهور.
- **الإصلاح:** كل hook فوق كل early return.
- **لماذا لم يكتشفه اختبار:** `renderToString` **لا ينفّذ التأثيرات** ⇒ كل شاشة تجلب
  بيانات تُختبر في حالة التحميل فقط، والتمريرة الثانية (العطل) لا تُنفَّذ أبداً.
- **الحارس:** `test/mount.test.tsx` (jsdom + `createRoot` + `StrictMode` + شبكة
  موهومة) يركّب الشاشات السبع في حالتها **المُحمَّلة**. **أُثبت أنه يكشف الانحدار:**
  بإعادة العطل فشلت 3 اختبارات بالتحديد.
- **فخّ في الحزام:** اقرأ `innerHTML` **قبل** `root.unmount()` — الـunmount يُفرّغ الحاوية.
- **الحماية:** `src/components/error-boundary.tsx` يلفّ محتوى الشاشة في `App.tsx`
  بـ`resetKey={guild.id:view}`. **والـfallback بعناصر HTML عارية لا بـ`ui/`** — حدّ
  يحرس شجرة لا يجوز أن يعتمد عليها.

## عقود المسارات
- **كل مسار إعدادات يجيب `{ settings, ... }`.** `GET/PUT /api/bot/identity` أجابا
  `{ identity }` والعميل يقرأ `result.settings` ⇒ مسودة `null` ⇒ شاشة سوداء، والحالة
  **200 سليمة** بلا 500 ولا سطر سجل. **أي انحراف يظهر كخطأ عميل لا خادم** ⇒ طابق
  `src/api/client.ts` حرفياً عند إضافة مسار.

## محرّك الأوامر
- `CommandCategory` = `moderation | channels | general`. `/al-status` داخل السجل.
  كل قسم مُبوَّب على راية قدرة حقيقية (`supportsReason/Duration/Purge/Notify`).
- **المدد الـ11:** `permanent/5m/30m/1h/6h/12h/1d/3d/7d/14d/30d`. **`permanent` =
  `null` لا `0`.** `TIMEOUT_MAX_SECONDS` تُقصّ **عند التحويل إلى ثوانٍ فقط**.
- `CommandConfig` (القائمة الكاملة في `command-registry.ts`): قوائم سماح/منع للأدوار
  والقنوات، `cooldownSeconds`، `autoDeleteResponseSeconds`، `requireReason`،
  `defaultDuration`، `presetReasons`. `assessCommandScope`: **المنع يتقدّم على السماح**.
- **⛔ لا تفرض في Discord ما يقرّره المشغّل:** `required` **يُجمَّد وقت التسجيل** ⇒
  إعداد باتجاه واحد. الفرض في البوت.
- `command-registry.ts` السلطة: كل أمر مُسجَّل له builder، ومفتاح غير مدعوم يُجبَر على
  الافتراضي. `config/channels.json` يطابق السكيما **بالضبط** (rule 15) وإلا رفض الإقلاع.
- `/mute` ملغاة. معالج الأوامر **لا يسجّل العقوبات** (الـgateway يفعل) عدا
  `warn`/`clearwarns`. السبب من `AuditLogEntry.reason`.

## تخصيص البوت
- **الهوية العامة** في `bot_identity` (صف واحد) = أفاتار/بانر/نبذة + الحالة والنشاط.
  **لكل سيرفر** في `guild_customization` = اسم مستعار/لون/أيقونة رتبة.
- **اللوحة الكاتب الوحيد لكل حقل ظهور؛ البوت لا يكتب الظهور** — كتابته الوحيدة
  **النبضة عبر الـgateway** (`presence-sync.ts`). `server/appearance.ts` هو الكاتب.
- **`FieldOutcome` تُبلَّغ لكل حقل ولا تُبلع**؛ الحفظ يحدث **حتى لو رفض Discord**
  والرد يفصل «محفوظ» عن «منفّذ». `changedAppearanceFields` ترسل المتغيّر فقط.
- **`resolveRoleIcon()`:** `data:` تمر كما هي، `https:` تُجلب، **`undefined` = اتركها
  و`null` = امسحها** (الخلط يمحو أيقونة المشغّل). **قيمة فشلت التحقق ⇒ 400 لا `null`.**
- **`dirty` بمقارنة حقلاً حقلاً لا `JSON.stringify`.**
- `MAX_IMAGE_DATA_URL_LENGTH = 500_000`، `IMAGE_TARGET_SIZES = avatar 256×256 /
  banner 600×240 / roleIcon 128×128`، `BOT_ROLE_NAME = "AL AI"`، `MAX_BIO_LENGTH = 400`،
  `MAX_ACTIVITY_TEXT_LENGTH = 128`.
- **⚠️ نسخ ثوابت الحالة تباعدت فعلاً (أُصلح):** `bot-preview.tsx` كان يُعيد تعريف
  `STATUS_LABELS`/`ACTIVITY_LABELS` بينما core يملك `botStatusLabels`/
  `activityTypeLabels` ويستعملها منتقي الحالة **في الشاشة نفسها** ⇒ المعاينة «لا تزعجني»
  و«غير مرئي» والقائمة «لا تُزعجني» و«غير ظاهر». حُذفت النسختان. **لا تُعِد تعريف ثابت
  موجود في core.** و`knownStatus()` تُسقط أي قيمة لا Discord يعرفها إلى `online`.
- **`hsvToRgb` كان يُبدّل لون المشغّل بصمت** (الدرجة بلا `((h%360)+360)%360` وبلا تقريب).
  اختبار: كل `DISCORD_ROLE_SWATCHES` تنجو من `rgbToHex(hsvToRgb(rgbToHsv(x)))`.

## الترحيل
- **`ADD COLUMN` قبل كتلة `RENAME` المحروسة يُبطلها بصمت** (العمود موجود فيُتخطّى
  الـRENAME ويبقى العمود اليتيم وقوائم السماح مُتجاهَلة، بلا خطأ). **الترتيب حمولة لا
  تنظيم. والفحص الوحيد الذي يلتقطه: قاعدة جديدة من الصفر.**
- `CREATE TABLE IF NOT EXISTS` **لا يُحدِّث default قائماً** ⇒ `ALTER COLUMN ... SET DEFAULT`.
- **`FOR EACH ROW` لا يعمل على `TRUNCATE`** ولا على جدول فارغ ⇒
  `BEFORE TRUNCATE ... FOR EACH STATEMENT` + `REVOKE TRUNCATE ... FROM PUBLIC`.

## قواعد معمارية
- **`discord.js` في ملف واحد فقط:** `apps/bot/src/lib/discord.ts` (rule 2)، وبثوابته
  الرسمية (`GatewayIntentBits`, `ChannelType`, `AuditLogEvent`, `PermissionsBitField`,
  `ActivityType`, `Routes`) — مُتحقَّق. `activityTypeNumbers` في core تحمل أرقام Discord.
- **لا تعرض رقماً لا تعرفه:** `pingMs`/`online` من نبضة حديثة لا من وجود توكن.
  `members.online` من ودجت السيرفر فقط (rule 8 تمنع `GUILD_PRESENCES`).
- **ملكية البيانات:** البوت يملك `guilds.member_count`/`ping_ms`؛ اللوحة تبذر الصف فقط
  (`ensureGuild` = `ON CONFLICT DO NOTHING`) — `upsertGuild` من اللوحة كان يصفّر العدد.
- **مضاد التخريب مُسلَّح افتراضياً؛** تغيير الـdefault **لا يعيد كتابة الصفوف**.
  `tripped` عندما `count > limit`. الأرضية 1 والسقف 100. الاحتواء قبل الإشعار.
- **كل مسار مرتبط بسيرفر يتحقق من الوصول للسيرفر لا من الجلسة فقط**
  (`requireGuildAccess` للقراءة / `requireTierForGuild` للكتابة). مسار الهوية العامة
  يحمل `guildId` في الجسم. `route-guards.test.ts` يفحص الجدول نصياً.
- **`normaliseBotIdentity` تأخذ `RawBotIdentity`** (حقول `unknown`) — تضييقها يسبب
  `TS2322` في كل قارئ.
- **السجلات:** 6 وجهات (خمس للمشغّل + `bot-log` داخلية لا تُربط بقناة). كتابة التدقيق
  **قبل** أي كتم (rule 12). الوضع `single` يتجاهل `categoryChannels` عمداً.

## اللوحة
- `types.ts` يُعيد تصدير عقود `@al-ai/core/browser`؛ **لا تُكرّر شكلاً موجوداً في core**.
- المنطق القابل للاختبار يُستخرج إلى دوال نقية في core (`deriveBotStatus`,
  `summarisePunishments`, `assessRoleHierarchy`, `assessRoleIconGate`,
  `assessNukeAction`, `describeAppearanceResult`).
- **`notice` و`authNotice` منفصلان** — خلطهما يُظهر «لا تملك صلاحية» على شاشة الدخول.
- **`--primary` يبقى نيلياً** `oklch(0.511 0.262 276.966)`؛ تحقّق أن الـCSS لا يحوي
  `oklch(.922 0 0)`.
- **`ErrorBoundary` يلفّ محتوى الشاشة فقط لا الـshell** لتبقى القائمة صالحة.

## المعاينة والفحص بلا متصفح
- **`renderToString` لا يكفي:** التأثيرات لا تجري وRadix لا يُثبّت محتوى `Collapsible`
  المطويّ ⇒ شاشة تجلب بيانات تُرسم في حالة التحميل فقط، **ولهذا لا يكشف انهيار التمريرة
  الثانية.** للشاشات الجالبة: `test/mount.test.tsx` (jsdom + `createRoot` + `StrictMode`)،
  والأجزاء النقية منفصلة.
- **تفاصيل jsdom الكاملة في مهارة `react-jsdom-mount-test`** — ترتيب الاستيراد الحامل
  للحمل، منشئات DOM من jsdom لا Node، الحمولات الحقيقية، القراءة قبل الـunmount،
  ترشيح ضجيج `act`، وفتح قائمة Radix بالنقر. **اقرأها قبل كتابة أي اختبار تركيب.**
- **`createElement` مع مكوّن يشترط `children`:** مرّرها **داخل كائن الخصائص** لا
  كوسيط ثالث وإلا `TS2769`.
- **فخّان في التأكيد:** قيمة عنصر نموذج **ليست `textContent`** (اقرأ `el.value`)، وRadix
  يرسم `Select` في **portal** (أكّد على `aria-label`). **وأكّد الاتجاهين.**
  و**`grep -c` يعدّ الأسطر لا الوقوعات** ⇒ على HTML سطر واحد استخدم `grep -o | wc -l`.
- **قياس نداءات Discord:** اعترض `globalThis.fetch` وعدّ لكل نقطة
  (`.workbuddy-ai/preview/count-screen-calls.mjs`) — أثبتت 4→2.
- **بناء معاينة تفاعلية:** مُدخل مؤقت يستدعي `createRoot` ويستورد `./src/index.css`،
  و`vite build` بـ`input` = المُدخل و`outDir` خارج `dist/`. **مصيدة:**
  `@vitejs/plugin-react` في `apps/dashboard/node_modules` لا الجذر ⇒ انسخ الإعداد
  والمُدخل **إلى `apps/dashboard/`**، شغّل، **ثم احذف المؤقتين**. **لا تفتح بـ`file://`**
  — اخدم بـ`python -m http.server`. اكتب في `.workbuddy-ai/preview/` (البناء ينظّف `dist/`).

## 🔴 ميثاق الحوكمة — مُفروض باختبار لا بالنيّة
`docs/GOVERNANCE.md` = **27 قاعدة**، والكود يحمل `GOVERNANCE rule N`. أربعة اختبارات
في `apps/bot/test/governance.test.ts` تمنع الانزلاق:
- **عدد القواعد مثبَّت (27) ومرقّم 1..27 بلا فجوات** ⇒ **إضافة قاعدة = تعديل
  الوثيقة + الاختبار معاً**، وإلا سقط `verify`.
- **كل إحالة `GOVERNANCE rule N` في الكود يجب أن تشير لقاعدة موجودة.** الفحص يمسح
  **ثلاثة جذور**: `apps/bot/src` + `apps/dashboard/server` + `packages/core/src`
  (كان البوت وحده، فكانت إحالة فاسدة في core تمرّ). أُثبت بإضافة `rule 99` في core.
- **قواعد [2,3,5,7,10..19,24,25,26,27] يجب أن تكون مُشاراً إليها** في الكود.
- قواعد 24–27 الجديدة: المرجعية الرسمية الإلزامية / ثوابت Discord من تعداداتها /
  الـSnowflake نصّ دائماً / لا تستهلك طلب Discord على بيانات يملكها البوت الحيّ.

## مواءمة ثوابت Discord (أُصلح 2026-09-14)
- **`packages/core/src/discord-permissions.ts` هو الاستثناء الوحيد المسموح** لتكرار
  ثوابت Discord، لأن اللوحة لا يجوز أن تستورد discord.js. **مُصدَّر من `index.ts`
  فقط لا `browser.ts`** (قيم `bigint` = شأن خادمي).
- **`apps/bot/test/discord-standards.test.ts`** يمسك القيم مقابل
  `PermissionFlagsBits` و`ActivityType` الرسميين ⇒ discord.js يبقى المصدر.
  **أُثبت بإفساد `MANAGE_GUILD` عمداً: `not ok 1` بالاسم الصحيح.**
- **حُذف `USER_PERMISSIONS` و`BOT_PERMISSIONS`** (كانا بتات مكتوبة يدوياً في اللوحة،
  وأحدهما أخطأ فعلاً مرة). الآن الكل يقرأ `DISCORD_PERMISSION_BITS` من core.
- **`IMAGE_TARGET_SIZES` في core هو المصدر** والمُقتطِع يقرأه؛ كانت الأبعاد مكتوبة
  مرتين (واحد ميت في core وآخر حيّ في المُقتطِع = انزلاق جاهز).

## تنظيف الكود الميت — الأدوات
سكربتان في `.workbuddy-ai/preview/` (مُتجاهَل): `scan-deps.mjs` (تبعية مُعلنة بلا
استيراد — **لكنه لا يقرأ CSS**، فافحص `@import` يدوياً) و`scan-dead-values.mjs`
(تصديرات **قيم** بلا مرجع خارجي؛ **يستثني الأنواع** لأنها سطح واجهة).
- **لا تحذف ثابتاً «ميتاً» قبل أن تتحقق أنه ليس النسخة الصحيحة**: `IMAGE_TARGET_SIZES`
  كان ميتاً لكن الحيّ نسخة منه ⇒ الصحيح ربط المُقتطِع بـcore لا الحذف.
- **`tailwindcss-animate` + `@radix-ui/react-visually-hidden` + `dotenv`** أُزيلت من
  اللوحة (مُعلنة فقط). `dotenv` **باقية في البوت** (يستعمل `dotenv/config`).
- **⛔ لا تنقل `tsx`/`typescript` إلى devDependencies:** كلا ملفَي Docker يشغّلان
  `npx tsx` في `CMD` ⇒ **تبعية تشغيل حقيقية هنا**.

## البيئة (Windows)
- PostgreSQL 17 في `C:\Program Files\PostgreSQL\17`، data dir
  `C:\Users\dlwta\.al-ai\pgdata`، منفذ **55432**. `psql` ليس على `PATH`.
- **`pg_ctl start` يُقتل** مع انتهاء أمر Bash ⇒ شغّل `postgres.exe` بـ
  `run_in_background: true`. الإقلاع ~30s و`pg_isready` يقول "rejecting" خلالها.
  **5432 مشغول بتثبيت آخر — لا تلمسه.**
- **`psql` يتعلّق بلا `-w` و`< /dev/null`.** و**لا تقرأ `-w '%{size_download}'`**
  (يرجع 0 حتى مع 200) — عُدّ بـ`grep -c` أو `content-length`.
- `scripts/dev-issue-session.mts` (**يجب أن يكون `.mts`**) يصدر جلسة حقيقية، لكن
  **التوكن وهمي** ⇒ `401 SESSION_EXPIRED` (يُثبت أن الحارس يعمل بـ401 لا 500)، **ولا
  يمكن فحص مسار سيرفر حقيقي به** (الحارس يقرأ `/users/@me/guilds` فيفشل).
  **قيود الفحص الحيّ تُقال صراحة.**
- **مسار صحة محوّل التكامل `GET /ping` لا `/health`** (`/health` ⇒ `404` وهذا سليم).
- **`.workbuddy-ai/memory/*.md` مُتتبَّعة ومرفوعة إلى مستودع عام** — لا أسرار.
  `backups/` و`preview/` **مُتجاهَلان**.
- (قواعد `--noproxy '*'`، `run_in_background`، `/tmp`، و`npx tsc` لكل مجلد: في
  الذاكرة العامة للمستخدم `~/.workbuddy-ai/MEMORY.md` — لا تُكرَّر هنا.)
