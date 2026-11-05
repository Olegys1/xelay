-- Per-test admission extends the existing versioned personal conditions.
-- Existing attempts, frozen question variants and journal values are untouched.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $preflight$
begin
  if to_regprocedure('public.xelay_private_test_allows_before_modules_20261104(public.teaching_tests,uuid,uuid)') is null
    or to_regprocedure('public.xelay_private_assessment_validate_overrides(public.teaching_tests,jsonb)') is null
    or to_regprocedure('public.xelay_private_test_view(public.teaching_tests,uuid,boolean)') is null
    or to_regprocedure('public.xelay_teaching_test_mutate(text,jsonb)') is null then
    raise exception 'TEST_ADMISSION_PREREQUISITES_MISSING';end if;
end $preflight$;

create function public.xelay_private_test_admission(p_test public.teaching_tests,p_user uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select case when exists(select 1 from public.teaching_test_attempts a where a.test_id=p_test.id and a.user_id=p_user)
    then jsonb_build_object('allowed',true,'reason','')
    else coalesce((select jsonb_build_object('allowed',false,'reason',case when jsonb_typeof(o->'exclusion_reason')='string'
      then left(btrim(o->>'exclusion_reason'),500) else '' end) from jsonb_array_elements(p_test.overrides)o
      where o->>'user_id'=p_user::text and o->'excluded'='true'::jsonb limit 1),jsonb_build_object('allowed',true,'reason','')) end;
$$;

alter function public.xelay_private_assessment_validate_overrides(public.teaching_tests,jsonb)
  rename to xelay_private_validate_overrides_before_admission_20261105;
create function public.xelay_private_assessment_validate_overrides(p_test public.teaching_tests,p_overrides jsonb)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare v_item jsonb;v_open timestamptz;v_close timestamptz;
begin
  if jsonb_typeof(p_overrides) is distinct from 'array' then return false;end if;
  if jsonb_array_length(p_overrides)>200 or jsonb_array_length(p_overrides)<>(select count(distinct x->>'user_id') from jsonb_array_elements(p_overrides)x) then return false;end if;
  for v_item in select value from jsonb_array_elements(p_overrides) loop
    if jsonb_typeof(v_item) is distinct from 'object' then return false;end if;
    if exists(select 1 from jsonb_object_keys(v_item)k where k not in('user_id','group_id','opens_at','closes_at','duration_seconds','excluded','exclusion_reason'))
      or v_item->>'user_id' is null or v_item->>'group_id' is null
      or(v_item?'excluded' and jsonb_typeof(v_item->'excluded') is distinct from 'boolean')
      or(v_item?'exclusion_reason' and(jsonb_typeof(v_item->'exclusion_reason') is distinct from 'string' or length(v_item->>'exclusion_reason')>500))
      -- Admission and module gates must not prevent an authorized teacher from
      -- restoring access or preparing conditions before a prerequisite is done.
      or public.xelay_private_test_allows_before_modules_20261104(p_test,(v_item->>'user_id')::uuid,(v_item->>'group_id')::uuid) is not true then return false;end if;
    v_open:=coalesce((v_item->>'opens_at')::timestamptz,p_test.opens_at);v_close:=coalesce((v_item->>'closes_at')::timestamptz,p_test.closes_at);
    if not isfinite(v_open) or not isfinite(v_close) or v_close<=v_open
      or not exists(select 1 from public.teaching_courses c where c.id=p_test.course_id and(v_open at time zone 'Europe/Kyiv')::date>=c.starts_on
        and(v_close at time zone 'Europe/Kyiv')::date<=c.ends_on)
      or(v_item->>'duration_seconds' is not null and(jsonb_typeof(v_item->'duration_seconds')<>'number'
        or(v_item->>'duration_seconds')::numeric not between 30 and 86400 or trunc((v_item->>'duration_seconds')::numeric)<>(v_item->>'duration_seconds')::numeric)) then return false;end if;
  end loop;return true;
exception when others then return false;
end $$;

alter function public.xelay_private_test_allows(public.teaching_tests,uuid,uuid)
  rename to xelay_private_test_allows_before_admission_20261105;
create function public.xelay_private_test_allows(p_test public.teaching_tests,p_user uuid,p_group uuid default null)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_private_test_allows_before_admission_20261105(p_test,p_user,p_group)
    and(public.xelay_private_test_admission(p_test,p_user)->>'allowed')::boolean;
$$;

alter function public.xelay_private_test_view(public.teaching_tests,uuid,boolean)
  rename to xelay_private_test_view_before_admission_20261105;
create function public.xelay_private_test_view(p_test public.teaching_tests,p_user uuid,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_view jsonb;v_admission jsonb;
begin
  v_view:=public.xelay_private_test_view_before_admission_20261105(p_test,p_user,p_full);
  if p_full then
    -- A colleague for one group does not gain private exclusion reasons from
    -- other groups merely because this test has one shared question pool.
    return v_view||jsonb_build_object('overrides',coalesce((select jsonb_agg(o) from jsonb_array_elements(p_test.overrides)o
      where public.xelay_teaching_group_permissions(p_test.course_id,(o->>'group_id')::uuid,p_user)&&array['assignments','grades']::text[]),'[]'::jsonb));
  end if;
  v_admission:=public.xelay_private_test_admission(p_test,p_user);
  if(v_admission->>'allowed')::boolean then return v_view||jsonb_build_object('my_admission',v_admission);end if;
  -- A student may know the title and their own admission decision. No prompt,
  -- descriptions, solution, peer override, attempt or grade is returned here.
  return jsonb_build_object('id',p_test.id,'course_id',p_test.course_id,'course_title',v_view->'course_title',
    'title',p_test.title,'description','','status',p_test.status,'opens_at',v_view->'opens_at','closes_at',v_view->'closes_at',
    'duration_seconds',v_view->'duration_seconds','max_points',p_test.max_points,'category',p_test.category,
    'journal_date',p_test.journal_date,'work_type',p_test.work_type,'allow_skip',p_test.allow_skip,'allow_return',p_test.allow_return,
    'question_timer_policy',p_test.question_timer_policy,'restrict_copy',p_test.restrict_copy,'bonus_percent',p_test.bonus_percent,
    'bonus_points',p_test.bonus_points,'question_count',0,'questions','[]'::jsonb,'targets',coalesce((select jsonb_agg(jsonb_build_object(
      'group_id',t->>'group_id','audience_mode','all','subgroup_ids','[]'::jsonb)) from jsonb_array_elements(p_test.targets)t
      where public.xelay_private_test_allows_before_modules_20261104(p_test,p_user,(t->>'group_id')::uuid)),'[]'::jsonb),
    'version',p_test.version,'has_attempts',false,'results_finalized_at',null,'review_revision',0,'approved_revision',null,
    'can_edit',false,'can_review',false,'my_attempt',null,'overrides','[]'::jsonb,'my_admission',v_admission,'created_at',p_test.created_at);
end $$;

alter function public.xelay_teaching_test(uuid) rename to xelay_private_test_detail_before_admission_20261105;
create function public.xelay_teaching_test(p_test_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_test public.teaching_tests%rowtype;
begin
  select * into v_test from public.teaching_tests where id=p_test_id;
  if found and v_test.status<>'draft' and not public.xelay_private_test_staff(v_test,v_uid,'assignments')
    and not public.xelay_private_test_staff(v_test,v_uid,'grades')
    and public.xelay_private_test_allows_before_modules_20261104(v_test,v_uid)
    and not(public.xelay_private_test_admission(v_test,v_uid)->>'allowed')::boolean then
    return jsonb_build_object('test',public.xelay_private_test_view(v_test,v_uid,false),'attempt',null,'attempts','[]'::jsonb,'server_now',clock_timestamp());end if;
  return public.xelay_private_test_detail_before_admission_20261105(p_test_id);
end $$;

alter function public.xelay_teaching_tests(uuid,uuid) rename to xelay_private_test_list_before_admission_20261105;
create function public.xelay_teaching_tests(p_course_id uuid default null,p_group_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_result jsonb;v_excluded jsonb;v_tests jsonb;
begin
  v_result:=public.xelay_private_test_list_before_admission_20261105(p_course_id,p_group_id);
  select coalesce(jsonb_agg(public.xelay_private_test_view(t,v_uid,false)),'[]'::jsonb) into v_excluded
    from public.teaching_tests t where(p_course_id is null or t.course_id=p_course_id) and t.status<>'draft'
      and(p_group_id is null or exists(select 1 from jsonb_array_elements(t.targets)x where(x->>'group_id')::uuid=p_group_id))
      and not public.xelay_private_test_staff(t,v_uid,'assignments') and not public.xelay_private_test_staff(t,v_uid,'grades')
      and public.xelay_private_test_allows_before_modules_20261104(t,v_uid,p_group_id)
      and not(public.xelay_private_test_admission(t,v_uid)->>'allowed')::boolean;
  select coalesce(jsonb_agg(x order by(x->>'created_at') desc nulls last,x->>'id'),'[]'::jsonb) into v_tests
    from jsonb_array_elements((v_result->'tests')||v_excluded)x;
  return v_result||jsonb_build_object('tests',v_tests);
end $$;

alter function public.xelay_teaching_test_mutate(text,jsonb) rename to xelay_private_test_mutate_before_admission_20261105;
create function public.xelay_teaching_test_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_id uuid;v_test public.teaching_tests%rowtype;v_override jsonb;v_old jsonb;
  v_payload jsonb:=p_payload;v_target jsonb;v_has_admission boolean;
begin
  if p_action not in('save_override','save_test','start') then return public.xelay_private_test_mutate_before_admission_20261105(p_action,p_payload);end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>500000 then raise exception 'TEST_INVALID_INPUT';end if;
  v_id:=(p_payload->>'id')::uuid;
  if v_id is null then raise exception 'TEST_INVALID_INPUT';end if;
  v_has_admission:=p_action='save_override' or(p_action='save_test' and jsonb_typeof(p_payload->'overrides')='array'
    and exists(select 1 from jsonb_array_elements(p_payload->'overrides')o where o?'excluded' or o?'exclusion_reason'));
  if v_has_admission and p_payload->>'expected_user_id' is distinct from v_uid::text then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||v_id,0));
  select * into v_test from public.teaching_tests where id=v_id for update;
  if p_action='save_override' then
    if not found or jsonb_typeof(p_payload->'override') is distinct from 'object' then raise exception 'TEST_INVALID_INPUT';end if;
    v_override:=p_payload->'override';
    if(v_override?'excluded' and jsonb_typeof(v_override->'excluded') is distinct from 'boolean')
      or(v_override?'exclusion_reason' and jsonb_typeof(v_override->'exclusion_reason') is distinct from 'string') then raise exception 'TEST_INVALID_INPUT';end if;
    perform public.xelay_private_assert_teaching_group(v_test.course_id,(v_override->>'group_id')::uuid,'assignments');
    perform public.xelay_private_assert_teaching_group(v_test.course_id,(v_override->>'group_id')::uuid,'grades');
    if(p_payload->>'version')::integer is distinct from v_test.version then raise exception 'TEST_CONFLICT';end if;
    if exists(select 1 from public.teaching_test_attempts where test_id=v_id and user_id=(v_override->>'user_id')::uuid) then raise exception 'TEST_OVERRIDE_STARTED';end if;
    select o into v_old from jsonb_array_elements(v_test.overrides)o where o->>'user_id'=v_override->>'user_id';
    if not(v_override?'excluded') and v_old?'excluded' then
      -- Older open editors can change dates without silently restoring admission.
      v_override:=v_override||jsonb_build_object('excluded',v_old->'excluded','exclusion_reason',coalesce(v_old->>'exclusion_reason',''));
    end if;
    if v_override?'excluded' and jsonb_typeof(v_override->'excluded')='boolean' then
      v_override:=v_override||jsonb_build_object('exclusion_reason',case when v_override->'excluded'='true'::jsonb
        then coalesce(v_override->>'exclusion_reason',v_old->>'exclusion_reason','') else '' end);
    end if;
    if coalesce(v_override->'excluded'='true'::jsonb,false) is distinct from coalesce(v_old->'excluded'='true'::jsonb,false)
      or(v_override->'excluded'='true'::jsonb and coalesce(v_override->>'exclusion_reason','') is distinct from coalesce(v_old->>'exclusion_reason','')) then
      -- Admission is per test/student. A scoped teacher cannot use a student's
      -- second group to remove an opportunity controlled by a different teacher.
      for v_target in select value from jsonb_array_elements(v_test.targets)t
        where public.xelay_private_test_allows_before_modules_20261104(v_test,(v_override->>'user_id')::uuid,(t->>'group_id')::uuid) loop
        perform public.xelay_private_assert_teaching_group(v_test.course_id,(v_target->>'group_id')::uuid,'assignments');
        perform public.xelay_private_assert_teaching_group(v_test.course_id,(v_target->>'group_id')::uuid,'grades');
      end loop;
    end if;
    v_payload:=jsonb_set(p_payload,'{override}',v_override);
  elsif p_action='start' and v_test.id is not null and v_test.status<>'draft'
    and public.xelay_private_test_allows_before_modules_20261104(v_test,v_uid,(p_payload->>'group_id')::uuid)
    and not(public.xelay_private_test_admission(v_test,v_uid)->>'allowed')::boolean then
    raise exception 'TEST_NOT_ADMITTED' using errcode='42501';
  end if;
  return public.xelay_private_test_mutate_before_admission_20261105(p_action,v_payload);
exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then raise exception 'TEST_INVALID_INPUT' using errcode='22023';
end $$;

revoke all on function public.xelay_private_test_admission(public.teaching_tests,uuid),
  public.xelay_private_validate_overrides_before_admission_20261105(public.teaching_tests,jsonb),public.xelay_private_assessment_validate_overrides(public.teaching_tests,jsonb),
  public.xelay_private_test_allows_before_admission_20261105(public.teaching_tests,uuid,uuid),public.xelay_private_test_allows(public.teaching_tests,uuid,uuid),
  public.xelay_private_test_view_before_admission_20261105(public.teaching_tests,uuid,boolean),public.xelay_private_test_view(public.teaching_tests,uuid,boolean),
  public.xelay_private_test_detail_before_admission_20261105(uuid),public.xelay_private_test_list_before_admission_20261105(uuid,uuid),
  public.xelay_private_test_mutate_before_admission_20261105(text,jsonb),
  public.xelay_teaching_test(uuid),public.xelay_teaching_tests(uuid,uuid),public.xelay_teaching_test_mutate(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_test(uuid),public.xelay_teaching_tests(uuid,uuid),public.xelay_teaching_test_mutate(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
