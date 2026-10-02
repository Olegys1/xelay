-- Personal deputy permissions inside an existing accepted study-group membership.
-- Ownership, billing and appointment of deputies remain with the actual representative.
begin;

do $$
begin
  if to_regclass('public.study_group_members') is null
    or to_regclass('public.study_group_seminar_file_cleanup') is null
    or to_regclass('public.group_annual_entitlements') is null
    or to_regprocedure('public.xelay_can_read_study_group_membership(uuid,uuid,text)') is null
    or to_regprocedure('public.xelay_homework_resources_valid(uuid,jsonb,jsonb)') is null then
    raise exception 'Apply study-group, homework-resource, seminar-resource, roster visibility (202610020005) and annual-billing migrations before deputies';
  end if;
end;
$$;

create or replace function public.xelay_normalize_study_group_permissions(p_permissions text[])
returns text[] language plpgsql immutable set search_path = public, pg_temp
as $$
declare v_allowed constant text[] := array['schedule','homework','seminars','seminar_resources','seminar_comments','invite_members','remove_members'];
begin
  if p_permissions is null or coalesce(array_ndims(p_permissions),1) <> 1
    or cardinality(p_permissions) > 7
    or exists (select 1 from unnest(p_permissions) as requested(permission)
      where permission is null or not (permission = any(v_allowed))) then
    raise exception 'DEPUTY_INVALID_PERMISSIONS' using errcode = '22023';
  end if;
  return array(select p from unnest(v_allowed) with ordinality as allowed(p,n)
    where p = any(p_permissions) order by n);
end;
$$;

create table if not exists public.study_group_deputy_requests (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.study_groups(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled','revoked')),
  permissions text[] not null default '{}'::text[],
  message text check (message is null or length(message) <= 1000),
  created_at timestamptz not null default now(),
  reviewed_by uuid references public.profiles(id) on delete set null,
  reviewed_at timestamptz,
  updated_at timestamptz not null default now(),
  constraint study_group_deputy_one_current_row unique(group_id,user_id),
  constraint study_group_deputy_permissions_valid check (
    permissions = public.xelay_normalize_study_group_permissions(permissions)
    and (status = 'approved' or cardinality(permissions) = 0)
  ),
  constraint study_group_deputy_review_valid check (
    (status = 'pending' and reviewed_by is null and reviewed_at is null)
    or (status <> 'pending' and reviewed_at is not null)
  )
);
create index if not exists study_group_deputy_group_status_idx
  on public.study_group_deputy_requests(group_id,status,created_at);
create index if not exists study_group_deputy_user_idx
  on public.study_group_deputy_requests(user_id,updated_at desc);

create or replace function public.xelay_study_group_permissions(p_group_id uuid)
returns text[] language sql stable security definer set search_path = public, pg_temp
as $$
  select case
    when auth.uid() is null or not exists (select 1 from public.study_groups where id=p_group_id) then '{}'::text[]
    when public.xelay_is_study_group_representative(p_group_id) or public.xelay_is_platform_admin()
      then array['schedule','homework','seminars','seminar_resources','seminar_comments','invite_members','remove_members']::text[]
    else coalesce((select d.permissions from public.study_group_deputy_requests d
      where d.group_id=p_group_id and d.user_id=auth.uid() and d.status='approved'
      and exists (select 1 from public.study_group_members m
        where m.group_id=d.group_id and m.user_id=d.user_id and m.status='accepted')), '{}'::text[])
    end;
$$;

create or replace function public.xelay_has_study_group_permission(p_group_id uuid,p_permission text)
returns boolean language sql volatile security definer set search_path = public, pg_temp
as $$ select coalesce(p_permission = any(public.xelay_study_group_permissions(p_group_id)),false); $$;

-- Share the existing seminar lock for roles, resources, membership and content.
-- The permission query happens after acquiring the lock with a fresh snapshot.
create or replace function public.xelay_lock_study_group_permission(
  p_group_id uuid,p_permission text,p_require_license boolean default true
)
returns void language plpgsql volatile security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'DEPUTY_AUTH_REQUIRED' using errcode='42501'; end if;
  if p_group_id is null then raise exception 'DEPUTY_GROUP_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || p_group_id::text,0));
  if not exists (select 1 from public.study_groups where id=p_group_id) then raise exception 'DEPUTY_GROUP_NOT_FOUND'; end if;
  if not public.xelay_has_study_group_permission(p_group_id,p_permission) then
    raise exception 'STUDY_GROUP_PERMISSION_REQUIRED' using errcode='42501';
  end if;
  if p_require_license and not exists (select 1 from public.billing_settings b where b.singleton
    and (not b.enforce_group_payment or public.xelay_group_has_access(p_group_id))) then
    raise exception 'GROUP_LICENSE_REQUIRED' using errcode='42501';
  end if;
end;
$$;

create or replace function public.xelay_lock_study_group_deputy_reviewer(p_group_id uuid)
returns void language plpgsql volatile security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'DEPUTY_AUTH_REQUIRED' using errcode='42501'; end if;
  if p_group_id is null then raise exception 'DEPUTY_REQUEST_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || p_group_id::text,0));
  -- Platform administrators may inspect requests, but cannot delegate this ownership power.
  if not public.xelay_is_study_group_representative(p_group_id) then
    raise exception 'DEPUTY_REPRESENTATIVE_REQUIRED' using errcode='42501';
  end if;
end;
$$;

create or replace function public.xelay_submit_study_group_deputy_request(p_group_id uuid,p_message text default null)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_request public.study_group_deputy_requests%rowtype; v_message text := nullif(btrim(p_message),''); v_id uuid;
begin
  if auth.uid() is null then raise exception 'DEPUTY_AUTH_REQUIRED' using errcode='42501'; end if;
  if p_group_id is null then raise exception 'DEPUTY_GROUP_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || p_group_id::text,0));
  if not exists (select 1 from public.study_groups where id=p_group_id) then raise exception 'DEPUTY_GROUP_NOT_FOUND'; end if;
  if public.xelay_is_study_group_representative(p_group_id) then raise exception 'DEPUTY_CANNOT_APPLY_AS_REPRESENTATIVE'; end if;
  if not exists (select 1 from public.study_group_members where group_id=p_group_id and user_id=auth.uid() and status='accepted') then
    raise exception 'DEPUTY_MEMBER_REQUIRED' using errcode='42501';
  end if;
  if length(coalesce(v_message,'')) > 1000 then raise exception 'DEPUTY_INVALID_MESSAGE'; end if;
  select * into v_request from public.study_group_deputy_requests
    where group_id=p_group_id and user_id=auth.uid() for update;
  if found and v_request.status in ('pending','approved') then raise exception 'DEPUTY_ALREADY_ACTIVE'; end if;
  insert into public.study_group_deputy_requests(group_id,user_id,message)
    values(p_group_id,auth.uid(),v_message)
    on conflict(group_id,user_id) do update set status='pending',permissions='{}'::text[],
      message=excluded.message,created_at=now(),reviewed_by=null,reviewed_at=null,updated_at=now()
    returning id into v_id;
  return v_id;
end;
$$;

create or replace function public.xelay_cancel_study_group_deputy_request(p_request_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid; v_request public.study_group_deputy_requests%rowtype;
begin
  if auth.uid() is null then raise exception 'DEPUTY_AUTH_REQUIRED' using errcode='42501'; end if;
  select group_id into v_group_id from public.study_group_deputy_requests where id=p_request_id and user_id=auth.uid();
  if v_group_id is null then raise exception 'DEPUTY_REQUEST_NOT_FOUND'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || v_group_id::text,0));
  select * into v_request from public.study_group_deputy_requests where id=p_request_id and user_id=auth.uid() for update;
  if not found then raise exception 'DEPUTY_REQUEST_NOT_FOUND'; end if;
  if v_request.status <> 'pending' then raise exception 'DEPUTY_REQUEST_NOT_PENDING'; end if;
  update public.study_group_deputy_requests set status='cancelled',permissions='{}'::text[],reviewed_at=now(),updated_at=now()
    where id=p_request_id;
