-- Scoped editing and deletion of official news. Apply after 202609300002.
begin;

do $$
begin
  if to_regclass('public.news_posts') is null
    or to_regclass('public.news_submissions') is null
    or to_regprocedure('public.xelay_can_manage_news(uuid,uuid)') is null
    or to_regprocedure('public.xelay_can_read_news_media(text)') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'news_posts' and column_name = 'image_path'
    )
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'news_posts' and column_name = 'link_url'
    ) then
    raise exception 'Apply the news and 202609300002 news-media migrations before news management';
  end if;
end;
$$;

-- A deleted publication keeps the reviewed suggestion's history while its
-- foreign key is cleared. The trigger runs before ON DELETE SET NULL.
alter table public.news_submissions
  drop constraint if exists news_submissions_status_check;
alter table public.news_submissions
  add constraint news_submissions_status_check
  check (status in ('pending', 'published', 'rejected', 'removed'));

alter table public.news_submissions
  drop constraint if exists news_submissions_review_fields_check;
alter table public.news_submissions
  add constraint news_submissions_review_fields_check check (
    (status = 'pending' and reviewed_by is null and reviewed_at is null and published_post_id is null)
    or (status = 'published' and reviewed_by is not null and reviewed_at is not null and published_post_id is not null)
    or (status in ('rejected', 'removed') and reviewed_by is not null and reviewed_at is not null and published_post_id is null)
  );

create or replace function public.xelay_preserve_removed_news_submission()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  update public.news_submissions
  set status = 'removed', published_post_id = null
  where published_post_id = old.id and status = 'published';
  return old;
end;
$$;

drop trigger if exists preserve_removed_news_submission on public.news_posts;
create trigger preserve_removed_news_submission
  before delete on public.news_posts
  for each row execute function public.xelay_preserve_removed_news_submission();

revoke all on function public.xelay_preserve_removed_news_submission() from public, anon, authenticated;

create or replace function public.xelay_update_news_post(p_post_id uuid, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post public.news_posts%rowtype;
  v_image_path text;
  v_published_at timestamptz;
  v_event_starts_at timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_changes is null or jsonb_typeof(p_changes) <> 'object' then
    raise exception 'News changes must be an object';
  end if;

  select * into v_post from public.news_posts
  where id = p_post_id for update;
  if not found or not public.xelay_can_manage_news(v_post.university_id, v_post.academic_unit_id) then
    raise exception 'News post not found or editor permission required';
  end if;

  if (p_changes - array[
    'title', 'excerpt', 'body', 'published_at', 'post_type', 'is_pinned',
    'event_starts_at', 'event_location', 'organizer', 'registration_url', 'link_url',
    'image_url', 'image_path'
  ]) <> '{}'::jsonb then
    raise exception 'News changes contain unsupported fields';
  end if;
  if not (p_changes ?& array[
    'title', 'excerpt', 'body', 'published_at', 'post_type', 'is_pinned',
    'event_starts_at', 'event_location', 'organizer', 'registration_url', 'link_url'
  ]) then
    raise exception 'Required news fields are missing';
  end if;
  if exists (
    select 1 from jsonb_each(p_changes) e
    where e.key in ('title', 'excerpt', 'body', 'published_at', 'post_type')
      and jsonb_typeof(e.value) <> 'string'
  ) or jsonb_typeof(p_changes->'is_pinned') <> 'boolean' then
    raise exception 'Required news fields have invalid types';
  end if;
  if exists (
    select 1 from jsonb_each(p_changes) e
    where e.key in (
      'event_starts_at', 'event_location', 'organizer', 'registration_url', 'link_url',
      'image_url', 'image_path'
    ) and jsonb_typeof(e.value) not in ('string', 'null')
  ) then
    raise exception 'Optional news fields must be text or null';
  end if;

  v_published_at := (p_changes->>'published_at')::timestamptz;
  v_event_starts_at := (p_changes->>'event_starts_at')::timestamptz;
  if not isfinite(v_published_at) or (v_event_starts_at is not null and not isfinite(v_event_starts_at)) then
    raise exception 'News dates must be finite';
  end if;

  v_image_path := case when p_changes ? 'image_path'
    then p_changes->>'image_path' else v_post.image_path end;
  if v_image_path is not null and v_image_path is distinct from v_post.image_path then
    if split_part(v_image_path, '/', 1) <> auth.uid()::text or not exists (
      select 1 from storage.objects o
      where o.bucket_id = 'xelay-news-media' and o.name = v_image_path
    ) then
      raise exception 'Replacement news photo must be an existing upload belonging to you';
    end if;
  end if;

  update public.news_posts
  set title = btrim(p_changes->>'title'),
      excerpt = btrim(p_changes->>'excerpt'),
      body = btrim(p_changes->>'body'),
      published_at = v_published_at,
      post_type = p_changes->>'post_type',
      is_pinned = (p_changes->>'is_pinned')::boolean,
      event_starts_at = v_event_starts_at,
      event_location = nullif(btrim(p_changes->>'event_location'), ''),
      organizer = nullif(btrim(p_changes->>'organizer'), ''),
      registration_url = nullif(btrim(p_changes->>'registration_url'), ''),
      link_url = nullif(btrim(p_changes->>'link_url'), ''),
      image_url = case when p_changes ? 'image_url'
        then nullif(btrim(p_changes->>'image_url'), '') else v_post.image_url end,
      image_path = v_image_path,
      updated_at = now()
  where id = p_post_id
  returning * into v_post;

  return to_jsonb(v_post);
end;
$$;

create or replace function public.xelay_delete_news_post(p_post_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_post public.news_posts%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_post from public.news_posts
  where id = p_post_id for update;
  if not found or not public.xelay_can_manage_news(v_post.university_id, v_post.academic_unit_id) then
    raise exception 'News post not found or editor permission required';
  end if;
  delete from public.news_posts where id = p_post_id;
end;
$$;

revoke all on function public.xelay_update_news_post(uuid, jsonb) from public, anon, authenticated;
revoke all on function public.xelay_delete_news_post(uuid) from public, anon, authenticated;
grant execute on function public.xelay_update_news_post(uuid, jsonb) to authenticated;
grant execute on function public.xelay_delete_news_post(uuid) to authenticated;

commit;
