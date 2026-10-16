-- Explicit first-shift copies. Original RPC definitions and ACLs are unchanged.
-- No source lessons, homework, assignments or files are rewritten/copied.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$ begin
  if to_regprocedure('public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)') is null
    or to_regprocedure('public.xelay_copy_study_group_schedule_sequence(uuid,jsonb,boolean,text)') is null then
    raise exception 'Apply schedule occurrence cancellation and sequence copying first';
  end if;
end $$;

create or replace function public.xelay_private_first_shift_projection(p_sources jsonb,p_slot_assignments jsonb)
returns jsonb language plpgsql immutable security definer set search_path='' as $$
declare
  v_slots jsonb; v_slot jsonb; v_assignment jsonb; v_assignments jsonb:='[]'::jsonb;
  v_overrides jsonb:='[]'::jsonb; v_projected jsonb:='[]'::jsonb; v_lesson jsonb;
  v_count integer; v_number integer; v_min integer; v_previous integer; v_rank integer:=0;
  v_all_numbered boolean; v_all_unnumbered boolean; v_auto_valid boolean:=true;
  v_starts time; v_ends time; v_target_starts text; v_target_ends text;
begin
  if p_sources is null or jsonb_typeof(p_sources) is distinct from 'array'
    or p_slot_assignments is null or jsonb_typeof(p_slot_assignments) is distinct from 'array'
    or jsonb_array_length(p_slot_assignments)>5 or octet_length(p_slot_assignments::text)>4096 then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_SLOT_ASSIGNMENTS_INVALID' using errcode='22023';
  end if;
  select coalesce(jsonb_agg(to_jsonb(q) order by q.starts_at,q.ends_at),'[]'::jsonb) into v_slots
    from (select s.starts_at,s.ends_at,min(s.lesson_number) as source_number,
      count(distinct s.lesson_number)::integer as number_count,bool_or(s.lesson_number is null) as has_null
      from jsonb_populate_recordset(null::public.study_group_schedule,p_sources) s
      group by s.starts_at,s.ends_at) q;
  v_count:=jsonb_array_length(v_slots);
  if v_count not between 1 and 5 then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_FIRST_SHIFT_UNMAPPABLE' using errcode='22023';
  end if;

  -- Overrides contain exact original intervals and predefined slot numbers,
  -- never client-provided destination times. Normalize interval aliases first.
  for v_assignment in select value from jsonb_array_elements(p_slot_assignments) loop
    if jsonb_typeof(v_assignment) is distinct from 'object'
      or exists(select 1 from jsonb_object_keys(v_assignment) k where k not in('source_starts_at','source_ends_at','target_lesson_number'))
      or jsonb_typeof(v_assignment->'source_starts_at') is distinct from 'string'
      or jsonb_typeof(v_assignment->'source_ends_at') is distinct from 'string'
      or jsonb_typeof(v_assignment->'target_lesson_number') is distinct from 'number'
      or (v_assignment->>'source_starts_at') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
      or (v_assignment->>'source_ends_at') !~ '^([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9])?$'
      or (v_assignment->>'target_lesson_number') !~ '^[1-5]$' then
      raise exception 'STUDY_GROUP_TIMETABLE_COPY_SLOT_ASSIGNMENTS_INVALID' using errcode='22023';
    end if;
    v_starts:=(v_assignment->>'source_starts_at')::time;v_ends:=(v_assignment->>'source_ends_at')::time;
    if not exists(select 1 from jsonb_array_elements(v_slots) s where (s->>'starts_at')::time=v_starts and (s->>'ends_at')::time=v_ends)
      or exists(select 1 from jsonb_array_elements(v_overrides) s where (s->>'source_starts_at')::time=v_starts and (s->>'source_ends_at')::time=v_ends) then
      raise exception 'STUDY_GROUP_TIMETABLE_COPY_SLOT_ASSIGNMENTS_INVALID' using errcode='22023';
    end if;
    v_overrides:=v_overrides||jsonb_build_array(jsonb_build_object('source_starts_at',v_starts::text,
      'source_ends_at',v_ends::text,'target_lesson_number',(v_assignment->>'target_lesson_number')::integer));
  end loop;
  select bool_and((s->>'number_count')::integer=1 and not (s->>'has_null')::boolean),
    bool_and((s->>'number_count')::integer=0),min((s->>'source_number')::integer)
    into v_all_numbered,v_all_unnumbered,v_min from jsonb_array_elements(v_slots) s;
  -- Incomplete/unnumbered days use chronological intervals. Preserve numeric
  -- gaps only when every interval has one consistent, ordered known number.
  if v_all_numbered then
    for v_slot in select value from jsonb_array_elements(v_slots) loop
      v_number:=(v_slot->>'source_number')::integer;
      if v_number is null or v_number not between 1 and 12 or v_number-v_min+1>5
        or (v_previous is not null and v_number<=v_previous) then v_auto_valid:=false; end if;
      v_previous:=v_number;
    end loop;
  end if;
  if not v_auto_valid and jsonb_array_length(v_overrides)<>v_count then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_FIRST_SHIFT_UNMAPPABLE' using errcode='22023';
  end if;
  for v_slot in select value from jsonb_array_elements(v_slots) loop
    v_rank:=v_rank+1;
    select (a->>'target_lesson_number')::integer into v_number from jsonb_array_elements(v_overrides) a
      where a->>'source_starts_at'=v_slot->>'starts_at' and a->>'source_ends_at'=v_slot->>'ends_at';
    if not found then
      v_number:=case when v_all_numbered then (v_slot->>'source_number')::integer-v_min+1 else v_rank end;
    end if;
    if v_number not between 1 and 5 or exists(select 1 from jsonb_array_elements(v_assignments) a where (a->>'target_lesson_number')::integer=v_number) then
      raise exception 'STUDY_GROUP_TIMETABLE_COPY_SLOT_ASSIGNMENTS_INVALID' using errcode='22023';
    end if;
    v_assignments:=v_assignments||jsonb_build_array(jsonb_build_object('source_starts_at',v_slot->>'starts_at',
      'source_ends_at',v_slot->>'ends_at','target_lesson_number',v_number));
  end loop;
  for v_lesson in select value from jsonb_array_elements(p_sources) loop
    select (a->>'target_lesson_number')::integer into v_number from jsonb_array_elements(v_assignments) a
      where a->>'source_starts_at'=v_lesson->>'starts_at' and a->>'source_ends_at'=v_lesson->>'ends_at';
    select t.starts_at,t.ends_at into v_target_starts,v_target_ends from (values
      (1,'08:00:00','09:20:00'),(2,'09:40:00','11:00:00'),(3,'11:20:00','12:40:00'),
      (4,'12:50:00','14:10:00'),(5,'14:30:00','15:50:00')) t(number,starts_at,ends_at) where t.number=v_number;
    v_projected:=v_projected||jsonb_build_array(v_lesson||jsonb_build_object(
      'source_starts_at',v_lesson->>'starts_at','source_ends_at',v_lesson->>'ends_at',
      'source_lesson_number',v_lesson->'lesson_number','starts_at',v_target_starts,'ends_at',v_target_ends,'lesson_number',v_number));
  end loop;
  -- Distinct original rows may differ only in inconsistent old lesson numbers.
  -- Once projected to the same interval/number/content they represent one copy;
  -- keep the entire original array in the approval digest in the caller.
  select jsonb_agg(q.value order by q.value->>'starts_at',q.value->>'ends_at',q.value->>'id') into v_projected from (
    select distinct on(s->>'starts_at',s->>'ends_at',btrim(s->>'subject'),s->>'lesson_type',btrim(s->>'location'),
      nullif(btrim(s->>'online_url'),''),nullif(btrim(s->>'online_url_secondary'),''),s->>'online_url_label',
      s->>'online_url_secondary_label',s->>'lesson_number') s as value
    from jsonb_array_elements(v_projected) s
    order by s->>'starts_at',s->>'ends_at',btrim(s->>'subject'),s->>'lesson_type',btrim(s->>'location'),
      nullif(btrim(s->>'online_url'),''),nullif(btrim(s->>'online_url_secondary'),''),s->>'online_url_label',
      s->>'online_url_secondary_label',s->>'lesson_number',s->>'id'
  ) q;
  return jsonb_build_object('lessons',v_projected,'slot_assignments',v_assignments);
