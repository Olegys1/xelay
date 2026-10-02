-- Third seminar format, private assignment resources, and member discussion.
-- Apply after 202610010002_homework_resources and 202610010005_group_seminars.
-- Files are removed through the Storage API; no direct storage metadata deletion.
begin;

do $$
begin
  if to_regclass('public.study_group_seminars') is null
    or to_regprocedure('public.xelay_homework_resources_valid(uuid,jsonb,jsonb)') is null
    or to_regprocedure('public.xelay_lock_seminar_group(uuid,boolean)') is null then
    raise exception 'Apply homework resources and group seminars before seminar extensions';
  end if;
end;
$$;

alter table public.study_group_seminars
  drop constraint if exists study_group_seminars_format_check;
alter table public.study_group_seminars
  add constraint study_group_seminars_format_check check (format in ('questions', 'teams', 'booking')),
  add column if not exists resource_links jsonb not null default '[]'::jsonb,
  add column if not exists resource_attachments jsonb not null default '[]'::jsonb;
alter table public.study_group_seminars
  drop constraint if exists study_group_seminars_resources_check;
alter table public.study_group_seminars
  add constraint study_group_seminars_resources_check
    check (public.xelay_homework_resources_valid(group_id, resource_links, resource_attachments));
create index if not exists study_group_seminars_attachments_idx
  on public.study_group_seminars using gin (resource_attachments jsonb_path_ops);

alter table public.study_group_seminar_reservations
  drop constraint if exists study_group_seminar_reservations_role_check,
  drop constraint if exists study_group_seminar_reservations_check;
alter table public.study_group_seminar_reservations
  add constraint study_group_seminar_reservations_role_check
    check (role in ('primary', 'supplement', 'team', 'booking')),
  add constraint study_group_seminar_reservations_check check (
    (role in ('primary', 'supplement', 'booking') and question_id is not null and team_id is null)
    or (role = 'team' and team_id is not null and question_id is null)
  );

