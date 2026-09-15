# AL AI — Discord bot + لوحة تحكم

`apps/bot` (discord.js) + `apps/dashboard` (Fastify BFF + React SPA RTL) + `packages/core` (المصدر الوحيد
للعقود). **قواعد فقط**؛ القصص في السجلات اليومية والإجراءات في المهارات (`→`).

## التشغيل
- `npm run verify` = lint + check:schema + test + build. **اقرأ `# skipped` لا `# pass`**: بلا قاعدة حيّة
  يتخطّى `storage.test.ts` بصمت ويرجع **exit 0**. PostgreSQL على **55432**.
- **سكربتات الـworkspace بـcwd = مجلد الحزمة** ⇒ يلزمها `--env-file=../../.env` وإلا `start -w @al-ai/bot`
  **يخرج 0 بلا تشغيل**. **`tsx` بلا hot-reload** ⇒ أعد التشغيل بعد كل تعديل خلفي وإلا خدمت مسارات قديمة (404).
- **التسليم:** `present_files` بمسار مطلق. **إثبات الواجهة:** طابق بصمة الحزمة المخدومة مع `dist/assets/`
  ثم `grep` على **الحزمة المخدومة نفسها**.
- **⚠️ كتابة الملفات تُسقَط بصمت** (`Edit`/`Write` ينجحان والملف لا يتغيّر) ⇒ **تحقّق بـ`grep`/`md5sum`.**
- **⚠️ Tailwind يمسح التعليقات:** تسمية صنف داخل شرح **تولّد قاعدته في CSS** ⇒ `grep` يجدها ويُضلّلك.

## 🔴 Git — → `al-ai-git-recovery`
`.git` مشترك مع `glyph-agent`؛ `origin` → `Steve6546/al-ai`.
- **⛔ لا `git rm`** (أتلف ملفات غير متعقَّبة) — احذف بـ`rm` بعد `git add -A`. **⛔ لا `git stash`** — انسخ
  الملف إلى `.workbuddy-ai/` لإثبات الانحدار.
- **مراجع التتبّع لا تُحفظ** ⇒ تحقّق بـ`git ls-remote origin refs/heads/main` **فقط**، واكتب
  `.git/refs/remotes/origin/main` يدوياً **آخر شيء**.
- **الدفع:** `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true timeout 150 git push origin main`.
  **⛔ `gh auth setup-git` يخرج 0 وهو فاشل.** **`git commit -F`** بمسار ويندوز `C:/…` لا `/c/…`.

## Discord API
- **لا `@me` في مسار عضو السيرفر** (GET ⇒ 400/403): `/users/@me` ثم `/guilds/{id}/members/{botUserId}`.
  استثناء: `PATCH .../members/@me` مقبول.
- **`permissions` = `0` لرمز بوت** حتى مع Administrator ⇒ ابنِها من `@everyone` (معرّفه = معرّف السيرفر) +
  أدوار العضو **وافحص 0x8 أولاً**. **«مجهول» ليس `false`:** `granted` ثلاثي.
- كل قراءة بـ`.catch(() => null)` تفشل **بصمت** ⇒ الاختبار يثبّت **شكل الطلب** لا النتيجة؛ والخطّاف يطابق
  بـ`includes` ⇒ رتّب الأكثر تحديداً أولاً.
- **النبذة عبر `PATCH /applications/@me {description}`**؛ `/users/@me {bio}` يُهمَل صامتاً بـ200.
  **`Presence Intent` ممنوع** (حوكمة 8).
- **🔴 الأحداث: `Events.*` لا نصّاً.** discord.js **يبعث بالقيمة** و**مفتاح ≠ قيمة**:
  `Events.GuildEmojiCreate` قيمته `emojiCreate` ⇒ `client.on("guildEmojiCreate")` **ميت**، و`"clientReady"`
  هو القيمة نفسها. **لا تستنتج «ميت» من نمط ثابت — شغّل السلوك.** `Events` يُعاد تصديره من `lib/discord.ts`
  (rule 2)، و`discord-standards.test.ts` يطابق `Object.values(Events)`. **جرّد التعليقات قبل أي فحص نصّي.**

## تصنيف الأخطاء
`isAuthFailure` **401 فقط** و`isRateLimited` **429 فقط** — قبلها كل خطأ صار «توكن منتهٍ» ⇒ 429 يُتلف جلسة.
- `loadUserGuilds` **المصدر الوحيد** لسيرفرات المستخدم: 401 ⇒ إتلاف + `SESSION_EXPIRED`؛ 429 ⇒
  `429 RATE_LIMITED` + `retry-after` **والجلسة سليمة**؛ غير ذلك ⇒ 503. نداء مباشر جديد لـ`fetchUserGuilds`
  يُسقط `route-guards.test.ts`.
