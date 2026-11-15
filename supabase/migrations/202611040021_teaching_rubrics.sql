-- Criterion-based assessment stays private until the existing journal publishes it.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

create function public.xelay_private_rubric_valid(p_rubric jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare c jsonb;l jsonb;v_cap numeric:=0;
begin
  if p_rubric is null or p_rubric='null'::jsonb then return true;end if;
  if jsonb_typeof(p_rubric)<>'object' or jsonb_typeof(p_rubric->'criteria') is distinct from 'array'
    or jsonb_array_length(p_rubric->'criteria') not between 1 and 20 then return false;end if;
  if(select count(distinct x->>'id') from jsonb_array_elements(p_rubric->'criteria')x)<>jsonb_array_length(p_rubric->'criteria') then return false;end if;
  for c in select value from jsonb_array_elements(p_rubric->'criteria') loop
    if coalesce(c->>'id','') !~ '^[A-Za-z0-9_-]{1,64}$' or length(btrim(coalesce(c->>'title',''))) not between 1 and 200
      or jsonb_typeof(c->'levels') is distinct from 'array' or jsonb_array_length(c->'levels') not between 2 and 10 then return false;end if;
    if(select count(distinct x->>'id') from jsonb_array_elements(c->'levels')x)<>jsonb_array_length(c->'levels') then return false;end if;
    for l in select value from jsonb_array_elements(c->'levels') loop
      if coalesce(l->>'id','') !~ '^[A-Za-z0-9_-]{1,64}$' or length(btrim(coalesce(l->>'label',''))) not between 1 and 300
        or jsonb_typeof(l->'points') is distinct from 'number' or(l->>'points')::numeric not between 0 and 10000 or scale((l->>'points')::numeric)>2 then return false;end if;
    end loop;
    if(select max((x->>'points')::numeric) from jsonb_array_elements(c->'levels')x)<=0 then return false;end if;
    v_cap:=v_cap+(select max((x->>'points')::numeric) from jsonb_array_elements(c->'levels')x);
  end loop;
  return v_cap>0;
exception when others then return false;
end $$;

create function public.xelay_private_rubric_score(p_rubric jsonb,p_levels jsonb,p_max numeric)
returns numeric language plpgsql immutable set search_path='' as $$
declare c jsonb;l jsonb;v_total numeric:=0;v_cap numeric:=0;
begin
  if p_rubric is null or p_rubric='null'::jsonb or not public.xelay_private_rubric_valid(p_rubric)
    or jsonb_typeof(p_levels) is distinct from 'object' or p_max<=0 or p_max>10000
    or exists(select 1 from jsonb_each(p_levels)x where jsonb_typeof(x.value)<>'string')
    or(select count(*) from jsonb_object_keys(p_levels))<>jsonb_array_length(p_rubric->'criteria') then raise exception 'RUBRIC_INVALID_INPUT';end if;
  for c in select value from jsonb_array_elements(p_rubric->'criteria') loop
    select x into l from jsonb_array_elements(c->'levels')x where x->>'id'=p_levels->>(c->>'id');
    if l is null then raise exception 'RUBRIC_INVALID_INPUT';end if;
    v_total:=v_total+(l->>'points')::numeric;
    v_cap:=v_cap+(select max((x->>'points')::numeric) from jsonb_array_elements(c->'levels')x);
  end loop;
  return round(p_max*v_total/v_cap,2);
end $$;

create table public.teaching_assignment_rubrics(
  item_id uuid primary key references public.teaching_items(id) on delete cascade,
  rubric jsonb not null check(public.xelay_private_rubric_valid(rubric)),version integer not null default 1,
  updated_by uuid not null references public.profiles(id),updated_at timestamptz not null default clock_timestamp()
);
create table public.teaching_rubric_marks(
  id uuid primary key default gen_random_uuid(),submission_id uuid not null unique references public.teaching_submissions(id) on delete cascade,
  submission_attempt integer not null,
  grade_id uuid not null references public.teaching_grades(id) on delete cascade,
  rubric jsonb not null,levels jsonb not null,score numeric(8,2) not null,maximum numeric(8,2) not null,
  feedback text not null default '',version integer not null default 1,
  updated_by uuid not null references public.profiles(id),updated_at timestamptz not null default clock_timestamp()
);
create table public.teaching_rubric_mark_audit(
  id uuid primary key default gen_random_uuid(),mark_id uuid not null references public.teaching_rubric_marks(id) on delete cascade,
  actor_id uuid not null references public.profiles(id),old_value jsonb,new_value jsonb not null,created_at timestamptz not null default clock_timestamp()
);
create table public.teaching_test_rubric_audit(
  id uuid primary key default gen_random_uuid(),attempt_id uuid not null references public.teaching_test_attempts(id) on delete cascade,
  question_id text not null,actor_id uuid not null references public.profiles(id),old_levels jsonb,new_levels jsonb not null,
  created_at timestamptz not null default clock_timestamp()
);
alter table public.teaching_assignment_rubrics enable row level security;
alter table public.teaching_rubric_marks enable row level security;
alter table public.teaching_rubric_mark_audit enable row level security;
alter table public.teaching_test_rubric_audit enable row level security;
revoke all on public.teaching_assignment_rubrics,public.teaching_rubric_marks,public.teaching_rubric_mark_audit,public.teaching_test_rubric_audit from public,anon,authenticated,service_role;

-- Apply rubric validation equally to bank imports and test definitions.
alter function public.xelay_private_test_validate_question(jsonb) rename to xelay_private_test_validate_question_before_rubrics;
create function public.xelay_private_test_validate_question(p_question jsonb)
returns boolean language sql immutable set search_path='' as $$
  select public.xelay_private_test_validate_question_before_rubrics(p_question) and public.xelay_private_rubric_valid(p_question->'rubric');
$$;

create function public.xelay_teaching_rubric(p_assignment_id uuid,p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_item public.teaching_items%rowtype;v_config public.teaching_assignment_rubrics%rowtype;
  v_perms text[];v_staff boolean;v_edit boolean;
begin
  select * into v_item from public.teaching_items where id=p_assignment_id and kind='assignment';
  if not found or not exists(select 1 from public.teaching_item_targets where item_id=v_item.id and group_id=p_group_id) then raise exception 'RUBRIC_FORBIDDEN' using errcode='42501';end if;
  v_perms:=public.xelay_teaching_group_permissions(v_item.course_id,p_group_id,v_uid);
  v_staff:='grades'=any(v_perms) or 'assignments'=any(v_perms);
  if not v_staff and not public.xelay_classroom_student(v_item.id,p_group_id,v_uid) then raise exception 'RUBRIC_FORBIDDEN' using errcode='42501';end if;
  select * into v_config from public.teaching_assignment_rubrics where item_id=v_item.id;
  v_edit:=v_staff and not exists(select 1 from public.teaching_item_targets t where t.item_id=v_item.id and not 'assignments'=any(public.xelay_teaching_group_permissions(v_item.course_id,t.group_id,v_uid)))
    and not exists(select 1 from public.teaching_courses where id=v_item.course_id and archived_at is not null);
  return jsonb_build_object('rubric',v_config.rubric,'version',coalesce(v_config.version,0),'can_edit',v_edit,'can_grade','grades'=any(v_perms),
    'marks',coalesce((select jsonb_agg(to_jsonb(m)-array['updated_by','grade_id']) from public.teaching_rubric_marks m
      join public.teaching_submissions s on s.id=m.submission_id join public.teaching_grades g on g.id=m.grade_id
      where s.item_id=v_item.id and s.group_id=p_group_id and('grades'=any(v_perms)
        or s.user_id=v_uid and s.attempt=m.submission_attempt and g.published_at>=m.updated_at and g.published_score=m.score and not coalesce((to_jsonb(g)->>'published_absent')::boolean,false))),'[]'::jsonb));
end $$;

create function public.xelay_teaching_rubric_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_item public.teaching_items%rowtype;v_config public.teaching_assignment_rubrics%rowtype;
  v_submission public.teaching_submissions%rowtype;v_mark public.teaching_rubric_marks%rowtype;v_old jsonb;v_group uuid:=(p_payload->>'group_id')::uuid;
  v_activity public.teaching_activities%rowtype;v_entry public.teaching_entries%rowtype;v_grade public.teaching_grades%rowtype;v_score numeric;v_response jsonb;v_feedback text:=btrim(coalesce(p_payload->>'feedback',''));
begin
  if p_payload->>'expected_user_id' is distinct from v_uid::text then raise exception 'RUBRIC_FORBIDDEN' using errcode='42501';end if;
  select * into v_item from public.teaching_items where id=(p_payload->>'assignment_id')::uuid and kind='assignment';
  if not found or not exists(select 1 from public.teaching_item_targets where item_id=v_item.id and group_id=v_group) then raise exception 'RUBRIC_FORBIDDEN' using errcode='42501';end if;
  if p_action not in('save_rubric','assess_submission') then raise exception 'RUBRIC_INVALID_INPUT';end if;
  perform public.xelay_private_assert_teaching_group(v_item.course_id,v_group,case when p_action='save_rubric' then 'assignments' else 'grades' end);
  select * into v_item from public.teaching_items where id=v_item.id for update;
  select * into v_config from public.teaching_assignment_rubrics where item_id=v_item.id for update;
  if p_action='save_rubric' then
    perform public.xelay_private_assert_teaching_group(v_item.course_id,v_group,'assignments');
    if exists(select 1 from public.teaching_item_targets t where t.item_id=v_item.id and not 'assignments'=any(public.xelay_teaching_group_permissions(v_item.course_id,t.group_id,v_uid))) then raise exception 'RUBRIC_FORBIDDEN' using errcode='42501';end if;
    if(p_payload->>'version')::integer is distinct from coalesce(v_config.version,0) then raise exception 'RUBRIC_CONFLICT';end if;
    if exists(select 1 from public.teaching_rubric_marks m join public.teaching_submissions s on s.id=m.submission_id where s.item_id=v_item.id) then raise exception 'RUBRIC_LOCKED';end if;
    if not public.xelay_private_rubric_valid(p_payload->'rubric') or v_item.max_points is null then raise exception 'RUBRIC_INVALID_INPUT';end if;
    insert into public.teaching_assignment_rubrics(item_id,rubric,updated_by) values(v_item.id,coalesce(p_payload->'rubric','null'::jsonb),v_uid)
      on conflict(item_id) do update set rubric=excluded.rubric,updated_by=v_uid,updated_at=clock_timestamp(),version=teaching_assignment_rubrics.version+1;
  elsif p_action='assess_submission' then
    perform public.xelay_private_assert_teaching_group(v_item.course_id,v_group,'grades');
    if(p_payload->>'rubric_version')::integer is distinct from v_config.version or v_config.rubric is null or v_config.rubric='null'::jsonb then raise exception 'RUBRIC_CONFLICT';end if;
    select * into v_submission from public.teaching_submissions where id=(p_payload->>'submission_id')::uuid and item_id=v_item.id and group_id=v_group for update;
    if not found or v_submission.status not in('submitted','reviewed') or (to_jsonb(v_submission)->>'team_id') is not null then raise exception 'RUBRIC_INVALID_INPUT';end if;
    if v_submission.version is distinct from(p_payload->>'submission_version')::integer then raise exception 'RUBRIC_CONFLICT';end if;
    if not public.xelay_teaching_is_member(v_group,v_submission.user_id) then raise exception 'RUBRIC_FORBIDDEN' using errcode='42501';end if;
    select * into v_mark from public.teaching_rubric_marks where submission_id=v_submission.id for update;
    if coalesce(v_mark.version,0) is distinct from(p_payload->>'version')::integer then raise exception 'RUBRIC_CONFLICT';end if;
    if length(v_feedback)>2000 or length(btrim(coalesce(p_payload->>'reason',''))) not between 2 and 2000 then raise exception 'RUBRIC_INVALID_INPUT';end if;
    v_score:=public.xelay_private_rubric_score(v_config.rubric,p_payload->'levels',v_item.max_points);
    select * into v_activity from public.teaching_activities where item_id=v_item.id and group_id=v_group;
    select * into v_entry from public.teaching_entries where course_id=v_item.course_id and group_id=v_group and user_id=v_submission.user_id and active;
    if v_activity.id is null or v_entry.id is null then raise exception 'RUBRIC_FORBIDDEN' using errcode='42501';end if;
    perform public.xelay_teaching_mutate('save_grade',jsonb_build_object('activity_id',v_activity.id,'entry_id',v_entry.id,'version',(p_payload->>'grade_version')::integer,
      'score',v_score,'comment',v_feedback,'reason',p_payload->>'reason','expected_user_id',v_uid));
    select * into v_grade from public.teaching_grades where activity_id=v_activity.id and entry_id=v_entry.id;
    v_old:=case when v_mark.id is null then null else to_jsonb(v_mark) end;
    insert into public.teaching_rubric_marks(submission_id,submission_attempt,grade_id,rubric,levels,score,maximum,feedback,updated_by)
      values(v_submission.id,v_submission.attempt,v_grade.id,v_config.rubric,p_payload->'levels',v_score,v_item.max_points,v_feedback,v_uid)
      on conflict(submission_id) do update set rubric=excluded.rubric,levels=excluded.levels,score=excluded.score,maximum=excluded.maximum,feedback=excluded.feedback,
        submission_attempt=excluded.submission_attempt,grade_id=excluded.grade_id,updated_by=v_uid,updated_at=clock_timestamp(),version=teaching_rubric_marks.version+1 returning * into v_mark;
    insert into public.teaching_rubric_mark_audit(mark_id,actor_id,old_value,new_value) values(v_mark.id,v_uid,v_old,to_jsonb(v_mark));
  else raise exception 'RUBRIC_INVALID_INPUT';end if;
  return public.xelay_teaching_rubric(v_item.id,v_group);
end $$;

-- A selected rubric level, rather than a client-supplied score, is authoritative.
alter function public.xelay_teaching_test_mutate(text,jsonb) rename to xelay_teaching_test_mutate_before_rubrics;
create function public.xelay_teaching_test_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_attempt public.teaching_test_attempts%rowtype;v_test public.teaching_tests%rowtype;
  v_mark jsonb;v_question jsonb;v_marks jsonb:='[]';v_result jsonb;v_levels jsonb;v_question_id text;v_points numeric;v_rubric_changed boolean:=false;
begin
  if p_action<>'save_review' then return public.xelay_teaching_test_mutate_before_rubrics(p_action,p_payload);end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||(p_payload->>'id'),0));
  select * into v_test from public.teaching_tests where id=(p_payload->>'id')::uuid for update;
  select * into v_attempt from public.teaching_test_attempts where id=(p_payload->>'attempt_id')::uuid and test_id=v_test.id for update;
  if v_attempt.id is null then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  perform public.xelay_private_assert_teaching_group(v_test.course_id,v_attempt.group_id,'grades');
  if jsonb_typeof(p_payload->'marks') is distinct from 'array' then raise exception 'TEST_INVALID_INPUT';end if;
  for v_mark in select value from jsonb_array_elements(p_payload->'marks') loop
    select q into v_question from jsonb_array_elements(coalesce(v_attempt.questions,v_test.questions))q where q->>'id'=v_mark->>'question_id';
    if v_question->'rubric' is not null and v_question->'rubric'<>'null'::jsonb then
      v_points:=public.xelay_private_rubric_score(v_question->'rubric',v_mark->'rubric_levels',(v_question->>'points')::numeric);
      v_mark:=v_mark||jsonb_build_object('mode','custom','points',v_points);
    end if;
    v_marks:=v_marks||jsonb_build_array(v_mark);
  end loop;
  v_result:=public.xelay_teaching_test_mutate_before_rubrics(p_action,p_payload||jsonb_build_object('marks',v_marks));
  for v_mark in select value from jsonb_array_elements(v_marks) loop
    v_question_id:=v_mark->>'question_id';
    select q into v_question from jsonb_array_elements(coalesce(v_attempt.questions,v_test.questions))q where q->>'id'=v_question_id;
    if v_question->'rubric' is not null and v_question->'rubric'<>'null'::jsonb then
      if v_attempt.question_reviews->v_question_id->'rubric_levels' is distinct from v_mark->'rubric_levels' then
        v_rubric_changed:=true;
        insert into public.teaching_test_rubric_audit(attempt_id,question_id,actor_id,old_levels,new_levels)
          values(v_attempt.id,v_question_id,v_uid,v_attempt.question_reviews->v_question_id->'rubric_levels',v_mark->'rubric_levels');
      end if;
      update public.teaching_test_attempts set question_reviews=jsonb_set(question_reviews,array[v_question_id,'rubric_levels'],v_mark->'rubric_levels') where id=v_attempt.id;
    end if;
  end loop;
  if v_rubric_changed and exists(select 1 from public.teaching_tests where id=v_test.id and version=v_test.version) then
    update public.teaching_test_attempts set version=version+1 where id=v_attempt.id;
    update public.teaching_test_attempts set final_score=null,bonus_score=0,rank=null,bonus_winner=false,reviewed_at=null,version=version+1
      where test_id=v_test.id and(final_score is not null or bonus_score<>0 or rank is not null or bonus_winner or reviewed_at is not null);
    update public.teaching_tests set review_revision=review_revision+1,approved_revision=null,results_finalized_at=null,version=version+1,updated_at=clock_timestamp() where id=v_test.id;
  end if;
  return public.xelay_teaching_test(v_test.id);
