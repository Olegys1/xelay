-- A narrow caller/RLS operation for an assistant-confirmed, single-date lesson.
-- Journal service-role functions cannot call this; it uses the actual user's
-- JWT and serializes occurrence checking with existing timetable edits/copies.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $$begin
  if to_regclass('public.study_group_schedule') is null
    or to_regprocedure('public.xelay_has_study_group_permission(uuid,text)') is null
    or to_regprocedure('public.xelay_schedule_occurs_on_date(smallint,date,date,text,date,date)') is null
    or to_regprocedure('public.xelay_normalize_schedule_extra_links(jsonb)') is null
    or to_regprocedure('public.xelay_assistant_create_schedule(jsonb)') is not null then
    raise exception 'ASSISTANT_SCHEDULE_PREREQUISITE_OR_SCHEMA_DRIFT';
  end if;
end $$;

create function public.xelay_assistant_create_schedule(p_values jsonb)
returns jsonb language plpgsql security invoker set search_path='' set lock_timeout='3s' as $$
declare
  v public.study_group_schedule%rowtype;
  v_existing public.study_group_schedule%rowtype;
  v_user uuid:=auth.uid();
  v_keys text[]:=array['id','group_id','weekday','starts_at','ends_at','subject','teacher_name','lesson_type','location',
    'online_url','online_url_secondary','online_url_label','online_url_secondary_label','online_links_extra',
    'conference_id','conference_access_code','valid_from','valid_until','week_pattern','week_anchor_date','created_by'];
  v_key text;v_value text;
