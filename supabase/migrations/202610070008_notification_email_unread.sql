-- Personal-message mail follows actual unread messages, independently of the
-- notification bell. Existing queue history is retained but never mailed at
-- activation. No email settings or credentials are enabled by this migration.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$
begin
  if to_regclass('public.notifications') is null
    or to_regclass('public.notification_email_outbox') is null
    or to_regclass('public.notification_preferences') is null
    or to_regclass('public.messages') is null
    or to_regclass('public.conversations') is null
    or to_regclass('public.connection_requests') is null
    or not exists(select 1 from pg_catalog.pg_attribute
      where attrelid=to_regclass('public.messages') and attname='deleted_at' and not attisdropped)
    or to_regprocedure('public.xelay_claim_notification_email(uuid)') is null
    or to_regprocedure('public.xelay_finish_notification_email(uuid,uuid,text,text,text)') is null
    or exists(select 1 from pg_catalog.pg_class c where c.oid in(
      to_regclass('public.notifications'),to_regclass('public.notification_email_outbox'),
      to_regclass('public.notification_preferences'),to_regclass('public.messages'),
      to_regclass('public.conversations'),to_regclass('public.connection_requests')) and not c.relrowsecurity) then
    raise exception 'Apply existing email notifications and direct-message migrations before unread email delivery';
  end if;
end $$;

alter table public.notifications
  add column if not exists direct_message_id uuid references public.messages(id) on delete set null,
  add column if not exists direct_conversation_id uuid references public.conversations(id) on delete set null;
alter table public.notification_email_outbox
  add column if not exists direct_conversation_id uuid references public.conversations(id) on delete set null,
  add column if not exists delivery_reserved_at timestamptz;
create index if not exists notifications_direct_message_idx
  on public.notifications(direct_message_id) where type='message';
create index if not exists notifications_direct_conversation_idx
  on public.notifications(direct_conversation_id,recipient_id) where type='message';
create index if not exists notification_email_sent_thread_idx
  on public.notification_email_outbox(recipient_id,direct_conversation_id,completed_at desc)
  where notification_type='message' and status='sent';
create index if not exists notification_email_reserved_thread_idx
  on public.notification_email_outbox(recipient_id,direct_conversation_id,delivery_reserved_at desc)
  where notification_type='message' and delivery_reserved_at is not null;
create index if not exists messages_email_unread_thread_idx
  on public.messages(conversation_id,recipient_id,sender_id,created_at)
  where read_at is null and deleted_at is null;

create table if not exists public.notification_email_runtime (
  singleton boolean primary key default true check(singleton),
  worker_enabled boolean not null default false,
  last_heartbeat_at timestamptz,
  cutover_at timestamptz not null default clock_timestamp()
);
alter table public.notification_email_runtime enable row level security;
revoke all on public.notification_email_runtime from public,anon,authenticated,service_role;
insert into public.notification_email_runtime(singleton) values(true) on conflict do nothing;

-- One immutable cutover marker makes accidental replay safe: future queue
-- entries are not cancelled on a later repeat of this migration.
update public.notification_email_outbox q set status='skipped',completed_at=clock_timestamp(),
  last_error_code='email_setup_cutover',lock_token=null,locked_until=null
  where q.status in('pending','processing')
    and q.created_at<=(select r.cutover_at from public.notification_email_runtime r where r.singleton);
create unique index if not exists notification_email_active_thread_unique
  on public.notification_email_outbox(recipient_id,direct_conversation_id)
  where notification_type='message' and direct_conversation_id is not null and status in('pending','processing');

create or replace function public.xelay_notification_email_worker_heartbeat()
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501';
  end if;
  update public.notification_email_runtime set worker_enabled=true,last_heartbeat_at=clock_timestamp() where singleton;
end $$;
create or replace function public.xelay_notification_email_worker_disable()
returns void language plpgsql security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501';
  end if;
  update public.notification_email_runtime set worker_enabled=false where singleton;
