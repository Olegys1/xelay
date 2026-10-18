-- Real RPC/trigger workflow using disposable synthetic identities only.
-- Run as the SQL Editor database owner after teaching migrations 180004+005.
-- Existing admins are read-only fixtures; no Auth API, files or emails are sent.
-- Successful synthetic writes are rolled back inside the exception block;
-- any unexpected error aborts the outer transaction and cannot report success.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $qa$
declare
  v_marker text:='xelay-teaching-qa-'||gen_random_uuid()::text;
  v_teacher uuid:=gen_random_uuid();v_head uuid:=gen_random_uuid();
  v_student uuid:=gen_random_uuid();v_other uuid:=gen_random_uuid();
  v_university uuid:=gen_random_uuid();v_unit uuid:=gen_random_uuid();v_program uuid:=gen_random_uuid();
  v_request uuid:=gen_random_uuid();v_group uuid;v_course uuid:=gen_random_uuid();
  v_assignment uuid:=gen_random_uuid();v_submission uuid:=gen_random_uuid();
  v_admin uuid;v_teacher_request uuid;v_uid uuid;v_index integer;v_version integer;
  v_meta jsonb;v_result jsonb;v_visible jsonb;v_link uuid;v_completed boolean:=false;
begin
  select r.user_id into v_admin from public.user_roles r
    join public.profiles p on p.id=r.user_id join auth.users u on u.id=r.user_id
    where r.role='ADMIN' and u.deleted_at is null and u.email_confirmed_at is not null
      and (u.banned_until is null or u.banned_until<=now())
      and exists(select 1 from auth.mfa_factors f where f.user_id=r.user_id and f.status='verified' and f.factor_type='totp')
    order by r.user_id limit 1;
  if v_admin is null then raise exception 'QA_NEEDS_EXISTING_ADMIN_WITH_VERIFIED_TOTP'; end if;

  begin
    insert into public.universities(id,name,slug,is_active)
      values(v_university,'Synthetic QA university',v_marker,true);
    insert into public.academic_units(id,university_id,name,slug,unit_type,is_active)
      values(v_unit,v_university,'Synthetic QA faculty',v_marker,'faculty',true);
    insert into public.academic_specialties(id,university_id,academic_unit_id,code,specialty_name,name,is_active,study_levels)
      values(v_program,v_university,v_unit,'QA','Synthetic QA programme','Synthetic QA programme',true,array['bachelor']);

    -- All four profiles use the real registration, consent and academic triggers.
    for v_index in 1..4 loop
      v_uid:=case v_index when 1 then v_teacher when 2 then v_head when 3 then v_student else v_other end;
      v_meta:=jsonb_build_object('xelay_registration_version',1,'xelay_privacy_consent',true,
        'xelay_privacy_policy_version','2026-10-15.1','xelay_privacy_consent_version','2026-10-15.1',
        'full_name','Synthetic QA actor '||v_index,'username','tqa_'||left(replace(v_uid::text,'-',''),22),
        'country','Україна','city','Київ','bio','','university_id',v_university,'academic_unit_id',v_unit);
      v_meta:=v_meta||case when v_index=1 then jsonb_build_object('account_type','teacher','experience','',
        'categories','[]'::jsonb,'teacher_department','Synthetic QA department','teacher_position','Synthetic QA lecturer')
        else jsonb_build_object('account_type','student','experience','bachelor','study_year',1,
          'specialty_id',v_program,'categories',jsonb_build_array('General')) end;
      insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
        values(v_uid,v_marker||'-'||v_index||'@example.invalid',case when v_index=1 then null else now() end,v_meta);
    end loop;
    if (select count(*) from public.profiles where id in(v_teacher,v_head,v_student,v_other))<>4
      or (select account_type from public.profiles where id=v_teacher) is distinct from 'teacher' then
      raise exception 'QA_REGISTRATION_PROFILE_FAILED'; end if;
    select id into v_teacher_request from public.teacher_verification_requests where user_id=v_teacher and status='pending';
    if v_teacher_request is null then raise exception 'QA_PENDING_TEACHER_REQUEST_MISSING'; end if;
    update auth.users set email_confirmed_at=now() where id=v_teacher;

    execute 'set local role authenticated';
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_teacher,'role','authenticated','aal','aal1')::text,true);
    if (public.xelay_teacher_status()->>'verified')::boolean then raise exception 'QA_UNAPPROVED_TEACHER_VERIFIED'; end if;
    execute 'reset role';
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_admin,'role','authenticated','aal','aal2')::text,true);
    perform public.xelay_teaching_mutate('review_teacher',jsonb_build_object('request_id',v_teacher_request,'status','approved'));
    execute 'reset role';

    insert into public.class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,
      specialty,group_name,telegram_username,status,reviewed_by,reviewed_at)
      values(v_request,v_head,'Synthetic QA head',v_university,v_unit,'Synthetic QA programme',
        'Synthetic QA group','synthetic_qa_head','approved',v_admin,now());
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_head,'role','authenticated','aal','aal1')::text,true);
    v_group:=public.xelay_create_study_group(v_request);
    execute 'reset role';
    insert into public.study_group_members(group_id,user_id,invited_by,status,accepted_at)
      values(v_group,v_student,v_head,'accepted',now()),(v_group,v_other,v_head,'accepted',now());

    execute 'set local role authenticated';
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_teacher,'role','authenticated','aal','aal1')::text,true);
    if not (public.xelay_teacher_status()->>'verified')::boolean then raise exception 'QA_APPROVAL_FAILED'; end if;
    perform public.xelay_teaching_mutate('create_course',jsonb_build_object('id',v_course,'version',0,
      'title','Synthetic QA assessment','semester','Synthetic QA semester','starts_on',current_date-30,'ends_on',current_date+180));
    v_result:=public.xelay_teaching_mutate('invite_group',jsonb_build_object('course_id',v_course,'group_id',v_group));
    v_link:=(v_result->>'id')::uuid;
    if not exists(select 1 from jsonb_array_elements(public.xelay_teaching_workspace()->'pending_invites') i
      where i->>'id'=v_link::text and i->>'status'='pending_group') then raise exception 'QA_SENT_INVITATION_STATUS_FAILED'; end if;
    execute 'reset role';
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_head,'role','authenticated','aal','aal1')::text,true);
    perform public.xelay_teaching_mutate('respond_group',jsonb_build_object('link_id',v_link,'accept',true));
    execute 'reset role';

    execute 'set local role authenticated';
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_teacher,'role','authenticated','aal','aal1')::text,true);
    v_visible:=public.xelay_teaching_group_context(v_group);
    if (v_visible->'group'->>'study_year')::integer is distinct from 1 then raise exception 'QA_GROUP_IDENTITY_FAILED'; end if;
    perform public.xelay_classroom_mutate('save_group_assignment',jsonb_build_object('id',v_assignment,'version',0,
      'course_id',v_course,'title','Synthetic QA homework','body','Synthetic QA calculation',
      'links',jsonb_build_array('https://example.invalid/lecture'),
      'link_labels',jsonb_build_object('https://example.invalid/lecture','Лекція'),'attachments','[]'::jsonb,
      'targets',jsonb_build_array(jsonb_build_object('group_id',v_group,'due_at',now()+interval '7 days')),
      'status','published','max_points',10,'category',''));
    execute 'reset role';

    execute 'set local role authenticated';
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_student,'role','authenticated','aal','aal1')::text,true);
    v_visible:=public.xelay_classroom_assignment(v_assignment,v_group);
    if v_visible->'item'->'link_labels'->>'https://example.invalid/lecture' is distinct from 'Лекція' then
      raise exception 'QA_NAMED_LINK_FAILED'; end if;
    v_result:=public.xelay_classroom_mutate('reserve_submission',jsonb_build_object('id',v_submission,'item_id',v_assignment,'group_id',v_group));
    v_version:=(v_result->>'version')::integer;
    v_result:=public.xelay_classroom_mutate('save_submission',jsonb_build_object('id',v_submission,'item_id',v_assignment,
      'group_id',v_group,'version',v_version,'body','Synthetic QA initial answer','links','[]'::jsonb,'attachments','[]'::jsonb));
    v_version:=(v_result->>'version')::integer;
    v_result:=public.xelay_classroom_mutate('submit_submission',jsonb_build_object('id',v_submission,'version',v_version));
    v_version:=(v_result->>'version')::integer;
    execute 'reset role';
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_teacher,'role','authenticated','aal','aal1')::text,true);
    v_visible:=public.xelay_classroom_assignment(v_assignment,v_group);
    if not exists(select 1 from jsonb_array_elements(v_visible->'submissions') s where s->>'body'='Synthetic QA initial answer') then
      raise exception 'QA_TEACHER_SUBMISSION_READ_FAILED'; end if;
    v_result:=public.xelay_classroom_mutate('review_submission',jsonb_build_object('id',v_submission,
      'version',v_version,'status','returned','feedback','Synthetic QA: add a calculation'));
    v_version:=(v_result->>'version')::integer;
    execute 'reset role';

    execute 'set local role authenticated';
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_student,'role','authenticated','aal','aal1')::text,true);
    if public.xelay_classroom_assignment(v_assignment,v_group)->'my_submission'->>'status' is distinct from 'returned' then
      raise exception 'QA_RETURN_FEEDBACK_FAILED'; end if;
    v_result:=public.xelay_classroom_mutate('save_submission',jsonb_build_object('id',v_submission,'item_id',v_assignment,
      'group_id',v_group,'version',v_version,'body','Synthetic QA corrected answer','links','[]'::jsonb,'attachments','[]'::jsonb));
    v_version:=(v_result->>'version')::integer;
    v_result:=public.xelay_classroom_mutate('submit_submission',jsonb_build_object('id',v_submission,'version',v_version));
    v_version:=(v_result->>'version')::integer;
    execute 'reset role';
    execute 'set local role authenticated';
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_teacher,'role','authenticated','aal','aal1')::text,true);
    perform public.xelay_classroom_mutate('review_submission',jsonb_build_object('id',v_submission,'version',v_version,
      'status','reviewed','feedback','Synthetic QA accepted','score',9,'grade_version',0));
    execute 'reset role';

    execute 'set local role authenticated';
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_student,'role','authenticated','aal','aal1')::text,true);
    v_visible:=public.xelay_classroom_assignment(v_assignment,v_group);
    if v_visible->'my_submission'->>'status' is distinct from 'reviewed'
      or (v_visible->'my_submission'->>'published_score')::numeric is distinct from 9
      or (v_visible->'my_submission'->>'attempt')::integer is distinct from 2 then raise exception 'QA_PUBLISHED_RESULT_FAILED'; end if;
    if not exists(select 1 from jsonb_array_elements(public.xelay_teaching_group(v_group)->'grades') g
      where (g->>'published_score')::numeric=9) then raise exception 'QA_GROUP_GRADE_FAILED'; end if;
    execute 'reset role';
    for v_index in 1..2 loop
      v_uid:=case when v_index=1 then v_other else v_head end;
      execute 'set local role authenticated';
      perform set_config('request.jwt.claims',jsonb_build_object('sub',v_uid,'role','authenticated','aal','aal1')::text,true);
      v_visible:=public.xelay_classroom_assignment(v_assignment,v_group);
      if v_visible::text like '%Synthetic QA corrected answer%' or v_visible::text like '%Synthetic QA accepted%'
        or jsonb_array_length(v_visible->'submissions')<>0 then raise exception 'QA_OTHER_STUDENT_PRIVACY_FAILED'; end if;
      if exists(select 1 from jsonb_array_elements(public.xelay_teaching_group(v_group)->'grades') g
        where (g->>'published_score')::numeric=9) then raise exception 'QA_OTHER_GRADE_PRIVACY_FAILED'; end if;
      execute 'reset role';
    end loop;

    -- This is the only caught exception. It rolls back every synthetic write,
    -- including notifications/outbox rows targeting existing administrators.
    raise exception 'XELAY_TEACHING_QA_ROLLBACK_SUCCESS' using errcode='ZQ001';
  exception when sqlstate 'ZQ001' then
    if sqlerrm<>'XELAY_TEACHING_QA_ROLLBACK_SUCCESS' then raise; end if;
    v_completed:=true;
  end;
  if not v_completed then raise exception 'QA_WORKFLOW_NOT_COMPLETED'; end if;
  if exists(select 1 from auth.users where id in(v_teacher,v_head,v_student,v_other) or email like v_marker||'%')
    or exists(select 1 from public.profiles where id in(v_teacher,v_head,v_student,v_other))
    or exists(select 1 from public.teacher_verification_requests where user_id=v_teacher)
    or exists(select 1 from public.universities where id=v_university)
    or exists(select 1 from public.academic_units where id=v_unit)
    or exists(select 1 from public.academic_specialties where id=v_program)
    or exists(select 1 from public.class_representative_requests where id=v_request)
    or exists(select 1 from public.study_groups where id=v_group)
    or exists(select 1 from public.teaching_courses where id=v_course)
    or exists(select 1 from public.teaching_items where id=v_assignment)
    or exists(select 1 from public.teaching_submissions where id=v_submission)
    or exists(select 1 from public.notifications where teaching_course_id=v_course or actor_id::text=v_teacher::text) then
    raise exception 'QA_SYNTHETIC_ROWS_NOT_ROLLED_BACK'; end if;
  perform set_config('xelay.teaching_workflow_qa','passed',true);
  perform set_config('xelay.teaching_workflow_qa_clean','true',true);
end $qa$;

select current_setting('xelay.teaching_workflow_qa',true)='passed' as passed,
  current_setting('xelay.teaching_workflow_qa_clean',true)='true' as no_test_rows;
rollback;
