# AL AI — بوت Discord + لوحة تحكم

`apps/bot` + `apps/dashboard` (Fastify BFF + React RTL) + `packages/core`. **قواعد فقط**؛ القصص
والقياسات في `YYYY-MM-DD.md`. **مستودع عام ⇒ لا أسرار.**

**مراجع تُقرأ عند العمل في مجالها:** `RULES-{UI,CONTRACTS,DISCORD,ARCH,NGROK}.md` ·
`docs/{ARCHITECTURE,API,DEPLOYMENT,GOVERNANCE,BOT-HOSTING-MCP}.md` · `docs/README.md` (فهرس).
معظم القواعد يكشفها `npm run verify`؛ هذه الصفحة لما لا يكشفه اختبار.

## 🔴 حدود لا تُخالَف
- **ngrok:** 20,000 طلب/شهر. نفادها = `403 ERR_NGROK_727` ⇒ حظر إعادة التوليد + تهدئة 5 د.
  الحيوية **loopback فقط** (`4040/api/{status,tunnels}` + `:3000/api/health`)؛ تحقق عام 1/ساعة
  (6 ساعات أثناء الحصة). نفاد الحصة حقيقة حساب لا يُصلحها الكود.
- **الرامات:** كل الحزم عبر `scripts/test-runner.mjs` (توازٍ ≤2، heap ≤768 MiB، رفض <512 MiB حرّة).
  لا فحوص ثقيلة بالتوازي على هذا الجهاز (16 GB). **اقرأ `# skipped` لا `# pass`** — بلا قاعدة
  حيّة يتخطّى `storage.test.ts` بصمت بـ exit 0.
- **Git:** `.git` مشترك مع `glyph-agent`، `origin=Steve6546/al-ai`. ⛔ لا `git rm` (احذف بـ`rm` بعد
  `git add -A`) ولا `git stash`. تحقّق **فقط** بـ`git ls-remote origin refs/heads/main` (المراجع
  لا تُحفظ). الدفع: `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true timeout 150 git push origin main`.
  ⛔ `gh auth setup-git` يخرج 0 وهو فاشل. `git commit -F` بمسار `C:/…` لا `/c/…`.
- **نسخة واحدة:** `npm run dev` (`dev.ps1`) فقط؛ `dev` بلا `tsx watch`. الهوية = **`.al-ai-bot.lock`**
  لا المنفذ 3400. فشل `adapter.listen()` ⇒ `exit(1)` **قبل** `client.login()`.
- ⛔ **لا مهام مُجدولة محلية ولا حلقات خلفية**: الإنتاج على Bot-Hosting، الجهاز أداة تطوير.
  `-WindowStyle Hidden` لا يمنع وميض النافذة. أي spawn يلزمه `-NoProfile -NonInteractive`.

## التشغيل والبيئة
- `npm run verify` = lint + check:schema + test + build. `npm start` → `scripts/start.mjs`.
- PostgreSQL 17 محلياً على **55432** (`~/.al-ai/pgdata`)؛ `psql` ليس على `PATH`؛ **5432 مشغول لا
  تلمسه**؛ اقرأ `information_schema.columns` قبل أي استعلام.
- ⚠️ ngrok + بروكسي الـsandbox ⇒ `ERR_NGROK_9009`: شغّل بـ`env -u http_proxy -u https_proxy
  -u HTTP_PROXY -u HTTPS_PROXY npm run dev -- -Tunnel`. ⚠️ **`curl` دائماً بـ`--noproxy '*'`**.
- cwd السكربتات = مجلد الحزمة ⇒ `--env-file=../../.env`؛ **`tsx` بلا hot-reload** ⇒ أعد التشغيل
  بعد كل تعديل خلفي. صحة محوّل التكامل **`GET /ping` لا `/health`**.
- ⚠️ **كتابة الملفات قد تُسقَط بصمت** ⇒ تحقّق بـ`grep`/`md5sum`. ⚠️ **جرّد التعليقات قبل فحص
  نصّي** (اسم صنف داخل شرح يولّد قاعدته في CSS). **تعديل واحد لكل ملف في الرسالة** (تعديلان
  متوازيان يتسابقان ويُسقطان أحدهما).
