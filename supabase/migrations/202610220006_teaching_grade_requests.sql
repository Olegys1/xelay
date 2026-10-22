-- Private student reminders about grading; no grade, submission or defense is
-- created or required by this workflow. Prepared only, not applied by this file's author.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $preflight$
begin
  if to_regprocedure('public.xelay_teaching_assert_user()') is null
    or to_regprocedure('public.xelay_teaching_permissions(uuid,uuid)') is null
    or to_regprocedure('public.xelay_teaching_is_member(uuid,uuid)') is null
    or to_regprocedure('public.xelay_teaching_notify(uuid,text,text,uuid,uuid,uuid)') is null
    or to_regclass('public.teaching_entries') is null
    or to_regclass('public.teaching_activities') is null
    or to_regclass('public.teaching_grade_requests') is not null then
    raise exception 'TEACHING_GRADE_REQUEST_PREREQUISITE_OR_STATE_CHANGED';
  end if;
end;
$preflight$;

create table public.teaching_grade_requests(
  id uuid primary key default gen_random_uuid(),
  course_id uuid not null references public.teaching_courses(id) on delete cascade,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  activity_id uuid not null references public.teaching_activities(id) on delete cascade,
  entry_id uuid not null references public.teaching_entries(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  message text not null check(length(btrim(message)) between 2 and 1000),
  status text not null default 'open' check(status in('open','resolved')),
  response text not null default '' check(length(response)<=2000),
  version integer not null default 1 check(version>0),
  created_at timestamptz not null default clock_timestamp(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles(id) on delete restrict,
  check((status='open' and resolved_at is null and resolved_by is null and response='')
    or(status='resolved' and resolved_at is not null and resolved_by is not null and length(btrim(response)) between 2 and 2000))
);
create unique index teaching_grade_requests_one_open_idx on public.teaching_grade_requests(activity_id,user_id) where status='open';
create index teaching_grade_requests_course_idx on public.teaching_grade_requests(course_id,status,created_at desc);
create index teaching_grade_requests_user_idx on public.teaching_grade_requests(user_id,created_at desc);
create table public.teaching_grade_request_receipts(
  user_id uuid not null references public.profiles(id) on delete cascade,
  request_id uuid not null,
  grade_request_id uuid not null references public.teaching_grade_requests(id) on delete cascade,
  activity_id uuid not null,
  message text not null,
  result jsonb not null,
  created_at timestamptz not null default clock_timestamp(),
  primary key(user_id,request_id)
);
create table public.teaching_grade_request_audit(
  id uuid primary key default gen_random_uuid(),
  grade_request_id uuid not null references public.teaching_grade_requests(id) on delete cascade,
  actor_id uuid not null references public.profiles(id) on delete restrict,
  event text not null check(event in('created','resolved')),
  version integer not null,
  response text not null default '',
  created_at timestamptz not null default clock_timestamp()
);
alter table public.teaching_grade_requests enable row level security;
alter table public.teaching_grade_request_receipts enable row level security;
alter table public.teaching_grade_request_audit enable row level security;
revoke all on public.teaching_grade_requests,public.teaching_grade_request_receipts,public.teaching_grade_request_audit
  from public,anon,authenticated,service_role;

-- Standalone journal activities are already visible upon creation under the
-- existing teaching-course read contract. Linked draft/scheduled assignments
-- never become available here merely because a grade/column happens to exist.
create function public.xelay_private_grade_request_activity_visible(p_activity uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.teaching_activities a where a.id=p_activity and(a.item_id is null
    or exists(select 1 from public.teaching_items i where i.id=a.item_id and i.course_id=a.course_id
      and i.kind='assignment' and i.status='published' and i.withdrawn_at is null)));
$$;
revoke all on function public.xelay_private_grade_request_activity_visible(uuid) from public,anon,authenticated,service_role;

create function public.xelay_teaching_grade_requests(p_course_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();
begin
  return jsonb_build_object(
    'requests',coalesce((select jsonb_agg(to_jsonb(r)||jsonb_build_object('course_title',c.title,'group_name',g.group_name,
      'activity_title',a.title,'student_name',e.full_name,
      'can_manage','grades'=any(public.xelay_teaching_permissions(c.id,v_uid)),
      'can_resolve',r.status='open' and c.archived_at is null and 'grades'=any(public.xelay_teaching_permissions(c.id,v_uid)))
      order by case when r.status='open' then 0 else 1 end,r.created_at desc,r.id)
      from public.teaching_grade_requests r join public.teaching_courses c on c.id=r.course_id
      join public.study_groups g on g.id=r.group_id
      join public.teaching_activities a on a.id=r.activity_id and a.course_id=r.course_id and a.group_id=r.group_id
      join public.teaching_entries e on e.id=r.entry_id and e.course_id=r.course_id and e.group_id=r.group_id and e.user_id=r.user_id
      where(p_course_id is null or c.id=p_course_id)
        and exists(select 1 from public.teaching_course_groups l where l.course_id=c.id and l.group_id=r.group_id and l.status='accepted')
        and public.xelay_private_grade_request_activity_visible(a.id)
        and('grades'=any(public.xelay_teaching_permissions(c.id,v_uid))
          or(r.user_id=v_uid and e.active and public.xelay_teaching_is_member(r.group_id,v_uid)))
    ),'[]'::jsonb),
    'available_activities',coalesce((select jsonb_agg(jsonb_build_object('activity_id',a.id,'activity_title',a.title,
      'activity_date',a.activity_date,'course_id',c.id,'course_title',c.title,'group_id',g.id,'group_name',g.group_name,'max_points',a.max_points)
      order by a.activity_date desc,a.title,a.id)
      from public.teaching_activities a join public.teaching_courses c on c.id=a.course_id
      join public.study_groups g on g.id=a.group_id
      where(p_course_id is null or c.id=p_course_id) and c.archived_at is null
        and public.xelay_private_grade_request_activity_visible(a.id)
        and exists(select 1 from public.teaching_entries e where e.course_id=a.course_id and e.group_id=a.group_id and e.user_id=v_uid and e.active)
        and exists(select 1 from public.teaching_course_groups l where l.course_id=a.course_id and l.group_id=a.group_id and l.status='accepted')
        and public.xelay_teaching_is_member(a.group_id,v_uid)
    ),'[]'::jsonb));
end $$;

create function public.xelay_teaching_request_grade(p_activity_id uuid,p_message text,p_request_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_activity public.teaching_activities%rowtype;
  v_entry public.teaching_entries%rowtype;v_request public.teaching_grade_requests%rowtype;
  v_receipt public.teaching_grade_request_receipts%rowtype;v_course public.teaching_courses%rowtype;
  v_message text:=btrim(coalesce(p_message,''));v_teacher uuid;v_result jsonb;v_existing boolean:=false;
begin
  if p_activity_id is null or p_request_id is null or length(v_message) not between 2 and 1000 then
    raise exception 'TEACHING_GRADE_REQUEST_INVALID' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:grade-request-user:'||v_uid::text,0));
  select * into v_receipt from public.teaching_grade_request_receipts where user_id=v_uid and request_id=p_request_id;
  if found then
    if v_receipt.activity_id is distinct from p_activity_id or v_receipt.message is distinct from v_message then raise exception 'TEACHING_CONFLICT'; end if;
    -- A replay is its historical receipt, never a live status/version probe after
    -- removal from the group or loss of activity visibility.
    return v_receipt.result;
  end if;
  -- Bound repeated new nonces too, including attempts to remind an already-open request.
  if(select count(*) from public.teaching_grade_request_receipts where user_id=v_uid and created_at>clock_timestamp()-interval '1 hour')>=60
    or(select count(*) from public.teaching_grade_request_receipts where user_id=v_uid and created_at>clock_timestamp()-interval '1 day')>=200 then
    raise exception 'TEACHING_GRADE_REQUEST_RATE_LIMIT'; end if;
  select * into v_activity from public.teaching_activities where id=p_activity_id;
  if not found then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  select * into v_course from public.teaching_courses where id=v_activity.course_id for update;
  select * into v_activity from public.teaching_activities where id=p_activity_id for update;
  if v_course.archived_at is not null or not public.xelay_private_grade_request_activity_visible(p_activity_id)
    or not public.xelay_teaching_is_member(v_activity.group_id,v_uid)
    or not exists(select 1 from public.teaching_course_groups l where l.course_id=v_activity.course_id and l.group_id=v_activity.group_id and l.status='accepted') then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  select * into v_entry from public.teaching_entries where course_id=v_activity.course_id and group_id=v_activity.group_id
    and user_id=v_uid and active for update;
  if not found then raise exception 'TEACHING_GRADE_REQUEST_ENTRY_REQUIRED'; end if;
  select * into v_request from public.teaching_grade_requests where activity_id=p_activity_id and user_id=v_uid and status='open' for update;
  v_existing:=found;
  if not v_existing then
    if(select count(*) from public.teaching_grade_requests where user_id=v_uid and created_at>clock_timestamp()-interval '1 hour')>=10
      or(select count(*) from public.teaching_grade_requests where user_id=v_uid and created_at>clock_timestamp()-interval '1 day')>=30
      or exists(select 1 from public.teaching_grade_requests where user_id=v_uid and activity_id=p_activity_id
        and created_at>clock_timestamp()-interval '1 day') then
      raise exception 'TEACHING_GRADE_REQUEST_RATE_LIMIT'; end if;
    insert into public.teaching_grade_requests(course_id,group_id,activity_id,entry_id,user_id,message)
      values(v_activity.course_id,v_activity.group_id,v_activity.id,v_entry.id,v_uid,v_message) returning * into v_request;
    insert into public.teaching_grade_request_audit(grade_request_id,actor_id,event,version)
      values(v_request.id,v_uid,'created',v_request.version);
    for v_teacher in select c.owner_id from public.teaching_courses c where c.id=v_activity.course_id
      union select t.user_id from public.teaching_course_teachers t where t.course_id=v_activity.course_id and t.status='accepted' loop
      if 'grades'=any(public.xelay_teaching_permissions(v_activity.course_id,v_teacher)) then
        perform public.xelay_teaching_notify(v_teacher,'grade-request:'||v_request.id::text,
          'Студент просить перевірити результат роботи «'||left(v_activity.title,180)||'».',v_activity.course_id,v_activity.group_id,v_uid);
      end if;
    end loop;
  end if;
  v_result:=jsonb_build_object('id',v_request.id,'version',v_request.version,'status',v_request.status,'existing',v_existing);
  insert into public.teaching_grade_request_receipts(user_id,request_id,grade_request_id,activity_id,message,result)
    values(v_uid,p_request_id,v_request.id,p_activity_id,v_message,v_result);
  return v_result;
end $$;

create function public.xelay_teaching_resolve_grade_request(p_request_id uuid,p_version integer,p_response text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_request public.teaching_grade_requests%rowtype;
  v_course uuid;v_response text:=btrim(coalesce(p_response,''));
begin
  if p_request_id is null or p_version is null or p_version<1 or length(v_response) not between 2 and 2000 then
    raise exception 'TEACHING_GRADE_REQUEST_INVALID' using errcode='22023'; end if;
  select course_id into v_course from public.teaching_grade_requests where id=p_request_id;
  if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
  perform public.xelay_teaching_lock_course(v_course,'grades');
  select * into v_request from public.teaching_grade_requests where id=p_request_id and course_id=v_course for update;
  if not exists(select 1 from public.teaching_course_groups l where l.course_id=v_course and l.group_id=v_request.group_id and l.status='accepted')
    or not public.xelay_private_grade_request_activity_visible(v_request.activity_id) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  if v_request.status='resolved' and v_request.response=v_response and v_request.resolved_by=v_uid
    and p_version in(v_request.version,v_request.version-1) then
    return jsonb_build_object('id',v_request.id,'version',v_request.version,'status',v_request.status);
  end if;
  if v_request.version is distinct from p_version or v_request.status<>'open' then raise exception 'TEACHING_CONFLICT'; end if;
  update public.teaching_grade_requests set status='resolved',response=v_response,resolved_by=v_uid,
    resolved_at=clock_timestamp(),version=version+1 where id=v_request.id returning * into v_request;
  insert into public.teaching_grade_request_audit(grade_request_id,actor_id,event,version,response)
    values(v_request.id,v_uid,'resolved',v_request.version,v_response);
  perform public.xelay_teaching_notify(v_request.user_id,'grade-request-resolved:'||v_request.id::text||':'||v_request.version::text,
    'Викладач відповів на ваше прохання перевірити результат. Перегляньте відповідь у розділі балів.',v_request.course_id,v_request.group_id,v_uid);
  return jsonb_build_object('id',v_request.id,'version',v_request.version,'status',v_request.status);
end $$;

revoke all on function public.xelay_teaching_grade_requests(uuid),public.xelay_teaching_request_grade(uuid,text,uuid),
  public.xelay_teaching_resolve_grade_request(uuid,integer,text) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_grade_requests(uuid),public.xelay_teaching_request_grade(uuid,text,uuid),
  public.xelay_teaching_resolve_grade_request(uuid,integer,text) to authenticated;
comment on table public.teaching_grade_requests is 'Private student grading reminders, independent of files, seminar reservations, defense completion and grades. One open reminder per user/activity; replies require current scoped grading rights.';
comment on table public.teaching_grade_request_receipts is 'Own-call idempotency keys. Different new keys for an already-open reminder map to its existing row without duplicate notifications.';
comment on table public.teaching_grade_request_audit is 'Server-only immutable-by-ACL creation/resolution record. Browser roles have no direct writes or reads.';
notify pgrst,'reload schema';
commit;
