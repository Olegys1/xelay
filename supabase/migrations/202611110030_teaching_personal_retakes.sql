-- Personal retakes use recipient-only frozen child tests. The established
-- single-attempt invariant, original attempts and journal column are retained.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

create table public.teaching_test_retake_grants (
  id uuid primary key,
  parent_test_id uuid not null references public.teaching_tests(id) on delete restrict,
  child_test_id uuid not null unique references public.teaching_tests(id) on delete cascade,
  user_id uuid not null references public.profiles(id),
  group_id uuid not null references public.study_groups(id),
  source_attempt_id uuid not null references public.teaching_test_attempts(id),
  retake_number integer not null check(retake_number>=2),
  variant_choice text not null,
  request_hash text not null,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default clock_timestamp(),
  revoked_at timestamptz,
  published_at timestamptz,
  published_attempt_score numeric(8,2),
  published_best_score numeric(8,2),
  check(parent_test_id<>child_test_id),
  check(variant_choice in('random','base') or variant_choice ~ '^(variant:)?[A-Za-z0-9_-]{1,64}$')
);
create index teaching_test_retake_parent_user_idx on public.teaching_test_retake_grants(parent_test_id,user_id,created_at);
create table public.teaching_test_attempt_publications (
  attempt_id uuid primary key references public.teaching_test_attempts(id) on delete cascade,
  parent_test_id uuid not null references public.teaching_tests(id) on delete cascade,
  score numeric(8,2), absent boolean not null default false, published_comment text,
  best_score numeric(8,2), published_at timestamptz not null,
  actor_id uuid references public.profiles(id),
  origin text not null check(origin in('original','retake'))
);
create index teaching_test_attempt_publications_parent_idx on public.teaching_test_attempt_publications(parent_test_id);
alter table public.teaching_test_retake_grants enable row level security;
alter table public.teaching_test_attempt_publications enable row level security;
revoke all on public.teaching_test_retake_grants,public.teaching_test_attempt_publications from public,anon,authenticated,service_role;

