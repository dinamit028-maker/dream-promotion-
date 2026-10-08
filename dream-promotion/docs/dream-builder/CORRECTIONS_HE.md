# תיקונים לחבילה — לקרוא לפני הכל

התיקונים כאן גוברים על כל מה שכתוב בשאר החבילה.

## 1. מקור האמת לתמונות

מקור האמת היחיד הוא `kit-images.json` שבתוך כל ZIP ב-branch בשם `kit-images`.

- ב-branch התמונות שמורות כקבצי ZIP. פתח כל ZIP. אם התיקייה שנפתחת נקראת `kit-images-<שם>`, שנה את שמה ל-`<שם>`.
- בסוף צריכות להיות 7 תיקיות: `fashion`, `furniture`, `beauty`, `bags`, `services`, `retail`, `general`.
- אל תעשה commit לקבצי ה-ZIP לתוך `main`.

## 2. asset-manifests

- `services`, `retail`, `general` — אומתו מול ה-ZIP האמיתי (`"verified": true`). שמות קבצים, מידות, focal ו-alt נכונים.
- `fashion`, `furniture`, `beauty`, `bags` — ריקים (`"verified": false`). צור אותם בעצמך מתוך `kit-images.json` שב-ZIP, באותו פורמט.
- אם יש אי-התאמה בין manifest ל-JSON שב-ZIP, ה-ZIP קובע.

## 3. textSafe

ה-JSON שב-ZIP משתמש בכיוון פיזי. הסכמה משתמשת בכיוון לוגי (RTL):

| ב-JSON | בסכמה |
|---|---|
| `right` | `start` |
| `left` | `end` |
| חסר | `""` |

החלק הפנוי לטקסט בתמונות ה-Hero הרחבות נמצא **בצד ימין**. אל תמפה ל-`end`.

## 4. שתי תמונות Hero רחבות

בכל Kit יש 2 תמונות `hero / wide` (order 1 ו-2). השתמש בשתיהן: slider ב-Kits שה-Hero שלהם slider, ובשאר — התמונה השנייה כחלופה הניתנת לבחירה בעורך.

## 5. collection slugs

השווה את ה-`collection` שב-JSON של כל ZIP מול הקטגוריות ב-`kits-v2-target/<kit>.json`. דווח על כל אי-התאמה בעברית **לפני** שאתה משנה משהו. אל תשנה slugs בעצמך.

## 6. חלוקה ל-3 PRs

1. **PR-1:** חיבור assets + 7 עיצובים שונים באמת (לפי `docs/PHASE1_DESIGN_MATRIX.md`).
2. **PR-2:** Preview בלי mutation + Design Switch / Full Kit.
3. **PR-3:** עורך Drag & Drop — לפי `docs/VISUAL_BUILDER_ENGINEERING_HE.md`, מפוצל ל-PR-3a / 3b / 3c. המסמך הזה גובר על סעיף "Visual Builder" ב-`CLAUDE_START_HERE_PHASE1.md`. screenshots אמיתיים לגלריה נכנסים ל-PR-3b.

כל PR עצמאי, עם tests ו-Preview URL. אל תמזג אף אחד. התחל ב-PR-1 בלבד, ועצור לאישור לפני PR-2.

## 7. Flatsome

ההשראה לעורך היא UX Builder של Flatsome, ברמת עקרונות בלבד. אין להעתיק ממנו קוד, CSS, תבניות, תמונות או thumbnails, ואין להכניס את קובצי Flatsome לריפו. פירוט ב-`docs/VISUAL_BUILDER_ENGINEERING_HE.md`, סעיף 0.