create table if not exists public.study_group_seminar_comments (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.study_groups(id) on delete cascade,
  seminar_id uuid not null,
  author_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (length(btrim(body)) between 1 and 4000 and body ~ '[^[:space:]]'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (seminar_id, group_id)
    references public.study_group_seminars(id, group_id) on delete cascade
);
create index if not exists study_group_seminar_comments_timeline_idx
  on public.study_group_seminar_comments(seminar_id, created_at, id);

-- Survives assignment/subject/schedule/group deletion, allowing the deleting
-- representative and upload owner to retry physical deletion through Storage.
-- UUIDs deliberately have no FK: account/group deletion must not lose cleanup.
create table if not exists public.study_group_seminar_file_cleanup (
  storage_path text primary key,
  cleanup_user_id uuid not null,
  owner_id uuid not null,
  created_at timestamptz not null default now(),
  check (public.xelay_homework_file_group(storage_path) is not null)
);
create index if not exists study_group_seminar_file_cleanup_user_idx
  on public.study_group_seminar_file_cleanup(cleanup_user_id, created_at);
create index if not exists study_group_seminar_file_cleanup_owner_idx
  on public.study_group_seminar_file_cleanup(owner_id, created_at);

-- Booking uses question capacities and one reservation per assignment.
-- Existing streak functions deliberately keep their questions-only filter.

create or replace function public.xelay_seminar_items_valid(p_items jsonb, p_format text)
returns boolean language plpgsql immutable set search_path = public, pg_temp
as $$
declare v_item jsonb; v_ids text[] := '{}'; v_names text[] := '{}'; v_id text; v_name text; v_capacity text;
begin
  if p_format is null or p_format not in ('questions', 'teams', 'booking')
    or jsonb_typeof(p_items) is distinct from 'array' then return false; end if;
  if jsonb_array_length(p_items) not between 1 and 30 then return false; end if;
  for v_item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(v_item) is distinct from 'object' then return false; end if;
    if p_format in ('questions', 'booking') then
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
    or p_format is null or p_format not in ('questions', 'teams', 'booking')
    or jsonb_typeof(p_questions) is distinct from 'array'
    or jsonb_typeof(p_teams) is distinct from 'array' then raise exception 'SEMINAR_INVALID_INPUT'; end if;
  if (p_format in ('questions', 'booking') and (not public.xelay_seminar_items_valid(p_questions, p_format) or jsonb_array_length(p_teams) <> 0))
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
  for v_item in select value from jsonb_array_elements(case when p_format in ('questions', 'booking') then p_questions else p_teams end) loop
    if v_item ? 'id' then
      v_item_id := (v_item ->> 'id')::uuid;
      if (p_format in ('questions', 'booking') and not exists (select 1 from public.study_group_seminar_questions where id = v_item_id and seminar_id = v_id))
        or (p_format = 'teams' and not exists (select 1 from public.study_group_seminar_teams where id = v_item_id and seminar_id = v_id)) then
        raise exception 'SEMINAR_INVALID_INPUT';
      end if;
      v_keep := array_append(v_keep, v_item_id);
    end if;
  end loop;
  if exists (select 1 from public.study_group_seminar_reservations r where r.seminar_id = v_id and (
      (r.question_id is not null and (p_format not in ('questions', 'booking') or not (r.question_id = any(v_keep))))
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
    and (p_format not in ('questions', 'booking') or not (id = any(v_keep)));
  delete from public.study_group_seminar_teams where seminar_id = v_id
    and (p_format <> 'teams' or not (id = any(v_keep)));
  for v_item in select value from jsonb_array_elements(case when p_format in ('questions', 'booking') then p_questions else p_teams end) loop
    v_position := v_position + 1;
    v_item_id := case when v_item ? 'id' then (v_item ->> 'id')::uuid else gen_random_uuid() end;
    if p_format in ('questions', 'booking') then
      v_capacity := (v_item ->> 'primary_capacity')::integer;
      if (select count(*) from public.study_group_seminar_reservations where question_id = v_item_id and role in ('primary', 'booking')) > v_capacity then
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
  if p_role is null or p_role not in ('primary', 'supplement', 'team', 'booking') or p_target_id is null
    or (v_seminar.format = 'questions' and p_role not in ('primary', 'supplement'))
    or (v_seminar.format = 'teams' and p_role <> 'team')
    or (v_seminar.format = 'booking' and p_role <> 'booking') then raise exception 'SEMINAR_INVALID_INPUT'; end if;
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

-- Discussion remains writable after the lesson starts, unlike reservations.
create or replace function public.xelay_add_seminar_comment(p_seminar_id uuid, p_body text)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid; v_id uuid;
begin
  select group_id into v_group_id from public.study_group_seminars where id = p_seminar_id;
  perform public.xelay_lock_seminar_group(v_group_id, false);
  if not exists (select 1 from public.study_group_seminars where id = p_seminar_id and group_id = v_group_id) then
    raise exception 'SEMINAR_NOT_FOUND';
  end if;
  if length(btrim(coalesce(p_body, ''))) not between 1 and 4000 or coalesce(p_body, '') !~ '[^[:space:]]' then
    raise exception 'SEMINAR_COMMENT_INVALID_INPUT';
  end if;
  insert into public.study_group_seminar_comments(group_id, seminar_id, author_id, body)
    values (v_group_id, p_seminar_id, auth.uid(), btrim(p_body)) returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.xelay_update_seminar_comment(p_comment_id uuid, p_body text)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid; v_comment public.study_group_seminar_comments%rowtype;
begin
  select group_id into v_group_id from public.study_group_seminar_comments where id = p_comment_id;
  if v_group_id is null then raise exception 'SEMINAR_COMMENT_NOT_FOUND'; end if;
  perform public.xelay_lock_seminar_group(v_group_id, false);
  select * into v_comment from public.study_group_seminar_comments where id = p_comment_id and group_id = v_group_id;
  if not found then raise exception 'SEMINAR_COMMENT_NOT_FOUND'; end if;
  if v_comment.author_id <> auth.uid() then raise exception 'SEMINAR_COMMENT_OWNER_REQUIRED' using errcode = '42501'; end if;
  if length(btrim(coalesce(p_body, ''))) not between 1 and 4000 or coalesce(p_body, '') !~ '[^[:space:]]' then
    raise exception 'SEMINAR_COMMENT_INVALID_INPUT';
  end if;
  update public.study_group_seminar_comments set body = btrim(p_body), updated_at = now()
    where id = p_comment_id and group_id = v_group_id;
end;
$$;

create or replace function public.xelay_delete_seminar_comment(p_comment_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid; v_comment public.study_group_seminar_comments%rowtype;
begin
  select group_id into v_group_id from public.study_group_seminar_comments where id = p_comment_id;
  if v_group_id is null then raise exception 'SEMINAR_COMMENT_NOT_FOUND'; end if;
  perform public.xelay_lock_seminar_group(v_group_id, false);
  select * into v_comment from public.study_group_seminar_comments where id = p_comment_id and group_id = v_group_id;
  if not found then raise exception 'SEMINAR_COMMENT_NOT_FOUND'; end if;
  if v_comment.author_id <> auth.uid()
    and not exists (select 1 from public.study_groups where id = v_group_id and representative_id = auth.uid()) then
    raise exception 'SEMINAR_COMMENT_OWNER_REQUIRED' using errcode = '42501';
  end if;
  delete from public.study_group_seminar_comments where id = p_comment_id and group_id = v_group_id;
end;
$$;

-- Clients subscribe to this group-scoped parent UPDATE as well as the comment
-- rows, so another participant's DELETE refreshes the discussion without an
-- unfiltered Realtime DELETE subscription or broadcasting deleted bodies.
create or replace function public.xelay_touch_seminar_discussion()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    update public.study_group_seminars set updated_at = now() where id = old.seminar_id;
    return old;
  end if;
  update public.study_group_seminars set updated_at = now() where id = new.seminar_id;
  return new;
end;
$$;
drop trigger if exists study_group_seminar_comments_touch on public.study_group_seminar_comments;
create trigger study_group_seminar_comments_touch after insert or update or delete
  on public.study_group_seminar_comments for each row execute function public.xelay_touch_seminar_discussion();

create or replace function public.xelay_can_upload_seminar_file(p_name text)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and public.xelay_homework_file_group(p_name) is not null
    and split_part(p_name, '/', 2) = auth.uid()::text
    and public.xelay_can_edit_homework_resources(public.xelay_homework_file_group(p_name));
$$;

create or replace function public.xelay_can_read_seminar_file(p_name text)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and public.xelay_homework_file_group(p_name) is not null and (
    exists (select 1 from public.study_group_seminars s
      where s.group_id = public.xelay_homework_file_group(p_name)
        and s.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path', p_name))
        and public.xelay_can_view_seminars(s.group_id))
    or (split_part(p_name, '/', 2) = auth.uid()::text
      and public.xelay_is_study_group_representative(public.xelay_homework_file_group(p_name)))
    or (exists (select 1 from public.study_group_seminar_file_cleanup c
        where c.storage_path = p_name and (c.cleanup_user_id = auth.uid() or c.owner_id = auth.uid()))
      and not exists (select 1 from public.study_group_seminars s
        where s.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path', p_name))))
  );
$$;

create or replace function public.xelay_can_remove_seminar_file(p_name text)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or public.xelay_homework_file_group(p_name) is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminar-file:' || p_name, 0));
  if exists (select 1 from public.study_group_seminars s
    where s.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path', p_name))) then return false; end if;
  return coalesce(public.xelay_can_upload_seminar_file(p_name), false)
    or exists (select 1 from public.study_group_seminar_file_cleanup c
      where c.storage_path = p_name and (c.cleanup_user_id = auth.uid() or c.owner_id = auth.uid()));
end;
$$;

-- Objects are immutable. Publishing/removing a descriptor takes the same path
-- lock as Storage DELETE, closing races between save and temporary-file cleanup.
create or replace function public.xelay_validate_seminar_resources()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_path text;
  v_paths text[] := '{}';
  v_metadata jsonb;
  v_object_owner text;
  v_existing boolean;
begin
  if tg_op <> 'DELETE' then
    if not public.xelay_homework_resources_valid(new.group_id, new.resource_links, new.resource_attachments) then
      raise exception 'SEMINAR_RESOURCE_INVALID_INPUT' using errcode = '23514';
    end if;
    if tg_op = 'UPDATE' then
      if new.group_id = old.group_id and new.resource_links is not distinct from old.resource_links
        and new.resource_attachments is not distinct from old.resource_attachments then return new; end if;
    elsif jsonb_array_length(new.resource_links) = 0 and jsonb_array_length(new.resource_attachments) = 0 then
      return new;
    end if;
    perform public.xelay_lock_seminar_group(new.group_id, true);
    for v_item in select value from jsonb_array_elements(new.resource_attachments) loop
      v_paths := array_append(v_paths, v_item ->> 'storage_path');
    end loop;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    for v_item in select value from jsonb_array_elements(old.resource_attachments) loop
      v_paths := array_append(v_paths, v_item ->> 'storage_path');
    end loop;
  end if;
  for v_path in select distinct path from unnest(v_paths) as paths(path) order by path loop
    perform pg_advisory_xact_lock(hashtextextended('xelay:seminar-file:' || v_path, 0));
  end loop;
  if tg_op <> 'DELETE' then
    for v_item in select value from jsonb_array_elements(new.resource_attachments) loop
      v_existing := false;
      if tg_op = 'UPDATE' and new.group_id = old.group_id then
        v_existing := old.resource_attachments @> jsonb_build_array(v_item);
      end if;
      v_path := v_item ->> 'storage_path';
      if exists (select 1 from public.study_group_seminars s where s.id <> new.id
        and s.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path', v_path))) then
        raise exception 'SEMINAR_RESOURCE_ALREADY_ATTACHED' using errcode = '23514';
      end if;
      if not v_existing and split_part(v_path, '/', 2) is distinct from auth.uid()::text then
        raise exception 'SEMINAR_RESOURCE_FORBIDDEN' using errcode = '42501';
      end if;
      select o.metadata, coalesce(to_jsonb(o) ->> 'owner_id', to_jsonb(o) ->> 'owner')
        into v_metadata, v_object_owner from storage.objects o
        where o.bucket_id = 'xelay-seminar-files' and o.name = v_path for key share;
      if not found then raise exception 'SEMINAR_RESOURCE_UPLOAD_MISSING' using errcode = '23514'; end if;
      if not v_existing and v_object_owner is distinct from auth.uid()::text then
        raise exception 'SEMINAR_RESOURCE_FORBIDDEN' using errcode = '42501';
      end if;
      if coalesce(v_metadata ->> 'size', '') !~ '^[0-9]+$'
        or (v_metadata ->> 'mimetype') is distinct from (v_item ->> 'mime_type') then
        raise exception 'SEMINAR_RESOURCE_METADATA_MISMATCH' using errcode = '23514';
      end if;
      if (v_metadata ->> 'size')::numeric <> (v_item ->> 'file_size')::numeric then
        raise exception 'SEMINAR_RESOURCE_METADATA_MISMATCH' using errcode = '23514';
      end if;
      delete from public.study_group_seminar_file_cleanup where storage_path = v_path;
    end loop;
  end if;
  if tg_op in ('UPDATE', 'DELETE') then
    for v_item in select value from jsonb_array_elements(old.resource_attachments) loop
      v_path := v_item ->> 'storage_path';
      if tg_op = 'UPDATE' then
        if new.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path', v_path)) then continue; end if;
      end if;
      insert into public.study_group_seminar_file_cleanup(storage_path, cleanup_user_id, owner_id)
        values (v_path, coalesce(auth.uid(), old.created_by), split_part(v_path, '/', 2)::uuid)
        on conflict (storage_path) do update set cleanup_user_id = excluded.cleanup_user_id, created_at = now();
    end loop;
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists study_group_seminars_resources_validate on public.study_group_seminars;
create trigger study_group_seminars_resources_validate before insert or update or delete
  on public.study_group_seminars for each row execute function public.xelay_validate_seminar_resources();

-- A separate, unambiguous RPC keeps old clients compatible and saves the
-- assignment plus resources in one transaction. Failures restore all old data.
create or replace function public.xelay_save_seminar_with_resources(
  p_group_id uuid, p_seminar_id uuid, p_schedule_id uuid, p_lesson_date date,
  p_title text, p_instructions text, p_format text, p_questions jsonb, p_teams jsonb,
  p_resource_links jsonb, p_resource_attachments jsonb
)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_id uuid;
begin
  perform public.xelay_lock_seminar_group(p_group_id, true);
  if not public.xelay_homework_resources_valid(p_group_id, p_resource_links, p_resource_attachments) then
    raise exception 'SEMINAR_RESOURCE_INVALID_INPUT' using errcode = '23514';
  end if;
  v_id := public.xelay_save_seminar(p_group_id, p_seminar_id, p_schedule_id, p_lesson_date,
    p_title, p_instructions, p_format, p_questions, p_teams);
  update public.study_group_seminars
    set resource_links = p_resource_links, resource_attachments = p_resource_attachments, updated_at = now()
    where id = v_id and group_id = p_group_id;
  return v_id;
end;
$$;

create or replace function public.xelay_ack_seminar_file_cleanup(p_storage_path text)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null or public.xelay_homework_file_group(p_storage_path) is null then
    raise exception 'SEMINAR_RESOURCE_FORBIDDEN' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminar-file:' || p_storage_path, 0));
  if not exists (select 1 from public.study_group_seminar_file_cleanup c
    where c.storage_path = p_storage_path and (c.cleanup_user_id = auth.uid() or c.owner_id = auth.uid())) then
    raise exception 'SEMINAR_RESOURCE_FORBIDDEN' using errcode = '42501';
  end if;
  if exists (select 1 from storage.objects where bucket_id = 'xelay-seminar-files' and name = p_storage_path) then
    raise exception 'SEMINAR_RESOURCE_CLEANUP_PENDING';
  end if;
  delete from public.study_group_seminar_file_cleanup
    where storage_path = p_storage_path and (cleanup_user_id = auth.uid() or owner_id = auth.uid());
end;
$$;

insert into storage.buckets(id, name, public, file_size_limit, allowed_mime_types)
values ('xelay-seminar-files', 'xelay-seminar-files', false, 20971520, array[
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'image/jpeg', 'image/png', 'image/webp',
  'application/zip', 'application/x-zip-compressed'
])
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Representatives upload private seminar files" on storage.objects;
create policy "Representatives upload private seminar files" on storage.objects
  for insert to authenticated with check (bucket_id = 'xelay-seminar-files' and public.xelay_can_upload_seminar_file(name));
drop policy if exists "Seminar members read private resources" on storage.objects;
create policy "Seminar members read private resources" on storage.objects
  for select to authenticated using (bucket_id = 'xelay-seminar-files' and public.xelay_can_read_seminar_file(name));
drop policy if exists "Representatives remove unused seminar files" on storage.objects;
create policy "Representatives remove unused seminar files" on storage.objects
  for delete to authenticated using (bucket_id = 'xelay-seminar-files' and public.xelay_can_remove_seminar_file(name));

-- Legacy permissive policies cannot expose this private bucket or overwrite an
-- immutable object, including to an anonymous client. Other buckets unchanged.
drop policy if exists "Seminar file upload guard" on storage.objects;
create policy "Seminar file upload guard" on storage.objects as restrictive
  for insert to anon, authenticated
  with check (bucket_id <> 'xelay-seminar-files' or public.xelay_can_upload_seminar_file(name));
drop policy if exists "Seminar file read guard" on storage.objects;
create policy "Seminar file read guard" on storage.objects as restrictive
  for select to anon, authenticated
  using (bucket_id <> 'xelay-seminar-files' or public.xelay_can_read_seminar_file(name));
drop policy if exists "Seminar file removal guard" on storage.objects;
create policy "Seminar file removal guard" on storage.objects as restrictive
  for delete to anon, authenticated
  using (bucket_id <> 'xelay-seminar-files' or public.xelay_can_remove_seminar_file(name));
drop policy if exists "Seminar file overwrite guard" on storage.objects;
create policy "Seminar file overwrite guard" on storage.objects as restrictive
  for update to anon, authenticated
  using (bucket_id <> 'xelay-seminar-files') with check (bucket_id <> 'xelay-seminar-files');

alter table public.study_group_seminar_comments enable row level security;
alter table public.study_group_seminar_file_cleanup enable row level security;
drop policy if exists "Seminar members read discussion" on public.study_group_seminar_comments;
create policy "Seminar members read discussion" on public.study_group_seminar_comments
  for select to authenticated using (public.xelay_can_view_seminars(group_id));
drop policy if exists "Users read own seminar file cleanup" on public.study_group_seminar_file_cleanup;
create policy "Users read own seminar file cleanup" on public.study_group_seminar_file_cleanup
  for select to authenticated using (cleanup_user_id = auth.uid() or owner_id = auth.uid());
revoke all on public.study_group_seminar_comments, public.study_group_seminar_file_cleanup
  from public, anon, authenticated, service_role;
grant select on public.study_group_seminar_comments, public.study_group_seminar_file_cleanup to authenticated, service_role;

revoke all on function public.xelay_add_seminar_comment(uuid,text),
  public.xelay_update_seminar_comment(uuid,text), public.xelay_delete_seminar_comment(uuid),
  public.xelay_touch_seminar_discussion(), public.xelay_can_upload_seminar_file(text),
  public.xelay_can_read_seminar_file(text), public.xelay_can_remove_seminar_file(text),
  public.xelay_validate_seminar_resources(),
  public.xelay_save_seminar_with_resources(uuid,uuid,uuid,date,text,text,text,jsonb,jsonb,jsonb,jsonb),
  public.xelay_ack_seminar_file_cleanup(text)
  from public, anon, authenticated, service_role;
grant execute on function public.xelay_add_seminar_comment(uuid,text),
  public.xelay_update_seminar_comment(uuid,text), public.xelay_delete_seminar_comment(uuid),
  public.xelay_save_seminar_with_resources(uuid,uuid,uuid,date,text,text,text,jsonb,jsonb,jsonb,jsonb),
  public.xelay_ack_seminar_file_cleanup(text) to authenticated;
-- Anonymous evaluations on unrelated buckets return false instead of failing
-- due to execute permissions. All three helpers require an authenticated UID.
grant execute on function public.xelay_can_upload_seminar_file(text),
  public.xelay_can_read_seminar_file(text), public.xelay_can_remove_seminar_file(text) to anon, authenticated;

comment on column public.study_group_seminars.resource_links is
  'Up to ten HTTP(S) material links for this dated seminar assignment.';
comment on column public.study_group_seminars.resource_attachments is
  'Up to ten private xelay-seminar-files descriptors. Upload first; save atomically; clean unused objects through Storage API.';
comment on table public.study_group_seminar_file_cleanup is
  'Private retry queue for physical Storage cleanup after attachment replacement or cascaded assignment deletion.';

-- Keep default replica identity: deleted comment bodies are never broadcast.
-- Parent assignment updates carry the group-scoped refresh signal for deletes.
do $$
declare v_table text;
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime' and not puballtables) then
    foreach v_table in array array['study_group_seminar_comments'] loop
      if not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
        and schemaname = 'public' and tablename = v_table) then
        execute format('alter publication supabase_realtime add table public.%I', v_table);
      end if;
    end loop;
  end if;
end;
$$;

notify pgrst, 'reload schema';
commit;

