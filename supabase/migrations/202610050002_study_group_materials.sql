-- Private study-group materials: subjects, dated topics, resource links and files.
-- Apply after 202610030002. Does not require unrelated news/media remediation.
-- The existing permission lock remains authoritative for annual/trial access;
-- every academic write (including DELETE) requests an active group license.
begin;

do $$
begin
  if to_regclass('public.study_groups') is null
    or to_regclass('public.study_group_members') is null
    or to_regclass('public.study_group_deputy_requests') is null
    or to_regclass('storage.objects') is null
    or to_regclass('storage.buckets') is null
    or to_regprocedure('public.xelay_lock_study_group_permission(uuid,text,boolean)') is null
    or to_regprocedure('public.xelay_normalize_study_group_permissions(text[])') is null
    or to_regprocedure('public.xelay_is_study_group_representative(uuid)') is null
    or to_regprocedure('public.xelay_is_platform_admin()') is null
    or to_regprocedure('public.xelay_can_view_study_group(uuid)') is null then
    raise exception 'Apply study-group, annual billing, deputy and academic permission migrations through 202610030002 before materials';
  end if;
end;
$$;

-- The new permission is opt-in for deputies. Existing assignments stay intact.
create or replace function public.xelay_normalize_study_group_permissions(p_permissions text[])
returns text[] language plpgsql immutable set search_path = '' as $$
declare v_allowed constant text[]:=array['schedule','homework','seminars','seminar_resources','materials','seminar_comments','invite_members','remove_members'];
begin
  if p_permissions is null or coalesce(array_ndims(p_permissions),1)<>1
    or cardinality(p_permissions)>8
    or exists(select 1 from unnest(p_permissions) as requested(permission)
      where permission is null or not(permission=any(v_allowed))) then
    raise exception 'DEPUTY_INVALID_PERMISSIONS' using errcode='22023';
  end if;
  return array(select p from unnest(v_allowed) with ordinality as allowed(p,n)
    where p=any(p_permissions) order by n);
end;
$$;