end $$;

-- Teacher views expose level selections; student views keep all provisional marks private.
alter function public.xelay_private_test_attempt_view(public.teaching_test_attempts,public.teaching_tests,boolean) rename to xelay_private_test_attempt_view_before_rubrics;
create function public.xelay_private_test_attempt_view(p_attempt public.teaching_test_attempts,p_test public.teaching_tests,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;v_results jsonb;
begin
  v_result:=public.xelay_private_test_attempt_view_before_rubrics(p_attempt,p_test,p_full);
  if p_full then
    select jsonb_agg(r||jsonb_build_object('rubric_levels',p_attempt.question_reviews->(r->>'question_id')->'rubric_levels')) into v_results
      from jsonb_array_elements(coalesce(v_result->'question_results','[]'::jsonb))r;
    v_result:=v_result||jsonb_build_object('question_results',coalesce(v_results,'[]'::jsonb));
  elsif exists(select 1 from public.teaching_grades g where g.id=p_attempt.grade_id and g.published_at is not null
    and p_attempt.reviewed_at is not null and g.published_at>=p_attempt.reviewed_at
    and g.published_score=p_attempt.final_score and not coalesce((to_jsonb(g)->>'published_absent')::boolean,false)) then
    select jsonb_agg(jsonb_build_object('question_id',q->>'id','text',q->>'text','rubric',q->'rubric',
      'levels',p_attempt.question_reviews->(q->>'id')->'rubric_levels','points',(p_attempt.question_reviews->(q->>'id')->>'points')::numeric,'maximum',(q->>'points')::numeric)) into v_results
      from jsonb_array_elements(coalesce(p_attempt.questions,p_test.questions))q where q->'rubric' is not null and q->'rubric'<>'null'::jsonb
        and p_attempt.question_reviews->(q->>'id')->'rubric_levels' is not null;
    v_result:=v_result||jsonb_build_object('published_rubrics',coalesce(v_results,'[]'::jsonb));
  end if;
  return v_result;
end $$;

revoke all on function public.xelay_private_rubric_valid(jsonb),public.xelay_private_rubric_score(jsonb,jsonb,numeric),
  public.xelay_private_test_validate_question_before_rubrics(jsonb),public.xelay_private_test_validate_question(jsonb),
  public.xelay_teaching_test_mutate_before_rubrics(text,jsonb),public.xelay_private_test_attempt_view_before_rubrics(public.teaching_test_attempts,public.teaching_tests,boolean),
  public.xelay_private_test_attempt_view(public.teaching_test_attempts,public.teaching_tests,boolean) from public,anon,authenticated,service_role;
revoke all on function public.xelay_teaching_rubric(uuid,uuid),public.xelay_teaching_rubric_mutate(text,jsonb),public.xelay_teaching_test_mutate(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_rubric(uuid,uuid),public.xelay_teaching_rubric_mutate(text,jsonb),public.xelay_teaching_test_mutate(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
