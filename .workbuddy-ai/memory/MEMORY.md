# AL AI — Discord bot + لوحة تحكم

Monorepo: `apps/bot` (discord.js) + `apps/dashboard` (Fastify BFF + React SPA RTL) +
`packages/core` (المصدر الوحيد للعقود المشتركة). **501 اختباراً** (بوت 173 / لوحة 191 / core 137).
**قواعد فقط** — القصص والقياسات في السجلات اليومية المؤرَّخة، والإجراءات في المهارات.

## التشغيل والتحقق
- `npm run verify` = lint + check:schema + test + build. **اقرأ `# skipped` لا `# pass`**:
  `storage.test.ts` يتخطّى بصمت بلا قاعدة حيّة و`verify` يرجع **exit 0**. شغّل PostgreSQL على
  **55432** قبل أي ادّعاء نجاح.
- اللوحة: `cd apps/dashboard && ../../node_modules/.bin/tsx --env-file=../../.env server/index.ts`.
  **`node` على أي ملف يستورد `server/*.ts` لا يعمل** (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).
- **`tsx` لا يعيد التحميل الحارّ** ⇒ أعد تشغيل العملية بعد كل تعديل خلفي، وإلا خدمت مسارات قديمة
  (الجديدة 404) وأنت تظن الإصلاح فشل.
- **التسليم:** `present_files` بمسار مطلق عند كل تسليم وإلا لا يرى المستخدم شيئاً. **إثبات وصول
  الواجهة:** طابق بصمة الحزمة المخدومة مع `dist/assets/` ثم `grep` العلامات الجديدة **على الحزمة
  المخدومة نفسها**.

## 🔴 مخاطر Git — اقرأ أولاً
`.git` مشترك مع مشروع آخر (`origin` → `Steve6546/al-ai`، `glyph-agent` →
`Steve6546/glyph-weaver-forge`).
- **⛔ لا `git rm`** (جرّ 46 ملفاً وأتلف 4 غير متعقَّبة نهائياً). احذف بـ`rm`، **`git add -A` قبل
  أي حذف**، وافحص `git status` قبل أن تكمل.
- **⛔ لا `git stash`** (أفقد 88 blob و`HEAD`). لإثبات انحدار: انسخ الملف إلى `.workbuddy-ai/`.
- **مراجع التتبّع لا تُحفظ** ⇒ تحقّق بـ`git ls-remote origin refs/heads/main` **فقط**، لا بـ
  `git status`. والحلّ: اكتب `.git/refs/remotes/origin/main` يدوياً **آخر شيء** (أي
  `git update-ref` بعده يحذفه).
- **الدفع:** `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true timeout 150 git push origin main`.
  **⛔ `gh auth setup-git` لا يفيد** — `gh` غير مسجَّل فيرد «not logged into any GitHub hosts»
  **ويخرج 0** (فشل يبدو نجاحاً). لا تحلّ التعليق بـ`run_in_background`. **مخزن معطوب:** مهارة
  `al-ai-git-recovery`.

## Discord API — مصائد صامتة
- **لا `@me` في مسار عضو السيرفر** (`GET` ⇒ 400/403). الصحيح: معرّف البوت من `GET /users/@me` ثم
  `GET /guilds/{id}/members/{botUserId}` (يعطي الأدوار والصلاحيات). استثناء:
  **`PATCH /guilds/{id}/members/@me` مقبول**.
- **`permissions` في كائن العضو = `0` لرمز بوت** حتى مع Administrator ⇒ ابنِها من `@everyone`
  (يحمل **معرّف السيرفر نفسه**) + أدوار العضو، **وافحص 0x8 أولاً**.
- **«مجهول» ليس `false`:** `granted` ثلاثي؛ ارفض الكتابة فقط عند `false` مؤكدة.
- كل قراءة مُغلَّفة بـ`.catch(() => null)` تفشل **بصمت** ⇒ `discord.test.ts` يثبّت **شكل الطلب**
  لا النتيجة. **والخطّاف يطابق بـ`includes`** ⇒ رتّب الأكثر تحديداً أولاً (`/guilds/{id}` يبتلع
  `/guilds/{id}/channels`).
