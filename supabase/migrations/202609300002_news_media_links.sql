-- Uploaded news photos and independent video/resource links.
begin;

alter table public.news_posts add column if not exists link_url text;
alter table public.news_submissions add column if not exists link_url text;
alter table public.news_posts add column if not exists image_path text;
alter table public.news_submissions add column if not exists image_path text;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.news_posts'::regclass
      and conname = 'news_posts_link_url_check'
  ) then
    alter table public.news_posts
      add constraint news_posts_link_url_check check (
        link_url is null or (
          length(link_url) <= 2048 and link_url ~* '^https?://[^[:space:]]+$'
        )
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.news_submissions'::regclass
      and conname = 'news_submissions_link_url_check'
  ) then
    alter table public.news_submissions
      add constraint news_submissions_link_url_check check (
        link_url is null or (
          length(link_url) <= 2048 and link_url ~* '^https?://[^[:space:]]+$'
        )
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.news_posts'::regclass
      and conname = 'news_posts_image_path_check'
  ) then
    alter table public.news_posts
      add constraint news_posts_image_path_check check (
        image_path is null or image_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpe?g|png|webp|gif|avif)$'
      );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conrelid = 'public.news_submissions'::regclass
      and conname = 'news_submissions_image_path_check'
  ) then
    alter table public.news_submissions
      add constraint news_submissions_image_path_check check (
        image_path is null or image_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpe?g|png|webp|gif|avif)$'
      );
  end if;
end;
$$;

-- Keep uploaded photos within the same visibility as the faculty news row.
-- Existing externally hosted image_url values remain supported.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'xelay-news-media',
  'xelay-news-media',
  false,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Members can upload their news photos" on storage.objects;
create policy "Members can upload their news photos"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'xelay-news-media'
    and (storage.foldername(name))[1] = auth.uid()::text
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpe?g|png|webp|gif|avif)$'
    and (
      public.xelay_is_platform_admin()
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid()
          and p.university_id is not null and p.academic_unit_id is not null
      )
    )
  );

-- Restrictive guards keep broad legacy storage policies from widening access
-- to this bucket. The other buckets retain their existing policy behavior.
drop policy if exists "News photo upload guard" on storage.objects;
create policy "News photo upload guard"
  on storage.objects as restrictive for insert to authenticated
  with check (
    bucket_id <> 'xelay-news-media'
    or (
      (storage.foldername(name))[1] = auth.uid()::text
      and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpe?g|png|webp|gif|avif)$'
      and (
        public.xelay_is_platform_admin()
        or exists (
          select 1 from public.profiles p
          where p.id = auth.uid()
            and p.university_id is not null and p.academic_unit_id is not null
        )
      )
    )
  );

drop policy if exists "News photo overwrite guard" on storage.objects;
create policy "News photo overwrite guard"
  on storage.objects as restrictive for update to authenticated
  using (bucket_id <> 'xelay-news-media')
  with check (bucket_id <> 'xelay-news-media');

create or replace function public.xelay_can_read_news_media(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and (
      exists (
        select 1 from public.news_posts n
        where n.image_path = p_name and public.xelay_can_read_news(n.id)
      )
      or exists (
        select 1 from public.news_submissions s
        where s.image_path = p_name and s.status = 'pending'
          and (s.user_id = auth.uid() or public.xelay_can_manage_news(s.university_id, s.academic_unit_id))
      )
    );
$$;

revoke all on function public.xelay_can_read_news_media(text) from public, anon, authenticated;
grant execute on function public.xelay_can_read_news_media(text) to authenticated;

drop policy if exists "Readers can view permitted news photos" on storage.objects;
create policy "Readers can view permitted news photos"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'xelay-news-media'
    and (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.xelay_can_read_news_media(name)
    )
  );

drop policy if exists "News photo read guard" on storage.objects;
create policy "News photo read guard"
  on storage.objects as restrictive for select to authenticated
  using (
    bucket_id <> 'xelay-news-media'
    or (
      (storage.foldername(name))[1] = auth.uid()::text
      or public.xelay_can_read_news_media(name)
    )
  );

-- RLS on news rows may hide a reference from its uploader after moderation.
-- Check both tables as their owner before permitting failed-upload cleanup.
create or replace function public.xelay_can_remove_news_media(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and split_part(p_name, '/', 1) = auth.uid()::text
    and p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpe?g|png|webp|gif|avif)$'
    and not exists (
      select 1 from public.news_posts n
      where n.image_path = p_name
    )
    and not exists (
      select 1 from public.news_submissions s
      where s.image_path = p_name
    );
$$;

revoke all on function public.xelay_can_remove_news_media(text) from public, anon, authenticated;
grant execute on function public.xelay_can_remove_news_media(text) to authenticated;

