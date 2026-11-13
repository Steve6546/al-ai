# AL AI — بوت Discord + لوحة تحكم

`apps/bot` (discord.js) + `apps/dashboard` (Fastify BFF + React SPA RTL) + `packages/core` (العقود).
**قواعد فقط**؛ القصص في السجلات اليومية.

**ملفات مرافقة في هذا المجلد — اقرأها عند العمل في مجالها:**
- `RULES-UI.md` — التمرير والقوائم، الشاشة السوداء، تركيب React.
- `RULES-CONTRACTS.md` — عقود المسارات، الأوامر والتخصيص، الهوية، الاختصارات.
- `RULES-DISCORD.md` — واجهة Discord، تصنيف الأخطاء، منع 429.
- `RULES-ARCH.md` — الترحيل والسكيما، الحوكمة (27 قاعدة)، منهج الفحص.

**المهارات:** لا توجد مهارات داخل المستودع بعد الآن؛ المهارات الموجودة في `.agents/skills` هي أدوات
HeroUI فقط. **فحوص المشروع الحيّة هي:** `scripts/ui-check.mjs` (متصفح حقيقي: العرضان، الوضعان، قائمة
الحساب، تبويب المظهر في الإعدادات، **axe-core**، وصفحات حيّة بـ`--live`) · `scripts/oauth-check.mjs` (دورة OAuth
و`state` وحارس CSRF والخروج) · `scripts/load-check.mjs` (زمن الاستجابة وتأخير Event loop والذاكرة).
ما كان في `.workbuddy-ai/verify/` أدوات جولة سابقة؛ `browser-check.mjs` أقدم منها وما زال يُشغَّل يدويًا.
**كثير من القواعد مُفروضة باختبار** ⇒ `npm run verify` يكشفها. ما في هذه الصفحة هو **ما لا يكشفه اختبار**.

## التشغيل والبيئة — → `al-ai-stack-verify`
- `npm run verify` = lint + check:schema + test + build. **اقرأ `# skipped` لا `# pass`**: بلا قاعدة حيّة يتخطّى
  `storage.test.ts` بصمت ويرجع **exit 0**.
- PostgreSQL 17 على **55432** (`C:\Users\dlwta\.al-ai\pgdata`)؛ `psql` ليس على `PATH`؛ **5432 مشغول — لا تلمسه**.
  اقرأ `information_schema.columns` قبل أي استعلام.
- **⚠️ ngrok + بروكسي الـsandbox لا يجتمعان:** المتغيّرات `http_proxy`/`https_proxy` الموروثة تُسقط
  الوكيل بـ`ERR_NGROK_9009` (خطة مجانية ترفض البروكسي) فيخرج برمز 1 ثم يتوقف بعد 3 محاولات.
  شغّل النفق بـ`env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY npm run dev -- -Tunnel`
  كمهمة خلفية مُدارة؛ الدليل `apps/dashboard/.al-tunnel.log` وواجهة ngrok المحلية `:4040/api/tunnels`.
- سكربتات الـworkspace بـcwd = مجلد الحزمة ⇒ `--env-file=../../.env`. **`tsx` بلا hot-reload** ⇒ أعد التشغيل بعد
  كل تعديل خلفي وإلا خدمت مسارات قديمة (404).
- **التسليم** `present_files` بمسار مطلق؛ **إثبات الواجهة** = طابق بصمة الحزمة المخدومة مع `dist/assets/`.
- **⚠️ كتابة الملفات تُسقَط بصمت** ⇒ تحقّق بـ`grep`/`md5sum`. **⚠️ جرّد التعليقات قبل أي فحص نصّي** — Tailwind يمسح
  التعليقات، واسم صنف داخل شرح **يولّد قاعدته في CSS** فيُضلّل `grep`.
- **لا `SIGTERM`/`SIGINT` لعملية منفصلة على ويندوز** ⇒ **الإغلاق الرشيق يُختبر في Docker/Linux**، ودليله **ملف
  القفل**: زواله = المسار عمل، بقاؤه = قتل قسري.
