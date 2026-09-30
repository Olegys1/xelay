-- Several private files and resource links for one dated lesson.
-- Apply after participant billing and 202610010001_lesson_topics.sql.
begin;

do $$
begin
  if to_regclass('public.study_group_homework') is null
    or not exists (select 1 from information_schema.columns
      where table_schema = 'public' and table_name = 'study_group_homework' and column_name = 'lesson_topic')
    or to_regprocedure('public.xelay_is_study_group_representative(uuid)') is null
    or to_regprocedure('public.xelay_group_has_access(uuid)') is null
    or to_regprocedure('public.xelay_validate_group_license_write()') is null
    or to_regprocedure('public.xelay_notify_study_group_homework()') is null then
    raise exception 'Apply participant billing and lesson topics before homework resources';
  end if;
end;
$$;

alter table public.study_group_homework
  add column if not exists resource_links jsonb not null default '[]'::jsonb,
  add column if not exists attachments jsonb not null default '[]'::jsonb;

-- Parse only complete, bounded paths, so arbitrary policy inputs cannot cause
-- UUID cast errors. The final filename includes its extension in the 180 limit.
create or replace function public.xelay_homework_file_group(p_name text)
returns uuid
language plpgsql immutable
set search_path = public, pg_temp
as $$
begin
  if p_name is null or length(p_name) > 512
    or p_name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-[A-Za-z0-9][A-Za-z0-9._-]{0,179}$'
    or p_name !~* '[.](pdf|doc|docx|xls|xlsx|ppt|pptx|txt|csv|jpg|jpeg|png|webp|zip)$' then
    return null;
  end if;
  return split_part(p_name, '/', 1)::uuid;
end;
$$;

create or replace function public.xelay_homework_file_mime_allowed(p_name text, p_mime text)
returns boolean
language sql immutable
set search_path = public, pg_temp
as $$
  select coalesce(case lower(substring(p_name from '[.]([^.]*)$'))
    when 'pdf' then p_mime = 'application/pdf'
    when 'doc' then p_mime = 'application/msword'
    when 'docx' then p_mime = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    when 'xls' then p_mime = 'application/vnd.ms-excel'
    when 'xlsx' then p_mime = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    when 'ppt' then p_mime = 'application/vnd.ms-powerpoint'
    when 'pptx' then p_mime = 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    when 'txt' then p_mime = 'text/plain'
    when 'csv' then p_mime = 'text/csv'
    when 'jpg' then p_mime = 'image/jpeg'
    when 'jpeg' then p_mime = 'image/jpeg'
    when 'png' then p_mime = 'image/png'
    when 'webp' then p_mime = 'image/webp'
    when 'zip' then p_mime in ('application/zip', 'application/x-zip-compressed')
    else false
  end, false);
$$;

create or replace function public.xelay_homework_resources_valid(
  p_group_id uuid, p_resource_links jsonb, p_attachments jsonb
)
returns boolean
language plpgsql immutable
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_value text;
  v_paths text[] := array[]::text[];
begin
  if p_group_id is null
    or jsonb_typeof(p_resource_links) is distinct from 'array'
    or jsonb_typeof(p_attachments) is distinct from 'array' then return false; end if;
  if jsonb_array_length(p_resource_links) > 10 or jsonb_array_length(p_attachments) > 10 then return false; end if;
  for v_item in select value from jsonb_array_elements(p_resource_links) loop
    if jsonb_typeof(v_item) is distinct from 'string' then return false; end if;
    v_value := v_item #>> '{}';
    if length(v_value) not between 1 and 2048
      or v_value !~* '^https?://[^[:space:]/?#]+([/?#][^[:space:]]*)?$' then return false; end if;
  end loop;
  for v_item in select value from jsonb_array_elements(p_attachments) loop
    if jsonb_typeof(v_item) is distinct from 'object' then return false; end if;
    if not (v_item ?& array['storage_path', 'file_name', 'mime_type', 'file_size'])
      or (v_item - array['storage_path', 'file_name', 'mime_type', 'file_size']) <> '{}'::jsonb
      or jsonb_typeof(v_item -> 'storage_path') is distinct from 'string'
      or jsonb_typeof(v_item -> 'file_name') is distinct from 'string'
      or jsonb_typeof(v_item -> 'mime_type') is distinct from 'string'
      or jsonb_typeof(v_item -> 'file_size') is distinct from 'number' then return false; end if;
    v_value := v_item ->> 'storage_path';
    if public.xelay_homework_file_group(v_value) is distinct from p_group_id
      or v_value = any(v_paths)
      or length(btrim(v_item ->> 'file_name')) not between 1 and 255
      or (v_item ->> 'file_name') ~ '[[:cntrl:]/\\]'
      or length(v_item ->> 'mime_type') not between 1 and 120
      or not public.xelay_homework_file_mime_allowed(v_value, v_item ->> 'mime_type')
      or not public.xelay_homework_file_mime_allowed(v_item ->> 'file_name', v_item ->> 'mime_type')
      or (v_item ->> 'file_size') !~ '^[0-9]+$' then return false; end if;
    if (v_item ->> 'file_size')::numeric not between 1 and 20971520 then return false; end if;
    v_paths := array_append(v_paths, v_value);
  end loop;
  return true;