create or replace function public.xelay_study_group_permissions(p_group_id uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  select case
    when auth.uid() is null or not exists(select 1 from public.study_groups where id=p_group_id) then '{}'::text[]
    when public.xelay_is_study_group_representative(p_group_id)
      then array['schedule','homework','seminars','seminar_resources','materials','seminar_comments','invite_members','remove_members']::text[]
    else array(
      select allowed.permission
      from unnest(array['schedule','homework','seminars','seminar_resources','materials','seminar_comments','invite_members','remove_members']::text[])
        with ordinality as allowed(permission,position)
      where (allowed.permission in('seminar_comments','invite_members','remove_members') and public.xelay_is_platform_admin())
        or exists(select 1 from public.study_group_deputy_requests d
          join public.study_group_members m on m.group_id=d.group_id and m.user_id=d.user_id and m.status='accepted'
          where d.group_id=p_group_id and d.user_id=auth.uid() and d.status='approved' and allowed.permission=any(d.permissions))
      order by allowed.position)
  end;
$$;

revoke all on function public.xelay_normalize_study_group_permissions(text[]),public.xelay_study_group_permissions(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_normalize_study_group_permissions(text[]) to authenticated,service_role;
grant execute on function public.xelay_study_group_permissions(uuid) to authenticated;

-- Group-details visibility historically includes pending invitations. Private
-- academic materials require actual acceptance, while platform moderation reads
-- retain the existing platform-admin exception. Reads never depend on payment.
create or replace function public.xelay_can_read_study_group_materials(p_group_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and public.xelay_can_view_study_group(p_group_id)
    and (public.xelay_is_platform_admin() or public.xelay_is_study_group_representative(p_group_id)
      or exists(select 1 from public.study_group_members m
        where m.group_id=p_group_id and m.user_id=auth.uid() and m.status='accepted'));
$$;

create or replace function public.xelay_material_file_mime(p_path text)
returns text language sql immutable set search_path = '' as $$
  select case lower(substring(p_path from '\.([a-z0-9]+)$'))
    when 'jpg' then 'image/jpeg' when 'jpeg' then 'image/jpeg'
    when 'png' then 'image/png' when 'webp' then 'image/webp'
    when 'gif' then 'image/gif' when 'avif' then 'image/avif'
    when 'pdf' then 'application/pdf' when 'doc' then 'application/msword'
    when 'docx' then 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    when 'xls' then 'application/vnd.ms-excel'
    when 'xlsx' then 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    when 'ppt' then 'application/vnd.ms-powerpoint'
    when 'pptx' then 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    when 'txt' then 'text/plain' when 'csv' then 'text/csv' when 'zip' then 'application/zip'
    when 'mp3' then 'audio/mpeg' when 'wav' then 'audio/wav' when 'm4a' then 'audio/mp4'
    when 'ogg' then 'audio/ogg' when 'mp4' then 'video/mp4' when 'webm' then 'video/webm'
    when 'mov' then 'video/quicktime' else null end;
$$;

create or replace function public.xelay_material_file_path_valid(p_path text)
returns boolean language sql immutable set search_path = '' as $$
  select coalesce(p_path ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpe?g|png|webp|gif|avif|pdf|docx?|xlsx?|pptx?|txt|csv|zip|mp3|wav|m4a|ogg|mp4|webm|mov)$',false);
$$;

create or replace function public.xelay_material_links_valid(p_links jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_link jsonb;
begin
  if p_links is null or jsonb_typeof(p_links)<>'array' then return false; end if;
  if jsonb_array_length(p_links)>10 then return false; end if;
  for v_link in select value from jsonb_array_elements(p_links) loop
    if jsonb_typeof(v_link)<>'object' or not(v_link ?& array['label','url'])
      or (v_link-array['label','url'])<>'{}'::jsonb
      or jsonb_typeof(v_link->'label')<>'string' or jsonb_typeof(v_link->'url')<>'string'
      or length(v_link->>'label')>120 or length(v_link->>'url') not between 1 and 2048
      or (v_link->>'url') !~* '^https?://[^/?#[:space:]\\@]+([/?#][^[:space:]\\]*)?$'
      or (v_link->>'url') ~ '[[:cntrl:]]' or (v_link->>'label') ~ '[[:cntrl:]]' then return false; end if;
  end loop;
  return true;
end;
$$;

create or replace function public.xelay_material_attachments_valid(p_group_id uuid,p_attachments jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_file jsonb; v_total bigint:=0; v_seen text[]:='{}';
begin
  if p_group_id is null or p_attachments is null or jsonb_typeof(p_attachments)<>'array' then return false; end if;
  if jsonb_array_length(p_attachments)>10 then return false; end if;
  for v_file in select value from jsonb_array_elements(p_attachments) loop
    if jsonb_typeof(v_file)<>'object' or not(v_file ?& array['path','file_name','mime_type','file_size'])
      or (v_file-array['path','file_name','mime_type','file_size'])<>'{}'::jsonb
      or jsonb_typeof(v_file->'path')<>'string' or jsonb_typeof(v_file->'file_name')<>'string'
      or jsonb_typeof(v_file->'mime_type')<>'string' or jsonb_typeof(v_file->'file_size')<>'number'
      or not public.xelay_material_file_path_valid(v_file->>'path')
      or split_part(v_file->>'path','/',1)<>p_group_id::text
      or length(btrim(v_file->>'file_name')) not between 1 and 180
      or (v_file->>'file_name') ~ '[[:cntrl:]/\\]' or (v_file->>'file_name') ~ U&'[\202A-\202E\2066-\2069]'
      or public.xelay_material_file_mime(v_file->>'path') is distinct from v_file->>'mime_type'
      or public.xelay_material_file_mime(v_file->>'file_name') is distinct from v_file->>'mime_type'
      or coalesce(v_file->>'file_size','') !~ '^[0-9]{1,8}$'
      or (v_file->>'path')=any(v_seen) then return false; end if;
    if (v_file->>'file_size')::bigint not between 1 and 52428800 then return false; end if;
    v_total:=v_total+(v_file->>'file_size')::bigint;
    if v_total>209715200 then return false; end if;
    v_seen:=array_append(v_seen,v_file->>'path');
  end loop;
  return true;
end;
$$;

create table if not exists public.study_group_material_subjects(
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.study_groups(id) on delete cascade,
  name text not null check(name=btrim(name) and length(name) between 2 and 180 and name !~ '[[:cntrl:]]'),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(id,group_id)
);
create unique index if not exists study_group_material_subjects_group_name_idx
  on public.study_group_material_subjects(group_id,lower(btrim(name)));
create table if not exists public.study_group_materials(
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.study_groups(id) on delete cascade,
  subject_id uuid not null,
  title text not null check(title=btrim(title) and length(title) between 3 and 240 and title !~ '[[:cntrl:]]'),
  material_date date not null check(isfinite(material_date) and material_date between date '1900-01-01' and date '2200-12-31'),
  body text not null default '' check(length(body)<=50000),
  links jsonb not null default '[]'::jsonb check(public.xelay_material_links_valid(links)),
  attachments jsonb not null default '[]'::jsonb check(public.xelay_material_attachments_valid(group_id,attachments)),
  created_by uuid not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key(subject_id,group_id) references public.study_group_material_subjects(id,group_id) on delete cascade
);
create index if not exists study_group_materials_group_subject_date_idx
  on public.study_group_materials(group_id,subject_id,material_date desc,created_at desc);
create index if not exists study_group_materials_attachment_paths_idx
  on public.study_group_materials using gin(attachments jsonb_path_ops);

-- A detached UUID path is permanently retired before physical deletion begins.
-- No table API access is granted. The receipt is bound to the real object ID
-- and only the uploader plus the actor that detached it may clean that object.
-- No group FK: receipts must remain usable if the parent group is deleted.
create table if not exists public.study_group_material_file_cleanup(
  storage_path text primary key,
  group_id uuid not null,
  object_id uuid,
  owner_id uuid not null,
  cleanup_user_id uuid,
  retired_at timestamptz not null default clock_timestamp(),
  check(public.xelay_material_file_path_valid(storage_path) and split_part(storage_path,'/',1)=group_id::text
    and split_part(storage_path,'/',2)=owner_id::text)
);
create index if not exists study_group_material_file_cleanup_actor_idx
  on public.study_group_material_file_cleanup(cleanup_user_id,group_id,retired_at);
create index if not exists study_group_material_file_cleanup_owner_idx
  on public.study_group_material_file_cleanup(owner_id,group_id,retired_at);

alter table public.study_group_material_subjects enable row level security;
alter table public.study_group_materials enable row level security;
alter table public.study_group_material_file_cleanup enable row level security;
revoke all on table public.study_group_material_subjects,public.study_group_materials,public.study_group_material_file_cleanup
  from public,anon,authenticated,service_role;
grant select on public.study_group_material_subjects,public.study_group_materials to authenticated;
drop policy if exists "Accepted members read material subjects" on public.study_group_material_subjects;
create policy "Accepted members read material subjects" on public.study_group_material_subjects
  for select to authenticated using(public.xelay_can_read_study_group_materials(group_id));
drop policy if exists "Accepted members read group materials" on public.study_group_materials;
create policy "Accepted members read group materials" on public.study_group_materials
  for select to authenticated using(public.xelay_can_read_study_group_materials(group_id));

create or replace function public.xelay_guard_material_subject()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_group_id uuid; v_role text:=coalesce(current_setting('role',true),'none');
begin
  v_group_id:=case when tg_op='DELETE' then old.group_id else new.group_id end;
  if exists(select 1 from public.study_groups where id=v_group_id) then
    if auth.uid() is not null then perform public.xelay_lock_study_group_permission(v_group_id,'materials',true);
    elsif v_role not in('none','postgres','supabase_admin') then raise exception 'MATERIAL_AUTH_REQUIRED' using errcode='42501'; end if;
  end if;
  if tg_op='DELETE' then
    -- Parent-group deletion can cascade safely; ordinary subject deletion is
    -- still refused before any topic can be removed by this composite FK.
    if exists(select 1 from public.study_groups where id=v_group_id)
      and exists(select 1 from public.study_group_materials where subject_id=old.id and group_id=old.group_id) then
      raise exception 'MATERIAL_SUBJECT_NOT_EMPTY' using errcode='23503';
    end if;
    return old;
  end if;
  if tg_op='UPDATE' and (new.id is distinct from old.id or new.group_id is distinct from old.group_id
    or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at) then
    raise exception 'MATERIAL_IDENTITY_IMMUTABLE' using errcode='42501';
  end if;
  if tg_op='INSERT' and auth.uid() is not null and new.created_by is distinct from auth.uid() then
    raise exception 'MATERIAL_UPLOAD_OWNER_REQUIRED' using errcode='42501';
  end if;
  new.name:=btrim(new.name); new.updated_at:=clock_timestamp();
  return new;
end;
$$;
drop trigger if exists study_group_material_subject_guard on public.study_group_material_subjects;
create trigger study_group_material_subject_guard before insert or update or delete on public.study_group_material_subjects
  for each row execute function public.xelay_guard_material_subject();

create or replace function public.xelay_guard_study_group_material()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_group_id uuid; v_prior jsonb:='[]'; v_next jsonb:='[]'; v_file jsonb;
  v_object storage.objects%rowtype; v_owner text; v_retained boolean;
  v_role text:=coalesce(current_setting('role',true),'none');
begin
  v_group_id:=case when tg_op='DELETE' then old.group_id else new.group_id end;
  if exists(select 1 from public.study_groups where id=v_group_id) then
    if auth.uid() is not null then perform public.xelay_lock_study_group_permission(v_group_id,'materials',true);
    elsif v_role not in('none','postgres','supabase_admin') then raise exception 'MATERIAL_AUTH_REQUIRED' using errcode='42501'; end if;
  end if;
  if tg_op<>'INSERT' then v_prior:=old.attachments; end if;
  if tg_op<>'DELETE' then
    v_next:=new.attachments;
    if not public.xelay_material_attachments_valid(v_group_id,v_next) or not public.xelay_material_links_valid(new.links) then
      raise exception 'MATERIAL_FILES_OR_LINKS_INVALID' using errcode='22023';
    end if;
    if tg_op='UPDATE' and (new.id is distinct from old.id or new.group_id is distinct from old.group_id
      or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at) then
      raise exception 'MATERIAL_IDENTITY_IMMUTABLE' using errcode='42501';
    end if;
    if tg_op='INSERT' and auth.uid() is not null and new.created_by is distinct from auth.uid() then
      raise exception 'MATERIAL_UPLOAD_OWNER_REQUIRED' using errcode='42501';
    end if;
  end if;
  -- The same group lock is also used by cleanup RPCs. Lock the union of old
  -- and new uploads in sorted order before any reference or receipt changes.
  perform 1 from storage.objects o where o.bucket_id='xelay-study-materials'
    and (v_prior @> jsonb_build_array(jsonb_build_object('path',o.name))
      or v_next @> jsonb_build_array(jsonb_build_object('path',o.name)))
    order by o.name for update;
  for v_file in select value from jsonb_array_elements(v_next) order by value->>'path' loop
    v_retained:=v_prior @> jsonb_build_array(v_file);
    if auth.uid() is not null and not v_retained and split_part(v_file->>'path','/',2) is distinct from auth.uid()::text then
      raise exception 'MATERIAL_FILE_UPLOAD_OWNER_REQUIRED' using errcode='42501';
    end if;
    select * into v_object from storage.objects o where o.bucket_id='xelay-study-materials' and o.name=v_file->>'path';
    if not found then raise exception 'MATERIAL_FILE_UPLOAD_NOT_FOUND' using errcode='22023'; end if;
    if exists(select 1 from public.study_group_material_file_cleanup c where c.storage_path=v_object.name) then
      raise exception 'MATERIAL_FILE_UPLOAD_RETIRED' using errcode='42501';
    end if;
    v_owner:=coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),to_jsonb(v_object)->>'owner');
    if v_owner is distinct from split_part(v_file->>'path','/',2)
      or coalesce(v_object.metadata->>'size','') !~ '^[0-9]{1,8}$'
      or (v_object.metadata->>'size')::bigint is distinct from (v_file->>'file_size')::bigint
      or lower(split_part(coalesce(v_object.metadata->>'mimetype',''),';',1)) is distinct from v_file->>'mime_type' then
      raise exception 'MATERIAL_FILE_UPLOAD_METADATA_MISMATCH' using errcode='22023';
    end if;
    if exists(select 1 from public.study_group_materials m where m.id<>new.id
      and m.attachments @> jsonb_build_array(jsonb_build_object('path',v_object.name))) then
      raise exception 'MATERIAL_FILE_ALREADY_ATTACHED' using errcode='22023';
    end if;
  end loop;
  for v_file in select value from jsonb_array_elements(v_prior)
    where not(v_next @> jsonb_build_array(jsonb_build_object('path',value->>'path'))) order by value->>'path' loop
    select * into v_object from storage.objects o where o.bucket_id='xelay-study-materials' and o.name=v_file->>'path';
    if found and coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),to_jsonb(v_object)->>'owner')
      is distinct from split_part(v_file->>'path','/',2) then
      raise exception 'MATERIAL_FILE_UPLOAD_METADATA_MISMATCH' using errcode='22023';
    end if;
    insert into public.study_group_material_file_cleanup(storage_path,group_id,object_id,owner_id,cleanup_user_id)
      values(v_file->>'path',v_group_id,case when found then v_object.id else null end,
        split_part(v_file->>'path','/',2)::uuid,auth.uid()) on conflict(storage_path) do nothing;
  end loop;
  if tg_op='DELETE' then return old; end if;
  new.title:=btrim(new.title); new.updated_at:=clock_timestamp();
  return new;
end;
$$;
drop trigger if exists study_group_material_guard on public.study_group_materials;
create trigger study_group_material_guard before insert or update or delete on public.study_group_materials
  for each row execute function public.xelay_guard_study_group_material();

create or replace function public.xelay_save_material_subject(p_group_id uuid,p_subject_id uuid,p_name text)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_subject public.study_group_material_subjects%rowtype; v_name text:=btrim(p_name);
begin
  perform public.xelay_lock_study_group_permission(p_group_id,'materials',true);
  if v_name is null or length(v_name) not between 2 and 180 or v_name ~ '[[:cntrl:]]' then
    raise exception 'MATERIAL_SUBJECT_INVALID' using errcode='22023';
  end if;
  if p_subject_id is null then
    insert into public.study_group_material_subjects(group_id,name,created_by)
      values(p_group_id,v_name,auth.uid()) returning * into v_subject;
  else
    select * into v_subject from public.study_group_material_subjects where id=p_subject_id and group_id=p_group_id for update;
    if not found then raise exception 'MATERIAL_SUBJECT_NOT_FOUND' using errcode='22023'; end if;
    update public.study_group_material_subjects set name=v_name where id=p_subject_id and group_id=p_group_id returning * into v_subject;
  end if;
  return to_jsonb(v_subject);
exception when unique_violation then raise exception 'MATERIAL_SUBJECT_NAME_EXISTS' using errcode='23505';
end;
$$;

create or replace function public.xelay_delete_material_subject(p_group_id uuid,p_subject_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.xelay_lock_study_group_permission(p_group_id,'materials',true);
  perform 1 from public.study_group_material_subjects where id=p_subject_id and group_id=p_group_id for update;
  if not found then raise exception 'MATERIAL_SUBJECT_NOT_FOUND' using errcode='22023'; end if;
  if exists(select 1 from public.study_group_materials where group_id=p_group_id and subject_id=p_subject_id) then
    raise exception 'MATERIAL_SUBJECT_NOT_EMPTY' using errcode='23503';
  end if;
  delete from public.study_group_material_subjects where id=p_subject_id and group_id=p_group_id;
end;
$$;

create or replace function public.xelay_save_study_group_material(
  p_group_id uuid,p_material_id uuid,p_subject_id uuid,p_title text,p_material_date date,
  p_body text,p_links jsonb,p_attachments jsonb
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_material public.study_group_materials%rowtype; v_title text:=btrim(p_title);
begin
  perform public.xelay_lock_study_group_permission(p_group_id,'materials',true);
  if v_title is null or length(v_title) not between 3 and 240 or v_title ~ '[[:cntrl:]]'
    or p_material_date is null or not isfinite(p_material_date)
    or p_material_date not between date '1900-01-01' and date '2200-12-31'
    or p_body is null or length(p_body)>50000 then raise exception 'MATERIAL_ENTRY_INVALID' using errcode='22023'; end if;
  if not public.xelay_material_links_valid(p_links) or not public.xelay_material_attachments_valid(p_group_id,p_attachments) then
    raise exception 'MATERIAL_FILES_OR_LINKS_INVALID' using errcode='22023';
  end if;
  if not exists(select 1 from public.study_group_material_subjects where id=p_subject_id and group_id=p_group_id) then
    raise exception 'MATERIAL_SUBJECT_NOT_FOUND' using errcode='22023';
  end if;
  if p_material_id is null then
    insert into public.study_group_materials(group_id,subject_id,title,material_date,body,links,attachments,created_by)
      values(p_group_id,p_subject_id,v_title,p_material_date,p_body,p_links,p_attachments,auth.uid()) returning * into v_material;
  else
    select * into v_material from public.study_group_materials where id=p_material_id and group_id=p_group_id for update;
    if not found then raise exception 'MATERIAL_NOT_FOUND' using errcode='22023'; end if;
    update public.study_group_materials set subject_id=p_subject_id,title=v_title,material_date=p_material_date,
      body=p_body,links=p_links,attachments=p_attachments where id=p_material_id and group_id=p_group_id returning * into v_material;
  end if;
  return to_jsonb(v_material);
end;
$$;

create or replace function public.xelay_delete_study_group_material(p_group_id uuid,p_material_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
begin
  perform public.xelay_lock_study_group_permission(p_group_id,'materials',true);
  perform 1 from public.study_group_materials where id=p_material_id and group_id=p_group_id for update;
  if not found then raise exception 'MATERIAL_NOT_FOUND' using errcode='22023'; end if;
  delete from public.study_group_materials where id=p_material_id and group_id=p_group_id;
end;
$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('xelay-study-materials','xelay-study-materials',false,52428800,array[
  'image/jpeg','image/png','image/webp','image/gif','image/avif','application/pdf','application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation','text/plain','text/csv','application/zip',
  'audio/mpeg','audio/wav','audio/mp4','audio/ogg','video/mp4','video/webm','video/quicktime'
]) on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create or replace function public.xelay_claim_material_file_cleanup(p_group_id uuid,p_path text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_object storage.objects%rowtype; v_receipt public.study_group_material_file_cleanup%rowtype;
begin
  if auth.uid() is null or not public.xelay_material_file_path_valid(p_path)
    or split_part(p_path,'/',1) is distinct from p_group_id::text then return false; end if;
  -- Cleanup intentionally needs no current membership/license: it can only
  -- retire an own unused upload or use an exact previously issued receipt.
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:'||p_group_id::text,0));
  select * into v_object from storage.objects where bucket_id='xelay-study-materials' and name=p_path for update;
  if not found or coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),to_jsonb(v_object)->>'owner')
    is distinct from split_part(p_path,'/',2) then return false; end if;
  if exists(select 1 from public.study_group_materials where attachments @> jsonb_build_array(jsonb_build_object('path',p_path))) then return false; end if;
  select * into v_receipt from public.study_group_material_file_cleanup where storage_path=p_path;
  if found then return v_receipt.object_id=v_object.id
    and (v_receipt.owner_id=auth.uid() or v_receipt.cleanup_user_id=auth.uid()); end if;
  if split_part(p_path,'/',2) is distinct from auth.uid()::text then return false; end if;
  insert into public.study_group_material_file_cleanup(storage_path,group_id,object_id,owner_id,cleanup_user_id)
    values(p_path,p_group_id,v_object.id,auth.uid(),auth.uid()) on conflict(storage_path) do nothing;
  select * into v_receipt from public.study_group_material_file_cleanup where storage_path=p_path;
  return v_receipt.object_id=v_object.id and (v_receipt.owner_id=auth.uid() or v_receipt.cleanup_user_id=auth.uid());
end;
$$;

create or replace function public.xelay_material_file_cleanup_paths(p_group_id uuid)
returns text[] language sql stable security definer set search_path = '' as $$
  select coalesce(array_agg(candidate.name),'{}'::text[]) from(
    select o.name from storage.objects o
    join public.study_group_material_file_cleanup c on c.storage_path=o.name and c.object_id=o.id
    where auth.uid() is not null and o.bucket_id='xelay-study-materials'
      and public.xelay_material_file_path_valid(o.name) and split_part(o.name,'/',1)=p_group_id::text
      and coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner')=split_part(o.name,'/',2)
      -- Generic cleanup enumerates only previously claimed/detached paths.
      -- A fresh upload in another browser tab must not be retired before save.
      and (c.owner_id=auth.uid() or c.cleanup_user_id=auth.uid())
      and not exists(select 1 from public.study_group_materials m
        where m.attachments @> jsonb_build_array(jsonb_build_object('path',o.name)))
    order by o.created_at,o.name limit 100) candidate;
$$;

create or replace function public.xelay_can_upload_material_file(p_name text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.xelay_material_file_path_valid(p_name)
    or split_part(p_name,'/',2) is distinct from auth.uid()::text
    or exists(select 1 from public.study_group_material_file_cleanup where storage_path=p_name) then return false; end if;
  perform public.xelay_lock_study_group_permission(split_part(p_name,'/',1)::uuid,'materials',true);
  return true;
exception when insufficient_privilege then return false;
end;
$$;

create or replace function public.xelay_can_read_material_file(p_name text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
begin
  if auth.uid() is null or not public.xelay_material_file_path_valid(p_name) then return false; end if;
  return exists(select 1 from storage.objects o where o.bucket_id='xelay-study-materials' and o.name=p_name
      and split_part(o.name,'/',2)=auth.uid()::text
      and coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner')=auth.uid()::text
      -- Upload ownership permits previewing an unused own upload only. Once
      -- attached, the uploader needs the same current membership as readers.
      and not exists(select 1 from public.study_group_materials m
        where m.attachments @> jsonb_build_array(jsonb_build_object('path',p_name))))
    or (public.xelay_can_read_study_group_materials(split_part(p_name,'/',1)::uuid)
      and exists(select 1 from public.study_group_materials m where m.group_id=split_part(p_name,'/',1)::uuid
        and m.attachments @> jsonb_build_array(jsonb_build_object('path',p_name))));
end;
$$;

create or replace function public.xelay_can_remove_material_file(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists(select 1 from storage.objects o
    join public.study_group_material_file_cleanup c on c.storage_path=o.name and c.object_id=o.id
    where o.bucket_id='xelay-study-materials' and o.name=p_name
      and c.owner_id::text=coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner')
      and (c.owner_id=auth.uid() or c.cleanup_user_id=auth.uid()))
    and not exists(select 1 from public.study_group_materials m
      where m.attachments @> jsonb_build_array(jsonb_build_object('path',p_name)));
$$;

create or replace function public.xelay_guard_material_file_storage()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_owner text; v_role text:=coalesce(current_setting('role',true),'none');
  v_bytes bigint:=52428800; v_usage bigint; v_count bigint;
begin
  if tg_op='DELETE' then
    if old.bucket_id<>'xelay-study-materials' then return old; end if;
    -- Permanent retirement is committed before Storage's two-phase API delete.
    if not exists(select 1 from public.study_group_material_file_cleanup c
      where c.storage_path=old.name and c.object_id=old.id
        and c.owner_id::text=coalesce(nullif(to_jsonb(old)->>'owner_id',''),to_jsonb(old)->>'owner')) then
      raise exception 'MATERIAL_FILE_CLEANUP_CLAIM_REQUIRED' using errcode='42501';
    end if;
    if exists(select 1 from public.study_group_materials where attachments @> jsonb_build_array(jsonb_build_object('path',old.name))) then
      raise exception 'MATERIAL_FILE_IS_REFERENCED' using errcode='42501';
    end if;
    if v_role in('anon','authenticated') and not public.xelay_can_remove_material_file(old.name) then
      raise exception 'MATERIAL_FILE_DELETE_FORBIDDEN' using errcode='42501';
    end if;
    return old;
  end if;
  if tg_op='UPDATE' then
    if new.bucket_id<>'xelay-study-materials' and old.bucket_id<>'xelay-study-materials' then return new; end if;
    if new.bucket_id is distinct from old.bucket_id or new.name is distinct from old.name or new.id is distinct from old.id
      or coalesce(nullif(to_jsonb(new)->>'owner_id',''),to_jsonb(new)->>'owner') is distinct from
        coalesce(nullif(to_jsonb(old)->>'owner_id',''),to_jsonb(old)->>'owner') then
      raise exception 'MATERIAL_FILE_IDENTITY_IMMUTABLE' using errcode='42501';
    end if;
    if v_role in('anon','authenticated') then raise exception 'MATERIAL_FILE_OVERWRITE_FORBIDDEN' using errcode='42501'; end if;
    -- Privileged Storage metadata finalization is permitted once. Metadata for
    -- an uploaded object cannot later be rewritten underneath a saved topic.
    if old.metadata ? 'size' and (new.metadata->>'size' is distinct from old.metadata->>'size'
      or new.metadata->>'mimetype' is distinct from old.metadata->>'mimetype') then
      raise exception 'MATERIAL_FILE_CONTENT_IMMUTABLE' using errcode='42501';
    end if;
  elsif new.bucket_id<>'xelay-study-materials' then return new;
  end if;
  if not public.xelay_material_file_path_valid(new.name)
    or exists(select 1 from public.study_group_material_file_cleanup where storage_path=new.name) then
    raise exception 'MATERIAL_FILE_UPLOAD_RETIRED_OR_INVALID' using errcode='22023';
  end if;
  v_owner:=coalesce(nullif(to_jsonb(new)->>'owner_id',''),to_jsonb(new)->>'owner');
  if v_owner is distinct from split_part(new.name,'/',2) then
    raise exception 'MATERIAL_FILE_UPLOAD_OWNER_REQUIRED' using errcode='42501';
  end if;
  if tg_op='INSERT' then
    if auth.uid() is not null then
      perform public.xelay_lock_study_group_permission(split_part(new.name,'/',1)::uuid,'materials',true);
      if v_owner is distinct from auth.uid()::text then raise exception 'MATERIAL_FILE_UPLOAD_OWNER_REQUIRED' using errcode='42501'; end if;
    elsif v_role not in('none','postgres','supabase_admin','service_role') then
      raise exception 'MATERIAL_AUTH_REQUIRED' using errcode='42501';
    end if;
  end if;
  if new.metadata ? 'size' then
    if coalesce(new.metadata->>'size','') !~ '^[0-9]{1,8}$'
      or (new.metadata->>'size')::bigint not between 1 and 52428800
      or lower(split_part(coalesce(new.metadata->>'mimetype',''),';',1)) is distinct from public.xelay_material_file_mime(new.name) then
      raise exception 'MATERIAL_FILE_UPLOAD_METADATA_MISMATCH' using errcode='22023';
    end if;
    v_bytes:=(new.metadata->>'size')::bigint;
  end if;
  -- Raw orphan uploads are bounded too. A provisional object reserves 50 MiB
  -- until privileged metadata finalization reports the real size.
  perform pg_advisory_xact_lock(hashtextextended('xelay-study-materials-owner:'||v_owner,0));
  select count(*),coalesce(sum(case when coalesce(o.metadata->>'size','') ~ '^[0-9]{1,8}$'
    and (o.metadata->>'size')::bigint between 1 and 52428800 then (o.metadata->>'size')::bigint
    else 52428800 end),0) into v_count,v_usage from storage.objects o
    where o.bucket_id='xelay-study-materials' and o.id is distinct from new.id
      and coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner')=v_owner;
  if v_count>=500 or v_usage+v_bytes>1073741824 then raise exception 'MATERIAL_FILE_STORAGE_QUOTA' using errcode='54000'; end if;
  return new;
end;
$$;
drop trigger if exists study_group_material_file_storage_guard on storage.objects;
create trigger study_group_material_file_storage_guard before insert or update or delete on storage.objects
  for each row execute function public.xelay_guard_material_file_storage();

-- Permissive policies authorize this bucket; restrictive guards stop older
-- broad Storage policies from granting access to it. Other buckets are untouched.
drop policy if exists "Materials editors upload group files" on storage.objects;
create policy "Materials editors upload group files" on storage.objects for insert to authenticated
  with check(bucket_id='xelay-study-materials' and public.xelay_can_upload_material_file(name)
    and coalesce(nullif(to_jsonb(objects)->>'owner_id',''),to_jsonb(objects)->>'owner')=auth.uid()::text);
drop policy if exists "Study material upload guard" on storage.objects;
create policy "Study material upload guard" on storage.objects as restrictive for insert to anon,authenticated
  with check(bucket_id<>'xelay-study-materials' or (public.xelay_can_upload_material_file(name)
    and coalesce(nullif(to_jsonb(objects)->>'owner_id',''),to_jsonb(objects)->>'owner')=auth.uid()::text));
drop policy if exists "Accepted group members download material files" on storage.objects;
create policy "Accepted group members download material files" on storage.objects for select to authenticated
  using(bucket_id='xelay-study-materials' and public.xelay_can_read_material_file(name));
drop policy if exists "Study material read guard" on storage.objects;
create policy "Study material read guard" on storage.objects as restrictive for select to anon,authenticated
  using(bucket_id<>'xelay-study-materials' or public.xelay_can_read_material_file(name));
drop policy if exists "Cleanup actors remove retired material files" on storage.objects;
create policy "Cleanup actors remove retired material files" on storage.objects for delete to authenticated
  using(bucket_id='xelay-study-materials' and public.xelay_can_remove_material_file(name));
drop policy if exists "Study material removal guard" on storage.objects;
create policy "Study material removal guard" on storage.objects as restrictive for delete to anon,authenticated
  using(bucket_id<>'xelay-study-materials' or public.xelay_can_remove_material_file(name));
drop policy if exists "Study material overwrite guard" on storage.objects;
create policy "Study material overwrite guard" on storage.objects as restrictive for update to anon,authenticated
  using(bucket_id<>'xelay-study-materials') with check(bucket_id<>'xelay-study-materials');

revoke all on function public.xelay_guard_material_subject(),public.xelay_guard_study_group_material(),
  public.xelay_guard_material_file_storage() from public,anon,authenticated,service_role;
revoke all on function public.xelay_can_read_study_group_materials(uuid),public.xelay_material_file_mime(text),
  public.xelay_material_file_path_valid(text),public.xelay_material_links_valid(jsonb),public.xelay_material_attachments_valid(uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_can_read_study_group_materials(uuid),public.xelay_material_file_mime(text),
  public.xelay_material_file_path_valid(text),public.xelay_material_links_valid(jsonb),public.xelay_material_attachments_valid(uuid,jsonb) to authenticated;
revoke all on function public.xelay_save_material_subject(uuid,uuid,text),public.xelay_delete_material_subject(uuid,uuid),
  public.xelay_save_study_group_material(uuid,uuid,uuid,text,date,text,jsonb,jsonb),public.xelay_delete_study_group_material(uuid,uuid),
  public.xelay_claim_material_file_cleanup(uuid,text),public.xelay_material_file_cleanup_paths(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_save_material_subject(uuid,uuid,text),public.xelay_delete_material_subject(uuid,uuid),
  public.xelay_save_study_group_material(uuid,uuid,uuid,text,date,text,jsonb,jsonb),public.xelay_delete_study_group_material(uuid,uuid),
  public.xelay_claim_material_file_cleanup(uuid,text),public.xelay_material_file_cleanup_paths(uuid) to authenticated;
revoke all on function public.xelay_can_upload_material_file(text),public.xelay_can_read_material_file(text),public.xelay_can_remove_material_file(text)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_can_upload_material_file(text),public.xelay_can_read_material_file(text),public.xelay_can_remove_material_file(text)
  to anon,authenticated;

comment on table public.study_group_material_subjects is 'Private academic subjects; accepted group members read, representative or explicitly appointed materials deputies manage through RPC. Subjects containing topics cannot be removed.';
comment on table public.study_group_materials is 'Private dated topic materials with body, max 10 HTTP(S) links and 10 private files (50 MiB each / 200 MiB total). Read access survives billing expiry; all writes require active annual/trial group access.';
comment on table public.study_group_material_file_cleanup is 'Closed permanent UUID retirement receipts. Exact object ID, uploader and detaching actor only; no reattachment/reupload after retirement and no direct client table access.';
comment on column public.study_group_materials.created_by is 'Immutable historical author ID; deleting an account does not delete the shared group materials.';
comment on function public.xelay_study_group_permissions(uuid) is 'Academic edits require actual representative or accepted approved deputy with the explicit permission. materials is opt-in; platform admins alone retain only seminar_comments/invite_members/remove_members.';
notify pgrst,'reload schema';
commit;
