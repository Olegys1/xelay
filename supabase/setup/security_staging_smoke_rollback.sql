-- STAGING ONLY: test1 / saufzpryybuawudohhwj, AFTER safe baseline + all migrations.
-- Operator must prepend BOTH lines in the SAME SQL execution, after checking UI:
--   SET xelay.security_staging = 'true';
--   SET xelay.security_test_project = 'saufzpryybuawudohhwj';
-- Do not run on production. No account/production data is copied or printed.
-- No real login, email, provider charge, physical Storage upload/delete, or keys.
-- Simulated request.jwt.claims test DB RLS/ACL only, NOT JWT verification/Auth HTTP.
-- SQL-created auth.users are rollback-only fixtures, NOT real signup evidence.
-- For MFA's optional positive case first create/enroll a synthetic Auth user via
-- staging Auth HTTP/UI, username security_smoke_mfa, with real own verified factor;
-- then optionally prepend SET xelay.security_mfa_user_id = '<that test UUID>';
-- No auth.mfa_factors row is manufactured, changed or removed by this file.
-- An error aborts the transaction: execute ROLLBACK in the SAME connection before
-- doing anything else. Never replace the final ROLLBACK with COMMIT. SQL Editor
-- may show only the last result; notices identify completed checks separately.
-- Rollback covers database rows, not unknown external trigger side effects.
-- Refuse obvious outbound hooks; independently review all custom hooks first.

begin;
set local statement_timeout = '60s';
set local lock_timeout = '2s';

do $$
declare v_ref text := 'saufzpryybuawudohhwj';
begin
  if current_setting('xelay.security_staging',true) is distinct from 'true'
    or current_setting('xelay.security_test_project',true) is distinct from v_ref then
    raise exception 'Explicit same-call staging confirmation and target ref required';
  end if;
  if (coalesce(current_setting('app.settings.supabase_url',true),'')
    || coalesce(current_setting('api.external_url',true),'')) like '%baohfpadxvhqhhjjqtil%' then
    raise exception 'Known production target refused';
  end if;
  if session_user not in ('postgres','supabase_admin') then
    raise exception 'Use trusted staging SQL operator, not a client/service JWT';
  end if;
  if to_regprocedure('public.xelay_send_direct_message(uuid,uuid,text,uuid,jsonb)') is null
    or to_regprocedure('public.xelay_private_reserve_media(text,text)') is null
    or to_regprocedure('public.xelay_security_is_trusted_backend()') is null
    or to_regprocedure('public.xelay_media_cleanup_next_scope()') is null
    or to_regprocedure('public.xelay_import_study_group_timetable(uuid,jsonb)') is null
    or to_regprocedure('public.xelay_is_platform_admin()') is null then
    raise exception 'Install safe baseline and complete migrations through 009 first';
  end if;
  if exists(select 1 from pg_trigger t join pg_class c on c.oid=t.tgrelid
    join pg_namespace n on n.oid=c.relnamespace join pg_proc p on p.oid=t.tgfoid
    join pg_namespace pn on pn.oid=p.pronamespace
    where not t.tgisinternal and t.tgenabled<>'D' and n.nspname in ('auth','public','storage')
      and (pn.nspname in ('http','net','supabase_functions') or p.proname ilike '%http%'
        or p.prosrc ~* '(net[.]http_|http_post|http_get)')) then
    raise exception 'Possible outbound HTTP hook: review/remove in staging before rollback smoke';
  end if;
end $$;

create temporary table xelay_security_smoke_results (
  check_name text primary key,status text not null,detail text not null
) on commit drop;
-- Only ephemeral test result rows; no persistent role/grant/policy changes.
grant select,insert on xelay_security_smoke_results to authenticated,service_role;