end;
$$;

create or replace function public.xelay_review_study_group_deputy_request(
  p_request_id uuid,p_approve boolean,p_permissions text[] default '{}'::text[]
)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid; v_request public.study_group_deputy_requests%rowtype; v_permissions text[];
begin
  select group_id into v_group_id from public.study_group_deputy_requests where id=p_request_id;
  perform public.xelay_lock_study_group_deputy_reviewer(v_group_id);
  select * into v_request from public.study_group_deputy_requests where id=p_request_id and group_id=v_group_id for update;
  if not found then raise exception 'DEPUTY_REQUEST_NOT_FOUND'; end if;
  if v_request.status <> 'pending' then raise exception 'DEPUTY_REQUEST_NOT_PENDING'; end if;
  if p_approve is null then raise exception 'DEPUTY_INVALID_PERMISSIONS'; end if;
  v_permissions := public.xelay_normalize_study_group_permissions(p_permissions);
  if p_approve and (public.xelay_is_study_group_representative(v_group_id) and v_request.user_id=auth.uid()
    or not exists (select 1 from public.study_group_members
      where group_id=v_group_id and user_id=v_request.user_id and status='accepted')) then
    raise exception 'DEPUTY_MEMBER_REQUIRED' using errcode='42501';
  end if;
  update public.study_group_deputy_requests set status=case when p_approve then 'approved' else 'rejected' end,
    permissions=case when p_approve then v_permissions else '{}'::text[] end,
    reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now() where id=p_request_id;
end;
$$;

create or replace function public.xelay_update_study_group_deputy_permissions(p_request_id uuid,p_permissions text[])
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid; v_request public.study_group_deputy_requests%rowtype; v_permissions text[];
begin
  select group_id into v_group_id from public.study_group_deputy_requests where id=p_request_id;
  perform public.xelay_lock_study_group_deputy_reviewer(v_group_id);
  select * into v_request from public.study_group_deputy_requests where id=p_request_id and group_id=v_group_id for update;
  if not found then raise exception 'DEPUTY_REQUEST_NOT_FOUND'; end if;
  if v_request.status <> 'approved' then raise exception 'DEPUTY_NOT_APPROVED'; end if;
  if not exists (select 1 from public.study_group_members where group_id=v_group_id and user_id=v_request.user_id and status='accepted') then
    raise exception 'DEPUTY_MEMBER_REQUIRED' using errcode='42501';
  end if;
  v_permissions := public.xelay_normalize_study_group_permissions(p_permissions);
  update public.study_group_deputy_requests set permissions=v_permissions,reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now()
    where id=p_request_id;
