# AL AI — مشروع Discord bot + لوحة تحكم

Monorepo: `apps/bot` (discord.js) + `apps/dashboard` (Fastify BFF + React SPA RTL)
+ `packages/core` (المصدر الوحيد لكل عقد مشترك).

## الأوامر والتحقق
- `npm run verify` = lint + check:schema + test + build. استخدمه دائماً بدل تشغيل
  الخطوات يدوياً. **296 اختباراً** (162 بوت + 38 لوحة + 96 core).
- `npm run check:schema` يحلّل `infra/schema.sql` بمحلّل PostgreSQL حقيقي
  (`pgsql-ast-parser`). أسرع من الترحيل الفعلي، ويبقى مفيداً كفحص نحوي.
- `apps/dashboard` لا يحمّل `.env` بنفسه. شغّله بـ:
  `cd apps/dashboard && ../../node_modules/.bin/tsx --env-file=../../.env server/index.ts`
  (البوت يحمّله عبر `import "dotenv/config"`). استخدم مسار `tsx` المحلي مباشرة —
  `npx tsx` يضيف عملية وسيطة تكلّف ~70MB لكل خدمة.
- **`node server/index.ts` مباشرة لا يعمل** (Node 22.22 مع `process.features.typescript
  === "strip"`): الكود يستورد `./env.js` والملف `env.ts`، وNode لا يعيد كتابة
  الامتداد — هذه ميزة tsx/esbuild لا ميزة type-stripping. فلا بد من tsx أو بناء
  فعلي بـ`tsc`.
- **للتشغيل الكامل:** PostgreSQL (مهمة خلفية) → اللوحة (مهمة خلفية) → البوت.
  أو `npm run dev:dashboard` / `npm run dev:bot`.

## Discord API — مصائد صامتة (كلّفتنا 3 ميزات ميتة)
- **لا يوجد اختصار `@me` في مسار عضو السيرفر.** `GET /guilds/{id}/members/@me`
  يُرجع **400** `NUMBER_TYPE_COERCE`، و`GET /users/@me/guilds/{id}/member` يُرجع
  **403** `"Bots cannot use this endpoint"` (خاص بـOAuth2).
  الصحيح لرمز بوت: احلّ معرّف البوت من `GET /users/@me` ثم
  `GET /guilds/{id}/members/{botUserId}` — وهذا يعطي **الأدوار والصلاحيات معاً**.
- **حقل `permissions` في كائن العضو يُرجع `0` لرمز بوت** حتى لبوت يملك
  Administrator. لا تعتمد عليه: ابنِ الصلاحيات الأساسية باتحاد `@everyone`
  + أدوار العضو (`computeBasePermissions`).
- **Administrator (0x8) يتقدّم على كل صلاحية** ولا يتوسّع إلى البتات التي يعنيها.
  أي فحص بتّي ساذج يقول «مفقودة» لبوت يملك Administrator. افحص 0x8 أولاً
  (`hasPermission`).
- **الدرس العام:** أي قراءة Discord تُغلَّف بـ`.catch(() => null)` تفشل بصمت —
  لا انهيار ولا سجل، الميزة تصمت للأبد. لذلك `apps/dashboard/test/discord.test.ts`
  يثبّت **شكل الطلب** نفسه (الـURL)، لا النتيجة فقط.
- **«مجهول» ليس `false`:** `PermissionStatus.granted` ثلاثي القيمة
  (`boolean | null`). `null` = تعذّرت القراءة. تحويله إلى `false` يرفض عملية
  يستطيع البوت تنفيذها. مسار الكتابة يرفض فقط عند `false` مؤكدة.

## قواعد معمارية يفرضها المشروع
- `discord.js` يُستورد في ملف واحد فقط: `apps/bot/src/lib/discord.ts`.
  (GOVERNANCE rule 2)
- معالج الأوامر في `apps/bot/src/index.ts` **لا يسجّل العقوبات** — الـ gateway
  يسجّلها مرة واحدة من audit log. تسجيلها هنا ينتج مدخلين لفعل واحد.
  الاستثناء: `moderation.warn` و`moderation.clearwarns` لأنهما سجلان لا تعديل Discord.
