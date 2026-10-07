-- Xelay Participant expansion, 2026-10-07. First installation only.
-- Paste THIS ENTIRE FILE into a NEW EMPTY SQL Editor tab.
-- Existing functional billing/chat/organizer/media schema is required.
-- Compatible 070003 update is included. Do not append to an earlier query.
-- One transaction: any error rolls back this complete package.
-- All new tables have RLS and explicit grants. Do not disable security.
-- Background cron and deployment are separate; see XELAY_PARTICIPANT_EXPANSION_SETUP.md.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';
do $bundle$
declare v_table text;
begin
  foreach v_table in array array[
    'participant_worker_runtime','scheduled_direct_messages','organizer_task_reminders',
    'connection_request_weekly_usage','participant_appearance_preferences',
    'participant_push_subscriptions','participant_push_outbox'
  ] loop
    if to_regclass('public.' || v_table) is not null then
      raise exception 'Participant expansion already or partly installed (public.% exists). Do not rerun this first-install bundle. Apply only missing separate migrations 202610070004-007, in order; see XELAY_PARTICIPANT_EXPANSION_SETUP.md.', v_table;
    end if;
  end loop;
end;
$bundle$;

-- Source: 202610070003_direct_messaging_smoothness.sql
-- SHA256 of source with LF newlines: 264aa98b9e48399d38907e1343d8a1b42e2af6a27f40890d037cce83df0a5700
-- Direct messages: safe retries, one inbox query and scoped Realtime updates.
-- Apply before deploying the matching client. Accepts either the complete
-- direct-media security setup or the targeted production media repair from
-- 2026-10-04. Do not replay complete 004/005 over that partial repair.
-- Missing direct-send date/rate guard is installed below; existing guards remain.
-- No messages, media, policies, subscription rules or read grants are removed.
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$
declare
  v_table text;
  v_relation regclass;
  v_required record;
  v_missing text[] := '{}';
begin
  foreach v_table in array array['conversations','connection_requests','messages','message_reactions','message_attachments'] loop
    v_relation := to_regclass('public.' || v_table);
    if v_relation is null then
      v_missing := array_append(v_missing,'public.' || v_table);
    elsif not exists(select 1 from pg_catalog.pg_class where oid=v_relation and relrowsecurity) then
      v_missing := array_append(v_missing,'RLS enabled on public.' || v_table);
    end if;
  end loop;
  for v_required in select * from (values
    ('messages','shared_post_id'),('messages','reply_to_message_id'),('messages','deleted_at'),
    ('message_attachments','file_size')
  ) required(table_name,column_name) loop
    if not exists(select 1 from pg_catalog.pg_attribute
      where attrelid=to_regclass('public.' || v_required.table_name)
        and attname=v_required.column_name and not attisdropped) then
      v_missing := array_append(v_missing,'public.' || v_required.table_name || '.' || v_required.column_name);
    end if;
  end loop;
  for v_required in select * from (values
    ('messages','validate_message_reply_insert','public.xelay_validate_message_reply()'),
    ('messages','remove_deleted_message_attachments','public.xelay_remove_deleted_message_attachments()'),
    ('message_attachments','xelay_private_validate_message_attachment','public.xelay_private_validate_message_attachment()')
  ) required(table_name,trigger_name,function_signature) loop
    if not exists(select 1 from pg_catalog.pg_trigger
      where tgrelid=to_regclass('public.' || v_required.table_name)
        and tgname=v_required.trigger_name and not tgisinternal and tgenabled in('O','A')
        and tgfoid=to_regprocedure(v_required.function_signature)) then
      v_missing := array_append(v_missing,v_required.trigger_name || ' enabled on public.' || v_required.table_name);
    end if;
  end loop;
  if to_regprocedure('public.xelay_send_direct_message(uuid,uuid,text,uuid,jsonb)') is null then
    v_missing := array_append(v_missing,'public.xelay_send_direct_message(uuid,uuid,text,uuid,jsonb)');
  end if;
  if cardinality(v_missing)>0 then
    raise exception 'Direct messaging prerequisites missing: %. Review a targeted continuation of the existing media/reply setup; do not rerun complete 004/005 over partial media repair or disable RLS/security guards.',array_to_string(v_missing,', ');
  end if;
end $$;

-- The final UUID is part of ordering, so equal timestamps do not lose a message
-- at a keyset page boundary. Partial unread counts stay local to a conversation.
create index if not exists messages_conversation_created_id_idx
  on public.messages(conversation_id,created_at desc,id desc);
create index if not exists messages_conversation_unread_recipient_idx
  on public.messages(conversation_id,recipient_id) where read_at is null;
create index if not exists messages_sender_created_idx
  on public.messages(sender_id,created_at);

-- The 2026-10-04 compatibility repair intentionally installed the media RPCs
-- without replaying the full 005 security migration. Continue that state by
-- adding only its missing direct-send guard. Retain an existing active guard,
-- including a newer implementation; never replace an unknown partial function.
do $direct_guard_install$
begin
  if exists(select 1 from pg_catalog.pg_trigger
    where tgrelid='public.messages'::regclass and tgname='xelay_private_guard_message' and not tgisinternal) then
    if not exists(select 1 from pg_catalog.pg_trigger
      where tgrelid='public.messages'::regclass and tgname='xelay_private_guard_message' and not tgisinternal
        and tgenabled in('O','A') and tgfoid=to_regprocedure('public.xelay_private_guard_message()')) then
      raise exception 'Existing xelay_private_guard_message trigger differs or is disabled. Review its definition before continuing; no guard is overwritten.';
    end if;
  elsif to_regprocedure('public.xelay_private_guard_message()') is not null then
    raise exception 'Existing xelay_private_guard_message function has no matching trigger. Review this partial setup before continuing; its definition is not overwritten.';
  else
    -- Body retained from 202610030005_message_chat_security.sql.
    execute $create_direct_guard$
create function public.xelay_private_guard_message()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if tg_op='UPDATE' then new.created_at:=old.created_at; return new; end if;
  if auth.uid() is null or new.sender_id is distinct from auth.uid() then raise exception 'CHAT_AUTH_REQUIRED' using errcode='42501'; end if;
  -- Use the same container -> sender order as publication RPCs; lock both normal INSERT and RPC sends.
  perform 1 from public.conversations c where c.id=new.conversation_id
    and ((c.user_one_id=new.sender_id and c.user_two_id=new.recipient_id)
      or (c.user_two_id=new.sender_id and c.user_one_id=new.recipient_id)) for update;
  if not found then raise exception 'CHAT_MEMBER_REQUIRED' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-direct-send:' || new.sender_id::text,0));
  new.created_at:=clock_timestamp();
  if (select count(*) from public.messages where sender_id=new.sender_id and created_at>new.created_at-interval '1 minute')>=30
    or (select count(*) from public.messages where sender_id=new.sender_id and created_at>new.created_at-interval '1 day')>=1000
    or (select count(*) from public.messages where sender_id=new.sender_id and conversation_id=new.conversation_id
      and created_at>new.created_at-interval '1 minute')>=30 then
    raise exception 'DIRECT_MESSAGE_RATE_LIMIT' using errcode='P0001';
  end if;
  return new;
end $$;
$create_direct_guard$;
    execute 'revoke all on function public.xelay_private_guard_message() from public,anon,authenticated,service_role';
    execute 'create trigger xelay_private_guard_message before insert or update on public.messages for each row execute function public.xelay_private_guard_message()';
  end if;
end;
$direct_guard_install$;

-- Keep the same RPC signature and atomic message + attachment transaction.
-- Conversation serialization makes concurrent retries wait for the first
-- commit. The existing INSERT triggers still set the date, enforce rate limits,
-- validate the reply and owned Storage object, and consume cleanup receipts.
create or replace function public.xelay_send_direct_message(
  p_message_id uuid,p_conversation_id uuid,p_body text,
  p_reply_to uuid default null,p_attachments jsonb default '[]'
)
returns jsonb language plpgsql security definer set search_path = public,pg_temp as $$
declare
  v_actor uuid := auth.uid();
  v_conversation public.conversations%rowtype;
  v_message public.messages%rowtype;
  v_item jsonb;
  v_recipient uuid;
  v_requested_attachments jsonb;
  v_existing_attachments jsonb;
begin
  if v_actor is null then raise exception 'CHAT_AUTH_REQUIRED' using errcode='42501'; end if;
  if p_message_id is null or p_conversation_id is null or p_body is null
    or length(btrim(p_body)) not between 1 and 5000
    or p_attachments is null or jsonb_typeof(p_attachments)<>'array' then
    raise exception 'CHAT_INVALID_INPUT';
  end if;
  if jsonb_array_length(p_attachments)>5 then raise exception 'PRIVATE_MEDIA_ATTACHMENT_LIMIT'; end if;

  -- Parse before replay comparison as well: unknown keys, null metadata and
  -- duplicate paths cannot make two different send requests look identical.
  for v_item in select value from jsonb_array_elements(p_attachments) loop
    if jsonb_typeof(v_item)<>'object' then raise exception 'PRIVATE_MEDIA_INVALID'; end if;
    if exists(select 1 from jsonb_each(v_item) e
      where e.key not in('storage_path','file_name','media_type','mime_type'))
      or jsonb_typeof(v_item->'storage_path') is distinct from 'string'
      or jsonb_typeof(v_item->'file_name') is distinct from 'string'
      or jsonb_typeof(v_item->'media_type') is distinct from 'string'
      or jsonb_typeof(v_item->'mime_type') is distinct from 'string' then
      raise exception 'PRIVATE_MEDIA_INVALID';
    end if;
  end loop;
  if (select count(distinct item->>'storage_path') from jsonb_array_elements(p_attachments) attachments(item))
    <>jsonb_array_length(p_attachments) then raise exception 'PRIVATE_MEDIA_INVALID'; end if;
  select coalesce(jsonb_agg(item order by item->>'storage_path'),'[]'::jsonb)
    into v_requested_attachments from jsonb_array_elements(p_attachments) attachments(item);

  select * into v_conversation from public.conversations c
    where c.id=p_conversation_id and v_actor in(c.user_one_id,c.user_two_id) for update;
  if not found then raise exception 'CHAT_MEMBER_REQUIRED' using errcode='42501'; end if;
  v_recipient := case when v_conversation.user_one_id=v_actor
    then v_conversation.user_two_id else v_conversation.user_one_id end;

  -- A retry never bypasses a subsequently revoked accepted connection. Only
  -- acceptance creates a normal conversation; old history remains readable
  -- through the existing policies even if the connection is later withdrawn.
  perform 1 from public.connection_requests r
    where r.status='accepted'
      and least(r.requester_id,r.recipient_id)=v_conversation.user_one_id
      and greatest(r.requester_id,r.recipient_id)=v_conversation.user_two_id for share;
  if not found then raise exception 'CHAT_CONNECTION_REQUIRED' using errcode='42501'; end if;

  select * into v_message from public.messages
    where id=p_message_id and conversation_id=p_conversation_id and sender_id=v_actor for update;
  if found then
    if v_message.sender_id is distinct from v_actor
      or v_message.recipient_id is distinct from v_recipient
      or v_message.conversation_id is distinct from p_conversation_id then
      raise exception 'DIRECT_MESSAGE_ID_CONFLICT' using errcode='23505';
    end if;
    -- Deletion deliberately erases the original body/descriptors. A terminal
    -- error acknowledges that identity without returning the removed content
    -- or treating a later retry as permission to resurrect it.
    if v_message.deleted_at is not null then raise exception 'DIRECT_MESSAGE_REMOVED'; end if;
    if v_message.body is distinct from p_body
      or v_message.reply_to_message_id is distinct from p_reply_to
      or v_message.shared_post_id is not null then
      raise exception 'DIRECT_MESSAGE_ID_CONFLICT' using errcode='23505';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
      'storage_path',a.storage_path,'file_name',a.file_name,
      'media_type',a.media_type,'mime_type',a.mime_type
    ) order by a.storage_path),'[]'::jsonb)
      into v_existing_attachments from public.message_attachments a
      where a.message_id=v_message.id and a.conversation_id=p_conversation_id and a.uploaded_by=v_actor;
    if v_existing_attachments is distinct from v_requested_attachments then
      raise exception 'DIRECT_MESSAGE_ID_CONFLICT' using errcode='23505';
    end if;
    -- The existing record includes its current read_at; replay emits neither a
    -- second INSERT nor a second notification and does not reset abuse quotas.
    return to_jsonb(v_message);
  end if;

  insert into public.messages(id,conversation_id,sender_id,recipient_id,body,reply_to_message_id)
    values(p_message_id,p_conversation_id,v_actor,v_recipient,p_body,p_reply_to) returning * into v_message;
  for v_item in select value from jsonb_array_elements(p_attachments) loop
    insert into public.message_attachments(message_id,conversation_id,uploaded_by,storage_path,file_name,media_type,mime_type)
      values(v_message.id,p_conversation_id,v_actor,v_item->>'storage_path',v_item->>'file_name',v_item->>'media_type',v_item->>'mime_type');
  end loop;
  return to_jsonb(v_message);
