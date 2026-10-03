-- Message/chat remediation: authoritative dates, atomic abuse limits and private-media cleanup.
-- Apply after 202610030004_legacy_content_storage_security.sql. No public buckets or role/premium rules are changed.
begin;

do $$
begin
  if to_regprocedure('public.xelay_chat_publish(text,jsonb,uuid,uuid,uuid,uuid)') is null
    or to_regclass('public.message_attachments') is null
    or to_regclass('public.study_group_seminar_file_cleanup') is null then
    raise exception 'Apply message, chat publication and seminar migrations before message/chat security';
  end if;
end $$;

-- Keep the original invalid metadata for review; message/poll text, choices and votes are retained.
create table public.message_chat_date_repairs (
  object_kind text not null check (object_kind in ('message','poll')),
  object_id uuid not null,
  field_name text not null,
  original_value text,
  repaired_value text,
  repaired_at timestamptz not null default clock_timestamp(),
  primary key (object_kind,object_id,field_name)
);
alter table public.message_chat_date_repairs enable row level security;
revoke all on public.message_chat_date_repairs from public,anon,authenticated,service_role;

create or replace function public.xelay_private_safe_timestamp(p_value timestamptz)
returns boolean language sql immutable set search_path = public,pg_temp as $$
  select p_value is not null and isfinite(p_value)
    and p_value >= timestamptz '0001-01-01 00:00:00+00' and p_value < timestamptz '10000-01-01 00:00:00+00';
$$;
create or replace function public.xelay_private_poll_date_valid(p_content jsonb)
returns boolean language plpgsql stable set search_path = public,pg_temp set timezone='UTC' set datestyle='ISO,YMD' as $$
begin
  if p_content->>'closes_at' is null then return true; end if;
  return jsonb_typeof(p_content->'closes_at') = 'string'
    and public.xelay_private_safe_timestamp((p_content->>'closes_at')::timestamptz);
exception when others then return false;
end $$;

insert into public.message_chat_date_repairs(object_kind,object_id,field_name,original_value,repaired_value)
select 'message',m.id,'created_at',m.created_at::text,
  (case when public.xelay_private_safe_timestamp(c.created_at) then c.created_at else clock_timestamp() end)::text
from public.messages m join public.conversations c on c.id=m.conversation_id
where not public.xelay_private_safe_timestamp(m.created_at);
update public.messages m set created_at=r.repaired_value::timestamptz
from public.message_chat_date_repairs r where r.object_kind='message' and r.object_id=m.id and r.field_name='created_at';

-- The table lock taken by ALTER is held until commit. Only this migration repairs invalid poll metadata.
alter table public.chat_publications disable trigger xelay_chat_guard_publication_identity;
insert into public.message_chat_date_repairs(object_kind,object_id,field_name,original_value,repaired_value)
select 'poll',id,'closes_at',content->>'closes_at',null from public.chat_publications
where kind='poll' and not public.xelay_private_poll_date_valid(content);
update public.chat_publications set content=jsonb_set(content,'{closes_at}','null'::jsonb)
where kind='poll' and not public.xelay_private_poll_date_valid(content);
alter table public.chat_publications enable trigger xelay_chat_guard_publication_identity;

alter table public.messages add constraint messages_safe_created_at check(public.xelay_private_safe_timestamp(created_at));
alter table public.chat_publications add constraint chat_publications_safe_poll_date
  check(kind<>'poll' or public.xelay_private_poll_date_valid(content));
-- CHECK helpers are pure predicates; RLS and mutation grants remain the authorization boundary.
revoke all on function public.xelay_private_safe_timestamp(timestamptz),public.xelay_private_poll_date_valid(jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_private_safe_timestamp(timestamptz),public.xelay_private_poll_date_valid(jsonb) to authenticated;

create index if not exists messages_sender_created_idx on public.messages(sender_id,created_at);
create index if not exists connection_requests_requester_created_idx on public.connection_requests(requester_id,created_at);

create or replace function public.xelay_private_guard_message()
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
create trigger xelay_private_guard_message before insert or update on public.messages
  for each row execute function public.xelay_private_guard_message();

create or replace function public.xelay_private_guard_connection_request()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if tg_op='UPDATE' then new.created_at:=old.created_at; return new; end if;
  if auth.uid() is null or new.requester_id is distinct from auth.uid() or new.recipient_id is null
    or new.recipient_id=new.requester_id or new.status<>'pending' then raise exception 'CONNECTION_REQUEST_INVALID' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-connection-pair:' || least(new.requester_id,new.recipient_id)::text
    || ':' || greatest(new.requester_id,new.recipient_id)::text,0));
  perform pg_advisory_xact_lock(hashtextextended('xelay-connection-send:' || new.requester_id::text,0));
  new.created_at:=clock_timestamp(); new.updated_at:=new.created_at;
  if (select count(*) from public.connection_requests where requester_id=new.requester_id and created_at>new.created_at-interval '10 minutes')>=10
    or (select count(*) from public.connection_requests where requester_id=new.requester_id and created_at>new.created_at-interval '1 day')>=30
    or exists(select 1 from public.connection_requests where requester_id=new.requester_id and recipient_id=new.recipient_id
      and status='rejected' and updated_at>new.created_at-interval '1 day') then
    raise exception 'CONNECTION_REQUEST_RATE_LIMIT' using errcode='P0001';
  end if;
  return new;
end $$;
create trigger xelay_private_guard_connection_request before insert or update on public.connection_requests
  for each row execute function public.xelay_private_guard_connection_request();

create table public.private_chat_cancel_events(owner_id uuid not null,cancelled_at timestamptz not null default clock_timestamp());
create index private_chat_cancel_events_owner_time_idx on public.private_chat_cancel_events(owner_id,cancelled_at);
alter table public.private_chat_cancel_events enable row level security;
revoke all on public.private_chat_cancel_events from public,anon,authenticated,service_role;

create or replace function public.xelay_chat_cancel_request(p_space_id uuid)
returns void language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  -- A random/private space ID without an own pending request never acquires the chat lock.
  if not exists(select 1 from public.chat_join_requests where space_id=p_space_id and user_id=auth.uid() and status='pending') then return; end if;
  perform public.xelay_chat_lock(p_space_id,'none');
  perform pg_advisory_xact_lock(hashtextextended('xelay-chat-cancel:' || auth.uid()::text,0));
  -- Recheck after the container wait; a concurrently handled request is an idempotent no-op.
  if not exists(select 1 from public.chat_join_requests where space_id=p_space_id and user_id=auth.uid() and status='pending') then return; end if;
  delete from public.private_chat_cancel_events where owner_id=auth.uid() and cancelled_at<clock_timestamp()-interval '7 days';
  if (select count(*) from public.private_chat_cancel_events where owner_id=auth.uid() and cancelled_at>clock_timestamp()-interval '10 minutes')>=10
    or (select count(*) from public.private_chat_cancel_events where owner_id=auth.uid() and cancelled_at>clock_timestamp()-interval '1 day')>=50 then
    raise exception 'CHAT_RATE_LIMIT';
  end if;
  update public.chat_join_requests set status='cancelled',updated_at=clock_timestamp()
    where space_id=p_space_id and user_id=auth.uid() and status='pending';
  if found then
    insert into public.private_chat_cancel_events(owner_id) values(auth.uid());
    update public.chat_spaces set updated_at=clock_timestamp() where id=p_space_id;
  end if;
