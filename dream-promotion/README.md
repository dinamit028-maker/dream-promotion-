# Dream Promotion

מחלקת שיווק מבוססת AI לעסקים קטנים: יצירת פוסטים ורילס בעברית, קריינות, כתוביות, ספריית מדיה, יומן,
ופרסום לאינסטגרם, פייסבוק ו-TikTok.

Next.js 14 (App Router) · TypeScript · Tailwind · Zustand · Supabase · Vercel
ממשק עברי RTL מלא, מצב בהיר/כהה, מותאם לטלפון.

**עיקרון מנחה: שום כפתור לא משקר.** פעולה שדורשת שירות שלא חובר מציגה בדיוק מה חסר — בלי הצלחות מדומות ובלי נתונים מומצאים.

---

## בדיקות

- `npm test` — בדיקות הלוגיקה והשרת (tsx, בלי רשת).
- `npm run test:sql` — כל המיגרציות על Postgres 16 מקומי, וניסיונות עקיפה כמשתמשים מחוברים: RLS, קופאי/ת, מנהל-על, עסק מול עסק, ועומס מקבילי.
- `npm run test:e2e` — Chromium אמיתי מול Supabase מדומה: הקופה, "כספים" ו"חנות" — טלפון (375 / 390 / 430), טאבלט (768) ומחשב (1440).
- **החזית** (`../storefront/`) — אפליקציה נפרדת עם בדיקות משלה: `npm test`, `npm run test:e2e` (Chromium מול Postgres אמיתי). פירוט: `storefront/README.md`.
- `tests/store-theme.test.ts` מריץ גם את הקוד של החזית, ולכן צריך `npm ci` גם ב-`storefront/`.
- לפני כל PR: `npm run typecheck`, `npm test`, `npm run build`.
- מצב מלא ומה נבדק: `STATUS.md`. דרישות רשות המסים: `COMPLIANCE_CHECKLIST.md` ו-`docs/ISRAEL_COMPLIANCE_MATRIX.md`.
- **התוכנה לא רשומה ברשות המסים ולא אושרה על ידה.** המסמכים מיועדים לבדיקה עד הרישום ובדיקת יועץ מס.

## ✅ עובד עכשיו

