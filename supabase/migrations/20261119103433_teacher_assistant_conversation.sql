-- Teacher conversation; private history and existing paid-period limits.
-- Replacing existing private functions preserves restricted grants.
begin;
create or replace function xelay_teacher_private.modes(p text)returns text[]language sql immutable set search_path=''as $$select case
 when p='teacher_max'then array['chat','questions','variants','tasks','rubric_review','quality','error_practice']
 when p='teacher_plus'then array['chat','questions','variants','tasks','rubric_review']
 when p='teacher_start'then array['chat','questions','variants','tasks']else '{}'::text[]end;$$;

create or replace function xelay_teacher_private.request_valid(r jsonb)returns boolean language plpgsql immutable set search_path=''as $$begin
 return coalesce(jsonb_typeof(r)='object'and octet_length(r::text)<=64000 and(r->>'requestId')~'^[a-f0-9-]{36}$'
 and r->>'kind'in('chat','questions','variants','tasks','rubric_review','quality','error_practice')and r->'consent'='true'::jsonb
 and(case when r->>'kind'='chat' then r->>'courseId'='' else (r->>'courseId')~'^[a-f0-9-]{36}$' end)and xelay_student_private.plain(r->>'prompt',2400)
 and jsonb_typeof(r->'groupIds')='array'and(case when r->>'kind'='chat' then jsonb_array_length(r->'groupIds')=0 else jsonb_array_length(r->'groupIds')between 1 and 10 end)
 and not exists(select 1 from jsonb_array_elements_text(r->'groupIds')g where g!~'^[a-f0-9-]{36}$')
 and(not(r?'parentId')or(r->>'kind'='chat'and(r->>'parentId')~'^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$'))
 and(r->>'kind'<>'chat'or not(r?|array['rubricText','submissionId','testId','questionCount','variantCount']))
 and coalesce(length(r->>'sourceText'),0)<=12000 and coalesce(length(r->>'rubricText'),0)<=4000
 and not exists(select 1 from jsonb_object_keys(r)k where not k=any(array['requestId','kind','courseId','groupIds','prompt','consent','sourceText','rubricText','submissionId','testId','questionCount','variantCount','parentId'])),false);
exception when others then return false;end$$;

