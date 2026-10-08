# Dream Builder — הנדסת עורך Drag & Drop

מסמך זה מחליף את סעיף "Visual Builder" ב-`CLAUDE_START_HERE_PHASE1.md` ומפרט את PR-3.
הוא נכתב אחרי חקירה של שני מקורות:

1. **הקוד של Dream ב-`main`** (commit `13597f3`, גרסה 2.61.0): `storefront/src/components/EditBridge.tsx`,
   `storefront/src/lib/edit.ts`, `storefront/src/lib/preview.ts`, `storefront/src/lib/csp.ts`,
   `storefront/src/components/sections/index.tsx`, `dream-promotion/src/features/store/visual-edit.ts`,
   `StoreVisual.tsx`, `theme-fields.ts`.
2. **הארכיטקטורה של UX Builder ב-Flatsome 3.20.11** — כהשראה לרעיונות בלבד.

## 0. כללי רישוי — חובה

Flatsome בנוי משני חלקים: קוד PHP ברישיון GPL, ו-CSS, תמונות, עיצוב ו-thumbnails ברישיון מסחרי.
**אסור להעתיק שום דבר מ-Flatsome**: לא קוד, לא CSS, לא תבניות HTML, לא תמונות, לא thumbnails, לא שמות presets
ולא טקסטים. לקחנו ממנו רק עקרונות ארכיטקטורה, שכתובים כאן במילים שלנו ומיושמים בקוד מקורי ב-TypeScript.

## 1. מה קיים היום ב-Dream (לא לבנות מחדש)

| רכיב | איפה | מה הוא עושה |
|---|---|---|
| Draft / Publish / גרסאות | `saveDraft`, `publishVersion` | כל שינוי הוא טיוטה; פרסום יוצר גרסה; rollback קיים |
| מסגרת עריכה | `?edit=<token>` + `EditBridge` | האתר האמיתי בתוך iframe, חתום ב-HMAC, `frame-ancestors` רק ל-dashboard |
| פרוטוקול הודעות | `EditMessage` (שני הצדדים) | ready / section / text / field / image / open / navigate, עם בדיקת origin ובדיקת שדות |
| עריכת טקסט במקום | `data-edit-inline` + `applyText` | contenteditable, עם אורך מקסימלי לפי השדה |
| סכמת סקשנים | `SECTION_DEFS` ב-`theme-fields.ts` | 10 סוגים, שדות מסוג text/longtext/link/image/number/side/collection, רשימות |
| פעולות מבנה | `addSection` / `duplicateSection` / `removeSection` / `moveSection` | עד 20 סקשנים, הזזה למעלה ולמטה |
| Renderer | `SectionView` (Server Components) | אותו renderer לקונה ולעורך |

**הפער מול עורך Drag & Drop אמיתי:**

- **כל שינוי מבני טוען מחדש את כל ה-iframe** (`refreshFrame`). זה איטי, ובטלפון זה מורגש מאוד.
- אין גרירה, רק כפתורי למעלה ולמטה.
- אין ערכים נפרדים למובייל, לטאבלט ולדסקטופ.
- אין ספריית presets (פריסות מוכנות) לכל סוג סקשן.
- אין undo / redo.
- אין בלוקים בתוך סקשן: אי אפשר לגרור כפתור או תמונה בתוך הסקשן.
- סוגי השדות מוגבלים: אין select, toggle, slider, צבע, ריווח, ואין קבוצות או תנאים.

## 2. עקרונות שלקחנו מ-Flatsome, ואיך הם מיושמים אצלנו

