-- FollowMe — שלב א: ניקוי נתוני הטסט (הוכן 17.10.2026, לפי הדוח ב-docs/FOLLOWME_STAGE_A_HE.md).
-- רץ רק ב-SQL Editor של Supabase, ורק אחרי "מאשר" (יש בו DELETE, ולכן לא דרך ה-MCP). מדביקים הכול ולוחצים Run — פעם אחת.
-- טרנזקציה אחת: אם משהו לא כמו בדוח (מספר שורות, עובד עם מכירה, עסק אחר שהשתנה) — שום דבר לא נמחק, ומופיעה שגיאה שאומרת מה.
-- בסוף מוצגת טבלה של לפני / אחרי לכל טבלה שיש בה נתונים של FollowMe.
--
-- נמחק — רק שורות של FollowMe:
--   תוכן שיווקי (47), תזמוני פרסום (3), רשומות של פוסטים לטיקטוק (14 — רק ב-Dream, לא בטיקטוק), ספריית המדיה (130 שורות;
--   הקבצים עצמם נמחקים בנפרד דרך Storage — ראו המסמך), מוצרים (4, עם 3 וריאנטים, 2 תמונות ואפשרות אחת), קטגוריות (3),
--   משמרות בשעון הנוכחות (7), 5 עובדי בדיקה, וסוג הטיפול "בדיקה".
-- לא נמחק:
--   העסק, המשתמשים והחברים, החיבורים (Instagram, Facebook, TikTok וסנכרון הלידים), הגדרות העסק, הסניף, הקופה, המותג,
--   האתר (החנות, העמודים, התפריטים וגרסאות העיצוב — יוחלפו בשלב ג), העובדים שגית פרץ, גל שחר ואביב,
--   יומן העלויות של ה-AI, וכל מה שקשור למסמכים הכספיים: 22 המסמכים, התשלומים, יומן הכספים, המכירות בקופה, ההוצאות,
--   ימי הקופה, מוני המספור, ואיש הקשר שעליו הופק מסמך 16 עם הפעולות שלו.
--   מסמך שהופק לא נמחק ולא משתנה (גם המסד חוסם זאת) — מבטלים אותו בחשבונית זיכוי, מתוך Dream.

begin isolation level repeatable read;

