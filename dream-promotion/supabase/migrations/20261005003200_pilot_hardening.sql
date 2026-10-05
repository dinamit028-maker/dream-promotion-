-- ============================================================================
-- Migration 20261005003200 — pilot hardening 2.52.1 (additive: no table, column, policy or row is removed; no data changes)
-- Found in the 2.52.1 audit; every item is tested on a local database (tests/sql/pilot-hardening.check.sql).
--   1. no answers about another business   a_gate_caller: an app user's insert / update of a money row is refused BEFORE the
--                                           database's own checks run. Those checks (security definer) read the row's
--                                           business, and their messages could tell another business's numbers (credit
--                                           left on an invoice, its closed-books date, its type of business). The rule is
--                                           the one row-level security already applies — only earlier.
--   2. functions                           business_for_user(uid) and business_is_active(bid): server only (they answered
--                                           for any user / business). finance_locked_until(): only for a business whose
--                                           money the caller may see.
--   3. memberships                         nobody adds or changes their own membership from the browser (the super admin
--                                           too: that would open a business's money without the reason and the log of
--                                           open_finance_access); every membership change goes into the business's audit log.
--   4. profiles.email                      set by the sign-in system only (the admin panel finds people by it)
--   5. viewer                              role 'viewer' reads and never writes: RESTRICTIVE policies on every business
--                                           table + the write functions. (The app creates no viewers today.)
--   6. receipts                            a receipt never pays more than the invoice's balance (inside the invoice's lock);
--                                           a receipt (400) pays a transaction invoice (300) only in a business without VAT
--                                           — a VAT business pays a 300 with a tax invoice-receipt (320), as the app does.
--   7. document content                    lines and payments: numbers are numbers, dates are dates, cheque fields digits.
--   8. money back once                     a register refund and a refund recorded on a credit invoice together never
--                                           return more than the sale (each counts the other, inside the sale's lock).
--   9. TRUNCATE                            not for app users on any table (row-level security does not apply to TRUNCATE).
-- Idempotent (create or replace / if not exists). Rollback: at the end of this file.
-- Applied to production only after the owner's explicit approval.
-- ============================================================================

-- ---- 1. the caller's own business, before any check reads another one -------------------------------------------------
-- not security definer: current_user is the caller ('authenticated' from the app; the server's service role and SQL pass)
create or replace function public.gate_caller() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    if new.business_id is null
       or new.business_id is distinct from public.current_business_id()
       or new.business_id not in (select public.accessible_business_ids())
       or new.business_id not in (select public.finance_business_ids()) then
      raise exception 'not allowed' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.gate_caller() from public, anon, authenticated;
-- "a_gate_": after a_fill_business_id (it fills an empty business_id), before every b_ / c_ / d_ check and the numbering
do $$
declare t text;
begin
  foreach t in array array['documents', 'sale_refunds', 'document_cancellations', 'quotes', 'expenses', 'document_drafts'] loop
    execute format('create or replace trigger a_gate_caller before insert or update on public.%I for each row execute function public.gate_caller()', t);
  end loop;
end $$;

-- ---- 2. functions that answered about any user or business --------------------------------------------------------------
-- (used inside security definer functions and by the server's service role only — no policy or invoker function calls them)
revoke execute on function public.business_for_user(uuid) from authenticated;
revoke execute on function public.business_is_active(uuid) from authenticated;
-- the closed-books date: for the server (no user), or a business whose money the caller may see
create or replace function public.finance_locked_until(p_business uuid) returns date
language sql stable security definer set search_path = public as $$
  select max(l.period_end) from public.finance_period_locks l
   where l.business_id = p_business
     and (auth.uid() is null or p_business in (select public.finance_business_ids()));
$$;
revoke execute on function public.finance_locked_until(uuid) from public, anon;
grant execute on function public.finance_locked_until(uuid) to authenticated, service_role;

-- ---- 3. memberships: never one's own from the browser; every change in the business's audit log -----------------------
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'business_members' and policyname = 'business_members_not_self_insert') then
    create policy business_members_not_self_insert on public.business_members as restrictive for insert to authenticated
      with check (user_id <> auth.uid());
  end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'business_members' and policyname = 'business_members_not_self_update') then
    create policy business_members_not_self_update on public.business_members as restrictive for update to authenticated
      using (user_id <> auth.uid()) with check (user_id <> auth.uid());
  end if;
end $$;

create or replace function public.business_members_audit() returns trigger
language plpgsql security definer set search_path = public as $$
declare bid uuid := coalesce(new.business_id, old.business_id); who text;
begin
  -- a business that is being deleted (members go with it) has no log to write to
  if not exists (select 1 from public.businesses b where b.id = bid) then return null; end if;
  select coalesce(p.email, '') into who from public.profiles p where p.id = coalesce(new.user_id, old.user_id);
  if tg_op = 'INSERT' then
    perform public.finance_log(bid, 'member.added', 'business_members', new.user_id::text,
      jsonb_build_object('email', coalesce(who, ''), 'role', new.role, 'access', new.access));
  elsif tg_op = 'UPDATE' then
    if (new.role, new.access) is distinct from (old.role, old.access) then
      perform public.finance_log(bid, 'member.changed', 'business_members', new.user_id::text,
        jsonb_build_object('email', coalesce(who, ''), 'role', new.role, 'access', new.access, 'was', old.role || '/' || old.access));
    end if;
  else
    perform public.finance_log(bid, 'member.removed', 'business_members', old.user_id::text,
      jsonb_build_object('email', coalesce(who, ''), 'role', old.role, 'access', old.access));
  end if;
  return null;
end $$;
revoke execute on function public.business_members_audit() from public, anon, authenticated;
create or replace trigger business_members_audit after insert or update or delete on public.business_members
  for each row execute function public.business_members_audit();

-- ---- 4. profiles: the email comes from the sign-in system (as 20261004002300, plus the email) ----------------------------
create or replace function public.profiles_guard_super_admin() returns trigger
language plpgsql set search_path = public as $$
begin
  if current_user in ('anon', 'authenticated') then
    if (tg_op = 'INSERT' and new.is_super_admin)
       or (tg_op = 'UPDATE' and new.is_super_admin is distinct from old.is_super_admin) then
      raise exception 'is_super_admin can only be changed by the platform administrator' using errcode = '42501';
    end if;
    if (tg_op = 'INSERT' and (new.clip_quota > 20 or new.image_quota > 200 or new.clips_used <> 0 or new.images_used <> 0))
       or (tg_op = 'UPDATE' and (new.clip_quota is distinct from old.clip_quota
                              or new.image_quota is distinct from old.image_quota
                              or new.clips_used is distinct from old.clips_used
                              or new.images_used is distinct from old.images_used
                              or new.quota_reset_at is distinct from old.quota_reset_at)) then
      raise exception 'quotas can only be changed by the platform administrator' using errcode = '42501';
    end if;
    -- 2.52.1: the address the admin panel looks people up by is not the user's to write
    if (tg_op = 'INSERT' and coalesce(new.email, '') <> '') or (tg_op = 'UPDATE' and new.email is distinct from old.email) then
      raise exception 'the email is set by the sign-in system' using errcode = '42501';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.profiles_guard_super_admin() from public, anon, authenticated;

-- ---- 5. viewer: reads, never writes ----------------------------------------------------------------------------------------
-- may the caller change the business they work in now? (the super admin and every role but 'viewer')
create or replace function public.can_write() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_super_admin()
      or coalesce((select m.role <> 'viewer' from public.business_members m
                    where m.user_id = auth.uid() and m.business_id = public.current_business_id()), true);
$$;
revoke execute on function public.can_write() from public, anon;
grant execute on function public.can_write() to authenticated, service_role;

do $$
declare t text;
begin
  -- every business table (the ones with a "_business_gate"): writes need can_write(); reading is unchanged
  for t in select p.tablename from pg_policies p where p.schemaname = 'public' and p.policyname = p.tablename || '_business_gate' loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_viewer_insert') then
      execute format('create policy %I on public.%I as restrictive for insert to authenticated with check ((select public.can_write()))', t || '_viewer_insert', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_viewer_update') then
      execute format('create policy %I on public.%I as restrictive for update to authenticated using ((select public.can_write())) with check ((select public.can_write()))', t || '_viewer_update', t);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_viewer_delete') then
      execute format('create policy %I on public.%I as restrictive for delete to authenticated using ((select public.can_write()))', t || '_viewer_delete', t);
    end if;
  end loop;
  -- expense files: a viewer opens them, never uploads
  if not exists (select 1 from pg_policies where schemaname = 'storage' and tablename = 'objects' and policyname = 'finance_files_viewer') then
    create policy finance_files_viewer on storage.objects as restrictive for insert to authenticated
      with check (bucket_id <> 'finance-files' or (select public.can_write()));
  end if;
end $$;

-- the write functions (security definer — row-level security does not stop them): the same rule, inside.
-- Bodies as in 20261004003000 / 20261004003100; the only change is the can_write() check (+ item 8 in record_credit_refund).
create or replace function public.adjust_stock(p_item uuid, p_mode text, p_qty int, p_note text default '')
returns int language plpgsql security definer set search_path = public as $$
declare b uuid; cur int; d int;
begin
  select business_id, stock_qty into b, cur from public.catalog_items where id = p_item for update;
  if b is null or b is distinct from public.current_business_id() or not public.can_access_business(b) or public.my_access() = 'register'
     or not public.can_write() then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_mode = 'add' then
    if coalesce(p_qty, 0) <= 0 then raise exception 'a delivery adds at least one unit' using errcode = '22023'; end if;
    d := p_qty;
  elsif p_mode = 'set' then
    if coalesce(p_qty, -1) < 0 then raise exception 'a count is zero or more' using errcode = '22023'; end if;
    d := p_qty - cur;
  else
    raise exception 'mode is add or set' using errcode = '22023';
  end if;
  update public.catalog_items set track_stock = true where id = p_item and not track_stock;  -- counting = tracking
  perform public.stock_move(b, p_item, d, case when p_mode = 'add' then 'receive' else 'count' end, null, null, p_note);
  return (select stock_qty from public.catalog_items where id = p_item);
end $$;
revoke execute on function public.adjust_stock(uuid, text, int, text) from public, anon;
grant execute on function public.adjust_stock(uuid, text, int, text) to authenticated;

create or replace function public.lock_finance_period(p_end date, p_note text default '') returns date
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); cur date;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.business_members m where m.business_id = b and m.user_id = auth.uid() and m.access = 'full') then
    raise exception 'only the business closes its books' using errcode = '42501'; end if;
  if p_end is null or p_end >= public.il_today() then raise exception 'a period that has ended (before today)' using errcode = '22023'; end if;
  cur := public.finance_locked_until(b);
  if cur is not null and p_end <= cur then raise exception 'the books are already closed until %', cur using errcode = '22023'; end if;
  insert into public.finance_period_locks (business_id, user_id, period_end, note) values (b, auth.uid(), p_end, left(coalesce(p_note, ''), 300));
  return p_end;
