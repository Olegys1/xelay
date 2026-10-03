-- Deploy the enrollment UI and enroll both platform admins before applying this.
begin;
create or replace function public.xelay_is_platform_admin()
returns boolean language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and coalesce(auth.jwt()->>'aal','') = 'aal2'
    and exists(select 1 from public.user_roles r where r.user_id=auth.uid() and r.role='ADMIN')
    and exists(select 1 from auth.mfa_factors f where f.user_id=auth.uid() and f.status='verified');
$$;
revoke all on function public.xelay_is_platform_admin() from public,anon;
grant execute on function public.xelay_is_platform_admin() to authenticated,service_role;
commit;
