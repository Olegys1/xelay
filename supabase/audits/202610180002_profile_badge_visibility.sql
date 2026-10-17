-- Read-only before/after audit. Only the new table and its two decorative
-- preference RPCs are excluded from hashes of existing data and permissions.
select jsonb_build_object(
  'existing_data',(select jsonb_agg(v order by name) from (
    select 'profiles' as name,count(*) as row_count,md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) as row_hash from public.profiles t
    union all select 'user_roles',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.user_roles t
    union all select 'teacher_verification_requests',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.teacher_verification_requests t
    union all select 'participant_entitlements',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.participant_entitlements t
    union all select 'billing_orders',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.billing_orders t
    union all select 'billing_payment_events',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.billing_payment_events t
    union all select 'premium_preferences',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'' order by user_id),'')) from public.premium_preferences t
    union all select 'support_orders',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.support_orders t
    union all select 'support_payment_events',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'' order by id),'')) from public.support_payment_events t
    union all select 'supporter_badge_preferences',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'' order by user_id),'')) from public.supporter_badge_preferences t
    union all select 'halloween_2026_rewards',count(*),md5(coalesce(string_agg(to_jsonb(t)::text,'' order by user_id),'')) from public.halloween_2026_rewards t
  ) v),
  'other_functions_hash',(select md5(coalesce(string_agg(pg_get_functiondef(p.oid)||coalesce(p.proacl::text,''),'' order by p.oid),''))
    from pg_proc p where p.pronamespace='public'::regnamespace and p.prokind='f'
      and p.proname not in('xelay_profile_badge_preferences','xelay_set_my_profile_badges')),
  'existing_table_acl_hash',(select md5(coalesce(string_agg(c.relname||coalesce(c.relacl::text,'')||c.relrowsecurity::text,'' order by c.relname),''))
    from pg_class c where c.relnamespace='public'::regnamespace and c.relkind='r' and c.relname<>'profile_badge_preferences'),
  'existing_policies_hash',(select md5(coalesce(string_agg(to_jsonb(p)::text,'' order by p.tablename,p.policyname),''))
    from pg_policies p where p.schemaname='public' and p.tablename<>'profile_badge_preferences'),
  'functions',(select coalesce(jsonb_agg(jsonb_build_object(
      'name',p.proname,'security_definer',p.prosecdef,'config',p.proconfig,
      'anon_execute',has_function_privilege('anon',p.oid,'execute'),
      'authenticated_execute',has_function_privilege('authenticated',p.oid,'execute'),
      'service_execute',has_function_privilege('service_role',p.oid,'execute')) order by p.proname),'[]'::jsonb)
    from pg_proc p where p.pronamespace='public'::regnamespace and p.proname in('xelay_profile_badge_preferences','xelay_set_my_profile_badges')),
  'table',(select jsonb_build_object('rls',c.relrowsecurity,
      'anon_select',has_table_privilege('anon',c.oid,'select'),
      'authenticated_select',has_table_privilege('authenticated',c.oid,'select'),
      'authenticated_write',has_table_privilege('authenticated',c.oid,'insert,update,delete'),
      'service_select',has_table_privilege('service_role',c.oid,'select'))
    from pg_class c where c.relnamespace='public'::regnamespace and c.relname='profile_badge_preferences')
) as audit;
