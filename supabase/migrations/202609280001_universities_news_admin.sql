-- University-scoped profiles, official news, and editor access for Xelay.

create table if not exists public.universities (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  slug text not null unique,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists public.academic_units (
  id uuid primary key default gen_random_uuid(),
  university_id uuid not null references public.universities(id) on delete cascade,
  name text not null,
  slug text not null,
  unit_type text not null check (unit_type in ('faculty', 'institute', 'college', 'other')),
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (university_id, slug),
  unique (id, university_id)
);

insert into public.universities (name, slug)
values ('Київський національний університет імені Тараса Шевченка', 'knu')
on conflict (slug) do update set name = excluded.name, is_active = true;

with knu as (
  select id from public.universities where slug = 'knu'
), units(name, slug, unit_type) as (values
  ('Географічний факультет', 'geography', 'faculty'),
  ('Економічний факультет', 'economics', 'faculty'),
  ('Історичний факультет', 'history', 'faculty'),
  ('Механіко-математичний факультет', 'mechanics-mathematics', 'faculty'),
  ('Факультет інформаційних технологій', 'information-technology', 'faculty'),
  ('Факультет комп’ютерних наук та кібернетики', 'computer-science-cybernetics', 'faculty'),
  ('Факультет психології', 'psychology', 'faculty'),
  ('Факультет радіофізики, електроніки та комп’ютерних систем', 'radio-physics-electronics', 'faculty'),
  ('Факультет соціології', 'sociology', 'faculty'),
  ('Фізичний факультет', 'physics', 'faculty'),
  ('Філософський факультет', 'philosophy', 'faculty'),
  ('Хімічний факультет', 'chemistry', 'faculty'),
  ('Військовий інститут', 'military-institute', 'institute'),
  ('Інститут післядипломної освіти', 'continuing-education', 'institute'),
  ('Інститут управління державної охорони України', 'state-guard-management', 'institute'),
  ('Навчально-науковий інститут високих технологій', 'high-technologies', 'institute'),
  ('Навчально-науковий інститут «Інститут геології»', 'geology', 'institute'),
  ('Навчально-науковий інститут журналістики', 'journalism', 'institute'),
  ('Навчально-науковий інститут міжнародних відносин', 'international-relations', 'institute'),
  ('Навчально-науковий інститут права', 'law', 'institute'),
  ('Навчально-науковий інститут філології', 'philology', 'institute'),
  ('Навчально-науковий інститут публічного управління та державної служби', 'public-administration', 'institute'),
  ('Навчально-науковий центр «Інститут біології та медицини»', 'biology-medicine', 'institute')
)
insert into public.academic_units (university_id, name, slug, unit_type)
select knu.id, units.name, units.slug, units.unit_type
from knu cross join units
on conflict (university_id, slug) do update
set name = excluded.name, unit_type = excluded.unit_type, is_active = true;

alter table public.profiles
  add column if not exists university_id uuid references public.universities(id) on delete set null,
  add column if not exists academic_unit_id uuid;

alter table public.profiles
  drop constraint if exists profiles_academic_unit_university_fkey;
alter table public.profiles
  add constraint profiles_academic_unit_university_fkey
  foreign key (academic_unit_id, university_id)
  references public.academic_units(id, university_id)
  on delete set null (academic_unit_id);

create index if not exists profiles_university_unit_idx
  on public.profiles (university_id, academic_unit_id);

create table if not exists public.user_roles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('FACULTY_EDITOR', 'ADMIN')),
  university_id uuid references public.universities(id) on delete cascade,
  academic_unit_id uuid,
  granted_by uuid references public.profiles(id) on delete set null,
  granted_at timestamptz not null default now(),
  constraint user_roles_scope_check check (
    (role = 'ADMIN' and university_id is null and academic_unit_id is null)
    or (role = 'FACULTY_EDITOR' and university_id is not null and academic_unit_id is not null)
  ),
  constraint user_roles_unit_university_fkey
    foreign key (academic_unit_id, university_id)
    references public.academic_units(id, university_id)
    on delete cascade
);

create unique index if not exists user_roles_unique_scope_idx
  on public.user_roles (user_id, role, coalesce(university_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(academic_unit_id, '00000000-0000-0000-0000-000000000000'::uuid));
create index if not exists user_roles_scope_idx
  on public.user_roles (university_id, academic_unit_id, role);

create or replace function public.xelay_is_platform_admin()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.user_roles r
    where r.user_id = auth.uid() and r.role = 'ADMIN'
      and r.university_id is null and r.academic_unit_id is null
  );
