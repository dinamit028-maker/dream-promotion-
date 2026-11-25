-- 2.118.0 — the accountant's answers of 25.11.2026, stage 1: the database (tests/sql/cpa-rules-stage1.check.sql).
-- Approved by the owner of the system (25.11.2026). Five rules, for NEW rows only — no issued document, cancellation, payment
-- or setting changes (documents are immutable; nothing here updates or deletes a row):
--   1. (answer 16) the date of a document is always the day it is issued, Israel time. New trigger d_documents_issue_day
--      (documents_issue_day): any date other than il_today() is refused — 'doc_date_not_today: …' (errcode 22008, so a server
--      path that crossed midnight retries instead of blocking). No date sent = today (documents_validate fills it). A client
--      clock a little ahead (tomorrow) is still brought back to today, as before (documents_validate).
--   2. (answer 8) a receipt (400) is no longer cancelled by marking "בוטל": document_cancellations_check refuses it —
--      'cancel_receipt_not_allowed: …'. 100 / 200 / 210 / 300 keep their conditions; 305 / 320 / 330 were never cancellable.
--      Receipts cancelled before this migration stay cancelled (their rows are not touched).
--   3. (answer 15) an exempt dealer's (עוסק פטור) refund is a receipt (400) with a negative total ("refund receipt"):
--      documents_validate accepts it only for an exempt dealer (entity_of(...) = 'exempt_dealer'), pointing to the receipt it
--      refunds (base_doc_type = 400, base_doc_number — the fields a credit invoice (330) uses, 1256/1257), never more than that
--      receipt's total less the refund receipts already on it (in a lock), negative payments that add up to the total, no
--      withholding, not paying an invoice, not from a quote or a draft. With refund_id (the register's / an order's
--      sale_refunds row): the money out is the refund's own ledger row and stock is the refund's — the document adds neither.
--      Without it (from the money screens, e.g. a package): documents_after_insert writes the money out (direction 'out') and
--      brings back the lines marked "restock", like a credit invoice.
--   4. (answer 17) register_settings.deductions_file — the business's deductions file number (תיק ניכויים, unified-file field
--      1016): nullable, 9 digits (register_settings_deductions_file_check). Saved like the other business details (the owner's
--      upsert of register_settings, under its RLS); its change is logged (register_settings_audit, field 'deductions_file').
--   5. (answer 13) a card payment (method 3) of a new receipt names its credit transaction kind — "cardKind", a JSON number,
--      field 1315 of 1.31 (checked against the official text): 1 regular, 2 installments, 3 credit, 4 deferred charge,
--      5 other. Required on every new card payment ('card_kind_missing: …'); refused on any other payment
--      ('card_kind_not_card: …'). Payments of documents issued before stay as they are.
-- Replaces four functions (same signatures; the md5 of the old ones are in the report of 25.11.2026, compare with the live
-- database before running):
--   documents_validate()           of 20261011005000_cash_bank_goods.sql   (items 1, 3, 5)
--   documents_after_insert()       of 20261011005000_cash_bank_goods.sql   (item 3)
--   document_cancellations_check() of 20261011005000_cash_bank_goods.sql   (item 2)
--   register_settings_audit()      of 20261004003100_dream_finance.sql     (item 4)
-- Running 5000 (or 3100) again after this one brings the old versions back — then run this one again.
-- Adds: one column + its check, one function + its trigger (d_documents_issue_day). No table, no policy, no grant to the browser.
-- Deploy order: the app that sends "cardKind" on every card payment goes FIRST (the old database ignores the key); then this
-- migration. Until it runs, a refund receipt is refused by the old checks (total above zero).
-- Runs after 3100 (Dream Finance), 4900 (reports, withholding) and 5000 (goods documents) — it stops at the top without them.

