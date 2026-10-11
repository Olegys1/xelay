-- Private links and files for subject-level long-term assignments.
-- Apply after 202610100001_study_group_long_term_tasks and homework resources.
-- Existing task rows and scalar RPCs retain their contents and permissions.
-- Storage bytes are removed only through the Storage API after a committed
-- retirement claim. SQL never deletes storage.objects or physical files.
begin;

do $long_term_resources_preflight$
begin
  if to_regclass('public.study_group_long_term_tasks') is null
    or to_regclass('storage.objects') is null or to_regclass('storage.buckets') is null
    or to_regprocedure('public.xelay_homework_file_group(text)') is null
    or to_regprocedure('public.xelay_homework_file_mime_allowed(text,text)') is null
    or to_regprocedure('public.xelay_homework_resources_valid(uuid,jsonb,jsonb)') is null
    or to_regprocedure('public.xelay_lock_study_group_long_term_tasks(uuid)') is null
    or to_regprocedure('public.xelay_can_read_study_group_long_term_tasks(uuid)') is null then
    raise exception 'LONG_TERM_TASK_RESOURCE_PREREQUISITES_MISSING'
      using hint='Apply homework resources and 202610100001_study_group_long_term_tasks first. No changes were made.';
  end if;
end;
$long_term_resources_preflight$;

alter table public.study_group_long_term_tasks
  add column if not exists resource_links jsonb not null default '[]'::jsonb,
  add column if not exists resource_attachments jsonb not null default '[]'::jsonb,
  add column if not exists create_request_id uuid;

create or replace function public.xelay_long_term_task_resources_valid(
  p_group_id uuid,p_resource_links jsonb,p_resource_attachments jsonb
)
returns boolean language plpgsql immutable set search_path = '' as $$
declare v_link jsonb; v_value text;
begin
  if not public.xelay_homework_resources_valid(p_group_id,p_resource_links,p_resource_attachments) then return false; end if;
  for v_link in select value from jsonb_array_elements(p_resource_links) loop
    v_value:=v_link #>> '{}';
    -- Backslashes are authority separators in browser URL parsers. Forbid
    -- credentials in the authority and all controls, including in fragments.
    if v_value !~* '^https?://[^/?#[:space:]\\@]+([/?#][^[:space:]\\]*)?$'
      or v_value ~ '[[:cntrl:]]' then return false; end if;
  end loop;
  return true;
end;
$$;

alter table public.study_group_long_term_tasks
  drop constraint if exists study_group_long_term_tasks_resources_check;
alter table public.study_group_long_term_tasks
  add constraint study_group_long_term_tasks_resources_check check(
    public.xelay_long_term_task_resources_valid(group_id,resource_links,resource_attachments));
create index if not exists study_group_long_term_tasks_attachments_idx
  on public.study_group_long_term_tasks using gin(resource_attachments jsonb_path_ops);
create unique index if not exists study_group_long_term_tasks_create_request_idx
  on public.study_group_long_term_tasks(group_id,created_by,create_request_id) where create_request_id is not null;

-- Receipts have no account/group/object FK: removal or deletion of a parent
-- cannot lose pending cleanup. Completion preserves a permanent UUID tombstone.
create table if not exists public.study_group_long_term_task_file_cleanup(
  storage_path text primary key,
  group_id uuid not null,
  object_id uuid,
  cleanup_user_id uuid not null,
  owner_id uuid not null,
  created_at timestamptz not null default clock_timestamp(),
  claim_user_id uuid,
  claim_token uuid,
  claim_expires_at timestamptz,
  completed_at timestamptz,
  check(public.xelay_homework_file_group(storage_path) is not null
    and split_part(storage_path,'/',1)=group_id::text
    and split_part(storage_path,'/',2)=owner_id::text),
  check((claim_user_id is null and claim_token is null and claim_expires_at is null)
    or (claim_user_id is not null and claim_token is not null and claim_expires_at is not null))
);
create index if not exists study_group_long_term_task_file_cleanup_actor_idx
  on public.study_group_long_term_task_file_cleanup(cleanup_user_id,created_at) where completed_at is null;
create index if not exists study_group_long_term_task_file_cleanup_owner_idx
  on public.study_group_long_term_task_file_cleanup(owner_id,created_at) where completed_at is null;