- `/api/guilds` بـ**`Promise.allSettled`** (لا كتابة في `reply` بعد الرد ⇒ `FST_ERR_REP_ALREADY_SENT`).

## منع 429 — → `al-ai-stack-verify`
**الانفجار نفسه هو المشكلة**، **وحدّ Discord لكل تطبيق لا لكل مسار.** `TtlCache.resolve(key, load)`
**تدمج الطلبات الجارية** (نداء ثانٍ ينتظر الوعد القائم — **هذا ما يقتل الانفجار لا الـTTL**).
**`fetchBotMemberShared` بلا TTL عن قصد.**

## 🔴 الواجهة: التمرير والقوائم
- **إطار واحد بحجم الشاشة وعنصر تمرير واحد لكل شاشة:** `html,body,#root{height:100dvh;overflow:hidden}`،
  `grid h-full grid-rows-[minmax(0,1fr)]`، هيدر `shrink-0` (لا `sticky` — لا شيء يُلتصق به)، و`<main>` وحده
  `flex-1 min-h-0 overflow-y-auto`. **⚠️ داخل مستند مقفل أي `min-h-dvh` يُقتطع بلا تمرير** ⇒ الشاشات خارج
  الـshell (المنتقي/الدخول/التحميل) `h-full` + تمرير داخلي. حارس: `apps/dashboard/test/layout.test.tsx`.
- **`min-h-0` هو ما يجعل `flex-1` «خذ الباقي»** لا «اتمدّد مع المحتوى»؛ و`overflow` غير `visible` يجعل الحد
  الأدنى التلقائي للعنصر المرن `0` — وهو ما يسمح له بالانكماش والتمرير. **و Sticky داخل شبكة يحتاج `self-start`.**
- **قوائم Radix:** `max-h-64` على **المحتوى** (وهو `overflow-y-auto`)؛ والعرض
  `w-[var(--radix-select-trigger-width)]` (لا `min-w` وحده — أرضية يتمدّد فوقها نصّ الخيار)؛ و**`min-w-0 truncate`
  على نصّ الخيار** وإلا لن ينكمش العنصر المرن.
  **🔴 `h-[var(--radix-select-trigger-height)]` على الـviewport عديم الأثر:** Radix يضع
  `display:flex; flex-direction:column` على المحتوى و`flex: 1 1 0%` على الـviewport، و**`flex-basis` يتقدّم
  على `height` في المحور الرئيسي**؛ والمتغيّر يُحلّ فعلاً (36px) ⇒ الصنف **يبدو** هو الحدّ وليس هو.
- **⛔ `<select>` أصلي = قائمة يرسمها النظام** ⇒ بيضاء على ثيم داكن والخيارات غير مرئية. استعمل `ui/select`.
- **قيمة `SelectValue` تُرسَل بـportal إلى الـtrigger عند تركيب المحتوى فقط** (والمغلق في `DocumentFragment`
  منفصل) ⇒ `renderToString` يُظهر trigger فارغاً و`createRoot` في jsdom يُظهرها. **وأي قياس هندسي يلزمه متصفح
  حقيقي** — `getBoundingClientRect` في jsdom أصفار. → `al-ai-stack-verify`

## 🔴 الشاشة السوداء — → `react-jsdom-mount-test`
hook بعد `if (error) return` ⇒ `Rendered more hooks than during the previous render` — **يُزيل الشجرة كلها**.
**كل hook فوق كل early return.** `renderToString` **لا ينفّذ التأثيرات** ⇒ الحارس `test/mount.test.tsx`
(jsdom + `createRoot`) يركّب الشاشات السبع **مُحمَّلة**، و`error-boundary.tsx` يلفّ **محتوى الشاشة لا الـshell**.

## عقود المسارات
**كل مسار إعدادات يجيب `{ settings, ... }`** (استثناء مقبول: `tiers`/`security/config` بشكلهما المكتوب).
انحراف ⇒ مسودة `null` ⇒ شاشة سوداء **والحالة 200 سليمة** ⇒ **الانحراف يظهر كخطأ عميل لا خادم.** طابق
`src/api/client.ts`.
- **الغائب ≠ `null`:** الغائب «اتركه» و`null` «امسحه». **ورفض على مستوى الحقل لا الطلب:** حقل مبوَّب يُسقَط
  ويُبلَّغ كـ`FieldOutcome` بدل `409` يُسقط النموذج كله. **وحدّد الفحص على «تغيّر فعلاً».**