end $$;

-- Actual Storage ownership is authoritative; legacy owner UUID and current owner_id text are supported.
create or replace function public.xelay_private_object_owner(p_object jsonb)
returns uuid language plpgsql immutable set search_path = public,pg_temp as $$
begin
  return coalesce(nullif(p_object->>'owner_id',''),p_object->>'owner')::uuid;
exception when invalid_text_representation then return null;
end $$;
create or replace function public.xelay_private_object_bytes(p_metadata jsonb)
returns bigint language plpgsql immutable set search_path = public,pg_temp as $$
declare v_size numeric;
begin
  if coalesce(p_metadata->>'size','') !~ '^[0-9]+$' or length(p_metadata->>'size')>10 then return 26214400; end if;
  v_size:=(p_metadata->>'size')::numeric;
  if v_size not between 1 and 26214400 then return 26214400; end if;
  return v_size::bigint;
end $$;

alter table public.message_attachments add column if not exists file_size bigint;
update public.message_attachments a set file_size=public.xelay_private_object_bytes(o.metadata)
from storage.objects o where o.bucket_id='xelay-message-media' and o.name=a.storage_path and a.file_size is null;

create table public.private_media_cleanup (
  bucket_id text not null check(bucket_id in ('xelay-message-media','xelay-chat-media')),
  storage_path text not null,
  object_id uuid not null,
  owner_id uuid not null,
  cleanup_user_id uuid,
  created_at timestamptz not null default clock_timestamp(),
  primary key(bucket_id,storage_path)
);
alter table public.private_media_cleanup enable row level security;
revoke all on public.private_media_cleanup from public,anon,authenticated,service_role;
create index private_media_cleanup_actor_idx on public.private_media_cleanup(cleanup_user_id);

create or replace function public.xelay_private_media_attached(p_bucket text,p_path text)
returns boolean language sql stable security definer set search_path = public,pg_temp as $$
  select case p_bucket when 'xelay-message-media' then exists(select 1 from public.message_attachments where storage_path=p_path)
    when 'xelay-chat-media' then exists(select 1 from public.chat_attachments where storage_path=p_path)
      or exists(select 1 from public.chat_spaces where avatar_path=p_path)
      or exists(select 1 from public.chat_publications p
        left join public.chat_posts cp on cp.id=p.post_id left join public.messages m on m.id=p.message_id
        where p.kind='article' and p.content->>'cover_path'=p_path
          and ((cp.id is not null and cp.deleted_at is null) or (m.id is not null and m.deleted_at is null)))
    else true end;
$$;

create or replace function public.xelay_private_capture_attachment_cleanup()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
declare v_bucket text; v_object storage.objects%rowtype; v_owner uuid;
begin
  v_bucket:=case tg_table_name when 'message_attachments' then 'xelay-message-media' else 'xelay-chat-media' end;
  select * into v_object from storage.objects where bucket_id=v_bucket and name=old.storage_path for update;
  if found then
    v_owner:=public.xelay_private_object_owner(to_jsonb(v_object));
    if v_owner is not null then
      insert into public.private_media_cleanup(bucket_id,storage_path,object_id,owner_id,cleanup_user_id)
      values(v_bucket,old.storage_path,v_object.id,v_owner,coalesce(auth.uid(),old.uploaded_by))
      on conflict(bucket_id,storage_path) do update set object_id=excluded.object_id,owner_id=excluded.owner_id,
        cleanup_user_id=excluded.cleanup_user_id,created_at=clock_timestamp();
    end if;
  end if;
  return old;
end $$;
create trigger xelay_private_attachment_cleanup before delete on public.message_attachments
  for each row execute function public.xelay_private_capture_attachment_cleanup();
create trigger xelay_private_chat_attachment_cleanup before delete on public.chat_attachments
  for each row execute function public.xelay_private_capture_attachment_cleanup();

create or replace function public.xelay_private_record_cleanup(p_bucket text,p_path text,p_actor uuid)
returns void language plpgsql security definer set search_path = public,pg_temp as $$
declare v_object storage.objects%rowtype; v_owner uuid;
begin
  if p_path is null then return; end if;
  select * into v_object from storage.objects where bucket_id=p_bucket and name=p_path for update;
  if not found then return; end if;
  v_owner:=public.xelay_private_object_owner(to_jsonb(v_object));
  if v_owner is null then return; end if;
  insert into public.private_media_cleanup(bucket_id,storage_path,object_id,owner_id,cleanup_user_id)
    values(p_bucket,p_path,v_object.id,v_owner,p_actor)
    on conflict(bucket_id,storage_path) do update set object_id=excluded.object_id,owner_id=excluded.owner_id,
      cleanup_user_id=excluded.cleanup_user_id,created_at=clock_timestamp();
end $$;
create or replace function public.xelay_private_capture_cover_cleanup()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if old.kind='article' and (tg_op='DELETE' or new.content->>'cover_path' is distinct from old.content->>'cover_path') then
    perform public.xelay_private_record_cleanup('xelay-chat-media',old.content->>'cover_path',coalesce(auth.uid(),old.author_id));
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger xelay_private_cover_cleanup before update of content or delete on public.chat_publications
  for each row execute function public.xelay_private_capture_cover_cleanup();
create or replace function public.xelay_private_capture_avatar_cleanup()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if tg_op='DELETE' or new.avatar_path is distinct from old.avatar_path then
    perform public.xelay_private_record_cleanup('xelay-chat-media',old.avatar_path,coalesce(auth.uid(),old.owner_id));
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end $$;
create trigger xelay_private_avatar_cleanup before update of avatar_path or delete on public.chat_spaces
  for each row execute function public.xelay_private_capture_avatar_cleanup();

