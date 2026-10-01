-- Private dated seminar assignments and atomic question/team reservations.
-- Apply after study groups, participant billing, and the earlier migrations.
-- Recurrences are templates: assignments and reservations always belong to one date.
begin;

do $$
begin
  if to_regclass('public.study_groups') is null
    or to_regclass('public.study_group_members') is null
    or to_regclass('public.billing_settings') is null
    or to_regprocedure('public.xelay_group_has_access(uuid)') is null then
    raise exception 'Apply study groups and participant billing before group seminars';
  end if;
end;
$$;

create table if not exists public.study_group_seminar_subjects (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.study_groups(id) on delete cascade,
  name text not null check (length(btrim(name)) between 1 and 120),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, group_id)
);
create unique index if not exists study_group_seminar_subjects_name_idx
  on public.study_group_seminar_subjects(group_id, lower(btrim(name)));

create table if not exists public.study_group_seminar_schedule (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.study_groups(id) on delete cascade,
  subject_id uuid not null,
  weekday smallint not null check (weekday between 1 and 7),
  starts_at time not null,
  ends_at time not null,
  valid_from date not null,
  valid_until date not null,
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (isfinite(valid_from) and isfinite(valid_until) and valid_until >= valid_from),
  foreign key (subject_id, group_id)
    references public.study_group_seminar_subjects(id, group_id) on delete cascade,
  unique (id, group_id, subject_id)
);
create index if not exists study_group_seminar_schedule_calendar_idx
  on public.study_group_seminar_schedule(group_id, subject_id, weekday, starts_at);

create table if not exists public.study_group_seminars (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.study_groups(id) on delete cascade,
  subject_id uuid not null,
  schedule_id uuid not null,
  lesson_date date not null,
  -- Preserve the actual dated session's chronology when a template changes later.
  starts_at time not null,
  ends_at time not null,
  title text not null check (length(btrim(title)) between 1 and 160),
  instructions text not null default '' check (length(instructions) <= 10000),
  format text not null check (format in ('questions', 'teams')),
  created_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at > starts_at),
  check (isfinite(lesson_date)),
  foreign key (subject_id, group_id)
    references public.study_group_seminar_subjects(id, group_id) on delete cascade,
  foreign key (schedule_id, group_id, subject_id)
    references public.study_group_seminar_schedule(id, group_id, subject_id) on delete cascade,
  unique (schedule_id, lesson_date),
  unique (id, group_id)
);
create index if not exists study_group_seminars_calendar_idx
  on public.study_group_seminars(group_id, lesson_date, starts_at);
create index if not exists study_group_seminars_subject_history_idx
  on public.study_group_seminars(subject_id, lesson_date, starts_at, id);

create table if not exists public.study_group_seminar_questions (
  id uuid primary key default gen_random_uuid(),
  seminar_id uuid not null references public.study_group_seminars(id) on delete cascade,
  position integer not null check (position between 1 and 30),
  body text not null check (length(btrim(body)) between 1 and 2000),
  primary_capacity integer not null default 1 check (primary_capacity between 1 and 30),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, seminar_id),
  unique (seminar_id, position) deferrable initially deferred
);

create table if not exists public.study_group_seminar_teams (
  id uuid primary key default gen_random_uuid(),
  seminar_id uuid not null references public.study_group_seminars(id) on delete cascade,
  position integer not null check (position between 1 and 30),
  name text not null check (length(btrim(name)) between 1 and 80),
  capacity integer not null check (capacity between 1 and 50),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, seminar_id),
  unique (seminar_id, position) deferrable initially deferred
);

create table if not exists public.study_group_seminar_reservations (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.study_groups(id) on delete cascade,
  seminar_id uuid not null,
  user_id uuid not null references public.profiles(id) on delete cascade,
  role text not null check (role in ('primary', 'supplement', 'team')),
  question_id uuid,
  team_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (seminar_id, group_id)
    references public.study_group_seminars(id, group_id) on delete cascade,
  foreign key (question_id, seminar_id)
    references public.study_group_seminar_questions(id, seminar_id) on delete cascade,
  foreign key (team_id, seminar_id)
    references public.study_group_seminar_teams(id, seminar_id) on delete cascade,
  check (
    (role in ('primary', 'supplement') and question_id is not null and team_id is null)
    or (role = 'team' and team_id is not null and question_id is null)
  ),
  unique (seminar_id, user_id)
);
create index if not exists study_group_seminar_reservations_question_idx
  on public.study_group_seminar_reservations(question_id, role);
create index if not exists study_group_seminar_reservations_team_idx
  on public.study_group_seminar_reservations(team_id);
