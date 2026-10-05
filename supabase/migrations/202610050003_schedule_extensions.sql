-- Extra lesson types, editable semester/year date shortcuts, and weekend copying.
-- Apply after 202610030003. Existing lessons and homework remain unchanged.
begin;
do $$
begin
  if to_regclass('public.study_group_schedule') is null
    or to_regclass('public.study_groups') is null
    or to_regclass('public.study_group_deputy_requests') is null
    or to_regclass('public.study_group_members') is null
    or to_regprocedure('public.xelay_lock_study_group_permission(uuid,text,boolean)') is null
    or to_regprocedure('public.xelay_schedule_occurs_on_date(smallint,date,date,text,date,date)') is null
    or to_regprocedure('public.xelay_import_study_group_timetable(uuid,jsonb)') is null then
    raise exception 'Apply study-group permissions and timetable migration 202610030003 before schedule extensions';
  end if;
end;
$$;

alter table public.study_group_schedule
  drop constraint if exists study_group_schedule_lesson_type_check;
alter table public.study_group_schedule
  add constraint study_group_schedule_lesson_type_check
  check(lesson_type in('lecture','seminar','practical','lab','makeup','replacement','module','final_assessment','test','other'));

-- Preserve the existing atomic import, adding only the five new lesson types.
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
      or v_lesson_type not in ('lecture','seminar','practical','lab','makeup','replacement','module','final_assessment','test','other')
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

revoke all on function public.xelay_import_study_group_timetable(uuid,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_import_study_group_timetable(uuid,jsonb) to authenticated;

-- Preview and copy use the same authoritative day filter and group lock.
-- A copy is additive, one-date only, and safe to retry after a lost response.
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
      select distinct on(s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),nullif(btrim(s.online_url),''),nullif(btrim(s.online_url_secondary),''),s.lesson_number) s.*
      from public.study_group_schedule s
      where s.group_id=p_group_id and public.xelay_schedule_occurs_on_date(
        s.weekday,s.valid_from,s.valid_until,s.week_pattern,s.week_anchor_date,p_source_date)
      order by s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),nullif(btrim(s.online_url),''),nullif(btrim(s.online_url_secondary),''),s.lesson_number,s.id
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
    and not exists(select 1 from jsonb_populate_recordset(null::public.study_group_schedule,v_sources) source
      where row(s.starts_at,s.ends_at,btrim(s.subject),s.lesson_type,btrim(s.location),
        nullif(btrim(s.online_url),''),nullif(btrim(s.online_url_secondary),''),s.lesson_number)
      is not distinct from row(source.starts_at,source.ends_at,btrim(source.subject),source.lesson_type,btrim(source.location),
        nullif(btrim(source.online_url),''),nullif(btrim(source.online_url_secondary),''),source.lesson_number));

  for v_source in select * from jsonb_populate_recordset(null::public.study_group_schedule,v_sources)
    order by starts_at,ends_at,id loop
    -- A manual identical lesson or a previous completed copy is not duplicated.
    if exists(select 1 from public.study_group_schedule s where s.group_id=p_group_id
      and public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,s.week_pattern,s.week_anchor_date,p_target_date)
      and s.starts_at=v_source.starts_at and s.ends_at=v_source.ends_at
      and btrim(s.subject)=btrim(v_source.subject) and s.lesson_type=v_source.lesson_type
      and btrim(s.location)=btrim(v_source.location)
      and nullif(btrim(s.online_url),'') is not distinct from nullif(btrim(v_source.online_url),'')
      and nullif(btrim(s.online_url_secondary),'') is not distinct from nullif(btrim(v_source.online_url_secondary),'')
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
        valid_from,valid_until,week_pattern,week_anchor_date,lesson_number,created_by
      ) values(
        p_group_id,extract(isodow from p_target_date)::smallint,v_source.starts_at,v_source.ends_at,
        btrim(v_source.subject),v_source.lesson_type,btrim(v_source.location),v_source.online_url,v_source.online_url_secondary,
        p_target_date,p_target_date,'every',null,v_source.lesson_number,auth.uid()
      );
    end if;
    v_copied:=v_copied+1;
  end loop;
  return jsonb_build_object('copied',v_copied,'skipped',v_skipped,'source_signature',v_signature,
    'lessons',case when p_preview then v_sources else '[]'::jsonb end);
end;
$$;
revoke all on function public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text) to authenticated;
comment on function public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text) is
  'Representative or schedule deputy with active group access. Preview/change detection; one-date weekend copies preserve source and homework, skip existing matches, rollback the complete batch on destination conflicts.';
comment on column public.study_group_schedule.lesson_type is
  'lecture, seminar, practical, lab, makeup, replacement, module, final_assessment, test, other. Academic permissions and annual/trial gates still apply.';
notify pgrst,'reload schema';
commit;