end;
$$;

create or replace function public.xelay_revoke_study_group_deputy(p_request_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid; v_request public.study_group_deputy_requests%rowtype;
begin
  select group_id into v_group_id from public.study_group_deputy_requests where id=p_request_id;
  perform public.xelay_lock_study_group_deputy_reviewer(v_group_id);
  select * into v_request from public.study_group_deputy_requests where id=p_request_id and group_id=v_group_id for update;
  if not found then raise exception 'DEPUTY_REQUEST_NOT_FOUND'; end if;
  if v_request.status <> 'approved' then raise exception 'DEPUTY_NOT_APPROVED'; end if;
  update public.study_group_deputy_requests set status='revoked',permissions='{}'::text[],reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now()
    where id=p_request_id;
end;
$$;

-- A removed/changed membership never resurrects a previous deputy appointment.
create or replace function public.xelay_cleanup_study_group_deputy_membership()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
begin
  if tg_op='UPDATE' and new.group_id=old.group_id and new.user_id=old.user_id
    and (old.status <> 'accepted' or new.status='accepted') then return new; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || old.group_id::text,0));
  update public.study_group_deputy_requests set status='revoked',permissions='{}'::text[],
    reviewed_by=auth.uid(),reviewed_at=now(),updated_at=now()
    where group_id=old.group_id and user_id=old.user_id and status in ('pending','approved');
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;
drop trigger if exists study_group_members_deputy_cleanup on public.study_group_members;
create trigger study_group_members_deputy_cleanup before update or delete on public.study_group_members
  for each row execute function public.xelay_cleanup_study_group_deputy_membership();

alter table public.study_group_deputy_requests enable row level security;
drop policy if exists "Study group deputy request visibility" on public.study_group_deputy_requests;
create policy "Study group deputy request visibility" on public.study_group_deputy_requests
  for select to authenticated using (auth.uid() is not null and (
    user_id=auth.uid() or public.xelay_is_study_group_representative(group_id) or public.xelay_is_platform_admin()
  ));
revoke all on public.study_group_deputy_requests from public,anon,authenticated,service_role;
grant select on public.study_group_deputy_requests to authenticated,service_role;

