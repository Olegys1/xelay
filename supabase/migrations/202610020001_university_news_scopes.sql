-- Independent university-wide and faculty news/editor permissions.
-- Apply after 202609300003_news_management.sql. Existing faculty content is retained.
begin;

do $$
begin
  if to_regclass('public.news_posts') is null
    or to_regclass('public.news_submissions') is null
    or to_regclass('public.editor_access_requests') is null
    or to_regclass('public.user_roles') is null
    or to_regprocedure('public.xelay_update_news_post(uuid,jsonb)') is null
    or to_regprocedure('public.xelay_can_read_news_media(text)') is null
    or not exists (
      select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'messages' and column_name = 'deleted_at'
    ) then
    raise exception 'Apply the university/news, message interactions, news-media and news-management migrations first';
  end if;
end;
$$;

-- A NULL academic_unit_id identifies a university-wide scope. The separate
-- university FK still protects such rows; the existing composite unit FK
-- continues to prevent assigning a faculty from another university.
alter table public.news_posts alter column academic_unit_id drop not null;
alter table public.news_submissions alter column academic_unit_id drop not null;
alter table public.editor_access_requests alter column academic_unit_id drop not null;

comment on column public.news_posts.academic_unit_id is 'NULL: university-wide news; otherwise news of this faculty/institute.';
comment on column public.news_submissions.academic_unit_id is 'NULL: university-wide suggestion; otherwise faculty/institute suggestion.';
comment on column public.editor_access_requests.academic_unit_id is 'NULL: UNIVERSITY_EDITOR application; otherwise FACULTY_EDITOR application.';

alter table public.user_roles drop constraint if exists user_roles_role_check;
alter table public.user_roles add constraint user_roles_role_check
  check (role in ('FACULTY_EDITOR', 'UNIVERSITY_EDITOR', 'ADMIN'));
alter table public.user_roles drop constraint if exists user_roles_scope_check;
alter table public.user_roles add constraint user_roles_scope_check check (
  (role = 'ADMIN' and university_id is null and academic_unit_id is null)
  or (role = 'FACULTY_EDITOR' and university_id is not null and academic_unit_id is not null)
  or (role = 'UNIVERSITY_EDITOR' and university_id is not null and academic_unit_id is null)
);

-- One pending application per exact scope, so requesting the general feed
-- never blocks a separate application for one's own faculty feed.
drop index if exists public.editor_access_requests_one_pending_idx;
create unique index editor_access_requests_one_pending_idx
  on public.editor_access_requests (
    user_id,
    university_id,
    coalesce(academic_unit_id, '00000000-0000-0000-0000-000000000000'::uuid)
  ) where status = 'pending';
create index if not exists editor_access_requests_scope_status_idx
  on public.editor_access_requests (university_id, academic_unit_id, status, created_at desc);
create index if not exists messages_news_recipient_idx
  on public.messages (shared_post_id, recipient_id)
  where shared_post_id is not null and deleted_at is null;

create or replace function public.xelay_can_manage_news(
  p_university_id uuid,
  p_academic_unit_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and p_university_id is not null and (
    public.xelay_is_platform_admin()
    or exists (
      select 1 from public.user_roles r
      where r.user_id = auth.uid() and r.university_id = p_university_id
        and (
          (p_academic_unit_id is null and r.role = 'UNIVERSITY_EDITOR' and r.academic_unit_id is null)
          or (p_academic_unit_id is not null and r.role = 'FACULTY_EDITOR'
            and r.academic_unit_id = p_academic_unit_id)
        )
    )
  );
$$;

-- Used by the feed, detail, comments and likes, and the private photo helper.
-- Published general news is available to every profile of the university;
-- faculty news requires an exact faculty match or an exact editorial role.
-- Preserve recipient-only access to deliberately shared posts in real chats.
create or replace function public.xelay_can_read_news(p_post_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.news_posts n
    where n.id = p_post_id and n.status = 'published' and (
      public.xelay_can_manage_news(n.university_id, n.academic_unit_id)
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.university_id = n.university_id
          and (n.academic_unit_id is null or p.academic_unit_id = n.academic_unit_id)
      )
      or exists (
        select 1 from public.messages m
        join public.conversations c on c.id = m.conversation_id
        where m.shared_post_id = n.id and m.recipient_id = auth.uid()
          and m.deleted_at is null
          and ((c.user_one_id = m.sender_id and c.user_two_id = m.recipient_id)
            or (c.user_two_id = m.sender_id and c.user_one_id = m.recipient_id))
      )
    )
  );
$$;

