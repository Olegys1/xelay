-- Catalog metadata only. Compare legacy hashes/owners/ACLs with preflight.
-- No recipient, account, subscription dates, gift values or billing rows are read.
begin read only;
set local statement_timeout='15s';
with required(signature,kind) as(values
  ('public.xelay_private_appreciation_gift_clock()','clock'),('public.xelay_private_appreciation_gift_json(uuid,boolean)','private'),
  ('public.xelay_my_appreciation_gifts()','owner'),('public.xelay_admin_offer_appreciation_gift(uuid,text)','owner'),
  ('public.xelay_claim_appreciation_gift(uuid)','owner'),('public.xelay_appreciation_badge(uuid)','public_badge'),
  ('public.xelay_my_appreciation_badge()','owner'),('public.xelay_set_my_appreciation_badge(boolean)','owner'),
  ('public.xelay_guard_appreciation_gift_notification_update()','private')
),f as(
  select r.*,p.oid,p.prosecdef,p.proconfig,p.prosrc,
    has_function_privilege('anon',p.oid,'EXECUTE') anon_execute,
    has_function_privilege('authenticated',p.oid,'EXECUTE') authenticated_execute,
    has_function_privilege('service_role',p.oid,'EXECUTE') service_execute,
    exists(select 1 from aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a where a.grantee=0 and a.privilege_type='EXECUTE') public_execute
  from required r left join pg_proc p on p.oid=to_regprocedure(r.signature)
),legacy(signature) as(values
  ('public.xelay_is_platform_admin()'),('public.xelay_reflow_participant_access(uuid)'),
  ('public.xelay_queue_notification_email()'),('public.xelay_queue_participant_push()'),('public.xelay_queue_teaching_email()'),
  ('public.xelay_admin_offer_birthday_gift(uuid,text)'),('public.xelay_claim_birthday_gift(uuid)'),
  ('public.xelay_profile_badge_preferences(uuid)'),('public.xelay_set_my_profile_badges(boolean,boolean)')
),checks as(select
  (select count(*)=9 and bool_and(oid is not null and prosecdef=(kind<>'clock') and array_to_string(proconfig,',')='search_path=""') from f) functions_installed_with_expected_security,
  (select bool_and(not public_execute and anon_execute=(kind='public_badge') and service_execute=(kind='public_badge')
    and authenticated_execute=(kind in('owner','public_badge'))) from f) function_acl_expected,
  exists(select 1 from pg_class c where c.oid=to_regclass('public.appreciation_gifts') and c.relrowsecurity
    and not has_table_privilege('anon',c.oid,'SELECT,INSERT,UPDATE,DELETE')
    and not has_table_privilege('authenticated',c.oid,'SELECT,INSERT,UPDATE,DELETE')
    and not has_table_privilege('service_role',c.oid,'SELECT,INSERT,UPDATE,DELETE')
    and not exists(select 1 from aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a where a.grantee=0)) table_private_with_rls,
  not exists(select 1 from pg_policy where polrelid=to_regclass('public.appreciation_gifts')) no_browser_table_policies,
  (select p.prorettype='boolean'::regtype and position('claimed_at is not null and badge_visible' in lower(p.prosrc))>0
    and position('valid_until' in lower(p.prosrc))=0 and position('participant_entitlements' in lower(p.prosrc))=0
    from pg_proc p where p.oid=to_regprocedure('public.xelay_appreciation_badge(uuid)')) public_badge_is_only_hidden_aware_boolean,
  (select position('''aal2''' in prosrc)>0 and position('auth.mfa_factors' in prosrc)>0
    from f where kind='owner' and signature='public.xelay_admin_offer_appreciation_gift(uuid,text)') offer_requires_explicit_mfa,
  exists(select 1 from pg_trigger where tgrelid=to_regclass('public.notifications') and tgname='notification_email_queue'
    and tgfoid=to_regprocedure('public.xelay_queue_notification_email()') and tgtype=5 and tgenabled='O'
    and position('new.type IS DISTINCT FROM ''birthday_gift''::text' in pg_get_triggerdef(oid))>0
    and position('new.type IS DISTINCT FROM ''appreciation_gift''::text' in pg_get_triggerdef(oid))>0) gift_email_exclusions_present,
  exists(select 1 from pg_trigger where tgrelid=to_regclass('public.notifications') and tgname='appreciation_gift_notification_update_guard'
    and tgfoid=to_regprocedure('public.xelay_guard_appreciation_gift_notification_update()') and tgtype=19 and tgenabled='O') notification_guard_present,
  exists(select 1 from pg_policy where polrelid=to_regclass('public.notifications') and polname='Appreciation gift notifications server insert'
    and not polpermissive and polcmd='a') restrictive_notification_insert_policy
)
select jsonb_build_object('release','appreciation-gift-20261026','catalog_only',true,
  'passed',not exists(select 1 from jsonb_each(to_jsonb(checks)) c where c.value is distinct from 'true'::jsonb),
  'checks',to_jsonb(checks),
  'function_access',(select jsonb_agg(jsonb_build_object('signature',signature,'kind',kind,'public_execute',public_execute,
    'anon_execute',anon_execute,'authenticated_execute',authenticated_execute,'service_execute',service_execute) order by signature) from f),
  'legacy_functions',(select jsonb_agg(jsonb_build_object('signature',l.signature,'present',p.oid is not null,
    'body_md5',md5(replace(p.prosrc,E'\r\n',E'\n')),'owner_oid',p.proowner,'acl',p.proacl::text,'config',p.proconfig) order by l.signature)
    from legacy l left join pg_proc p on p.oid=to_regprocedure(l.signature))
) as appreciation_gift_postflight from checks;
commit;
