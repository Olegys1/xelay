-- Apply after 202610030002_study_group_content_permissions.sql.
-- Alternating timetables retain the existing strict academic-content permissions.
begin;

do $$
begin
  if to_regclass('public.study_group_schedule') is null
    or to_regclass('public.study_group_deputy_requests') is null
    or to_regprocedure('public.xelay_assign_study_group_deputy(uuid,uuid,text[])') is null
    or to_regprocedure('public.xelay_has_study_group_permission(uuid,text)') is null
    or to_regprocedure('public.xelay_lock_study_group_permission(uuid,text,boolean)') is null
    or to_regprocedure('public.xelay_validate_study_group_delegated_content()') is null then
    raise exception 'Apply study group migrations through 202610030002 before the timetable';
  end if;
end;
$$;

alter table public.study_group_schedule
  add column if not exists week_pattern text not null default 'every',
  add column if not exists week_anchor_date date,
  add column if not exists lesson_number smallint;

alter table public.study_group_schedule
  drop constraint if exists study_group_schedule_week_pattern_check,
  drop constraint if exists study_group_schedule_week_anchor_check,
  drop constraint if exists study_group_schedule_lesson_number_check;

alter table public.study_group_schedule
  add constraint study_group_schedule_week_pattern_check
    check (week_pattern in ('every','upper','lower')),
  add constraint study_group_schedule_week_anchor_check check (
    (week_pattern='every' and week_anchor_date is null)
    or (week_pattern in ('upper','lower') and week_anchor_date is not null
      and isfinite(week_anchor_date) and extract(isodow from week_anchor_date)=1)
  ),
  add constraint study_group_schedule_lesson_number_check
    check (lesson_number is null or lesson_number between 1 and 12);

comment on column public.study_group_schedule.week_pattern is
  'every repeats weekly; upper/lower alternate around the Monday upper-week anchor.';
comment on column public.study_group_schedule.week_anchor_date is
  'Monday of an upper week. Required for alternating lessons, null for every week.';
comment on column public.study_group_schedule.lesson_number is
  'Optional lesson/pair number for the timetable, from 1 through 12.';

create or replace function public.xelay_schedule_occurs_on_date(
  p_weekday smallint,p_valid_from date,p_valid_until date,
  p_week_pattern text,p_week_anchor_date date,p_date date
)
returns boolean language plpgsql immutable set search_path = public, pg_temp
as $$
declare v_week integer;
begin
  if p_weekday is null or p_weekday not between 1 and 7
    or p_valid_from is null or p_valid_until is null or p_date is null
    or not isfinite(p_date)
    or p_valid_until<p_valid_from or p_date not between p_valid_from and p_valid_until
    or extract(isodow from p_date)::smallint<>p_weekday then
    return false;
  end if;
  -- Legacy schedules can use infinite range bounds; the actual lesson date
  -- and alternating-week anchor must still be finite calendar dates.
  if p_week_pattern='every' then return p_week_anchor_date is null; end if;
  if p_week_pattern is null or p_week_pattern not in ('upper','lower')
    or p_week_anchor_date is null or not isfinite(p_week_anchor_date)
    or extract(isodow from p_week_anchor_date)<>1 then
    return false;
  end if;
  -- Compare Mondays so the division is exact even for dates before the anchor.
  -- PostgreSQL's negative remainder is normalized to the range 0..1.
  v_week := (p_date-(extract(isodow from p_date)::integer-1)-p_week_anchor_date)/7;
  return mod(mod(v_week,2)+2,2)=case when p_week_pattern='upper' then 0 else 1 end;
end;
$$;