do $$
begin
  if to_regclass('public.documents') is null or to_regclass('public.register_settings') is null or to_regclass('public.payments') is null
     or to_regclass('public.document_cancellations') is null or to_regclass('public.sale_refunds') is null then
    raise exception 'migration 20261125006800 runs after 20261004003100 (Dream Finance) — run it first; nothing was changed';
  end if;
  if to_regprocedure('public.il_today()') is null or to_regprocedure('public.entity_of(text, text)') is null
     or to_regprocedure('public.finance_locked_until(uuid)') is null or to_regprocedure('public.issuer_snapshot(uuid)') is null
     or to_regprocedure('public.finance_log(uuid, text, text, text, jsonb)') is null then
    raise exception 'migration 20261125006800 runs after 20261004003100 (Dream Finance) — run it first; nothing was changed';
  end if;
  if to_regprocedure('public.documents_withholding()') is null or to_regprocedure('public.withholding_pct(jsonb)') is null then
    raise exception 'migration 20261125006800 runs after 20261011004900 (reports, withholding) — run it first; nothing was changed';
  end if;
  if to_regprocedure('public.documents_goods()') is null or to_regprocedure('public.stock_lines_v(jsonb)') is null
     or to_regprocedure('public.stock_move_ref_at(uuid, uuid, uuid, uuid, integer, text, text, uuid, uuid)') is null
     or not exists (select 1 from pg_constraint where conname = 'documents_doc_type_check'
                     and pg_get_constraintdef(oid) like '%210%') then
    raise exception 'migration 20261125006800 runs after 20261011005000 (goods documents) — run it first; nothing was changed';
  end if;
end $$;

-- ---- 4. the deductions file number (field 1016) -------------------------------------------------------------------------------
alter table public.register_settings add column if not exists deductions_file text;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'register_settings_deductions_file_check') then
    alter table public.register_settings add constraint register_settings_deductions_file_check
      check (deductions_file is null or deductions_file ~ '^[0-9]{9}$');
  end if;
end $$;
comment on column public.register_settings.deductions_file is
  'תיק ניכויים — 9 ספרות, שדה 1016 בקובץ במבנה האחיד (רואה החשבון, 25.11.2026). ריק = אין.';