- **لا `SIGTERM`/`SIGINT` لعملية منفصلة على ويندوز** ⇒ الإغلاق الرشيق يُختبر في Docker/Linux.
- **جلسة فحص حقيقية** من `oauth_sessions` (`id` = قيمة الكوكي): `__Host-al_ai_session` في الإنتاج،
  `al_ai_session` خارجه. السيرفر `1523473815555018782`؛ المسبار **بعد** `Page.navigate`.
- ⚠️ اختبار يكتب حالة حيّة **يعيدها** (لقطة + استعادة في `after()` قبل `pool.end()`).
- **الرؤية = وجود البيانات؛ التحرير = الإذن** (متغيّران لا `isPlatformOwner && draft`).
- **2FA إلزامي للمسؤولين:** `needsSecondFactor = requiresSecondFactor(...) || isEnrolled(...)`؛
  `second_factor_satisfied` افتراضه `FALSE` و`readSession` يُتلف أي جلسة لم تمرّ بالرمز. → `docs/API.md`.
- **القاعدة بدورين لا دور واحد:** المالك `al_ai` (superuser) للسكيما فقط، والخدمات عبر
  `al_ai_app` (NOSUPERUSER NOBYPASSRLS، DML فقط) بكلمة سر `.al-ai-pg/password-app`.
  `boot.sh` يطلب `--print-app-url` **بعد** `ready`، و`--print-url` للمالك. **RLS على كل جدول**
  بحلقة `pg_tables` (لا قائمة يدوية)، و`audit_trail` بـSELECT+INSERT فقط. ⚠️ منح لدور غير موجود
  ليست حماية: تحقّق من `pg_roles` و`pg_tables.rowsecurity` لا من نص السكيما.

## مجالات لها ملف مرجعي — خلاصة فقط
- **النفق:** `tunnelHostForGate` = النطاق المحجوز لا `tunnelUrl` الحيّ؛ `network.boot()` قبل
  `app.listen`؛ وكيل حيّ بلا اسم يُقتل **قبل** بديل (`ERR_NGROK_6030`). → `RULES-NGROK.md`.
- **الهوية:** `guild_customization` = مظهر السيرفر، `bot_identity` = الحضور فقط؛ `bio` كتابة-فقط
  وسقفه **300**؛ الحالة/النشاط gateway بلا REST ⇒ `400 GUILD_ID_REQUIRED` مقصود. → `RULES-CONTRACTS.md`.
- **الواجهة:** شريط السيرفرات دائم بلا مُبدِّل؛ الكرت `Tooltip` (portal) لا `Popover`؛
  الشبكة `[4.5rem_16.5rem_1fr]` والطيّ `[4.5rem_4.75rem_1fr]`. → `RULES-UI.md`.
- **الاستضافة/MCP:** Bot-Hosting.net Starter+ بمفتاح `bhk_` خارج المستودع؛
  `~/.workbuddy-ai/mcp.json` = `ngrok` + `github-remote`. FeatherPanel مرفوض (MySQL). Docker غير مثبّت.

## دروس الاستضافة الحيّة
- **`ps` مجموع RSS لا يقيس الرام هنا:** كل backend لـPostgreSQL يحمل `shared_buffers=16MB` في RSS.
  المرجع الوحيد `deployments_resources` (cgroup).
- **`information_schema.constraint_column_usage` مصفّاة بالملكية** ⇒ دور التطبيق يرى **صفر** مفاتيح
  خارجية. استخدم `pg_constraint` لأي استعلام بنيوي.
- **`disableRequestLogging` مهمَل في Fastify 5**؛ الصواب `{ logLevel: "silent" }` على المسار.
- **`db:import`:** sidecar `.sha256` بصيغة `sha256sum`، تحقّق **قبل** الاتصال، و`--fresh` يتخطّى
  الجداول ذات مشغّل `BEFORE TRUNCATE` (append-only).
- **سقوف الذاكرة:** `HEAP_BOT=96` · `HEAP_DASHBOARD=80` · `HEAP_PG=24` (ثوابت مسمّاة في `boot.sh`).

