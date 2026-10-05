-- News documents and repeatable resource links. Apply after 202610020001.
-- Independent of the later security remediation migrations; existing scope,
-- image policies, news content and single legacy link_url values are retained.
begin;

do $$
begin
  if to_regclass('public.news_posts') is null
    or to_regclass('public.news_submissions') is null
    or to_regclass('storage.objects') is null
    or to_regprocedure('public.xelay_can_manage_news(uuid,uuid)') is null
    or to_regprocedure('public.xelay_can_read_news(uuid)') is null
    or to_regprocedure('public.xelay_update_news_post(uuid,jsonb)') is null
    or to_regprocedure('public.xelay_review_news_submission(uuid,text)') is null
    or not exists (select 1 from information_schema.columns where table_schema='public'
      and table_name='news_posts' and column_name='image_path') then
    raise exception 'Apply news media, management and university scope migrations through 202610020001 before news attachments';
  end if;
end;
$$;

alter table public.news_posts add column if not exists attachments jsonb not null default '[]'::jsonb;
alter table public.news_posts add column if not exists links jsonb not null default '[]'::jsonb;
alter table public.news_submissions add column if not exists attachments jsonb not null default '[]'::jsonb;
alter table public.news_submissions add column if not exists links jsonb not null default '[]'::jsonb;
create index if not exists news_posts_attachment_paths_idx on public.news_posts using gin(attachments jsonb_path_ops);
create index if not exists news_submissions_pending_attachment_paths_idx on public.news_submissions
  using gin(attachments jsonb_path_ops) where status='pending';

create or replace function public.xelay_news_file_mime(p_path text)
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
    when 'txt' then 'text/plain' when 'csv' then 'text/csv'
    when 'zip' then 'application/zip' else null end;
$$;

