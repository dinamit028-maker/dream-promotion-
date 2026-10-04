-- ============================================================================
-- Migration 20261004002000 — multi-business, stage 2: every row belongs to a business (additive only)
--   * business_id (nullable for now) on 23 tables, FK -> businesses, indexed. user_id stays ("who created").
--   * profiles.current_business_id — the business a user is working in (the switcher, stage 7)
--   * business_for_user(uid) + trigger fill_business_id: an insert without business_id gets the
--     creator's current business — so the app keeps working unchanged until its code sends business_id.
--   * one row per business for the settings tables: unique (business_id). Their primary key stays
--     user_id until the app code stops upserting by user_id (stage 7).
--   * document numbering per business: counters keyed by (business_id, doc_type), the issue trigger
--     counts by business, and documents get unique (business_id, doc_type, doc_number).
--   * issued documents stay locked; the ONLY change allowed is attaching business_id once (null -> value).
-- No "drop" statements (the Supabase MCP holds them for approval). Idempotent.
-- NOT NULL is set by a separate migration after the backfill is verified.
-- ============================================================================
alter table public.profiles add column if not exists current_business_id uuid references public.businesses on delete set null;

do $$ declare t text; begin
  foreach t in array array[
    'social_accounts','brands','content','media','scheduled_posts','social_posts','ad_drafts','leads','lead_activities','ai_generations','usage',
    'booking_settings','booking_services','appointments','catalog_items','sales','documents','document_counters','register_settings','register_shifts',
    'employees','time_entries','timeclock_settings'] loop
    execute format('alter table public.%I add column if not exists business_id uuid references public.businesses on delete restrict', t);
    execute format('create index if not exists %I on public.%I (business_id)', t || '_business_idx', t);
  end loop;
end $$;

-- the business a user's new rows go to: the one they chose (if they may use it), else their first membership (owner first)
create or replace function public.business_for_user(uid uuid) returns uuid
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select p.current_business_id from public.profiles p
      where p.id = uid and p.current_business_id is not null
        and (p.is_super_admin or exists (select 1 from public.business_members m where m.user_id = uid and m.business_id = p.current_business_id))),
    (select m.business_id from public.business_members m where m.user_id = uid order by (m.role = 'owner') desc, m.created_at limit 1));
$$;
revoke execute on function public.business_for_user(uuid) from public, anon;
grant execute on function public.business_for_user(uuid) to authenticated, service_role;

create or replace function public.fill_business_id() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.business_id is null and new.user_id is not null then new.business_id := public.business_for_user(new.user_id); end if;
  return new;
end $$;
revoke execute on function public.fill_business_id() from public, anon, authenticated;

-- "a_" so it runs before the other BEFORE INSERT triggers (documents_number needs business_id)
do $$ declare t text; begin
  foreach t in array array[
    'social_accounts','brands','content','media','scheduled_posts','social_posts','ad_drafts','leads','lead_activities','ai_generations','usage',
    'booking_settings','booking_services','appointments','catalog_items','sales','documents','document_counters','register_settings','register_shifts',
    'employees','time_entries','timeclock_settings'] loop
    execute format('create or replace trigger a_fill_business_id before insert on public.%I for each row execute function public.fill_business_id()', t);
  end loop;
end $$;

-- one settings row / brand per business
create unique index if not exists brands_business_uq             on public.brands (business_id);
create unique index if not exists register_settings_business_uq  on public.register_settings (business_id);
create unique index if not exists booking_settings_business_uq   on public.booking_settings (business_id);
create unique index if not exists timeclock_settings_business_uq on public.timeclock_settings (business_id);

-- ---- document numbering per business (every business has its own dealer number) ----
create unique index if not exists document_counters_business_uq on public.document_counters (business_id, doc_type);
create unique index if not exists documents_business_number_uq   on public.documents (business_id, doc_type, doc_number);

create or replace function public.documents_before_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare n bigint;
begin
  if new.business_id is null then raise exception 'a document must belong to a business'; end if;
  insert into public.document_counters(user_id, business_id, doc_type, last_no) values (new.user_id, new.business_id, new.doc_type, 0)
    on conflict (business_id, doc_type) do nothing;
  update public.document_counters set last_no = last_no + 1
    where business_id = new.business_id and doc_type = new.doc_type returning last_no into n;
  new.doc_number := n;
  new.issued_at := now();
  new.print_count := 0;
  return new;
end $$;

-- issued documents never change — except attaching the business once, which is bookkeeping, not content
create or replace function public.documents_immutable() returns trigger
language plpgsql set search_path = public as $$
begin
  if tg_op = 'DELETE' then raise exception 'issued documents cannot be deleted (issue a credit invoice instead)'; end if;
  if old.business_id is not null and new.business_id is distinct from old.business_id then
    raise exception 'issued documents cannot be changed (issue a credit invoice instead)';
  end if;
  if (to_jsonb(new) - 'print_count' - 'business_id') <> (to_jsonb(old) - 'print_count' - 'business_id') or new.print_count < old.print_count then
    raise exception 'issued documents cannot be changed (issue a credit invoice instead)';
  end if;
  return new;
end $$;