-- Replace only the recurrence portion of the delegated guard. Identity, author,
-- group locking, license checks and parent-deletion cleanup remain enforced.
create or replace function public.xelay_validate_study_group_delegated_content()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid; v_permission text;
begin
  v_group_id := case when tg_op='DELETE' then old.group_id else new.group_id end;
  v_permission := case when tg_table_name='study_group_schedule' then 'schedule' else 'homework' end;
  if tg_op='DELETE' and not exists (select 1 from public.study_groups where id=v_group_id) then return old; end if;
  perform public.xelay_lock_study_group_permission(v_group_id,v_permission,tg_op<>'DELETE');
  if tg_op='UPDATE' then
    if new.id is distinct from old.id or new.group_id is distinct from old.group_id
      or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
      raise exception 'STUDY_GROUP_CONTENT_IDENTITY_IMMUTABLE' using errcode='23514';
    end if;
    if tg_table_name='study_group_homework' then
      if new.schedule_item_id is distinct from old.schedule_item_id or new.lesson_date is distinct from old.lesson_date then
        raise exception 'STUDY_GROUP_CONTENT_IDENTITY_IMMUTABLE' using errcode='23514';
      end if;
    end if;
  elsif tg_op='INSERT' and new.created_by is distinct from auth.uid() then
    raise exception 'STUDY_GROUP_CONTENT_AUTHOR_REQUIRED' using errcode='42501';
  end if;
  if tg_table_name='study_group_schedule' then
    if tg_op<>'DELETE' and new.week_pattern='every' then new.week_anchor_date := null; end if;
    if tg_op='DELETE' and exists (select 1 from public.study_group_homework where schedule_item_id=old.id) then
      perform public.xelay_lock_study_group_permission(v_group_id,'homework',false);
    elsif tg_op='UPDATE' and exists (
      select 1 from public.study_group_homework h where h.schedule_item_id=old.id
        and not public.xelay_schedule_occurs_on_date(new.weekday,new.valid_from,new.valid_until,
          new.week_pattern,new.week_anchor_date,h.lesson_date)
    ) then
      raise exception 'STUDY_GROUP_SCHEDULE_HAS_HOMEWORK' using errcode='23514';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  new.updated_at := now();
  return new;
end;
$$;

create or replace function public.xelay_validate_study_group_homework()
returns trigger language plpgsql set search_path = public, pg_temp
as $$
begin
  if not exists (
    select 1 from public.study_group_schedule s
    where s.id=new.schedule_item_id and s.group_id=new.group_id
      and public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,
        s.week_pattern,s.week_anchor_date,new.lesson_date)
  ) then
    raise exception 'Homework date must match the selected recurring lesson' using errcode='23514';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- Atomic and additive: a failure rolls back every row of this import. Existing
-- schedules and homework are never deleted or replaced, including on re-import.
create or replace function public.xelay_import_study_group_timetable(p_group_id uuid,p_lessons jsonb)
returns integer language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_weekday smallint;
  v_starts_at time;
  v_ends_at time;
  v_subject text;
  v_lesson_type text;
  v_location text;
  v_online_url text;
  v_online_url_secondary text;
  v_valid_from date;
  v_valid_until date;
  v_week_pattern text;
  v_week_anchor_date date;
  v_lesson_number smallint;
  v_anchor_text text;
  v_count integer := 0;
