# Dream Promotion

מחלקת שיווק מבוססת AI לעסקים קטנים: יצירת פוסטים ורילס בעברית, קריינות, כתוביות, ספריית מדיה, יומן,
ופרסום לאינסטגרם, פייסבוק ו-TikTok.

Next.js 14 (App Router) · TypeScript · Tailwind · Zustand · Supabase · Vercel
ממשק עברי RTL מלא, מצב בהיר/כהה, מותאם לטלפון.

**עיקרון מנחה: שום כפתור לא משקר.** פעולה שדורשת שירות שלא חובר מציגה בדיוק מה חסר — בלי הצלחות מדומות ובלי נתונים מומצאים.

---

## ✅ עובד עכשיו

| יכולת | איך |
|---|---|
| חשבונות, התחברות, אונבורדינג | Supabase Auth; כל שורה במסד שייכת למשתמש אחד (RLS) |
| יצירת טקסט: פוסטים, תסריטי רילס, תוכנית שבועית, טקסט לפוסט + האשטגים | Anthropic (`/api/ai`, כל הפרומפטים ב-`lib/services/prompts.ts`) |
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
| יומן ותזמון | תכנון ותזמון תוכן (תזכורת — הפרסום עצמו ידני) |
| מכסות ובקרת עלויות | שמירה אטומית של מכסה ב-Postgres, הגבלת עבודות במקביל ובקשות לדקה |
| מסך ניהול (`/admin`) | למנהלים בלבד (`ADMIN_EMAILS`): עלות היום/החודש/לתקופה, ממוצע לריל ולמשתמש, פירוק לפי סוג/ספק/מודל/איכות/משתמש, רילים יקרים, כישלונות וניסיונות חוזרים, מצב ספקים (אחוז הצלחה, זמן, שגיאות), והשוואת ספקים ידנית עם אישור הוצאה |

## 🔑 דורש הגדרת מפתחות

הרשימה המלאה ב-`.env.example` (מקובצת לפי שירות).

| שירות | משתנים | בלעדיו |
|---|---|---|
| Supabase | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY` | אין חשבונות, אחסון, ריל סופי או מכסות |
| Anthropic | `ANTHROPIC_API_KEY` | מסכי היצירה מציגים "ה-AI לא מוגדר" |
| fal.ai | `FAL_KEY` | אין תמונות, וידאו ותמלול |
| ElevenLabs | `ELEVENLABS_API_KEY` | אין קריינות |
| Meta | `META_APP_ID`, `META_APP_SECRET`, `META_CONFIG_FULL`, `META_CONFIG_READ`, `META_REDIRECT_URI` | אין חיבור לאינסטגרם/פייסבוק |
| TikTok | `TIKTOK_CLIENT_KEY`, `TIKTOK_CLIENT_SECRET`, `TIKTOK_REDIRECT_URI` | אין שליחה ל-TikTok |
| Cron | `CRON_SECRET` + `supabase/cron-stories.sql` | סטוריז נמשכים רק כשמסך המדיה פתוח |

## 🚧 עוד לא / מוגבל

| יכולת | מצב |
|---|---|
| פרסום אוטומטי ב-TikTok | לא — רק טיוטה ב-Inbox (מגבלת TikTok לאפליקציות שלא עברו audit) |
| פרסום אוטומטי בזמן מתוזמן | לא — היומן מתזמן, הפרסום בלחיצה |
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

## הריל הסופי — איך זה עובד

- השרת מוריד את הקליפים, הקריינות והמוזיקה (דרך safe-fetch), מנרמל ל-720×1280 ‏30fps; כל סצנה באורך הקריינות שלה, או באורך הקליפ כשאין קריינות.
- הקול המקורי של הקליפים נשמר (בשקט מתחת לקריינות); המוזיקה בלולאה ויורדת כשמדברים.
- כתוביות: הדפדפן מצייר כל מצב של שורה כתמונה שקופה בגודל מסך מלא (עברית, פונט, צבע, מילה מודגשת) — השרת מחבר אותן לערוץ כתוביות אחד.
- אין fade-in מהשחור, כך שהפריים הראשון (ותמונת השער באינסטגרם) הוא תמונה אמיתית.
- ffmpeg מגיע מ-`ffmpeg-static` ונכלל בפונקציה דרך `outputFileTracingIncludes` ב-`next.config.mjs`.

## מבנה

```
src/
  app/(app)/          המסכים מאחורי ה-shell: dashboard create reels content calendar media
                      strategy ads leads analytics integrations settings
  app/api/            ai image video voice transcribe media archive reel/render
                      meta/* tiktok/* social/* cron/meta-stories
  components/         ui (primitives, MicButton…) · shell/AppShell
  features/           reels (FinalReelPanel, CaptionEditor, captionImages) · social · media · content …
  lib/server/         quota · safe-fetch · reel-render · meta · tiktok · secrets · access
  lib/services/       לקוחות ה-API בדפדפן + prompts
supabase/migrations/  מקור האמת של מסד הנתונים
```
