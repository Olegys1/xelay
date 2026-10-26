-- Reviewed custom first-shift times and an explicit, private Saturday default.
-- Existing copy entrypoints, group access, source rows and academic data stay intact.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $$ begin
  if to_regprocedure('public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)') is null
    or to_regprocedure('public.xelay_copy_study_group_schedule_sequence_with_time_mode(uuid,jsonb,boolean,text,text,jsonb)') is null
    or to_regprocedure('public.xelay_private_first_shift_projection(jsonb,jsonb)') is null
    or to_regclass('public.study_group_schedule_copy_settings') is not null
    or not exists(select 1 from pg_attribute where attrelid='public.study_group_schedule'::regclass
      and attname='conference_access_code' and not attisdropped) then
    raise exception 'SCHEDULE_COPY_CUSTOM_TIMES_PREREQUISITE_OR_SCHEMA_DRIFT';
  end if;
end $$;

create table public.study_group_schedule_copy_settings(
  group_id uuid primary key references public.study_groups(id) on delete cascade,
  first_shift_start time not null check(first_shift_start<time '24:00' and extract(second from first_shift_start)=0),
  revision integer not null check(revision>0),
  previous_revision integer not null check(previous_revision>=0),
  last_approval_signature text not null,
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default clock_timestamp()
);
alter table public.study_group_schedule_copy_settings enable row level security;
revoke all on public.study_group_schedule_copy_settings from public,anon,authenticated,service_role;
comment on table public.study_group_schedule_copy_settings is
  'Private shared Saturday first-shift preference, saved only by an explicitly approved successful copy. No client table access. Last approval supports exact validated retries after its own revision change.';

