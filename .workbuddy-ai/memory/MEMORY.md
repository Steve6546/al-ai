# AL AI — Discord bot + لوحة تحكم

Monorepo: `apps/bot` (discord.js) + `apps/dashboard` (Fastify BFF + React SPA RTL) + `packages/core`
(المصدر الوحيد للعقود). **قواعد فقط** — القصص في السجلات اليومية، والإجراءات في المهارات (`→`).

## التشغيل
- `npm run verify` = lint + check:schema + test + build. **اقرأ `# skipped` لا `# pass`**: بلا قاعدة حيّة
  يتخطّى `storage.test.ts` بصمت ويرجع **exit 0**. شغّل PostgreSQL على **55432** أولاً.
- **⚠️ سكربتات الـworkspace تعمل بـcwd = مجلد الحزمة** ⇒ `dotenv` لا يرى `.env` في الجذر. كل سكربت
  يلزمه `--env-file=../../.env` (مضاف للبوت واللوحة). بدونه `npm run start -w @al-ai/bot` **يخرج 0 بلا
  تشغيل** (بوّابة الأسرار)، و`deploy-commands` يرمي «BOT_TOKEN مطلوب» وهو موجود. من الجذر `dotenv/config`
  هو ما يعمل. **`tsx` بلا hot-reload** ⇒ أعد التشغيل بعد كل تعديل خلفي، وإلا خدمت مسارات قديمة (404).
- **التسليم:** `present_files` بمسار مطلق. **إثبات الواجهة:** طابق بصمة الحزمة المخدومة مع `dist/assets/`.
- **⚠️ كتابة الملفات تُسقَط أحياناً بصمت:** `Edit`/`Write` يُبلّغان بالنجاح والملف لا يتغيّر (وقع 7 مرات).
  **تحقّق بـ`grep`/`md5sum` بعد كل كتابة حرجة — لا تثق برسالة النجاح.**

## 🔴 Git — → `al-ai-git-recovery`
`.git` مشترك مع `glyph-agent`؛ `origin` → `Steve6546/al-ai`.
- **⛔ لا `git rm`** (أتلف ملفات غير متعقَّبة) — احذف بـ`rm` بعد **`git add -A`**.
  **⛔ لا `git stash`** — انسخ الملف إلى `.workbuddy-ai/` لإثبات الانحدار.
- **مراجع التتبّع لا تُحفظ** ⇒ تحقّق بـ`git ls-remote origin refs/heads/main` **فقط**، واكتب
  `.git/refs/remotes/origin/main` يدوياً **آخر شيء**.
- **الدفع:** `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true timeout 150 git push origin main`.
  **⛔ `gh auth setup-git` يخرج 0 وهو فاشل.** **رسالة commit: ملف خارج المستودع ثم `git commit -F`**
  بمسار ويندوز `C:/…` (لا `/c/…`، وإلا `could not read log file`).

## Discord API
- **لا `@me` في مسار عضو السيرفر** (GET ⇒ 400/403) — الصحيح `GET /users/@me` ثم
  `/guilds/{id}/members/{botUserId}`. استثناء: **`PATCH .../members/@me` مقبول**.
- **`permissions` = `0` لرمز بوت** حتى مع Administrator ⇒ ابنِها من `@everyone` (معرّفه = معرّف السيرفر)
  + أدوار العضو، **وافحص 0x8 أولاً**. **«مجهول» ليس `false`:** `granted` ثلاثي.
- كل قراءة بـ`.catch(() => null)` تفشل **بصمت** ⇒ الاختبار يثبّت **شكل الطلب** لا النتيجة، والخطّاف يطابق
  بـ`includes` ⇒ رتّب الأكثر تحديداً أولاً.
- **النبذة عبر `PATCH /applications/@me {description}`** — `/users/@me {bio}` يُهمَل صامتاً بـ200.
  **`Presence Intent` ممنوع** (حوكمة 8).
