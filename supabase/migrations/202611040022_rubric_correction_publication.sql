-- A criterion-only correction is a real journal draft even when its score and
-- teacher feedback stay equal. Keep the original feedback on the rubric mark.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $$ begin
  if to_regprocedure('public.xelay_teaching_rubric_mutate(text,jsonb)') is null
    or to_regclass('public.teaching_rubric_marks') is null then
    raise exception 'RUBRIC_CORRECTION_PREREQUISITES_MISSING';
  end if;
end $$;

create or replace function public.xelay_teaching_rubric_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_item public.teaching_items%rowtype;v_config public.teaching_assignment_rubrics%rowtype;
  v_submission public.teaching_submissions%rowtype;v_mark public.teaching_rubric_marks%rowtype;v_old jsonb;v_group uuid:=(p_payload->>'group_id')::uuid;
  v_activity public.teaching_activities%rowtype;v_entry public.teaching_entries%rowtype;v_grade public.teaching_grades%rowtype;v_score numeric;
  v_feedback text:=btrim(coalesce(p_payload->>'feedback',''));v_grade_comment text;
begin
  if p_payload->>'expected_user_id' is distinct from v_uid::text then raise exception 'RUBRIC_FORBIDDEN' using errcode='42501';end if;
  select * into v_item from public.teaching_items where id=(p_payload->>'assignment_id')::uuid and kind='assignment';
  if not found or not exists(select 1 from public.teaching_item_targets where item_id=v_item.id and group_id=v_group) then raise exception 'RUBRIC_FORBIDDEN' using errcode='42501';end if;
  if p_action not in('save_rubric','assess_submission') then raise exception 'RUBRIC_INVALID_INPUT';end if;
  perform public.xelay_private_assert_teaching_group(v_item.course_id,v_group,case when p_action='save_rubric' then 'assignments' else 'grades' end);
  select * into v_item from public.teaching_items where id=v_item.id for update;
  select * into v_config from public.teaching_assignment_rubrics where item_id=v_item.id for update;
  if p_action='save_rubric' then
    perform public.xelay_private_assert_teaching_group(v_item.course_id,v_group,'assignments');
    if exists(select 1 from public.teaching_item_targets t where t.item_id=v_item.id and not 'assignments'=any(public.xelay_teaching_group_permissions(v_item.course_id,t.group_id,v_uid))) then raise exception 'RUBRIC_FORBIDDEN' using errcode='42501';end if;
    if(p_payload->>'version')::integer is distinct from coalesce(v_config.version,0) then raise exception 'RUBRIC_CONFLICT';end if;
    if exists(select 1 from public.teaching_rubric_marks m join public.teaching_submissions s on s.id=m.submission_id where s.item_id=v_item.id) then raise exception 'RUBRIC_LOCKED';end if;
    if not public.xelay_private_rubric_valid(p_payload->'rubric') or v_item.max_points is null then raise exception 'RUBRIC_INVALID_INPUT';end if;
    insert into public.teaching_assignment_rubrics(item_id,rubric,updated_by) values(v_item.id,coalesce(p_payload->'rubric','null'::jsonb),v_uid)
      on conflict(item_id) do update set rubric=excluded.rubric,updated_by=v_uid,updated_at=clock_timestamp(),version=teaching_assignment_rubrics.version+1;
  elsif p_action='assess_submission' then
    perform public.xelay_private_assert_teaching_group(v_item.course_id,v_group,'grades');
    if(p_payload->>'rubric_version')::integer is distinct from v_config.version or v_config.rubric is null or v_config.rubric='null'::jsonb then raise exception 'RUBRIC_CONFLICT';end if;
    select * into v_submission from public.teaching_submissions where id=(p_payload->>'submission_id')::uuid and item_id=v_item.id and group_id=v_group for update;
    if not found or v_submission.status not in('submitted','reviewed') or (to_jsonb(v_submission)->>'team_id') is not null then raise exception 'RUBRIC_INVALID_INPUT';end if;
    if v_submission.version is distinct from(p_payload->>'submission_version')::integer then raise exception 'RUBRIC_CONFLICT';end if;
    if not public.xelay_teaching_is_member(v_group,v_submission.user_id) then raise exception 'RUBRIC_FORBIDDEN' using errcode='42501';end if;
    select * into v_mark from public.teaching_rubric_marks where submission_id=v_submission.id for update;
    if coalesce(v_mark.version,0) is distinct from(p_payload->>'version')::integer then raise exception 'RUBRIC_CONFLICT';end if;
    if length(v_feedback)>2000 or length(btrim(coalesce(p_payload->>'reason',''))) not between 2 and 2000 then raise exception 'RUBRIC_INVALID_INPUT';end if;
    v_score:=public.xelay_private_rubric_score(v_config.rubric,p_payload->'levels',v_item.max_points);
    select * into v_activity from public.teaching_activities where item_id=v_item.id and group_id=v_group;
    select * into v_entry from public.teaching_entries where course_id=v_item.course_id and group_id=v_group and user_id=v_submission.user_id and active;
    if v_activity.id is null or v_entry.id is null then raise exception 'RUBRIC_FORBIDDEN' using errcode='42501';end if;
    -- The journal publishes changes in score/comment. A new assessed version
    -- needs its own explicit publication even if only equal-point levels change.
    -- Feedback remains complete: 2000 characters plus this marker is below the
    -- existing journal comment limit of 3000 characters.
    v_grade_comment:=v_feedback||case when v_feedback='' then '' else E'\n\n' end||
      'Оцінювання за критеріями · перевірка №'||(coalesce(v_mark.version,0)+1)::text||'.';
    perform public.xelay_teaching_mutate('save_grade',jsonb_build_object('activity_id',v_activity.id,'entry_id',v_entry.id,'version',(p_payload->>'grade_version')::integer,
      'score',v_score,'comment',v_grade_comment,'reason',p_payload->>'reason','expected_user_id',v_uid));
    select * into v_grade from public.teaching_grades where activity_id=v_activity.id and entry_id=v_entry.id;
    v_old:=case when v_mark.id is null then null else to_jsonb(v_mark) end;
    insert into public.teaching_rubric_marks(submission_id,submission_attempt,grade_id,rubric,levels,score,maximum,feedback,updated_by)
      values(v_submission.id,v_submission.attempt,v_grade.id,v_config.rubric,p_payload->'levels',v_score,v_item.max_points,v_feedback,v_uid)
      on conflict(submission_id) do update set rubric=excluded.rubric,levels=excluded.levels,score=excluded.score,maximum=excluded.maximum,feedback=excluded.feedback,
        submission_attempt=excluded.submission_attempt,grade_id=excluded.grade_id,updated_by=v_uid,updated_at=clock_timestamp(),version=teaching_rubric_marks.version+1 returning * into v_mark;
    insert into public.teaching_rubric_mark_audit(mark_id,actor_id,old_value,new_value) values(v_mark.id,v_uid,v_old,to_jsonb(v_mark));
  else raise exception 'RUBRIC_INVALID_INPUT';end if;
  return public.xelay_teaching_rubric(v_item.id,v_group);
end $$;

revoke all on function public.xelay_teaching_rubric_mutate(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_rubric_mutate(text,jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
