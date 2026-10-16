-- Read-only rollout fingerprints; no identities, amounts, status text or emails.
begin transaction isolation level repeatable read read only;
select jsonb_build_object(
  'snapshot_at',clock_timestamp(),
  'payments_hash',(select md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.support_orders t),
  'events_hash',(select md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.support_payment_events t),
  'premium_preferences_hash',(select md5(coalesce(string_agg(to_jsonb(t)::text,'' order by user_id),'')) from public.premium_preferences t),
  'entitlements_hash',(select md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.participant_entitlements t),
  'existing_table_access_hash',(select md5(string_agg(c.oid::regclass::text||coalesce(c.relacl::text,'')||c.relrowsecurity||c.relforcerowsecurity,'' order by c.oid::regclass::text))
    from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' and c.relname<>'supporter_badge_preferences'),
  'unchanged_policies_hash',(select md5(string_agg(polrelid::regclass::text||polname||polcmd::text||polroles::text
    ||coalesce(pg_get_expr(polqual,polrelid),'')||coalesce(pg_get_expr(polwithcheck,polrelid),''),'' order by polrelid::regclass::text,polname))
    from pg_policy where polrelid<>coalesce(to_regclass('public.supporter_badge_preferences'),0::oid)
    and not(polrelid='public.account_announcement_receipts'::regclass and polname='Record own announcement receipt')),
  'unchanged_functions_hash',(select md5(string_agg(p.oid::regprocedure::text||pg_get_functiondef(p.oid)||coalesce(p.proacl::text,''),'' order by p.oid::regprocedure::text))
    from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f'
      and p.proname not in('xelay_supporter_badges','xelay_supporter_tier','xelay_supporter_badge','xelay_my_supporter_badges','xelay_set_my_supporter_badges','xelay_set_participant_status')),
  'status_setter',(select jsonb_build_object('acl',p.proacl::text,'owner',p.proowner::regrole::text,'config',p.proconfig,'security_definer',p.prosecdef,
    'normalized_hash',md5(replace(pg_get_functiondef(p.oid),'''sticker:penguin'',''sticker:green-watch''];','''sticker:penguin''];')),
    'allows_watch',position('''sticker:green-watch''' in p.prosrc)>0)
    from pg_proc p where p.oid='public.xelay_set_participant_status(text,text)'::regprocedure),
  'badge_functions',(select jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'security_definer',p.prosecdef,'config',p.proconfig,
    'anon',has_function_privilege('anon',p.oid,'execute'),'authenticated',has_function_privilege('authenticated',p.oid,'execute'),
    'service',has_function_privilege('service_role',p.oid,'execute')) order by p.proname)
    from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in('xelay_my_supporter_badges','xelay_set_my_supporter_badges','xelay_supporter_badges','xelay_supporter_tier','xelay_supporter_badge','xelay_supporter_summary')),
  'receipt_whitelist',pg_get_constraintdef((select oid from pg_constraint where conrelid='public.account_announcement_receipts'::regclass and conname='account_announcement_receipts_announcement_id_check')),
  'receipt_insert_check',(select pg_get_expr(polwithcheck,polrelid) from pg_policy where polrelid='public.account_announcement_receipts'::regclass and polname='Record own announcement receipt')
) as display_rollout_audit;
rollback;
