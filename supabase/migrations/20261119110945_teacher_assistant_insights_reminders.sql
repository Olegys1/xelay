-- Teacher-only analytics and personal scheduled reminders; no grade writes.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create or replace function xelay_teacher_private.modes(p text)returns text[]language sql immutable set search_path=''as $$select case
 when p='teacher_max'then array['chat','questions','variants','tasks','rubric_review','quality','error_practice','insights']
 when p='teacher_plus'then array['chat','questions','variants','tasks','rubric_review','insights']
 when p='teacher_start'then array['chat','questions','variants','tasks']else '{}'::text[]end;$$;

-- Existing validation remains the baseline. Insights read only an authorized scope.
alter function xelay_teacher_private.request_valid(jsonb) rename to request_valid_before_insights;
create function xelay_teacher_private.request_valid(r jsonb)returns boolean language plpgsql immutable set search_path=''as $$
declare base jsonb:=r;begin
 if r->>'kind'='insights' then
  if r ?| array['parentId','submissionId','questionCount','variantCount','rubricText'] then return false;end if;
  base:=jsonb_set(r-'testId','{kind}','"tasks"');
  if r?'testId' and not coalesce((r->>'testId')~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',false)then return false;end if;
 elsif r->>'kind' in('questions','variants','tasks') and r?'parentId' then
  if not coalesce((r->>'parentId')~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',false)then return false;end if;
  base:=r-'parentId';
 end if;
 return xelay_teacher_private.request_valid_before_insights(base);
end$$;
revoke all on function xelay_teacher_private.request_valid(jsonb) from public,anon,authenticated,service_role;

-- Optional proposed settings are inert until the teacher explicitly confirms the export form.
alter function xelay_teacher_private.bundle_valid(jsonb,jsonb)rename to bundle_valid_before_settings;
create function xelay_teacher_private.bundle_valid(v jsonb,r jsonb)returns boolean language plpgsql immutable set search_path=''as $$
declare c jsonb:=v->'testConditions';k text;begin
 if c is not null and c<>'null'::jsonb then
  if r->>'kind'not in('questions','variants','error_practice')or not xelay_student_private.fields(c,array['opensAt','closesAt','durationSeconds','allowSkip','allowReturn','restrictTabSwitch','requireAccessCode','shuffleQuestions','shuffleAnswers'])then return false;end if;
  foreach k in array array['opensAt','closesAt']loop
   if c->k<>'null'::jsonb and(jsonb_typeof(c->k)<>'string'or length(c->>k)>40 or(c->>k)!~'^\d{4}-\d{2}-\d{2}T'or not isfinite((c->>k)::timestamptz))then return false;end if;
  end loop;
  foreach k in array array['allowSkip','allowReturn','restrictTabSwitch','requireAccessCode','shuffleQuestions','shuffleAnswers']loop
   if jsonb_typeof(c->k)not in('boolean','null')then return false;end if;
  end loop;
  if c->'durationSeconds'<>'null'::jsonb and(jsonb_typeof(c->'durationSeconds')<>'number'or(c->>'durationSeconds')::numeric<>trunc((c->>'durationSeconds')::numeric)or(c->>'durationSeconds')::numeric not between 60 and 86400)then return false;end if;
  if(c->>'closesAt')::timestamptz<=(c->>'opensAt')::timestamptz then return false;end if;
 end if;
 return xelay_teacher_private.bundle_valid_before_settings(v-'testConditions',r);
exception when others then return false;end$$;
revoke all on function xelay_teacher_private.bundle_valid(jsonb,jsonb)from public,anon,authenticated,service_role;

-- Cheap permission check for saved analysis: never recompute a whole test while loading history.
create function xelay_teacher_private.insights_access(p_user uuid,p_course uuid,p_groups uuid[],p_test uuid)
returns void language plpgsql stable security definer set search_path=''as $$
declare g uuid;t public.teaching_tests;begin
 if not public.xelay_teaching_has_current_access(p_user)or p_groups is null or cardinality(p_groups)not between 1 and 10
 or array_position(p_groups,null)is not null or cardinality(p_groups)<>(select count(distinct x)from unnest(p_groups)x)
 or not exists(select 1 from public.teaching_courses where id=p_course and archived_at is null)
 then raise exception 'TEACHER_GROUP_FORBIDDEN'using errcode='42501';end if;
 foreach g in array p_groups loop
  if not 'grades'=any(public.xelay_teaching_group_permissions(p_course,g,p_user))
   or not exists(select 1 from public.teaching_course_groups where course_id=p_course and group_id=g and status='accepted')
  then raise exception 'TEACHER_GROUP_FORBIDDEN'using errcode='42501';end if;
 end loop;
 if p_test is not null then
  select*into t from public.teaching_tests where id=p_test and course_id=p_course;
  if not found or not public.xelay_private_test_staff(t,p_user,'grades',false)
   or not exists(select 1 from jsonb_array_elements(t.targets)x where(x->>'group_id')::uuid=any(p_groups))
  then raise exception 'TEACHER_TEST_FORBIDDEN'using errcode='42501';end if;
 end if;
end$$;
revoke all on function xelay_teacher_private.insights_access(uuid,uuid,uuid[],uuid)from public,anon,authenticated,service_role;

create function xelay_teacher_private.insights(p_user uuid,p_course uuid,p_groups uuid[],p_test uuid default null,p_names boolean default false)
returns jsonb language plpgsql stable security definer set search_path=''as $$
declare g uuid;e jsonb;groups jsonb:='[]';test public.teaching_tests;questions jsonb:='[]';learners jsonb:='[]';result jsonb;ready boolean:=false;total integer:=0;begin
 if not public.xelay_teaching_has_current_access(p_user)or p_groups is null or cardinality(p_groups)not between 1 and 10
 or array_position(p_groups,null)is not null or cardinality(p_groups)<>(select count(distinct x)from unnest(p_groups)x)
 then raise exception 'TEACHER_GROUP_FORBIDDEN'using errcode='42501';end if;
 perform xelay_teacher_private.insights_access(p_user,p_course,p_groups,p_test);
 e:=xelay_teacher_private.entitlement(p_user);
 if e->>'planId'not in('teacher_plus','teacher_max')or(cardinality(p_groups)>1 and e->>'planId'<>'teacher_max')
 then raise exception 'TEACHER_PLAN_REQUIRED'using errcode='42501';end if;
 if not exists(select 1 from public.teaching_courses where id=p_course and archived_at is null)
 then raise exception 'TEACHER_COURSE_FORBIDDEN'using errcode='42501';end if;
 foreach g in array p_groups loop
  if not 'grades'=any(public.xelay_teaching_group_permissions(p_course,g,p_user))
   or not exists(select 1 from public.teaching_course_groups where course_id=p_course and group_id=g and status='accepted')
  then raise exception 'TEACHER_GROUP_FORBIDDEN'using errcode='42501';end if;
  groups:=groups||jsonb_build_array(jsonb_build_object('id',g,'name',(select group_name from public.study_groups where id=g),
   'students',(select count(*)from public.teaching_entries where course_id=p_course and group_id=g and active),
   'publishedGrades',(select count(*)from public.teaching_grades where course_id=p_course and group_id=g and published_at is not null),
   'averagePercent',(select round(avg(gr.published_score/nullif(a.max_points,0)*100),1)from public.teaching_grades gr join public.teaching_activities a on a.id=gr.activity_id where gr.course_id=p_course and gr.group_id=g and gr.published_at is not null),
   'pendingReviews',(select count(*)from public.teaching_submissions where course_id=p_course and group_id=g and status='submitted'),
   'upcoming',coalesce((select jsonb_agg(jsonb_build_object('title',i.title,'dueAt',t.due_at)order by t.due_at)from public.teaching_items i join public.teaching_item_targets t on t.item_id=i.id where i.course_id=p_course and t.group_id=g and i.kind='assignment'and i.status='published'and i.withdrawn_at is null and t.due_at>=statement_timestamp()and t.due_at<statement_timestamp()+interval '7 days'),'[]')));
 end loop;
 if p_test is not null then
  select*into test from public.teaching_tests where id=p_test and course_id=p_course;
  if not found or not public.xelay_private_test_staff(test,p_user,'grades',false)
   or not exists(select 1 from jsonb_array_elements(test.targets)t where(t->>'group_id')::uuid=any(p_groups))
  then raise exception 'TEACHER_TEST_FORBIDDEN'using errcode='42501';end if;
  ready:=(test.status='closed' or test.closes_at<=statement_timestamp())and not exists(select 1 from public.teaching_test_attempts where test_id=p_test and group_id=any(p_groups)and status='in_progress');
  if ready then
   select count(*)into total from public.teaching_test_attempts where test_id=p_test and group_id=any(p_groups)and status='submitted';
   if total>500 then raise exception 'TEACHER_ANALYSIS_TOO_LARGE'using errcode='22023';end if;
   with rows as(
    select a.user_id,a.group_id,q.value q,'Q-'||left(md5((q.value->>'text')||'|'||(q.value->>'kind')),12) key,
     case when q.value->>'kind'='essay' and coalesce(a.question_reviews->(q.value->>'id')->>'mode','auto')='auto' then null
      when coalesce(a.question_reviews->(q.value->>'id')->>'mode','auto')<>'auto' then(a.question_reviews->(q.value->>'id')->>'points')::numeric
      else public.xelay_private_test_question_points(q.value,a.answers->(q.value->>'id')) end points
    from public.teaching_test_attempts a cross join lateral jsonb_array_elements(a.questions)q
    where a.test_id=p_test and a.group_id=any(p_groups)and a.status='submitted'
   ), grouped as(
    select key,min(q->>'text')text,min(q->>'kind')kind,count(*)responses,count(*)filter(where points is null)pending,
     count(*)filter(where points<(q->>'points')::numeric)mistakes
    from rows group by key order by count(*)filter(where points<(q->>'points')::numeric)desc,key limit 80
   )select coalesce(jsonb_agg(jsonb_build_object('key',key,'text',left(text,450),'kind',kind,'responses',responses,'mistakes',mistakes,'pendingReview',pending)),'[]')into questions from grouped;
   with rows as(
    select a.user_id,a.group_id,a.id,
     coalesce(jsonb_agg('Q-'||left(md5((q.value->>'text')||'|'||(q.value->>'kind')),12)order by q.n)filter(where
      case when q.value->>'kind'='essay'and coalesce(a.question_reviews->(q.value->>'id')->>'mode','auto')='auto'then false
       when coalesce(a.question_reviews->(q.value->>'id')->>'mode','auto')<>'auto'then(a.question_reviews->(q.value->>'id')->>'points')::numeric<(q.value->>'points')::numeric
       else public.xelay_private_test_question_points(q.value,a.answers->(q.value->>'id'))<(q.value->>'points')::numeric end),'[]')weak,
     count(*)filter(where q.value->>'kind'='essay'and coalesce(a.question_reviews->(q.value->>'id')->>'mode','auto')='auto')pending
    from public.teaching_test_attempts a cross join lateral jsonb_array_elements(a.questions)with ordinality q(value,n)
    where a.test_id=p_test and a.group_id=any(p_groups)and a.status='submitted'group by a.user_id,a.group_id,a.id
   )select coalesce(jsonb_agg(jsonb_build_object('code','S-'||left(md5(user_id::text||p_course::text),12),'groupId',group_id,'weak',weak,'pendingReview',pending)
     ||case when p_names then jsonb_build_object('name',coalesce((select full_name from public.profiles where id=rows.user_id),'Студент'))else'{}'end
     order by jsonb_array_length(weak)desc,user_id),'[]')into learners from rows;
  end if;
 end if;
 result:=jsonb_build_object('courseId',p_course,'courseTitle',(select title from public.teaching_courses where id=p_course),'groups',groups,
  'test',case when p_test is null then null else jsonb_build_object('id',test.id,'title',test.title,'ready',ready,'submitted',total)end,
  'questions',questions,'learners',learners,'notice','Бали — лише опубліковані. Помилки — фактичні втрачені бали у завершеному тесті; неперевірені відкриті відповіді не вважаємо помилками.');
 if not p_names then
  -- Bound provider payload without silently representing a partial sample as a whole cohort.
  result:=jsonb_set(result,'{learners}',coalesce((select jsonb_agg(jsonb_set(x,'{weak}',coalesce((select jsonb_agg(value)from(select value from jsonb_array_elements(x->'weak')limit 5)w),'[]'))||jsonb_build_object('weakTotal',jsonb_array_length(x->'weak')))from(select value x from jsonb_array_elements(learners)limit 100)s),'[]'));
  result:=jsonb_set(result,'{questions}',coalesce((select jsonb_agg(jsonb_set(x,'{text}',to_jsonb(left(x->>'text',250))))from(select value x from jsonb_array_elements(questions)limit 30)s),'[]'));
  result:=jsonb_set(result,'{groups}',(select jsonb_agg(jsonb_set(x,'{upcoming}',coalesce((select jsonb_agg(value)from(select value from jsonb_array_elements(x->'upcoming')limit 2)u),'[]')))from jsonb_array_elements(groups)x));
  while octet_length(result::text)>23000 and jsonb_array_length(result->'learners')>0 loop
   result:=jsonb_set(result,'{learners}',(result->'learners')-(jsonb_array_length(result->'learners')-1));
  end loop;
  while octet_length(result::text)>23000 and jsonb_array_length(result->'questions')>1 loop
   result:=jsonb_set(result,'{questions}',(result->'questions')-(jsonb_array_length(result->'questions')-1));
  end loop;
  result:=result||jsonb_build_object('learnersIncluded',jsonb_array_length(result->'learners'),'learnersTotal',total,'questionsIncluded',jsonb_array_length(result->'questions'),
   'coverage','Worst affected learners first, up to 5 weak question keys each. Most missed questions first. Up to 2 upcoming deadlines per group. Not the entire question set or all deadlines.');
 end if;
 if octet_length(result::text)>(case when p_names then 1000000 else 24000 end) then raise exception 'TEACHER_ANALYSIS_TOO_LARGE'using errcode='22023';end if;
 return result;
end$$;
revoke all on function xelay_teacher_private.insights(uuid,uuid,uuid[],uuid,boolean) from public,anon,authenticated,service_role;
create function public.xelay_teacher_ai_insights(p_course_id uuid,p_group_ids uuid[],p_test_id uuid default null)returns jsonb language plpgsql stable security definer set search_path=''as $$
begin return xelay_teacher_private.insights(xelay_student_private.caller(),p_course_id,p_group_ids,p_test_id,true)||jsonb_build_object('checkedAt',statement_timestamp());end$$;
revoke all on function public.xelay_teacher_ai_insights(uuid,uuid[],uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teacher_ai_insights(uuid,uuid[],uuid) to authenticated;

alter function xelay_teacher_private.context(uuid,jsonb) rename to context_before_insights;
create function xelay_teacher_private.context(p_user_id uuid,r jsonb)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare result jsonb;conversation jsonb;begin
 if not xelay_teacher_private.request_valid(r)then raise exception 'TEACHER_AI_INVALID'using errcode='22023';end if;
 if r->>'kind'='insights'then
  return xelay_teacher_private.insights(p_user_id,(r->>'courseId')::uuid,array(select value::uuid from jsonb_array_elements_text(r->'groupIds')),(r->>'testId')::uuid,false);
 end if;
 result:=xelay_teacher_private.context_before_insights(p_user_id,r-'parentId'||case when r->>'kind'='chat'and r?'parentId'then jsonb_build_object('parentId',r->'parentId')else'{}'end);
 if r->>'kind'in('questions','variants','tasks')and r?'parentId'then
  conversation:=xelay_teacher_private.context_before_insights(p_user_id,jsonb_build_object('requestId',r->'requestId','kind','chat','courseId','','groupIds','[]'::jsonb,'prompt',r->'prompt','consent',true,'parentId',r->'parentId'));
  result:=result||conversation;
 end if;
 return result;
end$$;
revoke all on function xelay_teacher_private.context(uuid,jsonb) from public,anon,authenticated,service_role;

create table xelay_teacher_private.reminders(
 id uuid primary key,user_id uuid not null references auth.users(id)on delete cascade,title text not null check(length(btrim(title))between 1 and 180),
 due_at timestamptz not null check(isfinite(due_at)),state text not null default 'pending'check(state in('pending','sent','cancelled')),
 created_at timestamptz not null default clock_timestamp(),sent_at timestamptz,notification_id text
);
alter table xelay_teacher_private.reminders enable row level security;
revoke all on xelay_teacher_private.reminders from public,anon,authenticated,service_role;
create index teacher_reminders_due_idx on xelay_teacher_private.reminders(due_at)where state='pending';
create index teacher_reminders_owner_idx on xelay_teacher_private.reminders(user_id,created_at desc);
create function public.xelay_teacher_ai_reminders(p_action text,p_payload jsonb default '{}')returns jsonb language plpgsql security definer set search_path=''as $$
declare u uuid:=xelay_student_private.caller();r xelay_teacher_private.reminders;e jsonb;begin
 if p_action='create'then
  e:=xelay_teacher_private.entitlement(u);
  if e->>'canEdit'<>'true'or not public.xelay_teaching_has_current_access(u)then raise exception 'TEACHER_PLAN_REQUIRED'using errcode='42501';end if;
  if not xelay_student_private.fields(p_payload,array['id','title','dueAt'])or not xelay_student_private.plain(p_payload->>'title',180)
   or not coalesce((p_payload->>'id')~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$',false)
  then raise exception 'TEACHER_REMINDER_INVALID'using errcode='22023';end if;
  perform pg_advisory_xact_lock(hashtextextended('teacher-reminder:'||u::text,0));
  select*into r from xelay_teacher_private.reminders where id=(p_payload->>'id')::uuid;
  if found then
   if r.user_id<>u or r.title<>p_payload->>'title'or r.due_at<>(p_payload->>'dueAt')::timestamptz then raise exception 'TEACHER_REMINDER_CONFLICT'using errcode='PT409';end if;
  else
   if not isfinite((p_payload->>'dueAt')::timestamptz)or(p_payload->>'dueAt')::timestamptz<clock_timestamp()+interval '15 seconds'
    or(p_payload->>'dueAt')::timestamptz>clock_timestamp()+interval '1 year'then raise exception 'TEACHER_REMINDER_TIME'using errcode='22023';end if;
   if(select count(*)from xelay_teacher_private.reminders where user_id=u and state='pending')>=100
    or(select count(*)from xelay_teacher_private.reminders where user_id=u and created_at>clock_timestamp()-interval '1 day')>=30
   then raise exception 'TEACHER_REMINDER_LIMIT'using errcode='PT429';end if;
   insert into xelay_teacher_private.reminders(id,user_id,title,due_at)values((p_payload->>'id')::uuid,u,p_payload->>'title',(p_payload->>'dueAt')::timestamptz);
  end if;
 elsif p_action='cancel'then
  if not xelay_student_private.fields(p_payload,array['id'])then raise exception 'TEACHER_REMINDER_INVALID'using errcode='22023';end if;
  update xelay_teacher_private.reminders set state='cancelled'where id=(p_payload->>'id')::uuid and user_id=u and state='pending';
 elsif p_action<>'list'or p_payload<>'{}'then raise exception 'TEACHER_REMINDER_INVALID'using errcode='22023';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('id',id,'title',title,'dueAt',due_at,'state',state)order by due_at)from(select*from xelay_teacher_private.reminders where user_id=u and state<>'cancelled'order by(state='pending')desc,due_at desc limit 100)s),'[]');
end$$;
revoke all on function public.xelay_teacher_ai_reminders(text,jsonb)from public,anon,authenticated,service_role;
grant execute on function public.xelay_teacher_ai_reminders(text,jsonb)to authenticated;

create policy "Teacher assistant reminders server insert"on public.notifications as restrictive for insert to anon,authenticated
 with check(type is distinct from 'teacher_assistant_organizer_reminder');
create function xelay_teacher_private.reminder_notice_guard()returns trigger language plpgsql set search_path=''as $$begin
 if(old.type='teacher_assistant_organizer_reminder'and(to_jsonb(new)-'is_read')is distinct from(to_jsonb(old)-'is_read'))
 or(old.type is distinct from'teacher_assistant_organizer_reminder'and new.type='teacher_assistant_organizer_reminder')
 then raise exception 'TEACHER_REMINDER_IMMUTABLE'using errcode='42501';end if;return new;end$$;
revoke all on function xelay_teacher_private.reminder_notice_guard()from public,anon,authenticated,service_role;
create trigger teacher_reminder_notice_guard before update on public.notifications for each row execute function xelay_teacher_private.reminder_notice_guard();

create function xelay_teacher_private.dispatch_reminders()returns integer language plpgsql security definer set search_path=''as $$
declare r xelay_teacher_private.reminders;n text;count integer:=0;begin
 for r in select*from xelay_teacher_private.reminders where state='pending'and due_at<=clock_timestamp()order by due_at limit 100 for update skip locked loop
  if not exists(select 1 from auth.users where id=r.user_id and deleted_at is null and coalesce(banned_until,'-infinity')<clock_timestamp())
   or not public.xelay_teaching_has_current_access(r.user_id)then update xelay_teacher_private.reminders set state='cancelled'where id=r.id;continue;end if;
  insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read)
   values(r.user_id,r.user_id,'Помічник викладача','teacher_assistant_organizer_reminder','Нагадування: '||r.title,false)returning id::text into n;
  update xelay_teacher_private.reminders set state='sent',sent_at=clock_timestamp(),notification_id=n where id=r.id;
  count:=count+1;
 end loop;return count;end$$;
