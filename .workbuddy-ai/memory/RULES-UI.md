# RULES-UI — التمرير والقوائم والتركيب

مرافق لـ`MEMORY.md`. اقرأه قبل أي عمل على `apps/dashboard`.

## 🔴 التمرير (حارس: `apps/dashboard/test/layout.test.tsx`)
- **إطار واحد بحجم الشاشة وعنصر تمرير واحد لكل شاشة:** `html,body,#root{height:100dvh;overflow:hidden}`،
  `grid h-full grid-rows-[minmax(0,1fr)]`، هيدر `shrink-0` (لا `sticky`)، و`<main>` وحده `flex-1 min-h-0
  overflow-y-auto`.
- **⚠️ داخل مستند مقفل أي `min-h-dvh` يُقتطع بلا تمرير** ⇒ الشاشات خارج الـshell `h-full` + تمرير داخلي.
- **`min-h-0` هو ما يجعل `flex-1` «خذ الباقي»** لا «اتمدّد مع المحتوى».
- **Sticky داخل شبكة يحتاج `self-start`.**

## 🔴 قوائم Radix
- `max-h-64` على **المحتوى** (وهو `overflow-y-auto`)؛ العرض `w-[var(--radix-select-trigger-width)]` (لا `min-w`
  وحده)؛ **`min-w-0 truncate` على نصّ الخيار**.
- **🔴 `h-[var(--radix-select-trigger-height)]` على الـviewport عديم الأثر:** Radix يضع `flex-direction:column` على
  المحتوى و`flex: 1 1 0%` على الـviewport، و**`flex-basis` يتقدّم على `height`**.
- **⛔ `<select>` أصلي = قائمة يرسمها النظام** ⇒ بيضاء على ثيم داكن. استعمل `ui/select`.
- **قيمة `SelectValue` تُرسَل بـportal عند تركيب المحتوى فقط** ⇒ `renderToString` يُظهر trigger فارغاً و
  `createRoot` في jsdom يُظهرها. **أي قياس هندسي يلزمه متصفح حقيقي.**

## 🔴 Popover (مكوّن جديد `ui/popover.tsx`)
- **`PopoverContent` يُرسَل بـportal إلى `document.body`** ⇒ **خارج تدفّق المستند** ⇒ فتحه **لا يمدّ الصفحة**
  (مُثبت هندسياً: فرق ارتفاع اللوحة والمستند = 0). **وله `role="dialog"`** — لذا استعلم بـ
  `[role="dialog"][aria-label="…"]` وليس بالبنية.
- **⛔ لا `max-h` على الحاوية** — الارتفاع ملك **المحتوى**: صندوق بحث ثابت + قائمة `max-h-56 overflow-y-auto`
  وإلا مرّ صندوق البحث مع التمرير.
- **العرض `w-[var(--radix-popover-trigger-width)]`** على المحتوى ليطابق الزناد.
- **الزناد يفتح على `pointerdown` + `click`** (Radix يسجّل نوع المؤشّر). **والـtrigger `role="combobox"` +
  `aria-label` + `aria-expanded`** ⇒ الحالة المغلقة تُقاس بـ`aria-expanded === "false"` و**غياب أي `[role="dialog"]`**.
- **🔴 في jsdom: النقر ثم الاستعلام في نفس التكت يقرأ الشجرة قبل النقر** ⇒ أي helper للفتح يجب أن يكون
  `async` مع `await act(...)`، **و`interact` في `mount.test.tsx` يعمل والمحتوى مركّب** (اللوحات في `document.body`
  لا في الحاوية).
- **⚠️ لا تُثبِت «لا لوحة مفتوحة» على مستوى اللوحة** — البطاقة المطويّة **لا تُركِّب جسمها أصلاً** فينجح الفحص
  بلا معنى. **ثبّته على المكوّن، أو على لوحة مفتوحة فعلاً.**

## 🔴 الشاشة السوداء — → `react-jsdom-mount-test`
hook بعد `if (error) return` ⇒ `Rendered more hooks than during the previous render` — **يُزيل الشجرة كلها**.
**كل hook فوق كل early return.** `renderToString` **لا ينفّذ التأثيرات** ⇒ الحارس `test/mount.test.tsx` يركّب
الشاشات السبع **مُحمَّلة**، و`error-boundary.tsx` يلفّ **محتوى الشاشة لا الـshell**.