create or replace function public.xelay_news_links_valid(p_links jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_link jsonb;
begin
  if p_links is null or jsonb_typeof(p_links)<>'array' then return false; end if;
  if jsonb_array_length(p_links)>10 then return false; end if;
  for v_link in select value from jsonb_array_elements(p_links) loop
    if jsonb_typeof(v_link)<>'object' or not(v_link ?& array['label','url'])
      or (v_link-array['label','url'])<>'{}'::jsonb
      or jsonb_typeof(v_link->'label')<>'string' or jsonb_typeof(v_link->'url')<>'string'
      or length(v_link->>'label')>120
      or length(v_link->>'url') not between 1 and 2048
      or (v_link->>'url') !~* '^https?://[^/?#[:space:]\\@]+([/?#][^[:space:]\\]*)?$'
      or (v_link->>'url') ~ '[[:cntrl:]]' then return false; end if;
  end loop;
  return true;
end;
$$;

create or replace function public.xelay_news_attachments_valid(p_attachments jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_file jsonb; v_total bigint:=0; v_seen text[]:='{}';
begin
  if p_attachments is null or jsonb_typeof(p_attachments)<>'array' then return false; end if;
  if jsonb_array_length(p_attachments)>10 then return false; end if;
  for v_file in select value from jsonb_array_elements(p_attachments) loop
    if jsonb_typeof(v_file)<>'object' or not(v_file ?& array['path','file_name','mime_type','file_size'])
      or (v_file-array['path','file_name','mime_type','file_size'])<>'{}'::jsonb
      or jsonb_typeof(v_file->'path')<>'string' or jsonb_typeof(v_file->'file_name')<>'string'
      or jsonb_typeof(v_file->'mime_type')<>'string' or jsonb_typeof(v_file->'file_size')<>'number'
      or (v_file->>'path') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpe?g|png|webp|gif|avif|pdf|docx?|xlsx?|pptx?|txt|csv|zip)$'
      or length(btrim(v_file->>'file_name')) not between 1 and 180
      or (v_file->>'file_name') ~ '[[:cntrl:]/\\]'
      or (v_file->>'file_name') ~ U&'[\202A-\202E\2066-\2069]'
      or public.xelay_news_file_mime(v_file->>'path') is distinct from (v_file->>'mime_type')
      or public.xelay_news_file_mime(v_file->>'file_name') is distinct from (v_file->>'mime_type')
      or coalesce(v_file->>'file_size','') !~ '^[0-9]{1,8}$'
      or (v_file->>'path')=any(v_seen) then return false; end if;
    if (v_file->>'file_size')::bigint not between 1 and 20971520 then return false; end if;
    v_total:=v_total+(v_file->>'file_size')::bigint;
    if v_total>52428800 then return false; end if;
    v_seen:=array_append(v_seen,v_file->>'path');
  end loop;
  return true;
end;
$$;

revoke all on function public.xelay_news_file_mime(text), public.xelay_news_links_valid(jsonb),
  public.xelay_news_attachments_valid(jsonb) from public,anon,authenticated;
-- Pure validators contain no data lookup; CHECK constraints also need them for
-- ordinary authenticated INSERTs. They expose no private storage/catalog data.
grant execute on function public.xelay_news_file_mime(text), public.xelay_news_links_valid(jsonb),
  public.xelay_news_attachments_valid(jsonb) to authenticated,service_role;

alter table public.news_posts drop constraint if exists news_posts_attachments_check;
alter table public.news_posts add constraint news_posts_attachments_check check(public.xelay_news_attachments_valid(attachments));
alter table public.news_posts drop constraint if exists news_posts_links_check;
alter table public.news_posts add constraint news_posts_links_check check(public.xelay_news_links_valid(links));
alter table public.news_submissions drop constraint if exists news_submissions_attachments_check;
alter table public.news_submissions add constraint news_submissions_attachments_check check(public.xelay_news_attachments_valid(attachments));
alter table public.news_submissions drop constraint if exists news_submissions_links_check;
alter table public.news_submissions add constraint news_submissions_links_check check(public.xelay_news_links_valid(links));

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('xelay-news-files','xelay-news-files',false,20971520,array[
  'image/jpeg','image/png','image/webp','image/gif','image/avif','application/pdf','application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document','application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/vnd.ms-powerpoint',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation','text/plain','text/csv','application/zip'
]) on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

-- Storage's API tests DELETE permission in a rolled-back transaction before
-- removing physical bytes. Retire the path in a separate committed RPC first,
-- so it cannot become newly attached between that test and the real removal.
-- UUID paths are never reused, so claims deliberately have no expiry.
create table if not exists public.news_file_cleanup_claims(
  storage_path text primary key,
  object_id uuid not null,
  owner_id uuid not null,
  claimed_at timestamptz not null default clock_timestamp(),
  constraint news_file_cleanup_owner_path_check check(split_part(storage_path,'/',1)=owner_id::text)
);
alter table public.news_file_cleanup_claims enable row level security;
revoke all on table public.news_file_cleanup_claims from public,anon,authenticated;
comment on table public.news_file_cleanup_claims is 'Permanent retired news-file UUID paths; no client table access. Owner-scoped cleanup RPC binds the actual object ID before Storage deletion so delayed physical removal cannot delete a newly referenced file.';

create or replace function public.xelay_claim_news_file_cleanup(p_path text)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_object storage.objects%rowtype; v_claim public.news_file_cleanup_claims%rowtype;
begin
  if auth.uid() is null or split_part(p_path,'/',1) is distinct from auth.uid()::text then return false; end if;
  select * into v_object from storage.objects o
    where o.bucket_id='xelay-news-files' and o.name=p_path for update;
  if not found or coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),to_jsonb(v_object)->>'owner')
    is distinct from auth.uid()::text then return false; end if;
  -- The attachment guard locks this same object before accepting a reference.
  -- Each statement below observes the latest committed rows after lock wait.
  if exists(select 1 from public.news_posts n where n.attachments @> jsonb_build_array(jsonb_build_object('path',p_path)))
    or exists(select 1 from public.news_submissions s where s.status='pending'
      and s.attachments @> jsonb_build_array(jsonb_build_object('path',p_path))) then return false; end if;
  insert into public.news_file_cleanup_claims(storage_path,object_id,owner_id)
    values(p_path,v_object.id,auth.uid()) on conflict(storage_path) do nothing;
  select * into v_claim from public.news_file_cleanup_claims where storage_path=p_path;
  return v_claim.object_id=v_object.id and v_claim.owner_id=auth.uid();
