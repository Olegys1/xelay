-- Identify same-named academic groups in the existing teaching directory.
-- Visibility, accepted group links, RLS and grants are unchanged. Course is
-- derived from the group's immutable cohort; unknown legacy cohorts stay null.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $preflight$ begin
  if to_regprocedure('public.xelay_teaching_workspace()') is null
    or to_regprocedure('public.xelay_teaching_course(uuid)') is null
    or to_regprocedure('public.xelay_classroom_workspace()') is null
    or to_regprocedure('public.xelay_teaching_group_context(uuid)') is null
    or to_regprocedure('public.xelay_current_academic_year()') is null
    or not exists(select 1 from pg_catalog.pg_attribute where attrelid=to_regclass('public.study_groups')
      and not attisdropped and attname in('cohort_start_year','study_level')
      group by attrelid having count(*)=2) then
    raise exception 'TEACHING_GROUP_DIRECTORY_PREREQUISITES_MISSING';
  end if;
end $preflight$;

create or replace function public.xelay_teaching_workspace()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_university uuid; begin
  select university_id into v_university from public.profiles where id=v_uid;
  return jsonb_build_object('teacher_status',public.xelay_teacher_status(),
    'courses',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('permissions',public.xelay_teaching_permissions(c.id,v_uid)) order by c.starts_on desc,c.title)
      from public.teaching_courses c where public.xelay_teaching_can_read_course(c.id,v_uid)
        or (c.owner_id=v_uid and public.xelay_teaching_is_verified(v_uid))
        or exists(select 1 from public.teaching_course_teachers t where t.course_id=c.id and t.user_id=v_uid and t.status='pending')),'[]'::jsonb),
    'groups',coalesce((select jsonb_agg(jsonb_build_object('id',g.id,'group_id',g.id,'group_name',g.group_name,'specialty',g.specialty,
      'representative_id',g.representative_id,'representative_name',p.full_name,'university_id',g.university_id,'academic_unit_id',g.academic_unit_id,
      'academic_unit_name',a.name,'cohort_start_year',g.cohort_start_year,'study_level',g.study_level,
      'study_year',case when public.xelay_current_academic_year()::integer-g.cohort_start_year+1 between 1 and 6
        then public.xelay_current_academic_year()::integer-g.cohort_start_year+1 else null end,
      'is_representative',g.representative_id=v_uid,'subjects',coalesce((select jsonb_agg(jsonb_build_object('id',s.id,'name',s.name) order by s.name)
        from public.study_group_seminar_subjects s where s.group_id=g.id),'[]'::jsonb)) order by g.group_name)
      from public.study_groups g join public.profiles p on p.id=g.representative_id
      left join public.academic_units a on a.id=g.academic_unit_id and a.university_id=g.university_id
      where public.xelay_teaching_is_member(g.id,v_uid) or (public.xelay_teaching_is_verified(v_uid) and g.university_id=v_university)),'[]'::jsonb),
    'teacher_directory',coalesce((select jsonb_agg(jsonb_build_object('id',r.user_id,'user_id',r.user_id,'full_name',p.full_name,
      'department',r.department,'position',r.position,'academic_unit_id',r.academic_unit_id) order by p.full_name)
      from public.teacher_verification_requests r join public.profiles p on p.id=r.user_id
      where r.university_id=v_university and public.xelay_teaching_is_verified(r.user_id)),'[]'::jsonb),
    'invitations',coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('course_title',c.title,'semester',c.semester,'full_name',p.full_name))
      from public.teaching_course_teachers t join public.teaching_courses c on c.id=t.course_id
      join public.profiles p on p.id=c.owner_id where t.user_id=v_uid and t.status='pending'),'[]'::jsonb),
    'teacher_invites',coalesce((select jsonb_agg(to_jsonb(t)||jsonb_build_object('course_title',c.title,'semester',c.semester))
      from public.teaching_course_teachers t join public.teaching_courses c on c.id=t.course_id where t.user_id=v_uid and t.status='pending'),'[]'::jsonb),
    'pending_invites',coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object('title',c.title,'semester',c.semester,'group_name',g.group_name,
      'teacher_name',p.full_name)) from public.teaching_course_groups l join public.teaching_courses c on c.id=l.course_id
      join public.study_groups g on g.id=l.group_id join public.profiles p on p.id=c.owner_id
      -- Owners also see their sent invitations, so the first-run card can
      -- accurately explain that group confirmation is still pending.
      where (l.status in('pending_teacher','pending_group') and c.owner_id=v_uid)
        or (l.status='pending_group' and g.representative_id=v_uid)),'[]'::jsonb),
    'roster_claims',coalesce((select jsonb_agg(to_jsonb(q)||jsonb_build_object('full_name',e.full_name,'course_title',c.title,'group_id',e.group_id))
      from public.teaching_roster_claims q join public.teaching_entries e on e.id=q.entry_id join public.teaching_courses c on c.id=e.course_id
      where q.user_id=v_uid and q.status='pending'),'[]'::jsonb));
end $$;