do $$
declare
  v_a uuid := gen_random_uuid();
  v_b uuid := gen_random_uuid();
  v_outsider uuid := gen_random_uuid();
  v_rep uuid := gen_random_uuid();
  v_deputy uuid := gen_random_uuid();
  v_pending uuid := gen_random_uuid();
  v_id uuid;
  v_question text := gen_random_uuid()::text;
  v_conversation uuid;
  v_message uuid := gen_random_uuid();
  v_bad_message uuid := gen_random_uuid();
  v_good_path text;
  v_bad_path text;
  v_university uuid := gen_random_uuid();
  v_unit uuid := gen_random_uuid();
  v_request uuid := gen_random_uuid();
  v_group uuid := gen_random_uuid();
  v_lesson jsonb := '[{"weekday":1,"starts_at":"09:00","ends_at":"10:00","subject":"Synthetic lesson","lesson_type":"lecture","location":"","valid_from":"2026-10-05","valid_until":"2026-10-31","week_pattern":"every","lesson_number":1}]';
  v_schedule uuid;
  v_order jsonb;
  v_participant_order jsonb;
  v_event jsonb;
  v_mfa_user uuid;
  v_raw_mfa_user text := nullif(current_setting('xelay.security_mfa_user_id',true),'');
  v_denied boolean;
  v_count integer;
  v_created timestamptz;
  v_permissions text[];
  v_fingerprint text := md5(gen_random_uuid()::text)||md5(gen_random_uuid()::text);
