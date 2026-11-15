# AL AI — بوت Discord + لوحة تحكم

`apps/bot` + `apps/dashboard` (Fastify BFF + React RTL) + `packages/core`.
**قواعد فقط**؛ القصص والقياسات في `YYYY-MM-DD.md`. **مُتتبَّعة في مستودع عام ⇒ لا أسرار.**

**مراجع — اقرأها عند العمل في مجالها:** `RULES-UI.md` · `RULES-CONTRACTS.md` · `RULES-DISCORD.md` ·
`RULES-ARCH.md` · `RULES-NGROK.md` · `docs/{ARCHITECTURE,API,DEPLOYMENT,GOVERNANCE}.md`
(**29** قاعدة مُفروضة بـ`governance.test.ts`) · `docs/README.md` (فهرس) · `docs/BOT-HOSTING-MCP.md`.
`.agents/skills` = HeroUI فقط. **فحوص حيّة:** `scripts/{ui-check,oauth-check,load-check}.mjs`؛
ما في `.workbuddy-ai/verify/` و`browser-check.mjs` قديم ويدوي. معظم القواعد يكشفها
`npm run verify`؛ هذه الصفحة لما لا يكشفه اختبار.
- ⚠️ **`ui-check.mjs --live` يلزمه جلسة Discord حقيقية** (تسجيل دخول عبر اللوحة)؛ جلسة
  `dev:session` توكنها `probe-token` ⇒ `/api/session` يقبلها و`/api/guilds` يرفضها 401 ⇒ كان
  يُسمّي نقص صلاحية واحد **54 انحداراً بصرياً**. الآن فحص مسبق يتوقف بخطأ واحد صريح (لا تخطٍّ
  صامت). الفحص المُستَبّد بلا `--live` يكفي للبنية البصرية ولا يحتاج جلسة.
- ⚠️ **لا تستنتج اسم كوكي الجلسة من `NODE_ENV` داخل سكربت مستقل**: اللوحة تقرأ `.env`، والسكربت
  لا. `ui-check.mjs` يجرّب `__Host-`/العادي ويسأل السيرفر أيّهما يقبل ثم يمرّره للمتصفح.
  `.env` هنا `NODE_ENV=production` ⇒ الاسم `__Host-al_ai_session` فقط.
- `dev:session` بـ**`tsx`** لا `node` (يستورد `.js` من `.ts`)، ويحتاج `NODE_ENV=development`
  كتجاوز لأن الحارس يرفض الإنتاج؛ الجلسة الوهمية يُبطلها السيرفر تلقائياً عند أول قراءة Discord.
- ⚠️ **نتيجة `verify` واحدة لا تُشخَّص قبل مطابقة رقم السطر**: فشلٌ أشار للسطر 1619 بينما الإصلاح
  في الشجرة على 1624 ⇒ جولة قديمة. أعد الجولة نظيفة قبل لمس الكود.

## 🔴 حدود لا تُخالَف — التفصيل في `RULES-NGROK.md` والسجلات
- **حصة ngrok:** 20,000 طلب/شهر. مسبار عام + استقصاء 2ث نفداها ⇒ `403 ERR_NGROK_727` ⇒
  **437** إعادة توليد للوكيل. الآن الحيوية **loopback فقط** (`4040/api/{status,tunnels}` +
  `:3000/api/health`)، وتحقق عام 1/ساعة (6 ساعات أثناء الحصة)؛ الحصة **تمنع** إعادة التوليد
  + تهدئة 5 د. نفادها حقيقة حساب لا يُصلحها الكود (انتظر الدورة/ترقِّ)؛ localhost سليم.
- **الرامات:** 20 عامل `node --test` ⇒ 8–15 GB ⇒ قتل عمال و`bot_identity` محذوف. كل الحزم الآن عبر
  `scripts/test-runner.mjs`: توازٍ ≤2، heap ≤768 MiB، رفض <512 MiB حرّة. النتيجة ذروة ≈1 GB و
  **1040 اختبار / 0 فشل / 0 متخطّى**. لا تُشغَّل فحوص ثقيلة بالتوازي على هذا الجهاز (16 GB).