create or replace function public.xelay_classroom_workspace()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user(); begin
  return jsonb_build_object('classrooms',coalesce((select jsonb_agg(jsonb_build_object(
    'group_id',g.id,'group_name',g.group_name,'specialty',g.specialty,
    'academic_unit_name',a.name,'cohort_start_year',g.cohort_start_year,'study_level',g.study_level,
    'representative_id',g.representative_id,'representative_name',p.full_name,
    'study_year',case when public.xelay_current_academic_year()::integer-g.cohort_start_year+1 between 1 and 6
      then public.xelay_current_academic_year()::integer-g.cohort_start_year+1 else null end,
    'courses',(select jsonb_agg(jsonb_build_object('course_id',l.course_id,'subject_id',l.subject_id,'status',l.status) order by c.title)
      from public.teaching_course_groups l join public.teaching_courses c on c.id=l.course_id
      where l.group_id=g.id and l.status='accepted' and cardinality(public.xelay_teaching_permissions(c.id,v_uid))>0)
    ) order by g.group_name) from public.study_groups g
    left join public.academic_units a on a.id=g.academic_unit_id and a.university_id=g.university_id
    left join public.profiles p on p.id=g.representative_id where exists(select 1 from public.teaching_course_groups l
      where l.group_id=g.id and l.status='accepted' and cardinality(public.xelay_teaching_permissions(l.course_id,v_uid))>0)),'[]'::jsonb));
end $$;

create or replace function public.xelay_teaching_group_context(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user(); begin
  if not exists(select 1 from public.teaching_course_groups l where l.group_id=p_group_id
    and l.status='accepted' and cardinality(public.xelay_teaching_permissions(l.course_id,v_uid))>0) then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  return jsonb_build_object('group',(select jsonb_build_object('id',g.id,'group_id',g.id,'group_name',g.group_name,
      'specialty',g.specialty,'representative_id',g.representative_id,'representative_name',p.full_name,
      'university_id',g.university_id,'academic_unit_id',g.academic_unit_id,'academic_unit_name',a.name,
      'cohort_start_year',g.cohort_start_year,'study_level',g.study_level,
      'study_year',case when public.xelay_current_academic_year()::integer-g.cohort_start_year+1 between 1 and 6
        then public.xelay_current_academic_year()::integer-g.cohort_start_year+1 else null end)
      from public.study_groups g
      left join public.academic_units a on a.id=g.academic_unit_id and a.university_id=g.university_id
      left join public.profiles p on p.id=g.representative_id where g.id=p_group_id),
    'courses',coalesce((select jsonb_agg(to_jsonb(c)||jsonb_build_object('subject_id',l.subject_id,'link_id',l.id,
      'permissions',public.xelay_teaching_permissions(c.id,v_uid))) from public.teaching_courses c
      join public.teaching_course_groups l on l.course_id=c.id where l.group_id=p_group_id and l.status='accepted'
      and cardinality(public.xelay_teaching_permissions(c.id,v_uid))>0),'[]'::jsonb));
end $$;

-- Only extend linked group identity in the course snapshot. All existing
-- student/private-grade filters remain byte-for-byte in the installed function.
do $course_groups$
declare v_body text;v_old text;v_new text;v_old_count integer;v_new_count integer;v_patch record;
begin
  select pg_get_functiondef('public.xelay_teaching_course(uuid)'::regprocedure) into v_body;
  for v_patch in select * from (values
    ($old$jsonb_build_object('group_name',g.group_name,'specialty',g.specialty,'representative_id',g.representative_id)$old$,
     $new$jsonb_build_object('group_name',g.group_name,'specialty',g.specialty,'representative_id',g.representative_id,
        'representative_name',p.full_name,'academic_unit_name',a.name,'cohort_start_year',g.cohort_start_year,'study_level',g.study_level,
        'study_year',case when public.xelay_current_academic_year()::integer-g.cohort_start_year+1 between 1 and 6
          then public.xelay_current_academic_year()::integer-g.cohort_start_year+1 else null end)$new$),
    ($old$from public.teaching_course_groups l join public.study_groups g on g.id=l.group_id where l.course_id=p_course_id$old$,
     $new$from public.teaching_course_groups l join public.study_groups g on g.id=l.group_id
      left join public.academic_units a on a.id=g.academic_unit_id and a.university_id=g.university_id
      left join public.profiles p on p.id=g.representative_id where l.course_id=p_course_id$new$)
  ) as patches(old_body,new_body) loop
    v_old:=v_patch.old_body;v_new:=v_patch.new_body;
    v_old_count:=(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old);
    v_new_count:=(length(v_body)-length(replace(v_body,v_new,'')))/length(v_new);
    if v_old_count=0 and v_new_count=1 then continue; end if;
    if v_old_count<>1 or v_new_count<>0 then raise exception 'TEACHING_GROUP_DIRECTORY_COURSE_PREREQUISITE'; end if;
    v_body:=replace(v_body,v_old,v_new);
  end loop;
  execute v_body;
end $course_groups$;

-- CREATE OR REPLACE preserves existing execute grants; no new RPC is exposed.
notify pgrst, 'reload schema';
commit;