end $$;

-- ---- 8 (with 5). money back on a credit invoice: never beyond the credit invoice, nor — with the register's refunds of the
-- same sale — beyond what the sale was paid
create or replace function public.record_credit_refund(p_document uuid, p_method text, p_amount numeric, p_paid_on date default null, p_note text default '')
returns uuid language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); d record; base_id uuid; base_sale uuid; sale_ref uuid; sale_total numeric; reg_out numeric; cred_out numeric;
  done numeric; day date := coalesce(p_paid_on, public.il_today()); lock_end date; new_id uuid;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  select x.id, x.business_id, x.doc_type, x.total, x.base_doc_type, x.base_doc_number, x.lead_id, x.sale_id, x.refund_id
    into d from public.documents x where x.id = p_document for update;
  if not found or d.business_id <> b or d.doc_type <> 330 then raise exception 'a refund is recorded on a credit invoice of this business' using errcode = '23514'; end if;
  if d.refund_id is not null then raise exception 'this credit invoice belongs to a register refund (already recorded)' using errcode = '23514'; end if;
  if p_method is null or p_method not in ('cash', 'card', 'transfer', 'bit', 'cheque', 'other') then raise exception 'unknown payment method' using errcode = '22023'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'an amount above zero' using errcode = '22023'; end if;
  if day > public.il_today() then raise exception 'not in the future' using errcode = '22023'; end if;
  lock_end := public.finance_locked_until(b);
  if lock_end is not null and day <= lock_end then raise exception 'period_locked: the books are closed until %', lock_end using errcode = '23514'; end if;
  select coalesce(sum(p.amount), 0) into done from public.payments p where p.document_id = d.id and p.source = 'credit';
  if done + p_amount > d.total then raise exception 'more than the credit invoice (% left)', d.total - done using errcode = '23514'; end if;
  select x.id, x.sale_id into base_id, base_sale from public.documents x where x.business_id = b and x.doc_type = d.base_doc_type and x.doc_number = d.base_doc_number;
  -- 2.52.1: an invoice of a register sale — what the register already refunded counts (in the sale's lock, as sale_refunds_check)
  sale_ref := coalesce(d.sale_id, base_sale);
  if sale_ref is not null then
    select s.total into sale_total from public.sales s where s.id = sale_ref and s.business_id = b for update;
    if found then
      select coalesce(sum(r.amount), 0) into reg_out from public.sale_refunds r where r.sale_id = sale_ref;
      select coalesce(sum(p.amount), 0) into cred_out from public.payments p
       where p.source = 'credit' and p.direction = 'out'
         and (p.sale_id = sale_ref or p.applies_to in (select x.id from public.documents x where x.sale_id = sale_ref and x.business_id = b));
      if reg_out + cred_out + p_amount > sale_total then
        raise exception 'refund_exceeds_paid: % left (part of the sale was already returned at the register)', greatest(sale_total - reg_out - cred_out, 0)
          using errcode = '23514';
      end if;
    end if;
  end if;
  insert into public.payments (business_id, user_id, direction, amount, method, paid_on, source, document_id, applies_to, sale_id, lead_id, note)
  values (b, auth.uid(), 'out', round(p_amount, 2), p_method, day, 'credit', d.id, base_id, d.sale_id, d.lead_id, left(coalesce(p_note, ''), 300))
  returning payments.id into new_id;
  return new_id;
end $$;

create or replace function public.record_manual_allocation(p_document uuid, p_number text) returns uuid
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); d record; new_id uuid;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  if coalesce(p_number, '') !~ '^[0-9]{6,20}$' then raise exception 'an allocation number is digits only' using errcode = '22023'; end if;
  select x.id, x.business_id, x.doc_type into d from public.documents x where x.id = p_document;
  if not found or d.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if d.doc_type not in (305, 320, 330) then raise exception 'allocation numbers are for tax invoices' using errcode = '23514'; end if;
  if exists (select 1 from public.tax_allocations a where a.document_id = d.id and a.status in ('approved', 'manual') and not a.is_test) then
    raise exception 'the document already has an allocation number' using errcode = '23505'; end if;
  insert into public.tax_allocations (business_id, document_id, user_id, status, is_test, allocation_number, gateway)
  values (b, d.id, auth.uid(), 'manual', false, p_number, 'manual') returning tax_allocations.id into new_id;
  return new_id;