- **🔴 أحداث: `Events.*` لا نصّاً.** discord.js **يبعث بالقيمة**، و**مفتاح ≠ قيمة**:
  `Events.GuildEmojiCreate` قيمته `emojiCreate` ⇒ `client.on("guildEmojiCreate")` **ميت تماماً**، أما
  `"clientReady"` فهو **القيمة نفسها**. **لا تستنتج «ميت» من نمط ثابت — شغّل السلوك.** (فُحصت 23 تسجيلة
  مقابل 14.27.0: سليمة.) **`Events` يُعاد تصديره من `lib/discord.ts`** (rule 2)، و`discord-standards.test.ts`
  يطابق `Object.values(Events)`. **جرّد التعليقات قبل أي فحص نصّي.**

## تصنيف الأخطاء
`isAuthFailure` **401 فقط** و`isRateLimited` **429 فقط** — قبلها كل خطأ صار «توكن منتهٍ» ⇒ 429 يُتلف
جلسة سليمة.
- `loadUserGuilds` **المصدر الوحيد** لسيرفرات المستخدم: 401 ⇒ إتلاف + `SESSION_EXPIRED` / 429 ⇒
  `429 RATE_LIMITED` + `retry-after` **والجلسة سليمة** / غير ذلك ⇒ 503. أي نداء مباشر جديد
  لـ`fetchUserGuilds` يُسقط `route-guards.test.ts`.
- `/api/guilds` بـ**`Promise.allSettled`** (لا كتابة في `reply` بعد الرد ⇒ `FST_ERR_REP_ALREADY_SENT`).

## منع 429 — → `al-ai-stack-verify`
**الانفجار نفسه هو المشكلة**، **وحدّ Discord لكل تطبيق لا لكل مسار.** `TtlCache.resolve(key, load)`
**تدمج الطلبات الجارية** (نداء ثانٍ ينتظر الوعد القائم — **هذا ما يقتل الانفجار لا الـTTL**).
**`fetchBotMemberShared` بلا TTL عن قصد.** (الفخاخ الأربعة في المهارة.)

## 🔴 الشاشة السوداء — → `react-jsdom-mount-test`
hook بعد `if (error) return` ⇒ `Rendered more hooks than during the previous render` — **يُزيل الشجرة
كلها**. **القاعدة: كل hook فوق كل early return.** `renderToString` **لا ينفّذ التأثيرات** ⇒ الحارس
`test/mount.test.tsx` (jsdom + `createRoot`) يركّب الشاشات السبع **مُحمَّلة**، و`error-boundary.tsx`
يلفّ **محتوى الشاشة فقط لا الـshell**.

## عقود المسارات
**كل مسار إعدادات يجيب `{ settings, ... }`** (استثناء مقبول: `tiers`/`security/config` يعيدان شكلاً
مكتوباً — الطرفان متطابقان). انحراف ⇒ مسودة `null` ⇒ شاشة سوداء، **والحالة 200 سليمة** ⇒ **الانحراف يظهر
كخطأ عميل لا خادم.** طابق `src/api/client.ts`. (فُحصت 19 نداءً: كل مسار+method له مسار مسجَّل.)
- **الغائب ≠ `null`:** الغائب «اتركه» و`null` «امسحه». **ورفض على مستوى الحقل لا الطلب:** حقل مبوَّب
  يُسقَط ويُبلَّغ كـ`FieldOutcome` بدل `409` يُسقط النموذج كله. **وحدّد الفحص على «تغيّر فعلاً».**
- **`PUT /api/bot/identity` ⇒ 400 `GUILD_ID_REQUIRED` عند غياب `guildId` — مقصود ومُثبت
  (`route-guards.test.ts:180`).** أول قراءة قاعدة **بعد** `requireTierForGuild`، و`guildId` مشوّه يعطي
  **نفس الـ400** ⇒ لا كاشف وجود سيرفر. **لا «تصلح» الترتيب.**

## الأوامر والتخصيص
- **المنع يتقدّم على السماح.** **`permanent` = `null` لا `0`**. `TIMEOUT_MAX_SECONDS` تُقصّ **عند التحويل
  إلى ثوانٍ فقط**. (المدد الـ11 و`CommandCategory` في `packages/core`.)