| יכולת | איך |
|---|---|
| חשבונות, התחברות, אונבורדינג | Supabase Auth. כל שורה שייכת לעסק (`business_id`); RLS מציג רק את העסק שעובדים בו (`can_access_business`, `current_business_id`). `user_id` = מי יצר את השורה |
| יצירת טקסט: פוסטים, תסריטי רילס, תוכנית שבועית, טקסט לפוסט + האשטגים | Anthropic (`/api/ai`; הפרומפטים ב-`lib/services/prompts.ts`, וקריאת הוצאה ב-`app/api/finance/expenses/scan/route.ts`) |
| תמונות | fal.ai — Nano Banana 2 (יצירה ועריכה) |
| קליפי וידאו | fal.ai — Wan (טקסט→וידאו, תמונה→וידאו), כולל ביטול בזמן המתנה בתור |
| קריינות בעברית | ElevenLabs, עם מילון הגייה (הכתוביות שומרות את הכתיב המקורי) |
| תמלול (מיקרופון, כתוביות מדיבור) | fal.ai — Whisper, תזמון לכל מילה |
| ריל סופי | ffmpeg בשרת: סצנות + קריינות + קול מקורי + מוזיקה (עם ducking) + כתוביות → MP4 ‏720×1280 |
| ריל חסכוני | התסריט מחליט לכל סצנה: וידאו AI (רק איפה שתנועה חשובה, עד ~35% מהאורך), תמונה בתנועה (Ken Burns ב-ffmpeg), כרטיס ממותג (חינם), או מדיה של המשתמש (חינם) |
| טיוטה → גרסה סופית | טיוטה: סצנות הווידאו נוצרות כתמונות בתנועה (כמה סנטים). גרסה סופית: רק הן הופכות לווידאו, מהתמונה שאושרה כפריים ראשון; כל השאר לא נוצר שוב |
| עורך כתוביות | 6 סגנונות, 10 פונטים עבריים, הדגשת המילה הנאמרת, עריכה לפי שורה, תיקון AI |
| ספריית מדיה | העלאה ישירה לאחסון פרטי, ארכוב אוטומטי של כל קובץ שנוצר |
| Instagram + Facebook | OAuth (מצב פרסום / מצב משיכה בלבד), פרסום פוסט, רילס וסטורי, בחירת תמונת שער |
| ייבוא סטוריז מאינסטגרם | בכל כניסה למסך המדיה, כל 2 דקות כשהוא פתוח, וכל 10 דקות ברקע (Supabase pg_cron) |
| TikTok | OAuth + **שליחה לטיוטות (Inbox)** — הסרטון מגיע לאפליקציית TikTok והמשתמש מפרסם משם. **זה לא פרסום אוטומטי.** |
| יומן ותזמון | תכנון תוכן ביומן |
| פרסום אוטומטי מתוזמן | בוחרים זמן ויעדים (Instagram רילס/סטורי, עמוד Facebook, TikTok) — השרת מפרסם בזמן, גם כשהאפליקציה סגורה. סטטוס לכל יעד. TikTok: נשלח לטיוטות בזמן שנקבע |
| שעות מומלצות | בחלון התזמון: השעות הכי טובות לכל יעד — מהנתונים של החשבון (לייקים ותגובות לפי שעה, רילס ופוסטים) ומחקרי 2026 מותאמים לישראל (סטורי, TikTok, פייסבוק) |
| מכסות ובקרת עלויות | שמירה אטומית של מכסה ב-Postgres, הגבלת עבודות במקביל ובקשות לדקה |
| כספים (`/finance`, 2.51; כאפליקציה בפני עצמה מ-2.52) | נפתח עם תפריט משלו (תפריט מימין, סרגל תחתון ו-"+" בטלפון, סרגל צד במחשב) וכתובת לכל מסך (`/finance/documents` …). מסמכים (305/300/320/400/330) מהמסך ומהקופה — **לבדיקה בלבד עד רישום התוכנה ובדיקת יועץ מס**, קבלות, זיכויים, הכנסות (יומן תשלומים), הוצאות (קריאה עם AI רק בלחיצה, ובאישור), חייבים ותזכורות, הצעות מחיר עם קישור ללקוח, דוחות מע״מ ורווח, חבילה לרואה החשבון (ממשק פתוח לפי הקריאה שלנו בהוראות 1.31 — לא נבדק בסימולטור), יומן פעולות בשרשרת hash (מגלה שינוי, לא מונע). **רישום תשלומים — לא סליקה.** בלי ספקי חשבוניות חיצוניים. פירוט: `STATUS.md` סעיף 4טז |
| מסך ניהול (`/admin`) | למנהלים בלבד (`ADMIN_EMAILS`): עלות היום/החודש/לתקופה, ממוצע לריל ולמשתמש, פירוק לפי סוג/ספק/מודל/איכות/משתמש, רילים יקרים, כישלונות וניסיונות חוזרים, מצב ספקים (אחוז הצלחה, זמן, שגיאות), והשוואת ספקים ידנית עם אישור הוצאה |

## 🔑 דורש הגדרת מפתחות

הרשימה המלאה ב-`.env.example` (מקובצת לפי שירות).