- **`PUT /api/bot/identity` ⇒ 400 `GUILD_ID_REQUIRED` عند غياب `guildId` — مقصود ومُثبت.** أول قراءة قاعدة
  **بعد** `requireTierForGuild`، و`guildId` مشوّه يعطي **نفس الـ400** ⇒ لا كاشف وجود سيرفر. **لا «تصلح»ه.**

## الأوامر والتخصيص
- **المنع يتقدّم على السماح.** **`permanent` = `null` لا `0`**. `TIMEOUT_MAX_SECONDS` تُقصّ **عند التحويل إلى
  ثوانٍ فقط**. **⛔ لا تفرض في Discord ما يقرّره المشغّل:** `required` **يُجمَّد وقت التسجيل**. `/mute` ملغاة.
  معالج الأوامر **لا يسجّل العقوبات** (الـgateway يفعل) عدا `warn`/`clearwarns`.
- **الهوية العامة** في `bot_identity` (صف واحد) **ولكل سيرفر** في `guild_customization`. **اللوحة الكاتب
  الوحيد للظهور؛ البوت لا يكتب الظهور** — كتابته الوحيدة **النبضة** (`presence-sync.ts`). ⇒ **لا اسم بوت في
  `control-plane.json`**: الاسم مملوك للبوابة و`bot_identity`.
- **`FieldOutcome` تُبلَّغ ولا تُبلع**؛ الحفظ يحدث **حتى لو رفض Discord** والرد يفصل «محفوظ» عن «منفّذ».
- **أيقونة الرتبة تحت المستوى 2:** **لا `409`** — الحقل يُقفل **ويُحذف من الحمولة** والرفض يُبلَّغ
  كـ`FieldOutcome`. **حقل مُقفل يجب أن يكون غير قابل للاختيار لا للكتابة فقط.**
- **`resolveRoleIcon()`:** `undefined` = اتركها و`null` = امسحها؛ **قيمة فشلت التحقق ⇒ 400 لا `null`**.
  و**`dirty` بمقارنة حقلاً حقلاً لا `JSON.stringify`**.
- **لا تُعِد تعريف ثابت في core** (`STATUS_LABELS`/`ACTIVITY_LABELS` تباعدت)، و**`hsvToRgb` كان يُبدّل لون
  المشغّل بصمت** — الحارس: كل `DISCORD_ROLE_SWATCHES` تنجو من `rgbToHex(hsvToRgb(rgbToHsv(x)))`.
- **كل حدث في شاشة السجلات يلزمه تسمية عربية** (`eventCopy[id] ?? id` يُخفي الفجوة) —
  `apps/dashboard/test/log-labels.test.ts`.

## 🔴 المعمارية والترحيل — → `repo-architecture-audit` (الفحص 7)
- **الترتيب حمولة لا تنظيم:** `ADD COLUMN` قبل كتلة `RENAME` محروسة **يُبطِلها بصمت**؛ و`CREATE TABLE IF NOT
  EXISTS` **لا يُحدِّث default قائماً** ⇒ `ALTER COLUMN ... SET DEFAULT`. **الفحص الوحيد: قاعدة جديدة من الصفر.**
- **`FOR EACH ROW` لا يُطلَق إن لم يُطابق أي صف** (`DELETE 0` بلا خطأ) **ولا على `TRUNCATE`** ⇒
  `BEFORE TRUNCATE ... FOR EACH STATEMENT` + `REVOKE TRUNCATE ... FROM PUBLIC`؛ وإثباته `BEGIN…ROLLBACK`
  على صفوف موجودة.
- **الإعداد بلا قارئ = زخرفة، والتحقق في القارئ لا في موضع النداء** (`loadControlPlane` يفحص نفسه)؛
  و`schemaVersion` **مفروض** (1/2)؛ و**`null` = «لم يُقرَّر»** لا ملف معطوب. `retention`/`encryption`/
  `commands.deployment` قرارات مسجَّلة بلا سلوك — **مُوثَّقة لا «مُصلَحة»**.
- **قاعدة واحدة بلا نسختين:** أي ثابت مكرَّر يتقاعد أحدهما بصمت (`isHeartbeatFresh`, `clampInteger`,
  `severity`, `sourceLayer`).
- **`severity` من السكيما لا من المستدعي**؛ و`audit_trail` **يرفض UPDATE**؛ والتدقيق **قبل** أي كتم (rule 12)
  و`info` لا يدخل `audit_trail`.
