-- Teacher-authored tests use private definitions and server-timed single attempts.
-- Grading is copied through the existing journal writer only after teacher review.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

create table public.teaching_tests(
  id uuid primary key,course_id uuid not null references public.teaching_courses(id) on delete cascade,
  title text not null,description text not null default '',status text not null check(status in('draft','published','closed')),
  opens_at timestamptz not null,closes_at timestamptz not null,duration_seconds integer not null,
  max_points numeric(8,2) not null,category text not null default '',journal_date date not null,work_type text not null default 'Тест',
  allow_skip boolean not null,allow_return boolean not null,
  question_timer_policy text not null check(question_timer_policy in('continue','lock_on_leave')),restrict_copy boolean not null,
  bonus_percent integer not null check(bonus_percent in(0,10,20)),bonus_points numeric(8,2) not null,
  targets jsonb not null,questions jsonb not null,version integer not null default 1,
  results_finalized_at timestamptz,review_revision integer not null default 0,approved_revision integer,
  created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  check(isfinite(opens_at) and isfinite(closes_at) and closes_at>opens_at),
  check(duration_seconds between 30 and 86400 and max_points>0 and max_points<=10000 and bonus_points>=0 and bonus_points<=max_points),
  check(length(btrim(title)) between 1 and 180 and length(description)<=10000 and length(btrim(work_type)) between 1 and 100 and isfinite(journal_date))
);
create table public.teaching_test_attempts(
  id uuid primary key default gen_random_uuid(),test_id uuid not null references public.teaching_tests(id) on delete cascade,
  group_id uuid not null references public.study_groups(id),user_id uuid not null references public.profiles(id),
  status text not null default 'in_progress' check(status in('in_progress','submitted')),
  started_at timestamptz not null,expires_at timestamptz not null,submitted_at timestamptz,
  current_index integer not null default 0,answers jsonb not null default '{}',opened_at jsonb not null default '{}',
  locked text[] not null default '{}',version integer not null default 1,
  auto_score numeric(8,2),score numeric(8,2),question_reviews jsonb not null default '{}',bonus_score numeric(8,2) not null default 0,final_score numeric(8,2),
  rank integer,bonus_winner boolean not null default false,grade_snapshot jsonb,
  elapsed_seconds numeric,reviewed_at timestamptz,review_note text not null default '',grade_id uuid references public.teaching_grades(id) on delete set null,
  unique(test_id,user_id)
);
create table public.teaching_test_activities(
  test_id uuid not null references public.teaching_tests(id) on delete cascade,group_id uuid not null references public.study_groups(id),
  activity_id uuid not null references public.teaching_activities(id) on delete restrict,primary key(test_id,group_id),unique(activity_id)
);
create table public.teaching_test_review_audit(
  id uuid primary key default gen_random_uuid(),test_id uuid not null references public.teaching_tests(id) on delete cascade,
  attempt_id uuid not null references public.teaching_test_attempts(id) on delete cascade,question_id text not null,
  actor_id uuid not null references public.profiles(id),old_points numeric not null,new_points numeric not null,
  mode text not null check(mode in('auto','full','zero','custom')),reason text not null check(length(btrim(reason)) between 2 and 2000),
  created_at timestamptz not null default clock_timestamp()
);
create index teaching_tests_course_idx on public.teaching_tests(course_id,created_at desc);
create index teaching_tests_attempts_scope_idx on public.teaching_test_attempts(test_id,group_id);
alter table public.teaching_tests enable row level security;
alter table public.teaching_test_attempts enable row level security;
alter table public.teaching_test_activities enable row level security;
alter table public.teaching_test_review_audit enable row level security;
revoke all on public.teaching_tests,public.teaching_test_attempts,public.teaching_test_activities,public.teaching_test_review_audit from public,anon,authenticated,service_role;

create function public.xelay_private_test_staff(p_test public.teaching_tests,p_user uuid,p_permission text,p_all boolean default false)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_teaching_is_verified(p_user) and public.xelay_teaching_has_current_access(p_user)
    and case when p_all then not exists(select 1 from jsonb_array_elements(p_test.targets)t
      where not p_permission=any(public.xelay_teaching_group_permissions(p_test.course_id,(t->>'group_id')::uuid,p_user)))
    else exists(select 1 from jsonb_array_elements(p_test.targets)t
      where p_permission=any(public.xelay_teaching_group_permissions(p_test.course_id,(t->>'group_id')::uuid,p_user))) end;
$$;
create function public.xelay_private_test_allows(p_test public.teaching_tests,p_user uuid,p_group uuid default null)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from jsonb_array_elements(p_test.targets)t
    where(p_group is null or (t->>'group_id')::uuid=p_group)
      and public.xelay_private_teaching_audience_allows(p_test.course_id,(t->>'group_id')::uuid,t->>'audience_mode',
        array(select value::uuid from jsonb_array_elements_text(t->'subgroup_ids')),'{}'::uuid[],p_user));
$$;