-- Public role badges must not disclose the private application message.
-- Realtime uses the private table policy; group clients refresh this redacted list.
create or replace function public.xelay_list_study_group_deputies(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path = public, pg_temp
as $$
declare v_manage boolean;
begin
  if auth.uid() is null then raise exception 'DEPUTY_AUTH_REQUIRED' using errcode='42501'; end if;
  v_manage := public.xelay_is_study_group_representative(p_group_id) or public.xelay_is_platform_admin();
  if not v_manage and not exists (select 1 from public.study_group_members
    where group_id=p_group_id and user_id=auth.uid() and status='accepted') then
    raise exception 'DEPUTY_MEMBER_REQUIRED' using errcode='42501';
  end if;
  return coalesce((select jsonb_agg(case when v_manage or d.user_id=auth.uid() then to_jsonb(d)
      else to_jsonb(d)||jsonb_build_object('message',null,'reviewed_by',null) end order by d.created_at,d.id)
    from public.study_group_deputy_requests d where d.group_id=p_group_id
      and (v_manage or d.user_id=auth.uid() or d.status='approved')), '[]'::jsonb);
end;
$$;

-- Pending invitations are visible only to people explicitly allowed to manage members.
create or replace function public.xelay_can_read_study_group_membership(p_group_id uuid,p_user_id uuid,p_status text)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and coalesce(p_user_id=auth.uid() or public.xelay_is_platform_admin()
    or public.xelay_is_study_group_representative(p_group_id)
    or ('invite_members'=any(public.xelay_study_group_permissions(p_group_id)))
    or ('remove_members'=any(public.xelay_study_group_permissions(p_group_id)))
    or (p_status='accepted' and exists (select 1 from public.study_group_members m
      where m.group_id=p_group_id and m.user_id=auth.uid() and m.status='accepted')),false);
$$;

create or replace function public.xelay_invite_to_study_group(p_group_id uuid,p_username text)
returns uuid language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_user_id uuid; v_member_id uuid; v_member_status text;
begin
  perform public.xelay_lock_study_group_permission(p_group_id,'invite_members',false);
  select id into v_user_id from public.profiles where lower(username)=lower(regexp_replace(btrim(p_username),'^@',''));
  if v_user_id is null then raise exception 'Xelay user not found'; end if;
  if exists (select 1 from public.study_groups where id=p_group_id and representative_id=v_user_id) then
    raise exception 'The user is already the group representative';
  end if;
  select id,status into v_member_id,v_member_status from public.study_group_members
    where group_id=p_group_id and user_id=v_user_id for update;
  if found and v_member_status in ('accepted','pending') then return v_member_id; end if;
  if found then
    update public.study_group_members set status='pending',invited_by=auth.uid(),created_at=now(),updated_at=now(),accepted_at=null
      where id=v_member_id;
  else
    insert into public.study_group_members(group_id,user_id,invited_by,status)
      values(p_group_id,v_user_id,auth.uid(),'pending') returning id into v_member_id;
  end if;
  return v_member_id;
end;
$$;

-- Resource changes use their own permission, including cascaded deletion of an
-- assignment/subject/recurring lesson with files. Unchanged materials do not
-- require this permission when a seminars-only editor changes the assignment.
create or replace function public.xelay_validate_seminar_resources()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_item jsonb; v_path text; v_paths text[] := '{}'; v_metadata jsonb;
  v_object_owner text; v_existing boolean;
begin
  if tg_op='DELETE' then
    if (jsonb_array_length(old.resource_links)>0 or jsonb_array_length(old.resource_attachments)>0)
      and exists (select 1 from public.study_groups where id=old.group_id) then
      perform public.xelay_lock_study_group_permission(old.group_id,'seminar_resources',true);
    end if;
  else
    if not public.xelay_homework_resources_valid(new.group_id,new.resource_links,new.resource_attachments) then
      raise exception 'SEMINAR_RESOURCE_INVALID_INPUT' using errcode='23514';
    end if;
    if tg_op='UPDATE' then
      if new.group_id is distinct from old.group_id or new.created_by is distinct from old.created_by
        or new.id is distinct from old.id then
        raise exception 'STUDY_GROUP_CONTENT_IDENTITY_IMMUTABLE' using errcode='23514';
      end if;
      if new.resource_links is not distinct from old.resource_links
        and new.resource_attachments is not distinct from old.resource_attachments then return new; end if;
    elsif jsonb_array_length(new.resource_links)=0 and jsonb_array_length(new.resource_attachments)=0 then
      return new;
    end if;
    perform public.xelay_lock_study_group_permission(new.group_id,'seminar_resources',true);
    for v_item in select value from jsonb_array_elements(new.resource_attachments) loop
      v_paths := array_append(v_paths,v_item->>'storage_path');
    end loop;
  end if;
  if tg_op in ('UPDATE','DELETE') then
    for v_item in select value from jsonb_array_elements(old.resource_attachments) loop
      v_paths := array_append(v_paths,v_item->>'storage_path');
    end loop;
  end if;
  for v_path in select distinct path from unnest(v_paths) as paths(path) order by path loop
    perform pg_advisory_xact_lock(hashtextextended('xelay:seminar-file:' || v_path,0));
  end loop;
  if tg_op<>'DELETE' then
    for v_item in select value from jsonb_array_elements(new.resource_attachments) loop
      v_existing := false;
      if tg_op='UPDATE' then v_existing := old.resource_attachments @> jsonb_build_array(v_item); end if;
      v_path := v_item->>'storage_path';
      if exists (select 1 from public.study_group_seminars s where s.id<>new.id
        and s.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path',v_path))) then
        raise exception 'SEMINAR_RESOURCE_ALREADY_ATTACHED' using errcode='23514';
      end if;
      if not v_existing and split_part(v_path,'/',2) is distinct from auth.uid()::text then
        raise exception 'SEMINAR_RESOURCE_FORBIDDEN' using errcode='42501';
      end if;
      select o.metadata,coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')
        into v_metadata,v_object_owner from storage.objects o
        where o.bucket_id='xelay-seminar-files' and o.name=v_path for key share;
      if not found then raise exception 'SEMINAR_RESOURCE_UPLOAD_MISSING' using errcode='23514'; end if;
      if not v_existing and v_object_owner is distinct from auth.uid()::text then
        raise exception 'SEMINAR_RESOURCE_FORBIDDEN' using errcode='42501';
      end if;
      if coalesce(v_metadata->>'size','') !~ '^[0-9]+$'
        or (v_metadata->>'mimetype') is distinct from (v_item->>'mime_type') then
        raise exception 'SEMINAR_RESOURCE_METADATA_MISMATCH' using errcode='23514';
      end if;
      if (v_metadata->>'size')::numeric <> (v_item->>'file_size')::numeric then
        raise exception 'SEMINAR_RESOURCE_METADATA_MISMATCH' using errcode='23514';
      end if;
      delete from public.study_group_seminar_file_cleanup where storage_path=v_path;
    end loop;
  end if;
  if tg_op in ('UPDATE','DELETE') then
    for v_item in select value from jsonb_array_elements(old.resource_attachments) loop
      v_path := v_item->>'storage_path';
      if tg_op='UPDATE' then
        if new.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path',v_path)) then continue; end if;
      end if;
      insert into public.study_group_seminar_file_cleanup(storage_path,cleanup_user_id,owner_id)
        values(v_path,coalesce(auth.uid(),old.created_by),split_part(v_path,'/',2)::uuid)
        on conflict(storage_path) do update set cleanup_user_id=excluded.cleanup_user_id,created_at=now();
    end loop;
  end if;
  if tg_op='DELETE' then return old; end if;
  return new;
end;
$$;

create or replace function public.xelay_update_seminar_resources(
  p_seminar_id uuid,p_resource_links jsonb,p_resource_attachments jsonb
)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid;
begin
  select group_id into v_group_id from public.study_group_seminars where id=p_seminar_id;
  if v_group_id is null then raise exception 'SEMINAR_NOT_FOUND'; end if;
  perform public.xelay_lock_study_group_permission(v_group_id,'seminar_resources',true);
  if not public.xelay_homework_resources_valid(v_group_id,p_resource_links,p_resource_attachments) then
    raise exception 'SEMINAR_RESOURCE_INVALID_INPUT' using errcode='23514';
  end if;
  update public.study_group_seminars set resource_links=p_resource_links,
    resource_attachments=p_resource_attachments,updated_at=now() where id=p_seminar_id and group_id=v_group_id;
  if not found then raise exception 'SEMINAR_NOT_FOUND'; end if;
end;
$$;

create or replace function public.xelay_ack_seminar_file_cleanup(p_storage_path text)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid := public.xelay_homework_file_group(p_storage_path);
begin
  if auth.uid() is null or v_group_id is null then raise exception 'SEMINAR_RESOURCE_FORBIDDEN' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || v_group_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminar-file:' || p_storage_path,0));
  if not exists (select 1 from public.study_group_seminar_file_cleanup where storage_path=p_storage_path
    and (cleanup_user_id=auth.uid() or owner_id=auth.uid())) then
    raise exception 'SEMINAR_RESOURCE_FORBIDDEN' using errcode='42501';
  end if;
  if exists (select 1 from storage.objects where bucket_id='xelay-seminar-files' and name=p_storage_path) then
    raise exception 'SEMINAR_RESOURCE_CLEANUP_PENDING';
  end if;
  if exists (select 1 from public.study_group_seminars
    where resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_storage_path))) then
    raise exception 'SEMINAR_RESOURCE_CLEANUP_PENDING';
  end if;
  delete from public.study_group_seminar_file_cleanup where storage_path=p_storage_path
    and (cleanup_user_id=auth.uid() or owner_id=auth.uid());
