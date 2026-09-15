# AL AI — Discord bot + لوحة تحكم

Monorepo: `apps/bot` (discord.js) + `apps/dashboard` (Fastify BFF + React SPA RTL) + `packages/core`
(المصدر الوحيد للعقود). **قواعد فقط** — القصص في السجلات اليومية، والإجراءات في المهارات (تُشار إليها بـ`→`).

## التشغيل
- `npm run verify` = lint + check:schema + test + build. **اقرأ `# skipped` لا `# pass`**: بلا قاعدة حيّة
  يتخطّى `storage.test.ts` بصمت ويرجع **exit 0**. شغّل PostgreSQL على **55432** أولاً.
- اللوحة: `cd apps/dashboard && ../../node_modules/.bin/tsx --env-file=../../.env server/index.ts`.
  **`node` على ملف يستورد `server/*.ts` يفشل**. **`tsx` بلا hot-reload** ⇒ أعد التشغيل بعد كل تعديل خلفي.
- **التسليم:** `present_files` بمسار مطلق. **إثبات الواجهة:** طابق بصمة الحزمة المخدومة مع `dist/assets/`.
- **⚠️ كتابة الملفات تُسقَط أحياناً بصمت:** `Edit`/`Write` يُبلّغان بالنجاح والملف لا يتغيّر (وقع 7 مرات
  في جولة). **تحقّق بـ`grep`/`md5sum` بعد كل كتابة حرجة — لا تثق برسالة النجاح.**

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
  `"clientReady"` فهو **القيمة نفسها** ⇒ يعمل. **لا تستنتج «ميت» من نمط ثابت — شغّل السلوك.**
- **`Events` يُعاد تصديره من `lib/discord.ts`** (rule 2). الحارس `discord-standards.test.ts` يمسح كل
  شجرة البوت ويطابق `Object.values(Events)`. **جرّد التعليقات قبل الفحص النصّي.**

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
**كل مسار إعدادات يجيب `{ settings, ... }`** — انحراف إلى `{ identity }` ⇒ مسودة `null` ⇒ شاشة سوداء،
**والحالة 200 سليمة** بلا 500 ولا سطر سجل ⇒ **الانحراف يظهر كخطأ عميل لا خادم.** طابق `src/api/client.ts`.
- **الغائب ≠ `null`:** الغائب «اتركه» و`null` «امسحه». **ورفض على مستوى الحقل لا الطلب:** حقل مبوَّب
  يُسقَط ويُبلَّغ كـ`FieldOutcome` بدل `409` يُسقط النموذج كله. **وحدّد الفحص على «تغيّر فعلاً».**
- **`PUT /api/bot/identity` ⇒ 400 `GUILD_ID_REQUIRED` عند غياب `guildId` — مقصود ومُثبت
  (`route-guards.test.ts:180`).** أول قراءة قاعدة **بعد** `requireTierForGuild`، و`guildId` مشوّه يعطي
  **نفس الـ400** ⇒ لا كاشف وجود سيرفر. **لا «تصلح» الترتيب.**

## الأوامر والتخصيص
- **المنع يتقدّم على السماح.** **`permanent` = `null` لا `0`**. `TIMEOUT_MAX_SECONDS` تُقصّ **عند التحويل
  إلى ثوانٍ فقط**. (المدد الـ11 و`CommandCategory` في `packages/core`.)
- **⛔ لا تفرض في Discord ما يقرّره المشغّل:** `required` **يُجمَّد وقت التسجيل** ⇒ الفرض في البوت.
  `config/channels.json` يطابق السكيما **بالضبط** (rule 15) وإلا رفض الإقلاع.
- `/mute` ملغاة. معالج الأوامر **لا يسجّل العقوبات** (الـgateway يفعل) عدا `warn`/`clearwarns`.
- **الهوية العامة** في `bot_identity` (صف واحد)، **ولكل سيرفر** في `guild_customization`. **اللوحة
  الكاتب الوحيد للظهور؛ البوت لا يكتب الظهور** — كتابته الوحيدة **النبضة** (`presence-sync.ts`).
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
  بلا خطأ** — «نجاح» وهمي. **و`FOR EACH ROW` لا يعمل على `TRUNCATE`** ⇒ `BEFORE TRUNCATE ... FOR EACH
  STATEMENT` + `REVOKE TRUNCATE ... FROM PUBLIC`. **إثباته: `BEGIN … ROLLBACK` على صفوف موجودة.**
