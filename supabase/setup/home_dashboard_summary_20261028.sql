-- Home dashboard read projection. Existing reader permissions are preserved.
-- This projects a strict subset of the existing classroom-assignment response.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '45s';

do $$ begin
  if to_regprocedure('public.xelay_teaching_assert_user()') is null
    or to_regprocedure('public.xelay_classroom_student(uuid,uuid,uuid)') is null
    or to_regprocedure('public.xelay_classroom_staff(uuid,uuid,uuid)') is null
    or to_regprocedure('public.xelay_teaching_is_member(uuid,uuid)') is null
    or to_regprocedure('public.xelay_teaching_can_read_item(uuid,uuid)') is null
    or to_regprocedure('public.xelay_teaching_group_permissions(uuid,uuid,uuid)') is null
    or to_regprocedure('public.xelay_private_teaching_closes_at(uuid,uuid,uuid)') is null then
    raise exception 'HOME_TEACHING_PREREQUISITES_MISSING';
  end if;
end $$;

create or replace function public.xelay_home_teaching_summary(p_group_ids uuid[] default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_uid uuid := public.xelay_teaching_assert_user();
  v_result jsonb;
begin
  if p_group_ids is not null and (cardinality(p_group_ids) > 100
    or (cardinality(p_group_ids) > 0 and array_ndims(p_group_ids) <> 1)
    or array_position(p_group_ids, null) is not null) then
    raise exception 'HOME_GROUP_SCOPE_INVALID' using errcode = '22023';
  end if;

  with allowed_links as materialized (
    select l.course_id, l.group_id
    from public.teaching_course_groups l
    where l.status = 'accepted' and (p_group_ids is null or l.group_id = any(p_group_ids))
      and (public.xelay_teaching_is_member(l.group_id, v_uid)
        or public.xelay_classroom_staff(l.course_id, l.group_id, v_uid))
  ), scope as materialized (
    select i.id item_id, i.course_id, t.group_id, i.title, i.max_points
    from public.teaching_items i
    join public.teaching_courses c on c.id = i.course_id and c.archived_at is null
    join public.teaching_item_targets t on t.item_id = i.id
    join allowed_links l on l.course_id = i.course_id and l.group_id = t.group_id
    where i.kind = 'assignment' and i.status = 'published' and i.withdrawn_at is null
  ), own_scope as materialized (
    select a.* from scope a
    where public.xelay_classroom_student(a.item_id, a.group_id, v_uid)
      and public.xelay_teaching_can_read_item(a.item_id, v_uid)
  ), staff_scope as materialized (
    select a.*, 'grades' = any(public.xelay_teaching_group_permissions(a.course_id, a.group_id, v_uid)) can_grade
    from scope a
    where public.xelay_classroom_staff(a.course_id, a.group_id, v_uid)
      and public.xelay_teaching_can_read_item(a.item_id, v_uid)
  ), staff_rows as materialized (
    select a.*, s.status, s.submitted_at,
      (a.can_grade and a.max_points is not null and s.status in ('submitted', 'reviewed')
        and not exists (
          select 1 from public.teaching_activities activity
          join public.teaching_entries entry on entry.course_id = a.course_id and entry.group_id = a.group_id and entry.user_id = s.user_id
          join public.teaching_grades grade on grade.activity_id = activity.id and grade.entry_id = entry.id
          where activity.item_id = a.item_id and activity.course_id = a.course_id and activity.group_id = a.group_id
            and grade.published_at is not null and grade.published_score is not null
        )) needs_grade
    from staff_scope a
    join public.teaching_submissions s on s.item_id = a.item_id and s.course_id = a.course_id and s.group_id = a.group_id
      and s.status <> 'draft'
  ), reviews as (
    select item_id, course_id, group_id, title,
      count(*) filter (where status = 'submitted') submitted_count,
      case when can_grade then count(*) filter (where needs_grade) else null end ungraded_count,
      count(*) filter (where status = 'submitted' or needs_grade) pending_count,
      max(submitted_at) filter (where status = 'submitted' or needs_grade) last_submitted_at
    from staff_rows
    group by item_id, course_id, group_id, title, can_grade
    having count(*) filter (where status = 'submitted' or needs_grade) > 0
  )
  select jsonb_build_object(
    'assignments', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', a.item_id, 'course_id', a.course_id, 'group_id', a.group_id, 'user_id', v_uid,
        'status', s.status,
        'effective_closes_at', public.xelay_private_teaching_closes_at(a.item_id, a.group_id, v_uid)
      ) order by a.group_id, a.course_id, a.item_id)
      from own_scope a
      left join public.teaching_submissions s on s.item_id = a.item_id and s.course_id = a.course_id
        and s.group_id = a.group_id and s.user_id = v_uid
    ), '[]'::jsonb),
    'teacher_reviews', coalesce((
      select jsonb_agg(jsonb_build_object(
        'item_id', r.item_id, 'course_id', r.course_id, 'group_id', r.group_id, 'title', r.title,
        'submitted_count', r.submitted_count, 'ungraded_count', r.ungraded_count,
        'pending_count', r.pending_count, 'last_submitted_at', r.last_submitted_at
      ) order by r.last_submitted_at desc nulls last, r.group_id, r.item_id)
      from reviews r
    ), '[]'::jsonb)
  ) into v_result;
  return v_result;
end $$;

revoke all on function public.xelay_home_teaching_summary(uuid[]) from public, anon, authenticated, service_role;
grant execute on function public.xelay_home_teaching_summary(uuid[]) to authenticated;
comment on function public.xelay_home_teaching_summary(uuid[]) is
  'Read-only home projection using existing classroom and group-permission helpers. Own statuses only; staff counts exclude drafts and omit ungraded totals without grades permission. No new table or storage access.';
commit;
