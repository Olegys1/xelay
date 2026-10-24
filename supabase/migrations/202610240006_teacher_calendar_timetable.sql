-- A teacher's calendar is a projection of the group's current timetable.
-- Student seminar planning must not manufacture additional teacher lessons.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create temporary table xelay_teacher_calendar_baseline on commit drop as
select jsonb_build_object(
  'timetable',(select count(*) from public.study_group_schedule),
  'seminar_schedule',(select count(*) from public.study_group_seminar_schedule),
  'seminars',(select count(*) from public.study_group_seminars),
  'questions',(select count(*) from public.study_group_seminar_questions),
  'teams',(select count(*) from public.study_group_seminar_teams),
  'reservations',(select count(*) from public.study_group_seminar_reservations),
  'calendar_marks',(select count(*) from public.teaching_calendar_assignments),
  'activities',(select count(*) from public.teaching_activities),
  'grades',(select count(*) from public.teaching_grades),
  'grade_sum',(select coalesce(sum(published_score),0) from public.teaching_grades),
  'member_policy',pg_get_functiondef('public.xelay_can_view_seminars(uuid)'::regprocedure),
  'routine_access',(select jsonb_agg(jsonb_build_object('id',p.oid,'acl',p.proacl::text) order by p.oid)
    from pg_proc p where p.oid in('public.xelay_teaching_calendar(date,date)'::regprocedure,
      'public.xelay_teaching_calendar_assign(uuid,uuid,uuid,text,boolean)'::regprocedure))
) data;
alter table xelay_teacher_calendar_baseline enable row level security;

do $calendar$
declare v_body text;v_old text;v_new text;
begin
  select replace(pg_get_functiondef('public.xelay_teaching_calendar(date,date)'::regprocedure),chr(13),'') into v_body;
  v_old:=$old$    union all
    select a.course_id,a.course_title,a.group_id,a.group_name,sub.name,
      s.id,d.lesson_date,coalesce(se.starts_at,s.starts_at),coalesce(se.ends_at,s.ends_at),'seminar'::text,''::text,''::text,'seminar'::text
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
$old$;
  v_old:=replace(v_old,chr(13),'');
  if (length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>1 then
    raise exception 'TEACHING_CALENDAR_UNION_SOURCE_DRIFT';
  end if;
  v_body:=replace(v_body,v_old,'');
  execute v_body;

  select replace(pg_get_functiondef('public.xelay_teaching_calendar_assign(uuid,uuid,uuid,text,boolean)'::regprocedure),chr(13),'') into v_body;
  v_old:=$old$  if p_assigned and not(case when p_source='timetable' then exists(
    select 1 from public.study_group_schedule s where s.id=p_schedule_id and s.group_id=p_group_id
      and public.xelay_academic_subject_key(s.subject)=public.xelay_academic_subject_key(v_subject))
    else exists(select 1 from public.study_group_seminar_schedule s
      join public.study_group_seminar_subjects sub on sub.id=s.subject_id and sub.group_id=s.group_id
      where s.id=p_schedule_id and s.group_id=p_group_id and not s.source_managed
        and public.xelay_academic_subject_key(sub.name)=public.xelay_academic_subject_key(v_subject)) end) then$old$;
  v_new:=$new$  -- Legacy seminar marks may be removed by their authorized owner, but
  -- only a current timetable row can receive a new personal marker.
  if p_assigned and not(p_source='timetable' and exists(
    select 1 from public.study_group_schedule s where s.id=p_schedule_id and s.group_id=p_group_id
      and public.xelay_academic_subject_key(s.subject)=public.xelay_academic_subject_key(v_subject))) then$new$;
  v_old:=replace(v_old,chr(13),'');v_new:=replace(v_new,chr(13),'');
  if (length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>1 then
    raise exception 'TEACHING_CALENDAR_ASSIGN_SOURCE_DRIFT';
  end if;
  execute replace(v_body,v_old,v_new);
end $calendar$;

do $unchanged$
declare v_before jsonb;v_after jsonb;v_calendar text;v_assign text;
begin
  select data into v_before from xelay_teacher_calendar_baseline;
  select jsonb_build_object(
    'timetable',(select count(*) from public.study_group_schedule),
    'seminar_schedule',(select count(*) from public.study_group_seminar_schedule),
    'seminars',(select count(*) from public.study_group_seminars),
    'questions',(select count(*) from public.study_group_seminar_questions),
    'teams',(select count(*) from public.study_group_seminar_teams),
    'reservations',(select count(*) from public.study_group_seminar_reservations),
    'calendar_marks',(select count(*) from public.teaching_calendar_assignments),
    'activities',(select count(*) from public.teaching_activities),
    'grades',(select count(*) from public.teaching_grades),
    'grade_sum',(select coalesce(sum(published_score),0) from public.teaching_grades),
    'member_policy',pg_get_functiondef('public.xelay_can_view_seminars(uuid)'::regprocedure),
    'routine_access',(select jsonb_agg(jsonb_build_object('id',p.oid,'acl',p.proacl::text) order by p.oid)
      from pg_proc p where p.oid in('public.xelay_teaching_calendar(date,date)'::regprocedure,
        'public.xelay_teaching_calendar_assign(uuid,uuid,uuid,text,boolean)'::regprocedure))
  ) into v_after;
  if v_before is distinct from v_after then
    raise exception 'TEACHING_CALENDAR_UNEXPECTED_DATA_OR_ACCESS_CHANGE';
  end if;
  select pg_get_functiondef('public.xelay_teaching_calendar(date,date)'::regprocedure) into v_calendar;
  select pg_get_functiondef('public.xelay_teaching_calendar_assign(uuid,uuid,uuid,text,boolean)'::regprocedure) into v_assign;
  if v_calendar like '%study_group_seminar_schedule%' or v_calendar like '%study_group_seminars%'
    or v_calendar not like '%study_group_schedule%'
    or v_calendar not like '%xelay_schedule_occurs_on_date%'
    or v_calendar not like '%excluded_dates%'
    or v_assign like '%study_group_seminar_schedule%'
    or v_assign not like '%xelay_private_assert_teacher_current_access%'
    or v_assign not like '%p_source=''timetable'' and exists(%' then
    raise exception 'TEACHING_CALENDAR_TIMETABLE_CONTRACT_MISSING';
  end if;
end $unchanged$;
notify pgrst,'reload schema';
select jsonb_build_object('release','teacher-calendar-timetable-20261024',
  'receipt',gen_random_uuid(),'applied_at',clock_timestamp(),'existing_data_unchanged',true,
  'member_policy_unchanged',true,'function_access_unchanged',true,
  'source','current_group_timetable',
  'row_counts',(select data-'member_policy'-'routine_access' from xelay_teacher_calendar_baseline)) as teacher_calendar_release;
commit;
