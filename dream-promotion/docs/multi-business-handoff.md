# משימה רב-עסקית (דשבורד-על) — מסמך העברה בין שיחות

עודכן: 2026-10-04, באמצע שלב 3. הענף: `claude/adoring-maxwell-ffx5gz` (לא מוזג ל-main; אין PR עדיין).
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
| 3 | 🟡 קוד בענף (commit d520dcf, 56/56 בדיקות, typecheck עובר; build עוד לא הורץ). migration `20261004002200_social_assets.sql`: **חלק A הוחל** (עמודות connection_id/status/missing_since, fill_business_id מדלג על social_accounts, view `social_accounts_public`, grants ברמת עמודה — הטוקן של שורת FollowMe של אביב (fd1e8c04…) עודכן לחדש ביותר). **חלק B הוחל חלקית**: `business_id` כבר nullable (✅). ה-`delete` נחסם (timeout — אישור ההרשאה של Supabase לא מגיע לסשן גם ב-Always), ולכן גם האינדקס והרישום טרם בוצעו. build עובר ✅. |

### חלק B שנשאר (השורה הראשונה כבר בוצעה; ה-delete נחסם ב-MCP — להריץ ב-SQL Editor של Supabase או לאשר בחלון)
```sql
alter table public.social_accounts alter column business_id drop not null;
delete from public.social_accounts
  where id = '02513166-42a1-4ebe-8f65-7e5ec8ac20cc' and external_id = '219952771882507';
create unique index if not exists social_accounts_asset_uq on public.social_accounts (provider, external_id);
insert into supabase_migrations.schema_migrations(version, name, statements)
  values ('20261004002200', 'social_assets_2200', array['-- applied via execute_sql; full text in supabase/migrations/20261004002200_social_assets.sql'])
  on conflict (version) do nothing;
```
אחרי זה: לבדוק (נשארה שורה אחת לעמוד FollowMe, business_id nullable, האינדקס קיים), להריץ build, לתת סיכום שלב 3, ורק באישור — PR ומיזוג.

## הערות טכניות חשובות
- **Supabase MCP**: פקודה עם `drop`/`delete` דרשה אישור ונתקעה (timeout 60s, בלי לבצע). המשתמש שינה את הרשאות הכלים ל-"Always" — אמור לעבוד בשיחה חדשה. `apply_migration` נתקע גם הוא; עבד: `execute_sql` + רישום ידני ב-`supabase_migrations.schema_migrations`. **אחרי כל כתיבה — לוודא בשאילתה שהיא באמת רצה.**
- **מילוי אוטומטי**: טריגר `a_fill_business_id` (BEFORE INSERT) על 23 הטבלאות ממלא business_id מ-`business_for_user(user_id)` (profiles.current_business_id אם מותר, אחרת החברות הראשונה). לכן האפליקציה הקיימת עובדת בלי שינוי. social_accounts מדולג (נכס חדש = לא משויך; השרת קובע business_id ב-TikTok).
- **נדחה לשלב 7** (כי הקוד עושה upsert לפי user_id): החלפת PK של brands/register_settings/booking_settings/timeclock_settings ל-business_id (כבר יש `unique (business_id)`); החלפת PK של `document_counters` (עדיין `(user_id, doc_type)`; קיים `unique (business_id, doc_type)` והטריגר סופר לפי business_id) והסרת `unique (user_id, doc_type, doc_number)` במסמכים (קיים `unique (business_id, doc_type, doc_number)`) — חובה לפני שאדמין מפיק מסמכים לשני עסקים.
- **מסמכים**: `documents_immutable` מאפשר רק שיוך business_id פעם אחת (null → ערך); תוכן ומחיקה נעולים (נבדק).
- **לתקן בשלב 4**: המדיניות `profiles_self` מאפשרת לכל משתמש לעדכן את כל השורה שלו — כולל `clip_quota`/`image_quota`. is_super_admin עצמו מוגן בטריגר.
- **אדמין בקוד**: `src/lib/server/admin-auth.ts` — admin = is_super_admin או ADMIN_EMAILS. עזרים: `src/lib/server/business.ts` (isSuperAdmin, canUseBusiness, businessIsActive, businessOf). סנכרון Meta טהור: `src/lib/server/meta-sync.ts`. מסך: `/admin` → לשונית "חיבורים ונכסים" (`src/features/admin/ConnectionsPanel.tsx`).
- README עדיין מזכיר `META_CONFIG_READ` — כבר לא בשימוש (חיבור אחד מלא).
- בדיקת מיגרציות מקומית: Postgres 16 מותקן (`/usr/lib/postgresql/16/bin`, להריץ כ-`su postgres`, תיקייה ב-/tmp).

## מזהים
- אביב: `d7af645e-57b1-447f-8fc9-3c131b84812f` · שגית: `6fe7ab27-7258-4f40-b67b-cbd403f900d1`
- עמוד FollowMe בפייסבוק: external_id `219952771882507` (השורה שנשארת: `fd1e8c04-39f4-43d9-b9bf-588f53d9491d`)
