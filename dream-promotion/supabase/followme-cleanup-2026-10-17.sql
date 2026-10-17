-- FollowMe — שלב א: ניקוי התוכן ש"לא עלה" ו-4 הפריטים (הוכן 17.10.2026, לפי docs/FOLLOWME_STAGE_A_HE.md).
-- רץ רק ב-SQL Editor של Supabase, ורק אחרי "מאשר" (יש בו DELETE, ולכן לא דרך ה-MCP). מדביקים הכול ולוחצים Run — פעם אחת.
-- טרנזקציה אחת: אם משהו לא כמו בדוח — שום דבר לא משתנה, ומופיעה שגיאה שאומרת מה. בסוף — טבלה של לפני / אחרי.
--
-- מה נמחק — רק ב-FollowMe:
--   1. תוכן שלא עלה: 45 פריטים — 33 שתוזמנו ולא עלו (32 בעבר, 1 בעתיד) ו-12 טיוטות. עם הפריט שנכשל נמחק גם
--      התזמון שלו בתור הפרסום (1.10). 2 הפריטים שעלו נשארים ביומן כמו שהם, עם שני התזמונים שלהם.
--   2. 4 הפריטים שהוקמו בקטלוג (עם 3 הוריאנטים, 2 התמונות והאפשרות שלהם).
-- כל השאר לא משתנה: ספריית המדיה (כל הסרטונים והתמונות), קבלות, חשבוניות, תשלומים, מכירות, הוצאות, עובדים, משמרות,
-- לידים, קטגוריות, האתר, החיבורים, ההגדרות, יומן עלויות ה-AI — ואף עסק אחר.

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
  -- הטבלאות שמשתנות. בכל שאר הטבלאות של FollowMe המספר נשאר בדיוק כמו לפני
  changed constant text[] := array['content', 'scheduled_posts', 'catalog_items', 'catalog_variants', 'catalog_media', 'catalog_options'];
  -- טבלאות שהפקודות כאן נוגעות בהן (גם דרך מפתחות) — בהן בודקים שאף עסק אחר לא השתנה
  touched constant text[] := changed || array['ai_generations', 'catalog_collection_items', 'stock_movements', 'stock_levels',
    'stock_reservations', 'price_list_items', 'order_lines', 'client_packages'];
  kept_before jsonb; r record; n bigint; m bigint;
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
  -- התזמונים שעלו שייכים לפריטים שעלו, ונשארים איתם
  if exists (select 1 from public.scheduled_posts s left join public.content c on c.id = s.content_id
              where s.business_id = fm and s.status in ('partial', 'done') and coalesce(c.status, '') <> 'published') then
    raise exception 'תזמון שעלה שייך לפריט שלא מסומן כפורסם — לא כמו בדוח. לא השתנה כלום.';
  end if;
  select jsonb_agg(jsonb_build_object('id', c.id, 'date', c.date, 'time', c.time, 'updated', c.updated_at) order by c.id) into kept_before
    from public.content c where c.business_id = fm and c.status = 'published';

  -- 2) המחיקה — רק שורות של FollowMe
  delete from public.content where business_id = fm and status <> 'published';  -- יומן ה-AI נשאר; הקישור שלו לפריט מתאפס
  delete from public.scheduled_posts where business_id = fm and status = 'failed'; -- בדרך כלל כבר נמחק עם הפריט שלו
  delete from public.catalog_items where business_id = fm;  -- הוריאנטים, התמונות והאפשרויות שלהם נמחקים איתם

  -- 3) אחרי: נשארו בדיוק 2 הפריטים שעלו, כמו שהיו, עם 2 התזמונים שלהם; 0 פריטים בקטלוג; כל השאר כמו לפני
  if kept_before is distinct from (select jsonb_agg(jsonb_build_object('id', c.id, 'date', c.date, 'time', c.time, 'updated', c.updated_at) order by c.id)
      from public.content c where c.business_id = fm) then
    raise exception 'אחרי המחיקה התוכן שנשאר הוא לא בדיוק 2 הפריטים שעלו. בוטל — לא השתנה כלום.';
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

-- הדוח: לפני / אחרי, לכל טבלה שהיו בה נתונים של FollowMe
select tbl as "טבלה",
  followme_before as "FollowMe לפני", followme_after as "FollowMe אחרי",
  others_before as "עסקים אחרים לפני", others_after as "עסקים אחרים אחרי"
from fm_report
where followme_before > 0 or followme_after > 0
order by (followme_before - followme_after) desc, tbl;