alter table public.study_group_long_term_task_file_cleanup enable row level security;
revoke all on table public.study_group_long_term_task_file_cleanup from public,anon,authenticated,service_role;
grant select on table public.study_group_long_term_task_file_cleanup to authenticated;
drop policy if exists "Users read own long-term task cleanup" on public.study_group_long_term_task_file_cleanup;
create policy "Users read own long-term task cleanup" on public.study_group_long_term_task_file_cleanup
  for select to authenticated using(cleanup_user_id=auth.uid() or owner_id=auth.uid());

create or replace function public.xelay_can_edit_long_term_task_resources(p_group_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and exists(select 1 from public.study_groups g where g.id=p_group_id and (
    g.representative_id=auth.uid() or exists(select 1 from public.study_group_deputy_requests d
      join public.study_group_members m on m.group_id=d.group_id and m.user_id=d.user_id and m.status='accepted'
      where d.group_id=g.id and d.user_id=auth.uid() and d.status='approved' and 'homework'=any(d.permissions))));
$$;

create or replace function public.xelay_can_upload_long_term_task_file(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and public.xelay_homework_file_group(p_name) is not null
    and split_part(p_name,'/',2)=auth.uid()::text
    and public.xelay_can_edit_long_term_task_resources(public.xelay_homework_file_group(p_name))
    and not exists(select 1 from public.study_group_long_term_task_file_cleanup where storage_path=p_name);
$$;

create or replace function public.xelay_can_read_long_term_task_file(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and public.xelay_homework_file_group(p_name) is not null and (
    (public.xelay_can_read_study_group_long_term_tasks(public.xelay_homework_file_group(p_name))
      and exists(select 1 from public.study_group_long_term_tasks t
        where t.group_id=public.xelay_homework_file_group(p_name)
          and t.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name))))
    or (not exists(select 1 from public.study_group_long_term_tasks t
        where t.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name)))
      and exists(select 1 from storage.objects o where o.bucket_id='xelay-long-term-task-files' and o.name=p_name
        and coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner')=split_part(p_name,'/',2)
        and ((split_part(p_name,'/',2)=auth.uid()::text
            and public.xelay_can_edit_long_term_task_resources(public.xelay_homework_file_group(p_name)))
          or exists(select 1 from public.study_group_long_term_task_file_cleanup c
            where c.storage_path=o.name and c.object_id=o.id and c.completed_at is null
              and c.claim_user_id=auth.uid() and c.claim_expires_at>clock_timestamp()
              and (c.owner_id=auth.uid() or c.cleanup_user_id=auth.uid())))))
  );
$$;

create or replace function public.xelay_can_remove_long_term_task_file(p_name text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
begin
  if auth.uid() is null or public.xelay_homework_file_group(p_name) is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:long-term-task-file:'||p_name,0));
  return not exists(select 1 from public.study_group_long_term_tasks t
      where t.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name)))
    and exists(select 1 from storage.objects o
      join public.study_group_long_term_task_file_cleanup c on c.storage_path=o.name and c.object_id=o.id
      where o.bucket_id='xelay-long-term-task-files' and o.name=p_name and c.completed_at is null
        and c.owner_id::text=coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner')
        and c.claim_user_id=auth.uid() and c.claim_expires_at>clock_timestamp()
        and (c.owner_id=auth.uid() or c.cleanup_user_id=auth.uid()));
end;
$$;

create or replace function public.xelay_guard_long_term_task_resources()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_prior jsonb:='[]'::jsonb; v_next jsonb:='[]'::jsonb; v_path text; v_file jsonb;
  v_object storage.objects%rowtype; v_owner text; v_existing boolean; v_object_id uuid;
