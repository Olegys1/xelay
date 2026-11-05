-- Deliberate owner closure is separate from answer review, bonus approval,
-- journal transfer and student publication. Original availability is history.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.teaching_tests add column closed_early_at timestamptz,
  add column closed_early_by uuid references public.profiles(id);
alter table public.teaching_tests add constraint teaching_test_explicit_close_pair
  check((closed_early_at is null and closed_early_by is null)
    or(closed_early_at is not null and isfinite(closed_early_at) and closed_early_by is not null and status='closed'));

-- Preserve the existing finalizer with one narrow readiness condition. The
-- remainder still validates versions, essays, ranking and journal snapshots.
do $patch$
declare v_function regprocedure;v_body text;v_count integer:=0;
  v_old text:=$old$if v_now<greatest(v_test.closes_at,(select max((o->>'closes_at')::timestamptz) from jsonb_array_elements(v_test.overrides)o)) then raise exception 'TEST_RESULTS_NOT_READY';end if;$old$;
begin
  for v_function in select p.oid::regprocedure from pg_catalog.pg_proc p
    where p.pronamespace='public'::regnamespace and p.prokind='f' and p.proname like 'xelay%test%mutate%' loop
    v_body:=replace(pg_get_functiondef(v_function),chr(13),'');
    if strpos(v_body,v_old)>0 then
      if(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>1 then raise exception 'TEST_CLOSE_READINESS_SOURCE_CHANGED';end if;
      execute replace(v_body,v_old,replace(v_old,'if v_now<','if v_test.closed_early_at is null and v_now<'));
      v_count:=v_count+1;
    end if;
  end loop;
  if v_count<>1 then raise exception 'TEST_CLOSE_READINESS_SOURCE_CHANGED';end if;
end $patch$;

alter function public.xelay_private_test_view(public.teaching_tests,uuid,boolean)
  rename to xelay_private_test_view_before_close_20261105;
create function public.xelay_private_test_view(p_test public.teaching_tests,p_user uuid,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;v_owner boolean;
begin
  v_result:=public.xelay_private_test_view_before_close_20261105(p_test,p_user,p_full);
  v_owner:=p_full and exists(select 1 from public.teaching_courses c where c.id=p_test.course_id and c.owner_id=p_user and c.archived_at is null)
    and public.xelay_teaching_has_current_access(p_user)
    and public.xelay_private_test_staff(p_test,p_user,'assignments',true)
    and public.xelay_private_test_staff(p_test,p_user,'grades',true);
  v_result:=v_result||jsonb_build_object('can_close',v_owner and p_test.status='published' and p_test.results_finalized_at is null);
  if p_test.closed_early_at is not null then
    v_result:=v_result||jsonb_build_object('results_ready_at',p_test.closed_early_at,
      'closes_at',least((v_result->>'closes_at')::timestamptz,p_test.closed_early_at));
  end if;
  return v_result;
end $$;

alter function public.xelay_teaching_test_mutate(text,jsonb)
  rename to xelay_private_test_mutate_before_close_20261105;
create function public.xelay_teaching_test_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid;v_id uuid;v_test public.teaching_tests%rowtype;v_now timestamptz;v_attempt record;
begin
  if p_action is distinct from 'close_test' then return public.xelay_private_test_mutate_before_close_20261105(p_action,p_payload);end if;
  v_uid:=public.xelay_teaching_assert_user();
  if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>2000
    or exists(select 1 from jsonb_object_keys(p_payload)k where k not in('id','version','expected_user_id','confirm_close_all'))
    or p_payload->>'expected_user_id' is distinct from v_uid::text then raise exception 'TEST_INVALID_INPUT';end if;
  if p_payload->'confirm_close_all' is distinct from 'true'::jsonb then raise exception 'TEST_CLOSE_CONFIRM_REQUIRED';end if;
  v_id:=(p_payload->>'id')::uuid;
  if v_id is null or jsonb_typeof(p_payload->'version') is distinct from 'number' then raise exception 'TEST_INVALID_INPUT';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||v_id,0));
  select * into v_test from public.teaching_tests where id=v_id for update;
  if not found or not exists(select 1 from public.teaching_courses c where c.id=v_test.course_id and c.owner_id=v_uid and c.archived_at is null)
    or not public.xelay_private_test_staff(v_test,v_uid,'assignments',true)
    or not public.xelay_private_test_staff(v_test,v_uid,'grades',true) then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  perform public.xelay_teaching_lock_course(v_test.course_id,'assignments');
  if(p_payload->>'version')::numeric is distinct from v_test.version::numeric then raise exception 'TEST_CONFLICT';end if;
  if v_test.status<>'published' or v_test.results_finalized_at is not null then raise exception 'TEST_IMMUTABLE';end if;
  v_now:=clock_timestamp();
  if exists(select 1 from public.teaching_test_attempts where test_id=v_id and status='in_progress' and expires_at>v_now) then
    raise exception 'TEST_ACTIVE_ATTEMPTS';end if;
  for v_attempt in select id from public.teaching_test_attempts where test_id=v_id and status='in_progress' order by id for update loop
    perform public.xelay_private_test_finish(v_attempt.id,v_now);
  end loop;
  if not exists(select 1 from public.teaching_test_attempts where test_id=v_id and status='submitted') then raise exception 'TEST_NO_SUBMITTED_ATTEMPTS';end if;
  update public.teaching_tests set status='closed',closed_early_at=v_now,closed_early_by=v_uid,version=version+1,updated_at=v_now where id=v_id;
  return public.xelay_teaching_test(v_id);
exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then
  raise exception 'TEST_INVALID_INPUT' using errcode='22023';
end $$;
revoke all on function public.xelay_private_test_view_before_close_20261105(public.teaching_tests,uuid,boolean),
  public.xelay_private_test_view(public.teaching_tests,uuid,boolean),
  public.xelay_private_test_mutate_before_close_20261105(text,jsonb),public.xelay_teaching_test_mutate(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_test_mutate(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