end $$;

create or replace function public.receive_expense_stock(p_expense uuid) returns int
language plpgsql security definer set search_path = public as $$
declare b uuid := public.finance_guard(); e record; l record; n int := 0;
begin
  if not public.can_write() then raise exception 'not allowed' using errcode = '42501'; end if;
  select * into e from public.expenses where id = p_expense for update;
  if not found or e.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if e.status <> 'confirmed' then raise exception 'only a confirmed expense brings stock in' using errcode = '23514'; end if;
  if exists (select 1 from public.stock_movements m where m.expense_id = e.id and m.reason = 'receive') then return 0; end if;
  for l in select * from public.stock_lines(e.stock_lines) loop
    if exists (select 1 from public.catalog_items c where c.id = l.item_id and c.business_id = b) then
      perform public.stock_move_ref(b, l.item_id, l.qty, 'receive', format('הוצאה %s · %s', e.expense_number, e.supplier_name), null, e.id);
      n := n + 1;
    end if;
  end loop;
  return n;
end $$;

-- ---- 8. a register refund: what was returned on a credit invoice of the sale's document counts too (as 20261004003000,
-- plus credit_out) -----------------------------------------------------------------------------------------------------------------
create or replace function public.sale_refunds_check() returns trigger
language plpgsql security definer set search_path = public as $$
declare s record; done numeric; credit_out numeric;
begin
  select id, business_id, status, total into s from public.sales where id = new.sale_id for update;
  if s.id is null then raise exception 'sale not found' using errcode = '23503'; end if;
  if new.business_id is distinct from s.business_id then raise exception 'a refund belongs to the business of its sale' using errcode = '42501'; end if;
  if s.status <> 'paid' then raise exception 'only a paid sale can be refunded' using errcode = '23514'; end if;
  select coalesce(sum(r.amount), 0) into done from public.sale_refunds r where r.sale_id = new.sale_id;
  select coalesce(sum(p.amount), 0) into credit_out from public.payments p
   where p.source = 'credit' and p.direction = 'out'
     and (p.sale_id = new.sale_id or p.applies_to in (select x.id from public.documents x where x.sale_id = new.sale_id and x.business_id = s.business_id));
  if done + credit_out + new.amount > s.total then
    raise exception 'refund_exceeds_paid: % left', greatest(s.total - done - credit_out, 0) using errcode = '23514';
  end if;
  new.created_at := now();   -- the refund's day is the server's, like a document's issue time
  return new;