create or replace function public.xelay_private_validate_message_attachment()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
declare v_message public.messages%rowtype; v_object storage.objects%rowtype; v_bytes bigint;
begin
  if tg_op='UPDATE' then raise exception 'PRIVATE_MEDIA_IDENTITY_IMMUTABLE'; end if;
  if auth.uid() is null or new.uploaded_by is distinct from auth.uid() then raise exception 'PRIVATE_MEDIA_FORBIDDEN' using errcode='42501'; end if;
  select * into v_message from public.messages where id=new.message_id for update;
  if not found or v_message.sender_id<>auth.uid() or v_message.deleted_at is not null
    or v_message.conversation_id<>new.conversation_id
    or split_part(new.storage_path,'/',1)<>new.conversation_id::text or split_part(new.storage_path,'/',2)<>auth.uid()::text
    or split_part(new.storage_path,'/',3)<>new.message_id::text or array_length(string_to_array(new.storage_path,'/'),1)<>4 then
    raise exception 'PRIVATE_MEDIA_FORBIDDEN' using errcode='42501';
  end if;
  select * into v_object from storage.objects where bucket_id='xelay-message-media' and name=new.storage_path for update;
  if not found or public.xelay_private_object_owner(to_jsonb(v_object)) is distinct from auth.uid()
    or coalesce(v_object.metadata->>'size','') !~ '^[0-9]+$' or length(v_object.metadata->>'size')>10
    or v_object.metadata->>'mimetype' is distinct from new.mime_type then raise exception 'PRIVATE_MEDIA_INVALID'; end if;
  v_bytes:=(v_object.metadata->>'size')::bigint;
  if v_bytes not between 1 and 26214400 or new.media_type<>(case when new.mime_type like 'image/%' then 'image' else 'video' end) then
    raise exception 'PRIVATE_MEDIA_INVALID';
  end if;
  if (select count(*) from public.message_attachments where message_id=new.message_id)>=5
    or coalesce((select sum(coalesce(file_size,26214400)) from public.message_attachments where message_id=new.message_id),0)+v_bytes>52428800 then
    raise exception 'PRIVATE_MEDIA_ATTACHMENT_LIMIT';
  end if;
  new.file_size:=v_bytes; new.created_at:=clock_timestamp();
  delete from public.private_media_cleanup where bucket_id='xelay-message-media' and storage_path=new.storage_path;
  return new;
end $$;
create trigger xelay_private_validate_message_attachment before insert or update on public.message_attachments
  for each row execute function public.xelay_private_validate_message_attachment();

-- This RPC commits the message and all descriptors together; failure leaves no partial message/notification.
create or replace function public.xelay_send_direct_message(
  p_message_id uuid,p_conversation_id uuid,p_body text,p_reply_to uuid default null,p_attachments jsonb default '[]'
)
returns jsonb language plpgsql security definer set search_path = public,pg_temp as $$
declare v_conversation public.conversations%rowtype; v_message public.messages%rowtype; v_item jsonb; v_recipient uuid;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED' using errcode='42501'; end if;
  if p_message_id is null or p_body is null or length(btrim(p_body)) not between 1 and 5000
    or p_attachments is null or jsonb_typeof(p_attachments)<>'array' then raise exception 'CHAT_INVALID_INPUT'; end if;
  if jsonb_array_length(p_attachments)>5 then raise exception 'PRIVATE_MEDIA_ATTACHMENT_LIMIT'; end if;
  select * into v_conversation from public.conversations where id=p_conversation_id and auth.uid() in(user_one_id,user_two_id) for update;
  if not found then raise exception 'CHAT_MEMBER_REQUIRED' using errcode='42501'; end if;
  v_recipient:=case when v_conversation.user_one_id=auth.uid() then v_conversation.user_two_id else v_conversation.user_one_id end;
  insert into public.messages(id,conversation_id,sender_id,recipient_id,body,reply_to_message_id)
    values(p_message_id,p_conversation_id,auth.uid(),v_recipient,p_body,p_reply_to) returning * into v_message;
  for v_item in select value from jsonb_array_elements(p_attachments) loop
    if jsonb_typeof(v_item)<>'object' or exists(select 1 from jsonb_each(v_item) e
      where e.key not in('storage_path','file_name','media_type','mime_type'))
      or jsonb_typeof(v_item->'storage_path') is distinct from 'string' or jsonb_typeof(v_item->'file_name') is distinct from 'string'
      or jsonb_typeof(v_item->'media_type') is distinct from 'string' or jsonb_typeof(v_item->'mime_type') is distinct from 'string' then
      raise exception 'PRIVATE_MEDIA_INVALID';
    end if;
    insert into public.message_attachments(message_id,conversation_id,uploaded_by,storage_path,file_name,media_type,mime_type)
    values(v_message.id,p_conversation_id,auth.uid(),v_item->>'storage_path',v_item->>'file_name',v_item->>'media_type',v_item->>'mime_type');
  end loop;
  return to_jsonb(v_message);
end $$;

create or replace function public.xelay_private_can_read_media(p_bucket text,p_path text)
returns boolean language plpgsql stable security definer set search_path = public,pg_temp as $$
begin
  if auth.uid() is null then return false; end if;
  -- Attached paths always require content permission, even for the uploader or an old cleanup actor.
  if public.xelay_private_media_attached(p_bucket,p_path) then
    if p_bucket='xelay-message-media' then
      return exists(select 1 from public.message_attachments a join public.messages m on m.id=a.message_id
        join public.conversations c on c.id=m.conversation_id where a.storage_path=p_path and m.deleted_at is null
          and a.conversation_id=m.conversation_id and auth.uid() in(c.user_one_id,c.user_two_id)
          and ((m.sender_id=c.user_one_id and m.recipient_id=c.user_two_id) or (m.sender_id=c.user_two_id and m.recipient_id=c.user_one_id)));
    elsif p_bucket='xelay-chat-media' then
      return exists(select 1 from public.chat_attachments a where a.storage_path=p_path and public.xelay_chat_can_read_post(a.post_id))
        or exists(select 1 from public.chat_spaces s where s.avatar_path=p_path and public.xelay_chat_can_view_space(s.id))
        or exists(select 1 from public.chat_publications p where p.kind='article' and p.content->>'cover_path'=p_path
          and public.xelay_chat_can_read_publication(p.id));
    end if;
    return false;
  end if;
  return exists(select 1 from storage.objects o where o.bucket_id=p_bucket and o.name=p_path and (
    public.xelay_private_object_owner(to_jsonb(o))=auth.uid()
    or exists(select 1 from public.private_media_cleanup r where r.bucket_id=p_bucket and r.storage_path=p_path and r.object_id=o.id
      and r.owner_id=public.xelay_private_object_owner(to_jsonb(o)) and (r.cleanup_user_id=auth.uid() or r.owner_id=auth.uid()))));
end $$;
create or replace function public.xelay_private_can_remove_media(p_bucket text,p_path text)
returns boolean language plpgsql stable security definer set search_path = public,pg_temp as $$
begin
  if auth.uid() is null or p_bucket not in ('xelay-message-media','xelay-chat-media')
    or public.xelay_private_media_attached(p_bucket,p_path) then return false; end if;
  return exists(select 1 from storage.objects o where o.bucket_id=p_bucket and o.name=p_path and (
    public.xelay_private_object_owner(to_jsonb(o))=auth.uid()
    or exists(select 1 from public.private_media_cleanup r where r.bucket_id=p_bucket and r.storage_path=p_path and r.object_id=o.id
      and r.owner_id=public.xelay_private_object_owner(to_jsonb(o)) and (r.cleanup_user_id=auth.uid() or r.owner_id=auth.uid()))));