begin
  if v_user is null then raise exception 'ASSISTANT_SCHEDULE_CALLER_REQUIRED' using errcode='42501';end if;
  if p_values is null or jsonb_typeof(p_values) is distinct from 'object' or octet_length(p_values::text)>70000
    or not(p_values ?& v_keys) or exists(select 1 from jsonb_object_keys(p_values) k where not(k=any(v_keys))) then
    raise exception 'ASSISTANT_SCHEDULE_VALUES_INVALID' using errcode='22023';end if;
  foreach v_key in array array['id','group_id','starts_at','ends_at','subject','teacher_name','lesson_type','location','valid_from','valid_until','week_pattern','created_by'] loop
    if jsonb_typeof(p_values->v_key) is distinct from 'string' then
      raise exception 'ASSISTANT_SCHEDULE_VALUES_INVALID' using errcode='22023';end if;
  end loop;
  foreach v_key in array array['online_url','online_url_secondary','conference_id','conference_access_code'] loop
    if jsonb_typeof(p_values->v_key) not in('string','null') then
      raise exception 'ASSISTANT_SCHEDULE_VALUES_INVALID' using errcode='22023';end if;
  end loop;
  if jsonb_typeof(p_values->'weekday') is distinct from 'number'
    or p_values->'week_anchor_date' is distinct from 'null'::jsonb
    or p_values->'online_url_label' is distinct from 'null'::jsonb
    or p_values->'online_url_secondary_label' is distinct from 'null'::jsonb then
    raise exception 'ASSISTANT_SCHEDULE_VALUES_INVALID' using errcode='22023';end if;
  -- Cast only the fixed input shape, never arbitrary column names or SQL.
  select * into v from jsonb_populate_record(null::public.study_group_schedule,p_values);
  if v.id is null or v.id='00000000-0000-0000-0000-000000000000'::uuid or v.group_id is null
    or v.created_by is distinct from v_user or v.valid_from is null or not isfinite(v.valid_from)
    or v.valid_from not between date'2000-01-01' and date'2099-12-31' or v.valid_until is distinct from v.valid_from
    or v.weekday is distinct from extract(isodow from v.valid_from)::smallint
    or v.week_pattern is distinct from 'every' or v.week_anchor_date is not null
    or (p_values->>'starts_at') !~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$'
    or (p_values->>'ends_at') !~ '^(0[0-9]|1[0-9]|2[0-3]):[0-5][0-9]$'
    or v.starts_at is null or v.ends_at is null or v.starts_at>=v.ends_at
    or v.lesson_type is null or v.lesson_type not in('lecture','seminar','practical','lab','makeup','replacement','module','final_assessment','test','other')
    or v.subject is null or char_length(v.subject) not between 1 and 120 or v.subject<>btrim(v.subject)
    or v.teacher_name is null or char_length(v.teacher_name)>180 or v.teacher_name<>btrim(v.teacher_name)
    or v.location is null or char_length(v.location)>160 or v.location<>btrim(v.location)
    or v.online_url_label is not null or v.online_url_secondary_label is not null
    or v.online_links_extra is null or v.online_links_extra is distinct from public.xelay_normalize_schedule_extra_links(v.online_links_extra) then
    raise exception 'ASSISTANT_SCHEDULE_VALUES_INVALID' using errcode='22023';end if;
  foreach v_key in array array['subject','teacher_name','location','conference_id','conference_access_code'] loop
    v_value:=p_values->>v_key;
    if v_value ~ '[[:cntrl:]]' or v_value ~ U&'[\0080-\009F\202A-\202E\2066-\2069]'
      or (v_key in('conference_id','conference_access_code') and v_value is not null
        and (char_length(v_value)>120 or v_value='' or v_value<>btrim(v_value))) then
      raise exception 'ASSISTANT_SCHEDULE_VALUES_INVALID' using errcode='22023';end if;
  end loop;
  foreach v_key in array array['online_url','online_url_secondary'] loop
    v_value:=p_values->>v_key;
    if v_value is not null and(char_length(v_value)>2000
      or v_value !~* '^https?://[^/?#[:space:]@]+([/?#][^[:space:]]*)?$'
      or v_value ~ U&'[\0080-\009F\202A-\202E\2066-\2069]') then
      raise exception 'ASSISTANT_SCHEDULE_VALUES_INVALID' using errcode='22023';end if;
  end loop;
  if not coalesce(public.xelay_has_study_group_permission(v.group_id,'schedule'),false) then
    raise exception 'ASSISTANT_SCHEDULE_PERMISSION_REQUIRED' using errcode='42501';end if;
  -- Same key as timetable insert/update/delete, imports and weekend copies.
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:'||v.group_id::text,0));
  if not coalesce(public.xelay_has_study_group_permission(v.group_id,'schedule'),false) then
    raise exception 'ASSISTANT_SCHEDULE_PERMISSION_REQUIRED' using errcode='42501';end if;
  select * into v_existing from public.study_group_schedule where id=v.id;
  if found then
    if not exists(select 1 from unnest(v_keys) k where(to_jsonb(v_existing)->k) is distinct from(to_jsonb(v)->k))
      and v_existing.created_by=v_user and v_existing.group_id=v.group_id
      and cardinality(v_existing.excluded_dates)=0 and v_existing.copied_from_schedule_id is null then
      return jsonb_build_object('id',v_existing.id);
    end if;
    raise exception 'ASSISTANT_SCHEDULE_ID_CONFLICT' using errcode='PT409';
  end if;
  if exists(select 1 from public.study_group_schedule s where s.group_id=v.group_id
    and public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,s.week_pattern,s.week_anchor_date,v.valid_from)
    and not(v.valid_from=any(s.excluded_dates))
    and s.starts_at<v.ends_at and s.ends_at>v.starts_at) then
    raise exception 'ASSISTANT_SCHEDULE_OVERLAP' using errcode='PT409';end if;
  insert into public.study_group_schedule(id,group_id,weekday,starts_at,ends_at,subject,teacher_name,lesson_type,location,
    online_url,online_url_secondary,online_url_label,online_url_secondary_label,online_links_extra,
    conference_id,conference_access_code,valid_from,valid_until,week_pattern,week_anchor_date,created_by)
  values(v.id,v.group_id,v.weekday,v.starts_at,v.ends_at,v.subject,v.teacher_name,v.lesson_type,v.location,
    v.online_url,v.online_url_secondary,v.online_url_label,v.online_url_secondary_label,v.online_links_extra,
    v.conference_id,v.conference_access_code,v.valid_from,v.valid_until,v.week_pattern,v.week_anchor_date,v_user)
  returning * into v_existing;
  return jsonb_build_object('id',v_existing.id);
end $$;
revoke all on function public.xelay_assistant_create_schedule(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_assistant_create_schedule(jsonb) to authenticated;
comment on function public.xelay_assistant_create_schedule(jsonb) is
  'Verified caller only: fixed one-day lesson, own author, current schedule rights and normal RLS/triggers; same-ID readback and atomic occurrence-aware overlap check under existing timetable group lock. No service-role business write.';
notify pgrst,'reload schema';
commit;