end $$;

-- Client queues capture the sender identity before asynchronous upload/auth
-- refresh. Check it again in the same HTTP request that commits the send, so
-- switching between both participants cannot submit the old draft as the peer.
create or replace function public.xelay_send_direct_message_checked(
  p_sender_id uuid,p_message_id uuid,p_conversation_id uuid,p_body text,
  p_reply_to uuid default null,p_attachments jsonb default '[]'
)
returns jsonb language plpgsql security invoker set search_path = public,pg_temp as $$
begin
  if auth.uid() is null or auth.uid() is distinct from p_sender_id then
    raise exception 'CHAT_AUTH_CHANGED' using errcode='42501';
  end if;
  return public.xelay_send_direct_message(p_message_id,p_conversation_id,p_body,p_reply_to,p_attachments);
end $$;

-- Invoker execution deliberately retains the existing conversations/messages
-- SELECT privileges and RLS. One request replaces two HTTP calls per chat.
create or replace function public.xelay_direct_conversation_summaries()
returns jsonb language plpgsql stable security invoker set search_path = public,pg_temp as $$
declare v_actor uuid := auth.uid(); v_result jsonb;
begin
  if v_actor is null then raise exception 'CHAT_AUTH_REQUIRED' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',c.id,'created_at',c.created_at,'user_one_id',c.user_one_id,'user_two_id',c.user_two_id,
    'last_message',latest.message,'unread_count',unread.total
  ) order by coalesce(latest.message_created_at,c.created_at) desc,c.id desc),'[]'::jsonb)
    into v_result
    from public.conversations c
    left join lateral (
      select to_jsonb(m) as message,m.created_at as message_created_at from public.messages m
        where m.conversation_id=c.id and v_actor in(m.sender_id,m.recipient_id)
          and ((m.sender_id=c.user_one_id and m.recipient_id=c.user_two_id)
            or (m.sender_id=c.user_two_id and m.recipient_id=c.user_one_id))
        order by m.created_at desc,m.id desc limit 1
    ) latest on true
    cross join lateral (
      select count(*) as total from public.messages m
        where m.conversation_id=c.id and m.recipient_id=v_actor and m.read_at is null
    ) unread
    where v_actor in(c.user_one_id,c.user_two_id);
  return v_result;
end $$;

revoke all on function public.xelay_send_direct_message(uuid,uuid,text,uuid,jsonb),
  public.xelay_send_direct_message_checked(uuid,uuid,uuid,text,uuid,jsonb),
  public.xelay_direct_conversation_summaries() from public,anon,authenticated,service_role;
grant execute on function public.xelay_send_direct_message(uuid,uuid,text,uuid,jsonb),
  public.xelay_send_direct_message_checked(uuid,uuid,uuid,text,uuid,jsonb),
  public.xelay_direct_conversation_summaries() to authenticated;

-- Publish only the already RLS-protected direct-message tables. Deleted rows
-- carry only the primary key; never enable FULL replica identity for private
-- message bodies or attachment metadata. No table privileges are widened.
alter table public.conversations replica identity default;
alter table public.messages replica identity default;
alter table public.message_reactions replica identity default;
alter table public.message_attachments replica identity default;
do $$
declare v_table text;
begin
  if exists(select 1 from pg_catalog.pg_publication where pubname='supabase_realtime' and not puballtables) then
    foreach v_table in array array['conversations','messages','message_reactions','message_attachments'] loop
      if not exists(select 1 from pg_catalog.pg_publication_tables
        where pubname='supabase_realtime' and schemaname='public' and tablename=v_table) then
        execute format('alter publication supabase_realtime add table public.%I',v_table);
      end if;
    end loop;
  end if;
end $$;

comment on function public.xelay_send_direct_message(uuid,uuid,text,uuid,jsonb) is
  'Atomic authenticated direct send. A fixed message UUID may be retried only for the same accepted conversation, author and immutable body/reply/attachment set; exact replay returns the existing current record without duplicate notification or upload.';
comment on function public.xelay_direct_conversation_summaries() is
  'Authenticated invoker-scoped inbox JSON array: own conversations, current last message (including a soft-deleted placeholder), unread recipient count. Existing SELECT privileges and RLS remain authoritative.';
comment on function public.xelay_send_direct_message_checked(uuid,uuid,uuid,text,uuid,jsonb) is
  'Authenticated sender-identity boundary for queued sends. The captured sender UUID must match the current request JWT before calling the idempotent atomic direct-send RPC.';
notify pgrst,'reload schema';


-- Source: 202610070004_participant_direct_features.sql
-- SHA256 of source with LF newlines: 6368b062e4b0dabf96573dd888324222b9733ccdccd06e92a33ee0a679cfc798
-- Participant: server-side conversation search and text-only scheduled directs.
-- Apply after 202610070003. Existing media guards/RLS are retained; no history,
-- contact or free chat permissions are changed. Background delivery stays off
-- until a service-only worker has completed its first successful heartbeat.
set local lock_timeout='5s';
set local statement_timeout='60s';
do $$
begin
  if to_regprocedure('public.xelay_send_direct_message_checked(uuid,uuid,uuid,text,uuid,jsonb)') is null
    or to_regprocedure('public.xelay_has_participant_access(uuid)') is null
    or to_regprocedure('public.xelay_chat_can_read_post(uuid)') is null
    or to_regclass('public.chat_publications') is null then
    raise exception 'Apply direct messaging 202610070003, participant billing and community chats before participant direct features';
  end if;
end $$;

create table public.participant_worker_runtime (
  singleton boolean primary key default true check(singleton),
  worker_enabled boolean not null default false,
  last_heartbeat_at timestamptz
);
insert into public.participant_worker_runtime(singleton) values(true);
alter table public.participant_worker_runtime enable row level security;
revoke all on public.participant_worker_runtime from public,anon,authenticated,service_role;