drop policy if exists "Owners can remove unreferenced news photos" on storage.objects;
create policy "Owners can remove unreferenced news photos"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'xelay-news-media'
    and (storage.foldername(name))[1] = auth.uid()::text
    and public.xelay_can_remove_news_media(name)
  );

drop policy if exists "News photo removal guard" on storage.objects;
create policy "News photo removal guard"
  on storage.objects as restrictive for delete to authenticated
  using (
    bucket_id <> 'xelay-news-media'
    or (
      (storage.foldername(name))[1] = auth.uid()::text
      and public.xelay_can_remove_news_media(name)
    )
  );

-- Only an uploader can attach a new storage path through a direct insert.
-- The moderation RPC copies the submitter's path with its existing authority.
drop policy if exists "News photos must belong to their publishing editor" on public.news_posts;
create policy "News photos must belong to their publishing editor"
  on public.news_posts as restrictive for insert to authenticated
  with check (image_path is null or split_part(image_path, '/', 1) = auth.uid()::text);

drop policy if exists "Submitted news photos must belong to their author" on public.news_submissions;
create policy "Submitted news photos must belong to their author"
  on public.news_submissions as restrictive for insert to authenticated
  with check (image_path is null or split_part(image_path, '/', 1) = auth.uid()::text);

-- Editors may retain another author's existing photo while editing a post,
-- but cannot attach an unrelated private photo by changing its storage path.
create or replace function public.xelay_can_keep_news_media(p_post_id uuid, p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.news_posts n
    where n.id = p_post_id and n.image_path = p_name
      and public.xelay_can_manage_news(n.university_id, n.academic_unit_id)
  );
$$;

revoke all on function public.xelay_can_keep_news_media(uuid, text) from public, anon, authenticated;
grant execute on function public.xelay_can_keep_news_media(uuid, text) to authenticated;

drop policy if exists "Editors can keep or replace permitted news photos" on public.news_posts;
create policy "Editors can keep or replace permitted news photos"
  on public.news_posts as restrictive for update to authenticated
  using (true)
  with check (
    image_path is null
    or split_part(image_path, '/', 1) = auth.uid()::text
    or public.xelay_can_keep_news_media(id, image_path)
  );

-- Preserve independent links when a moderator publishes a suggestion.
create or replace function public.xelay_review_news_submission(p_submission_id uuid, p_action text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_submission public.news_submissions%rowtype;
  v_post_id uuid;
  v_actor_name text;
begin
  if auth.uid() is null or p_action is null or p_action not in ('publish', 'reject') then
    raise exception 'Valid moderation action and authentication required';
  end if;
  select * into v_submission from public.news_submissions
  where id = p_submission_id and status = 'pending' for update;
  if not found or not public.xelay_can_manage_news(v_submission.university_id, v_submission.academic_unit_id) then
    raise exception 'Submission not found or moderator permission required';
  end if;

  if p_action = 'publish' then
    insert into public.news_posts (
      university_id, academic_unit_id, post_type, title, excerpt, body, image_url, image_path, link_url,
      event_starts_at, event_location, organizer, registration_url, is_pinned, published_by
    ) values (
      v_submission.university_id, v_submission.academic_unit_id, v_submission.post_type,
      v_submission.title, v_submission.excerpt, v_submission.body, v_submission.image_url, v_submission.image_path, v_submission.link_url,
      v_submission.event_starts_at, v_submission.event_location, v_submission.organizer,
      v_submission.registration_url, false, auth.uid()
    ) returning id into v_post_id;
    update public.news_submissions
    set status = 'published', published_post_id = v_post_id, reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_submission_id;
    select full_name into v_actor_name from public.profiles where id = auth.uid();
    insert into public.notifications (recipient_id, actor_id, actor_name, type, message, is_read, news_post_id)
    values (v_submission.user_id, auth.uid(), coalesce(nullif(v_actor_name, ''), 'Редактор'),
      'news_submission_published', 'опублікував(-ла) вашу запропоновану новину', false, v_post_id);
    return v_post_id;
  end if;

  update public.news_submissions
  set status = 'rejected', reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_submission_id;
  select full_name into v_actor_name from public.profiles where id = auth.uid();
  insert into public.notifications (recipient_id, actor_id, actor_name, type, message, is_read)
  values (v_submission.user_id, auth.uid(), coalesce(nullif(v_actor_name, ''), 'Редактор'),
    'news_submission_rejected', 'відхилив(-ла) вашу пропозицію новини', false);
  return null;
end;
$$;

revoke all on function public.xelay_review_news_submission(uuid, text) from public, anon;
grant execute on function public.xelay_review_news_submission(uuid, text) to authenticated;

commit;
