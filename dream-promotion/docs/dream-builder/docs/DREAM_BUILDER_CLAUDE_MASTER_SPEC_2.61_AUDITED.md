# DREAM COMMERCE / DREAM BUILDER

## Master Implementation Spec --- Audited against Dream Promotion 2.61.0

### מסמך עבודה יחיד לקלוד --- לשדרוג המערכת הקיימת, בלי לבנות מערכות כפולות

**Snapshot שנבדק בפועל:** `dream-promotion-2.61.0-full.zip`\
**גרסת Dashboard:** `2.61.0`\
**גרסת Storefront:** `2.61.0`\
**תאריך:** 7 באוקטובר 2026\
**Reference architecture שנלמד:** Flatsome Classic 3.20.11, לצורכי
product/architecture בלבד. אין להעתיק קוד, CSS, assets או UI.

------------------------------------------------------------------------

# 0. הוראת על לקלוד --- קרא לפני שינוי קוד

הפרויקט **אינו מתחיל מאפס**.

Dream Commerce 2.61.0 כבר מכיל חלק גדול מהתשתית של Builder מודרני:

-   Storefront נפרד.
-   מנוע Sections.
-   7 Starter Kits כ-JSON.
-   Draft / Published / Archived.
-   Preview חתום.
-   חזרה לגרסה קודמת.
-   Visual Editor שמציג את האתר האמיתי בתוך iframe.
-   Click-to-edit.
-   Inline text editing.
-   הוספה / שכפול / מחיקה / הסתרה / שינוי סדר של Sections.
-   אותו Storefront Renderer משמש גם Preview וגם Live.
-   Business Data אמיתי מגיע מהמנועים הקיימים.
-   Products אינם נוצרים מחדש על ידי Kit.
-   RLS, domains, catalog, checkout, finance ו-CRM כבר קיימים.

**לכן אסור לבנות Builder חדש במקביל.** המשימה היא **להרחיב את המנוע
הקיים של 2.61.0** עד לרמת Theme Builder / Template Gallery עשירה.

כלל על:

> EXTEND, DO NOT REPLACE.

------------------------------------------------------------------------

# 1. מה נבדק בפועל ב-2.61.0

נבדקו בפועל הקבצים והאזורים הבאים מתוך ה-ZIP:

## Dashboard

``` text
dream-promotion/
  STATUS.md
  CLAUDE.md
  docs/DREAM_COMMERCE_SPEC.md
  docs/DREAM_COMMERCE_ARCHITECTURE.md

  kits/
    bags.json
    beauty.json
    fashion.json
    furniture.json
    general.json
    retail.json
    services.json

  scripts/kits.mjs

  src/features/store/
    StoreDesign.tsx
    StoreVisual.tsx
    StoreKits.tsx
    StoreNavigation.tsx
    StoreCollections.tsx
    StoreSettings.tsx
    data.ts
    kits.ts
    kits.generated.ts
    theme-fields.ts
    visual-edit.ts
    preview-token.ts
    ui.tsx

  tests/
    store-theme.test.ts
    store-kits.test.ts
    store-visual-edit.test.ts
    store-media.test.ts
    e2e/commerce.e2e.ts
    sql/store-kits.check.sql
```

## Storefront

``` text
storefront/
  src/
    proxy.ts
    app/layout.tsx
    app/globals.css
    app/site/[host]/
    components/
      chrome.tsx
      ui.tsx
      listing.tsx
      EditBridge.tsx
      sections/index.tsx
    lib/
      theme.ts
      edit.ts
      preview.ts
      site.ts
      data.ts
      types.ts
    templates/
      bags.ts
      kit.ts

  tests/
    unit/kits.test.ts
    unit/edit.test.ts
    unit/storefront.test.ts
    e2e/storefront.e2e.ts
```

## Database

נבדקה התשתית של:

-   `stores`
-   `store_theme_versions`
-   `store_pages`
-   `store_menus`
-   `catalog_collections`
-   `store_publish_theme`
-   `sf_store`
-   `sf_page`
-   `sf_menu_visible`

המיגרציות עד `20261006003800_store_kits.sql` קיימות ב-ZIP.

------------------------------------------------------------------------

# 2. מצב אמיתי של המערכת --- DO NOT REBUILD

הסעיפים הבאים **כבר קיימים**. אין לבנות להם מנוע שני.

## 2.1 Starter Kits

כבר קיימים 7 Kits:

1.  bags
2.  beauty
3.  fashion
4.  furniture
5.  general
6.  retail
7.  services

כל Kit הוא JSON ב-`kits/`.

`scripts/kits.mjs` מייצר:

`src/features/store/kits.generated.ts`

`validateKit()` בודק:

-   schema.
-   links.
-   contrast.
-   section types.
-   page/collection consistency.

**לא ליצור מערכת Theme Files חדשה במקום זה.** יש להרחיב את פורמט ה-Kit
הקיים.

------------------------------------------------------------------------

# 3. Draft / Publish / Revision כבר קיימים

טבלת:

`store_theme_versions`

כבר מחזיקה:

-   draft
-   published
-   archived
-   version number
-   settings JSONB
-   template
-   note
-   timestamps

קיים:

`store_publish_theme()`

שמאפשר גם לפרסם גרסה ישנה מחדש.

ב-UI כבר יש:

**"להחזיר לאתר"**

לגרסה קודמת.

## הוראה

**לא ליצור:**

-   design_revisions table
-   theme_snapshots table
-   publish engine חדש
-   rollback engine חדש

השתמש ב-`store_theme_versions`.

אם נדרש Undo/Redo בתוך session העריכה, הוא צריך להיות client-side
history מעל ה-Draft הקיים --- לא טבלת DB חדשה.

------------------------------------------------------------------------

# 4. Preview כבר קיים

קיים Preview חתום:

-   Dashboard: `preview-token.ts`
-   Storefront: `lib/preview.ts`
-   HMAC.
-   Store אחד.
-   expiry.
-   `STOREFRONT_PREVIEW_SECRET`.

ה-Storefront יודע להציג Draft דרך preview token.

## הוראה

**לא ליצור Preview service חדש.**

יש להרחיב את ה-Preview הקיים כך שיוכל גם להציג Kit אחר **לפני Apply**,
בלי לשנות את ה-Draft.

------------------------------------------------------------------------

# 5. Shared Renderer כבר קיים

זה ממצא חשוב.

ה-Visual Editor ב-2.61.0 **לא מחקה את האתר**.

הוא מציג את ה-Storefront האמיתי בתוך iframe.

לכן:

-   Preview משתמש ב-Storefront.
-   Visual Editor משתמש ב-Storefront.
-   Live משתמש ב-Storefront.

זה כבר עונה על העיקרון:

> One renderer.

## הוראה

**לא לבנות Renderer נוסף בדשבורד.**

כל הרחבה ויזואלית צריכה להתבצע ב-Storefront renderer הקיים.

ה-Dashboard נשאר Controller / Inspector.

------------------------------------------------------------------------

# 6. Click-to-edit כבר קיים

כבר קיימים:

Dashboard:

-   `StoreVisual.tsx`
-   `visual-edit.ts`

Storefront:

-   `EditBridge.tsx`
-   `lib/edit.ts`

קיימים:

-   `data-edit-section`
-   `data-edit-field`
-   `data-edit-image`
-   `data-edit-link`
-   `postMessage`
-   origin validation
-   source validation
-   inline text edit
-   selection
-   navigation בתוך iframe

## הוראה

**לא להחליף את המנגנון.**

להרחיב אותו.

------------------------------------------------------------------------

# 7. Section Engine כבר קיים

קיימים 10 Section Types:

``` text
hero
collections
products
imageText
steps
faq
contact
text
gallery
newsletter
```

ה-7 Kits משתמשים באותו Engine.

הם כבר שונים מעט בסדר הסקשנים.

לדוגמה:

``` text
fashion:
hero → products → collections → imageText → gallery → newsletter → contact

beauty:
hero → imageText → gallery → products → steps → faq → contact

retail:
hero → collections → products → products → products → faq → contact
```