end;
$$;

drop policy if exists "Users read own seminar file cleanup" on public.study_group_seminar_file_cleanup;
create policy "Users read own seminar file cleanup" on public.study_group_seminar_file_cleanup
  for select to authenticated using (cleanup_user_id=auth.uid() or owner_id=auth.uid());

create or replace function public.xelay_notify_study_group_deputy_request()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_rep uuid; v_name text; v_type text; v_message text; v_actor_id uuid; v_actor_name text;
begin
  select g.representative_id,g.group_name into v_rep,v_name from public.study_groups g where g.id=new.group_id;
  if v_rep is null or not exists (select 1 from public.profiles where id=new.user_id) then return new; end if;
  v_actor_id := coalesce(auth.uid(),v_rep);
  select full_name into v_actor_name from public.profiles where id=v_actor_id;
  if tg_op='INSERT' or (new.status='pending' and old.status<>'pending') then
    select full_name into v_actor_name from public.profiles where id=new.user_id;
    insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,study_group_id)
      values(v_rep,new.user_id,coalesce(nullif(v_actor_name,''),'Учасник'),'group_deputy_request',
        'подав(-ла) заявку на заступника старости у групі «' || v_name || '».',false,new.group_id);
    return new;
  end if;
  if new.status='approved' and old.status<>'approved' then
    v_type := 'group_deputy_approved'; v_message := 'схвалив(-ла) вашу заявку на заступника у групі «' || v_name || '».';
  elsif new.status='rejected' and old.status<>'rejected' then
    v_type := 'group_deputy_rejected'; v_message := 'відхилив(-ла) вашу заявку на заступника у групі «' || v_name || '».';
  elsif new.status='revoked' and old.status<>'revoked' then
    v_type := 'group_deputy_revoked'; v_message := 'скасував(-ла) ваші повноваження заступника у групі «' || v_name || '».';
  elsif new.status='approved' and new.permissions is distinct from old.permissions then
    v_type := 'group_deputy_permissions'; v_message := 'змінив(-ла) ваші права заступника у групі «' || v_name || '».';
  else return new;
  end if;
  insert into public.notifications(recipient_id,actor_id,actor_name,type,message,is_read,study_group_id)
    values(new.user_id,v_actor_id,coalesce(nullif(v_actor_name,''),'Староста'),v_type,v_message,false,new.group_id);
  return new;
end;
$$;
drop trigger if exists study_group_deputy_notifications on public.study_group_deputy_requests;
create trigger study_group_deputy_notifications after insert or update on public.study_group_deputy_requests
  for each row execute function public.xelay_notify_study_group_deputy_request();



