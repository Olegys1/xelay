-- Activate the approved first package. No paid placements, ads or student grades change.
begin;
create or replace function public.xelay_my_business_identity()
returns jsonb language sql stable security definer set search_path='' as $$
  select jsonb_build_object('userId',b.user_id,'kind',b.organization_kind,'name',b.company_name)
  from public.opportunities_business_accounts b join auth.users u on u.id=b.user_id
  where b.user_id=auth.uid() and u.deleted_at is null and u.email_confirmed_at is not null
    and (u.banned_until is null or u.banned_until<=now())
$$;
revoke all on function public.xelay_my_business_identity() from public,anon,authenticated,service_role;
grant execute on function public.xelay_my_business_identity() to authenticated;
create or replace function public.xelay_my_account_bootstrap()
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare uid uuid:=auth.uid(); result jsonb:='{}'::jsonb; value jsonb;
begin
  if uid is null then raise exception 'ACCOUNT_AUTH_REQUIRED' using errcode='42501';end if;
  -- The primary profile is authoritative: do not return roles if it is absent
  -- or if its RLS/table read fails.
  select to_jsonb(p) into value from public.profiles p where p.id=uid;
  result:=jsonb_build_object('profile',jsonb_build_object('data',value,'error',null,'status',200));
  if value is null then
    return result||jsonb_build_object('business',public.xelay_my_business_identity());
  end if;
  begin
    select coalesce(jsonb_agg(jsonb_build_object('role',r.role,'university_id',r.university_id,
      'academic_unit_id',r.academic_unit_id) order by r.id),'[]'::jsonb)
      into value from public.user_roles r where r.user_id=uid;
    result:=result||jsonb_build_object('roles',jsonb_build_object('data',value,'error',null,'status',200));
  exception when others then
    result:=result||jsonb_build_object('roles',jsonb_build_object('data',null,
      'error',jsonb_build_object('code',sqlstate,'message','ACCOUNT_SECTION_UNAVAILABLE'),
      'status',case when sqlstate='42501' then 403 when sqlstate in('42P01','42883','42703') then 404 when left(sqlstate,2)='22' then 400 else 500 end));
  end;
  begin
    select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'status',r.status) order by r.created_at desc,r.id),'[]'::jsonb)
      into value from public.class_representative_requests r where r.user_id=uid and r.status in('pending','approved');
    result:=result||jsonb_build_object('representative_requests',jsonb_build_object('data',value,'error',null,'status',200));
  exception when others then
    result:=result||jsonb_build_object('representative_requests',jsonb_build_object('data',null,
      'error',jsonb_build_object('code',sqlstate,'message','ACCOUNT_SECTION_UNAVAILABLE'),
      'status',case when sqlstate='42501' then 403 when sqlstate in('42P01','42883','42703') then 404 when left(sqlstate,2)='22' then 400 else 500 end));
  end;
  begin
    select coalesce(jsonb_agg(jsonb_build_object('group_id',m.group_id,'status',m.status) order by m.id),'[]'::jsonb)
      into value from public.study_group_members m where m.user_id=uid and m.status in('pending','accepted');
    result:=result||jsonb_build_object('memberships',jsonb_build_object('data',value,'error',null,'status',200));
  exception when others then
    result:=result||jsonb_build_object('memberships',jsonb_build_object('data',null,
      'error',jsonb_build_object('code',sqlstate,'message','ACCOUNT_SECTION_UNAVAILABLE'),
      'status',case when sqlstate='42501' then 403 when sqlstate in('42P01','42883','42703') then 404 when left(sqlstate,2)='22' then 400 else 500 end));
  end;
  begin
    -- Preserve the existing teacher authority / expiry helper. Bootstrap needs
    -- the actor's status only, never an admin's list of other applications.
    value:=public.xelay_teacher_status()-'requests';
    result:=result||jsonb_build_object('teacher',jsonb_build_object('data',value,'error',null,'status',200));
  exception when others then
    result:=result||jsonb_build_object('teacher',jsonb_build_object('data',null,
      'error',jsonb_build_object('code',sqlstate,'message','ACCOUNT_SECTION_UNAVAILABLE'),
      'status',case when sqlstate='42501' then 403 when sqlstate in('42P01','42883','42703') then 404 when left(sqlstate,2)='22' then 400 else 500 end));
  end;
  begin
    value:=public.xelay_my_study_group_representative_status();
    result:=result||jsonb_build_object('representative_status',jsonb_build_object('data',value,'error',null,'status',200));
  exception when others then
    result:=result||jsonb_build_object('representative_status',jsonb_build_object('data',null,
      'error',jsonb_build_object('code',sqlstate,'message','ACCOUNT_SECTION_UNAVAILABLE'),
      'status',case when sqlstate='42501' then 403 when sqlstate in('42P01','42883','42703') then 404 when left(sqlstate,2)='22' then 400 else 500 end));
  end;
  return result;