end $$;
-- SELECT policy for RETURNING uses the actual new Storage row before a STABLE lookup sees it.
-- The supplied row is policy context; this boolean helper never returns any content.
create or replace function public.xelay_private_can_read_media_row(p_bucket text,p_path text,p_object jsonb)
returns boolean language plpgsql stable security definer set search_path = public,pg_temp as $$
declare v_owner uuid:=public.xelay_private_object_owner(p_object); v_id uuid;
begin
  if auth.uid() is null then return false; end if;
  if public.xelay_private_media_attached(p_bucket,p_path) then return public.xelay_private_can_read_media(p_bucket,p_path); end if;
  v_id:=(p_object->>'id')::uuid;
  return v_owner=auth.uid() or exists(select 1 from public.private_media_cleanup r where r.bucket_id=p_bucket
    and r.storage_path=p_path and r.object_id=v_id and r.owner_id=v_owner and (r.cleanup_user_id=auth.uid() or r.owner_id=auth.uid()));
exception when invalid_text_representation then return false;
end $$;

create or replace function public.xelay_chat_can_read_media(p_path text)
returns boolean language sql stable security definer set search_path = public,pg_temp as $$
  select public.xelay_private_can_read_media('xelay-chat-media',p_path);
$$;
create or replace function public.xelay_chat_can_remove_media(p_path text)
returns boolean language sql stable security definer set search_path = public,pg_temp as $$
  select public.xelay_private_can_remove_media('xelay-chat-media',p_path);
$$;

create table public.private_media_upload_events (
  owner_id uuid not null,
  uploaded_at timestamptz not null default clock_timestamp()
);
create index private_media_upload_events_owner_time_idx on public.private_media_upload_events(owner_id,uploaded_at);
alter table public.private_media_upload_events enable row level security;
revoke all on public.private_media_upload_events from public,anon,authenticated,service_role;


create table public.private_media_upload_reservations (
  bucket_id text not null check(bucket_id in('xelay-message-media','xelay-chat-media')),
  storage_path text not null,
  owner_id uuid not null,
  expires_at timestamptz not null default clock_timestamp()+interval '15 minutes',
  primary key(bucket_id,storage_path)
);
create index private_media_upload_reservations_owner_idx on public.private_media_upload_reservations(owner_id,expires_at);
alter table public.private_media_upload_reservations enable row level security;
revoke all on public.private_media_upload_reservations from public,anon,authenticated,service_role;
create table public.private_media_cleanup_claims (
  bucket_id text not null,
  storage_path text not null,
  object_id uuid not null,
  object_updated_at timestamptz not null,
  object_version text,
  expires_at timestamptz not null default clock_timestamp()+interval '5 minutes',
  primary key(bucket_id,storage_path)
);
create index private_media_cleanup_claims_expiry_idx on public.private_media_cleanup_claims(expires_at);
alter table public.private_media_cleanup_claims enable row level security;
revoke all on public.private_media_cleanup_claims from public,anon,authenticated,service_role;

create or replace function public.xelay_private_can_upload_media(p_bucket text,p_path text)
returns boolean language plpgsql stable security definer set search_path = public,pg_temp as $$
begin
  if auth.uid() is null then return false; end if;
  if p_bucket='xelay-chat-media' then return public.xelay_chat_valid_media_path(p_path); end if;
  if p_bucket<>'xelay-message-media' or split_part(p_path,'/',2)<>auth.uid()::text
    or array_length(string_to_array(p_path,'/'),1)<>4
    or split_part(p_path,'/',3)!~'^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
    or length(split_part(p_path,'/',4)) not between 1 and 255 then return false; end if;
  return exists(select 1 from public.conversations c where c.id::text=split_part(p_path,'/',1) and auth.uid() in(c.user_one_id,c.user_two_id));
end $$;

-- Persisted before the Storage permission preflight (which intentionally rolls its transaction back).
-- The full bucket maximum is reserved; same-path retries are idempotent, not a HTTP DDoS control.
create or replace function public.xelay_private_reserve_media(p_bucket_id text,p_storage_path text)
returns void language plpgsql security definer set search_path = public,pg_temp as $$
declare v_count bigint; v_usage bigint; v_pending bigint; v_reserved bigint;
begin
  if auth.uid() is null or not public.xelay_private_can_upload_media(p_bucket_id,p_storage_path) then
    raise exception 'PRIVATE_MEDIA_FORBIDDEN' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-private-upload:' || auth.uid()::text,0));
  delete from public.private_media_upload_reservations where owner_id=auth.uid() and expires_at<=clock_timestamp();
  if exists(select 1 from public.private_media_upload_reservations where bucket_id=p_bucket_id and storage_path=p_storage_path
    and owner_id=auth.uid() and expires_at>clock_timestamp()) then return; end if;
  if exists(select 1 from storage.objects where bucket_id=p_bucket_id and name=p_storage_path)
    or public.xelay_private_media_attached(p_bucket_id,p_storage_path) then raise exception 'PRIVATE_MEDIA_IN_USE'; end if;
  delete from public.private_media_upload_events where owner_id=auth.uid() and uploaded_at<clock_timestamp()-interval '7 days';
  if (select count(*) from public.private_media_upload_events where owner_id=auth.uid() and uploaded_at>clock_timestamp()-interval '1 minute')>=30
    or (select count(*) from public.private_media_upload_events where owner_id=auth.uid() and uploaded_at>clock_timestamp()-interval '1 day')>=200 then
    raise exception 'PRIVATE_MEDIA_UPLOAD_RATE_LIMIT';
  end if;
  select count(*),coalesce(sum(public.xelay_private_object_bytes(o.metadata)),0),
    count(*) filter(where not public.xelay_private_media_attached(o.bucket_id,o.name))
    into v_count,v_usage,v_pending from storage.objects o where o.bucket_id in('xelay-message-media','xelay-chat-media')
      and public.xelay_private_object_owner(to_jsonb(o))=auth.uid();
  select count(*) into v_reserved from public.private_media_upload_reservations r where r.owner_id=auth.uid()
    and r.expires_at>clock_timestamp() and not exists(select 1 from storage.objects o where o.bucket_id=r.bucket_id and o.name=r.storage_path);
  if v_count+v_reserved>=1000 or v_usage+(v_reserved+1)*26214400>1073741824 or v_pending+v_reserved>=100 then raise exception 'PRIVATE_MEDIA_QUOTA'; end if;
  insert into public.private_media_upload_reservations(bucket_id,storage_path,owner_id) values(p_bucket_id,p_storage_path,auth.uid());
  insert into public.private_media_upload_events(owner_id) values(auth.uid());
end $$;