זה בסיס נכון.

## הבעיה

לכל Section Type יש כרגע **Renderer ויזואלי אחד בלבד**.

לכן למרות סדרים שונים, האתרים עדיין מרגישים דומים.

------------------------------------------------------------------------

# 8. Business Data כבר מופרד מהעיצוב

זה כבר נכון ב-2.61.0.

Kit:

-   לא יוצר Product.
-   לא משכפל Inventory.
-   לא יוצר Sale.
-   לא יוצר Finance data.
-   לא משנה CRM.
-   לא משנה POS.

Product Data מגיע מהקטלוג הקיים.

Storefront קורא דרך `sf_*`.

## הוראה

**לא לבנות Data Binding Engine חדש.**

השתמש ב-data layer הקיים.

Theme / Kit משפיע על Presentation בלבד.

------------------------------------------------------------------------

# 9. Media Upload כבר קיים

`PicturePicker` משתמש ב:

`uploadStorePicture()`

ותמונות חנות עוברות דרך מנגנון המדיה הקיים.

## הוראה

לא ליצור uploader חדש.

צריך להוסיף מעל הקיים:

-   בחירה מספריית מדיה.
-   AI image action.
-   default kit asset.
-   reset to kit default.

------------------------------------------------------------------------

# 10. מה חסר באמת

אלה הפערים שצריך לבנות.

## 10.1 אין Variants

כרגע:

-   Hero אחד.
-   Header אחד.
-   Footer אחד.
-   Product Card אחד.
-   Collection Card אחד.
-   Product Page layout אחד.

זה הפער העיקרי בין המערכת הנוכחית לבין WordPress/Flatsome/Wix.

------------------------------------------------------------------------

# 11. אין Header Builder / Header Variants

`storefront/src/components/chrome.tsx`

מכיל Header אחד קשיח:

-   menu icon
-   logo
-   nav
-   search
-   cart

כל 7 ה-Kits משתמשים באותו Header.

## צריך

בשלב הזה אין צורך לבנות Free-form Header Builder חדש.

צריך קודם Variant Engine.

לפחות:

``` text
minimal
centered-logo
split-navigation
search-heavy
commerce-wide
transparent-overlay
dark
compact
```

אותו `Header` component, עם variant בטוח ומאומת.

------------------------------------------------------------------------

# 12. אין Footer Variants

קיים Footer אחד.

צריך לפחות:

``` text
minimal
multi-column
newsletter
dark
centered
```

אותו data.

עיצוב שונה.

------------------------------------------------------------------------

# 13. Product Card אחד בלבד

`storefront/src/components/ui.tsx`

מכיל:

`ProductCard`

אחד.

צריך לפחות:

``` text
classic
centered
editorial
overlay
horizontal
minimal
```

אסור לשכפל Product Data.

------------------------------------------------------------------------

# 14. Collection Card אחד בלבד

כרגע `.tile`.

צריך:

``` text
grid
circle
editorial
overlay
carousel
masonry
```

------------------------------------------------------------------------

# 15. Product Page אחד בלבד

`products/[slug]/page.tsx`

כרגע:

-   gallery
-   product-info
-   sticky info
-   related

מבנה אחד.

צריך Variant/Preset layer:

``` text
classic
gallery-left
gallery-right
stacked
editorial
compact
wide
```

אין צורך בשלב הזה להפוך את Product Page ל-free-pixel editor.

הוא צריך להיות data-driven preset.

------------------------------------------------------------------------

# 16. Global Design Tokens חלקיים בלבד

כרגע קיימים:

-   8 colors.
-   font.
-   radius.
-   art placeholder.

חסר:

-   spacing scale.
-   heading scale.
-   button style.
-   button radius/height.
-   container width.
-   section gap.
-   card shadow.
-   card border.
-   image ratio.
-   nav style.

## הרחבת Draft / Theme

שמור backward compatibility.

הוסף optional object:

``` ts
design: {
  spacing: "compact" | "normal" | "airy"
  headingScale: "small" | "normal" | "large" | "display"
  buttonStyle: "solid" | "outline" | "soft" | "underline" | "pill"
  container: "narrow" | "normal" | "wide"
  cardStyle: "flat" | "border" | "shadow" | "soft"
}
```

Defaults צריכים לשמור בדיוק את המראה של 2.61.0 ל-sites ישנים.

------------------------------------------------------------------------

# 17. Theme Composition

הוסף optional:

``` ts
chrome: {
  headerVariant: string
  footerVariant: string
}

commerceDesign: {
  productCardVariant: string
  collectionCardVariant: string
  productPageVariant: string
}
```

שמות מדויקים יכולים להשתנות אם קיים naming convention טוב יותר.

העיקר:

**כל הערכים whitelist בלבד.**

------------------------------------------------------------------------

# 18. Section Variants

הרחב את Section:

``` ts
interface Section {
  id: string
  type: SectionType
  variant?: string
  hidden: boolean
  settings: Record<string, unknown>
}
```

Optional כדי שכל Draft ישן ימשיך לעבוד.

## Variants ראשוניים

### Hero

``` text
split
full-image
centered
slider
editorial
minimal
```

### Products

``` text
grid
editorial
compact
carousel
featured
```

### Collections

``` text
grid
circles
carousel
editorial
masonry
```

### ImageText

``` text
split
reverse
overlap
full-bleed
```

### Gallery

``` text
grid
masonry
carousel
editorial
```

### Steps

``` text
numbered
cards
horizontal
minimal
```

### FAQ

``` text
accordion
two-column
minimal
```

### Contact

``` text
dark
light
centered
split
```

------------------------------------------------------------------------

# 19. Registry --- להרחיב, לא להחליף

כבר יש Registry חלקי:

Dashboard:

`SECTION_DEFS`

Storefront:

`SCHEMA`

ו-`SectionView` עושה switch לפי type.

אין צורך ליצור framework חדש.

אבל צריך להפוך את ההגדרות ליותר data-driven.

לדוגמה:

``` ts
type VariantDef = {
  id: string
  label: string
}

type SectionDef = {
  type: SectionType
  label: string
  fields: FieldDef[]
  variants: VariantDef[]
  defaultVariant: string
  list?: ListDef
}
```

Storefront צריך whitelist מקביל.

------------------------------------------------------------------------

# 20. אין ליצור shared runtime package בין Dashboard ל-Storefront בלי צורך

כלל קיים ב-CLAUDE.md:

> storefront לא מייבא קוד מה-dashboard.

יש לשמור אותו.

כיום קיימים שני contracts:

-   Dashboard `theme-fields.ts`
-   Storefront `theme.ts`

וה-tests בודקים שאין drift.

## שיפור מותר

אפשר ליצור **generated contract copies**.

אסור לגרום ל-Storefront לייבא runtime code מה-Dashboard.

אם יוצרים generator:

``` text
source schema
  ↓
dashboard generated contract
storefront generated contract
```

שני ה-projects נשארים עצמאיים.

אם generator מוסיף סיכון ל-build, אפשר להישאר עם שני contracts + tests.

------------------------------------------------------------------------

# 21. Default Kit Images --- חסר לגמרי ב-ZIP 2.61

ב-ZIP שנבדק:

-   אין `storefront/public/kits`.
-   אין `kit-images.json`.
-   אין WebP של ה-Kits.
-   אין preview screenshots.
-   כל שדות `image` ב-7 ה-Kits ריקים.
-   Gallery items אינם מכילים את חבילת התמונות שהוכנה בנפרד.

**ה-branch `kit-images` אינו בתוך ZIP 2.61.0.**

לכן קלוד צריך להביא את החבילות מה-branch הקיים, לא להמציא תמונות.

------------------------------------------------------------------------

# 22. Image Packs קיימים ב-branch kit-images

לפי המשימה שהוכנה:

``` text
kit-images-fashion.zip
kit-images-furniture.zip
kit-images-beauty.zip
kit-images-bags.zip
services.zip
retail.zip
general.zip
```

בכל ZIP:

