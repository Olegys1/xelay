-- Participant: server-side conversation search and text-only scheduled directs.
-- Apply after 202610070003. Existing media guards/RLS are retained; no history,
-- contact or free chat permissions are changed. Background delivery stays off
-- until a service-only worker has completed its first successful heartbeat.
begin;
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
commit;