create index if not exists study_group_seminar_reservations_user_idx
  on public.study_group_seminar_reservations(group_id, user_id, seminar_id);

-- Pending invitations and platform-admin status alone do not grant participation.
create or replace function public.xelay_can_view_seminars(p_group_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from public.study_groups g where g.id = p_group_id and (
      g.representative_id = auth.uid() or exists (
        select 1 from public.study_group_members m
        where m.group_id = g.id and m.user_id = auth.uid() and m.status = 'accepted'
      )
    )
  );
$$;

create or replace function public.xelay_seminar_start(p_date date, p_time time)
returns timestamptz language sql stable set search_path = public, pg_temp
as $$ select (p_date + p_time) at time zone 'Europe/Kyiv'; $$;

-- VOLATILE checks take a fresh snapshot after the lock, including a concurrent
-- removal of a member. Every write on a group uses this same advisory lock.
create or replace function public.xelay_lock_seminar_group(p_group_id uuid, p_representative boolean)
returns void language plpgsql volatile security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'SEMINAR_AUTH_REQUIRED' using errcode = '42501'; end if;
  if p_group_id is null then raise exception 'SEMINAR_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || p_group_id::text, 0));
  if not exists (select 1 from public.study_groups where id = p_group_id) then
    raise exception 'SEMINAR_NOT_FOUND';
  end if;
  if p_representative then
    if not exists (select 1 from public.study_groups where id = p_group_id and representative_id = auth.uid()) then
      raise exception 'SEMINAR_REPRESENTATIVE_REQUIRED' using errcode = '42501';
    end if;
  elsif not exists (
    select 1 from public.study_groups g where g.id = p_group_id and (
      g.representative_id = auth.uid() or exists (
        select 1 from public.study_group_members m
        where m.group_id = g.id and m.user_id = auth.uid() and m.status = 'accepted'
      )
    )
  ) then
    raise exception 'SEMINAR_MEMBER_REQUIRED' using errcode = '42501';
  end if;
  if not exists (select 1 from public.billing_settings b where b.singleton
      and (not b.enforce_group_payment or public.xelay_group_has_access(p_group_id))) then
    raise exception 'GROUP_LICENSE_REQUIRED' using errcode = '42501';
  end if;
end;
$$;

create or replace function public.xelay_seminar_streak_internal(
  p_subject_id uuid, p_user_id uuid, p_before_seminar_id uuid default null
)
returns integer language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
  v_row record;
  v_before public.study_group_seminars%rowtype;
begin
  if p_before_seminar_id is not null then
    select * into v_before from public.study_group_seminars
      where id = p_before_seminar_id and subject_id = p_subject_id;
    if not found then raise exception 'SEMINAR_NOT_FOUND'; end if;
  end if;
  for v_row in
    select s.id, s.lesson_date, s.starts_at, r.role
    from public.study_group_seminars s
    left join public.study_group_seminar_reservations r
      on r.seminar_id = s.id and r.user_id = p_user_id
    where s.subject_id = p_subject_id and s.format = 'questions'
      and (p_before_seminar_id is null
        or (s.lesson_date, s.starts_at, s.id) < (v_before.lesson_date, v_before.starts_at, v_before.id))
    order by s.lesson_date, s.starts_at, s.id
  loop
    if v_row.role = 'primary' then
      v_count := v_count + 1;
    elsif v_row.role = 'supplement'
      or public.xelay_seminar_start(v_row.lesson_date, v_row.starts_at) <= now() then
      v_count := 0;
    end if;
    -- An unreserved future seminar is not a skipped seminar. Ignoring it closes
    -- the loophole of booking four answers by first leaving future gaps.
  end loop;
  return v_count;
end;
$$;

create or replace function public.xelay_seminar_streak(
  p_subject_id uuid, p_before_seminar_id uuid default null
)
returns integer language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid;
begin
  select group_id into v_group_id from public.study_group_seminar_subjects where id = p_subject_id;
  if v_group_id is null or not public.xelay_can_view_seminars(v_group_id) then
    raise exception 'SEMINAR_MEMBER_REQUIRED' using errcode = '42501';
  end if;
  return public.xelay_seminar_streak_internal(p_subject_id, auth.uid(), p_before_seminar_id);
end;
$$;

