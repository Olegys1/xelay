-- Bounded, private snapshots for signed-in Android widgets. No data writes,
-- new table grants, or changes to schedule/homework/reward permissions.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $preflight$ begin
  if to_regclass('public.study_groups') is null
    or to_regclass('public.study_group_members') is null
    or to_regclass('public.study_group_schedule') is null
    or to_regclass('public.study_group_homework') is null
    or to_regclass('public.study_group_long_term_tasks') is null
    or to_regclass('public.teaching_items') is null
    or to_regclass('public.teaching_item_targets') is null
    or to_regclass('public.teaching_course_groups') is null
    or to_regclass('public.teaching_submissions') is null
    or to_regprocedure('public.xelay_current_academic_year()') is null
    or to_regprocedure('public.xelay_teaching_is_member(uuid,uuid)') is null
    or to_regprocedure('public.xelay_can_read_study_group_long_term_tasks(uuid)') is null
    or to_regprocedure('public.xelay_schedule_occurs_on_date(smallint,date,date,text,date,date)') is null
    or not exists(select 1 from pg_catalog.pg_attribute where attrelid=to_regclass('public.study_group_schedule')
      and attname='excluded_dates' and not attisdropped) then
    raise exception 'ANDROID_WIDGET_PREREQUISITES_MISSING';
  end if;
end $preflight$;

create or replace function public.xelay_android_widget_groups()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_result jsonb;
begin
  if v_uid is null or not exists(select 1 from auth.users u join public.profiles p on p.id=u.id
    where u.id=v_uid and u.email_confirmed_at is not null and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=now()) limit 1) then
    raise exception 'AUTH_REQUIRED' using errcode='28000';
  end if;
  with candidates as materialized (
    select g.id,g.group_name,g.study_level,g.cohort_start_year
    from public.study_groups g where public.xelay_teaching_is_member(g.id,v_uid)
    order by lower(g.group_name),g.cohort_start_year desc nulls last,g.study_level,g.id limit 51
  ), selected as (
    select * from candidates
    order by lower(group_name),cohort_start_year desc nulls last,study_level,id limit 50
  )
  select jsonb_build_object('groups',coalesce((select jsonb_agg(jsonb_build_object(
    'id',s.id,'name',s.group_name,
    'course',case when public.xelay_current_academic_year()::integer-s.cohort_start_year+1 between 1 and 6
      then public.xelay_current_academic_year()::integer-s.cohort_start_year+1 else null end,
    'degree',s.study_level) order by lower(s.group_name),s.cohort_start_year desc nulls last,s.study_level,s.id)
    from selected s),'[]'::jsonb),'truncated',(select count(*)>50 from candidates)) into v_result;
  return v_result;
end $$;

