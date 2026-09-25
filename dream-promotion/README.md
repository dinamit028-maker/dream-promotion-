# Dream Promotion

מחלקת השיווק שלך, מונעת AI — פלטפורמה לניהול רשתות חברתיות לעסקים קטנים ובינוניים.

Next.js 14 (App Router) · TypeScript · Tailwind · Zustand · Anthropic API
ממשק עברי RTL מלא, מצב בהיר/כהה, ומובייל שנבנה כמובייל ולא כדסקטופ מוקטן.

---

## הרצה מקומית

```bash
npm install
cp .env.example .env.local     # מלאו לפחות ANTHROPIC_API_KEY
npm run dev                    # http://localhost:3000
```

בלי `ANTHROPIC_API_KEY` האפליקציה עולה ועובדת, אבל כל מסך יצירה יציג
"מנוע ה-AI לא מוגדר" במקום לייצר טקסט מקומי שמתחזה ליצירה של מודל.

---

## עקרון מנחה

**שום כפתור לא משקר.**
פעולה שמחייבת שירות חיצוני שלא חובר — פרסום לאינסטגרם, העלאת קמפיין, רינדור וידאו —
זורקת `IntegrationRequiredError` ומציגה למשתמש בדיוק מה חסר.
אין "חיבור בוצע בהצלחה" מדומה, ואין נתוני ביצועים מומצאים.

---

## מבנה

```
src/
  app/
    layout.tsx              שורש — RTL, פונטים, טוקנים
    page.tsx                דף נחיתה ציבורי
    onboarding/             אונבורדינג 5 שלבים + ניתוח מותג
    (app)/                  האפליקציה מאחורי ה-shell
      layout.tsx            AppShell (סיידבר + טופבר + ניווט תחתון)
      dashboard/ create/ reels/ content/ calendar/ media/
      strategy/ ads/ leads/ analytics/ integrations/ settings/
    api/ai/route.ts         הנקודה היחידה שמדברת עם מודל שפה
  components/
    ui/                     primitives · feedback · Visual
    shell/AppShell.tsx
  features/
    create/CreateStudio.tsx
    calendar/ContentCalendar.tsx
    content/ContentCard.tsx
  lib/
    services/               AI · Media · Social · Ads · Video · prompts
    store.ts                Zustand + persist
    utils.ts
  hooks/useAiReady.ts
  types/index.ts
```

**הפרדה:** קומפוננטות UI לא יודעות על ספקים. פיצ'רים לא יודעים על HTTP.
כל קריאה חיצונית עוברת דרך service אחד, וכל פרומפט יושב ב-`lib/services/prompts.ts`.

---

## מערכת העיצוב

כל צבע הוא CSS variable ב-`app/globals.css`, ו-Tailwind צורך אותם דרך `tailwind.config.ts`.
מעבר למותג אחר או למצב כהה = שינוי משתנים, בלי לגעת בקומפוננטה אחת.

| טוקן | שימוש |
|---|---|
| `--grad` | פעולות AI, CTA ראשי, מצבים נבחרים |
| `--primary` / `--primary-soft` | מיקוד, צ'יפים פעילים, פילים |
| `--surface` / `--surface-2` | כרטיסים ורקעים משניים |
| `--ink` / `--ink-2` / `--muted` | היררכיית טקסט |

מרווחים: 4 / 8 / 12 / 16 / 24 / 32 / 48 / 64 / 96 / 128.
רדיוסים: 10 / 16 / 24 / 32.

---

## מה עובד היום

- אונבורדינג + ניתוח מותג (AI), התחברות וחשבונות (Supabase Auth)
- יצירת פוסט / ריל / סטורי / מודעה עם וריאציות, עריכה, טיוטות, תזמון, שכפול
- תמונות ב-AI (Nano Banana 2) וסרטונים (Wan 3.0) דרך fal, עם תצוגה מקדימה לפי פלטפורמה לפני שיבוץ
- **אולפן רילס מקצה לקצה:** בריף → תסריט → סטוריבורד → קליפים → קריינות בעברית (ElevenLabs) →
  כתוביות → מוזיקת רקע → **MP4 סופי אנכי 9:16** (`/api/reel/render`, ffmpeg בצד השרת)
