-- Preserve Storage denial rules; only default P0001 is mapped to permission errors.
-- Current DELETE definition is taken from012, retaining live-version/lease guards.
-- Source: https://github.com/supabase/storage/blob/master/src/storage/database/errors.ts
-- Upstream maps42501 to AccessDenied; this is not deployed-revision evidence.
begin;

create or replace function public.xelay_private_guard_storage_upload()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
declare v_owner uuid; v_bytes bigint; v_usage bigint; v_count bigint; v_pending bigint; v_reserved bigint;
begin
  if new.bucket_id not in ('xelay-message-media','xelay-chat-media') then return new; end if;
  v_owner:=public.xelay_private_object_owner(to_jsonb(new));
  if v_owner is null or (auth.uid() is not null and v_owner<>auth.uid()) then raise exception 'PRIVATE_MEDIA_FORBIDDEN' using errcode='42501'; end if;
  if auth.uid() is not null and not public.xelay_private_can_upload_media(new.bucket_id,new.name) then raise exception 'PRIVATE_MEDIA_FORBIDDEN' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-private-upload:' || v_owner::text,0));
  perform 1 from public.private_media_upload_reservations where bucket_id=new.bucket_id and storage_path=new.name
    and owner_id=v_owner and expires_at>clock_timestamp() for update;
  if not found then raise exception 'PRIVATE_MEDIA_UPLOAD_RESERVATION_REQUIRED' using errcode='42501'; end if;
  if new.metadata->>'size' is not null and (coalesce(new.metadata->>'size','')!~'^[0-9]+$'
    or length(new.metadata->>'size')>10 or (new.metadata->>'size')::numeric not between 1 and 26214400) then raise exception 'PRIVATE_MEDIA_INVALID' using errcode='42501'; end if;
  v_bytes:=public.xelay_private_object_bytes(new.metadata);
  if public.xelay_private_media_attached(new.bucket_id,new.name) then raise exception 'PRIVATE_MEDIA_IN_USE' using errcode='42501'; end if;
  select count(*),coalesce(sum(public.xelay_private_object_bytes(o.metadata)),0),
    count(*) filter(where not public.xelay_private_media_attached(o.bucket_id,o.name))
    into v_count,v_usage,v_pending from storage.objects o where o.bucket_id in('xelay-message-media','xelay-chat-media')
      and not(o.bucket_id=new.bucket_id and o.name=new.name) and public.xelay_private_object_owner(to_jsonb(o))=v_owner;
  select count(*) into v_reserved from public.private_media_upload_reservations r where r.owner_id=v_owner and r.expires_at>clock_timestamp()
    and not(r.bucket_id=new.bucket_id and r.storage_path=new.name)
    and not exists(select 1 from storage.objects o where o.bucket_id=r.bucket_id and o.name=r.storage_path);
  if v_count+v_reserved>=1000 or v_usage+v_reserved*26214400+v_bytes>1073741824 or v_pending+v_reserved>=100 then raise exception 'PRIVATE_MEDIA_QUOTA' using errcode='42501'; end if;
  -- Consume only after INSERT/UPDATE actually completes; an upsert may still execute its UPDATE guard.
  delete from public.private_media_cleanup where bucket_id=new.bucket_id and storage_path=new.name;
  delete from public.private_media_cleanup_claims where bucket_id=new.bucket_id and storage_path=new.name;
  return new;
end $$;