- **🔴 إعداد في `control-plane.json` بلا قارئ = زخرفة.** `new EventPipeline()` كان بلا وسائط ⇒
  `gateway.ceilingPerMinute`/`voiceDebounceMs` لا تفعل شيئاً. **أي قيمة جديدة يلزمها قارئ + اختبار يثبّت
  الوصل.** و`retention`/`encryption` **بلا قارئ**، و`AUDIT_RETENTION_DAYS`/`KEY_ROTATION_DAYS`
  **إلزامية وصفر قارئ**، و**`auditDays` مستحيل** (append-only). **مفتوح — قرار المالك.**
- **🔴 قاعدة واحدة بلا نسختين.** شيخوخة النبضة كانت **مكتوبة مرتين** (`deriveBotStatus` و`/api/health`
  مضمّنة) على نفس الثابت — **واختبار على جهة واحدة لا يكشف انحراف الأخرى**. الحل: `isHeartbeatFresh`،
  وكذلك `clampInteger`، و`severity` (أدناه).
- **لا تعرض رقماً لا تعرفه:** `pingMs`/`online` من نبضة حديثة لا من وجود توكن (rule 8 تمنع
  `GUILD_PRESENCES`). **ملكية البيانات:** البوت يملك `guilds.member_count`/`ping_ms`؛ اللوحة تبذر الصف
  فقط (`ensureGuild` = `ON CONFLICT DO NOTHING`). **مضاد التخريب مُسلَّح افتراضياً؛** تغيير الـdefault
  **لا يعيد كتابة الصفوف**، و`tripped` عند `count > limit` مع احتواء قبل الإشعار.
- **كل مسار مرتبط بسيرفر يتحقق من الوصول للسيرفر لا من الجلسة** (`requireGuildAccess` قراءة /
  `requireTierForGuild` كتابة). `route-guards.test.ts` يفحص الجدول نصياً.
- **`discord.js` في ملف واحد فقط:** `apps/bot/src/lib/discord.ts` (rule 2).
- **🔴 `npx tsc` يحلّ لكل مجلد** (الجذر 5.2.2 مقابل الحزم 7.0.2 ⇒ «أخطاء» وهمية) ⇒ **تحقّق من
  `--version` داخل الحزمة.** **TS 7 أزال `baseUrl`** ⇒ `paths` فقط.
- **منقّح «الكود الميت» يكذب** (يُظهر المستخدَم داخل الملف كميت، و`endsWith` لا يطابق بمسار نسبي) ⇒
  **افحص داخل الملف وثبّت الجذر قبل الحذف.** (التفصيل في المهارة.)
- **🔴 `severity` تُقرأ من السكيما لا من المستدعي.** `appendAudit` كان يستقبلها، و**مواضع النداء السبعة**
  كلها تمرّر `"warning"` ⇒ `bot.security-rejection` (المعلَن `critical`) يُخزَّن `warning` ويُرسم كهرماني
  ويُستبعد من عدّاد `critical`. الآن `requireEvent(eventId).severity` و**الحقل محذوف من نوع السجل** ⇒
  لا يستطيع مستدعٍ أن يخطئ. و`audit_trail` **يرفض UPDATE** ⇒ القديمة لا تُصحَّح.
- **السجلات:** كتابة التدقيق **قبل** أي كتم (rule 12)، و`log-router.ts` **لا يكتب في `audit_trail` عند
  `severity === "info"`**. **اللوحة:** `types.ts` يُعيد تصدير عقود `@al-ai/core/browser`؛ **لا تُكرّر
  شكلاً في core**، و**`notice` و`authNotice` منفصلان**. **والاعتماديات كلها `"latest"`** والـDockerfiles
  تعمل `npm install` **بلا lock** (مفتوحة).