end;
$$;

alter table public.study_group_homework
  drop constraint if exists study_group_homework_resources_check,
  drop constraint if exists study_group_homework_content_check;
alter table public.study_group_homework
  add constraint study_group_homework_resources_check
    check (public.xelay_homework_resources_valid(group_id, resource_links, attachments)),
  add constraint study_group_homework_content_check check (
    length(btrim(body)) > 0
    or coalesce(length(btrim(lesson_topic)), 0) > 0
    or nullif(btrim(url), '') is not null
    or jsonb_array_length(resource_links) > 0
    or jsonb_array_length(attachments) > 0
  );

create index if not exists study_group_homework_attachments_idx
  on public.study_group_homework using gin (attachments jsonb_path_ops);

-- Match xelay_validate_group_license_write and group billing can_edit exactly.
-- Payment enforcement remains an explicit existing platform setting.
create or replace function public.xelay_can_edit_homework_resources(p_group_id uuid)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and public.xelay_is_study_group_representative(p_group_id)
    and exists (select 1 from public.billing_settings b where b.singleton
      and (not b.enforce_group_payment or public.xelay_group_has_access(p_group_id)));
$$;

create or replace function public.xelay_can_upload_homework_file(p_name text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select public.xelay_homework_file_group(p_name) is not null
    and split_part(p_name, '/', 2) = auth.uid()::text
    and public.xelay_can_edit_homework_resources(public.xelay_homework_file_group(p_name));
$$;

-- SECURITY DEFINER avoids a storage -> homework RLS -> storage recursion.
-- Membership checks intentionally accept only accepted members and the rep.
create or replace function public.xelay_can_read_homework_file(p_name text)
returns boolean
language sql stable security definer
set search_path = public, pg_temp
as $$
  select auth.uid() is not null
    and public.xelay_homework_file_group(p_name) is not null
    and (
      (split_part(p_name, '/', 2) = auth.uid()::text
        and public.xelay_is_study_group_representative(public.xelay_homework_file_group(p_name)))
      or exists (
        select 1 from public.study_group_homework h
        where h.group_id = public.xelay_homework_file_group(p_name)
          and h.attachments @> jsonb_build_array(jsonb_build_object('storage_path', p_name))
          and (public.xelay_is_study_group_representative(h.group_id)
            or exists (select 1 from public.study_group_members m
              where m.group_id = h.group_id and m.user_id = auth.uid() and m.status = 'accepted'))
      )
    );
$$;

create or replace function public.xelay_can_remove_homework_file(p_name text)
returns boolean
language plpgsql volatile security definer
set search_path = public, pg_temp
as $$
begin
  if not coalesce(public.xelay_can_upload_homework_file(p_name), false) then return false; end if;
  -- The validator takes the same lock before publishing a descriptor. A fresh
  -- query after waiting must see a concurrently committed homework reference;
  -- a STABLE helper or object row lock alone would use an earlier snapshot.
  perform pg_advisory_xact_lock(hashtextextended('xelay:homework-file:' || p_name, 0));
  return not exists (select 1 from public.study_group_homework h
    where h.attachments @> jsonb_build_array(jsonb_build_object('storage_path', p_name)));
end;
$$;

-- All descriptors must reference actual completed uploads with matching server
-- metadata. A new rep may retain an unchanged earlier rep's descriptor, but
-- every new descriptor belongs to this rep and this group.
create or replace function public.xelay_validate_homework_resources()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_item jsonb;
  v_path text;
  v_metadata jsonb;
  v_existing boolean;
begin
  if not public.xelay_homework_resources_valid(new.group_id, new.resource_links, new.attachments) then
    raise exception 'Invalid homework resource links or attachments' using errcode = '23514';
  end if;
  if (tg_op = 'INSERT' and jsonb_array_length(new.attachments) > 0)
    or (tg_op = 'UPDATE' and new.attachments is distinct from old.attachments) then
    if not public.xelay_can_edit_homework_resources(new.group_id) then
      raise exception 'Editable group representative permission required' using errcode = '42501';
    end if;
  end if;
  -- Lock the complete set in deterministic order before validating uploads.
  -- Reordering files in two concurrent editors cannot reverse this lock order.
  for v_path in select value ->> 'storage_path' from jsonb_array_elements(new.attachments)
    order by value ->> 'storage_path' loop
    perform pg_advisory_xact_lock(hashtextextended('xelay:homework-file:' || v_path, 0));
  end loop;
  for v_item in select value from jsonb_array_elements(new.attachments) loop
    v_existing := false;
    if tg_op = 'UPDATE' and new.group_id = old.group_id then
      v_existing := old.attachments @> jsonb_build_array(v_item);
    end if;
    if not v_existing and split_part(v_item ->> 'storage_path', '/', 2) is distinct from auth.uid()::text then
      raise exception 'New homework files must belong to the current group representative' using errcode = '42501';
    end if;
    select o.metadata into v_metadata from storage.objects o
      where o.bucket_id = 'xelay-homework-files' and o.name = v_item ->> 'storage_path'
      for key share;
    if not found then
      raise exception 'Homework attachment upload is missing' using errcode = '23514';
    end if;
    if coalesce(v_metadata ->> 'size', '') !~ '^[0-9]+$'
      or (v_metadata ->> 'mimetype') is distinct from (v_item ->> 'mime_type') then
      raise exception 'Homework attachment metadata does not match its upload' using errcode = '23514';
    end if;
    if (v_metadata ->> 'size')::numeric <> (v_item ->> 'file_size')::numeric then
      raise exception 'Homework attachment size does not match its upload' using errcode = '23514';
    end if;
  end loop;
  -- Existing legacy-only url values are untouched until their resources change.
  if jsonb_array_length(new.resource_links) > 0 then
    new.url := new.resource_links ->> 0;
  elsif tg_op = 'UPDATE' and new.resource_links is distinct from old.resource_links then
    new.url := null;
  end if;
  return new;
end;
$$;

drop trigger if exists study_group_homework_resources_validate on public.study_group_homework;
create trigger study_group_homework_resources_validate
  before insert or update on public.study_group_homework
  for each row execute function public.xelay_validate_homework_resources();

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('xelay-homework-files', 'xelay-homework-files', false, 20971520, array[
  'application/pdf', 'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain', 'text/csv', 'image/jpeg', 'image/png', 'image/webp',
  'application/zip', 'application/x-zip-compressed'
])
on conflict (id) do update set public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists "Representatives upload private homework files" on storage.objects;
create policy "Representatives upload private homework files"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'xelay-homework-files' and public.xelay_can_upload_homework_file(name));
drop policy if exists "Participants read attached homework files" on storage.objects;
create policy "Participants read attached homework files"
  on storage.objects for select to authenticated
  using (bucket_id = 'xelay-homework-files' and public.xelay_can_read_homework_file(name));