create table public.scheduled_direct_messages (
  id uuid primary key,
  owner_id uuid not null references public.profiles(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  message_id uuid not null unique,
  body text not null check(length(btrim(body)) between 1 and 5000),
  reply_to_message_id uuid,
  scheduled_at timestamptz not null,
  status text not null default 'pending' check(status in('pending','sent','cancelled','failed')),
  attempts integer not null default 0 check(attempts between 0 and 5),
  next_attempt_at timestamptz,
  failure_code text,
  sent_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  check(message_id=id)
);
create index scheduled_direct_due_idx on public.scheduled_direct_messages(coalesce(next_attempt_at,scheduled_at),id) where status='pending';
create index scheduled_direct_owner_idx on public.scheduled_direct_messages(owner_id,conversation_id,scheduled_at,id);
alter table public.scheduled_direct_messages enable row level security;
revoke all on public.scheduled_direct_messages from public,anon,authenticated,service_role;
grant select on public.scheduled_direct_messages to authenticated;
create policy "Owner reads scheduled directs" on public.scheduled_direct_messages for select to authenticated using(owner_id=auth.uid());

create or replace function public.xelay_participant_runtime_status()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if auth.uid() is null and auth.role() is distinct from 'service_role' then raise exception 'CHAT_AUTH_REQUIRED' using errcode='42501'; end if;
  return (select jsonb_build_object('scheduled_enabled',worker_enabled and last_heartbeat_at>clock_timestamp()-interval '5 minutes',
    'last_heartbeat_at',last_heartbeat_at) from public.participant_worker_runtime where singleton);
end $$;
create or replace function public.xelay_participant_worker_heartbeat()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'WORKER_SERVICE_REQUIRED' using errcode='42501'; end if;
  update public.participant_worker_runtime set worker_enabled=true,last_heartbeat_at=clock_timestamp() where singleton;
  return jsonb_build_object('scheduled_enabled',true);
end $$;
create or replace function public.xelay_participant_worker_disable()
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'WORKER_SERVICE_REQUIRED' using errcode='42501'; end if;
  update public.participant_worker_runtime set worker_enabled=false where singleton;
end $$;

create or replace function public.xelay_schedule_direct_message(p_owner_id uuid,p_job_id uuid,p_conversation_id uuid,p_body text,p_scheduled_at timestamptz,p_reply_to uuid default null)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_job public.scheduled_direct_messages%rowtype; v_conversation public.conversations%rowtype;
begin
  if v_actor is null then raise exception 'CHAT_AUTH_REQUIRED' using errcode='42501'; end if;
  if v_actor is distinct from p_owner_id then raise exception 'CHAT_AUTH_CHANGED' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-schedule:'||v_actor::text,0));
  select * into v_job from public.scheduled_direct_messages where id=p_job_id for update;
  if found then
    if v_job.owner_id is distinct from v_actor or v_job.conversation_id is distinct from p_conversation_id
      or v_job.body is distinct from p_body or v_job.scheduled_at is distinct from p_scheduled_at
      or v_job.reply_to_message_id is distinct from p_reply_to then raise exception 'SCHEDULE_ID_CONFLICT'; end if;
    return to_jsonb(v_job);
  end if;
  if not public.xelay_has_participant_access(v_actor) then raise exception 'PARTICIPANT_REQUIRED' using errcode='42501'; end if;
  if not coalesce((public.xelay_participant_runtime_status()->>'scheduled_enabled')::boolean,false) then raise exception 'SCHEDULE_WORKER_UNAVAILABLE'; end if;
  if p_job_id is null or p_conversation_id is null or p_body is null or length(btrim(p_body)) not between 1 and 5000
    or p_scheduled_at is null or p_scheduled_at<clock_timestamp()+interval '1 minute' or p_scheduled_at>clock_timestamp()+interval '90 days' then raise exception 'SCHEDULE_INVALID_INPUT'; end if;
  select * into v_conversation from public.conversations where id=p_conversation_id and v_actor in(user_one_id,user_two_id);
  if not found then raise exception 'CHAT_MEMBER_REQUIRED' using errcode='42501'; end if;
  if not exists(select 1 from public.connection_requests r where r.status='accepted'
    and least(r.requester_id,r.recipient_id)=v_conversation.user_one_id and greatest(r.requester_id,r.recipient_id)=v_conversation.user_two_id) then raise exception 'CHAT_CONNECTION_REQUIRED' using errcode='42501'; end if;
  if p_reply_to is not null and not exists(select 1 from public.messages m where m.id=p_reply_to and m.conversation_id=p_conversation_id and m.deleted_at is null) then raise exception 'CHAT_INVALID_REPLY'; end if;
  if (select count(*) from public.scheduled_direct_messages where owner_id=v_actor and status='pending')>=50 then raise exception 'SCHEDULE_LIMIT'; end if;
  if exists(select 1 from public.messages where id=p_job_id) then raise exception 'SCHEDULE_ID_CONFLICT'; end if;
  insert into public.scheduled_direct_messages(id,owner_id,conversation_id,message_id,body,reply_to_message_id,scheduled_at)
    values(p_job_id,v_actor,p_conversation_id,p_job_id,p_body,p_reply_to,p_scheduled_at) returning * into v_job;
  return to_jsonb(v_job);
end $$;

create or replace function public.xelay_update_scheduled_direct_message(p_job_id uuid,p_body text,p_scheduled_at timestamptz)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_actor uuid:=auth.uid(); v_job public.scheduled_direct_messages%rowtype;
begin
  if v_actor is null then raise exception 'CHAT_AUTH_REQUIRED' using errcode='42501'; end if;
  if not public.xelay_has_participant_access(v_actor) then raise exception 'PARTICIPANT_REQUIRED' using errcode='42501'; end if;
  if not coalesce((public.xelay_participant_runtime_status()->>'scheduled_enabled')::boolean,false) then raise exception 'SCHEDULE_WORKER_UNAVAILABLE'; end if;
  if p_body is null or length(btrim(p_body)) not between 1 and 5000 or p_scheduled_at is null
    or p_scheduled_at<clock_timestamp()+interval '1 minute' or p_scheduled_at>clock_timestamp()+interval '90 days' then raise exception 'SCHEDULE_INVALID_INPUT'; end if;
  select * into v_job from public.scheduled_direct_messages where id=p_job_id and owner_id=v_actor for update;
  if not found then raise exception 'SCHEDULE_NOT_FOUND'; end if;
  if v_job.status<>'pending' then raise exception 'SCHEDULE_CLOSED'; end if;
  update public.scheduled_direct_messages set body=p_body,scheduled_at=p_scheduled_at,next_attempt_at=null,attempts=0,failure_code=null,updated_at=clock_timestamp()
    where id=p_job_id returning * into v_job;
  return to_jsonb(v_job);
end $$;
create or replace function public.xelay_cancel_scheduled_direct_message(p_job_id uuid)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job public.scheduled_direct_messages%rowtype;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED' using errcode='42501'; end if;
  select * into v_job from public.scheduled_direct_messages where id=p_job_id and owner_id=auth.uid() for update;
  if not found then raise exception 'SCHEDULE_NOT_FOUND'; end if;
  if v_job.status='sent' then raise exception 'SCHEDULE_CLOSED'; end if;
  update public.scheduled_direct_messages set status='cancelled',failure_code='OWNER_CANCELLED',updated_at=clock_timestamp() where id=p_job_id;
end $$;

-- Only the trusted worker can bind request auth to the immutable stored actor.
-- Existing core RPC locks accepted contacts, validates replies, applies quotas
-- and uses the immutable UUID for replay-safe insert + notification delivery.
create or replace function public.xelay_dispatch_scheduled_direct_messages(p_limit integer default 20)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_job public.scheduled_direct_messages%rowtype; v_result jsonb; v_sent integer:=0; v_failed integer:=0; v_cancelled integer:=0;
  v_claims text:=current_setting('request.jwt.claims',true); v_sub text:=current_setting('request.jwt.claim.sub',true);
  v_role text:=current_setting('request.jwt.claim.role',true); v_error text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'WORKER_SERVICE_REQUIRED' using errcode='42501'; end if;
  if not exists(select 1 from public.participant_worker_runtime where singleton and worker_enabled and last_heartbeat_at>clock_timestamp()-interval '5 minutes') then
    return jsonb_build_object('sent',0,'failed',0,'cancelled',0,'worker_ready',false);
  end if;
  for v_job in select * from public.scheduled_direct_messages where status='pending'
    and scheduled_at<=clock_timestamp() and coalesce(next_attempt_at,scheduled_at)<=clock_timestamp()
    order by coalesce(next_attempt_at,scheduled_at),id limit greatest(1,least(coalesce(p_limit,20),50)) for update skip locked loop
    begin
      perform pg_advisory_xact_lock(hashtextextended('xelay:premium:'||v_job.owner_id::text,0));
      if not public.xelay_has_participant_access(v_job.owner_id) then
        update public.scheduled_direct_messages set status='cancelled',failure_code='PARTICIPANT_EXPIRED',updated_at=clock_timestamp() where id=v_job.id;
        v_cancelled:=v_cancelled+1; continue;
      end if;
      perform set_config('request.jwt.claim.sub',v_job.owner_id::text,true);
      perform set_config('request.jwt.claim.role','authenticated',true);
      perform set_config('request.jwt.claims',jsonb_build_object('sub',v_job.owner_id,'role','authenticated')::text,true);
      v_result:=public.xelay_send_direct_message_checked(v_job.owner_id,v_job.message_id,v_job.conversation_id,v_job.body,v_job.reply_to_message_id,'[]');
      perform set_config('request.jwt.claim.sub',coalesce(v_sub,''),true);
      perform set_config('request.jwt.claim.role',coalesce(v_role,''),true);
      perform set_config('request.jwt.claims',coalesce(v_claims,''),true);
      update public.scheduled_direct_messages set status='sent',sent_at=clock_timestamp(),attempts=attempts+1,failure_code=null,updated_at=clock_timestamp() where id=v_job.id;
      v_sent:=v_sent+1;
    exception when others then
      perform set_config('request.jwt.claim.sub',coalesce(v_sub,''),true);
      perform set_config('request.jwt.claim.role',coalesce(v_role,''),true);
      perform set_config('request.jwt.claims',coalesce(v_claims,''),true);
      v_error:=case when sqlerrm like '%CHAT_CONNECTION_REQUIRED%' then 'CONTACT_UNAVAILABLE'
        when sqlerrm like '%CHAT_MEMBER_REQUIRED%' then 'CONTACT_UNAVAILABLE'
        when sqlerrm like '%CHAT_INVALID_REPLY%' or sqlerrm like '%MESSAGE_REPLY%' then 'REPLY_UNAVAILABLE'
        when sqlerrm like '%DIRECT_MESSAGE_REMOVED%' then 'MESSAGE_REMOVED'
        when sqlerrm like '%DIRECT_MESSAGE_ID_CONFLICT%' then 'MESSAGE_CONFLICT'
        else 'TEMPORARY_DELIVERY_FAILURE' end;
      update public.scheduled_direct_messages set attempts=attempts+1,
        status=case when v_error<>'TEMPORARY_DELIVERY_FAILURE' or attempts+1>=5 then 'failed' else 'pending' end,
        next_attempt_at=clock_timestamp()+(attempts+1)*interval '2 minutes',failure_code=v_error,updated_at=clock_timestamp() where id=v_job.id;
      v_failed:=v_failed+1;
    end;
  end loop;
  return jsonb_build_object('sent',v_sent,'failed',v_failed,'cancelled',v_cancelled,'worker_ready',true);
end $$;

-- Keyset search uses current RLS and post visibility predicates on every page.
-- Returned attachment metadata has neither storage paths nor signed URLs.
create or replace function public.xelay_search_conversation_messages(
  p_kind text,p_container_id uuid,p_query text default '',p_author_id uuid default null,
  p_from date default null,p_through date default null,p_media text default 'all',
  p_before timestamptz default null,p_before_id uuid default null,p_limit integer default 30
)
returns jsonb language plpgsql stable security invoker set search_path=public,pg_temp as $$
declare v_query text:=btrim(coalesce(p_query,'')); v_result jsonb;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED' using errcode='42501'; end if;
  if not public.xelay_has_participant_access(auth.uid()) then raise exception 'PARTICIPANT_REQUIRED' using errcode='42501'; end if;
  if p_kind is null or p_kind not in('direct','group','channel') or p_container_id is null or length(v_query)>150
    or p_media not in('all','photo','video','file','link') or p_media is null
    or (p_from is not null and p_through is not null and p_from>p_through)
    or (p_before is null)<>(p_before_id is null) then raise exception 'CHAT_INVALID_INPUT'; end if;
  if p_kind='direct' then
    if not exists(select 1 from public.conversations where id=p_container_id and auth.uid() in(user_one_id,user_two_id)) then raise exception 'CHAT_MEMBER_REQUIRED' using errcode='42501'; end if;
    select coalesce(jsonb_agg(to_jsonb(found) order by found.created_at desc,found.id desc),'[]') into v_result from (
      select m.id,m.sender_id,m.body,m.created_at,
        coalesce((select jsonb_agg(jsonb_build_object('file_name',a.file_name,'media_type',a.media_type)) from public.message_attachments a where a.message_id=m.id),'[]') as attachments
      from public.messages m where m.conversation_id=p_container_id and auth.uid() in(m.sender_id,m.recipient_id) and m.deleted_at is null
        and (v_query='' or strpos(lower(m.body),lower(v_query))>0 or exists(select 1 from public.message_attachments a where a.message_id=m.id and strpos(lower(a.file_name),lower(v_query))>0)
          or exists(select 1 from public.chat_publications pub where pub.message_id=m.id and strpos(lower(coalesce(pub.content->>'title','')||' '||coalesce(pub.content->>'body','')||' '||coalesce(pub.content->>'question','')),lower(v_query))>0))
        and (p_author_id is null or m.sender_id=p_author_id)
        and (p_from is null or m.created_at>=p_from::timestamp at time zone 'Europe/Kyiv')
        and (p_through is null or m.created_at<(p_through+1)::timestamp at time zone 'Europe/Kyiv')
        and (p_before is null or (m.created_at,m.id)<(p_before,p_before_id))
        and (p_media='all' or (p_media='link' and (m.body~*'https?://' or exists(select 1 from public.chat_publications pub where pub.message_id=m.id and pub.content->>'body'~*'https?://')))
          or exists(select 1 from public.message_attachments a where a.message_id=m.id and a.media_type=case p_media when 'photo' then 'image' else p_media end))
      order by m.created_at desc,m.id desc limit greatest(1,least(coalesce(p_limit,30),50))
    ) found;
  else
    if not exists(select 1 from public.chat_spaces s where s.id=p_container_id and s.kind=p_kind
      and public.xelay_chat_is_member(s.id)) then raise exception 'CHAT_MEMBER_REQUIRED' using errcode='42501'; end if;
    select coalesce(jsonb_agg(to_jsonb(found) order by found.created_at desc,found.id desc),'[]') into v_result from (
      select m.id,m.sender_id,m.body,m.created_at,
        coalesce((select jsonb_agg(jsonb_build_object('file_name',a.file_name,'media_type',a.media_type)) from public.chat_attachments a where a.post_id=m.id),'[]') as attachments
      from public.chat_posts m where m.space_id=p_container_id and m.deleted_at is null and public.xelay_chat_can_read_post(m.id)
        and (v_query='' or strpos(lower(m.body),lower(v_query))>0 or exists(select 1 from public.chat_attachments a where a.post_id=m.id and strpos(lower(a.file_name),lower(v_query))>0)
          or exists(select 1 from public.chat_publications pub where pub.post_id=m.id and strpos(lower(coalesce(pub.content->>'title','')||' '||coalesce(pub.content->>'body','')||' '||coalesce(pub.content->>'question','')),lower(v_query))>0))
        and (p_author_id is null or m.sender_id=p_author_id)
        and (p_from is null or m.created_at>=p_from::timestamp at time zone 'Europe/Kyiv')
        and (p_through is null or m.created_at<(p_through+1)::timestamp at time zone 'Europe/Kyiv')
        and (p_before is null or (m.created_at,m.id)<(p_before,p_before_id))
        and (p_media='all' or (p_media='link' and (m.body~*'https?://' or exists(select 1 from public.chat_publications pub where pub.post_id=m.id and pub.content->>'body'~*'https?://')))
          or exists(select 1 from public.chat_attachments a where a.post_id=m.id and a.media_type=case p_media when 'photo' then 'image' else p_media end))
      order by m.created_at desc,m.id desc limit greatest(1,least(coalesce(p_limit,30),50))
    ) found;
  end if;
  return v_result;
end $$;

-- Discover an author only from the caller's readable history in this container.
-- Return known IDs; the established public-profile RPC formats their fields.
create or replace function public.xelay_conversation_search_authors(p_kind text,p_container_id uuid,p_query text default '',p_limit integer default 30)
returns uuid[] language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_query text:=lower(ltrim(btrim(coalesce(p_query,'')),'@')); v_result uuid[];
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED' using errcode='42501'; end if;
  if not public.xelay_has_participant_access(auth.uid()) then raise exception 'PARTICIPANT_REQUIRED' using errcode='42501'; end if;
  if p_kind is null or p_kind not in('direct','group','channel') or p_container_id is null or length(v_query)>80 then raise exception 'CHAT_INVALID_INPUT'; end if;
  if p_kind='direct' then
    if not exists(select 1 from public.conversations where id=p_container_id and auth.uid() in(user_one_id,user_two_id)) then raise exception 'CHAT_MEMBER_REQUIRED' using errcode='42501'; end if;
    select coalesce(array_agg(found.id),'{}'::uuid[]) into v_result from (
      select p.id from public.profiles p where exists(select 1 from public.messages m where m.conversation_id=p_container_id
        and auth.uid() in(m.sender_id,m.recipient_id) and m.sender_id=p.id and m.deleted_at is null)
        and (v_query='' or strpos(lower(coalesce(p.full_name,'')),v_query)>0 or strpos(lower(coalesce(p.username,'')),v_query)>0)
        order by lower(coalesce(p.full_name,p.username,'')),p.id limit greatest(1,least(coalesce(p_limit,30),50))
    ) found;
  else
    if not exists(select 1 from public.chat_spaces s where s.id=p_container_id and s.kind=p_kind and public.xelay_chat_is_member(s.id)) then raise exception 'CHAT_MEMBER_REQUIRED' using errcode='42501'; end if;
    select coalesce(array_agg(found.id),'{}'::uuid[]) into v_result from (
      select p.id from public.profiles p where exists(select 1 from public.chat_posts m where m.space_id=p_container_id
        and m.sender_id=p.id and m.deleted_at is null and public.xelay_chat_can_read_post(m.id))
        and (v_query='' or strpos(lower(coalesce(p.full_name,'')),v_query)>0 or strpos(lower(coalesce(p.username,'')),v_query)>0)
        order by lower(coalesce(p.full_name,p.username,'')),p.id limit greatest(1,least(coalesce(p_limit,30),50))
    ) found;
  end if;
  return v_result;
end $$;

revoke all on function public.xelay_participant_runtime_status(),public.xelay_participant_worker_heartbeat(),public.xelay_participant_worker_disable(),
  public.xelay_schedule_direct_message(uuid,uuid,uuid,text,timestamptz,uuid),public.xelay_update_scheduled_direct_message(uuid,text,timestamptz),
  public.xelay_cancel_scheduled_direct_message(uuid),public.xelay_dispatch_scheduled_direct_messages(integer),
  public.xelay_search_conversation_messages(text,uuid,text,uuid,date,date,text,timestamptz,uuid,integer),
  public.xelay_conversation_search_authors(text,uuid,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.xelay_participant_runtime_status(),public.xelay_schedule_direct_message(uuid,uuid,uuid,text,timestamptz,uuid),
  public.xelay_update_scheduled_direct_message(uuid,text,timestamptz),public.xelay_cancel_scheduled_direct_message(uuid),
  public.xelay_search_conversation_messages(text,uuid,text,uuid,date,date,text,timestamptz,uuid,integer),
  public.xelay_conversation_search_authors(text,uuid,text,integer) to authenticated;
grant execute on function public.xelay_participant_runtime_status(),public.xelay_participant_worker_heartbeat(),public.xelay_participant_worker_disable(),public.xelay_dispatch_scheduled_direct_messages(integer) to service_role;
comment on table public.scheduled_direct_messages is 'Owner-read-only queue, authenticated RPC writes. Text only, at most 50 pending jobs per owner. Due send rechecks paid access and accepted contact; expired membership cancels. Immutable owner/conversation/message UUID. No browser timer delivery.';
comment on function public.xelay_participant_worker_heartbeat() is 'Service-only activation/health receipt: call only after all worker dispatch RPCs successfully return. New schedules require this receipt younger than five minutes.';
notify pgrst,'reload schema';


-- Source: 202610070005_participant_organizer_features.sql
-- SHA256 of source with LF newlines: 32ae8c4255c48937f00c836890ae2f9592f4b45681cd3abf50cca008940c3a46
-- Participant organizer: Kyiv calendar recurrence and deduplicated reminders.
-- Apply after 202610040001. Existing sources, tasks and sent reminders survive.
set local lock_timeout='5s';
set local statement_timeout='60s';
do $$
begin
  if to_regclass('public.organizer_tasks') is null
    or to_regclass('public.notifications') is null
    or to_regclass('public.notification_preferences') is null
    or to_regprocedure('public.xelay_prepare_organizer_task()') is null
    or to_regprocedure('public.xelay_has_participant_access(uuid)') is null
    or not exists(select 1 from pg_attribute where attrelid='public.organizer_tasks'::regclass
      and attname='source_date' and not attisdropped) then
    raise exception 'Apply organizer upgrade 202610040001 before participant organizer features';
  end if;
end;
$$;

alter table public.organizer_tasks
  add column if not exists recurrence_rule text not null default 'none',
  add column if not exists recurrence_until date,
  add column if not exists reminder_offsets_minutes integer[] not null default '{}',
  add column if not exists recurrence_anchor_at timestamptz,
  add column if not exists recurrence_anchor_date date,
  add column if not exists recurrence_series_id uuid,
  add column if not exists recurrence_index integer not null default 0,
  add column if not exists recurrence_parent_id uuid,
  add column if not exists recurrence_next_id uuid;
alter table public.organizer_tasks
  drop constraint if exists organizer_task_recurrence_check,
  drop constraint if exists organizer_task_offsets_check;
alter table public.organizer_tasks
  add constraint organizer_task_recurrence_check check (
    recurrence_rule in ('none','daily','weekly','monthly') and recurrence_index>=0
    and (recurrence_until is null or isfinite(recurrence_until))
    and (recurrence_rule='none' or ((due_at is not null or due_date is not null) and source_kind is null))),
  add constraint organizer_task_offsets_check check (
    cardinality(reminder_offsets_minutes)<=5 and array_position(reminder_offsets_minutes,null) is null
    and reminder_offsets_minutes <@ array[15,60,180,1440,10080]
    and (cardinality(reminder_offsets_minutes)=0 or due_at is not null or due_date is not null));
create unique index if not exists organizer_task_recurrence_parent_unique_idx
  on public.organizer_tasks(recurrence_parent_id) where recurrence_parent_id is not null;
grant insert(recurrence_rule,recurrence_until,reminder_offsets_minutes),
  update(recurrence_rule,recurrence_until,reminder_offsets_minutes)
  on public.organizer_tasks to authenticated;

create table if not exists public.organizer_task_reminders (
  id uuid primary key default gen_random_uuid(),
  task_id uuid not null references public.organizer_tasks(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  reminder_at timestamptz not null check(isfinite(reminder_at)),
  sent_at timestamptz,
  notification_id uuid,
  unique(task_id,reminder_at)
);
alter table public.organizer_task_reminders enable row level security;
revoke all on public.organizer_task_reminders from public,anon,authenticated;
grant select on public.organizer_task_reminders to authenticated;
drop policy if exists "Participant reads own task reminders" on public.organizer_task_reminders;
create policy "Participant reads own task reminders" on public.organizer_task_reminders
  for select to authenticated using(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()));
drop policy if exists "Task reminder owner read guard" on public.organizer_task_reminders;
create policy "Task reminder owner read guard" on public.organizer_task_reminders as restrictive
  for select to authenticated using(user_id=auth.uid() and public.xelay_has_participant_access(auth.uid()));
create index if not exists organizer_task_reminders_pending_idx
  on public.organizer_task_reminders(reminder_at,task_id) where sent_at is null;

create or replace function public.xelay_prepare_organizer_task()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_base timestamptz; v_offset integer; v_changed boolean; v_generated boolean;
begin
  if auth.uid() is not null and (new.user_id is distinct from auth.uid()
    or not public.xelay_has_participant_access(auth.uid())) then
    raise exception 'ORGANIZER_PARTICIPANT_REQUIRED' using errcode='42501';
  end if;
  v_generated := tg_op='INSERT' and new.recurrence_parent_id is not null;
  if tg_op='UPDATE' then
    if new.id is distinct from old.id or new.user_id is distinct from old.user_id
      or new.created_at is distinct from old.created_at then
      raise exception 'ORGANIZER_IDENTITY_IMMUTABLE' using errcode='42501';
    end if;
    if new.source_kind is distinct from old.source_kind or new.source_id is distinct from old.source_id
      or new.source_group_id is distinct from old.source_group_id
      or new.source_question_id is distinct from old.source_question_id
      or new.source_date is distinct from old.source_date then
      raise exception 'ORGANIZER_SOURCE_IMMUTABLE' using errcode='42501';
    end if;
    if old.completed and old.recurrence_next_id is not null and not new.completed then
      raise exception 'ORGANIZER_OCCURRENCE_FINISHED' using errcode='22023';
    end if;
  end if;
  new.subject := btrim(new.subject);
  if new.due_date is not null and (not isfinite(new.due_date) or new.due_at is not null)
    or (new.due_at is not null and not isfinite(new.due_at)) then
    raise exception 'ORGANIZER_INVALID_DEADLINE' using errcode='22023';
  end if;
  if new.recurrence_rule not in ('none','daily','weekly','monthly')
    or (new.recurrence_rule<>'none' and (new.source_kind is not null or (new.due_at is null and new.due_date is null)))
    or (new.recurrence_until is not null and (not isfinite(new.recurrence_until)
      or new.recurrence_until<coalesce(new.due_date,(new.due_at at time zone 'Europe/Kyiv')::date))) then
    raise exception 'ORGANIZER_INVALID_RECURRENCE' using errcode='22023';
  end if;
  new.reminder_offsets_minutes := array(select distinct value from unnest(new.reminder_offsets_minutes) value order by value);
  if cardinality(new.reminder_offsets_minutes)>5 or array_position(new.reminder_offsets_minutes,null) is not null
    or not new.reminder_offsets_minutes <@ array[15,60,180,1440,10080]
    or (cardinality(new.reminder_offsets_minutes)>0 and new.due_at is null and new.due_date is null) then
    raise exception 'ORGANIZER_INVALID_REMINDER' using errcode='22023';
  end if;
  v_base := coalesce(new.due_at,(new.due_date+time '18:00') at time zone 'Europe/Kyiv');
  v_changed := tg_op='INSERT';
  if tg_op='UPDATE' then
    v_changed := new.due_at is distinct from old.due_at or new.due_date is distinct from old.due_date
      or new.reminder_offsets_minutes is distinct from old.reminder_offsets_minutes;
  end if;
  if v_changed and not v_generated then
    foreach v_offset in array new.reminder_offsets_minutes loop
      if v_base-make_interval(mins=>v_offset)<=clock_timestamp() then
        raise exception 'ORGANIZER_REMINDER_IN_PAST' using errcode='22023';
      end if;
    end loop;
  end if;
  if new.reminder_at is not null then
    if not isfinite(new.reminder_at) or v_base is null then
      raise exception 'ORGANIZER_INVALID_REMINDER' using errcode='22023';
    end if;
    if (tg_op='INSERT' or new.reminder_at is distinct from old.reminder_at) and not v_generated
      and new.reminder_at<=clock_timestamp() then
      raise exception 'ORGANIZER_REMINDER_IN_PAST' using errcode='22023';
    end if;
  end if;
  -- A changed pending occurrence starts a new anchor. Future months always use
  -- that anchor (31 January -> 28 February -> 31 March, without accumulated drift).
  if tg_op='INSERT' and not v_generated then
    new.recurrence_anchor_at := new.due_at; new.recurrence_anchor_date := new.due_date;
    new.recurrence_series_id := new.id; new.recurrence_index := 0;
  elsif tg_op='UPDATE' and (new.due_at is distinct from old.due_at
    or new.due_date is distinct from old.due_date or new.recurrence_rule is distinct from old.recurrence_rule) then
    new.recurrence_anchor_at := new.due_at; new.recurrence_anchor_date := new.due_date;
    new.recurrence_series_id := new.id; new.recurrence_index := 0;
  end if;
  new.due_sort_at := coalesce(new.due_at,(new.due_date+time '23:59:59') at time zone 'Europe/Kyiv');
  if tg_op='INSERT' then
    new.created_at := clock_timestamp(); new.reminder_sent_at := null;
  elsif new.reminder_at is distinct from old.reminder_at or v_changed or new.completed is distinct from old.completed then
    new.reminder_sent_at := null;
  end if;
  if tg_op='INSERT' or new.title is distinct from old.title or new.notes is distinct from old.notes
    or new.subject is distinct from old.subject or new.due_at is distinct from old.due_at
    or new.due_date is distinct from old.due_date or new.reminder_at is distinct from old.reminder_at
    or new.completed is distinct from old.completed or new.recurrence_rule is distinct from old.recurrence_rule
    or new.recurrence_until is distinct from old.recurrence_until
    or new.reminder_offsets_minutes is distinct from old.reminder_offsets_minutes then
    new.updated_at := clock_timestamp();
  else new.updated_at := old.updated_at;
  end if;
  return new;
end;
$$;

create or replace function public.xelay_private_organizer_after_change()
returns trigger language plpgsql security definer set search_path=public,pg_temp
as $$
declare v_base timestamptz; v_desired timestamptz[]; v_next_at timestamptz; v_next_date date;
  v_anchor timestamp; v_next_base timestamptz; v_index integer; v_next_id uuid; v_reminder timestamptz;
begin
  v_base := coalesce(new.due_at,(new.due_date+time '18:00') at time zone 'Europe/Kyiv');
  v_desired := array(select distinct value from (
    select new.reminder_at value where new.reminder_at is not null
    union select v_base-make_interval(mins=>value) from unnest(new.reminder_offsets_minutes) value
  ) reminders where value is not null);
  if new.completed then
    delete from public.organizer_task_reminders where task_id=new.id and sent_at is null;
  else
    delete from public.organizer_task_reminders where task_id=new.id and sent_at is null
      and not reminder_at=any(v_desired);
    foreach v_reminder in array v_desired loop
      -- Existing overdue queue entries remain above when still desired. Never
      -- recreate an elapsed offset omitted from an automatically generated
      -- occurrence just because its notes or delivery receipt changed later.
      if v_reminder>clock_timestamp() then
        insert into public.organizer_task_reminders(task_id,user_id,reminder_at)
          values(new.id,new.user_id,v_reminder) on conflict(task_id,reminder_at) do nothing;
      end if;
    end loop;
  end if;
  if tg_op<>'UPDATE' or not new.completed or old.completed or new.recurrence_rule='none'
    or new.recurrence_next_id is not null then return null; end if;
  v_anchor := coalesce(new.recurrence_anchor_at at time zone 'Europe/Kyiv',new.recurrence_anchor_date+time '18:00');
  v_index := new.recurrence_index+1;
  if new.recurrence_rule in ('daily','weekly') then
    v_index := greatest(v_index, floor(((clock_timestamp() at time zone 'Europe/Kyiv')::date-v_anchor::date)::numeric
      /case new.recurrence_rule when 'weekly' then 7 else 1 end)::integer);
  else
    v_index := greatest(v_index, (extract(year from clock_timestamp() at time zone 'Europe/Kyiv')::integer
      -extract(year from v_anchor)::integer)*12+extract(month from clock_timestamp() at time zone 'Europe/Kyiv')::integer
      -extract(month from v_anchor)::integer);
  end if;
  loop
    if new.recurrence_rule='monthly' then
      v_next_base := (v_anchor+make_interval(months=>v_index)) at time zone 'Europe/Kyiv';
    else
      v_next_base := (v_anchor+make_interval(days=>v_index*case new.recurrence_rule when 'weekly' then 7 else 1 end)) at time zone 'Europe/Kyiv';
    end if;
    exit when v_next_base>clock_timestamp();
    v_index := v_index+1;
  end loop;
  v_next_date := (v_next_base at time zone 'Europe/Kyiv')::date;
  if new.recurrence_until is not null and v_next_date>new.recurrence_until then return null; end if;
  v_next_at := case when new.due_at is not null then v_next_base else null end;
  v_reminder := case when new.reminder_at is not null then v_next_base-(v_base-new.reminder_at) else null end;
  -- Sent custom reminders remain relative to the deadline; if the next reminder
  -- has already passed, omit it rather than generating a retrospective push.
  if v_reminder<=clock_timestamp() then v_reminder := null; end if;
  insert into public.organizer_tasks(user_id,title,notes,subject,due_at,due_date,reminder_at,
    recurrence_rule,recurrence_until,reminder_offsets_minutes,recurrence_anchor_at,recurrence_anchor_date,
    recurrence_series_id,recurrence_index,recurrence_parent_id)
    values(new.user_id,new.title,new.notes,new.subject,v_next_at,
      case when v_next_at is null then v_next_date else null end,v_reminder,
      new.recurrence_rule,new.recurrence_until,new.reminder_offsets_minutes,new.recurrence_anchor_at,new.recurrence_anchor_date,
      new.recurrence_series_id,v_index,new.id)
    on conflict(recurrence_parent_id) where recurrence_parent_id is not null do nothing returning id into v_next_id;
  if v_next_id is null then select id into v_next_id from public.organizer_tasks where recurrence_parent_id=new.id; end if;
  update public.organizer_tasks set recurrence_next_id=v_next_id where id=new.id;
  return null;
end;
$$;
drop trigger if exists organizer_task_feature_after_change on public.organizer_tasks;
create trigger organizer_task_feature_after_change after insert or update on public.organizer_tasks
  for each row execute function public.xelay_private_organizer_after_change();

-- Retain delivery markers from the old single-reminder implementation.
insert into public.organizer_task_reminders(task_id,user_id,reminder_at,sent_at)
  select id,user_id,reminder_at,reminder_sent_at from public.organizer_tasks
  where reminder_at is not null and (not completed or reminder_sent_at is not null)
  on conflict(task_id,reminder_at) do nothing;

create or replace function public.xelay_private_dispatch_organizer_reminders(p_user_id uuid,p_limit integer)
returns integer language plpgsql volatile security definer set search_path=public,pg_temp
as $$
declare v_task public.organizer_tasks%rowtype; v_reminder public.organizer_task_reminders%rowtype;
  v_count integer := 0; v_notification uuid; v_enabled boolean;
begin
  -- All paths lock the task before its reminder rows. This also serializes with
  -- task edits/completion, and SKIP LOCKED allows parallel foreground/cron jobs.
  for v_task in select t.* from public.organizer_tasks t
    where not t.completed and (p_user_id is null or t.user_id=p_user_id)
      and exists(select 1 from public.organizer_task_reminders r where r.task_id=t.id and r.sent_at is null and r.reminder_at<=clock_timestamp())
      and public.xelay_has_participant_access(t.user_id)
      and not exists(select 1 from public.notification_preferences pref
        where pref.user_id=t.user_id and pref.notifications_enabled is false)
    order by t.id limit p_limit for update of t skip locked
  loop
    select notifications_enabled into v_enabled from public.notification_preferences where user_id=v_task.user_id;
    if not coalesce(v_enabled,true) then continue; end if;
    for v_reminder in select * from public.organizer_task_reminders where task_id=v_task.id
      and sent_at is null and reminder_at<=clock_timestamp() order by reminder_at,id
      limit greatest(p_limit-v_count,0) for update skip locked
    loop
      insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,organizer_task_id)
        values(v_task.user_id,v_task.user_id,'Органайзер','organizer_reminder','Нагадування: ' || v_task.title,false,v_task.id)
        returning id into v_notification;
      update public.organizer_task_reminders set sent_at=clock_timestamp(),notification_id=v_notification where id=v_reminder.id;
      -- Trigger keeps content version stable, and the reminder receipt remains
      -- compatible with older clients; queue rows are the authoritative dedup.
      if v_task.reminder_at=v_reminder.reminder_at then
        update public.organizer_tasks set reminder_sent_at=clock_timestamp() where id=v_task.id;
      end if;
      v_count := v_count+1;
    end loop;
    exit when v_count>=p_limit;
  end loop;
  return v_count;
end;
$$;
create or replace function public.xelay_deliver_organizer_reminders()
returns integer language plpgsql volatile security definer set search_path=public,pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'ORGANIZER_AUTH_REQUIRED' using errcode='42501'; end if;
  if not public.xelay_has_participant_access(auth.uid()) then return 0; end if;
  return public.xelay_private_dispatch_organizer_reminders(auth.uid(),100);
end;
$$;
create or replace function public.xelay_dispatch_organizer_reminders(p_limit integer default 20)
returns integer language plpgsql volatile security definer set search_path=public,pg_temp
as $$
begin
  if p_limit is null or p_limit<1 or p_limit>100 then raise exception 'ORGANIZER_INVALID_LIMIT' using errcode='22023'; end if;
  return public.xelay_private_dispatch_organizer_reminders(null,p_limit);
end;
$$;
revoke all on function public.xelay_prepare_organizer_task(),public.xelay_private_organizer_after_change(),
  public.xelay_private_dispatch_organizer_reminders(uuid,integer),public.xelay_dispatch_organizer_reminders(integer),
  public.xelay_deliver_organizer_reminders() from public,anon,authenticated,service_role;
grant execute on function public.xelay_dispatch_organizer_reminders(integer) to service_role;
grant execute on function public.xelay_deliver_organizer_reminders() to authenticated;
comment on function public.xelay_dispatch_organizer_reminders(integer) is
  'Service-only cron entry point. Inserts at most p_limit due organizer_reminder notifications, atomically deduplicated with foreground delivery. Rechecks participant access and general notification preferences. Push delivery is handled by the separate notification push queue.';
comment on column public.organizer_tasks.recurrence_rule is
  'Personal unlinked tasks only. Completing an occurrence creates at most one next future occurrence, using a Kyiv calendar anchor. Missed occurrences are skipped; source assignment snapshots never repeat.';
notify pgrst,'reload schema';


-- Source: 202610070006_participant_limits.sql
-- SHA256 of source with LF newlines: 4ca228eab59273b4062dcb7916ef0bbebf68bfdcd8db2dbe130fe2f529305dc6
-- Participant expansion: 3 people searches/day, 3 new contact requests/week.
-- Accepted contacts and study-group classmates remain free. No historic quotas
-- are charged. Apply the complete file in a fresh SQL Editor tab.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
declare v_name text;
begin
  foreach v_name in array array['profiles','connection_requests','conversations',
    'study_groups','study_group_members','user_search_usage','user_search_sessions',
    'participant_entitlements','premium_preferences'] loop
    if to_regclass('public.' || v_name) is null then
      raise exception 'Apply existing connection, study-group, billing and live-search migrations first: missing %',v_name;
    end if;
  end loop;
  if to_regprocedure('public.xelay_has_participant_access(uuid)') is null
    or to_regprocedure('public.xelay_billing_status()') is null
    or not exists(select 1 from information_schema.columns
      where table_schema='public' and table_name='premium_preferences' and column_name='status_text') then
    raise exception 'Apply existing participant billing and participant-status migrations first';
  end if;
end $$;

-- Private counter survives request rejection/removal. Only successful INSERTs
-- increment it, in the same transaction as the request and notification.
create table if not exists public.connection_request_weekly_usage (
  user_id uuid not null references public.profiles(id) on delete cascade,
  week_start date not null,
  used integer not null default 0 check(used >= 0),
  primary key(user_id,week_start),
  constraint connection_request_week_is_monday check(extract(isodow from week_start)=1)
);
alter table public.connection_request_weekly_usage enable row level security;
revoke all on public.connection_request_weekly_usage from public,anon,authenticated,service_role;
create index if not exists connection_requests_requester_created_idx
  on public.connection_requests(requester_id,created_at);
alter table public.connection_requests enable row level security;

create or replace function public.xelay_private_share_study_group(p_first uuid,p_second uuid)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select p_first is not null and p_second is not null and p_first<>p_second
    and exists(with candidates as (
      select id from public.study_groups where representative_id=p_first
      union select group_id from public.study_group_members where user_id=p_first and status='accepted'
    ) select 1 from candidates c join public.study_groups g on g.id=c.id
      where g.representative_id=p_second or exists(select 1 from public.study_group_members m
        where m.group_id=g.id and m.user_id=p_second and m.status='accepted'));
$$;
revoke all on function public.xelay_private_share_study_group(uuid,uuid)
  from public,anon,authenticated,service_role;

create or replace function public.xelay_connection_request_status(p_recipient_id uuid default null)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare
  v_owner uuid:=auth.uid();
  v_week date:=date_trunc('week',now() at time zone 'Europe/Kyiv')::date;
  v_used integer;
  v_premium boolean;
begin
  if v_owner is null then raise exception 'Authentication required' using errcode='42501'; end if;
  v_premium:=public.xelay_has_participant_access(v_owner);
  select used into v_used from public.connection_request_weekly_usage where user_id=v_owner and week_start=v_week;
  v_used:=coalesce(v_used,0);
  return jsonb_build_object('limit',3,'used',v_used,
    'remaining',case when v_premium then null else greatest(3-v_used,0) end,
    'unlimited',v_premium,'recipient_exempt',public.xelay_private_share_study_group(v_owner,p_recipient_id),
    'resets_at',(v_week+7)::timestamp at time zone 'Europe/Kyiv');
end $$;

create or replace function public.xelay_guard_participant_connection_limits()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_used integer; v_week date; v_premium boolean;
begin
  if tg_op='UPDATE' then
    -- Receiving/accepting a request never consumes quota. Identity and dates
    -- cannot be rewritten to move old requests out of the abuse windows.
    if new.id is distinct from old.id or new.requester_id is distinct from old.requester_id
      or new.recipient_id is distinct from old.recipient_id then
      raise exception 'CONNECTION_REQUEST_INVALID' using errcode='42501';
    end if;
    new.created_at:=old.created_at;
    if new.status is distinct from old.status then
      if auth.uid() is distinct from old.recipient_id or old.status<>'pending'
        or new.status not in('accepted','rejected') then
        raise exception 'CONNECTION_REQUEST_INVALID' using errcode='42501';
      end if;
      new.updated_at:=clock_timestamp();
    else new.updated_at:=old.updated_at;
    end if;
    return new;
  end if;
  if auth.uid() is null or new.requester_id is distinct from auth.uid()
    or new.recipient_id is null or new.recipient_id=new.requester_id or new.status<>'pending' then
    raise exception 'CONNECTION_REQUEST_INVALID' using errcode='42501';
  end if;
  -- Same lock order as the existing chat-security trigger. This also guards
  -- direct-table INSERTs, which cannot bypass the RPC weekly counter.
  perform pg_advisory_xact_lock(hashtextextended('xelay-connection-pair:' || least(new.requester_id,new.recipient_id)::text
    || ':' || greatest(new.requester_id,new.recipient_id)::text,0));
  perform pg_advisory_xact_lock(hashtextextended('xelay-connection-send:' || new.requester_id::text,0));
  new.created_at:=clock_timestamp(); new.updated_at:=new.created_at;
  if exists(select 1 from public.connection_requests r
    where r.status in('pending','accepted')
      and least(r.requester_id,r.recipient_id)=least(new.requester_id,new.recipient_id)
      and greatest(r.requester_id,r.recipient_id)=greatest(new.requester_id,new.recipient_id)) then
    raise unique_violation using constraint='connection_requests_active_pair_unique';
  end if;
  if (select count(*) from public.connection_requests where requester_id=new.requester_id
      and created_at>new.created_at-interval '10 minutes')>=10
    or (select count(*) from public.connection_requests where requester_id=new.requester_id
      and created_at>new.created_at-interval '1 day')>=30
    or exists(select 1 from public.connection_requests where requester_id=new.requester_id
      and recipient_id=new.recipient_id and status='rejected' and updated_at>new.created_at-interval '1 day') then
    raise exception 'CONNECTION_REQUEST_RATE_LIMIT' using errcode='P0001';
  end if;
  if not public.xelay_private_share_study_group(new.requester_id,new.recipient_id) then
    v_week:=date_trunc('week',new.created_at at time zone 'Europe/Kyiv')::date;
    v_premium:=public.xelay_has_participant_access(new.requester_id);
    insert into public.connection_request_weekly_usage(user_id,week_start,used)
    values(new.requester_id,v_week,1)
    on conflict(user_id,week_start) do update set used=connection_request_weekly_usage.used+1
      where v_premium or connection_request_weekly_usage.used<3 returning used into v_used;
    if v_used is null then raise exception 'CONNECTION_REQUEST_WEEKLY_LIMIT' using errcode='P0001'; end if;
  end if;
  return new;
end $$;
drop trigger if exists xelay_guard_participant_connection_limits on public.connection_requests;
create trigger xelay_guard_participant_connection_limits before insert or update on public.connection_requests
  for each row execute function public.xelay_guard_participant_connection_limits();
revoke all on function public.xelay_guard_participant_connection_limits() from public,anon,authenticated,service_role;

create or replace function public.send_connection_request(p_recipient_id uuid)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_owner uuid:=auth.uid(); v_request_id uuid;
begin
  if v_owner is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_recipient_id is null or p_recipient_id=v_owner then
    raise exception 'CONNECTION_REQUEST_INVALID' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-connection-pair:' || least(v_owner,p_recipient_id)::text
    || ':' || greatest(v_owner,p_recipient_id)::text,0));
  select id into v_request_id from public.connection_requests
  where status in('pending','accepted') and least(requester_id,recipient_id)=least(v_owner,p_recipient_id)
    and greatest(requester_id,recipient_id)=greatest(v_owner,p_recipient_id)
  order by created_at desc limit 1;
  if v_request_id is not null then return v_request_id; end if;
  -- A client retry of an existing connection returns before any counters.
  -- FK, trigger, notification or INSERT errors roll back the counter too.
  insert into public.connection_requests(requester_id,recipient_id)
    values(v_owner,p_recipient_id) returning id into v_request_id;
  return v_request_id;