| עיקרון | ב-Flatsome | אצלנו |
|---|---|---|
| Registry של אלמנטים | כל אלמנט נרשם עם type, category, options, presets, כללי קינון | `ELEMENTS` אחד, טיפוסי, משותף לשני האפליקציות (סעיף 3) |
| סכמת אפשרויות | options עם group, conditions, responsive, min/max/step/unit | אותו רעיון, אבל conditions **הצהרתיים** (`{ field, eq }`) ולא מחרוזת קוד |
| Presets | כל אלמנט מגיע עם פריסות מוכנות עם תמונה ממוזערת | presets כ-JSON, וה-thumbnails מצולמים מה-renderer האמיתי |
| כללי קינון | `allow` / `require` (למשל col רק בתוך row) | `accepts` / `parent` ב-registry, נבדקים בשרת ובלקוח |
| Breakpoints | sm=550, md=850, lg=1000; ערך עם סיומת `__sm` / `__md` | `base` (מובייל) + `md` + `lg` – mobile-first, בתוך אובייקט `responsive` |
| עדכון חי | תבנית Angular כפולה בתוך ה-iframe + AJAX לרינדור אלמנט בודד בשרת | **בלי תבנית כפולה**: CSS חי דרך CSSOM + רינדור סקשן בודד בשרת (סעיף 5) |
| שמירה | המבנה נשמר כ-shortcodes בתוך post_content | JSON מאומת בטיוטה הקיימת – בלי shortcodes ובלי HTML חופשי |

**מה לא לוקחים, ולמה:**

- **תבניות כפולות לעורך** (ב-Flatsome יש קובץ `.html` נפרד לעורך לכל אלמנט). זה מקור קבוע לאי-התאמות בין העורך לאתר. אצלנו יש renderer אחד בלבד.
- **קינון חופשי בלי הגבלה** (section → row → col → row → col...). זה כוח לבוני אתרים מקצועיים, אבל משתמש רגיל "שובר" איתו את העיצוב. אצלנו העומק המקסימלי הוא 3 (סעיף 3.2).
- **ערכי פיקסלים חופשיים** (padding="59px"). אצלנו רק סולמות של ה-theme, כדי שכל שילוב ייראה טוב.
- **conditions כמחרוזת JS** (`'sticky === "true"'`) – לא בטוח ולא ניתן לבדיקה.

## 3. מודל הנתונים

### 3.1 הרחבה של `Section` הקיים – תואמת לאחור

```ts
interface Section {
  id: string;
  type: SectionType;
  hidden: boolean;
  settings: Record<string, unknown>;          // כמו היום
  preset?: string;                             // חדש: איזו פריסה (למשל 'split-start')
  style?: StyleValues;                         // חדש: עיצוב מהסולמות
  responsive?: { md?: Partial<StyleValues>; lg?: Partial<StyleValues> }; // חדש
  hiddenOn?: Array<'base' | 'md' | 'lg'>;       // חדש: הסתרה לפי מכשיר
  columns?: Column[];                          // חדש, רק לסקשנים עם accepts
}
interface Column { id: string; span: Span; responsive?: { md?: { span: Span }; lg?: { span: Span } }; blocks: Block[] }
interface Block  { id: string; type: BlockType; settings: Record<string, unknown>; style?: StyleValues; responsive?: {...}; hiddenOn?: [...] }
type Span = 3 | 4 | 6 | 8 | 9 | 12;           // רק חלוקות שנראות טוב
```

**כלל תאימות:** כל טיוטה קיימת, בלי השדות החדשים, נטענת ומוצגת בדיוק כמו היום. השדות החדשים אופציונליים, והמיגרציה היא "אם חסר – ערך ברירת מחדל של ה-preset".

### 3.2 עומק מקסימלי: 3

`Section → Column → Block`. לא row בתוך column, ולא section בתוך section.

- **סקשנים "סגורים"** (`products`, `collections`, `faq`, `steps`, `contact`) לא מקבלים columns. הם נשלטים רק דרך settings ו-preset.
- **סקשנים "פתוחים"** (`hero`, `imageText`, `text`, וסוג חדש `custom`) מקבלים columns ו-blocks.

### 3.3 `StyleValues` – רק סולמות

```ts
interface StyleValues {
  padY?: 'none' | 's' | 'm' | 'l' | 'xl';
  align?: 'start' | 'center' | 'end';
  surface?: 'background' | 'surface' | 'primary' | 'accent' | 'accentSoft' | 'dark';  // טוקנים של ה-theme בלבד
  width?: 'narrow' | 'normal' | 'wide' | 'full';
  textSize?: 's' | 'm' | 'l' | 'xl';
  radius?: 'theme' | 'none';
  minHeight?: 'auto' | 'half' | 'tall' | 'screen';
}
```