begin
  if tg_op='UPDATE' and new.create_request_id is distinct from old.create_request_id then
    raise exception 'LONG_TERM_TASK_IDENTITY_IMMUTABLE' using errcode='42501';
  end if;
  if tg_op<>'INSERT' then v_prior:=old.resource_attachments; end if;
  if tg_op<>'DELETE' then
    v_next:=new.resource_attachments;
    if not public.xelay_long_term_task_resources_valid(new.group_id,new.resource_links,v_next) then
      raise exception 'LONG_TERM_TASK_RESOURCE_INVALID_INPUT' using errcode='22023';
    end if;
    -- Closing/reopening or old scalar clients preserve all resources. The
    -- original task guard still checks identity, role and content on every write.
    if tg_op='UPDATE' and new.resource_links is not distinct from old.resource_links
      and v_next is not distinct from v_prior then return new; end if;
    if auth.uid() is not null then perform public.xelay_lock_study_group_long_term_tasks(new.group_id); end if;
  end if;
  -- The deterministic union order also covers detached files, not only retained
  -- uploads. Claim, Storage mutation and publication take the same path locks.
  for v_path in select distinct value->>'storage_path'
    from jsonb_array_elements(v_prior||v_next) order by value->>'storage_path' loop
    perform pg_advisory_xact_lock(hashtextextended('xelay:long-term-task-file:'||v_path,0));
  end loop;
  if tg_op<>'DELETE' then
    for v_file in select value from jsonb_array_elements(v_next) loop
      v_path:=v_file->>'storage_path';
      v_existing:=v_prior @> jsonb_build_array(v_file);
      if v_prior @> jsonb_build_array(jsonb_build_object('storage_path',v_path)) and not v_existing then
        raise exception 'LONG_TERM_TASK_RESOURCE_METADATA_MISMATCH' using errcode='22023';
      end if;
      if not v_existing and split_part(v_path,'/',2) is distinct from auth.uid()::text then
        raise exception 'LONG_TERM_TASK_RESOURCE_FORBIDDEN' using errcode='42501';
      end if;
      if exists(select 1 from public.study_group_long_term_task_file_cleanup where storage_path=v_path) then
        raise exception 'LONG_TERM_TASK_RESOURCE_RETIRED' using errcode='42501';
      end if;
      if exists(select 1 from public.study_group_long_term_tasks t where t.id<>new.id
        and t.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path',v_path))) then
        raise exception 'LONG_TERM_TASK_RESOURCE_ALREADY_ATTACHED' using errcode='22023';
      end if;
      select * into v_object from storage.objects o
        where o.bucket_id='xelay-long-term-task-files' and o.name=v_path for key share;
      if not found then raise exception 'LONG_TERM_TASK_RESOURCE_UPLOAD_MISSING' using errcode='22023'; end if;
      v_owner:=coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),to_jsonb(v_object)->>'owner');
      if v_owner is distinct from split_part(v_path,'/',2) then
        raise exception 'LONG_TERM_TASK_RESOURCE_FORBIDDEN' using errcode='42501';
      end if;
      if coalesce(v_object.metadata->>'size','') !~ '^[0-9]{1,8}$'
        or lower(split_part(coalesce(v_object.metadata->>'mimetype',''),';',1)) is distinct from v_file->>'mime_type' then
        raise exception 'LONG_TERM_TASK_RESOURCE_METADATA_MISMATCH' using errcode='22023';
      end if;
      if (v_object.metadata->>'size')::bigint is distinct from (v_file->>'file_size')::bigint then
        raise exception 'LONG_TERM_TASK_RESOURCE_METADATA_MISMATCH' using errcode='22023';
      end if;
    end loop;
  end if;
  for v_file in select value from jsonb_array_elements(v_prior)
    where not(v_next @> jsonb_build_array(jsonb_build_object('storage_path',value->>'storage_path'))) loop
    v_path:=v_file->>'storage_path';
    select o.id into v_object_id from storage.objects o where o.bucket_id='xelay-long-term-task-files' and o.name=v_path;
    insert into public.study_group_long_term_task_file_cleanup(storage_path,group_id,object_id,cleanup_user_id,owner_id)
      values(v_path,old.group_id,v_object_id,coalesce(auth.uid(),old.created_by),split_part(v_path,'/',2)::uuid)
      on conflict(storage_path) do nothing;
  end loop;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists study_group_long_term_task_resources_guard on public.study_group_long_term_tasks;
create trigger study_group_long_term_task_resources_guard before insert or update or delete
  on public.study_group_long_term_tasks for each row execute function public.xelay_guard_long_term_task_resources();

