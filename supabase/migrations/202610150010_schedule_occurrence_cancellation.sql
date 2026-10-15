-- Cancel one calendar occurrence without deleting the recurring lesson, its
-- homework or its files. Existing schedule membership/permission guards remain.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regclass('public.study_group_schedule') is null
    or to_regprocedure('public.xelay_lock_study_group_permission(uuid,text,boolean)') is null
    or to_regprocedure('public.xelay_schedule_occurs_on_date(smallint,date,date,text,date,date)') is null
    or to_regprocedure('public.xelay_import_study_group_timetable(uuid,jsonb)') is null
    or to_regprocedure('public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)') is null
    or not exists(select 1 from pg_attribute
      where attrelid=to_regclass('public.study_group_schedule')
        and attname='online_url_label' and not attisdropped) then
    raise exception 'Apply schedule link labels 202610150008 before occurrence cancellation';
  end if;
end;
$$;

alter table public.study_group_schedule
  add column if not exists excluded_dates date[] not null default '{}'::date[]
    constraint study_group_schedule_excluded_dates_check check (
      cardinality(excluded_dates)<=366
      and coalesce(array_ndims(excluded_dates),1)=1
      and array_position(excluded_dates,null) is null
    );

comment on column public.study_group_schedule.excluded_dates is
  'Calendar occurrences cancelled by an authorized schedule editor. The recurring lesson, date-specific homework and files are preserved.';

create or replace function public.xelay_normalize_study_group_schedule_exclusions()
returns trigger language plpgsql set search_path='' as $$
declare v_date date;
begin
  if new.excluded_dates is null or coalesce(array_ndims(new.excluded_dates),1)<>1 then
    raise exception 'STUDY_GROUP_SCHEDULE_EXCLUSIONS_INVALID' using errcode='22023';
  end if;
  if cardinality(new.excluded_dates)>366 then
    raise exception 'STUDY_GROUP_SCHEDULE_EXCLUSIONS_LIMIT' using errcode='22023';
  end if;
  foreach v_date in array new.excluded_dates loop
    if v_date is null or not isfinite(v_date)
      or v_date not between date '1900-01-01' and date '2200-12-31' then
      raise exception 'STUDY_GROUP_SCHEDULE_EXCLUSIONS_INVALID' using errcode='22023';
    end if;
  end loop;
  -- Recurrence edits may make old exceptions irrelevant. Retain only actual
  -- occurrences of the updated series, without touching date-specific homework.
  new.excluded_dates := array(select distinct cancelled_date
    from unnest(new.excluded_dates) as cancelled(cancelled_date)
    where public.xelay_schedule_occurs_on_date(new.weekday,new.valid_from,new.valid_until,
      new.week_pattern,new.week_anchor_date,cancelled_date)
    order by cancelled_date);
  return new;
end;
$$;
revoke all on function public.xelay_normalize_study_group_schedule_exclusions()
  from public,anon,authenticated,service_role;
drop trigger if exists study_group_schedule_exclusions on public.study_group_schedule;
create trigger study_group_schedule_exclusions before insert or update of
  excluded_dates,weekday,valid_from,valid_until,week_pattern,week_anchor_date
  on public.study_group_schedule for each row
  execute function public.xelay_normalize_study_group_schedule_exclusions();

