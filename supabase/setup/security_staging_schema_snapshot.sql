-- Single result set for Supabase SQL Editor Export -> Copy JSON.
-- SELECT ONLY. Intended target: test1 / saufzpryybuawudohhwj; check UI target.
-- Catalog metadata only: no user rows, URL values, secrets, function bodies,
-- trigger arguments, JWTs, bucket object names or Auth-factor contents.
-- NULL optional settings do NOT prove which project/API schema is connected.
select jsonb_build_object(
  'versions',jsonb_build_object(
    'postgres',current_setting('server_version'),
    'postgres_number',current_setting('server_version_num')::integer,
    'database',current_database(),'sql_role',current_user,
    'intended_staging_project','saufzpryybuawudohhwj',
    'db_exposed_schema_setting',nullif(current_setting('pgrst.db_schemas',true),''),
    'known_production_detected_by_optional_url_settings',case
      when coalesce(current_setting('app.settings.supabase_url',true),'')
        || coalesce(current_setting('api.external_url',true),'')='' then null
      else (coalesce(current_setting('app.settings.supabase_url',true),'')
        || coalesce(current_setting('api.external_url',true),'')) like '%baohfpadxvhqhhjjqtil%' end),
  'extensions',coalesce((select jsonb_agg(to_jsonb(m) order by extname) from (
    select e.extname,e.extversion,n.nspname as installed_schema
    from pg_extension e join pg_namespace n on n.oid=e.extnamespace) m),'[]'::jsonb),
  'features',coalesce((select jsonb_agg(to_jsonb(m) order by signature) from (
    select f.signature,to_regprocedure(f.signature) is not null as installed
    from (values ('pg_catalog.gen_random_uuid()'),('auth.uid()'),('auth.jwt()'),('auth.role()'),
      ('storage.foldername(text)'),('storage.extension(text)'),
      ('extensions.uuid_generate_v4()'),('extensions.digest(bytea,text)'),
      ('net.http_post(text,jsonb,jsonb,jsonb,integer)')) f(signature)) m),'[]'::jsonb),
  'roles',coalesce((select jsonb_agg(to_jsonb(m) order by rolname) from (
    select rolname,rolsuper,rolbypassrls,rolinherit,rolcanlogin from pg_roles
    where rolname in ('anon','authenticated','service_role','postgres','supabase_admin',
      'supabase_auth_admin','supabase_storage_admin')) m),'[]'::jsonb),
  'default_acl',coalesce((select jsonb_agg(to_jsonb(m) order by object_creator,schema_name,object_type,grantee,privilege_type) from (
    select pg_get_userbyid(d.defaclrole) as object_creator,
      coalesce(n.nspname,'ALL SCHEMAS') as schema_name,d.defaclobjtype as object_type,
      case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
      a.privilege_type,a.is_grantable
    from pg_default_acl d left join pg_namespace n on n.oid=d.defaclnamespace
    cross join lateral aclexplode(d.defaclacl) a) m),'[]'::jsonb),
  'effective_table_grants',coalesce((select jsonb_agg(to_jsonb(m) order by schema_name,object_name) from (
    select n.nspname as schema_name,c.relname as object_name,c.relkind,
      c.relrowsecurity as rls_enabled,c.relforcerowsecurity as force_rls,
      c.relreplident as replica_identity,
      has_table_privilege('anon',c.oid,'SELECT') as anon_select,
      has_table_privilege('anon',c.oid,'INSERT,UPDATE,DELETE') as anon_any_mutation,
      has_table_privilege('authenticated',c.oid,'SELECT') as authenticated_select,
      has_table_privilege('authenticated',c.oid,'INSERT,UPDATE,DELETE') as authenticated_any_mutation,
      exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
        and has_column_privilege('anon',c.oid,a.attnum,'SELECT')) as anon_any_column_select,
      exists(select 1 from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
        and has_column_privilege('anon',c.oid,a.attnum,'INSERT,UPDATE')) as anon_any_column_mutation
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname in ('public','storage') and c.relkind in ('r','p','v','m','f')) m),'[]'::jsonb),
  'table_acl',coalesce((select jsonb_agg(to_jsonb(m) order by schema_name,table_name,grantee,privilege_type) from (
    select n.nspname as schema_name,c.relname as table_name,
      case when a.grantee=0 then 'PUBLIC' else pg_get_userbyid(a.grantee) end as grantee,
      a.privilege_type,a.is_grantable from pg_class c join pg_namespace n on n.oid=c.relnamespace
    cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a
    where n.nspname in ('public','storage') and c.relkind in ('r','p','v','m','f')) m),'[]'::jsonb),
  'column_grants',coalesce((select jsonb_agg(to_jsonb(m) order by table_schema,table_name,column_name,grantee,privilege_type) from (
    select table_schema,table_name,column_name,grantee,privilege_type,is_grantable
    from information_schema.column_privileges where table_schema in ('public','storage')
      and grantee in ('PUBLIC','anon','authenticated','service_role')) m),'[]'::jsonb),
  'policy_structure',coalesce((select jsonb_agg(to_jsonb(m) order by schemaname,tablename,policyname) from (
    select schemaname,tablename,policyname,permissive,roles,cmd,
      qual is not null as has_using,with_check is not null as has_with_check,
      regexp_replace(coalesce(qual,''),'[()[:space:]]','','g')='true' as using_literal_true,
      regexp_replace(coalesce(with_check,''),'[()[:space:]]','','g')='true' as check_literal_true
    from pg_policies where schemaname in ('public','storage')) m),'[]'::jsonb),
  'trigger_structure',coalesce((select jsonb_agg(to_jsonb(m) order by table_schema,table_name,trigger_name) from (
    select n.nspname as table_schema,c.relname as table_name,t.tgname as trigger_name,
      t.tgenabled as enabled,pn.nspname as function_schema,p.proname as function_name,
      p.prosecdef as security_definer,octet_length(t.tgargs)>0 as has_redacted_arguments,
      (pn.nspname in ('http','net','supabase_functions') or p.proname ilike '%http%'
        or p.prosrc ~* '(net[.]http_|http_post|http_get)') as possible_outbound_http_hook
    from pg_trigger t join pg_class c on c.oid=t.tgrelid join pg_namespace n on n.oid=c.relnamespace
    join pg_proc p on p.oid=t.tgfoid join pg_namespace pn on pn.oid=p.pronamespace
    where not t.tgisinternal and n.nspname in ('auth','public','storage')) m),'[]'::jsonb),
  'public_function_acl',coalesce((select jsonb_agg(to_jsonb(m) order by function_name,argument_types) from (
    select p.proname as function_name,pg_get_function_identity_arguments(p.oid) as argument_types,
      p.prosecdef as security_definer,
      (select string_agg(setting,',') from unnest(p.proconfig) setting where setting like 'search_path=%') as search_path_only,
      has_function_privilege('anon',p.oid,'EXECUTE') as anon_execute,
      has_function_privilege('authenticated',p.oid,'EXECUTE') as authenticated_execute,
      has_function_privilege('service_role',p.oid,'EXECUTE') as service_execute
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f') m),'[]'::jsonb),
  'publications',coalesce((select jsonb_agg(to_jsonb(m) order by pubname) from (
    select pubname,puballtables,pubinsert,pubupdate,pubdelete,pubtruncate from pg_publication) m),'[]'::jsonb),
  'publication_tables',coalesce((select jsonb_agg(to_jsonb(m) order by pubname,schemaname,tablename) from (
    select pubname,schemaname,tablename from pg_publication_tables) m),'[]'::jsonb),
  'managed_column_shapes',coalesce((select jsonb_agg(to_jsonb(m) order by table_schema,table_name,ordinal_position) from (
    select table_schema,table_name,column_name,data_type,udt_schema,udt_name,is_nullable,ordinal_position,
      column_default is not null as has_default from information_schema.columns
    where (table_schema='auth' and table_name in ('users','mfa_factors'))
      or (table_schema='storage' and table_name in ('objects','buckets'))) m),'[]'::jsonb)
) as security_schema_snapshot;
