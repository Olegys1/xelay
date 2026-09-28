-- Replies, soft deletion and reactions for private conversation messages.

alter table public.messages
  add column if not exists reply_to_message_id uuid
    references public.messages(id) on delete set null,
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid
    references public.profiles(id) on delete set null;

-- A deleted message keeps its row so existing replies stay meaningful, while
-- its visible text is replaced with an empty value by the delete RPC below.
alter table public.messages drop constraint if exists messages_body_check;
alter table public.messages
  add constraint messages_body_visible_or_deleted_check
  check (
    (deleted_at is not null and length(body) = 0)
    or (deleted_at is null and length(btrim(body)) between 1 and 5000)
  );

create index if not exists messages_reply_to_idx
  on public.messages (reply_to_message_id)
  where reply_to_message_id is not null;

create table if not exists public.message_reactions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  emoji text not null check (emoji in ('👍', '❤️', '😂', '😮', '🙌', '🔥')),
  created_at timestamptz not null default now(),
  constraint message_reactions_one_per_user unique (message_id, user_id)
);

create index if not exists message_reactions_message_idx
  on public.message_reactions (message_id, created_at);

alter table public.message_reactions enable row level security;

drop policy if exists "Conversation members can view message reactions" on public.message_reactions;
create policy "Conversation members can view message reactions"
  on public.message_reactions for select to authenticated
  using (
    exists (
      select 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_id
        and auth.uid() in (c.user_one_id, c.user_two_id)
    )
  );

drop policy if exists "Conversation members can add message reactions" on public.message_reactions;
create policy "Conversation members can add message reactions"
  on public.message_reactions for insert to authenticated
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_id and m.deleted_at is null
        and auth.uid() in (c.user_one_id, c.user_two_id)
    )
  );

drop policy if exists "Users can update their message reactions" on public.message_reactions;
create policy "Users can update their message reactions"
  on public.message_reactions for update to authenticated
  using (
    auth.uid() = user_id
    and exists (
      select 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_id and m.deleted_at is null
        and auth.uid() in (c.user_one_id, c.user_two_id)
    )
  )
  with check (
    auth.uid() = user_id
    and exists (
      select 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_id and m.deleted_at is null
        and auth.uid() in (c.user_one_id, c.user_two_id)
    )
  );

drop policy if exists "Users can remove their message reactions" on public.message_reactions;
create policy "Users can remove their message reactions"
  on public.message_reactions for delete to authenticated
  using (
    auth.uid() = user_id
    and exists (
      select 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_id
        and auth.uid() in (c.user_one_id, c.user_two_id)
    )
  );

revoke all on public.message_reactions from public, anon, authenticated;
grant select, insert, update, delete on public.message_reactions to authenticated;

-- The reply target must belong to the same private conversation. SECURITY
-- DEFINER avoids recursive message-table RLS evaluation in this check.
create or replace function public.xelay_validate_message_reply()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' and (new.deleted_at is not null or new.deleted_by is not null) then
    raise exception 'New messages cannot start in a deleted state';
  end if;

  if new.reply_to_message_id is not null and not exists (
    select 1 from public.messages replied
    where replied.id = new.reply_to_message_id
      and replied.conversation_id = new.conversation_id
  ) then
    raise exception 'Reply target must be in the same conversation';
  end if;
  return new;
end;
$$;

drop trigger if exists validate_message_reply_insert on public.messages;
create trigger validate_message_reply_insert
  before insert on public.messages
  for each row execute function public.xelay_validate_message_reply();

drop trigger if exists validate_message_reply_update on public.messages;
create trigger validate_message_reply_update
  before update of reply_to_message_id, conversation_id on public.messages
  for each row execute function public.xelay_validate_message_reply();

create or replace function public.xelay_delete_message(p_message_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_sender_id uuid;
  v_deleted_at timestamptz;
begin
  if auth.uid() is null then
    raise exception 'Authentication required';
  end if;

  select sender_id, deleted_at into v_sender_id, v_deleted_at
  from public.messages
  where id = p_message_id
  for update;

  if not found or v_sender_id <> auth.uid() then
    raise exception 'Message not found or not sent by you';
  end if;
  if v_deleted_at is not null then
    return;
  end if;

  update public.messages
  set body = '', deleted_at = now(), deleted_by = auth.uid(),
      read_at = coalesce(read_at, now())
  where id = p_message_id;

  delete from public.message_reactions where message_id = p_message_id;
end;
$$;

revoke all on function public.xelay_validate_message_reply() from public, anon, authenticated;
revoke all on function public.xelay_delete_message(uuid) from public, anon;
grant execute on function public.xelay_delete_message(uuid) to authenticated;
