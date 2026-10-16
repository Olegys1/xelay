-- Read-only rollout fingerprint. Never returns identities or individual amounts.
begin transaction isolation level repeatable read read only;
select jsonb_build_object(
  'snapshot_at',clock_timestamp(),
  'payment_rows_hash',(select md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.support_orders t),
  'payment_events_hash',(select md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.support_payment_events t),
  'table_access_hash',(select md5(string_agg(c.oid::regclass::text||coalesce(c.relacl::text,'')||c.relrowsecurity||c.relforcerowsecurity,'' order by c.oid::regclass::text))
    from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r'),
  'policies_hash',(select md5(string_agg(polrelid::regclass::text||polname||polcmd::text||polroles::text
    ||coalesce(pg_get_expr(polqual,polrelid),'')||coalesce(pg_get_expr(polwithcheck,polrelid),''),'' order by polrelid::regclass::text,polname)) from pg_policy),
  'unchanged_functions_hash',(select md5(string_agg(p.oid::regprocedure::text||pg_get_functiondef(p.oid)||coalesce(p.proacl::text,''),'' order by p.oid::regprocedure::text))
    from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f'
      and p.proname not in('xelay_supporter_badges','xelay_supporter_summary')),
  'badge_functions',(select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,
    'definition_hash',md5(pg_get_functiondef(p.oid)),'security_definer',p.prosecdef,'config',p.proconfig,
    'anon_execute',has_function_privilege('anon',p.oid,'execute'),
    'authenticated_execute',has_function_privilege('authenticated',p.oid,'execute'),
    'service_execute',has_function_privilege('service_role',p.oid,'execute')) order by p.proname)
    from pg_proc p where p.pronamespace='public'::regnamespace
      and p.proname in('xelay_supporter_badges','xelay_supporter_summary'))
) as supporter_secret_audit;
rollback;