create or replace function public.xelay_private_guard_storage_size_update()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
declare v_owner uuid; v_before bigint; v_after bigint; v_usage bigint; v_reserved bigint;
begin
  if new.bucket_id not in('xelay-message-media','xelay-chat-media') or new.metadata is not distinct from old.metadata then return new; end if;
  if new.metadata->>'size' is not null and (coalesce(new.metadata->>'size','') !~ '^[0-9]+$'
    or length(new.metadata->>'size')>10 or (new.metadata->>'size')::numeric not between 1 and 26214400) then raise exception 'PRIVATE_MEDIA_INVALID' using errcode='42501'; end if;
  v_before:=public.xelay_private_object_bytes(old.metadata); v_after:=public.xelay_private_object_bytes(new.metadata);
  v_owner:=public.xelay_private_object_owner(to_jsonb(new));
  if v_owner is null then raise exception 'PRIVATE_MEDIA_FORBIDDEN' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay-private-upload:' || v_owner::text,0));
  if old.metadata->>'size' is null and new.metadata->>'size' is not null then
    perform 1 from public.private_media_upload_reservations where bucket_id=new.bucket_id and storage_path=new.name
      and owner_id=v_owner and expires_at>clock_timestamp() for update;
    if not found then raise exception 'PRIVATE_MEDIA_UPLOAD_RESERVATION_REQUIRED' using errcode='42501'; end if;
  end if;
  select coalesce(sum(public.xelay_private_object_bytes(o.metadata)),0) into v_usage from storage.objects o
    where o.bucket_id in('xelay-message-media','xelay-chat-media') and o.id<>new.id and public.xelay_private_object_owner(to_jsonb(o))=v_owner;
  select count(*) into v_reserved from public.private_media_upload_reservations r where r.owner_id=v_owner and r.expires_at>clock_timestamp()
    and not(r.bucket_id=new.bucket_id and r.storage_path=new.name)
    and not exists(select 1 from storage.objects o where o.bucket_id=r.bucket_id and o.name=r.storage_path);
  if v_usage+v_after+v_reserved*26214400>1073741824 then raise exception 'PRIVATE_MEDIA_QUOTA' using errcode='42501'; end if;
  return new;
end $$;

create or replace function public.xelay_private_guard_storage_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.bucket_id in('xelay-message-media','xelay-chat-media')
    and public.xelay_private_media_attached(old.bucket_id,old.name) then raise exception 'PRIVATE_MEDIA_IN_USE' using errcode='42501'; end if;
  if old.bucket_id in('xelay-message-media','xelay-chat-media') and (auth.uid() is null or auth.role()='service_role') then
    if not public.xelay_media_cleanup_live_object(to_jsonb(old))
      or not public.xelay_media_cleanup_unversioned_bucket(old.bucket_id)
      or not exists(select 1 from public.private_media_cleanup_claims c where c.bucket_id=old.bucket_id and c.storage_path=old.name
        and c.object_id=old.id and c.object_updated_at is not distinct from coalesce(old.updated_at,old.created_at)
        and c.object_version is not distinct from to_jsonb(old)->>'version' and c.expires_at>clock_timestamp()) then
      raise exception 'PRIVATE_MEDIA_CLEANUP_CLAIM_REQUIRED' using errcode='42501'; end if;
  end if;
  return old;
end $$;

create or replace function public.xelay_private_invalidate_seminar_cleanup()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
declare v_group uuid;
begin
  if new.bucket_id<>'xelay-seminar-files' then return new; end if;
  v_group:=public.xelay_homework_file_group(new.name);
  if v_group is null then raise exception 'SEMINAR_RESOURCE_INVALID_INPUT' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:' || v_group::text,0));
  perform pg_advisory_xact_lock(hashtextextended('xelay:seminar-file:' || new.name,0));
  delete from public.study_group_seminar_file_cleanup where storage_path=new.name;
  return new;
end $$;

create or replace function public.xelay_chat_guard_media_delete()
returns trigger language plpgsql security definer set search_path = public,pg_temp as $$
begin
  if old.bucket_id = 'xelay-chat-media' and (exists(select 1 from public.chat_attachments where storage_path = old.name)
    or exists(select 1 from public.chat_spaces where avatar_path = old.name)
    or exists(select 1 from public.chat_publications where kind = 'article' and content->>'cover_path' = old.name)) then raise exception 'CHAT_MEDIA_IN_USE' using errcode='42501'; end if;
  return old;
end $$;

revoke all on function public.xelay_private_guard_storage_upload(),
  public.xelay_private_guard_storage_size_update(),public.xelay_private_guard_storage_delete(),
  public.xelay_private_invalidate_seminar_cleanup(),public.xelay_chat_guard_media_delete()
  from public,anon,authenticated,service_role;

commit;