revoke all on function xelay_teacher_private.dispatch_reminders()from public,anon,authenticated,service_role;
-- Scheduler runs as the database owner. No browser or public dispatch endpoint.
select cron.schedule('xelay-teacher-assistant-reminders','* * * * *','select xelay_teacher_private.dispatch_reminders()');
create table xelay_teacher_private.test_exports(
 user_id uuid not null references auth.users(id),draft_id uuid not null,test_id uuid not null references public.teaching_tests(id),
 conditions jsonb not null,primary key(user_id,draft_id)
);
alter table xelay_teacher_private.test_exports enable row level security;
revoke all on xelay_teacher_private.test_exports from public,anon,authenticated,service_role;
create function public.xelay_teacher_ai_create_test(p_draft_id uuid,p_conditions jsonb)returns jsonb language plpgsql security definer set search_path=''as $$
declare u uuid:=xelay_student_private.caller();d xelay_teacher_private.drafts;x xelay_teacher_private.test_exports;sets jsonb:='[]';questions jsonb;v integer;maxv integer;definition jsonb;result jsonb;begin
 perform pg_advisory_xact_lock(hashtextextended('teacher-export:'||u::text||p_draft_id::text,0));
 select*into d from xelay_teacher_private.drafts where user_id=u and id=p_draft_id;
 if not found or d.status<>'accepted'or d.request->>'kind'not in('questions','variants','error_practice')then raise exception 'TEACHER_DRAFT_FORBIDDEN'using errcode='42501';end if;
 perform xelay_teacher_private.context(u,d.request);
 if xelay_teacher_private.entitlement(u)->>'canEdit'<>'true'then raise exception 'TEACHER_PLAN_REQUIRED'using errcode='42501';end if;
 if not xelay_teacher_private.bundle_valid(d.bundle,d.request)then raise exception 'TEACHER_DRAFT_INVALID'using errcode='22023';end if;
 select*into x from xelay_teacher_private.test_exports where user_id=u and draft_id=p_draft_id;
 if found then
  if x.conditions is distinct from p_conditions then raise exception 'TEACHER_TEST_ALREADY_CREATED'using errcode='PT409';end if;
  return jsonb_build_object('testId',x.test_id,'replayed',true);end if;
 if exists(select 1 from public.teaching_tests where id=d.id)then raise exception 'TEACHER_DRAFT_CONFLICT'using errcode='PT409';end if;
 if not xelay_student_private.fields(p_conditions,array['opensAt','closesAt','durationSeconds','allowSkip','allowReturn','restrictTabSwitch','requireAccessCode','shuffleQuestions','shuffleAnswers'])
 or exists(select 1 from jsonb_each(p_conditions)e where e.key in('allowSkip','allowReturn','restrictTabSwitch','requireAccessCode','shuffleQuestions','shuffleAnswers')and jsonb_typeof(e.value)<>'boolean')
 or not isfinite((p_conditions->>'opensAt')::timestamptz)or not isfinite((p_conditions->>'closesAt')::timestamptz)
 or(p_conditions->>'closesAt')::timestamptz<=(p_conditions->>'opensAt')::timestamptz
 or(p_conditions->>'durationSeconds')::integer not between 30 and 86400 then raise exception 'TEACHER_TEST_CONDITIONS_INVALID'using errcode='22023';end if;
 select max((value->>'variant')::integer)into maxv from jsonb_array_elements(d.bundle->'questions');
 for v in 1..maxv loop
  select jsonb_agg(jsonb_build_object('id',(md5(d.id::text||(q->>'id')))::uuid,'kind','choice','text',q->>'text','points',q->'points','time_limit_seconds',null,'partial_credit',false,
   'options',(select jsonb_agg(jsonb_build_object('id','option-'||n,'text',value)order by n)from jsonb_array_elements_text(q->'choices')with ordinality choices(value,n)),
   'buckets','[]'::jsonb,'answer','option-'||((q->>'correctIndex')::integer+1))order by n)
   into questions from jsonb_array_elements(d.bundle->'questions')with ordinality qs(q,n)where(q->>'variant')::integer=v;
  sets:=sets||jsonb_build_array(jsonb_build_object('id',(md5(d.id::text||'variant'||v))::uuid,'title','Варіант '||v,'questions',questions));
 end loop;
 definition:=jsonb_build_object('id',d.id,'course_id',d.request->>'courseId','expected_user_id',u,'version',0,'title',d.bundle->>'title',
  'description',d.bundle->>'summary','status','draft','journal_date',((p_conditions->>'opensAt')::timestamptz at time zone 'Europe/Kyiv')::date,
  'work_type','Тест','opens_at',p_conditions->'opensAt','closes_at',p_conditions->'closesAt','duration_seconds',p_conditions->'durationSeconds',
  'max_points',(select sum((value->>'points')::numeric)from jsonb_array_elements(sets->0->'questions')),'category','',
  'allow_skip',p_conditions->'allowSkip','allow_return',p_conditions->'allowReturn','question_timer_policy','continue','restrict_copy',true,
  'bonus_percent',0,'bonus_points',0,'restrict_tab_switch',p_conditions->'restrictTabSwitch','require_access_code',p_conditions->'requireAccessCode',
  'shuffle_questions',p_conditions->'shuffleQuestions','shuffle_answers',p_conditions->'shuffleAnswers',
  'targets',(select jsonb_agg(jsonb_build_object('group_id',value,'audience_mode','all','subgroup_ids','[]'::jsonb))from jsonb_array_elements_text(d.request->'groupIds')),
  'questions',sets->0->'questions','base_variant_title','Варіант 1','variants',coalesce((select jsonb_agg(value)from jsonb_array_elements(sets)with ordinality a(value,n)where n>1),'[]'));
 result:=public.xelay_teaching_test_mutate('save_test',definition);
 insert into xelay_teacher_private.test_exports(user_id,draft_id,test_id,conditions)values(u,d.id,d.id,p_conditions);
 return jsonb_build_object('testId',d.id,'replayed',false);