create or replace function public.xelay_can_share_news(
  p_post_id uuid, p_sender_id uuid, p_recipient_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() = p_sender_id and p_sender_id <> p_recipient_id and exists (
    select 1 from public.news_posts n
    where n.id = p_post_id and n.status = 'published'
      and (
        public.xelay_can_manage_news(n.university_id, n.academic_unit_id)
        or exists (
          select 1 from public.profiles p
          where p.id = p_sender_id and p.university_id = n.university_id
            and (n.academic_unit_id is null or p.academic_unit_id = n.academic_unit_id)
        )
      )
      and exists (
        select 1 from public.conversations c
        where (c.user_one_id = p_sender_id and c.user_two_id = p_recipient_id)
          or (c.user_two_id = p_sender_id and c.user_one_id = p_recipient_id)
      )
  );
$$;

-- All existing publish/edit/delete/moderation policies and RPCs already call
-- xelay_can_manage_news, so the new exact scope rules apply to them as well.
drop policy if exists "Users can view their faculty news" on public.news_posts;
drop policy if exists "Users can view permitted university and faculty news" on public.news_posts;
create policy "Users can view permitted university and faculty news" on public.news_posts
  for select to authenticated using (
    public.xelay_can_manage_news(university_id, academic_unit_id)
    or (status = 'published' and public.xelay_can_read_news(id))
  );

drop policy if exists "Users can submit news for their unit" on public.news_submissions;
drop policy if exists "Users can submit news for their academic scope" on public.news_submissions;
create policy "Users can submit news for their academic scope" on public.news_submissions
  for insert to authenticated with check (
    user_id = auth.uid() and status = 'pending' and reviewed_by is null
    and reviewed_at is null and published_post_id is null
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.university_id = news_submissions.university_id
        and (news_submissions.academic_unit_id is null or p.academic_unit_id = news_submissions.academic_unit_id)
    )
  );

drop policy if exists "Users can request faculty editor access" on public.editor_access_requests;
drop policy if exists "Users can request scoped editor access" on public.editor_access_requests;
create policy "Users can request scoped editor access" on public.editor_access_requests
  for insert to authenticated with check (
    user_id = auth.uid() and status = 'pending' and reviewed_by is null and reviewed_at is null
    and not public.xelay_can_manage_news(university_id, academic_unit_id)
    and exists (
      select 1 from public.profiles p
      join public.universities u on u.id = p.university_id and u.is_active
      where p.id = auth.uid() and p.university_id = editor_access_requests.university_id
        and (
          editor_access_requests.academic_unit_id is null
          or (p.academic_unit_id = editor_access_requests.academic_unit_id and exists (
            select 1 from public.academic_units a
            where a.id = p.academic_unit_id and a.university_id = p.university_id and a.is_active
          ))
        )
    )
  );