create or replace function public.xelay_save_study_group_long_term_task_resources(
  p_group_id uuid,p_task_id uuid,p_subject text,p_title text,p_description text,p_due_date date,
  p_resource_links jsonb,p_resource_attachments jsonb,
  p_expected_updated_at timestamptz default null,p_create_request_id uuid default null
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid; v_task public.study_group_long_term_tasks%rowtype;
begin
  perform public.xelay_lock_study_group_long_term_tasks(p_group_id);
  if p_task_id is null then
    if p_expected_updated_at is not null then raise exception 'LONG_TERM_TASK_RESOURCE_INVALID_INPUT' using errcode='22023'; end if;
    if p_create_request_id is not null then
      select id into v_id from public.study_group_long_term_tasks
        where group_id=p_group_id and created_by=auth.uid() and create_request_id=p_create_request_id;
      -- A response lost in transit can be retried. An already created task,
      -- including later edits, is never overwritten by replaying CREATE.
      if found then return v_id; end if;
    end if;
    insert into public.study_group_long_term_tasks(group_id,subject,title,description,due_date,
      resource_links,resource_attachments,created_by,create_request_id)
      values(p_group_id,p_subject,p_title,p_description,p_due_date,
        p_resource_links,p_resource_attachments,auth.uid(),p_create_request_id) returning id into v_id;
  else
    if p_create_request_id is not null then raise exception 'LONG_TERM_TASK_RESOURCE_INVALID_INPUT' using errcode='22023'; end if;
    select * into v_task from public.study_group_long_term_tasks where id=p_task_id and group_id=p_group_id for update;
    if not found then raise exception 'LONG_TERM_TASK_NOT_FOUND' using errcode='22023'; end if;
    if p_expected_updated_at is not null and (not isfinite(p_expected_updated_at)
      or p_expected_updated_at is distinct from v_task.updated_at) then
      raise exception 'LONG_TERM_TASK_CONFLICT' using errcode='40001';
    end if;
    update public.study_group_long_term_tasks set subject=p_subject,title=p_title,description=p_description,
      due_date=p_due_date,resource_links=p_resource_links,resource_attachments=p_resource_attachments
      where id=p_task_id and group_id=p_group_id returning id into v_id;
  end if;
  return v_id;
end;
$$;

-- Claim may also retire a never-published own path after upload/cancel failure.
-- It can claim a missing path: the committed tombstone prevents a delayed
-- in-flight upload from appearing after the client has already cancelled it.
create or replace function public.xelay_claim_long_term_task_file_cleanup(p_storage_paths text[])
returns table(storage_path text,claim_token uuid)
language plpgsql security definer set search_path = '' as $$
declare v_path text; v_queue public.study_group_long_term_task_file_cleanup%rowtype;
  v_object storage.objects%rowtype; v_exists boolean; v_token uuid; v_owner text;
begin
  if auth.uid() is null then raise exception 'LONG_TERM_TASK_RESOURCE_FORBIDDEN' using errcode='42501'; end if;
  if p_storage_paths is null or coalesce(array_ndims(p_storage_paths),1)<>1
    or cardinality(p_storage_paths) not between 1 and 50
    or exists(select 1 from unnest(p_storage_paths) p(name) where public.xelay_homework_file_group(p.name) is null) then
    raise exception 'LONG_TERM_TASK_RESOURCE_INVALID_INPUT' using errcode='22023';
  end if;
  for v_path in select distinct path from unnest(p_storage_paths) p(path) order by path loop
    perform pg_advisory_xact_lock(hashtextextended('xelay:long-term-task-file:'||v_path,0));
  end loop;
  for v_path in select distinct path from unnest(p_storage_paths) p(path) order by path loop
    if exists(select 1 from public.study_group_long_term_tasks t
      where t.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path',v_path))) then continue; end if;
    select * into v_queue from public.study_group_long_term_task_file_cleanup c where c.storage_path=v_path;
    if found then
      if v_queue.owner_id<>auth.uid() and v_queue.cleanup_user_id<>auth.uid() then continue; end if;
      if v_queue.completed_at is not null then continue; end if;
      if v_queue.claim_expires_at>clock_timestamp() and v_queue.claim_user_id<>auth.uid() then continue; end if;
    else
      if split_part(v_path,'/',2) is distinct from auth.uid()::text then continue; end if;
      select * into v_object from storage.objects o where o.bucket_id='xelay-long-term-task-files' and o.name=v_path for key share;
      v_exists:=found;
      if v_exists then
        v_owner:=coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),to_jsonb(v_object)->>'owner');
        if v_owner is distinct from auth.uid()::text then continue; end if;
      elsif not public.xelay_can_edit_long_term_task_resources(public.xelay_homework_file_group(v_path)) then
        continue;
      end if;
      -- Ownership of an existing unreferenced upload is sufficient for cleanup
      -- after appointment/membership loss; it does not expose attached content.
      insert into public.study_group_long_term_task_file_cleanup(storage_path,group_id,object_id,cleanup_user_id,owner_id)
        values(v_path,public.xelay_homework_file_group(v_path),case when v_exists then v_object.id else null end,auth.uid(),auth.uid());
    end if;
    select * into v_object from storage.objects o where o.bucket_id='xelay-long-term-task-files' and o.name=v_path for key share;
    if found then
      select * into v_queue from public.study_group_long_term_task_file_cleanup c where c.storage_path=v_path;
      if v_queue.object_id is distinct from v_object.id
        or v_queue.owner_id::text is distinct from coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),to_jsonb(v_object)->>'owner') then continue; end if;
    end if;
    v_token:=gen_random_uuid();
    update public.study_group_long_term_task_file_cleanup c set claim_user_id=auth.uid(),claim_token=v_token,
      claim_expires_at=clock_timestamp()+interval '5 minutes' where c.storage_path=v_path;
    storage_path:=v_path; claim_token:=v_token; return next;
  end loop;