end$$;
revoke all on function public.xelay_teacher_ai_create_test(uuid,jsonb)from public,anon,authenticated,service_role;
grant execute on function public.xelay_teacher_ai_create_test(uuid,jsonb)to authenticated;

create function xelay_teacher_private.saved_context_access(u uuid,r jsonb)returns void language plpgsql stable security definer set search_path=''as $$begin
 if not xelay_teacher_private.request_valid(r)then raise exception 'TEACHER_AI_INVALID'using errcode='22023';end if;
 if r->>'kind'='insights'then
  perform xelay_teacher_private.insights_access(u,(r->>'courseId')::uuid,array(select value::uuid from jsonb_array_elements_text(r->'groupIds')),(r->>'testId')::uuid);
 else perform xelay_teacher_private.context(u,r);end if;
end$$;
revoke all on function xelay_teacher_private.saved_context_access(uuid,jsonb)from public,anon,authenticated,service_role;
create or replace function public.xelay_teacher_ai_history()returns jsonb language plpgsql stable security definer set search_path=''as $$
declare u uuid:=xelay_student_private.caller();d xelay_teacher_private.drafts;result jsonb:='[]';entry jsonb;used integer:=2;cost integer;begin
 for d in select*from xelay_teacher_private.drafts where user_id=u order by created_at desc limit 50 loop
  begin
   perform xelay_teacher_private.saved_context_access(u,d.request);
   if not xelay_teacher_private.bundle_valid(d.bundle,d.request)or not xelay_teacher_private.text_valid(to_jsonb(d.teacher_notes),5000,true)then continue;end if;
   entry:=xelay_teacher_private.draft_json(d);cost:=octet_length(entry::text)+1;
   if used+cost>2097152 then exit;end if;
   result:=result||jsonb_build_array(entry);used:=used+cost;
  exception when others then null;end;
 end loop;return result;
end$$;
create or replace function public.xelay_teacher_ai_draft(p_id uuid)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare u uuid:=xelay_student_private.caller();d xelay_teacher_private.drafts;begin
 select*into d from xelay_teacher_private.drafts where user_id=u and id=p_id;
 if not found then raise exception 'TEACHER_DRAFT_FORBIDDEN'using errcode='42501';end if;
 perform xelay_teacher_private.saved_context_access(u,d.request);return xelay_teacher_private.draft_json(d);
end$$;

notify pgrst,'reload schema';
commit;
