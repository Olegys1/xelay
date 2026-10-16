-- READ-ONLY before/after deployment. Exactly one JSON result, containing only
-- aggregate data hashes/counts and function/table security metadata. Concurrent
-- legitimate user activity may change a data hash independently of deployment.
begin transaction isolation level repeatable read read only;
with relations as (
  select 'study_group_schedule' as relation,count(*) as row_count,md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) as aggregate_row_hash from public.study_group_schedule t
  union all select 'study_group_homework',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) from public.study_group_homework t
  union all select 'study_group_long_term_tasks',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) from public.study_group_long_term_tasks t
  union all select 'study_group_seminar_subjects',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) from public.study_group_seminar_subjects t
  union all select 'study_group_seminar_schedule',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) from public.study_group_seminar_schedule t
  union all select 'study_group_seminars',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) from public.study_group_seminars t
  union all select 'study_group_seminar_questions',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) from public.study_group_seminar_questions t
  union all select 'study_group_seminar_teams',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) from public.study_group_seminar_teams t
  union all select 'study_group_seminar_reservations',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) from public.study_group_seminar_reservations t
  union all select 'study_group_material_subjects',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) from public.study_group_material_subjects t
  union all select 'study_group_materials',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) from public.study_group_materials t
  union all select 'storage.objects',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) from storage.objects t
  union all select 'notifications',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) from public.notifications t
  union all select 'notification_email_outbox',count(*),md5(coalesce(string_agg(md5(to_jsonb(t)::text),'' order by t.id::text),'')) from public.notification_email_outbox t
), functions as (
  select p.oid::regprocedure::text as signature,pg_get_userbyid(p.proowner) as owner,p.proacl::text as execution_acl,
    p.prosecdef as security_definer,p.proconfig,p.pronargdefaults as default_argument_count,
    md5(pg_get_functiondef(p.oid)) as definition_hash
  from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid=p.pronamespace
  where n.nspname='public' and p.proname in('xelay_copy_study_group_schedule_day','xelay_copy_study_group_schedule_sequence',
    'xelay_lock_study_group_permission','xelay_study_group_permissions','xelay_schedule_occurs_on_date',
    'xelay_copy_study_group_schedule_day_with_time_mode','xelay_copy_study_group_schedule_sequence_with_time_mode',
    'xelay_private_first_shift_projection')
), policy_audit as (
  select count(*) as policy_count,md5(coalesce(string_agg(md5(to_jsonb(p)::text),'' order by p.schemaname,p.tablename,p.policyname),'')) as policy_hash
  from pg_catalog.pg_policies p where p.schemaname in('public','storage')
), table_security as (
  select n.nspname as schema,c.relname as relation,c.relrowsecurity as rls_enabled,c.relforcerowsecurity as force_rls,
    c.relacl::text as table_acl
  from pg_catalog.pg_class c join pg_catalog.pg_namespace n on n.oid=c.relnamespace
  where (n.nspname='public' and c.relname in('study_group_schedule','study_group_homework','study_group_long_term_tasks',
    'study_group_seminars','study_group_seminar_schedule','study_group_seminar_questions','study_group_seminar_teams',
    'study_group_seminar_reservations','study_group_materials','study_group_seminar_subjects','study_group_material_subjects'))
    or (n.nspname='storage' and c.relname='objects')
)
select jsonb_build_object('relations',(select jsonb_agg(to_jsonb(r) order by r.relation) from relations r),
  'functions',(select jsonb_agg(to_jsonb(f) order by f.signature) from functions f),
  'policies',(select to_jsonb(p) from policy_audit p),
  'table_security',(select jsonb_agg(to_jsonb(s) order by s.schema,s.relation) from table_security s)) as audit;
rollback;