end $$;
create or replace function public.xelay_notification_email_delivery_status()
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501';
  end if;
  return (select jsonb_build_object(
    'enabled',r.worker_enabled and coalesce(r.last_heartbeat_at>clock_timestamp()-interval '180 seconds',false)
      and to_regprocedure('public.xelay_claim_notification_email(uuid)') is not null
      and to_regprocedure('public.xelay_finish_notification_email(uuid,uuid,text,text,text)') is not null
      and to_regprocedure('public.xelay_notification_email_message_context(uuid,uuid)') is not null,
    'heartbeat_at',r.last_heartbeat_at) from public.notification_email_runtime r where r.singleton);
end $$;

create or replace function public.notify_new_message()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_actor_name text;
begin
  select p.full_name into v_actor_name from public.profiles p where p.id=new.sender_id;
  insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,
    direct_message_id,direct_conversation_id)
  values(new.recipient_id,new.sender_id,coalesce(nullif(v_actor_name,''),'Учасник'),
    'message','надіслав(-ла) вам повідомлення',new.read_at is not null or new.deleted_at is not null,
    new.id,new.conversation_id);
  return new;
end $$;
revoke all on function public.notify_new_message() from public,anon,authenticated,service_role;
drop trigger if exists message_notification on public.messages;
create trigger message_notification after insert on public.messages
  for each row execute function public.notify_new_message();

create or replace function public.xelay_sync_direct_notification_read()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op='DELETE' then
    update public.notifications n set is_read=true
      where n.type='message' and n.direct_message_id=old.id and not coalesce(n.is_read,false);
    return old;
  end if;
  if new.read_at is not null or new.deleted_at is not null then
    update public.notifications n set is_read=true
      where n.type='message' and n.direct_message_id=new.id and not coalesce(n.is_read,false);
  end if;
  return new;
end $$;
revoke all on function public.xelay_sync_direct_notification_read() from public,anon,authenticated,service_role;
drop trigger if exists xelay_sync_direct_notification_read on public.messages;
create trigger xelay_sync_direct_notification_read after update of read_at,deleted_at on public.messages
  for each row execute function public.xelay_sync_direct_notification_read();
drop trigger if exists xelay_sync_direct_notification_delete on public.messages;
create trigger xelay_sync_direct_notification_delete before delete on public.messages
  for each row execute function public.xelay_sync_direct_notification_read();

create or replace function public.xelay_queue_notification_email()
returns trigger language plpgsql security definer set search_path='' as $$
declare
  v_preferences public.notification_preferences%rowtype;
  v_key text;
  v_available timestamptz:=clock_timestamp();
  v_message public.messages%rowtype;
begin
  if new.recipient_id is null or new.recipient_id::text=coalesce(new.actor_id::text,'')
    or (new.type is distinct from 'message' and coalesce(new.is_read,false))
    or new.type is null or new.type not in('answer','question_comment','connection_request','connection_accepted','message','news_comment',
      'news_submission_published','news_submission_rejected','editor_request_approved','editor_request_rejected',
      'class_rep_approved','class_rep_rejected','group_invite','group_invite_accepted','group_homework') then return new; end if;
  if not exists(select 1 from auth.users u where u.id::text=new.recipient_id::text
    and u.email_confirmed_at is not null and nullif(u.email,'') is not null and u.deleted_at is null) then return new; end if;
  select * into v_preferences from public.notification_preferences where user_id::text=new.recipient_id::text;
  if not coalesce(v_preferences.notifications_enabled,true)
    or not coalesce(v_preferences.email_notifications_enabled,true) then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-email-'||new.recipient_id::text,0));

  if new.type='message' then
    select * into v_message from public.messages m
      where m.id=new.direct_message_id and m.conversation_id=new.direct_conversation_id
        and m.sender_id::text=new.actor_id::text and m.recipient_id::text=new.recipient_id::text
        and m.read_at is null and m.deleted_at is null;
    if not found then return new; end if;
    -- Retire an expired predecessor before the active-thread unique constraint
    -- sees the new event. Live processing leases are never overwritten.
    update public.notification_email_outbox q set status='skipped',completed_at=clock_timestamp(),
      last_error_code='expired',lock_token=null,locked_until=null
      where q.recipient_id::text=new.recipient_id::text and q.direct_conversation_id=new.direct_conversation_id
        and q.notification_type='message' and q.created_at<=clock_timestamp()-interval '23 hours'
        and (q.status='pending' or(q.status='processing' and q.locked_until<=clock_timestamp()));
    if exists(select 1 from public.notification_email_outbox q
      where q.recipient_id::text=new.recipient_id::text and q.direct_conversation_id=new.direct_conversation_id
        and q.notification_type='message' and q.status in('pending','processing')) then return new; end if;
    v_available:=greatest(v_message.created_at+interval '5 minutes',coalesce(
      (select max(greatest(case when q.status='sent' then q.completed_at else null end,q.delivery_reserved_at))
          +interval '10 minutes' from public.notification_email_outbox q
        where q.recipient_id::text=new.recipient_id::text and q.direct_conversation_id=new.direct_conversation_id
          and q.notification_type='message'),v_message.created_at+interval '5 minutes'));
  end if;
  if(select count(*) from public.notification_email_outbox q where q.recipient_id::text=new.recipient_id::text
    and q.created_at>clock_timestamp()-interval '1 hour')>=30 then return new; end if;
  v_key:=case when new.type='answer' and new.answer_id is not null
    then 'answer:'||new.answer_id::text||':'||new.recipient_id::text else 'notification:'||new.id::text end;
  insert into public.notification_email_outbox(notification_id,recipient_id,actor_id,notification_type,event_key,
    available_at,direct_conversation_id)
  values(new.id::text,new.recipient_id::uuid,new.actor_id::uuid,new.type,v_key,v_available,
    case when new.type='message' then new.direct_conversation_id else null end) on conflict do nothing;
  return new;