- **⛔ لا تفرض في Discord ما يقرّره المشغّل:** `required` **يُجمَّد وقت التسجيل** ⇒ الفرض في البوت.
- `/mute` ملغاة. معالج الأوامر **لا يسجّل العقوبات** (الـgateway يفعل) عدا `warn`/`clearwarns`.
- **الهوية العامة** في `bot_identity` (صف واحد)، **ولكل سيرفر** في `guild_customization`. **اللوحة
  الكاتب الوحيد للظهور؛ البوت لا يكتب الظهور** — كتابته الوحيدة **النبضة** (`presence-sync.ts`).
  ⇒ **لا اسم بوت في `control-plane.json`**: الاسم مملوك للبوابة و`bot_identity`.
- **`FieldOutcome` تُبلَّغ ولا تُبلع**؛ الحفظ يحدث **حتى لو رفض Discord** والرد يفصل «محفوظ» عن «منفّذ».
- **أيقونة الرتبة تحت المستوى 2:** **لا `409`** — الحقل يُقفل، **ويُحذف من الحمولة**، والرفض يُبلَّغ
  كـ`FieldOutcome`. **حقل مُقفل يجب أن يكون غير قابل للاختيار لا للكتابة فقط.**
- **`resolveRoleIcon()`:** `undefined` = اتركها و`null` = امسحها. **قيمة فشلت التحقق ⇒ 400 لا `null`.**
  و**`dirty` بمقارنة حقلاً حقلاً لا `JSON.stringify`**.
- **لا تُعِد تعريف ثابت في core** (`STATUS_LABELS`/`ACTIVITY_LABELS` تباعدت)، و**`hsvToRgb` كان يُبدّل
  لون المشغّل بصمت** — الحارس: كل `DISCORD_ROLE_SWATCHES` تنجو من `rgbToHex(hsvToRgb(rgbToHsv(x)))`.
- **كل حدث في شاشة السجلات يلزمه تسمية عربية** (`eventCopy[id] ?? id` يُخفي الفجوة) —
  `apps/dashboard/test/log-labels.test.ts`.

## 🔴 المعمارية والترحيل — → `repo-architecture-audit`
- **`ADD COLUMN` قبل كتلة `RENAME` المحروسة يُبطِلها بصمت**، و`CREATE TABLE IF NOT EXISTS` **لا يُحدِّث
  default قائماً** ⇒ `ALTER COLUMN ... SET DEFAULT`. **الترتيب حمولة لا تنظيم، والفحص الوحيد الذي
  يلتقطه: قاعدة جديدة من الصفر.**
- **🔴 `FOR EACH ROW` لا يُطلَق إن لم يُطابق أي صف** ⇒ `DELETE ... WHERE <لا صفوف>` يعيد **`DELETE 0`
  بلا خطأ**. **ولا يعمل على `TRUNCATE`** ⇒ `BEFORE TRUNCATE ... FOR EACH STATEMENT` +
  `REVOKE TRUNCATE ... FROM PUBLIC`. **إثباته: `BEGIN … ROLLBACK` على صفوف موجودة.**
- **🔴 الإعداد بلا قارئ = زخرفة — والتحقق يُبنى في القارئ لا في موضع النداء.**
  `loadControlPlane()` **يفحص نفسه عند القراءة** (`assertControlPlane`)، فحذف `gateway.ceilingPerMinute`
  كان يصل `undefined` و**ثابت `EventPipeline` يملأ 120 بصمت**. **كل مشكلة تُجمَع وتُرمى مرة واحدة.**
  `schemaVersion` **مفروض** في الملفين (1/2) — وإلا فترقية الملف بلا أثر. **`null` = «لم يُقرَّر»**
  (يرفعه `undecidedSettings` ويوقف الإقلاع في production) — **وليس ملفاً معطوباً**: الفاحص يقبل `null`
  ويرفض النوع الخطأ. و`retention`/`encryption`/`commands.deployment` قرارات مسجَّلة بلا سلوك (`auditDays`
  مستحيل: append-only) — **مُوثَّقة، لا «مُصلَحة»**.
- **🔴 قاعدة واحدة بلا نسختين.** شيخوخة النبضة كانت **مكتوبة مرتين** على نفس الثابت — **واختبار على جهة
  واحدة لا يكشف انحراف الأخرى**. الحل: `isHeartbeatFresh`، وكذلك `clampInteger`، و`severity` (أدناه).
  و`sourceLayer` كان **مكتوباً كنصّ في `index.ts`** ⇒ الآن `controlPlane.instance.sourceLayer`.
