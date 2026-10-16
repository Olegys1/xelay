-- READ-ONLY before/after audit. Existing-data hashes contain no row contents,
-- contacts or identifiers. Concurrent legitimate changes may change a hash.
begin transaction isolation level repeatable read read only;

select 'profiles' as relation,count(*) as row_count,
  md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) as aggregate_row_hash
from public.profiles t
union all
select 'auth.users',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) from auth.users t
union all
select 'participant_entitlements',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) from public.participant_entitlements t
union all
select 'premium_preferences',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.user_id::text),'')) from public.premium_preferences t
union all
select 'participant_appearance_preferences',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.user_id::text),'')) from public.participant_appearance_preferences t
union all
select 'notifications',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) from public.notifications t
union all
select 'notification_email_outbox',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) from public.notification_email_outbox t
order by relation;

-- Setter/admin guard hashes and ACLs must remain unchanged; only the four new
-- report RPCs should appear. No function implementation or user data is exposed.
select p.oid::regprocedure::text as signature,pg_get_userbyid(p.proowner) as owner,
  p.proacl::text as execution_acl,p.prosecdef as security_definer,p.proconfig,md5(p.prosrc) as implementation_hash
from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
where n.nspname='public' and p.proname in('xelay_is_platform_admin','xelay_set_participant_status',
  'xelay_has_participant_access','xelay_submit_profile_report','xelay_admin_profile_reports',
  'xelay_admin_profile_report','xelay_admin_review_profile_report') order by signature;

-- No SELECT/INSERT/UPDATE/DELETE grant to any API role, including service_role;
-- RLS is enabled and there are no table policies. Empty before migration 007.
select c.relname as relation,c.relrowsecurity as rls_enabled,
  (select count(*) from pg_catalog.pg_policy p where p.polrelid=c.oid) as policy_count,
  r.rolname as role,
  has_table_privilege(r.oid,c.oid,'select,insert,update,delete') as any_direct_access
from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
cross join pg_catalog.pg_roles r
where n.nspname='public' and c.relname in('profile_reports','profile_report_requests','profile_report_history')
  and r.rolname in('anon','authenticated','service_role') order by relation,role;

rollback;
