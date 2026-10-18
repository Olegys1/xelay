-- Read-only before/after evidence. Only receipt_check and receipt_insert_check
-- should differ immediately after applying the migration. Live users may add
-- receipts during the audit; no receipt identities or form answers are returned.
select jsonb_build_object(
  'receipt_table', (select jsonb_build_object(
      'owner', c.relowner::regrole::text, 'acl', c.relacl::text,
      'rls', c.relrowsecurity, 'force_rls', c.relforcerowsecurity)
    from pg_class c where c.oid = 'public.account_announcement_receipts'::regclass),
  'receipt_columns', (select jsonb_agg(jsonb_build_object(
      'name', a.attname, 'acl', a.attacl::text,
      'type', format_type(a.atttypid, a.atttypmod), 'not_null', a.attnotnull,
      'default', pg_get_expr(d.adbin, d.adrelid)) order by a.attnum)
    from pg_attribute a left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
    where a.attrelid = 'public.account_announcement_receipts'::regclass
      and a.attnum > 0 and not a.attisdropped),
  'receipt_policy_metadata', (select jsonb_agg(jsonb_build_object(
      'name', p.polname, 'command', p.polcmd, 'roles', p.polroles::text,
      'permissive', p.polpermissive, 'using', pg_get_expr(p.polqual, p.polrelid)) order by p.polname)
    from pg_policy p where p.polrelid = 'public.account_announcement_receipts'::regclass),
  'receipt_check', (select pg_get_constraintdef(c.oid) from pg_constraint c
    where c.conrelid = 'public.account_announcement_receipts'::regclass
      and c.conname = 'account_announcement_receipts_announcement_id_check'),
  'receipt_insert_check', (select pg_get_expr(p.polwithcheck, p.polrelid) from pg_policy p
    where p.polrelid = 'public.account_announcement_receipts'::regclass
      and p.polname = 'Record own announcement receipt'),
  'receipt_data', (select jsonb_build_object('row_count', count(*),
      'row_hash', md5(coalesce(string_agg(to_jsonb(r)::text, '' order by r.user_id, r.announcement_id), '')))
    from public.account_announcement_receipts r),
  'receipt_counts', (select coalesce(jsonb_object_agg(r.announcement_id, r.n), '{}'::jsonb)
    from (select announcement_id, count(*) as n from public.account_announcement_receipts group by announcement_id) r),
  'public_functions_hash', (select md5(coalesce(string_agg(
      p.oid::regprocedure::text || pg_get_functiondef(p.oid) || coalesce(p.proacl::text, ''),
      '' order by p.oid::regprocedure::text), ''))
    from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'),
  'all_table_access_hash', (select md5(coalesce(string_agg(
      c.oid::regclass::text || c.relowner::regrole::text || coalesce(c.relacl::text, '')
        || c.relrowsecurity::text || c.relforcerowsecurity::text,
      '' order by c.oid::regclass::text), ''))
    from pg_class c where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'),
  'all_column_access_hash', (select md5(coalesce(string_agg(
      c.oid::regclass::text || a.attname || coalesce(a.attacl::text, ''),
      '' order by c.oid::regclass::text, a.attnum), ''))
    from pg_attribute a join pg_class c on c.oid = a.attrelid
    where c.relnamespace = 'public'::regnamespace and c.relkind = 'r'
      and a.attnum > 0 and not a.attisdropped),
  'other_policies_hash', (select md5(coalesce(string_agg(to_jsonb(p)::text,
      '' order by p.tablename, p.policyname), ''))
    from pg_policies p where p.schemaname = 'public'
      and not (p.tablename = 'account_announcement_receipts' and p.policyname = 'Record own announcement receipt')),
  'other_constraints_hash', (select md5(coalesce(string_agg(
      c.conrelid::regclass::text || c.conname || pg_get_constraintdef(c.oid),
      '' order by c.conrelid::regclass::text, c.conname), ''))
    from pg_constraint c where c.connamespace = 'public'::regnamespace
      and not (c.conrelid = 'public.account_announcement_receipts'::regclass
        and c.conname = 'account_announcement_receipts_announcement_id_check'))
) as deployment_audit;
