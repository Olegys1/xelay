-- Local review migration. No semester, work, file or grade is deleted.
-- The existing workspace read is extended with the current author's sent requests.
begin;

do $$ begin
  if to_regprocedure('public.xelay_teaching_workspace()') is null
    or to_regprocedure('public.xelay_teaching_mutate(text,jsonb)') is null
    or to_regprocedure('public.xelay_teaching_lock_course(uuid,text)') is null then
    raise exception 'Teaching workspace prerequisites are missing';
  end if;
  if to_regprocedure('public.xelay_teaching_workspace_before_group_requests_20261027()') is not null
    or to_regprocedure('public.xelay_teaching_mutate_before_group_requests_20261027(text,jsonb)') is not null then
    raise exception 'Teaching group-request migration was already installed';
  end if;
end $$;

alter function public.xelay_teaching_workspace() rename to xelay_teaching_workspace_before_group_requests_20261027;
alter function public.xelay_teaching_mutate(text,jsonb) rename to xelay_teaching_mutate_before_group_requests_20261027;
revoke all on function public.xelay_teaching_workspace_before_group_requests_20261027(), public.xelay_teaching_mutate_before_group_requests_20261027(text,jsonb) from public, anon, authenticated, service_role;

create function public.xelay_teaching_workspace()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user(); v_workspace jsonb;
begin
  v_workspace:=public.xelay_teaching_workspace_before_group_requests_20261027();
  return v_workspace||jsonb_build_object('sent_group_requests',coalesce((
    select jsonb_agg(jsonb_build_object(
      'id',l.id,'course_id',c.id,'course_title',c.title,'semester',c.semester,
      'group_id',g.id,'group_name',g.group_name,'representative_name',p.full_name,
      'status',l.status,'created_at',l.created_at,'updated_at',l.updated_at,'accepted_at',l.accepted_at,
      'can_cancel',l.status='pending_group' and c.archived_at is null and 'manage'=any(public.xelay_teaching_permissions(c.id,v_uid))
    ) order by l.created_at desc,l.id)
    from public.teaching_course_groups l join public.teaching_courses c on c.id=l.course_id
    join public.study_groups g on g.id=l.group_id
    left join public.profiles p on p.id=g.representative_id
    where l.invited_by=v_uid and c.owner_id=v_uid
  ),'[]'::jsonb));
end $$;

create function public.xelay_teaching_mutate(p_action text,p_payload jsonb default '{}'::jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid; v_link public.teaching_course_groups%rowtype; v_expected timestamptz;
begin
  if p_action is distinct from 'cancel_group_invite' then
    return public.xelay_teaching_mutate_before_group_requests_20261027(p_action,p_payload);
  end if;
  v_uid:=public.xelay_teaching_assert_user();
  if jsonb_typeof(p_payload) is distinct from 'object'
    or nullif(p_payload->>'link_id','') is null or nullif(p_payload->>'expected_updated_at','') is null then
    raise exception 'TEACHING_INVALID_INPUT';
  end if;
  select * into v_link from public.teaching_course_groups where id=(p_payload->>'link_id')::uuid;
  if not found then raise exception 'TEACHING_NOT_FOUND'; end if;
  -- Use the same course -> link lock order as the existing response/remove flow.
  perform public.xelay_teaching_lock_course(v_link.course_id,'manage');
  select * into v_link from public.teaching_course_groups where id=(p_payload->>'link_id')::uuid for update;
  if not found or v_link.invited_by is distinct from v_uid then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  v_expected:=(p_payload->>'expected_updated_at')::timestamptz;
  if not isfinite(v_expected) or v_link.status<>'pending_group' or v_link.updated_at is distinct from v_expected then
    raise exception 'TEACHING_CONFLICT';
  end if;
  -- The existing operation keeps all historical works and grades and notifies the head.
  return public.xelay_teaching_mutate_before_group_requests_20261027('remove_group',jsonb_build_object('link_id',v_link.id));
end $$;

revoke all on function public.xelay_teaching_workspace(),public.xelay_teaching_mutate(text,jsonb) from public, anon, authenticated, service_role;
grant execute on function public.xelay_teaching_workspace(),public.xelay_teaching_mutate(text,jsonb) to authenticated;
comment on function public.xelay_teaching_workspace() is 'Teacher workspace with an author-scoped history of group invitations; semester records are retained.';
comment on function public.xelay_teaching_mutate(text,jsonb) is 'Teaching mutations, including conflict-checked cancellation of the current teacher''s pending group invitation.';
notify pgrst, 'reload schema';
commit;
