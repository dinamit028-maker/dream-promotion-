-- FollowMe — שלב א: ניקוי היומן ו-4 הפריטים (הוכן 17.10.2026, לפי docs/FOLLOWME_STAGE_A_HE.md).
-- רץ רק ב-SQL Editor של Supabase, ורק אחרי "מאשר" (יש בו DELETE, ולכן לא דרך ה-MCP). מדביקים הכול ולוחצים Run — פעם אחת.
-- טרנזקציה אחת: אם משהו לא כמו בדוח — שום דבר לא משתנה, ומופיעה שגיאה שאומרת מה. בסוף — טבלה של לפני / אחרי.
--
-- מה משתנה — רק ב-FollowMe:
--   1. יומן התוכן: 33 פריטים שתוזמנו ולא עלו (32 בעבר, 1 בעתיד) יוצאים מהיומן — בדיוק כמו "הוצאה מהיומן" באפליקציה:
--      התאריך והשעה נמחקים והסטטוס חוזר לטיוטה. התוכן עצמו (הרילס, הסרטון, הכיתוב) נשאר בספרייה.
--      2 הפריטים שעלו נשארים ביומן כמו שהם.
--   2. תור הפרסום: התזמון היחיד שנכשל ולא עלה (1.10) נמחק. שני התזמונים שעלו (3.10, 8.10) נשארים.
--   3. 4 הפריטים שהוקמו בקטלוג נמחקים (עם 3 הוריאנטים, 2 התמונות והאפשרות שלהם).
-- כל השאר לא משתנה: מדיה, סרטונים, רילסים, טיוטות, הפוסטים לטיקטוק, קבלות, חשבוניות, תשלומים, מכירות, הוצאות,
-- עובדים, משמרות, לידים, קטגוריות, האתר, החיבורים, ההגדרות — ואף עסק אחר.

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
  -- הטבלאות שמשתנות, ומה צריך להיות בהן אחרי
  changed constant text[] := array['scheduled_posts', 'catalog_items', 'catalog_variants', 'catalog_media', 'catalog_options'];
  -- טבלאות שהפקודות כאן נוגעות בהן (גם דרך מפתחות) — בהן בודקים שאף עסק אחר לא השתנה
  touched constant text[] := changed || array['content', 'catalog_collection_items', 'stock_movements', 'stock_levels',
    'stock_reservations', 'price_list_items', 'order_lines', 'client_packages'];
  published_before jsonb; r record; n bigint; m bigint;
