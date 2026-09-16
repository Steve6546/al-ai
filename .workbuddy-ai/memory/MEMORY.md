# AL AI — بوت Discord + لوحة تحكم

`apps/bot` (discord.js) + `apps/dashboard` (Fastify BFF + React SPA RTL) + `packages/core` (العقود).
**قواعد فقط**؛ القصص في السجلات اليومية.

**ملفات مرافقة في هذا المجلد — اقرأها عند العمل في مجالها (غير مُحمَّلة تلقائياً):**
- `RULES-UI.md` — التمرير والقوائم، الشاشة السوداء، تركيب React.
- `RULES-CONTRACTS.md` — عقود المسارات، الأوامر والتخصيص، الهوية.
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
- **الفحص الحيّ:** `browser-check.mjs` (هندسة حقيقية) · `write-path-check.mjs` (مسار الكتابة) ·
  `live-screens-check.mjs` (الشاشات الثمانية). **جلسة حقيقية من `oauth_sessions` — العمود `id` هو قيمة كوكي
  `al_ai_session`** (`dev-issue-session.mts` توكنه وهمي ⇒ أي مسار ينادي Discord يرجع 401 به).
  **سيرفر الفحص:** `1523473815555018782` (البوت حاضر + 14 صف أوامر، منها `warn` عضو و`clear`/`lock` لا).
  **⚠️ لا `curl` بلا `--noproxy '*'`** — الوكيل يرد **502** مضلِّلاً.

## 🔴 Git — → `al-ai-git-recovery`
`.git` مشترك مع `glyph-agent`؛ `origin` → `Steve6546/al-ai`.
- **⛔ لا `git rm`** (أتلف ملفات غير متعقَّبة) — احذف بـ`rm` بعد `git add -A`. **⛔ لا `git stash`**.
- **مراجع التتبّع لا تُحفظ** ⇒ تحقّق بـ`git ls-remote origin refs/heads/main` **فقط**، واكتب المرجع يدوياً **آخر
  شيء**. **الدفع:** `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=/bin/true timeout 150 git push origin main`؛ **⛔
  `gh auth setup-git` يخرج 0 وهو فاشل**؛ **`git commit -F`** بمسار `C:/…` لا `/c/…`.
- **⚠️ المرجع اليدوي يُقلَّم بأي أمر git لاحق** ⇒ اكتبه **بعد آخر أمر**، و**أعِد إنشاء المجلد**
  (`mkdir -p .git/refs/remotes/origin`) وإلا فشل التوجيه بـ`No such file or directory`.
  **و`[gone]` تعني «المرجع مفقود» لا «الفرع محذوف»** — رآها هذا المشروع **مع دفع ناجح في اللحظة نفسها**.

## Discord API
- **لا `@me` في مسار عضو السيرفر** (GET ⇒ 400/403): `/users/@me` ثم `/guilds/{id}/members/{botUserId}`. الاستثناء
  `PATCH .../members/@me`.
- **`permissions` = `0` لرمز بوت** حتى مع Administrator ⇒ ابنِها من `@everyone` (معرّفه = معرّف السيرفر) + أدوار
  العضو **وافحص 0x8 أولاً**. **«مجهول» ليس `false`:** `granted` ثلاثي.
- كل قراءة بـ`.catch(() => null)` تفشل **بصمت** ⇒ الاختبار يثبّت **شكل الطلب** لا النتيجة؛ والخطّاف يطابق
  بـ`includes` ⇒ رتّب الأكثر تحديداً أولاً.
- **النبذة عبر `PATCH /applications/@me {description}`**؛ `/users/@me {bio}` يُهمَل صامتاً بـ200. **`Presence
  Intent` ممنوع** (حوكمة 8).
- **🔴 الأحداث: `Events.*` لا نصّاً.** discord.js **يبعث بالقيمة** و**مفتاح ≠ قيمة**: `Events.GuildEmojiCreate`
  قيمته `emojiCreate` ⇒ `client.on("guildEmojiCreate")` **ميت**. **لا تستنتج «ميت» من نمط ثابت — شغّل السلوك.**

## تصنيف الأخطاء ومنع 429
- `isAuthFailure` **401 فقط** و`isRateLimited` **429 فقط** — قبلها كل خطأ صار «توكن منتهٍ» ⇒ 429 يُتلف جلسة.
- `loadUserGuilds` **المصدر الوحيد** لسيرفرات المستخدم: 401 ⇒ إتلاف + `SESSION_EXPIRED`؛ 429 ⇒ `429
  RATE_LIMITED` + `retry-after` **والجلسة سليمة**؛ غير ذلك ⇒ 503. نداء مباشر جديد لـ`fetchUserGuilds` يُسقط
  `route-guards.test.ts`. و`/api/guilds` بـ**`Promise.allSettled`** (لا كتابة في `reply` بعد الرد).
- **الانفجار نفسه هو المشكلة**، **وحدّ Discord لكل تطبيق لا لكل مسار.** `TtlCache.resolve(key, load)` **تدمج
  الطلبات الجارية** (نداء ثانٍ ينتظر الوعد القائم — **هذا ما يقتل الانفجار لا الـTTL**). **`fetchBotMemberShared`
  بلا TTL عن قصد.**
