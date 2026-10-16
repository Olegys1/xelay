-- Read-only deployment evidence: only receipt whitelist/CHECK may change.
begin transaction isolation level repeatable read read only;
select jsonb_build_object(
  'snapshot_at',clock_timestamp(),
  'receipt_table',(select jsonb_build_object('acl',relacl::text,'rls',relrowsecurity,'force_rls',relforcerowsecurity)
    from pg_class where oid='public.account_announcement_receipts'::regclass),
  'receipt_columns',(select jsonb_agg(jsonb_build_object('name',a.attname,'acl',a.attacl::text,'type',format_type(a.atttypid,a.atttypmod),
    'default',pg_get_expr(d.adbin,d.adrelid)) order by a.attnum) from pg_attribute a
    left join pg_attrdef d on d.adrelid=a.attrelid and d.adnum=a.attnum
    where a.attrelid='public.account_announcement_receipts'::regclass and a.attnum>0 and not a.attisdropped),
  'receipt_policies',(select jsonb_agg(jsonb_build_object('name',polname,'command',polcmd,'roles',polroles::text,
    'using',pg_get_expr(polqual,polrelid),'check',pg_get_expr(polwithcheck,polrelid)) order by polname)
    from pg_policy where polrelid='public.account_announcement_receipts'::regclass),
  'receipt_check',(select pg_get_constraintdef(oid) from pg_constraint
    where conrelid='public.account_announcement_receipts'::regclass and conname='account_announcement_receipts_announcement_id_check'),
  'existing_receipt_counts',(select jsonb_object_agg(announcement_id,n) from(
    select announcement_id,count(*) as n from public.account_announcement_receipts group by announcement_id)t),
  'public_functions_hash',(select md5(string_agg(p.oid::regprocedure::text||pg_get_functiondef(p.oid)||coalesce(p.proacl::text,''),'' order by p.oid::regprocedure::text))
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.prokind='f'),
  'all_table_access_hash',(select md5(string_agg(c.oid::regclass::text||coalesce(c.relacl::text,'')||c.relrowsecurity||c.relforcerowsecurity,'' order by c.oid::regclass::text))
    from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r')
) as deployment_audit;
rollback;