-   folder של ה-kit.
-   WebP.
-   README.
-   `kit-images.json`.

כל asset כולל:

``` text
file
slot
variant
order
focal{x,y}
textSafe
alt
collection
```

## הוראה

לא להכניס את ה-ZIP ל-main.

לחלץ assets ל:

``` text
storefront/public/kits/<kit>/
```

------------------------------------------------------------------------

# 23. שינוי נדרש ב-safeImage

כרגע `safeImage()` מקבל רק:

`https://...`

אבל default kit assets יהיו מקומיים:

``` text
/kits/fashion/hero-01.webp
```

ה-CSP כבר מאפשר:

`img-src 'self' https: data:`

לכן יש להרחיב `safeImage()` בצורה מוגבלת:

מותר:

-   `https://...`
-   `/kits/<safe-kit>/<safe-file>.webp`
-   אם יש צורך גם `/kits/...png/jpg`, רק extensions מוגדרים.

אסור:

-   `//host`
-   `javascript:`
-   path traversal
-   arbitrary local path

דוגמה:

``` text
^/kits/[a-z0-9-]+/[a-z0-9._-]+\.(webp|png|jpg|jpeg)$
```

התאם לשמות הקבצים האמיתיים.

------------------------------------------------------------------------

# 24. CSP --- לא להשתמש ב-inline style

ה-Storefront במפורש חוסם `style=`.

לכן:

`focal -> object-position`

**לא** באמצעות:

``` tsx
style={{ objectPosition: ... }}
```

במקום זה:

1.  sanitize focal numbers.
2.  `themeCss()` מייצר CSS עם nonce.
3.  selector לפי section id בטוח.

לדוגמה רעיונית:

``` css
[data-section-id="hero"] .hero-img {
  object-position: 35% 50%;
}
```

או CSS variables שנוצרות בתוך `<style nonce>`.

אותו כלל לכל dynamic design token.

------------------------------------------------------------------------

# 25. Alt / focal / textSafe

יש להוסיף support אמיתי.

## Asset metadata

``` ts
type KitAsset = {
  file: string
  slot: "hero" | "imageText" | "collection" | "gallery"
  variant: "wide" | "vertical"
  order: number
  focal: { x: number; y: number }
  textSafe: "start" | "end" | "center" | ""
  alt: string
  collection?: string
}
```

## Behavior

-   `focal` → generated nonce CSS.
-   `textSafe` → class / safe variant.
-   `alt` → `alt`.
-   collection slug → default presentation image for that collection.
-   missing file → warning + fallback.
-   unknown collection → warning + skip.
-   never crash.

------------------------------------------------------------------------

# 26. Asset Priority

צריך להיות:

``` text
1. User uploaded image
2. Site override
3. Kit default asset
4. Existing Art placeholder
```

Default Kit Asset הוא presentation בלבד.

לא לכתוב אותו ל:

-   product image.
-   catalog item.
-   POS.
-   inventory.
-   finance.

------------------------------------------------------------------------

# 27. Collection Images

אל תדרוס `catalog_collections.image_url` בתמונת Kit.

היא Business Data / user content.

הוסף Presentation fallback ב-theme settings, למשל:

``` ts
collectionAssets: {
  "women": "/kits/fashion/collection-women.webp"
}
```

Renderer:

``` text
collection.image_url
  ?? theme.collectionAssets[slug]
  ?? Art
```

כך אם בעל העסק העלה תמונה אמיתית, היא תמיד מנצחת.

------------------------------------------------------------------------

# 28. Hero Assets

Hero צריך לתמוך:

-   desktop wide.
-   mobile vertical.
-   optional slides.

לא חייבים לשנות את כל ה-schema בבת אחת.

אפשר:

``` ts
heroMedia: {
  desktop: string
  mobile?: string
  slides?: string[]
  focal?: ...
  textSafe?: ...
  alt?: string
}
```

או לשלב ב-settings של Hero.

העדף מבנה שקל validate.

------------------------------------------------------------------------

# 29. Template Gallery --- כרגע לא קיימת ברמה הנדרשת

`StoreKits.tsx` מציג כרגע:

-   4 רצועות צבע.
-   שם.
-   description.
-   בחירה.

אין:

-   screenshot אמיתי.
-   preview לפני apply.

## לשדרג את אותו `StoreKits.tsx`

לא לבנות Gallery נפרדת.

Card חדש:

-   screenshot.
-   name.
-   category.
-   current badge.
-   suggested badge.
-   Preview.
-   Apply.

------------------------------------------------------------------------

# 30. Preview Kit לפני Apply --- להשתמש בתשתית Preview הקיימת

דרישה:

לחיצה על:

**"תצוגה מקדימה"**

צריכה לפתוח את אותו Storefront עם:

-   אותו store.
-   אותם products.
-   אותם prices.
-   אותם collections.
-   אותם business details.
-   Theme של Kit שנבחר.

בלי:

-   saveDraft.
-   applyKit.
-   שינוי DB.
-   publish.

## Implementation direction

הרחב את preview הקיים.

אפשרות מומלצת:

1.  ה-Storefront יקבל רשימת Kit Themes generated ומאומתת.
2.  `?kit=<id>` יכובד **רק כאשר יש preview/edit token תקין**.
3.  בלי preview token --- `kit` query ignored.
4.  `getSite()` / theme resolution יבחר:
    -   preview override kit, או
    -   draft/published theme הרגיל.

Kit ID אינו סוד, אבל override מותר רק לבעל Preview תקין.

אין DB mutation.

------------------------------------------------------------------------

# 31. Generated Kit Data ל-Storefront

ה-Storefront לא צריך לקרוא runtime code מה-Dashboard.

אפשר להרחיב את `scripts/kits.mjs` כך שייצר artifact נוסף שמקבל רק את
הנתונים הדרושים ל-Storefront Preview.

לדוגמה:

``` text
storefront/src/templates/kits.generated.ts
```

הקובץ generated בלבד.

לא עורכים אותו ביד.

Tests חייבים לבדוק שהוא תואם ל-`kits/*.json`.

אם כתיבה ל-sibling בזמן build אינה בטוחה בסביבת Vercel:

-   צור command מפורש generation.
-   commit את generated artifact.
-   tests נכשלים אם הוא stale.

אל תשבור את עצמאות ה-Storefront.

------------------------------------------------------------------------

# 32. Apply Modes --- חסר

כרגע יש Apply Kit אחד:

`applyKit()`

הוא יכול ליצור:

-   theme draft.
-   missing collections.
-   missing pages.
-   menus.
-   policies.

זה טוב ל-"ערכה מלאה".

חסר:

## מצב 1 --- החלפת עיצוב

משנה רק Theme Draft:

-   kit id.
-   colors/tokens.
-   variants.
-   default presentation assets.
-   section visual variants.

לא:

-   pages.
-   menus.
-   collections.
-   policies.
-   products.

## מצב 2 --- ערכה מלאה

שומר את ההתנהגות הקיימת של `applyKit()`.

### חשוב

אל תיצור apply engine שני.

אפשר:

``` ts
applyKit(..., mode: "design" | "full")
```

או פונקציה קטנה שממחזרת את `saveDraft()` עבור design-only.

------------------------------------------------------------------------

# 33. Draft Conflict

כבר קיימת הגנה:

`replaceDraft`

אם יש Draft שונה מה-Published.

שמור אותה.

Design-only חייב להשתמש באותה הגנה.

אין לדרוס Draft שקט.

------------------------------------------------------------------------

# 34. Rollback

כבר קיים.

אין לבנות snapshot table.

אחרי Apply:

-   published נשאר.
-   new design הוא draft.
-   user מפרסם רק בלחיצה.
-   old published version נשאר בארכיון אחרי publish.
-   אפשר להחזיר אותו.

------------------------------------------------------------------------

# 35. Visual Editor --- מה כבר קיים

2.61.0 כבר עושה:

-   click section.
-   inline title/text.
-   open image field.
-   move up/down.
-   hide.
-   add.
-   duplicate.
-   remove.
-   auto-save draft.
-   publish.
-   phone / desktop.
-   bottom sheet mobile.