create or replace function public.xelay_private_guard_storage_upload()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
declare v_owner uuid; v_bytes bigint; v_usage bigint; v_count bigint; v_pending bigint; v_reserved bigint;
begin
  if new.bucket_id not in ('xelay-message-media','xelay-chat-media') then return new; end if;
  v_owner:=public.xelay_private_object_owner(to_jsonb(new));
  if v_owner is null or (auth.uid() is not null and v_owner<>auth.uid()) then raise exception 'PRIVATE_MEDIA_FORBIDDEN' using errcode='42501'; end if;
  if auth.uid() is not null and not public.xelay_private_can_upload_media(new.bucket_id,new.name) then raise exception 'PRIVATE_MEDIA_FORBIDDEN'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-private-upload:' || v_owner::text,0));
  perform 1 from public.private_media_upload_reservations where bucket_id=new.bucket_id and storage_path=new.name
    and owner_id=v_owner and expires_at>clock_timestamp() for update;
  if not found then raise exception 'PRIVATE_MEDIA_UPLOAD_RESERVATION_REQUIRED'; end if;
  if new.metadata->>'size' is not null and (coalesce(new.metadata->>'size','')!~'^[0-9]+$'
    or length(new.metadata->>'size')>10 or (new.metadata->>'size')::numeric not between 1 and 26214400) then raise exception 'PRIVATE_MEDIA_INVALID'; end if;
  v_bytes:=public.xelay_private_object_bytes(new.metadata);
  if public.xelay_private_media_attached(new.bucket_id,new.name) then raise exception 'PRIVATE_MEDIA_IN_USE'; end if;
  select count(*),coalesce(sum(public.xelay_private_object_bytes(o.metadata)),0),
    count(*) filter(where not public.xelay_private_media_attached(o.bucket_id,o.name))
    into v_count,v_usage,v_pending from storage.objects o where o.bucket_id in('xelay-message-media','xelay-chat-media')
      and not(o.bucket_id=new.bucket_id and o.name=new.name) and public.xelay_private_object_owner(to_jsonb(o))=v_owner;
  select count(*) into v_reserved from public.private_media_upload_reservations r where r.owner_id=v_owner and r.expires_at>clock_timestamp()
    and not(r.bucket_id=new.bucket_id and r.storage_path=new.name)
    and not exists(select 1 from storage.objects o where o.bucket_id=r.bucket_id and o.name=r.storage_path);
  if v_count+v_reserved>=1000 or v_usage+v_reserved*26214400+v_bytes>1073741824 or v_pending+v_reserved>=100 then raise exception 'PRIVATE_MEDIA_QUOTA'; end if;
  -- Consume only after INSERT/UPDATE actually completes; an upsert may still execute its UPDATE guard.
  delete from public.private_media_cleanup where bucket_id=new.bucket_id and storage_path=new.name;
  delete from public.private_media_cleanup_claims where bucket_id=new.bucket_id and storage_path=new.name;
  return new;
end $$;
create trigger xelay_private_guard_storage_upload before insert on storage.objects
  for each row execute function public.xelay_private_guard_storage_upload();

-- Some Storage versions finalize metadata with UPDATE after the initial row INSERT.
create or replace function public.xelay_private_guard_storage_size_update()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
declare v_owner uuid; v_before bigint; v_after bigint; v_usage bigint; v_reserved bigint;
begin
  if new.bucket_id not in('xelay-message-media','xelay-chat-media') or new.metadata is not distinct from old.metadata then return new; end if;
  if new.metadata->>'size' is not null and (coalesce(new.metadata->>'size','') !~ '^[0-9]+$'
    or length(new.metadata->>'size')>10 or (new.metadata->>'size')::numeric not between 1 and 26214400) then raise exception 'PRIVATE_MEDIA_INVALID'; end if;
  v_before:=public.xelay_private_object_bytes(old.metadata); v_after:=public.xelay_private_object_bytes(new.metadata);
  v_owner:=public.xelay_private_object_owner(to_jsonb(new));
  if v_owner is null then raise exception 'PRIVATE_MEDIA_FORBIDDEN'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-private-upload:' || v_owner::text,0));
  if old.metadata->>'size' is null and new.metadata->>'size' is not null then
    perform 1 from public.private_media_upload_reservations where bucket_id=new.bucket_id and storage_path=new.name
      and owner_id=v_owner and expires_at>clock_timestamp() for update;
    if not found then raise exception 'PRIVATE_MEDIA_UPLOAD_RESERVATION_REQUIRED'; end if;
  end if;
  select coalesce(sum(public.xelay_private_object_bytes(o.metadata)),0) into v_usage from storage.objects o
    where o.bucket_id in('xelay-message-media','xelay-chat-media') and o.id<>new.id and public.xelay_private_object_owner(to_jsonb(o))=v_owner;
  select count(*) into v_reserved from public.private_media_upload_reservations r where r.owner_id=v_owner and r.expires_at>clock_timestamp()
    and not(r.bucket_id=new.bucket_id and r.storage_path=new.name)
    and not exists(select 1 from storage.objects o where o.bucket_id=r.bucket_id and o.name=r.storage_path);
  if v_usage+v_after+v_reserved*26214400>1073741824 then raise exception 'PRIVATE_MEDIA_QUOTA'; end if;
  return new;
end $$;
create trigger xelay_private_guard_storage_size_update before update of metadata on storage.objects
  for each row execute function public.xelay_private_guard_storage_size_update();

create or replace function public.xelay_private_consume_upload_reservation()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if new.bucket_id in('xelay-message-media','xelay-chat-media') and new.metadata->>'size' is not null then
    delete from public.private_media_upload_reservations where bucket_id=new.bucket_id and storage_path=new.name
      and owner_id=public.xelay_private_object_owner(to_jsonb(new));
  end if;
  return new;
end $$;
create trigger xelay_private_consume_upload_reservation after insert or update of metadata on storage.objects
  for each row execute function public.xelay_private_consume_upload_reservation();

create or replace function public.xelay_private_guard_storage_delete()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  -- Recheck after Storage obtains the object row lock: a just-committed association wins over a stale RLS snapshot.
  if old.bucket_id in ('xelay-message-media','xelay-chat-media')
    and public.xelay_private_media_attached(old.bucket_id,old.name) then raise exception 'PRIVATE_MEDIA_IN_USE'; end if;
  if old.bucket_id in('xelay-message-media','xelay-chat-media') and (auth.uid() is null or auth.role()='service_role')
    and not exists(select 1 from public.private_media_cleanup_claims c where c.bucket_id=old.bucket_id and c.storage_path=old.name
      and c.object_id=old.id and c.object_updated_at is not distinct from coalesce(old.updated_at,old.created_at)
      and c.object_version is not distinct from to_jsonb(old)->>'version'
      and c.expires_at>clock_timestamp()) then raise exception 'PRIVATE_MEDIA_CLEANUP_CLAIM_REQUIRED'; end if;
  return old;
end $$;
create trigger xelay_private_guard_storage_delete before delete on storage.objects
  for each row execute function public.xelay_private_guard_storage_delete();