end $$;
revoke all on function public.xelay_queue_notification_email() from public,anon,authenticated,service_role;
drop trigger if exists notification_email_queue on public.notifications;
create trigger notification_email_queue after insert on public.notifications
  for each row execute function public.xelay_queue_notification_email();

-- Internal metadata only. No message body, address or user-editable profile
-- email enters this result; callers cannot query arbitrary conversations.
create or replace function public.xelay_private_notification_email_message_state(p_job_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_job public.notification_email_outbox%rowtype;
  v_notification public.notifications%rowtype;
  v_anchor public.messages%rowtype;
  v_conversation public.conversations%rowtype;
  v_first_unread timestamptz;
  v_last_sent timestamptz;
  v_other_lease timestamptz;
  v_due timestamptz;
begin
  select * into v_job from public.notification_email_outbox where id=p_job_id;
  if not found or v_job.notification_type<>'message' then
    return jsonb_build_object('eligible',false,'reason','message_context_missing','conversation_id',null); end if;
  if v_job.created_at<=clock_timestamp()-interval '23 hours' then
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
  if not found then return jsonb_build_object('eligible',false,'reason','message_removed','conversation_id',null); end if;
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
    and u.email_confirmed_at is not null and nullif(u.email,'') is not null and u.deleted_at is null) then
    return jsonb_build_object('eligible',false,'reason','email_unverified','conversation_id',null); end if;
  if exists(select 1 from public.notification_preferences p where p.user_id=v_job.recipient_id
    and(not p.notifications_enabled or not p.email_notifications_enabled)) then
    return jsonb_build_object('eligible',false,'reason','notifications_disabled','conversation_id',null); end if;

  -- This period starts with the trusted seed message, not old unread history.
  -- A read seed does not discard newer unread messages coalesced in the burst.
  select min(m.created_at) into v_first_unread from public.messages m
    where m.conversation_id=v_job.direct_conversation_id and m.recipient_id=v_job.recipient_id
      and m.sender_id=v_job.actor_id and m.read_at is null and m.deleted_at is null
      and m.created_at>=v_anchor.created_at and m.created_at<=clock_timestamp();
  if v_first_unread is null then
    return jsonb_build_object('eligible',false,'reason','already_read','conversation_id',v_job.direct_conversation_id); end if;
  select max(greatest(case when q.status='sent' then q.completed_at else null end,q.delivery_reserved_at))
    into v_last_sent from public.notification_email_outbox q
    where q.notification_type='message' and q.recipient_id=v_job.recipient_id
      and q.direct_conversation_id=v_job.direct_conversation_id and q.id<>v_job.id;
  select max(q.locked_until) into v_other_lease from public.notification_email_outbox q
    where q.notification_type='message' and q.recipient_id=v_job.recipient_id
      and q.direct_conversation_id=v_job.direct_conversation_id and q.status='processing'
      and q.locked_until>clock_timestamp() and q.id<>v_job.id;
  v_due:=greatest(v_first_unread+interval '5 minutes',coalesce(v_last_sent+interval '10 minutes','-infinity'::timestamptz),
    coalesce(v_other_lease,'-infinity'::timestamptz));
  return jsonb_build_object('eligible',v_due<=clock_timestamp(),'reason',case
    when v_other_lease>clock_timestamp() then 'conversation_in_progress'
    when v_last_sent+interval '10 minutes'>clock_timestamp() then 'conversation_rate_limit'
    when v_first_unread+interval '5 minutes'>clock_timestamp() then 'read_delay' else 'eligible' end,
    'conversation_id',v_job.direct_conversation_id,'due_at',v_due);