- **تجزئة `a_` = أفاتار متحرك** ⇒ `.gif`، وإلا الإطار الأول. **النبذة عبر
  `PATCH /applications/@me {description}`** — `PATCH /users/@me {bio}` يُهمَل صامتاً بـ200.
- **`Presence Intent` ممنوع** (حوكمة 8) — لا تُفعّله.

## تصنيف أخطاء Discord
`DiscordApiError` تحمل `status` و`retryAfterSeconds`؛ `isAuthFailure` (**401 فقط**) و
`isRateLimited` (**429 فقط**). قبلها كان كل خطأ «توكن منتهٍ» ⇒ 429 يُتلف جلسة سليمة.
- `loadUserGuilds` **المصدر الوحيد** لقائمة سيرفرات المستخدم: 401 ⇒ إتلاف + `SESSION_EXPIRED` /
  429 ⇒ `429 RATE_LIMITED` + `retry-after` **والجلسة سليمة** / غير ذلك ⇒ 503. أي نداء مباشر جديد
  لـ`fetchUserGuilds` يُسقط `route-guards.test.ts`.
- `/api/guilds` يستخدم **`Promise.allSettled`** (ولا كتابة في `reply` بعد الرد ⇒
  `FST_ERR_REP_ALREADY_SENT`). خُذ `const list = x.value;` أولاً لتضييق TS.

## منع 429 — كاش + دمج + خنّاق
`server/cache.ts`. **الانفجار نفسه هو المشكلة** (3 تابات = 3 نداءات متطابقة في اللحظة نفسها)؛
إعادة المحاولة في العميل وحدها لا تكفي. **وحدّ Discord لكل تطبيق لا لكل مسار.**
- **`TtlCache.resolve(key, load)`**: إصابة طازجة، **دمج الطلبات الجارية** (نداء ثانٍ ينتظر الوعد
  القائم — **هذا ما يقتل الانفجار لا الـTTL**)، «القديم أفضل من الخطأ»، و`finally` تُحرّر خانة
  الـin-flight.
- **الفخّ 1: كاش على النتيجة المُحوَّلة لا الحمولة الخام** ⇒ **كاش على الحمولة الخام، وكل مستهلك
  يُسقط عليها سؤاله.**
- **الفخّ 2: نسيت الحارس** — `loadUserGuilds` في ~15 مساراً وشاشة تناديه 3 مرات ⇒
  `fetchUserGuildsCached` (20s، مفتاح = التوكن). **مُدخل القياس يحاكي المسار من أوله بحارسه.**
- **الفخّ 3: قراءة بلا كاش على مسار يُفتح دائماً** ⇒ `appearanceSnapshotCache` (60s، مفتاح =
  التوكن) + `invalidateAppearanceSnapshot()` بعد الحفظ. قيس حياً: 2.400s ← 0.415s.
- **الفخّ 4: المذكرة على النتيجة لا على الوعد** ⇒ نداءان في نفس التكة كلٌّ يرى `null`.
- TTL: `GUILD_READ 60_000` / `BOT_GUILD 15_000` / `USER_GUILD 20_000`.
  `invalidateGuildReadCache(guildId)` بعد أي كتابة، و`resetGuildReadCaches()` في `beforeEach`.
  (اختبار يسقط فور إدخال كاش = سببه الكاش، صلّح الكاش لا التأكيد.)
- **`fetchBotMemberShared` بلا TTL عن قصد**: بتة قديمة تحوّل «البوت فقد الصلاحية» إلى «يملكها».
- **`RequestThrottle` نافذة منزلقة** تستثني الجلسات الموثَّقة و`/internal/` — **ليس ثغرة**: كوكي
  مزوّر ⇒ `401 UNAUTHENTICATED`.

## 🔴 الشاشة السوداء = hook بعد early return
**العَرَض:** «هوية البوت» ⇒ «جارٍ التحميل» ثم **صفحة سوداء تماماً**. **السبب:** `useMemo` في
`customization.tsx` **بعد** `if (error) return` و`if (!savedGuild || !guildDraft) return` ⇒ 15
hook في تمريرة التحميل و16 في البيانات ⇒ `Rendered more hooks than during the previous render` —
وهذا **يُزيل الشجرة كلها** لا يتدهور. **القاعدة: كل hook فوق كل early return.**
- **لماذا فاته الاختبار:** `renderToString` **لا ينفّذ التأثيرات** ⇒ كل شاشة جالبة تُختبر في حالة
  التحميل فقط، والتمريرة الثانية (العطل) لا تُنفَّذ أبداً.
