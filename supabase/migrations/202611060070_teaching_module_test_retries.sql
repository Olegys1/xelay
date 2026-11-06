-- Preserve every submission while keeping a single current attempt for the
-- existing ranking, journal and student views.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.teaching_tests
  add column retry_days integer,
  add column retry_pass_percent integer,
  add constraint teaching_tests_retry_settings check (
    (retry_days is null and retry_pass_percent is null)
    or (retry_days is not null and retry_pass_percent is not null
      and retry_days between 1 and 60 and retry_pass_percent between 1 and 100)
  );
alter table public.teaching_test_attempts
  add column attempt_number integer not null default 1 check(attempt_number>0),
  add column superseded_at timestamptz,
  add constraint teaching_test_attempt_history check (
    superseded_at is null or (status='submitted' and submitted_at is not null
      and superseded_at>=submitted_at and grade_id is null)
  ),
  add constraint teaching_test_attempt_number_unique unique(test_id,user_id,attempt_number);
alter table public.teaching_test_attempts drop constraint teaching_test_attempts_test_id_user_id_key;
create unique index teaching_test_current_attempt_idx
  on public.teaching_test_attempts(test_id,user_id) where superseded_at is null;

create function public.xelay_private_test_module_retry_group(p_test uuid,p_group uuid,p_user uuid default null)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.teaching_course_module_items i
    join public.teaching_course_modules m on m.id=i.module_id
    left join public.teaching_course_module_lectures l on l.module_id=m.id
    where i.resource_type='test' and i.resource_id=p_test and i.archived_at is null
      and m.status='published' and p_group=any(m.group_ids)
      and (p_user is null or (
        -- Viewing an earlier attempt is still grandfathered. A fresh start
        -- must satisfy current module and lecture requirements.
        not exists(select 1 from unnest(m.prerequisite_item_ids||i.prerequisite_item_ids) d
          where not coalesce((public.xelay_private_module_item_completion(d,p_group,p_user)->>'completed')::boolean,false))
        and not coalesce(public.xelay_private_module_delay_until(m.id,p_group,p_user)>statement_timestamp(),false)
        and (l.module_id is null or (public.xelay_private_module_lecture_open(m.id,p_group,p_user)
          and (l.test_item_id is distinct from i.id or public.xelay_private_module_lecture_watched(m.id,p_group,p_user))))
      )));
$$;

create function public.xelay_private_test_retry_close_at(
  p_test public.teaching_tests,p_attempt public.teaching_test_attempts
)
returns timestamptz language sql stable set search_path='' as $$
  select coalesce((select (o->>'closes_at')::timestamptz from jsonb_array_elements(p_test.overrides)o
    where o->>'user_id'=p_attempt.user_id::text and o->>'group_id'=p_attempt.group_id::text),p_test.closes_at);
$$;

create function public.xelay_private_test_retry_available_at(
  p_test public.teaching_tests,p_attempt public.teaching_test_attempts
)
returns timestamptz language plpgsql stable security definer set search_path='' as $$
declare v_ready timestamptz;v_close timestamptz;
begin
  if p_test.retry_days is null or p_test.status<>'published' or p_test.results_finalized_at is not null
    or p_attempt.test_id is distinct from p_test.id or p_attempt.status<>'submitted'
    or p_attempt.superseded_at is not null or p_attempt.grade_id is not null
    or p_attempt.submitted_at is null or p_attempt.score is null
    or p_attempt.score*100>=p_test.retry_pass_percent*p_test.max_points
    or not public.xelay_private_test_module_retry_group(p_test.id,p_attempt.group_id,p_attempt.user_id)
    or not public.xelay_private_test_allows(p_test,p_attempt.user_id,p_attempt.group_id)
    or exists(select 1 from jsonb_array_elements(p_attempt.questions) q
      where q->>'kind'='essay' and coalesce(p_attempt.question_reviews->(q->>'id')->>'mode','auto')='auto')
  then return null;end if;
  v_close:=public.xelay_private_test_retry_close_at(p_test,p_attempt);
  v_ready:=p_attempt.submitted_at+make_interval(hours=>p_test.retry_days*24);
  if v_ready>=v_close or statement_timestamp()>=v_close then return null;end if;
  return v_ready;
end $$;

