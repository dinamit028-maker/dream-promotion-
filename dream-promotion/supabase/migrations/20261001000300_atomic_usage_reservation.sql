-- ============================================================================
-- Migration 20261001000300 — atomic quota reservation + rate / concurrency limits
-- Purpose: "check quota → generate → record usage" as separate steps let two requests
--          sent together both pass the check. Now the server reserves the units first,
--          inside one transaction, under a per-user lock:
--            reserve_usage  → ok + row id, or the reason it was refused
--            commit_usage   → the provider accepted the job (status 'running' or 'done')
--            release_usage  → the job failed / was cancelled before costing anything
--            finish_usage   → a running job (video) finished or failed, by provider request id
-- Rows with status 'released' never count toward the quota.
-- Existing rows keep counting: they get status 'done'.
-- Security: the functions are callable ONLY with the service role (execute revoked from
--          anon / authenticated), so a browser can neither reserve nor release.
-- Rollback: drop the four functions; the added columns are harmless and can stay.
-- ============================================================================

alter table public.usage add column if not exists status      text not null default 'done';
alter table public.usage add column if not exists request_id  text;
alter table public.usage add column if not exists updated_at  timestamptz not null default now();
alter table public.usage drop constraint if exists usage_status_check;
alter table public.usage add constraint usage_status_check check (status in ('reserved','running','done','released'));
create index if not exists usage_request_idx on public.usage (request_id) where request_id is not null;
create index if not exists usage_open_idx on public.usage (user_id, kind, status) where status in ('reserved','running');

-- --------------------------------------------------------------- reserve_usage --
create or replace function public.reserve_usage(
  p_user uuid, p_kind text, p_units numeric, p_limit numeric,
  p_max_concurrent int default 0, p_max_per_minute int default 0,
  p_meta jsonb default '{}'::jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_used numeric;
  v_open int;
  v_recent int;
  v_id uuid;
  v_month timestamptz := date_trunc('month', now() at time zone 'utc') at time zone 'utc';
begin
  if p_units is null or p_units <= 0 then
    return jsonb_build_object('ok', false, 'reason', 'bad_units');
  end if;
  -- one user + one kind at a time: concurrent requests queue here instead of racing
  perform pg_advisory_xact_lock(hashtext(coalesce(p_user::text, 'shared') || ':' || p_kind));

  select coalesce(sum(units), 0) into v_used from public.usage
   where user_id is not distinct from p_user and kind = p_kind
     and created_at >= v_month and status <> 'released';
  if p_limit > 0 and v_used + p_units > p_limit then
    return jsonb_build_object('ok', false, 'reason', 'quota_exceeded', 'used', v_used, 'limit', p_limit);
  end if;

  if p_max_concurrent > 0 then
    -- jobs still open; anything older than 30 minutes is considered stuck and ignored
    select count(*) into v_open from public.usage
     where user_id is not distinct from p_user and kind = p_kind
       and status in ('reserved','running') and created_at > now() - interval '30 minutes';
    if v_open >= p_max_concurrent then
      return jsonb_build_object('ok', false, 'reason', 'too_many_running', 'open', v_open, 'max', p_max_concurrent);
    end if;
  end if;

  if p_max_per_minute > 0 then
    select count(*) into v_recent from public.usage
     where user_id is not distinct from p_user and kind = p_kind and created_at > now() - interval '1 minute';
    if v_recent >= p_max_per_minute then
      return jsonb_build_object('ok', false, 'reason', 'rate_limited', 'recent', v_recent, 'max', p_max_per_minute);
    end if;
  end if;

  insert into public.usage (user_id, kind, units, cost_usd, meta, status)
  values (p_user, p_kind, p_units, 0, coalesce(p_meta, '{}'::jsonb), 'reserved')
  returning id into v_id;
  return jsonb_build_object('ok', true, 'id', v_id, 'used', v_used + p_units, 'limit', p_limit);
end $$;

-- ---------------------------------------------------------------- commit_usage --
create or replace function public.commit_usage(
  p_id uuid, p_status text, p_cost numeric default 0, p_request_id text default null, p_meta jsonb default '{}'::jsonb
) returns void
language sql security definer set search_path = public as $$
  update public.usage
     set status = case when p_status in ('running','done') then p_status else 'done' end,
         cost_usd = coalesce(p_cost, 0),
         request_id = coalesce(p_request_id, request_id),
         meta = coalesce(meta, '{}'::jsonb) || coalesce(p_meta, '{}'::jsonb) || case when p_request_id is null then '{}'::jsonb else jsonb_build_object('requestId', p_request_id) end,
         updated_at = now()
   where id = p_id and status = 'reserved';
$$;

-- --------------------------------------------------------------- release_usage --
create or replace function public.release_usage(p_id uuid, p_reason text default null) returns void
language sql security definer set search_path = public as $$
  update public.usage
     set status = 'released', cost_usd = 0, updated_at = now(),
         meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('releaseReason', coalesce(p_reason, ''))
   where id = p_id and status in ('reserved','running');
$$;

-- ---------------------------------------------------------------- finish_usage --
-- p_ok = false with p_refund = true: the provider dropped the job before billing (cancel)
create or replace function public.finish_usage(p_request_id text, p_ok boolean, p_refund boolean default false) returns void
language sql security definer set search_path = public as $$
  update public.usage
     set status = case when p_refund then 'released' else 'done' end,
         cost_usd = case when p_refund then 0 else cost_usd end,
         meta = coalesce(meta, '{}'::jsonb) || jsonb_build_object('result', case when p_ok then 'completed' else 'failed' end),
         updated_at = now()
   where request_id = p_request_id and status in ('reserved','running');
$$;

revoke execute on function public.reserve_usage(uuid, text, numeric, numeric, int, int, jsonb) from public, anon, authenticated;
revoke execute on function public.commit_usage(uuid, text, numeric, text, jsonb)               from public, anon, authenticated;
revoke execute on function public.release_usage(uuid, text)                                     from public, anon, authenticated;
revoke execute on function public.finish_usage(text, boolean, boolean)                          from public, anon, authenticated;
grant  execute on function public.reserve_usage(uuid, text, numeric, numeric, int, int, jsonb) to service_role;
grant  execute on function public.commit_usage(uuid, text, numeric, text, jsonb)               to service_role;
grant  execute on function public.release_usage(uuid, text)                                     to service_role;
grant  execute on function public.finish_usage(text, boolean, boolean)                          to service_role;
