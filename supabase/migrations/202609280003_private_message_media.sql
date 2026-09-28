-- Private image and video attachments for accepted conversations.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'xelay-message-media',
  'xelay-message-media',
  false,
  26214400,
  array['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'video/mp4', 'video/webm', 'video/quicktime']
)
on conflict (id) do update
set public = false,
    file_size_limit = excluded.file_size_limit,
    allowed_mime_types = excluded.allowed_mime_types;

create table if not exists public.message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.messages(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  uploaded_by uuid not null references public.profiles(id) on delete cascade,
  storage_path text not null unique,
  file_name text not null check (length(file_name) between 1 and 255),
  media_type text not null check (media_type in ('image', 'video')),
  mime_type text not null check (
    mime_type in ('image/jpeg', 'image/png', 'image/webp', 'image/gif',
      'video/mp4', 'video/webm', 'video/quicktime')
  ),
  created_at timestamptz not null default now()
);

create index if not exists message_attachments_message_idx
  on public.message_attachments (message_id, created_at);

alter table public.message_attachments enable row level security;

drop policy if exists "Conversation members can view private message attachments" on public.message_attachments;
create policy "Conversation members can view private message attachments"
  on public.message_attachments for select to authenticated
  using (
    exists (
      select 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_attachments.message_id
        and m.conversation_id = message_attachments.conversation_id
        and m.deleted_at is null
        and auth.uid() in (c.user_one_id, c.user_two_id)
    )
  );

drop policy if exists "Senders can attach media to their messages" on public.message_attachments;
create policy "Senders can attach media to their messages"
  on public.message_attachments for insert to authenticated
  with check (
    uploaded_by = auth.uid()
    and (storage.foldername(message_attachments.storage_path))[2] = auth.uid()::text
    and (storage.foldername(message_attachments.storage_path))[3] = message_attachments.message_id::text
    and (storage.foldername(message_attachments.storage_path))[1] = message_attachments.conversation_id::text
    and exists (
      select 1
      from public.messages m
      join public.conversations c on c.id = m.conversation_id
      where m.id = message_attachments.message_id
        and m.conversation_id = message_attachments.conversation_id
        and m.sender_id = auth.uid()
        and m.deleted_at is null
        and auth.uid() in (c.user_one_id, c.user_two_id)
    )
  );

revoke all on public.message_attachments from public, anon, authenticated;
grant select, insert on public.message_attachments to authenticated;

drop policy if exists "Conversation members can upload their private message media" on storage.objects;
create policy "Conversation members can upload their private message media"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'xelay-message-media'
    and (storage.foldername(name))[2] = auth.uid()::text
    and exists (
      select 1 from public.conversations c
      where c.id::text = (storage.foldername(name))[1]
        and auth.uid() in (c.user_one_id, c.user_two_id)
    )
  );

drop policy if exists "Conversation members can view attached private message media" on storage.objects;
create policy "Conversation members can view attached private message media"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'xelay-message-media'
    and exists (
      select 1
      from public.message_attachments a
      join public.messages m on m.id = a.message_id and m.conversation_id = a.conversation_id
      join public.conversations c on c.id = a.conversation_id
      where a.storage_path = name
        and m.deleted_at is null
        and auth.uid() in (c.user_one_id, c.user_two_id)
    )
  );

drop policy if exists "Uploaders can remove their private message media" on storage.objects;
create policy "Uploaders can remove their private message media"
  on storage.objects for delete to authenticated
  using (
    bucket_id = 'xelay-message-media'
    and (storage.foldername(name))[2] = auth.uid()::text
    and exists (
      select 1 from public.conversations c
      where c.id::text = (storage.foldername(name))[1]
        and auth.uid() in (c.user_one_id, c.user_two_id)
    )
  );

create or replace function public.xelay_remove_deleted_message_attachments()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if old.deleted_at is null and new.deleted_at is not null then
    delete from public.message_attachments where message_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists remove_deleted_message_attachments on public.messages;
create trigger remove_deleted_message_attachments
  after update of deleted_at on public.messages
  for each row execute function public.xelay_remove_deleted_message_attachments();

revoke all on function public.xelay_remove_deleted_message_attachments() from public, anon, authenticated;
