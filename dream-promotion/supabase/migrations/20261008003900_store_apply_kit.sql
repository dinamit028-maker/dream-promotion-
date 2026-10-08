-- ============================================================================================================================
-- 2.73 — a kit applied in one transaction (the Master Spec's section 53: "applyKit אינו transaction מלא").
-- Until now the dashboard's applyKit wrote step by step — collections, pages, the pages the owner chose to replace, menus,
-- the theme draft, and the first publish — each through the existing tables and their row-level security; a failure in the
-- middle left what was already written ("a second run creates only what is still missing").
-- store_apply_kit does the same writes, in the same order, through the same tables — as the caller (security invoker: the
-- row-level security, the triggers and the checks of each table are exactly those of the browser's writes) — in one call,
-- so one transaction: a failure anywhere leaves nothing behind, and the error names the step.
-- No new table, no new column; nothing is dropped or deleted. The dashboard falls back to its step-by-step writes while this
-- function is not on the database (so it works before and after the migration).
-- Tested on a local Postgres 16: tests/sql/store-apply-kit.check.sql (with every existing check).
-- Applied to the live database only after the owner's explicit approval.
-- ============================================================================================================================

-- p_plan (the dashboard's kitPayload, kits.ts):
--   { "collections": [{ title, slug, description, image_url, kind, rules, sort, publish_online, seo_title, seo_description }],
--     "pages":       [{ kind, policy, slug, title, body, seo_title, seo_description, published }],
--     "replace":     [{ "id": <page id>, "row": { …the same fields as a page… } }],
--     "menus":       [{ "kind": "main" | "footer", "items": [ … ] }],
--     "draft":       { "id": <the draft's id> | null, "template": "kit", "settings": { … }, "note": "…" },
--     "publish":     true | false }
-- returns { collections, pages, replacedPages, menus, version, published } — what was written, as KitApplied.
create or replace function public.store_apply_kit(p_store uuid, p_plan jsonb) returns jsonb
language plpgsql set search_path = public as $$
declare
  step text := 'החנות';
  c jsonb; p jsonb; m jsonb;
  d jsonb := coalesce(p_plan->'draft', '{}'::jsonb);
  pos int; v uuid; ver int;
  n_col int := 0; n_pages int := 0; n_replaced int := 0; n_menus int := 0; done_publish boolean := false;
begin
  if jsonb_typeof(p_plan) is distinct from 'object' then raise exception 'a plan is an object' using errcode = '22023'; end if;
  -- the store, as the caller sees it (row-level security): another business's store is "not found"
  if not exists (select 1 from public.stores where id = p_store) then raise exception 'store not found' using errcode = '42501'; end if;

  for c in select e from jsonb_array_elements(coalesce(p_plan->'collections', '[]'::jsonb)) as t(e) loop
    step := format('הקולקציה "%s"', c->>'title');
    -- a new collection comes last on the site (as saveCollection: the caller's own collections)
    select coalesce(max(position), -1) + 1 into pos from public.catalog_collections;
    insert into public.catalog_collections (title, slug, description, image_url, kind, rules, sort, publish_online, seo_title, seo_description, position)
    values (c->>'title', c->>'slug', coalesce(c->>'description', ''), coalesce(c->>'image_url', ''), coalesce(c->>'kind', 'manual'),
            coalesce(c->'rules', '{}'::jsonb), coalesce(c->>'sort', 'manual'), coalesce((c->>'publish_online')::boolean, false),
            coalesce(c->>'seo_title', ''), coalesce(c->>'seo_description', ''), pos);
    n_col := n_col + 1;
  end loop;

  for p in select e from jsonb_array_elements(coalesce(p_plan->'pages', '[]'::jsonb)) as t(e) loop
    step := format('העמוד "%s"', p->>'title');
    insert into public.store_pages (store_id, kind, policy, slug, title, body, seo_title, seo_description, published)
    values (p_store, coalesce(p->>'kind', 'page'), p->>'policy', p->>'slug', p->>'title', coalesce(p->>'body', ''),
            coalesce(p->>'seo_title', ''), coalesce(p->>'seo_description', ''), coalesce((p->>'published')::boolean, false));
    n_pages := n_pages + 1;
  end loop;

  for p in select e from jsonb_array_elements(coalesce(p_plan->'replace', '[]'::jsonb)) as t(e) loop
    step := format('העמוד "%s"', p->'row'->>'title');
    update public.store_pages set
      kind = coalesce(p->'row'->>'kind', 'page'), policy = p->'row'->>'policy', slug = p->'row'->>'slug', title = p->'row'->>'title',
      body = coalesce(p->'row'->>'body', ''), seo_title = coalesce(p->'row'->>'seo_title', ''),
      seo_description = coalesce(p->'row'->>'seo_description', ''), published = coalesce((p->'row'->>'published')::boolean, false)
    where id = (p->>'id')::uuid and store_id = p_store;
    if not found then raise exception 'page not found' using errcode = '42501'; end if;
    n_replaced := n_replaced + 1;
  end loop;

  for m in select e from jsonb_array_elements(coalesce(p_plan->'menus', '[]'::jsonb)) as t(e) loop
    step := 'התפריט';
    insert into public.store_menus (store_id, kind, items) values (p_store, m->>'kind', coalesce(m->'items', '[]'::jsonb))
    on conflict (store_id, kind) do update set items = excluded.items;
    n_menus := n_menus + 1;
  end loop;

  step := 'העיצוב';
  if d->>'id' is not null then
    update public.store_theme_versions set settings = d->'settings', template = d->>'template', note = coalesce(d->>'note', note)
    where id = (d->>'id')::uuid and store_id = p_store and status = 'draft'
    returning id, version into v, ver;
    if v is null then raise exception 'draft not found' using errcode = '42501'; end if;
  else
    insert into public.store_theme_versions (store_id, template, settings, note)
    values (p_store, d->>'template', d->'settings', coalesce(d->>'note', ''))
    returning id, version into v, ver;
  end if;
  if coalesce((p_plan->>'publish')::boolean, false) then
    perform public.store_publish_theme(v);
    done_publish := true;
  end if;

  return jsonb_build_object('collections', n_col, 'pages', n_pages, 'replacedPages', n_replaced, 'menus', n_menus,
                            'version', ver, 'published', done_publish);
exception when others then
  -- one transaction: nothing above stays; the message names the step (the dashboard shows it), the code stays the same
  raise exception using message = step || ' — ' || sqlerrm, errcode = sqlstate;
end $$;
revoke execute on function public.store_apply_kit(uuid, jsonb) from public, anon;
grant execute on function public.store_apply_kit(uuid, jsonb) to authenticated;