end;
$$;
revoke all on function public.xelay_claim_news_file_cleanup(text) from public,anon,authenticated;
grant execute on function public.xelay_claim_news_file_cleanup(text) to authenticated;

create or replace function public.xelay_can_upload_news_file(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and split_part(p_name,'/',1)=auth.uid()::text
    and p_name ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpe?g|png|webp|gif|avif|pdf|docx?|xlsx?|pptx?|txt|csv|zip)$'
    and (public.xelay_is_platform_admin()
      or exists(select 1 from public.profiles p where p.id=auth.uid() and p.university_id is not null)
      or exists(select 1 from public.user_roles r where r.user_id=auth.uid()
        and r.role in('FACULTY_EDITOR','UNIVERSITY_EDITOR')));
$$;

create or replace function public.xelay_can_read_news_file(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (
    exists(select 1 from storage.objects o where o.bucket_id='xelay-news-files' and o.name=p_name
      and split_part(o.name,'/',1)=auth.uid()::text
      and coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner')=auth.uid()::text)
    or exists(select 1 from public.news_posts n where n.attachments @> jsonb_build_array(jsonb_build_object('path',p_name))
      and (public.xelay_can_manage_news(n.university_id,n.academic_unit_id) or public.xelay_can_read_news(n.id)))
    or exists(select 1 from public.news_submissions s where s.status='pending'
      and s.attachments @> jsonb_build_array(jsonb_build_object('path',p_name))
      and (s.user_id=auth.uid() or public.xelay_can_manage_news(s.university_id,s.academic_unit_id)))
  );
$$;

create or replace function public.xelay_can_remove_news_file(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and split_part(p_name,'/',1)=auth.uid()::text
    and exists(select 1 from storage.objects o where o.bucket_id='xelay-news-files' and o.name=p_name
      and coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner')=auth.uid()::text
      and exists(select 1 from public.news_file_cleanup_claims c where c.storage_path=o.name
        and c.object_id=o.id and c.owner_id=auth.uid()))
    and not exists(select 1 from public.news_posts n where n.attachments @> jsonb_build_array(jsonb_build_object('path',p_name)))
    and not exists(select 1 from public.news_submissions s where s.status='pending'
      and s.attachments @> jsonb_build_array(jsonb_build_object('path',p_name)));
$$;

revoke all on function public.xelay_can_upload_news_file(text),public.xelay_can_read_news_file(text),
  public.xelay_can_remove_news_file(text) from public,anon,authenticated;
grant execute on function public.xelay_can_upload_news_file(text),public.xelay_can_read_news_file(text),
  public.xelay_can_remove_news_file(text) to anon,authenticated;

-- Each restrictive guard is scoped to this new bucket. Existing broad Storage
-- policies cannot open it, and policies for every older bucket stay unchanged.
drop policy if exists "Members upload news files" on storage.objects;
create policy "Members upload news files" on storage.objects for insert to authenticated
  with check(bucket_id='xelay-news-files' and public.xelay_can_upload_news_file(name)
    and coalesce(nullif(to_jsonb(objects)->>'owner_id',''),to_jsonb(objects)->>'owner')=auth.uid()::text);
drop policy if exists "News file upload guard" on storage.objects;
create policy "News file upload guard" on storage.objects as restrictive for insert to anon,authenticated
  with check(bucket_id<>'xelay-news-files' or (public.xelay_can_upload_news_file(name)
    and coalesce(nullif(to_jsonb(objects)->>'owner_id',''),to_jsonb(objects)->>'owner')=auth.uid()::text));
drop policy if exists "Readers download scoped news files" on storage.objects;
create policy "Readers download scoped news files" on storage.objects for select to authenticated
  using(bucket_id='xelay-news-files' and public.xelay_can_read_news_file(name));
drop policy if exists "News file read guard" on storage.objects;
create policy "News file read guard" on storage.objects as restrictive for select to anon,authenticated
  using(bucket_id<>'xelay-news-files' or public.xelay_can_read_news_file(name));
drop policy if exists "News file overwrite guard" on storage.objects;
create policy "News file overwrite guard" on storage.objects as restrictive for update to anon,authenticated
  using(bucket_id<>'xelay-news-files') with check(bucket_id<>'xelay-news-files');
drop policy if exists "Owners remove unused news files" on storage.objects;
create policy "Owners remove unused news files" on storage.objects for delete to authenticated
  using(bucket_id='xelay-news-files' and public.xelay_can_remove_news_file(name));
drop policy if exists "News file delete guard" on storage.objects;
create policy "News file delete guard" on storage.objects as restrictive for delete to anon,authenticated
  using(bucket_id<>'xelay-news-files' or public.xelay_can_remove_news_file(name));

create or replace function public.xelay_guard_news_files()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_file jsonb; v_object storage.objects%rowtype; v_prior jsonb:='[]';
  v_submission public.news_submissions%rowtype; v_retained boolean; v_owner text;
  v_foreign jsonb:='[]';
begin
  if not public.xelay_news_attachments_valid(new.attachments) or not public.xelay_news_links_valid(new.links) then
    raise exception 'NEWS_FILES_OR_LINKS_INVALID' using errcode='22023';
  end if;
  if tg_op='UPDATE' then
    v_prior:=old.attachments;
    if new.attachments is not distinct from old.attachments
      and new.university_id is not distinct from old.university_id
      and new.academic_unit_id is not distinct from old.academic_unit_id
      and not(tg_table_name='news_submissions' and new.status='pending' and old.status<>'pending') then return new; end if;
  end if;
  if jsonb_array_length(new.attachments)=0 then return new; end if;
  if auth.uid() is null then
    -- Offline restoration is allowed, but request-bearing roles still need an
    -- authenticated uploader/editor. Metadata validation remains mandatory.
    if coalesce(current_setting('role',true),'none') not in('none','postgres','supabase_admin','service_role') then
      raise exception 'NEWS_FILES_AUTH_REQUIRED' using errcode='42501';
    end if;
  elsif tg_table_name='news_posts' then
    if not public.xelay_can_manage_news(new.university_id,new.academic_unit_id) then
      raise exception 'NEWS_FILES_EDITOR_REQUIRED' using errcode='42501';
    end if;
    if tg_op='UPDATE' and not public.xelay_can_manage_news(old.university_id,old.academic_unit_id) then
      raise exception 'NEWS_FILES_EDITOR_REQUIRED' using errcode='42501';
    end if;
  elsif new.user_id is distinct from auth.uid() and tg_op='INSERT' then
    raise exception 'NEWS_FILES_SUBMISSION_OWNER_REQUIRED' using errcode='42501';
  end if;
  if auth.uid() is not null then
    select coalesce(jsonb_agg(value),'[]'::jsonb) into v_foreign
    from jsonb_array_elements(new.attachments)
    where not(v_prior @> jsonb_build_array(value)) and split_part(value->>'path','/',1)<>auth.uid()::text;
    if jsonb_array_length(v_foreign)>0 then
      if tg_table_name<>'news_posts' or not public.xelay_can_manage_news(new.university_id,new.academic_unit_id) then
        raise exception 'NEWS_FILES_UPLOAD_OWNER_REQUIRED' using errcode='42501';
      end if;
      -- One exact source for every new foreign descriptor, never a mixture of
      -- independent private submissions. Choose the minimum matching ID before
      -- locking files. Review already holds its requested submission, which is
      -- itself a matching candidate, so any additional source lock moves only
      -- toward a lower UUID and cannot form a reversed moderation lock cycle.
      select * into v_submission from public.news_submissions s
      where s.status='pending' and s.university_id=new.university_id
        and s.academic_unit_id is not distinct from new.academic_unit_id
        and s.attachments @> v_foreign
        and not exists(select 1 from jsonb_array_elements(v_foreign) f
          where split_part(f.value->>'path','/',1)<>s.user_id::text)
      order by s.id limit 1 for update;
      if not found then raise exception 'NEWS_FILES_UPLOAD_OWNER_REQUIRED' using errcode='42501'; end if;
    end if;
  end if;
  -- Stable path order keeps multi-file edits from taking Storage locks in
  -- opposite orders. The lock also serializes publication with file removal.
  for v_file in select value from jsonb_array_elements(new.attachments) order by value->>'path' loop
    v_retained:=tg_op='UPDATE' and v_prior @> jsonb_build_array(v_file);
    if auth.uid() is not null and v_retained and (new.university_id is distinct from old.university_id
      or new.academic_unit_id is distinct from old.academic_unit_id)
      and split_part(v_file->>'path','/',1) is distinct from auth.uid()::text then
      raise exception 'NEWS_FILES_CANNOT_MOVE_FOREIGN_UPLOADS' using errcode='42501';
    end if;
    select * into v_object from storage.objects o
    where o.bucket_id='xelay-news-files' and o.name=v_file->>'path' for update;
    if not found then raise exception 'NEWS_FILE_UPLOAD_NOT_FOUND' using errcode='22023'; end if;
    if exists(select 1 from public.news_file_cleanup_claims c where c.storage_path=v_object.name) then
      raise exception 'NEWS_FILE_UPLOAD_RETIRED' using errcode='42501';
    end if;
    v_owner:=coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),to_jsonb(v_object)->>'owner');
    if v_owner is distinct from split_part(v_file->>'path','/',1)
      or coalesce(v_object.metadata->>'size','') !~ '^[0-9]{1,8}$'
      or (v_object.metadata->>'size')::bigint<>(v_file->>'file_size')::bigint
      or lower(split_part(coalesce(v_object.metadata->>'mimetype',''),';',1)) is distinct from v_file->>'mime_type' then
      raise exception 'NEWS_FILE_UPLOAD_METADATA_MISMATCH' using errcode='22023';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.xelay_guard_news_files() from public,anon,authenticated,service_role;
drop trigger if exists xelay_news_files_guard on public.news_posts;
create trigger xelay_news_files_guard before insert or update on public.news_posts
  for each row execute function public.xelay_guard_news_files();
drop trigger if exists xelay_news_submission_files_guard on public.news_submissions;
create trigger xelay_news_submission_files_guard before insert or update on public.news_submissions
  for each row execute function public.xelay_guard_news_files();

create or replace function public.xelay_guard_news_file_storage()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_owner text; v_role text:=coalesce(current_setting('role',true),'none');
  v_bytes bigint:=20971520; v_usage bigint; v_count bigint;
begin
  if tg_op='DELETE' then
    if old.bucket_id<>'xelay-news-files' then return old; end if;
    if not exists(select 1 from public.news_file_cleanup_claims c where c.storage_path=old.name
      and c.object_id=old.id and c.owner_id::text=split_part(old.name,'/',1)
      and c.owner_id::text=coalesce(nullif(to_jsonb(old)->>'owner_id',''),to_jsonb(old)->>'owner')) then
      raise exception 'NEWS_FILE_CLEANUP_CLAIM_REQUIRED' using errcode='42501';
    end if;
    -- The permanent claim prevents future references across Storage's rolled
    -- back permission test and S3 removal; still check existing live references.
    if exists(select 1 from public.news_posts n where n.attachments @> jsonb_build_array(jsonb_build_object('path',old.name)))
      or exists(select 1 from public.news_submissions s where s.status='pending'
        and s.attachments @> jsonb_build_array(jsonb_build_object('path',old.name))) then
      raise exception 'NEWS_FILE_IS_REFERENCED' using errcode='42501';
    end if;
    if v_role in('anon','authenticated') and not public.xelay_can_remove_news_file(old.name) then
      raise exception 'NEWS_FILE_DELETE_FORBIDDEN' using errcode='42501';
    end if;
    return old;
  end if;
  if tg_op='UPDATE' then
    if new.bucket_id<>'xelay-news-files' and old.bucket_id<>'xelay-news-files' then return new; end if;
    if new.bucket_id is distinct from old.bucket_id or new.name is distinct from old.name
      or coalesce(nullif(to_jsonb(new)->>'owner_id',''),to_jsonb(new)->>'owner') is distinct from
        coalesce(nullif(to_jsonb(old)->>'owner_id',''),to_jsonb(old)->>'owner') then
      raise exception 'NEWS_FILE_IDENTITY_IMMUTABLE' using errcode='42501';
    end if;
    if v_role in('anon','authenticated') then raise exception 'NEWS_FILE_OVERWRITE_FORBIDDEN' using errcode='42501'; end if;
    -- Storage versions may finalize metadata in a privileged UPDATE. Permit
    -- that once; a published upload's size and type cannot subsequently change.
    if old.metadata ? 'size' and (new.metadata->>'size' is distinct from old.metadata->>'size'
      or new.metadata->>'mimetype' is distinct from old.metadata->>'mimetype') then
      raise exception 'NEWS_FILE_CONTENT_IMMUTABLE' using errcode='42501';
    end if;
  elsif new.bucket_id<>'xelay-news-files' then return new;
  end if;
  if exists(select 1 from public.news_file_cleanup_claims c where c.storage_path=new.name) then
    raise exception 'NEWS_FILE_UPLOAD_RETIRED' using errcode='42501';
  end if;
  v_owner:=coalesce(nullif(to_jsonb(new)->>'owner_id',''),to_jsonb(new)->>'owner');
  if v_owner is distinct from split_part(new.name,'/',1) or public.xelay_news_file_mime(new.name) is null
    or new.name !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]+$' then
    raise exception 'NEWS_FILE_UPLOAD_INVALID' using errcode='22023';
  end if;
  if v_role in('anon','authenticated') and not public.xelay_can_upload_news_file(new.name) then
    raise exception 'NEWS_FILE_UPLOAD_FORBIDDEN' using errcode='42501';
  end if;
  if new.metadata ? 'size' then
    if coalesce(new.metadata->>'size','') !~ '^[0-9]{1,8}$'
      or (new.metadata->>'size')::bigint not between 1 and 20971520
      or lower(split_part(coalesce(new.metadata->>'mimetype',''),';',1)) is distinct from public.xelay_news_file_mime(new.name) then
      raise exception 'NEWS_FILE_UPLOAD_METADATA_INVALID' using errcode='22023';
    end if;
    v_bytes:=(new.metadata->>'size')::bigint;
  end if;
  -- Bound raw uploads as well as published descriptors. Storage may first
  -- INSERT without size, so that provisional object conservatively reserves
  -- the full 20 MiB until privileged metadata finalization supplies its size.
  -- Serialize same-owner writes; the following volatile statement sees rows
  -- committed by another uploader after the advisory lock was acquired.
  perform pg_advisory_xact_lock(hashtextextended('xelay-news-files-owner:'||v_owner,0));
  select count(*),coalesce(sum(case when coalesce(o.metadata->>'size','') ~ '^[0-9]{1,8}$'
    and (o.metadata->>'size')::bigint between 1 and 20971520
    then (o.metadata->>'size')::bigint else 20971520 end),0) into v_count,v_usage
  from storage.objects o where o.bucket_id='xelay-news-files' and o.id is distinct from new.id
    and coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner')=v_owner;
  if v_count>=500 or v_usage+v_bytes>209715200 then raise exception 'NEWS_FILE_STORAGE_QUOTA' using errcode='54000'; end if;
  return new;