create or replace function public.xelay_remove_study_group_member(p_member_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid; v_member public.study_group_members%rowtype;
begin
  select group_id into v_group_id from public.study_group_members where id=p_member_id;
  if v_group_id is null then raise exception 'Study group member not found'; end if;
  perform public.xelay_lock_study_group_permission(v_group_id,'remove_members',false);
  select * into v_member from public.study_group_members where id=p_member_id and group_id=v_group_id for update;
  if not found then raise exception 'Study group member not found'; end if;
  if v_member.user_id=auth.uid() or exists (select 1 from public.study_groups
    where id=v_group_id and representative_id=v_member.user_id) then
    raise exception 'The representative and your own membership cannot be removed' using errcode='42501';
  end if;
  -- Removing another deputy would implicitly revoke an appointment. Only its owner can do that.
  if not public.xelay_is_study_group_representative(v_group_id) and exists (
    select 1 from public.study_group_deputy_requests where group_id=v_group_id and user_id=v_member.user_id and status='approved'
  ) then raise exception 'DEPUTY_REPRESENTATIVE_REQUIRED' using errcode='42501'; end if;
  update public.study_group_members set status='removed',updated_at=now()
    where id=p_member_id and status in ('accepted','pending');
end;
$$;

-- Replace the old FOR ALL author=viewer policies with separate mutation policies.
-- An editor can change the representative's assignment without changing its author.
drop policy if exists "Representatives manage group schedules" on public.study_group_schedule;
drop policy if exists "Representatives manage group homework" on public.study_group_homework;
drop policy if exists "Delegated schedule insert" on public.study_group_schedule;
create policy "Delegated schedule insert" on public.study_group_schedule for insert to authenticated
  with check (public.xelay_has_study_group_permission(group_id,'schedule') and created_by=auth.uid());
drop policy if exists "Delegated schedule update" on public.study_group_schedule;
create policy "Delegated schedule update" on public.study_group_schedule for update to authenticated
  using (public.xelay_has_study_group_permission(group_id,'schedule'))
  with check (public.xelay_has_study_group_permission(group_id,'schedule'));
drop policy if exists "Delegated schedule delete" on public.study_group_schedule;
create policy "Delegated schedule delete" on public.study_group_schedule for delete to authenticated
  using (public.xelay_has_study_group_permission(group_id,'schedule'));
drop policy if exists "Delegated homework insert" on public.study_group_homework;
create policy "Delegated homework insert" on public.study_group_homework for insert to authenticated
  with check (public.xelay_has_study_group_permission(group_id,'homework') and created_by=auth.uid());
drop policy if exists "Delegated homework update" on public.study_group_homework;
create policy "Delegated homework update" on public.study_group_homework for update to authenticated
  using (public.xelay_has_study_group_permission(group_id,'homework'))
  with check (public.xelay_has_study_group_permission(group_id,'homework'));
drop policy if exists "Delegated homework delete" on public.study_group_homework;
create policy "Delegated homework delete" on public.study_group_homework for delete to authenticated
  using (public.xelay_has_study_group_permission(group_id,'homework'));

create or replace function public.xelay_validate_study_group_delegated_content()
returns trigger language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid; v_permission text;
begin
  v_group_id := case when tg_op='DELETE' then old.group_id else new.group_id end;
  v_permission := case when tg_table_name='study_group_schedule' then 'schedule' else 'homework' end;
  -- Only a privileged parent deletion can reach this cascade: clients have no
  -- DELETE privilege on study_groups. Preserve its existing child cleanup.
  if tg_op='DELETE' and not exists (select 1 from public.study_groups where id=v_group_id) then return old; end if;
  -- INSERT/UPDATE retain the original billing guard; DELETE was previously allowed after expiry.
  perform public.xelay_lock_study_group_permission(v_group_id,v_permission,tg_op<>'DELETE');
  if tg_op='UPDATE' then
    if new.id is distinct from old.id or new.group_id is distinct from old.group_id
      or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
      raise exception 'STUDY_GROUP_CONTENT_IDENTITY_IMMUTABLE' using errcode='23514';
    end if;
    if tg_table_name='study_group_homework' then
      if new.schedule_item_id is distinct from old.schedule_item_id or new.lesson_date is distinct from old.lesson_date then
        raise exception 'STUDY_GROUP_CONTENT_IDENTITY_IMMUTABLE' using errcode='23514';
      end if;
    end if;
  elsif tg_op='INSERT' and new.created_by is distinct from auth.uid() then
    raise exception 'STUDY_GROUP_CONTENT_AUTHOR_REQUIRED' using errcode='42501';
  end if;
  if tg_table_name='study_group_schedule' then
    if tg_op='DELETE' and exists (select 1 from public.study_group_homework where schedule_item_id=old.id) then
      perform public.xelay_lock_study_group_permission(v_group_id,'homework',false);
    elsif tg_op='UPDATE' and exists (select 1 from public.study_group_homework h where h.schedule_item_id=old.id
      and (extract(isodow from h.lesson_date)::smallint <> new.weekday
        or h.lesson_date not between new.valid_from and new.valid_until)) then
      raise exception 'STUDY_GROUP_SCHEDULE_HAS_HOMEWORK' using errcode='23514';
    end if;
  end if;
  if tg_op='DELETE' then return old; end if;
  new.updated_at := now();
  return new;
end;
$$;
drop trigger if exists study_group_schedule_delegated_guard on public.study_group_schedule;
create trigger study_group_schedule_delegated_guard before insert or update or delete on public.study_group_schedule
  for each row execute function public.xelay_validate_study_group_delegated_content();
drop trigger if exists study_group_homework_delegated_guard on public.study_group_homework;
create trigger study_group_homework_delegated_guard before insert or update or delete on public.study_group_homework
  for each row execute function public.xelay_validate_study_group_delegated_content();

create or replace function public.xelay_can_edit_homework_resources(p_group_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and 'homework'=any(public.xelay_study_group_permissions(p_group_id))
    and exists (select 1 from public.billing_settings b where b.singleton
      and (not b.enforce_group_payment or public.xelay_group_has_access(p_group_id)));
$$;

create or replace function public.xelay_can_upload_homework_file(p_name text)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid := public.xelay_homework_file_group(p_name);
begin
  if auth.uid() is null or v_group_id is null or split_part(p_name,'/',2)<>auth.uid()::text then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || v_group_id::text,0));
  return public.xelay_can_edit_homework_resources(v_group_id);
