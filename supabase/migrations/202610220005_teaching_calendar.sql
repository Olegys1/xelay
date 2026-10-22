-- Personal view over accepted teaching subjects. A personal marker grants no
-- access and never edits the group's schedule, assignments or journal.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$ begin
  if to_regprocedure('public.xelay_teaching_assert_user()') is null
    or to_regprocedure('public.xelay_academic_subject_key(text)') is null
    or to_regprocedure('public.xelay_seminar_schedule_occurs_on_date(public.study_group_seminar_schedule,date)') is null then
    raise exception 'TEACHING_CALENDAR_PREREQUISITES_MISSING';
  end if;
end $$;

create table public.teaching_calendar_assignments (
  user_id uuid not null references public.profiles(id) on delete cascade,
  course_id uuid not null references public.teaching_courses(id) on delete cascade,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  schedule_id uuid not null,
  source text not null check(source in('timetable','seminar')),
  created_at timestamptz not null default now(),
  primary key(user_id,course_id,group_id,schedule_id,source)
);
alter table public.teaching_calendar_assignments enable row level security;
revoke all on public.teaching_calendar_assignments from public,anon,authenticated,service_role;

create function public.xelay_teaching_calendar(p_from date,p_to date)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_result jsonb;
begin
  if p_from is null or p_to is null or not isfinite(p_from) or not isfinite(p_to)
    or p_to<p_from or p_to-p_from>30 then
    raise exception 'TEACHING_CALENDAR_RANGE_INVALID' using errcode='22023';
  end if;
  with allowed as (
    select c.id course_id,c.title course_title,c.starts_on,c.ends_on,l.group_id,
      g.group_name,coalesce(sub.name,c.title) subject_name,l.subject_id
    from public.teaching_courses c join public.teaching_course_groups l on l.course_id=c.id and l.status='accepted'
    join public.study_groups g on g.id=l.group_id
    left join public.study_group_seminar_subjects sub on sub.id=l.subject_id and sub.group_id=l.group_id
    where c.archived_at is null and cardinality(public.xelay_teaching_permissions(c.id,v_uid))>0
      and c.starts_on<=p_to and c.ends_on>=p_from
  ), days as (
    select p_from+n lesson_date from generate_series(0,p_to-p_from) n
  ), occurrences as (
    select a.course_id,a.course_title,a.group_id,a.group_name,a.subject_name,
      s.id,d.lesson_date,s.starts_at,s.ends_at,s.lesson_type,coalesce(s.location,'') location,'timetable'::text source
    from allowed a join public.study_group_schedule s on s.group_id=a.group_id
      and public.xelay_academic_subject_key(s.subject)=public.xelay_academic_subject_key(a.subject_name)
    cross join days d
    where d.lesson_date between a.starts_on and a.ends_on
      and public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,s.week_pattern,s.week_anchor_date,d.lesson_date)
      and not(d.lesson_date=any(s.excluded_dates))
    union all
    select a.course_id,a.course_title,a.group_id,a.group_name,sub.name,
      s.id,d.lesson_date,coalesce(se.starts_at,s.starts_at),coalesce(se.ends_at,s.ends_at),'seminar'::text,''::text,'seminar'::text
    from allowed a join public.study_group_seminar_schedule s on s.group_id=a.group_id
    join public.study_group_seminar_subjects sub on sub.id=s.subject_id and sub.group_id=s.group_id
      and public.xelay_academic_subject_key(sub.name)=public.xelay_academic_subject_key(a.subject_name)
    cross join days d
    left join public.study_group_seminars se on se.schedule_id=s.id and se.lesson_date=d.lesson_date
    where d.lesson_date between a.starts_on and a.ends_on and not s.source_managed
      and public.xelay_seminar_schedule_occurs_on_date(s,d.lesson_date)
      and not exists(select 1 from public.study_group_schedule ts where ts.group_id=a.group_id
        and public.xelay_academic_subject_key(ts.subject)=public.xelay_academic_subject_key(a.subject_name)
        and ts.starts_at=coalesce(se.starts_at,s.starts_at) and ts.ends_at=coalesce(se.ends_at,s.ends_at)
        and public.xelay_schedule_occurs_on_date(ts.weekday,ts.valid_from,ts.valid_until,ts.week_pattern,ts.week_anchor_date,d.lesson_date)
        and not(d.lesson_date=any(ts.excluded_dates)))
  ), limited as (
    select o.*,'grades'=any(public.xelay_teaching_permissions(o.course_id,v_uid)) can_grade,
      exists(select 1 from public.teaching_calendar_assignments own where own.user_id=v_uid
      and own.course_id=o.course_id and own.group_id=o.group_id and own.schedule_id=o.id and own.source=o.source) assigned_to_me
    from occurrences o order by o.lesson_date,o.starts_at,o.group_name,o.course_title,o.id limit 3001
  ) select jsonb_build_object('lessons',coalesce(jsonb_agg(to_jsonb(l) order by l.lesson_date,l.starts_at,l.group_name,l.course_title),'[]'::jsonb))
    into v_result from limited l;
  if jsonb_array_length(v_result->'lessons')>3000 then
    raise exception 'TEACHING_CALENDAR_TOO_LARGE' using errcode='22023';
  end if;
  return v_result;