-- לפני: כמה שורות יש בכל טבלה — של FollowMe ושל כל שאר העסקים
create temp table fm_report as
select c.table_name::text as tbl,
  (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I where business_id = %L', c.table_name, 'bdb5d123-5c67-4c3b-a819-d76904429ce9'), false, true, '')))[1]::text::bigint as followme_before,
  (xpath('/row/n/text()', query_to_xml(format('select count(*) as n from public.%I where business_id is distinct from %L', c.table_name, 'bdb5d123-5c67-4c3b-a819-d76904429ce9'), false, true, '')))[1]::text::bigint as others_before,
  null::bigint as followme_after,
  null::bigint as others_after
from information_schema.columns c
join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
where c.table_schema = 'public' and c.column_name = 'business_id';

do $$
declare
  fm constant uuid := 'bdb5d123-5c67-4c3b-a819-d76904429ce9';
  -- 5 עובדי הבדיקה, לפי מזהה (לא לפי שם). נשארים: שגית פרץ, גל שחר, ואביב (שיש לו מכירות בקופה)
  test_staff constant uuid[] := array[
    '36385ee7-5846-4129-a84e-a9e6daba3f05', 'b8f9fd41-4c57-47dd-aee6-6b4ef0aea951', 'db64fd23-c410-4551-b48a-c1d720d7bdd9',
    '0bb82023-1610-4d79-8aba-2a1d858735de', '67feeb0c-241b-4e8c-ad70-01197e894b1a']::uuid[];
  test_treatment constant uuid := 'cc16ba5d-2fda-49d4-b764-4abcd046cc1a';
  -- מה שנמחק, ומה צריך להישאר בו אחרי
  emptied constant text[] := array['scheduled_posts', 'social_posts', 'content', 'media', 'catalog_items', 'catalog_variants',
    'catalog_media', 'catalog_options', 'catalog_collections', 'catalog_collection_items', 'time_entries', 'treatment_types'];
  -- טבלאות שהפקודות כאן נוגעות בהן (גם דרך מפתחות) — בהן בודקים שאף עסק אחר לא השתנה
  touched constant text[] := emptied || array['employees', 'ai_generations', 'stock_movements', 'stock_levels', 'stock_reservations',
    'price_list_items', 'order_lines', 'client_packages'];
  r record; n bigint; m bigint;
begin
  if not exists (select 1 from public.businesses where id = fm and name = 'FollowMe') then
    raise exception 'העסק FollowMe לא נמצא. לא נמחק כלום.';
  end if;

  -- 1) בדיוק מה שהיה בדוח של 17.10.2026. מספר אחר = משהו השתנה מאז (או שהניקוי כבר רץ) — עוצרים, ושום דבר לא נמחק.
  for r in select * from (values
      ('scheduled_posts', 3), ('social_posts', 14), ('content', 47), ('media', 130), ('catalog_items', 4), ('catalog_variants', 3),
      ('catalog_media', 2), ('catalog_options', 1), ('catalog_collections', 3), ('catalog_collection_items', 0),
      ('time_entries', 7), ('employees', 8), ('treatment_types', 1)) as e(tbl, expected)
  loop
    execute format('select count(*) from public.%I where business_id = $1', r.tbl) into n using fm;
    if n <> r.expected then
      raise exception '%: יש % שורות של FollowMe, ובדוח היו %. משהו השתנה מאז הדוח (או שהניקוי כבר רץ). לא נמחק כלום.', r.tbl, n, r.expected;
    end if;
  end loop;
  if (select count(*) from public.employees where business_id = fm and id = any (test_staff)) <> 5 then
    raise exception 'עובדי הבדיקה לא נמצאו כמו בדוח. לא נמחק כלום.';
  end if;
  if exists (select 1 from public.sales where employee_id = any (test_staff)) then
    raise exception 'לאחד מעובדי הבדיקה יש מכירה בקופה (מכירה לא משתנה). לא נמחק כלום.';
  end if;
  if not exists (select 1 from public.treatment_types where id = test_treatment and business_id = fm and name = 'בדיקה') then
    raise exception 'סוג הטיפול "בדיקה" לא נמצא. לא נמחק כלום.';
  end if;

  -- 2) המחיקה — רק שורות של FollowMe
  delete from public.scheduled_posts where business_id = fm;
  delete from public.social_posts where business_id = fm;
  delete from public.content where business_id = fm;        -- יומן ה-AI נשאר; הקישור שלו לתוכן מתאפס
  delete from public.media where business_id = fm;          -- השורות; הקבצים עצמם — דרך Storage
  delete from public.catalog_items where business_id = fm;  -- הוריאנטים, התמונות והאפשרויות שלהם נמחקים איתם
  delete from public.catalog_collections where business_id = fm;
  delete from public.time_entries where business_id = fm;
  delete from public.employees where business_id = fm and id = any (test_staff);
  delete from public.treatment_types where business_id = fm and id = test_treatment;

  -- 3) אחרי: מה שנמחק — אפס; עובדים — 3; כל שאר הטבלאות של FollowMe — בדיוק כמו לפני; ואף עסק אחר לא השתנה
  for r in select * from fm_report loop
    execute format('select count(*) from public.%I where business_id = $1', r.tbl) into n using fm;
    execute format('select count(*) from public.%I where business_id is distinct from $1', r.tbl) into m using fm;
    update fm_report set followme_after = n, others_after = m where tbl = r.tbl;
    if r.tbl = any (emptied) and n <> 0 then
      raise exception '%: נשארו % שורות של FollowMe. בוטל — לא נמחק כלום.', r.tbl, n;
    elsif r.tbl = 'employees' and n <> 3 then
      raise exception 'employees: נשארו % עובדים במקום 3. בוטל — לא נמחק כלום.', n;
    elsif not (r.tbl = any (emptied)) and r.tbl <> 'employees' and n <> r.followme_before then
      raise exception '%: % שורות של FollowMe לפני ו-% אחרי — הטבלה הזו לא הייתה אמורה להשתנות. בוטל — לא נמחק כלום.', r.tbl, r.followme_before, n;
    end if;
    if r.tbl = any (touched) and m <> r.others_before then
      raise exception '%: השתנה מספר השורות של עסק אחר (% → %). בוטל — לא נמחק כלום.', r.tbl, r.others_before, m;
    end if;
  end loop;
end $$;

commit;

-- הדוח: לפני / אחרי, לכל טבלה שהיו בה נתונים של FollowMe
select tbl as "טבלה",
  followme_before as "FollowMe לפני", followme_after as "FollowMe אחרי",
  others_before as "עסקים אחרים לפני", others_after as "עסקים אחרים אחרי"
from fm_report
where followme_before > 0 or followme_after > 0
order by (followme_before - followme_after) desc, tbl;
