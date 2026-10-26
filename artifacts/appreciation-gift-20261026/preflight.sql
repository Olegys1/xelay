-- Catalog metadata only; never reads recipient/account/billing rows or calls gift RPCs.
begin read only;
set local statement_timeout='15s';
with legacy(signature) as(values
  ('public.xelay_is_platform_admin()'),('public.xelay_reflow_participant_access(uuid)'),
  ('public.xelay_queue_notification_email()'),('public.xelay_queue_participant_push()'),('public.xelay_queue_teaching_email()'),
  ('public.xelay_admin_offer_birthday_gift(uuid,text)'),('public.xelay_claim_birthday_gift(uuid)'),
  ('public.xelay_profile_badge_preferences(uuid)'),('public.xelay_set_my_profile_badges(boolean,boolean)')
),f as(
  select l.signature,p.oid,p.proowner,p.proacl,p.proconfig,p.prosecdef,p.prosrc from legacy l
  left join pg_proc p on p.oid=to_regprocedure(l.signature)
),new_signatures(signature) as(values
  ('public.xelay_private_appreciation_gift_clock()'),('public.xelay_private_appreciation_gift_json(uuid,boolean)'),
  ('public.xelay_my_appreciation_gifts()'),('public.xelay_admin_offer_appreciation_gift(uuid,text)'),
  ('public.xelay_claim_appreciation_gift(uuid)'),('public.xelay_appreciation_badge(uuid)'),
  ('public.xelay_my_appreciation_badge()'),('public.xelay_set_my_appreciation_badge(boolean)'),
  ('public.xelay_guard_appreciation_gift_notification_update()')
),checks as(select
  (select count(*)=9 and bool_and(oid is not null and prosecdef) from f) legacy_functions_present,
  to_regclass('public.birthday_gifts') is not null birthday_dependency_present,
  to_regclass('public.participant_entitlements') is not null entitlement_dependency_present,
  to_regclass('public.billing_audit_log') is not null audit_dependency_present,
  to_regclass('public.appreciation_gifts') is null new_table_absent,
  (select bool_and(to_regprocedure(signature) is null) from new_signatures) all_new_functions_absent,
  exists(select 1 from pg_trigger where tgrelid=to_regclass('public.notifications') and tgname='notification_email_queue'
    and not tgisinternal and tgfoid=to_regprocedure('public.xelay_queue_notification_email()')
    and tgtype=5 and tgenabled='O' and tgnargs=0
    and position('WHEN ((new.type IS DISTINCT FROM ''birthday_gift''::text))' in pg_get_triggerdef(oid))>0) email_trigger_matches_birthdays_only_exclusion,
  (select position('new.type is distinct from ''organizer_reminder''' in lower(prosrc))>0 from f
    where signature='public.xelay_queue_participant_push()') push_is_organizer_only,
  (select position('new.type is distinct from ''teaching_update''' in lower(prosrc))>0 from f
    where signature='public.xelay_queue_teaching_email()') teaching_email_is_teaching_only,
  exists(select 1 from pg_class where oid=to_regclass('public.birthday_gifts') and relrowsecurity
    and not has_table_privilege('anon',oid,'SELECT') and not has_table_privilege('authenticated',oid,'SELECT,INSERT,UPDATE,DELETE')) birthday_table_still_private
)
select jsonb_build_object('release','appreciation-gift-20261026','catalog_only',true,
  'ready',not exists(select 1 from jsonb_each(to_jsonb(checks)) c where c.value is distinct from 'true'::jsonb),
  'checks',to_jsonb(checks),
  'notification_checks',(select coalesce(jsonb_agg(jsonb_build_object('name',conname,'expression',pg_get_expr(conbin,conrelid)) order by conname),'[]'::jsonb)
    from pg_constraint where conrelid=to_regclass('public.notifications') and contype='c'),
  'check_note','Migration 006 additionally validates notification CHECKs against a typed synthetic appreciation row and rolls back if unsupported.',
  'legacy_functions',(select jsonb_agg(jsonb_build_object('signature',signature,'present',oid is not null,
    'body_md5',md5(replace(prosrc,E'\r\n',E'\n')),'owner_oid',proowner,'acl',proacl::text,'config',proconfig) order by signature) from f)
) as appreciation_gift_preflight from checks;
commit;
