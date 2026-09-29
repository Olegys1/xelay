-- Class representative verification and private study-group schedules.

create table if not exists public.class_representative_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  full_name text not null,
  university_id uuid not null references public.universities(id) on delete restrict,
  academic_unit_id uuid not null,
  specialty text not null default '',
  group_name text not null check (length(btrim(group_name)) between 1 and 80),
  telegram_username text,
  phone text,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint class_rep_request_unit_university_fkey
    foreign key (academic_unit_id, university_id)
    references public.academic_units(id, university_id) on delete restrict,
  constraint class_rep_request_contact_check check (
    (nullif(btrim(telegram_username), '') is not null)
    <> (nullif(btrim(phone), '') is not null)
  ),
  constraint class_rep_request_review_fields_check check (
    (status = 'pending' and reviewed_by is null and reviewed_at is null)
    or (status in ('approved', 'rejected') and reviewed_by is not null and reviewed_at is not null)
  )
);

create unique index if not exists class_rep_requests_one_active_per_user_idx
  on public.class_representative_requests (user_id)
  where status in ('pending', 'approved');
create index if not exists class_rep_requests_status_created_idx
  on public.class_representative_requests (status, created_at);

create table if not exists public.study_groups (
  id uuid primary key default gen_random_uuid(),
  representative_request_id uuid not null unique
    references public.class_representative_requests(id) on delete restrict,
  representative_id uuid not null references public.profiles(id) on delete restrict,
  university_id uuid not null references public.universities(id) on delete restrict,
  academic_unit_id uuid not null,
  specialty text not null default '',
  group_name text not null check (length(btrim(group_name)) between 1 and 80),
  created_at timestamptz not null default now(),
  constraint study_groups_unit_university_fkey
    foreign key (academic_unit_id, university_id)
    references public.academic_units(id, university_id) on delete restrict
);

create unique index if not exists study_groups_academic_identity_unique_idx
  on public.study_groups (university_id, academic_unit_id, lower(btrim(specialty)), lower(btrim(group_name)));
create index if not exists study_groups_representative_idx
  on public.study_groups (representative_id, created_at desc);

