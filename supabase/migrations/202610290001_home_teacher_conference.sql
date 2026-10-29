-- Show a direct join action for the teacher's already authorized timetable
-- occurrences. Add four display fields to the existing RPC only. Its caller,
-- group/subject grants, semester dates, exclusions, row limit and ACL stay intact.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $home_teacher_conference$
declare
  v_routine regprocedure:=to_regprocedure('public.xelay_teaching_calendar(date,date)');
  v_before text;v_after text;v_acl_before jsonb;v_acl_after jsonb;
  v_old text:=$old$s.starts_at,s.ends_at,s.lesson_type,coalesce(s.location,'') location,s.teacher_name,'timetable'::text source$old$;
  v_new text:=$new$s.starts_at,s.ends_at,s.lesson_type,coalesce(s.location,'') location,s.teacher_name,s.online_url,s.online_url_secondary,s.conference_id,s.conference_access_code,'timetable'::text source$new$;
begin
  if v_routine is null or (
    select count(*) from information_schema.columns where table_schema='public'
      and table_name='study_group_schedule' and column_name in('online_url','online_url_secondary','conference_id','conference_access_code')
  )<>4 then raise exception 'HOME_TEACHER_CONFERENCE_PREREQUISITE_MISSING';end if;
  select replace(pg_get_functiondef(v_routine),chr(13),'') into v_before;
  if position('xelay_teaching_assert_user()' in v_before)=0
    or position('public.xelay_teaching_group_permissions(c.id,l.group_id,v_uid)' in v_before)=0
    or position('public.xelay_teaching_group_permissions(o.course_id,o.group_id,v_uid)' in v_before)=0
    or position('d.lesson_date between a.starts_on and a.ends_on' in v_before)=0
    or position('xelay_schedule_occurs_on_date' in v_before)=0
    or position('not(d.lesson_date=any(s.excluded_dates))' in v_before)=0
    or position('study_group_seminar_schedule' in v_before)>0
    or position('study_group_seminars' in v_before)>0
    or (length(v_before)-length(replace(v_before,v_old,'')))/length(v_old)<>1 then
    raise exception 'HOME_TEACHER_CONFERENCE_SOURCE_DRIFT';
  end if;
  select jsonb_build_object('oid',p.oid,'acl',p.proacl::text,'owner',p.proowner,
    'security_definer',p.prosecdef,'config',p.proconfig,'volatility',p.provolatile,
    'return_type',p.prorettype,'arguments',p.proargtypes::text)
    into v_acl_before from pg_proc p where p.oid=v_routine;

  execute replace(v_before,v_old,v_new);

  select replace(pg_get_functiondef(v_routine),chr(13),'') into v_after;
  select jsonb_build_object('oid',p.oid,'acl',p.proacl::text,'owner',p.proowner,
    'security_definer',p.prosecdef,'config',p.proconfig,'volatility',p.provolatile,
    'return_type',p.prorettype,'arguments',p.proargtypes::text)
    into v_acl_after from pg_proc p where p.oid=v_routine;
  if replace(v_after,v_new,v_old) is distinct from v_before or v_acl_after is distinct from v_acl_before then
    raise exception 'HOME_TEACHER_CONFERENCE_UNEXPECTED_ACCESS_CHANGE';
  end if;
end $home_teacher_conference$;

notify pgrst,'reload schema';
commit;