$$;

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
  select public.xelay_is_platform_admin() or exists (
    select 1 from public.user_roles r
    where r.user_id = auth.uid() and r.role = 'FACULTY_EDITOR'
      and r.university_id = p_university_id
      and r.academic_unit_id = p_academic_unit_id
  );
$$;

create table if not exists public.news_posts (
  id uuid primary key default gen_random_uuid(),
  university_id uuid not null references public.universities(id) on delete cascade,
  academic_unit_id uuid not null,
  post_type text not null check (post_type in ('news', 'event', 'opportunity', 'announcement')),
  title text not null check (length(btrim(title)) between 3 and 180),
  excerpt text not null check (length(btrim(excerpt)) between 1 and 500),
  body text not null check (length(btrim(body)) > 0),
  image_url text check (image_url is null or image_url ~* '^https?://'),
  event_starts_at timestamptz,
  event_location text,
  organizer text,
  registration_url text check (registration_url is null or registration_url ~* '^https?://'),
  status text not null default 'published' check (status in ('draft', 'published', 'archived')),
  is_pinned boolean not null default false,
  published_by uuid not null references public.profiles(id) on delete restrict,
  published_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint news_posts_unit_university_fkey
    foreign key (academic_unit_id, university_id)
    references public.academic_units(id, university_id)
    on delete cascade,
  constraint news_posts_event_fields_check check (
    post_type <> 'event' or (event_starts_at is not null and length(btrim(coalesce(organizer, ''))) > 0)
  )
);

create index if not exists news_posts_feed_idx
  on public.news_posts (university_id, academic_unit_id, status, is_pinned desc, published_at desc);

alter table public.messages
  add column if not exists shared_post_id uuid references public.news_posts(id) on delete set null;

create or replace function public.xelay_can_read_news(p_post_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.news_posts n
    where n.id = p_post_id and n.status = 'published' and (
      public.xelay_is_platform_admin()
      or public.xelay_can_manage_news(n.university_id, n.academic_unit_id)
      or exists (
        select 1 from public.profiles p
        where p.id = auth.uid() and p.university_id = n.university_id
          and p.academic_unit_id = n.academic_unit_id
      )
      or exists (
        select 1 from public.messages m
        where m.shared_post_id = n.id and m.recipient_id = auth.uid()
      )
    )
  );
$$;

alter table public.notifications
  add column if not exists news_post_id uuid references public.news_posts(id) on delete cascade;

create table if not exists public.news_comments (
  id uuid primary key default gen_random_uuid(),
  post_id uuid not null references public.news_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 3000),
  created_at timestamptz not null default now()
);

create index if not exists news_comments_post_created_idx
  on public.news_comments (post_id, created_at);

create or replace function public.xelay_notify_news_comment()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_owner_id uuid;
  v_actor_name text;
begin
  select published_by into v_owner_id from public.news_posts where id = new.post_id;
  if v_owner_id is not null and v_owner_id <> new.user_id then
    select full_name into v_actor_name from public.profiles where id = new.user_id;
    insert into public.notifications (recipient_id, actor_id, actor_name, type, message, is_read, news_post_id)
    values (v_owner_id, new.user_id, coalesce(nullif(v_actor_name, ''), 'Учасник'),
      'news_comment', 'прокоментував(-ла) вашу новину', false, new.post_id);
  end if;
  return new;
end;
$$;

drop trigger if exists news_comment_notification on public.news_comments;
create trigger news_comment_notification
  after insert on public.news_comments
  for each row execute function public.xelay_notify_news_comment();
revoke all on function public.xelay_notify_news_comment() from public, anon, authenticated;

