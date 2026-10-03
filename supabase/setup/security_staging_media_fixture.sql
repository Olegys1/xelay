-- PREPARED STAGING WRITE; do not run against production or as a migration.
-- Target: disposable test1 / saufzpryybuawudohhwj. Verify Dashboard target.
-- Use only the three independent synthetic Auth accounts already confirmed
-- by the separate reviewed test1 creator, and its durable owned receipt.
-- Their names/emails/authoritative app metadata must match that exact run UUID.
-- The existing human security_smoke_mfa account is not used or changed.
-- This script does not create Auth users/tokens/passwords/MFA, assign ADMIN,
-- alter managed schemas, upload bytes or enable any scheduled worker.
-- It inserts only missing profiles for the three verified synthetic accounts,
-- then commits an accepted A->B connection, their empty conversation, one
-- private chat owned by A with B as an accepted member, and DB notifications.
-- C remains outside both containers. Keep the returned IDs for the separate
-- bounded hosted-media runner; remove disposable fixture containers manually
-- only after checking they contain no media/publications to retain.
--
-- In the SAME Dashboard call, prepend explicit operator settings:
-- SET xelay.security_staging='true';
-- SET xelay.security_test_project='saufzpryybuawudohhwj';
-- SET xelay.security_media_run_id='<owned receipt run UUID>';
-- SET xelay.security_media_user_a='<existing confirmed Auth UUID A>';
-- SET xelay.security_media_user_b='<existing confirmed Auth UUID B>';
-- SET xelay.security_media_user_c='<existing confirmed Auth UUID C>';
-- No keys or passwords belong in SQL. Any error requires ROLLBACK, then
-- correction and a fresh call. A second successful run deliberately refuses
-- to reuse the existing connection/chat. No unrelated content is deleted.
begin;
set local statement_timeout='15s';
set local lock_timeout='2s';

do $$
declare
  v_a text:=current_setting('xelay.security_media_user_a',true);
  v_b text:=current_setting('xelay.security_media_user_b',true);
  v_c text:=current_setting('xelay.security_media_user_c',true);
  v_run text:=current_setting('xelay.security_media_run_id',true);
  v_names text[]; v_emails text[];
  v_ids uuid[]; v_request uuid; v_conversation uuid; v_space uuid; v_invitation uuid;
  v_result uuid; v_claims text:=current_setting('request.jwt.claims',true);
  v_role text:=current_setting('role',true);