end;
$$;
revoke all on function public.xelay_guard_news_file_storage() from public,anon,authenticated,service_role;
drop trigger if exists xelay_news_file_storage_guard on storage.objects;
create trigger xelay_news_file_storage_guard before insert or update or delete on storage.objects
  for each row execute function public.xelay_guard_news_file_storage();

-- Optional new arrays preserve the old client/RPC contract. The complete
-- editable-field allowlist, scope check, image ownership and date checks remain.
create or replace function public.xelay_update_news_post(p_post_id uuid,p_changes jsonb)
returns jsonb language plpgsql security definer set search_path = public,pg_temp as $$
declare v_post public.news_posts%rowtype; v_image_path text;
  v_published_at timestamptz; v_event_starts_at timestamptz;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  if p_changes is null or jsonb_typeof(p_changes)<>'object' then raise exception 'News changes must be an object'; end if;
  select * into v_post from public.news_posts where id=p_post_id for update;
  if not found or not public.xelay_can_manage_news(v_post.university_id,v_post.academic_unit_id) then
    raise exception 'News post not found or editor permission required'; end if;
  if (p_changes-array['title','excerpt','body','published_at','post_type','is_pinned',
    'event_starts_at','event_location','organizer','registration_url','link_url','image_url','image_path','attachments','links'])<>'{}'::jsonb then
    raise exception 'News changes contain unsupported fields'; end if;
  if not(p_changes ?& array['title','excerpt','body','published_at','post_type','is_pinned',
    'event_starts_at','event_location','organizer','registration_url','link_url']) then
    raise exception 'Required news fields are missing'; end if;
  if exists(select 1 from jsonb_each(p_changes) e where e.key in('title','excerpt','body','published_at','post_type')
    and jsonb_typeof(e.value)<>'string') or jsonb_typeof(p_changes->'is_pinned')<>'boolean' then
    raise exception 'Required news fields have invalid types'; end if;
  if exists(select 1 from jsonb_each(p_changes) e where e.key in('event_starts_at','event_location','organizer',
    'registration_url','link_url','image_url','image_path') and jsonb_typeof(e.value) not in('string','null')) then
    raise exception 'Optional news fields must be text or null'; end if;
  if (p_changes ? 'attachments' and not public.xelay_news_attachments_valid(p_changes->'attachments'))
    or (p_changes ? 'links' and not public.xelay_news_links_valid(p_changes->'links')) then
    raise exception 'NEWS_FILES_OR_LINKS_INVALID' using errcode='22023'; end if;
  v_published_at:=(p_changes->>'published_at')::timestamptz;
  v_event_starts_at:=(p_changes->>'event_starts_at')::timestamptz;
  if not isfinite(v_published_at) or (v_event_starts_at is not null and not isfinite(v_event_starts_at)) then
    raise exception 'News dates must be finite'; end if;
  v_image_path:=case when p_changes ? 'image_path' then p_changes->>'image_path' else v_post.image_path end;
  if v_image_path is not null and v_image_path is distinct from v_post.image_path then
    if split_part(v_image_path,'/',1)<>auth.uid()::text or not exists(select 1 from storage.objects o
      where o.bucket_id='xelay-news-media' and o.name=v_image_path) then
      raise exception 'Replacement news photo must be an existing upload belonging to you'; end if;
  end if;
  update public.news_posts set title=btrim(p_changes->>'title'),excerpt=btrim(p_changes->>'excerpt'),
    body=btrim(p_changes->>'body'),published_at=v_published_at,post_type=p_changes->>'post_type',
    is_pinned=(p_changes->>'is_pinned')::boolean,event_starts_at=v_event_starts_at,
    event_location=nullif(btrim(p_changes->>'event_location'),''),organizer=nullif(btrim(p_changes->>'organizer'),''),
    registration_url=nullif(btrim(p_changes->>'registration_url'),''),link_url=nullif(btrim(p_changes->>'link_url'),''),
    image_url=case when p_changes ? 'image_url' then nullif(btrim(p_changes->>'image_url'),'') else v_post.image_url end,
    image_path=v_image_path,
    attachments=case when p_changes ? 'attachments' then p_changes->'attachments' else v_post.attachments end,
    links=case when p_changes ? 'links' then p_changes->'links' else v_post.links end,updated_at=now()
  where id=p_post_id returning * into v_post;
  return to_jsonb(v_post);
