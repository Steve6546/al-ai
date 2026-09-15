# AL AI — Discord bot + لوحة تحكم

Monorepo: `apps/bot` (discord.js) + `apps/dashboard` (Fastify BFF + React SPA RTL) + `packages/core`
(المصدر الوحيد للعقود). **507 اختباراً** (بوت 173 / لوحة 197 / core 137). **قواعد فقط** — القصص
والقياسات في السجلات اليومية، والتفاصيل الإجرائية في المهارات (تُشار إليها بـ`→`).

## التشغيل
- `npm run verify` = lint + check:schema + test + build. **اقرأ `# skipped` لا `# pass`**: بلا قاعدة
  حيّة يتخطّى `storage.test.ts` بصمت ويرجع **exit 0**. شغّل PostgreSQL على **55432** أولاً.
- اللوحة: `cd apps/dashboard && ../../node_modules/.bin/tsx --env-file=../../.env server/index.ts`.
  **`node` على ملف يستورد `server/*.ts` يفشل** (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`).
- **`tsx` بلا hot-reload** ⇒ أعد التشغيل بعد كل تعديل خلفي، وإلا خدمت مسارات قديمة (404) وأنت تظن
  الإصلاح فشل.
- **التسليم:** `present_files` بمسار مطلق. **إثبات الواجهة:** طابق بصمة الحزمة المخدومة مع
  `dist/assets/` ثم `grep` على **الحزمة المخدومة نفسها**.

## 🔴 Git
`.git` مشترك مع `glyph-agent`؛ `origin` → `Steve6546/al-ai`.
- **⛔ لا `git rm`** (أتلف 4 ملفات غير متعقَّبة) — احذف بـ`rm`، **`git add -A` قبل أي حذف**.
  **⛔ لا `git stash`** — لإثبات انحدار انسخ الملف إلى `.workbuddy-ai/`.
- **مراجع التتبّع لا تُحفظ** ⇒ تحقّق بـ`git ls-remote origin refs/heads/main` **فقط**. اكتب
  `.git/refs/remotes/origin/main` يدوياً **آخر شيء**.
- **الدفع:** `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true timeout 150 git push origin main`.
  **⛔ `gh auth setup-git` يخرج 0 وهو فاشل.** → `al-ai-git-recovery`

## Discord API
- **لا `@me` في مسار عضو السيرفر** (GET ⇒ 400/403) — الصحيح `GET /users/@me` ثم
  `/guilds/{id}/members/{botUserId}`. استثناء: **`PATCH .../members/@me` مقبول**.
- **`permissions` = `0` لرمز بوت** حتى مع Administrator ⇒ ابنِها من `@everyone` (معرّفه = معرّف
  السيرفر) + أدوار العضو، **وافحص 0x8 أولاً**.
- **«مجهول» ليس `false`:** `granted` ثلاثي؛ ارفض الكتابة عند `false` مؤكدة فقط.
- كل قراءة بـ`.catch(() => null)` تفشل **بصمت** ⇒ الاختبار يثبّت **شكل الطلب** لا النتيجة. والخطّاف
  يطابق بـ`includes` ⇒ رتّب الأكثر تحديداً أولاً.
- **`a_` = أفاتار متحرك** ⇒ `.gif`. **النبذة عبر `PATCH /applications/@me {description}`** —
  `/users/@me {bio}` يُهمَل صامتاً بـ200. **`Presence Intent` ممنوع** (حوكمة 8).

## تصنيف الأخطاء
`DiscordApiError` تحمل `status`/`retryAfterSeconds`؛ `isAuthFailure` **401 فقط** و`isRateLimited`
**429 فقط** — قبلها كل خطأ صار «توكن منتهٍ» ⇒ 429 يُتلف جلسة سليمة.
- `loadUserGuilds` **المصدر الوحيد** لسيرفرات المستخدم: 401 ⇒ إتلاف + `SESSION_EXPIRED` / 429 ⇒
  `429 RATE_LIMITED` + `retry-after` **والجلسة سليمة** / غير ذلك ⇒ 503. أي نداء مباشر جديد
  لـ`fetchUserGuilds` يُسقط `route-guards.test.ts`.
- `/api/guilds` بـ**`Promise.allSettled`** (لا كتابة في `reply` بعد الرد ⇒ `FST_ERR_REP_ALREADY_SENT`)،
  و`const list = x.value;` أولاً لتضييق TS.

## منع 429 (كاش + دمج + خنّاق) — → `al-ai-stack-verify`
**الانفجار نفسه هو المشكلة** (3 تابات = 3 نداءات متطابقة في اللحظة نفسها)، **وحدّ Discord لكل تطبيق
لا لكل مسار.** `server/cache.ts`:
- **`TtlCache.resolve(key, load)`**: **دمج الطلبات الجارية** (نداء ثانٍ ينتظر الوعد القائم — **هذا ما
  يقتل الانفجار لا الـTTL**) + «القديم أفضل من الخطأ» + `finally` تُحرّر الـin-flight.
- الفخاخ الأربعة: كاش على النتيجة المُحوَّلة بدل الحمولة الخام / نسيان الحارس على مسار يمرّ به
  الجميع / قراءة بلا كاش على مسار يُفتح دائماً / المذكرة على النتيجة لا على الوعد.
- TTL: `GUILD_READ 60_000` / `BOT_GUILD 15_000` / `USER_GUILD 20_000`؛
  `invalidateGuildReadCache(guildId)` بعد أي كتابة، و`resetGuildReadCaches()` في `beforeEach`.
  (اختبار يسقط فور إدخال كاش = سببه الكاش، صلّح الكاش لا التأكيد.)
- **`fetchBotMemberShared` بلا TTL عن قصد** (بتة قديمة تحوّل «فقد الصلاحية» إلى «يملكها»).
- **`RequestThrottle`** تستثني الجلسات الموثَّقة و`/internal/` — **ليس ثغرة**: كوكي مزوّر ⇒ 401.

## 🔴 الشاشة السوداء — → `react-jsdom-mount-test`
hook بعد `if (error) return` ⇒ `Rendered more hooks than during the previous render` — وهذا **يُزيل
الشجرة كلها** لا يتدهور. **القاعدة: كل hook فوق كل early return.**
- `renderToString` **لا ينفّذ التأثيرات** ⇒ الشاشات الجالبة تُختبر في حالة التحميل فقط. الحارس:
  `test/mount.test.tsx` (jsdom + `createRoot` + `StrictMode`) يركّب الشاشات السبع **مُحمَّلة**.
- `error-boundary.tsx` يلفّ **محتوى الشاشة فقط لا الـshell** بـ`resetKey={guild.id:view}`،
  **والـfallback بعناصر HTML عارية لا بـ`ui/`**.

## عقود المسارات
**كل مسار إعدادات يجيب `{ settings, ... }`** — انحراف إلى `{ identity }` ⇒ مسودة `null` ⇒ شاشة
سوداء، **والحالة 200 سليمة** بلا 500 ولا سطر سجل ⇒ **الانحراف يظهر كخطأ عميل لا خادم.** طابق
`src/api/client.ts` حرفياً.
- **الغائب ≠ `null`:** الغائب «اتركه» و`null` «امسحه» — قراءة الغائب كـ`null` تمحو قيمة مخزَّنة.
- **رفض على مستوى الحقل لا الطلب:** حقل مبوَّب يُسقَط ويُبلَّغ كـ`FieldOutcome` بدل `409` يُسقط
  النموذج كله. **وحدّد الفحص على «تغيّر فعلاً»** وإلا رفض حقلٌ واحدٌ نموذجاً سليماً.

## الأوامر والتخصيص
- `CommandCategory` = `moderation | channels | general`. المدد الـ11:
  `permanent/5m/30m/1h/6h/12h/1d/3d/7d/14d/30d`، و**`permanent` = `null` لا `0`**.
  `TIMEOUT_MAX_SECONDS` تُقصّ **عند التحويل إلى ثوانٍ فقط**. **المنع يتقدّم على السماح**.
- **⛔ لا تفرض في Discord ما يقرّره المشغّل:** `required` **يُجمَّد وقت التسجيل** ⇒ الفرض في البوت.
  `config/channels.json` يطابق السكيما **بالضبط** (rule 15) وإلا رفض الإقلاع.
- `/mute` ملغاة. معالج الأوامر **لا يسجّل العقوبات** (الـgateway يفعل) عدا `warn`/`clearwarns`.
- **الهوية العامة** في `bot_identity` (صف واحد)، **ولكل سيرفر** في `guild_customization`. **اللوحة
  الكاتب الوحيد للظهور؛ البوت لا يكتب الظهور** — كتابته الوحيدة **النبضة** (`presence-sync.ts`).
- **`FieldOutcome` تُبلَّغ ولا تُبلع**؛ الحفظ يحدث **حتى لو رفض Discord** والرد يفصل «محفوظ» عن
  «منفّذ». `changedAppearanceFields` ترسل المتغيّر فقط.
- **أيقونة الرتبة تحت المستوى 2:** **لا `409`** (أُزيل 2026-09-15) — الحقل يُقفل، **ويُحذف من
  الحمولة**، والرفض يُبلَّغ كـ`FieldOutcome`. **حقل مُقفل يجب أن يكون غير قابل للاختيار لا للكتابة
  فقط** (`<Input disabled>` بجانب زرّ رفع حيّ = مصدر الـ409 الحقيقي).
- **`resolveRoleIcon()`:** `undefined` = اتركها و`null` = امسحها. **قيمة فشلت التحقق ⇒ 400 لا
  `null`.** و**`dirty` بمقارنة حقلاً حقلاً لا `JSON.stringify`**.
- **لا تُعِد تعريف ثابت في core** (تباعدت `STATUS_LABELS`/`ACTIVITY_LABELS` في `bot-preview.tsx` عن
  core ⇒ «غير مرئي» مقابل «غير ظاهر»). و`knownStatus()` تُسقط كل قيمة لا Discord يعرفها إلى `online`.
  و**`hsvToRgb` كان يُبدّل لون المشغّل بصمت** — اختبار: كل `DISCORD_ROLE_SWATCHES` تنجو من
  `rgbToHex(hsvToRgb(rgbToHsv(x)))`.

## الترحيل والمعمارية — → `repo-architecture-audit`
- **`ADD COLUMN` قبل كتلة `RENAME` المحروسة يُبطلها بصمت.** **الترتيب حمولة لا تنظيم، والفحص الوحيد
  الذي يلتقطه: قاعدة جديدة من الصفر.** و`CREATE TABLE IF NOT EXISTS` **لا يُحدِّث default قائماً** ⇒
  `ALTER COLUMN ... SET DEFAULT`. و**`FOR EACH ROW` لا يعمل على `TRUNCATE`** ⇒
  `BEFORE TRUNCATE ... FOR EACH STATEMENT` + `REVOKE TRUNCATE ... FROM PUBLIC`.
- **`discord.js` في ملف واحد فقط:** `apps/bot/src/lib/discord.ts` (rule 2)، بثوابته الرسمية.
- **لا تعرض رقماً لا تعرفه:** `pingMs`/`online` من نبضة حديثة لا من وجود توكن. `members.online` من
  ودجت السيرفر فقط (rule 8 تمنع `GUILD_PRESENCES`).
- **ملكية البيانات:** البوت يملك `guilds.member_count`/`ping_ms`؛ اللوحة تبذر الصف فقط
  (`ensureGuild` = `ON CONFLICT DO NOTHING`).
- **مضاد التخريب مُسلَّح افتراضياً؛** تغيير الـdefault **لا يعيد كتابة الصفوف**. `tripped` عند
  `count > limit`، والاحتواء قبل الإشعار.
- **كل مسار مرتبط بسيرفر يتحقق من الوصول للسيرفر لا من الجلسة** (`requireGuildAccess` قراءة /
  `requireTierForGuild` كتابة). `route-guards.test.ts` يفحص الجدول نصياً.
- **`normaliseBotIdentity` تأخذ `RawBotIdentity`** — تضييقها يسبب `TS2322`.
- **السجلات:** 6 وجهات (خمس للمشغّل + `bot-log` داخلية). كتابة التدقيق **قبل** أي كتم (rule 12).
- **اللوحة:** `types.ts` يُعيد تصدير عقود `@al-ai/core/browser`؛ **لا تُكرّر شكلاً في core**.
  **`notice` و`authNotice` منفصلان** — خلطهما يُظهر «لا تملك صلاحية» على شاشة الدخول. **`--primary`
  يبقى نيلياً** `oklch(0.511 0.262 276.966)`.

## 🔴 الحوكمة — مُفروضة باختبار
`docs/GOVERNANCE.md` = **27 قاعدة**، والكود يحمل `GOVERNANCE rule N`. `governance.test.ts`:
- **العدد مثبَّت (27) ومرقّم 1..27 بلا فجوات** ⇒ **إضافة قاعدة = تعديل الوثيقة + الاختبار معاً**.
  و**كل إشارة في الكود يجب أن تشير لقاعدة موجودة** (الفحص يمسح `apps/bot/src` +
  `apps/dashboard/server` + `packages/core/src`). و**قواعد [2,3,5,7,10..19,24..27] يجب أن تكون
  مُشاراً إليها.** و**24–27:** المرجعية الرسمية إلزامية / ثوابت Discord من تعداداتها / الـSnowflake
  نصّ دائماً / لا تستهلك طلب Discord على بيانات يملكها البوت الحيّ.
- **فصل الطبقات بثلاثة اختبارات:** core لا يستورد إلا `node:crypto`، والـSPA لا يصل للبوت/الخادم،
  والبوت لا يصل للوحة.
- **`packages/core/src/discord-permissions.ts` الاستثناء الوحيد** لتكرار ثوابت Discord (اللوحة لا
  تستورد discord.js)، **مُصدَّر من `index.ts` فقط لا `browser.ts`** (قيم `bigint`).

## الفحص بلا متصفح + الكود الميت — → `al-ai-stack-verify` + `repo-architecture-audit`
- **`createElement` مع مكوّن يشترط `children`:** مرّرها **داخل كائن الخصائص** لا كوسيط ثالث (TS2769).
- **فخّان:** قيمة عنصر نموذج **ليست `textContent`** (اقرأ `el.value`)، وRadix يرسم `Select` في
  **portal** (أكّد على `aria-label`). و**`grep -c` يعدّ الأسطر لا الوقوعات** ⇒ `grep -o | wc -l`.
- **قياس نداءات Discord:** اعترض `globalThis.fetch` وعدّ لكل نقطة.
- **معاينة تفاعلية:** مُدخل مؤقت + `vite build` بـ`input` = المُدخل. **مصيدة:**
  `@vitejs/plugin-react` في `apps/dashboard/node_modules` لا الجذر ⇒ انسخ الإعداد والمُدخل **إلى
  `apps/dashboard/`**، شغّل، **ثم احذف المؤقتين**. **لا تفتح بـ`file://`**.
- **الإثبات الحيّ لمسار كتابة:** جلسة OAuth **حقيقية** من `oauth_sessions` (لا `sessions`) تفتح
  `requireTierForGuild`. غير مُدمِّر: أعِد القيم المخزَّنة، أو غيّر حقلاً وأعِده في `finally`، **واقرأ
  المستوى أولاً** حتى لا تُطبَّق أيقونة على رتبة حقيقية. الجلسة الوهمية (`dev-issue-session.mts`)
  للقراءة ومسبار «500 بدل 401» فقط.
- **سكربتا التنظيف** في `.workbuddy-ai/preview/` (مُتجاهَل): `scan-deps.mjs` (**لا يقرأ CSS** فافحص
  `@import` يدوياً) و`scan-dead-values.mjs` (تصديرات **قيم** بلا مرجع خارجي؛ **يستثني الأنواع**).
- **لا تحذف ثابتاً «ميتاً» قبل التحقق أنه ليس النسخة الصحيحة:** `IMAGE_TARGET_SIZES` كان ميتاً والحيّ
  نسخة منه في المُقتطِع ⇒ الصحيح ربط المُقتطِع بـcore لا الحذف.
- **⛔ لا تنقل `tsx`/`typescript` إلى devDependencies:** كلا ملفَي Docker يشغّلان `npx tsx` في `CMD`.

## البيئة (Windows)
- PostgreSQL 17 في `C:\Program Files\PostgreSQL\17`، data dir `C:\Users\dlwta\.al-ai\pgdata`، منفذ
  **55432**، و`psql` ليس على `PATH`. **`pg_ctl start` يُقتل** مع انتهاء أمر Bash ⇒ شغّل
  `postgres.exe` بـ`run_in_background: true` (الإقلاع ~30s). **5432 مشغول — لا تلمسه.**
- **`psql` يتعلّق بلا `-w` و`< /dev/null`.** و**لا تقرأ `-w '%{size_download}'`** (0 حتى مع 200).
- **مسار صحة محوّل التكامل `GET /ping` لا `/health`** (`/health` ⇒ 404 وهذا سليم).
- **`.workbuddy-ai/memory/*.md` مُتتبَّعة ومرفوعة لمستودع عام** — لا أسرار؛ `backups/` و`preview/`
  **مُتجاهَلان**. (قواعد `--noproxy '*'`، `run_in_background`، `/tmp`، `npx tsc` لكل مجلد: في
  `~/.workbuddy-ai/MEMORY.md`.)