## عقد البيئة والنشر
- **`.env.example` هو القائمة الوحيدة** (3 أقسام: 9 أساسية · `DATABASE_URL` · متقدّمة). لا تكرّر
  جدول متغيّرات في أي وثيقة. `DATABASE_URL` فارغ ⇒ `boot.sh` يشغّل القاعدة ويصدّره؛ `npm run dev`
  المحلي لا يمرّ بـ`boot.sh` فيحتاج السطر المعلّق مفتوحاً. **`KEY_ROTATION_DAYS` +
  `AUDIT_RETENTION_DAYS` إلزاميان في الإنتاج.**
- ⚠️ **حارس `env-template.test.ts`** يجب أن يرى `process.env.X` و`read("X")` و`readEnv("X")`
  و`heap("X")` و`pinned("X")` — **كل حارس يمرّ بلا نتيجة يجب أن يُثبَت أنه يرى شيئاً**.
- **لوحة Packages تقرأ `package.json` لا `node_modules`** — تعرض `devDependencies` غير المثبّتة
  (`setup.sh` = `npm ci --omit=dev`). تحريرها من اللوحة يكسر `npm ci` التالي. **لا تُحرَّر.**
- **السجلّات:** `rotate_logs()` في `boot.sh`: 5 MiB + 400 سطر، **قصّ في المكان لا إعادة تسمية**
  (`tee -a` يمسك `O_APPEND`).
- **`PRESENCE INTENT` = OFF**: `discord.ts` يطلب `GuildMembers`+`MessageContent` فقط.
- **`npm run deploy`** (`scripts/deploy.mjs`): بصمة مخدومة → بناء → بوابة أسرار على الحزمة المبنية →
  مقارنة القرص بما يردّه `/api/version`. `dist/` يُخدَم من القرص ⇒ تعديل `src/` لا يحتاج إعادة تشغيل.
- **شارة التحديث** (`components/update-banner.tsx`) أساسها الحزمة المحمَّلة من وسم `<script>`، لا
  أول استطلاع. عقدها `test/update-banner.test.tsx`. **نشر أوامر السلاش خطوة منفصلة:**
  `npm run deploy-commands --workspace=@al-ai/bot`.
- **نطاق الوثائق:** `DEPLOY.md` = النشر لكل المضيفين · `DEPLOYMENT.md` = التشغيل المحلي.

## OAuth: القائمة تُقرأ ولا تُكتب (2026-11-17)
- 🔴 **`redirect_uris` في Discord تُعدَّل من البوابة فقط**: `PATCH /applications/@me` يحملها
  يُرجع **200 ويُتجاهلها صامتاً**. أي «إصلاح» برمجي لها وهم. المدخل الوحيد: Portal → OAuth2 → Redirects.
- **الفحص عند الإقلاع** (`server/oauth-preflight.ts`): طلب واحد بعد `listen`، تحذير بالنطاق
  المفقود، لا يرمي ولا يحجب. غياب `redirect_uris` = «تعذّر العلم» **لا** «مفقود».
  السكربت `scripts/oauth-preflight.mjs` يبقى للفحص قبل النشر (exit 1 عند النقص).
- **`trustProxyOnlyLoopback` يعمل على Bot-Hosting**: Caddy يتصل من `127.0.0.1` ⇒ `__Host-`+`Secure`
  و`request.protocol=https` بلا تدخّل. خطّاف `AL_AI_PLATFORM_HOST` احتياط لا أساس. حصّة throttle
  واحدة للجميع (peer واحد) — مقايضة مقصودة لمشغّل واحد.
- ⚠️ **`deployments_shell` لا يرى `DATABASE_URL`** (يُصدّره `boot.sh` في شجرته فقط):
  `export DATABASE_URL="$(node scripts/host/pg.mjs --print-url)"` في نفس الأمر، ولا تطبعه.
  الاتصال بدونه يترك `FATAL: canceling authentication due to timeout`.
- **`check:lock`** في `verify`: كل manifest مقابل `package-lock.json`، ويرفض `dependencies` في
  الجذر (لوحة Packages تعرضها كأنها مثبّتة).