- **`.env` غير مُتتبَّع** (`.env.example` هو العقد). **صحة محوّل التكامل `GET /ping` لا `/health`**.
- **`.workbuddy-ai/memory/*.md` مُتتبَّعة ومرفوعة لمستودع عام** — لا أسرار؛ `backups/`/`preview/` **مُتَجاهَلان**.
- **الفحص الحيّ:** `scripts/ui-check.mjs` (متصفح حقيقي: العرضان، الوضعان، قائمة الحساب، تبويب المظهر في الإعدادات،
  **axe-core**، وصفحات حيّة بـ`--live`) · `scripts/oauth-check.mjs` (دورة OAuth و`state` وحارس CSRF
  والخروج) · `scripts/load-check.mjs` (زمن الاستجابة وتأخير Event loop والذاكرة). ما في
  `.workbuddy-ai/verify/` أدوات جولة سابقة (و`browser-check.mjs` أقدمها). **جلسة حقيقية من `oauth_sessions` — العمود `id` هو قيمة الكوكي**، واسمها
  **`__Host-al_ai_session`** في `NODE_ENV=production` و`al_ai_session` خارجه ⇒ **اسم خاطئ = صفحات
  مسجَّلة-خروجاً وتقرير «clean» كاذب** (`dev-issue-session.mts` توكنه وهمي ⇒ 401).
  **سيرفر الفحص:** `1523473815555018782`. **⚠️ لا `curl` بلا `--noproxy '*'`** — الوكيل يرد **502** مضلِّلاً.
- **⚠️ لا تُبوِّب رسم بيانات على إذن التحرير.** `isPlatformOwner && draft !== null` أخفى أقساماً
  **وصلت بياناتها فعلاً** عن كل مشرف سيرفر، فبدت الشاشة كأنها لم تكسبها قط. **الرؤية = وجود البيانات؛
  التحرير = الإذن** — متغيّران لا واحد.
- **⚠️ مسبار المصادقة بعد `Page.navigate` لا قبله:** على `about:blank` لا أصل للـ`fetch` النسبي فيرد
  `false` لكل أسماء الكوكيز ويبدو كجلسة مرفوضة.
- **⚠️ اختبار يكتب حالة حيّة يجب أن يُعيدها** (لقطة + استعادة في `after()` **قبل** `pool.end()`).
  `bot_identity` **جدول صفّ واحد يملكه النشر**، لا الوحَدة. التفصيل في `RULES-ARCH.md`.

## نسخة واحدة من كل خدمة (جولة 2026-11-11) — → السجل اليومي
- **`npm run dev` هو المُشغّل الوحيد.** `dev:bot`/`dev:dashboard` تفوّضان إلى `dev.ps1`،
  و`dev` داخل الحزمة = `node --import tsx` **بلا `tsx watch`**: المراقب **مشرف ثانٍ** يعيد تشغيل
  طفله خلف ظهر `dev.ps1`، ويظهر في إدارة المهام كعملية Node **إضافية لنفس البوت**.
- **هوية البوت = ملف القفل `.al-ai-bot.lock` لا المنفذ 3400.** بوت بدأ من `apps/bot` لا يحمل مسار
  المستودع في سطر أوامره ⇒ `Find-AlAiProcesses` أعمى عنه. `Get-BotLockOwner` في `common.ps1`
  يتحقق من (pid حيّ + صورة node + وقت البدء ≤ وقت القفل) ويرفض pid المُعاد تدويره؛
  `dev.ps1` يستخدمه في start/stop/status و`watchdog.ps1` في مسبار البوت.
- **ربط المنفذ شرط لا خيار:** فشل `adapter.listen()` ⇒ `exit(1)` **قبل** `client.login()`. ابتلاعه
  سابقاً أنتج بوتين على توكن واحد، وواحداً فقط يملك المنفذ ⇒ المشرف يرى «متوقف» ويطلق بدائل.