-- The new RPC has a distinct name, avoiding PostgREST overload ambiguity.
-- It derives the target scope exclusively from the authenticated profile.
create or replace function public.xelay_request_editor_access(
  p_message text default '', p_scope text default 'faculty'
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_university_id uuid;
  v_unit_id uuid;
  v_request_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_scope is null or p_scope not in ('faculty', 'university') then
    raise exception 'Editor scope must be faculty or university';
  end if;
  if length(coalesce(p_message, '')) > 1000 then
    raise exception 'Editor application message cannot exceed 1000 characters';
  end if;
  select p.university_id, p.academic_unit_id into v_university_id, v_unit_id
  from public.profiles p
  join public.universities u on u.id = p.university_id and u.is_active
  where p.id = auth.uid();
  if v_university_id is null then raise exception 'Choose your university before applying'; end if;
  if p_scope = 'university' then
    v_unit_id := null;
  elsif v_unit_id is null or not exists (
    select 1 from public.academic_units a
    where a.id = v_unit_id and a.university_id = v_university_id and a.is_active
  ) then
    raise exception 'Choose your faculty before applying for faculty editor access';
  end if;
  -- Serialize same-user applications; the partial unique index also protects
  -- direct inserts and permits independent faculty/university requests.
  perform pg_advisory_xact_lock(hashtextextended('xelay-editor-request:' || auth.uid()::text, 0));
  if public.xelay_can_manage_news(v_university_id, v_unit_id) then
    raise exception 'You already have editor access to this news scope';
  end if;
  select id into v_request_id from public.editor_access_requests
  where user_id = auth.uid() and university_id = v_university_id
    and academic_unit_id is not distinct from v_unit_id and status = 'pending';
  if found then return v_request_id; end if;
  insert into public.editor_access_requests (user_id, university_id, academic_unit_id, message)
  values (auth.uid(), v_university_id, v_unit_id, btrim(coalesce(p_message, '')))
  returning id into v_request_id;
  return v_request_id;
end;
$$;

-- Compatibility for already deployed faculty clients. It cannot request or
-- grant university editor access accidentally.
create or replace function public.xelay_submit_editor_request(p_message text default '')
returns uuid
language sql
security definer
set search_path = public, pg_temp
as $$
  select public.xelay_request_editor_access(p_message, 'faculty');
$$;

create or replace function public.xelay_review_editor_request(p_request_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.editor_access_requests%rowtype;
  v_role text;
  v_scope_label text;
begin
  if auth.uid() is null or not public.xelay_is_platform_admin() then
    raise exception 'Platform administrator permission required';
  end if;
  if p_approve is null then raise exception 'An approval or rejection decision is required'; end if;
  select * into v_request from public.editor_access_requests
  where id = p_request_id and status = 'pending' for update;
  if not found then raise exception 'Pending editor request not found'; end if;
  v_role := case when v_request.academic_unit_id is null then 'UNIVERSITY_EDITOR' else 'FACULTY_EDITOR' end;
  v_scope_label := case when v_request.academic_unit_id is null then 'загальних новин університету' else 'новин факультету / інституту' end;
  update public.editor_access_requests
  set status = case when p_approve then 'approved' else 'rejected' end,
      reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_request_id;
  if p_approve then
    insert into public.user_roles (user_id, role, university_id, academic_unit_id, granted_by)
    values (v_request.user_id, v_role, v_request.university_id, v_request.academic_unit_id, auth.uid())
    on conflict do nothing;
  end if;
  insert into public.notifications (recipient_id, actor_id, actor_name, type, message, is_read)
  select v_request.user_id, auth.uid(), coalesce(nullif(p.full_name, ''), 'Адміністратор'),
    case when p_approve then 'editor_request_approved' else 'editor_request_rejected' end,
    case when p_approve then 'підтвердив(-ла) ваш доступ редактора ' || v_scope_label
      else 'відхилив(-ла) вашу заявку на редакторський доступ до ' || v_scope_label end, false
  from public.profiles p where p.id = auth.uid();
end;
$$;

-- Permit photos for general news when a profile has only selected a
-- university. Pending submissions remain private; authors own upload paths.
drop policy if exists "Members can upload their news photos" on storage.objects;
create policy "Members can upload their news photos"
  on storage.objects for insert to authenticated with check (
    bucket_id = 'xelay-news-media'
    and (storage.foldername(name))[1] = auth.uid()::text
    and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpe?g|png|webp|gif|avif)$'
    and (public.xelay_is_platform_admin() or exists (
      select 1 from public.profiles p where p.id = auth.uid() and p.university_id is not null
    ) or exists (
      select 1 from public.user_roles r where r.user_id = auth.uid() and r.role in ('FACULTY_EDITOR', 'UNIVERSITY_EDITOR')
    ))
  );
drop policy if exists "News photo upload guard" on storage.objects;
create policy "News photo upload guard"
  on storage.objects as restrictive for insert to authenticated with check (
    bucket_id <> 'xelay-news-media'
    or (
      (storage.foldername(name))[1] = auth.uid()::text
      and name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpe?g|png|webp|gif|avif)$'
      and (public.xelay_is_platform_admin() or exists (
        select 1 from public.profiles p where p.id = auth.uid() and p.university_id is not null
      ) or exists (
        select 1 from public.user_roles r where r.user_id = auth.uid() and r.role in ('FACULTY_EDITOR', 'UNIVERSITY_EDITOR')
      ))
    )
  );

create or replace function public.xelay_can_read_news_media(p_name text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null and (
    exists (
      select 1 from public.news_posts n where n.image_path = p_name
        and (public.xelay_can_manage_news(n.university_id, n.academic_unit_id) or public.xelay_can_read_news(n.id))
    )
    or exists (
      select 1 from public.news_submissions s where s.image_path = p_name and s.status = 'pending'
        and (s.user_id = auth.uid() or public.xelay_can_manage_news(s.university_id, s.academic_unit_id))
    )
  );
$$;

revoke all on function public.xelay_can_manage_news(uuid, uuid) from public, anon, authenticated;
revoke all on function public.xelay_can_read_news(uuid) from public, anon, authenticated;
revoke all on function public.xelay_can_share_news(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function public.xelay_request_editor_access(text, text) from public, anon, authenticated;
revoke all on function public.xelay_submit_editor_request(text) from public, anon, authenticated;
revoke all on function public.xelay_review_editor_request(uuid, boolean) from public, anon, authenticated;
revoke all on function public.xelay_can_read_news_media(text) from public, anon, authenticated;
grant execute on function public.xelay_can_manage_news(uuid, uuid) to authenticated;
grant execute on function public.xelay_can_read_news(uuid) to authenticated;
grant execute on function public.xelay_can_share_news(uuid, uuid, uuid) to authenticated;
grant execute on function public.xelay_request_editor_access(text, text) to authenticated;
grant execute on function public.xelay_submit_editor_request(text) to authenticated;
grant execute on function public.xelay_review_editor_request(uuid, boolean) to authenticated;
grant execute on function public.xelay_can_read_news_media(text) to authenticated;

notify pgrst, 'reload schema';
commit;