end;
$$;

create or replace function public.xelay_can_read_homework_file(p_name text)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and public.xelay_homework_file_group(p_name) is not null and (
    'homework'=any(public.xelay_study_group_permissions(public.xelay_homework_file_group(p_name)))
    or (split_part(p_name,'/',2)=auth.uid()::text
      and exists (select 1 from storage.objects o where o.bucket_id='xelay-homework-files' and o.name=p_name
        and coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')=auth.uid()::text)
      and not exists (select 1 from public.study_group_homework h
        where h.attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name))))
    or exists (select 1 from public.study_group_homework h
      where h.group_id=public.xelay_homework_file_group(p_name)
      and h.attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name))
      and (public.xelay_is_study_group_representative(h.group_id) or public.xelay_is_platform_admin()
        or exists (select 1 from public.study_group_members m
          where m.group_id=h.group_id and m.user_id=auth.uid() and m.status='accepted')))
  );
$$;

create or replace function public.xelay_can_remove_homework_file(p_name text)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid := public.xelay_homework_file_group(p_name);
begin
  if auth.uid() is null or v_group_id is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || v_group_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('xelay:homework-file:' || p_name,0));
  if exists (select 1 from public.study_group_homework h
    where h.attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name))) then return false; end if;
  -- Role revocation between upload and save must not strand an unpublished
  -- own file. Its real Storage owner and user path must both match the caller.
  if split_part(p_name,'/',2)=auth.uid()::text and exists (select 1 from storage.objects o
    where o.bucket_id='xelay-homework-files' and o.name=p_name
    and coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')=auth.uid()::text) then return true; end if;
  return coalesce(public.xelay_can_edit_homework_resources(v_group_id),false);
end;
$$;

-- Existing seminar RPCs all call this helper before editing; reservations still
-- require an actual accepted membership, rather than administrative status alone.
create or replace function public.xelay_lock_seminar_group(p_group_id uuid,p_representative boolean)
returns void language plpgsql volatile security definer set search_path = public, pg_temp
as $$
begin
  if auth.uid() is null then raise exception 'SEMINAR_AUTH_REQUIRED' using errcode='42501'; end if;
  if p_group_id is null then raise exception 'SEMINAR_NOT_FOUND'; end if;
  if p_representative then
    perform public.xelay_lock_study_group_permission(p_group_id,'seminars',true);
    return;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || p_group_id::text,0));
  if not exists (select 1 from public.study_groups where id=p_group_id) then raise exception 'SEMINAR_NOT_FOUND'; end if;
  if not exists (select 1 from public.study_groups g where g.id=p_group_id and (
    g.representative_id=auth.uid() or exists (select 1 from public.study_group_members m
      where m.group_id=g.id and m.user_id=auth.uid() and m.status='accepted')
  )) then raise exception 'SEMINAR_MEMBER_REQUIRED' using errcode='42501'; end if;
  if not exists (select 1 from public.billing_settings b where b.singleton
    and (not b.enforce_group_payment or public.xelay_group_has_access(p_group_id))) then
    raise exception 'GROUP_LICENSE_REQUIRED' using errcode='42501';
  end if;
end;
$$;

create or replace function public.xelay_can_view_seminars(p_group_id uuid)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and exists (select 1 from public.study_groups g where g.id=p_group_id and (
    public.xelay_is_platform_admin() or g.representative_id=auth.uid()
    or exists (select 1 from public.study_group_members m
      where m.group_id=g.id and m.user_id=auth.uid() and m.status='accepted')
  ));
$$;

create or replace function public.xelay_delete_seminar_comment(p_comment_id uuid)
returns void language plpgsql security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid; v_comment public.study_group_seminar_comments%rowtype;
begin
  select group_id into v_group_id from public.study_group_seminar_comments where id=p_comment_id;
  if v_group_id is null then raise exception 'SEMINAR_COMMENT_NOT_FOUND'; end if;
  if public.xelay_has_study_group_permission(v_group_id,'seminar_comments') then
    perform public.xelay_lock_study_group_permission(v_group_id,'seminar_comments',true);
  else
    perform public.xelay_lock_seminar_group(v_group_id,false);
  end if;
  select * into v_comment from public.study_group_seminar_comments where id=p_comment_id and group_id=v_group_id for update;
  if not found then raise exception 'SEMINAR_COMMENT_NOT_FOUND'; end if;
  if v_comment.author_id<>auth.uid() and not public.xelay_has_study_group_permission(v_group_id,'seminar_comments') then
    raise exception 'SEMINAR_COMMENT_OWNER_REQUIRED' using errcode='42501';
  end if;
  delete from public.study_group_seminar_comments where id=p_comment_id and group_id=v_group_id;
end;
$$;