אין צבע חופשי ואין פיקסלים. הצבעים עצמם משתנים רק ב"עיצוב כללי" (ה-theme).

## 4. ה-Registry

קובץ אחד: `shared/builder/registry.ts`. ייבוא מהעתק זהה בשני האפליקציות, או package משותף אם המבנה מאפשר. בדיקה אוטומטית מוודאת ששני ההעתקים זהים, כמו שכבר נעשה עם preview token.

```ts
interface ElementDef {
  type: string;
  kind: 'section' | 'block';
  label: string;                         // עברית
  category: 'מבנה' | 'תוכן' | 'מדיה' | 'מסחר' | 'יצירת קשר';
  icon: string;                          // אייקון מקורי
  accepts?: BlockType[];                 // לסקשן פתוח
  parent?: SectionType[];                // לבלוק: באילו סקשנים מותר
  maxPerParent?: number;
  fields: FieldDef[];                    // הסכמה הקיימת + סוגים חדשים
  styles: Array<keyof StyleValues>;      // אילו בקרות עיצוב מוצגות
  presets: PresetDef[];                  // לפחות אחד
  live: 'css' | 'render';                // איך מתעדכן בתצוגה (סעיף 5)
}
type FieldKind = 'text' | 'longtext' | 'link' | 'image' | 'number' | 'side' | 'collection'   // קיימים
  | 'select' | 'toggle' | 'scale' | 'icon';                                                   // חדשים
interface FieldDef { key; label; kind; max?; hint?; options?: {value; label}[];
  group?: 'תוכן' | 'עיצוב' | 'מתקדם';
  when?: { field: string; eq?: unknown; ne?: unknown };   // תנאי הצהרתי
  responsive?: boolean }
```

**בלוקים בשלב הראשון:** `heading`, `paragraph`, `button`, `image`, `badge`, `spacer`, `icon-list`, `product-card`.

**Presets:** הפריסות מטבלת העיצוב (`PHASE1_DESIGN_MATRIX.md`) הן ה-presets הראשונים. לדוגמה, ל-hero: `full-image`, `split-start`, `split-end`, `centered`, `editorial`, `slider`. כל Kit מצביע על preset ברירת המחדל שלו, ולכן הוספת Kit חדש = JSON בלבד.

**ולידציה:** אותה פונקציה (`validateDraft`) רצה בלקוח לפני שליחה ובשרת לפני `saveDraft`. כל מה שלא מוכר נזרק בשקט, כמו `readSection` היום.

## 5. עדכון חי בלי טעינה מחדש

זה השינוי שהכי ישפיע על התחושה. יש שלושה מסלולים, לפי השדה `live` ב-registry:

**א. טקסט** – כבר קיים: contenteditable בתוך ה-iframe.

**ב. עיצוב (`live: 'css'`)** – ריווח, יישור, רקע, גודל טקסט, הסתרה לפי מכשיר.
ה-dashboard שולח `{ type: 'style', target, values }`, וה-EditBridge מעדכן classes ומשתני CSS על האלמנט דרך CSSOM (`el.style.setProperty('--sec-pad', ...)`).
מדיניות ה-CSP הנוכחית (`style-src 'self' 'nonce-…'`) חוסמת `style=""` ב-HTML ותגיות `<style>` בלי nonce, **אבל לא חוסמת שינוי דרך CSSOM מתוך סקריפט מורשה** – ולכן אין צורך לשנות את ה-CSP.
התגובה מיידית, בלי רשת. השמירה לטיוטה רצה ברקע עם debounce.