create or replace function public.xelay_cancel_study_group_schedule_occurrence(
  p_group_id uuid,p_schedule_item_id uuid,p_lesson_date date
)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_schedule public.study_group_schedule%rowtype;
begin
  perform public.xelay_lock_study_group_permission(p_group_id,'schedule',true);
  -- Match schedule copy: platform admin status alone grants no schedule edit.
  if not exists(select 1 from public.study_groups g
      where g.id=p_group_id and g.representative_id=auth.uid())
    and not exists(select 1 from public.study_group_deputy_requests d
      join public.study_group_members m on m.group_id=d.group_id
        and m.user_id=d.user_id and m.status='accepted'
      where d.group_id=p_group_id and d.user_id=auth.uid()
        and d.status='approved' and 'schedule'=any(d.permissions)) then
    raise exception 'STUDY_GROUP_PERMISSION_REQUIRED' using errcode='42501';
  end if;
  if p_schedule_item_id is null or p_lesson_date is null or not isfinite(p_lesson_date)
    or p_lesson_date not between date '1900-01-01' and date '2200-12-31' then
    raise exception 'STUDY_GROUP_SCHEDULE_OCCURRENCE_INVALID' using errcode='22023';
  end if;
  select * into v_schedule from public.study_group_schedule
    where id=p_schedule_item_id and group_id=p_group_id for update;
  if not found then
    raise exception 'STUDY_GROUP_SCHEDULE_NOT_FOUND' using errcode='22023';
  end if;
  if not public.xelay_schedule_occurs_on_date(v_schedule.weekday,
    v_schedule.valid_from,v_schedule.valid_until,v_schedule.week_pattern,
    v_schedule.week_anchor_date,p_lesson_date) then
    raise exception 'STUDY_GROUP_SCHEDULE_OCCURRENCE_NOT_FOUND' using errcode='22023';
  end if;
  if not (p_lesson_date=any(v_schedule.excluded_dates)) then
    update public.study_group_schedule
      set excluded_dates=array_append(excluded_dates,p_lesson_date)
      where id=p_schedule_item_id and group_id=p_group_id;
  end if;
  return jsonb_build_object('cancelled',true,'schedule_item_id',p_schedule_item_id,
    'lesson_date',p_lesson_date);
end;
$$;
revoke all on function public.xelay_cancel_study_group_schedule_occurrence(uuid,uuid,date)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_cancel_study_group_schedule_occurrence(uuid,uuid,date)
  to authenticated;

-- The original six-argument occurrence predicate intentionally continues to
-- describe the series. Homework validation must accept retained homework on a
-- cancelled date. Import and day-copy below explicitly omit cancelled dates.

create or replace function public.xelay_import_study_group_timetable(p_group_id uuid,p_lessons jsonb)
returns integer language plpgsql volatile security definer set search_path = ''
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
  v_online_url_label text;
  v_online_url_secondary_label text;
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
      'online_url_secondary','online_url_label','online_url_secondary_label',
      'valid_from','valid_until','week_pattern','week_anchor_date','lesson_number'
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
        'online_url_label','online_url_secondary_label','week_pattern','week_anchor_date']::text[]) as optional(key)
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
    v_online_url_label := case when v_online_url is null then null else nullif(btrim(v_item->>'online_url_label'),'') end;
    v_online_url_secondary_label := case when v_online_url_secondary is null then null else nullif(btrim(v_item->>'online_url_secondary_label'),'') end;
    v_week_pattern := coalesce(nullif(btrim(v_item->>'week_pattern'),''),'every');
    v_anchor_text := nullif(btrim(v_item->>'week_anchor_date'),'');
    if length(v_subject) not between 1 and 120 or v_subject ~ '[[:cntrl:]]'
      or length(v_location)>160 or v_location ~ '[[:cntrl:]]'
      or v_lesson_type not in ('lecture','seminar','practical','lab','makeup','replacement','module','final_assessment','test','other')
      or v_week_pattern not in ('every','upper','lower')
      or (v_online_url is not null and (length(v_online_url)>2048
        or v_online_url !~* '^https?://[^/?#[:space:]]+([/?#][^[:space:]]*)?$'))
      or (v_online_url_secondary is not null and (length(v_online_url_secondary)>2048
        or v_online_url_secondary !~* '^https?://[^/?#[:space:]]+([/?#][^[:space:]]*)?$'))
      or (v_online_url_label is not null and (length(v_online_url_label)>80 or v_online_url_label ~ '[[:cntrl:]]'))
      or (v_online_url_secondary_label is not null and (length(v_online_url_secondary_label)>80 or v_online_url_secondary_label ~ '[[:cntrl:]]'))
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

    -- Fourteen dates cover the weekly/fortnightly cycle. Each cancellation can
    -- hide at most one matching date, so include another cycle per exception.
    -- This still rejects a repeating duplicate whose first weeks were cancelled
    -- while allowing a single replacement on an explicitly cancelled date.
    if exists (
      select 1 from public.study_group_schedule s
      where s.group_id=p_group_id and s.weekday=v_weekday
        and s.starts_at=v_starts_at and s.ends_at=v_ends_at
        and btrim(s.subject)=v_subject and s.lesson_type=v_lesson_type
        and btrim(s.location)=v_location
        and nullif(btrim(s.online_url),'') is not distinct from v_online_url
        and nullif(btrim(s.online_url_secondary),'') is not distinct from v_online_url_secondary
        and s.online_url_label is not distinct from v_online_url_label
        and s.online_url_secondary_label is not distinct from v_online_url_secondary_label
        and s.valid_from<=v_valid_until and s.valid_until>=v_valid_from
        and exists (
          select 1 from generate_series(0,13+14*cardinality(s.excluded_dates)) as days(offset_days)
          where public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,
            s.week_pattern,s.week_anchor_date,greatest(s.valid_from,v_valid_from)+offset_days)
            and not (greatest(s.valid_from,v_valid_from)+offset_days=any(s.excluded_dates))
            and public.xelay_schedule_occurs_on_date(v_weekday,v_valid_from,v_valid_until,
              v_week_pattern,v_week_anchor_date,greatest(s.valid_from,v_valid_from)+offset_days)
        )
    ) then
      raise exception 'STUDY_GROUP_TIMETABLE_DUPLICATE_LESSON' using errcode='23505';
    end if;
    insert into public.study_group_schedule(
      group_id,weekday,starts_at,ends_at,subject,lesson_type,location,online_url,
      online_url_secondary,online_url_label,online_url_secondary_label,
      valid_from,valid_until,week_pattern,week_anchor_date,lesson_number,created_by
    ) values (
      p_group_id,v_weekday,v_starts_at,v_ends_at,v_subject,v_lesson_type,v_location,v_online_url,
      v_online_url_secondary,v_online_url_label,v_online_url_secondary_label,
      v_valid_from,v_valid_until,v_week_pattern,v_week_anchor_date,v_lesson_number,auth.uid()
    );
    v_count := v_count+1;
  end loop;
  return v_count;