exception when unique_violation then
  select id into v_request_id from public.connection_requests
  where status in('pending','accepted') and least(requester_id,recipient_id)=least(v_owner,p_recipient_id)
    and greatest(requester_id,recipient_id)=greatest(v_owner,p_recipient_id)
  order by created_at desc limit 1;
  if v_request_id is null then raise; end if;
  return v_request_id;
end $$;

comment on table public.connection_request_weekly_usage is
  'Successful non-classmate contact requests per Kyiv Monday week. Replays/errors do not charge. Premium bypasses weekly limit but remains subject to abuse limits; accepted chats and received requests remain free.';

-- Existing billing-status fields are retained, including gap-safe coverage.
create or replace function public.xelay_billing_status()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_premium boolean; v_used integer; v_expiry timestamptz; v_emoji text; v_text text; v_contacts jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  v_premium:=public.xelay_has_participant_access(auth.uid());
  select used into v_used from public.user_search_usage where user_id=auth.uid()
    and usage_date=(now() at time zone 'Europe/Kyiv')::date;
  v_used:=coalesce(v_used,0);
  if v_premium then
    with recursive coverage(until_at) as (
      select max(valid_until) from public.participant_entitlements where user_id=auth.uid()
        and revoked_at is null and valid_from<=now() and valid_until>now()
      union
      select e.valid_until from coverage c join public.participant_entitlements e
        on e.user_id=auth.uid() and e.revoked_at is null
          and e.valid_from<=c.until_at and e.valid_until>c.until_at
    ) select max(until_at) into v_expiry from coverage;
    select emoji_status,status_text into v_emoji,v_text from public.premium_preferences where user_id=auth.uid();
  end if;
  v_contacts:=public.xelay_connection_request_status(null);
  return jsonb_build_object('is_premium',v_premium,'expires_at',v_expiry,'emoji_status',v_emoji,'status_text',v_text,
    'search_used',v_used,'search_remaining',case when v_premium then null else greatest(3-v_used,0) end,
    'search_limit',3,'search_unlimited',v_premium,
    'connection_used',v_contacts->'used','connection_remaining',v_contacts->'remaining',
    'connection_limit',3,'connection_unlimited',v_premium,'connection_resets_at',v_contacts->'resets_at');