begin
  if not exists (select 1 from public.businesses where id = fm and name = 'FollowMe') then
    raise exception 'העסק FollowMe לא נמצא. לא השתנה כלום.';
  end if;

  -- 1) בדיוק מה שהיה בדוח של 17.10.2026. מספר אחר = משהו השתנה מאז (או שהסקריפט כבר רץ) — עוצרים.
  for r in select * from (values
      ('content', 'scheduled', 33), ('content', 'published', 2), ('content', 'draft', 12),
      ('scheduled_posts', 'failed', 1), ('scheduled_posts', 'partial', 1), ('scheduled_posts', 'done', 1)) as e(tbl, status, expected)
  loop
    execute format('select count(*) from public.%I where business_id = $1 and status = $2', r.tbl) into n using fm, r.status;
    if n <> r.expected then
      raise exception '%: יש % שורות במצב %, ובדוח היו %. משהו השתנה מאז הדוח (או שהסקריפט כבר רץ). לא השתנה כלום.', r.tbl, n, r.status, r.expected;
    end if;
  end loop;
  for r in select * from (values ('content', 47), ('scheduled_posts', 3), ('catalog_items', 4), ('catalog_variants', 3),
      ('catalog_media', 2), ('catalog_options', 1), ('catalog_collection_items', 0)) as e(tbl, expected)
  loop
    execute format('select count(*) from public.%I where business_id = $1', r.tbl) into n using fm;
    if n <> r.expected then
      raise exception '%: יש % שורות של FollowMe, ובדוח היו %. לא השתנה כלום.', r.tbl, n, r.expected;
    end if;
  end loop;
  if exists (select 1 from public.content where business_id = fm and status = 'draft' and date is not null) then
    raise exception 'יש טיוטה עם תאריך ביומן — לא כמו בדוח. לא השתנה כלום.';
  end if;
  select jsonb_agg(jsonb_build_object('id', id, 'date', date, 'time', time) order by id) into published_before
    from public.content where business_id = fm and status = 'published';

  -- 2) השינוי — רק שורות של FollowMe
  update public.content set date = null, time = null, status = 'draft'   -- "הוצאה מהיומן", כמו באפליקציה
   where business_id = fm and status = 'scheduled';
  delete from public.scheduled_posts where business_id = fm and status = 'failed';
  delete from public.catalog_items where business_id = fm;  -- הוריאנטים, התמונות והאפשרויות שלהם נמחקים איתם

  -- 3) אחרי: אין יותר תזמונים שלא עלו; מה שעלה — בדיוק כמו קודם; 47 פריטי התוכן כולם נשארו
  if exists (select 1 from public.content where business_id = fm and status <> 'published' and (date is not null or status = 'scheduled')) then
    raise exception 'נשאר ביומן פריט שלא עלה. בוטל — לא השתנה כלום.';
  end if;
  if published_before is distinct from (select jsonb_agg(jsonb_build_object('id', id, 'date', date, 'time', time) order by id)
      from public.content where business_id = fm and status = 'published') then
    raise exception 'הפריטים שעלו השתנו. בוטל — לא השתנה כלום.';
  end if;
  if (select count(*) from public.scheduled_posts where business_id = fm) <> 2
     or exists (select 1 from public.scheduled_posts where business_id = fm and status not in ('partial', 'done')) then
    raise exception 'תור הפרסום לא כמו שצריך אחרי. בוטל — לא השתנה כלום.';
  end if;
  for r in select * from fm_report loop
    execute format('select count(*) from public.%I where business_id = $1', r.tbl) into n using fm;
    execute format('select count(*) from public.%I where business_id is distinct from $1', r.tbl) into m using fm;
    update fm_report set followme_after = n, others_after = m where tbl = r.tbl;
    if r.tbl in ('catalog_items', 'catalog_variants', 'catalog_media', 'catalog_options') and n <> 0 then
      raise exception '%: נשארו % שורות. בוטל — לא השתנה כלום.', r.tbl, n;
    elsif not (r.tbl = any (changed)) and n <> r.followme_before then
      raise exception '%: % שורות של FollowMe לפני ו-% אחרי — הטבלה הזו לא הייתה אמורה להשתנות. בוטל — לא השתנה כלום.', r.tbl, r.followme_before, n;
    end if;
    if r.tbl = any (touched) and m <> r.others_before then
      raise exception '%: השתנה מספר השורות של עסק אחר (% → %). בוטל — לא השתנה כלום.', r.tbl, r.others_before, m;
    end if;
  end loop;
end $$;

commit;

-- הדוח: לפני / אחרי, לכל טבלה שהיו בה נתונים של FollowMe; ומצב היומן אחרי
select tbl as "טבלה",
  followme_before as "FollowMe לפני", followme_after as "FollowMe אחרי",
  others_before as "עסקים אחרים לפני", others_after as "עסקים אחרים אחרי"
from fm_report
where followme_before > 0 or followme_after > 0
union all
select 'content — ביומן (עם תאריך)', null, count(*), null, null
from public.content where business_id = 'bdb5d123-5c67-4c3b-a819-d76904429ce9' and date is not null
union all
select 'content — טיוטות בלי תאריך', null, count(*), null, null
from public.content where business_id = 'bdb5d123-5c67-4c3b-a819-d76904429ce9' and date is null and status = 'draft'
order by 1;