## אל תבנה את זה שוב.

------------------------------------------------------------------------

# 36. Visual Editor --- מה להוסיף

### 36.1 Tablet

הוסף:

``` text
phone
tablet
desktop
```

### 36.2 Drag reorder

כיום יש ▲ / ▼.

שמור אותם לנגישות.

הוסף drag handle לשינוי סדר Sections.

Drag הוא enhancement.

הכפתורים נשארים keyboard fallback.

### 36.3 Undo / Redo

Session history בלבד.

לא DB.

למשל:

``` ts
past[]
present
future[]
```

או reducer command history.

Undo/Redo צריך לעבוד על:

-   text.
-   variant.
-   colors.
-   section move.
-   add.
-   duplicate.
-   remove.
-   visibility.
-   image override.

Auto-save שומר את ה-state הנוכחי.

### 36.4 Colors / fonts / design

היום רק בעורך הקלאסי.

הוסף Visual Editor panel:

-   colors.
-   font.
-   spacing.
-   heading scale.
-   buttons.
-   radius.
-   header.
-   footer.
-   product card.
-   collection style.

### 36.5 Image click

היום PicturePicker מעלה מהמכשיר.

להוסיף:

-   Upload.
-   Media library.
-   AI.
-   Reset to Kit image.

השתמש ב-media system הקיים.

------------------------------------------------------------------------

# 37. אין Free Pixel Positioning

שמור את ההחלטה הקיימת.

Dream Builder אינו Canva.

אין:

-   absolute arbitrary coordinates.
-   pixel placement.

יש:

-   structured sections.
-   variants.
-   responsive controls.
-   safe layouts.

כך האתר נשאר תקין בטלפון.

------------------------------------------------------------------------

# 38. האם לבנות Row / Column / Element כמו Flatsome?

לא כ-Rewrite של 2.61.0.

המערכת כבר בנויה סביב Sections.

למטרה הנוכחית --- 20+ אתרים מוכנים ושונים --- Variants + structured
sections נותנים את רוב הערך בלי לפרק את המערכת.

## הכנה לעתיד

מותר להוסיף optional:

``` ts
children?: BuilderNode[]
```

רק אם באמת נדרש.

אבל:

**אל תמיר את כל 2.61.0 לעץ חדש בפרויקט הזה אם אין צורך.**

היעד הוא לשדרג, לא לזרוק מערכת שעובדת.

------------------------------------------------------------------------

# 39. Header / Footer editing בתוך Visual Editor

Click על Header היום פותח Navigation.

Click על Logo/Footer פותח Settings.

שמור את ההתנהגות.

הוסף ב-Visual panel פעולה:

**"עיצוב Header"**

עם variant selector.

אותו ל-Footer.

Content נשאר בעורכים הקיימים.

כך:

-   content editor קיים נשמר.
-   design editor חדש מתווסף.

------------------------------------------------------------------------

# 40. Product Card / Collection Style בתוך Visual Editor

כאשר נבחר Products section:

בנוסף לשדות הקיימים:

-   collection.
-   limit.
-   title.

הוסף:

-   section variant.
-   product card variant.
-   columns desktop/tablet/mobile אם נדרש.

כאשר נבחר Collections:

-   section variant.
-   collection card variant.

------------------------------------------------------------------------

# 41. Responsive Values

לא צריך להפוך כל property ל-responsive ביום הראשון.

Responsive settings נדרשים בעיקר ל:

-   columns.
-   spacing.
-   alignment.
-   image crop.
-   visibility.

דוגמה:

``` ts
responsive: {
  desktop?: {...}
  tablet?: {...}
  mobile?: {...}
}
```

Optional.

Backward compatible.

------------------------------------------------------------------------

# 42. Breakpoints

ה-Storefront כבר מכיל breakpoints ב-CSS:

-   560/700/800/900/1000 באזורים שונים.

אל תכניס מערכת breakpoints חדשה בלי audit.

בשלב הזה:

1.  רכז constants/semantic device widths ל-Builder preview.
2.  אל תשבור CSS קיים.
3.  אפשר בהמשך לאחד breakpoints.

Visual Editor:

-   phone \~390.
-   tablet \~768.
-   desktop full.

------------------------------------------------------------------------

# 43. Kit JSON v2 --- הרחבה, לא פורמט חדש

דוגמה:

``` json
{
  "id": "fashion",
  "name": "אופנה",
  "description": "...",
  "order": 20,

  "preview": {
    "image": "/kits/fashion/preview.webp",
    "category": "fashion"
  },

  "theme": {
    "colors": {},
    "font": "assistant",
    "radius": "small",

    "design": {
      "spacing": "airy",
      "headingScale": "display",
      "buttonStyle": "underline",
      "container": "wide",
      "cardStyle": "flat"
    },

    "chrome": {
      "headerVariant": "transparent-overlay",
      "footerVariant": "minimal"
    },

    "commerceDesign": {
      "productCardVariant": "editorial",
      "collectionCardVariant": "editorial",
      "productPageVariant": "gallery-left"
    },

    "collectionAssets": {},

    "sections": [
      {
        "id": "hero",
        "type": "hero",
        "variant": "full-image",
        "hidden": false,
        "settings": {}
      }
    ]
  }
}
```

שמות יכולים להשתנות אם יש naming טוב יותר.

העיקר הוא backward compatibility.

------------------------------------------------------------------------

# 44. 7 Kits --- redesign אמיתי

ה-7 קיימים כבר.

לא ליצור אותם מחדש.

להוסיף להם:

-   images.
-   variants.
-   design tokens.
-   header/footer.
-   product cards.
-   collection style.
-   preview screenshot.

## יעד

כאשר שמים 7 screenshots זה ליד זה:

אסור שייראו כמו אותו אתר בצבעים אחרים.

------------------------------------------------------------------------

# 45. Mapping מומלץ ל-7 הקיימים

זה guideline, לא חובה אם design טוב יותר.

## Bags

-   Header: commerce-wide.
-   Hero: split.
-   Product cards: classic.
-   Collections: grid.
-   Footer: multi-column.
-   Feel: kraft / cream / black.

## Beauty

-   Header: centered-logo.
-   Hero: editorial / split.
-   Product cards: minimal.
-   Gallery: editorial.
-   Footer: centered.
-   Feel: dusty pink / cream / plum.

## Fashion

-   Header: transparent-overlay.
-   Hero: full-image / slider.
-   Product cards: editorial.
-   Collections: circles/editorial.
-   Footer: minimal.
-   Feel: black / white / deep red.

## Furniture

-   Header: minimal.
-   Hero: wide editorial.
-   Product cards: minimal.
-   Collections: editorial.
-   ImageText: overlap.
-   Footer: multi-column.
-   Feel: oak / olive / beige.

## General

-   Header: compact.
-   Hero: centered or split.
-   Product cards: classic.
-   Collections: grid.
-   Footer: simple.
-   Feel: blue / gray.

## Retail

-   Header: search-heavy.
-   Hero: slider.
-   Product cards: compact.
-   Collections: carousel.
-   Footer: dark.
-   Feel: burnt orange / black / white.

## Services

-   Header: centered / compact.
-   Hero: split.
-   Products/Services: cards.
-   Steps: horizontal/cards.
-   Contact: strong CTA.
-   Feel: navy / turquoise.

------------------------------------------------------------------------

# 46. 20+ Kits

ה-Engine חייב להיות מוכן ל-20+.

אבל **אל תכתוב component חדש לכל Kit.**

13 families נוספות:

``` text
jewelry-luxury
cosmetics-product
streetwear-dark
shoes-sneakers
kids-baby
sports-fitness
electronics
food-gourmet
bakery-cafe
flowers-gifts
pet-store
wellness-salon
b2b-wholesale
```

## כלל

Kit חדש שמשתמש ב-Section Types וב-Variants קיימים:

= JSON + assets בלבד.

אם נדרש React component חדש כדי להוסיף Kit כזה:

