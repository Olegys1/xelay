-- Local preparation only. Apply after teacher academic profiles (202610240002).
-- Academic messaging is a separate, revocable relationship; it never creates
-- an accepted friendship or exposes a login email/other students' identities.
begin;

do $$
begin
  if to_regprocedure('public.xelay_teacher_contacts(uuid,uuid)') is null
    or to_regprocedure('public.xelay_teaching_has_current_access(uuid)') is null
    or to_regprocedure('public.xelay_send_direct_message(uuid,uuid,text,uuid,jsonb)') is null then
    raise exception 'Apply teacher academic profiles and existing safe direct messaging first';
  end if;
end $$;

create table public.academic_direct_contexts (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  course_id uuid not null references public.teaching_courses(id) on delete cascade,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  teacher_id uuid not null references public.profiles(id) on delete cascade,
  student_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp(),
  last_opened_at timestamptz not null default clock_timestamp(),
  primary key(conversation_id,course_id,group_id),
  check(teacher_id<>student_id)
);
create index academic_direct_contexts_student_created_idx on public.academic_direct_contexts(student_id,created_at);
alter table public.academic_direct_contexts enable row level security;
revoke all on public.academic_direct_contexts from public,anon,authenticated,service_role;

create or replace function public.xelay_academic_teacher_link(p_teacher_id uuid,p_group_id uuid,p_student_id uuid default auth.uid())
returns boolean language sql stable security definer set search_path='' as $$
  select p_teacher_id is not null and p_teacher_id is distinct from p_student_id
    and public.xelay_teaching_is_member(p_group_id,p_student_id)
    and public.xelay_teaching_is_verified(p_teacher_id)
    and public.xelay_teaching_has_current_access(p_teacher_id)
    and exists(select 1 from public.teaching_courses c
      join public.teaching_course_groups l on l.course_id=c.id and l.group_id=p_group_id and l.status='accepted'
      where c.archived_at is null and cardinality(public.xelay_teaching_permissions(c.id,p_teacher_id))>0);
$$;

create or replace function public.xelay_academic_context_active(p_context public.academic_direct_contexts)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_academic_teacher_link(p_context.teacher_id,p_context.group_id,p_context.student_id)
    and exists(select 1 from public.teaching_courses c
      join public.teaching_course_groups l on l.course_id=c.id and l.group_id=p_context.group_id and l.status='accepted'
      where c.id=p_context.course_id and c.archived_at is null
        and cardinality(public.xelay_teaching_permissions(c.id,p_context.teacher_id))>0);
$$;

