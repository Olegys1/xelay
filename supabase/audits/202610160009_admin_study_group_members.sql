-- READ-ONLY before/after audit. Exactly one JSON cell: counts/hashes only,
-- existing security metadata and the two new read-only RPCs. Real user activity
-- can independently change a data hash. No contacts or row contents are emitted.
begin transaction isolation level repeatable read read only;
with relations as (
  select 'profiles' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.profiles t
  union all
  select 'auth.users' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from auth.users t
  union all
  select 'user_roles' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.user_roles t
  union all
  select 'study_groups' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.study_groups t
  union all
  select 'study_group_members' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.study_group_members t
  union all
  select 'class_representative_requests' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.class_representative_requests t
  union all
  select 'study_group_deputy_requests' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.study_group_deputy_requests t
  union all
  select 'study_group_schedule' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.study_group_schedule t
  union all
  select 'study_group_homework' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.study_group_homework t
  union all
  select 'study_group_long_term_tasks' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.study_group_long_term_tasks t
  union all
  select 'study_group_seminar_subjects' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.study_group_seminar_subjects t
  union all
  select 'study_group_seminar_schedule' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.study_group_seminar_schedule t
  union all
  select 'study_group_seminars' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.study_group_seminars t
  union all
  select 'study_group_seminar_questions' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.study_group_seminar_questions t
  union all
  select 'study_group_seminar_teams' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.study_group_seminar_teams t
  union all
  select 'study_group_seminar_reservations' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.study_group_seminar_reservations t
  union all
  select 'study_group_material_subjects' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.study_group_material_subjects t
  union all
  select 'study_group_materials' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.study_group_materials t
  union all
  select 'storage.objects' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from storage.objects t
  union all
  select 'notifications' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.notifications t
  union all
  select 'notification_email_outbox' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.notification_email_outbox t
  union all
  select 'profile_reports' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.profile_reports t
  union all
  select 'profile_report_requests' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.profile_report_requests t
  union all
  select 'profile_report_history' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by md5(to_jsonb(t)::text)),'')) as aggregate_row_hash from public.profile_report_history t
), functions as (
  select p.oid::regprocedure::text as signature,pg_get_userbyid(p.proowner) as owner,p.proacl::text as execution_acl,
    p.prosecdef as security_definer,p.provolatile as volatility,p.proconfig,p.pronargdefaults as default_argument_count,
    md5(pg_get_functiondef(p.oid)) as definition_hash
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in('xelay_is_platform_admin','xelay_can_read_study_group_membership',
    'xelay_can_view_study_group','xelay_is_active_study_group_member','xelay_study_group_permissions',
    'xelay_admin_study_groups','xelay_admin_study_group_members')
), policy_audit as (
  select count(*) as policy_count,md5(coalesce(string_agg(md5(to_jsonb(p)::text),'' order by p.schemaname,p.tablename,p.policyname),'')) as policy_hash
  from pg_catalog.pg_policies p where p.schemaname in('public','storage')
), table_security as (
  select n.nspname as schema,c.relname as relation,c.relrowsecurity as rls_enabled,c.relforcerowsecurity as force_rls,
    c.relacl::text as table_acl
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where (n.nspname='public' and c.relkind in('r','p')) or (n.nspname='storage' and c.relname='objects')
)
select jsonb_build_object('relations',(select jsonb_agg(to_jsonb(r) order by r.relation) from relations r),
  'functions',(select jsonb_agg(to_jsonb(f) order by f.signature) from functions f),
  'policies',(select to_jsonb(p) from policy_audit p),
  'table_security',(select jsonb_agg(to_jsonb(s) order by s.schema,s.relation) from table_security s)) as audit;
rollback;