-- Validate the whole affected group after every mutation, including deleting
-- a reset, switching a team assignment's format, or changing recurring times.
create or replace function public.xelay_assert_seminar_streaks(p_group_id uuid, p_primary_attempt_id uuid default null)
returns void language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_user record; v_row record; v_count integer; v_cutoff timestamptz := clock_timestamp();
begin
  for v_user in
    select distinct r.user_id, s.subject_id
    from public.study_group_seminar_reservations r
    join public.study_group_seminars s on s.id = r.seminar_id
    where s.group_id = p_group_id and s.format = 'questions' and r.role = 'primary'
      and (public.xelay_seminar_start(s.lesson_date, s.starts_at) > v_cutoff or s.id = p_primary_attempt_id)
  loop
    v_count := 0;
    for v_row in
      select s.id, s.lesson_date, s.starts_at, r.role
      from public.study_group_seminars s
      left join public.study_group_seminar_reservations r
        on r.seminar_id = s.id and r.user_id = v_user.user_id
      where s.group_id = p_group_id and s.subject_id = v_user.subject_id and s.format = 'questions'
      order by s.lesson_date, s.starts_at, s.id
    loop
      if v_row.role = 'primary' then
        v_count := v_count + 1;
        if v_count > 3 and (public.xelay_seminar_start(v_row.lesson_date, v_row.starts_at) > v_cutoff or v_row.id = p_primary_attempt_id) then
          if v_row.id = p_primary_attempt_id then raise exception 'PRIMARY_STREAK_LIMIT'; end if;
          raise exception 'SEMINAR_FUTURE_STREAK_CONFLICT';
        end if;
      elsif v_row.role = 'supplement'
        or public.xelay_seminar_start(v_row.lesson_date, v_row.starts_at) <= v_cutoff then
        v_count := 0;
      end if;
    end loop;
  end loop;
end;
$$;

create or replace function public.xelay_save_seminar_subject(
  p_group_id uuid, p_subject_id uuid, p_name text
)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  perform public.xelay_lock_seminar_group(p_group_id, true);
  if length(btrim(coalesce(p_name, ''))) not between 1 and 120 then raise exception 'SEMINAR_INVALID_INPUT'; end if;
  if exists (select 1 from public.study_group_seminar_subjects
      where group_id = p_group_id and lower(btrim(name)) = lower(btrim(p_name))
        and (p_subject_id is null or id <> p_subject_id)) then
    raise exception 'SEMINAR_SUBJECT_EXISTS';
  end if;
  if p_subject_id is null then
    insert into public.study_group_seminar_subjects(group_id, name, created_by)
      values (p_group_id, btrim(p_name), auth.uid()) returning id into v_id;
  else
    update public.study_group_seminar_subjects set name = btrim(p_name), updated_at = now()
      where id = p_subject_id and group_id = p_group_id returning id into v_id;
    if v_id is null then raise exception 'SEMINAR_NOT_FOUND'; end if;
  end if;
  return v_id;
end;
$$;