**ג. מבנה ותוכן מהשרת (`live: 'render'`)** – preset, הוספת בלוק, החלפת קולקציה, מספר מוצרים.
1. ה-dashboard שומר טיוטה (קיים).
2. ה-dashboard שולח `{ type: 'rerender', sections: [id] }`.
3. ה-EditBridge מבקש מהשרת `GET <path>?edit=<token>&only=<id>&rev=<n>`. זה route שמרנדר את **אותו** `SectionView` מהטיוטה, ומחזיר רק את הסקשן הזה.
4. ה-EditBridge מחליף רק את הצומת הזה ב-DOM, משמר את הגלילה, ומסמן מחדש את הבחירה.

`rev` מונע מצב שבו תשובה ישנה מגיעה אחרי תשובה חדשה. אם אין תשובה תוך 4 שניות, עושים fallback ל-`refreshFrame` הקיים.

**הזזה, מחיקה, שכפול והסתרה** של סקשן שלם: ה-EditBridge מזיז או מסיר את הצומת ב-DOM מיד (אופטימי), והשמירה רצה ברקע. שכפול ממתין לרינדור (מסלול ג).

**הודעות חדשות לפרוטוקול** (בשני הצדדים, עם בדיקת שדות כמו ב-`readMessage`):

```ts
// dashboard → page
| { type: 'style'; target: string; values: Partial<StyleValues>; bp: 'base' | 'md' | 'lg' }
| { type: 'rerender'; sections: string[]; rev: number }
| { type: 'move'; id: string; to: number }             // סקשן
| { type: 'moveBlock'; id: string; column: string; to: number }
| { type: 'remove' | 'hide'; id: string }
| { type: 'select'; id: string }                        // קיים
| { type: 'device'; bp: 'base' | 'md' | 'lg' }
// page → dashboard
| { type: 'drop'; id: string; to: number }               // גרירת סקשן בתוך הדף
| { type: 'dropBlock'; id: string; column: string; to: number }
| { type: 'insert'; at: number }                         // לחיצה על "+" בין סקשנים
| { type: 'block'; section: string; id: string }        // בחירת בלוק
```

## 6. Drag & Drop

**איפה גוררים:**
1. **בתוך הדף** (ב-iframe): ידית גרירה מופיעה על הסקשן או הבלוק הנבחר. קו אינדיקציה מראה איפה זה ינחת.
2. **בעץ השכבות** (בפאנל): רשימה מקוננת Section → Column → Block, שאפשר לגרור בה.

**מימוש:**
- בפאנל: `@dnd-kit/core` + `@dnd-kit/sortable` (רישיון MIT).
- ב-iframe: Pointer Events נייטיב, בלי ספרייה. ה-iframe רק מחשב את אינדקס היעד ושולח `drop` / `dropBlock`. ה-dashboard מחליט, מאמת מול כללי ה-registry, ומחזיר `move` או דוחה.
- **ה-dashboard הוא מקור האמת היחיד למבנה.** ה-iframe אף פעם לא משנה את הטיוטה בעצמו.

**טלפון – דרישת חובה:**
- גרירה מתחילה בלחיצה ארוכה (400ms) על הידית, עם רטט קצר אם הדפדפן תומך.
- גלילה אוטומטית ליד קצות המסך בזמן גרירה.
- הפאנל הוא bottom sheet בשלושה גבהים, וה-iframe ממלא את המסך מעליו.
- כפתורי "למעלה" ו"למטה" נשארים בכל מקרה, כחלופה נגישה.

**נגישות:** אפשר להזיז כל פריט גם עם מקלדת – רווח כדי להרים, חצים כדי להזיז, רווח כדי להניח, Escape כדי לבטל – עם הודעת `aria-live` בעברית ("הסקשן הוזז למקום 3 מתוך 7").

**כללים:**
- אי אפשר לגרור בלוק לסקשן שלא מקבל אותו – הקו לא מופיע, והסמן מראה "אסור".
- `products` ו-`collections` לא ניתנים למחיקה אם זה הסקשן האחרון שמציג מוצרים – מוצגת אזהרה.
- `MAX_SECTIONS = 20` נשאר. מקסימום 4 עמודות לסקשן ו-12 בלוקים לעמודה.

## 7. מכשירים: מובייל, טאבלט, דסקטופ