end;
$$;

create or replace function public.xelay_ack_long_term_task_file_cleanup(p_storage_path text,p_claim_token uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare v_queue public.study_group_long_term_task_file_cleanup%rowtype;
begin
  if auth.uid() is null or public.xelay_homework_file_group(p_storage_path) is null or p_claim_token is null then
    raise exception 'LONG_TERM_TASK_RESOURCE_FORBIDDEN' using errcode='42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:long-term-task-file:'||p_storage_path,0));
  select * into v_queue from public.study_group_long_term_task_file_cleanup where storage_path=p_storage_path;
  if not found or (v_queue.owner_id<>auth.uid() and v_queue.cleanup_user_id<>auth.uid())
    or v_queue.claim_user_id is distinct from auth.uid() or v_queue.claim_token is distinct from p_claim_token then
    raise exception 'LONG_TERM_TASK_RESOURCE_FORBIDDEN' using errcode='42501';
  end if;
  if v_queue.completed_at is not null then return; end if;
  if exists(select 1 from storage.objects where bucket_id='xelay-long-term-task-files' and name=p_storage_path)
    or exists(select 1 from public.study_group_long_term_tasks t
      where t.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_storage_path))) then
    raise exception 'LONG_TERM_TASK_RESOURCE_CLEANUP_PENDING' using errcode='55000';
  end if;
  update public.study_group_long_term_task_file_cleanup set completed_at=clock_timestamp()
    where storage_path=p_storage_path;
end;
$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('xelay-long-term-task-files','xelay-long-term-task-files',false,20971520,array[
  'application/pdf','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/plain','text/csv','image/jpeg','image/png','image/webp','application/zip','application/x-zip-compressed'
]) on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,
  allowed_mime_types=excluded.allowed_mime_types;