begin
  if session_user not in('postgres','supabase_admin') or current_user not in('postgres','supabase_admin')
    or current_setting('xelay.security_staging',true) is distinct from 'true'
    or current_setting('xelay.security_test_project',true) is distinct from 'saufzpryybuawudohhwj' then
    raise exception 'Explicit trusted test1 staging confirmation required'; end if;
  if (coalesce(current_setting('app.settings.supabase_url',true),'')||coalesce(current_setting('api.external_url',true),''))
    like '%baohfpadxvhqhhjjqtil%' then raise exception 'Known production target refused'; end if;
  if v_a is null or v_b is null or v_c is null or v_run is null
    or v_run !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or v_a !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or v_b !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or v_c !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Three existing confirmed human Auth UUIDs required'; end if;
  v_ids:=array[v_a::uuid,v_b::uuid,v_c::uuid];
  v_run:=v_run::uuid::text;
  v_names:=array['security_media_a_','security_media_b_','security_media_c_'];
  select array_agg(stem||left(v_run,8) order by n),array_agg(stem||replace(v_run,'-','')||'@example.test' order by n)
    into v_names,v_emails from unnest(v_names) with ordinality s(stem,n);
  if v_ids[1]=v_ids[2] or v_ids[1]=v_ids[3] or v_ids[2]=v_ids[3] then raise exception 'Three distinct Auth users required'; end if;
  if (select count(*) from unnest(v_ids) with ordinality i(id,n)
    join auth.users u on u.id=i.id
    where u.email_confirmed_at is not null and u.deleted_at is null
      and u.email=v_emails[i.n]
      and u.raw_app_meta_data->>'xelay_security_fixture'='media-v1'
      and u.raw_app_meta_data->>'xelay_security_run_id'=v_run
      and u.raw_app_meta_data->>'xelay_security_label'=(array['A','B','C'])[i.n]
      and u.raw_user_meta_data->>'username'=v_names[i.n]
      and u.raw_user_meta_data->>'full_name'='Synthetic media '||(array['A','B','C'])[i.n])<>3 then
    raise exception 'Confirmed synthetic Auth users and exact owned run metadata required'; end if;
  -- Inspect only function names/namespaces, never raw trigger arguments or
  -- function bodies. A copied HTTP hook must not send fixture notifications.
  if exists(select 1 from pg_catalog.pg_trigger t join pg_catalog.pg_proc p on p.oid=t.tgfoid
    join pg_catalog.pg_namespace n on n.oid=p.pronamespace where not t.tgisinternal and t.tgenabled<>'D'
      and t.tgrelid in('public.connection_requests'::regclass,'public.notifications'::regclass,
        'public.chat_spaces'::regclass,'public.chat_members'::regclass,'public.chat_invitations'::regclass)
      and (n.nspname in('net','supabase_functions') or p.proname~* '(http|webhook|email)')
      and not(n.nspname='public' and p.proname='xelay_queue_notification_email' and p.pronargs=0)) then
    raise exception 'External notification hook requires separate review before fixture writes'; end if;
  if exists(select 1 from public.conversations where user_one_id=least(v_ids[1],v_ids[2]) and user_two_id=greatest(v_ids[1],v_ids[2]))
    or exists(select 1 from public.connection_requests where status in('pending','accepted')
      and ((requester_id=v_ids[1] and recipient_id=v_ids[2]) or(requester_id=v_ids[2] and recipient_id=v_ids[1])))
    or exists(select 1 from public.chat_spaces where owner_id=v_ids[1] and name='Security media fixture A+B') then
    raise exception 'Fresh disposable fixture required; existing containers are never reused or deleted'; end if;

  if exists(select 1 from unnest(v_ids) with ordinality i(id,n) join public.profiles p on p.id=i.id
    where p.username is distinct from v_names[i.n] or p.email is distinct from v_emails[i.n]
      or p.full_name is distinct from 'Synthetic media '||(array['A','B','C'])[i.n]) then
    raise exception 'Existing synthetic profile differs; no profile is overwritten'; end if;
  insert into public.profiles(id,username,email,full_name)
    select i.id,v_names[i.n],v_emails[i.n],'Synthetic media '||(array['A','B','C'])[i.n]
    from unnest(v_ids) with ordinality i(id,n) where not exists(select 1 from public.profiles p where p.id=i.id);

  -- Only this transaction simulates authenticated application callers. Use
  -- the real RPCs and permission guards, then restore the operator settings.
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_ids[1],'role','authenticated','aal','aal1',
    'iss','https://saufzpryybuawudohhwj.supabase.co/auth/v1')::text,true);
  perform set_config('role','authenticated',true);
  v_request:=public.send_connection_request(v_ids[2]);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_ids[2],'role','authenticated','aal','aal1',
    'iss','https://saufzpryybuawudohhwj.supabase.co/auth/v1')::text,true);
  v_conversation:=public.accept_connection_request(v_request);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_ids[1],'role','authenticated','aal','aal1',
    'iss','https://saufzpryybuawudohhwj.supabase.co/auth/v1')::text,true);
  v_space:=public.xelay_chat_create('group','private','Security media fixture A+B',null,
    'Disposable hosted Storage permission verification',null,true,false,true);
  v_invitation:=public.xelay_chat_invite(v_space,v_ids[2]);
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_ids[2],'role','authenticated','aal','aal1',
    'iss','https://saufzpryybuawudohhwj.supabase.co/auth/v1')::text,true);
  v_result:=public.xelay_chat_invitation(v_invitation,true);
  if v_result is distinct from v_space then raise exception 'Chat invitation acceptance mismatch'; end if;
  perform set_config('request.jwt.claims',jsonb_build_object('sub',v_ids[3],'role','authenticated','aal','aal1',
    'iss','https://saufzpryybuawudohhwj.supabase.co/auth/v1')::text,true);
  if exists(select 1 from public.conversations where id=v_conversation)
    or exists(select 1 from public.chat_spaces where id=v_space) then raise exception 'Outsider could read private fixture'; end if;
  perform set_config('role',coalesce(nullif(v_role,''),'none'),true);
  perform set_config('request.jwt.claims',coalesce(v_claims,''),true);
  if not exists(select 1 from public.connection_requests where id=v_request and status='accepted'
      and requester_id=v_ids[1] and recipient_id=v_ids[2])
    or not exists(select 1 from public.conversations where id=v_conversation
      and user_one_id=least(v_ids[1],v_ids[2]) and user_two_id=greatest(v_ids[1],v_ids[2]))
    or not exists(select 1 from public.chat_spaces where id=v_space and kind='group' and visibility='private' and owner_id=v_ids[1])
    or not exists(select 1 from public.chat_members where space_id=v_space and user_id=v_ids[1] and role='owner' and status='active')
    or not exists(select 1 from public.chat_members where space_id=v_space and user_id=v_ids[2] and role='member' and status='active')
    or exists(select 1 from public.chat_members where space_id=v_space and user_id=v_ids[3]) then
    raise exception 'Private fixture membership assertion failed'; end if;
  perform set_config('xelay.security_media_fixture_result',jsonb_build_object('mode','test1-media-fixtures',
    'projectRef','saufzpryybuawudohhwj','origin','https://saufzpryybuawudohhwj.supabase.co','runId',v_run,
    'conversationId',v_conversation,'chatSpaceId',v_space)::text,true);
  perform set_config('xelay.security_media_fixture_assertions',jsonb_build_object(
    'connectionRequestId',v_request,'chatInvitationId',v_invitation,'a_owner_b_member',true,'c_outsider_read_denied',true,
    'auth_or_global_role_mutation',false,'storage_mutation',false)::text,true);
end $$;

-- Save only security_media_fixture (exact six-field JSON) as the wrapper's
-- .local fixture file. The second column is separate verification/cleanup data.
select current_setting('xelay.security_media_fixture_result')::jsonb as security_media_fixture,
  current_setting('xelay.security_media_fixture_assertions')::jsonb as fixture_assertions;
reset xelay.security_staging;
reset xelay.security_test_project;
reset xelay.security_media_run_id;
reset xelay.security_media_user_a;
reset xelay.security_media_user_b;
reset xelay.security_media_user_c;
commit;