create or replace function public.xelay_delete_seminar_subject(p_subject_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid;
begin
  select group_id into v_group_id from public.study_group_seminar_subjects where id = p_subject_id;
  perform public.xelay_lock_seminar_group(v_group_id, true);
  if not exists (select 1 from public.study_group_seminar_subjects where id = p_subject_id and group_id = v_group_id) then
    raise exception 'SEMINAR_NOT_FOUND';
  end if;
  if exists (select 1 from public.study_group_seminars where subject_id = p_subject_id
      and public.xelay_seminar_start(lesson_date, starts_at) <= clock_timestamp()) then raise exception 'SEMINAR_LOCKED'; end if;
  delete from public.study_group_seminar_subjects where id = p_subject_id and group_id = v_group_id;
  perform public.xelay_assert_seminar_streaks(v_group_id);
end;
$$;

create or replace function public.xelay_save_seminar_schedule(
  p_group_id uuid, p_schedule_id uuid, p_subject_id uuid, p_weekday integer,
  p_starts_at time, p_ends_at time, p_valid_from date, p_valid_until date
)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid; v_old_subject uuid;
begin
  perform public.xelay_lock_seminar_group(p_group_id, true);
  if p_weekday is null or p_weekday not between 1 and 7
    or p_starts_at is null or p_ends_at is null or p_ends_at <= p_starts_at
    or p_valid_from is null or p_valid_until is null or not isfinite(p_valid_from) or not isfinite(p_valid_until)
    or p_valid_until < p_valid_from
    or not exists (select 1 from public.study_group_seminar_subjects where id = p_subject_id and group_id = p_group_id) then
    raise exception 'SEMINAR_INVALID_INPUT';
  end if;
  if p_schedule_id is not null then
    select subject_id into v_old_subject from public.study_group_seminar_schedule
      where id = p_schedule_id and group_id = p_group_id;
    if not found then raise exception 'SEMINAR_NOT_FOUND'; end if;
    if exists (select 1 from public.study_group_seminars s where s.schedule_id = p_schedule_id and (
        v_old_subject <> p_subject_id
        or extract(isodow from s.lesson_date)::integer <> p_weekday
        or s.lesson_date not between p_valid_from and p_valid_until
        or (public.xelay_seminar_start(s.lesson_date, s.starts_at) > clock_timestamp()
          and public.xelay_seminar_start(s.lesson_date, p_starts_at) <= clock_timestamp())
      )) then raise exception 'SEMINAR_SCHEDULE_HAS_ASSIGNMENTS'; end if;
    update public.study_group_seminar_schedule
      set subject_id = p_subject_id, weekday = p_weekday::smallint,
        starts_at = p_starts_at, ends_at = p_ends_at,
        valid_from = p_valid_from, valid_until = p_valid_until, updated_at = now()
      where id = p_schedule_id and group_id = p_group_id returning id into v_id;
    update public.study_group_seminars set starts_at = p_starts_at, ends_at = p_ends_at, updated_at = now()
      where schedule_id = v_id and public.xelay_seminar_start(lesson_date, starts_at) > clock_timestamp();
    perform public.xelay_assert_seminar_streaks(p_group_id);
  else
    insert into public.study_group_seminar_schedule(
      group_id, subject_id, weekday, starts_at, ends_at, valid_from, valid_until, created_by
    ) values (p_group_id, p_subject_id, p_weekday::smallint, p_starts_at, p_ends_at,
      p_valid_from, p_valid_until, auth.uid()) returning id into v_id;
  end if;
  return v_id;
end;
$$;

create or replace function public.xelay_delete_seminar_schedule(p_schedule_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid;
begin
  select group_id into v_group_id from public.study_group_seminar_schedule where id = p_schedule_id;
  perform public.xelay_lock_seminar_group(v_group_id, true);
  if not exists (select 1 from public.study_group_seminar_schedule where id = p_schedule_id and group_id = v_group_id) then
    raise exception 'SEMINAR_NOT_FOUND';
  end if;
  if exists (select 1 from public.study_group_seminars where schedule_id = p_schedule_id
      and public.xelay_seminar_start(lesson_date, starts_at) <= clock_timestamp()) then raise exception 'SEMINAR_LOCKED'; end if;
  delete from public.study_group_seminar_schedule where id = p_schedule_id and group_id = v_group_id;
  perform public.xelay_assert_seminar_streaks(v_group_id);
end;
$$;

-- Validate bounded JSON before UUID/integer casts so malformed client payloads
-- yield a stable application error, never partially change an assignment.
create or replace function public.xelay_seminar_items_valid(p_items jsonb, p_format text)
returns boolean language plpgsql immutable set search_path = public, pg_temp
as $$
declare v_item jsonb; v_ids text[] := '{}'; v_names text[] := '{}'; v_id text; v_name text; v_capacity text;
begin
  if p_format is null or p_format not in ('questions', 'teams')
    or jsonb_typeof(p_items) is distinct from 'array' then return false; end if;
  if jsonb_array_length(p_items) not between 1 and 30 then return false; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) is distinct from 'object' then return false; end if;
    if p_format = 'questions' then
      if (v_item - array['id', 'body', 'primary_capacity']) <> '{}'::jsonb
        or jsonb_typeof(v_item -> 'body') is distinct from 'string'
        or length(btrim(v_item ->> 'body')) not between 1 and 2000
        or jsonb_typeof(v_item -> 'primary_capacity') is distinct from 'number' then return false; end if;
      v_capacity := v_item ->> 'primary_capacity';
      if v_capacity !~ '^[0-9]{1,2}$' then return false; end if;
      if v_capacity::integer not between 1 and 30 then return false; end if;
    else
      if (v_item - array['id', 'name', 'capacity']) <> '{}'::jsonb
        or jsonb_typeof(v_item -> 'name') is distinct from 'string'
        or length(btrim(v_item ->> 'name')) not between 1 and 80
        or jsonb_typeof(v_item -> 'capacity') is distinct from 'number' then return false; end if;
      v_name := lower(btrim(v_item ->> 'name'));
      if v_name = any(v_names) then return false; end if;
      v_names := array_append(v_names, v_name);
      v_capacity := v_item ->> 'capacity';
      if v_capacity !~ '^[0-9]{1,2}$' then return false; end if;
      if v_capacity::integer not between 1 and 50 then return false; end if;
    end if;
    if v_item ? 'id' then
      if jsonb_typeof(v_item -> 'id') is distinct from 'string' then return false; end if;
      v_id := lower(v_item ->> 'id');
      if v_id !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or v_id = any(v_ids) then return false; end if;
      v_ids := array_append(v_ids, v_id);
    end if;
  end loop;
  return true;
end;
$$;

create or replace function public.xelay_save_seminar(
  p_group_id uuid, p_seminar_id uuid, p_schedule_id uuid, p_lesson_date date,
  p_title text, p_instructions text, p_format text, p_questions jsonb, p_teams jsonb
)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_schedule public.study_group_seminar_schedule%rowtype;
  v_old public.study_group_seminars%rowtype;
  v_id uuid;
  v_item jsonb;
  v_item_id uuid;
  v_keep uuid[] := '{}';
  v_position integer := 0;
  v_capacity integer;
begin
  perform public.xelay_lock_seminar_group(p_group_id, true);
  if length(btrim(coalesce(p_title, ''))) not between 1 and 160
    or p_instructions is null or length(p_instructions) > 10000
    or p_format is null or p_format not in ('questions', 'teams')
    or jsonb_typeof(p_questions) is distinct from 'array'
    or jsonb_typeof(p_teams) is distinct from 'array' then raise exception 'SEMINAR_INVALID_INPUT'; end if;
  if (p_format = 'questions' and (not public.xelay_seminar_items_valid(p_questions, p_format) or jsonb_array_length(p_teams) <> 0))
    or (p_format = 'teams' and (not public.xelay_seminar_items_valid(p_teams, p_format) or jsonb_array_length(p_questions) <> 0)) then
    raise exception 'SEMINAR_INVALID_INPUT';
  end if;
  select * into v_schedule from public.study_group_seminar_schedule where id = p_schedule_id and group_id = p_group_id;
  if not found then raise exception 'SEMINAR_NOT_FOUND'; end if;
  if p_lesson_date is null or not isfinite(p_lesson_date) then raise exception 'SEMINAR_DATE_MISMATCH'; end if;
  if extract(isodow from p_lesson_date)::integer <> v_schedule.weekday
    or p_lesson_date not between v_schedule.valid_from and v_schedule.valid_until then raise exception 'SEMINAR_DATE_MISMATCH'; end if;
  if public.xelay_seminar_start(p_lesson_date, v_schedule.starts_at) <= clock_timestamp() then raise exception 'SEMINAR_LOCKED'; end if;
  if exists (select 1 from public.study_group_seminars where schedule_id = p_schedule_id and lesson_date = p_lesson_date
      and (p_seminar_id is null or id <> p_seminar_id)) then raise exception 'SEMINAR_ALREADY_EXISTS'; end if;
  if p_seminar_id is not null then
    select * into v_old from public.study_group_seminars where id = p_seminar_id and group_id = p_group_id;
    if not found then raise exception 'SEMINAR_NOT_FOUND'; end if;
    if public.xelay_seminar_start(v_old.lesson_date, v_old.starts_at) <= clock_timestamp() then raise exception 'SEMINAR_LOCKED'; end if;
    if (v_old.format <> p_format or v_old.subject_id <> v_schedule.subject_id)
      and exists (select 1 from public.study_group_seminar_reservations where seminar_id = p_seminar_id) then
      raise exception 'SEMINAR_HAS_RESERVATIONS';
    end if;
    v_id := p_seminar_id;
  else
    v_id := gen_random_uuid();
  end if;
  -- Provided IDs must already belong to this dated assignment. Client input
  -- cannot attach another seminar's question/team or invent a retained ID.
  for v_item in select value from jsonb_array_elements(case when p_format = 'questions' then p_questions else p_teams end) loop
    if v_item ? 'id' then
      v_item_id := (v_item ->> 'id')::uuid;
      if (p_format = 'questions' and not exists (select 1 from public.study_group_seminar_questions where id = v_item_id and seminar_id = v_id))
        or (p_format = 'teams' and not exists (select 1 from public.study_group_seminar_teams where id = v_item_id and seminar_id = v_id)) then
        raise exception 'SEMINAR_INVALID_INPUT';
      end if;
      v_keep := array_append(v_keep, v_item_id);
    end if;
  end loop;
  if exists (select 1 from public.study_group_seminar_reservations r where r.seminar_id = v_id and (
      (r.question_id is not null and (p_format <> 'questions' or not (r.question_id = any(v_keep))))
      or (r.team_id is not null and (p_format <> 'teams' or not (r.team_id = any(v_keep))))
    )) then raise exception 'SEMINAR_HAS_RESERVATIONS'; end if;
  if p_seminar_id is null then
    insert into public.study_group_seminars(id, group_id, subject_id, schedule_id, lesson_date, starts_at, ends_at, title, instructions, format, created_by)
      values (v_id, p_group_id, v_schedule.subject_id, v_schedule.id, p_lesson_date, v_schedule.starts_at,
        v_schedule.ends_at, btrim(p_title), p_instructions, p_format, auth.uid());
  else
    update public.study_group_seminars set subject_id = v_schedule.subject_id, schedule_id = v_schedule.id,
      lesson_date = p_lesson_date, starts_at = v_schedule.starts_at, ends_at = v_schedule.ends_at,
      title = btrim(p_title), instructions = p_instructions, format = p_format, updated_at = now()
      where id = v_id and group_id = p_group_id;
  end if;
  delete from public.study_group_seminar_questions where seminar_id = v_id
    and (p_format <> 'questions' or not (id = any(v_keep)));
  delete from public.study_group_seminar_teams where seminar_id = v_id
    and (p_format <> 'teams' or not (id = any(v_keep)));
  for v_item in select value from jsonb_array_elements(case when p_format = 'questions' then p_questions else p_teams end) loop
    v_position := v_position + 1;
    v_item_id := case when v_item ? 'id' then (v_item ->> 'id')::uuid else gen_random_uuid() end;
    if p_format = 'questions' then
      v_capacity := (v_item ->> 'primary_capacity')::integer;
      if (select count(*) from public.study_group_seminar_reservations where question_id = v_item_id and role = 'primary') > v_capacity then
        raise exception 'SEMINAR_CAPACITY_BELOW_MEMBERS';
      end if;
      insert into public.study_group_seminar_questions(id, seminar_id, position, body, primary_capacity)
        values (v_item_id, v_id, v_position, btrim(v_item ->> 'body'), v_capacity)
        on conflict (id) do update set position = excluded.position, body = excluded.body,
          primary_capacity = excluded.primary_capacity, updated_at = now();
    else
      v_capacity := (v_item ->> 'capacity')::integer;
      if (select count(*) from public.study_group_seminar_reservations where team_id = v_item_id) > v_capacity then
        raise exception 'SEMINAR_CAPACITY_BELOW_MEMBERS';
      end if;
      insert into public.study_group_seminar_teams(id, seminar_id, position, name, capacity)
        values (v_item_id, v_id, v_position, btrim(v_item ->> 'name'), v_capacity)
        on conflict (id) do update set position = excluded.position, name = excluded.name,
          capacity = excluded.capacity, updated_at = now();
    end if;
  end loop;
  perform public.xelay_assert_seminar_streaks(p_group_id);
  return v_id;
end;
$$;

create or replace function public.xelay_delete_seminar(p_seminar_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid; v_seminar public.study_group_seminars%rowtype;
begin
  select group_id into v_group_id from public.study_group_seminars where id = p_seminar_id;
  perform public.xelay_lock_seminar_group(v_group_id, true);
  select * into v_seminar from public.study_group_seminars where id = p_seminar_id and group_id = v_group_id;
  if not found then raise exception 'SEMINAR_NOT_FOUND'; end if;
  if public.xelay_seminar_start(v_seminar.lesson_date, v_seminar.starts_at) <= clock_timestamp() then raise exception 'SEMINAR_LOCKED'; end if;
  delete from public.study_group_seminars where id = p_seminar_id and group_id = v_group_id;
  perform public.xelay_assert_seminar_streaks(v_group_id);
end;
$$;

create or replace function public.xelay_reserve_seminar(p_seminar_id uuid, p_role text, p_target_id uuid)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid; v_seminar public.study_group_seminars%rowtype; v_capacity integer; v_count integer; v_id uuid;
begin
  select group_id into v_group_id from public.study_group_seminars where id = p_seminar_id;
  perform public.xelay_lock_seminar_group(v_group_id, false);
  select * into v_seminar from public.study_group_seminars where id = p_seminar_id and group_id = v_group_id;
  if not found then raise exception 'SEMINAR_NOT_FOUND'; end if;
  if public.xelay_seminar_start(v_seminar.lesson_date, v_seminar.starts_at) <= clock_timestamp() then raise exception 'SEMINAR_LOCKED'; end if;
  if p_role is null or p_role not in ('primary', 'supplement', 'team') or p_target_id is null
    or (v_seminar.format = 'questions' and p_role = 'team')
    or (v_seminar.format = 'teams' and p_role <> 'team') then raise exception 'SEMINAR_INVALID_INPUT'; end if;
  if p_role = 'team' then
    select capacity into v_capacity from public.study_group_seminar_teams where id = p_target_id and seminar_id = p_seminar_id;
    if not found then raise exception 'SEMINAR_NOT_FOUND'; end if;
    select count(*) into v_count from public.study_group_seminar_reservations where team_id = p_target_id and user_id <> auth.uid();
  else
    select case when p_role = 'supplement' then 3 else primary_capacity end into v_capacity
      from public.study_group_seminar_questions where id = p_target_id and seminar_id = p_seminar_id;
    if not found then raise exception 'SEMINAR_NOT_FOUND'; end if;
    select count(*) into v_count from public.study_group_seminar_reservations
      where question_id = p_target_id and role = p_role and user_id <> auth.uid();
  end if;
  if v_count >= v_capacity then raise exception 'SEMINAR_TARGET_FULL'; end if;
  -- A switch is one transaction: failed capacity/streak checks restore the old
  -- place instead of leaving the participant without a reservation.
  insert into public.study_group_seminar_reservations(group_id, seminar_id, user_id, role, question_id, team_id)
    values (v_group_id, p_seminar_id, auth.uid(), p_role,
      case when p_role <> 'team' then p_target_id else null end,
      case when p_role = 'team' then p_target_id else null end)
    on conflict (seminar_id, user_id) do update set role = excluded.role,
      question_id = excluded.question_id, team_id = excluded.team_id, updated_at = now()
    returning id into v_id;
  perform public.xelay_assert_seminar_streaks(v_group_id,
    case when p_role = 'primary' then p_seminar_id else null end);
  -- Realtime DELETE events cannot be filtered by group_id. A parent UPDATE
  -- lets group-scoped subscribers refresh counts for every reservation change.
  update public.study_group_seminars set updated_at = now() where id = p_seminar_id;
  return v_id;
end;
$$;

create or replace function public.xelay_cancel_seminar_reservation(p_seminar_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid; v_seminar public.study_group_seminars%rowtype;
begin
  select group_id into v_group_id from public.study_group_seminars where id = p_seminar_id;
  perform public.xelay_lock_seminar_group(v_group_id, false);
  select * into v_seminar from public.study_group_seminars where id = p_seminar_id and group_id = v_group_id;
  if not found then raise exception 'SEMINAR_NOT_FOUND'; end if;
  if public.xelay_seminar_start(v_seminar.lesson_date, v_seminar.starts_at) <= clock_timestamp() then raise exception 'SEMINAR_LOCKED'; end if;
  delete from public.study_group_seminar_reservations where seminar_id = p_seminar_id and user_id = auth.uid();
  perform public.xelay_assert_seminar_streaks(v_group_id);
  update public.study_group_seminars set updated_at = now() where id = p_seminar_id;
end;
$$;

-- Removing a member immediately frees future places. Historical roles remain
-- intact, so removing/reinviting someone cannot erase their answer history.
create or replace function public.xelay_cleanup_seminar_membership()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_cutoff timestamptz;
begin
  if tg_op = 'UPDATE' then
    if old.status <> 'accepted' or (new.status = 'accepted' and new.group_id = old.group_id and new.user_id = old.user_id) then return new; end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || old.group_id::text, 0));
  v_cutoff := clock_timestamp();
  with deleted as (
    delete from public.study_group_seminar_reservations r
      using public.study_group_seminars s
      where r.seminar_id = s.id and r.group_id = old.group_id and r.user_id = old.user_id
        and public.xelay_seminar_start(s.lesson_date, s.starts_at) > v_cutoff
      returning r.seminar_id
  )
  update public.study_group_seminars set updated_at = now() where id in (select seminar_id from deleted);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists study_group_members_seminar_cleanup on public.study_group_members;
create trigger study_group_members_seminar_cleanup before update or delete on public.study_group_members
  for each row execute function public.xelay_cleanup_seminar_membership();

alter table public.study_group_seminar_subjects enable row level security;
alter table public.study_group_seminar_schedule enable row level security;
alter table public.study_group_seminars enable row level security;
alter table public.study_group_seminar_questions enable row level security;
alter table public.study_group_seminar_teams enable row level security;
alter table public.study_group_seminar_reservations enable row level security;

drop policy if exists "Seminar members read subjects" on public.study_group_seminar_subjects;
create policy "Seminar members read subjects" on public.study_group_seminar_subjects
  for select to authenticated using (public.xelay_can_view_seminars(group_id));
drop policy if exists "Seminar members read recurring schedule" on public.study_group_seminar_schedule;
create policy "Seminar members read recurring schedule" on public.study_group_seminar_schedule
  for select to authenticated using (public.xelay_can_view_seminars(group_id));
drop policy if exists "Seminar members read assignments" on public.study_group_seminars;
create policy "Seminar members read assignments" on public.study_group_seminars
  for select to authenticated using (public.xelay_can_view_seminars(group_id));
drop policy if exists "Seminar members read questions" on public.study_group_seminar_questions;
create policy "Seminar members read questions" on public.study_group_seminar_questions
  for select to authenticated using (exists (select 1 from public.study_group_seminars s
    where s.id = study_group_seminar_questions.seminar_id and public.xelay_can_view_seminars(s.group_id)));
drop policy if exists "Seminar members read teams" on public.study_group_seminar_teams;
create policy "Seminar members read teams" on public.study_group_seminar_teams
  for select to authenticated using (exists (select 1 from public.study_group_seminars s
    where s.id = study_group_seminar_teams.seminar_id and public.xelay_can_view_seminars(s.group_id)));
drop policy if exists "Seminar members read active participant reservations" on public.study_group_seminar_reservations;
create policy "Seminar members read active participant reservations" on public.study_group_seminar_reservations
  for select to authenticated using (public.xelay_can_view_seminars(group_id) and exists (
    select 1 from public.study_groups g where g.id = study_group_seminar_reservations.group_id and (
      g.representative_id = study_group_seminar_reservations.user_id or exists (select 1 from public.study_group_members m
        where m.group_id = g.id and m.user_id = study_group_seminar_reservations.user_id and m.status = 'accepted')
    )
  ));

-- No direct client/service-role mutations: capacities, membership, chronology,
-- and role exclusivity must go through the locked SECURITY DEFINER RPCs.
revoke all on public.study_group_seminar_subjects, public.study_group_seminar_schedule,
  public.study_group_seminars, public.study_group_seminar_questions, public.study_group_seminar_teams,
  public.study_group_seminar_reservations from public, anon, authenticated, service_role;
grant select on public.study_group_seminar_subjects, public.study_group_seminar_schedule,
  public.study_group_seminars, public.study_group_seminar_questions, public.study_group_seminar_teams,
  public.study_group_seminar_reservations to authenticated, service_role;

revoke all on function public.xelay_can_view_seminars(uuid), public.xelay_seminar_start(date,time),
  public.xelay_lock_seminar_group(uuid,boolean), public.xelay_seminar_streak_internal(uuid,uuid,uuid),
  public.xelay_assert_seminar_streaks(uuid,uuid), public.xelay_seminar_items_valid(jsonb,text),
  public.xelay_cleanup_seminar_membership(), public.xelay_seminar_streak(uuid,uuid),
  public.xelay_save_seminar_subject(uuid,uuid,text), public.xelay_delete_seminar_subject(uuid),
  public.xelay_save_seminar_schedule(uuid,uuid,uuid,integer,time,time,date,date), public.xelay_delete_seminar_schedule(uuid),
  public.xelay_save_seminar(uuid,uuid,uuid,date,text,text,text,jsonb,jsonb), public.xelay_delete_seminar(uuid),
  public.xelay_reserve_seminar(uuid,text,uuid), public.xelay_cancel_seminar_reservation(uuid)
  from public, anon, authenticated, service_role;
grant execute on function public.xelay_can_view_seminars(uuid), public.xelay_seminar_streak(uuid,uuid),
  public.xelay_save_seminar_subject(uuid,uuid,text), public.xelay_delete_seminar_subject(uuid),
  public.xelay_save_seminar_schedule(uuid,uuid,uuid,integer,time,time,date,date), public.xelay_delete_seminar_schedule(uuid),
  public.xelay_save_seminar(uuid,uuid,uuid,date,text,text,text,jsonb,jsonb), public.xelay_delete_seminar(uuid),
  public.xelay_reserve_seminar(uuid,text,uuid), public.xelay_cancel_seminar_reservation(uuid) to authenticated;

-- Supabase Realtime respects these SELECT policies. This is optional when the
-- publication is absent, and safe when the migration is reapplied.
do $$
declare v_table text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables) then
    foreach v_table in array array['study_group_seminar_subjects', 'study_group_seminar_schedule',
      'study_group_seminars', 'study_group_seminar_questions', 'study_group_seminar_teams', 'study_group_seminar_reservations'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
          and schemaname = 'public' and tablename = v_table) then
        execute format('alter publication supabase_realtime add table public.%I', v_table);
      end if;
    end loop;
  end if;
end;
$$;

commit;
