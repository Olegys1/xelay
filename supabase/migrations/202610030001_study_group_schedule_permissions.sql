-- Apply after 202610020009_study_group_deputy_appointments.sql.
-- Schedule mutations are limited to the actual group representative and
-- accepted, appointed deputies with the explicit schedule permission.
begin;

do $$
begin
  if to_regclass('public.study_group_deputy_requests') is null
    or to_regprocedure('public.xelay_assign_study_group_deputy(uuid,uuid,text[])') is null
    or to_regprocedure('public.xelay_has_study_group_permission(uuid,text)') is null
    or to_regprocedure('public.xelay_validate_study_group_delegated_content()') is null then
    raise exception 'Apply 202610020008 and 202610020009 before schedule permission correction';
  end if;
end;
$$;

-- Both the existing RLS policies and the mutation trigger use this helper.
-- Preserve other existing platform moderation permissions and deputy grants.
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
      where (allowed.permission <> 'schedule' and public.xelay_is_platform_admin())
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
  'Effective group permissions. Schedule editing requires the actual representative or an accepted, approved deputy explicitly granted schedule; platform admin status alone does not grant schedule.';

revoke all on function public.xelay_study_group_permissions(uuid) from public,anon,service_role;
grant execute on function public.xelay_study_group_permissions(uuid) to authenticated;

commit;