- اللوحة كذلك: `EADDRINUSE` على `PORT` ⇒ رسالة صريحة + `exit(1)` (لا وكيل ngrok ثانٍ على نفس النطاق).
- **⚠️ تشغيل من جلسة أداة = يُقتل معها** (حتى `-Detach`). لإعادة تشغيل تبقى:
  `Start-ScheduledTask -TaskName "AL AI Watchdog"` — خارج شجرة الجلسة فتُبقي الخدمات حيّة.

## النفق ووصول اللوحة (2026-11-11/2) — → السجل اليومي
- **مضيف النفق = النطاق المحجوز إن وُجد** (`tunnelHostForGate`)، لا `tunnelUrl` الحيّ وحده.
  اعتماد البوّابة على الرابط الحيّ وحده جعل `remote_access_tunnel_url=""` ينتج `403
  REMOTE_ACCESS_DISABLED` لكل طلب، **ومسبار الصحة يقرأ الـ403 «الرابط لا يستجيب» فيعيد توليد
  وكيل سليم** ⇒ النفق «يموت» كل ~8 دقائق. فحص الـpeer (loopback فقط) هو ما يحمي، لا الاسم.
- **`network.boot()` يعمل قبل `app.listen`** ⇒ **لا تسبير الرابط العام في الإقلاع** (محكوم بالفشل:
  لا خادم يستمع). وكيل حيّ + نطاق ⇒ **تبنٍّ بلا مسبار**؛ والشفاء يبقى لـ`probeTunnel` بعد الاستماع.
- وكيل حيّ بلا اسم (لا نطاق ولا رابط صالح) ⇒ **اقتله قبل** تشغيل بديل، وإلا وكيلان على نطاق واحد
  (`ERR_NGROK_6030`). وكتابات `setSetting` في هذا المسار **منتظرة** (`await`) وإلا هبطت متأخّرة
  وأفرغت الرابط الجديد.

## هوية البوت = نطاق واحد (جولة 2026-10-11/2)
- **`guild_customization` هو كل شيء يخصّ سيرفراً**: `nickname, role_color, role_icon_url, avatar_data_url,
  banner_data_url, bio, enabled`. **`bot_identity` = الحضور فقط** (`status, activity_type, activity_text,
  status_duration, status_expires_at`) ولا أعمدة مظهر فيه إطلاقاً.
- **`PATCH /guilds/{id}/members/@me` يقبل `nick`/`bio`/`banner`/`avatar`** ⇒ لكل سيرفر لقب ونبذة وصورة
  **وغلاف**. `RESTPatchAPIGuildMemberJSONBody` (العضو *الآخر*) لا يقبل منها شيئاً غير `nick`.
- **`bio` حقل كتابة-فقط** (ليس على `APIGuildMember`) ⇒ **الصفّ المخزَّن هو المصدر الوحيد**؛ و**اختبار رفض**
  وحده يُثبت أنه يُقرأ. **السقف 300 لا 190** (`MAX_BIO_LENGTH`) — 190 سقف «About me» للحساب، وهو حقل آخر.
- **الحالة/النشاط لا مسار REST لهما** (اتصال الـgateway، والبوت بلا sharding) ⇒ **شاشة مستقلّة**
  `view: "presence"`، `ownerOnly`، ومسار `/api/bot/presence`. **`PUT /api/bot/presence` بلا `guildId` ⇒
  400 `GUILD_ID_REQUIRED` عن قصد** («لا تصلحه»)؛ وهو **لا ينادي `applyAppearance` ولا يُرجع `applied`** —
  البوت هو من يطبّقه (يقرأ الصفّ كل 15 ثانية).
- **الشاشة لا تحمل أي مفهوم عام:** لا شارات، لا «الصورة العالمية»، لا `قراءة فقط`، ولا حصرية للمالك —
  و**مشرف غير مالك يُحوَّل من `/presence` إلى `/dashboard/…/dashboard`**.

## نشر الواجهة وشارة التحديث (2026-11-13)
- **`npm run deploy`** (`scripts/deploy.mjs`): البصمة المخدومة → بناء → **بوابة الأسرار على الحزمة
  المبنية** → مقارنة القرص بما يردّه `/api/version` الحيّ. أعلام `--no-build` · `--port` · `--url`.
