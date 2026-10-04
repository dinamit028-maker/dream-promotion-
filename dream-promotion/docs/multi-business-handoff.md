# משימה רב-עסקית (דשבורד-על) — מסמך העברה בין שיחות

עודכן: 2026-10-04, סוף שלב 7 (ממתין לאישור + PR + הרצה ידנית של 2600). הענף: `claude/adoring-maxwell-ffx5gz`. מוזגו: 1–3 (PR #6), 4 (#7), 5 (#8), 6 (#9).
פרויקט Supabase: `dream-promotion`, ref `nljnbixgjsjbdgutryun`, תוכנית free (אין branches/גיבוי מובנה).

## כללי עבודה (מהמשתמש — אביב)
- **כל התקשורת בעברית**, כולל שאלות וחלונות בחירה (גם ב-CLAUDE.md).
- סיכום בעברית אחרי כל שלב, ולחכות לאישור לפני השלב הבא.
- אם משהו בקוד הקיים סותר את התכנית — לעצור ולשאול.
- לא למחוק שום דבר בלי להראות קודם מה יימחק ולקבל אישור בצ'אט.
- כל שינוי במסד = migration מסודר בתיקייה `supabase/migrations`. לא מוחקים עמודות. `user_id` נשאר בכל טבלה ("מי יצר").
- לפני PR: `npm run typecheck`, `npm test`, `npm run build` — חייבים לעבור. לוגיקה חדשה = בדיקה ב-`tests/`.

## התכנית המקורית (7 שלבים)
1. טבלאות: `businesses`, `business_members`, `profiles.is_super_admin`, `meta_connections`.
2. `business_id` ל-23 טבלאות (סבב שיווק + סבב כלי העסק), backfill, ואז NOT NULL. brands/register_settings/booking_settings/timeclock_settings — שורה אחת לעסק. מספור מסמכים לכל עסק.
3. `social_accounts`: `connection_id`, `status` active/missing, `unique (provider, external_id)`; חיבור Meta אחד (כל ההרשאות בבקשה אחת), upsert בלי מחיקה, נכס שלא חזר → missing + באנר "העמוד X נותק. בחיבור מחדש בחרו 'כל הדפים הנוכחיים והעתידיים'", נכס חדש → לא משויך; כפתור החיבור במסך האדמין; טוקנים לעולם לא לדפדפן.
4. RLS: פונקציות `is_super_admin()`, `business_is_active(bid)` (status='active' AND (paid_until IS NULL OR current_date <= paid_until + grace_days)), `can_access_business(bid)` (super admin, או חבר + עסק פעיל). מדיניות select/insert/update/delete לכל טבלה עם business_id. businesses/business_members — כתיבה רק ל-super admin. **owner לא יכול לשנות סטטוס, paid_until, נעילה, ולא להוסיף חברים — רק super admin.** עמודים ציבוריים (הזמנת תורים, מסמך עם share_token) — "השירות אינו זמין" כשהעסק נעול.
5. נעילה אוטומטית (דרך business_is_active, בלי cron); scheduler מדלג על עסק לא פעיל ומסמן cancelled עם סיבה "העסק נעול"; קריאות AI נחסמות לעסק נעול בצד שרת; פתיחה מחזירה הכל.
6. `/admin` דשבורד-על: כרטיס לכל עסק (שם, סטטוס פעיל/נעול/פג תוקף, בתוקף עד + אזהרה 7 ימים, נכסים + אזהרת missing, פוסטים/לידים/עלות החודש); פעולות: הארך חודש, תאריך ידני, נעל/פתח, הוסף עסק, שייך נכסים, כנס לעסק.
7. בורר עסקים בראש המסך (לאדמין-על); כל מסך מסונן לפי העסק הנבחר; בידוד מלא בין SaGabot ל-FollowMe.

בדיקות קבלה: (1) חיבור Meta אחד מציג הכל ומשייכים; (2) חיבור מחדש עם פחות עמודים → missing + התראה, בלי מחיקה; (3) בידוד בין העסקים; (4) paid_until של אתמול → נעול, פוסטים לא יוצאים, הזמנות "לא זמין", אדמין רואה הכל; (5) "הארך חודש" פותח מיד; (6) משתמש לא-אדמין לא משנה is_super_admin/businesses/business_members (לבדוק עם משתמש בדיקה); (7) טוקנים לא מגיעים לדפדפן.

## החלטות של המשתמש
- החשבון dinamit028@gmail.com (אביב) = **super admin** + owner של **FollowMe** (פולו מי אופנה בע"מ). כל הנתונים שלו שייכים ל-FollowMe; פרופיל המותג שונה מ-tasimla ל-FollowMe.
- sagitpr@gmail.com (שגית) = owner של **SaGabot**; רואה רק את SaGabot.
- gal.shahar4@gmail.com — חשבון ניסיוני — **נמחק** (כולל קבצי Storage). שורת ה-TikTok של אביב נשמרה.
- גיבוי: סכמה סגורה `backup_20261004` במסד (29 טבלאות + auth.users + רשימת storage.objects; לא הקבצים עצמם).
- כפילויות נכסים: למזג לשורה אחת המשויכת ל-FollowMe (העותק בגיבוי).

## מה בוצע (במסד החי + בקוד)
| שלב | מצב |
|---|---|
| 1 | ✅ migration `20261004001900_businesses.sql` הוחל. is_super_admin=true לאביב. טריגר `guard_super_admin` חוסם שינוי מה-API (נבדק חי). meta_connections סגורה לדפדפן. RLS פעיל בלי policies על הטבלאות החדשות (עד שלב 4). |
| 2 | ✅ `20261004002000_business_id.sql` + `20261004002100_business_id_required.sql` הוחלו. עסקים FollowMe (slug followme) ו-SaGabot (slug sagabot), חברים, backfill מלא, NOT NULL בכל הטבלאות חוץ מ-`ai_generations` (יומן עלויות, user_id nullable). |
| 3 | ✅ מוזג (PR #6). קוד בענף (commit d520dcf, 56/56 בדיקות, typecheck עובר; build עוד לא הורץ). migration `20261004002200_social_assets.sql`: **חלק A הוחל** (עמודות connection_id/status/missing_since, fill_business_id מדלג על social_accounts, view `social_accounts_public`, grants ברמת עמודה — הטוקן של שורת FollowMe של אביב (fd1e8c04…) עודכן לחדש ביותר). **חלק B הוחל** (ה-delete/אינדקס/רישום הורצו ידנית ע"י אביב ב-SQL Editor, כי פקודות מחיקה נחסמות ב-MCP; נבדק: שורה אחת לעמוד, business_id nullable, האינדקס קיים, migration רשום). build עובר ✅. |
| 4 | ✅ מוזג (PR #7). migration `20261004002300_business_rls.sql` (בלי drop): פונקציות is_super_admin / business_is_active (שעון ישראל) / can_access_business / accessible_business_ids; לכל 23 הטבלאות policy restrictive `<t>_business_gate` + permissive `<t>_business` (אותן פקודות כמו קודם; documents בלי delete; ai_generations/scheduled_posts בלי policy לקוח). המדיניות הישנות `user_id = auth.uid()` נשארו — ה-gate הוא שנועל. businesses/business_members: קריאה לחבר, כתיבה רק ל-super admin. הטריגר על profiles חוסם גם שינוי מכסות. דפים ציבוריים (book, doc, clock) → 403 `unavailable` "השירות אינו זמין". בדיקות: `tests/business-lock.test.ts` + בדיקה חיה בטרנזקציה שבוטלה. |
| 5 | ✅ מוזג (PR #8). migration `20261004002400_scheduled_cancel_reason.sql` (עמודה `cancel_reason`, הוחלה). `src/lib/server/business.ts`: `userLocked` (אדמין-על אף פעם; בלי עסק = נעול), `LOCKED`, `LOCKED_REASON`. הטיימר (`scheduler.ts`) מבטל פוסט של עסק נעול ומסמן כל יעד failed "העסק נעול" — לא חוזר לבד אחרי פתיחה. `meta-stories` מדלג על עסק נעול. 403 `business_locked` ב: accessDenied (ai, image, video, voice, transcribe), reel/render, meta/publish, tiktok/upload, schedule POST. בדיקות: `tests/business-lock-server.test.ts`. |
| 6 | ✅ מוזג (PR #9). `/api/admin/businesses` (מנהל-על בלבד): GET כרטיסים, POST עסק חדש (+בעלים לפי מייל — רק משתמש רשום), PATCH extend / paid_until / lock / unlock / enter (enter = profiles.current_business_id של האדמין). לוגיקה טהורה: `src/features/admin/business-state.ts` (bizView, extendMonth — מהמאוחר מבין היום ו-paid_until; null נשאר null). מסך: `BusinessesPanel.tsx`, לשונית ראשונה ב-/admin. באנר "העסק נעול" ב-AppShell דרך `/api/business/me`. "פוסטים החודש" = scheduled_posts done/partial (פרסום מיידי ל-Meta לא נרשם בשום טבלה). |
| 7 | ✅ קוד בענף, ממתין ל-PR. `20261004002500_current_business.sql` **הוחל** (פונקציה `current_business_id()`; ALTER POLICY ל-23 ה-gates: `business_id = current_business_id() and business_id in accessible_business_ids()`; exclusion חדש `appointments_business_no_overlap`). `20261004002600_business_keys.sql` **לא הוחל — אביב מריץ ב-SQL Editor** (PK של brands/register_settings/booking_settings/timeclock_settings → business_id, document_counters → (business_id, doc_type), הסרת unique (user_id, doc_type, doc_number) במסמכים; נבדק מקומית ב-PG16, idempotent). קוד: המסכים בלי סינון user_id (RLS מסנן לפי העסק הנוכחי); upsert של ההגדרות עם `onConflict: 'business_id'`; store שומר `businessId` ו-`hydratePlan` מונע העלאת נתונים של עסק אחר; בורר עסקים ב-AppShell (`/api/business/me` GET רשימה, POST מעבר); בשרת: דפים ציבוריים / טיימר / התראות לפי business_id של השורה, מסלולי משתמש לפי `workBusiness(userId)`. בדיקות: `tests/business-switch.test.ts` + בדיקה חיה בטרנזקציה שבוטלה. |

### חלק B של שלב 3 (בוצע — לתיעוד)
```sql
alter table public.social_accounts alter column business_id drop not null;
delete from public.social_accounts
  where id = '02513166-42a1-4ebe-8f65-7e5ec8ac20cc' and external_id = '219952771882507';
create unique index if not exists social_accounts_asset_uq on public.social_accounts (provider, external_id);
insert into supabase_migrations.schema_migrations(version, name, statements)
  values ('20261004002200', 'social_assets_2200', array['-- applied via execute_sql; full text in supabase/migrations/20261004002200_social_assets.sql'])
  on conflict (version) do nothing;
```
הבא: אביב מריץ את 20261004002600 ב-SQL Editor → אימות בשאילתה → אישור שלב 7 → PR → מיזוג → בדיקות הקבלה (1–7) מול האתר החי.

**חשוב לשיחות הבאות:** פקודות `delete`/`drop` דרך Supabase MCP נחסמות תמיד (timeout) — להכין SQL ולבקש מאביב להריץ ב-SQL Editor, ואז לוודא בשאילתה.

## הערות טכניות חשובות
- **Supabase MCP**: פקודה עם `drop`/`delete` דרשה אישור ונתקעה (timeout 60s, בלי לבצע). המשתמש שינה את הרשאות הכלים ל-"Always" — אמור לעבוד בשיחה חדשה. `apply_migration` נתקע גם הוא; עבד: `execute_sql` + רישום ידני ב-`supabase_migrations.schema_migrations`. **אחרי כל כתיבה — לוודא בשאילתה שהיא באמת רצה.**
- **מילוי אוטומטי**: טריגר `a_fill_business_id` (BEFORE INSERT) על 23 הטבלאות ממלא business_id מ-`business_for_user(user_id)` (profiles.current_business_id אם מותר, אחרת החברות הראשונה). לכן האפליקציה הקיימת עובדת בלי שינוי. social_accounts מדולג (נכס חדש = לא משויך; השרת קובע business_id ב-TikTok).
- **נדחה לשלב 7** (כי הקוד עושה upsert לפי user_id): החלפת PK של brands/register_settings/booking_settings/timeclock_settings ל-business_id (כבר יש `unique (business_id)`); החלפת PK של `document_counters` (עדיין `(user_id, doc_type)`; קיים `unique (business_id, doc_type)` והטריגר סופר לפי business_id) והסרת `unique (user_id, doc_type, doc_number)` במסמכים (קיים `unique (business_id, doc_type, doc_number)`) — חובה לפני שאדמין מפיק מסמכים לשני עסקים.
- **מסמכים**: `documents_immutable` מאפשר רק שיוך business_id פעם אחת (null → ערך); תוכן ומחיקה נעולים (נבדק).
- ✅ תוקן בשלב 4: מכסות ב-profiles מוגנות בטריגר `profiles_guard_super_admin`.
- **פתוח**: משתמש חדש שנרשם בלי להיות חבר בעסק — אין לו business_id, כך שלא יוכל לשמור כלום (NOT NULL + RLS). עסקים וחברים נוספים ע"י האדמין (שלב 6).
- ✅ שלב 6: באנר "העסק נעול" לבעלים.
- ✅ שלב 7: מסכים לפי העסק הנוכחי. **עד שירוץ 2600**: אדמין לא יכול לשמור הגדרות (מותג/קופה/תורים/נוכחות) או להפיק מסמכים בעסק שני.
- הערה: upsert של content/media/leads מעדכן גם user_id לעורך האחרון ("מי יצר" יכול להתחלף כשאדמין עורך שורה של בעלים).
- **אדמין בקוד**: `src/lib/server/admin-auth.ts` — admin = is_super_admin או ADMIN_EMAILS. עזרים: `src/lib/server/business.ts` (isSuperAdmin, canUseBusiness, businessIsActive, businessOf). סנכרון Meta טהור: `src/lib/server/meta-sync.ts`. מסך: `/admin` → לשונית "חיבורים ונכסים" (`src/features/admin/ConnectionsPanel.tsx`).
- README עדיין מזכיר `META_CONFIG_READ` — כבר לא בשימוש (חיבור אחד מלא).
- בדיקת מיגרציות מקומית: Postgres 16 מותקן (`/usr/lib/postgresql/16/bin`, להריץ כ-`su postgres`, תיקייה ב-/tmp).

## מזהים
- אביב: `d7af645e-57b1-447f-8fc9-3c131b84812f` · שגית: `6fe7ab27-7258-4f40-b67b-cbd403f900d1`
- עמוד FollowMe בפייסבוק: external_id `219952771882507` (השורה שנשארת: `fd1e8c04-39f4-43d9-b9bf-588f53d9491d`)