end $$;
revoke execute on function public.sale_refunds_check() from public, anon, authenticated;

-- ---- 6 + 7. documents: content and receipts (after c_documents_validate, which already locked the paid invoice; before the
-- numbering — "d_documents_checks" < "documents_number") ------------------------------------------------------------------
create or replace function public.documents_more_checks() returns trigger
language plpgsql security definer set search_path = public as $$
declare bad int; tgt record; ent text; credited numeric; paid numeric;
begin
  -- 7. lines: an object each; a name (text); amounts, quantity, rate and kind are numbers
  select count(*) into bad from jsonb_array_elements(new.lines) e
   where jsonb_typeof(e) <> 'object'
      or jsonb_typeof(e->'name') is distinct from 'string' or length(e->>'name') > 300
      or (e ? 'qty' and jsonb_typeof(e->'qty') <> 'number')
      or (e ? 'unitPriceExVat' and jsonb_typeof(e->'unitPriceExVat') <> 'number')
      or (e ? 'discountExVat' and jsonb_typeof(e->'discountExVat') <> 'number')
      or (e ? 'totalExVat' and jsonb_typeof(e->'totalExVat') <> 'number')
      or (e ? 'vatRate' and jsonb_typeof(e->'vatRate') <> 'number')
      or (e ? 'kind' and jsonb_typeof(e->'kind') <> 'number')
      or (e ? 'restock' and jsonb_typeof(e->'restock') <> 'boolean');
  if bad > 0 then raise exception 'lines: names are text; quantities, prices, totals and rates are numbers' using errcode = '23514'; end if;
  -- 7. payments: an object each; method and amount are numbers, the date a date; a cheque's fields are digits
  select count(*) into bad from jsonb_array_elements(new.payments) p
   where jsonb_typeof(p) <> 'object'
      or jsonb_typeof(p->'method') is distinct from 'number' or jsonb_typeof(p->'amount') is distinct from 'number'
      or (p ? 'date' and coalesce(p->>'date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$')
      or (p ? 'm' and coalesce(p->>'m', '') !~ '^[a-z]{1,20}$')
      or (p ? 'cheque' and (jsonb_typeof(p->'cheque') <> 'object'
            or coalesce(p->'cheque'->>'number', '') !~ '^[0-9]{1,10}$'
            or coalesce(p->'cheque'->>'bank', '') !~ '^[0-9]{0,3}$'
            or coalesce(p->'cheque'->>'branch', '') !~ '^[0-9]{0,5}$'
            or coalesce(p->'cheque'->>'account', '') !~ '^[0-9]{0,15}$'
            or coalesce(p->'cheque'->>'dueDate', '') !~ '^([0-9]{4}-[0-9]{2}-[0-9]{2})?$'));
  if bad > 0 then raise exception 'payments: method and amount are numbers, dates are dates, a cheque''s details are digits' using errcode = '23514'; end if;

  -- 6. a receipt paying an invoice: never beyond its balance; a 400 pays a 300 only without VAT
  if new.paid_document_id is not null then
    select id, doc_type, doc_number, total, business_id into tgt from public.documents where id = new.paid_document_id for update;
    if not found or tgt.business_id is distinct from new.business_id then
      raise exception 'the paid document was not found in this business' using errcode = '42501'; end if;
    select public.entity_of(s.entity_type, s.business_type) into ent from public.register_settings s where s.business_id = new.business_id;
    if new.doc_type = 400 and tgt.doc_type = 300 and public.entity_charges_vat(coalesce(ent, 'licensed_dealer')) then
      raise exception 'a VAT business pays a transaction invoice (300) with a tax invoice-receipt (320), not a receipt (400)' using errcode = '23514';
    end if;
    select coalesce(sum(c.total), 0) into credited from public.documents c
     where c.business_id = new.business_id and c.doc_type = 330 and c.base_doc_type = tgt.doc_type and c.base_doc_number = tgt.doc_number;
    select coalesce(sum(case p.direction when 'in' then p.amount else -p.amount end), 0) into paid from public.payments p where p.applies_to = tgt.id;
    if new.total > tgt.total - credited - paid then
      raise exception 'receipt_exceeds_balance: % left to pay on this invoice', greatest(tgt.total - credited - paid, 0) using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.documents_more_checks() from public, anon, authenticated;
create or replace trigger d_documents_checks before insert on public.documents for each row execute function public.documents_more_checks();

-- ---- 9. TRUNCATE skips row-level security: not for the app's roles, on any table ----------------------------------------
do $$
declare t text;
begin
  for t in select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind in ('r', 'p') loop
    execute format('revoke truncate on public.%I from anon, authenticated', t);
  end loop;
end $$;
alter default privileges in schema public revoke truncate on tables from anon, authenticated;

-- ============================================================================================================================
-- Rollback (by hand, if ever needed):
--   drop trigger a_gate_caller on documents, sale_refunds, document_cancellations, quotes, expenses, document_drafts;
--   drop function gate_caller(); grant execute on function business_for_user(uuid), business_is_active(uuid) to authenticated;
--   re-run finance_locked_until, profiles_guard_super_admin, adjust_stock, lock_finance_period, record_credit_refund,
--   record_manual_allocation, receive_expense_stock, sale_refunds_check from 20261004002300 / 20261004003000 / 20261004003100;
--   drop policy business_members_not_self_insert / _update; drop trigger business_members_audit; drop function business_members_audit();
--   drop policy <table>_viewer_insert / _update / _delete; drop policy finance_files_viewer on storage.objects; drop function can_write();
--   drop trigger d_documents_checks on documents; drop function documents_more_checks();
--   grant truncate on the tables to anon, authenticated (not recommended).
-- ============================================================================================================================