end $$;

-- Search definitions below preserve the existing ten-minute live refinement
-- window; reducing the counter never turns every keystroke into a new search.
create or replace function public.xelay_search_users(p_query text)
returns jsonb language plpgsql security definer set search_path = public,pg_temp
as $$
declare v_query text; v_pattern text; v_premium boolean; v_used integer; v_profiles jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  v_query := lower(regexp_replace(btrim(p_query),'^@+',''));
  if v_query is null or length(v_query)<2 or length(v_query)>30 or v_query !~ '^[[:alnum:]_.-]+$' then raise exception 'INVALID_SEARCH_QUERY'; end if;
  v_premium := public.xelay_has_participant_access(auth.uid());
  perform pg_advisory_xact_lock(hashtextextended(auth.uid()::text,202609300005));
  if v_premium then
    select used into v_used from public.user_search_usage where user_id=auth.uid()
      and usage_date=(now() at time zone 'Europe/Kyiv')::date;
    v_used:=coalesce(v_used,0);
  else
    insert into public.user_search_usage(user_id,usage_date,used) values(auth.uid(),(now() at time zone 'Europe/Kyiv')::date,1)
      on conflict(user_id,usage_date) do update set used=user_search_usage.used+1
      where user_search_usage.used<3 returning used into v_used;
    if v_used is null then
      select used into v_used from public.user_search_usage where user_id=auth.uid()
        and usage_date=(now() at time zone 'Europe/Kyiv')::date;
      return jsonb_build_object('profiles','[]'::jsonb,'used',coalesce(v_used,3),'remaining',0,'limit',3,'unlimited',false,'limit_reached',true);
    end if;
  end if;
  v_pattern := '%' || replace(replace(replace(v_query,E'\\',E'\\\\'),'%',E'\\%'),'_',E'\\_') || '%';
  select coalesce(jsonb_agg(to_jsonb(p)),'[]'::jsonb) into v_profiles from (
    select profiles.id,username,full_name,avatar_url,faculty,specialty,study_year,
      public.xelay_has_participant_access(profiles.id) as is_premium,
      case when public.xelay_has_participant_access(profiles.id) then pref.emoji_status else null end as emoji_status,
      case when public.xelay_has_participant_access(profiles.id) then pref.status_text else null end as status_text
    from public.profiles
    left join public.premium_preferences pref on pref.user_id=profiles.id
    where profiles.id<>auth.uid() and username ilike v_pattern escape E'\\' order by username limit 30
  ) p;
  return jsonb_build_object('profiles',v_profiles,'used',v_used,'remaining',case when v_premium then null else greatest(3-v_used,0) end,'limit',3,'unlimited',v_premium);