-- All alterations have exact anchors and abort the migration if a deployed
-- function has diverged. Preserve the established lock, admission, code,
-- variant, scoring and grade-transfer paths.
do $patch$
declare v_target record;v_source text;v_pair record;
begin
  for v_target in select distinct function_name from (values
    ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)'),
    ('public.xelay_private_test_detail_before_admission_20261105(uuid)'),
    ('public.xelay_private_test_view_before_admission_20261105(public.teaching_tests,uuid,boolean)'),
    ('public.xelay_teaching_module_lecture_statistics(uuid,uuid)')
  )f(function_name) loop
    v_source:=replace(pg_get_functiondef(v_target.function_name::regprocedure),chr(13),'');
    for v_pair in select * from (values
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        'where test_id=v_id and user_id=v_uid for update;',
        'where test_id=v_id and user_id=v_uid and superseded_at is null for update;'),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        $old$if p_action='start' then
    if v_attempt.id is not null then return public.xelay_teaching_test(v_id);end if;
    v_group:=(p_payload->>'group_id')::uuid;$old$,
        $new$if p_action in('start','retry') then
    if p_action='start' and v_attempt.id is not null then return public.xelay_teaching_test(v_id);end if;
    v_group:=(p_payload->>'group_id')::uuid;
    if p_action='retry' then
      if p_payload->>'expected_user_id' is distinct from v_uid::text then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501';end if;
      if v_attempt.id is null or v_attempt.group_id is distinct from v_group
        or v_attempt.id::text is distinct from p_payload->>'attempt_id'
        or v_attempt.version<>v_version then raise exception 'TEST_CONFLICT';end if;
      v_open:=public.xelay_private_test_retry_available_at(v_test,v_attempt);
      if v_open is null then raise exception 'TEST_RETRY_NOT_AVAILABLE';end if;
      if v_now<v_open then raise exception 'TEST_RETRY_TOO_EARLY';end if;
    end if;$new$),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        $old$insert into public.teaching_test_attempts(id,test_id,group_id,user_id,started_at,expires_at,opened_at,questions)
      values(v_attempt_id,v_id,v_group,v_uid,v_now,least(v_close,v_now+make_interval(secs=>v_duration)),jsonb_build_object(v_variant->0->>'id',v_now),v_variant);$old$,
        $new$if p_action='retry' then
      update public.teaching_test_attempts set superseded_at=v_now where id=v_attempt.id;
    end if;
    insert into public.teaching_test_attempts(id,test_id,group_id,user_id,started_at,expires_at,opened_at,questions,attempt_number)
      values(v_attempt_id,v_id,v_group,v_uid,v_now,least(v_close,v_now+make_interval(secs=>v_duration)),
        jsonb_build_object(v_variant->0->>'id',v_now),v_variant,coalesce(v_attempt.attempt_number,0)+1);$new$),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        $old$if v_attempt.id is null then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  if v_attempt.status='submitted' then$old$,
        $new$if v_attempt.id is null then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  if (v_attempt.attempt_number>1 or p_payload?'attempt_id')
    and p_payload->>'attempt_id' is distinct from v_attempt.id::text then raise exception 'TEST_CONFLICT';end if;
  if v_attempt.status='submitted' then$new$),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        $old$if v_attempt.status<>'submitted' then raise exception 'TEST_REVIEW_REQUIRED';end if;$old$,
        $new$if v_attempt.superseded_at is not null then raise exception 'TEST_IMMUTABLE';end if;
    if v_attempt.status<>'submitted' then raise exception 'TEST_REVIEW_REQUIRED';end if;$new$),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        'version=version+1 where test_id=v_id;',
        'version=version+1 where test_id=v_id and superseded_at is null;'),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        $old$where a.test_id=v_id and q->>'kind'='essay'$old$,
        $new$where a.test_id=v_id and a.superseded_at is null and q->>'kind'='essay'$new$),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        $old$where test_id=v_id and status='submitted' and public.xelay_private_test_allows(v_test,user_id,group_id);$old$,
        $new$where test_id=v_id and status='submitted' and superseded_at is null and public.xelay_private_test_allows(v_test,user_id,group_id);$new$),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        $old$where test_id=v_id and status='submitted' order by score desc,elapsed_seconds,id for update loop$old$,
        $new$where test_id=v_id and status='submitted' and superseded_at is null order by score desc,elapsed_seconds,id for update loop$new$),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        'where test_id=v_id and reviewed_at is null order by group_id,id for update loop',
        'where test_id=v_id and superseded_at is null and reviewed_at is null order by group_id,id for update loop'),
      ('public.xelay_private_test_detail_before_admission_20261105(uuid)',
        'where test_id=p_test_id and user_id=v_uid;',
        'where test_id=p_test_id and user_id=v_uid and superseded_at is null;'),
      ('public.xelay_private_test_view_before_admission_20261105(public.teaching_tests,uuid,boolean)',
        'where a.test_id=p_test.id and a.user_id=p_user and public.xelay_private_test_allows',
        'where a.test_id=p_test.id and a.user_id=p_user and a.superseded_at is null and public.xelay_private_test_allows'),
      ('public.xelay_teaching_module_lecture_statistics(uuid,uuid)',
        'a.test_id=v_test.id and a.group_id=p_group_id and a.user_id=p.id',
        'a.test_id=v_test.id and a.group_id=p_group_id and a.user_id=p.id and a.superseded_at is null'),
      ('public.xelay_teaching_module_lecture_statistics(uuid,uuid)',
        $old$where a.test_id=v_test.id and a.group_id=p_group_id and a.status='submitted'$old$,
        $new$where a.test_id=v_test.id and a.group_id=p_group_id and a.status='submitted' and a.superseded_at is null$new$)
    )p(function_name,anchor,replacement) where p.function_name=v_target.function_name loop
      if (length(v_source)-length(replace(v_source,v_pair.anchor,'')))/length(v_pair.anchor)<>1 then
        raise exception 'TEST_RETRY_SOURCE_CHANGED: % / %',v_target.function_name,left(v_pair.anchor,120);end if;
      v_source:=replace(v_source,v_pair.anchor,v_pair.replacement);
    end loop;
    execute v_source;
  end loop;
