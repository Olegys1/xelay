-- A separate immediate email job for each trusted platform notification.
-- Read state and conversation bursts no longer suppress email. Existing
-- explicit opt-outs, verified Auth addresses and private service leases remain.
-- No notifications or historical queue entries are inserted by this migration.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$
begin
  if to_regclass('public.notifications') is null
    or to_regclass('public.notification_preferences') is null
    or to_regclass('public.notification_email_outbox') is null
    or to_regclass('public.notification_email_runtime') is null
    or to_regclass('public.messages') is null
    or to_regclass('public.conversations') is null
    or to_regclass('public.connection_requests') is null
    or to_regprocedure('public.xelay_queue_notification_email()') is null
    or to_regprocedure('public.xelay_notification_email_message_context(uuid,uuid)') is null
    or to_regprocedure('public.xelay_claim_notification_email(uuid)') is null
    or to_regprocedure('public.xelay_finish_notification_email(uuid,uuid,text,text,text)') is null
    or exists(select 1 from pg_catalog.pg_class c where c.oid in(
      to_regclass('public.notifications'),to_regclass('public.notification_preferences'),
      to_regclass('public.notification_email_outbox'),to_regclass('public.notification_email_runtime'))
      and not c.relrowsecurity) then
    raise exception 'Apply the existing trusted notification and unread email migrations before all-notification email';
  end if;
  -- The expanded type coverage is safe only while notification creation stays
  -- server-owned. Do not silently expand a legacy arbitrary-client mail relay.
  if has_table_privilege('anon','public.notifications','INSERT')
    or has_table_privilege('authenticated','public.notifications','INSERT')
    or has_any_column_privilege('anon','public.notifications','INSERT')
    or has_any_column_privilege('authenticated','public.notifications','INSERT') then
    raise exception 'Notification inserts must be server-only before enabling all-notification email';
  end if;
end $$;

-- Waiting for a provider quota or configuration repair is not an uncertain
-- delivery. The provider's 24-hour deduplication window starts with a claim,
-- rather than discarding an event that has only waited in the queue.
alter table public.notification_email_outbox
  add column if not exists first_delivery_attempt_at timestamptz;
alter table public.notification_email_runtime
  add column if not exists paused_until timestamptz,
  add column if not exists pause_reason text;
-- Existing live attempted jobs retain their conservative original window.
-- Completed historical jobs remain untouched and are never reactivated.
update public.notification_email_outbox q set first_delivery_attempt_at=q.created_at
  where q.status in('pending','processing') and q.attempts>0 and q.first_delivery_attempt_at is null;
-- Release only the former unread/conversation waiting period of live pending
-- jobs. Provider retries, quota backoff, live leases and terminal history stay.
update public.notification_email_outbox q set available_at=clock_timestamp()
  where q.status='pending' and q.notification_type='message' and q.available_at>clock_timestamp()
    and (q.last_error_code in('read_delay','conversation_rate_limit','conversation_in_progress')
      or(q.attempts=0 and q.first_delivery_attempt_at is null and q.last_error_code is null));

-- Each notification, including separate messages in the same conversation,
-- now has its own immutable job. Notification/event unique constraints remain.
drop index if exists public.notification_email_active_thread_unique;

create or replace function public.xelay_queue_notification_email()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_preferences public.notification_preferences%rowtype;
  v_actor uuid;
  v_conversation uuid;
begin
  if new.recipient_id is null or nullif(btrim(new.type),'') is null then return new; end if;
  if not exists(select 1 from auth.users u where u.id::text=new.recipient_id::text
    and u.email_confirmed_at is not null and nullif(btrim(u.email),'') is not null
    and u.deleted_at is null) then return new; end if;
  select * into v_preferences from public.notification_preferences p
    where p.user_id::text=new.recipient_id::text;
  if not coalesce(v_preferences.notifications_enabled,true)
    or not coalesce(v_preferences.email_notifications_enabled,true) then return new; end if;

  -- Preserve the existing recipient lock order. Unknown future event types can
  -- use the server's generic template without a migration for every new type.
  perform pg_advisory_xact_lock(hashtextextended('xelay-email-'||new.recipient_id::text,0));
  select u.id into v_actor from auth.users u where u.id::text=new.actor_id::text;
  if new.type='message' then
    select m.conversation_id into v_conversation from public.messages m
      where m.id=new.direct_message_id and m.conversation_id=new.direct_conversation_id
        and m.sender_id::text=new.actor_id::text and m.recipient_id::text=new.recipient_id::text
        and m.deleted_at is null;
    if not found then return new; end if;
  end if;
  insert into public.notification_email_outbox(
    notification_id,recipient_id,actor_id,notification_type,event_key,available_at,direct_conversation_id)
  values(new.id::text,new.recipient_id::uuid,v_actor,new.type,'notification:'||new.id::text,
    clock_timestamp(),v_conversation) on conflict do nothing;
  return new;