drop policy if exists "Representatives remove unused homework files" on storage.objects;
create policy "Representatives remove unused homework files"
  on storage.objects for delete to authenticated
  using (bucket_id = 'xelay-homework-files' and public.xelay_can_remove_homework_file(name));

-- Restrictive guards isolate this bucket from permissive legacy policies.
-- They give no access to anonymous users and leave other buckets unchanged.
drop policy if exists "Homework file upload guard" on storage.objects;
create policy "Homework file upload guard"
  on storage.objects as restrictive for insert to anon, authenticated
  with check (bucket_id <> 'xelay-homework-files' or public.xelay_can_upload_homework_file(name));
drop policy if exists "Homework file read guard" on storage.objects;
create policy "Homework file read guard"
  on storage.objects as restrictive for select to anon, authenticated
  using (bucket_id <> 'xelay-homework-files' or public.xelay_can_read_homework_file(name));
drop policy if exists "Homework file removal guard" on storage.objects;
create policy "Homework file removal guard"
  on storage.objects as restrictive for delete to anon, authenticated
  using (bucket_id <> 'xelay-homework-files' or public.xelay_can_remove_homework_file(name));
drop policy if exists "Homework file overwrite guard" on storage.objects;
create policy "Homework file overwrite guard"
  on storage.objects as restrictive for update to anon, authenticated
  using (bucket_id <> 'xelay-homework-files')
  with check (bucket_id <> 'xelay-homework-files');