create or replace function public.xelay_private_consume_cleanup()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if old.bucket_id in('xelay-message-media','xelay-chat-media') then
    delete from public.private_media_cleanup where bucket_id=old.bucket_id and storage_path=old.name and object_id=old.id;
    delete from public.private_media_cleanup_claims where bucket_id=old.bucket_id and storage_path=old.name and object_id=old.id;
  elsif old.bucket_id='xelay-seminar-files' then
    delete from public.study_group_seminar_file_cleanup where storage_path=old.name;
  end if;
  return old;
end $$;
create trigger xelay_private_consume_cleanup after delete on storage.objects
  for each row execute function public.xelay_private_consume_cleanup();

create or replace function public.xelay_private_invalidate_seminar_cleanup()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
declare v_group uuid;
begin
  if new.bucket_id<>'xelay-seminar-files' then return new; end if;
  v_group:=public.xelay_homework_file_group(new.name);
  if v_group is null then raise exception 'SEMINAR_RESOURCE_INVALID_INPUT'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || v_group::text,0));
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminar-file:' || new.name,0));
  delete from public.study_group_seminar_file_cleanup where storage_path=new.name;
  return new;
end $$;
create trigger xelay_private_invalidate_seminar_cleanup before insert on storage.objects
  for each row execute function public.xelay_private_invalidate_seminar_cleanup();

create or replace function public.xelay_private_validate_chat_attachment()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
declare v_object storage.objects%rowtype;
begin
  if auth.uid() is null or new.uploaded_by is distinct from auth.uid() then raise exception 'CHAT_INVALID_MEDIA'; end if;
  select * into v_object from storage.objects where bucket_id='xelay-chat-media' and name=new.storage_path for update;
  if not found or public.xelay_private_object_owner(to_jsonb(v_object)) is distinct from auth.uid()
    or v_object.metadata->>'mimetype' is distinct from new.mime_type
    or coalesce(v_object.metadata->>'size','')!~'^[0-9]+$' or length(v_object.metadata->>'size')>10
    or (v_object.metadata->>'size')::numeric is distinct from new.file_size::numeric then raise exception 'CHAT_INVALID_MEDIA'; end if;
  delete from public.private_media_cleanup where bucket_id='xelay-chat-media' and storage_path=new.storage_path;
  return new;
end $$;
create trigger xelay_private_validate_chat_attachment before insert on public.chat_attachments
  for each row execute function public.xelay_private_validate_chat_attachment();

-- Preserve the existing helper contract, adding real object ownership to avatar/article-cover association.

create or replace function public.xelay_chat_validate_avatar(p_path text)
returns void language plpgsql security definer set search_path = public,pg_temp as $$
declare v_meta jsonb; v_owner uuid;
begin
  if p_path is null then return; end if;
  if not public.xelay_chat_valid_media_path(p_path) then raise exception 'CHAT_INVALID_MEDIA'; end if;
  select o.metadata,public.xelay_private_object_owner(to_jsonb(o)) into v_meta,v_owner from storage.objects o where bucket_id = 'xelay-chat-media' and name = p_path for update;
  if not found or v_owner is distinct from auth.uid() or coalesce(v_meta->>'mimetype','') not in ('image/jpeg','image/png','image/webp','image/gif')
    or coalesce(v_meta->>'size','') !~ '^[0-9]+$' then raise exception 'CHAT_INVALID_MEDIA'; end if;
  if (v_meta->>'size')::numeric not between 1 and 5242880
    or exists(select 1 from public.chat_attachments where storage_path = p_path)
    or exists(select 1 from public.chat_publications where kind = 'article' and content->>'cover_path' = p_path) then raise exception 'CHAT_INVALID_MEDIA'; end if;
end $$;