-- the log of the business (20261004003100's): and the deductions file number
create or replace function public.register_settings_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare changed text[];
begin
  changed := array_remove(array[
    case when new.business_type is distinct from old.business_type then 'business_type' end,
    case when new.entity_type is distinct from old.entity_type then 'entity_type' end,
    case when new.vat_rate is distinct from old.vat_rate then 'vat_rate' end,
    case when new.dealer_number is distinct from old.dealer_number then 'dealer_number' end,
    case when new.company_number is distinct from old.company_number then 'company_number' end,
    case when new.deductions_file is distinct from old.deductions_file then 'deductions_file' end,
    case when new.legal_name is distinct from old.legal_name then 'legal_name' end,
    case when (new.street, new.house_no, new.city, new.zip) is distinct from (old.street, old.house_no, old.city, old.zip) then 'address' end], null);
  if cardinality(changed) > 0 then
    perform public.finance_log(new.business_id, 'settings.business', 'register_settings', new.business_id::text,
      jsonb_build_object('fields', to_jsonb(changed), 'vatRate', new.vat_rate, 'entity', public.entity_of(new.entity_type, new.business_type)));
  end if;
  return null;
end $$;
revoke execute on function public.register_settings_audit() from public, anon, authenticated;

-- ---- 1 + 3 + 5. documents_validate (20261011005000's) ------------------------------------------------------------------------
-- 1: no date sent = today. 3: an exempt dealer's refund receipt (a 400 with a negative total). 5: a card payment's kind.
-- Everything else as in 5000.
create or replace function public.documents_validate() returns trigger
language plpgsql security definer set search_path = public as $$
declare
  rs record; ent text; n int; bad int; s numeric; lock_end date; base record; done numeric; tgt record; mirror boolean := false;
  refund_receipt boolean; rf record;
begin
  if new.business_id is null then raise exception 'a document must belong to a business' using errcode = '23502'; end if;
  select * into rs from public.register_settings where business_id = new.business_id;
  if not found or coalesce(rs.dealer_number, '') !~ '^[0-9]{9}$' then
    raise exception 'business_details_missing: a document needs the business''s dealer number (9 digits)' using errcode = '23514';
  end if;
  ent := public.entity_of(rs.entity_type, rs.business_type);
  if not (new.doc_type = any (public.entity_doc_types(ent))) then
    raise exception 'doc_type_not_allowed: % does not issue document type %', ent, new.doc_type using errcode = '23514';
  end if;
  -- a cashier issues the sale's own document, nothing more
  if public.my_access() = 'register' and (new.paid_document_id is not null or new.quote_id is not null or new.draft_id is not null) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  -- references stay inside the business
  if new.sale_id is not null and not exists (select 1 from public.sales x where x.id = new.sale_id and x.business_id = new.business_id) then
    raise exception 'the sale belongs to another business' using errcode = '42501'; end if;
  if new.lead_id is not null and not exists (select 1 from public.leads x where x.id = new.lead_id and x.business_id = new.business_id) then
    raise exception 'the customer belongs to another business' using errcode = '42501'; end if;
  if new.refund_id is not null and not exists (select 1 from public.sale_refunds x where x.id = new.refund_id and x.business_id = new.business_id) then
    raise exception 'the refund belongs to another business' using errcode = '42501'; end if;
  if new.quote_id is not null and not exists (select 1 from public.quotes x where x.id = new.quote_id and x.business_id = new.business_id
                                                and x.status in ('draft', 'sent', 'accepted')) then
    raise exception 'the quote was not found in this business (or was already used)' using errcode = '23514'; end if;
  if new.draft_id is not null and not exists (select 1 from public.document_drafts x where x.id = new.draft_id and x.business_id = new.business_id
                                                and x.status = 'open' and x.doc_type = new.doc_type) then
    raise exception 'the draft was not found in this business (or was already issued)' using errcode = '23514'; end if;

  -- 2.118 (the accountant, answer 15): an exempt dealer refunds with a receipt of a negative total, pointing to the receipt it
  -- refunds — never more than that receipt less the refund receipts already on it (in a lock)
  refund_receipt := new.doc_type = 400 and new.total < 0;
  if refund_receipt then
    if ent is distinct from 'exempt_dealer' then
      raise exception 'refund_receipt_not_exempt: קבלה במינוס (החזר כספי) — רק לעוסק פטור. עוסק מורשה וחברה מפיקים חשבונית מס זיכוי (330)'
        using errcode = '23514'; end if;
    if new.paid_document_id is not null or new.quote_id is not null or new.draft_id is not null then
      raise exception 'refund_receipt_alone: קבלה במינוס לא משלמת חשבונית ולא מופקת מהצעה או מטיוטה' using errcode = '23514'; end if;
    if new.base_doc_type is distinct from 400 or new.base_doc_number is null then
      raise exception 'refund_receipt_base: קבלה במינוס מציינת את הקבלה שעליה ההחזר (base_doc_type 400 ומספר הקבלה)' using errcode = '23514'; end if;
    select id, total, sale_id into base from public.documents
     where business_id = new.business_id and doc_type = 400 and doc_number = new.base_doc_number for update;
    if not found or base.total <= 0 then
      raise exception 'refund_receipt_base: הקבלה שעליה ההחזר לא נמצאה בעסק הזה' using errcode = '23514'; end if;
    if exists (select 1 from public.document_cancellations c where c.document_id = base.id) then
      raise exception 'refund_receipt_base: הקבלה שעליה ההחזר בוטלה' using errcode = '23514'; end if;
    select coalesce(sum(-c.total), 0) into done from public.documents c
     where c.business_id = new.business_id and c.doc_type = 400 and c.total < 0 and c.base_doc_type = 400 and c.base_doc_number = new.base_doc_number;
    if done - new.total > base.total then
      raise exception 'refund_receipt_over: על הקבלה נשארו להחזר % ש״ח', base.total - done using errcode = '23514'; end if;
    -- the register's / an order's refund: the same money, of the same sale
    if new.refund_id is not null then
      select id, sale_id, amount into rf from public.sale_refunds where id = new.refund_id;
      if rf.amount is distinct from -new.total then
        raise exception 'refund_receipt_refund: סכום הקבלה במינוס (%) שונה מסכום ההחזר (%)', new.total, rf.amount using errcode = '23514'; end if;
      if base.sale_id is distinct from rf.sale_id or (new.sale_id is not null and new.sale_id is distinct from rf.sale_id) then
        raise exception 'refund_receipt_refund: ההחזר שייך למכירה אחרת מהקבלה' using errcode = '23514'; end if;
    end if;
  -- a credit invoice: points to a tax invoice of this business, never beyond what is left to credit (in a lock)
  elsif new.doc_type = 330 then
    if new.base_doc_type is null or new.base_doc_type not in (305, 320) or new.base_doc_number is null then
      raise exception 'a credit invoice points to a tax invoice (305 / 320)' using errcode = '23514'; end if;
    select id, total, before_discount, discount, after_discount, vat_amount into base from public.documents
     where business_id = new.business_id and doc_type = new.base_doc_type and doc_number = new.base_doc_number for update;
    if not found then raise exception 'the credited invoice was not found in this business' using errcode = '23514'; end if;
    select coalesce(sum(c.total), 0) into done from public.documents c
     where c.business_id = new.business_id and c.doc_type = 330 and c.base_doc_type = new.base_doc_type and c.base_doc_number = new.base_doc_number;
    if done + new.total > base.total then
      raise exception 'credit_exceeds_original: % left to credit', base.total - done using errcode = '23514'; end if;
    -- a full mirror of an invoice issued before these checks existed is accepted as it is
    mirror := new.total = base.total and new.before_discount = base.before_discount and new.discount = base.discount
              and new.after_discount = base.after_discount and new.vat_amount = base.vat_amount;
  elsif new.base_doc_type is not null or new.base_doc_number is not null then
    -- 2.95 (T10): a document made from an order or a delivery note names it (fields 1256/1257) — d_documents_goods checks which
    if new.base_doc_number is null or not ((new.doc_type = 200 and new.base_doc_type = 100) or (new.doc_type = 210 and new.base_doc_type = 200)
                                            or (new.doc_type in (300, 305, 320) and new.base_doc_type in (100, 200))) then
      raise exception 'only a credit invoice points to a base document (or a document made from an order or a delivery note)' using errcode = '23514';
    end if;
  end if;

  -- totals, to the agora
  if not mirror then
    if refund_receipt then
      -- a refund receipt: no discount and no VAT — before = after = the total, below zero
      if new.discount <> 0 or new.vat_amount <> 0 or new.before_discount >= 0 then
        raise exception 'totals: a refund receipt has no discount and no VAT, and its amounts are below zero' using errcode = '23514'; end if;
    elsif new.before_discount < 0 or new.discount < 0 or new.vat_amount < 0 or new.total <= 0 then
      raise exception 'totals: amounts are positive and the total is above zero' using errcode = '23514'; end if;
    if new.after_discount <> new.before_discount - new.discount then
      raise exception 'totals: after discount must equal before discount minus the discount' using errcode = '23514'; end if;
    if new.total <> new.after_discount + new.vat_amount then
      raise exception 'totals: the total must equal the amount before VAT plus the VAT' using errcode = '23514'; end if;
    if new.vat_rate < 0 or new.vat_rate > 30 then raise exception 'totals: VAT rate out of range' using errcode = '23514'; end if;
    if not public.entity_charges_vat(ent) or new.doc_type = 400 then
      if new.vat_amount <> 0 then raise exception 'totals: this document carries no VAT' using errcode = '23514'; end if;
    elsif abs(new.vat_amount - round(new.after_discount * new.vat_rate / 100, 2)) > 0.01 then
      raise exception 'totals: the VAT does not match the rate' using errcode = '23514';
    end if;
    if jsonb_typeof(new.lines) is distinct from 'array' then raise exception 'lines: a list is expected' using errcode = '23514'; end if;
    n := jsonb_array_length(new.lines);
    if n = 0 and new.doc_type <> 400 then raise exception 'lines: a document needs at least one line' using errcode = '23514'; end if;
    if n > 0 then
      select coalesce(sum((e->>'totalExVat')::numeric), 0), count(*) filter (where coalesce(e->>'name', '') = '' or e->>'totalExVat' is null)
        into s, bad from jsonb_array_elements(new.lines) e;
      if bad > 0 then raise exception 'lines: every line needs a name and a total' using errcode = '23514'; end if;
      if s <> new.before_discount then
        raise exception 'lines: the lines add up to % but the document says %', s, new.before_discount using errcode = '23514'; end if;
    end if;
  end if;

  -- payments: a receipt (320 / 400) lists how it was paid, exactly the total; other documents list none
  if jsonb_typeof(new.payments) is distinct from 'array' then raise exception 'payments: a list is expected' using errcode = '23514'; end if;
  if new.doc_type in (320, 400) then
    if jsonb_array_length(new.payments) = 0 then raise exception 'payments: a receipt says how it was paid' using errcode = '23514'; end if;
    if refund_receipt then
      -- the money that went back: each payment below zero, never tax withheld at source
      select coalesce(sum((p->>'amount')::numeric), 0),
             count(*) filter (where coalesce((p->>'amount')::numeric, 0) >= 0 or coalesce(p->>'method', '') !~ '^[1-9]$'
                                or p->>'m' = 'withholding' or p ? 'pct'
                                or (p ? 'date' and coalesce(p->>'date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
        into s, bad from jsonb_array_elements(new.payments) p;
      if bad > 0 then
        raise exception 'refund_receipt_payments: בקבלה במינוס כל תשלום הוא החזר — סכום מתחת לאפס, אמצעי תשלום 1–9, בלי ניכוי במקור'
          using errcode = '23514'; end if;
    else
      select coalesce(sum((p->>'amount')::numeric), 0),
             count(*) filter (where coalesce((p->>'amount')::numeric, 0) <= 0 or coalesce(p->>'method', '') !~ '^[1-9]$'
                                or (p ? 'date' and coalesce(p->>'date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'))
        into s, bad from jsonb_array_elements(new.payments) p;
      if bad > 0 then raise exception 'payments: each payment needs a method (1–9), an amount above zero and a valid date' using errcode = '23514'; end if;
    end if;
    if abs(s - new.total) > 0.01 then raise exception 'payments: % paid but the document says %', s, new.total using errcode = '23514'; end if;
    -- 2.118 (the accountant, answer 13): a card payment names its credit transaction kind (field 1315): 1 regular, 2 installments,
    -- 3 credit, 4 deferred charge, 5 other — asked when the document is issued; no other payment carries one
    if exists (select 1 from jsonb_array_elements(new.payments) p
                where p->>'method' = '3' and (jsonb_typeof(p->'cardKind') is distinct from 'number' or coalesce(p->>'cardKind', '') !~ '^[1-5]$')) then
      raise exception 'card_kind_missing: בתשלום בכרטיס אשראי בוחרים את סוג העסקה — רגיל, תשלומים, קרדיט, חיוב נדחה או אחר (cardKind 1–5)'
        using errcode = '23514'; end if;
    if exists (select 1 from jsonb_array_elements(new.payments) p where p->>'method' is distinct from '3' and p ? 'cardKind') then
      raise exception 'card_kind_not_card: סוג עסקת אשראי (cardKind) — רק בתשלום בכרטיס אשראי' using errcode = '23514'; end if;
  elsif jsonb_array_length(new.payments) > 0 then
    raise exception 'payments: only a receipt (320 / 400) lists payments' using errcode = '23514';
  end if;

  -- a receipt paying an invoice of this business: 400 pays a 305 / 300, a 320 pays a 300 (in a lock)
  if new.paid_document_id is not null then
    select id, doc_type, business_id into tgt from public.documents where id = new.paid_document_id for update;
    if not found or tgt.business_id is distinct from new.business_id then
      raise exception 'the paid document was not found in this business' using errcode = '42501'; end if;
    if not ((new.doc_type = 400 and tgt.doc_type in (300, 305)) or (new.doc_type = 320 and tgt.doc_type = 300)) then
      raise exception 'a receipt (400) pays a 305 / 300; a tax invoice-receipt (320) pays a 300' using errcode = '23514'; end if;
    if exists (select 1 from public.document_cancellations x where x.document_id = tgt.id) then
      raise exception 'the paid document was cancelled' using errcode = '23514'; end if;
  end if;

  -- dates: the day it is issued (2.118 — d_documents_issue_day refuses any other); no date sent = today; never ahead of today
  -- (a client clock a little ahead is brought back), never in closed books
  if new.doc_date is null then new.doc_date := public.il_today(); end if;
  if new.doc_date > public.il_today() + 1 then raise exception 'a document can not be dated in the future' using errcode = '23514'; end if;
  if new.doc_date > public.il_today() then new.doc_date := public.il_today(); end if;
  lock_end := public.finance_locked_until(new.business_id);
  if lock_end is not null and new.doc_date <= lock_end then
    raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  if new.doc_type in (300, 305) then
    if new.due_date is not null and new.due_date < new.doc_date then raise exception 'the due date is before the document date' using errcode = '23514'; end if;
  else
    new.due_date := null;
  end if;

  new.source := coalesce(new.source, case when new.refund_id is not null or refund_receipt then 'refund' when new.sale_id is not null then 'pos'
                                          when new.paid_document_id is not null then 'receipt'
                                          when new.quote_id is not null then 'quote' when new.doc_type = 330 then 'credit' else 'direct' end);
  new.issuer := public.issuer_snapshot(new.business_id);   -- whatever the client sent: the business as it is now
  return new;
end $$;
revoke execute on function public.documents_validate() from public, anon, authenticated;

-- ---- 1. the date of a document is the day it is issued (the accountant, answer 16) --------------------------------------------
-- A trigger of its own, after c_documents_validate (which fills a missing date and brings tomorrow back) and before the numbering
-- ("d_documents_issue_day" < "documents_number"). errcode 22008, not 23514: a server path whose day turned at midnight between
-- computing the date and the insert waits and tries again (documentFailure), instead of blocking.
create or replace function public.documents_issue_day() returns trigger
language plpgsql set search_path = public as $$
begin
  if new.doc_date is distinct from public.il_today() then
    raise exception 'doc_date_not_today: תאריך המסמך הוא תמיד יום ההפקה (%). אי אפשר להפיק מסמך בתאריך אחר (%)',
      to_char(public.il_today(), 'DD/MM/YYYY'), coalesce(to_char(new.doc_date, 'DD/MM/YYYY'), '—') using errcode = '22008';
  end if;
  return new;
end $$;
revoke execute on function public.documents_issue_day() from public, anon, authenticated;
create or replace trigger d_documents_issue_day before insert on public.documents for each row execute function public.documents_issue_day();

-- ---- 3. the ledger and the stock of a refund receipt: documents_after_insert (20261011005000's) ---------------------------------
-- A refund receipt with refund_id (the register's / an order's refund): nothing — the refund's own ledger row (sale_refunds_ledger)
-- is the money out, and its restock is the refund's. Without it: one 'out' row per payment (the amount above zero), and the lines
-- marked "restock" come back, like a direct credit invoice. Everything else as in 5000.
create or replace function public.documents_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare p jsonb; m text; l record; rest jsonb; refund_receipt boolean := new.doc_type = 400 and new.total < 0;
begin
  -- 1. the ledger: one row per payment of a receipt (2.94: tax withheld at source stays "withholding", with its percent)
  if new.doc_type in (320, 400) and not (refund_receipt and new.refund_id is not null) then
    for p in select value from jsonb_array_elements(new.payments) loop
      m := coalesce(nullif(p->>'m', ''), case p->>'method' when '1' then 'cash' when '2' then 'cheque' when '3' then 'card' when '4' then 'transfer' else 'other' end);
      if m not in ('cash', 'card', 'transfer', 'bit', 'cheque', 'other', 'withholding') then m := 'other'; end if;
      insert into public.payments (business_id, user_id, direction, amount, method, paid_on, source, document_id, applies_to, sale_id, lead_id, reference)
      values (new.business_id, new.user_id, case when refund_receipt then 'out' else 'in' end, abs((p->>'amount')::numeric), m,
              coalesce(nullif(p->>'date', '')::date, new.doc_date), 'document',
              new.id, new.paid_document_id, new.sale_id, new.lead_id,
              case when m = 'withholding' then jsonb_strip_nulls(jsonb_build_object('pct', public.withholding_pct(p)))
                   when jsonb_typeof(p->'cheque') = 'object' then p->'cheque' else '{}'::jsonb end);
    end loop;
  end if;
  -- 2. the draft it came from is now issued; the quote it came from is converted
  if new.draft_id is not null then
    update public.document_drafts set status = 'finalized', document_id = new.id where id = new.draft_id and business_id = new.business_id;
  end if;
  if new.quote_id is not null then
    update public.quotes set status = 'converted', converted_document_id = new.id
     where id = new.quote_id and business_id = new.business_id and status in ('draft', 'sent', 'accepted');
  end if;
  -- 3. stock: products sold on a direct document go out on the document that makes the sale — a 300 / 305, or a
  --    320 / 400 that stands alone — and never again on the receipt that pays it (whole or in parts, exempt or not).
  --    Cancelling that document brings them back (document_cancellations_after). The register's sales move stock on
  --    their own. A direct credit invoice — and (2.118) a direct refund receipt — brings back the lines marked "restock".
  --    A line's variant moves with it (3300).
  if new.sale_id is null and new.refund_id is null then
    if new.doc_type = 200 then
      -- 2.95 (T10): a delivery note takes the goods out — the invoice made from it takes nothing again
      for l in select * from public.stock_lines_v(new.lines) loop
        perform public.stock_move_ref_at(new.business_id, coalesce(new.location_id, new.business_id), l.item_id, l.variant_id, -l.qty, 'sale', format('%s-%s', new.doc_type, new.doc_number), new.id, null);
      end loop;
    elsif new.doc_type = 210 then
      -- a return note brings back what came back, where it went out from (its delivery note's location)
      for l in select * from public.stock_lines_v(new.lines) loop
        perform public.stock_move_ref_at(new.business_id, coalesce(new.location_id, new.business_id), l.item_id, l.variant_id, l.qty, 'refund', format('%s-%s', new.doc_type, new.doc_number), new.id, null);
      end loop;
    elsif new.doc_type in (300, 305, 320, 400) and not refund_receipt and new.paid_document_id is null and new.base_doc_type is distinct from 200 then
      for l in select * from public.stock_lines_v(new.lines) loop
        perform public.stock_move_ref_at(new.business_id, coalesce(new.location_id, new.business_id), l.item_id, l.variant_id, -l.qty, 'sale', format('%s-%s', new.doc_type, new.doc_number), new.id, null);
      end loop;
    elsif new.doc_type = 330 or refund_receipt then
      select coalesce(jsonb_agg(e), '[]'::jsonb) into rest from jsonb_array_elements(new.lines) e where (e->>'restock') = 'true';
      for l in select * from public.stock_lines_v(rest) loop
        perform public.stock_move_ref_at(new.business_id, coalesce(new.location_id, new.business_id), l.item_id, l.variant_id, case when refund_receipt then abs(l.qty) else l.qty end, 'refund', format('%s-%s', new.doc_type, new.doc_number), new.id, null);
      end loop;
    end if;
  end if;
  -- 4. the audit log
  perform public.finance_log(new.business_id, 'document.issued', 'documents', new.id::text,
    jsonb_build_object('type', new.doc_type, 'number', new.doc_number, 'total', new.total, 'date', new.doc_date, 'source', new.source));
  return null;
end $$;
revoke execute on function public.documents_after_insert() from public, anon, authenticated;

-- ---- 2. cancellations (20261011005000's): no longer a receipt (the accountant, answer 8) ----------------------------------------
-- Cancelling by marking — only a document that is neither a tax invoice nor a receipt: an order, a delivery note, a return note
-- and a transaction invoice (100 / 200 / 210 / 300), with their conditions as before. A receipt is refunded (an exempt dealer:
-- a refund receipt, above) or credited. Receipts cancelled before stay cancelled.
create or replace function public.document_cancellations_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare d record; lock_end date;
begin
  select id, business_id, doc_type, doc_number, doc_date, base_doc_number into d from public.documents where id = new.document_id for update;
  if not found or d.business_id is distinct from new.business_id then
    raise exception 'the document was not found in this business' using errcode = '42501'; end if;
  if d.doc_type = 400 then
    raise exception 'cancel_receipt_not_allowed: קבלה לא מבטלים בסימון "בוטל". מחזירים כסף בקבלה במינוס (עוסק פטור) או בחשבונית זיכוי'
      using errcode = '23514'; end if;
  if d.doc_type not in (300, 100, 200, 210) then
    raise exception 'cancel_not_allowed: a tax invoice is corrected by a credit invoice (330)' using errcode = '23514'; end if;
  lock_end := public.finance_locked_until(d.business_id);
  if lock_end is not null and d.doc_date <= lock_end then
    raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  if d.doc_type = 300 and exists (select 1 from public.documents p where p.paid_document_id = d.id
                                    and not exists (select 1 from public.document_cancellations c where c.document_id = p.id)) then
    raise exception 'a paid transaction invoice is not cancelled (cancel its receipt first)' using errcode = '23514'; end if;
  -- 2.95 (T10): an order / a delivery note a document was made from stays (cancel that one first, if it may be)
  if d.doc_type in (100, 200) and exists (select 1 from public.documents x
                                            where x.business_id = d.business_id and x.base_doc_type = d.doc_type and x.base_doc_number = d.doc_number
                                              and not exists (select 1 from public.document_cancellations c where c.document_id = x.id)) then
    raise exception 'cancel_has_followers: a document was made from it — cancel that one first' using errcode = '23514'; end if;
  -- a return note stays once its delivery note was invoiced (the invoice counted what came back)
  if d.doc_type = 210 and exists (select 1 from public.documents x
                                    where x.business_id = d.business_id and x.base_doc_type = 200 and x.base_doc_number = d.base_doc_number
                                      and x.doc_type in (300, 305, 320)
                                      and not exists (select 1 from public.document_cancellations c where c.document_id = x.id)) then
    raise exception 'cancel_has_followers: its delivery note was invoiced' using errcode = '23514'; end if;
  new.created_at := now();
  return new;
end $$;
revoke execute on function public.document_cancellations_check() from public, anon, authenticated;

-- ---- rollback (by hand, only to undo it) ---------------------------------------------------------------------------------------
-- Documents issued under these rules stay as they are (a refund receipt, a card payment's kind) — undoing the rules does not
-- change them. To go back:
--   drop trigger if exists d_documents_issue_day on public.documents; drop function if exists public.documents_issue_day();
--   then run again, from 20261011005000_cash_bank_goods.sql, documents_validate(), documents_after_insert() and
--   document_cancellations_check() (with their revoke lines), and from 20261004003100_dream_finance.sql register_settings_audit().
--   The column may stay (nothing else reads it); to remove it as well:
--   alter table public.register_settings drop constraint if exists register_settings_deductions_file_check;
--   alter table public.register_settings drop column if exists deductions_file;
