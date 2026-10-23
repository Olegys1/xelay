-- Reversible exact-scope category removal. Custom categories are archived;
-- built-in formats remain valid post data and gain per-feed filter visibility.
-- No post is deleted, reassigned or removed from the complete news feed.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $$
declare v_signature text;
begin
  foreach v_signature in array array[
    'public.xelay_create_news_category(text,uuid,uuid)',
    'public.xelay_guard_news_post_category()',
    'public.xelay_can_manage_news(uuid,uuid)'
  ] loop
    if to_regprocedure(v_signature) is null then raise exception 'NEWS_CATEGORY_ARCHIVE_PREREQUISITE: %',v_signature; end if;
  end loop;
  if to_regclass('public.news_categories') is null
    or to_regclass('public.news_category_scopes') is not null
    or to_regprocedure('public.xelay_news_category_settings(uuid,uuid)') is not null
    or to_regprocedure('public.xelay_set_news_category_visibility(uuid,uuid,uuid,text,boolean,integer)') is not null
    or exists(select 1 from pg_attribute where attrelid='public.news_categories'::regclass
      and attname in('archived_at','version') and not attisdropped) then
    raise exception 'NEWS_CATEGORY_ARCHIVE_SCHEMA_DRIFT';
  end if;
end $$;

lock table public.news_categories in access exclusive mode;
alter table public.news_categories
  add column archived_at timestamptz,
  add column version integer not null default 1,
  add constraint news_categories_archive_time check(archived_at is null or isfinite(archived_at)),
  add constraint news_categories_version_positive check(version>0);
create index news_categories_active_scope_idx on public.news_categories(university_id,academic_unit_id,name)
  where archived_at is null;

-- Private mutable state for the four existing standard filter chips. NULL,NULL
-- is exactly platform scope; university/faculty ownership never crosses it.
create table public.news_category_scopes(
  id uuid primary key default gen_random_uuid(),
  university_id uuid references public.universities(id) on delete cascade,
  academic_unit_id uuid,
  hidden_types text[] not null default '{}'::text[],
  version integer not null default 0 check(version>=0),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default clock_timestamp(),
  constraint news_category_scopes_shape check(university_id is not null or academic_unit_id is null),
  constraint news_category_scopes_types check(
    hidden_types<@array['news','event','opportunity','announcement']::text[]
    and array_position(hidden_types,null) is null and cardinality(hidden_types)<=4),
  constraint news_category_scopes_unit_fkey foreign key(academic_unit_id,university_id)
    references public.academic_units(id,university_id) on delete cascade
);
create unique index news_category_scopes_unique on public.news_category_scopes(
  coalesce(university_id,'00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(academic_unit_id,'00000000-0000-0000-0000-000000000000'::uuid)
);
alter table public.news_category_scopes enable row level security;
revoke all on table public.news_category_scopes from public,anon,authenticated,service_role;

-- Shared lock order for category creation, archiving and restoration. The
-- existing name lock remains below this scope lock, preserving idempotence.
create function public.xelay_private_lock_news_category_scope(p_university_id uuid,p_academic_unit_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or(p_university_id is null and p_academic_unit_id is not null)
    or not public.xelay_can_manage_news(p_university_id,p_academic_unit_id) then
    raise exception 'NEWS_CATEGORY_EDITOR_REQUIRED' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-news-category-scope:'
    ||coalesce(p_university_id::text,'platform')||':'||coalesce(p_academic_unit_id::text,'university'),0));
  -- Permission may have been revoked while another writer held the scope.
  if not public.xelay_can_manage_news(p_university_id,p_academic_unit_id) then
    raise exception 'NEWS_CATEGORY_EDITOR_REQUIRED' using errcode='42501';
  end if;
  insert into public.news_category_scopes(university_id,academic_unit_id)
    values(p_university_id,p_academic_unit_id) on conflict do nothing;
  perform 1 from public.news_category_scopes s
    where s.university_id is not distinct from p_university_id
      and s.academic_unit_id is not distinct from p_academic_unit_id for update;
  if not found then raise exception 'NEWS_CATEGORY_SCOPE_NOT_FOUND'; end if;
end $$;
revoke all on function public.xelay_private_lock_news_category_scope(uuid,uuid) from public,anon,authenticated,service_role;

