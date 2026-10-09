-- Migration 4100 (client file), the part that runs in the SQL Editor: client_file_purge — the owner deletes a customer's
-- whole client file on request (it contains DELETE, so it is not applied through the MCP). Paste all of it and press Run.
-- Safe to run more than once (create or replace).
-- the owner deletes a customer's whole client file, on request. Returns the storage paths for the server to remove from
-- "client-files". The log keeps who, when and which customer — not the content. Server only (the route checks the user).
create or replace function public.client_file_purge(p_user uuid, p_business uuid, p_lead uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare paths text[]; n jsonb;
begin
  if not public.client_file_owner_for(p_user, p_business) then raise exception 'not allowed' using errcode = '42501'; end if;
  if not exists (select 1 from public.leads l where l.id = p_lead and l.business_id = p_business) then
    raise exception 'not allowed' using errcode = '42501';
  end if;
  select coalesce(array_agg(p), '{}') into paths from (
    select path as p from public.client_photos where business_id = p_business and lead_id = p_lead
    union all select signature_path from public.declarations where business_id = p_business and lead_id = p_lead
    union all select pdf_path from public.declarations where business_id = p_business and lead_id = p_lead) x;
  n := jsonb_build_object(
    'photos', (select count(*) from public.client_photos where business_id = p_business and lead_id = p_lead),
    'declarations', (select count(*) from public.declarations where business_id = p_business and lead_id = p_lead),
    'treatments', (select count(*) from public.client_treatments where business_id = p_business and lead_id = p_lead));
  perform set_config('dream.client_file_purge', 'on', true);
  delete from public.client_photos where business_id = p_business and lead_id = p_lead;
  delete from public.declarations where business_id = p_business and lead_id = p_lead;
  delete from public.declaration_requests where business_id = p_business and lead_id = p_lead;
  delete from public.client_sessions where business_id = p_business and lead_id = p_lead;
  delete from public.client_treatments where business_id = p_business and lead_id = p_lead;
  perform set_config('dream.client_file_purge', '', true);
  insert into public.client_file_views (business_id, user_id, lead_id, object, object_id, action)
  values (p_business, p_user, p_lead, 'client_file', p_lead, 'purge');
  return jsonb_build_object('paths', to_jsonb(paths), 'counts', n);
end $$;
revoke execute on function public.client_file_purge(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function public.client_file_purge(uuid, uuid, uuid) to service_role;