- **لا تعرض رقماً لا تعرفه:** `pingMs`/`online` من نبضة حديثة لا من وجود توكن (rule 8). **ملكية البيانات:**
  البوت يملك `guilds.member_count`/`ping_ms`؛ اللوحة تبذر الصف فقط (`ensureGuild` = `ON CONFLICT DO NOTHING`).
  **مضاد التخريب مُسلَّح افتراضياً؛** تغيير الـdefault **لا يعيد كتابة الصفوف**، و`tripped` عند
  `count > limit` مع احتواء قبل الإشعار. **الحجر (`latched`) في الذاكرة والاحتواء
  (`roles.set`) في Discord** ⇒ إعادة التشغيل تُنسى الحجر ولا تُكرِّر العقوبة، والأثر الحقيقي = إشعار ثانٍ.
  **`release()`/`isLatched` بلا نداء إنتاجي** (مثل `countFor`/`reset`) — تصحيح التعليق لا حذف الواجهة.
- **كل مسار مرتبط بسيرفر يتحقق من الوصول للسيرفر لا من الجلسة** (`requireGuildAccess` قراءة /
  `requireTierForGuild` كتابة). `route-guards.test.ts` يفحص الجدول نصياً.
- **`discord.js` في ملف واحد فقط:** `apps/bot/src/lib/discord.ts` (rule 2).
- **🔴 `npx tsc` يحلّ لكل مجلد** (الجذر 5.2.2 مقابل الحزم 7.0.2 ⇒ «أخطاء» وهمية) ⇒ **تحقّق من
  `--version` داخل الحزمة.** **TS 7 أزال `baseUrl`** ⇒ `paths` فقط.
- **منقّح «الكود الميت» يكذب** ⇒ **افحص داخل الملف وثبّت الجذر قبل الحذف.** (فُحص: صفر تصدير ميت فعلاً؛
  227 تصديراً مستعملاً داخل ملفه فقط = زائد عن الحاجة لا ميت.) (التفصيل في المهارة.)
- **🔴 `severity` تُقرأ من السكيما لا من المستدعي.** مواضع النداء السبعة كانت تمرّر `"warning"` ⇒
  `bot.security-rejection` (المعلَن `critical`) يُخزَّن `warning`. الآن `requireEvent(eventId).severity`
  و**الحقل محذوف من نوع السجل** ⇒ لا يستطيع مستدعٍ أن يخطئ. و`audit_trail` **يرفض UPDATE**.
- **السجلات:** كتابة التدقيق **قبل** أي كتم (rule 12)، و`log-router.ts` **لا يكتب في `audit_trail` عند
  `severity === "info"`**. **اللوحة:** `types.ts` يُعيد تصدير عقود `@al-ai/core/browser`؛ **لا تُكرّر
  شكلاً في core**، و**`notice` و`authNotice` منفصلان**.
- **الاعتماديات:** الـlockfile **مُتتبَّع**، و**لا `"latest"` في أي manifest** (مثبَّتة على نسخة الـlock
  بـ`^`) — `latest` مع `npm install` كان يعيد كتابة الـlock داخل الصورة ⇒ صورة غير قابلة للتكرار.
  **والـDockerfiles تستعمل `npm ci`** (الـlock يُنسخ قبل التثبيت؛ مُثبَت في سياق بناء محاكى).
  **⛔ لا تنقل `tsx`/`typescript` إلى devDependencies** — ملفا Docker يشغّلان `tsx` في `CMD`.
- **القفل (`supervisor.ts`)** مثبَّت على **جذر المستودع** مشتقاً من `import.meta.url`، **و`BOT_LOCK_FILE`
  النسبي يُحلّ على الجذر لا على cwd** — البوت موثَّق بالتشغيل من الجذر ومن `apps/bot`، والقفل النسبي كان
  يعطي **ملفَّي قفل** ⇒ نسختان حيّتان على توكن واحد. **وأي عملية إضافية (npx/tsx) تُمرِّر الإشارة؟**
- **`uncaughtException` تُرك لـNode عن قصد** (لا استمرار بعدها، والمنفّذ هو الكود الذي رمى) — الإشارات
  وحدها تفلش. **مُوثَّق في `index.ts` لا «مُصلَح».**