הארכיטקטורה לא data-driven מספיק.

------------------------------------------------------------------------

# 47. חשוב לגבי 20 Kits והתמונות

ב-Snapshot 2.61 קיימות רק 7 ערכות JSON.

קיימים image packs מוכנים רק ל-7 הראשונות לפי branch `kit-images`.

ל-13 הנוספות אין כרגע asset packs בתוך ה-ZIP שנבדק.

## לכן

אל תמציא או תעתיק תמונות מ-Flatsome.

אם asset packs ל-13 הנוספות לא ניתנו:

-   בנה את Engine ל-20+.
-   אל תציג Kit חדש כ-"מוכן" בגלריה בלי assets מלאים.
-   אפשר להוסיף manifests/configs רק לאחר שה-assets נמסרו.

------------------------------------------------------------------------

# 48. Screenshot אמיתי לכל Kit

כיום Gallery מציגה color swatches.

צריך preview screenshot.

## מקור

לא mock ידני.

השתמש ב-Storefront renderer.

Playwright / E2E fixture:

1.  seed store fixture.
2.  render Kit.
3.  wait for images/fonts.
4.  screenshot desktop.
5.  screenshot mobile.
6.  write:
    -   `/kits/<id>/preview.webp`
    -   optional `/kits/<id>/preview-mobile.webp`

אם screenshot generation לא מתאים ל-CI בכל build:

-   command מפורש.
-   generated assets committed.
-   test שמוודא שקיים preview לכל Kit פעיל.

------------------------------------------------------------------------

# 49. Preview עם FollowMe

Acceptance requirement:

להציג את **אותו FollowMe** על 3 Kits שונים.

אותם:

-   products.
-   prices.
-   collections.
-   store identity.

שונה:

-   Header.
-   Hero.
-   product cards.
-   spacing.
-   typography.
-   collections.
-   footer.

זה מוכיח שהעיצוב מופרד מה-Business Data.

------------------------------------------------------------------------

# 50. Design-only Preview

לפני Apply:

``` text
Gallery
→ Preview
→ same business, temporary Kit override
→ phone / tablet / desktop
→ Apply Design / Apply Full Kit
```

Preview לא שומר כלום.

------------------------------------------------------------------------

# 51. Apply UX

אחרי Preview:

שני כפתורים:

## החלפת עיצוב בלבד

טקסט ברור:

> משנה את המראה בלבד. המוצרים, העמודים, התפריטים והתוכן שלכם נשארים.

## ערכה מלאה

טקסט ברור:

> מחילה גם את מבנה הערכה. לפני החלפת תוכן קיים תתבקשו לאשר.

השתמש ב-plan הקיים של `KitPlanView`.

------------------------------------------------------------------------

# 52. Kit Apply --- לא לשבור את ההגנות הקיימות

שמור:

-   existing policy never replaced.
-   page conflict asks.
-   menu conflict asks.
-   edited draft asks.
-   no products.
-   no automatic publish.
-   no `commerce_live`.
-   no live DB migration.

------------------------------------------------------------------------

# 53. Known Risk --- applyKit אינו transaction מלא

`applyKit()` מבצע כרגע writes עוקבים:

-   collections.
-   pages.
-   menus.
-   draft.

אם write באמצע נכשל, הוא מחזיר מה כבר נעשה.

זו התנהגות קיימת.

## במשימה הזאת

אל תבנה מערכת כפולה.

אם אתה נוגע משמעותית ב-apply flow:

-   שקול RPC transactional חדש.
-   migration רק אם באמת נחוץ.
-   prepare only.
-   **לא להחיל על live בלי אישור.**

אם לא נוגעים ב-flow הזה מעבר ל-design-only: אפשר להשאיר ולתעד Known
Risk.

------------------------------------------------------------------------

# 54. Undo / Redo --- לא Revision

חשוב להפריד:

## Revision

כבר קיים ב-DB.

## Undo/Redo

חסר בתוך session.

לכן:

-   Undo/Redo = client history.
-   Publish history = existing DB versions.

אל תערבב ביניהם.

------------------------------------------------------------------------

# 55. AI Design from Inspiration

זה כבר מופיע ב-DREAM_COMMERCE_SPEC כמשימה של Stage 6.

עדיין לא בנוי.

## כלל

AI לא מחזיר JSX/CSS/code.

AI מחזיר configuration בלבד:

``` json
{
  "design": {},
  "chrome": {},
  "commerceDesign": {},
  "sections": [
    {
      "type": "hero",
      "variant": "editorial"
    }
  ]
}
```

הכל עובר validation.

AI יכול לבחור רק:

-   known section type.
-   known variant.
-   known token.
-   known font.
-   known spacing.
-   known palette shape.

------------------------------------------------------------------------

# 56. AI Inspiration --- זכויות

אם המשתמש נותן:

-   URL.
-   screenshot.

ה-AI רשאי ללמוד:

-   composition.
-   density.
-   color mood.
-   hierarchy.
-   section rhythm.

אסור:

-   להעתיק logo.
-   להעתיק text.
-   להעתיק image.
-   לשכפל עיצוב מזוהה 1:1.
-   להעתיק source code.

------------------------------------------------------------------------

# 57. Flatsome --- גבול שימוש

הניתוח של Flatsome 3.20.11 הראה עקרונות שימושיים:

-   element registry.
-   presets.
-   variants.
-   reusable blocks.
-   responsive.
-   live canvas.
-   header presets.
-   product layouts.
-   template library.
-   undo/redo.

Dream צריך לקחת את **העקרונות**.

אסור להכניס:

-   Flatsome source.
-   Flatsome CSS.
-   Flatsome JS/PHP.
-   Flatsome images.
-   thumbnails.
-   PSD.
-   icons.
-   exact demo clones.

------------------------------------------------------------------------

# 58. Reusable Patterns --- שלב הרחבה בתוך אותו Engine

אחרי Variant Engine:

אפשר להוסיף Pattern Library.

Pattern = כמה Sections מוכנים.

לדוגמה:

``` text
Hero + Categories + Products
Hero + ImageText + Gallery
Sale Hero + Countdown + Products
Services + Steps + FAQ + Contact
```

Pattern לא יוצר מערכת חדשה.

הוא פשוט מכניס Sections ל-Draft.

------------------------------------------------------------------------

# 59. Global Blocks

לא חובה כדי להשלים את 20 Kits.

אם מוסיפים:

-   Announcement.
-   Trust bar.
-   Newsletter.
-   CTA.

אפשר לשמור כ-pattern/reusable config.

אל תוסיף טבלה חדשה בלי צורך.

------------------------------------------------------------------------

# 60. Product / Catalog pages

אין לבנות Product DB חדש.

רק presentation.

## Product page

הוסף variant ל-theme.

## Catalog

הוסף:

-   grid density.
-   card variant.
-   filters layout.
-   collection header style.

שמור את `sf_products` וה-query layer הקיים.

------------------------------------------------------------------------

# 61. Storefront CSS strategy

כיום יש:

`globals.css`

ו-`themeCss()`.

שמור CSP.

מומלץ:

-   static variant classes ב-`globals.css`.
-   dynamic tokens ב-`themeCss()`.
-   sanitized per-section CSS ב-`themeCss()` רק כשנדרש focal/responsive
    numeric value.

לא לייצר arbitrary CSS מה-JSON.

------------------------------------------------------------------------

# 62. Security

כל value חדש חייב whitelist.

אין:

-   arbitrary class name.
-   arbitrary CSS.
-   arbitrary HTML.
-   arbitrary JS.
-   style string מהמשתמש.

Variant:

``` ts
if (KNOWN_VARIANTS.includes(value)) ...
```

Token:

-   enum או numeric bounded.

Image:

-   safe https user asset.
-   safe `/kits/...` internal asset.

------------------------------------------------------------------------

# 63. Backward Compatibility

זה קריטי.

יש כבר:

-   FollowMe.
-   SaGabot.
-   published versions.
-   archived versions.
-   template `bags`.
-   template `kit`.

