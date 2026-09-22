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

- אונבורדינג מלא + ניתוח מותג (AI)
- יצירת פוסט / ריל / סטורי / מודעה עם כמה וריאציות בזוויות שונות
- עריכה, שמירה כטיוטה, תזמון, שכפול, מחיקה
- אולפן רילס — תסריט מחולק לקליפים של 15 שניות, רינדור ב-Wan 3.0 (fal), רצף חלק בין קליפים ותצוגה רציפה
- יומן חודשי עם גרירה ושחרור + "תכנן לי את השבוע"
- אסטרטגיה שבועית
- ספריית מדיה עם העלאה
- בונה קמפיינים + חישוב הוצאה מתוכננת
- CRM לידים עם סטטוסים
- הגדרות, ערכת מותג ומצב מערכת
- RTL, מצב כהה, ניווט תחתון במובייל

## מה עדיין דורש חיבור

| יכולת | מה חסר | איפה מחברים |
|---|---|---|
| פרסום לאינסטגרם/פייסבוק | Meta App + OAuth | `social.service.ts` |
| פרסום לטיקטוק | TikTok Content API | `social.service.ts` |
| לידים מוואטסאפ | WhatsApp Business API | `social.service.ts` |
| העלאת קמפיינים | Meta Marketing API (`ads_management`) | `ads.service.ts` |
| נתוני ביצועים | Instagram Graph + Meta Insights | מסך analytics |
| חיבור הקליפים לקובץ אחד + כתוביות וקריינות בעברית | Remotion / ffmpeg | חדש |
| אחסון מדיה מתמיד | S3 / Supabase Storage | `media.service.ts` |
| התחברות ומשתמשים | Supabase Auth | חדש |
| בסיס נתונים | Postgres/Supabase במקום localStorage | `lib/store.ts` |

---

## מפתחות נדרשים

ראו `.env.example`. חובה להתחלה: `ANTHROPIC_API_KEY`.
כל השאר נדרש רק כשמחברים את היכולת המתאימה.

---

## צעדים הבאים מומלצים

1. Supabase — סכמת users / businesses / content / media / leads / campaigns, והחלפת ה-persist.
2. Meta OAuth — מסך החיבורים כבר מחכה ל-`/api/auth/meta`.
3. Cron לפרסום מתוזמן (Vercel Cron → `/api/publish/tick`).
4. Rate limit על `/api/ai` לפני שהדמו הציבורי עולה לאוויר.