- **الواجهة تُخدَم من `dist/` على القرص ويُقرأ `/api/version` كل طلب** ⇒ تعديل `src/` **لا** يحتاج
  إعادة تشغيل؛ تعديل `apps/dashboard/server` يحتاجه. «لا شارة» غالباً = **لم يتغيّر `src/`**، لا عطل.
- **شارة «تحديث جديد متاح»** (`components/update-banner.tsx`): أساسها = الحزمة المحمَّلة من وسم
  `<script type="module">`، **لا أول استطلاع** (وإلا فات تبويبٌ فُتح قبل النشر). تُفحص عند التحميل +
  كل 20s + `focus`/`visibilitychange`، مرة/جلسة، ولا تُعيد التحميل بنفسها. عقدها:
  `test/update-banner.test.tsx` (6 حالات، مُتحقَّق بالطفر).
- **نشر أوامر السلاش خطوة منفصلة:** `npm run deploy-commands --workspace=@al-ai/bot` (`-- --guild <id>` فوري).

## شريط السيرفرات (2026-11-13) — → `RULES-UI.md`
- **كل السيرفرات ظاهرة دائماً في شريط أقصى اليمين**، والتبديل بنقرة. **لا قائمة منسدلة ولا مُبدِّل**:
  `GuildSwitcher` أُزيل من الـshell. الشبكة `[4.5rem_16.5rem_1fr]` والطيّ `[4.5rem_4.75rem_1fr]`.
- **الكرت `Tooltip` (portal إلى `document.body`) لا `Popover`** — `ScrollArea`/`overflow-hidden` يقصّ الكرت.
  التكبير `scale-110` على الصورة، وحالة البوت نصّ + لون + `aria-label` (اللون وحده ليس دليلاً).
- **الفحص:** `npm run check:ui` يغطّي hover والكرت ومسار «البوت غير مضاف» وقائمة الهاتف وaxe.

## الاستضافة (2026-11-13) — → `docs/BOT-HOSTING-MCP.md`
- **FeatherPanel مرفوض:** الحساب `role: user` و`permissions: []` و0 سيرفرات، وقواعده MySQL فقط ⇒
  لا يصلح لمشروع PostgreSQL بثلاث عمليات. أُبقي مربوطاً بـ`enabled: false` للسجلّ فقط.
- **Bot-Hosting.net هو المسار:** PostgreSQL كنشر مستقل + Node 24، و72 أداة MCP تُدير كل شيء.
  يحتاج مفتاح `bhk_` وخطة **Starter+ £2.59**؛ المجاني (نشر واحد، 256MB) لا يشيل التطبيق + القاعدة.
- **المفتاح لا يدخل المستودع:** `%USERPROFILE%\.al-ai\bot-hosting-mcp\.env` + `run.cmd`، والـMCP مسجَّل
  في `opencode.jsonc` باسم `bot-hosting`.

## 🔴 Git — → `al-ai-git-recovery`
`.git` مشترك مع `glyph-agent`؛ `origin` → `Steve6546/al-ai`.
- **⛔ لا `git rm`** (أتلف ملفات غير متعقَّبة) — احذف بـ`rm` بعد `git add -A`. **⛔ لا `git stash`**.
- **مراجع التتبّع لا تُحفظ** ⇒ تحقّق بـ`git ls-remote origin refs/heads/main` **فقط**. **الدفع:**
  `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true timeout 150 git push origin main`؛ **⛔ `gh auth setup-git`
  يخرج 0 وهو فاشل**؛ **`git commit -F`** بمسار `C:/…` لا `/c/…`.
- **⚠️ المرجع اليدوي يُقلَّم بأي أمر git لاحق** ⇒ اكتبه **آخر شيء**، وأعِد إنشاء المجلد
  (`mkdir -p .git/refs/remotes/origin`). **و`[gone]` تعني «المرجع مفقود» لا «الفرع محذوف»**.
