-- ============================================================================================================================
-- Migration 20261010004600 — locations and registers (docs/FINANCE_ADDITIONS_HE.md, T12א; 2.91.0)
-- Prepared only: NOT applied to the live database (needs the owner's explicit approval). Run it in the SQL Editor: it drops the
-- per-user "one open shift" index and the two "no overlapping appointments" rules (each replaced below by a rule per register /
-- per location), and the MCP stops on the word drop. Tested on a local Postgres: tests/sql/locations.check.sql,
-- tests/sql/concurrency.sh §17 and tests/sql/locations-compare.sh (a business with one location sees what it saw before).
--
--   1. locations   business_locations: a business's stores, branches, warehouses and clinics — up to 10. Every business has its
--                  MAIN location, whose id is the business's own id: made here for every business, and by a trigger for a new
--                  one. A row with no location (location_id null) is the main location's — coalesce(location_id, business_id)
--                  is a row's location, with no join. Nothing that exists is updated (documents and payments never change).
--   2. registers   registers: the cash registers of a location (a name, the device it stands on) — up to 10 a location. The
--                  main location's first register has the business's id too: a sale or a shift with no register is its.
--   3. columns     location_id on sales, register_shifts, sale_refunds, documents, document_drafts, payments, expenses,
--                  appointments, orders and stores (where the store's orders go); register_id on sales, register_shifts and
--                  sale_refunds. A row's location is set when it is written — from its register, its sale, the document it pays,
--                  its draft, its expense, its store; else the location the user works in; else the main one — and never moves.
--   4. who sees    business_members.locations: a member limited to some locations (null = all; set by the super admin, like a
--                  role). profiles.current_location_id: the switch at the top of the screen (null = all). A RESTRICTIVE policy
--                  on every table above: a signed-in user reads and writes only rows of the locations they see now — the same
--                  way the business switch works (20261004002500), so no screen filters by itself. A row written on a member's
--                  behalf (also by a function) must be in a location the member may use.
--   5. shifts      one open shift per register (instead of one per user: two registers are opened apart). Appointments: no
--                  overlap within a location (instead of the business, or the user who booked) — two clinics book one hour.
--   6. documents   numbering stays one series per business (the law: one per dealer number). When the business has more than
--                  one active location, a document's issuer snapshot names its location, and so does the printed document.
-- No row is removed and no existing row is changed. The rollback is a comment at the end.
-- ============================================================================================================================

-- ---- 1. locations --------------------------------------------------------------------------------------------------------------
create table if not exists public.business_locations (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  name        text not null check (length(btrim(name)) between 1 and 60),
  kind        text not null default 'branch' check (kind in ('store', 'branch', 'warehouse', 'clinic')),
  address     text not null default '' check (length(address) <= 200),
  phone       text not null default '' check (phone ~ '^[0-9+\- ]{0,20}$'),
  hours       text not null default '' check (length(hours) <= 300),
  active      boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, business_id)
);
create unique index if not exists business_locations_name_uq on public.business_locations (business_id, lower(btrim(name)));
create index if not exists business_locations_business_idx on public.business_locations (business_id, sort);

-- ---- 2. registers --------------------------------------------------------------------------------------------------------------
create table if not exists public.registers (
  id          uuid primary key default gen_random_uuid(),
  business_id uuid not null references public.businesses on delete restrict,
  location_id uuid not null,
  name        text not null check (length(btrim(name)) between 1 and 40),
  device      text not null default '' check (length(device) <= 80),
  active      boolean not null default true,
  sort        int not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (id, business_id),
  foreign key (location_id, business_id) references public.business_locations (id, business_id) on delete restrict
);
create unique index if not exists registers_name_uq on public.registers (location_id, lower(btrim(name)));
create index if not exists registers_business_idx on public.registers (business_id, location_id, sort);

-- every business: its main location and its main register, with the business's own id
insert into public.business_locations (id, business_id, name) select b.id, b.id, 'ראשי' from public.businesses b on conflict (id) do nothing;
insert into public.registers (id, business_id, location_id, name) select b.id, b.id, b.id, 'קופה 1' from public.businesses b on conflict (id) do nothing;

create or replace function public.business_main_location() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.business_locations (id, business_id, name) values (new.id, new.id, 'ראשי') on conflict (id) do nothing;
  insert into public.registers (id, business_id, location_id, name) values (new.id, new.id, new.id, 'קופה 1') on conflict (id) do nothing;
  return null;
end $$;
revoke execute on function public.business_main_location() from public, anon, authenticated;
create or replace trigger z_business_main_location after insert on public.businesses
  for each row execute function public.business_main_location();

-- what never changes, the limits, and a location / register that is still in use
create or replace function public.business_locations_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.name := btrim(new.name);
  new.address := btrim(new.address);
  new.phone := btrim(new.phone);
  new.updated_at := now();
  if tg_op = 'INSERT' then
    perform 1 from public.businesses b where b.id = new.business_id for update;      -- one writer of a business's locations
    if (select count(*) from public.business_locations l where l.business_id = new.business_id) >= 10 then
      raise exception 'locations_limit: up to 10 locations' using errcode = '23514';
    end if;
    new.created_at := now();
    return new;
  end if;
  if new.id <> old.id or new.business_id <> old.business_id or new.created_at <> old.created_at then
    raise exception 'a location keeps its business' using errcode = '23514';
  end if;
  if old.active and not new.active then
    perform 1 from public.businesses b where b.id = new.business_id for update;
    if not exists (select 1 from public.business_locations l where l.business_id = new.business_id and l.active and l.id <> new.id) then
      raise exception 'locations_last: one active location stays' using errcode = '23514';
    end if;
    if exists (select 1 from public.register_shifts s where s.business_id = new.business_id and s.closed_at is null
                and coalesce(s.location_id, s.business_id) = new.id) then
      raise exception 'location_open_shift: close the open days of its registers first' using errcode = '23514';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.business_locations_guard() from public, anon, authenticated;
create or replace trigger b_business_locations_guard before insert or update on public.business_locations
  for each row execute function public.business_locations_guard();
create or replace trigger business_locations_no_delete before delete on public.business_locations
  for each row execute function public.finance_append_only();

create or replace function public.registers_guard() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  new.name := btrim(new.name);
  new.device := btrim(new.device);
  new.updated_at := now();
  if tg_op = 'INSERT' then
    perform 1 from public.business_locations l where l.id = new.location_id for update;   -- one writer of a location's registers
    if (select count(*) from public.registers r where r.location_id = new.location_id) >= 10 then
      raise exception 'registers_limit: up to 10 registers a location' using errcode = '23514';
    end if;
    new.created_at := now();
    return new;
  end if;
  if new.id <> old.id or new.business_id <> old.business_id or new.location_id <> old.location_id or new.created_at <> old.created_at then
    raise exception 'a register keeps its location' using errcode = '23514';
  end if;
  if new.active and not old.active
     and not exists (select 1 from public.business_locations l where l.id = new.location_id and l.active) then
    raise exception 'register_location_inactive: its location is not active' using errcode = '23514';
  end if;
  if old.active and not new.active
     and exists (select 1 from public.register_shifts s where s.business_id = new.business_id and s.closed_at is null
                  and coalesce(s.register_id, s.business_id) = new.id) then
    raise exception 'register_open_shift: close its open day first' using errcode = '23514';
  end if;
  return new;
end $$;
revoke execute on function public.registers_guard() from public, anon, authenticated;
create or replace trigger b_registers_guard before insert or update on public.registers
  for each row execute function public.registers_guard();
create or replace trigger registers_no_delete before delete on public.registers
  for each row execute function public.finance_append_only();

-- ---- 3. columns ----------------------------------------------------------------------------------------------------------------
do $$
declare t text;
begin
  foreach t in array array['sales', 'register_shifts', 'sale_refunds', 'documents', 'document_drafts', 'payments', 'expenses',
                           'appointments', 'orders', 'stores'] loop
    execute format('alter table public.%I add column if not exists location_id uuid', t);
    if not exists (select 1 from pg_constraint where conname = t || '_location_fkey' and conrelid = ('public.' || t)::regclass) then
      execute format('alter table public.%I add constraint %I foreign key (location_id, business_id) references public.business_locations (id, business_id) on delete restrict',
        t, t || '_location_fkey');
    end if;
    if t <> 'stores' then
      execute format('create index if not exists %I on public.%I (business_id, (coalesce(location_id, business_id)))', t || '_location_idx', t);
    end if;
  end loop;
  foreach t in array array['sales', 'register_shifts', 'sale_refunds'] loop
    execute format('alter table public.%I add column if not exists register_id uuid', t);
    if not exists (select 1 from pg_constraint where conname = t || '_register_fkey' and conrelid = ('public.' || t)::regclass) then
      execute format('alter table public.%I add constraint %I foreign key (register_id, business_id) references public.registers (id, business_id) on delete restrict',
        t, t || '_register_fkey');
    end if;
  end loop;
end $$;

-- a member limited to some locations (null = all of them); set by the super admin, like the role
alter table public.business_members add column if not exists locations uuid[];
-- the switch at the top of the screen: the location the user works in now (null = all they may see)
alter table public.profiles add column if not exists current_location_id uuid references public.business_locations on delete set null;

create or replace function public.business_members_locations() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.locations is not null then
    select array_agg(distinct x order by x) into new.locations from unnest(new.locations) x where x is not null;
    if new.locations is null then
      raise exception 'member_locations: at least one location, or none for all of them' using errcode = '22023';
    end if;
    if exists (select 1 from unnest(new.locations) x
                where not exists (select 1 from public.business_locations l where l.id = x and l.business_id = new.business_id)) then
      raise exception 'member_locations: a location of the business' using errcode = '22023';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.business_members_locations() from public, anon, authenticated;
create or replace trigger b_business_members_locations before insert or update of locations on public.business_members
  for each row execute function public.business_members_locations();

-- the log of the business: who limited whom to which locations
create or replace function public.business_members_locations_audit() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.locations is distinct from old.locations then
    perform public.finance_log(new.business_id, 'member.locations', 'business_members', new.user_id::text,
      jsonb_build_object('locations', coalesce(to_jsonb(new.locations), 'null'::jsonb), 'was', coalesce(to_jsonb(old.locations), 'null'::jsonb)));
  end if;
  return null;
end $$;
revoke execute on function public.business_members_locations_audit() from public, anon, authenticated;
create or replace trigger business_members_locations_audit after update of locations on public.business_members
  for each row execute function public.business_members_locations_audit();

-- ---- 4. who sees what ----------------------------------------------------------------------------------------------------------
-- the locations the caller may use in the business they work in now: null = every one (no limit, or the super admin)
create or replace function public.my_locations() returns uuid[]
language sql stable security definer set search_path = public as $$
  select case when public.is_super_admin() then null
    else (select m.locations from public.business_members m where m.user_id = auth.uid() and m.business_id = public.current_business_id()) end;
$$;
-- the location the caller picked at the top: one of the business they work in now, and one they may use — else null (all)
create or replace function public.current_location_id() returns uuid
language sql stable security definer set search_path = public as $$
  select l.id from public.profiles p join public.business_locations l on l.id = p.current_location_id
   where p.id = auth.uid() and l.business_id = public.current_business_id()
     and (public.my_locations() is null or l.id = any (public.my_locations()));
$$;
-- what a signed-in user sees now: null = every location of the business, else these
create or replace function public.location_filter() returns uuid[]
language sql stable security definer set search_path = public as $$
  select case when public.current_location_id() is not null then array[public.current_location_id()] else public.my_locations() end;
$$;
-- may the caller use this location of this business? (the server and SQL have no member to limit)
create or replace function public.location_allowed(p_business uuid, p_location uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select auth.uid() is null or public.is_super_admin()
      or coalesce((select m.locations is null or coalesce(p_location, p_business) = any (m.locations)
                     from public.business_members m where m.user_id = auth.uid() and m.business_id = p_business), false);
$$;
-- where a new row goes when nothing it belongs to says: the location the user works in (picked, or the only one they may use),
-- else the main location while it is active, else the first active one
create or replace function public.location_pick(p_business uuid) returns uuid
language plpgsql stable security definer set search_path = public as $$
declare cur uuid; mine uuid[]; pick uuid;
begin
  if auth.uid() is not null and p_business = public.current_business_id() then
    cur := public.current_location_id();
    if cur is not null then return cur; end if;
    mine := public.my_locations();
    if mine is not null then
      select l.id into pick from public.business_locations l where l.business_id = p_business and l.id = any (mine)
       order by l.active desc, (l.id = p_business) desc, l.sort, l.created_at limit 1;
      if pick is not null then return pick; end if;
    end if;
  end if;
  select l.id into pick from public.business_locations l where l.business_id = p_business
   order by l.active desc, (l.id = p_business) desc, l.sort, l.created_at limit 1;
  return pick;
end $$;
revoke execute on function public.my_locations(), public.current_location_id(), public.location_filter(),
  public.location_allowed(uuid, uuid), public.location_pick(uuid) from public, anon;
grant execute on function public.my_locations(), public.current_location_id(), public.location_filter(),
  public.location_allowed(uuid, uuid) to authenticated, service_role;
grant execute on function public.location_pick(uuid) to service_role;

-- a row's location and register, when it is written: what it belongs to decides; it never moves afterwards
create or replace function public.location_fill() returns trigger
language plpgsql security definer set search_path = public as $$
declare loc uuid; rloc uuid; rb uuid; ractive boolean;
begin
  if tg_op = 'UPDATE' then
    if new.location_id is distinct from old.location_id then
      raise exception 'location_fixed: a row keeps its location' using errcode = '23514';
    end if;
    if tg_table_name in ('sales', 'register_shifts', 'sale_refunds') and to_jsonb(new) ->> 'register_id' is distinct from to_jsonb(old) ->> 'register_id' then
      raise exception 'location_fixed: a row keeps its register' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.business_id is null then return new; end if;   -- the business's own checks refuse it

  -- a register decides its location (sales, shifts, refunds)
  if tg_table_name in ('sales', 'register_shifts', 'sale_refunds') then
    if tg_table_name = 'register_shifts' and new.register_id is null then
      -- a day opened before registers (an older screen): the location's first register, else the main one
      select r.id into new.register_id from public.registers r
       where r.business_id = new.business_id and r.active
         and r.location_id = coalesce(new.location_id, public.location_pick(new.business_id))
       order by (r.id = new.business_id) desc, r.sort, r.created_at limit 1;
    end if;
    if new.register_id is not null then
      select r.location_id, r.business_id, r.active and l.active into rloc, rb, ractive
        from public.registers r join public.business_locations l on l.id = r.location_id where r.id = new.register_id;
      if rloc is null or rb <> new.business_id then raise exception 'register_not_found' using errcode = '23503'; end if;
      -- a register closed down (or in a closed location) sells and opens no day; a refund of its old sale still goes there
      if not ractive and tg_table_name <> 'sale_refunds' then
        raise exception 'register_inactive: this register is closed down' using errcode = '23514';
      end if;
      if new.location_id is not null and new.location_id <> rloc then
        raise exception 'location_mismatch: a register stands in one location' using errcode = '23514';
      end if;
      loc := rloc;
    end if;
  end if;

  if loc is null then
    case tg_table_name
      when 'sale_refunds' then
        -- a refund is its sale's; the register that paid it out is the one given, else the sale's
        select coalesce(s.location_id, s.business_id), coalesce(new.register_id, s.register_id) into loc, new.register_id
          from public.sales s where s.id = new.sale_id;
      when 'sales' then
        -- an online sale has its order's id: the order's location (the store's)
        select coalesce(o.location_id, o.business_id) into loc from public.orders o where o.id = new.id and o.business_id = new.business_id;
      when 'documents' then
        select coalesce(
          (select coalesce(s.location_id, s.business_id) from public.sales s where s.id = new.sale_id),
          (select coalesce(r.location_id, r.business_id) from public.sale_refunds r where r.id = new.refund_id),
          (select coalesce(d.location_id, d.business_id) from public.documents d where d.id = new.paid_document_id),
          (select coalesce(d.location_id, d.business_id) from public.document_drafts d where d.id = new.draft_id),
          (select coalesce(d.location_id, d.business_id) from public.documents d
            where new.base_doc_number is not null and d.business_id = new.business_id and d.doc_type = new.base_doc_type
              and d.doc_number = new.base_doc_number limit 1)) into loc;
      when 'payments' then
        select coalesce(
          (select coalesce(d.location_id, d.business_id) from public.documents d where d.id = new.document_id),
          (select coalesce(d.location_id, d.business_id) from public.documents d where d.id = new.applies_to),
          (select coalesce(r.location_id, r.business_id) from public.sale_refunds r where r.id = new.refund_id),
          (select coalesce(s.location_id, s.business_id) from public.sales s where s.id = new.sale_id),
          (select coalesce(e.location_id, e.business_id) from public.expenses e where e.id = new.expense_id)) into loc;
      when 'orders' then
        select s.location_id into loc from public.stores s where s.id = new.store_id;
      else null;
    end case;
  end if;

  -- what the row was given, else what it belongs to, else where the user works, else the main location
  new.location_id := coalesce(new.location_id, loc, public.location_pick(new.business_id));
  if new.location_id is not null and loc is not null and new.location_id <> loc then
    raise exception 'location_mismatch: a row goes where what it belongs to is' using errcode = '23514';
  end if;
  -- a member limited to some locations writes only there — also through a function that writes on their behalf
  if not public.location_allowed(new.business_id, new.location_id) then
    raise exception 'not allowed: this location is not yours' using errcode = '42501';
  end if;
  return new;
end $$;
revoke execute on function public.location_fill() from public, anon, authenticated;

do $$
declare t text;
begin
  -- "a_location_fill": after a_fill_business_id (it fills an empty business_id), before every b_ / c_ / d_ check
  foreach t in array array['sales', 'register_shifts', 'sale_refunds', 'document_drafts', 'expenses', 'appointments', 'orders'] loop
    execute format('create or replace trigger a_location_fill before insert or update on public.%I for each row execute function public.location_fill()', t);
  end loop;
  -- documents and payments never change (their own triggers refuse any update): insert only
  foreach t in array array['documents', 'payments'] loop
    execute format('create or replace trigger a_location_fill before insert on public.%I for each row execute function public.location_fill()', t);
  end loop;
end $$;

-- the switch: the location the caller works in from now on (null = all they may use)
create or replace function public.location_select(p_location uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.current_business_id(); mine uuid[] := public.my_locations();
begin
  if auth.uid() is null or b is null or b not in (select public.accessible_business_ids()) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  if p_location is not null then
    if not exists (select 1 from public.business_locations l where l.id = p_location and l.business_id = b) then
      raise exception 'location_not_found' using errcode = '22023';
    end if;
    if mine is not null and not (p_location = any (mine)) then raise exception 'not allowed' using errcode = '42501'; end if;
  end if;
  update public.profiles set current_location_id = p_location where id = auth.uid();
  return jsonb_build_object('location', p_location);
end $$;

-- the business's owner (full access) — or the super admin — shapes its locations and registers
create or replace function public.location_owner() returns boolean
language sql stable security definer set search_path = public as $$
  select public.is_super_admin()
      or exists (select 1 from public.business_members m where m.user_id = auth.uid() and m.business_id = public.current_business_id()
                  and m.role = 'owner' and m.access = 'full' and m.locations is null);
$$;

-- what the screens need: the locations and registers the caller may use, the one picked, who may change them
create or replace function public.location_state() returns jsonb
language sql stable security definer set search_path = public as $$
  select jsonb_build_object(
    'business', public.current_business_id(),
    'current', public.current_location_id(),
    'limited', public.my_locations() is not null,
    'owner', public.location_owner(),
    'locations', coalesce((select jsonb_agg(jsonb_build_object('id', l.id, 'name', l.name, 'kind', l.kind, 'address', l.address,
        'phone', l.phone, 'hours', l.hours, 'active', l.active, 'sort', l.sort, 'main', l.id = l.business_id)
        order by (l.id = l.business_id) desc, l.sort, l.created_at)
      from public.business_locations l
      where l.business_id = public.current_business_id()
        and (public.my_locations() is null or l.id = any (public.my_locations()))), '[]'::jsonb),
    'registers', coalesce((select jsonb_agg(jsonb_build_object('id', r.id, 'location', r.location_id, 'name', r.name, 'device', r.device,
        'active', r.active, 'sort', r.sort, 'main', r.id = r.business_id)
        order by (r.id = r.business_id) desc, r.sort, r.created_at)
      from public.registers r
      where r.business_id = public.current_business_id()
        and (public.my_locations() is null or r.location_id = any (public.my_locations()))), '[]'::jsonb))
  where public.current_business_id() in (select public.accessible_business_ids());
$$;



-- a location: a new one (its id may be chosen by the screen — a second try is the same location), or a change to one
create or replace function public.location_save(p_id uuid, p_name text, p_kind text, p_address text, p_phone text, p_hours text,
                                                p_active boolean, p_sort int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.current_business_id(); cur record; made boolean := false;
begin
  if b is null or not public.location_owner() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  select * into cur from public.business_locations l where l.id = p_id;   -- no row (a new one, or no id): its fields are null
  if cur.id is not null and cur.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if cur.id is null then
    insert into public.business_locations (id, business_id, name, kind, address, phone, hours, active, sort)
    values (coalesce(p_id, gen_random_uuid()), b, coalesce(p_name, ''), coalesce(p_kind, 'branch'), coalesce(p_address, ''), coalesce(p_phone, ''),
            coalesce(p_hours, ''), coalesce(p_active, true), coalesce(p_sort, 0))
    returning * into cur;
    made := true;
    -- a place that sells gets its first register (a warehouse sells nothing)
    if cur.kind <> 'warehouse' then
      insert into public.registers (business_id, location_id, name) values (b, cur.id, 'קופה 1');
    end if;
    perform public.finance_log(b, 'location.created', 'business_locations', cur.id::text, jsonb_build_object('name', cur.name, 'kind', cur.kind));
  else
    update public.business_locations set name = coalesce(p_name, name), kind = coalesce(p_kind, kind), address = coalesce(p_address, address),
           phone = coalesce(p_phone, phone), hours = coalesce(p_hours, hours), active = coalesce(p_active, active), sort = coalesce(p_sort, sort)
     where id = cur.id returning * into cur;
    perform public.finance_log(b, 'location.changed', 'business_locations', cur.id::text,
      jsonb_build_object('name', cur.name, 'kind', cur.kind, 'active', cur.active));
  end if;
  return jsonb_build_object('id', cur.id, 'created', made);
end $$;

-- a register: a new one in a location (the id may be chosen by the screen), or a change to one
create or replace function public.register_save(p_id uuid, p_location uuid, p_name text, p_device text, p_active boolean, p_sort int) returns jsonb
language plpgsql security definer set search_path = public as $$
declare b uuid := public.current_business_id(); cur record; made boolean := false;
begin
  if b is null or not public.location_owner() then raise exception 'not allowed' using errcode = '42501'; end if;
  if not public.business_is_active(b) then raise exception 'business_locked' using errcode = '42501'; end if;
  select * into cur from public.registers r where r.id = p_id;   -- no row (a new one, or no id): its fields are null
  if cur.id is not null and cur.business_id <> b then raise exception 'not allowed' using errcode = '42501'; end if;
  if cur.id is null then
    if not exists (select 1 from public.business_locations l where l.id = p_location and l.business_id = b and l.active) then
      raise exception 'register_location: an active location of the business' using errcode = '22023';
    end if;
    insert into public.registers (id, business_id, location_id, name, device, active, sort)
    values (coalesce(p_id, gen_random_uuid()), b, p_location, coalesce(p_name, ''), coalesce(p_device, ''), coalesce(p_active, true), coalesce(p_sort, 0))
    returning * into cur;
    made := true;
    perform public.finance_log(b, 'register.created', 'registers', cur.id::text, jsonb_build_object('name', cur.name, 'location', cur.location_id));
  else
    update public.registers set name = coalesce(p_name, name), device = coalesce(p_device, device), active = coalesce(p_active, active),
           sort = coalesce(p_sort, sort)
     where id = cur.id returning * into cur;
    perform public.finance_log(b, 'register.changed', 'registers', cur.id::text, jsonb_build_object('name', cur.name, 'active', cur.active));
  end if;
  return jsonb_build_object('id', cur.id, 'created', made);
end $$;

revoke execute on function public.location_select(uuid), public.location_state(), public.location_owner(),
  public.location_save(uuid, text, text, text, text, text, boolean, int), public.register_save(uuid, uuid, text, text, boolean, int) from public, anon;
grant execute on function public.location_select(uuid), public.location_state(), public.location_owner(),
  public.location_save(uuid, text, text, text, text, text, boolean, int), public.register_save(uuid, uuid, text, text, boolean, int) to authenticated;

-- the two new tables: members read the business's (only the locations they may use); writes go through the functions above
do $$
declare
  t text;
  gate constant text := 'business_id = (select public.current_business_id()) and business_id in (select public.accessible_business_ids())';
begin
  foreach t in array array['business_locations', 'registers'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from anon', t);
    execute format('revoke insert, update, delete, truncate on public.%I from authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_gate') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_business_gate', t, gate, gate);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_member_limit') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using ((select public.my_locations()) is null or %s = any ((select public.my_locations())::uuid[]))',
        t || '_member_limit', t, case t when 'registers' then 'location_id' else 'id' end);
    end if;
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_business_read') then
      execute format('create policy %I on public.%I for select to authenticated using (%s)', t || '_business_read', t, gate);
    end if;
  end loop;

  -- the rows of the locations: a signed-in user reads and writes only those of the locations they see now
  foreach t in array array['sales', 'register_shifts', 'sale_refunds', 'documents', 'document_drafts', 'payments', 'expenses', 'appointments', 'orders'] loop
    if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = t and policyname = t || '_location_gate') then
      execute format('create policy %I on public.%I as restrictive for all to authenticated using (%s) with check (%s)', t || '_location_gate', t,
        '(select public.location_filter()) is null or coalesce(location_id, business_id) = any ((select public.location_filter())::uuid[])',
        '(select public.location_filter()) is null or coalesce(location_id, business_id) = any ((select public.location_filter())::uuid[])');
    end if;
  end loop;
end $$;

-- ---- 5. one open shift per register; appointments do not overlap within a location -------------------------------------------
drop index if exists public.register_shifts_one_open_idx;
create unique index if not exists register_shifts_one_open_register_idx on public.register_shifts (register_id)
  where closed_at is null and register_id is not null;
-- a day opened before registers (no register) is the main register's: one open day there too, whoever opened it
create or replace function public.register_shifts_one_open() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.closed_at is null then
    perform 1 from public.registers r where r.id = coalesce(new.register_id, new.business_id) for update;
    if exists (select 1 from public.register_shifts s where s.business_id = new.business_id and s.closed_at is null and s.id <> new.id
                and coalesce(s.register_id, s.business_id) = coalesce(new.register_id, new.business_id)) then
      raise exception 'register_shifts_one_open: this register already has an open day' using errcode = '23505';
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.register_shifts_one_open() from public, anon, authenticated;
create or replace trigger b_register_shifts_one_open before insert on public.register_shifts
  for each row execute function public.register_shifts_one_open();

alter table public.appointments drop constraint if exists appointments_no_overlap;
alter table public.appointments drop constraint if exists appointments_business_no_overlap;
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'appointments_location_no_overlap') then
    alter table public.appointments add constraint appointments_location_no_overlap
      exclude using gist (business_id with =, (coalesce(location_id, business_id)) with =, tstzrange(start_at, end_at, '[)') with &&)
      where (status in ('booked', 'confirmed'));
  end if;
end $$;

-- ---- 6. a document names its location (more than one active location) ------------------------------------------------------------
-- after c_documents_validate, which takes the issuer snapshot; the numbering (document_counters) stays one per business
create or replace function public.documents_location_issuer() returns trigger
language plpgsql security definer set search_path = public as $$
declare l record;
begin
  if new.issuer is not null
     and (select count(*) from public.business_locations x where x.business_id = new.business_id and x.active) > 1 then
    select x.name, x.address, x.phone into l from public.business_locations x where x.id = coalesce(new.location_id, new.business_id);
    if l.name is not null then
      new.issuer := new.issuer || jsonb_build_object('location', jsonb_build_object('name', l.name, 'address', l.address, 'phone', l.phone));
    end if;
  end if;
  return new;
end $$;
revoke execute on function public.documents_location_issuer() from public, anon, authenticated;
create or replace trigger e_documents_location before insert on public.documents
  for each row execute function public.documents_location_issuer();

-- ============================================================================================================================
-- Rollback (by hand, if ever needed — the locations and registers go, the columns may stay): drop the policies *_location_gate,
--   business_locations_* and registers_*; drop the triggers a_location_fill, e_documents_location, b_register_shifts_one_open,
--   z_business_main_location, b_business_members_locations, business_members_locations_audit; drop the functions of sections 1,
--   4, 5 and 6; recreate register_shifts_one_open_idx (user_id) and the two appointment rules of 20261003001000 / 20261004002500
--   (only while no two open days or overlapping appointments exist); drop table registers, business_locations.
-- ============================================================================================================================
