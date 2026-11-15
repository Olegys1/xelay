-- One authenticated account round trip instead of six concurrent PostgREST
-- requests per cold login. Every table read keeps its existing RLS and an
-- explicit own-actor filter; no user ID or elevated caller is accepted.
begin;
create or replace function public.xelay_my_account_bootstrap()
returns jsonb language plpgsql stable security invoker set search_path='' as $$
declare uid uuid:=auth.uid(); result jsonb:='{}'::jsonb; value jsonb;
begin
  if uid is null then raise exception 'ACCOUNT_AUTH_REQUIRED' using errcode='42501';end if;
  -- The primary profile is authoritative: do not return roles if it is absent
  -- or if its RLS/table read fails.
  select to_jsonb(p) into value from public.profiles p where p.id=uid;
  result:=jsonb_build_object('profile',jsonb_build_object('data',value,'error',null,'status',200));
  if value is null then return result;end if;
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
commit;
