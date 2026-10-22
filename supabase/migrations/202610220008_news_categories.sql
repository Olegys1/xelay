-- Editor-created categories supplement the fixed news/event/opportunity formats.
-- Apply as one transaction after 202610220007_platform_news.sql.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$
begin
  if to_regclass('public.news_posts') is null
    or to_regprocedure('public.xelay_can_manage_news(uuid,uuid)') is null
    or to_regprocedure('public.xelay_update_news_post(uuid,jsonb)') is null
    or not exists(select 1 from pg_constraint where conrelid='public.news_posts'::regclass
      and conname='news_posts_platform_scope_check') then
    raise exception 'Apply the independent platform news scope migration before news categories';
  end if;
  if exists(select 1 from information_schema.columns where table_schema='public'
    and table_name='news_posts' and column_name='category_id')
    or to_regclass('public.news_categories') is not null then
    raise exception 'News categories already exist; inspect migration history before retrying';
  end if;
end $$;

create table public.news_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  university_id uuid references public.universities(id) on delete cascade,
  academic_unit_id uuid,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default clock_timestamp(),
  constraint news_categories_name_check check (
    name=btrim(name) and char_length(name) between 2 and 50
    and name !~ '[[:cntrl:]]' and name !~ U&'[\202A-\202E\2066-\2069]'
  ),
  constraint news_categories_scope_check check(university_id is not null or academic_unit_id is null),
  constraint news_categories_unit_university_fkey foreign key (academic_unit_id,university_id)
    references public.academic_units(id,university_id) on delete cascade
);
create unique index news_categories_unique_scope_name on public.news_categories (
  coalesce(university_id,'00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(academic_unit_id,'00000000-0000-0000-0000-000000000000'::uuid),lower(name)
);
create index news_categories_scope_idx on public.news_categories(university_id,academic_unit_id,name);

alter table public.news_categories enable row level security;
revoke all on table public.news_categories from public,anon,authenticated;
grant select on table public.news_categories to authenticated;
create policy "Readers view exact-scope news categories" on public.news_categories
  for select to authenticated using (
    auth.uid() is not null and (
      (university_id is null and academic_unit_id is null)
      or public.xelay_can_manage_news(university_id,academic_unit_id)
      or exists(select 1 from public.profiles p where p.id=auth.uid()
        and p.university_id=news_categories.university_id
        and (news_categories.academic_unit_id is null or p.academic_unit_id=news_categories.academic_unit_id))
    )
  );

create function public.xelay_create_news_category(
  p_name text,p_university_id uuid,p_academic_unit_id uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_name text; v_category public.news_categories%rowtype;
begin
  if auth.uid() is null
    or (p_university_id is null and p_academic_unit_id is not null)
    or not public.xelay_can_manage_news(p_university_id,p_academic_unit_id) then
    raise exception 'NEWS_CATEGORY_EDITOR_REQUIRED' using errcode='42501';
  end if;
  v_name:=btrim(p_name);
  if v_name is null or char_length(v_name) not between 2 and 50
    or v_name ~ '[[:cntrl:]]' or v_name ~ U&'[\202A-\202E\2066-\2069]' then
    raise exception 'NEWS_CATEGORY_NAME_INVALID' using errcode='22023';
  end if;
  -- The normalized scope/name lock makes retries and simultaneous requests
  -- return the same category instead of creating duplicate chips.
  perform pg_advisory_xact_lock(hashtextextended('xelay-news-category:'
    ||coalesce(p_university_id::text,'platform')||':'
    ||coalesce(p_academic_unit_id::text,'university')||':'||lower(v_name),0));
  select * into v_category from public.news_categories c
    where c.university_id is not distinct from p_university_id
      and c.academic_unit_id is not distinct from p_academic_unit_id
      and lower(c.name)=lower(v_name);
  if not found then
    insert into public.news_categories(name,university_id,academic_unit_id,created_by)
      values(v_name,p_university_id,p_academic_unit_id,auth.uid()) returning * into v_category;
  end if;
  return jsonb_build_object('id',v_category.id,'name',v_category.name,
    'university_id',v_category.university_id,'academic_unit_id',v_category.academic_unit_id);
end $$;
revoke all on function public.xelay_create_news_category(text,uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_create_news_category(text,uuid,uuid) to authenticated;

-- There is no category rename/move endpoint. Keeping scope and identity
-- immutable also protects existing posts from an indirect scope change.
create function public.xelay_guard_news_category_identity()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.id is distinct from old.id or new.name is distinct from old.name
    or new.university_id is distinct from old.university_id
    or new.academic_unit_id is distinct from old.academic_unit_id then
    raise exception 'NEWS_CATEGORY_IDENTITY_IMMUTABLE' using errcode='42501';
  end if;
  return new;
end $$;
revoke all on function public.xelay_guard_news_category_identity() from public,anon,authenticated,service_role;
create trigger xelay_news_category_identity_guard before update on public.news_categories
  for each row execute function public.xelay_guard_news_category_identity();

alter table public.news_posts add column category_id uuid references public.news_categories(id) on delete restrict;
create index news_posts_category_feed_idx on public.news_posts(category_id,status,published_at desc,id)
  where category_id is not null;

create function public.xelay_guard_news_post_category()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.category_id is null then return new; end if;
  -- Exact NULL-aware scope equality prevents a faculty/university editor from
  -- attaching another feed's category, including a global platform category.
  perform 1 from public.news_categories c where c.id=new.category_id
    and c.university_id is not distinct from new.university_id
    and c.academic_unit_id is not distinct from new.academic_unit_id for key share;
  if not found then raise exception 'NEWS_CATEGORY_SCOPE_MISMATCH' using errcode='22023'; end if;
  return new;
end $$;
revoke all on function public.xelay_guard_news_post_category() from public,anon,authenticated,service_role;
create trigger xelay_news_post_category_guard before insert or update of category_id,university_id,academic_unit_id
  on public.news_posts for each row execute function public.xelay_guard_news_post_category();

-- Retain all installed field, ownership, attachment, scope and date checks.
-- Only one optional editable field is added; old clients retain the category.
create function pg_temp.xelay_news_category_patch(p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text; v_old text; v_new text; v_count integer;
begin
  v_definition:=replace(pg_get_functiondef('public.xelay_update_news_post(uuid,jsonb)'::regprocedure),chr(13),'');
  v_old:=replace(p_old,chr(13),''); v_new:=replace(p_new,chr(13),'');
  if v_old='' then raise exception 'Empty news-category patch anchor'; end if;
  v_count:=(length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old);
  if v_count<>1 then raise exception 'News-category update anchor mismatch (matches: %)',v_count; end if;
  execute replace(v_definition,v_old,v_new);
end $$;
select pg_temp.xelay_news_category_patch(
$old$'link_url','image_url','image_path','attachments','links'])$old$,
$new$'link_url','image_url','image_path','attachments','links','category_id'])$new$);
select pg_temp.xelay_news_category_patch(
$old$  v_published_at:=(p_changes->>'published_at')::timestamptz;$old$,
$new$  if p_changes ? 'category_id' and jsonb_typeof(p_changes->'category_id') not in('string','null') then
    raise exception 'NEWS_CATEGORY_INVALID' using errcode='22023';
  end if;
  v_published_at:=(p_changes->>'published_at')::timestamptz;$new$);
select pg_temp.xelay_news_category_patch(
$old$    image_path=v_image_path,$old$,
$new$    image_path=v_image_path,
    category_id=case when p_changes ? 'category_id' then (p_changes->>'category_id')::uuid else v_post.category_id end,$new$);
drop function pg_temp.xelay_news_category_patch(text,text);

grant select(category_id),insert(category_id) on public.news_posts to authenticated;
comment on table public.news_categories is
  'Optional exact-scope news categories. Authorized editors create through the idempotent RPC; there is no client rename, delete or scope-move operation.';
comment on column public.news_posts.category_id is
  'Optional custom category in the exact same platform/university/faculty scope. The fixed post_type continues to control event fields and validation.';
notify pgrst,'reload schema';
commit;