כל settings ישנים חייבים להמשיך לעבוד.

## Defaults

אם אין:

-   section.variant.
-   design.
-   chrome.
-   commerceDesign.

ה-Storefront חייב להציג בדיוק את legacy default.

------------------------------------------------------------------------

# 64. `bags` legacy template

`bags` הוא closed template היסטורי.

אל תשבור אותו.

גרסאות ישנות צריכות להמשיך להיפתח.

Kits חדשים משתמשים ב-`kit`.

אפשר בהמשך לבצע migration ידני, אבל לא כחלק מהמשימה בלי צורך.

------------------------------------------------------------------------

# 65. No DB Migration by Default

רוב השדרוג יכול להיכנס ל:

`store_theme_versions.settings JSONB`

שכבר מאפשר עד 200,000 bytes.

לכן ברירת המחדל:

**אין migration.**

Migration רק אם יש requirement שאי אפשר לפתור ב-settings הקיים.

אם צריך migration:

-   קובץ חדש.
-   idempotent.
-   RLS.
-   prepare only.
-   לא apply live.

------------------------------------------------------------------------

# 66. שלבי ביצוע --- באותו Stage 6, Branch אחד, PR אחד

המשימה הזו היא **תת-פרויקט אחד של Stage 6**.

אין צורך לעצור לאישור בין תתי-השלבים.

כן לעצור לפני:

-   merge.
-   production deploy.
-   live migration.

------------------------------------------------------------------------

# 67. Step 0 --- Preflight

1.  Checkout latest `main`.
2.  Pull.
3.  working tree clean.
4.  קרא:
    -   `CLAUDE.md`
    -   `STATUS.md`
    -   `DREAM_COMMERCE_SPEC.md`
    -   `DREAM_COMMERCE_ARCHITECTURE.md`
5.  ודא version 2.61.0 או version חדש יותר.
6.  אם repo כבר התקדם מעבר ל-ZIP:
    -   אל תחזיר אחורה.
    -   בצע audit diff.
    -   reuse כל מה שכבר נוסף.
7.  אתר branch `kit-images`.
8.  אל תשנה live DB.

------------------------------------------------------------------------

# 68. Step 1 --- Branch

צור branch חדש מ-main.

שם מומלץ:

``` text
claude/dream-builder-theme-engine
```

אם naming convention אחר קיים --- השתמש בו.

------------------------------------------------------------------------

# 69. Step 2 --- Tests Baseline

לפני שינוי:

Dashboard:

``` text
npm run typecheck
npm test
npm run build
```

אם סביבת SQL/E2E זמינה:

``` text
npm run test:sql
npm run test:e2e
```

Storefront:

``` text
npm run typecheck
npm test
npm run build
npm run test:e2e
```

אל תכתוב PASS על בדיקה שלא רצה.

------------------------------------------------------------------------

# 70. Step 3 --- Import 7 Asset Packs

קח מה-branch `kit-images`.

חלץ ל:

``` text
storefront/public/kits/
```

אל תכניס ZIPs.

שמור:

-   WebP.
-   manifest.
-   README רק אם שימושי לפיתוח.

------------------------------------------------------------------------

# 71. Step 4 --- Extend Kit Schema

הוסף:

-   preview.
-   design.
-   chrome.
-   commerceDesign.
-   section.variant.
-   default assets.
-   collection asset map.

עדכן:

-   validateKit.
-   generated file.
-   tests.

Backward compatible.

------------------------------------------------------------------------

# 72. Step 5 --- Extend Storefront Theme Contract

עדכן:

`storefront/src/lib/theme.ts`

עם:

-   whitelisted variants.
-   design tokens.
-   internal kit images.
-   asset metadata.
-   legacy defaults.

עדכן Dashboard contract במקביל.

Tests חייבים להוכיח round-trip.

------------------------------------------------------------------------

# 73. Step 6 --- Variant Renderers

שדרג את components הקיימים.

לא ליצור 7 Homepages.

### Files מרכזיים

``` text
storefront/src/components/sections/index.tsx
storefront/src/components/chrome.tsx
storefront/src/components/ui.tsx
storefront/src/app/globals.css
storefront/src/app/site/[host]/products/[slug]/page.tsx
storefront/src/app/site/[host]/collections/*
```

------------------------------------------------------------------------

# 74. Step 7 --- Connect Default Assets

לכל אחד מ-7 Kits:

-   Hero.
-   ImageText.
-   Collections.
-   Gallery.

לפי manifest.

Implement:

-   order.
-   focal.
-   textSafe.
-   alt.
-   collection slug.

Fallback safe.

------------------------------------------------------------------------

# 75. Step 8 --- Upgrade 7 Kits

כל אחד מקבל:

-   real variants.
-   real assets.
-   design tokens.
-   header/footer.
-   product card.
-   collection style.

לא רק colors.

------------------------------------------------------------------------

# 76. Step 9 --- Upgrade Kit Gallery

שדרג `StoreKits.tsx`.

הוסף:

-   screenshot.
-   preview.
-   apply design.
-   apply full kit.

שמור current/suggested badges.

------------------------------------------------------------------------

# 77. Step 10 --- Kit Preview Override

הרחב preview token flow.

דרישות:

-   real store data.
-   no DB mutation.
-   kit override only with valid preview/edit access.
-   query ignored for public shopper.
-   no indexing.
-   no checkout side effect beyond existing preview behavior.

------------------------------------------------------------------------

# 78. Step 11 --- Visual Editor Upgrade

הוסף:

-   tablet.
-   drag reorder.
-   undo.
-   redo.
-   design panel.
-   section variant.
-   header/footer variants.
-   product/collection style.
-   image actions.

שמור:

-   current iframe.
-   EditBridge.
-   postMessage security.
-   auto-save.
-   classic editor fallback.

------------------------------------------------------------------------

# 79. Step 12 --- Design-only Apply

הוסף mode.

Design-only:

-   theme draft only.
-   preserve content.

Full:

-   existing plan/apply behavior.

Draft conflict protection remains.

------------------------------------------------------------------------

# 80. Step 13 --- Screenshots

צור command:

``` text
npm run kits:screenshots
```

או equivalent.

לכל active kit:

-   desktop.
-   mobile.

ה-Gallery משתמש ב-desktop preview.

------------------------------------------------------------------------

# 81. Step 14 --- 20-Kit Readiness

בצע test:

צור Kit זמני:

``` text
test-kit.json
```

עם:

-   existing sections.
-   existing variants.
-   assets.

בלי React code חדש.

הוא חייב:

-   לעבור validation.
-   להופיע ב-Gallery.
-   Preview לעבוד.
-   Apply design לעבוד.

מחק test kit אחרי הבדיקה.

------------------------------------------------------------------------

# 82. Step 15 --- Additional Kits

אם כל 13 asset packs קיימים בזמן העבודה:

הוסף עד 20.

אם לא:

-   אל תייצר stock assets מזויפים.
-   אל תעתיק Flatsome.
-   השאר engine מוכן.
-   תעד אילו Kits ממתינים ל-assets.

------------------------------------------------------------------------

# 83. Step 16 --- AI Inspiration Generator

רק אחרי Registry/Variants יציבים.

Output configuration בלבד.

Validation חובה.

Preview לפני Apply.

אין auto publish.

------------------------------------------------------------------------

# 84. Tests --- Dashboard

להוסיף/לעדכן:

``` text
store-theme.test.ts
store-kits.test.ts
store-visual-edit.test.ts
```

בדיקות חדשות:

-   variants valid.
-   unknown variant fallback.
-   old settings unchanged.
-   design-only preserves pages/menus.
-   full kit behavior unchanged.
-   asset manifest validation.
-   missing asset warning.
-   focal bounds.
-   textSafe enum.
-   alt.
-   internal path safety.
-   undo/redo reducer.
-   preview override does not save.

------------------------------------------------------------------------

# 85. Tests --- Storefront

להוסיף:

