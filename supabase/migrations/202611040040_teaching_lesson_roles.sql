-- Personal teaching responsibility is a calendar preference, never an access
-- permission. Existing authorization, timetable, homework and grades are kept.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $preflight$
begin
  if to_regprocedure('public.xelay_teaching_assert_user()') is null
    or to_regprocedure('public.xelay_private_assert_teacher_current_access(uuid)') is null
    or to_regprocedure('public.xelay_teaching_group_permissions(uuid,uuid,uuid)') is null
    or to_regprocedure('public.xelay_study_group_is_listed(uuid)') is null
    or to_regprocedure('public.xelay_teaching_calendar(date,date)') is null
    or to_regprocedure('public.xelay_private_calendar_before_homework_20261104(date,date)') is null
    or to_regprocedure('public.xelay_teaching_calendar_assign(uuid,uuid,uuid,text,boolean)') is null
    or to_regclass('public.teaching_calendar_assignments') is null then
    raise exception 'TEACHING_LESSON_ROLE_PREREQUISITES_MISSING';
  end if;
end $preflight$;

create table public.teaching_lesson_roles (
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null,
  group_id uuid not null,
  lesson_types text[] not null,
  version integer not null default 1 check(version>=1),
  updated_at timestamptz not null default now(),
  primary key(user_id,course_id,group_id),
  foreign key(course_id,group_id) references public.teaching_course_groups(course_id,group_id) on delete cascade,
  constraint teaching_lesson_roles_types_valid check(
    cardinality(lesson_types)<=10 and coalesce(array_ndims(lesson_types),1)=1
    and array_position(lesson_types,null) is null
    and lesson_types<@array['lecture','seminar','practical','lab','makeup','replacement','module','final_assessment','test','other']::text[])
);
alter table public.teaching_lesson_roles enable row level security;
revoke all on public.teaching_lesson_roles from public,anon,authenticated,service_role;
comment on table public.teaching_lesson_roles is 'Self-selected lesson types for a current authorized teacher/course/group. This preference grants no permissions.';

-- All old positive markers keep their exact keys and remain positive. A false
-- row is an explicit personal exclusion which survives later role changes.
alter table public.teaching_calendar_assignments add column assigned boolean not null default true;

create function public.xelay_private_teaching_lesson_roles(p_user_id uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object('course_id',c.id,'course_title',c.title,
    'group_id',g.id,'group_name',g.group_name,'lesson_types',coalesce(r.lesson_types,'{}'::text[]),
    'version',coalesce(r.version,0)) order by c.title,g.group_name,c.id,g.id),'[]'::jsonb)
  from public.teaching_courses c
  join public.teaching_course_groups l on l.course_id=c.id and l.status='accepted'
  join public.study_groups g on g.id=l.group_id
  left join public.teaching_lesson_roles r on r.user_id=p_user_id and r.course_id=c.id and r.group_id=l.group_id
  where c.archived_at is null and public.xelay_teaching_has_current_access(p_user_id)
    and cardinality(public.xelay_teaching_group_permissions(c.id,l.group_id,p_user_id))>0
    and public.xelay_study_group_is_listed(g.id);
$$;
revoke all on function public.xelay_private_teaching_lesson_roles(uuid) from public,anon,authenticated,service_role;

create function public.xelay_teaching_lesson_role_save(
  p_course_id uuid,p_group_id uuid,p_lesson_types text[],p_version integer,p_expected_user_id uuid
)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare
  v_uid uuid:=public.xelay_teaching_assert_user();
  v_allowed constant text[]:=array['lecture','seminar','practical','lab','makeup','replacement','module','final_assessment','test','other'];
  v_types text[];v_role public.teaching_lesson_roles%rowtype;v_course_title text;v_group_name text;
begin
  if p_expected_user_id is distinct from v_uid then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501'; end if;
  if p_course_id is null or p_group_id is null or p_version is null or p_version<0 or p_version>=2147483647
    or p_lesson_types is null or cardinality(p_lesson_types)>10
    or coalesce(array_ndims(p_lesson_types),1)<>1
    or(cardinality(p_lesson_types)>0 and array_lower(p_lesson_types,1)<>1) then
    raise exception 'TEACHING_LESSON_ROLE_INVALID' using errcode='22023';
  end if;
  -- Shape must be checked before array_position, which rejects multidimensional
  -- arrays itself. Keep malformed input on the documented invalid-input path.
  if array_position(p_lesson_types,null) is not null
    or not(p_lesson_types<@v_allowed)
    or cardinality(p_lesson_types)<>(select count(distinct t) from unnest(p_lesson_types)t) then
    raise exception 'TEACHING_LESSON_ROLE_INVALID' using errcode='22023';
  end if;
  -- The shared course lock serializes preference changes with permission,
  -- group connection and semester changes. No access is inferred from roles.
  select title into v_course_title from public.teaching_courses
    where id=p_course_id and archived_at is null for update;
  if not found then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  perform public.xelay_private_assert_teacher_current_access(v_uid);
  if cardinality(public.xelay_teaching_group_permissions(p_course_id,p_group_id,v_uid))=0
    or not public.xelay_study_group_is_listed(p_group_id) then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  select g.group_name into v_group_name from public.teaching_course_groups l
    join public.study_groups g on g.id=l.group_id
    where l.course_id=p_course_id and l.group_id=p_group_id and l.status='accepted' for share of l;
  if not found then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  select coalesce(array_agg(t order by array_position(v_allowed,t)),'{}'::text[]) into v_types from unnest(p_lesson_types)t;
  select * into v_role from public.teaching_lesson_roles
    where user_id=v_uid and course_id=p_course_id and group_id=p_group_id for update;
  if not found then
    if p_version<>0 then raise exception 'TEACHING_LESSON_ROLE_VERSION_CONFLICT' using errcode='P0001'; end if;
    insert into public.teaching_lesson_roles(user_id,course_id,group_id,lesson_types)
      values(v_uid,p_course_id,p_group_id,v_types) returning * into v_role;
  else
    if v_role.version<>p_version then raise exception 'TEACHING_LESSON_ROLE_VERSION_CONFLICT' using errcode='P0001'; end if;
    update public.teaching_lesson_roles set lesson_types=v_types,version=version+1,updated_at=clock_timestamp()
      where user_id=v_uid and course_id=p_course_id and group_id=p_group_id returning * into v_role;
  end if;
  return jsonb_build_object('course_id',p_course_id,'course_title',v_course_title,'group_id',p_group_id,
    'group_name',v_group_name,'lesson_types',v_role.lesson_types,'version',v_role.version);