## 🔴 الحوكمة — مُفروضة باختبار
`docs/GOVERNANCE.md` = **27 قاعدة**، والكود يحمل `GOVERNANCE rule N`. `governance.test.ts`:
- **العدد مثبَّت (27) ومرقّم 1..27 بلا فجوات** ⇒ **إضافة قاعدة = تعديل الوثيقة + الاختبار معاً**، و**كل
  إشارة في الكود يجب أن تشير لقاعدة موجودة**، و**[2,3,5,7,10..19,24..27] يجب أن تكون مُشاراً إليها.**
- **فصل الطبقات:** core لا يستورد إلا `node:crypto`، والـSPA لا يصل للبوت/الخادم، والبوت لا يصل للوحة.
  **لا دورات استيراد.** **`discord-permissions.ts` الاستثناء الوحيد** لتكرار ثوابت Discord، **مُصدَّر من
  `index.ts` فقط لا `browser.ts`** (قيم `bigint`).
- **حارس مُعلَن-بلا-مُنتِج:** `routing.test.ts` يثبّت أن **كل حدث في السكيما له مُنتِج**. (فُحص 39/39،
  وصفر إصدار بمعرّف غير مسجَّل — `logEvent` يمرّ بـ`validateEvent`.)
  **⚠️ لا تستدلّ على «بلا مُنتِج» من صفوف `audit_trail`:** `bot.health` (info) = **0 صف وهو الصحيح**.
- **متغيّر بيئة يقرأه الكود ولا يوثّقه `.env.example` = عطل صامت** (`DEVELOPER_WEBHOOK_URL` و`NODE_ENV`
  و`PORT` و`POSTGRES_HOST_PORT` و`AL_AI_TOOLCHAIN` كانت كذلك). الحارس: `env-template.test.ts` يمسح
  **ثلاث صيغ** — `process.env.X`، `process.env["X"]`، و**`read("X")` في `server/env.ts`**. **وجرّد
  التعليقات أولاً** وإلا طابق شرحه لنفسه.

## الفحص والكود الميت — → `al-ai-stack-verify`
- **«مُختبَر» ليس «مُوصَّل»** (`prune()`/`release()` كانا مُختبَرَين وبلا نداء؛ `prune()` وحده كان يخفي
  **27MB** تسريباً — وُصل).
- **إثبات الانحدار:** عطّل الكود ⇒ راقب **الاختبار المحدد** الذي يسقط ⇒ أعِد الملف **مطابقاً بـ`md5sum`**.
  **⚠️ عطّل شيئاً واحداً:** تعطيل قيمتين متناسقتين معاً يُبقي الاختبار ناجحاً زوراً.
- **⚠️ ماسح نجح/فشل يثبت أن الماسح يعمل، لا أن عطلاً كان موجوداً.**

## البيئة (Windows) — → `al-ai-stack-verify`
- PostgreSQL 17، data dir `C:\Users\dlwta\.al-ai\pgdata`، **منفذ 55432**، و`psql` ليس على `PATH`.
  **5432 مشغول — لا تلمسه.** **اقرأ `information_schema.columns` قبل أي استعلام** (الأسماء غير بديهية:
  `guild_health.gateway_events_last_minute`).
- **لا `SIGTERM`/`SIGINT` لعملية منفصلة على ويندوز** ⇒ **الإغلاق الرشيق يُختبر في Docker/Linux لا هنا**،
  ودليله **ملف القفل**: زواله = المسار عمل، بقاؤه = قتل قسري. **وقفل معلَّق بمُعرّف ميت يُستصلَح تلقائياً.**
- **`.env` غير مُتتبَّع** (`.env.example` هو العقد المُلتزم). **ومسار صحة محوّل التكامل `GET /ping` لا `/health`.**
- **`.workbuddy-ai/memory/*.md` مُتتبَّعة ومرفوعة لمستودع عام** — لا أسرار؛ `backups/` و`preview/`
  **مُتَجاهَلان**. (قواعد `--noproxy '*'`، `run_in_background`، `pg_ctl`: في المهارة و`~/.workbuddy-ai/MEMORY.md`.)