| שירות | משתנים | בלעדיו |
|---|---|---|
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | אין חשבונות, אחסון, ריל סופי או מכסות |
| Anthropic | `ANTHROPIC_API_KEY` | מסכי היצירה מציגים "ה-AI לא מוגדר" |
| fal.ai | `FAL_KEY` | אין תמונות, וידאו ותמלול |
| ElevenLabs | `ELEVENLABS_API_KEY` | אין קריינות |
| Meta | `META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_FULL` (התצורה חייבת לכלול גם `leads_retrieval` ו-`pages_manage_ads` לייבוא לידים), `META_REDIRECT_URI` | אין חיבור לאינסטגרם/פייסבוק |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI` | אין שליחה ל-TikTok |
| Cron | `CRON_SECRET` + `supabase/cron-stories.sql` + `supabase/cron-publish.sql` | סטוריז נמשכים רק כשמסך המדיה פתוח; פרסום מתוזמן לא רץ |
| רשות המסים (לא חובה) | `APP_URL`, `ITA_OAUTH_AUTHORIZE_URL`, `ITA_OAUTH_TOKEN_URL`, `ITA_CLIENT_ID`, `ITA_CLIENT_SECRET`, `ITA_OAUTH_SCOPE`, `ITA_ENVIRONMENT`; לשליחה: `TAX_GATEWAY_MODE=live`, `ITA_API_BASE_URL`, `ITA_ALLOCATION_PATH`, `ITA_SPEC_VERIFIED=1` (רק אחרי שמממשים את `mapRequest` / `mapResponse` לפי המפרט הרשמי) | אין בקשת מספר הקצאה אוטומטית — מזינים ידנית מספר שהתקבל מהרשות |
| קריאת הוצאות עם AI | `ANTHROPIC_API_KEY` (+ `AI_SCAN_MODEL`, לא חובה) | ממלאים הוצאה ידנית |
| החנות — תצוגה מקדימה (2.55) | `STOREFRONT_URL` (הכתובת של פרויקט החזית ב-Vercel), `STOREFRONT_PREVIEW_SECRET` (אותו ערך כמו בחזית) | "תצוגה מקדימה" מסבירה מה חסר |
| החנות — מסוף סליקה (2.56) | `PAYMENT_SEAL_KEY` (32 תווים ומעלה, אותו ערך כמו בחזית) | "מכירה באתר" אומרת שהשרת לא מוכן לשמור מפתחות |
| החנות — דומיין ב-Vercel (לא חובה, 2.55) | `VERCEL_API_TOKEN`, `VERCEL_STOREFRONT_PROJECT`, `VERCEL_TEAM_ID` (רק לצוות). **לא אומת מול Vercel** | המסך מציג את הצעדים להוספת הדומיין ב-Vercel ביד |

## 🚧 עוד לא / מוגבל

| יכולת | מצב |
|---|---|
| פרסום אוטומטי ב-TikTok | לא — רק טיוטה ב-Inbox (מגבלת TikTok לאפליקציות שלא עברו audit) |
| העלאת קמפיינים ממומנים | לא — טיוטות קמפיין בלבד (Meta Marketing API לא מחובר) |
| נתוני ביצועים (Insights) | לא מחובר |
| לידים מוואטסאפ | לא מחובר |
| סטורי עם מוזיקה מספריית אינסטגרם | Meta לא מאפשרת להוריד — נשמר כרשומה בלי קובץ |
| Alibaba Wan ישיר | נכתב לפי ה-API הרשמי (text-to-video, Wan 2.7) ונבדק מול תגובות מדומות — **עוד לא נבדק עם מפתח אמיתי**. image-to-video עדיין רק דרך fal |
| Kling / Seedance / MiniMax | לא מחוברים — המבנה מוכן (קובץ ספק אחד + שורה ב-config) |

---

## הקמה

```bash
npm install
cp .env.example .env.local
npm run dev          # http://localhost:3000
npm run build
```

### מסד הנתונים

כל אובייקט במסד נוצר מקבצים ב-`supabase/migrations/`, לפי הסדר (כולם בטוחים להרצה חוזרת ולא מוחקים נתונים):
Supabase → SQL Editor → להריץ כל קובץ, מהישן לחדש. פירוט ב-`supabase/migrations/README.md`.
במסד החי של הפרויקט הורצו כל המיגרציות עד 3400 (3400 ב-6.10.2026). סעיף 3 של 3400 רץ ב-SQL Editor, ונבדק מול הקובץ. 3500 (`commerce_checkout`, 2.56.0) הוחלה ב-6.10.2026, אחרי אישור (`20261006065045`). `supabase/cron-commerce.sql` — עוד לא. ראו "מצב מיגרציות" ב-`STATUS.md`.

אחר כך, פעם אחת: `supabase/cron-stories.sql` עם הערך של `CRON_SECRET` (לא נשמר בריפו).

Authentication → URL Configuration: Site URL = כתובת האתר ב-Vercel.

---

## ספקי AI ועלויות

- **AI Router** (`src/lib/server/ai/router.ts`) — הנקודה היחידה שמייצרת. המסכים מבקשים מצב איכות; ה-router בוחר ספק.
- **AI_CONFIG** (`src/lib/server/ai/config.ts`) — המקום היחיד עם שמות ספקים, מודלים ומחירים.
  וידאו: `draft` (480p, fal) · `standard` (720p) · `premium` (1080p). `AI_VIDEO_PRIMARY=alibaba` הופך את Alibaba לראשי עם fal כגיבוי.
- **ספקים:** `FalVideoProvider`, `AlibabaWanProvider`, `FalImageProvider` (`src/lib/server/ai/providers/`); קול: `lib/services/voice` (ElevenLabs).
- **Fallback מבוקר:** שגיאה זמנית (עומס, 5xx, רשת) → ניסיון חוזר אחד → הספק הבא. שגיאת קלט, חסימת תוכן, מפתח שגוי או חוסר קרדיט → בלי fallback.
  בקשה שהספק לא תומך בה (תמונת פתיחה, 480p, מעל 15 שניות ב-Alibaba) עוברת ישר לספק שתומך.
- **ספר עלויות** (`ai_generations`): כל קריאה — טקסט, תמונה, וידאו, קול, תמלול ורינדור — נרשמת בשרת עם ספק, מודל, יחידות, עלות משוערת ובפועל, ניסיונות חוזרים ו-fallback.
  `reel_costs` — עלות לכל ריל לפי סוג; `provider_health` — אחוז הצלחה וזמן ממוצע לכל ספק (7 ימים).
  השיוך לריל מגיע מהכותרת `x-dp-content` שהסטודיו שולח, ונבדק שהריל שייך למשתמש.

## אבטחה

- **קריאות בתשלום** (`/api/ai`, `image`, `video`, `voice`, `transcribe`) דורשות משתמש מחובר או `APP_ACCESS_CODE`.
- **מכסות אטומיות:** `reserve_usage` שומר את היחידות בתוך טרנזקציה עם נעילה למשתמש, לפני הקריאה לספק.
  הצלחה → `commit_usage`, כישלון → `release_usage`. גם בקשות במקביל לא עוקפות את המכסה.
- **הורדות בשרת (SSRF):** השרת מוריד קבצים רק דרך `lib/server/safe-fetch.ts` — https בלבד, רק מאחסון Supabase של הפרויקט
  ומה-CDN של fal (או `ASSET_HOSTS`), חסימת כתובות פרטיות/מקומיות/metadata, בדיקה מחדש בכל redirect, ותקרת גודל.
- **העלאות:** רשימת סיומות מותרות, תקרת גודל לפי סוג, בדיקת הסוג והגודל שנשמרו בפועל באחסון, ומגבלות על ה-bucket עצמו.
- **טוקנים של רשתות חברתיות** מוצפנים (AES-256-GCM) ונקראים רק בשרת; לטבלאות האלה אין גישה מהדפדפן.

## כספים — איך זה בנוי (2.51)

- **מקור האמת הוא המסד** (`supabase/migrations/20261004003100_dream_finance.sql`):
  - סכומים, מע״מ וסוגי מסמך נבדקים בטריגר בכל הפקה, וכך גם תקרת זיכוי.
  - מספור רציף בלי פערים.
  - מפתח `idempotency_key` נגד כפילויות.
  - יומן תשלומים ויומן פעולות שלא נערכים מהאפליקציה (append-only), עם שרשרת hash שמגלה שינוי.
  - סגירת תקופה.
- **בצד הלקוח** (`src/features/finance/`):
  - מנוע אחד: `vat.ts` (שיעורים היסטוריים), `rules.ts` (סוג העוסק → מסמכים מותרים), `compose.ts` (הרכבת מסמך / קבלה / זיכוי באגורות).
  - כל הפקה עוברת דרך `issueDocumentRow` (`api.ts`).
- **פרטיות:**
  - כל טבלה מוגבלת לעסק הנוכחי. הקופאי/ת לא רואה כלום.
  - מנהל-על רואה כספים של עסק אחר רק אחרי "פתיחת גישה" עם סיבה ותוקף, שנרשמת ביומן של העסק.
- **רשות המסים** (`src/lib/server/tax/`):
  - שער עם 3 מצבים (לא מוגדר / בדיקות / חי), ו-OAuth לכל עסק. הטוקנים מוצפנים ובשרת בלבד.
  - אין כתובות או שדות מומצאים: המיפוי נעצר עד אימות מול המפרט הרשמי.
  - מספר בדיקה תמיד מסומן `TEST`.
- **ניווט (2.52):**
  - `src/components/shell/ModuleShell.tsx` — מעטפת כללית למודול שנפתח כאפליקציה (שם, צבע, קבוצות תפריט, סרגל תחתון, "+").
  - `src/features/finance/module.ts` — התפריט, הסרגל וה-"+" של הכספים.
  - `src/features/finance/routes.ts` — הכתובות. קישורים ישנים (`/finance?tab=…`) מועברים ב-`src/middleware.ts`.
- **סקירת אבטחה:** `docs/finance-security-review.md`.
- **2.52.1 — מוכנות לפיילוט:** תיקוני אבטחה וכפילויות בקוד; מיגרציה `20261005003200_pilot_hardening.sql` נבדקה מקומית והוחלה על המסד החי ב-5.10.2026, אחרי אישור (פירוט: `STATUS.md` סעיף 4יח).
- **2.53.0 — Dream Commerce, שלב 0:** תכנון החנות בלבד, בלי קוד ובלי מיגרציה. האפיון: `docs/DREAM_COMMERCE_SPEC.md`. הארכיטקטורה, כולל ההחלטות שמחכות לבעל המערכת: `docs/DREAM_COMMERCE_ARCHITECTURE.md`.
- **2.54.0 — Dream Commerce, שלב 1: מוצרים.** קטלוג אחד לקופה, לכספים ולחנות:
  - `src/features/catalog/` — הכללים (`catalog.ts`), הקריאה והכתיבה (`data.ts`), התמונות (`images.ts`, `upload.ts`), עורך המוצר האחד (`ProductEditor.tsx`), המתג "באתר" (`PublishSwitch.tsx`) ורשימת המוצרים (`ProductsScreen.tsx`).
  - מודול "חנות": `/store/products`, `/store/products/[id]` (`src/features/store/`).
  - תמונות: `/api/store/media` (קישורי העלאה חתומים ל-bucket `store-media`).
  - מיגרציה `20261005003300_commerce_catalog.sql` — נבדקה מקומית **והוחלה על המסד החי ב-5.10.2026**, אחרי אישור (`20261005205543`). פירוט: `STATUS.md` סעיף 4כ ו"מצב מיגרציות".
- **2.55.0 — Dream Commerce, שלב 2: החזית לצפייה.**
  - **החזית:** אפליקציה נפרדת, `storefront/` (Next 16). החנות נקבעת לפי הדומיין, והאתר קורא למסד רק דרך פונקציות `sf_*`. התבנית הראשונה: "שקיות ממותגות". אין קנייה. הקמה ב-Vercel, משתני סביבה ודומיין: `storefront/README.md`.
  - **בדשבורד, מודול "חנות":** הגדרות ודומיין, עיצוב (טיוטה, פרסום, גרסאות, תצוגה מקדימה), קולקציות, עמודים ומדיניות, ותפריטים (`src/features/store/`). השרת: `/api/store/domains`, `/api/store/preview-token`.
  - **מיגרציה `20261005003400_commerce_store.sql`:** נבדקה מקומית, **והוחלה על המסד החי ב-6.10.2026, אחרי אישור** (`20261006043124`). סעיף 3 שלה רץ ב-SQL Editor, ונבדק. פירוט: "מצב מיגרציות" ב-`STATUS.md`.
  - **מיגרציה `20261006003500_commerce_checkout.sql` (2.56.0):** נבדקה מקומית, **והוחלה על המסד החי ב-6.10.2026, אחרי אישור** (`20261006065045`); השוואה מלאה מול מסד מקומי — זהה. אחריה, ידנית: `supabase/cron-commerce.sql`. פירוט: `STATUS.md` סעיף 4כב.

## הריל הסופי — איך זה עובד

- השרת מוריד את הקליפים, הקריינות והמוזיקה (דרך safe-fetch), מנרמל ל-720×1280 ‏30fps; כל סצנה באורך הקריינות שלה, או באורך הקליפ כשאין קריינות.
- הקול המקורי של הקליפים נשמר (בשקט מתחת לקריינות); המוזיקה בלולאה ויורדת כשמדברים.
- כתוביות: הדפדפן מצייר כל מצב של שורה כתמונה שקופה בגודל מסך מלא (עברית, פונט, צבע, מילה מודגשת) — השרת מחבר אותן לערוץ כתוביות אחד.
- אין fade-in מהשחור, כך שהפריים הראשון (ותמונת השער באינסטגרם) הוא תמונה אמיתית.
- ffmpeg מגיע מ-`ffmpeg-static` ונכלל בפונקציה דרך `outputFileTracingIncludes` ב-`next.config.mjs`.

## מבנה

```
src/
  app/(app)/          המסכים מאחורי ה-shell: dashboard create reels content calendar media strategy ads leads
                      appointments register finance/* store/* attendance analytics integrations settings admin
                      error.tsx (שגיאה בעברית במקום מסך לבן)
  app/                d/[token] (מסמך ללקוח) · q/[token] (הצעת מחיר) · book/[slug] (תורים) · c/ · clock/ (נוכחות)
                      error.tsx · global-error.tsx · not-found.tsx
  app/api/            ai image video voice transcribe media archive reel/render meta/* tiktok/* social/* cron/*
                      finance/* (רשות המסים, מספרי הקצאה, סריקת הוצאה) · doc/[token] (+pdf) · quote/[token] · book/*
                      clock/* · notify/* · business/me · admin/*
  components/         ui (primitives, feedback, MicButton…) · shell (AppShell, ModuleShell) · system (VersionWatcher,
                      ErrorScreen, SaveErrorBanner)
  features/           finance · documents · register · booking · crm · timeclock · admin · reels · social · media · content …
  lib/server/         finance (financeCaller) · business · tax/* (gateway, oauth) · sign-pdf · doc-pdf · doc-share
                      rate-limit · admin-users · quota · safe-fetch · reel-render · meta · tiktok · secrets · access
  lib/services/       לקוחות ה-API בדפדפן + prompts
  middleware.ts       קישורים ישנים של הכספים (/finance?tab=…) → הכתובת של המסך
supabase/migrations/  מקור האמת של מסד הנתונים
../storefront/        החזית של החנויות: אפליקציה נפרדת (Next 16), לא מייבאת מכאן כלום — storefront/README.md
```