end;
$$;

-- Preserve the ten-minute search window and its atomic usage counter.
create or replace function public.xelay_search_users_live(p_query text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_user_id uuid := auth.uid();
  v_now timestamptz := now();
  v_day date := (now() at time zone 'Europe/Kyiv')::date;
  v_query text;
  v_prefix text;
  v_premium boolean;
  v_used integer;
  v_session_expires_at timestamptz;
  v_profiles jsonb;
  v_has_more boolean;
begin
  if v_user_id is null then
    raise exception 'Authentication required' using errcode = '42501';
  end if;

  v_query := lower(regexp_replace(btrim(p_query), '^@+', ''));
  if v_query is null or char_length(v_query) < 2 or char_length(v_query) > 30
    or v_query !~ '^[[:alnum:]_.-]+$' then
    raise exception 'INVALID_SEARCH_QUERY' using errcode = '22023';
  end if;
  v_prefix := left(v_query, 2);

  -- Serialize session creation per account. The shared usage row also keeps
  -- its atomic increment so calls to the legacy RPC cannot overspend quota.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(v_user_id::text, 202609300005)
  );

  -- Only this account's expired windows are removed, at most twenty per call.
  -- Active windows are never extended by typing or by a repeated request.
  delete from public.user_search_sessions s
  using (
    select usage_date, query_prefix
    from public.user_search_sessions
    where user_id = v_user_id and expires_at <= v_now
    order by expires_at, usage_date, query_prefix
    limit 20
  ) expired
  where s.user_id = v_user_id
    and s.usage_date = expired.usage_date
    and s.query_prefix = expired.query_prefix;

  -- Entitlements are checked for every request. Premium requests create no
  -- free search windows and do not consume the three ordinary daily searches.
  v_premium := public.xelay_has_participant_access(v_user_id);
  if not v_premium then
    select s.expires_at into v_session_expires_at
    from public.user_search_sessions s
    where s.user_id = v_user_id and s.usage_date = v_day
      and s.query_prefix = v_prefix and s.expires_at > v_now;

    if v_session_expires_at is null then
      insert into public.user_search_usage (user_id, usage_date, used)
      values (v_user_id, v_day, 1)
      on conflict (user_id, usage_date) do update
        set used = user_search_usage.used + 1
        where user_search_usage.used < 3
      returning used into v_used;

      if v_used is null then
        select used into v_used from public.user_search_usage
        where user_id = v_user_id and usage_date = v_day;
        return jsonb_build_object(
          'profiles', '[]'::jsonb, 'has_more', false,
          'used', coalesce(v_used, 3), 'remaining', 0, 'limit', 3,
          'unlimited', false, 'limit_reached', true,
          'session_expires_at', null
        );
      end if;

      v_session_expires_at := v_now + interval '10 minutes';
      insert into public.user_search_sessions (
        user_id, usage_date, query_prefix, created_at, expires_at
      ) values (v_user_id, v_day, v_prefix, v_now, v_session_expires_at)
      on conflict (user_id, usage_date, query_prefix) do update
        set created_at = excluded.created_at, expires_at = excluded.expires_at;
    end if;
  end if;

  select used into v_used from public.user_search_usage
  where user_id = v_user_id and usage_date = v_day;
  v_used := coalesce(v_used, 0);

  -- strpos and left compare literal characters, including an underscore.
  -- Exact handles lead, then handles starting with the query, then substring
  -- matches. Fetch one extra result to report truncation accurately.
  with matches as materialized (
    select p.id, p.username, p.full_name, p.avatar_url,
      p.faculty, p.specialty, p.study_year,
      case
        when lower(p.username) = v_query then 0
        when left(lower(p.username), char_length(v_query)) = v_query then 1
        else 2
      end as match_rank
    from public.profiles p
    where p.id <> v_user_id and strpos(lower(p.username), v_query) > 0
    order by match_rank, char_length(p.username), lower(p.username), p.id
    limit 31
  ), ranked as (
    select m.*, row_number() over (
      order by m.match_rank, char_length(m.username), lower(m.username), m.id
    ) as result_position
    from matches m
  )
  select coalesce(jsonb_agg(jsonb_build_object(
      'id', p.id, 'username', p.username, 'full_name', p.full_name,
      'avatar_url', p.avatar_url, 'faculty', p.faculty,
      'specialty', p.specialty, 'study_year', p.study_year,
      'is_premium', public.xelay_has_participant_access(p.id),
      'emoji_status', case when public.xelay_has_participant_access(p.id)
        then pref.emoji_status else null end,
      'status_text', case when public.xelay_has_participant_access(p.id)
        then pref.status_text else null end
    ) order by p.result_position), '[]'::jsonb),
    (select count(*) > 30 from matches)
  into v_profiles, v_has_more
  from ranked p
  left join public.premium_preferences pref on pref.user_id = p.id
  where p.result_position <= 30;

  return jsonb_build_object(
    'profiles', v_profiles, 'has_more', v_has_more,
    'used', v_used,
    'remaining', case when v_premium then null else greatest(3 - v_used, 0) end,
    'limit', 3, 'unlimited', v_premium, 'limit_reached', false,
    'session_expires_at', v_session_expires_at
  );
