-- Safe before/after verification. Only SELECT in a read-only transaction.
-- Returns hashes/counts, function metadata and table privileges; no names,
-- contacts, membership identifiers, content, authentication claims or secrets.
begin read only;
set local statement_timeout='30s';

with functions as (
 select p.oid::regprocedure::text as signature,
  encode(extensions.digest(replace(p.prosrc,chr(13),''),'sha256'),'hex') as source_sha256,
  md5((to_jsonb(p)-'prosrc')::text) as metadata_fingerprint,
  p.oid,p.proowner,p.proacl::text as execute_acl,p.prosecdef,p.provolatile,p.proconfig,
  p.prorettype::regtype::text as returns_type,
  has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
  has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
  has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
 from pg_catalog.pg_proc p
 where p.oid in ('public.xelay_study_group_permissions(uuid)'::regprocedure,
  'public.xelay_remove_study_group_member(uuid)'::regprocedure)
), relation_fingerprints as (
 select 'study_groups' as relation,count(*) as rows,
  md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) as fingerprint from public.study_groups t
 union all
 select 'study_group_members',count(*),
  md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) from public.study_group_members t
 union all
 select 'study_group_deputy_requests',count(*),
  md5(coalesce(jsonb_agg(to_jsonb(t) order by to_jsonb(t)::text)::text,'[]')) from public.study_group_deputy_requests t
), table_guards as (
 select c.relname,c.relrowsecurity,c.relforcerowsecurity,
  md5(coalesce(c.relacl::text,'')) as acl_fingerprint,
  has_table_privilege('authenticated',c.oid,'INSERT') as authenticated_insert,
  has_table_privilege('authenticated',c.oid,'UPDATE') as authenticated_update,
  has_table_privilege('authenticated',c.oid,'DELETE') as authenticated_delete,
  (select md5(coalesce(jsonb_agg(to_jsonb(p) order by p.polname)::text,'[]'))
   from pg_catalog.pg_policy p where p.polrelid=c.oid) as policy_fingerprint
 from pg_catalog.pg_class c
 where c.oid in ('public.study_groups'::regclass,'public.study_group_members'::regclass,
  'public.study_group_deputy_requests'::regclass)
)
select jsonb_build_object('checked_at_utc',clock_timestamp(),
 'functions',(select jsonb_agg(to_jsonb(f) order by f.signature) from functions f),
 'relation_fingerprints',(select jsonb_agg(to_jsonb(r) order by r.relation) from relation_fingerprints r),
 'table_guards',(select jsonb_agg(to_jsonb(g) order by g.relname) from table_guards g)
) as verification;
commit;