create table if not exists public.news_likes (
  post_id uuid not null references public.news_posts(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.news_submissions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  university_id uuid not null references public.universities(id) on delete cascade,
  academic_unit_id uuid not null,
  post_type text not null check (post_type in ('news', 'event', 'opportunity', 'announcement')),
  title text not null check (length(btrim(title)) between 3 and 180),
  excerpt text not null check (length(btrim(excerpt)) between 1 and 500),
  body text not null check (length(btrim(body)) > 0),
  image_url text check (image_url is null or image_url ~* '^https?://'),
  event_starts_at timestamptz,
  event_location text,
  organizer text,
  registration_url text check (registration_url is null or registration_url ~* '^https?://'),
  status text not null default 'pending' check (status in ('pending', 'published', 'rejected')),
  published_post_id uuid references public.news_posts(id) on delete set null,
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint news_submissions_unit_university_fkey
    foreign key (academic_unit_id, university_id)
    references public.academic_units(id, university_id)
    on delete cascade,
  constraint news_submissions_event_fields_check check (
    post_type <> 'event' or (event_starts_at is not null and length(btrim(coalesce(organizer, ''))) > 0)
  ),
  constraint news_submissions_review_fields_check check (
    (status = 'pending' and reviewed_by is null and reviewed_at is null and published_post_id is null)
    or (status = 'published' and reviewed_by is not null and reviewed_at is not null and published_post_id is not null)
    or (status = 'rejected' and reviewed_by is not null and reviewed_at is not null and published_post_id is null)
  )
);

create index if not exists news_submissions_unit_status_created_idx
  on public.news_submissions (university_id, academic_unit_id, status, created_at);

create table if not exists public.editor_access_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  university_id uuid not null references public.universities(id) on delete cascade,
  academic_unit_id uuid not null,
  message text not null default '' check (length(message) <= 1000),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint editor_request_unit_university_fkey
    foreign key (academic_unit_id, university_id)
    references public.academic_units(id, university_id)
    on delete cascade
);

create unique index if not exists editor_access_requests_one_pending_idx
  on public.editor_access_requests (user_id)
  where status = 'pending';
create index if not exists editor_access_requests_status_idx
  on public.editor_access_requests (status, created_at);

alter table public.universities enable row level security;
alter table public.academic_units enable row level security;
alter table public.user_roles enable row level security;
alter table public.news_posts enable row level security;
alter table public.news_comments enable row level security;
alter table public.news_likes enable row level security;
alter table public.news_submissions enable row level security;
alter table public.editor_access_requests enable row level security;

drop policy if exists "Active universities are visible" on public.universities;
create policy "Active universities are visible" on public.universities
  for select to anon, authenticated using (is_active);
drop policy if exists "Active academic units are visible" on public.academic_units;
create policy "Active academic units are visible" on public.academic_units
  for select to anon, authenticated using (is_active);
drop policy if exists "Users and admins can view roles" on public.user_roles;
create policy "Users and admins can view roles" on public.user_roles
  for select to authenticated using (user_id = auth.uid() or public.xelay_is_platform_admin());

drop policy if exists "Users can view their faculty news" on public.news_posts;
create policy "Users can view their faculty news" on public.news_posts
  for select to authenticated using (
    public.xelay_is_platform_admin()
    or public.xelay_can_manage_news(university_id, academic_unit_id)
    or (status = 'published' and public.xelay_can_read_news(id))
  );
drop policy if exists "Editors can create scoped news" on public.news_posts;
create policy "Editors can create scoped news" on public.news_posts
  for insert to authenticated with check (
    published_by = auth.uid() and public.xelay_can_manage_news(university_id, academic_unit_id)
  );
drop policy if exists "Editors can update scoped news" on public.news_posts;
create policy "Editors can update scoped news" on public.news_posts
  for update to authenticated using (public.xelay_can_manage_news(university_id, academic_unit_id))
  with check (public.xelay_can_manage_news(university_id, academic_unit_id));
drop policy if exists "Editors can delete scoped news" on public.news_posts;
create policy "Editors can delete scoped news" on public.news_posts
  for delete to authenticated using (public.xelay_can_manage_news(university_id, academic_unit_id));

drop policy if exists "Faculty members can read news comments" on public.news_comments;
create policy "Faculty members can read news comments" on public.news_comments
  for select to authenticated using (public.xelay_can_read_news(post_id));
drop policy if exists "Faculty members can comment on news" on public.news_comments;
create policy "Faculty members can comment on news" on public.news_comments
  for insert to authenticated with check (
    user_id = auth.uid() and public.xelay_can_read_news(post_id)
  );
drop policy if exists "Authors can remove own news comments" on public.news_comments;
create policy "Authors can remove own news comments" on public.news_comments
  for delete to authenticated using (user_id = auth.uid() or public.xelay_is_platform_admin());

drop policy if exists "Faculty members can see news likes" on public.news_likes;
create policy "Faculty members can see news likes" on public.news_likes
  for select to authenticated using (public.xelay_can_read_news(post_id));
drop policy if exists "Users can like faculty news" on public.news_likes;
create policy "Users can like faculty news" on public.news_likes
  for insert to authenticated with check (
    user_id = auth.uid() and public.xelay_can_read_news(post_id)
  );