end;
$$;


revoke all on function public.xelay_connection_request_status(uuid),public.send_connection_request(uuid),
  public.xelay_billing_status(),public.xelay_search_users(text),public.xelay_search_users_live(text)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_connection_request_status(uuid),public.send_connection_request(uuid),
  public.xelay_billing_status(),public.xelay_search_users(text),public.xelay_search_users_live(text) to authenticated;
notify pgrst, 'reload schema';


-- Source: 202610070007_participant_appearance_push.sql
-- SHA256 of source with LF newlines: efe4181eaac300bcf25ec7de1f0e796cb753f2441b063b7f195007beb9ae043f
-- Participant appearance and opt-in browser push for personal organizer reminders.
-- Run this whole file in a fresh SQL tab after 202610070004/005/006.
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $$
begin
  if to_regprocedure('public.xelay_has_participant_access(uuid)') is null
    or to_regprocedure('public.xelay_participant_runtime_status()') is null
    or to_regprocedure('public.xelay_dispatch_organizer_reminders(integer)') is null
    or to_regclass('public.notification_preferences') is null
    or not exists(select 1 from information_schema.columns where table_schema='public' and table_name='notifications' and column_name='organizer_task_id') then
    raise exception 'Apply participant direct and organizer migrations 202610070004 and 202610070005 before appearance/push';
  end if;
end;
$$;

create table if not exists public.participant_appearance_preferences (
  user_id uuid primary key references auth.users(id) on delete cascade,
  profile_cover text not null default 'default' check(profile_cover in ('default','rose','ocean','forest','lavender','sunrise')),
  chat_theme text not null default 'default' check(chat_theme in ('default','rose','ocean','forest','lavender')),
  chat_wallpaper text not null default 'default' check(chat_wallpaper in ('default','dots','grid','waves')),
  updated_at timestamptz not null default now()
);
alter table public.participant_appearance_preferences enable row level security;
revoke all on public.participant_appearance_preferences from public,anon,authenticated;
grant select on public.participant_appearance_preferences to authenticated;
grant all on public.participant_appearance_preferences to service_role;
drop policy if exists "Own participant appearance" on public.participant_appearance_preferences;
create policy "Own participant appearance" on public.participant_appearance_preferences
  for select to authenticated using(user_id=auth.uid());

create or replace function public.xelay_get_participant_appearance()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb;
begin
  if auth.uid() is null then raise exception 'PARTICIPANT_AUTH_REQUIRED' using errcode='42501'; end if;
  if public.xelay_has_participant_access(auth.uid()) then
    select jsonb_build_object('profile_cover',profile_cover,'chat_theme',chat_theme,'chat_wallpaper',chat_wallpaper)
      into v_result from public.participant_appearance_preferences where user_id=auth.uid();
  end if;
  return coalesce(v_result,jsonb_build_object('profile_cover','default','chat_theme','default','chat_wallpaper','default'));
end;
$$;

