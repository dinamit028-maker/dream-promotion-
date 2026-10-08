# DREAM Builder --- PHASE 1 / 7 KITS ONLY

> **קרא קודם את `CORRECTIONS_HE.md`.** התיקונים שם גוברים על הקובץ הזה: מקור האמת לתמונות, המרת textSafe, ושלושה PRs נפרדים.

## זו המשימה הפעילה כרגע

עבוד רק על 7 הערכות שכבר קיימות ב-Dream Promotion 2.61.0:

1.  `fashion`
2.  `furniture`
3.  `beauty`
4.  `bags`
5.  `services`
6.  `retail`
7.  `general`

**אל תבנה כרגע את 13 הערכות הנוספות.** המנוע כן חייב להיות כללי ומוכן
ל-20+ Kits, כך שהוספת Kit עתידי תדרוש JSON + assets בלבד כאשר הוא משתמש
ב-variants קיימים.

## מקור אמת

ה-Snapshot שנבדק הוא Dream Promotion 2.61.0.

לפני שינוי קוד: - בדוק את `main` הנוכחי מול 2.61.0. - reuse כל דבר שכבר
קיים. - אל תחזיר קוד לאחור. - אל תבנה Builder, Preview, Revision,
Draft/Publish או Renderer מקבילים. - קרא את
`docs/DREAM_BUILDER_CLAUDE_MASTER_SPEC_2.61_AUDITED.md`.

## תמונות

ל-7 הערכות כבר קיימת חבילת תמונות מקורית ב-branch בשם `kit-images`.

השתמש ב-ZIP-ים הקיימים שם: - `kit-images-fashion.zip` -
`kit-images-furniture.zip` - `kit-images-beauty.zip` -
`kit-images-bags.zip` - `services.zip` - `retail.zip` - `general.zip`

בכל ZIP יש תיקיית Kit, תמונות WebP, README ו-`kit-images.json`.

אין לייצר placeholders ואין להעתיק תמונות או assets מ-Flatsome.

### מיפוי assets

-   `hero / wide` → Hero desktop / slider
-   `hero / vertical` → split/mobile
-   `imageText` → image+text
-   `collection` → לפי collection slug
-   `gallery` → gallery
-   `focal` → object-position דרך מנגנון CSS מאובטח; לא inline style אם
    CSP חוסם
-   `textSafe` → צד הטקסט ב-Hero
-   `alt` → alt
-   asset חסר או slug לא קיים → warning בבדיקות, לא crash

תמונות Kit הן defaults בלבד. הן לא נכנסות למוצרים, למלאי או לקופה. תמונת
משתמש תמיד גוברת על default של Kit, וצריך לאפשר חזרה ל-default.

## יעד Phase 1

בסוף השלב חייבים לראות 7 Starter Sites שנראים שונים באמת --- לא אותו אתר
בצבעים אחרים.

השונות צריכה להגיע מ: - Header - Hero - Product Card - Collections -
Image+Text - Gallery - Footer - typography - spacing - buttons - product
page - section composition/order

השתמש ב-`kits-v2-target/` כיעד configuration וב-`kits-current-2.61/`
להשוואה.

## Preview וגלריית תבניות

גלריית התבניות צריכה להציג screenshot אמיתי של כל Kit, שנוצר מה-renderer
האמיתי לאחר שה-assets מחוברים.

כפתור `תצוגה מקדימה` חייב להראות את העסק הנוכחי בתוך Kit אחר ללא
mutation למסד.

בדיקת קבלה מרכזית: הצג את **FollowMe** עם אותם נתונים ומוצרים על לפחות 3
Kits שונים.

לאחר Preview: - `החלפת עיצוב` → משנה עיצוב בלבד ושומרת
תוכן/עמודים/תפריטים/מוצרים/קטגוריות/Business Data. - `ערכה מלאה` → יכולה
לשנות section composition/default presentation, אך לעולם לא למחוק או
לשכפל Business Data.

## Visual Builder

הרחב את ה-Visual Editor הקיים. אל תחליף אותו.

נדרש: - Desktop / Tablet / Mobile - עריכת טקסט קיימת - עריכת/החלפת
תמונה - בחירה ב-default של Kit - variants לסקשנים - שינוי סדר -
duplicate/hide/delete/add - global design controls - undo/redo אם ניתן
ליישם על revision/draft model הקיים בלי מערכת מקבילה

## Definition of Done

Phase 1 לא נחשב גמור עד ש:

-   7 Kits נטענים בהצלחה.
-   כל 7 ה-Kits משתמשים בתמונות האמיתיות מה-branch `kit-images`.
-   כל 7 נראים שונים באופן ברור.
-   FollowMe מוצג על 3 Kits שונים ב-Preview ללא שמירה.
-   Preview לא משנה DB.
-   Design Switch שומר את כל התוכן וה-Business Data.
-   Full Kit שומר מוצרים, מלאי, לקוחות, הזמנות ונתונים פיננסיים.
-   Draft/Publish ממשיך לעבוד.
-   Rollback ממשיך לעבוד.
-   אין דריסה של עריכות משתמש.
-   Desktop/Tablet/Mobile נבדקו.
-   RTL ונגישות נבדקו.
-   focal/textSafe/alt נבדקו.
-   screenshot אמיתי נוצר לכל Kit לגלריה.
-   Kit שמיני שמשתמש ב-variants קיימים ניתן להוספה ללא שינוי engine
    code.
-   אין מוצרי דמה.
-   אין שינוי ב-`commerce_live`.
-   אין merge או production deploy ללא אישור בעלת המערכת.

## סיום העבודה

בסיום: 1. עדכן גרסה. 2. עדכן `STATUS.md`. 3. תן רשימת קבצים ששונו. 4. תן
תוצאות tests. 5. תן Preview URL. 6. פתח PR חדש. 7. אל תמזג.

כל ההודעות לבעלת המערכת בעברית.