end $$;
revoke all on function public.xelay_private_first_shift_projection(jsonb,jsonb) from public,anon,authenticated,service_role;

-- Reuse the installed single-day implementation, preserving every existing
-- permission, occurrence, duplicate and conflict check. Only the new entrypoint
-- receives a projection before its existing destination comparisons/inserts.
do $migration$
declare
  v_body text;v_original text;
  v_anchor text;v_replacement text;
begin
  select prosrc into v_body from pg_catalog.pg_proc
    where oid='public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)'::regprocedure;
  v_original:=v_body;
  v_anchor:='  v_sources jsonb;';
  if cardinality(string_to_array(v_body,v_anchor))<>2 then raise exception 'TIMETABLE_COPY_MODE_CONTRACT_MISMATCH'; end if;
  v_body:=replace(v_body,v_anchor,v_anchor||E'\n  v_original_sources jsonb; v_projection jsonb; v_assignments jsonb;');
  v_anchor:='  if p_preview is null or p_source_date is null or p_target_date is null';
  if cardinality(string_to_array(v_body,v_anchor))<>2 then raise exception 'TIMETABLE_COPY_MODE_CONTRACT_MISMATCH'; end if;
  v_replacement:=$fragment$  if p_time_mode is null or p_time_mode not in('original','first_shift') then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_TIME_MODE_INVALID' using errcode='22023';
  end if;
  if p_slot_assignments is null or jsonb_typeof(p_slot_assignments) is distinct from 'array' then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_SLOT_ASSIGNMENTS_INVALID' using errcode='22023';
  end if;
  if p_time_mode='original' then
    if jsonb_array_length(p_slot_assignments)<>0 then raise exception 'STUDY_GROUP_TIMETABLE_COPY_SLOT_ASSIGNMENTS_INVALID' using errcode='22023'; end if;
    return public.xelay_copy_study_group_schedule_day(p_group_id,p_source_date,p_target_date,p_preview,p_expected_signature)
      ||jsonb_build_object('slot_assignments','[]'::jsonb);
  end if;
