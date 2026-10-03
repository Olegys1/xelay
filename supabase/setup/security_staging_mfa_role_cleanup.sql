-- PREPARED HUMAN-APPROVED test1 SQL only. Deletes solely the exact temporary
-- ADMIN tuple recorded by security_staging_mfa_role_seed.sql, including time.
-- No role grants, unrelated role deletion or Auth/Storage mutation occurs.
-- Prepend the SAME six settings used by the seed plus the returned timestamp:
-- SET xelay.security_mfa_role_granted_at='<seed JSON role.granted_at>';
-- Known run/probe/role IDs must come from the durable owned seed JSON.
-- Run after the bounded MFA probe (including after failure). Removal of ADMIN
-- is not blocked by a failed factor cleanup: remaining exact MFA factors are
-- reported and can be retried with --restore-only using service Auth only.
begin;
set local statement_timeout='15s';
set local lock_timeout='2s';
do $$
declare
  v_run text:=current_setting('xelay.security_media_run_id',true);
  v_user text:=current_setting('xelay.security_media_user_a',true);
  v_probe text:=current_setting('xelay.security_mfa_probe_id',true);
  v_role text:=current_setting('xelay.security_mfa_role_id',true);
  v_time text:=current_setting('xelay.security_mfa_role_granted_at',true);
  v_granted timestamptz; v_value text; v_row public.user_roles%rowtype;
  v_deleted integer; v_remaining integer; v_factors integer;
begin
  if session_user not in('postgres','supabase_admin') or current_user not in('postgres','supabase_admin')
    or current_setting('xelay.security_staging',true) is distinct from 'true'
    or current_setting('xelay.security_test_project',true) is distinct from 'saufzpryybuawudohhwj' then
    raise exception 'Explicit trusted test1 confirmation and approved exact role cleanup required'; end if;
  if (coalesce(current_setting('app.settings.supabase_url',true),'')||coalesce(current_setting('api.external_url',true),''))
    like '%baohfpadxvhqhhjjqtil%' then raise exception 'Known production refused'; end if;
  if to_regclass('xelay_staging.installation') is null then raise exception 'Staging manifest missing'; end if;
  if (select count(*) from xelay_staging.installation)<>45 then raise exception 'Expected installed test1 manifest45'; end if;
  foreach v_value in array array[v_run,v_user,v_probe,v_role] loop
    if v_value is null or v_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Exact owned synthetic run/user/probe/role UUIDs required'; end if;
  end loop;
  v_run:=v_run::uuid::text;v_user:=v_user::uuid::text;v_probe:=v_probe::uuid::text;v_role:=v_role::uuid::text;
  if v_time is null or length(v_time)>64 then raise exception 'Exact seed role timestamp required'; end if;
  begin v_granted:=v_time::timestamptz;
  exception when invalid_datetime_format or datetime_field_overflow then raise exception 'Exact seed role timestamp required'; end;
  if v_granted is null or not isfinite(v_granted) then raise exception 'Finite exact seed role timestamp required'; end if;
  if not exists(select 1 from auth.users u join public.profiles p on p.id=u.id where u.id=v_user::uuid
    and u.email_confirmed_at is not null and u.deleted_at is null
    and u.email='security_media_a_'||replace(v_run,'-','')||'@example.test'
    and u.raw_app_meta_data->>'xelay_security_fixture'='media-v1'
    and u.raw_app_meta_data->>'xelay_security_run_id'=v_run and u.raw_app_meta_data->>'xelay_security_label'='A'
    and u.raw_user_meta_data->>'username'='security_media_a_'||left(v_run,8)
    and p.username='security_media_a_'||left(v_run,8) and p.email=u.email) then
    raise exception 'Only the confirmed owned synthetic A and its profile are eligible'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-test1-mfa-role:'||v_user,0));
  select * into v_row from public.user_roles where id=v_role::uuid for update;
  if found and (v_row.user_id<>v_user::uuid or v_row.role<>'ADMIN' or v_row.university_id is not null
    or v_row.academic_unit_id is not null or v_row.granted_by is not null or v_row.granted_at<>v_granted) then
    raise exception 'Role differs from the exact owned seed tuple; nothing deleted'; end if;
  delete from public.user_roles where id=v_role::uuid and user_id=v_user::uuid and role='ADMIN'
    and university_id is null and academic_unit_id is null and granted_by is null and granted_at=v_granted;
  get diagnostics v_deleted=row_count;
  select count(*) into v_remaining from public.user_roles where user_id=v_user::uuid;
  select count(*) into v_factors from auth.mfa_factors where user_id=v_user::uuid
    and friendly_name='security_media_mfa_'||v_probe;
  perform set_config('xelay.security_mfa_role_cleanup',jsonb_build_object('mode','test1-mfa-role-cleanup',
    'projectRef','saufzpryybuawudohhwj','runId',v_run,'probeId',v_probe,'userId',v_user,'adminRoleId',v_role,
    'roleDeleted',v_deleted,'exactRoleAbsent',not exists(select 1 from public.user_roles where id=v_role::uuid),
    'initialRoleBaselineRestored',v_remaining=0,'remainingOwnRoles',v_remaining,'remainingExactMfaFactors',v_factors)::text,true);
end $$;
select current_setting('xelay.security_mfa_role_cleanup')::jsonb as security_mfa_role_cleanup;
reset xelay.security_staging;reset xelay.security_test_project;
reset xelay.security_media_run_id;reset xelay.security_media_user_a;
reset xelay.security_mfa_probe_id;reset xelay.security_mfa_role_id;reset xelay.security_mfa_role_granted_at;
commit;