-   kit internal image accepted.
-   arbitrary local path rejected.
-   variant classes.
-   legacy theme unchanged.
-   product card variants.
-   collection variants.
-   header variants.
-   footer variants.
-   product page variants.
-   focal CSS sanitized.
-   preview kit override requires valid preview access.
-   public shopper cannot override kit.
-   edit markers still only in edit mode.

------------------------------------------------------------------------

# 86. E2E

חובה:

1.  FollowMe current theme loads.
2.  open Kit Gallery.
3.  preview Fashion without save.
4.  verify DB draft unchanged.
5.  preview Retail.
6.  preview General.
7.  apply design-only.
8.  verify:
    -   products same.
    -   pages same.
    -   menus same.
9.  publish.
10. live site changes design.
11. rollback old version.
12. live site returns.
13. full kit still asks before replacing conflict.
14. mobile visual editor.
15. tablet visual editor.
16. drag section.
17. undo.
18. redo.
19. upload image.
20. reset to kit image.

------------------------------------------------------------------------

# 87. Visual Regression

לפחות 7 Kits:

-   desktop homepage.
-   mobile homepage.

וגם:

-   product page.
-   collections.
-   header.
-   footer.

אם visual snapshot tooling אינו קיים:

הוסף Playwright screenshot tests בצורה שלא הופכת כל anti-aliasing קטן
לכשל בלתי נשלט.

------------------------------------------------------------------------

# 88. Performance

שמור את היתרון של Storefront נפרד.

-   Builder code לא נכנס ל-live bundle.
-   default assets lazy below fold.
-   Hero eager only where appropriate.
-   `srcset` אם pipeline קיים.
-   no huge JS slider dependency.
-   CSS variants עדיפים על duplicate components.
-   no dashboard imports.

------------------------------------------------------------------------

# 89. Accessibility / RTL

חובה:

-   Hebrew RTL.
-   logical CSS.
-   keyboard.
-   focus.
-   drag has button fallback.
-   carousel controls accessible.
-   alt.
-   heading hierarchy.
-   reduced motion.
-   contrast.
-   mobile touch targets.

------------------------------------------------------------------------

# 90. No duplicate work --- רשימה מחייבת

**אל תבנה מחדש:**

-   store_theme_versions.
-   publishVersion.
-   rollback.
-   preview token.
-   Storefront app.
-   domain resolver.
-   Section engine.
-   Visual Editor iframe.
-   EditBridge.
-   media uploader.
-   product catalog.
-   inventory.
-   cart.
-   checkout.
-   finance.
-   CRM.
-   navigation editor.
-   pages editor.
-   collections editor.
-   kit generator.
-   kit apply planner.
-   AI page copy.

הרחב אותם בלבד.

------------------------------------------------------------------------

# 91. Files שסביר לשנות

Dashboard:

``` text
kits/*.json
scripts/kits.mjs
src/features/store/theme-fields.ts
src/features/store/kits.ts
src/features/store/StoreKits.tsx
src/features/store/StoreDesign.tsx
src/features/store/StoreVisual.tsx
src/features/store/visual-edit.ts
src/features/store/ui.tsx
src/features/store/data.ts
tests/store-theme.test.ts
tests/store-kits.test.ts
tests/store-visual-edit.test.ts
```

Storefront:

``` text
public/kits/*
src/lib/theme.ts
src/lib/site.ts
src/lib/preview.ts
src/proxy.ts
src/components/sections/index.tsx
src/components/chrome.tsx
src/components/ui.tsx
src/app/globals.css
src/app/site/[host]/products/[slug]/page.tsx
src/app/site/[host]/collections/*
tests/unit/kits.test.ts
tests/unit/edit.test.ts
tests/e2e/storefront.e2e.ts
```

ייתכנו קבצים נוספים לפי implementation.

------------------------------------------------------------------------

# 92. Files שלא אמורים להשתנות בגלל Theme Builder

אלא אם נמצא bug אמיתי:

``` text
finance/*
register/*
crm/*
documents/*
checkout finance flow
sales accounting
tax allocation
POS stock engine
```

Theme Builder לא מצדיק שינוי שם.

------------------------------------------------------------------------

# 93. Commerce Live

אסור לגעת:

`commerce_live`

לא:

-   enable.
-   UI.
-   migration.
-   workaround.

------------------------------------------------------------------------

# 94. DB

אל תריץ migration על live.

אל תעשה production mutation.

אם אין migration --- כתוב במפורש:

**No DB migration required.**

------------------------------------------------------------------------

# 95. Version

ה-ZIP שנבדק הוא 2.61.0.

קרא את version הנוכחי ב-main בזמן העבודה.

אל תוריד גרסה.

בצע bump לפי convention של הפרויקט.

עדכן גם Dashboard וגם Storefront אם שניהם משתנים.

------------------------------------------------------------------------

# 96. STATUS.md

בסיום:

-   current version.
-   branch.
-   מה היה קיים לפני.
-   מה הורחב.
-   asset packs.
-   variants.
-   gallery.
-   preview.
-   design-only.
-   visual editor.
-   tests.
-   known risks.
-   migration status.
-   live status.
-   PR.
-   preview URL.

------------------------------------------------------------------------

# 97. PR

PR אחד ל-Stage 6 upgrade.

חובה:

-   summary.
-   architecture.
-   "what reused".
-   "what added".
-   screenshots.
-   FollowMe 3 themes.
-   desktop/mobile/tablet.
-   tests.
-   no migration / migration prepared.
-   risks.
-   rollback.

------------------------------------------------------------------------

# 98. Definition of Done --- Existing Architecture

DONE רק אם:

-   לא נוצר Builder שני.
-   לא נוצר Renderer שני.
-   לא נוצר Theme DB חדש.
-   לא נוצר Preview service חדש.
-   לא נוצר Product source חדש.
-   legacy sites עובדים.

------------------------------------------------------------------------

# 99. Definition of Done --- Theme Engine

DONE רק אם:

-   Section variants קיימים.
-   Header variants קיימים.
-   Footer variants קיימים.
-   Product Card variants קיימים.
-   Collection variants קיימים.
-   Product Page variants קיימים.
-   Design tokens הורחבו.
-   values validated.
-   old settings fallback.

------------------------------------------------------------------------

# 100. Definition of Done --- Assets

DONE רק אם:

-   7 image packs מחוברים.
-   Hero desktop/mobile.
-   ImageText.
-   Collections.
-   Gallery.
-   focal.
-   textSafe.
-   alt.
-   missing file no crash.
-   unknown slug no crash.
-   no images copied from Flatsome.

------------------------------------------------------------------------

# 101. Definition of Done --- Gallery

DONE רק אם:

-   screenshot אמיתי.
-   Preview.
-   Apply Design.
-   Apply Full Kit.
-   current badge.
-   suggested badge.
-   Preview no mutation.

------------------------------------------------------------------------

# 102. Definition of Done --- Visual Editor

DONE רק אם:

-   phone.
-   tablet.
-   desktop.
-   click edit.
-   inline text.
-   section inspector.
-   variant selector.
-   design panel.
-   drag reorder.
-   keyboard move fallback.
-   undo.
-   redo.
-   image upload.
-   reset default.
-   draft auto-save.
-   explicit publish.

------------------------------------------------------------------------

# 103. Definition of Done --- FollowMe

הצג FollowMe על 3 Themes.

אותו Business Data.

שלושה עיצובים שונים באמת.

בדוק:

-   product count.
-   prices.
-   collections.
-   menu content.
-   business identity.

לא משתנים ב-design-only.

------------------------------------------------------------------------

# 104. Definition of Done --- Scalability

Kit נוסף עם existing variants:

= JSON + assets.

לא React code.

לא CSS ייעודי ל-Kit אלא אם הוא הופך ל-Variant reusable.

------------------------------------------------------------------------

# 105. Definition of Done --- No fake completion

אל תכתוב DONE אם:

-   Gallery עדיין color strips.
-   images עדיין empty.
-   7 themes נראים אותו דבר.
-   Preview שומר Draft.
-   Product Cards זהים.
-   Header זהה.
-   Footer זהה.
-   אין Tablet.
-   אין Undo/Redo.
-   asset errors קורסים.
-   tests לא רצו.