end $patch$;

alter function public.xelay_private_test_attempt_view(public.teaching_test_attempts,public.teaching_tests,boolean)
  rename to xelay_private_test_attempt_view_before_retries;
create function public.xelay_private_test_attempt_view(p_attempt public.teaching_test_attempts,p_test public.teaching_tests,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_view jsonb;v_available timestamptz;
begin
  v_view:=public.xelay_private_test_attempt_view_before_retries(p_attempt,p_test,p_full)
    ||jsonb_build_object('attempt_number',p_attempt.attempt_number);
  if not p_full and p_attempt.user_id=auth.uid() and p_test.retry_days is not null then
    v_available:=public.xelay_private_test_retry_available_at(p_test,p_attempt);
    if v_available is not null then
      v_view:=v_view||jsonb_build_object('retry_available_at',v_available,
        'retry_closes_at',public.xelay_private_test_retry_close_at(p_test,p_attempt));
    end if;
  end if;
  return v_view;
end $$;

alter function public.xelay_private_test_view(public.teaching_tests,uuid,boolean)
  rename to xelay_private_test_view_before_retries;
create function public.xelay_private_test_view(p_test public.teaching_tests,p_user uuid,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_view jsonb;
begin
  v_view:=public.xelay_private_test_view_before_retries(p_test,p_user,p_full)-array['retry_days','retry_pass_percent'];
  if p_full or (p_test.retry_days is not null and exists(
    select 1 from jsonb_array_elements(v_view->'targets') t
      where public.xelay_private_test_module_retry_group(p_test.id,(t->>'group_id')::uuid)
      and public.xelay_private_test_allows(p_test,p_user,(t->>'group_id')::uuid)
  )) then
    v_view:=v_view||jsonb_build_object('retry_days',p_test.retry_days,'retry_pass_percent',p_test.retry_pass_percent);
  end if;
  return v_view;
end $$;

alter function public.xelay_teaching_test_mutate(text,jsonb) rename to xelay_private_test_mutate_before_retries;
create function public.xelay_teaching_test_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_result jsonb;v_days integer;v_percent integer;v_open timestamptz;v_close timestamptz;
begin
  if p_action is distinct from 'save_test' or not coalesce(p_payload?|array['retry_days','retry_pass_percent'],false) then
    return public.xelay_private_test_mutate_before_retries(p_action,p_payload);end if;
  if not(p_payload?&array['retry_days','retry_pass_percent']) then raise exception 'TEST_INVALID_INPUT';end if;
  if p_payload->'retry_days'<>'null'::jsonb or p_payload->'retry_pass_percent'<>'null'::jsonb then
    if jsonb_typeof(p_payload->'retry_days') is distinct from 'number'
      or jsonb_typeof(p_payload->'retry_pass_percent') is distinct from 'number' then raise exception 'TEST_INVALID_INPUT';end if;
    v_days:=(p_payload->>'retry_days')::integer;
    v_percent:=(p_payload->>'retry_pass_percent')::integer;
    if v_days not between 1 and 60 or v_percent not between 1 and 100 then raise exception 'TEST_INVALID_INPUT';end if;
    v_open:=(p_payload->>'opens_at')::timestamptz;v_close:=(p_payload->>'closes_at')::timestamptz;
    if v_close<=v_open+make_interval(hours=>v_days*24) then raise exception 'TEST_RETRY_WINDOW_TOO_SHORT';end if;
  end if;
  -- Existing save holds the attempt lock and prevents changing policy after
  -- an attempt starts. Only replace the two new fields after its checks pass.
  v_result:=public.xelay_private_test_mutate_before_retries(p_action,p_payload-array['retry_days','retry_pass_percent']);
  update public.teaching_tests set retry_days=v_days,retry_pass_percent=v_percent where id=(p_payload->>'id')::uuid;
  return v_result||jsonb_build_object('test',v_result->'test'||jsonb_build_object('retry_days',v_days,'retry_pass_percent',v_percent));
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow then
  raise exception 'TEST_INVALID_INPUT' using errcode='22023';
end $$;

revoke all on function public.xelay_private_test_module_retry_group(uuid,uuid,uuid),
  public.xelay_private_test_retry_close_at(public.teaching_tests,public.teaching_test_attempts),
  public.xelay_private_test_retry_available_at(public.teaching_tests,public.teaching_test_attempts),
  public.xelay_private_test_attempt_view_before_retries(public.teaching_test_attempts,public.teaching_tests,boolean),
  public.xelay_private_test_attempt_view(public.teaching_test_attempts,public.teaching_tests,boolean),
  public.xelay_private_test_view_before_retries(public.teaching_tests,uuid,boolean),
  public.xelay_private_test_view(public.teaching_tests,uuid,boolean),
  public.xelay_private_test_mutate_before_retries(text,jsonb),
  public.xelay_teaching_test_mutate(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_test_mutate(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
