-- PREPARED HUMAN-APPROVED test1 SQL only; never a migration/production action.
-- Inserts exactly one temporary global ADMIN row for owned synthetic user A.
-- No privileges, Auth user/password/session/MFA, human role or worker changes.
-- The operator must approve this concrete row and its separate deletion SQL.
-- In the SAME confirmed test1 Dashboard call, prepend these six settings:
-- SET xelay.security_staging='true';
-- SET xelay.security_test_project='saufzpryybuawudohhwj';
-- SET xelay.security_media_run_id='<owned creator receipt run UUID>';
-- SET xelay.security_media_user_a='<owned creator receipt A UUID>';
-- SET xelay.security_mfa_probe_id='<fresh local probe UUID>';
-- SET xelay.security_mfa_role_id='<fresh local exact role UUID>';
-- Save returned JSON as .security-audit.local/test1-mfa-role-seed-<probe>.json.
-- Probe verifies A's self-role SELECT before real MFA and never deletes this
-- row itself. Use security_staging_mfa_role_cleanup.sql immediately afterward.
begin;
set local statement_timeout='15s';
set local lock_timeout='2s';
do $$
declare
  v_run text:=current_setting('xelay.security_media_run_id',true);
  v_user text:=current_setting('xelay.security_media_user_a',true);
  v_probe text:=current_setting('xelay.security_mfa_probe_id',true);
  v_role text:=current_setting('xelay.security_mfa_role_id',true);
  v_value text; v_row public.user_roles%rowtype;
begin
  if session_user not in('postgres','supabase_admin') or current_user not in('postgres','supabase_admin')
    or current_setting('xelay.security_staging',true) is distinct from 'true'
    or current_setting('xelay.security_test_project',true) is distinct from 'saufzpryybuawudohhwj' then
    raise exception 'Explicit trusted test1 confirmation and approved temporary role required'; end if;
  if (coalesce(current_setting('app.settings.supabase_url',true),'')||coalesce(current_setting('api.external_url',true),''))
    like '%baohfpadxvhqhhjjqtil%' then raise exception 'Known production refused'; end if;
  if to_regclass('xelay_staging.installation') is null then raise exception 'Staging manifest missing'; end if;
  if (select count(*) from xelay_staging.installation)<>45 then raise exception 'Expected installed test1 manifest45'; end if;
  foreach v_value in array array[v_run,v_user,v_probe,v_role] loop
    if v_value is null or v_value !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'Exact owned synthetic run/user/probe/role UUIDs required'; end if;
  end loop;
  v_run:=v_run::uuid::text;v_user:=v_user::uuid::text;v_probe:=v_probe::uuid::text;v_role:=v_role::uuid::text;
  if v_user=v_role or v_user=v_probe or v_role=v_probe then raise exception 'Distinct role/probe UUIDs required'; end if;
  if not exists(select 1 from auth.users u join public.profiles p on p.id=u.id where u.id=v_user::uuid
    and u.email_confirmed_at is not null and u.deleted_at is null
    and u.email='security_media_a_'||replace(v_run,'-','')||'@example.test'
    and u.raw_app_meta_data->>'xelay_security_fixture'='media-v1'
    and u.raw_app_meta_data->>'xelay_security_run_id'=v_run and u.raw_app_meta_data->>'xelay_security_label'='A'
    and u.raw_user_meta_data->>'username'='security_media_a_'||left(v_run,8)
    and p.username='security_media_a_'||left(v_run,8) and p.email=u.email) then
    raise exception 'Only the confirmed owned synthetic A and its profile are eligible'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-test1-mfa-role:'||v_user,0));
  if exists(select 1 from public.user_roles where user_id=v_user::uuid)
    or exists(select 1 from public.user_roles where id=v_role::uuid)
    or exists(select 1 from auth.mfa_factors where user_id=v_user::uuid) then
    raise exception 'Synthetic A must have empty initial role and factor baselines'; end if;
  insert into public.user_roles(id,user_id,role,university_id,academic_unit_id,granted_by)
    values(v_role::uuid,v_user::uuid,'ADMIN',null,null,null) returning * into v_row;
  perform set_config('xelay.security_mfa_role_seed',jsonb_build_object('mode','test1-mfa-role-seed',
    'projectRef','saufzpryybuawudohhwj','origin','https://saufzpryybuawudohhwj.supabase.co','runId',v_run,
    'probeId',v_probe,'userId',v_user,'adminRoleId',v_role,'originalRoles','[]'::jsonb,
    'initialRoleBaselineEmpty',true,'syntheticUserConfirmed',true,'role',to_jsonb(v_row))::text,true);
end $$;
select current_setting('xelay.security_mfa_role_seed')::jsonb as security_mfa_role_seed;
reset xelay.security_staging;reset xelay.security_test_project;
reset xelay.security_media_run_id;reset xelay.security_media_user_a;
reset xelay.security_mfa_probe_id;reset xelay.security_mfa_role_id;
commit;