-- Draft first, link second, publish last is mandatory below. Notification
-- producers must also check the private recipient fence, not just targets.
do $notify$
declare source text; anchor text:='if new.qa_own_attempt or new.status=''draft'' then return new;end if;';
begin
  source:=replace(pg_get_functiondef('public.xelay_notify_test_center()'::regprocedure),chr(13),'');
  if(length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 then raise exception 'TEST_RETAKE_NOTIFICATION_SOURCE_CHANGED';end if;
  execute replace(source,anchor,anchor||$guard$
 if exists(select 1 from public.teaching_test_retake_grants r where r.child_test_id=new.id) then
  if tg_op='INSERT' or old.status='draft' then
   perform public.xelay_teaching_notify(r.user_id,'teaching-test-published:'||new.id||':'||new.version,
    'Викладач дозволив вам повторну спробу тесту. Перегляньте особисті умови в Xelay.',new.course_id,r.group_id)
    from public.teaching_test_retake_grants r where r.child_test_id=new.id and r.revoked_at is null;
  end if;
  return new;
 end if;
$guard$);
end $notify$;

create function public.xelay_private_test_retake_module_guard()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.resource_type='test' and exists(select 1 from public.teaching_test_retake_grants where child_test_id=new.resource_id) then
    raise exception 'COURSE_MODULE_PRIVATE_RETAKE';
  end if;
  return new;
end $$;
create trigger teaching_test_retake_module_guard before insert or update of resource_type,resource_id on public.teaching_course_module_items
  for each row execute function public.xelay_private_test_retake_module_guard();
do $resources$
declare source text; anchor text:='from public.teaching_tests t where t.course_id=p_course_id and not t.qa_own_attempt and(v_owner';
begin
  source:=replace(pg_get_functiondef('public.xelay_private_teaching_course_modules_before_lectures(uuid)'::regprocedure),chr(13),'');
  if(length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 then raise exception 'TEST_RETAKE_MODULE_SOURCE_CHANGED';end if;
  execute replace(source,anchor,'from public.teaching_tests t where t.course_id=p_course_id and not t.qa_own_attempt and not exists(select 1 from public.teaching_test_retake_grants r where r.child_test_id=t.id) and(v_owner');
end $resources$;

-- Fence the earliest common audience helper, including APIs which deliberately
-- bypass admission/module gates when preparing staff settings.
alter function public.xelay_private_test_allows_before_modules_20261104(public.teaching_tests,uuid,uuid)
  rename to xelay_private_test_allows_before_personal_retake;
create function public.xelay_private_test_allows_before_modules_20261104(p_test public.teaching_tests,p_user uuid,p_group uuid default null)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_private_test_allows_before_personal_retake(p_test,p_user,p_group)
    and not exists(select 1 from public.teaching_test_retake_grants r where r.child_test_id=p_test.id
      and(r.user_id<>p_user or(p_group is not null and r.group_id<>p_group) or r.revoked_at is not null
        or not exists(select 1 from public.teaching_tests original where original.id=r.parent_test_id
          and public.xelay_private_test_allows_before_personal_retake(original,r.user_id,r.group_id) is true)));
$$;

alter function public.xelay_private_assessment_snapshot(public.teaching_tests,uuid)
  rename to xelay_private_assessment_snapshot_before_personal_retake;
create function public.xelay_private_assessment_snapshot(p_test public.teaching_tests,p_attempt uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare choice text; variants jsonb;
begin
  select r.variant_choice into choice from public.teaching_test_retake_grants r where r.child_test_id=p_test.id;
  if choice is null or choice='random' then return public.xelay_private_assessment_snapshot_before_personal_retake(p_test,p_attempt);end if;
  if choice<>'base' then
    if left(choice,8)='variant:' then choice:=substr(choice,9);end if;
    select v.variants into variants from public.teaching_test_manual_variants v where v.test_id=p_test.id;
    select v->'questions' into p_test.questions from jsonb_array_elements(variants)v where v->>'id'=choice;
    if p_test.questions is null then raise exception 'TEST_INVALID_INPUT';end if;
  end if;
  return public.xelay_private_assessment_snapshot_before_manual_variants(p_test,p_attempt);
end $$;

alter function public.xelay_private_test_variant_identity(public.teaching_tests,uuid,jsonb)
  rename to xelay_private_test_variant_identity_before_personal_retake;
create function public.xelay_private_test_variant_identity(p_test public.teaching_tests,p_attempt uuid,p_issued jsonb)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare choice text; source_questions jsonb:=p_test.questions; chosen jsonb; number integer:=1; title text;
begin
  select r.variant_choice into choice from public.teaching_test_retake_grants r where r.child_test_id=p_test.id;
  if choice is null or choice='random' then return public.xelay_private_test_variant_identity_before_personal_retake(p_test,p_attempt,p_issued);end if;
  if choice='base' then
    select base_title into title from public.teaching_test_variant_labels where test_id=p_test.id;
    title:=coalesce(title,'Варіант 1');
  else
    if left(choice,8)='variant:' then choice:=substr(choice,9);end if;
    select v,n::integer+1 into chosen,number from public.teaching_test_manual_variants m
      cross join lateral jsonb_array_elements(m.variants) with ordinality x(v,n)
      where m.test_id=p_test.id and v->>'id'=choice;
    source_questions:=chosen->'questions';title:=chosen->>'title';
  end if;
  if jsonb_typeof(p_issued) is distinct from 'array' or jsonb_typeof(source_questions) is distinct from 'array'
    or jsonb_array_length(p_issued)<>least(coalesce(p_test.draw_count,jsonb_array_length(source_questions)),jsonb_array_length(source_questions))
    or(select count(distinct q->>'id') from jsonb_array_elements(p_issued)q)<>jsonb_array_length(p_issued)
    or exists(select 1 from jsonb_array_elements(p_issued)q where not exists(select 1 from jsonb_array_elements(source_questions)s where s->>'id'=q->>'id')) then return null;end if;
  return jsonb_build_object('variant_id',case when number>1 then choice end,'variant_number',number,'variant_title',title);
end $$;

-- Finalization snapshots and explicit publication both address the original
-- journal cell. No child teaching_test_activities row is ever created.
alter function public.xelay_private_test_grade_snapshot(uuid,uuid,uuid)
  rename to xelay_private_test_grade_snapshot_before_personal_retake;
create function public.xelay_private_test_grade_snapshot(p_test uuid,p_group uuid,p_user uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select public.xelay_private_test_grade_snapshot_before_personal_retake(
    coalesce((select parent_test_id from public.teaching_test_retake_grants where child_test_id=p_test),p_test),p_group,p_user);
$$;

create function public.xelay_private_test_retake_transfer_score(p_root uuid,p_group uuid,p_user uuid,p_score numeric)
returns numeric language plpgsql stable security definer set search_path='' as $$
declare grade public.teaching_grades%rowtype; published_best numeric; publication_count integer;
begin
  select count(*)::integer,max(greatest(p.score,p.best_score)) into publication_count,published_best from public.teaching_test_attempt_publications p
    join public.teaching_test_attempts a on a.id=p.attempt_id where p.parent_test_id=p_root and a.group_id=p_group and a.user_id=p_user;
  if publication_count=0 then return p_score;end if;
  select g.* into grade from public.teaching_grades g join public.teaching_test_activities l on l.activity_id=g.activity_id
    join public.teaching_entries e on e.id=g.entry_id where l.test_id=p_root and l.group_id=p_group and e.group_id=p_group and e.user_id=p_user;
  if grade.id is not null and(grade.draft_score is distinct from grade.published_score or grade.draft_comment is distinct from grade.published_comment
    or grade.draft_absent is distinct from grade.published_absent) then raise exception 'TEST_RETAKE_PENDING_GRADE';end if;
  return greatest(p_score,published_best,grade.published_score);
end $$;

-- Parent bulk transfer must also retain the best published result after a
-- later correction/refinalization of the original attempt. Change only the
-- automatic transfer score expression; ordinary manual journal edits retain
-- their established writer, permissions and optimistic version checks.
do $parent_transfer$
declare source text; anchor text:='''score'',v_attempt.final_score,''absent'',false';
begin
  source:=replace(pg_get_functiondef('public.xelay_teaching_test_mutate_before_rubrics(text,jsonb)'::regprocedure),chr(13),'');
  if(length(source)-length(replace(source,anchor,'')))/length(anchor)<>1 then raise exception 'TEST_RETAKE_TRANSFER_SOURCE_CHANGED';end if;
  execute replace(source,anchor,'''score'',public.xelay_private_test_retake_transfer_score(v_id,v_attempt.group_id,v_attempt.user_id,v_attempt.final_score),''absent'',false');
end $parent_transfer$;

create function public.xelay_private_test_retake_grants_view(p_test uuid,p_user uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'child_test_id',r.child_test_id,'user_id',r.user_id,'group_id',r.group_id,
    'source_attempt_id',r.source_attempt_id,'retake_number',r.retake_number,'variant_choice',r.variant_choice,
    'opens_at',t.opens_at,'closes_at',t.closes_at,'duration_seconds',t.duration_seconds,'created_at',r.created_at,
    'revoked_at',r.revoked_at,'attempt_id',a.id,'started_at',a.started_at,'expires_at',a.expires_at,
    'status',case when a.id is null then 'pending' when a.status='submitted' or a.expires_at<=clock_timestamp() then 'submitted' else 'in_progress' end,
    'published_at',r.published_at,'published_attempt_score',r.published_attempt_score,'published_best_score',r.published_best_score)
    order by r.created_at,r.id),'[]'::jsonb)
  from public.teaching_test_retake_grants r join public.teaching_tests t on t.id=r.child_test_id
    left join public.teaching_test_attempts a on a.test_id=t.id and a.user_id=r.user_id
  where r.parent_test_id=p_test and 'grades'=any(public.xelay_teaching_group_permissions(t.course_id,r.group_id,p_user));
$$;

alter function public.xelay_private_test_attempt_view(public.teaching_test_attempts,public.teaching_tests,boolean)
  rename to xelay_private_test_attempt_view_before_personal_retake;
create function public.xelay_private_test_attempt_view(p_attempt public.teaching_test_attempts,p_test public.teaching_tests,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; grant_row public.teaching_test_retake_grants%rowtype; publication public.teaching_test_attempt_publications%rowtype;
begin
  result:=public.xelay_private_test_attempt_view_before_personal_retake(p_attempt,p_test,p_full);
  select * into grant_row from public.teaching_test_retake_grants where child_test_id=p_test.id;
  if found then result:=result||jsonb_build_object('attempt_number',grant_row.retake_number,'retake_number',grant_row.retake_number,'retake_parent_id',grant_row.parent_test_id);end if;
  select * into publication from public.teaching_test_attempt_publications where attempt_id=p_attempt.id;
  if found then
    result:=result||jsonb_build_object('published_score',publication.score,'published_absent',publication.absent,'published_comment',publication.published_comment,
      'grade_published_at',publication.published_at,'retake_best_published_score',publication.best_score);
  elsif grant_row.id is not null then
    result:=result-array['published_score','published_absent','published_comment','grade_published_at'];
  end if;
  return result;
end $$;

alter function public.xelay_private_test_view(public.teaching_tests,uuid,boolean)
  rename to xelay_private_test_view_before_personal_retake;
create function public.xelay_private_test_view(p_test public.teaching_tests,p_user uuid,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; r public.teaching_test_retake_grants%rowtype; publication public.teaching_test_attempt_publications%rowtype;
begin
  result:=public.xelay_private_test_view_before_personal_retake(p_test,p_user,p_full);
  select * into r from public.teaching_test_retake_grants where child_test_id=p_test.id;
  if found then
    result:=result||jsonb_build_object('is_personal_retake',true,'retake_parent_id',r.parent_test_id,
      'retake_parent_title',(select title from public.teaching_tests where id=r.parent_test_id),'retake_number',r.retake_number,
      'retake_published_at',r.published_at,
      'retake_published_score',case when p_user=r.user_id or 'grades'=any(public.xelay_teaching_group_permissions(p_test.course_id,r.group_id,p_user)) then r.published_attempt_score end,
      'retake_best_published_score',case when p_user=r.user_id or 'grades'=any(public.xelay_teaching_group_permissions(p_test.course_id,r.group_id,p_user)) then r.published_best_score end,
      'can_edit',false,'can_grant_retake',false);
    if result->'my_attempt' is not null and result->'my_attempt'<>'null'::jsonb then
      select p.* into publication from public.teaching_test_attempt_publications p where p.attempt_id=(result->'my_attempt'->>'id')::uuid;
      result:=jsonb_set(result,'{my_attempt}',((result->'my_attempt')-array['published_score','published_absent','published_comment','grade_published_at'])||
        jsonb_build_object('published_score',publication.score,'published_absent',coalesce(publication.absent,false),'published_comment',publication.published_comment,'grade_published_at',publication.published_at));
    end if;
  elsif p_full then
    result:=result||jsonb_build_object('can_grant_retake',p_test.status<>'draft' and not p_test.qa_own_attempt
      and public.xelay_private_test_staff(p_test,p_user,'assignments') and public.xelay_private_test_staff(p_test,p_user,'grades'),
      'retake_grants',public.xelay_private_test_retake_grants_view(p_test.id,p_user));
  end if;
  return result;
end $$;

create function public.xelay_private_test_retake_history(p_attempt public.teaching_test_attempts,p_test public.teaching_tests,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare result jsonb; publication public.teaching_test_attempt_publications%rowtype; grade public.teaching_grades%rowtype;
  r public.teaching_test_retake_grants%rowtype;
begin
  select * into r from public.teaching_test_retake_grants where child_test_id=p_test.id;
  result:=jsonb_build_object('id',p_attempt.id,'test_id',p_test.id,'user_id',p_attempt.user_id,'group_id',p_attempt.group_id,
    'status',p_attempt.status,'started_at',p_attempt.started_at,'submitted_at',p_attempt.submitted_at,'expires_at',p_attempt.expires_at,
    'version',p_attempt.version,'retake_number',coalesce(r.retake_number,1),'attempt_number',coalesce(r.retake_number,1),'retake_parent_id',r.parent_test_id);
  select * into publication from public.teaching_test_attempt_publications where attempt_id=p_attempt.id;
  if found then
    result:=result||jsonb_build_object('published_score',publication.score,'published_absent',publication.absent,'published_comment',publication.published_comment,
      'grade_published_at',publication.published_at,'retake_best_published_score',publication.best_score);
  elsif r.id is null then
    select * into grade from public.teaching_grades where id=p_attempt.grade_id;
    result:=result||jsonb_build_object('published_score',grade.published_score,'published_absent',grade.published_absent,'published_comment',grade.published_comment,'grade_published_at',grade.published_at);
  end if;
  if p_full then result:=result||jsonb_build_object('student_name',(select full_name from public.profiles where id=p_attempt.user_id),
    'score',p_attempt.score,'final_score',p_attempt.final_score,'variant_id',p_attempt.variant_id,
    'variant_number',p_attempt.variant_number,'variant_title',p_attempt.variant_title);end if;
  return result;
end $$;

alter function public.xelay_teaching_test(uuid) rename to xelay_private_test_detail_before_personal_retake;
create function public.xelay_teaching_test(p_test_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare uid uuid:=public.xelay_teaching_assert_user(); result jsonb; test_row public.teaching_tests%rowtype; root_id uuid; history jsonb;
begin
  result:=public.xelay_private_test_detail_before_personal_retake(p_test_id);
  select * into test_row from public.teaching_tests where id=p_test_id;
  root_id:=coalesce((select parent_test_id from public.teaching_test_retake_grants where child_test_id=p_test_id),p_test_id);
  if not exists(select 1 from public.teaching_test_retake_grants where parent_test_id=root_id) then return result||jsonb_build_object('attempt_history','[]'::jsonb);end if;
  select coalesce(jsonb_agg(public.xelay_private_test_retake_history(a,t,
      'grades'=any(public.xelay_teaching_group_permissions(t.course_id,a.group_id,uid))) order by a.started_at,a.id),'[]'::jsonb) into history
    from public.teaching_test_attempts a join public.teaching_tests t on t.id=a.test_id
    where(a.test_id=root_id or exists(select 1 from public.teaching_test_retake_grants r where r.child_test_id=a.test_id and r.parent_test_id=root_id))
      and(a.user_id=uid and public.xelay_private_test_allows_before_modules_20261104(t,uid,a.group_id)
        or 'grades'=any(public.xelay_teaching_group_permissions(t.course_id,a.group_id,uid)));
  return result||jsonb_build_object('attempt_history',history);
end $$;

alter function public.xelay_teaching_test_mutate(text,jsonb) rename to xelay_private_test_mutate_before_personal_retake;
create function public.xelay_teaching_test_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare uid uuid:=public.xelay_teaching_assert_user(); test_row public.teaching_tests%rowtype; parent_row public.teaching_tests%rowtype;
  r public.teaching_test_retake_grants%rowtype; previous public.teaching_test_retake_grants%rowtype;
  attempt public.teaching_test_attempts%rowtype; source_attempt public.teaching_test_attempts%rowtype;
  grade public.teaching_grades%rowtype; entry public.teaching_entries%rowtype;
  v_id uuid; child_id uuid; request_id uuid; student uuid; v_group uuid; activity uuid;
  now_at timestamptz:=clock_timestamp(); opens timestamptz; closes timestamptz; duration integer; variant text; number integer;
  variants jsonb; label text; result jsonb; saved jsonb; best numeric; payload jsonb:=p_payload;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' then raise exception 'TEST_INVALID_INPUT';end if;
  v_id:=(p_payload->>'id')::uuid;
  select * into r from public.teaching_test_retake_grants where child_test_id=v_id;
  if p_action in('save_answer','navigate','finish','record_tab_exit') then
    select * into attempt from public.teaching_test_attempts a where a.test_id=v_id and a.user_id=uid;
    -- Each child retains UNIQUE(test_id,user_id): an old tab cannot address a
    -- later opportunity. Cached clients may omit this added binding; when an
    -- ID is supplied it must identify the same canonical per-child attempt.
    if p_payload?'attempt_id' and(p_payload->>'attempt_id' is null or(p_payload->>'attempt_id')::uuid is distinct from attempt.id) then raise exception 'TEST_ATTEMPT_CHANGED';end if;
    payload:=p_payload-'attempt_id';
    if p_action='record_tab_exit' then payload:=p_payload;end if;
  end if;
  if p_action not in('grant_retake','publish_retake') then
    if r.id is not null and(p_action in('save_test','save_override','review_results') or r.published_at is not null and p_action in('save_review','finalize_results')) then raise exception 'TEST_RETAKE_IMMUTABLE';end if;
    return public.xelay_private_test_mutate_before_personal_retake(p_action,payload);
  end if;
  if p_payload->>'expected_user_id' is distinct from uid::text then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501';end if;
  if jsonb_typeof(p_payload->'version') is distinct from 'number' or octet_length(p_payload::text)>6000 then raise exception 'TEST_INVALID_INPUT';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||v_id,0));
  select * into test_row from public.teaching_tests where id=v_id for update;
  if not found then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  now_at:=clock_timestamp();
  if p_action='grant_retake' then
    if p_payload->'confirm_retake' is distinct from 'true'::jsonb or test_row.status='draft' or test_row.qa_own_attempt
      or r.id is not null or exists(select 1 from jsonb_object_keys(p_payload)k where k not in('id','version','expected_user_id','request_id','user_id','group_id','source_attempt_id','variant_choice','opens_at','closes_at','duration_seconds','confirm_retake')) then raise exception 'TEST_INVALID_INPUT';end if;
    request_id:=(p_payload->>'request_id')::uuid;student:=(p_payload->>'user_id')::uuid;v_group:=(p_payload->>'group_id')::uuid;
    if request_id is null or student is null or v_group is null then raise exception 'TEST_INVALID_INPUT';end if;
    perform public.xelay_private_assert_teaching_group(test_row.course_id,v_group,'assignments');
    perform public.xelay_private_assert_teaching_group(test_row.course_id,v_group,'grades');
    perform pg_advisory_xact_lock(hashtextextended('xelay:test-retake-request:'||request_id,0));
    select * into previous from public.teaching_test_retake_grants where id=request_id;
    if found then
      if previous.parent_test_id<>v_id or previous.created_by<>uid or previous.request_hash<>md5(p_payload::text) then raise exception 'TEST_CONFLICT';end if;
      return public.xelay_teaching_test(v_id);
    end if;
    if(p_payload->>'version')::numeric is distinct from test_row.version::numeric then raise exception 'TEST_CONFLICT';end if;
    if public.xelay_private_test_allows_before_modules_20261104(test_row,student,v_group) is not true
      or not(public.xelay_private_test_admission(test_row,student)->>'allowed')::boolean then raise exception 'TEST_NOT_ADMITTED' using errcode='42501';end if;
    if student=test_row.created_by or public.xelay_private_test_staff(test_row,student,'assignments')
      or public.xelay_private_test_staff(test_row,student,'grades') then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
    -- A pending child may be starting while the teacher submits the form.
    -- Freeze its established test/student guards before finding the latest
    -- source; timely answer saves finish before an expired attempt is closed.
    select g.* into previous from public.teaching_test_retake_grants g where g.parent_test_id=v_id and g.user_id=student and g.revoked_at is null
      order by g.created_at desc,g.id desc limit 1;
    if previous.id is not null then
      perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||previous.child_test_id,0));
      perform pg_advisory_xact_lock(public.xelay_private_test_student_lock_key(previous.child_test_id,student));
    end if;
    perform pg_advisory_xact_lock(public.xelay_private_test_student_lock_key(v_id,student));
    now_at:=clock_timestamp();
    select a.* into source_attempt from public.teaching_test_attempts a where a.user_id=student
      and(a.test_id=v_id or exists(select 1 from public.teaching_test_retake_grants g where g.parent_test_id=v_id and g.child_test_id=a.test_id and g.user_id=student))
      order by a.started_at desc,a.id desc limit 1 for update;
    if source_attempt.id is null or source_attempt.id is distinct from(p_payload->>'source_attempt_id')::uuid or source_attempt.group_id<>v_group then raise exception 'TEST_RETAKE_SOURCE_CHANGED';end if;
    if source_attempt.status='in_progress' and source_attempt.expires_at>now_at then raise exception 'TEST_RETAKE_ACTIVE_ATTEMPT';end if;
    if source_attempt.status='in_progress' then perform public.xelay_private_test_finish(source_attempt.id,now_at);end if;
    for previous in select g.* from public.teaching_test_retake_grants g join public.teaching_tests c on c.id=g.child_test_id
      where g.parent_test_id=v_id and g.user_id=student and g.revoked_at is null
        and not exists(select 1 from public.teaching_test_attempts a where a.test_id=g.child_test_id) for update of g loop
      if(previous.child_test_id is not null and(select c.closes_at from public.teaching_tests c where c.id=previous.child_test_id)>now_at) then raise exception 'TEST_RETAKE_PENDING';end if;
      update public.teaching_test_retake_grants set revoked_at=now_at where id=previous.id;
      update public.teaching_tests set status='closed',version=version+1,updated_at=now_at where id=previous.child_test_id;
    end loop;
    opens:=(p_payload->>'opens_at')::timestamptz;closes:=(p_payload->>'closes_at')::timestamptz;duration:=(p_payload->>'duration_seconds')::integer;
    variant:=p_payload->>'variant_choice';
    if opens is null or closes is null or not isfinite(opens) or not isfinite(closes) or closes<=greatest(opens,now_at)
      or jsonb_typeof(p_payload->'duration_seconds') is distinct from 'number' or(p_payload->>'duration_seconds')::numeric<>duration or duration not between 30 and 86400
      or not exists(select 1 from public.teaching_courses c where c.id=test_row.course_id and(opens at time zone 'Europe/Kyiv')::date>=c.starts_on and(closes at time zone 'Europe/Kyiv')::date<=c.ends_on)
      or jsonb_typeof(p_payload->'variant_choice') is distinct from 'string' then raise exception 'TEST_INVALID_INPUT';end if;
    select v.variants into variants from public.teaching_test_manual_variants v where v.test_id=v_id;
    if variant not in('random','base') and not exists(select 1 from jsonb_array_elements(coalesce(variants,'[]'))v where v->>'id'=case when left(variant,8)='variant:' then substr(variant,9) else variant end) then raise exception 'TEST_INVALID_INPUT';end if;
    select count(*)::integer+1 into number from public.teaching_test_attempts a where a.user_id=student
      and(a.test_id=v_id or exists(select 1 from public.teaching_test_retake_grants g where g.parent_test_id=v_id and g.child_test_id=a.test_id));
    child_id:=gen_random_uuid();
    insert into public.teaching_tests(id,course_id,title,description,status,opens_at,closes_at,duration_seconds,max_points,category,journal_date,work_type,
      allow_skip,allow_return,question_timer_policy,restrict_copy,bonus_percent,bonus_points,targets,questions,created_by,
      shuffle_questions,shuffle_answers,draw_count,overrides,require_access_code,restrict_tab_switch,discourage_capture,allow_external_links)
    values(child_id,test_row.course_id,left('Повторна спроба · '||test_row.title,180),test_row.description,'draft',opens,closes,duration,test_row.max_points,test_row.category,test_row.journal_date,test_row.work_type,
      test_row.allow_skip,test_row.allow_return,test_row.question_timer_policy,test_row.restrict_copy,0,0,
      jsonb_build_array(jsonb_build_object('group_id',v_group,'audience_mode','all','subgroup_ids','[]'::jsonb)),test_row.questions,uid,
      test_row.shuffle_questions,test_row.shuffle_answers,test_row.draw_count,'[]'::jsonb,test_row.require_access_code,test_row.restrict_tab_switch,test_row.discourage_capture,test_row.allow_external_links);
    insert into public.teaching_test_retake_grants(id,parent_test_id,child_test_id,user_id,group_id,source_attempt_id,retake_number,variant_choice,request_hash,created_by)
      values(request_id,v_id,child_id,student,v_group,source_attempt.id,number,variant,md5(p_payload::text),uid);
    if variants is not null then insert into public.teaching_test_manual_variants(test_id,variants) values(child_id,variants);end if;
    select base_title into label from public.teaching_test_variant_labels v where v.test_id=v_id;
    insert into public.teaching_test_variant_labels(test_id,base_title) values(child_id,coalesce(label,'Варіант 1'));
    if test_row.require_access_code then
      insert into public.teaching_test_access_codes(test_id,current_code,previous_code,rotated_at)
        select child_id,current_code,previous_code,now_at from public.teaching_test_access_codes c where c.test_id=v_id;
      if not found then perform public.xelay_private_test_rotate_access_code(child_id);end if;
    end if;
    -- Freeze the already published original result before any retake can improve
    -- the shared journal cell. Old history never borrows a later higher score.
    insert into public.teaching_test_attempt_publications(attempt_id,parent_test_id,score,absent,published_comment,best_score,published_at,actor_id,origin)
      select a.id,v_id,g.published_score,g.published_absent,g.published_comment,g.published_score,g.published_at,null::uuid,'original'
      from public.teaching_test_attempts a join public.teaching_test_activities l on l.test_id=v_id and l.group_id=a.group_id
      join public.teaching_entries e on e.user_id=a.user_id and e.group_id=a.group_id and e.course_id=test_row.course_id
      join public.teaching_grades g on g.activity_id=l.activity_id and g.entry_id=e.id
      where a.test_id=v_id and a.user_id=student and g.published_at is not null on conflict(attempt_id) do nothing;
    update public.teaching_tests set status='published',updated_at=now_at where id=child_id;
    update public.teaching_tests set version=version+1,updated_at=now_at where id=v_id;
    return public.xelay_teaching_test(v_id);
  end if;

  select * into r from public.teaching_test_retake_grants where child_test_id=v_id for update;
  if not found or r.revoked_at is not null or p_payload->'confirm_retake_publish' is distinct from 'true'::jsonb
    or exists(select 1 from jsonb_object_keys(p_payload)k where k not in('id','version','expected_user_id','expected_grade_version','confirm_retake_publish')) then raise exception 'TEST_INVALID_INPUT';end if;
  perform public.xelay_private_assert_teaching_group(test_row.course_id,r.group_id,'grades');
  if r.published_at is not null then return public.xelay_teaching_test(v_id);end if;
  if(p_payload->>'version')::numeric is distinct from test_row.version::numeric then raise exception 'TEST_CONFLICT';end if;
  if test_row.results_finalized_at is null or test_row.approved_revision is distinct from test_row.review_revision or test_row.status<>'closed' then raise exception 'TEST_REVIEW_REQUIRED';end if;
  select * into attempt from public.teaching_test_attempts a where a.test_id=v_id and a.user_id=r.user_id and a.status='submitted' for update;
  if not found or attempt.final_score is null then raise exception 'TEST_NO_SUBMITTED_ATTEMPTS';end if;
  select * into parent_row from public.teaching_tests where id=r.parent_test_id;
  if public.xelay_private_test_allows_before_modules_20261104(parent_row,r.user_id,r.group_id) is not true then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  perform public.xelay_teaching_lock_course(test_row.course_id,'grades');
  perform public.xelay_teaching_sync_roster(test_row.course_id,r.group_id);
  select * into entry from public.teaching_entries e where e.course_id=test_row.course_id and e.group_id=r.group_id and e.user_id=r.user_id and e.active for update;
  select l.activity_id into activity from public.teaching_test_activities l where l.test_id=r.parent_test_id and l.group_id=r.group_id;
  if entry.id is null or activity is null then raise exception 'TEST_REVIEW_REQUIRED';end if;
  select * into grade from public.teaching_grades g where g.activity_id=activity and g.entry_id=entry.id for update;
  if jsonb_typeof(p_payload->'expected_grade_version') is distinct from 'number'
    or(p_payload->>'expected_grade_version')::numeric is distinct from coalesce(grade.version,0)::numeric
    or attempt.grade_snapshot is null or(attempt.grade_snapshot->>'version')::integer is distinct from coalesce(grade.version,0)
    or nullif(attempt.grade_snapshot->>'id','')::uuid is distinct from grade.id then raise exception 'TEST_GRADE_CONFLICT';end if;
  if grade.id is not null and(grade.draft_score is distinct from grade.published_score or grade.draft_comment is distinct from grade.published_comment
    or grade.draft_absent is distinct from grade.published_absent) then raise exception 'TEST_RETAKE_PENDING_GRADE';end if;
  insert into public.teaching_test_attempt_publications(attempt_id,parent_test_id,score,absent,published_comment,best_score,published_at,actor_id,origin)
    select a.id,r.parent_test_id,grade.published_score,grade.published_absent,grade.published_comment,grade.published_score,grade.published_at,null::uuid,'original'
    from public.teaching_test_attempts a where a.test_id=r.parent_test_id and a.user_id=r.user_id and grade.published_at is not null
    on conflict(attempt_id) do nothing;
  best:=public.xelay_private_test_retake_transfer_score(r.parent_test_id,r.group_id,r.user_id,attempt.final_score);
  if grade.published_score is null or best>grade.published_score then
    saved:=public.xelay_teaching_mutate('save_grade',jsonb_build_object('course_id',test_row.course_id,'activity_id',activity,'entry_id',entry.id,
      'version',coalesce(grade.version,0),'score',best,'absent',false,'comment','Найкращий результат тесту. Повторна спроба №'||r.retake_number||'.',
      'reason','Публікація перевіреної повторної спроби №'||r.retake_number||'; найкращий опублікований бал збережено.'));
    perform public.xelay_teaching_mutate('publish_grades',jsonb_build_object('course_id',test_row.course_id,'activity_id',activity,
      'expected_versions',jsonb_build_array(jsonb_build_object('entry_id',entry.id,'version',(saved->>'version')::integer))));
    select * into grade from public.teaching_grades g where g.activity_id=activity and g.entry_id=entry.id;
  end if;
  insert into public.teaching_test_attempt_publications(attempt_id,parent_test_id,score,absent,published_comment,best_score,published_at,actor_id,origin)
    values(attempt.id,r.parent_test_id,attempt.final_score,false,'Перевірену повторну спробу №'||r.retake_number||' опубліковано.',best,now_at,uid,'retake');
  update public.teaching_test_retake_grants set published_at=now_at,published_attempt_score=attempt.final_score,published_best_score=best where id=r.id;
  update public.teaching_test_attempts set grade_id=grade.id,reviewed_at=now_at,review_note='Результат повторної спроби опубліковано. Найкращий бал у журналі: '||best||'.',version=version+1 where id=attempt.id;
  update public.teaching_tests set version=version+1,updated_at=now_at where id=v_id;
  return public.xelay_teaching_test(v_id);
exception when invalid_text_representation or numeric_value_out_of_range or datetime_field_overflow or invalid_datetime_format then raise exception 'TEST_INVALID_INPUT' using errcode='22023';
end $$;

revoke all on function
  public.xelay_private_test_allows_before_personal_retake(public.teaching_tests,uuid,uuid),
  public.xelay_private_test_allows_before_modules_20261104(public.teaching_tests,uuid,uuid),
  public.xelay_private_assessment_snapshot_before_personal_retake(public.teaching_tests,uuid),
  public.xelay_private_assessment_snapshot(public.teaching_tests,uuid),
  public.xelay_private_test_variant_identity_before_personal_retake(public.teaching_tests,uuid,jsonb),
  public.xelay_private_test_variant_identity(public.teaching_tests,uuid,jsonb),
  public.xelay_private_test_grade_snapshot_before_personal_retake(uuid,uuid,uuid),public.xelay_private_test_grade_snapshot(uuid,uuid,uuid),
  public.xelay_private_test_retake_transfer_score(uuid,uuid,uuid,numeric),
  public.xelay_private_test_retake_grants_view(uuid,uuid),
  public.xelay_private_test_retake_module_guard(),
  public.xelay_private_test_attempt_view_before_personal_retake(public.teaching_test_attempts,public.teaching_tests,boolean),
  public.xelay_private_test_attempt_view(public.teaching_test_attempts,public.teaching_tests,boolean),
  public.xelay_private_test_retake_history(public.teaching_test_attempts,public.teaching_tests,boolean),
  public.xelay_private_test_view_before_personal_retake(public.teaching_tests,uuid,boolean),public.xelay_private_test_view(public.teaching_tests,uuid,boolean),
  public.xelay_private_test_detail_before_personal_retake(uuid),public.xelay_teaching_test(uuid),
  public.xelay_private_test_mutate_before_personal_retake(text,jsonb),public.xelay_teaching_test_mutate(text,jsonb)
from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_test(uuid),public.xelay_teaching_test_mutate(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