- السبب (reason) يُقرأ من `AuditLogEntry.reason` في `createActorResolver`،
  لا من خيار الأمر.
- `config/channels.json` يجب أن يطابق السكيما **بالضبط** وإلا رفض البوت الإقلاع
  (GOVERNANCE rule 15). أضف حدثاً → حدّث الملف + `channels.json` معاً.
- `command-registry.ts` هو سلطة الأوامر: أمر غير مسجّل يُرفض قبل أي نداء Discord.
  كل أمر مُسجَّل **يجب** أن يكون له builder في `buildModerationCommands`.
- مفتاح تكوين غير مدعوم لأمر ما يُجبَر على القيمة الافتراضية في
  `normaliseCommandConfig` — لا تُخزّن مفتاحاً لا يفعل شيئاً.
- **ملكية البيانات:** البوت يملك `guilds.member_count` و`ping_ms`؛ اللوحة تبذر
  الصف فقط (`ensureGuild` = `ON CONFLICT DO NOTHING`). لا تستخدم `upsertGuild`
  من اللوحة — كان يصفّر العدد عند كل فتح.
- **لا تعرض رقماً لا تعرفه:** `pingMs`/`online` تُشتق من نبضة حديثة، لا من وجود
  توكن. `members.online` من ودجت السيرفر فقط (قاعدة 8 تمنع `GUILD_PRESENCES`).
- **محرّك مضاد التخريب مُسلَّح لكنه متوقف افتراضياً** — الاحتواء يسحب رتب مشرف،
  وهذا قرار المالك.

## اللوحة
- `types.ts` يُعيد تصدير كل عقد مشترك من `@al-ai/core/browser`؛ لا تُكرّر شكلاً
  موجوداً في core (سبب انحراف سابق: `CommandFlag` كان معرّفاً في مكانين).
- `logCategories` تُشتق من `eventsByCategory` لا تُكتب يدوياً.
- `bot-log` وجهة داخلية: لا تظهر للمشغّل ولا يمكن ربطها بقناة. الـ BFF يفلترها
  عبر `normaliseCategoryChannels`.
- المنطق القابل للاختبار يُستخرج إلى دوال نقية في `@al-ai/core`
  (`deriveBotStatus`, `summarisePunishments`, `assessRoleHierarchy`,
  `assessRoleIconGate`, `assessNukeAction`) بدل حقنه في المسار.

## البيئة (Windows)
- PostgreSQL 17 في `C:\Program Files\PostgreSQL\17`. نسخة المشروع: data dir
  `C:\Users\dlwta\.al-ai\pgdata` (خارج المستودع)، منفذ **55432**.
- **القاعدة تعمل.** ما كان يُظن قيداً على مستوى النظام هو في الحقيقة:
  `pg_ctl start` يُشغّل عملية فرعية يقتلها الـ sandbox عند انتهاء أمر Bash.
  **الحل: شغّل `postgres.exe` كمهمة خلفية** (`run_in_background: true`).
  الإقلاع يستغرق ~30 ثانية (fsync) و`pg_isready` يقول "rejecting" خلالها.
- المنفذ 5432 مشغول بتثبيت PostgreSQL آخر للمستخدم — **لا تلمسه**.
- **`psql` يتعلّق بلا `-w` و`< /dev/null`** في Git Bash (يُقتل بـSIGTERM بلا مخرجات).
- Docker CLI موجود لكن الـ daemon متوقف؛ WSL محجوب بسياسة أمنية (Program Blacklist).
- `/tmp` في Git Bash يترجم إلى `C:\tmp` لـ node — استخدم مساراً داخل المشروع
  عند تمرير ملف إلى node.
- `scripts/dev-issue-session.mts` يصدر جلسة حقيقية لفحص المسارات المحمية.
  **يجب أن يكون `.mts`** (الجذر بلا `"type": "module"` فـ`.ts` يُترجم CJS).
  مسارات **الكتابة** لا تُفحص به لأنها تحتاج توكن OAuth حقيقي.
