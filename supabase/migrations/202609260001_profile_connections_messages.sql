-- Profile details and private conversations for Xelay.

alter table public.profiles
  add column if not exists faculty text not null default '',
  add column if not exists specialty text not null default '',
  add column if not exists study_year smallint,
  add column if not exists skills text[] not null default '{}',
  add column if not exists help_with text[] not null default '{}',
  add column if not exists want_to_learn text[] not null default '{}';

create table if not exists public.connection_requests (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending'
    check (status in ('pending', 'accepted', 'rejected')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint connection_requests_no_self check (requester_id <> recipient_id)
);

create unique index if not exists connection_requests_active_pair_unique
  on public.connection_requests (
    (least(requester_id, recipient_id)),
    (greatest(requester_id, recipient_id))
  )
  where status in ('pending', 'accepted');

create index if not exists connection_requests_recipient_status_idx
  on public.connection_requests (recipient_id, status, created_at desc);

create table if not exists public.conversations (
  id uuid primary key default gen_random_uuid(),
  user_one_id uuid not null references public.profiles(id) on delete cascade,
  user_two_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint conversations_distinct_users check (user_one_id < user_two_id),
  constraint conversations_pair_unique unique (user_one_id, user_two_id)
);

create table if not exists public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  sender_id uuid not null references public.profiles(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  body text not null check (length(btrim(body)) > 0 and length(body) <= 5000),
  created_at timestamptz not null default now(),
  read_at timestamptz,
  constraint messages_distinct_users check (sender_id <> recipient_id)
);

create index if not exists messages_conversation_created_idx
  on public.messages (conversation_id, created_at desc);
create index if not exists messages_unread_recipient_idx
  on public.messages (recipient_id, created_at desc)
  where read_at is null;

alter table public.connection_requests enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;

drop policy if exists "Participants can view connection requests" on public.connection_requests;
create policy "Participants can view connection requests"
  on public.connection_requests for select to authenticated
  using (auth.uid() = requester_id or auth.uid() = recipient_id);

drop policy if exists "Users can send their own connection requests" on public.connection_requests;
create policy "Users can send their own connection requests"
  on public.connection_requests for insert to authenticated
  with check (auth.uid() = requester_id and status = 'pending');

drop policy if exists "Conversation members can view conversations" on public.conversations;
create policy "Conversation members can view conversations"
  on public.conversations for select to authenticated
  using (auth.uid() = user_one_id or auth.uid() = user_two_id);

drop policy if exists "Conversation members can view messages" on public.messages;
create policy "Conversation members can view messages"
  on public.messages for select to authenticated
  using (
    auth.uid() in (sender_id, recipient_id)
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and auth.uid() in (c.user_one_id, c.user_two_id)
        and sender_id in (c.user_one_id, c.user_two_id)
        and recipient_id in (c.user_one_id, c.user_two_id)
    )
  );

drop policy if exists "Conversation members can send messages" on public.messages;
create policy "Conversation members can send messages"
  on public.messages for insert to authenticated
  with check (
    auth.uid() = sender_id
    and read_at is null
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_id
        and ((c.user_one_id = sender_id and c.user_two_id = recipient_id)
          or (c.user_two_id = sender_id and c.user_one_id = recipient_id))
    )
  );

drop policy if exists "Recipients can mark messages as read" on public.messages;
create policy "Recipients can mark messages as read"
  on public.messages for update to authenticated
  using (auth.uid() = recipient_id)
  with check (auth.uid() = recipient_id and read_at is not null);

revoke all on public.connection_requests, public.conversations, public.messages
  from public, anon, authenticated;
grant select, insert on public.connection_requests to authenticated;
grant select on public.conversations to authenticated;
grant select, insert on public.messages to authenticated;
grant update (read_at) on public.messages to authenticated;