- **Git:** `.git` مشترك مع `glyph-agent`، `origin=Steve6546/al-ai`. ⛔ لا `git rm` (احذف بـ`rm`
  بعد `git add -A`) ولا `git stash`. تحقّق بـ`git ls-remote origin refs/heads/main` فقط
  (المراجع لا تُحفظ؛ `[gone]` = مرجع مفقود). الدفع:
  `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true timeout 150 git push origin main`؛
  ⛔ `gh auth setup-git` يخرج 0 وهو فاشل؛ `git commit -F` بـ`C:/…` لا `/c/…`؛ المرجع اليدوي
  يُقلَّم بأي git لاحق ⇒ اكتبه آخراً وأعِد `mkdir -p .git/refs/remotes/origin`.
- **نسخة واحدة:** `npm run dev` (`dev.ps1`) فقط، و`dev` بالحزمة بلا `tsx watch` (مراقب = مشرف ثانٍ).
  الهوية = **`.al-ai-bot.lock` لا المنفذ 3400** (`Get-BotLockOwner` يرفض pid المُعاد تدويره).
  فشل `adapter.listen()` ⇒ `exit(1)` **قبل** `client.login()`؛ `EADDRINUSE` للوحة كذلك.

## التشغيل والبيئة
- `npm run verify` = lint + check:schema + test + build. **اقرأ `# skipped` لا `# pass`**: بلا قاعدة
  حيّة يتخطّى `storage.test.ts` بصمت بـ**exit 0**. `npm start` → `scripts/start.mjs` بديل PowerShell المحمول.
- PostgreSQL 17 على **55432** (`~/.al-ai/pgdata`)؛ `psql` ليس على `PATH`؛ **5432 مشغول لا تلمسه**؛
  اقرأ `information_schema.columns` قبل أي استعلام.
- ⚠️ ngrok + بروكسي الـsandbox ⇒ `ERR_NGROK_9009`: شغّل بـ
  `env -u http_proxy -u https_proxy -u HTTP_PROXY -u HTTPS_PROXY npm run dev -- -Tunnel`
  كمهمة خلفية مُدارة. ⚠️ **`curl` دائماً بـ`--noproxy '*'`** وإلا 502 مضلِّل.
- cwd السكربتات = مجلد الحزمة ⇒ `--env-file=../../.env`؛ **`tsx` بلا hot-reload** ⇒ أعد التشغيل بعد
  كل تعديل خلفي. `.env.example` هو العقد (`env-template.test.ts` يفرض توثيق كل متغيّر)؛
  صحة محوّل التكامل **`GET /ping` لا `/health`**.
- ⚠️ **كتابة الملفات تُسقَط بصمت** ⇒ تحقّق بـ`grep`/`md5sum`. ⚠️ **جرّد التعليقات قبل فحص نصّي**:
  اسم صنف داخل شرح يولّد قاعدته في CSS فيُضلّل `grep`.
- التسليم `present_files` بمسار مطلق؛ إثبات الواجهة = طابق بصمة الحزمة بـ`dist/assets/`.
  `backups/`/`preview/`/`.al-ai/` مُتجاهَلة.
- **لا `SIGTERM`/`SIGINT` لعملية منفصلة على ويندوز** ⇒ الإغلاق الرشيق يُختبر في Docker/Linux،
  دليله زوال ملف القفل. ⚠️ تشغيل من جلسة أداة يُقتل معها (حتى `-Detach`) ⇒
  `Start-ScheduledTask -TaskName "AL AI Watchdog"`.
- **جلسة فحص حقيقية من `oauth_sessions`، `id` = قيمة الكوكي**: `__Host-al_ai_session` في الإنتاج،
  `al_ai_session` خارجه ⇒ اسم خاطئ = تقرير «clean» كاذب (`dev-issue-session.mts` توكن وهمي).
  السيرفر `1523473815555018782`؛ **المسبار بعد `Page.navigate` لا قبله**.
- ⚠️ **اختبار يكتب حالة حيّة يعيدها** (لقطة + استعادة في `after()` قبل `pool.end()`، و`before()`
  يعيد البذرة)؛ `bot_identity` **صفّ واحد يملكه النشر** → `RULES-ARCH.md`.