------------------------------------------------------------------------

# 106. מצב מדויק שנמצא ב-2.61.0

## קיים

-   7 Kits.
-   10 Section Types.
-   open `kit` template.
-   closed legacy `bags`.
-   JSON settings.
-   theme validation.
-   kit validation.
-   draft.
-   publish.
-   archived revisions.
-   rollback.
-   preview token.
-   Storefront separate.
-   real data preview.
-   visual iframe editor.
-   click-to-edit.
-   inline text.
-   section add.
-   duplicate.
-   remove.
-   hide.
-   move up/down.
-   auto-save.
-   phone/desktop.
-   media upload.
-   RTL baseline.
-   CSP.
-   tests.

## קיים חלקית

-   Visual editor.
-   Theme engine.
-   Section registry.
-   responsive.
-   media selection.
-   template gallery.

## חסר

-   section variants.
-   header variants.
-   footer variants.
-   product card variants.
-   collection variants.
-   product page variants.
-   default image packs in this branch.
-   focal.
-   textSafe.
-   alt mapping.
-   screenshots.
-   preview kit before apply.
-   design-only apply.
-   tablet.
-   drag reorder.
-   undo/redo.
-   media library/AI direct from image click.
-   visual global design panel.
-   20 Kits.
-   AI inspiration generator.
-   visual regression.

------------------------------------------------------------------------

# 107. הממצא החשוב ביותר

הארכיטקטורה של 2.61.0 **לא צריכה להיזרק**.

היא כבר מכילה את הבסיס הנכון:

``` text
Kit JSON
→ Theme settings
→ Draft version
→ Preview
→ Storefront renderer
→ Publish
```

החלק שחסר הוא:

``` text
Variants
+ richer design tokens
+ real assets
+ real template previews
+ safer preview-before-apply
+ richer visual editing
```

כלומר:

**Evolution, not rewrite.**

------------------------------------------------------------------------

# 108. הוראת ביצוע סופית

בצע את כל תתי-השלבים של המסמך על Branch אחד ו-PR אחד.

אל תעצור בין תתי-השלבים.

אבל:

-   אל תמזג.
-   אל תפרוס Production.
-   אל תריץ live migration.
-   אל תדליק commerce_live.

בסיום:

1.  כל הבדיקות הרלוונטיות.
2.  Production builds לשני הפרויקטים.
3.  Preview URL.
4.  screenshots.
5.  FollowMe על 3 Themes.
6.  STATUS.md.
7.  PR.
8.  סיכום בעברית.
9.  רשימת דברים שלא בוצעו בפועל.
10. המתן לאישור בעלת המערכת.

------------------------------------------------------------------------

# APPENDIX A --- Audit Matrix

  Capability                     2.61.0     Action
  ------------------------------ ---------- ---------------------------
  7 JSON Kits                    קיים       להרחיב
  Kit validation                 קיים       להרחיב
  Theme JSON                     קיים       להרחיב
  Draft/Publish                  קיים       לא לבנות שוב
  Archived revisions             קיים       לא לבנות שוב
  Rollback                       קיים       לא לבנות שוב
  Preview token                  קיים       להרחיב
  Same renderer Preview/Live     קיים       לשמור
  Visual iframe editor           קיים       להרחיב
  Inline text edit               קיים       לשמור
  Section add/duplicate/remove   קיים       לשמור
  Move sections                  חלקי       להוסיף drag
  Phone/Desktop                  חלקי       להוסיף Tablet
  Media upload                   קיים       להוסיף Library/AI/default
  Section variants               חסר        לבנות
  Header variants                חסר        לבנות
  Footer variants                חסר        לבנות
  Product card variants          חסר        לבנות
  Collection variants            חסר        לבנות
  Product page variants          חסר        לבנות
  Default kit assets             לא ב-ZIP   להביא מ-kit-images
  focal/textSafe/alt             חסר        לבנות
  Real gallery screenshots       חסר        לבנות
  Preview kit before apply       חסר        לבנות
  Design-only apply              חסר        לבנות
  Undo/Redo                      חסר        לבנות
  20+ kits                       7 בלבד     engine ready + assets
  AI inspiration generator       חסר        לבנות אחרי registry
  Visual regression              חסר        להוסיף

------------------------------------------------------------------------

# APPENDIX B --- Flatsome lessons already translated to Dream

Flatsome Classic 3.20.11 נותח בנפרד.

נמצאו שם בין היתר:

-   85 registered builder element tags.
-   live canvas.
-   tree.
-   presets.
-   responsive options.
-   undo/redo.
-   reusable blocks.
-   header slots/presets.
-   multiple product layouts.
-   template library.
-   external Studio assets.

התרגום ל-Dream אינו להעתיק 85 elements.

התרגום הוא:

``` text
Existing Dream Section Engine
+ Variant Registry
+ Presets
+ Design Tokens
+ Preview
+ Reusable Patterns
+ Undo/Redo
```

וזה יושב מעל 2.61.0 הקיים.

------------------------------------------------------------------------

# APPENDIX C --- Asset rule

Default images:

**Presentation, not Business Data.**

לעולם לא:

``` text
kit image → catalog product image
kit image → POS
kit image → inventory
kit image → finance
```

כן:

``` text
kit image → theme presentation fallback
```

------------------------------------------------------------------------

# APPENDIX D --- Success Test

הצלחה:

1.  פותחים FollowMe.
2.  בוחרים Fashion Preview.
3.  לא נשמר כלום.
4.  רואים FollowMe בתוך Fashion.
5.  עוברים ל-Retail Preview.
6.  אותם מוצרים, אתר אחר לגמרי.
7.  עוברים ל-General Preview.
8.  שוב אותו עסק, עיצוב אחר.
9.  Apply Design.
10. pages/menus/products נשארים.
11. Publish.
12. האתר משתנה.
13. Rollback.
14. האתר חוזר.

אם זה עובד --- המנוע באמת Theme-driven.

------------------------------------------------------------------------

# APPENDIX E --- Current 7 Kit section compositions

``` text
bags:
hero → collections → products → imageText → steps → faq → contact

beauty:
hero → imageText → gallery → products → steps → faq → contact

fashion:
hero → products → collections → imageText → gallery → newsletter(hidden) → contact

furniture:
hero → collections → products → imageText → steps → faq → contact

general:
hero → products → collections → imageText → faq → contact

retail:
hero → collections → products → products → products → faq → contact

services:
hero → imageText → steps → products → faq → contact
```

הם כבר שונים ב-composition.

מה שחסר כדי שייראו שונים באמת הוא בעיקר:

-   variants.
-   images.
-   global design.
-   header/footer.
-   product/collection cards.

------------------------------------------------------------------------

# APPENDIX F --- Important implementation note: image alt today

ב-2.61.0:

-   Hero image משתמש `alt=""`.
-   ImageText משתמש `alt=""`.
-   Collection image משתמש `alt=""`.
-   Gallery משתמש caption כ-alt.

במשימה החדשה:

-   Kit manifest `alt` צריך לעבור ל-renderer.
-   User-uploaded image צריך alt editable או fallback סביר.
-   אם image מוגדרת decorative במפורש, אפשר `alt=""`.

------------------------------------------------------------------------

# APPENDIX G --- Important implementation note: current CSS/CSP

`storefront/src/lib/csp.ts`:

-   style-src self + nonce.
-   no inline style attributes.
-   img-src self + https + data.

לכן:

-   dynamic design → nonce style.
-   default `/kits/...` images מתאימות ל-CSP.
-   arbitrary CSS from JSON אסור.

------------------------------------------------------------------------

# APPENDIX H --- Final constraint

אל תנסה "להכניס Flatsome לתוך Dream".

Dream כבר מחזיק מנוע משלו.

המטרה היא להפוך את המנוע הקיים של Dream ל:

**קל כמו Wix, עשיר בתבניות כמו WordPress/Flatsome, אבל עם
Data/Commerce/CRM/Finance של Dream עצמו.**