end;
$$;

create or replace function public.xelay_review_news_submission(p_submission_id uuid,p_action text)
returns uuid language plpgsql security definer set search_path = public,pg_temp as $$
declare v_submission public.news_submissions%rowtype; v_post_id uuid; v_actor_name text;
begin
  if auth.uid() is null or p_action is null or p_action not in('publish','reject') then
    raise exception 'Valid moderation action and authentication required'; end if;
  select * into v_submission from public.news_submissions where id=p_submission_id and status='pending' for update;
  if not found or not public.xelay_can_manage_news(v_submission.university_id,v_submission.academic_unit_id) then
    raise exception 'Submission not found or moderator permission required'; end if;
  if p_action='publish' then
    insert into public.news_posts(university_id,academic_unit_id,post_type,title,excerpt,body,image_url,image_path,link_url,
      attachments,links,event_starts_at,event_location,organizer,registration_url,is_pinned,published_by)
    values(v_submission.university_id,v_submission.academic_unit_id,v_submission.post_type,v_submission.title,
      v_submission.excerpt,v_submission.body,v_submission.image_url,v_submission.image_path,v_submission.link_url,
      v_submission.attachments,v_submission.links,v_submission.event_starts_at,v_submission.event_location,
      v_submission.organizer,v_submission.registration_url,false,auth.uid()) returning id into v_post_id;
    update public.news_submissions set status='published',published_post_id=v_post_id,reviewed_by=auth.uid(),reviewed_at=now()
      where id=p_submission_id;
    select full_name into v_actor_name from public.profiles where id=auth.uid();
    insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,news_post_id)
    values(v_submission.user_id,auth.uid(),coalesce(nullif(v_actor_name,''),'Редактор'),
      'news_submission_published','опублікував(-ла) вашу запропоновану новину',false,v_post_id);
    return v_post_id;
  end if;
  update public.news_submissions set status='rejected',reviewed_by=auth.uid(),reviewed_at=now() where id=p_submission_id;
  select full_name into v_actor_name from public.profiles where id=auth.uid();
  insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read)
  values(v_submission.user_id,auth.uid(),coalesce(nullif(v_actor_name,''),'Редактор'),
    'news_submission_rejected','відхилив(-ла) вашу пропозицію новини',false);
  return null;
end;
$$;
revoke all on function public.xelay_update_news_post(uuid,jsonb),public.xelay_review_news_submission(uuid,text)
  from public,anon,authenticated;
grant execute on function public.xelay_update_news_post(uuid,jsonb),public.xelay_review_news_submission(uuid,text) to authenticated;

-- Existing table-level SELECT/INSERT grants already cover added columns; these
-- narrow grants also work on deployments that use column-level grants instead.
grant select(attachments,links),insert(attachments,links) on public.news_posts to authenticated;
grant select(attachments,links),insert(attachments,links) on public.news_submissions to authenticated;
comment on column public.news_posts.attachments is 'Private xelay-news-files descriptors, max 10 files / 20 MiB each / 50 MiB total; actual Storage owner/size/type validated and locked before publication.';
comment on column public.news_posts.links is 'Up to 10 optional labeled HTTP(S) links. Legacy link_url is preserved for old publications and clients.';
comment on column public.news_submissions.attachments is 'Author uploads copied unchanged when a same-scope moderator publishes a suggestion.';
comment on column public.news_submissions.links is 'Resource links copied unchanged when a moderator publishes a suggestion.';
notify pgrst,'reload schema';
commit;