create or replace function public.xelay_can_upload_seminar_file(p_name text)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid := public.xelay_homework_file_group(p_name);
begin
  if auth.uid() is null or v_group_id is null or split_part(p_name,'/',2)<>auth.uid()::text then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || v_group_id::text,0));
  return public.xelay_has_study_group_permission(v_group_id,'seminar_resources') and exists (
    select 1 from public.billing_settings b where b.singleton
      and (not b.enforce_group_payment or public.xelay_group_has_access(v_group_id))
  );
end;
$$;

create or replace function public.xelay_can_read_seminar_file(p_name text)
returns boolean language sql stable security definer set search_path = public, pg_temp
as $$
  select auth.uid() is not null and public.xelay_homework_file_group(p_name) is not null and (
    exists (select 1 from public.study_group_seminars s where s.group_id=public.xelay_homework_file_group(p_name)
      and s.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name))
      and public.xelay_can_view_seminars(s.group_id))
    or 'seminar_resources'=any(public.xelay_study_group_permissions(public.xelay_homework_file_group(p_name)))
    or (split_part(p_name,'/',2)=auth.uid()::text
      and exists (select 1 from storage.objects o where o.bucket_id='xelay-seminar-files' and o.name=p_name
        and coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')=auth.uid()::text)
      and not exists (select 1 from public.study_group_seminars s
        where s.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name))))
    or (exists (select 1 from public.study_group_seminar_file_cleanup c where c.storage_path=p_name
        and (c.cleanup_user_id=auth.uid() or c.owner_id=auth.uid()))
      and not exists (select 1 from public.study_group_seminars s
        where s.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name))))
  );
$$;

create or replace function public.xelay_can_remove_seminar_file(p_name text)
returns boolean language plpgsql volatile security definer set search_path = public, pg_temp
as $$
declare v_group_id uuid := public.xelay_homework_file_group(p_name);
begin
  if auth.uid() is null or v_group_id is null then return false; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || v_group_id::text,0));
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminar-file:' || p_name,0));
  if exists (select 1 from public.study_group_seminars s
    where s.resource_attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name))) then return false; end if;
  -- An existing own cleanup receipt only grants deletion of detached garbage.
  -- It survives role/group removal and can never edit/reveal an attached file.
  if exists (select 1 from public.study_group_seminar_file_cleanup c
    where c.storage_path=p_name and (c.cleanup_user_id=auth.uid() or c.owner_id=auth.uid())) then return true; end if;
  if split_part(p_name,'/',2)=auth.uid()::text and exists (select 1 from storage.objects o
    where o.bucket_id='xelay-seminar-files' and o.name=p_name
    and coalesce(to_jsonb(o)->>'owner_id',to_jsonb(o)->>'owner')=auth.uid()::text) then return true; end if;
  return public.xelay_has_study_group_permission(v_group_id,'seminar_resources')
    and exists (select 1 from public.billing_settings b where b.singleton
      and (not b.enforce_group_payment or public.xelay_group_has_access(v_group_id)));
end;
$$;

revoke all on function public.xelay_normalize_study_group_permissions(text[]),
  public.xelay_study_group_permissions(uuid),public.xelay_has_study_group_permission(uuid,text),
  public.xelay_lock_study_group_permission(uuid,text,boolean),public.xelay_lock_study_group_deputy_reviewer(uuid),
  public.xelay_submit_study_group_deputy_request(uuid,text),public.xelay_cancel_study_group_deputy_request(uuid),
  public.xelay_review_study_group_deputy_request(uuid,boolean,text[]),
  public.xelay_update_study_group_deputy_permissions(uuid,text[]),public.xelay_revoke_study_group_deputy(uuid),
  public.xelay_list_study_group_deputies(uuid),public.xelay_cleanup_study_group_deputy_membership(),
  public.xelay_validate_study_group_delegated_content(),public.xelay_update_seminar_resources(uuid,jsonb,jsonb),
  public.xelay_notify_study_group_deputy_request()
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_study_group_permissions(uuid),
  public.xelay_has_study_group_permission(uuid,text),public.xelay_submit_study_group_deputy_request(uuid,text),
  public.xelay_cancel_study_group_deputy_request(uuid),public.xelay_review_study_group_deputy_request(uuid,boolean,text[]),
  public.xelay_update_study_group_deputy_permissions(uuid,text[]),public.xelay_revoke_study_group_deputy(uuid),
  public.xelay_list_study_group_deputies(uuid),public.xelay_update_seminar_resources(uuid,jsonb,jsonb)
  to authenticated;
-- Bucket policies may evaluate anonymous requests on unrelated buckets.
grant execute on function public.xelay_can_upload_homework_file(text),public.xelay_can_read_homework_file(text),
  public.xelay_can_remove_homework_file(text),public.xelay_can_upload_seminar_file(text),
  public.xelay_can_read_seminar_file(text),public.xelay_can_remove_seminar_file(text) to anon,authenticated;

do $$
begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime' and not puballtables)
    and not exists(select 1 from pg_publication_tables where pubname='supabase_realtime'
      and schemaname='public' and tablename='study_group_deputy_requests') then
    alter publication supabase_realtime add table public.study_group_deputy_requests;
  end if;
end;
$$;
-- Keep DEFAULT replica identity: application messages are never broadcast on DELETE.
comment on table public.study_group_deputy_requests is
  'One current request per group/user; accepted deputies have personal permissions. Private messages are redacted by the public-role RPC.';

commit;