end $$;
revoke all on function public.xelay_teaching_lesson_role_save(uuid,uuid,text[],integer,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_lesson_role_save(uuid,uuid,text[],integer,uuid) to authenticated;

-- Preserve the complete installed calendar chain (current scoped access,
-- hidden test groups, recurrence, links and homework) rather than rebuilding it.
alter function public.xelay_teaching_calendar(date,date) rename to xelay_private_calendar_before_lesson_roles_20261104;
revoke all on function public.xelay_private_calendar_before_lesson_roles_20261104(date,date) from public,anon,authenticated,service_role;

create function public.xelay_teaching_calendar(p_from date,p_to date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_calendar jsonb;v_roles jsonb;v_lessons jsonb;
begin
  v_calendar:=public.xelay_private_calendar_before_lesson_roles_20261104(p_from,p_to);
  v_roles:=public.xelay_private_teaching_lesson_roles(v_uid);
  select coalesce(jsonb_agg(l.value||jsonb_build_object(
    'assigned_to_me',coalesce(own.assigned,role_match.matches),
    'assignment_source',case when own.user_id is not null then 'manual' when role_match.matches then 'role' else 'none' end)
    order by l.ordinality),'[]'::jsonb) into v_lessons
    from jsonb_array_elements(v_calendar->'lessons') with ordinality l(value,ordinality)
    left join public.teaching_calendar_assignments own on own.user_id=v_uid
      and own.course_id=(l.value->>'course_id')::uuid and own.group_id=(l.value->>'group_id')::uuid
      and own.schedule_id=(l.value->>'id')::uuid and own.source=l.value->>'source'
    cross join lateral(select exists(select 1 from jsonb_array_elements(v_roles) r
      where r->>'course_id'=l.value->>'course_id' and r->>'group_id'=l.value->>'group_id'
        and coalesce(r->'lesson_types','[]'::jsonb) ? (l.value->>'lesson_type')) matches) role_match;
  return v_calendar||jsonb_build_object('lessons',v_lessons,'teaching_roles',v_roles);
end $$;
revoke all on function public.xelay_teaching_calendar(date,date) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_calendar(date,date) to authenticated;

alter function public.xelay_teaching_calendar_assign(uuid,uuid,uuid,text,boolean)
  rename to xelay_private_calendar_assign_before_lesson_roles_20261104;
revoke all on function public.xelay_private_calendar_assign_before_lesson_roles_20261104(uuid,uuid,uuid,text,boolean)
  from public,anon,authenticated,service_role;

create function public.xelay_teaching_calendar_assign(
  p_course_id uuid,p_group_id uuid,p_schedule_id uuid,p_source text,p_assigned boolean
)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_current boolean;
begin
  -- An existing current timetable tuple uses the original positive validation,
  -- including current verification and exact group-scoped authority. That also
  -- prevents creating a negative override for a phantom or unrelated schedule.
  select p_source='timetable' and exists(select 1 from public.study_group_schedule s
    join public.teaching_course_groups l on l.group_id=s.group_id and l.course_id=p_course_id and l.status='accepted'
    join public.teaching_courses c on c.id=l.course_id
    left join public.study_group_seminar_subjects sub on sub.id=l.subject_id and sub.group_id=l.group_id
    where s.id=p_schedule_id and s.group_id=p_group_id
      and public.xelay_academic_subject_key(s.subject)=public.xelay_academic_subject_key(coalesce(sub.name,c.title))) into v_current;
  if p_assigned is null or p_source is null or p_source not in('timetable','seminar') then
    raise exception 'TEACHING_INVALID_INPUT' using errcode='22023'; end if;
  if v_current or p_assigned then
    perform public.xelay_private_calendar_assign_before_lesson_roles_20261104(p_course_id,p_group_id,p_schedule_id,p_source,true);
    update public.teaching_calendar_assignments set assigned=p_assigned
      where user_id=v_uid and course_id=p_course_id and group_id=p_group_id and schedule_id=p_schedule_id and source=p_source;
    return jsonb_build_object('assigned',p_assigned,'assignment_source','manual');
  end if;
  -- Legacy seminar/deleted-row marks can still be removed through the original
  -- authorized cleanup path. No new invalid negative marker is created.
  perform public.xelay_private_calendar_assign_before_lesson_roles_20261104(p_course_id,p_group_id,p_schedule_id,p_source,false);
  return jsonb_build_object('assigned',false,'assignment_source','none');
end $$;
revoke all on function public.xelay_teaching_calendar_assign(uuid,uuid,uuid,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_calendar_assign(uuid,uuid,uuid,text,boolean) to authenticated;

notify pgrst,'reload schema';
commit;