create or replace function public.xelay_android_widget_snapshot(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_uid uuid:=auth.uid();v_now timestamptz:=now();
  v_today date:=(now() at time zone 'Europe/Kyiv')::date;
  v_tomorrow date:=(now() at time zone 'Europe/Kyiv')::date+1;
  v_group public.study_groups%rowtype;v_result jsonb;
  v_base text:='https://www.xelay.ink/groups/';
begin
  if v_uid is null or not exists(select 1 from auth.users u join public.profiles p on p.id=u.id
    where u.id=v_uid and u.email_confirmed_at is not null and u.deleted_at is null
      and (u.banned_until is null or u.banned_until<=v_now) limit 1) then
    raise exception 'AUTH_REQUIRED' using errcode='28000';
  end if;
  if p_group_id is null or not public.xelay_teaching_is_member(p_group_id,v_uid) then
    raise exception 'MEMBER_REQUIRED' using errcode='42501';
  end if;
  select * into v_group from public.study_groups where id=p_group_id limit 1;
  if not found then raise exception 'MEMBER_REQUIRED' using errcode='42501'; end if;

  with lesson_candidates as materialized (
    select s.id,s.subject,s.lesson_type,s.starts_at,s.ends_at,s.location
    from public.study_group_schedule s where s.group_id=p_group_id
      and public.xelay_schedule_occurs_on_date(s.weekday,s.valid_from,s.valid_until,
        s.week_pattern,s.week_anchor_date,v_tomorrow)
      and not(v_tomorrow=any(s.excluded_dates))
    order by s.starts_at,s.ends_at,s.id limit 13
  ), selected_lessons as (
    select * from lesson_candidates order by starts_at,ends_at,id limit 12
  ), homework_candidates as materialized (
    -- A dated homework survives cancelling its lesson. It is not a lesson
    -- occurrence and has no invented midnight/lesson-start deadline.
    select h.id,coalesce(nullif(btrim(h.lesson_topic),''),s.subject,'Домашнє завдання') as title,
      s.subject,null::timestamptz as due_at,h.lesson_date as due_date,'homework'::text as source,
      v_base||p_group_id::text||'?tab=schedule&date='||h.lesson_date::text
        ||'&assignment='||h.id::text||'&kind=homework' as url
    from public.study_group_homework h join public.study_group_schedule s on s.id=h.schedule_item_id and s.group_id=h.group_id
    where h.group_id=p_group_id and h.lesson_date>=v_today
      and (nullif(btrim(h.body),'') is not null or nullif(btrim(h.url),'') is not null
        or jsonb_array_length(h.resource_links)>0 or jsonb_array_length(h.attachments)>0)
    order by h.lesson_date,h.id limit 6
  ), long_term_candidates as materialized (
    select t.id,t.title,t.subject,null::timestamptz as due_at,t.due_date,'long_term'::text as source,
      v_base||p_group_id::text||'?tab=schedule' as url
    from public.study_group_long_term_tasks t
    where t.group_id=p_group_id and t.closed_at is null and t.due_date>=v_today
      and public.xelay_can_read_study_group_long_term_tasks(p_group_id)
    order by t.due_date,t.id limit 6
  ), teaching_candidates as materialized (
    select i.id,i.title,c.title as subject,t.due_at,(t.due_at at time zone 'Europe/Kyiv')::date as due_date,
      'teaching'::text as source,v_base||p_group_id::text||'?tab=schedule' as url
    from public.teaching_item_targets t
    join public.teaching_items i on i.id=t.item_id and i.kind='assignment' and i.status='published'
    join public.teaching_courses c on c.id=i.course_id and c.archived_at is null
    join public.teaching_course_groups l on l.course_id=i.course_id and l.group_id=t.group_id and l.status='accepted'
    where t.group_id=p_group_id and t.due_at is not null and t.due_at>=v_now
      and not exists(select 1 from public.teaching_submissions w where w.item_id=i.id and w.group_id=p_group_id
        and w.user_id=v_uid and w.status in('submitted','reviewed') limit 1)
    order by t.due_at,i.id limit 6
  ), deadline_candidates as materialized (
    select * from (
      select * from homework_candidates union all select * from long_term_candidates
      union all select * from teaching_candidates
    ) combined order by due_date,due_at nulls last,source,id limit 6
  ), selected_deadlines as (
    select * from deadline_candidates order by due_date,due_at nulls last,source,id limit 5
  )
  select jsonb_build_object('schema_version',1,
    'group',jsonb_build_object('id',v_group.id,'name',v_group.group_name,
      'course',case when public.xelay_current_academic_year()::integer-v_group.cohort_start_year+1 between 1 and 6
        then public.xelay_current_academic_year()::integer-v_group.cohort_start_year+1 else null end,
      'degree',v_group.study_level),
    'generated_at',to_char(v_now at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'timezone','Europe/Kyiv','schedule_date',v_tomorrow::text,
    'lessons',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'title',s.subject,'kind',s.lesson_type,
      'start_time',left(s.starts_at::text,5),'end_time',left(s.ends_at::text,5),
      'location',coalesce(s.location,''),'url',v_base||p_group_id::text||'?tab=schedule&date='||v_tomorrow::text)
      order by s.starts_at,s.ends_at,s.id) from selected_lessons s),'[]'::jsonb),
    'deadlines',coalesce((select jsonb_agg(jsonb_build_object('id',d.id,'title',d.title,'subject',d.subject,
      'due_at',case when d.due_at is not null then to_char(d.due_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') else null end,
      'due_date',d.due_date::text,'source',d.source,'url',d.url)
      order by d.due_date,d.due_at nulls last,d.source,d.id) from selected_deadlines d),'[]'::jsonb),
    'truncated',(select count(*)>12 from lesson_candidates) or (select count(*)>5 from deadline_candidates)) into v_result;
  return v_result;
end $$;

revoke all on function public.xelay_android_widget_groups(),public.xelay_android_widget_snapshot(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_android_widget_groups(),public.xelay_android_widget_snapshot(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