create function public.xelay_private_schedule_copy_access(p_group_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
  perform public.xelay_lock_study_group_permission(p_group_id,'schedule',true);
  if not exists(select 1 from public.study_groups g where g.id=p_group_id and g.representative_id=auth.uid())
    and not exists(select 1 from public.study_group_deputy_requests d
      join public.study_group_members m on m.group_id=d.group_id and m.user_id=d.user_id and m.status='accepted'
      where d.group_id=p_group_id and d.user_id=auth.uid() and d.status='approved' and 'schedule'=any(d.permissions)) then
    raise exception 'STUDY_GROUP_PERMISSION_REQUIRED' using errcode='42501';
  end if;
end $$;
revoke all on function public.xelay_private_schedule_copy_access(uuid) from public,anon,authenticated,service_role;

create function public.xelay_schedule_copy_settings(p_group_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_settings public.study_group_schedule_copy_settings%rowtype;
begin
  perform public.xelay_private_schedule_copy_access(p_group_id);
  select * into v_settings from public.study_group_schedule_copy_settings where group_id=p_group_id;
  return jsonb_build_object('first_shift_start',coalesce(left(v_settings.first_shift_start::text,5),'08:00'),
    'revision',coalesce(v_settings.revision,0));
end $$;
revoke all on function public.xelay_schedule_copy_settings(uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_schedule_copy_settings(uuid) to authenticated;

create function public.xelay_private_custom_shift_projection(p_sources jsonb,p_slot_assignments jsonb,p_first_shift_start text)
returns jsonb language plpgsql immutable security definer set search_path='' as $$
declare
  v_item jsonb;v_plain jsonb:='[]';v_base jsonb;v_slot jsonb;v_override jsonb;
  v_assignments jsonb:='[]';v_lessons jsonb:='[]';v_lesson jsonb;
  v_delta integer;v_starts integer;v_ends integer;v_start time;v_end time;
begin
  if p_first_shift_start is null or p_first_shift_start!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or p_slot_assignments is null or jsonb_typeof(p_slot_assignments) is distinct from 'array'
    or jsonb_array_length(p_slot_assignments)>5 or octet_length(p_slot_assignments::text)>8192 then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_CUSTOM_TIMES_INVALID' using errcode='22023';
  end if;
  for v_item in select value from jsonb_array_elements(p_slot_assignments) loop
    if jsonb_typeof(v_item) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(v_item) k where k not in('source_starts_at','source_ends_at','target_lesson_number','target_starts_at','target_ends_at'))
      or(v_item?'target_starts_at') is distinct from (v_item?'target_ends_at') then
      raise exception 'STUDY_GROUP_TIMETABLE_COPY_CUSTOM_TIMES_INVALID' using errcode='22023';
    end if;
    if v_item?'target_starts_at' and(jsonb_typeof(v_item->'target_starts_at') is distinct from 'string'
      or jsonb_typeof(v_item->'target_ends_at') is distinct from 'string'
      or(v_item->>'target_starts_at')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
      or(v_item->>'target_ends_at')!~'^([01][0-9]|2[0-3]):[0-5][0-9]$') then
      raise exception 'STUDY_GROUP_TIMETABLE_COPY_CUSTOM_TIMES_INVALID' using errcode='22023';
    end if;
    v_plain:=v_plain||jsonb_build_array(v_item-'target_starts_at'-'target_ends_at');
  end loop;
  -- Retain the installed source-slot, lesson-number and full-content projection.
  -- It already carries teacher/URL labels and conference access without inference.
  v_base:=public.xelay_private_first_shift_projection(p_sources,v_plain);
  if jsonb_array_length(v_plain)>0 and jsonb_array_length(v_plain)<>jsonb_array_length(v_base->'slot_assignments') then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_CUSTOM_TIMES_INVALID' using errcode='22023';
  end if;
  v_delta:=extract(hour from p_first_shift_start::time)::integer*60+extract(minute from p_first_shift_start::time)::integer-480;
  for v_slot in select value from jsonb_array_elements(v_base->'slot_assignments') loop
    select value into v_override from jsonb_array_elements(p_slot_assignments) a
      where(a->>'source_starts_at')::time=(v_slot->>'source_starts_at')::time
        and(a->>'source_ends_at')::time=(v_slot->>'source_ends_at')::time;
    if v_override?'target_starts_at' then
      v_start:=(v_override->>'target_starts_at')::time;v_end:=(v_override->>'target_ends_at')::time;
    else
      select starts_at+v_delta,ends_at+v_delta into v_starts,v_ends from(values
        (1,480,560),(2,580,660),(3,680,760),(4,770,850),(5,870,950)) s(number,starts_at,ends_at)
        where s.number=(v_slot->>'target_lesson_number')::integer;
      -- Check only slots actually present. SQL time arithmetic would wrap at midnight.
      if v_starts not between 0 and 1439 or v_ends not between 0 and 1439 then
        raise exception 'STUDY_GROUP_TIMETABLE_COPY_CUSTOM_TIMES_INVALID' using errcode='22023';
      end if;
      v_start:=make_time(v_starts/60,v_starts%60,0);v_end:=make_time(v_ends/60,v_ends%60,0);
    end if;
    if v_end<=v_start or exists(select 1 from jsonb_array_elements(v_assignments) a
      where(a->>'target_starts_at')::time<v_end and(a->>'target_ends_at')::time>v_start) then
      raise exception 'STUDY_GROUP_TIMETABLE_COPY_CUSTOM_TIMES_INVALID' using errcode='22023';
    end if;
    v_assignments:=v_assignments||jsonb_build_array(v_slot||jsonb_build_object(
      'target_starts_at',v_start::text,'target_ends_at',v_end::text));
  end loop;
  for v_lesson in select value from jsonb_array_elements(v_base->'lessons') loop
    select value into v_slot from jsonb_array_elements(v_assignments) a
      where a->>'source_starts_at'=v_lesson->>'source_starts_at' and a->>'source_ends_at'=v_lesson->>'source_ends_at';
    v_lessons:=v_lessons||jsonb_build_array(v_lesson||jsonb_build_object('starts_at',v_slot->>'target_starts_at','ends_at',v_slot->>'target_ends_at'));
  end loop;
  select jsonb_agg(value order by value->>'starts_at',value->>'ends_at',value->>'id') into v_lessons from jsonb_array_elements(v_lessons);
  return jsonb_build_object('lessons',coalesce(v_lessons,'[]'::jsonb),'slot_assignments',v_assignments);
end $$;
revoke all on function public.xelay_private_custom_shift_projection(jsonb,jsonb,text) from public,anon,authenticated,service_role;

-- Clone, do not replace, the fully installed day implementation. Fail closed
-- when an expected anchor has drifted; all its conflict/access/copy-link logic stays.
do $day$
declare v_body text;v_old text;v_new text;
begin
  select replace(prosrc,E'\r\n',E'\n') into v_body from pg_proc
    where oid='public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb)'::regprocedure;
  v_old:='public.xelay_private_first_shift_projection(v_sources,p_slot_assignments)';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'SCHEDULE_COPY_CUSTOM_DAY_CONTRACT_MISMATCH';end if;
  v_body:=replace(v_body,v_old,'public.xelay_private_custom_shift_projection(v_sources,p_slot_assignments,p_first_shift_start)');
  v_old:='||v_original_sources::text||'':''||v_assignments::text||'':''||v_sources::text);';
  v_new:='||v_original_sources::text||'':''||v_assignments::text||'':''||v_sources::text||'':''||p_first_shift_start||'':''||p_settings_revision::text||'':''||p_remember_first_shift_start::text);';
  if cardinality(string_to_array(v_body,v_old))<>2 or position('conference_access_code' in v_body)=0
    or position('copied_from_schedule_id' in v_body)=0 then raise exception 'SCHEDULE_COPY_CUSTOM_DAY_CONTRACT_MISMATCH';end if;
  v_body:=replace(v_body,v_old,v_new);
  execute format('create function public.xelay_private_copy_schedule_day_custom(
    p_group_id uuid,p_source_date date,p_target_date date,p_preview boolean,p_expected_signature text,p_time_mode text,p_slot_assignments jsonb,
    p_first_shift_start text,p_settings_revision integer,p_remember_first_shift_start boolean)
    returns jsonb language plpgsql volatile security definer set search_path='''' as %L',v_body);
end $day$;
revoke all on function public.xelay_private_copy_schedule_day_custom(uuid,date,date,boolean,text,text,jsonb,text,integer,boolean) from public,anon,authenticated,service_role;

create function public.xelay_private_remember_schedule_copy_start(p_group_id uuid,p_first_shift_start text,p_signature text)
returns integer language plpgsql volatile security definer set search_path='' as $$
declare v_revision integer;
begin
  insert into public.study_group_schedule_copy_settings(group_id,first_shift_start,revision,previous_revision,last_approval_signature,updated_by)
    values(p_group_id,p_first_shift_start::time,1,0,p_signature,auth.uid())
  on conflict(group_id) do update set first_shift_start=excluded.first_shift_start,
    previous_revision=study_group_schedule_copy_settings.revision,revision=study_group_schedule_copy_settings.revision+1,
    last_approval_signature=excluded.last_approval_signature,updated_by=excluded.updated_by,updated_at=clock_timestamp()
    where study_group_schedule_copy_settings.first_shift_start is distinct from excluded.first_shift_start
  returning revision into v_revision;
  if not found then select revision into v_revision from public.study_group_schedule_copy_settings where group_id=p_group_id;end if;
  return v_revision;
end $$;
revoke all on function public.xelay_private_remember_schedule_copy_start(uuid,text,text) from public,anon,authenticated,service_role;

create function public.xelay_copy_study_group_schedule_day_with_custom_times(
  p_group_id uuid,p_source_date date,p_target_date date,p_preview boolean,p_expected_signature text,p_time_mode text,p_slot_assignments jsonb,
  p_first_shift_start text,p_remember_first_shift_start boolean
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_settings public.study_group_schedule_copy_settings%rowtype;v_revision integer;v_used_revision integer;v_result jsonb;
begin
  perform public.xelay_private_schedule_copy_access(p_group_id);
  if p_preview is null or p_remember_first_shift_start is null or p_first_shift_start is null
    or p_first_shift_start!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or(p_remember_first_shift_start and(p_time_mode is distinct from 'first_shift' or p_target_date is null or extract(isodow from p_target_date)<>6)) then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_CUSTOM_TIMES_INVALID' using errcode='22023';
  end if;
  select * into v_settings from public.study_group_schedule_copy_settings where group_id=p_group_id;
  v_revision:=coalesce(v_settings.revision,0);v_used_revision:=v_revision;
  if not p_preview and p_remember_first_shift_start and p_expected_signature=v_settings.last_approval_signature
    and v_settings.first_shift_start=p_first_shift_start::time then v_used_revision:=v_settings.previous_revision;end if;
  v_result:=public.xelay_private_copy_schedule_day_custom(p_group_id,p_source_date,p_target_date,p_preview,p_expected_signature,
    p_time_mode,p_slot_assignments,p_first_shift_start,v_used_revision,p_remember_first_shift_start);
  if not p_preview and p_remember_first_shift_start and(v_result->>'copied')::integer+(v_result->>'skipped')::integer>0 then
    v_revision:=public.xelay_private_remember_schedule_copy_start(p_group_id,p_first_shift_start,v_result->>'source_signature');
  end if;
  return v_result||jsonb_build_object('first_shift_start',p_first_shift_start,'settings_revision',v_revision);
end $$;
revoke all on function public.xelay_copy_study_group_schedule_day_with_custom_times(uuid,date,date,boolean,text,text,jsonb,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.xelay_copy_study_group_schedule_day_with_custom_times(uuid,date,date,boolean,text,text,jsonb,text,boolean) to authenticated;

-- Sequence overrides are intentionally keyed by TARGET date: repeated source
-- weekdays can have independently reviewed destination times.
do $sequence$
declare v_body text;v_old text;v_new text;
begin
  select replace(prosrc,E'\r\n',E'\n') into v_body from pg_proc
    where oid='public.xelay_copy_study_group_schedule_sequence_with_time_mode(uuid,jsonb,boolean,text,text,jsonb)'::regprocedure;
  v_old:='  v_assignments jsonb;';
  v_new:=v_old||E'\n  v_settings public.study_group_schedule_copy_settings%rowtype;v_revision integer;v_used_revision integer;';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'SCHEDULE_COPY_CUSTOM_SEQUENCE_CONTRACT_MISMATCH';end if;
  v_body:=replace(v_body,v_old,v_new);
  v_old:='  perform public.xelay_lock_study_group_permission(p_group_id,''schedule'',true);';
  v_new:=$new$  perform public.xelay_private_schedule_copy_access(p_group_id);
  if p_preview is null or p_remember_first_shift_start is null or p_first_shift_start is null
    or p_first_shift_start!~'^([01][0-9]|2[0-3]):[0-5][0-9]$'
    or(p_remember_first_shift_start and p_time_mode is distinct from 'first_shift') then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_CUSTOM_TIMES_INVALID' using errcode='22023';end if;
  select * into v_settings from public.study_group_schedule_copy_settings where group_id=p_group_id;
  v_revision:=coalesce(v_settings.revision,0);v_used_revision:=v_revision;
  if not p_preview and p_remember_first_shift_start and p_expected_signature=v_settings.last_approval_signature
    and v_settings.first_shift_start=p_first_shift_start::time then v_used_revision:=v_settings.previous_revision;end if;$new$;
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'SCHEDULE_COPY_CUSTOM_SEQUENCE_CONTRACT_MISMATCH';end if;
  v_body:=replace(v_body,v_old,v_new);
  v_old:='return public.xelay_copy_study_group_schedule_sequence(p_group_id,p_pairs,p_preview,p_expected_signature);';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'SCHEDULE_COPY_CUSTOM_SEQUENCE_CONTRACT_MISMATCH';end if;
  v_body:=replace(v_body,v_old,
    'return public.xelay_copy_study_group_schedule_sequence(p_group_id,p_pairs,p_preview,p_expected_signature)||jsonb_build_object(''first_shift_start'',p_first_shift_start,''settings_revision'',v_revision);');
  v_old:='p->>''source_date''=a.key';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'SCHEDULE_COPY_CUSTOM_SEQUENCE_CONTRACT_MISMATCH';end if;
  v_body:=replace(v_body,v_old,'p->>''target_date''=a.key');
  v_old:='p_slot_assignments->(v_pair->>''source_date'')';
  if cardinality(string_to_array(v_body,v_old))<>3 then raise exception 'SCHEDULE_COPY_CUSTOM_SEQUENCE_CONTRACT_MISMATCH';end if;
  v_body:=replace(v_body,v_old,'p_slot_assignments->(v_pair->>''target_date'')');
  v_old:='  if exists(select 1 from jsonb_each(p_slot_assignments) a';
  v_new:=$new$  if p_remember_first_shift_start and exists(select 1 from jsonb_array_elements(p_pairs) p where extract(isodow from(p->>'target_date')::date)<>6) then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_CUSTOM_TIMES_INVALID' using errcode='22023';end if;
$new$||v_old;
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'SCHEDULE_COPY_CUSTOM_SEQUENCE_CONTRACT_MISMATCH';end if;
  v_body:=replace(v_body,v_old,v_new);
  v_old:='public.xelay_copy_study_group_schedule_day_with_time_mode(p_group_id,v_source_date,v_target_date,true,null,p_time_mode,v_assignments)';
  v_new:='public.xelay_private_copy_schedule_day_custom(p_group_id,v_source_date,v_target_date,true,null,p_time_mode,v_assignments,p_first_shift_start,v_used_revision,p_remember_first_shift_start)';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'SCHEDULE_COPY_CUSTOM_SEQUENCE_CONTRACT_MISMATCH';end if;
  v_body:=replace(v_body,v_old,v_new);
  v_old:=$old$public.xelay_copy_study_group_schedule_day_with_time_mode(p_group_id,(v_pair->>'source_date')::date,
      (v_pair->>'target_date')::date,false,v_previews->v_index->>'source_signature',p_time_mode,
      coalesce(p_slot_assignments->(v_pair->>'target_date'),'[]'::jsonb))$old$;
  v_new:=$new$public.xelay_private_copy_schedule_day_custom(p_group_id,(v_pair->>'source_date')::date,
      (v_pair->>'target_date')::date,false,v_previews->v_index->>'source_signature',p_time_mode,
      coalesce(p_slot_assignments->(v_pair->>'target_date'),'[]'::jsonb),p_first_shift_start,v_used_revision,p_remember_first_shift_start)$new$;
  -- SQL-editor paste may convert the multiline literals to CRLF; match the normalized installed body.
  v_old:=replace(v_old,E'\r\n',E'\n');v_new:=replace(v_new,E'\r\n',E'\n');
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'SCHEDULE_COPY_CUSTOM_SEQUENCE_CONTRACT_MISMATCH';end if;
  v_body:=replace(v_body,v_old,v_new);
  v_old:='v_signature:=md5(p_pairs::text||'':first_shift:''||v_signatures::text);';
  v_new:='v_signature:=md5(p_pairs::text||'':first_shift:''||v_signatures::text||'':''||p_first_shift_start||'':''||v_used_revision::text||'':''||p_remember_first_shift_start::text);';
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'SCHEDULE_COPY_CUSTOM_SEQUENCE_CONTRACT_MISMATCH';end if;
  v_body:=replace(v_body,v_old,v_new);
  v_old:='  return jsonb_build_object(''copied'',v_copied,''skipped'',v_skipped,''source_signature'',v_signature,''days'',v_days);';
  v_new:=$new$  if not p_preview and p_remember_first_shift_start and v_copied+v_skipped>0 then
    v_revision:=public.xelay_private_remember_schedule_copy_start(p_group_id,p_first_shift_start,v_signature);end if;
  return jsonb_build_object('copied',v_copied,'skipped',v_skipped,'source_signature',v_signature,'days',v_days,
    'first_shift_start',p_first_shift_start,'settings_revision',v_revision);$new$;
  if cardinality(string_to_array(v_body,v_old))<>2 then raise exception 'SCHEDULE_COPY_CUSTOM_SEQUENCE_CONTRACT_MISMATCH';end if;
  v_body:=replace(v_body,v_old,v_new);
  execute format('create function public.xelay_copy_study_group_schedule_sequence_with_custom_times(
    p_group_id uuid,p_pairs jsonb,p_preview boolean,p_expected_signature text,p_time_mode text,p_slot_assignments jsonb,
    p_first_shift_start text,p_remember_first_shift_start boolean)
    returns jsonb language plpgsql volatile security definer set search_path='''' as %L',v_body);
end $sequence$;
revoke all on function public.xelay_copy_study_group_schedule_sequence_with_custom_times(uuid,jsonb,boolean,text,text,jsonb,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.xelay_copy_study_group_schedule_sequence_with_custom_times(uuid,jsonb,boolean,text,text,jsonb,text,boolean) to authenticated;

notify pgrst,'reload schema';
commit;