- **الحارس:** `test/mount.test.tsx` (jsdom + `createRoot` + `StrictMode` + شبكة موهومة) يركّب
  الشاشات السبع **مُحمَّلة**؛ أُثبت أنه يكشف الانحدار. **اقرأ مهارة `react-jsdom-mount-test` قبل
  كتابة أي اختبار تركيب.**
- **الحماية:** `error-boundary.tsx` يلفّ **محتوى الشاشة فقط لا الـshell** في `App.tsx`
  بـ`resetKey={guild.id:view}`، **والـfallback بعناصر HTML عارية لا بـ`ui/`**.

## عقود المسارات
**كل مسار إعدادات يجيب `{ settings, ... }`.** `GET/PUT /api/bot/identity` أجابا `{ identity }`
والعميل يقرأ `result.settings` ⇒ مسودة `null` ⇒ شاشة سوداء، **والحالة 200 سليمة** بلا 500 ولا سطر
سجل ⇒ **أي انحراف يظهر كخطأ عميل لا خادم.** طابق `src/api/client.ts` حرفياً عند إضافة مسار.

## محرّك الأوامر وتخصيص البوت
- `CommandCategory` = `moderation | channels | general`. **المدد الـ11:**
  `permanent/5m/30m/1h/6h/12h/1d/3d/7d/14d/30d`، و**`permanent` = `null` لا `0`**.
  `TIMEOUT_MAX_SECONDS` تُقصّ **عند التحويل إلى ثوانٍ فقط**. `assessCommandScope`: **المنع يتقدّم
  على السماح**.
- **⛔ لا تفرض في Discord ما يقرّره المشغّل:** `required` **يُجمَّد وقت التسجيل** ⇒ إعداد باتجاه
  واحد؛ الفرض في البوت. `config/channels.json` يطابق السكيما **بالضبط** (rule 15) وإلا رفض الإقلاع.
- `/mute` ملغاة. معالج الأوامر **لا يسجّل العقوبات** (الـgateway يفعل) عدا `warn`/`clearwarns`.
- **الهوية العامة** في `bot_identity` (صف واحد)؛ **لكل سيرفر** في `guild_customization`. **اللوحة
  الكاتب الوحيد لكل حقل ظهور؛ البوت لا يكتب الظهور** — كتابته الوحيدة **النبضة عبر الـgateway**
  (`presence-sync.ts`).
- **`FieldOutcome` تُبلَّغ لكل حقل ولا تُبلع**؛ الحفظ يحدث **حتى لو رفض Discord** والرد يفصل
  «محفوظ» عن «منفّذ». `changedAppearanceFields` ترسل المتغيّر فقط.
- **`resolveRoleIcon()`:** `undefined` = اتركها و`null` = امسحها (الخلط يمحو أيقونة المشغّل).
  **قيمة فشلت التحقق ⇒ 400 لا `null`.** و**`dirty` بمقارنة حقلاً حقلاً لا `JSON.stringify`**.
- **لا تُعِد تعريف ثابت موجود في core.** سبق أن تباعدت نسختا `STATUS_LABELS`/`ACTIVITY_LABELS` في
  `bot-preview.tsx` عن core ⇒ «لا تزعجني/غير مرئي» مقابل «لا تُزعجني/غير ظاهر». و`knownStatus()`
  تُسقط أي قيمة لا Discord يعرفها إلى `online`.
- **`hsvToRgb` كان يُبدّل لون المشغّل بصمت** (بلا `((h%360)+360)%360` وبلا تقريب). اختبار: كل
  `DISCORD_ROLE_SWATCHES` تنجو من `rgbToHex(hsvToRgb(rgbToHsv(x)))`.

