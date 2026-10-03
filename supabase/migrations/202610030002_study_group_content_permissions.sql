-- Apply after 202610030001_study_group_schedule_permissions.sql.
-- Extend the schedule rule to homework, seminars and their materials.
-- Actual representatives and accepted, appointed deputies with the specific
-- permission may manage shared academic content. Ordinary members cannot
-- change it; personal reservations and own comments remain available.
begin;

do $$
begin
  if to_regclass('public.study_group_deputy_requests') is null
    or to_regprocedure('public.xelay_assign_study_group_deputy(uuid,uuid,text[])') is null
    or to_regprocedure('public.xelay_has_study_group_permission(uuid,text)') is null
    or to_regprocedure('public.xelay_validate_study_group_delegated_content()') is null
    or to_regprocedure('public.xelay_can_edit_homework_resources(uuid)') is null
    or to_regprocedure('public.xelay_lock_seminar_group(uuid,boolean)') is null
    or to_regprocedure('public.xelay_update_seminar_resources(uuid,jsonb,jsonb)') is null then
    raise exception 'Apply study group migrations through 202610030001 before content permission correction';
  end if;
end;
$$;

-- Homework CRUD policies, triggers, seminar management RPCs and file mutation
-- policies already check this helper. Personal reservations and own comments
-- use separate membership checks and remain available to accepted members.
create or replace function public.xelay_study_group_permissions(p_group_id uuid)
returns text[] language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when auth.uid() is null or not exists (select 1 from public.study_groups where id=p_group_id)
      then '{}'::text[]
    when public.xelay_is_study_group_representative(p_group_id)
      then array['schedule','homework','seminars','seminar_resources','seminar_comments','invite_members','remove_members']::text[]
    else array(
      select allowed.permission
      from unnest(array['schedule','homework','seminars','seminar_resources','seminar_comments','invite_members','remove_members']::text[])
        with ordinality as allowed(permission,position)
      where (allowed.permission in ('seminar_comments','invite_members','remove_members')
          and public.xelay_is_platform_admin())
        or exists (
          select 1 from public.study_group_deputy_requests d
          join public.study_group_members m
            on m.group_id=d.group_id and m.user_id=d.user_id and m.status='accepted'
          where d.group_id=p_group_id and d.user_id=auth.uid() and d.status='approved'
            and allowed.permission=any(d.permissions)
        )
      order by allowed.position
    )
  end;
$$;

comment on function public.xelay_study_group_permissions(uuid) is
  'Academic content management (schedule, homework, seminars, seminar resources) requires the actual group representative or an accepted, approved deputy with the specific permission. Platform admin status alone only retains existing moderation permissions.';

revoke all on function public.xelay_study_group_permissions(uuid) from public,anon,service_role;
grant execute on function public.xelay_study_group_permissions(uuid) to authenticated;

commit;