end $$;
revoke all on function public.xelay_my_account_bootstrap() from public,anon,authenticated,service_role;
grant execute on function public.xelay_my_account_bootstrap() to authenticated;
comment on function public.xelay_my_account_bootstrap() is
  'Own account bootstrap only. SECURITY INVOKER preserves RLS; section failures grant no missing authority. No parameters, storage, writes, or role grants.';

create or replace function public.xelay_google_registration_status()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();
begin
  if v_uid is null then raise exception 'GOOGLE_AUTH_REQUIRED' using errcode='42501';end if;
  if not exists(select 1 from auth.users u where u.id=v_uid and u.deleted_at is null
    and u.email_confirmed_at is not null and (u.banned_until is null or u.banned_until<=now())) then
    raise exception 'GOOGLE_AUTH_REQUIRED' using errcode='42501';
  end if;
  if exists(select 1 from public.profiles p where p.id=v_uid) then
    return jsonb_build_object('required',false);
  end if;
  -- Only a server-owned business registration can complete this separate flow.
  -- Editable Auth metadata can neither grant this identity nor verification.
  if public.xelay_my_business_identity() is not null then
    return jsonb_build_object('required',false);
  end if;
  if not exists(select 1 from public.xelay_google_registrations g join auth.users u on u.id=g.user_id
    where g.user_id=v_uid and g.completed_at is null and u.email_confirmed_at is not null
      and u.deleted_at is null and (u.banned_until is null or u.banned_until<=now())
      and exists(select 1 from auth.identities i where i.user_id=u.id and i.provider='google'
        and i.identity_data->>'email_verified'='true')) then
    raise exception 'GOOGLE_REGISTRATION_UNAVAILABLE' using errcode='42501';
  end if;
  return jsonb_build_object('required',true);
end $$;


revoke all on function public.xelay_google_registration_status() from public,anon;
grant execute on function public.xelay_google_registration_status() to authenticated;
update public.opportunities_settings set data=data||'{"enabled":true,"advertisingEnabled":false,"entryEnabled":false}'::jsonb where id;
-- Read only the currently open conversation, with the same withdrawal redaction
-- and actor checks as the workspace. Moderation does not grant message access.
create or replace function public.xelay_opportunities_conversation(p_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=auth.uid(); v_data jsonb;
begin
  if v_uid is null or not exists(select 1 from auth.users u where u.id=v_uid
    and u.email_confirmed_at is not null and u.deleted_at is null
    and (u.banned_until is null or u.banned_until<=now())) then
    raise exception 'OPPORTUNITIES_AUTH_REQUIRED' using errcode='42501';
  end if;
  if not exists(select 1 from public.opportunities_settings where id and data->>'enabled'='true') then
    raise exception 'OPPORTUNITIES_DEVELOPMENT';
  end if;
  select case when a.status='withdrawn' and a.student_id<>v_uid then
      a.data||jsonb_build_object('resumeSnapshot',(a.data->'resumeSnapshot')||'{"file":null,"contact":""}'::jsonb,'contact','')
    else a.data end into v_data
  from public.opportunities_applications a where a.id=p_id and (a.student_id=v_uid
    or public.xelay_opportunities_company_role(a.company_id) in ('owner','recruiter'));
  return v_data;
end $$;
revoke all on function public.xelay_opportunities_conversation(uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_opportunities_conversation(uuid) to authenticated;
notify pgrst,'reload schema';
commit;