end $$;
revoke all on function public.xelay_queue_notification_email() from public,anon,authenticated,service_role;
drop trigger if exists notification_email_queue on public.notifications;
create trigger notification_email_queue after insert on public.notifications
  for each row execute function public.xelay_queue_notification_email();

-- The general queue now covers teaching_update as well. Keep the old internal
-- function in place for migration compatibility, but remove duplicate routing.
drop trigger if exists xelay_teaching_email_queue on public.notifications;

create or replace function public.xelay_private_notification_email_message_state(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_job public.notification_email_outbox%rowtype;
  v_notification public.notifications%rowtype;
  v_anchor public.messages%rowtype;
  v_conversation public.conversations%rowtype;
begin
  select * into v_job from public.notification_email_outbox q where q.id=p_job_id;
  if not found or v_job.notification_type<>'message' then
    return jsonb_build_object('eligible',false,'reason','message_context_missing','conversation_id',null); end if;
  if v_job.first_delivery_attempt_at<=clock_timestamp()-interval '23 hours' then
    return jsonb_build_object('eligible',false,'reason','expired','conversation_id',null); end if;
  select * into v_notification from public.notifications n where n.id::text=v_job.notification_id;
  if not found then return jsonb_build_object('eligible',false,'reason','notification_removed','conversation_id',null); end if;
  if v_notification.type is distinct from 'message'
    or v_notification.recipient_id::text is distinct from v_job.recipient_id::text
    or v_notification.actor_id::text is distinct from v_job.actor_id::text
    or v_notification.direct_conversation_id is null
    or v_notification.direct_conversation_id is distinct from v_job.direct_conversation_id then
    return jsonb_build_object('eligible',false,'reason','message_context_mismatch','conversation_id',null); end if;
  select * into v_anchor from public.messages m where m.id=v_notification.direct_message_id;
  if not found or v_anchor.deleted_at is not null then
    return jsonb_build_object('eligible',false,'reason','message_removed','conversation_id',null); end if;
  if v_anchor.conversation_id is distinct from v_job.direct_conversation_id
    or v_anchor.recipient_id is distinct from v_job.recipient_id
    or v_anchor.sender_id is distinct from v_job.actor_id then
    return jsonb_build_object('eligible',false,'reason','message_context_mismatch','conversation_id',null); end if;
  select * into v_conversation from public.conversations c where c.id=v_job.direct_conversation_id
    and c.user_one_id=least(v_job.recipient_id,v_job.actor_id)
    and c.user_two_id=greatest(v_job.recipient_id,v_job.actor_id);
  if not found then return jsonb_build_object('eligible',false,'reason','conversation_removed','conversation_id',null); end if;
  if not exists(select 1 from public.connection_requests r where r.status='accepted'
    and least(r.requester_id,r.recipient_id)=v_conversation.user_one_id
    and greatest(r.requester_id,r.recipient_id)=v_conversation.user_two_id) then
    return jsonb_build_object('eligible',false,'reason','connection_removed','conversation_id',null); end if;
  if not exists(select 1 from auth.users u where u.id=v_job.recipient_id
    and u.email_confirmed_at is not null and nullif(btrim(u.email),'') is not null and u.deleted_at is null) then
    return jsonb_build_object('eligible',false,'reason','email_unverified','conversation_id',null); end if;
  if exists(select 1 from public.notification_preferences p where p.user_id=v_job.recipient_id
    and(not p.notifications_enabled or not p.email_notifications_enabled)) then
    return jsonb_build_object('eligible',false,'reason','notifications_disabled','conversation_id',null); end if;
  -- Neither messages.read_at nor notifications.is_read is a delivery decision.
  -- This context remains metadata-only: no body, attachment or address leaves.
  return jsonb_build_object('eligible',true,'reason','eligible',
    'conversation_id',v_job.direct_conversation_id);
end $$;
revoke all on function public.xelay_private_notification_email_message_state(uuid) from public,anon,authenticated,service_role;

create or replace function public.xelay_notification_email_message_context(p_job_id uuid,p_lock_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501'; end if;
  if not exists(select 1 from public.notification_email_outbox q where q.id=p_job_id
    and q.status='processing' and q.lock_token=p_lock_token and q.locked_until>clock_timestamp()) then
    return jsonb_build_object('eligible',false,'reason','lease_lost','conversation_id',null); end if;
  return public.xelay_private_notification_email_message_state(p_job_id);
end $$;

create or replace function public.xelay_claim_notification_email(p_job_id uuid default null)
returns table(id uuid,notification_id text,attempts integer,created_at timestamptz,lock_token uuid)
language plpgsql security definer set search_path='' as $$
declare v_candidate public.notification_email_outbox%rowtype; v_state jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501'; end if;
  if not exists(select 1 from public.notification_email_runtime r where r.singleton and r.worker_enabled
    and r.last_heartbeat_at>clock_timestamp()-interval '180 seconds'
    and (r.paused_until is null or r.paused_until<=clock_timestamp())) then return; end if;
  update public.notification_email_outbox q set status='skipped',completed_at=clock_timestamp(),
    last_error_code='expired',lock_token=null,locked_until=null
    where(q.status='pending' or(q.status='processing' and q.locked_until<=clock_timestamp()))
      and q.first_delivery_attempt_at<=clock_timestamp()-interval '23 hours';
  update public.notification_email_outbox q set status='failed',completed_at=clock_timestamp(),
    last_error_code='attempts_exhausted',lock_token=null,locked_until=null
    where q.attempts>=5 and(q.status='pending' or(q.status='processing' and q.locked_until<=clock_timestamp()));
  for v_candidate in
    select q.* from public.notification_email_outbox q
      where(p_job_id is null or q.id=p_job_id) and q.attempts<5
        and(q.first_delivery_attempt_at is null or q.first_delivery_attempt_at>clock_timestamp()-interval '23 hours')
        and((q.status='pending' and q.available_at<=clock_timestamp())
          or(q.status='processing' and q.locked_until<=clock_timestamp() and q.available_at<=clock_timestamp()))
      order by q.created_at,q.id for update skip locked limit 100
  loop
    -- Preserve row/advisory lock safety with concurrent notification inserts.
    if not pg_try_advisory_xact_lock(hashtextextended('xelay-email-'||v_candidate.recipient_id::text,0)) then continue; end if;
    if v_candidate.notification_type='message' then
      v_state:=public.xelay_private_notification_email_message_state(v_candidate.id);
      if not coalesce((v_state->>'eligible')::boolean,false) then
        update public.notification_email_outbox q set status='skipped',completed_at=clock_timestamp(),
          lock_token=null,locked_until=null,last_error_code=v_state->>'reason' where q.id=v_candidate.id;
        continue;
      end if;
    end if;
    return query update public.notification_email_outbox q set status='processing',attempts=q.attempts+1,
      first_delivery_attempt_at=coalesce(q.first_delivery_attempt_at,clock_timestamp()),
      lock_token=gen_random_uuid(),locked_until=clock_timestamp()+interval '2 minutes'
      where q.id=v_candidate.id returning q.id,q.notification_id,q.attempts,q.first_delivery_attempt_at,q.lock_token;
    return;
  end loop;
end $$;

create or replace function public.xelay_finish_notification_email(
  p_job_id uuid,p_lock_token uuid,p_status text,p_error_code text default null,p_provider_message_id text default null
)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_updated integer; v_pause_until timestamptz; v_job public.notification_email_outbox%rowtype;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501'; end if;
  if p_status is null or p_status not in('pending','sent','skipped','failed') then raise exception 'Invalid email job status'; end if;
  if p_status='pending' and p_error_code in(
    'provider_daily_quota','provider_monthly_quota','provider_rate_limit','provider_configuration') then
    select * into v_job from public.notification_email_outbox q where q.id=p_job_id
      and q.status='processing' and q.lock_token=p_lock_token and q.locked_until>clock_timestamp() for update;
    if not found then return false; end if;
    v_pause_until:=case p_error_code
      when 'provider_daily_quota' then
        (date_trunc('day',clock_timestamp() at time zone 'UTC')+interval '1 day 5 minutes') at time zone 'UTC'
      when 'provider_monthly_quota' then clock_timestamp()+interval '24 hours'
      when 'provider_rate_limit' then clock_timestamp()+interval '1 minute'
      else clock_timestamp()+interval '10 minutes' end;
    update public.notification_email_runtime r set paused_until=greatest(r.paused_until,v_pause_until),
      pause_reason=case when r.paused_until>v_pause_until then r.pause_reason else p_error_code end where r.singleton;
    update public.notification_email_outbox q set status='pending',attempts=greatest(q.attempts-1,0),
      -- Only a definitive rejection on the first attempt proves no previous
      -- ambiguous request may have been accepted. Preserve older uncertainty.
      first_delivery_attempt_at=case when q.attempts=1 then null else q.first_delivery_attempt_at end,
      available_at=v_pause_until,completed_at=null,provider_message_id=null,
      last_error_code=p_error_code,lock_token=null,locked_until=null where q.id=p_job_id;
    return true;
  end if;
  update public.notification_email_outbox q set
    status=case when p_status='pending' and q.attempts>=5 then 'failed' else p_status end,
    available_at=case when p_status='pending'
      then clock_timestamp()+make_interval(secs=>least(1800,60*(2^(q.attempts-1))::integer)) else q.available_at end,
    completed_at=case when p_status<>'pending' or q.attempts>=5 then clock_timestamp() else null end,
    provider_message_id=left(p_provider_message_id,200),last_error_code=left(p_error_code,80),
    lock_token=null,locked_until=null
    where q.id=p_job_id and q.status='processing' and q.lock_token=p_lock_token and q.locked_until>clock_timestamp();
  get diagnostics v_updated=row_count;
  return v_updated=1;
end $$;

create or replace function public.xelay_notification_email_delivery_status()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501'; end if;
  return(select jsonb_build_object(
    'enabled',r.worker_enabled and coalesce(r.last_heartbeat_at>clock_timestamp()-interval '180 seconds',false)
      and to_regprocedure('public.xelay_claim_notification_email(uuid)') is not null
      and to_regprocedure('public.xelay_finish_notification_email(uuid,uuid,text,text,text)') is not null,
    'heartbeat_at',r.last_heartbeat_at,'paused_until',r.paused_until,'pause_reason',r.pause_reason,
    'delivery_mode','per_notification_v1',
    'contexts_ready',to_regprocedure('public.xelay_shared_organizer_notification_email_context(uuid,uuid)') is not null
      and to_regprocedure('public.xelay_chat_notification_email_context(uuid,uuid)') is not null)
    from public.notification_email_runtime r where r.singleton);
end $$;

-- CREATE OR REPLACE preserves ownership. Explicitly close internal helpers and
-- keep only the existing worker's service-role entry points executable.
revoke all on function public.xelay_notification_email_message_context(uuid,uuid),
  public.xelay_claim_notification_email(uuid),public.xelay_finish_notification_email(uuid,uuid,text,text,text),
  public.xelay_notification_email_delivery_status()
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_notification_email_message_context(uuid,uuid),
  public.xelay_claim_notification_email(uuid),public.xelay_finish_notification_email(uuid,uuid,text,text,text),
  public.xelay_notification_email_delivery_status()
  to service_role;

comment on function public.xelay_queue_notification_email() is
  'One immediate private job per future trusted notification, including self-reminders and read events. Verified canonical Auth address and explicit opt-outs are required; no type whitelist, conversation coalescing or hourly event loss.';
comment on function public.xelay_notification_email_message_context(uuid,uuid) is
  'Service-only leased direct-message metadata. Current conversation, accepted contact, undeleted anchor and email preferences are rechecked. Reading the message or notification does not cancel email; no message text or email address is returned.';
comment on function public.xelay_claim_notification_email(uuid) is
  'Service-only two-minute per-event lease. Requires fresh worker health and no provider pause. The created_at result is the first delivery attempt timestamp used by the worker idempotency guard. Unattempted jobs wait durably; ambiguous attempts retain a conservative 23-hour window. Distinct messages never coalesce.';
comment on column public.notification_email_outbox.first_delivery_attempt_at is
  'Conservative provider idempotency-window start, set on first claim. Explicit provider quota/rate/configuration rejection refunds a first attempt; earlier ambiguous attempts are never forgotten.';
comment on column public.notification_email_runtime.paused_until is
  'Global provider quota/rate/configuration backoff. A healthy heartbeat does not clear it, preventing every pending notification from retrying the same exhausted quota.';
notify pgrst,'reload schema';
commit;