- ⚠️ **الرؤية = وجود البيانات؛ التحرير = الإذن** (متغيّران لا `isPlatformOwner && draft`).
- **2FA إلزامي للمسؤولين:** `needsSecondFactor = requiresSecondFactor(...) || isEnrolled(...)`؛
  `oauth_sessions.second_factor_satisfied` افتراضه `FALSE`، و`readSession` يُتلف أي جلسة لم تمرّ
  بالرمز لحساب عليه TOTP ⇒ لا تجاوز بكوكي قديمة. `check:2fa` 32/32. → `docs/API.md`.

## مجالات لها ملف مرجعي — خلاصة فقط
- **النفق:** `tunnelHostForGate` = النطاق المحجوز لا `tunnelUrl` الحيّ؛ `network.boot()` قبل
  `app.listen` ⇒ لا مسبار عام في الإقلاع؛ وكيل حيّ بلا اسم يُقتل **قبل** بديل (`ERR_NGROK_6030`)
  و`setSetting` مُنتظَرة (`await`). → السجل 11-11/2.
- **الهوية:** `guild_customization` = كل مظهر السيرفر، `bot_identity` = الحضور فقط؛
  `PATCH /guilds/{id}/members/@me` يقبل `nick/bio/banner/avatar`، `bio` كتابة-فقط والسقف **300**؛
  الحالة/النشاط gateway بلا REST ⇒ شاشة `presence` و**`400 GUILD_ID_REQUIRED` مقصود**؛ لا مفهوم عام.
  → `RULES-CONTRACTS.md`.
- **الواجهة:** شريط السيرفرات دائم بلا مُبدِّل؛ الكرت `Tooltip` (portal) لا `Popover`؛
  الشبكة `[4.5rem_16.5rem_1fr]` والطيّ `[4.5rem_4.75rem_1fr]`. → `RULES-UI.md`.
- **الاستضافة/MCP:** FeatherPanel مرفوض (MySQL، `role: user`)؛ Bot-Hosting.net **Starter+ £2.59**
  بمفتاح `bhk_` خارج المستودع. `~/.workbuddy-ai/mcp.json` = `ngrok` + `github-remote` (OAuth،
  بلا أسرار) **ويلزم المستخدم Trust + تسجيل دخول** قبل ظهور الأدوات؛ Docker غير مثبّت.
  → `docs/BOT-HOSTING-MCP.md`.

## جولة الفحص المعماري (2026-11-15)
`npx knip` + typecheck/lint/test/build = **EXIT=0** (`.al-ai/overhaul-gate.log`).
`i18n.tsx` 3643 → 183 سطراً (`i18n.{en,ar}.ts` بيانات صرفة، الصادرات محفوظة)؛
`knip.json` يصرّح بمداخل الاختبارات وإلا بلّغ عن ملفات حيّة كميتة. `DEPLOY.md`/
`FEATHERPANEL-MCP.md`/`HANDOVER-…` وثائق لحظية لا مرجع حيّ.
**لا حذف لملف متتبَّع بلا تأكيد صريح**؛ مرشّحا الحذف `docs/images/{mobile,phone}.png` (بلا مراجع).

## نشر الواجهة وشارة التحديث (2026-11-13)
- **`npm run deploy`** (`scripts/deploy.mjs`): البصمة المخدومة → بناء → **بوابة الأسرار على
  الحزمة المبنية** → مقارنة القرص بما يردّه `/api/version` الحيّ. أعلام `--no-build` · `--port` · `--url`.
- **`dist/` يُخدَم من القرص و`/api/version` يُقرأ كل طلب** ⇒ تعديل `src/` **لا** يحتاج إعادة تشغيل؛
  تعديل `apps/dashboard/server` يحتاجه. «لا شارة» غالباً = **لم يتغيّر `src/`**، لا عطل.
- **شارة «تحديث جديد متاح»** (`components/update-banner.tsx`): أساسها = الحزمة المحمَّلة من وسم
  `<script type="module">`، **لا أول استطلاع** (وإلا فات تبويبٌ فُتح قبل النشر). تُفحص عند التحميل +
  كل 20s + `focus`/`visibilitychange`، مرة/جلسة، ولا تُعيد التحميل بنفسها. عقدها:
  `test/update-banner.test.tsx` (6 حالات، مُتحقَّق بالطفر).
- **نشر أوامر السلاش خطوة منفصلة:** `npm run deploy-commands --workspace=@al-ai/bot` (`-- --guild <id>` فوري).