begin
  -- This is the same group lock used by role changes and direct content writes.
  -- The corrected helper grants no schedule permission from admin status alone.
  perform public.xelay_lock_study_group_permission(p_group_id,'schedule',true);
  if p_lessons is null or jsonb_typeof(p_lessons) is distinct from 'array' then
    raise exception 'STUDY_GROUP_TIMETABLE_INVALID_INPUT' using errcode='22023';
  end if;
  if jsonb_array_length(p_lessons) not between 1 and 168
    or octet_length(p_lessons::text)>1048576 then
    raise exception 'STUDY_GROUP_TIMETABLE_INVALID_INPUT' using errcode='22023';
  end if;

  for v_item in select value from jsonb_array_elements(p_lessons) loop
    if jsonb_typeof(v_item) is distinct from 'object' then
      raise exception 'STUDY_GROUP_TIMETABLE_INVALID_INPUT' using errcode='22023';
    end if;
    if exists (select 1 from jsonb_object_keys(v_item) as keys(key) where key<>all(array[
      'weekday','starts_at','ends_at','subject','lesson_type','location','online_url',
      'online_url_secondary','valid_from','valid_until','week_pattern','week_anchor_date','lesson_number'
    ]::text[])) then
      raise exception 'STUDY_GROUP_TIMETABLE_INVALID_INPUT' using errcode='22023';
    end if;
    if jsonb_typeof(v_item->'weekday') is distinct from 'number'
      or (v_item->>'weekday') !~ '^[1-7]$'
      or jsonb_typeof(v_item->'starts_at') is distinct from 'string'
      or jsonb_typeof(v_item->'ends_at') is distinct from 'string'
      or jsonb_typeof(v_item->'subject') is distinct from 'string'
      or jsonb_typeof(v_item->'valid_from') is distinct from 'string'
      or jsonb_typeof(v_item->'valid_until') is distinct from 'string'
      or exists (select 1 from unnest(array['lesson_type','location','online_url','online_url_secondary',
        'week_pattern','week_anchor_date']::text[]) as optional(key)
        where v_item ? key and jsonb_typeof(v_item->key) not in ('string','null'))
      or (v_item ? 'lesson_number' and jsonb_typeof(v_item->'lesson_number') not in ('number','null')) then
      raise exception 'STUDY_GROUP_TIMETABLE_INVALID_INPUT' using errcode='22023';
    end if;
    if (v_item->>'starts_at') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
      or (v_item->>'ends_at') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
      or (v_item->>'valid_from') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or (v_item->>'valid_until') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'STUDY_GROUP_TIMETABLE_INVALID_INPUT' using errcode='22023';
    end if;

    v_subject := btrim(v_item->>'subject');
    v_lesson_type := coalesce(nullif(btrim(v_item->>'lesson_type'),''),'other');
    v_location := btrim(coalesce(v_item->>'location',''));
    v_online_url := nullif(btrim(v_item->>'online_url'),'');
    v_online_url_secondary := nullif(btrim(v_item->>'online_url_secondary'),'');
    v_week_pattern := coalesce(nullif(btrim(v_item->>'week_pattern'),''),'every');
    v_anchor_text := nullif(btrim(v_item->>'week_anchor_date'),'');
    if length(v_subject) not between 1 and 120 or v_subject ~ '[[:cntrl:]]'
      or length(v_location)>160 or v_location ~ '[[:cntrl:]]'
      or v_lesson_type not in ('lecture','seminar','practical','lab','other')
      or v_week_pattern not in ('every','upper','lower')
      or (v_online_url is not null and (length(v_online_url)>2048
        or v_online_url !~* '^https?://[^/?#[:space:]]+([/?#][^[:space:]]*)?$'))
      or (v_online_url_secondary is not null and (length(v_online_url_secondary)>2048
        or v_online_url_secondary !~* '^https?://[^/?#[:space:]]+([/?#][^[:space:]]*)?$'))
      or (v_item->>'lesson_number' is not null and (v_item->>'lesson_number') !~ '^([1-9]|1[0-2])$')
      or (v_anchor_text is not null and v_anchor_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') then
      raise exception 'STUDY_GROUP_TIMETABLE_INVALID_INPUT' using errcode='22023';
    end if;

    begin
      v_weekday := (v_item->>'weekday')::smallint;
      v_starts_at := (v_item->>'starts_at')::time;
      v_ends_at := (v_item->>'ends_at')::time;
      v_valid_from := (v_item->>'valid_from')::date;
      v_valid_until := (v_item->>'valid_until')::date;
      v_week_anchor_date := v_anchor_text::date;
      v_lesson_number := (v_item->>'lesson_number')::smallint;
    exception when invalid_text_representation or datetime_field_overflow or numeric_value_out_of_range then
      raise exception 'STUDY_GROUP_TIMETABLE_INVALID_INPUT' using errcode='22023';
    end;
    if v_week_pattern='every' then v_week_anchor_date := null; end if;
    if v_ends_at<=v_starts_at or not isfinite(v_valid_from) or not isfinite(v_valid_until)
      or v_valid_until<v_valid_from
      or (v_week_pattern<>'every' and (v_week_anchor_date is null
        or not isfinite(v_week_anchor_date) or extract(isodow from v_week_anchor_date)<>1))
      or not exists (select 1 from generate_series(0,13) as days(offset_days)
        where public.xelay_schedule_occurs_on_date(v_weekday,v_valid_from,v_valid_until,
          v_week_pattern,v_week_anchor_date,v_valid_from+offset_days)) then
      raise exception 'STUDY_GROUP_TIMETABLE_INVALID_INPUT' using errcode='22023';
    end if;

    -- At most fourteen dates cover the combined weekly/fortnightly cycle.
    -- Check actual occurrences so upper/lower lessons can share a time slot.
    -- An earlier row from this import is also visible here, rejecting repeats.
    if exists (
      select 1 from public.study_group_schedule s
      where s.group_id=p_group_id and s.weekday=v_weekday
        and s.starts_at=v_starts_at and s.ends_at=v_ends_at
        and btrim(s.subject)=v_subject and s.lesson_type=v_lesson_type
        and btrim(s.location)=v_location
        and nullif(btrim(s.online_url),'') is not distinct from v_online_url
        and nullif(btrim(s.online_url_secondary),'') is not distinct from v_online_url_secondary
        and s.valid_from<=v_valid_until and s.valid_until>=v_valid_from
        and exists (
          select 1 from generate_series(0,13) as days(offset_days)
          where public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,
            s.week_pattern,s.week_anchor_date,greatest(s.valid_from,v_valid_from)+offset_days)
            and public.xelay_schedule_occurs_on_date(v_weekday,v_valid_from,v_valid_until,
              v_week_pattern,v_week_anchor_date,greatest(s.valid_from,v_valid_from)+offset_days)
        )
    ) then
      raise exception 'STUDY_GROUP_TIMETABLE_DUPLICATE_LESSON' using errcode='23505';
    end if;
    insert into public.study_group_schedule(
      group_id,weekday,starts_at,ends_at,subject,lesson_type,location,online_url,
      online_url_secondary,valid_from,valid_until,week_pattern,week_anchor_date,lesson_number,created_by
    ) values (
      p_group_id,v_weekday,v_starts_at,v_ends_at,v_subject,v_lesson_type,v_location,v_online_url,
      v_online_url_secondary,v_valid_from,v_valid_until,v_week_pattern,v_week_anchor_date,v_lesson_number,auth.uid()
    );
    v_count := v_count+1;
  end loop;
  return v_count;