end $$;

create function public.xelay_teaching_calendar_assign(
  p_course_id uuid,p_group_id uuid,p_schedule_id uuid,p_source text,p_assigned boolean
)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_subject text;
begin
  if p_source not in('timetable','seminar') or p_source is null or p_assigned is null then
    raise exception 'TEACHING_INVALID_INPUT' using errcode='22023';
  end if;
  -- Same lock as subject membership and semester/permission mutations.
  perform 1 from public.teaching_courses where id=p_course_id and archived_at is null for update;
  if not found or cardinality(public.xelay_teaching_permissions(p_course_id,v_uid))=0 then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501';
  end if;
  select coalesce(s.name,c.title) into v_subject from public.teaching_course_groups l
    join public.teaching_courses c on c.id=l.course_id
    left join public.study_group_seminar_subjects s on s.id=l.subject_id and s.group_id=l.group_id
    where l.course_id=p_course_id and l.group_id=p_group_id and l.status='accepted';
  if not found then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  if p_assigned and not(case when p_source='timetable' then exists(
    select 1 from public.study_group_schedule s where s.id=p_schedule_id and s.group_id=p_group_id
      and public.xelay_academic_subject_key(s.subject)=public.xelay_academic_subject_key(v_subject))
    else exists(select 1 from public.study_group_seminar_schedule s
      join public.study_group_seminar_subjects sub on sub.id=s.subject_id and sub.group_id=s.group_id
      where s.id=p_schedule_id and s.group_id=p_group_id and not s.source_managed
        and public.xelay_academic_subject_key(sub.name)=public.xelay_academic_subject_key(v_subject)) end) then
    raise exception 'TEACHING_CALENDAR_LESSON_INVALID' using errcode='22023';
  end if;
  if p_assigned then
    insert into public.teaching_calendar_assignments(user_id,course_id,group_id,schedule_id,source)
      values(v_uid,p_course_id,p_group_id,p_schedule_id,p_source) on conflict do nothing;
  else
    delete from public.teaching_calendar_assignments where user_id=v_uid and course_id=p_course_id
      and group_id=p_group_id and schedule_id=p_schedule_id and source=p_source;
  end if;
  return jsonb_build_object('assigned',p_assigned);
end $$;
revoke all on function public.xelay_teaching_calendar(date,date),
  public.xelay_teaching_calendar_assign(uuid,uuid,uuid,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_calendar(date,date),
  public.xelay_teaching_calendar_assign(uuid,uuid,uuid,text,boolean) to authenticated;
notify pgrst,'reload schema';
commit;
