# AL AI — بوت Discord + لوحة تحكم

`apps/bot` (discord.js) + `apps/dashboard` (Fastify BFF + React SPA RTL) + `packages/core` (العقود).
**قواعد فقط**؛ القصص في السجلات اليومية.

**ملفات مرافقة في هذا المجلد — اقرأها عند العمل في مجالها:**
- `RULES-UI.md` — التمرير والقوائم، الشاشة السوداء، تركيب React.
- `RULES-CONTRACTS.md` — عقود المسارات، الأوامر والتخصيص، الهوية، الاختصارات.
- `RULES-DISCORD.md` — واجهة Discord، تصنيف الأخطاء، منع 429.
- `RULES-ARCH.md` — الترحيل والسكيما، الحوكمة (27 قاعدة)، منهج الفحص.

**المهارات:** `al-ai-stack-verify` (تشغيل/فحص) · `al-ai-git-recovery` · `repo-architecture-audit` ·
`react-jsdom-mount-test`.
**كثير من القواعد مُفروضة باختبار** ⇒ `npm run verify` يكشفها. ما في هذه الصفحة هو **ما لا يكشفه اختبار**.

## التشغيل والبيئة — → `al-ai-stack-verify`
- `npm run verify` = lint + check:schema + test + build. **اقرأ `# skipped` لا `# pass`**: بلا قاعدة حيّة يتخطّى
  `storage.test.ts` بصمت ويرجع **exit 0**.
- PostgreSQL 17 على **55432** (`C:\Users\dlwta\.al-ai\pgdata`)؛ `psql` ليس على `PATH`؛ **5432 مشغول — لا تلمسه**.
  اقرأ `information_schema.columns` قبل أي استعلام.
- سكربتات الـworkspace بـcwd = مجلد الحزمة ⇒ `--env-file=../../.env`. **`tsx` بلا hot-reload** ⇒ أعد التشغيل بعد
  كل تعديل خلفي وإلا خدمت مسارات قديمة (404).
- **التسليم** `present_files` بمسار مطلق؛ **إثبات الواجهة** = طابق بصمة الحزمة المخدومة مع `dist/assets/`.
- **⚠️ كتابة الملفات تُسقَط بصمت** ⇒ تحقّق بـ`grep`/`md5sum`. **⚠️ جرّد التعليقات قبل أي فحص نصّي** — Tailwind يمسح
  التعليقات، واسم صنف داخل شرح **يولّد قاعدته في CSS** فيُضلّل `grep`.
- **لا `SIGTERM`/`SIGINT` لعملية منفصلة على ويندوز** ⇒ **الإغلاق الرشيق يُختبر في Docker/Linux**، ودليله **ملف
  القفل**: زواله = المسار عمل، بقاؤه = قتل قسري.
- **`.env` غير مُتتبَّع** (`.env.example` هو العقد). **صحة محوّل التكامل `GET /ping` لا `/health`**.
- **`.workbuddy-ai/memory/*.md` مُتتبَّعة ومرفوعة لمستودع عام** — لا أسرار؛ `backups/`/`preview/` **مُتَجاهَلان**.
- **الفحص الحيّ:** `browser-check.mjs` · `write-path-check.mjs` · `live-screens-check.mjs` ·
  `live-session-probe.mjs`. **جلسة حقيقية من `oauth_sessions` — العمود `id` هو قيمة الكوكي**، واسمها
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

## 🔴 Git — → `al-ai-git-recovery`
`.git` مشترك مع `glyph-agent`؛ `origin` → `Steve6546/al-ai`.
- **⛔ لا `git rm`** (أتلف ملفات غير متعقَّبة) — احذف بـ`rm` بعد `git add -A`. **⛔ لا `git stash`**.
- **مراجع التتبّع لا تُحفظ** ⇒ تحقّق بـ`git ls-remote origin refs/heads/main` **فقط**. **الدفع:**
  `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true timeout 150 git push origin main`؛ **⛔ `gh auth setup-git`
  يخرج 0 وهو فاشل**؛ **`git commit -F`** بمسار `C:/…` لا `/c/…`.
- **⚠️ المرجع اليدوي يُقلَّم بأي أمر git لاحق** ⇒ اكتبه **آخر شيء**، وأعِد إنشاء المجلد
  (`mkdir -p .git/refs/remotes/origin`). **و`[gone]` تعني «المرجع مفقود» لا «الفرع محذوف»**.
