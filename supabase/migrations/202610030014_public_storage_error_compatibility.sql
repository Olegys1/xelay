-- Keep upload rejection rules unchanged while using Storage's permission error.
-- Upstream maps 42501 to AccessDenied; 22023 falls through to DatabaseError.
-- Source: https://github.com/supabase/storage/blob/master/src/storage/database/errors.ts
-- This is upstream evidence, not a claim about the deployed source revision.
begin;

create or replace function public.xelay_guard_legacy_public_storage()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_size bigint; v_owner text; v_old_owner text; v_type text;
  v_role text:=coalesce(current_setting('role',true),'none'); v_reservation public.public_media_upload_reservations%rowtype;
begin
  if tg_op='INSERT' then
    if new.bucket_id not in ('avatars','answer-media','question-images') then return new; end if;
  elsif new.bucket_id not in ('avatars','answer-media','question-images')
    and old.bucket_id not in ('avatars','answer-media','question-images') then return new;
  end if;
  -- Trusted offline restoration remains possible; Storage's elevated final
  -- write is explicitly covered even though its JWT no longer has the user ID.
  if v_role in ('none','postgres','supabase_admin') then return new; end if;
  v_owner:=coalesce(nullif(to_jsonb(new)->>'owner_id',''),to_jsonb(new)->>'owner');
  if v_owner is null or v_owner !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    raise exception 'Upload owner required' using errcode='42501'; end if;
  if v_role in ('anon','authenticated') and v_owner is distinct from auth.uid()::text then
    raise exception 'Upload owner permission required' using errcode='42501'; end if;
  if tg_op='UPDATE' then
    v_old_owner:=coalesce(nullif(to_jsonb(old)->>'owner_id',''),to_jsonb(old)->>'owner');
    if new.id is distinct from old.id or new.bucket_id is distinct from old.bucket_id or new.name is distinct from old.name
      or (v_old_owner is not null and v_owner is distinct from v_old_owner)
      or new.created_at is distinct from old.created_at then
      raise exception 'Storage identity cannot be changed' using errcode='42501';
    end if;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:public-media:'||v_owner,0));
  select * into v_reservation from public.public_media_upload_reservations
    where bucket_id=new.bucket_id and storage_path=new.name and user_id=v_owner::uuid and expires_at>clock_timestamp() for update;
  if not found then raise exception 'Reserve upload before sending file' using errcode='42501'; end if;
  if (new.metadata->>'size')~'^[0-9]{1,12}$' then v_size:=(new.metadata->>'size')::bigint;
  -- SDK File/Blob bodies are multipart: preview contentLength can include form
  -- boundaries, metadata and cacheControl, rather than the file's byte size.
  -- Keep the declared reservation during this rolled-back permission test;
  -- the privileged final write must still supply and validate metadata.size.
  elsif v_role in ('anon','authenticated') and not(new.metadata ? 'size') then v_size:=v_reservation.byte_size;
  else raise exception 'Valid file size required' using errcode='42501'; end if;
  v_type:=lower(split_part(coalesce(new.metadata->>'mimetype',''),';',1));
  if v_type not in ('image/jpeg','image/png','image/webp','image/gif','image/avif')
    and not (new.bucket_id='answer-media' and v_type in ('video/mp4','video/webm','video/quicktime')) then
    raise exception 'Unsupported public media type' using errcode='42501'; end if;
  if v_size<1 or v_size>v_reservation.byte_size or v_type<>v_reservation.mimetype then
    raise exception 'File differs from upload reservation' using errcode='42501'; end if;
  if v_size>(case when new.bucket_id='avatars' then 5242880 else 26214400 end) then
    raise exception 'Public media file is too large' using errcode='42501'; end if;
  -- A direct authenticated insert with preview metadata remains bounded too.
  if not(new.metadata ? 'size') then new.metadata:=new.metadata||jsonb_build_object('size',v_size); end if;
  return new;
end $$;
revoke all on function public.xelay_guard_legacy_public_storage() from public,anon,authenticated,service_role;

commit;
