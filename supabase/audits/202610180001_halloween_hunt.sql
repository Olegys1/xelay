-- Read-only before/after installation audit. Empty campaign installation must
-- leave all existing financial rows, entitlements, consents and functions intact.
select jsonb_build_object(
  'payments',(select jsonb_agg(row_value order by name) from(
    select 'billing_orders' as name,count(*) as row_count,md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) as row_hash from public.billing_orders t
    union all select 'billing_payment_events',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.billing_payment_events t
    union all select 'support_orders',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.support_orders t
    union all select 'support_payment_events',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.support_payment_events t
    union all select 'participant_entitlements',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.participant_entitlements t
    union all select 'premium_preferences',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'' order by user_id),'')) from public.premium_preferences t
    union all select 'supporter_badge_preferences',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'' order by user_id),'')) from public.supporter_badge_preferences t
  ) row_value),
  'other_functions_hash',(select md5(coalesce(string_agg(pg_get_functiondef(p.oid)||coalesce(p.proacl::text,''),'' order by p.oid),''))
    from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f'
      and p.proname not in('xelay_private_halloween_clock','xelay_my_halloween_hunt','xelay_collect_halloween_pumpkin',
        'xelay_set_my_halloween_badge','xelay_halloween_badge','xelay_guard_halloween_notification_update')),
  'existing_table_acl_hash',(select md5(coalesce(string_agg(c.relname||coalesce(c.relacl::text,'')||c.relrowsecurity::text,'' order by c.relname),''))
    from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r'
      and c.relname not in('halloween_2026_campaign','halloween_2026_collections','halloween_2026_rewards')),
  'other_policies_hash',(select md5(coalesce(string_agg(to_jsonb(p)::text,'' order by p.tablename,p.policyname),''))
    from pg_policies p where p.schemaname='public' and p.policyname<>'Halloween reward notifications server insert'),
  'halloween_functions',(select coalesce(jsonb_agg(jsonb_build_object(
      'name',p.proname,'security_definer',p.prosecdef,'config',p.proconfig,
      'anon_execute',has_function_privilege('anon',p.oid,'execute'),
      'authenticated_execute',has_function_privilege('authenticated',p.oid,'execute'),
      'service_execute',has_function_privilege('service_role',p.oid,'execute')) order by p.proname),'[]'::jsonb)
    from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in(
      'xelay_private_halloween_clock','xelay_my_halloween_hunt','xelay_collect_halloween_pumpkin',
      'xelay_set_my_halloween_badge','xelay_halloween_badge','xelay_guard_halloween_notification_update')),
  'halloween_tables',(select coalesce(jsonb_agg(jsonb_build_object(
      'name',c.relname,'rls',c.relrowsecurity,
      'anon_select',has_table_privilege('anon',c.oid,'select'),
      'authenticated_select',has_table_privilege('authenticated',c.oid,'select'),
      'authenticated_write',has_table_privilege('authenticated',c.oid,'insert,update,delete')) order by c.relname),'[]'::jsonb)
    from pg_class c where c.relnamespace='public'::regnamespace and c.relname in(
      'halloween_2026_campaign','halloween_2026_collections','halloween_2026_rewards'))
) as audit;