## 🔴 الحوكمة — مُفروضة باختبار
`docs/GOVERNANCE.md` = **27 قاعدة**، والكود يحمل `GOVERNANCE rule N`. `governance.test.ts`:
- **العدد مثبَّت (27) ومرقّم 1..27 بلا فجوات** ⇒ **إضافة قاعدة = تعديل الوثيقة + الاختبار معاً**، و**كل
  إشارة في الكود يجب أن تشير لقاعدة موجودة**، و**[2,3,5,7,10..19,24..27] يجب أن تكون مُشاراً إليها.**
- **فصل الطبقات بثلاثة اختبارات:** core لا يستورد إلا `node:crypto`، والـSPA لا يصل للبوت/الخادم، والبوت
  لا يصل للوحة. **لا دورات استيراد.**
- **`packages/core/src/discord-permissions.ts` الاستثناء الوحيد** لتكرار ثوابت Discord، **مُصدَّر من
  `index.ts` فقط لا `browser.ts`** (قيم `bigint`).
- **حارس مُعلَن-بلا-مُنتِج:** `routing.test.ts` يثبّت أن **كل حدث في السكيما له مُنتِج في المستودع كله**.
  **⚠️ لا تستدلّ على «بلا مُنتِج» من صفوف `audit_trail`:** `bot.health` (info) = **0 صف وهو الصحيح**،
  وصفوف info التي تُرى تأتي من **اللوحة**. الدليل = الحارس أو سطر حيّ. (ادّعيتُ العكس خطأً.)
- **متغيّر بيئة يقرأه الكود ولا يوثّقه `.env.example` = عطل صامت:** `DEVELOPER_WEBHOOK_URL` و`NODE_ENV`
  و`PORT` و`POSTGRES_HOST_PORT` و`AL_AI_TOOLCHAIN` كانت كذلك. الحارس: `apps/bot/test/env-template.test.ts`
  يمسح **ثلاث صيغ** — `process.env.X`، `process.env["X"]`، و**`read("X")` في `server/env.ts`** (وهي التي
  تفوّت ماسح `process.env` وحده). **وجرّد التعليقات أولاً** وإلا طابق شرحه لنفسه.

## الفحص والكود الميت — → `al-ai-stack-verify`
- **`tracker.prune()` و`release()` كانا مُختبَرَين وبلا نداء إنتاجي** — **«مُختبَر» ليس «مُوصَّل»**،
  و`prune()` وحده كان يخفي **27MB** تسريباً (وُصل). **`release()`/`isLatched` مفتوحان** (لا واجهة لفكّ الحجر).
- **إثبات الانحدار:** عطّل الكود ⇒ راقب **الاختبار المحدد** الذي يسقط ⇒ أعِد الملف **مطابقاً بـ`md5sum`**.
  **⚠️ ماسح نجح/فشل يثبت أن الماسح يعمل، لا أن عطلاً كان موجوداً.**
- **⛔ لا تنقل `tsx`/`typescript` إلى devDependencies:** ملفا Docker يشغّلان `npx tsx` في `CMD`.

## البيئة (Windows) — → `al-ai-stack-verify`
- PostgreSQL 17، data dir `C:\Users\dlwta\.al-ai\pgdata`، **منفذ 55432**، و`psql` ليس على `PATH`.
  **5432 مشغول — لا تلمسه.** **اقرأ `information_schema.columns` قبل أي استعلام** (الأسماء غير بديهية:
  `guild_health.gateway_events_last_minute`).
- **لا `SIGTERM`/`SIGINT` لعملية منفصلة على ويندوز** ⇒ **الإغلاق الرشيق يُختبر في Docker/Linux لا هنا**،
  ودليله **ملف القفل**: `lock.release()` آخر خطوة ⇒ زواله = المسار عمل، بقاؤه = قتل قسري.
- **`.env` غير مُتتبَّع** (`.env.example` هو العقد المُلتزم). **ومسار صحة محوّل التكامل `GET /ping` لا `/health`.**
- **`.workbuddy-ai/memory/*.md` مُتتبَّعة ومرفوعة لمستودع عام** — لا أسرار؛ `backups/` و`preview/`
  **مُتَجاهَلان**. (قواعد `--noproxy '*'`، `run_in_background`، `pg_ctl`: في المهارة و`~/.workbuddy-ai/MEMORY.md`.)