drop policy if exists "Users can remove their news likes" on public.news_likes;
create policy "Users can remove their news likes" on public.news_likes
  for delete to authenticated using (user_id = auth.uid());

drop policy if exists "Authors and moderators can view news submissions" on public.news_submissions;
create policy "Authors and moderators can view news submissions" on public.news_submissions
  for select to authenticated using (
    user_id = auth.uid() or public.xelay_can_manage_news(university_id, academic_unit_id)
  );
drop policy if exists "Users can submit news for their unit" on public.news_submissions;
create policy "Users can submit news for their unit" on public.news_submissions
  for insert to authenticated with check (
    user_id = auth.uid() and status = 'pending' and reviewed_by is null
    and reviewed_at is null and published_post_id is null
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.university_id = news_submissions.university_id
        and p.academic_unit_id = news_submissions.academic_unit_id
    )
  );

drop policy if exists "Users and admins can view editor requests" on public.editor_access_requests;
create policy "Users and admins can view editor requests" on public.editor_access_requests
  for select to authenticated using (user_id = auth.uid() or public.xelay_is_platform_admin());
drop policy if exists "Users can request faculty editor access" on public.editor_access_requests;
create policy "Users can request faculty editor access" on public.editor_access_requests
  for insert to authenticated with check (
    user_id = auth.uid() and status = 'pending' and reviewed_by is null and reviewed_at is null
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid() and p.university_id = editor_access_requests.university_id
        and p.academic_unit_id = editor_access_requests.academic_unit_id
    )
  );

revoke all on public.universities, public.academic_units, public.user_roles,
  public.news_posts, public.news_comments, public.news_likes,
  public.news_submissions, public.editor_access_requests
  from public, anon, authenticated;
grant select on public.universities, public.academic_units to anon, authenticated;
grant select on public.user_roles to authenticated;
grant select, insert, update, delete on public.news_posts to authenticated;
grant select, insert, delete on public.news_comments, public.news_likes to authenticated;
grant select, insert on public.news_submissions to authenticated;
grant select, insert on public.editor_access_requests to authenticated;

create or replace function public.xelay_submit_editor_request(p_message text default '')
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
  select university_id, academic_unit_id into v_university_id, v_unit_id
  from public.profiles where id = auth.uid();
  if v_university_id is null or v_unit_id is null then
    raise exception 'Choose your university and faculty before applying';
  end if;
  insert into public.editor_access_requests (user_id, university_id, academic_unit_id, message)
  values (auth.uid(), v_university_id, v_unit_id, left(coalesce(p_message, ''), 1000))
  returning id into v_request_id;
  return v_request_id;
end;
$$;

create or replace function public.xelay_review_editor_request(p_request_id uuid, p_approve boolean)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.editor_access_requests%rowtype;
begin
  if auth.uid() is null or not public.xelay_is_platform_admin() then
    raise exception 'Platform administrator permission required';
  end if;
  select * into v_request from public.editor_access_requests
  where id = p_request_id and status = 'pending' for update;
  if not found then raise exception 'Pending editor request not found'; end if;
  update public.editor_access_requests
  set status = case when p_approve then 'approved' else 'rejected' end,
      reviewed_by = auth.uid(), reviewed_at = now()
  where id = p_request_id;
  if p_approve then
    insert into public.user_roles (user_id, role, university_id, academic_unit_id, granted_by)
    values (v_request.user_id, 'FACULTY_EDITOR', v_request.university_id, v_request.academic_unit_id, auth.uid())
    on conflict do nothing;
    insert into public.notifications (recipient_id, actor_id, actor_name, type, message, is_read)
    select v_request.user_id, auth.uid(), coalesce(nullif(p.full_name, ''), 'Адміністратор'),
      'editor_request_approved', 'підтвердив(-ла) ваш доступ редактора факультетських новин', false
    from public.profiles p where p.id = auth.uid();
  else
    insert into public.notifications (recipient_id, actor_id, actor_name, type, message, is_read)
    select v_request.user_id, auth.uid(), coalesce(nullif(p.full_name, ''), 'Адміністратор'),
      'editor_request_rejected', 'відхилив(-ла) вашу заявку на редакторський доступ', false
    from public.profiles p where p.id = auth.uid();
  end if;