create or replace function public.send_connection_request(p_recipient_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;
  if p_recipient_id is null or p_recipient_id = auth.uid() then
    raise exception 'A connection request must target another user';
  end if;

  select id into v_request_id
  from public.connection_requests
  where status in ('pending', 'accepted')
    and ((requester_id = auth.uid() and recipient_id = p_recipient_id)
      or (requester_id = p_recipient_id and recipient_id = auth.uid()))
  order by created_at desc
  limit 1;

  if v_request_id is not null then
    return v_request_id;
  end if;

  insert into public.connection_requests (requester_id, recipient_id)
  values (auth.uid(), p_recipient_id)
  returning id into v_request_id;

  return v_request_id;
exception when unique_violation then
  select id into v_request_id
  from public.connection_requests
  where status in ('pending', 'accepted')
    and ((requester_id = auth.uid() and recipient_id = p_recipient_id)
      or (requester_id = p_recipient_id and recipient_id = auth.uid()))
  order by created_at desc
  limit 1;
  return v_request_id;
end;
$$;

create or replace function public.accept_connection_request(p_request_id uuid)
returns uuid
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_request public.connection_requests%rowtype;
  v_user_one uuid;
  v_user_two uuid;
  v_conversation_id uuid;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select * into v_request
  from public.connection_requests
  where id = p_request_id
  for update;

  if not found or v_request.recipient_id <> auth.uid() then
    raise exception 'Connection request not found';
  end if;
  if v_request.status = 'accepted' then
    select id into v_conversation_id from public.conversations
    where user_one_id = least(v_request.requester_id, v_request.recipient_id)
      and user_two_id = greatest(v_request.requester_id, v_request.recipient_id);
    return v_conversation_id;
  end if;
  if v_request.status <> 'pending' then
    raise exception 'Connection request is no longer pending';
  end if;

  update public.connection_requests
  set status = 'accepted', updated_at = now()
  where id = p_request_id;

  v_user_one := least(v_request.requester_id, v_request.recipient_id);
  v_user_two := greatest(v_request.requester_id, v_request.recipient_id);

  insert into public.conversations (user_one_id, user_two_id)
  values (v_user_one, v_user_two)
  on conflict (user_one_id, user_two_id) do nothing
  returning id into v_conversation_id;

  if v_conversation_id is null then
    select id into v_conversation_id from public.conversations
    where user_one_id = v_user_one and user_two_id = v_user_two;
  end if;

  return v_conversation_id;
end;
$$;

create or replace function public.reject_connection_request(p_request_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  update public.connection_requests
  set status = 'rejected', updated_at = now()
  where id = p_request_id
    and recipient_id = auth.uid()
    and status = 'pending';

  if not found then
    raise exception 'Connection request not found or no longer pending';
  end if;
end;
$$;

revoke all on function public.send_connection_request(uuid) from public;
revoke all on function public.accept_connection_request(uuid) from public;
revoke all on function public.reject_connection_request(uuid) from public;
grant execute on function public.send_connection_request(uuid) to authenticated;
grant execute on function public.accept_connection_request(uuid) to authenticated;
grant execute on function public.reject_connection_request(uuid) to authenticated;

-- Keep notifications consistent with the existing notification panel.
create or replace function public.notify_connection_request()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_name text;
begin
  select full_name into v_actor_name from public.profiles where id = new.requester_id;
  insert into public.notifications (recipient_id, actor_id, actor_name, type, message, is_read)
  values (new.recipient_id, new.requester_id, coalesce(nullif(v_actor_name, ''), 'Учасник'),
    'connection_request', 'надіслав(-ла) вам запит на спілкування', false);
  return new;
end;
$$;

drop trigger if exists connection_request_notification on public.connection_requests;
create trigger connection_request_notification
  after insert on public.connection_requests
  for each row execute function public.notify_connection_request();

create or replace function public.notify_connection_accepted()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_name text;
begin
  if old.status = 'pending' and new.status = 'accepted' then
    select full_name into v_actor_name from public.profiles where id = new.recipient_id;
    insert into public.notifications (recipient_id, actor_id, actor_name, type, message, is_read)
    values (new.requester_id, new.recipient_id, coalesce(nullif(v_actor_name, ''), 'Учасник'),
      'connection_accepted', 'прийняв(-ла) ваш запит на спілкування', false);
  end if;
  return new;
end;
$$;

drop trigger if exists connection_accepted_notification on public.connection_requests;
create trigger connection_accepted_notification
  after update of status on public.connection_requests
  for each row execute function public.notify_connection_accepted();

create or replace function public.notify_new_message()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_actor_name text;
begin
  select full_name into v_actor_name from public.profiles where id = new.sender_id;
  insert into public.notifications (recipient_id, actor_id, actor_name, type, message, is_read)
  values (new.recipient_id, new.sender_id, coalesce(nullif(v_actor_name, ''), 'Учасник'),
    'message', 'надіслав(-ла) вам повідомлення', false);
  return new;
end;
$$;

drop trigger if exists message_notification on public.messages;
create trigger message_notification
  after insert on public.messages
  for each row execute function public.notify_new_message();