create function public.xelay_private_test_validate_question(p_question jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_option jsonb;v_ids text[];v_buckets text[];v_answer jsonb:=p_question->'answer';v_kind text:=p_question->>'kind';v_points numeric;v_seconds integer;
begin
  if jsonb_typeof(p_question)<>'object' or p_question->>'id' !~ '^[A-Za-z0-9_-]{1,64}$'
    or length(btrim(coalesce(p_question->>'text',''))) not between 1 and 10000
    or coalesce(v_kind,'') not in('choice','boolean','sorting','sequence') or jsonb_typeof(p_question->'points') is distinct from 'number'
    or jsonb_typeof(p_question->'partial_credit') is distinct from 'boolean'
    or jsonb_typeof(p_question->'options') is distinct from 'array' or jsonb_typeof(p_question->'buckets') is distinct from 'array' then return false;end if;
  v_points:=(p_question->>'points')::numeric;
  if v_points<=0 or v_points>10000 or scale(v_points)>2 then return false;end if;
  if p_question->'time_limit_seconds'<>'null'::jsonb then
    if jsonb_typeof(p_question->'time_limit_seconds') is distinct from 'number' then return false;end if;
    v_seconds:=(p_question->>'time_limit_seconds')::integer;
    if v_seconds not between 1 and 86400 or v_seconds::numeric<>(p_question->>'time_limit_seconds')::numeric then return false;end if;
  end if;
  if jsonb_array_length(p_question->'options') not between 2 and 30 then return false;end if;
  for v_option in select value from jsonb_array_elements(p_question->'options') union all select value from jsonb_array_elements(p_question->'buckets') loop
    if jsonb_typeof(v_option)<>'object' or coalesce(v_option->>'id','') !~ '^[A-Za-z0-9_-]{1,64}$'
      or length(btrim(coalesce(v_option->>'text',''))) not between 1 and 2000 then return false;end if;
  end loop;
  v_ids:=array(select value->>'id' from jsonb_array_elements(p_question->'options'));
  v_buckets:=array(select value->>'id' from jsonb_array_elements(p_question->'buckets'));
  if cardinality(v_ids)<>(select count(distinct x) from unnest(v_ids)x)
    or cardinality(v_buckets)<>(select count(distinct x) from unnest(v_buckets)x) then return false;end if;
  if v_kind in('choice','boolean') then
    return jsonb_typeof(v_answer)='string' and (v_answer#>>'{}')=any(v_ids) and cardinality(v_buckets)=0
      and (v_kind<>'choice' or cardinality(v_ids)=4)
      and (v_kind<>'boolean' or cardinality(v_ids)=2 and v_ids@>array['true','false']);
  elsif v_kind='sequence' then
    return jsonb_typeof(v_answer)='array' and cardinality(v_buckets)=0 and jsonb_array_length(v_answer)=cardinality(v_ids)
      and not exists(select 1 from jsonb_array_elements(v_answer)x where jsonb_typeof(x)<>'string' or not(x#>>'{}')=any(v_ids))
      and (select count(distinct x#>>'{}') from jsonb_array_elements(v_answer)x)=cardinality(v_ids);
  end if;
  return jsonb_typeof(v_answer)='object' and cardinality(v_buckets) between 2 and 10
    and (select count(*) from jsonb_object_keys(v_answer))=cardinality(v_ids)
    and not exists(select 1 from jsonb_each(v_answer)x where not x.key=any(v_ids) or jsonb_typeof(x.value)<>'string' or not(x.value#>>'{}')=any(v_buckets));
exception when others then return false;
end $$;

create function public.xelay_private_test_valid_answer(p_question jsonb,p_answer jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_ids text[]:=array(select value->>'id' from jsonb_array_elements(p_question->'options'));v_buckets text[]:=array(select value->>'id' from jsonb_array_elements(p_question->'buckets'));
begin
  if p_answer is null or p_answer='null'::jsonb then return true;end if;
  if p_question->>'kind' in('choice','boolean') then return jsonb_typeof(p_answer)='string' and (p_answer#>>'{}')=any(v_ids);end if;
  if p_question->>'kind'='sequence' then
    return jsonb_typeof(p_answer)='array' and jsonb_array_length(p_answer)=cardinality(v_ids)
      and not exists(select 1 from jsonb_array_elements(p_answer)x where jsonb_typeof(x)<>'string' or not(x#>>'{}')=any(v_ids))
      and(select count(distinct x#>>'{}') from jsonb_array_elements(p_answer)x)=cardinality(v_ids);
  end if;
  return jsonb_typeof(p_answer)='object' and (select count(*) from jsonb_object_keys(p_answer))<=cardinality(v_ids)
    and not exists(select 1 from jsonb_each(p_answer)x where not x.key=any(v_ids) or jsonb_typeof(x.value)<>'string' or not(x.value#>>'{}')=any(v_buckets));
exception when others then return false;
end $$;

create function public.xelay_private_test_question_points(p_question jsonb,p_answer jsonb)
returns numeric language plpgsql immutable set search_path='' as $$
declare v_points numeric:=(p_question->>'points')::numeric;v_correct numeric;v_count numeric;
begin
  if p_answer is null or p_answer='null'::jsonb then return 0;end if;
  if p_answer=p_question->'answer' then return v_points;end if;
  if (p_question->>'partial_credit')::boolean and p_question->>'kind' in('sorting','sequence') then
    if p_question->>'kind'='sorting' then
      select count(*) into v_count from jsonb_each(p_question->'answer');
      select count(*) into v_correct from jsonb_each(p_question->'answer')x where p_answer->x.key=x.value;
    else
      v_count:=jsonb_array_length(p_question->'answer');
      select count(*) into v_correct from jsonb_array_elements(p_question->'answer') with ordinality x(value,n) where p_answer->(x.n::integer-1)=x.value;
    end if;
    return v_points*v_correct/v_count;
  end if;
  return 0;
end $$;
create function public.xelay_private_test_effective_score(p_questions jsonb,p_answers jsonb,p_reviews jsonb,p_max numeric)
returns numeric language sql immutable set search_path='' as $$
  select round(p_max*sum(case when coalesce(p_reviews->(q->>'id')->>'mode','auto')='auto'
    then public.xelay_private_test_question_points(q,p_answers->(q->>'id')) else(p_reviews->(q->>'id')->>'points')::numeric end)
    /sum((q->>'points')::numeric),2) from jsonb_array_elements(p_questions)q;
$$;
create function public.xelay_private_test_score(p_questions jsonb,p_answers jsonb,p_max numeric)
returns numeric language sql immutable set search_path='' as $$
  select public.xelay_private_test_effective_score(p_questions,p_answers,'{}'::jsonb,p_max);
$$;

create function public.xelay_private_test_finish(p_attempt uuid,p_now timestamptz)
returns void language plpgsql security definer set search_path='' as $$
declare v_attempt public.teaching_test_attempts%rowtype;v_test public.teaching_tests%rowtype;v_end timestamptz;
begin
  select * into v_attempt from public.teaching_test_attempts where id=p_attempt for update;
  if not found or v_attempt.status='submitted' then return;end if;
  select * into v_test from public.teaching_tests where id=v_attempt.test_id;
  v_end:=least(p_now,v_attempt.expires_at);
  update public.teaching_test_attempts set status='submitted',submitted_at=v_end,
    elapsed_seconds=greatest(0,extract(epoch from v_end-started_at)),auto_score=public.xelay_private_test_score(v_test.questions,answers,v_test.max_points),
    score=public.xelay_private_test_score(v_test.questions,answers,v_test.max_points),
    version=version+1 where id=p_attempt;
end $$;

create function public.xelay_private_test_view(p_test public.teaching_tests,p_user uuid,p_full boolean)
returns jsonb language sql stable security definer set search_path='' as $$
  select (to_jsonb(p_test)-'questions'-'targets')||jsonb_build_object('course_title',(select title from public.teaching_courses where id=p_test.course_id),
    'question_count',jsonb_array_length(p_test.questions),'questions',case when p_full then p_test.questions else '[]'::jsonb end,
    'targets',case when p_full then p_test.targets else coalesce((select jsonb_agg(t) from jsonb_array_elements(p_test.targets)t
      where public.xelay_private_test_allows(p_test,p_user,(t->>'group_id')::uuid)),'[]') end,
    'has_attempts',exists(select 1 from public.teaching_test_attempts where test_id=p_test.id),
    'can_edit',public.xelay_private_test_staff(p_test,p_user,'assignments',true) and public.xelay_private_test_staff(p_test,p_user,'grades',true),
    'can_review',public.xelay_private_test_staff(p_test,p_user,'grades',true),
    'my_attempt',(select jsonb_build_object('id',a.id,'status',case when a.status='submitted' or a.expires_at<=clock_timestamp() then 'submitted' else 'in_progress' end,
      'submitted_at',case when a.status='submitted' then a.submitted_at when a.expires_at<=clock_timestamp() then a.expires_at else null end,
      'published_score',g.published_score,'published_absent',coalesce((to_jsonb(g)->>'published_absent')::boolean,false),'grade_published_at',g.published_at)
      from public.teaching_test_attempts a left join public.teaching_grades g on g.id=a.grade_id
      where a.test_id=p_test.id and a.user_id=p_user and public.xelay_private_test_allows(p_test,p_user,a.group_id)));
$$;

create function public.xelay_private_test_attempt_view(p_attempt public.teaching_test_attempts,p_test public.teaching_tests,p_full boolean)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_question jsonb;v_result jsonb;v_deadline timestamptz;
begin
  v_result:=to_jsonb(p_attempt)||jsonb_build_object('student_name',(select full_name from public.profiles where id=p_attempt.user_id));
  if p_full then
    v_result:=(v_result-'question_reviews')||jsonb_build_object('current_grade',public.xelay_private_test_grade_snapshot(p_test.id,p_attempt.group_id,p_attempt.user_id),
      'question_results',(select jsonb_agg(jsonb_build_object(
      'question_id',q->>'id','automatic_points',round(public.xelay_private_test_question_points(q,p_attempt.answers->(q->>'id')),4),
      'points',case when coalesce(p_attempt.question_reviews->(q->>'id')->>'mode','auto')='auto'
        then round(public.xelay_private_test_question_points(q,p_attempt.answers->(q->>'id')),4) else(p_attempt.question_reviews->(q->>'id')->>'points')::numeric end,
      'max_points',(q->>'points')::numeric,'manual',coalesce(p_attempt.question_reviews->(q->>'id')->>'mode','auto')<>'auto',
      'mode',coalesce(p_attempt.question_reviews->(q->>'id')->>'mode','auto'),'reason',coalesce(p_attempt.question_reviews->(q->>'id')->>'reason',''),
      'reviewed_at',p_attempt.question_reviews->(q->>'id')->'reviewed_at','reviewed_by',p_attempt.question_reviews->(q->>'id')->'reviewed_by') order by n)
      from jsonb_array_elements(p_test.questions) with ordinality x(q,n)),
      'review_history',coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'question_id',h.question_id,'old_points',round(h.old_points,4),'new_points',round(h.new_points,4),
        'mode',h.mode,'reason',h.reason,'actor_name',p.full_name,'created_at',h.created_at) order by h.created_at,h.id)
        from public.teaching_test_review_audit h join public.profiles p on p.id=h.actor_id where h.attempt_id=p_attempt.id),'[]'));
  else
    v_result:=v_result-array['score','auto_score','question_reviews','bonus_score','final_score','rank','bonus_winner','grade_snapshot','grade_id','student_name'];
    v_question:=p_test.questions->p_attempt.current_index;
    if p_attempt.status='in_progress' then
      v_question:=v_question-'answer';
      if v_question->>'kind'='sequence' then
        v_question:=jsonb_set(v_question,'{options}',(select jsonb_agg(o order by md5(p_attempt.id::text||(o->>'id'))) from jsonb_array_elements(v_question->'options')o));
      end if;
      if nullif(v_question->>'time_limit_seconds','') is not null then
        v_deadline:=(p_attempt.opened_at->>(v_question->>'id'))::timestamptz+make_interval(secs=>(v_question->>'time_limit_seconds')::integer);
      end if;
      v_result:=v_result||jsonb_build_object('current_question',v_question,'question_expires_at',case when v_deadline is null then null else least(v_deadline,p_attempt.expires_at) end);
    else v_result:=v_result||jsonb_build_object('current_question',null);end if;
  end if;
  return v_result||coalesce((select jsonb_build_object('published_score',g.published_score,'published_comment',g.published_comment,
    'published_absent',coalesce((to_jsonb(g)->>'published_absent')::boolean,false),
    'grade_published_at',g.published_at,'grade_version',case when p_full then g.version else null end) from public.teaching_grades g where id=p_attempt.grade_id),'{}');
end $$;

create function public.xelay_teaching_test(p_test_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_test public.teaching_tests%rowtype;v_attempt public.teaching_test_attempts%rowtype;
  v_staff boolean;v_now timestamptz;v_expired record;
begin
  -- Details can finish an expired attempt. Use the same test-before-attempt
  -- order as mutations before touching either the teacher's or student's view.
  perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||p_test_id,0));
  select * into v_test from public.teaching_tests where id=p_test_id for update;
  v_now:=clock_timestamp();
  if not found then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  v_staff:=public.xelay_private_test_staff(v_test,v_uid,'assignments') or public.xelay_private_test_staff(v_test,v_uid,'grades');
  if not v_staff and (v_test.status='draft' or not public.xelay_private_test_allows(v_test,v_uid)) then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  if v_staff then
    for v_expired in select a.id from public.teaching_test_attempts a where a.test_id=p_test_id
      and a.status='in_progress' and a.expires_at<=v_now
      and 'grades'=any(public.xelay_teaching_group_permissions(v_test.course_id,a.group_id,v_uid)) order by a.id loop
      perform public.xelay_private_test_finish(v_expired.id,v_now);
    end loop;
  end if;
  select * into v_attempt from public.teaching_test_attempts where test_id=p_test_id and user_id=v_uid;
  if not v_staff and v_attempt.id is not null and not public.xelay_private_test_allows(v_test,v_uid,v_attempt.group_id) then
    raise exception 'TEST_FORBIDDEN' using errcode='42501';
  end if;
  if v_attempt.status='in_progress' and v_attempt.expires_at<=v_now then
    perform public.xelay_private_test_finish(v_attempt.id,v_now);
    select * into v_attempt from public.teaching_test_attempts where id=v_attempt.id;
  end if;
  return jsonb_build_object('test',public.xelay_private_test_view(v_test,v_uid,v_staff),'attempt',case when v_attempt.id is null then null else public.xelay_private_test_attempt_view(v_attempt,v_test,false) end,
    'attempts',case when v_staff then coalesce((select jsonb_agg(public.xelay_private_test_attempt_view(a,v_test,true) order by a.started_at)
      from public.teaching_test_attempts a where a.test_id=p_test_id and 'grades'=any(public.xelay_teaching_group_permissions(v_test.course_id,a.group_id,v_uid))),'[]') else '[]'::jsonb end,'server_now',v_now);
end $$;

create function public.xelay_teaching_tests(p_course_id uuid default null,p_group_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();
begin
  return jsonb_build_object('server_now',clock_timestamp(),'tests',coalesce((select jsonb_agg(public.xelay_private_test_view(t,v_uid,
    public.xelay_private_test_staff(t,v_uid,'assignments') or public.xelay_private_test_staff(t,v_uid,'grades')) order by t.created_at desc)
    from public.teaching_tests t where (p_course_id is null or t.course_id=p_course_id)
      and(p_group_id is null or exists(select 1 from jsonb_array_elements(t.targets)x where(x->>'group_id')::uuid=p_group_id))
      and(public.xelay_private_test_staff(t,v_uid,'assignments') or public.xelay_private_test_staff(t,v_uid,'grades')
        or t.status<>'draft' and public.xelay_private_test_allows(t,v_uid,p_group_id))),'[]'));
end $$;

create function public.xelay_private_test_sync_activities(p_test_id uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_test public.teaching_tests%rowtype;v_target jsonb;v_group uuid;v_activity public.teaching_activities%rowtype;v_id uuid;v_result jsonb;
begin
  select * into v_test from public.teaching_tests where id=p_test_id;
  for v_target in select value from jsonb_array_elements(v_test.targets) order by value->>'group_id' loop
    v_group:=(v_target->>'group_id')::uuid;
    perform public.xelay_private_assert_teaching_group(v_test.course_id,v_group,'grades');
    perform public.xelay_teaching_sync_roster(v_test.course_id,v_group);
    select a.* into v_activity from public.teaching_test_activities l join public.teaching_activities a on a.id=l.activity_id
      where l.test_id=p_test_id and l.group_id=v_group for update of a;
    if v_activity.id is not null and v_activity.title=v_test.title and v_activity.category=v_test.category and v_activity.work_type=v_test.work_type
      and v_activity.activity_date=v_test.journal_date and v_activity.max_points=v_test.max_points then continue;end if;
    v_id:=coalesce(v_activity.id,gen_random_uuid());
    v_result:=public.xelay_teaching_classified_activity(jsonb_build_object('id',v_id,'version',coalesce(v_activity.version,0),'expected_user_id',auth.uid(),
      'course_id',v_test.course_id,'group_id',v_group,'title',v_test.title,'category',v_test.category,'work_type',v_test.work_type,
      'activity_date',v_test.journal_date,'max_points',v_test.max_points));
    insert into public.teaching_test_activities(test_id,group_id,activity_id) values(p_test_id,v_group,v_id) on conflict(test_id,group_id) do nothing;
  end loop;
end $$;

create function public.xelay_private_test_grade_snapshot(p_test uuid,p_group uuid,p_user uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce((select jsonb_build_object('id',g.id,'version',g.version,'draft_score',g.draft_score,'draft_comment',g.draft_comment,
      'draft_absent',coalesce((to_jsonb(g)->>'draft_absent')::boolean,false),'published_score',g.published_score,
      'published_absent',coalesce((to_jsonb(g)->>'published_absent')::boolean,false))
    from public.teaching_test_activities l join public.teaching_entries e on e.group_id=l.group_id and e.user_id=p_user
    join public.teaching_activities a on a.id=l.activity_id and a.course_id=e.course_id
    join public.teaching_grades g on g.activity_id=a.id and g.entry_id=e.id where l.test_id=p_test and l.group_id=p_group),
    jsonb_build_object('id',null,'version',0));
$$;

-- A linked journal column uses the test's scale. Changing its maximum through
-- the regular journal editor would otherwise strand already submitted results.
-- The test constructor updates the definition before synchronising activities.
create function public.xelay_private_test_activity_maximum()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_max numeric;
begin
  if new.max_points is not distinct from old.max_points then return new;end if;
  select t.max_points into v_max from public.teaching_test_activities l
    join public.teaching_tests t on t.id=l.test_id where l.activity_id=new.id;
  if found and new.max_points is distinct from v_max then
    raise exception 'TEACHING_TEST_MAX_POINTS_LOCKED';
  end if;
  return new;
end $$;
create trigger xelay_test_activity_maximum before update of max_points on public.teaching_activities
for each row execute function public.xelay_private_test_activity_maximum();

create function public.xelay_teaching_test_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_uid uuid:=public.xelay_teaching_assert_user();v_id uuid:=(p_payload->>'id')::uuid;v_version integer:=coalesce((p_payload->>'version')::integer,0);
  v_test public.teaching_tests%rowtype;v_attempt public.teaching_test_attempts%rowtype;v_course uuid;v_group uuid;v_target jsonb;v_question jsonb;
  v_now timestamptz:=clock_timestamp();v_index integer;v_question_id text;v_deadline timestamptz;v_answer jsonb;v_activity uuid;v_entry uuid;v_grade public.teaching_grades%rowtype;
  v_result jsonb;v_rank integer:=0;v_bonus_count integer;v_score numeric;v_count integer;v_old_targets jsonb;
  v_mark jsonb;v_mode text;v_reason text;v_points numeric;v_old_points numeric;v_reviews jsonb;v_changed boolean:=false;v_snapshot jsonb;
  v_journal_date date;v_obsolete record;
begin
  if v_id is null or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>500000
    or(p_payload?'expected_user_id' and(p_payload->>'expected_user_id')::uuid is distinct from v_uid) then raise exception 'TEST_INVALID_INPUT';end if;
  -- A test row and its attempts always lock in this order. Starting and editing
  -- share the same key so an attempt can never use a half-updated definition.
  perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-test:'||v_id,0));
  select * into v_test from public.teaching_tests where id=v_id for update;
  v_now:=clock_timestamp();
  if p_action='save_test' then
    v_course:=coalesce(v_test.course_id,(p_payload->>'course_id')::uuid);
    perform public.xelay_teaching_lock_course(v_course,'assignments');
    if v_test.id is not null then
      if v_test.version<>v_version then raise exception 'TEST_CONFLICT';end if;
      if exists(select 1 from public.teaching_test_attempts where test_id=v_id) then raise exception 'TEST_IMMUTABLE';end if;
      v_old_targets:=v_test.targets;
      for v_target in select value from jsonb_array_elements(v_old_targets) loop
        perform public.xelay_private_assert_teaching_group(v_course,(v_target->>'group_id')::uuid,'assignments');
      end loop;
    elsif v_version<>0 then raise exception 'TEST_CONFLICT';end if;
    if p_payload->>'status' not in('draft','published','closed') or jsonb_typeof(p_payload->'targets') is distinct from 'array'
      or jsonb_array_length(p_payload->'targets') not between 1 and 100 or jsonb_typeof(p_payload->'questions') is distinct from 'array'
      or jsonb_array_length(p_payload->'questions') not between 1 and 100
      or (select count(distinct q->>'id') from jsonb_array_elements(p_payload->'questions')q)<>jsonb_array_length(p_payload->'questions')
      or (select count(distinct q->>'group_id') from jsonb_array_elements(p_payload->'targets')q)<>jsonb_array_length(p_payload->'targets')
      or exists(select 1 from jsonb_array_elements(p_payload->'questions')q where public.xelay_private_test_validate_question(q) is not true) then raise exception 'TEST_INVALID_INPUT';end if;
    for v_target in select value from jsonb_array_elements(p_payload->'targets') loop
      v_group:=(v_target->>'group_id')::uuid;
      perform public.xelay_private_assert_teaching_group(v_course,v_group,'assignments');
      perform public.xelay_private_assert_teaching_group(v_course,v_group,'grades');
      if coalesce(v_target->>'audience_mode','') not in('all','subgroups') then raise exception 'TEST_INVALID_INPUT';end if;
      perform public.xelay_private_validate_teaching_audience(v_course,null,v_target);
    end loop;
    if not exists(select 1 from public.teaching_courses c where c.id=v_course
      and((p_payload->>'opens_at')::timestamptz at time zone 'Europe/Kyiv')::date>=c.starts_on
      and((p_payload->>'closes_at')::timestamptz at time zone 'Europe/Kyiv')::date<=c.ends_on
      and(coalesce(p_payload->>'category','')='' or exists(select 1 from jsonb_array_elements(c.grading_rules->'categories')k where k->>'id'=p_payload->>'category')))
      or(p_payload->>'max_points')::numeric<=0 or scale((p_payload->>'max_points')::numeric)>2
      or(p_payload->>'bonus_points')::numeric<0 or scale((p_payload->>'bonus_points')::numeric)>2 then raise exception 'TEST_INVALID_INPUT';end if;
    v_journal_date:=coalesce(nullif(p_payload->>'journal_date','')::date,((p_payload->>'opens_at')::timestamptz at time zone 'Europe/Kyiv')::date);
    if not exists(select 1 from public.teaching_courses where id=v_course and v_journal_date between starts_on and ends_on)
      or length(btrim(coalesce(p_payload->>'work_type','Тест'))) not between 1 and 100 then raise exception 'TEST_INVALID_INPUT';end if;
    for v_obsolete in select l.group_id,l.activity_id from public.teaching_test_activities l where l.test_id=v_id
      and not exists(select 1 from jsonb_array_elements(p_payload->'targets')t where(t->>'group_id')::uuid=l.group_id) order by l.group_id loop
      perform public.xelay_private_assert_teaching_group(v_course,v_obsolete.group_id,'grades');
      -- Journal writers and grade requests also lock the course before the
      -- activity, so a new grade cannot race this empty-column removal.
      perform 1 from public.teaching_activities where id=v_obsolete.activity_id for update;
      if exists(select 1 from public.teaching_grades where activity_id=v_obsolete.activity_id)
        or exists(select 1 from public.teaching_grade_audit where activity_id=v_obsolete.activity_id)
        or exists(select 1 from public.teaching_grade_requests where activity_id=v_obsolete.activity_id)
        or exists(select 1 from public.teaching_grade_batch_receipts where activity_id=v_obsolete.activity_id) then
        raise exception 'TEST_TARGET_HAS_GRADES';
      end if;
      delete from public.teaching_test_activities where test_id=v_id and group_id=v_obsolete.group_id;
      delete from public.teaching_activities where id=v_obsolete.activity_id;
    end loop;
    insert into public.teaching_tests(id,course_id,title,description,status,opens_at,closes_at,duration_seconds,max_points,category,journal_date,work_type,allow_skip,allow_return,
      question_timer_policy,restrict_copy,bonus_percent,bonus_points,targets,questions,created_by)
    values(v_id,v_course,btrim(p_payload->>'title'),coalesce(p_payload->>'description',''),p_payload->>'status',(p_payload->>'opens_at')::timestamptz,
      (p_payload->>'closes_at')::timestamptz,(p_payload->>'duration_seconds')::integer,(p_payload->>'max_points')::numeric,coalesce(p_payload->>'category',''),v_journal_date,btrim(coalesce(p_payload->>'work_type','Тест')),
      (p_payload->>'allow_skip')::boolean,(p_payload->>'allow_return')::boolean,p_payload->>'question_timer_policy',(p_payload->>'restrict_copy')::boolean,
      (p_payload->>'bonus_percent')::integer,(p_payload->>'bonus_points')::numeric,p_payload->'targets',p_payload->'questions',v_uid)
    on conflict(id) do update set title=excluded.title,description=excluded.description,status=excluded.status,opens_at=excluded.opens_at,closes_at=excluded.closes_at,
      duration_seconds=excluded.duration_seconds,max_points=excluded.max_points,category=excluded.category,journal_date=excluded.journal_date,work_type=excluded.work_type,allow_skip=excluded.allow_skip,allow_return=excluded.allow_return,
      question_timer_policy=excluded.question_timer_policy,restrict_copy=excluded.restrict_copy,bonus_percent=excluded.bonus_percent,bonus_points=excluded.bonus_points,
      targets=excluded.targets,questions=excluded.questions,version=teaching_tests.version+1,updated_at=now();
    if p_payload->>'status'<>'draft' or exists(select 1 from public.teaching_test_activities where test_id=v_id) then
      perform public.xelay_private_test_sync_activities(v_id);
    end if;
    return public.xelay_teaching_test(v_id);
  end if;
  if v_test.id is null then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  if p_action='save_review' then
    select * into v_attempt from public.teaching_test_attempts where id=(p_payload->>'attempt_id')::uuid and test_id=v_id for update;
    if not found then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
    perform public.xelay_private_assert_teaching_group(v_test.course_id,v_attempt.group_id,'grades');
    if v_attempt.status<>'submitted' then raise exception 'TEST_REVIEW_REQUIRED';end if;
    if v_attempt.version<>v_version then raise exception 'TEST_CONFLICT';end if;
    if jsonb_typeof(p_payload->'marks') is distinct from 'array' or jsonb_array_length(p_payload->'marks') not between 1 and 100
      or(select count(distinct m->>'question_id') from jsonb_array_elements(p_payload->'marks')m)<>jsonb_array_length(p_payload->'marks') then raise exception 'TEST_INVALID_INPUT';end if;
    v_reviews:=v_attempt.question_reviews;
    for v_mark in select value from jsonb_array_elements(p_payload->'marks') loop
      v_question_id:=v_mark->>'question_id';v_mode:=coalesce(v_mark->>'mode','custom');v_reason:=btrim(coalesce(v_mark->>'reason',''));
      select q into v_question from jsonb_array_elements(v_test.questions)q where q->>'id'=v_question_id;
      if v_question is null or v_mode not in('auto','full','zero','custom') then raise exception 'TEST_INVALID_INPUT';end if;
      if length(v_reason) not between 2 and 2000 then raise exception 'TEST_REVIEW_REASON_REQUIRED';end if;
      if v_mode='auto' then v_points:=public.xelay_private_test_question_points(v_question,v_attempt.answers->v_question_id);
      elsif v_mode='full' then v_points:=(v_question->>'points')::numeric;
      elsif v_mode='zero' then v_points:=0;
      else
        if jsonb_typeof(v_mark->'points') is distinct from 'number' then raise exception 'TEST_INVALID_INPUT';end if;
        v_points:=(v_mark->>'points')::numeric;
        if v_points<0 or v_points>(v_question->>'points')::numeric or scale(v_points)>2 then raise exception 'TEST_INVALID_INPUT';end if;
      end if;
      if v_reviews->v_question_id->>'mode'=v_mode and(v_reviews->v_question_id->>'points')::numeric=v_points
        and v_reviews->v_question_id->>'reason'=v_reason and v_reviews->v_question_id->>'reviewed_by'=v_uid::text then continue;end if;
      v_old_points:=case when coalesce(v_reviews->v_question_id->>'mode','auto')='auto'
        then public.xelay_private_test_question_points(v_question,v_attempt.answers->v_question_id) else(v_reviews->v_question_id->>'points')::numeric end;
      insert into public.teaching_test_review_audit(test_id,attempt_id,question_id,actor_id,old_points,new_points,mode,reason)
        values(v_id,v_attempt.id,v_question_id,v_uid,v_old_points,v_points,v_mode,v_reason);
      v_reviews:=jsonb_set(v_reviews,array[v_question_id],jsonb_build_object('mode',v_mode,'points',v_points,'reason',v_reason,'reviewed_by',v_uid,'reviewed_at',v_now));
      v_changed:=true;
    end loop;
    if not v_changed then return public.xelay_teaching_test(v_id);end if;
    update public.teaching_test_attempts set question_reviews=v_reviews,score=public.xelay_private_test_effective_score(v_test.questions,answers,v_reviews,v_test.max_points),
      reviewed_at=null,review_note='',version=version+1 where id=v_attempt.id;
    -- A correction can change the entire competition order. Previous journal
    -- publications stay intact while every transfer requires fresh approval.
    update public.teaching_test_attempts set final_score=null,bonus_score=0,rank=null,bonus_winner=false,reviewed_at=null,version=version+1
      where test_id=v_id and(final_score is not null or bonus_score<>0 or rank is not null or bonus_winner or reviewed_at is not null);
    update public.teaching_tests set review_revision=review_revision+1,approved_revision=null,results_finalized_at=null,version=version+1,updated_at=now() where id=v_id;
    return public.xelay_teaching_test(v_id);
  end if;
  if p_action in('finalize_results','review_results') then
    perform public.xelay_teaching_lock_course(v_test.course_id,'grades');
    if not public.xelay_private_test_staff(v_test,v_uid,'grades',true) then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
    if p_action='finalize_results' then
      if v_test.results_finalized_at is not null and v_test.approved_revision=v_test.review_revision then
        if v_test.version<>v_version then return public.xelay_teaching_test(v_id);end if;
        -- Explicit reapproval refreshes journal snapshots without redistributing
        -- an already-confirmed competition ranking after membership changes.
        update public.teaching_test_attempts a set grade_snapshot=public.xelay_private_test_grade_snapshot(v_id,a.group_id,a.user_id),version=version+1 where test_id=v_id;
        update public.teaching_tests set version=version+1,updated_at=now() where id=v_id;
        return public.xelay_teaching_test(v_id);
      end if;
      if v_test.version<>v_version then raise exception 'TEST_CONFLICT';end if;
      if v_now<v_test.closes_at then raise exception 'TEST_RESULTS_NOT_READY';end if;
      for v_attempt in select * from public.teaching_test_attempts where test_id=v_id and status='in_progress' order by id for update loop
        perform public.xelay_private_test_finish(v_attempt.id,v_now);
      end loop;
      select ceil(count(*)*v_test.bonus_percent/100.0)::integer into v_bonus_count from public.teaching_test_attempts
        where test_id=v_id and status='submitted' and public.xelay_private_test_allows(v_test,user_id,group_id);
      for v_attempt in select * from public.teaching_test_attempts where test_id=v_id and status='submitted' order by score desc,elapsed_seconds,id for update loop
        if public.xelay_private_test_allows(v_test,v_attempt.user_id,v_attempt.group_id) then v_rank:=v_rank+1;end if;
        v_score:=least(v_test.max_points,v_attempt.score+case when public.xelay_private_test_allows(v_test,v_attempt.user_id,v_attempt.group_id)
          and v_rank<=v_bonus_count then v_test.bonus_points else 0 end);
        update public.teaching_test_attempts set bonus_score=v_score-score,final_score=v_score,
          rank=case when public.xelay_private_test_allows(v_test,v_attempt.user_id,v_attempt.group_id) then v_rank else null end,
          bonus_winner=public.xelay_private_test_allows(v_test,v_attempt.user_id,v_attempt.group_id) and v_rank<=v_bonus_count,
          grade_snapshot=public.xelay_private_test_grade_snapshot(v_id,v_attempt.group_id,v_attempt.user_id),version=version+1 where id=v_attempt.id;
      end loop;
      update public.teaching_tests set results_finalized_at=v_now,approved_revision=review_revision,status='closed',version=version+1,updated_at=now() where id=v_id;
    else
      if v_test.results_finalized_at is null or v_test.approved_revision is distinct from v_test.review_revision then raise exception 'TEST_REVIEW_REQUIRED';end if;
      if v_test.version<>v_version then raise exception 'TEST_CONFLICT';end if;
      for v_attempt in select * from public.teaching_test_attempts where test_id=v_id and reviewed_at is null order by group_id,id for update loop
        perform public.xelay_private_assert_teaching_group(v_test.course_id,v_attempt.group_id,'grades');
        perform public.xelay_teaching_sync_roster(v_test.course_id,v_attempt.group_id);
        select id into v_entry from public.teaching_entries where course_id=v_test.course_id and group_id=v_attempt.group_id and user_id=v_attempt.user_id and active;
        if v_entry is null or not public.xelay_private_test_allows(v_test,v_attempt.user_id,v_attempt.group_id) then
          update public.teaching_test_attempts set review_note='Доступ учасника змінився. Результат збережено, передавання в журнал очікує перевірки складу групи.',version=version+1
            where id=v_attempt.id and review_note='';
          continue;
        end if;
        select activity_id into v_activity from public.teaching_test_activities where test_id=v_id and group_id=v_attempt.group_id;
        if v_activity is null then raise exception 'TEST_REVIEW_REQUIRED';end if;
        select * into v_grade from public.teaching_grades where activity_id=v_activity and entry_id=v_entry for update;
        if v_attempt.grade_snapshot is null or (v_attempt.grade_snapshot->>'version')::integer is distinct from coalesce(v_grade.version,0)
          or nullif(v_attempt.grade_snapshot->>'id','')::uuid is distinct from v_grade.id then raise exception 'TEST_GRADE_CONFLICT';end if;
        select h.reason into v_reason from public.teaching_test_review_audit h where h.attempt_id=v_attempt.id order by h.created_at desc,h.id desc limit 1;
        v_result:=public.xelay_teaching_mutate('save_grade',jsonb_build_object('activity_id',v_activity,'entry_id',v_entry,'version',coalesce(v_grade.version,0),
          'score',v_attempt.final_score,'absent',false,'comment','Результат тесту перевірено викладачем.','reason','Перевірка тесту. '||left(coalesce(v_reason,'Результати підтверджено викладачем.'),1900)));
        update public.teaching_test_attempts set reviewed_at=v_now,review_note='',grade_id=(v_result->>'id')::uuid,version=version+1 where id=v_attempt.id;
      end loop;
    end if;
    return public.xelay_teaching_test(v_id);
  end if;
  if v_test.status='draft' or not public.xelay_private_test_allows(v_test,v_uid) then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  if v_test.created_by=v_uid or public.xelay_private_test_staff(v_test,v_uid,'assignments') or public.xelay_private_test_staff(v_test,v_uid,'grades') then
    raise exception 'TEST_FORBIDDEN' using errcode='42501';
  end if;
  select * into v_attempt from public.teaching_test_attempts where test_id=v_id and user_id=v_uid for update;
  v_now:=clock_timestamp();
  if v_attempt.id is not null and not public.xelay_private_test_allows(v_test,v_uid,v_attempt.group_id) then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  if p_action='start' then
    if v_attempt.id is not null then return public.xelay_teaching_test(v_id);end if;
    v_group:=(p_payload->>'group_id')::uuid;
    if not public.xelay_private_test_allows(v_test,v_uid,v_group) then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
    if v_test.status<>'published' or v_now<v_test.opens_at or v_now>=v_test.closes_at then raise exception 'TEST_NOT_OPEN';end if;
    insert into public.teaching_test_attempts(test_id,group_id,user_id,started_at,expires_at,opened_at)
      values(v_id,v_group,v_uid,v_now,least(v_test.closes_at,v_now+make_interval(secs=>v_test.duration_seconds)),jsonb_build_object(v_test.questions->0->>'id',v_now));
    return public.xelay_teaching_test(v_id);
  end if;
  if v_attempt.id is null then raise exception 'TEST_FORBIDDEN' using errcode='42501';end if;
  if v_attempt.status='submitted' then return public.xelay_teaching_test(v_id);end if;
  if v_attempt.expires_at<=v_now then perform public.xelay_private_test_finish(v_attempt.id,v_now);return public.xelay_teaching_test(v_id);end if;
  if v_attempt.version<>v_version then raise exception 'TEST_CONFLICT';end if;
  v_question:=v_test.questions->v_attempt.current_index;v_question_id:=v_question->>'id';
  if nullif(v_question->>'time_limit_seconds','') is not null then
    v_deadline:=(v_attempt.opened_at->>v_question_id)::timestamptz+make_interval(secs=>(v_question->>'time_limit_seconds')::integer);
  end if;
  if p_action='save_answer' then
    if p_payload->>'question_id' is distinct from v_question_id or v_question_id=any(v_attempt.locked) or v_deadline<=v_now then raise exception 'TEST_ANSWER_LOCKED';end if;
    v_answer:=p_payload->'answer';
    if not public.xelay_private_test_valid_answer(v_question,v_answer) then raise exception 'TEST_INVALID_INPUT';end if;
    if v_attempt.answers->v_question_id is not distinct from v_answer then return public.xelay_teaching_test(v_id);end if;
    update public.teaching_test_attempts set answers=jsonb_set(answers,array[v_question_id],coalesce(v_answer,'null')),version=version+1 where id=v_attempt.id;
  elsif p_action='navigate' then
    v_index:=(p_payload->>'index')::integer;
    if v_index=v_attempt.current_index then return public.xelay_teaching_test(v_id);end if;
    if v_index<0 or v_index>=jsonb_array_length(v_test.questions) or(v_index<v_attempt.current_index and not v_test.allow_return)
      or(v_index>v_attempt.current_index and v_index<>v_attempt.current_index+1)
      or(v_index<v_attempt.current_index and not(v_attempt.opened_at?(v_test.questions->v_index->>'id')))
      or(v_index>v_attempt.current_index and not v_test.allow_skip and coalesce(v_attempt.answers->v_question_id,'null') in('null'::jsonb,'{}'::jsonb)
        and(v_deadline is null or v_deadline>v_now)) then raise exception 'TEST_NAVIGATION_BLOCKED';end if;
    update public.teaching_test_attempts set current_index=v_index,opened_at=case when opened_at?(v_test.questions->v_index->>'id') then opened_at
        else opened_at||jsonb_build_object(v_test.questions->v_index->>'id',v_now) end,
      locked=case when(v_test.question_timer_policy='lock_on_leave' or not v_test.allow_return or v_deadline<=v_now) and not v_question_id=any(locked)
        then array_append(locked,v_question_id) else locked end,version=version+1 where id=v_attempt.id;
  elsif p_action='finish' then perform public.xelay_private_test_finish(v_attempt.id,v_now);
  else raise exception 'TEST_INVALID_INPUT';end if;
  return public.xelay_teaching_test(v_id);
exception when invalid_text_representation or numeric_value_out_of_range or check_violation or not_null_violation or datetime_field_overflow then
  raise exception 'TEST_INVALID_INPUT' using errcode='22023';
end $$;

revoke all on function public.xelay_private_test_staff(public.teaching_tests,uuid,text,boolean),public.xelay_private_test_allows(public.teaching_tests,uuid,uuid),
  public.xelay_private_test_validate_question(jsonb),public.xelay_private_test_valid_answer(jsonb,jsonb),public.xelay_private_test_score(jsonb,jsonb,numeric),
  public.xelay_private_test_question_points(jsonb,jsonb),public.xelay_private_test_effective_score(jsonb,jsonb,jsonb,numeric),
  public.xelay_private_test_sync_activities(uuid),public.xelay_private_test_grade_snapshot(uuid,uuid,uuid),
  public.xelay_private_test_activity_maximum(),
  public.xelay_private_test_finish(uuid,timestamptz),public.xelay_private_test_view(public.teaching_tests,uuid,boolean),
  public.xelay_private_test_attempt_view(public.teaching_test_attempts,public.teaching_tests,boolean),
  public.xelay_teaching_test(uuid),public.xelay_teaching_tests(uuid,uuid),public.xelay_teaching_test_mutate(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_test(uuid),public.xelay_teaching_tests(uuid,uuid),public.xelay_teaching_test_mutate(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