create or replace function public.xelay_academic_group_teachers(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_actor uuid:=public.xelay_teaching_assert_user();v_teachers jsonb;
begin
  if not public.xelay_teaching_is_member(p_group_id,v_actor) then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  with linked as (
    select c.id,c.owner_id as teacher_id,c.title,c.semester from public.teaching_courses c
      join public.teaching_course_groups l on l.course_id=c.id and l.group_id=p_group_id and l.status='accepted'
      where c.archived_at is null
    union
    select c.id,t.user_id,c.title,c.semester from public.teaching_courses c
      join public.teaching_course_groups l on l.course_id=c.id and l.group_id=p_group_id and l.status='accepted'
      join public.teaching_course_teachers t on t.course_id=c.id and t.status='accepted'
      where c.archived_at is null
  ), permitted as (
    select l.* from linked l where l.teacher_id<>v_actor
      and public.xelay_teaching_is_verified(l.teacher_id)
      and public.xelay_teaching_has_current_access(l.teacher_id)
      and cardinality(public.xelay_teaching_permissions(l.id,l.teacher_id))>0
  )
  select coalesce(jsonb_agg(teachers.item order by teachers.full_name),'[]'::jsonb) into v_teachers from (
    select p.full_name,
      public.xelay_teacher_contacts(p.id,p_group_id)||jsonb_build_object('user_id',p.id,'full_name',p.full_name,
        'courses',jsonb_agg(jsonb_build_object('id',l.id,'title',l.title,'semester',l.semester) order by l.title,l.id)) as item
      from permitted l join public.profiles p on p.id=l.teacher_id group by p.id,p.full_name
  ) teachers;
  return jsonb_build_object('teachers',v_teachers);
end $$;

create or replace function public.xelay_academic_open_conversation(p_teacher_id uuid,p_group_id uuid,p_course_id uuid,p_student_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_actor uuid:=public.xelay_teaching_assert_user();v_id uuid;v_existing public.academic_direct_contexts%rowtype;
begin
  if p_student_id is distinct from v_actor then raise exception 'CHAT_AUTH_CHANGED' using errcode='42501'; end if;
  if p_teacher_id is null or p_course_id is null or p_group_id is null or p_teacher_id=v_actor then
    raise exception 'ACADEMIC_RELATION_REQUIRED' using errcode='42501'; end if;
  -- The same pair lock as contact requests prevents duplicate pair creation.
  perform pg_advisory_xact_lock(hashtextextended('xelay-connection-pair:'||least(v_actor,p_teacher_id)::text||':'||greatest(v_actor,p_teacher_id)::text,0));
  perform pg_advisory_xact_lock(hashtextextended('xelay-academic-open:'||v_actor::text,0));
  if not public.xelay_academic_teacher_link(p_teacher_id,p_group_id,v_actor)
    or not exists(select 1 from public.teaching_courses c join public.teaching_course_groups l on l.course_id=c.id
      where c.id=p_course_id and c.archived_at is null and l.group_id=p_group_id and l.status='accepted'
        and cardinality(public.xelay_teaching_permissions(c.id,p_teacher_id))>0) then
    raise exception 'ACADEMIC_RELATION_REQUIRED' using errcode='42501'; end if;
  select id into v_id from public.conversations where user_one_id=least(v_actor,p_teacher_id) and user_two_id=greatest(v_actor,p_teacher_id);
  if v_id is null and ((select count(*) from public.academic_direct_contexts where student_id=v_actor and created_at>clock_timestamp()-interval '1 minute')>=10
    or (select count(*) from public.academic_direct_contexts where student_id=v_actor and created_at>clock_timestamp()-interval '1 day')>=50) then
    raise exception 'ACADEMIC_OPEN_RATE_LIMIT'; end if;
  if v_id is null then
    insert into public.conversations(user_one_id,user_two_id) values(least(v_actor,p_teacher_id),greatest(v_actor,p_teacher_id))
      on conflict(user_one_id,user_two_id) do nothing returning id into v_id;
    if v_id is null then select id into v_id from public.conversations where user_one_id=least(v_actor,p_teacher_id) and user_two_id=greatest(v_actor,p_teacher_id); end if;
  end if;
  perform 1 from public.conversations where id=v_id for update;
  select * into v_existing from public.academic_direct_contexts where conversation_id=v_id and course_id=p_course_id and group_id=p_group_id for update;
  if found and (v_existing.teacher_id<>p_teacher_id or v_existing.student_id<>v_actor) then raise exception 'ACADEMIC_RELATION_REQUIRED' using errcode='42501'; end if;
  insert into public.academic_direct_contexts(conversation_id,course_id,group_id,teacher_id,student_id)
    values(v_id,p_course_id,p_group_id,p_teacher_id,v_actor)
    on conflict(conversation_id,course_id,group_id) do update set last_opened_at=clock_timestamp();
  return jsonb_build_object('conversation_id',v_id);
end $$;

-- Locks the authorization rows used for a new send. Concurrent withdrawal of
-- a group membership, course link, verification or temporary teaching access
-- must serialize with the send; historical conversation SELECT remains intact.
create or replace function public.xelay_academic_assert_direct_send(p_conversation_id uuid,p_actor uuid)
returns void language plpgsql security definer set search_path='' as $$
declare v_conversation public.conversations%rowtype;v_context public.academic_direct_contexts%rowtype;
begin
  if auth.uid() is null or p_actor is distinct from auth.uid() then raise exception 'CHAT_AUTH_REQUIRED' using errcode='42501'; end if;
  select * into v_conversation from public.conversations where id=p_conversation_id and p_actor in(user_one_id,user_two_id) for update;
  if not found then raise exception 'CHAT_MEMBER_REQUIRED' using errcode='42501'; end if;
  perform 1 from public.connection_requests r where r.status='accepted'
    and least(r.requester_id,r.recipient_id)=v_conversation.user_one_id and greatest(r.requester_id,r.recipient_id)=v_conversation.user_two_id for share;
  if found then return; end if;
  for v_context in select * from public.academic_direct_contexts where conversation_id=p_conversation_id
    and p_actor in(teacher_id,student_id) order by course_id,group_id for share loop
    perform 1 from public.teaching_courses where id=v_context.course_id for share;
    perform 1 from public.teaching_course_groups where course_id=v_context.course_id and group_id=v_context.group_id for share;
    perform 1 from public.teaching_course_teachers where course_id=v_context.course_id and user_id=v_context.teacher_id for share;
    perform 1 from public.study_groups where id=v_context.group_id for share;
    perform 1 from public.study_group_members where group_id=v_context.group_id and user_id=v_context.student_id for share;
    perform 1 from public.teacher_verification_requests where user_id=v_context.teacher_id for share;
    perform 1 from public.teacher_academic_profiles where user_id=v_context.teacher_id for share;
    if public.xelay_academic_context_active(v_context) then return; end if;
  end loop;
  raise exception 'CHAT_CONNECTION_REQUIRED' using errcode='42501';
end $$;

-- Keep the existing direct-send implementation, including retry identity,
-- attachments, replies and abuse guards. Replace its one authorization gate.
do $extend_safe_send$
declare v_body text;v_old text;v_new text;
begin
  select replace(pg_get_functiondef('public.xelay_send_direct_message(uuid,uuid,text,uuid,jsonb)'::regprocedure),chr(13),'') into v_body;
  v_old:=$old$  perform 1 from public.connection_requests r
    where r.status='accepted'
      and least(r.requester_id,r.recipient_id)=v_conversation.user_one_id
      and greatest(r.requester_id,r.recipient_id)=v_conversation.user_two_id for share;
  if not found then raise exception 'CHAT_CONNECTION_REQUIRED' using errcode='42501'; end if;$old$;
  v_new:=$new$  perform public.xelay_academic_assert_direct_send(p_conversation_id,v_actor);$new$;
  v_old:=replace(v_old,chr(13),'');v_new:=replace(v_new,chr(13),'');
  if position(v_old in v_body)=0 or position(v_old in substring(v_body from position(v_old in v_body)+length(v_old)))>0 then
    raise exception 'Safe direct-send definition differs. Review its current authorization gate; no function was replaced.';
  end if;
  execute replace(v_body,v_old,v_new);
end $extend_safe_send$;

-- Existing scheduled sends keep their participant entitlement and delivery
-- checks. Academic conversations use the same live relationship authorization
-- when scheduled and again when the worker eventually sends the message.
do $extend_scheduled_send$
declare v_body text;v_old text;
begin
  if to_regprocedure('public.xelay_schedule_direct_message(uuid,uuid,uuid,text,timestamptz,uuid)') is not null then
    select replace(pg_get_functiondef('public.xelay_schedule_direct_message(uuid,uuid,uuid,text,timestamptz,uuid)'::regprocedure),chr(13),'') into v_body;
    v_old:=$old$  if not exists(select 1 from public.connection_requests r where r.status='accepted'
    and least(r.requester_id,r.recipient_id)=v_conversation.user_one_id and greatest(r.requester_id,r.recipient_id)=v_conversation.user_two_id) then raise exception 'CHAT_CONNECTION_REQUIRED' using errcode='42501'; end if;$old$;
    v_old:=replace(v_old,chr(13),'');
    if position(v_old in v_body)=0 then raise exception 'Scheduled direct-send authorization differs; review before applying'; end if;
    execute replace(v_body,v_old,'  perform public.xelay_academic_assert_direct_send(p_conversation_id,v_actor);');
  end if;
end $extend_scheduled_send$;

-- No new email data is exposed. Existing message notifications/preferences
-- remain authoritative, including deletion and delivery deduplication.
do $extend_email_eligibility$
declare v_body text;v_old text;v_new text;
begin
  if to_regprocedure('public.xelay_private_notification_email_message_state(uuid)') is not null then
    select replace(pg_get_functiondef('public.xelay_private_notification_email_message_state(uuid)'::regprocedure),chr(13),'') into v_body;
    v_old:=$old$  if not exists(select 1 from public.connection_requests r where r.status='accepted'
    and least(r.requester_id,r.recipient_id)=v_conversation.user_one_id
    and greatest(r.requester_id,r.recipient_id)=v_conversation.user_two_id) then$old$;
    v_new:=$new$  if not exists(select 1 from public.connection_requests r where r.status='accepted'
    and least(r.requester_id,r.recipient_id)=v_conversation.user_one_id
    and greatest(r.requester_id,r.recipient_id)=v_conversation.user_two_id)
    and not exists(select 1 from public.academic_direct_contexts x where x.conversation_id=v_conversation.id
      and public.xelay_academic_context_active(x)) then$new$;
    v_old:=replace(v_old,chr(13),'');v_new:=replace(v_new,chr(13),'');
    if position(v_old in v_body)=0 then raise exception 'Direct-message email eligibility differs; review before applying'; end if;
    execute replace(v_body,v_old,v_new);
  end if;
end $extend_email_eligibility$;

-- Plain INSERTs and chat-publication RPCs receive the same relationship gate.
-- The existing message trigger still performs its own atomic rate checks.
create or replace function public.xelay_academic_guard_direct_message()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  perform public.xelay_academic_assert_direct_send(new.conversation_id,new.sender_id);
  return new;
end $$;
create trigger xelay_academic_guard_direct_message before insert on public.messages
  for each row execute function public.xelay_academic_guard_direct_message();

create or replace function public.xelay_academic_conversation_context(p_conversation_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_actor uuid:=public.xelay_teaching_assert_user();v_conversation public.conversations%rowtype;v_contexts jsonb;v_friend boolean;v_academic boolean;
begin
  select * into v_conversation from public.conversations where id=p_conversation_id and v_actor in(user_one_id,user_two_id);
  if not found then raise exception 'CHAT_MEMBER_REQUIRED' using errcode='42501'; end if;
  select exists(select 1 from public.connection_requests r where r.status='accepted'
    and least(r.requester_id,r.recipient_id)=v_conversation.user_one_id and greatest(r.requester_id,r.recipient_id)=v_conversation.user_two_id) into v_friend;
  select exists(select 1 from public.academic_direct_contexts where conversation_id=p_conversation_id and v_actor in(teacher_id,student_id)) into v_academic;
  select coalesce(jsonb_agg(jsonb_build_object(
    'teacher_id',x.teacher_id,'teacher_name',tp.full_name,'student_id',x.student_id,'student_name',sp.full_name,
    'course_id',c.id,'course_title',c.title,'group_id',g.id,'group_name',g.group_name,'specialty',g.specialty,
    'academic_unit_name',a.name,'study_level',g.study_level,
    'study_year',case when public.xelay_current_academic_year()::integer-g.cohort_start_year+1 between 1 and 6
      then public.xelay_current_academic_year()::integer-g.cohort_start_year+1 else null end
  ) order by x.last_opened_at desc,c.id,g.id),'[]'::jsonb) into v_contexts
    from public.academic_direct_contexts x
    join public.teaching_courses c on c.id=x.course_id join public.study_groups g on g.id=x.group_id
    join public.profiles sp on sp.id=x.student_id join public.profiles tp on tp.id=x.teacher_id
    left join public.academic_units a on a.id=g.academic_unit_id and a.university_id=g.university_id
    where x.conversation_id=p_conversation_id and v_actor in(x.teacher_id,x.student_id)
      and public.xelay_academic_context_active(x);
  return jsonb_build_object('conversation_id',p_conversation_id,'is_academic',v_academic,
    'active',jsonb_array_length(v_contexts)>0,'can_send',v_friend or jsonb_array_length(v_contexts)>0,'contexts',v_contexts);
end $$;

revoke all on function public.xelay_academic_teacher_link(uuid,uuid,uuid),
  public.xelay_academic_context_active(public.academic_direct_contexts),
  public.xelay_academic_assert_direct_send(uuid,uuid),public.xelay_academic_guard_direct_message(),
  public.xelay_academic_group_teachers(uuid),public.xelay_academic_open_conversation(uuid,uuid,uuid,uuid),
  public.xelay_academic_conversation_context(uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_academic_group_teachers(uuid),
  public.xelay_academic_open_conversation(uuid,uuid,uuid,uuid),public.xelay_academic_conversation_context(uuid) to authenticated;

comment on table public.academic_direct_contexts is 'Private academic conversation provenance. RPC-only; every contact read and new academic-only send revalidates actual group membership, accepted course and teacher access.';
commit;