## الترحيل وقواعد معمارية
- **`ADD COLUMN` قبل كتلة `RENAME` المحروسة يُبطلها بصمت** (بلا خطأ). **الترتيب حمولة لا تنظيم،
  والفحص الوحيد الذي يلتقطه: قاعدة جديدة من الصفر.** و`CREATE TABLE IF NOT EXISTS` **لا يُحدِّث
  default قائماً** ⇒ `ALTER COLUMN ... SET DEFAULT`. و**`FOR EACH ROW` لا يعمل على `TRUNCATE`** ولا
  على جدول فارغ ⇒ `BEFORE TRUNCATE ... FOR EACH STATEMENT` + `REVOKE TRUNCATE ... FROM PUBLIC`.
- **`discord.js` في ملف واحد فقط:** `apps/bot/src/lib/discord.ts` (rule 2)، وبثوابته الرسمية
  (`GatewayIntentBits`, `ChannelType`, `AuditLogEvent`, `PermissionsBitField`, `ActivityType`,
  `Routes`). `activityTypeNumbers` في core تحمل أرقام Discord.
- **لا تعرض رقماً لا تعرفه:** `pingMs`/`online` من نبضة حديثة لا من وجود توكن. `members.online` من
  ودجت السيرفر فقط (rule 8 تمنع `GUILD_PRESENCES`).
- **ملكية البيانات:** البوت يملك `guilds.member_count`/`ping_ms`؛ اللوحة تبذر الصف فقط
  (`ensureGuild` = `ON CONFLICT DO NOTHING`) — `upsertGuild` من اللوحة كان يصفّر العدد.
- **مضاد التخريب مُسلَّح افتراضياً؛** تغيير الـdefault **لا يعيد كتابة الصفوف**. `tripped` عند
  `count > limit`، والاحتواء قبل الإشعار.
- **كل مسار مرتبط بسيرفر يتحقق من الوصول للسيرفر لا من الجلسة فقط** (`requireGuildAccess` للقراءة
  / `requireTierForGuild` للكتابة). `route-guards.test.ts` يفحص الجدول نصياً.
- **`normaliseBotIdentity` تأخذ `RawBotIdentity`** (حقول `unknown`) — تضييقها يسبب `TS2322`.
- **السجلات:** 6 وجهات (خمس للمشغّل + `bot-log` داخلية لا تُربط بقناة). كتابة التدقيق **قبل** أي
  كتم (rule 12).
- **اللوحة:** `types.ts` يُعيد تصدير عقود `@al-ai/core/browser`؛ **لا تُكرّر شكلاً موجوداً في
  core**. المنطق القابل للاختبار يُستخرج إلى دوال نقية في core. **`notice` و`authNotice`
  منفصلان** — خلطهما يُظهر «لا تملك صلاحية» على شاشة الدخول. **`--primary` يبقى نيلياً**
  `oklch(0.511 0.262 276.966)`.

## 🔴 ميثاق الحوكمة — مُفروض باختبار لا بالنيّة
`docs/GOVERNANCE.md` = **27 قاعدة**، والكود يحمل `GOVERNANCE rule N`، والمقدّمة تُلزم **كل مساهم
بشري أو آلي**. `apps/bot/test/governance.test.ts`:
- **العدد مثبَّت (27) ومرقّم 1..27 بلا فجوات** ⇒ **إضافة قاعدة = تعديل الوثيقة + الاختبار معاً**.
- **كل إشارة `GOVERNANCE rule N` في الكود يجب أن تشير لقاعدة موجودة.** الفحص يمسح **ثلاثة جذور**:
  `apps/bot/src` + `apps/dashboard/server` + `packages/core/src`.
- **قواعد [2,3,5,7,10..19,24,25,26,27] يجب أن تكون مُشاراً إليها.** و24–27: المرجعية الرسمية
  إلزامية / ثوابت Discord من تعداداتها / الـSnowflake نصّ دائماً / لا تستهلك طلب Discord على بيانات
  يملكها البوت الحيّ.
- **فصل الطبقات مُفروض بثلاثة اختبارات:** core لا يستورد إلا `node:crypto`، والـSPA لا يصل
  للبوت/الخادم، والبوت لا يصل للوحة.
