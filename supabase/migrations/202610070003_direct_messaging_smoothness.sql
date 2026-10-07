-- Direct messages: safe retries, one inbox query and scoped Realtime updates.
-- Apply before deploying the matching client. Accepts either the complete
-- direct-media security setup or the targeted production media repair from
-- 2026-10-04. Do not replay complete 004/005 over that partial repair.
-- Missing direct-send date/rate guard is installed below; existing guards remain.
-- No messages, media, policies, subscription rules or read grants are removed.
begin;
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
commit;