create or replace function public.xelay_chat_publish(
  p_kind text,p_content jsonb,p_space_id uuid default null,p_conversation_id uuid default null,
  p_parent_post_id uuid default null,p_reply_to uuid default null
)
returns jsonb language plpgsql security definer set search_path = public,pg_temp as $$
declare v_id uuid; v_post_id uuid; v_message_id uuid; v_conversation public.conversations%rowtype;
  v_content jsonb; v_closes_at timestamptz; v_cover text; v_body text; v_recipient uuid; v_space public.chat_spaces%rowtype;
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  if not public.xelay_has_participant_access(auth.uid()) then raise exception 'PARTICIPANT_REQUIRED' using errcode = '42501'; end if;
  if p_kind is null or p_kind not in ('poll','article') or p_content is null or jsonb_typeof(p_content) <> 'object'
    or num_nonnulls(p_space_id,p_conversation_id) <> 1 then raise exception 'CHAT_PUBLICATION_INVALID_INPUT'; end if;
  if p_kind = 'poll' then
    if exists(select 1 from jsonb_each(p_content) e where e.key not in ('question','options','anonymous','allows_multiple','closes_at'))
      or jsonb_typeof(p_content->'question') is distinct from 'string'
      or jsonb_typeof(p_content->'options') is distinct from 'array'
      or jsonb_typeof(p_content->'anonymous') is distinct from 'boolean'
      or jsonb_typeof(p_content->'allows_multiple') is distinct from 'boolean'
      or (p_content ? 'closes_at' and jsonb_typeof(p_content->'closes_at') not in ('null','string')) then raise exception 'CHAT_PUBLICATION_INVALID_INPUT'; end if;
    if length(btrim(p_content->>'question')) not between 1 and 500 or jsonb_array_length(p_content->'options') not between 2 and 10 then
      raise exception 'CHAT_PUBLICATION_INVALID_INPUT';
    end if;
    if exists(select 1 from jsonb_array_elements(p_content->'options') opt where jsonb_typeof(opt) <> 'string' or length(btrim(opt#>>'{}')) not between 1 and 200)
      or (select count(distinct lower(btrim(opt))) from jsonb_array_elements_text(p_content->'options') opt) <> jsonb_array_length(p_content->'options') then
      raise exception 'CHAT_PUBLICATION_INVALID_INPUT';
    end if;
    if p_content->>'closes_at' is not null then
      begin v_closes_at := (p_content->>'closes_at')::timestamptz;
      exception when others then raise exception 'CHAT_PUBLICATION_INVALID_INPUT'; end;
      if not public.xelay_private_safe_timestamp(v_closes_at) or v_closes_at <= clock_timestamp()
        or v_closes_at > clock_timestamp() + interval '1 year' then raise exception 'CHAT_PUBLICATION_INVALID_INPUT'; end if;
    end if;
    v_content := jsonb_build_object('question',btrim(p_content->>'question'),
      'options',(select jsonb_agg(btrim(opt) order by ord) from jsonb_array_elements_text(p_content->'options') with ordinality options(opt,ord)),
      'anonymous',(p_content->>'anonymous')::boolean,'allows_multiple',(p_content->>'allows_multiple')::boolean,'closes_at',v_closes_at);
  else
    if exists(select 1 from jsonb_each(p_content) e where e.key not in ('title','body','cover_path'))
      or jsonb_typeof(p_content->'title') is distinct from 'string' or jsonb_typeof(p_content->'body') is distinct from 'string'
      or length(btrim(p_content->>'title')) not between 1 and 200 or btrim(p_content->>'body') = '' or length(p_content->>'body') > 50000
      or (p_content ? 'cover_path' and jsonb_typeof(p_content->'cover_path') not in ('null','string')) then raise exception 'CHAT_PUBLICATION_INVALID_INPUT'; end if;
    v_cover := p_content->>'cover_path';
    v_content := jsonb_build_object('title',btrim(p_content->>'title'),'body',p_content->>'body','cover_path',v_cover);
  end if;
  -- Validate scope/role and acquire the existing message-send lock before media.
  if p_space_id is not null then
    v_space := public.xelay_chat_lock(p_space_id,'member');
    if v_space.kind = 'channel' and p_parent_post_id is null and not public.xelay_chat_is_admin(p_space_id) then raise exception 'CHAT_ADMIN_REQUIRED'; end if;
    -- Match ordinary send ordering: space -> sender lock -> storage object.
    perform pg_advisory_xact_lock(hashtextextended('xelay-chat-send:' || auth.uid()::text,0));
  else
    if p_parent_post_id is not null then raise exception 'CHAT_INVALID_PARENT'; end if;
    select * into v_conversation from public.conversations c where c.id = p_conversation_id and auth.uid() in(c.user_one_id,c.user_two_id) for update;
    if not found then raise exception 'CHAT_MEMBER_REQUIRED'; end if;
    v_recipient := case when v_conversation.user_one_id = auth.uid() then v_conversation.user_two_id else v_conversation.user_one_id end;
    if p_reply_to is not null and not exists(select 1 from public.messages m where m.id = p_reply_to
      and m.conversation_id = p_conversation_id and m.deleted_at is null) then raise exception 'CHAT_INVALID_REPLY'; end if;
    perform pg_advisory_xact_lock(hashtextextended('xelay-publication-send:' || auth.uid()::text,0));
  end if;
  if v_cover is not null then
    perform public.xelay_chat_validate_avatar(v_cover);
    if exists(select 1 from public.chat_spaces where avatar_path = v_cover) then raise exception 'CHAT_INVALID_MEDIA'; end if;
  end if;
  v_body := public.xelay_chat_publication_summary(p_kind,v_content);
  if p_space_id is not null then
    v_post_id := public.xelay_chat_send(p_space_id,v_body,p_parent_post_id,p_reply_to,null,'[]'::jsonb);
  else
    if (select count(*) from public.messages where sender_id = auth.uid() and created_at > clock_timestamp() - interval '1 minute') >= 30 then raise exception 'CHAT_RATE_LIMIT'; end if;
    insert into public.messages(conversation_id,sender_id,recipient_id,body,reply_to_message_id)
      values(p_conversation_id,auth.uid(),v_recipient,v_body,p_reply_to) returning id into v_message_id;
  end if;
  insert into public.chat_publications(kind,author_id,post_id,message_id,content)
    values(p_kind,auth.uid(),v_post_id,v_message_id,v_content) returning id into v_id;
  return public.xelay_chat_publication_json(v_id);
end $$;

-- Caller retries and cleanup workers use the Storage API, never DELETE storage.objects as file deletion.
create or replace function public.xelay_private_media_cleanup_paths(p_bucket_id text,p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp as $$
begin
  if auth.uid() is null then raise exception 'CHAT_AUTH_REQUIRED'; end if;
  if p_bucket_id not in('xelay-message-media','xelay-chat-media') or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'CHAT_INVALID_INPUT';
  end if;
  return coalesce((select jsonb_agg(jsonb_build_object('storage_path',o.name)) from (
    select o.name from storage.objects o where o.bucket_id=p_bucket_id and public.xelay_private_can_remove_media(o.bucket_id,o.name)
      and (o.created_at<clock_timestamp()-interval '1 hour'
        or exists(select 1 from public.private_media_cleanup r where r.bucket_id=o.bucket_id and r.storage_path=o.name and r.object_id=o.id))
      order by o.created_at,o.id limit p_limit) o),'[]'::jsonb);
end $$;

-- A Storage service delete requires this exact object/version claim. A new object at the same path is protected.
create or replace function public.xelay_private_media_cleanup_claim(p_bucket_id text,p_storage_path text,p_object_id uuid)
returns boolean language plpgsql security definer set search_path = public,pg_temp as $$
declare v_object storage.objects%rowtype;
begin
  if p_bucket_id not in('xelay-message-media','xelay-chat-media') or p_object_id is null then return false; end if;
  select * into v_object from storage.objects where bucket_id=p_bucket_id and name=p_storage_path and id=p_object_id for update;
  if not found or coalesce(v_object.updated_at,v_object.created_at)>clock_timestamp()-interval '1 hour'
    or public.xelay_private_media_attached(p_bucket_id,p_storage_path) then return false; end if;
  if exists(select 1 from public.private_media_cleanup_claims where bucket_id=p_bucket_id and storage_path=p_storage_path
    and expires_at>clock_timestamp() and object_id=v_object.id
    and object_updated_at is not distinct from coalesce(v_object.updated_at,v_object.created_at)
    and object_version is not distinct from to_jsonb(v_object)->>'version') then return false; end if;
  insert into public.private_media_cleanup_claims(bucket_id,storage_path,object_id,object_updated_at,object_version)
    values(p_bucket_id,p_storage_path,p_object_id,coalesce(v_object.updated_at,v_object.created_at),to_jsonb(v_object)->>'version')
    on conflict(bucket_id,storage_path) do update set object_id=excluded.object_id,
      object_updated_at=excluded.object_updated_at,object_version=excluded.object_version,expires_at=clock_timestamp()+interval '5 minutes';
  return true;
end $$;

-- Bounded accounting maintenance; retained content and live upload/cleanup leases are untouched.
create or replace function public.xelay_private_media_maintenance()
returns void language plpgsql security definer set search_path = public,pg_temp as $$
begin
  delete from public.private_media_upload_events where ctid in (
    select ctid from public.private_media_upload_events where uploaded_at<clock_timestamp()-interval '7 days' limit 1000);
  delete from public.private_chat_cancel_events where ctid in (
    select ctid from public.private_chat_cancel_events where cancelled_at<clock_timestamp()-interval '7 days' limit 1000);
  delete from public.private_media_upload_reservations where ctid in (
    select ctid from public.private_media_upload_reservations where expires_at<=clock_timestamp() limit 1000);
  delete from public.private_media_cleanup_claims where ctid in (
    select ctid from public.private_media_cleanup_claims where expires_at<=clock_timestamp() limit 1000);
  delete from public.private_media_cleanup where ctid in (
    select r.ctid from public.private_media_cleanup r where not exists(select 1 from storage.objects o
      where o.bucket_id=r.bucket_id and o.name=r.storage_path and o.id=r.object_id
        and public.xelay_private_object_owner(to_jsonb(o))=r.owner_id) limit 1000);
end $$;

create or replace function public.xelay_private_media_cleanup_candidates(p_before timestamptz default clock_timestamp()-interval '1 day',p_limit integer default 100)
returns jsonb language plpgsql stable security definer set search_path = public,pg_temp as $$
begin
  if p_before is null or not isfinite(p_before) or p_before>clock_timestamp()-interval '1 hour'
    or p_limit is null or p_limit not between 1 and 100 then raise exception 'CHAT_INVALID_INPUT'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object('bucket_id',o.bucket_id,'name',o.name,'object_id',o.id)) from (
    select o.bucket_id,o.name,o.id from storage.objects o where o.bucket_id in('xelay-message-media','xelay-chat-media')
      and o.created_at<p_before and coalesce(o.updated_at,o.created_at)<p_before and not public.xelay_private_media_attached(o.bucket_id,o.name)
      and not exists(select 1 from public.private_media_cleanup_claims c where c.bucket_id=o.bucket_id and c.storage_path=o.name and c.expires_at>clock_timestamp())
      order by o.created_at,o.id limit p_limit) o),'[]'::jsonb);
end $$;

-- Consume seminar receipts on actual object deletion and invalidate them before a replacement version is inserted.
-- Existing UI acknowledgement remains idempotent after automatic consumption.
create or replace function public.xelay_ack_seminar_file_cleanup(p_storage_path text)
returns void language plpgsql security definer set search_path = public,pg_temp as $$
declare v_group_id uuid:=public.xelay_homework_file_group(p_storage_path);
begin
  if auth.uid() is null or v_group_id is null then raise exception 'SEMINAR_RESOURCE_FORBIDDEN' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || v_group_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminar-file:' || p_storage_path,0));
  if exists(select 1 from storage.objects where bucket_id='xelay-seminar-files' and name=p_storage_path)
    or exists(select 1 from public.study_group_seminars where resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_storage_path))) then
    raise exception 'SEMINAR_RESOURCE_CLEANUP_PENDING';
  end if;
  if exists(select 1 from public.study_group_seminar_file_cleanup where storage_path=p_storage_path)
    and not exists(select 1 from public.study_group_seminar_file_cleanup where storage_path=p_storage_path
      and (cleanup_user_id=auth.uid() or owner_id=auth.uid())) then raise exception 'SEMINAR_RESOURCE_FORBIDDEN' using errcode='42501'; end if;
  delete from public.study_group_seminar_file_cleanup where storage_path=p_storage_path
    and (cleanup_user_id=auth.uid() or owner_id=auth.uid());