-- Storage finalizes metadata using a privileged role. Allow that initial
-- finalization without allowing clients to overwrite bytes, identity or owner.
create or replace function public.xelay_guard_long_term_task_file_storage()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_owner text; v_role text:=coalesce(current_setting('role',true),'none');
begin
  if tg_op='DELETE' then
    if old.bucket_id<>'xelay-long-term-task-files' then return old; end if;
    perform pg_advisory_xact_lock(hashtextextended('xelay:long-term-task-file:'||old.name,0));
    if not exists(select 1 from public.study_group_long_term_task_file_cleanup c
      where c.storage_path=old.name and c.object_id=old.id and c.completed_at is null
        and c.owner_id::text=coalesce(nullif(to_jsonb(old)->>'owner_id',''),to_jsonb(old)->>'owner')) then
      raise exception 'LONG_TERM_TASK_RESOURCE_CLEANUP_CLAIM_REQUIRED' using errcode='42501';
    end if;
    if exists(select 1 from public.study_group_long_term_tasks t
      where t.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path',old.name))) then
      raise exception 'LONG_TERM_TASK_RESOURCE_ALREADY_ATTACHED' using errcode='42501';
    end if;
    if v_role in('anon','authenticated') and not public.xelay_can_remove_long_term_task_file(old.name) then
      raise exception 'LONG_TERM_TASK_RESOURCE_FORBIDDEN' using errcode='42501';
    end if;
    return old;
  end if;
  if tg_op='UPDATE' then
    if new.bucket_id<>'xelay-long-term-task-files' and old.bucket_id<>'xelay-long-term-task-files' then return new; end if;
    if new.bucket_id is distinct from old.bucket_id or new.name is distinct from old.name or new.id is distinct from old.id
      or coalesce(nullif(to_jsonb(new)->>'owner_id',''),to_jsonb(new)->>'owner') is distinct from
        coalesce(nullif(to_jsonb(old)->>'owner_id',''),to_jsonb(old)->>'owner') then
      raise exception 'LONG_TERM_TASK_RESOURCE_IDENTITY_IMMUTABLE' using errcode='42501';
    end if;
    if v_role in('anon','authenticated') then raise exception 'LONG_TERM_TASK_RESOURCE_FORBIDDEN' using errcode='42501'; end if;
    if old.metadata ? 'size' and (new.metadata->>'size' is distinct from old.metadata->>'size'
      or new.metadata->>'mimetype' is distinct from old.metadata->>'mimetype') then
      raise exception 'LONG_TERM_TASK_RESOURCE_METADATA_MISMATCH' using errcode='22023';
    end if;
  elsif new.bucket_id<>'xelay-long-term-task-files' then return new;
  end if;
  if public.xelay_homework_file_group(new.name) is null then
    raise exception 'LONG_TERM_TASK_RESOURCE_INVALID_INPUT' using errcode='22023';
  end if;
  v_owner:=coalesce(nullif(to_jsonb(new)->>'owner_id',''),to_jsonb(new)->>'owner');
  if v_owner is distinct from split_part(new.name,'/',2) then
    raise exception 'LONG_TERM_TASK_RESOURCE_FORBIDDEN' using errcode='42501';
  end if;
  if tg_op='INSERT' then
    -- Keep role/membership then path lock order identical to task publication.
    if auth.uid() is not null then
      perform public.xelay_lock_study_group_long_term_tasks(public.xelay_homework_file_group(new.name));
      if v_owner is distinct from auth.uid()::text then raise exception 'LONG_TERM_TASK_RESOURCE_FORBIDDEN' using errcode='42501'; end if;
    elsif v_role not in('none','postgres','supabase_admin','service_role') then
      raise exception 'LONG_TERM_TASK_RESOURCE_FORBIDDEN' using errcode='42501';
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:long-term-task-file:'||new.name,0));
  if exists(select 1 from public.study_group_long_term_task_file_cleanup where storage_path=new.name) then
    raise exception 'LONG_TERM_TASK_RESOURCE_RETIRED' using errcode='42501';
  end if;
  if new.metadata ? 'size' then
    if coalesce(new.metadata->>'size','') !~ '^[0-9]{1,8}$'
      or not public.xelay_homework_file_mime_allowed(new.name,lower(split_part(coalesce(new.metadata->>'mimetype',''),';',1))) then
      raise exception 'LONG_TERM_TASK_RESOURCE_METADATA_MISMATCH' using errcode='22023';
    end if;
    if (new.metadata->>'size')::bigint not between 1 and 20971520 then
      raise exception 'LONG_TERM_TASK_RESOURCE_METADATA_MISMATCH' using errcode='22023';
    end if;
  end if;
  return new;
end;
$$;
drop trigger if exists study_group_long_term_task_file_storage_guard on storage.objects;
create trigger study_group_long_term_task_file_storage_guard before insert or update or delete on storage.objects
  for each row execute function public.xelay_guard_long_term_task_file_storage();

drop policy if exists "Homework managers upload long-term task files" on storage.objects;
create policy "Homework managers upload long-term task files" on storage.objects for insert to authenticated
  with check(bucket_id='xelay-long-term-task-files' and public.xelay_can_upload_long_term_task_file(name)
    and coalesce(nullif(to_jsonb(objects)->>'owner_id',''),to_jsonb(objects)->>'owner')=auth.uid()::text);
drop policy if exists "Accepted members read long-term task files" on storage.objects;
create policy "Accepted members read long-term task files" on storage.objects for select to authenticated
  using(bucket_id='xelay-long-term-task-files' and public.xelay_can_read_long_term_task_file(name));
drop policy if exists "Users remove claimed long-term task files" on storage.objects;
create policy "Users remove claimed long-term task files" on storage.objects for delete to authenticated
  using(bucket_id='xelay-long-term-task-files' and public.xelay_can_remove_long_term_task_file(name));

-- Restrictive bucket guards prevent broad legacy permissive policies from
-- granting anonymous access or allowing uploads/deletes outside these rules.
drop policy if exists "Long-term task file upload guard" on storage.objects;
create policy "Long-term task file upload guard" on storage.objects as restrictive for insert to anon,authenticated
  with check(bucket_id<>'xelay-long-term-task-files' or (public.xelay_can_upload_long_term_task_file(name)
    and coalesce(nullif(to_jsonb(objects)->>'owner_id',''),to_jsonb(objects)->>'owner')=auth.uid()::text));
drop policy if exists "Long-term task file read guard" on storage.objects;
create policy "Long-term task file read guard" on storage.objects as restrictive for select to anon,authenticated
  using(bucket_id<>'xelay-long-term-task-files' or public.xelay_can_read_long_term_task_file(name));
drop policy if exists "Long-term task file removal guard" on storage.objects;
create policy "Long-term task file removal guard" on storage.objects as restrictive for delete to anon,authenticated
  using(bucket_id<>'xelay-long-term-task-files' or public.xelay_can_remove_long_term_task_file(name));
drop policy if exists "Long-term task file overwrite guard" on storage.objects;
create policy "Long-term task file overwrite guard" on storage.objects as restrictive for update to anon,authenticated
  using(bucket_id<>'xelay-long-term-task-files') with check(bucket_id<>'xelay-long-term-task-files');

revoke all on function public.xelay_long_term_task_resources_valid(uuid,jsonb,jsonb),
  public.xelay_can_edit_long_term_task_resources(uuid),public.xelay_can_upload_long_term_task_file(text),
  public.xelay_can_read_long_term_task_file(text),public.xelay_can_remove_long_term_task_file(text),
  public.xelay_guard_long_term_task_resources(),public.xelay_guard_long_term_task_file_storage(),
  public.xelay_save_study_group_long_term_task_resources(uuid,uuid,text,text,text,date,jsonb,jsonb,timestamptz,uuid),
  public.xelay_claim_long_term_task_file_cleanup(text[]),public.xelay_ack_long_term_task_file_cleanup(text,uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_long_term_task_resources_valid(uuid,jsonb,jsonb) to authenticated;
grant execute on function public.xelay_save_study_group_long_term_task_resources(uuid,uuid,text,text,text,date,jsonb,jsonb,timestamptz,uuid),
  public.xelay_claim_long_term_task_file_cleanup(text[]),public.xelay_ack_long_term_task_file_cleanup(text,uuid) to authenticated;
-- Unrelated bucket policy evaluation must return false, not an EXECUTE error.
grant execute on function public.xelay_can_upload_long_term_task_file(text),
  public.xelay_can_read_long_term_task_file(text),public.xelay_can_remove_long_term_task_file(text) to anon,authenticated;

comment on column public.study_group_long_term_tasks.resource_links is
  'Up to ten complete HTTP(S) resources without credentials, private to accepted group members.';
comment on column public.study_group_long_term_tasks.resource_attachments is
  'Up to ten immutable private xelay-long-term-task-files descriptors: storage_path,file_name,mime_type,file_size; maximum 20 MiB each. Never shared across tasks.';
comment on column public.study_group_long_term_tasks.create_request_id is
  'Immutable actor/group scoped idempotency UUID. Lost CREATE responses can be retried without overwriting subsequent edits. Legacy rows keep NULL.';
comment on table public.study_group_long_term_task_file_cleanup is
  'Private persistent retirement queue. Claim paths, remove through Storage API, acknowledge absence. Completed UUID tombstones permanently prevent reattachment and reupload.';
notify pgrst,'reload schema';
commit;