create or replace function xelay_teacher_private.context(p_user_id uuid,r jsonb)returns jsonb language plpgsql stable security definer set search_path=''as $$
declare c public.teaching_courses;g uuid;groups jsonb:='[]';permission text;sub record;test public.teaching_tests;payload jsonb;errors jsonb;parent uuid;previous xelay_teacher_private.drafts;conversation jsonb:='[]';turn jsonb;seen uuid[]:='{}';begin
 if not xelay_teacher_private.request_valid(r)then raise exception 'TEACHER_AI_INVALID'using errcode='22023';end if;
 if not public.xelay_teaching_has_current_access(p_user_id)then raise exception 'TEACHER_VERIFIED_ACCESS_REQUIRED'using errcode='42501';end if;
 -- Only this teacher's stored conversation is included. Paid entitlement,
 -- session identity and the existing budget are checked by the public wrapper.
 if r->>'kind'='chat' then
  parent:=(r->>'parentId')::uuid;
  while parent is not null and cardinality(seen)<6 loop
   if parent=any(seen)then raise exception 'TEACHER_AI_INVALID'using errcode='22023';end if;
   select*into previous from xelay_teacher_private.drafts where id=parent and user_id=p_user_id and request->>'kind'='chat';
   if not found then raise exception 'TEACHER_CONVERSATION_FORBIDDEN'using errcode='42501';end if;
   turn:=jsonb_build_array(jsonb_build_object('user',left(previous.request->>'prompt',2400),'assistant',left(previous.bundle->>'summary',1400)));
   if octet_length((turn||conversation)::text)>8000 then exit;end if;
   conversation:=turn||conversation;seen:=array_append(seen,parent);
   parent:=(previous.request->>'parentId')::uuid;
  end loop;
  return jsonb_build_object('conversation',conversation);
 end if;
 select*into c from public.teaching_courses where id=(r->>'courseId')::uuid and archived_at is null;
 if not found then raise exception 'TEACHER_COURSE_FORBIDDEN'using errcode='42501';end if;
 permission:=case when r->>'kind'in('rubric_review','error_practice')then'grades'else'assignments'end;
 if not permission=any(public.xelay_teaching_permissions(c.id,p_user_id))then raise exception 'TEACHER_COURSE_FORBIDDEN'using errcode='42501';end if;
 for g in select value::uuid from jsonb_array_elements_text(r->'groupIds')loop
  if not permission=any(public.xelay_teaching_group_permissions(c.id,g,p_user_id))or not exists(select 1 from public.teaching_course_groups where course_id=c.id and group_id=g and status='accepted')then raise exception 'TEACHER_GROUP_FORBIDDEN'using errcode='42501';end if;
  groups:=groups||jsonb_build_array(jsonb_build_object('id',g,'name',(select group_name from public.study_groups where id=g)));
 end loop;
 if jsonb_array_length(groups)<>(select count(distinct x)from jsonb_array_elements_text(r->'groupIds')x)then raise exception 'TEACHER_DUPLICATE_GROUP'using errcode='22023';end if;
 payload:=jsonb_build_object('course',jsonb_build_object('id',c.id,'title',c.title,'version',c.version),'groups',groups);
 if r->>'kind'='rubric_review'then
  select s.id,s.version,s.body,s.item_id,i.title,i.body assignment_body,i.max_points,b.rubric,b.version rubric_version into sub
   from public.teaching_submissions s join public.teaching_items i on i.id=s.item_id join public.teaching_assignment_rubrics b on b.item_id=i.id
   where s.id=(r->>'submissionId')::uuid and s.course_id=c.id and s.group_id=any(array(select value::uuid from jsonb_array_elements_text(r->'groupIds')))
   and s.status in('submitted','reviewed')and i.kind='assignment'and i.max_points is not null;
  if not found or length(btrim(sub.body))=0 or length(sub.body)>12000 then raise exception 'TEACHER_REVIEW_TEXT_AND_RUBRIC_REQUIRED'using errcode='22023';end if;
  payload:=payload||jsonb_build_object('submission',jsonb_build_object('id',sub.id,'version',sub.version,'body',sub.body,'assignmentTitle',sub.title,'assignmentBody',left(sub.assignment_body,4000),'maximum',sub.max_points,'rubric',sub.rubric,'rubricVersion',sub.rubric_version));
 elsif r->>'kind'in('quality','error_practice')then
  select*into test from public.teaching_tests where id=(r->>'testId')::uuid and course_id=c.id;
  if not found or not public.xelay_private_test_staff(test,p_user_id,permission,false)then raise exception 'TEACHER_TEST_FORBIDDEN'using errcode='42501';end if;
  if jsonb_array_length(test.questions)>30 or octet_length(test.questions::text)>30000 then raise exception 'TEACHER_TEST_TOO_LARGE'using errcode='22023';end if;
  payload:=payload||jsonb_build_object('test',jsonb_build_object('id',test.id,'title',test.title,'version',test.version,'questions',test.questions));
  if r->>'kind'='error_practice'then
   if test.closes_at>clock_timestamp()or exists(select 1 from public.teaching_test_attempts a where a.test_id=test.id and a.group_id=any(array(select value::uuid from jsonb_array_elements_text(r->'groupIds')))and a.status='in_progress')then raise exception 'TEACHER_TEST_NOT_FINISHED'using errcode='PT409';end if;
   select coalesce(jsonb_agg(jsonb_build_object('question',z.question,'responses',z.responses,'errors',z.errors)order by z.errors desc),'[]')into errors from(
    select jsonb_build_object('id',q->>'id','kind',q->>'kind','text',q->>'text','options',q->'options','points',q->'points')question,
     count(*)::integer responses,count(*)filter(where public.xelay_private_test_question_points(q,a.answers->(q->>'id'))<(q->>'points')::numeric)::integer errors
    from public.teaching_test_attempts a cross join lateral jsonb_array_elements(a.questions)q
    where a.test_id=test.id and a.group_id=any(array(select value::uuid from jsonb_array_elements_text(r->'groupIds')))and a.status='submitted'and q->>'kind'<>'essay'
    group by jsonb_build_object('id',q->>'id','kind',q->>'kind','text',q->>'text','options',q->'options','points',q->'points')
    having count(*)filter(where public.xelay_private_test_question_points(q,a.answers->(q->>'id'))<(q->>'points')::numeric)>0
    order by errors desc limit 12)z;
   if jsonb_array_length(errors)=0 then raise exception 'TEACHER_NO_CONFIRMED_ERRORS'using errcode='22023';end if;
   payload:=payload||jsonb_build_object('actualErrors',errors);
  end if;
 end if;
 if octet_length(payload::text)>50000 then raise exception 'TEACHER_CONTEXT_TOO_LARGE'using errcode='22023';end if;
 return payload;
end$$;
commit;