end $$;

drop policy if exists "Conversation members can upload their private message media" on storage.objects;
create policy "Conversation members can upload their private message media" on storage.objects for insert to authenticated
  with check(bucket_id='xelay-message-media' and public.xelay_private_can_upload_media(bucket_id,name));
drop policy if exists "Conversation members can view attached private message media" on storage.objects;
create policy "Conversation members can view attached private message media" on storage.objects for select to authenticated
  using(bucket_id='xelay-message-media' and public.xelay_private_can_read_media_row(bucket_id,name,to_jsonb(objects)));
drop policy if exists "Uploaders can remove their private message media" on storage.objects;
create policy "Uploaders can remove their private message media" on storage.objects for delete to authenticated
  using(bucket_id='xelay-message-media' and public.xelay_private_can_remove_media(bucket_id,name));

create policy "Private media read boundary" on storage.objects as restrictive for select to anon,authenticated
  using(bucket_id not in('xelay-message-media','xelay-chat-media') or public.xelay_private_can_read_media_row(bucket_id,name,to_jsonb(objects)));
drop policy if exists "Read accessible chat media" on storage.objects;
create policy "Read accessible chat media" on storage.objects for select to authenticated
  using(bucket_id='xelay-chat-media' and public.xelay_private_can_read_media_row(bucket_id,name,to_jsonb(objects)));
drop policy if exists "Chat media read guard" on storage.objects;
create policy "Chat media read guard" on storage.objects as restrictive for select to authenticated
  using(bucket_id<>'xelay-chat-media' or public.xelay_private_can_read_media_row(bucket_id,name,to_jsonb(objects)));
create policy "Private media delete boundary" on storage.objects as restrictive for delete to anon,authenticated
  using(bucket_id not in('xelay-message-media','xelay-chat-media') or public.xelay_private_can_remove_media(bucket_id,name));
create policy "Private media upload boundary" on storage.objects as restrictive for insert to anon,authenticated
  with check(bucket_id not in('xelay-message-media','xelay-chat-media') or public.xelay_private_can_upload_media(bucket_id,name));
create policy "Private media overwrite boundary" on storage.objects as restrictive for update to anon,authenticated
  using(bucket_id not in('xelay-message-media','xelay-chat-media')) with check(bucket_id not in('xelay-message-media','xelay-chat-media'));
create policy "Seminar cleanup version overwrite boundary" on storage.objects as restrictive for update to anon,authenticated
  using(bucket_id<>'xelay-seminar-files') with check(bucket_id<>'xelay-seminar-files');

do $$ declare v_function record;
begin
  for v_function in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    where n.nspname='public' and (starts_with(p.proname,'xelay_private_') or p.proname='xelay_send_direct_message') loop
    execute format('revoke all on function %s from public,anon,authenticated,service_role',v_function.signature);
  end loop;
end $$;
grant execute on function public.xelay_private_safe_timestamp(timestamptz),public.xelay_private_poll_date_valid(jsonb) to authenticated;
grant execute on function public.xelay_private_can_read_media(text,text),public.xelay_private_can_remove_media(text,text),
  public.xelay_private_can_upload_media(text,text),public.xelay_private_can_read_media_row(text,text,jsonb) to anon,authenticated;
grant execute on function public.xelay_send_direct_message(uuid,uuid,text,uuid,jsonb),
  public.xelay_private_media_cleanup_paths(text,integer),public.xelay_private_reserve_media(text,text) to authenticated;
grant execute on function public.xelay_private_media_cleanup_candidates(timestamptz,integer),
  public.xelay_private_media_cleanup_claim(text,text,uuid),public.xelay_private_media_maintenance() to service_role;
-- CREATE OR REPLACE retains the existing authenticated-only ACL of public chat/publish/ack RPCs.
revoke all on function public.xelay_chat_validate_avatar(text) from public,anon,authenticated,service_role;

comment on table public.private_media_cleanup is 'Version-bound detached-file cleanup authorization; no client table access and no Realtime publication.';
comment on table public.private_media_upload_events is 'Private upload rate accounting; deletion/reupload does not reset the daily quota.';
comment on function public.xelay_private_media_cleanup_candidates(timestamptz,integer) is
  'Service-only bounded TTL candidates. Delete through the Storage API; Storage guards reject files attached after listing.';
notify pgrst,'reload schema';
commit;