end;
$$;

-- CREATE OR REPLACE preserves both existing RPCs' owners and execute ACLs.
-- Preview/copy retain the same locks, appointment checks and conflict handling.
create or replace function public.xelay_copy_study_group_schedule_day(
  p_group_id uuid,p_source_date date,p_target_date date,
  p_preview boolean default false,p_expected_signature text default null
)
returns jsonb language plpgsql volatile security definer set search_path = '' as $$
declare
  v_sources jsonb;
  v_signature text;
  v_source public.study_group_schedule%rowtype;
  v_target_ids uuid[];
  v_copied integer:=0;
  v_skipped integer:=0;
begin
  perform public.xelay_lock_study_group_permission(p_group_id,'schedule',true);
  -- An older permission helper must not grant academic copying from a platform
  -- administrator role alone. Require the actual representative/appointment.
  if not exists(select 1 from public.study_groups g where g.id=p_group_id and g.representative_id=auth.uid())
    and not exists(select 1 from public.study_group_deputy_requests d
      join public.study_group_members m on m.group_id=d.group_id and m.user_id=d.user_id and m.status='accepted'
      where d.group_id=p_group_id and d.user_id=auth.uid() and d.status='approved' and 'schedule'=any(d.permissions)) then
    raise exception 'STUDY_GROUP_PERMISSION_REQUIRED' using errcode='42501';
  end if;
  if p_preview is null or p_source_date is null or p_target_date is null
    or not isfinite(p_source_date) or not isfinite(p_target_date)
    or p_source_date not between date '1900-01-01' and date '2200-12-31'
    or p_target_date not between date '1900-01-01' and date '2200-12-31'
    or p_source_date=p_target_date or extract(isodow from p_target_date) not in(6,7) then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_INVALID' using errcode='22023';
  end if;

  -- Identical source occurrences are represented once. Upper/lower lessons are
  -- selected on the explicit source date, not on the destination's week pattern.
  select coalesce(jsonb_agg(to_jsonb(source) order by source.starts_at,source.ends_at,source.id),'[]'::jsonb)
    into v_sources from(
      select distinct on(s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),nullif(btrim(s.online_url),''),nullif(btrim(s.online_url_secondary),''),s.online_url_label,s.online_url_secondary_label,s.lesson_number) s.*
      from public.study_group_schedule s
      where s.group_id=p_group_id and public.xelay_schedule_occurs_on_date(
        s.weekday,s.valid_from,s.valid_until,s.week_pattern,s.week_anchor_date,p_source_date)
        and not (p_source_date=any(s.excluded_dates))
      order by s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),nullif(btrim(s.online_url),''),nullif(btrim(s.online_url_secondary),''),s.online_url_label,s.online_url_secondary_label,s.lesson_number,s.id
    ) source;
  if jsonb_array_length(v_sources)=0 then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_SOURCE_EMPTY' using errcode='22023';
  end if;
  if jsonb_array_length(v_sources)>168 then
    raise exception 'STUDY_GROUP_TIMETABLE_TOO_MANY' using errcode='22023';
  end if;
  -- This digest is a change detector, not an authorization token.
  v_signature:=md5(p_source_date::text||':'||v_sources::text);
  if not p_preview and (p_expected_signature is null or p_expected_signature<>v_signature) then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_SOURCE_CHANGED' using errcode='22023';
  end if;
  select coalesce(array_agg(s.id),'{}'::uuid[]) into v_target_ids
    from public.study_group_schedule s where s.group_id=p_group_id
    and public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,s.week_pattern,s.week_anchor_date,p_target_date)
    and not (p_target_date=any(s.excluded_dates))
    and not exists(select 1 from jsonb_populate_recordset(null::public.study_group_schedule,v_sources) source
      where row(s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),
        nullif(btrim(s.online_url),''),nullif(btrim(s.online_url_secondary),''),s.online_url_label,s.online_url_secondary_label,s.lesson_number)
      is not distinct from row(source.starts_at,source.ends_at,btrim(source.subject),source.lesson_type,btrim(source.location),
        nullif(btrim(source.online_url),''),nullif(btrim(source.online_url_secondary),''),source.online_url_label,source.online_url_secondary_label,source.lesson_number));

  for v_source in select * from jsonb_populate_recordset(null::public.study_group_schedule,v_sources)
    order by starts_at,ends_at,id loop
    -- A manual identical lesson or a previous completed copy is not duplicated.
    if exists(select 1 from public.study_group_schedule s where s.group_id=p_group_id
      and public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,s.week_pattern,s.week_anchor_date,p_target_date)
      and not (p_target_date=any(s.excluded_dates))
      and s.starts_at=v_source.starts_at and s.ends_at=v_source.ends_at
      and btrim(s.subject)=btrim(v_source.subject) and s.lesson_type=v_source.lesson_type
      and btrim(s.location)=btrim(v_source.location)
      and nullif(btrim(s.online_url),'') is not distinct from nullif(btrim(v_source.online_url),'')
      and nullif(btrim(s.online_url_secondary),'') is not distinct from nullif(btrim(v_source.online_url_secondary),'')
      and s.online_url_label is not distinct from v_source.online_url_label
      and s.online_url_secondary_label is not distinct from v_source.online_url_secondary_label
      and s.lesson_number is not distinct from v_source.lesson_number) then
      v_skipped:=v_skipped+1;
      continue;
    end if;
    -- Only pre-existing destination lessons are conflicts. Overlapping source
    -- lessons are retained as given, e.g. parallel subgroups at the same time.
    if exists(select 1 from public.study_group_schedule s where s.group_id=p_group_id
      and s.id=any(v_target_ids) and s.starts_at<v_source.ends_at and s.ends_at>v_source.starts_at) then
      raise exception 'STUDY_GROUP_TIMETABLE_COPY_CONFLICT' using errcode='23505';
    end if;
    if not p_preview then
      insert into public.study_group_schedule(
        group_id,weekday,starts_at,ends_at,subject,lesson_type,location,online_url,online_url_secondary,
        online_url_label,online_url_secondary_label,
        valid_from,valid_until,week_pattern,week_anchor_date,lesson_number,created_by
      ) values(
        p_group_id,extract(isodow from p_target_date)::smallint,v_source.starts_at,v_source.ends_at,
        btrim(v_source.subject),v_source.lesson_type,btrim(v_source.location),v_source.online_url,v_source.online_url_secondary,
        v_source.online_url_label,v_source.online_url_secondary_label,
        p_target_date,p_target_date,'every',null,v_source.lesson_number,auth.uid()
      );
    end if;
    v_copied:=v_copied+1;
  end loop;
  return jsonb_build_object('copied',v_copied,'skipped',v_skipped,'source_signature',v_signature,
    'lessons',case when p_preview then v_sources else '[]'::jsonb end);
end;
$$;

notify pgrst,'reload schema';
commit;