- מתג בראש העורך: מובייל 390 / טאבלט 820 / דסקטופ 1280. ה-iframe משנה רוחב, וב-dashboard בטלפון עושים scale.
- **עריכת עיצוב חלה על המכשיר הנוכחי.** מובייל הוא הבסיס, ושאר המכשירים יורשים ממנו.
- ליד כל בקרה שיש לה ערך שונה במכשיר הנוכחי מוצגת נקודה, עם כפתור "חזרה לערך הבסיס".
- עמודות: `span` לכל מכשיר. ברירת המחדל: מובייל = 12 (אחת מתחת לשנייה).
- `hiddenOn`: "הסתר במובייל" / "הסתר בדסקטופ" – תמיד עם אינדיקציה ברורה בעץ השכבות.

## 8. Undo / Redo

- היסטוריה בצד הלקוח בלבד: מחסנית של טיוטות (הטיוטה כבר immutable), עם `zustand` שכבר קיים בפרויקט.
- עד 50 צעדים. טקסט שמוקלד מתאחד לצעד אחד כל 800ms.
- Ctrl/Cmd+Z, Ctrl/Cmd+Shift+Z, ושני כפתורים גדולים בטלפון.
- Undo שומר את הטיוטה כרגיל. **אין מערכת גרסאות מקבילה** – גרסאות ה-publish וה-rollback נשארות כמו שהן.

## 9. "הוסף" – ספריית סקשנים ובלוקים

- כפתור "+" בין כל שני סקשנים בתוך הדף, ובראש הפאנל.
- גלריה לפי קטגוריות. כל פריט מציג thumbnail שצולם מה-renderer האמיתי, בצבעי ה-Kit הנוכחי.
- בחירה מכניסה את ה-preset עם תוכן התחלתי בעברית מתוך ה-Kit, ותמונות ברירת מחדל מ-`kit-images`. **בלי lorem ipsum ובלי מוצרי דמה.**

## 10. עיצוב כללי (Global)

פאנל אחד: צבעים (8 הטוקנים הקיימים), גופן (4 הקיימים), עיגול פינות, סגנון כפתורים, ריווח כללי (צפוף / רגיל / מרווח).
השינוי חל על כל האתר מיד, דרך משתני CSS (מסלול ב), ונשמר בטיוטה.

## 11. סדר עבודה ל-PR-3 – שלושה PRs קטנים

**PR-3a – תשתית ותחושה**
- `registry.ts` משותף + `validateDraft`, עם תאימות לאחור.
- מסלולי עדכון חי ב' וג' + `only=<id>`.
- גרירת סקשנים בדף ובעץ השכבות, כולל טלפון ומקלדת.
- Undo / Redo.
- בדיקות: כל הטיוטות הקיימות של 7 ה-Kits נטענות זהה (snapshot), גרירה ב-e2e, אף שינוי לא מגיע לאתר החי לפני פרסום.

**PR-3b – Presets ומכשירים**
- presets לכל סוג סקשן לפי טבלת העיצוב.
- מתג מכשירים, `responsive`, `hiddenOn`.
- פאנל עיצוב כללי.
- גלריית "הוסף" עם thumbnails אמיתיים.

**PR-3c – בלוקים**
- `columns` + `blocks` בסקשנים הפתוחים, וסקשן `custom`.
- גרירת בלוקים בין עמודות.
- בדיקות קינון לפי `accepts` / `parent`, בשרת ובלקוח.

## 12. Definition of Done ל-PR-3

- משתמש בטלפון מזיז סקשן בגרירה, משנה ריווח ורואה את התוצאה מיד, עושה Undo – והכל בלי טעינה מחדש של הדף.
- 7 ה-Kits נראים זהה לפני ואחרי השינוי (השוואת screenshots).
- שום ערך שאינו בסולם לא נשמר, גם אם נשלח ישירות ל-API.
- ה-CSP לא הוחלש.
- הקונים לא רואים שום attribute של עריכה (כמו היום).
- Draft / Publish / Rollback עובדים כמו קודם.
- `commerce_live` לא נגעו בו.
- אין merge ואין deploy בלי אישור.