end $$;
revoke all on function public.xelay_private_notification_email_message_state(uuid) from public,anon,authenticated,service_role;

create or replace function public.xelay_notification_email_message_context(p_job_id uuid,p_lock_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_state jsonb;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501'; end if;
  if not exists(select 1 from public.notification_email_outbox q where q.id=p_job_id
    and q.status='processing' and q.lock_token=p_lock_token and q.locked_until>clock_timestamp()) then
    return jsonb_build_object('eligible',false,'reason','lease_lost','conversation_id',null); end if;
  v_state:=public.xelay_private_notification_email_message_state(p_job_id);
  if coalesce((v_state->>'eligible')::boolean,false) then
    -- Reserve a conservative cooldown before the provider call. If the provider
    -- accepts mail but its response is lost, later cancelling the read job must
    -- not allow another job in this conversation to send a duplicate burst.
    -- Retries of this same job keep their stable provider idempotency key.
    update public.notification_email_outbox q set delivery_reserved_at=clock_timestamp()
      where q.id=p_job_id and q.status='processing' and q.lock_token=p_lock_token and q.locked_until>clock_timestamp();
    if not found then return jsonb_build_object('eligible',false,'reason','lease_lost','conversation_id',null); end if;
  end if;
  return v_state;
end $$;

-- Keep the established return type so both worker routes retain the same job
-- contract. Delays and coalescing never consume a provider retry attempt.
create or replace function public.xelay_claim_notification_email(p_job_id uuid default null)
returns table(id uuid,notification_id text,attempts integer,created_at timestamptz,lock_token uuid)
language plpgsql security definer set search_path='' as $$
declare v_candidate public.notification_email_outbox%rowtype; v_state jsonb; v_reason text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501'; end if;
  if not exists(select 1 from public.notification_email_runtime r where r.singleton and r.worker_enabled
    and r.last_heartbeat_at>clock_timestamp()-interval '180 seconds') then return; end if;
  update public.notification_email_outbox q set status='skipped',completed_at=clock_timestamp(),
    last_error_code='expired',lock_token=null,locked_until=null
    where(q.status='pending' or(q.status='processing' and q.locked_until<=clock_timestamp()))
      and q.created_at<=clock_timestamp()-interval '23 hours';
  update public.notification_email_outbox q set status='failed',completed_at=clock_timestamp(),
    last_error_code='attempts_exhausted',lock_token=null,locked_until=null
    where q.attempts>=5 and(q.status='pending' or(q.status='processing' and q.locked_until<=clock_timestamp()));
  for v_candidate in
    select q.* from public.notification_email_outbox q
      where(p_job_id is null or q.id=p_job_id) and q.attempts<5 and q.created_at>clock_timestamp()-interval '23 hours'
        and((q.status='pending' and q.available_at<=clock_timestamp())
          or(q.status='processing' and q.locked_until<=clock_timestamp() and q.available_at<=clock_timestamp()))
      order by q.created_at,q.id for update skip locked limit 100
  loop
    -- The enqueue trigger takes this recipient lock first. A nonblocking try
    -- avoids inverted outbox-row/advisory-lock deadlocks during new messages.
    if not pg_try_advisory_xact_lock(hashtextextended('xelay-email-'||v_candidate.recipient_id::text,0)) then continue; end if;
    if v_candidate.notification_type='message' then
      v_state:=public.xelay_private_notification_email_message_state(v_candidate.id);
      v_reason:=v_state->>'reason';
      if not coalesce((v_state->>'eligible')::boolean,false) then
        if v_reason in('read_delay','conversation_rate_limit','conversation_in_progress') then
          update public.notification_email_outbox q set status='pending',available_at=(v_state->>'due_at')::timestamptz,
            lock_token=null,locked_until=null,last_error_code=v_reason where q.id=v_candidate.id;
        else
          update public.notification_email_outbox q set status='skipped',completed_at=clock_timestamp(),
            lock_token=null,locked_until=null,last_error_code=v_reason where q.id=v_candidate.id;
        end if;
        continue;
      end if;
    end if;
    return query update public.notification_email_outbox q set status='processing',attempts=q.attempts+1,
      lock_token=gen_random_uuid(),locked_until=clock_timestamp()+interval '2 minutes'
      where q.id=v_candidate.id returning q.id,q.notification_id,q.attempts,q.created_at,q.lock_token;
    return;
  end loop;
end $$;

create or replace function public.xelay_finish_notification_email(
  p_job_id uuid,p_lock_token uuid,p_status text,p_error_code text default null,p_provider_message_id text default null
)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_updated integer; v_state jsonb; v_wait boolean:=false;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501'; end if;
  if p_status is null or p_status not in('pending','sent','skipped','failed') then raise exception 'Invalid email job status'; end if;
  if p_status='pending' and p_error_code in('read_delay','conversation_rate_limit','conversation_in_progress') then
    v_state:=public.xelay_notification_email_message_context(p_job_id,p_lock_token);
    v_wait:=coalesce((v_state->>'eligible')::boolean,false)
      or v_state->>'reason' in('read_delay','conversation_rate_limit','conversation_in_progress');
  end if;
  update public.notification_email_outbox q set
    status=case when p_status='pending' and q.attempts>=5 and not coalesce(v_wait,false) then 'failed' else p_status end,
    attempts=case when coalesce(v_wait,false) then greatest(q.attempts-1,0) else q.attempts end,
    available_at=case when coalesce(v_wait,false) then (v_state->>'due_at')::timestamptz
      when p_status='pending' then clock_timestamp()+make_interval(secs=>least(1800,60*(2^(q.attempts-1))::integer))
      else q.available_at end,
    completed_at=case when p_status<>'pending' or(q.attempts>=5 and not coalesce(v_wait,false)) then clock_timestamp() else null end,
    provider_message_id=left(p_provider_message_id,200),last_error_code=left(p_error_code,80),lock_token=null,locked_until=null
    where q.id=p_job_id and q.status='processing' and q.lock_token=p_lock_token and q.locked_until>clock_timestamp();
  get diagnostics v_updated=row_count;
  return v_updated=1;
end $$;

revoke all on function public.xelay_notification_email_worker_heartbeat(),
  public.xelay_notification_email_worker_disable(),public.xelay_notification_email_delivery_status(),
  public.xelay_notification_email_message_context(uuid,uuid),public.xelay_claim_notification_email(uuid),
  public.xelay_finish_notification_email(uuid,uuid,text,text,text) from public,anon,authenticated,service_role;
grant execute on function public.xelay_notification_email_worker_heartbeat(),
  public.xelay_notification_email_worker_disable(),public.xelay_notification_email_delivery_status(),
  public.xelay_notification_email_message_context(uuid,uuid),public.xelay_claim_notification_email(uuid),
  public.xelay_finish_notification_email(uuid,uuid,text,text,text) to service_role;

comment on table public.notification_email_runtime is
  'Private notification email health and immutable cutover. No Auth email/signup/reset configuration is changed.';
comment on function public.xelay_notification_email_message_context(uuid,uuid) is
  'Service-only leased DM metadata: actual unread, undeleted messages from the trusted event period, accepted contact and enabled preferences. The notification bell does not decide DM mail. No message text or email address is returned.';
comment on function public.xelay_claim_notification_email(uuid) is
  'Service-only email lease. Requires healthy worker; unread DM email waits five minutes and coalesces per conversation, with at most one completed send per ten minutes. Waiting never spends a provider retry.';
notify pgrst,'reload schema';
commit;
