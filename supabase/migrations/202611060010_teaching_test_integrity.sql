-- Access codes stay outside test definitions. A recorded second tab exit
-- submits the student's saved answers through the ordinary attempt finalizer.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.teaching_tests
  add column require_access_code boolean not null default false,
  add column restrict_tab_switch boolean not null default false,
  add column discourage_capture boolean not null default false;

alter table public.teaching_test_attempts
  add column tab_exit_events uuid[] not null default '{}',
  add column completion_reason text,
  add constraint teaching_test_tab_completion check (
    (cardinality(tab_exit_events)<2 and completion_reason is null)
    or (cardinality(tab_exit_events)=2 and completion_reason is not distinct from 'tab_switch' and status='submitted')
  );

create table public.teaching_test_access_codes (
  test_id uuid primary key references public.teaching_tests(id) on delete cascade,
  current_code text not null check (current_code~'^[0-9A-F]{8}$'),
  previous_code text check (previous_code~'^[0-9A-F]{8}$' and previous_code<>current_code),
  rotated_at timestamptz not null
);
create table public.teaching_test_code_attempts (
  test_id uuid not null references public.teaching_tests(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  window_started_at timestamptz not null,
  failures integer not null check (failures between 1 and 5),
  primary key (test_id,user_id)
);
alter table public.teaching_test_access_codes enable row level security;
alter table public.teaching_test_code_attempts enable row level security;
revoke all on public.teaching_test_access_codes,public.teaching_test_code_attempts from public,anon,authenticated,service_role;

-- All calls to the code helpers run under the same per-test lock as start.
create function public.xelay_private_test_rotate_access_code(p_test_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_current text; v_previous text; v_new text;
begin
  select current_code,previous_code into v_current,v_previous from public.teaching_test_access_codes where test_id=p_test_id;
  loop
    v_new:=upper(left(gen_random_uuid()::text,8));
    exit when v_new is distinct from v_current and v_new is distinct from v_previous;
  end loop;
  insert into public.teaching_test_access_codes(test_id,current_code,previous_code,rotated_at)
  values(p_test_id,v_new,v_current,clock_timestamp())
  on conflict(test_id) do update set current_code=excluded.current_code,previous_code=excluded.previous_code,rotated_at=excluded.rotated_at;
end $$;

create function public.xelay_private_test_check_access_code(p_test_id uuid,p_user_id uuid,p_code jsonb,p_now timestamptz)
returns text language plpgsql security definer set search_path='' as $$
declare v_current text; v_candidate text; v_window public.teaching_test_code_attempts%rowtype;
begin
  select current_code into v_current from public.teaching_test_access_codes where test_id=p_test_id;
  if not found then return 'TEST_CODE_UNAVAILABLE';end if;
  select * into v_window from public.teaching_test_code_attempts where test_id=p_test_id and user_id=p_user_id;
  if v_window.failures>=5 and v_window.window_started_at>p_now-interval '1 minute' then return 'TEST_CODE_RATE_LIMITED';end if;
  if jsonb_typeof(p_code) is distinct from 'string' then return 'TEST_CODE_INVALID';end if;
  v_candidate:=upper(btrim(p_code#>>'{}'));
  if v_candidate !~ '^[0-9A-F]{8}$' then return 'TEST_CODE_INVALID';end if;
  if v_candidate=v_current then
    delete from public.teaching_test_code_attempts where test_id=p_test_id and user_id=p_user_id;
    return null;
  end if;
  insert into public.teaching_test_code_attempts(test_id,user_id,window_started_at,failures) values(p_test_id,p_user_id,p_now,1)
  on conflict(test_id,user_id) do update set
    window_started_at=case when teaching_test_code_attempts.window_started_at<=p_now-interval '1 minute' then p_now else teaching_test_code_attempts.window_started_at end,
    failures=case when teaching_test_code_attempts.window_started_at<=p_now-interval '1 minute' then 1 else teaching_test_code_attempts.failures+1 end;
  return 'TEST_CODE_INVALID';
end $$;

-- Insert the check after every existing authorization and availability check,
-- but before a new attempt can freeze questions. Resuming never needs a code.
do $patch$
declare v_source text; v_anchor text:='v_attempt_id:=gen_random_uuid();v_variant:=public.xelay_private_assessment_snapshot(v_test,v_attempt_id);';
begin
  v_source:=pg_get_functiondef('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)'::regprocedure);
  if (length(v_source)-length(replace(v_source,v_anchor,'')))/length(v_anchor)<>1 then raise exception 'TEST_INTEGRITY_START_SOURCE_CHANGED';end if;
  execute replace(v_source,v_anchor,$start$
    if v_test.require_access_code then
      v_result:=to_jsonb(public.xelay_private_test_check_access_code(v_id,v_uid,p_payload->'access_code',v_now));
      -- Returning the error instead of throwing commits the rate counter.
      if v_result is not null then return jsonb_build_object('access_error',v_result);end if;
    end if;
    $start$||v_anchor);
end $patch$;

alter function public.xelay_private_test_attempt_view(public.teaching_test_attempts,public.teaching_tests,boolean)
  rename to xelay_private_test_attempt_view_before_integrity_20261106;
create function public.xelay_private_test_attempt_view(p_attempt public.teaching_test_attempts,p_test public.teaching_tests,p_full boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select (public.xelay_private_test_attempt_view_before_integrity_20261106(p_attempt,p_test,p_full)-'tab_exit_events')
    ||jsonb_build_object('tab_exit_count',cardinality(p_attempt.tab_exit_events));
$$;

alter function public.xelay_private_test_view(public.teaching_tests,uuid,boolean)
  rename to xelay_private_test_view_before_integrity_20261106;
create function public.xelay_private_test_view(p_test public.teaching_tests,p_user uuid,p_full boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select public.xelay_private_test_view_before_integrity_20261106(p_test,p_user,p_full)
    ||jsonb_build_object('require_access_code',p_test.require_access_code,'restrict_tab_switch',p_test.restrict_tab_switch,
      'discourage_capture',p_test.discourage_capture);
$$;

alter function public.xelay_teaching_test_mutate(text,jsonb) rename to xelay_private_test_mutate_before_integrity_20261106;
create function public.xelay_teaching_test_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid; v_id uuid; v_test public.teaching_tests%rowtype; v_result jsonb;
  v_codes public.teaching_test_access_codes%rowtype; v_attempt public.teaching_test_attempts%rowtype;
  v_event uuid; v_now timestamptz; v_flags text[]:=array['require_access_code','restrict_tab_switch','discourage_capture'];
begin
  if p_action is null then raise exception 'TEST_INVALID_INPUT';end if;
  if p_action not in('save_test','read_access_code','rotate_access_code','record_tab_exit')
    or (p_action='save_test' and not coalesce(p_payload?|v_flags,false)) then
    return public.xelay_private_test_mutate_before_integrity_20261106(p_action,p_payload);
  end if;
  v_uid:=public.xelay_teaching_assert_user();
  if jsonb_typeof(p_payload) is distinct from 'object'
    or octet_length(p_payload::text)>(case when p_action='save_test' then 500000 else 2000 end)
    or (p_action<>'save_test' and (p_payload->>'expected_user_id' is distinct from v_uid::text
      or exists(select 1 from jsonb_object_keys(p_payload)k where k not in('id','expected_user_id')
        and not (p_action='record_tab_exit' and k in('attempt_id','event_id'))))) then raise exception 'TEST_INVALID_INPUT';end if;
  v_id:=(p_payload->>'id')::uuid;
  if v_id is null then raise exception 'TEST_INVALID_INPUT';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||v_id,0));
  select * into v_test from public.teaching_tests where id=v_id for update;

  if p_action='save_test' then
    if exists(select 1 from unnest(v_flags)f where p_payload?f and jsonb_typeof(p_payload->f) is distinct from 'boolean') then
      raise exception 'TEST_INVALID_INPUT';end if;
    v_result:=public.xelay_private_test_mutate_before_integrity_20261106(p_action,p_payload-v_flags);
    update public.teaching_tests set require_access_code=coalesce((p_payload->>'require_access_code')::boolean,require_access_code),
      restrict_tab_switch=coalesce((p_payload->>'restrict_tab_switch')::boolean,restrict_tab_switch),
      discourage_capture=coalesce((p_payload->>'discourage_capture')::boolean,discourage_capture)
    where id=v_id
    returning * into v_test;
    if v_test.require_access_code and not exists(select 1 from public.teaching_test_access_codes where test_id=v_id) then
      perform public.xelay_private_test_rotate_access_code(v_id);
    elsif not v_test.require_access_code then
      delete from public.teaching_test_access_codes where test_id=v_id;
      delete from public.teaching_test_code_attempts where test_id=v_id;
    end if;
    return v_result||jsonb_build_object('test',(v_result->'test')||jsonb_build_object('require_access_code',v_test.require_access_code,
      'restrict_tab_switch',v_test.restrict_tab_switch,'discourage_capture',v_test.discourage_capture));
  end if;

  if v_test.id is null then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  if p_action in('read_access_code','rotate_access_code') then
    if not public.xelay_private_test_staff(v_test,v_uid,'assignments',true)
      or not public.xelay_private_test_staff(v_test,v_uid,'grades',true) then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
    if p_action='rotate_access_code' then
      perform public.xelay_teaching_lock_course(v_test.course_id,'assignments');
      if not public.xelay_private_test_staff(v_test,v_uid,'assignments',true)
        or not public.xelay_private_test_staff(v_test,v_uid,'grades',true) then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
      if not v_test.require_access_code or v_test.status='closed' then raise exception 'TEST_IMMUTABLE';end if;
      perform public.xelay_private_test_rotate_access_code(v_id);
    end if;
    select * into v_codes from public.teaching_test_access_codes where test_id=v_id;
    return public.xelay_teaching_test(v_id)||jsonb_build_object('access_code',jsonb_build_object(
      'current',v_codes.current_code,'previous',v_codes.previous_code,'rotated_at',v_codes.rotated_at));
  end if;

  v_event:=(p_payload->>'event_id')::uuid;
  if v_event is null or p_payload->>'attempt_id' is null then raise exception 'TEST_INVALID_INPUT';end if;
  select * into v_attempt from public.teaching_test_attempts
  where id=(p_payload->>'attempt_id')::uuid and test_id=v_id and user_id=v_uid for update;
  if not found or v_test.status='draft' or not public.xelay_private_test_allows(v_test,v_uid,v_attempt.group_id) then
    raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  v_now:=clock_timestamp();
  if v_test.restrict_tab_switch and v_attempt.status='in_progress' and v_attempt.expires_at>v_now
    and not(v_event=any(v_attempt.tab_exit_events)) then
    if cardinality(v_attempt.tab_exit_events)=1 then
      perform public.xelay_private_test_finish(v_attempt.id,v_now);
      update public.teaching_test_attempts set tab_exit_events=array_append(tab_exit_events,v_event),completion_reason='tab_switch' where id=v_attempt.id;
    else
      update public.teaching_test_attempts set tab_exit_events=array_append(tab_exit_events,v_event) where id=v_attempt.id;
    end if;
  end if;
  return public.xelay_teaching_test(v_id);
exception when invalid_text_representation or numeric_value_out_of_range or invalid_parameter_value then
  raise exception 'TEST_INVALID_INPUT' using errcode='22023';
end $$;

revoke all on function public.xelay_private_test_rotate_access_code(uuid),public.xelay_private_test_check_access_code(uuid,uuid,jsonb,timestamptz),
  public.xelay_private_test_attempt_view_before_integrity_20261106(public.teaching_test_attempts,public.teaching_tests,boolean),
  public.xelay_private_test_attempt_view(public.teaching_test_attempts,public.teaching_tests,boolean),
  public.xelay_private_test_view_before_integrity_20261106(public.teaching_tests,uuid,boolean),
  public.xelay_private_test_view(public.teaching_tests,uuid,boolean),
  public.xelay_private_test_mutate_before_integrity_20261106(text,jsonb),public.xelay_teaching_test_mutate(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_test_mutate(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