create or replace function public.xelay_notify_study_group_homework()
returns trigger
language plpgsql security definer
set search_path = public, pg_temp
as $$
declare
  v_subject text;
  v_actor_name text;
  v_message text;
  v_member record;
begin
  if tg_op = 'UPDATE'
    and old.body is not distinct from new.body
    and old.url is not distinct from new.url
    and old.lesson_topic is not distinct from new.lesson_topic
    and old.resource_links is not distinct from new.resource_links
    and old.attachments is not distinct from new.attachments then
    return new;
  end if;
  select subject into v_subject from public.study_group_schedule where id = new.schedule_item_id;
  select full_name into v_actor_name from public.profiles where id = new.created_by;
  v_message := case when tg_op = 'INSERT'
      then 'додав(-ла) інформацію про заняття: '
      else 'оновив(-ла) інформацію про заняття: '
    end
    || coalesce(v_subject, 'Заняття')
    || ' (' || to_char(new.lesson_date, 'DD.MM.YYYY') || ')'
    || case when nullif(btrim(new.lesson_topic), '') is not null
      then ' — ' || btrim(new.lesson_topic)
      else ''
    end;
  for v_member in
    select user_id from public.study_group_members
    where group_id = new.group_id and status = 'accepted' and user_id <> new.created_by
  loop
    insert into public.notifications (
      recipient_id, actor_id, actor_name, type, message, is_read, study_group_id
    ) values (
      v_member.user_id, new.created_by, coalesce(nullif(v_actor_name, ''), 'Староста'),
      'group_homework', v_message, false, new.group_id
    );
  end loop;
  return new;
end;
$$;

revoke all on function public.xelay_homework_file_group(text),
  public.xelay_homework_file_mime_allowed(text, text),
  public.xelay_homework_resources_valid(uuid, jsonb, jsonb),
  public.xelay_can_edit_homework_resources(uuid),
  public.xelay_can_upload_homework_file(text),
  public.xelay_can_read_homework_file(text),
  public.xelay_can_remove_homework_file(text),
  public.xelay_validate_homework_resources() from public, anon, authenticated;
grant execute on function public.xelay_homework_file_group(text),
  public.xelay_homework_file_mime_allowed(text, text),
  public.xelay_homework_resources_valid(uuid, jsonb, jsonb),
  public.xelay_can_edit_homework_resources(uuid) to authenticated;
-- Anonymous policy evaluation must return false rather than fail due to a
-- function privilege on unrelated buckets. These functions require auth.uid().
grant execute on function public.xelay_can_upload_homework_file(text),
  public.xelay_can_read_homework_file(text),
  public.xelay_can_remove_homework_file(text) to anon, authenticated;

comment on column public.study_group_homework.resource_links is
  'Up to 10 HTTP(S) resources for this dated lesson; url mirrors the first new resource and keeps legacy values.';
comment on column public.study_group_homework.attachments is
  'Up to 10 private xelay-homework-files descriptors: storage_path, file_name, mime_type, file_size. Upload first, save row, then remove unused objects via Storage API.';

notify pgrst, 'reload schema';
commit;