end;
$$;

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
      university_id, academic_unit_id, post_type, title, excerpt, body, image_url,
      event_starts_at, event_location, organizer, registration_url, is_pinned, published_by
    ) values (
      v_submission.university_id, v_submission.academic_unit_id, v_submission.post_type,
      v_submission.title, v_submission.excerpt, v_submission.body, v_submission.image_url,
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

create or replace function public.xelay_admin_add_university(p_name text, p_slug text)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null or not public.xelay_is_platform_admin() then
    raise exception 'Platform administrator permission required';
  end if;
  if length(btrim(p_name)) not between 3 and 180 or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$' then
    raise exception 'University name or code is invalid';
  end if;
  insert into public.universities (name, slug) values (btrim(p_name), p_slug)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.xelay_admin_add_academic_unit(
  p_university_id uuid, p_name text, p_slug text, p_unit_type text
)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_id uuid;
begin
  if auth.uid() is null or not public.xelay_is_platform_admin() then
    raise exception 'Platform administrator permission required';
  end if;
  if length(btrim(p_name)) not between 3 and 180
    or p_slug !~ '^[a-z0-9]+(-[a-z0-9]+)*$'
    or p_unit_type not in ('faculty', 'institute', 'college', 'other') then
    raise exception 'Academic unit details are invalid';
  end if;
  insert into public.academic_units (university_id, name, slug, unit_type)
  values (p_university_id, btrim(p_name), p_slug, p_unit_type)
  returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.xelay_admin_stats()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or not public.xelay_is_platform_admin() then
    raise exception 'Platform administrator permission required';
  end if;
  return jsonb_build_object(
    'users', (select count(*) from public.profiles),
    'universities', (select count(*) from public.universities where is_active),
    'published_news', (select count(*) from public.news_posts where status = 'published'),
    'comments', (select count(*) from public.news_comments),
    'likes', (select count(*) from public.news_likes),
    'pending_editor_requests', (select count(*) from public.editor_access_requests where status = 'pending'),
    'pending_news_submissions', (select count(*) from public.news_submissions where status = 'pending')
  );
end;
$$;

revoke all on function public.xelay_is_platform_admin() from public, anon;
revoke all on function public.xelay_can_manage_news(uuid, uuid) from public, anon;
revoke all on function public.xelay_can_read_news(uuid) from public, anon;
revoke all on function public.xelay_submit_editor_request(text) from public, anon;
revoke all on function public.xelay_review_editor_request(uuid, boolean) from public, anon;
revoke all on function public.xelay_review_news_submission(uuid, text) from public, anon;
revoke all on function public.xelay_admin_stats() from public, anon;
revoke all on function public.xelay_admin_add_university(text, text) from public, anon;
revoke all on function public.xelay_admin_add_academic_unit(uuid, text, text, text) from public, anon;
grant execute on function public.xelay_is_platform_admin() to authenticated;
grant execute on function public.xelay_can_manage_news(uuid, uuid) to authenticated;
grant execute on function public.xelay_can_read_news(uuid) to authenticated;
grant execute on function public.xelay_submit_editor_request(text) to authenticated;
grant execute on function public.xelay_review_editor_request(uuid, boolean) to authenticated;
grant execute on function public.xelay_review_news_submission(uuid, text) to authenticated;
grant execute on function public.xelay_admin_stats() to authenticated;
grant execute on function public.xelay_admin_add_university(text, text) to authenticated;
grant execute on function public.xelay_admin_add_academic_unit(uuid, text, text, text) to authenticated;

-- Sharing creates recipient-only access to a published post through an accepted chat.
create or replace function public.xelay_can_share_news(
  p_post_id uuid, p_sender_id uuid, p_recipient_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.news_posts n
    join public.profiles s on s.id = p_sender_id
    where auth.uid() = p_sender_id and n.id = p_post_id and n.status = 'published'
      and n.university_id = s.university_id and n.academic_unit_id = s.academic_unit_id
  );
$$;

drop policy if exists "Conversation members can send messages" on public.messages;
create policy "Conversation members can send messages" on public.messages
  for insert to authenticated with check (
    auth.uid() = sender_id and read_at is null
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and ((c.user_one_id = sender_id and c.user_two_id = recipient_id)
          or (c.user_two_id = sender_id and c.user_one_id = recipient_id))
    )
    and (shared_post_id is null or public.xelay_can_share_news(shared_post_id, sender_id, recipient_id))
  );
revoke all on function public.xelay_can_share_news(uuid, uuid, uuid) from public, anon;
grant execute on function public.xelay_can_share_news(uuid, uuid, uuid) to authenticated;