$fragment$;
  v_body:=replace(v_body,v_anchor,v_replacement||v_anchor);
  v_anchor:='  v_signature:=md5(p_source_date::text||'':''||v_sources::text);';
  if cardinality(string_to_array(v_body,v_anchor))<>2 then raise exception 'TIMETABLE_COPY_MODE_CONTRACT_MISMATCH'; end if;
  v_body:=replace(v_body,v_anchor,$fragment$  v_original_sources:=v_sources;
  v_projection:=public.xelay_private_first_shift_projection(v_sources,p_slot_assignments);
  v_sources:=v_projection->'lessons';v_assignments:=v_projection->'slot_assignments';
  v_signature:=md5(p_group_id::text||':'||p_source_date::text||':'||p_target_date::text||':first_shift:'
    ||v_original_sources::text||':'||v_assignments::text||':'||v_sources::text);$fragment$);
  v_anchor:='    ''lessons'',case when p_preview then v_sources else ''[]''::jsonb end);';
  if cardinality(string_to_array(v_body,v_anchor))<>2 then raise exception 'TIMETABLE_COPY_MODE_CONTRACT_MISMATCH'; end if;
  v_body:=replace(v_body,v_anchor,'    ''lessons'',case when p_preview then v_sources else ''[]''::jsonb end,''slot_assignments'',v_assignments);');
  if v_body=v_original or position('xelay_lock_study_group_permission' in v_body)=0
    or position('study_group_deputy_requests' in v_body)=0 or position('for v_source' in v_body)=0 then
    raise exception 'TIMETABLE_COPY_MODE_CONTRACT_MISMATCH';
  end if;
  execute format('create or replace function public.xelay_copy_study_group_schedule_day_with_time_mode(
    p_group_id uuid,p_source_date date,p_target_date date,p_preview boolean,p_expected_signature text,p_time_mode text,p_slot_assignments jsonb)
    returns jsonb language plpgsql volatile security definer set search_path='''' as %L',v_body);
end;
$migration$;

create or replace function public.xelay_copy_study_group_schedule_sequence_with_time_mode(
  p_group_id uuid,p_pairs jsonb,p_preview boolean,p_expected_signature text,p_time_mode text,p_slot_assignments jsonb
) returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  v_pair jsonb;v_source_date date;v_target_date date;v_previous_target date;
  v_result jsonb;v_previews jsonb:='[]'::jsonb;v_signatures jsonb:='[]'::jsonb;v_signature text;
  v_source_lessons integer:=0;v_copied integer:=0;v_skipped integer:=0;v_days jsonb:='[]'::jsonb;v_index integer:=0;
  v_assignments jsonb;
begin
  perform public.xelay_lock_study_group_permission(p_group_id,'schedule',true);
  if p_time_mode is null or p_time_mode not in('original','first_shift') then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_TIME_MODE_INVALID' using errcode='22023';
  end if;
  if p_slot_assignments is null or jsonb_typeof(p_slot_assignments) is distinct from 'object'
    or octet_length(p_slot_assignments::text)>65536 then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_SLOT_ASSIGNMENTS_INVALID' using errcode='22023';
  end if;
  if p_time_mode='original' then
    if p_slot_assignments<>'{}'::jsonb then raise exception 'STUDY_GROUP_TIMETABLE_COPY_SLOT_ASSIGNMENTS_INVALID' using errcode='22023'; end if;
    return public.xelay_copy_study_group_schedule_sequence(p_group_id,p_pairs,p_preview,p_expected_signature);
  end if;
  if p_preview is null or p_pairs is null or jsonb_typeof(p_pairs) is distinct from 'array' then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_SEQUENCE_INVALID' using errcode='22023';
  end if;
  if jsonb_array_length(p_pairs) not between 1 and 26 or octet_length(p_pairs::text)>16384 then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_SEQUENCE_LIMIT' using errcode='22023';
  end if;
  for v_pair in select value from jsonb_array_elements(p_pairs) loop
    if jsonb_typeof(v_pair) is distinct from 'object' then raise exception 'STUDY_GROUP_TIMETABLE_COPY_SEQUENCE_INVALID' using errcode='22023'; end if;
    if jsonb_typeof(v_pair->'source_date') is distinct from 'string' or jsonb_typeof(v_pair->'target_date') is distinct from 'string'
      or (v_pair->>'source_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' or (v_pair->>'target_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or exists(select 1 from jsonb_object_keys(v_pair) k where k not in('source_date','target_date')) then
      raise exception 'STUDY_GROUP_TIMETABLE_COPY_SEQUENCE_INVALID' using errcode='22023';
    end if;
    begin v_source_date:=(v_pair->>'source_date')::date;v_target_date:=(v_pair->>'target_date')::date;
    exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
      raise exception 'STUDY_GROUP_TIMETABLE_COPY_SEQUENCE_INVALID' using errcode='22023';
    end;
    if not isfinite(v_source_date) or not isfinite(v_target_date)
      or v_source_date not between date '1900-01-01' and date '2200-12-31' or v_target_date not between date '1900-01-01' and date '2200-12-31'
      or v_source_date=v_target_date or extract(isodow from v_source_date) not between 1 and 5
      or extract(isodow from v_target_date) not in(6,7) or (v_previous_target is not null and v_target_date<=v_previous_target) then
      raise exception 'STUDY_GROUP_TIMETABLE_COPY_SEQUENCE_INVALID' using errcode='22023';
    end if;
    v_previous_target:=v_target_date;
  end loop;
  if exists(select 1 from jsonb_each(p_slot_assignments) a where jsonb_typeof(a.value) is distinct from 'array'
    or not exists(select 1 from jsonb_array_elements(p_pairs) p where p->>'source_date'=a.key)) then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_SLOT_ASSIGNMENTS_INVALID' using errcode='22023';
  end if;
  for v_pair in select value from jsonb_array_elements(p_pairs) loop
    v_source_date:=(v_pair->>'source_date')::date;v_target_date:=(v_pair->>'target_date')::date;
    v_assignments:=coalesce(p_slot_assignments->(v_pair->>'source_date'),'[]'::jsonb);
    begin
      v_result:=public.xelay_copy_study_group_schedule_day_with_time_mode(p_group_id,v_source_date,v_target_date,true,null,p_time_mode,v_assignments)
        ||jsonb_build_object('empty',false);
    exception when sqlstate '22023' then
      if sqlerrm is distinct from 'STUDY_GROUP_TIMETABLE_COPY_SOURCE_EMPTY' then raise; end if;
      if v_assignments<>'[]'::jsonb then raise exception 'STUDY_GROUP_TIMETABLE_COPY_SLOT_ASSIGNMENTS_INVALID' using errcode='22023'; end if;
      v_result:=jsonb_build_object('copied',0,'skipped',0,'empty',true,'source_signature',
        md5(p_group_id::text||':'||v_source_date::text||':'||v_target_date::text||':first_shift:[]'),
        'lessons','[]'::jsonb,'slot_assignments','[]'::jsonb);
    end;
    v_source_lessons:=v_source_lessons+jsonb_array_length(v_result->'lessons');
    if v_source_lessons>1008 then raise exception 'STUDY_GROUP_TIMETABLE_COPY_SEQUENCE_LIMIT' using errcode='22023'; end if;
    v_previews:=v_previews||jsonb_build_array(v_result);v_signatures:=v_signatures||jsonb_build_array(v_result->>'source_signature');
  end loop;
  v_signature:=md5(p_pairs::text||':first_shift:'||v_signatures::text);
  if not p_preview and (p_expected_signature is null or p_expected_signature<>v_signature) then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_SOURCE_CHANGED' using errcode='22023';
  end if;
  for v_pair in select value from jsonb_array_elements(p_pairs) loop
    if p_preview or (v_previews->v_index->>'empty')::boolean then v_result:=v_previews->v_index;
    else v_result:=public.xelay_copy_study_group_schedule_day_with_time_mode(p_group_id,(v_pair->>'source_date')::date,
      (v_pair->>'target_date')::date,false,v_previews->v_index->>'source_signature',p_time_mode,
      coalesce(p_slot_assignments->(v_pair->>'source_date'),'[]'::jsonb));
    end if;
    v_copied:=v_copied+(v_result->>'copied')::integer;v_skipped:=v_skipped+(v_result->>'skipped')::integer;
    v_days:=v_days||jsonb_build_array(jsonb_build_object('source_date',v_pair->>'source_date','target_date',v_pair->>'target_date',
      'copied',(v_result->>'copied')::integer,'skipped',(v_result->>'skipped')::integer,
      'empty',(v_previews->v_index->>'empty')::boolean,'lessons',v_result->'lessons','slot_assignments',v_result->'slot_assignments'));
    v_index:=v_index+1;
  end loop;
  return jsonb_build_object('copied',v_copied,'skipped',v_skipped,'source_signature',v_signature,'days',v_days);
end $$;

revoke all on function public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb),
  public.xelay_copy_study_group_schedule_sequence_with_time_mode(uuid,jsonb,boolean,text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_copy_study_group_schedule_day_with_time_mode(uuid,date,date,boolean,text,text,jsonb),
  public.xelay_copy_study_group_schedule_sequence_with_time_mode(uuid,jsonb,boolean,text,text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