- **لا تعرض رقماً لا تعرفه:** `pingMs`/`online` من نبضة حديثة (rule 8). **الملكية:** البوت يملك
  `guilds.member_count`/`ping_ms` واللوحة تبذر فقط. **الحجر في الذاكرة والاحتواء في Discord** ⇒ إعادة
  التشغيل تُنسى الحجر لا تُكرِّر العقوبة.
- **كل مسار مرتبط بسيرفر يتحقق من الوصول للسيرفر لا الجلسة.** **`discord.js` في ملف واحد** (rule 2).
- **`npx tsc` يحلّ لكل مجلد** ⇒ تحقّق من `--version` داخله؛ **TS 7 أزال `baseUrl`**. **منقّح الكود الميت
  يكذب** ⇒ ثبّت الجذر قبل الحذف. **لا `"latest"`** و`npm ci` في Docker، و**لا تنقل `tsx` لـdevDependencies**.
- **القفل ملف واحد على جذر المستودع** (`BOT_LOCK_FILE` النسبي على الجذر لا cwd) وإلا **نسختان حيّتان**.
- **`uncaughtException` مُوثَّق لا «مُصلَح».**

## 🔴 الحوكمة — مُفروضة باختبار
`docs/GOVERNANCE.md` = **27 قاعدة** والكود يحمل `GOVERNANCE rule N`. `governance.test.ts`:
- **العدد مثبَّت (27) ومرقّم 1..27 بلا فجوات** ⇒ إضافة قاعدة = تعديل الوثيقة والاختبار معاً، وكل إشارة في
  الكود تشير لقاعدة موجودة، و**[2,3,5,7,10..19,24..27] مُشار إليها.**
- **فصل الطبقات:** core لا يستورد إلا `node:crypto`؛ الـSPA لا يصل للبوت/الخادم؛ البوت لا يصل للوحة؛ **لا دورات
  استيراد**. **`discord-permissions.ts` الاستثناء الوحيد**، مُصدَّر من `index.ts` فقط لا `browser.ts`.
- **حارس مُعلَن-بلا-مُنتِج:** `routing.test.ts` يثبّت أن **كل حدث في السكيما له مُنتِج**. **⚠️ لا تستدلّ على
  «بلا مُنتِج» من صفوف `audit_trail`:** `bot.health` = **0 صف وهو الصحيح**.
- **متغيّر بيئة يقرأه الكود ولا يوثّقه `.env.example` = عطل صامت.** الحارس `env-template.test.ts` يمسح **ثلاث
  صيغ** (`process.env.X`، `process.env["X"]`، `read("X")` في `server/env.ts`). **وجرّد التعليقات أولاً.**

## الفحص والكود الميت — → `al-ai-stack-verify`
- **«مُختبَر» ليس «مُوصَّل»** (`prune()`/`release()` كانا مُختبَرَين وبلا نداء؛ `prune()` وحده كان يخفي
  **27MB** تسريباً).
- **إثبات الانحدار:** عطّل الكود ⇒ راقب **الاختبار المحدد** الذي يسقط ⇒ أعِد الملف **مطابقاً بـ`md5sum`**.
  **⚠️ عطّل شيئاً واحداً:** تعطيل قيمتين متناسقتين معاً يُبقي الاختبار ناجحاً زوراً.
- **⚠️ ماسح نجح/فشل يثبت أن الماسح يعمل، لا أن عطلاً كان موجوداً.** **«المسبار لم يُطبَّق» يبدو تماماً مثل
  «التغيير بلا أثر»** ⇒ **اقرأ القيمة المحسوبة لا استنتجها**. **والحكم على أثر تغيير في مكتبة خارجية يُقاس
  في متصفح حقيقي.**

## البيئة (Windows) — → `al-ai-stack-verify`
- PostgreSQL 17، data dir `C:\Users\dlwta\.al-ai\pgdata`، **منفذ 55432**، و`psql` ليس على `PATH`.
  **5432 مشغول — لا تلمسه.** **اقرأ `information_schema.columns` قبل أي استعلام** (الأسماء غير بديهية:
  `guild_health.gateway_events_last_minute`).
- **لا `SIGTERM`/`SIGINT` لعملية منفصلة على ويندوز** ⇒ **الإغلاق الرشيق يُختبر في Docker/Linux لا هنا**،
  ودليله **ملف القفل**: زواله = المسار عمل، بقاؤه = قتل قسري.
- **`.env` غير مُتتبَّع** (`.env.example` هو العقد المُلتزم). **ومسار صحة محوّل التكامل `GET /ping` لا `/health`.**
- **`.workbuddy-ai/memory/*.md` مُتتبَّعة ومرفوعة لمستودع عام** — لا أسرار؛ `backups/` و`preview/` **مُتَجاهَلان**.