-- Read scope matches the existing category SELECT policy. Deliberately no
-- writer metadata is exposed; version zero is the unchanged implicit baseline.
create function public.xelay_news_category_settings(p_university_id uuid,p_academic_unit_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_state public.news_category_scopes%rowtype;
begin
  if auth.uid() is null or(p_university_id is null and p_academic_unit_id is not null)
    or not((p_university_id is null and p_academic_unit_id is null)
      or public.xelay_can_manage_news(p_university_id,p_academic_unit_id)
      or exists(select 1 from public.profiles p where p.id=auth.uid() and p.university_id=p_university_id
        and(p_academic_unit_id is null or p.academic_unit_id=p_academic_unit_id))) then
    raise exception 'NEWS_CATEGORY_SCOPE_FORBIDDEN' using errcode='42501';
  end if;
  select * into v_state from public.news_category_scopes s
    where s.university_id is not distinct from p_university_id
      and s.academic_unit_id is not distinct from p_academic_unit_id;
  return jsonb_build_object(
    'categories',coalesce((select jsonb_agg(jsonb_build_object(
      'id',c.id,'name',c.name,'university_id',c.university_id,'academic_unit_id',c.academic_unit_id,
      'archived_at',c.archived_at,'version',c.version)order by c.name,c.id)
      from public.news_categories c where c.university_id is not distinct from p_university_id
        and c.academic_unit_id is not distinct from p_academic_unit_id),'[]'::jsonb),
    'hidden_types',coalesce(to_jsonb(v_state.hidden_types),'[]'::jsonb),'version',coalesce(v_state.version,0));
end $$;
revoke all on function public.xelay_news_category_settings(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_news_category_settings(uuid,uuid) to authenticated;

create function public.xelay_set_news_category_visibility(
  p_university_id uuid,p_academic_unit_id uuid,p_category_id uuid,p_post_type text,p_hidden boolean,p_expected_version integer
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_state public.news_category_scopes%rowtype;v_category public.news_categories%rowtype;v_hidden text[];
begin
  if p_hidden is null or p_expected_version is null or p_expected_version<0
    or((p_category_id is null)=(p_post_type is null))
    or(p_post_type is not null and p_post_type not in('news','event','opportunity','announcement')) then
    raise exception 'NEWS_CATEGORY_INPUT_INVALID' using errcode='22023';
  end if;
  perform public.xelay_private_lock_news_category_scope(p_university_id,p_academic_unit_id);
  select * into v_state from public.news_category_scopes s
    where s.university_id is not distinct from p_university_id
      and s.academic_unit_id is not distinct from p_academic_unit_id for update;
  if v_state.version is distinct from p_expected_version then
    raise exception 'NEWS_CATEGORY_CONFLICT' using errcode='40001';
  end if;
  if p_category_id is not null then
    select * into v_category from public.news_categories c where c.id=p_category_id
      and c.university_id is not distinct from p_university_id
      and c.academic_unit_id is not distinct from p_academic_unit_id for update;
    if not found then raise exception 'NEWS_CATEGORY_SCOPE_MISMATCH' using errcode='22023'; end if;
    if(v_category.archived_at is not null)=p_hidden then
      return public.xelay_news_category_settings(p_university_id,p_academic_unit_id);
    end if;
    update public.news_categories set archived_at=case when p_hidden then clock_timestamp() end,version=version+1
      where id=v_category.id;
  else
    select coalesce(array_agg(t.name order by t.ordinality),'{}'::text[]) into v_hidden
      from unnest(array['news','event','opportunity','announcement']::text[])with ordinality t(name,ordinality)
      where(t.name=any(v_state.hidden_types)and t.name<>p_post_type)or(t.name=p_post_type and p_hidden);
    if v_hidden is not distinct from v_state.hidden_types then
      return public.xelay_news_category_settings(p_university_id,p_academic_unit_id);
    end if;
  end if;
  update public.news_category_scopes set hidden_types=coalesce(v_hidden,hidden_types),version=version+1,
    updated_by=auth.uid(),updated_at=clock_timestamp() where id=v_state.id;
  return public.xelay_news_category_settings(p_university_id,p_academic_unit_id);
end $$;
revoke all on function public.xelay_set_news_category_visibility(uuid,uuid,uuid,text,boolean,integer) from public,anon,authenticated,service_role;
grant execute on function public.xelay_set_news_category_visibility(uuid,uuid,uuid,text,boolean,integer) to authenticated;

-- Preserve installed signatures, owner/ACLs and all existing validation. Both
-- live definitions and literal anchors normalize CRLF before exact matching.
create function pg_temp.xelay_news_category_archive_patch(p_signature text,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text;v_old text;v_new text;v_count integer;
begin
  if to_regprocedure(p_signature) is null then raise exception 'News archive function missing: %',p_signature; end if;
  v_definition:=replace(pg_get_functiondef(to_regprocedure(p_signature)),chr(13),'');
  v_old:=replace(p_old,chr(13),'');v_new:=replace(p_new,chr(13),'');
  if v_old='' then raise exception 'Empty news category archive anchor'; end if;
  v_count:=(length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old);
  if v_count<>1 then raise exception 'News category archive anchor mismatch for % (matches: %)',p_signature,v_count; end if;
  execute replace(v_definition,v_old,v_new);
end $$;

select pg_temp.xelay_news_category_archive_patch('public.xelay_create_news_category(text,uuid,uuid)',
$old$  perform pg_advisory_xact_lock(hashtextextended('xelay-news-category:'$old$,
$new$  perform public.xelay_private_lock_news_category_scope(p_university_id,p_academic_unit_id);
  perform pg_advisory_xact_lock(hashtextextended('xelay-news-category:'$new$);
select pg_temp.xelay_news_category_archive_patch('public.xelay_create_news_category(text,uuid,uuid)',
$old$      values(v_name,p_university_id,p_academic_unit_id,auth.uid()) returning * into v_category;
  end if;$old$,
$new$      values(v_name,p_university_id,p_academic_unit_id,auth.uid()) returning * into v_category;
    update public.news_category_scopes set version=version+1,updated_by=auth.uid(),updated_at=clock_timestamp()
      where university_id is not distinct from p_university_id and academic_unit_id is not distinct from p_academic_unit_id;
  elsif v_category.archived_at is not null then
    raise exception 'NEWS_CATEGORY_ARCHIVED' using errcode='22023';
  end if;$new$);
select pg_temp.xelay_news_category_archive_patch('public.xelay_create_news_category(text,uuid,uuid)',
$old$'university_id',v_category.university_id,'academic_unit_id',v_category.academic_unit_id);$old$,
$new$'university_id',v_category.university_id,'academic_unit_id',v_category.academic_unit_id,
    'archived_at',v_category.archived_at,'version',v_category.version);$new$);

select pg_temp.xelay_news_category_archive_patch('public.xelay_guard_news_post_category()',
$old$begin
  if new.category_id is null then return new; end if;$old$,
$new$declare v_archived_at timestamptz;
begin
  if new.category_id is null then return new; end if;$new$);
select pg_temp.xelay_news_category_archive_patch('public.xelay_guard_news_post_category()',
$old$  perform 1 from public.news_categories c where c.id=new.category_id
    and c.university_id is not distinct from new.university_id
    and c.academic_unit_id is not distinct from new.academic_unit_id for key share;
  if not found then raise exception 'NEWS_CATEGORY_SCOPE_MISMATCH' using errcode='22023'; end if;$old$,
$new$  select c.archived_at into v_archived_at from public.news_categories c where c.id=new.category_id
    and c.university_id is not distinct from new.university_id
    and c.academic_unit_id is not distinct from new.academic_unit_id for share;
  if not found then raise exception 'NEWS_CATEGORY_SCOPE_MISMATCH' using errcode='22023'; end if;
  if v_archived_at is not null then
    if tg_op='INSERT' then raise exception 'NEWS_CATEGORY_ARCHIVED' using errcode='22023'; end if;
    if new.category_id is distinct from old.category_id
      or new.university_id is distinct from old.university_id
      or new.academic_unit_id is distinct from old.academic_unit_id then
      raise exception 'NEWS_CATEGORY_ARCHIVED' using errcode='22023';
    end if;
  end if;$new$);

drop function pg_temp.xelay_news_category_archive_patch(text,text,text);
comment on table public.news_category_scopes is
  'Private exact-scope standard filter visibility and optimistic version. No direct client table access; editorial updates only through the existing exact news-scope authority.';
comment on column public.news_categories.archived_at is
  'Reversible category removal from active chips/new selections. Existing posts retain category ID/name and remain in the complete feed. No post content or classification is rewritten.';
comment on function public.xelay_set_news_category_visibility(uuid,uuid,uuid,text,boolean,integer) is
  'Exact editor scope required for every archive/restore. Hidden standard post_type chips are presentation settings, never deletion of publication formats or posts. Scope-version CAS prevents stale restoration/archiving.';
notify pgrst,'reload schema';
commit;
