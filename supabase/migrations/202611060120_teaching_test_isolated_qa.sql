-- A private, opt-in assessment workflow for the verified owner of the hidden QA group.
-- QA results do not use journal activities, ordinary grade rows or notifications.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.teaching_tests add column qa_own_attempt boolean not null default false;

create table public.teaching_test_qa_results (
  attempt_id uuid primary key references public.teaching_test_attempts(id) on delete cascade,
  score numeric not null check(score>=0),
  review_revision integer not null,
  published_at timestamptz not null
);
alter table public.teaching_test_qa_results enable row level security;
revoke all on public.teaching_test_qa_results from public,anon,authenticated,service_role;

create function public.xelay_private_test_qa_scope(p_test public.teaching_tests,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select coalesce(
    p_user='04f587f8-1604-4f53-aabc-d1699c938b1d'::uuid
    and p_test.created_by=p_user
    and p_test.targets->0->>'group_id'='437c96ae-19d1-4bed-ae69-0b83ae9ec1b4'
    and p_test.targets->0->>'audience_mode'='all'
    and coalesce(p_test.targets->0->'subgroup_ids','[]'::jsonb)='[]'::jsonb
    and case when jsonb_typeof(p_test.targets)='array' then jsonb_array_length(p_test.targets)=1 else false end
    and exists(
      select 1 from public.study_groups g
      join public.teaching_course_groups l on l.group_id=g.id and l.status='accepted'
      join public.teaching_courses c on c.id=l.course_id
      where g.id='437c96ae-19d1-4bed-ae69-0b83ae9ec1b4'::uuid
        and g.representative_id=p_user and c.id=p_test.course_id and c.owner_id=p_user and c.archived_at is null
    )
    and public.xelay_teaching_is_verified(p_user)
    and public.xelay_teaching_has_current_access(p_user),
    false
  );
$$;

-- Preserve ordinary membership, course and admission rules. The QA flag further
-- narrows both staff and student access to a single verified account.
alter function public.xelay_private_test_staff(public.teaching_tests,uuid,text,boolean)
  rename to xelay_private_test_staff_before_qa;
create function public.xelay_private_test_staff(p_test public.teaching_tests,p_user uuid,p_permission text,p_all boolean default false)
returns boolean language sql stable security definer set search_path='' as $$
  select (not p_test.qa_own_attempt or public.xelay_private_test_qa_scope(p_test,p_user))
    and public.xelay_private_test_staff_before_qa(p_test,p_user,p_permission,p_all);
$$;

alter function public.xelay_private_test_allows(public.teaching_tests,uuid,uuid)
  rename to xelay_private_test_allows_before_qa;
create function public.xelay_private_test_allows(p_test public.teaching_tests,p_user uuid,p_group uuid default null)
returns boolean language sql stable security definer set search_path='' as $$
  select (not p_test.qa_own_attempt or public.xelay_private_test_qa_scope(p_test,p_user))
    and public.xelay_private_test_allows_before_qa(p_test,p_user,p_group);
$$;

create function public.xelay_private_test_qa_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='UPDATE' and old.qa_own_attempt is distinct from new.qa_own_attempt then
    if old.status<>'draft' or not public.xelay_private_test_qa_scope(old,auth.uid()) then
      raise exception 'TEST_QA_FORBIDDEN' using errcode='42501';
    end if;
  end if;
  if new.qa_own_attempt then
    if not public.xelay_private_test_qa_scope(new,auth.uid()) or new.overrides<>'[]'::jsonb
      or exists(select 1 from public.teaching_test_activities a where a.test_id=new.id)
      or exists(select 1 from public.teaching_course_module_items m where m.resource_type='test' and m.resource_id=new.id) then
      raise exception 'TEST_QA_FORBIDDEN' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
create trigger teaching_test_qa_guard before insert or update on public.teaching_tests
  for each row execute function public.xelay_private_test_qa_guard();

create function public.xelay_private_test_qa_module_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.resource_type='test' then
    -- The test writer and module writer both take this course lock before
    -- checking one another, so neither can commit a conflicting change.
    perform 1 from public.teaching_courses where id=new.course_id for update;
    if exists(select 1 from public.teaching_tests t where t.id=new.resource_id and t.qa_own_attempt) then
      raise exception 'TEST_QA_FORBIDDEN' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
create trigger teaching_test_qa_module_guard before insert or update of resource_type,resource_id on public.teaching_course_module_items
  for each row execute function public.xelay_private_test_qa_module_guard();

-- These narrow changes leave the established locks, deadlines, answer
-- validation, scoring, review and permission checks in the ordinary engine.
-- SQL Editor can normalize the pasted file to CRLF, so normalize both sides.
do $patch$
declare v_target record;v_pair record;v_source text;v_anchor text;
begin
  for v_target in select * from (values
    ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)'),
    ('public.xelay_notify_test_center()'),
    ('public.xelay_private_teaching_course_modules_before_lectures(uuid)')
  )f(signature) loop
    v_source:=replace(pg_get_functiondef(v_target.signature::regprocedure),chr(13),'');
    for v_pair in select * from (values
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        'v_journal_date date;v_obsolete record;',
        'v_qa boolean;v_journal_date date;v_obsolete record;'),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        $old$perform public.xelay_teaching_lock_course(v_course,'assignments');
    if v_test.id is not null then$old$,
        $new$perform public.xelay_teaching_lock_course(v_course,'assignments');
    if p_payload?'qa_own_attempt' and jsonb_typeof(p_payload->'qa_own_attempt') is distinct from 'boolean' then
      raise exception 'TEST_INVALID_INPUT';
    end if;
    v_qa:=coalesce((p_payload->>'qa_own_attempt')::boolean,v_test.qa_own_attempt,false);
    if v_qa and not coalesce(v_test.qa_own_attempt,false) and p_payload->>'status' is distinct from 'draft' then
      raise exception 'TEST_QA_DRAFT_REQUIRED';
    end if;
    if v_test.id is not null then$new$),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        'question_timer_policy,restrict_copy,bonus_percent,bonus_points,targets,questions,created_by)',
        'question_timer_policy,restrict_copy,bonus_percent,bonus_points,targets,questions,created_by,qa_own_attempt)'),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        $old$(p_payload->>'bonus_percent')::integer,(p_payload->>'bonus_points')::numeric,p_payload->'targets',p_payload->'questions',v_uid)$old$,
        $new$(p_payload->>'bonus_percent')::integer,(p_payload->>'bonus_points')::numeric,p_payload->'targets',p_payload->'questions',v_uid,v_qa)$new$),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        'targets=excluded.targets,questions=excluded.questions,version=teaching_tests.version+1,updated_at=now();',
        'targets=excluded.targets,questions=excluded.questions,qa_own_attempt=excluded.qa_own_attempt,version=teaching_tests.version+1,updated_at=now();'),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        $old$if p_payload->>'status'<>'draft' or exists(select 1 from public.teaching_test_activities where test_id=v_id) then$old$,
        $new$if not v_qa and (p_payload->>'status'<>'draft' or exists(select 1 from public.teaching_test_activities where test_id=v_id)) then$new$),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        $old$if p_action in('finalize_results','review_results') then$old$,
        $new$if p_action in('finalize_results','review_results') then
    if p_action='review_results' and v_test.qa_own_attempt then raise exception 'TEST_QA_PUBLICATION_REQUIRED';end if;$new$),
      ('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)',
        $old$if v_test.created_by=v_uid or public.xelay_private_test_staff(v_test,v_uid,'assignments') or public.xelay_private_test_staff(v_test,v_uid,'grades') then$old$,
        $new$if (v_test.created_by=v_uid or public.xelay_private_test_staff(v_test,v_uid,'assignments') or public.xelay_private_test_staff(v_test,v_uid,'grades'))
    and not(v_test.qa_own_attempt and p_payload->'qa_internal_session' is not distinct from 'true'::jsonb
      and public.xelay_private_test_qa_scope(v_test,v_uid)) then$new$),
      ('public.xelay_notify_test_center()',
        $old$if new.status='draft' then return new;end if;$old$,
        $new$if new.qa_own_attempt or new.status='draft' then return new;end if;$new$),
      ('public.xelay_private_teaching_course_modules_before_lectures(uuid)',
        $old$from public.teaching_tests t where t.course_id=p_course_id and(v_owner$old$,
        $new$from public.teaching_tests t where t.course_id=p_course_id and not t.qa_own_attempt and(v_owner$new$)
    )p(signature,anchor,replacement) where p.signature=v_target.signature loop
      v_anchor:=replace(v_pair.anchor,chr(13),'');
      if (length(v_source)-length(replace(v_source,v_anchor,'')))/length(v_anchor)<>1 then
        raise exception 'TEST_QA_SOURCE_CHANGED: % / %',v_target.signature,left(v_pair.anchor,100);
      end if;
      v_source:=replace(v_source,v_anchor,replace(v_pair.replacement,chr(13),''));
    end loop;
    execute v_source;
  end loop;
end $patch$;

alter function public.xelay_private_test_view(public.teaching_tests,uuid,boolean) rename to xelay_private_test_view_before_qa;
create function public.xelay_private_test_view(p_test public.teaching_tests,p_user uuid,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_view jsonb;v_publication jsonb;v_scope boolean;
begin
  v_view:=public.xelay_private_test_view_before_qa(p_test,p_user,p_full);
  if p_full then
    v_scope:=public.xelay_private_test_qa_scope(p_test,p_user);
    v_view:=v_view||jsonb_build_object(
      'qa_can_enable',v_scope and p_test.status='draft' and p_test.overrides='[]'::jsonb
        and not exists(select 1 from public.teaching_test_activities a where a.test_id=p_test.id)
        and not exists(select 1 from public.teaching_course_module_items m where m.resource_type='test' and m.resource_id=p_test.id),
      'qa_can_start',v_scope and p_test.qa_own_attempt and p_test.status<>'draft'
    );
  end if;
  if p_test.qa_own_attempt and jsonb_typeof(v_view->'my_attempt')='object' and public.xelay_private_test_qa_scope(p_test,p_user) then
    select jsonb_build_object('published_score',r.score,'grade_published_at',r.published_at) into v_publication
      from public.teaching_test_qa_results r join public.teaching_test_attempts a on a.id=r.attempt_id
      where a.test_id=p_test.id and a.user_id=p_user and a.id=(v_view->'my_attempt'->>'id')::uuid;
    if v_publication is not null then
      v_view:=jsonb_set(v_view,'{my_attempt}',(v_view->'my_attempt')||v_publication);
    end if;
  end if;
  return v_view;
end $$;

alter function public.xelay_private_test_attempt_view(public.teaching_test_attempts,public.teaching_tests,boolean)
  rename to xelay_private_test_attempt_view_before_qa;
create function public.xelay_private_test_attempt_view(p_attempt public.teaching_test_attempts,p_test public.teaching_tests,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_view jsonb;v_publication jsonb;
begin
  v_view:=public.xelay_private_test_attempt_view_before_qa(p_attempt,p_test,p_full);
  if p_test.qa_own_attempt and public.xelay_private_test_qa_scope(p_test,p_attempt.user_id) then
    select jsonb_build_object('published_score',score,'grade_published_at',published_at) into v_publication
      from public.teaching_test_qa_results where attempt_id=p_attempt.id;
    if v_publication is not null then return v_view||v_publication;end if;
  end if;
  return v_view;
end $$;

alter function public.xelay_teaching_test_mutate(text,jsonb) rename to xelay_private_test_mutate_before_qa;
create function public.xelay_teaching_test_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid;v_test public.teaching_tests%rowtype;v_attempt public.teaching_test_attempts%rowtype;
  v_id uuid;v_now timestamptz;
begin
  if p_action is distinct from 'qa_publish' then
    -- The internal marker is never accepted on the normal student endpoint.
    return public.xelay_private_test_mutate_before_qa(p_action,
      case when jsonb_typeof(p_payload)='object' then p_payload-'qa_internal_session' else p_payload end);
  end if;
  v_uid:=public.xelay_teaching_assert_user();
  if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>2000
    or p_payload->>'expected_user_id' is distinct from v_uid::text
    or p_payload->'confirm_qa_publish' is distinct from 'true'::jsonb
    or jsonb_typeof(p_payload->'version') is distinct from 'number'
    or exists(select 1 from jsonb_object_keys(p_payload)k where k not in('id','expected_user_id','version','confirm_qa_publish')) then
    raise exception 'TEST_INVALID_INPUT';
  end if;
  v_id:=(p_payload->>'id')::uuid;
  if v_id is null then raise exception 'TEST_INVALID_INPUT';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||v_id,0));
  select * into v_test from public.teaching_tests where id=v_id for update;
  if not found or not v_test.qa_own_attempt or not public.xelay_private_test_qa_scope(v_test,v_uid)
    or not public.xelay_private_test_staff(v_test,v_uid,'grades',true) then
    raise exception 'TEST_QA_FORBIDDEN' using errcode='42501';
  end if;
  perform public.xelay_teaching_lock_course(v_test.course_id,'grades');
  if (p_payload->>'version')::numeric is distinct from v_test.version::numeric then raise exception 'TEST_CONFLICT';end if;
  if v_test.status<>'closed' or v_test.results_finalized_at is null or v_test.approved_revision is distinct from v_test.review_revision then
    raise exception 'TEST_REVIEW_REQUIRED';
  end if;
  select * into v_attempt from public.teaching_test_attempts a
    where a.test_id=v_id and a.user_id=v_uid and a.group_id='437c96ae-19d1-4bed-ae69-0b83ae9ec1b4'::uuid
      and a.status='submitted' and a.final_score is not null and a.grade_id is null
      and to_jsonb(a)->>'superseded_at' is null for update;
  if not found then raise exception 'TEST_NO_SUBMITTED_ATTEMPTS';end if;
  if exists(select 1 from public.teaching_test_qa_results r where r.attempt_id=v_attempt.id
    and r.review_revision=v_test.review_revision and r.score=v_attempt.final_score) then
    return public.xelay_teaching_test(v_id);
  end if;
  v_now:=clock_timestamp();
  insert into public.teaching_test_qa_results(attempt_id,score,review_revision,published_at)
    values(v_attempt.id,v_attempt.final_score,v_test.review_revision,v_now)
    on conflict(attempt_id) do update set score=excluded.score,review_revision=excluded.review_revision,published_at=excluded.published_at;
  update public.teaching_test_attempts set reviewed_at=v_now,version=version+1 where id=v_attempt.id;
  update public.teaching_tests set version=version+1,updated_at=v_now where id=v_id;
  return public.xelay_teaching_test(v_id);
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'TEST_INVALID_INPUT' using errcode='22023';
end $$;

-- Explicit student projection, even though the same UID is a verified teacher.
create function public.xelay_teaching_test_qa(p_action text,p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_test public.teaching_tests%rowtype;
  v_id uuid;v_detail jsonb;v_group uuid:='437c96ae-19d1-4bed-ae69-0b83ae9ec1b4';
begin
  if p_action is null or p_action not in('detail','start','save_answer','navigate','finish','record_tab_exit')
    or jsonb_typeof(p_payload) is distinct from 'object'
    or octet_length(p_payload::text)>(case when p_action='save_answer' then 500000 else 2000 end)
    or p_payload->>'expected_user_id' is distinct from v_uid::text then raise exception 'TEST_INVALID_INPUT';end if;
  v_id:=(p_payload->>'id')::uuid;
  if v_id is null then raise exception 'TEST_INVALID_INPUT';end if;
  select * into v_test from public.teaching_tests where id=v_id;
  if not found or not v_test.qa_own_attempt or v_test.status='draft' or not public.xelay_private_test_qa_scope(v_test,v_uid)
    or not public.xelay_private_test_allows(v_test,v_uid,v_group)
    or (p_action='start' and p_payload->>'group_id' is distinct from v_group::text) then
    raise exception 'TEST_QA_FORBIDDEN' using errcode='42501';
  end if;
  if p_action='detail' then
    v_detail:=public.xelay_teaching_test(v_id);
  elsif p_action='record_tab_exit' then
    v_detail:=public.xelay_private_test_mutate_before_qa(p_action,p_payload-'qa_internal_session');
  else
    v_detail:=public.xelay_private_test_mutate_before_qa(p_action,p_payload||jsonb_build_object('qa_internal_session',true));
  end if;
  -- Keep the code retry counter committed and return only its public error.
  if v_detail?'access_error' then return jsonb_build_object('access_error',v_detail->'access_error');end if;
  select * into v_test from public.teaching_tests where id=v_id;
  if not found or not v_test.qa_own_attempt or not public.xelay_private_test_qa_scope(v_test,v_uid) then
    raise exception 'TEST_QA_FORBIDDEN' using errcode='42501';
  end if;
  return jsonb_build_object(
    'test',public.xelay_private_test_view(v_test,v_uid,false)||jsonb_build_object('can_edit',false,'can_review',false,'can_close_early',false),
    'attempt',v_detail->'attempt','attempts','[]'::jsonb,'server_now',v_detail->'server_now'
  );
exception when invalid_text_representation or numeric_value_out_of_range then
  raise exception 'TEST_INVALID_INPUT' using errcode='22023';
end $$;

revoke all on function public.xelay_private_test_qa_scope(public.teaching_tests,uuid),
  public.xelay_private_test_staff_before_qa(public.teaching_tests,uuid,text,boolean),
  public.xelay_private_test_staff(public.teaching_tests,uuid,text,boolean),
  public.xelay_private_test_allows_before_qa(public.teaching_tests,uuid,uuid),
  public.xelay_private_test_allows(public.teaching_tests,uuid,uuid),
  public.xelay_private_test_qa_guard(),public.xelay_private_test_qa_module_guard(),
  public.xelay_private_test_view_before_qa(public.teaching_tests,uuid,boolean),
  public.xelay_private_test_view(public.teaching_tests,uuid,boolean),
  public.xelay_private_test_attempt_view_before_qa(public.teaching_test_attempts,public.teaching_tests,boolean),
  public.xelay_private_test_attempt_view(public.teaching_test_attempts,public.teaching_tests,boolean),
  public.xelay_private_test_mutate_before_qa(text,jsonb),public.xelay_teaching_test_mutate(text,jsonb),public.xelay_teaching_test_qa(text,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_test_mutate(text,jsonb),public.xelay_teaching_test_qa(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