create table if not exists public.study_group_members (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.study_groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  invited_by uuid references public.profiles(id) on delete set null,
  status text not null check (status in ('pending', 'accepted', 'rejected', 'removed')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  accepted_at timestamptz,
  constraint study_group_members_unique_user unique (group_id, user_id)
);

create index if not exists study_group_members_user_status_idx
  on public.study_group_members (user_id, status, created_at desc);
create index if not exists study_group_members_group_status_idx
  on public.study_group_members (group_id, status, created_at);

create table if not exists public.study_group_schedule (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.study_groups(id) on delete cascade,
  weekday smallint not null check (weekday between 1 and 7),
  starts_at time not null,
  ends_at time not null,
  subject text not null check (length(btrim(subject)) between 1 and 120),
  lesson_type text not null default 'other'
    check (lesson_type in ('lecture', 'seminar', 'practical', 'lab', 'other')),
  location text not null default '' check (length(location) <= 160),
  online_url text check (online_url is null or online_url ~* '^https?://'),
  valid_from date not null,
  valid_until date not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint study_group_schedule_time_check check (ends_at > starts_at),
  constraint study_group_schedule_date_check check (valid_until >= valid_from)
);

create index if not exists study_group_schedule_group_weekday_idx
  on public.study_group_schedule (group_id, weekday, starts_at);

create table if not exists public.study_group_homework (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.study_groups(id) on delete cascade,
  schedule_item_id uuid not null references public.study_group_schedule(id) on delete cascade,
  lesson_date date not null,
  body text not null check (length(btrim(body)) between 1 and 10000),
  url text check (url is null or url ~* '^https?://'),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint study_group_homework_one_per_lesson unique (schedule_item_id, lesson_date)
);

create index if not exists study_group_homework_group_date_idx
  on public.study_group_homework (group_id, lesson_date);

alter table public.notifications
  add column if not exists study_group_id uuid references public.study_groups(id) on delete cascade,
  add column if not exists study_group_member_id uuid references public.study_group_members(id) on delete cascade;

create or replace function public.xelay_is_study_group_representative(p_group_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.study_groups g
    where g.id = p_group_id and g.representative_id = auth.uid()
  );
$$;

create or replace function public.xelay_can_view_study_group(p_group_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select public.xelay_is_platform_admin()
    or public.xelay_is_study_group_representative(p_group_id)
    or exists (
      select 1 from public.study_group_members m
      where m.group_id = p_group_id and m.user_id = auth.uid()
        and m.status in ('pending', 'accepted')
    );
$$;

create or replace function public.xelay_is_active_study_group_member(p_group_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select public.xelay_is_platform_admin()
    or public.xelay_is_study_group_representative(p_group_id)
    or exists (
      select 1 from public.study_group_members m
      where m.group_id = p_group_id and m.user_id = auth.uid() and m.status = 'accepted'
    );
$$;

revoke all on function public.xelay_is_study_group_representative(uuid) from public;
revoke all on function public.xelay_can_view_study_group(uuid) from public;
revoke all on function public.xelay_is_active_study_group_member(uuid) from public;
grant execute on function public.xelay_is_study_group_representative(uuid) to authenticated;
grant execute on function public.xelay_can_view_study_group(uuid) to authenticated;
grant execute on function public.xelay_is_active_study_group_member(uuid) to authenticated;

alter table public.class_representative_requests enable row level security;
alter table public.study_groups enable row level security;
alter table public.study_group_members enable row level security;
alter table public.study_group_schedule enable row level security;
alter table public.study_group_homework enable row level security;

drop policy if exists "Applicants and admins view class representative requests" on public.class_representative_requests;
create policy "Applicants and admins view class representative requests"
  on public.class_representative_requests for select to authenticated
  using (user_id = auth.uid() or public.xelay_is_platform_admin());

drop policy if exists "Users submit their own class representative requests" on public.class_representative_requests;
create policy "Users submit their own class representative requests"
  on public.class_representative_requests for insert to authenticated
  with check (
    user_id = auth.uid() and status = 'pending'
    and reviewed_by is null and reviewed_at is null
    and exists (
      select 1 from public.profiles p
      where p.id = auth.uid()
        and p.full_name = class_representative_requests.full_name
        and p.university_id = class_representative_requests.university_id
        and p.academic_unit_id = class_representative_requests.academic_unit_id
        and coalesce(p.specialty, '') = class_representative_requests.specialty
    )
  );

drop policy if exists "Group members and invited users can view group details" on public.study_groups;
create policy "Group members and invited users can view group details"
  on public.study_groups for select to authenticated
  using (public.xelay_can_view_study_group(id));

drop policy if exists "Users and representatives can view group membership" on public.study_group_members;
create policy "Users and representatives can view group membership"
  on public.study_group_members for select to authenticated
  using (user_id = auth.uid() or public.xelay_can_view_study_group(group_id));

drop policy if exists "Active group members can view the schedule" on public.study_group_schedule;
create policy "Active group members can view the schedule"
  on public.study_group_schedule for select to authenticated
  using (public.xelay_is_active_study_group_member(group_id));
drop policy if exists "Representatives manage group schedules" on public.study_group_schedule;
create policy "Representatives manage group schedules"
  on public.study_group_schedule for all to authenticated
  using (public.xelay_is_study_group_representative(group_id))
  with check (public.xelay_is_study_group_representative(group_id) and created_by = auth.uid());

drop policy if exists "Active group members can view homework" on public.study_group_homework;
create policy "Active group members can view homework"
  on public.study_group_homework for select to authenticated
  using (public.xelay_is_active_study_group_member(group_id));
drop policy if exists "Representatives manage group homework" on public.study_group_homework;
create policy "Representatives manage group homework"
  on public.study_group_homework for all to authenticated
  using (public.xelay_is_study_group_representative(group_id))
  with check (public.xelay_is_study_group_representative(group_id) and created_by = auth.uid());

revoke all on public.class_representative_requests, public.study_groups,
  public.study_group_members, public.study_group_schedule, public.study_group_homework
  from public, anon, authenticated;
grant select, insert on public.class_representative_requests to authenticated;
grant select on public.study_groups, public.study_group_members to authenticated;
grant select, insert, update, delete on public.study_group_schedule, public.study_group_homework to authenticated;

create or replace function public.xelay_submit_class_representative_request(
  p_group_name text,
  p_telegram_username text default null,
  p_phone text default null
)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_profile public.profiles%rowtype;
  v_request_id uuid;
  v_telegram text := nullif(btrim(p_telegram_username), '');
  v_phone text := nullif(btrim(p_phone), '');
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if length(btrim(coalesce(p_group_name, ''))) not between 1 and 80 then
    raise exception 'Enter a valid study group name';
  end if;
  if (v_telegram is null) = (v_phone is null) then
    raise exception 'Provide either a Telegram username or a phone number';
  end if;

  select * into v_profile from public.profiles where id = auth.uid();
  if not found or nullif(btrim(v_profile.full_name), '') is null
    or v_profile.university_id is null or v_profile.academic_unit_id is null
    or nullif(btrim(coalesce(v_profile.specialty, '')), '') is null then
    raise exception 'Complete your name, university, faculty, and specialty in your profile first';
  end if;

  insert into public.class_representative_requests (
    user_id, full_name, university_id, academic_unit_id, specialty,
    group_name, telegram_username, phone
  ) values (
    auth.uid(), v_profile.full_name, v_profile.university_id, v_profile.academic_unit_id,
    btrim(v_profile.specialty), btrim(p_group_name), v_telegram, v_phone
  ) returning id into v_request_id;
  return v_request_id;
end;
$$;

create or replace function public.xelay_review_class_representative_request(
  p_request_id uuid,
  p_approve boolean
)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.class_representative_requests%rowtype;
  v_actor_name text;
begin
  if auth.uid() is null or not public.xelay_is_platform_admin() then
    raise exception 'Platform administrator permission required';
  end if;
  select * into v_request from public.class_representative_requests
    where id = p_request_id for update;
  if not found or v_request.status <> 'pending' then
    raise exception 'Request not found or no longer pending';
  end if;
  update public.class_representative_requests
    set status = case when p_approve then 'approved' else 'rejected' end,
        reviewed_by = auth.uid(), reviewed_at = now()
    where id = p_request_id;
  select full_name into v_actor_name from public.profiles where id = auth.uid();
  insert into public.notifications (recipient_id, actor_id, actor_name, type, message, is_read)
  values (v_request.user_id, auth.uid(), coalesce(nullif(v_actor_name, ''), 'Адміністратор'),
    case when p_approve then 'class_rep_approved' else 'class_rep_rejected' end,
    case when p_approve then 'підтвердив(-ла) вашу заявку старости' else 'відхилив(-ла) вашу заявку старости' end,
    false);
end;
$$;

create or replace function public.xelay_create_study_group(p_request_id uuid)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.class_representative_requests%rowtype;
  v_group_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_request from public.class_representative_requests
    where id = p_request_id and user_id = auth.uid() and status = 'approved'
    for update;
  if not found then raise exception 'Approved class representative request not found'; end if;
  if exists (select 1 from public.study_groups where representative_request_id = p_request_id) then
    select id into v_group_id from public.study_groups where representative_request_id = p_request_id;
    return v_group_id;
  end if;

  insert into public.study_groups (
    representative_request_id, representative_id, university_id, academic_unit_id, specialty, group_name
  ) values (
    v_request.id, auth.uid(), v_request.university_id, v_request.academic_unit_id,
    v_request.specialty, v_request.group_name
  ) returning id into v_group_id;
  insert into public.study_group_members (group_id, user_id, invited_by, status, accepted_at)
  values (v_group_id, auth.uid(), auth.uid(), 'accepted', now());
  return v_group_id;
end;
$$;

create or replace function public.xelay_invite_to_study_group(p_group_id uuid, p_username text)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid;
  v_member_id uuid;
  v_member_status text;
begin
  if auth.uid() is null or not public.xelay_is_study_group_representative(p_group_id) then
    raise exception 'Only this group''s representative can invite members';
  end if;
  select id into v_user_id from public.profiles
    where lower(username) = lower(regexp_replace(btrim(p_username), '^@', ''));
  if v_user_id is null then raise exception 'Xelay user not found'; end if;
  if v_user_id = auth.uid() then raise exception 'You are already the group representative'; end if;

  select id, status into v_member_id, v_member_status from public.study_group_members
    where group_id = p_group_id and user_id = v_user_id for update;
  if found and v_member_status in ('accepted', 'pending') then return v_member_id; end if;
  if found then
    update public.study_group_members
      set status = 'pending', invited_by = auth.uid(), created_at = now(), updated_at = now(), accepted_at = null
      where id = v_member_id;
  else
    insert into public.study_group_members (group_id, user_id, invited_by, status)
      values (p_group_id, v_user_id, auth.uid(), 'pending') returning id into v_member_id;
  end if;
  return v_member_id;
end;
$$;

create or replace function public.xelay_respond_study_group_invitation(p_member_id uuid, p_accept boolean)
returns uuid
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_member public.study_group_members%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_member from public.study_group_members
    where id = p_member_id and user_id = auth.uid() for update;
  if not found or v_member.status <> 'pending' then
    raise exception 'Invitation not found or no longer pending';
  end if;
  update public.study_group_members
    set status = case when p_accept then 'accepted' else 'rejected' end,
        accepted_at = case when p_accept then now() else null end,
        updated_at = now()
    where id = p_member_id;
  return v_member.group_id;
end;
$$;

create or replace function public.xelay_remove_study_group_member(p_member_id uuid)
returns void
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_member public.study_group_members%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_member from public.study_group_members where id = p_member_id for update;
  if not found or not public.xelay_is_study_group_representative(v_member.group_id)
    or v_member.user_id = auth.uid() then
    raise exception 'Group representative permission required';
  end if;
  update public.study_group_members set status = 'removed', updated_at = now()
    where id = p_member_id and status in ('pending', 'accepted');
end;
$$;

create or replace function public.xelay_validate_study_group_homework()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.study_group_schedule s
    where s.id = new.schedule_item_id and s.group_id = new.group_id
      and extract(isodow from new.lesson_date)::smallint = s.weekday
      and new.lesson_date between s.valid_from and s.valid_until
  ) then
    raise exception 'Homework date must match the selected recurring lesson';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

drop trigger if exists study_group_homework_validate on public.study_group_homework;
create trigger study_group_homework_validate
  before insert or update on public.study_group_homework
  for each row execute function public.xelay_validate_study_group_homework();

create or replace function public.xelay_notify_study_group_member()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_group_name text;
  v_actor_name text;
  v_recipient_id uuid;
  v_type text;
  v_message text;
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending' then return new; end if;
    v_recipient_id := new.user_id;
    v_type := 'group_invite';
    v_message := 'запрошує вас до навчальної групи';
  elsif new.status = 'pending' and old.status is distinct from new.status then
    v_recipient_id := new.user_id;
    v_type := 'group_invite';
    v_message := 'повторно запрошує вас до навчальної групи';
  elsif new.status = 'accepted' and old.status = 'pending' then
    v_recipient_id := new.invited_by;
    v_type := 'group_invite_accepted';
    v_message := 'прийняв(-ла) запрошення до вашої навчальної групи';
  else
    return new;
  end if;
  if v_recipient_id is null or v_recipient_id = new.user_id and v_type = 'group_invite_accepted' then
    return new;
  end if;

  select group_name into v_group_name from public.study_groups where id = new.group_id;
  select full_name into v_actor_name from public.profiles where id = auth.uid();
  if v_type = 'group_invite_accepted' then
    select full_name into v_actor_name from public.profiles where id = new.user_id;
  end if;
  insert into public.notifications (
    recipient_id, actor_id, actor_name, type, message, is_read,
    study_group_id, study_group_member_id
  ) values (
    v_recipient_id, auth.uid(), coalesce(nullif(v_actor_name, ''), 'Учасник'), v_type,
    v_message || ' «' || coalesce(v_group_name, 'Навчальна група') || '»', false,
    new.group_id, new.id
  );
  return new;
end;
$$;

drop trigger if exists study_group_invite_notification_insert on public.study_group_members;
create trigger study_group_invite_notification_insert
  after insert on public.study_group_members
  for each row execute function public.xelay_notify_study_group_member();
drop trigger if exists study_group_invite_notification_update on public.study_group_members;
create trigger study_group_invite_notification_update
  after update of status on public.study_group_members
  for each row execute function public.xelay_notify_study_group_member();

create or replace function public.xelay_notify_study_group_homework()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_subject text;
  v_actor_name text;
  v_member record;
begin
  if tg_op = 'UPDATE' and old.body is not distinct from new.body and old.url is not distinct from new.url then
    return new;
  end if;
  select subject into v_subject from public.study_group_schedule where id = new.schedule_item_id;
  select full_name into v_actor_name from public.profiles where id = new.created_by;
  for v_member in
    select user_id from public.study_group_members
    where group_id = new.group_id and status = 'accepted' and user_id <> new.created_by
  loop
    insert into public.notifications (
      recipient_id, actor_id, actor_name, type, message, is_read, study_group_id
    ) values (
      v_member.user_id, new.created_by, coalesce(nullif(v_actor_name, ''), 'Староста'),
      'group_homework', 'додав(-ла) домашнє завдання: ' || coalesce(v_subject, 'Заняття'),
      false, new.group_id
    );
  end loop;
  return new;
end;
$$;

drop trigger if exists study_group_homework_notification on public.study_group_homework;
create trigger study_group_homework_notification
  after insert or update on public.study_group_homework
  for each row execute function public.xelay_notify_study_group_homework();

revoke all on function public.xelay_submit_class_representative_request(text, text, text) from public;
revoke all on function public.xelay_review_class_representative_request(uuid, boolean) from public;
revoke all on function public.xelay_create_study_group(uuid) from public;
revoke all on function public.xelay_invite_to_study_group(uuid, text) from public;
revoke all on function public.xelay_respond_study_group_invitation(uuid, boolean) from public;
revoke all on function public.xelay_remove_study_group_member(uuid) from public;
grant execute on function public.xelay_submit_class_representative_request(text, text, text) to authenticated;
grant execute on function public.xelay_review_class_representative_request(uuid, boolean) to authenticated;
grant execute on function public.xelay_create_study_group(uuid) to authenticated;
grant execute on function public.xelay_invite_to_study_group(uuid, text) to authenticated;
grant execute on function public.xelay_respond_study_group_invitation(uuid, boolean) to authenticated;
grant execute on function public.xelay_remove_study_group_member(uuid) to authenticated;
