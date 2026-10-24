-- Student seminar planning belongs to group members and the headman.
-- Teaching access grants schedule, assignments, materials and grades only.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create temporary table xelay_seminar_boundary_baseline on commit drop as
select jsonb_build_object(
  'seminars',(select count(*) from public.study_group_seminars),
  'questions',(select count(*) from public.study_group_seminar_questions),
  'teams',(select count(*) from public.study_group_seminar_teams),
  'reservations',(select count(*) from public.study_group_seminar_reservations),
  'activities',(select count(*) from public.teaching_activities),
  'grades',(select count(*) from public.teaching_grades),
  'grade_sum',(select coalesce(sum(published_score),0) from public.teaching_grades),
  'member_policy',pg_get_functiondef('public.xelay_can_view_seminars(uuid)'::regprocedure),
  'calendar',pg_get_functiondef('public.xelay_teaching_calendar(date,date)'::regprocedure)
) as data;
alter table xelay_seminar_boundary_baseline enable row level security;

do $boundary$
declare v_body text;v_old text;v_new text;
begin
  select replace(pg_get_functiondef('public.xelay_teaching_course(uuid)'::regprocedure),chr(13),'') into v_body;
  v_old:=$old$'seminars',case when v_staff then public.xelay_teaching_seminars(p_course_id) else '{}'::jsonb end$old$;
  v_new:=$new$'seminars',jsonb_build_object('seminars','[]'::jsonb,'questions','[]'::jsonb,'teams','[]'::jsonb,'reservations','[]'::jsonb,'profiles','{}'::jsonb)$new$;
  if (length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>1 then
    raise exception 'TEACHING_SEMINAR_COURSE_SOURCE_DRIFT';
  end if;
  execute replace(v_body,v_old,v_new);

  select replace(pg_get_functiondef('public.xelay_classroom_mutate(text,jsonb)'::regprocedure),chr(13),'') into v_body;
  v_old:=$old$begin
  if p_action is null$old$;
  v_new:=$new$begin
  -- teacher_seminar_boundary_contract: deny before any idempotency receipt.
  if p_action in('save_seminar_schedule','save_seminar','delete_seminar') then
    raise exception 'TEACHING_SEMINARS_MANAGED_BY_GROUP' using errcode='42501';
  end if;
  if p_action is null$new$;
  v_old:=replace(v_old,chr(13),'');v_new:=replace(v_new,chr(13),'');
  if (length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>1 then
    raise exception 'TEACHING_SEMINAR_DISPATCH_SOURCE_DRIFT';
  end if;
  execute replace(v_body,v_old,v_new);

  select replace(pg_get_functiondef('public.xelay_teaching_mutate(text,jsonb)'::regprocedure),chr(13),'') into v_body;
  v_old:=$old$max_points=v_max,seminar_id=nullif(p_payload->>'seminar_id','')::uuid,version=version+1$old$;
  v_new:=$new$max_points=v_max,seminar_id=coalesce(nullif(p_payload->>'seminar_id','')::uuid,v_activity.seminar_id),version=version+1$new$;
  if (length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>1 then
    raise exception 'TEACHING_SEMINAR_ACTIVITY_SOURCE_DRIFT';
  end if;
  execute replace(v_body,v_old,v_new);
end $boundary$;

-- Retire the teacher-only facades as well as browser execution. Existing
-- group member/headman RPCs and their RLS predicates remain unchanged.
create or replace function public.xelay_classroom_seminars(p_course_id uuid,p_group_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  raise exception 'TEACHING_SEMINARS_MANAGED_BY_GROUP' using errcode='42501';
end $$;
create or replace function public.xelay_classroom_seminar_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  raise exception 'TEACHING_SEMINARS_MANAGED_BY_GROUP' using errcode='42501';
end $$;
create or replace function public.xelay_teaching_seminars(p_course_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  raise exception 'TEACHING_SEMINARS_MANAGED_BY_GROUP' using errcode='42501';
end $$;
revoke all on function public.xelay_classroom_seminars(uuid,uuid),
  public.xelay_classroom_seminar_mutate(text,jsonb),public.xelay_teaching_seminars(uuid)
  from public,anon,authenticated,service_role;

-- Historical journal links retain their grade history. No new teacher
-- activity may create or change a link to student seminar planning.
create function public.xelay_private_teaching_no_seminar_link()
returns trigger language plpgsql set search_path='' as $$
begin
  if new.seminar_id is not null then
    if tg_op='INSERT' then
      raise exception 'TEACHING_SEMINARS_MANAGED_BY_GROUP' using errcode='42501';
    elsif new.seminar_id is distinct from old.seminar_id then
      raise exception 'TEACHING_SEMINARS_MANAGED_BY_GROUP' using errcode='42501';
    end if;
  end if;
  return new;
end $$;
revoke all on function public.xelay_private_teaching_no_seminar_link() from public,anon,authenticated,service_role;
create trigger xelay_teaching_no_seminar_link before insert or update of seminar_id on public.teaching_activities
  for each row execute function public.xelay_private_teaching_no_seminar_link();

do $unchanged$
declare v_before jsonb;v_after jsonb;
begin
  select data into v_before from xelay_seminar_boundary_baseline;
  select jsonb_build_object(
    'seminars',(select count(*) from public.study_group_seminars),
    'questions',(select count(*) from public.study_group_seminar_questions),
    'teams',(select count(*) from public.study_group_seminar_teams),
    'reservations',(select count(*) from public.study_group_seminar_reservations),
    'activities',(select count(*) from public.teaching_activities),
    'grades',(select count(*) from public.teaching_grades),
    'grade_sum',(select coalesce(sum(published_score),0) from public.teaching_grades),
    'member_policy',pg_get_functiondef('public.xelay_can_view_seminars(uuid)'::regprocedure),
    'calendar',pg_get_functiondef('public.xelay_teaching_calendar(date,date)'::regprocedure)
  ) into v_after;
  if v_before is distinct from v_after then raise exception 'TEACHING_SEMINAR_BOUNDARY_UNEXPECTED_DATA_CHANGE'; end if;
end $unchanged$;
notify pgrst,'reload schema';
select jsonb_build_object('release','teacher-seminar-boundary-20261024',
  'receipt',gen_random_uuid(),'applied_at',clock_timestamp(),'existing_data_unchanged',true,
  'member_policy_unchanged',true,'teacher_calendar_unchanged',true,
  'row_counts',(select data-'member_policy'-'calendar' from xelay_seminar_boundary_baseline),
  'teacher_facades_closed',(select bool_and(not has_function_privilege('authenticated',signature,'execute') and not has_function_privilege('anon',signature,'execute') and not has_function_privilege('service_role',signature,'execute'))
    from (values('public.xelay_classroom_seminars(uuid,uuid)'),('public.xelay_classroom_seminar_mutate(text,jsonb)'),('public.xelay_teaching_seminars(uuid)')) f(signature))) as teacher_seminar_boundary_release;
commit;