begin
  perform set_config('request.jwt.claims','{}',true);
  perform set_config('role','none',true);
  foreach v_id in array array[v_a,v_b,v_outsider,v_rep,v_deputy,v_pending] loop
    insert into auth.users(id,email,email_confirmed_at,raw_user_meta_data)
      values(v_id,'smoke-'||v_id::text||'@example.test',clock_timestamp(),'{}');
    insert into public.profiles(id,email,full_name,username)
      values(v_id,'ignored@example.test','Synthetic security account','ssmoke_'||substr(md5(v_id::text),1,18))
      on conflict(id) do nothing;
  end loop;

  -- Ordinary participant: own content edit allowed; foreign mutation invisible.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_a,'role','authenticated','aal','aal1')::text,true);
  perform set_config('role','authenticated',true);
  insert into public.questions(id,user_id,title,content,category,author_name)
    values(v_question,v_a::text,'Synthetic security question','Original synthetic body','General','Synthetic security account');
  update public.questions set content='Own edit' where id=v_question;
  get diagnostics v_count=row_count;
  if v_count<>1 then raise exception 'FAIL own content edit'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_b,'role','authenticated','aal','aal1')::text,true);
  update public.questions set content='Foreign edit' where id=v_question;
  get diagnostics v_count=row_count;
  if v_count<>0 then raise exception 'FAIL foreign content UPDATE'; end if;
  begin
    delete from public.questions where id=v_question;
    get diagnostics v_count=row_count;
    if v_count<>0 then raise exception 'FAIL foreign content DELETE'; end if;
  exception when insufficient_privilege then null;
  end;
  perform set_config('role','none',true);
  if (select content from public.questions where id=v_question) is distinct from 'Own edit' then
    raise exception 'FAIL foreign content persisted';
  end if;
  insert into xelay_security_smoke_results values('content_owner','PASS','Own edit allowed; foreign UPDATE affects zero rows and DELETE is denied or affects zero rows');

  -- Rating/trust cannot change. Legacy unchanged values remain saveable.
  select created_at into v_created from public.profiles where id=v_a;
  perform set_config('role','authenticated',true);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_a,'role','authenticated','aal','aal1')::text,true);
  v_denied:=false;
  begin
    update public.profiles set rating=999,trust_score=999 where id=v_a;
  exception when insufficient_privilege then v_denied:=true;
  end;
  if not v_denied then raise exception 'FAIL profile system scores writable'; end if;
  update public.profiles set bio='Synthetic legitimate profile edit',rating=rating,trust_score=trust_score,
    email='forged-target@example.test',created_at='2000-01-01' where id=v_a;
  perform set_config('role','none',true);
  if not exists(select 1 from public.profiles p join auth.users u on u.id=p.id
    where p.id=v_a and p.email=u.email and p.rating=0 and p.trust_score=0 and p.created_at=v_created
      and p.bio='Synthetic legitimate profile edit') then raise exception 'FAIL profile canonical fields'; end if;
  insert into xelay_security_smoke_results values('profile_system_fields','PASS','Scores denied; unchanged score save works; email/date stay server owned');

  -- Metadata-only upload finalization and atomic direct attachment write.
  insert into public.conversations(user_one_id,user_two_id)
    values(least(v_a,v_b),greatest(v_a,v_b)) returning id into v_conversation;
  v_good_path:=v_conversation||'/'||v_a||'/'||v_message||'/smoke.png';
  v_bad_path:=v_conversation||'/'||v_a||'/'||v_bad_message||'/smoke.png';
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_a,'role','authenticated','aal','aal1')::text,true);
  perform set_config('role','authenticated',true);
  perform public.xelay_private_reserve_media('xelay-message-media',v_good_path);
  perform public.xelay_private_reserve_media('xelay-message-media',v_bad_path);
  perform set_config('role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role","aal":"aal1"}',true);
  insert into storage.objects(bucket_id,name,owner_id,metadata) values
    ('xelay-message-media',v_good_path,v_a::text,'{"size":10,"mimetype":"image/png"}'),
    ('xelay-message-media',v_bad_path,v_a::text,'{"size":10,"mimetype":"image/png"}');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_a,'role','authenticated','aal','aal1')::text,true);
  perform set_config('role','authenticated',true);
  perform public.xelay_send_direct_message(v_message,v_conversation,'Synthetic attached message',null,
    jsonb_build_array(jsonb_build_object('storage_path',v_good_path,'file_name','smoke.png','media_type','image','mime_type','image/png')));
  v_denied:=false;
  begin
    perform public.xelay_send_direct_message(v_bad_message,v_conversation,'Must fully roll back',null,
      jsonb_build_array(
        jsonb_build_object('storage_path',v_bad_path,'file_name','smoke.png','media_type','image','mime_type','image/png'),
        jsonb_build_object('storage_path',v_bad_path,'file_name','bad.png','media_type','image','mime_type','image/jpeg')));
  exception when raise_exception then
    if sqlerrm<>'PRIVATE_MEDIA_INVALID' then raise; end if;
    v_denied:=true;
  end;
  if not v_denied then raise exception 'FAIL invalid attachment accepted'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_outsider,'role','authenticated','aal','aal1')::text,true);
  v_denied:=false;
  begin
    perform public.xelay_send_direct_message(gen_random_uuid(),v_conversation,'Foreign direct',null,'[]');
  exception when insufficient_privilege then v_denied:=true;
  end;
  if not v_denied then raise exception 'FAIL foreign direct accepted'; end if;
  perform set_config('role','none',true);
  perform set_config('request.jwt.claims','{}',true);
  if not exists(select 1 from public.messages where id=v_message)
    or (select count(*) from public.message_attachments where message_id=v_message)<>1
    or exists(select 1 from public.messages where id=v_bad_message)
    or exists(select 1 from public.message_attachments where message_id=v_bad_message) then
    raise exception 'FAIL direct attachment atomicity';
  end if;
  insert into xelay_security_smoke_results values('direct_atomic_attachments','PASS','Valid message+attachment persist inside transaction; invalid descriptor rolls both back; outsider denied. No physical blob upload');

  -- Create synthetic academic scope. No historical username-based ADMIN seed.
  insert into public.universities(id,name,slug) values(v_university,'Synthetic security university','smoke-'||v_university);
  insert into public.academic_units(id,university_id,name,slug,unit_type)
    values(v_unit,v_university,'Synthetic faculty','smoke-'||v_unit,'faculty');
  insert into public.class_representative_requests(id,user_id,full_name,university_id,academic_unit_id,
    group_name,telegram_username,status,reviewed_by,reviewed_at)
    values(v_request,v_rep,'Synthetic representative',v_university,v_unit,'Synthetic group','synthetic_contact','approved',v_a,clock_timestamp());
  insert into public.study_groups(id,representative_request_id,representative_id,university_id,academic_unit_id,group_name)
    values(v_group,v_request,v_rep,v_university,v_unit,'Synthetic group');
  -- Remove only this new group's automatic promotion so payment is measurable.
  delete from public.group_entitlements where group_id=v_group;
  update public.billing_settings set enforce_group_payment=false;
  -- Complete legacy schema has NOT NULL notification.actor_id; invitations
  -- must retain the real synthetic representative as the notification actor.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_rep,'role','authenticated','aal','aal1')::text,true);
  insert into public.study_group_members(group_id,user_id,status,invited_by,accepted_at) values
    (v_group,v_deputy,'accepted',v_rep,clock_timestamp()),
    (v_group,v_b,'accepted',v_rep,clock_timestamp()),(v_group,v_pending,'pending',v_rep,null);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_rep,'role','authenticated','aal','aal1')::text,true);
  perform set_config('role','authenticated',true);
  perform public.xelay_assign_study_group_deputy(v_group,v_deputy,array['schedule']);
  v_denied:=false;
  begin
    perform public.xelay_assign_study_group_deputy(v_group,v_pending,array['schedule']);
  exception when insufficient_privilege then v_denied:=true;
  end;
  if not v_denied then raise exception 'FAIL pending deputy accepted'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_deputy,'role','authenticated','aal','aal1')::text,true);
  select public.xelay_study_group_permissions(v_group) into v_permissions;
  if v_permissions is distinct from array['schedule'] then raise exception 'FAIL deputy cross-scope permissions'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_b,'role','authenticated','aal','aal1')::text,true);
  select public.xelay_study_group_permissions(v_group) into v_permissions;
  if cardinality(v_permissions)<>0 then raise exception 'FAIL ordinary academic permissions'; end if;
  v_denied:=false;
  begin
    perform public.xelay_import_study_group_timetable(v_group,v_lesson);
  exception when insufficient_privilege then v_denied:=true;
  end;
  if not v_denied then raise exception 'FAIL ordinary schedule import'; end if;
  -- Ordinary user cannot invoke service billing RPC, even with a forged mode.
  v_denied:=false;
  begin
    perform public.xelay_create_billing_order(v_b,'participant','live','smoke-forged-'||v_b,null);
  exception when insufficient_privilege then v_denied:=true;
  end;
  if not v_denied then raise exception 'FAIL ordinary billing service RPC'; end if;
  perform set_config('role','none',true);
  perform set_config('request.jwt.claims','{}',true);
  update public.billing_settings set enforce_group_payment=true;
  -- The retained payment/refund branch measures post-trial access. This only
  -- changes its newly created synthetic group inside the final ROLLBACK.
  -- Dynamic SQL keeps the operator smoke compatible with the through015 test1.
  if to_regclass('public.group_trial_entitlements') is not null then
    execute 'update public.group_trial_entitlements set started_at=now()-interval ''192 hours'',expires_at=now()-interval ''24 hours'' where group_id=$1' using v_group;
  end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_deputy,'role','authenticated','aal','aal1')::text,true);
  perform set_config('role','authenticated',true);
  v_denied:=false;
  begin
    perform public.xelay_import_study_group_timetable(v_group,v_lesson);
  exception when insufficient_privilege then
    if sqlerrm<>'GROUP_LICENSE_REQUIRED' then raise; end if;
    v_denied:=true;
  end;
  if not v_denied then raise exception 'FAIL schedule import without license'; end if;
  insert into xelay_security_smoke_results values('academic_permissions','PASS','Actual representative appoints accepted schedule-only deputy; pending/ordinary denied; active license required');

  -- Synthetic billing events only. 'live' here is a DB enum to cover entitlement
  -- logic; no WayForPay HTTP, LIVE key, checkout or real transaction is involved.
  perform set_config('role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role","aal":"aal1"}',true);
  select public.xelay_create_billing_order(v_rep,'group','live','smoke-group-'||v_group,v_group) into v_order;
  if (v_order->>'amount')::numeric<>750 or (v_order->>'group_term_months')::integer<>12
    or v_order->>'currency'<>'UAH' then raise exception 'FAIL annual price/period'; end if;
  select public.xelay_apply_billing_event(v_order->>'order_reference','live',v_fingerprint,'Approved',750,'UAH') into v_event;
  if (v_event->>'duplicate')::boolean is distinct from false then raise exception 'FAIL first annual event'; end if;
  select public.xelay_apply_billing_event(v_order->>'order_reference','live',v_fingerprint,'Approved',750,'UAH') into v_event;
  if (v_event->>'duplicate')::boolean is distinct from true then raise exception 'FAIL annual replay'; end if;
  perform public.xelay_apply_billing_event(v_order->>'order_reference','live',md5(v_group::text)||md5('annual-approved'),'Approved',750,'UAH');
  select public.xelay_create_billing_order(v_b,'participant','live','smoke-participant-'||v_b,null) into v_participant_order;
  if (v_participant_order->>'amount')::numeric<>100 then raise exception 'FAIL participant price'; end if;
  perform public.xelay_apply_billing_event(v_participant_order->>'order_reference','live',md5(v_b::text)||md5('participant-approved'),'Approved',100,'UAH');
  perform set_config('role','none',true);
  perform set_config('request.jwt.claims','{}',true);
  if (select count(*) from public.group_annual_entitlements where order_id=(v_order->>'id')::uuid)<>1
    or not exists(select 1 from public.group_annual_entitlements where order_id=(v_order->>'id')::uuid
      and term_months=12 and revoked_at is null
      and valid_until=(((valid_from at time zone 'Europe/Kyiv')+interval '1 year') at time zone 'Europe/Kyiv')) then
    raise exception 'FAIL annual entitlement/replay/calendar term';
  end if;
  if not exists(select 1 from public.participant_entitlements where order_id=(v_participant_order->>'id')::uuid
    and term_months=1 and revoked_at is null
    and valid_until=(((valid_from at time zone 'Europe/Kyiv')+interval '1 month') at time zone 'Europe/Kyiv')) then
    raise exception 'FAIL participant calendar month';
  end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_deputy,'role','authenticated','aal','aal1')::text,true);
  perform set_config('role','authenticated',true);
  if public.xelay_import_study_group_timetable(v_group,v_lesson)<>1 then raise exception 'FAIL licensed deputy import'; end if;
  perform set_config('role','none',true);
  select id into v_schedule from public.study_group_schedule where group_id=v_group;
  perform set_config('role','authenticated',true);
  v_denied:=false;
  begin
    insert into public.study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by)
      values(v_group,v_schedule,'2026-10-05','Forbidden deputy homework',v_deputy);
  exception when insufficient_privilege then v_denied:=true;
  end;
  if not v_denied then raise exception 'FAIL schedule deputy can write homework'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_rep,'role','authenticated','aal','aal1')::text,true);
  insert into public.study_group_homework(group_id,schedule_item_id,lesson_date,body,created_by)
    values(v_group,v_schedule,'2026-10-05','Synthetic representative homework',v_rep);
  perform set_config('role','service_role',true);
  perform set_config('request.jwt.claims','{"role":"service_role","aal":"aal1"}',true);
  perform public.xelay_apply_billing_event(v_order->>'order_reference','live',md5(v_group::text)||md5('annual-refunded'),'Refunded',750,'UAH');
  perform public.xelay_apply_billing_event(v_participant_order->>'order_reference','live',md5(v_b::text)||md5('participant-refunded'),'Refunded',100,'UAH');
  perform set_config('role','none',true);
  if not exists(select 1 from public.group_annual_entitlements where order_id=(v_order->>'id')::uuid and revoked_at is not null)
    or not exists(select 1 from public.participant_entitlements where order_id=(v_participant_order->>'id')::uuid and revoked_at is not null) then
    raise exception 'FAIL refund revocation';
  end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_rep,'role','authenticated','aal','aal1')::text,true);
  perform set_config('role','authenticated',true);
  v_denied:=false;
  begin
    perform public.xelay_import_study_group_timetable(v_group,v_lesson);
  exception when insufficient_privilege then
    if sqlerrm<>'GROUP_LICENSE_REQUIRED' then raise; end if;
    v_denied:=true;
  end;
  if not v_denied then raise exception 'FAIL refunded license permits import'; end if;
  insert into xelay_security_smoke_results values('billing_service','PASS','Service AAL1: annual 750/12 calendar months, replay idempotent, participant 100/1 calendar month, refunds revoke both; no provider contact');

  -- No manufactured verified MFA factor; negative checks are unconditional.
  perform set_config('role','none',true);
  perform set_config('request.jwt.claims','{}',true);
  insert into public.user_roles(user_id,role) values(v_a,'ADMIN');
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_a,'role','authenticated','aal','aal1')::text,true);
  perform set_config('role','authenticated',true);
  if public.xelay_is_platform_admin() then raise exception 'FAIL ADMIN AAL1'; end if;
  v_denied:=false;
  begin
    perform public.xelay_admin_billing_overview();
  exception when insufficient_privilege then v_denied:=true;
  end;
  if not v_denied then raise exception 'FAIL privileged RPC AAL1'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_a,'role','authenticated','aal','aal2')::text,true);
  if public.xelay_is_platform_admin() then raise exception 'FAIL ADMIN AAL2 without own verified factor'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_b,'role','authenticated','aal','aal2')::text,true);
  if public.xelay_is_platform_admin() then raise exception 'FAIL ordinary AAL2'; end if;
  perform set_config('role','none',true);
  perform set_config('request.jwt.claims','{}',true);
  insert into xelay_security_smoke_results values('admin_mfa_negative','PASS','ADMIN AAL1 denied; ADMIN AAL2 without own verified factor denied; ordinary AAL2 denied');
  if v_raw_mfa_user is null then
    insert into xelay_security_smoke_results values('admin_mfa_actual_factor','SKIP','Supply enrolled synthetic staging Auth user security_smoke_mfa; this file never manufactures verified factors');
  else
    v_mfa_user:=v_raw_mfa_user::uuid;
    if not exists(select 1 from public.profiles where id=v_mfa_user and username='security_smoke_mfa')
      or not exists(select 1 from auth.mfa_factors where user_id=v_mfa_user and status='verified') then
      raise exception 'MFA positive case requires named synthetic account and actual own verified Auth factor';
    end if;
    if not exists(select 1 from public.user_roles where user_id=v_mfa_user and role='ADMIN') then
      insert into public.user_roles(user_id,role) values(v_mfa_user,'ADMIN');
    end if;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_mfa_user,'role','authenticated','aal','aal1')::text,true);
    perform set_config('role','authenticated',true);
    if public.xelay_is_platform_admin() then raise exception 'FAIL actual-factor ADMIN AAL1'; end if;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_mfa_user,'role','authenticated','aal','aal2')::text,true);
    if not public.xelay_is_platform_admin() then raise exception 'FAIL actual-factor ADMIN AAL2'; end if;
    perform set_config('request.jwt.claims',jsonb_build_object('sub',v_a,'role','authenticated','aal','aal2')::text,true);
    if public.xelay_is_platform_admin() then raise exception 'FAIL another user factor grants ADMIN'; end if;
    perform set_config('role','none',true);
    perform set_config('request.jwt.claims','{}',true);
    insert into xelay_security_smoke_results values('admin_mfa_actual_factor','PASS','Own real enrolled factor relational check: AAL1 denied/AAL2 allowed, another user denied. Signed JWT/challenge/session HTTP still separate');
  end if;
  perform set_config('role','none',true);
  perform set_config('request.jwt.claims','{}',true);
  raise notice 'Database smoke completed; final ROLLBACK removes all synthetic rows and temporary changes. Actual MFA may be SKIP; inspect result below. No hosted HTTP evidence.';
end $$;

select jsonb_build_object(
  'target','saufzpryybuawudohhwj','evidence_type','SQL DB role/JWT simulation; not Auth/Storage/provider HTTP',
  'checks',jsonb_agg(to_jsonb(r) order by check_name),
  'finish','ROLLBACK follows; do not COMMIT'
) as security_smoke_results from xelay_security_smoke_results r;
rollback;