create or replace function public.xelay_set_participant_appearance(p_cover text,p_theme text,p_wallpaper text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if auth.uid() is null or not public.xelay_has_participant_access(auth.uid()) then
    raise exception 'PARTICIPANT_REQUIRED' using errcode='42501';
  end if;
  if p_cover is null or p_cover not in ('default','rose','ocean','forest','lavender','sunrise')
    or p_theme is null or p_theme not in ('default','rose','ocean','forest','lavender')
    or p_wallpaper is null or p_wallpaper not in ('default','dots','grid','waves') then
    raise exception 'PARTICIPANT_APPEARANCE_INVALID' using errcode='22023';
  end if;
  insert into public.participant_appearance_preferences(user_id,profile_cover,chat_theme,chat_wallpaper)
    values(auth.uid(),p_cover,p_theme,p_wallpaper)
    on conflict(user_id) do update set profile_cover=excluded.profile_cover,chat_theme=excluded.chat_theme,
      chat_wallpaper=excluded.chat_wallpaper,updated_at=now();
  return public.xelay_get_participant_appearance();
end;
$$;

create or replace function public.xelay_public_appearance(p_user_ids uuid[])
returns jsonb language plpgsql stable security definer set search_path='' as $$
begin
  if p_user_ids is null or cardinality(p_user_ids)>100 then raise exception 'PARTICIPANT_APPEARANCE_INVALID' using errcode='22023'; end if;
  -- Only a predefined decorative cover is public. Private chat preferences never leave the owner scope.
  return coalesce((select jsonb_agg(jsonb_build_object('user_id',p.id,'profile_cover',
    case when public.xelay_has_participant_access(p.id) then coalesce(a.profile_cover,'default') else 'default' end))
    from public.profiles p left join public.participant_appearance_preferences a on a.user_id=p.id
    where p.id=any(p_user_ids)),'[]'::jsonb);
end;
$$;

create table if not exists public.participant_push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  endpoint text not null unique check(length(endpoint) between 20 and 2048),
  p256dh text not null check(length(p256dh) between 80 and 100),
  auth_key text not null check(length(auth_key) between 20 and 30),
  device_label text not null default '' check(length(device_label)<=120),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.participant_push_subscriptions enable row level security;
revoke all on public.participant_push_subscriptions from public,anon,authenticated;
grant all on public.participant_push_subscriptions to service_role;
create index if not exists participant_push_owner_idx on public.participant_push_subscriptions(user_id) where enabled;

create table if not exists public.participant_push_outbox (
  id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references public.participant_push_subscriptions(id) on delete cascade,
  notification_id uuid not null references public.notifications(id) on delete cascade,
  status text not null default 'pending' check(status in ('pending','processing','sent','skipped','failed')),
  attempts integer not null default 0 check(attempts between 0 and 5),
  next_attempt_at timestamptz not null default now(),
  lease_until timestamptz,
  lease_token uuid,
  delivered_at timestamptz,
  created_at timestamptz not null default now(),
  unique(subscription_id,notification_id)
);
alter table public.participant_push_outbox enable row level security;
revoke all on public.participant_push_outbox from public,anon,authenticated;
grant all on public.participant_push_outbox to service_role;
create index if not exists participant_push_pending_idx on public.participant_push_outbox(next_attempt_at,id) where status in ('pending','processing');

create or replace function public.xelay_register_participant_push(p_user_id uuid,p_endpoint text,p_p256dh text,p_auth text,p_label text default '')
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'PUSH_WORKER_REQUIRED' using errcode='42501'; end if;
  if p_user_id is null or not public.xelay_has_participant_access(p_user_id) then raise exception 'PARTICIPANT_REQUIRED' using errcode='42501'; end if;
  if p_endpoint is null or length(p_endpoint)>2048
    or p_endpoint !~ '^https://(fcm[.]googleapis[.]com|updates[.]push[.]services[.]mozilla[.]com|([a-zA-Z0-9-]+[.])*push[.]apple[.]com|([a-zA-Z0-9-]+[.])+notify[.]windows[.]com)/'
    or p_p256dh is null or p_p256dh !~ '^[A-Za-z0-9_-]{87}=?$'
    or p_auth is null or p_auth !~ '^[A-Za-z0-9_-]{22}(==)?$' then
    raise exception 'PUSH_SUBSCRIPTION_INVALID' using errcode='22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:push-owner:'||p_user_id::text,0));
  if exists(select 1 from public.participant_push_subscriptions where endpoint=p_endpoint and user_id<>p_user_id) then
    raise exception 'PUSH_DEVICE_OTHER_ACCOUNT' using errcode='42501';
  end if;
  if (select count(*) from public.participant_push_subscriptions where user_id=p_user_id)>=8
    and not exists(select 1 from public.participant_push_subscriptions where user_id=p_user_id and endpoint=p_endpoint) then
    raise exception 'PUSH_DEVICE_LIMIT' using errcode='22023';
  end if;
  insert into public.participant_push_subscriptions(user_id,endpoint,p256dh,auth_key,device_label)
    values(p_user_id,p_endpoint,p_p256dh,p_auth,left(coalesce(p_label,''),120))
    on conflict(endpoint) do update set p256dh=excluded.p256dh,auth_key=excluded.auth_key,device_label=excluded.device_label,
      enabled=true,updated_at=now() where participant_push_subscriptions.user_id=p_user_id
    returning id into v_id;
  if v_id is null then raise exception 'PUSH_DEVICE_OTHER_ACCOUNT' using errcode='42501'; end if;
  return v_id;
end;
$$;

create or replace function public.xelay_queue_participant_push()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.type is distinct from 'organizer_reminder' or new.organizer_task_id is null or new.is_read
    or not public.xelay_has_participant_access(new.recipient_id::uuid)
    or not coalesce((select notifications_enabled from public.notification_preferences where user_id::text=new.recipient_id::text),true) then return new; end if;
  insert into public.participant_push_outbox(subscription_id,notification_id)
    select id,new.id from public.participant_push_subscriptions where user_id::text=new.recipient_id::text and enabled
    on conflict(subscription_id,notification_id) do nothing;
  return new;
end;
$$;
drop trigger if exists xelay_participant_push_queue on public.notifications;
create trigger xelay_participant_push_queue after insert on public.notifications for each row execute function public.xelay_queue_participant_push();

create or replace function public.xelay_claim_participant_push(p_limit integer default 20)
returns table(job_id uuid,lock_token uuid,subscription_id uuid,user_id uuid,notification_id uuid,endpoint text,p256dh text,auth_key text)
language plpgsql security definer set search_path='' as $$
declare v_job record; v_token uuid; v_sub public.participant_push_subscriptions%rowtype; v_notification public.notifications%rowtype; v_returned integer:=0;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'PUSH_WORKER_REQUIRED' using errcode='42501'; end if;
  update public.participant_push_outbox o set status='failed',lease_token=null,lease_until=null where o.id in
    (select q.id from public.participant_push_outbox q where q.status='processing' and q.attempts>=5
      and q.lease_until<now() order by q.lease_until limit 50 for update skip locked);
  delete from public.participant_push_outbox o where o.id in
    (select q.id from public.participant_push_outbox q where q.status in ('sent','skipped','failed')
      and q.created_at<now()-interval '7 days' order by q.created_at limit 100 for update skip locked);
  for v_job in select o.* from public.participant_push_outbox o where o.attempts<5
    and ((o.status='pending' and o.next_attempt_at<=now()) or (o.status='processing' and o.lease_until<now()))
    order by o.next_attempt_at,o.id limit 50 for update skip locked
  loop
    select * into v_sub from public.participant_push_subscriptions s where s.id=v_job.subscription_id;
    select * into v_notification from public.notifications n where n.id=v_job.notification_id;
    if not found or v_sub.id is null or not v_sub.enabled or v_notification.is_read
      or v_notification.type is distinct from 'organizer_reminder' or v_notification.organizer_task_id is null
      or v_notification.recipient_id::text is distinct from v_sub.user_id::text
      or not exists(select 1 from public.organizer_tasks t where t.id=v_notification.organizer_task_id and t.user_id=v_sub.user_id and not t.completed)
      or not exists(select 1 from public.organizer_task_reminders r where r.notification_id=v_notification.id and r.reminder_at>=now()-interval '24 hours')
      or v_job.created_at<now()-interval '24 hours' or not public.xelay_has_participant_access(v_sub.user_id)
      or not coalesce((select notifications_enabled from public.notification_preferences where notification_preferences.user_id=v_sub.user_id),true) then
      update public.participant_push_outbox o set status='skipped',lease_token=null,lease_until=null where o.id=v_job.id;
      continue;
    end if;
    v_token:=gen_random_uuid();
    update public.participant_push_outbox o set status='processing',attempts=o.attempts+1,
      lease_token=v_token,lease_until=now()+interval '2 minutes' where o.id=v_job.id;
    job_id:=v_job.id; lock_token:=v_token; subscription_id:=v_sub.id; user_id:=v_sub.user_id;
    notification_id:=v_notification.id; endpoint:=v_sub.endpoint; p256dh:=v_sub.p256dh; auth_key:=v_sub.auth_key;
    return next;
    v_returned:=v_returned+1;
    exit when v_returned>=least(greatest(coalesce(p_limit,20),1),50);
  end loop;
end;
$$;

create or replace function public.xelay_participant_push_delivery_allowed(p_job_id uuid,p_token uuid)
returns boolean language plpgsql stable security definer set search_path='' as $$
begin
  if auth.role() is distinct from 'service_role' then raise exception 'PUSH_WORKER_REQUIRED' using errcode='42501'; end if;
  return exists(select 1 from public.participant_push_outbox o
    join public.participant_push_subscriptions s on s.id=o.subscription_id
    join public.notifications n on n.id=o.notification_id and n.recipient_id::text=s.user_id::text
    join public.organizer_tasks t on t.id=n.organizer_task_id and t.user_id=s.user_id
    join public.organizer_task_reminders r on r.notification_id=n.id and r.task_id=t.id
    where o.id=p_job_id and o.lease_token=p_token and o.status='processing' and o.lease_until>now()
      and s.enabled and not t.completed and not n.is_read and n.type='organizer_reminder'
      and r.reminder_at>=now()-interval '24 hours' and o.created_at>=now()-interval '24 hours'
      and public.xelay_has_participant_access(s.user_id)
      and coalesce((select notifications_enabled from public.notification_preferences p where p.user_id=s.user_id),true));
end;
$$;

create or replace function public.xelay_finish_participant_push(p_job_id uuid,p_token uuid,p_status text,p_remove_device boolean default false)
returns boolean language plpgsql security definer set search_path='' as $$
declare v_job public.participant_push_outbox%rowtype;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'PUSH_WORKER_REQUIRED' using errcode='42501'; end if;
  if p_status not in ('sent','skipped','retry') or p_status is null then raise exception 'PUSH_RESULT_INVALID' using errcode='22023'; end if;
  select * into v_job from public.participant_push_outbox where id=p_job_id and lease_token=p_token and status='processing' for update;
  if not found then return false; end if;
  update public.participant_push_outbox set status=case when p_status='retry' then case when attempts>=5 then 'failed' else 'pending' end else p_status end,
    next_attempt_at=now()+make_interval(secs=>least(3600,60*power(2,attempts)::integer)),
    lease_token=null,lease_until=null,delivered_at=case when p_status='sent' then now() else null end where id=p_job_id;
  if p_remove_device then delete from public.participant_push_subscriptions where id=v_job.subscription_id; end if;
  return true;
end;
$$;

revoke all on function public.xelay_get_participant_appearance(),public.xelay_set_participant_appearance(text,text,text),public.xelay_public_appearance(uuid[]),
  public.xelay_register_participant_push(uuid,text,text,text,text),public.xelay_queue_participant_push(),public.xelay_claim_participant_push(integer),
  public.xelay_participant_push_delivery_allowed(uuid,uuid),public.xelay_finish_participant_push(uuid,uuid,text,boolean) from public,anon,authenticated,service_role;
grant execute on function public.xelay_get_participant_appearance(),public.xelay_set_participant_appearance(text,text,text) to authenticated;
grant execute on function public.xelay_public_appearance(uuid[]) to anon,authenticated;
grant execute on function public.xelay_register_participant_push(uuid,text,text,text,text),public.xelay_claim_participant_push(integer),
  public.xelay_participant_push_delivery_allowed(uuid,uuid),public.xelay_finish_participant_push(uuid,uuid,text,boolean) to service_role;
comment on table public.participant_push_subscriptions is 'Private opt-in endpoint capability and encryption keys; never exposed through browser table grants. At most 8 devices per owner.';
comment on table public.participant_push_outbox is 'Organizer-only push, atomic claim leases and bounded retries. Provider and service-worker tags suppress duplicate display; external delivery is not exactly-once.';
notify pgrst,'reload schema';


commit;