- מילון הגייה: הקול אומר את הגרסה המוגדרת ("אי סים"), הכתוביות מציגות את המקור ("eSIM")
- כל פרויקט ריל נשמר בחשבון (`content.reel`) תוך כדי עבודה ונפתח מחדש אחרי רענון או התחברות מחדש
- ספריית מדיה מתמידה ב-Supabase Storage (תמונות, וידאו, אודיו), כולל הריל הסופי
- מכסת שימוש חודשית בצד השרת לווידאו, תמונות וקול (`public.usage`)
- יומן, "תכנן לי את השבוע", אסטרטגיה שבועית, קמפיינים, CRM לידים, RTL ומצב כהה

## הקמה ב-Supabase

1. SQL Editor → הריצו את `supabase/schema.sql`.
2. אחריו כל קובץ ב-`supabase/migrations/` לפי סדר התאריך (בטוח להריץ שוב).
3. Authentication → URL Configuration: Site URL = כתובת האתר ב-Vercel.

## מפתחות

הרשימה המלאה, עם הסבר לכל משתנה, ב-`.env.example`.

| משתנה | חובה | בשביל מה |
|---|---|---|
| `ANTHROPIC_API_KEY` | כן | כל הטקסט: תסריטים, פוסטים, תוכנית שבועית |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | כן | חשבונות, מסד נתונים |
| `SUPABASE_SERVICE_ROLE_KEY` | כן | אחסון קבצים, ריל סופי, מכסות |
| `FAL_KEY` | לתמונות ווידאו | Nano Banana 2, Wan 3.0 |
| `ELEVENLABS_API_KEY` | לקריינות | קול בעברית |
| `VOICE_PROVIDER` | לא (ברירת מחדל `elevenlabs`) | מנוע הקול |
| `ELEVENLABS_MODEL_HE` | לא (ברירת מחדל `eleven_v3`) | מודל לעברית — v3 מכבד `language_code` |
| `ELEVENLABS_MODEL` | לא (ברירת מחדל `eleven_multilingual_v2`) | מודל לשפות אחרות |
| `QUOTA_VIDEO_SECONDS_MONTH` / `QUOTA_IMAGES_MONTH` / `QUOTA_VOICE_CHARS_MONTH` | לא (300 / 200 / 30000, ‏0 = ללא הגבלה) | מכסה חודשית למשתמש |
| `APP_ACCESS_CODE` | לא | גישה בלי התחברות |
| `AI_MODEL`, `FFMPEG_PATH`, `REEL_FONTS_DIR` | לא | עקיפות מתקדמות |

## הריל הסופי — איך זה עובד

- השרת מוריד את הקליפים, הקריינות והמוזיקה, מנרמל הכול ל-720×1280 ‏30fps, וקצב כל סצנה נקבע לפי אורך הקריינות
  (קליפ קצר מדי "מוקפא" בפריים האחרון, ארוך מדי נחתך).
- כתוביות נצרבות מקובץ ASS בגופן Rubik (`assets/fonts`), עם כיווניות עברית נכונה גם כשיש מילים באנגלית.
- המוזיקה בלולאה, בעוצמה שנבחרה, ויורדת אוטומטית כשהקריין מדבר (sidechain), עם fade-in/out לתמונה ולקול.
- הקובץ עולה ל-`assets/<user>/reel/`, נוסף לספריית המדיה ומשויך לפרויקט.
- ffmpeg מגיע מהחבילה `ffmpeg-static` ונכלל בפונקציה דרך `outputFileTracingIncludes` ב-`next.config.mjs`.

## מה עדיין דורש חיבור

| יכולת | מה חסר | איפה מחברים |
|---|---|---|
| פרסום לאינסטגרם/פייסבוק | Meta App + OAuth | `social.service.ts` |
| פרסום לטיקטוק | TikTok Content API | `social.service.ts` |
| לידים מוואטסאפ | WhatsApp Business API | `social.service.ts` |
| העלאת קמפיינים | Meta Marketing API (`ads_management`) | `ads.service.ts` |
| נתוני ביצועים | Instagram Graph + Meta Insights | מסך analytics |