- **`packages/core/src/discord-permissions.ts` هو الاستثناء الوحيد المسموح** لتكرار ثوابت Discord
  (اللوحة لا يجوز أن تستورد discord.js)، **مُصدَّر من `index.ts` فقط لا `browser.ts`** (قيم
  `bigint`). و`apps/bot/test/discord-standards.test.ts` يمسكها مقابل `PermissionFlagsBits`
  و`ActivityType` ⇒ discord.js يبقى المصدر. **حُذف `USER_PERMISSIONS`/`BOT_PERMISSIONS`** (بتات
  يدوية أخطأ أحدها فعلاً).

## الفحص بلا متصفح
- **`createElement` مع مكوّن يشترط `children`:** مرّرها **داخل كائن الخصائص** لا كوسيط ثالث وإلا
  `TS2769`.
- **فخّان في التأكيد:** قيمة عنصر نموذج **ليست `textContent`** (اقرأ `el.value`)، وRadix يرسم
  `Select` في **portal** (أكّد على `aria-label`). و**`grep -c` يعدّ الأسطر لا الوقوعات** ⇒ على HTML
  سطر واحد استخدم `grep -o | wc -l`.
- **قياس نداءات Discord:** اعترض `globalThis.fetch` وعدّ لكل نقطة
  (`.workbuddy-ai/preview/count-screen-calls.mjs`).
- **بناء معاينة تفاعلية:** مُدخل مؤقت يستدعي `createRoot` + `vite build` بـ`input` = المُدخل.
  **مصيدة:** `@vitejs/plugin-react` في `apps/dashboard/node_modules` لا الجذر ⇒ انسخ الإعداد
  والمُدخل **إلى `apps/dashboard/`**، شغّل، **ثم احذف المؤقتين**. **لا تفتح بـ`file://`**.

## تنظيف الكود الميت
**المهارة: `repo-architecture-audit`.** سكربتان في `.workbuddy-ai/preview/` (مُتجاهَل):
`scan-deps.mjs` (**لا يقرأ CSS** فافحص `@import` يدوياً) و`scan-dead-values.mjs` (تصديرات **قيم**
بلا مرجع خارجي؛ **يستثني الأنواع**).
- **لا تحذف ثابتاً «ميتاً» قبل التحقق أنه ليس النسخة الصحيحة:** `IMAGE_TARGET_SIZES` كان ميتاً
  والحيّ نسخة منه في المُقتطِع ⇒ الصحيح ربط المُقتطِع بـcore لا الحذف.
- **⛔ لا تنقل `tsx`/`typescript` إلى devDependencies:** كلا ملفَي Docker يشغّلان `npx tsx` في
  `CMD` ⇒ **تبعية تشغيل حقيقية**.

## البيئة (Windows)
- PostgreSQL 17 في `C:\Program Files\PostgreSQL\17`، data dir `C:\Users\dlwta\.al-ai\pgdata`، منفذ
  **55432**، و`psql` ليس على `PATH`. **`pg_ctl start` يُقتل** مع انتهاء أمر Bash ⇒ شغّل
  `postgres.exe` بـ`run_in_background: true` (الإقلاع ~30s). **5432 مشغول — لا تلمسه.**
- **`psql` يتعلّق بلا `-w` و`< /dev/null`.** و**لا تقرأ `-w '%{size_download}'`** (يرجع 0 حتى مع
  200) — عُدّ بـ`grep -c` أو `content-length`.
- `scripts/dev-issue-session.mts` يصدر جلسة حقيقية لكن **التوكن وهمي** ⇒ `401 SESSION_EXPIRED`،
  **ولا يمكن فحص مسار سيرفر حقيقي به**. **قيود الفحص الحيّ تُقال صراحة.**
- **مسار صحة محوّل التكامل `GET /ping` لا `/health`** (`/health` ⇒ `404` وهذا سليم).
- **`.workbuddy-ai/memory/*.md` مُتتبَّعة ومرفوعة إلى مستودع عام** — لا أسرار؛ `backups/`
  و`preview/` **مُتجاهَلان**.
- (قواعد `--noproxy '*'`، `run_in_background`، `/tmp`، و`npx tsc` لكل مجلد: في
  `~/.workbuddy-ai/MEMORY.md` — لا تُكرَّر هنا.)