end;
$$;

revoke all on function public.xelay_schedule_occurs_on_date(smallint,date,date,text,date,date),
  public.xelay_validate_study_group_delegated_content(),public.xelay_validate_study_group_homework(),
  public.xelay_import_study_group_timetable(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_schedule_occurs_on_date(smallint,date,date,text,date,date),
  public.xelay_import_study_group_timetable(uuid,jsonb) to authenticated;

-- Private timetable reference images. Metadata mutations use one permissioned
-- RPC; Storage objects stay immutable and are removed only after detachment.
create or replace function public.xelay_timetable_image_group(p_name text)
returns uuid language plpgsql immutable set search_path = public, pg_temp
as $$
begin
  if p_name is null or length(p_name) > 128
    or p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[.](jpg|jpeg|png|webp)$' then
    return null;
  end if;
  return split_part(p_name, '/', 1)::uuid;
end;
$$;

create or replace function public.xelay_timetable_image_mime_allowed(p_name text,p_mime text)
returns boolean language sql immutable set search_path = public, pg_temp
as $$
  select coalesce(case lower(substring(p_name from '[.]([^.]*)$'))
    when 'jpg' then p_mime='image/jpeg'
    when 'jpeg' then p_mime='image/jpeg'
    when 'png' then p_mime='image/png'
    when 'webp' then p_mime='image/webp'
    else false end,false);
$$;

create or replace function public.xelay_can_view_timetable_photo_group(p_group_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and (
    public.xelay_is_study_group_representative(p_group_id)
    or exists (select 1 from public.study_group_members m
      where m.group_id=p_group_id and m.user_id=auth.uid() and m.status='accepted')
  );
$$;

create table if not exists public.study_group_timetable_photos (
  group_id uuid primary key references public.study_groups(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null check (length(btrim(file_name)) between 1 and 255
    and file_name !~ '[[:cntrl:]/\\]'),
  mime_type text not null check (mime_type in ('image/jpeg','image/png','image/webp')),
  file_size bigint not null check (file_size between 1 and 8388608),
  updated_at timestamptz not null default now(),
  updated_by uuid not null references public.profiles(id) on delete restrict,
  constraint study_group_timetable_photo_path_valid check (
    public.xelay_timetable_image_group(storage_path) is not null
    and public.xelay_timetable_image_group(storage_path)=group_id
    and public.xelay_timetable_image_mime_allowed(storage_path,mime_type)
  )
);
alter table public.study_group_timetable_photos enable row level security;
drop policy if exists "Accepted members read timetable photos" on public.study_group_timetable_photos;
create policy "Accepted members read timetable photos" on public.study_group_timetable_photos
  for select to authenticated using (public.xelay_can_view_timetable_photo_group(group_id));
revoke all on public.study_group_timetable_photos from public,anon,authenticated,service_role;
grant select on public.study_group_timetable_photos to authenticated,service_role;

-- Receipts grant access only to a particular detached photo. No group/profile
-- foreign keys: a role, membership, account or group deletion must not strand it.
create table if not exists public.study_group_timetable_photo_cleanup (
  storage_path text primary key,
  group_id uuid not null,
  cleanup_user_id uuid not null,
  owner_id uuid not null,
  created_at timestamptz not null default now(),
  constraint study_group_timetable_photo_cleanup_path_valid check (
    public.xelay_timetable_image_group(storage_path) is not null
    and public.xelay_timetable_image_group(storage_path)=group_id
  )
);
create index if not exists study_group_timetable_photo_cleanup_user_idx
  on public.study_group_timetable_photo_cleanup(cleanup_user_id,created_at);
create index if not exists study_group_timetable_photo_cleanup_owner_idx
  on public.study_group_timetable_photo_cleanup(owner_id,created_at);
alter table public.study_group_timetable_photo_cleanup enable row level security;
drop policy if exists "Users read own timetable photo cleanup" on public.study_group_timetable_photo_cleanup;
create policy "Users read own timetable photo cleanup" on public.study_group_timetable_photo_cleanup
  for select to authenticated using (cleanup_user_id=auth.uid() or owner_id=auth.uid());
revoke all on public.study_group_timetable_photo_cleanup from public,anon,authenticated,service_role;
grant select on public.study_group_timetable_photo_cleanup to authenticated,service_role;

-- Every Storage mutation acquires the common group lock before the file lock.
-- This serializes role revocation, photo association, and physical removal.
create or replace function public.xelay_can_upload_timetable_image(p_name text)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid := public.xelay_timetable_image_group(p_name);
begin
  if auth.uid() is null or v_group_id is null
    or split_part(p_name,'/',2)<>auth.uid()::text then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || v_group_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('xelay:timetable-image:' || p_name,0));
  return public.xelay_has_study_group_permission(v_group_id,'schedule')
    and exists (select 1 from public.billing_settings b where b.singleton
      and (not b.enforce_group_payment or public.xelay_group_has_access(v_group_id)));
end;
$$;

create or replace function public.xelay_can_read_timetable_image(p_name text)
returns boolean language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid := public.xelay_timetable_image_group(p_name);
begin
  if auth.uid() is null or v_group_id is null then return false; end if;
  if exists (select 1 from public.study_group_timetable_photos p
    where p.storage_path=p_name) then
    return public.xelay_can_view_timetable_photo_group(v_group_id);
  end if;
  if exists (select 1 from public.study_group_timetable_photo_cleanup c
    where c.storage_path=p_name and c.group_id=v_group_id
      and (c.cleanup_user_id=auth.uid() or c.owner_id=auth.uid())) then
    return true;
  end if;
  return split_part(p_name,'/',2)=auth.uid()::text
    and exists (select 1 from storage.objects o
      where o.bucket_id='xelay-timetable-images' and o.name=p_name
        and coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')=auth.uid()::text);
end;
$$;

create or replace function public.xelay_can_remove_timetable_image(p_name text)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid := public.xelay_timetable_image_group(p_name);
begin
  if auth.uid() is null or v_group_id is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || v_group_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('xelay:timetable-image:' || p_name,0));
  if exists (select 1 from public.study_group_timetable_photos p
    where p.storage_path=p_name) then return false; end if;
  -- A replacement actor's receipt survives role loss and grants only this
  -- detached path. It cannot expose or remove a currently attached photo.
  if exists (select 1 from public.study_group_timetable_photo_cleanup c
    where c.storage_path=p_name and c.group_id=v_group_id
      and (c.cleanup_user_id=auth.uid() or c.owner_id=auth.uid())) then
    return true;
  end if;
  -- Real owners can clean up detached uploads after losing their group role.
  if split_part(p_name,'/',2)=auth.uid()::text
    and exists (select 1 from storage.objects o
      where o.bucket_id='xelay-timetable-images' and o.name=p_name
        and coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')=auth.uid()::text) then
    return true;
  end if;
  return public.xelay_has_study_group_permission(v_group_id,'schedule')
    and exists (select 1 from public.billing_settings b where b.singleton
      and (not b.enforce_group_payment or public.xelay_group_has_access(v_group_id)));
end;
$$;

create or replace function public.xelay_validate_study_group_timetable_photo()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid; v_paths text[] := '{}'; v_path text; v_metadata jsonb; v_owner text;
  v_old_owner text; v_detaching boolean := false;
begin
  v_group_id := case when tg_op='DELETE' then old.group_id else new.group_id end;
  -- Privileged group deletion may detach its photo even after its license ends.
  if tg_op='DELETE' and not exists (select 1 from public.study_groups where id=v_group_id) then
    perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || v_group_id::text,0));
  else
    perform public.xelay_lock_study_group_permission(v_group_id,'schedule',true);
  end if;
  if tg_op='UPDATE' and new.group_id is distinct from old.group_id then
    raise exception 'STUDY_GROUP_CONTENT_IDENTITY_IMMUTABLE' using errcode='23514';
  end if;
  if tg_op<>'DELETE' then
    if public.xelay_timetable_image_group(new.storage_path) is distinct from new.group_id
      or new.storage_path is null
      or new.file_name is null or length(btrim(new.file_name)) not between 1 and 255
      or new.file_name ~ '[[:cntrl:]/\\]'
      or not public.xelay_timetable_image_mime_allowed(new.storage_path,new.mime_type)
      or new.file_size is null or new.file_size not between 1 and 8388608 then
      raise exception 'TIMETABLE_PHOTO_INVALID_INPUT' using errcode='22023';
    end if;
    v_paths := array_append(v_paths,new.storage_path);
  end if;
  if tg_op in ('UPDATE','DELETE') then v_paths := array_append(v_paths,old.storage_path); end if;
  for v_path in select distinct path from unnest(v_paths) as paths(path) order by path loop
    perform pg_advisory_xact_lock(hashtextextended('xelay:timetable-image:' || v_path,0));
  end loop;
  if tg_op<>'DELETE' then
    if split_part(new.storage_path,'/',2) is distinct from auth.uid()::text then
      raise exception 'TIMETABLE_PHOTO_FORBIDDEN' using errcode='42501';
    end if;
    select o.metadata,coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')
      into v_metadata,v_owner from storage.objects o
      where o.bucket_id='xelay-timetable-images' and o.name=new.storage_path for key share;
    if not found then raise exception 'TIMETABLE_PHOTO_UPLOAD_MISSING' using errcode='23514'; end if;
    if v_owner is distinct from auth.uid()::text then
      raise exception 'TIMETABLE_PHOTO_FORBIDDEN' using errcode='42501';
    end if;
    if coalesce(v_metadata->>'size','') !~ '^[0-9]+$'
      or (v_metadata->>'mimetype') is distinct from new.mime_type then
      raise exception 'TIMETABLE_PHOTO_METADATA_MISMATCH' using errcode='23514';
    end if;
    if (v_metadata->>'size')::numeric <> new.file_size::numeric then
      raise exception 'TIMETABLE_PHOTO_METADATA_MISMATCH' using errcode='23514';
    end if;
    -- Reattachment closes every former cleanup grant for this path.
    delete from public.study_group_timetable_photo_cleanup where storage_path=new.storage_path;
    new.updated_by := auth.uid();
    new.updated_at := now();
  end if;
  if tg_op='DELETE' then v_detaching := true;
  elsif tg_op='UPDATE' then v_detaching := old.storage_path is distinct from new.storage_path;
  end if;
  if v_detaching then
    -- Read the real Storage owner; descriptors and the path's user component
    -- cannot nominate somebody else as the cleanup owner. Missing objects need
    -- no receipt and do not prevent a clear/replacement from succeeding.
    select coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner') into v_old_owner
      from storage.objects o where o.bucket_id='xelay-timetable-images'
        and o.name=old.storage_path for key share;
    if found then
      if v_old_owner is null
        or v_old_owner !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
        raise exception 'TIMETABLE_PHOTO_METADATA_MISMATCH' using errcode='23514';
      end if;
      insert into public.study_group_timetable_photo_cleanup(
        storage_path,group_id,cleanup_user_id,owner_id
      ) values(old.storage_path,old.group_id,coalesce(auth.uid(),old.updated_by),v_old_owner::uuid)
        on conflict(storage_path) do update set group_id=excluded.group_id,
          cleanup_user_id=excluded.cleanup_user_id,owner_id=excluded.owner_id,created_at=now();
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists study_group_timetable_photo_guard on public.study_group_timetable_photos;
create trigger study_group_timetable_photo_guard before insert or update or delete
  on public.study_group_timetable_photos for each row
  execute function public.xelay_validate_study_group_timetable_photo();

-- Consumed receipts must not authorize a later upload that reuses a deleted
-- name. Physical deletion still happens through the Storage API, which removes
-- the storage.objects row and invokes this bucket-scoped internal trigger.
create or replace function public.xelay_cleanup_deleted_timetable_photo_storage()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if old.bucket_id='xelay-timetable-images' then
    delete from public.study_group_timetable_photo_cleanup where storage_path=old.name;
  end if;
  return old;
end;
$$;
drop trigger if exists study_group_timetable_photo_storage_cleanup on storage.objects;
create trigger study_group_timetable_photo_storage_cleanup after delete on storage.objects
  for each row when (old.bucket_id='xelay-timetable-images')
  execute function public.xelay_cleanup_deleted_timetable_photo_storage();

create or replace function public.xelay_set_study_group_timetable_photo(
  p_group_id uuid,p_storage_path text,p_file_name text,p_mime_type text,p_file_size bigint
)
returns jsonb language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_previous text; v_photo public.study_group_timetable_photos%rowtype;
  v_paths text[] := '{}'; v_path text;
begin
  perform public.xelay_lock_study_group_permission(p_group_id,'schedule',true);
  select storage_path into v_previous from public.study_group_timetable_photos
    where group_id=p_group_id for update;
  if v_previous is not null then v_paths := array_append(v_paths,v_previous); end if;
  if p_storage_path is not null then
    if public.xelay_timetable_image_group(p_storage_path) is distinct from p_group_id then
      raise exception 'TIMETABLE_PHOTO_INVALID_INPUT' using errcode='22023';
    end if;
    v_paths := array_append(v_paths,p_storage_path);
  end if;
  for v_path in select distinct path from unnest(v_paths) as paths(path) order by path loop
    perform pg_advisory_xact_lock(hashtextextended('xelay:timetable-image:' || v_path,0));
  end loop;
  if p_storage_path is null then
    delete from public.study_group_timetable_photos where group_id=p_group_id;
    return jsonb_build_object('previous_storage_path',v_previous,'photo',null::jsonb);
  end if;
  insert into public.study_group_timetable_photos(
    group_id,storage_path,file_name,mime_type,file_size,updated_by
  ) values(p_group_id,p_storage_path,p_file_name,p_mime_type,p_file_size,auth.uid())
    on conflict(group_id) do update set storage_path=excluded.storage_path,
      file_name=excluded.file_name,mime_type=excluded.mime_type,file_size=excluded.file_size,
      updated_by=excluded.updated_by,updated_at=now()
    returning * into v_photo;
  return jsonb_build_object('previous_storage_path',
    case when v_previous is distinct from p_storage_path then v_previous else null end,
    'photo',to_jsonb(v_photo));
end;
$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('xelay-timetable-images','xelay-timetable-images',false,8388608,
  array['image/jpeg','image/png','image/webp'])
on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

drop policy if exists "Schedule editors upload timetable images" on storage.objects;
create policy "Schedule editors upload timetable images" on storage.objects
  for insert to authenticated with check (bucket_id='xelay-timetable-images'
    and public.xelay_can_upload_timetable_image(name));
drop policy if exists "Accepted members read timetable images" on storage.objects;
create policy "Accepted members read timetable images" on storage.objects
  for select to authenticated using (bucket_id='xelay-timetable-images'
    and public.xelay_can_read_timetable_image(name));
drop policy if exists "Owners and schedule editors remove detached timetable images" on storage.objects;
create policy "Owners and schedule editors remove detached timetable images" on storage.objects
  for delete to authenticated using (bucket_id='xelay-timetable-images'
    and public.xelay_can_remove_timetable_image(name));

-- Restrictive guards also constrain older permissive policies on Storage.
drop policy if exists "Timetable image upload guard" on storage.objects;
create policy "Timetable image upload guard" on storage.objects as restrictive
  for insert to anon,authenticated with check (bucket_id<>'xelay-timetable-images'
    or public.xelay_can_upload_timetable_image(name));
drop policy if exists "Timetable image read guard" on storage.objects;
create policy "Timetable image read guard" on storage.objects as restrictive
  for select to anon,authenticated using (bucket_id<>'xelay-timetable-images'
    or public.xelay_can_read_timetable_image(name));
drop policy if exists "Timetable image removal guard" on storage.objects;
create policy "Timetable image removal guard" on storage.objects as restrictive
  for delete to anon,authenticated using (bucket_id<>'xelay-timetable-images'
    or public.xelay_can_remove_timetable_image(name));
drop policy if exists "Timetable image overwrite guard" on storage.objects;
create policy "Timetable image overwrite guard" on storage.objects as restrictive
  for update to anon,authenticated using (bucket_id<>'xelay-timetable-images')
  with check (bucket_id<>'xelay-timetable-images');

revoke all on function public.xelay_timetable_image_group(text),
  public.xelay_timetable_image_mime_allowed(text,text),
  public.xelay_can_view_timetable_photo_group(uuid),
  public.xelay_can_upload_timetable_image(text),public.xelay_can_read_timetable_image(text),
  public.xelay_can_remove_timetable_image(text),public.xelay_validate_study_group_timetable_photo(),
  public.xelay_cleanup_deleted_timetable_photo_storage(),
  public.xelay_set_study_group_timetable_photo(uuid,text,text,text,bigint)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_can_view_timetable_photo_group(uuid),
  public.xelay_set_study_group_timetable_photo(uuid,text,text,text,bigint) to authenticated;
-- Anonymous evaluation of guards on unrelated buckets must remain harmless.
grant execute on function public.xelay_can_upload_timetable_image(text),
  public.xelay_can_read_timetable_image(text),public.xelay_can_remove_timetable_image(text)
  to anon,authenticated;

comment on table public.study_group_timetable_photos is
  'One private reference image per group. Actual representatives and accepted appointed deputies with schedule permission replace metadata through the RPC; actual representatives and accepted members can read the attached image.';
comment on table public.study_group_timetable_photo_cleanup is
  'Private receipts for individual detached timetable image paths, visible to the detaching actor and actual Storage owner. Receipts survive role/group removal, disappear on reattachment or successful Storage deletion, and are not added to Realtime.';
comment on function public.xelay_set_study_group_timetable_photo(uuid,text,text,text,bigint) is
  'Attach an existing owned private JPEG/PNG/WebP upload, or clear by passing a null storage path. Returns the detached previous path and current photo descriptor; physical cleanup uses the Storage API after the RPC commits.';

-- Realtime readers receive only primary-key identity for deleted rows.
alter table public.study_group_schedule replica identity default;
alter table public.study_group_timetable_photos replica identity default;
do $$
begin
  if exists (select 1 from pg_publication where pubname='supabase_realtime' and not puballtables) then
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='study_group_schedule') then
      alter publication supabase_realtime add table public.study_group_schedule;
    end if;
    if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='study_group_timetable_photos') then
      alter publication supabase_realtime add table public.study_group_timetable_photos;
    end if;
  end if;
end;
$$;

notify pgrst, 'reload schema';

commit;

