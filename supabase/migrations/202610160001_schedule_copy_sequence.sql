-- Atomic weekend copying for an explicitly previewed sequence of source days.
-- Reuse the existing single-day permission, parity, exclusion, conflict and
-- duplicate checks. Only timetable lessons are copied, never homework or files.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regprocedure('public.xelay_copy_study_group_schedule_day(uuid,date,date,boolean,text)') is null
    or to_regprocedure('public.xelay_lock_study_group_permission(uuid,text,boolean)') is null
    or not exists(select 1 from pg_attribute
      where attrelid=to_regclass('public.study_group_schedule')
        and attname='excluded_dates' and not attisdropped) then
    raise exception 'Apply schedule occurrence cancellation 202610150010 before sequence copying';
  end if;
end;
$$;

create or replace function public.xelay_copy_study_group_schedule_sequence(
  p_group_id uuid,p_pairs jsonb,p_preview boolean default false,p_expected_signature text default null
)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  v_pair jsonb;
  v_source_date date;
  v_target_date date;
  v_previous_target date;
  v_result jsonb;
  v_previews jsonb:='[]'::jsonb;
  v_signatures jsonb:='[]'::jsonb;
  v_signature text;
  v_source_lessons integer:=0;
  v_copied integer:=0;
  v_skipped integer:=0;
  v_days jsonb:='[]'::jsonb;
  v_index integer:=0;
begin
  -- Hold the established group/permission lock for the entire transaction.
  -- The nested single-day RPC also enforces actual representative/appointment
  -- status; a function-owner or platform-admin role is not an exception.
  perform public.xelay_lock_study_group_permission(p_group_id,'schedule',true);
  if p_preview is null or p_pairs is null or jsonb_typeof(p_pairs) is distinct from 'array' then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_SEQUENCE_INVALID' using errcode='22023';
  end if;
  if jsonb_array_length(p_pairs) not between 1 and 26 or octet_length(p_pairs::text)>16384 then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_SEQUENCE_LIMIT' using errcode='22023';
  end if;

  -- Validate the entire plan before source queries, including order/uniqueness.
  for v_pair in select value from jsonb_array_elements(p_pairs) loop
    if jsonb_typeof(v_pair) is distinct from 'object' then
      raise exception 'STUDY_GROUP_TIMETABLE_COPY_SEQUENCE_INVALID' using errcode='22023';
    end if;
    if jsonb_typeof(v_pair->'source_date') is distinct from 'string'
      or jsonb_typeof(v_pair->'target_date') is distinct from 'string'
      or (v_pair->>'source_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or (v_pair->>'target_date') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
      or exists(select 1 from jsonb_object_keys(v_pair) as keys(key)
        where key not in('source_date','target_date')) then
      raise exception 'STUDY_GROUP_TIMETABLE_COPY_SEQUENCE_INVALID' using errcode='22023';
    end if;
    begin
      v_source_date:=(v_pair->>'source_date')::date;
      v_target_date:=(v_pair->>'target_date')::date;
    exception when invalid_text_representation or invalid_datetime_format or datetime_field_overflow then
      raise exception 'STUDY_GROUP_TIMETABLE_COPY_SEQUENCE_INVALID' using errcode='22023';
    end;
    if not isfinite(v_source_date) or not isfinite(v_target_date)
      or v_source_date not between date '1900-01-01' and date '2200-12-31'
      or v_target_date not between date '1900-01-01' and date '2200-12-31'
      or v_source_date=v_target_date
      or extract(isodow from v_source_date) not between 1 and 5
      or extract(isodow from v_target_date) not in(6,7)
      or (v_previous_target is not null and v_target_date<=v_previous_target) then
      raise exception 'STUDY_GROUP_TIMETABLE_COPY_SEQUENCE_INVALID' using errcode='22023';
    end if;
    v_previous_target:=v_target_date;
  end loop;

  -- Preview every pair before insertion. A genuinely empty source is a visible
  -- no-op, so free weekdays do not prevent copying the rest of the sequence.
  for v_pair in select value from jsonb_array_elements(p_pairs) loop
    v_source_date:=(v_pair->>'source_date')::date;
    v_target_date:=(v_pair->>'target_date')::date;
    begin
      v_result:=public.xelay_copy_study_group_schedule_day(p_group_id,v_source_date,v_target_date,true,null)
        ||jsonb_build_object('empty',false);
    exception when sqlstate '22023' then
      if sqlerrm is distinct from 'STUDY_GROUP_TIMETABLE_COPY_SOURCE_EMPTY' then raise; end if;
      v_result:=jsonb_build_object('copied',0,'skipped',0,'empty',true,
        'source_signature',md5(v_source_date::text||':[]'),'lessons','[]'::jsonb);
    end;
    v_source_lessons:=v_source_lessons+jsonb_array_length(v_result->'lessons');
    if v_source_lessons>1008 then
      raise exception 'STUDY_GROUP_TIMETABLE_COPY_SEQUENCE_LIMIT' using errcode='22023';
    end if;
    v_previews:=v_previews||jsonb_build_array(v_result);
    v_signatures:=v_signatures||jsonb_build_array(v_result->>'source_signature');
  end loop;

  -- Pair order and all exact source snapshots belong to the approval. Target
  -- state is checked anew by the existing single-day RPC, without replacing it.
  v_signature:=md5(p_pairs::text||':'||v_signatures::text);
  if not p_preview and (p_expected_signature is null or p_expected_signature<>v_signature) then
    raise exception 'STUDY_GROUP_TIMETABLE_COPY_SOURCE_CHANGED' using errcode='22023';
  end if;

  for v_pair in select value from jsonb_array_elements(p_pairs) loop
    if p_preview or (v_previews->v_index->>'empty')::boolean then
      v_result:=v_previews->v_index;
    else
      v_result:=public.xelay_copy_study_group_schedule_day(p_group_id,
        (v_pair->>'source_date')::date,(v_pair->>'target_date')::date,false,
        v_previews->v_index->>'source_signature');
    end if;
    v_copied:=v_copied+(v_result->>'copied')::integer;
    v_skipped:=v_skipped+(v_result->>'skipped')::integer;
    v_days:=v_days||jsonb_build_array(jsonb_build_object(
      'source_date',v_pair->>'source_date','target_date',v_pair->>'target_date',
      'copied',(v_result->>'copied')::integer,'skipped',(v_result->>'skipped')::integer,
      'empty',(v_previews->v_index->>'empty')::boolean,'lessons',v_result->'lessons'));
    v_index:=v_index+1;
  end loop;
  return jsonb_build_object('copied',v_copied,'skipped',v_skipped,
    'source_signature',v_signature,'days',v_days);
end;
$$;

revoke all on function public.xelay_copy_study_group_schedule_sequence(uuid,jsonb,boolean,text)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_copy_study_group_schedule_sequence(uuid,jsonb,boolean,text)
  to authenticated;
comment on function public.xelay_copy_study_group_schedule_sequence(uuid,jsonb,boolean,text) is
  'Preview/confirm 1-26 explicit weekday-to-weekend copies atomically, with at most 1008 source occurrences. Existing schedule permissions and single-day checks remain authoritative; no homework is copied.';

notify pgrst,'reload schema';
commit;
