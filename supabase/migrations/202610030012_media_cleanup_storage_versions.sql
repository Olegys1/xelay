-- Managed Storage now has C-collated name indexes and optional versioning
-- columns. Use its existing indexes; never alter a managed table or index.
begin;

create or replace function public.xelay_media_cleanup_live_object(p_object jsonb)
returns boolean language sql immutable set search_path = ''
as $$select coalesce(jsonb_typeof(p_object)='object' and p_object->>'archived_at' is null
  and case when p_object?'is_versioned' then p_object->>'is_versioned'='false' else true end
  and case when p_object?'is_delete_marker' then p_object->>'is_delete_marker'='false' else true end,false)$$;
create or replace function public.xelay_media_cleanup_unversioned_bucket(p_bucket_id text)
returns boolean language sql stable security definer set search_path = ''
as $$select exists(select 1 from storage.buckets b where b.id=p_bucket_id
  and case when to_jsonb(b)?'versioning_status' then to_jsonb(b)->>'versioning_status'='DISABLED' else true end)$$;
revoke all on function public.xelay_media_cleanup_live_object(jsonb),
  public.xelay_media_cleanup_unversioned_bucket(text) from public,anon,authenticated,service_role;

create or replace function public.xelay_media_cleanup_scan_candidates(p_scope text,p_before timestamptz,p_limit integer)
returns jsonb language plpgsql security definer set search_path = ''
as $$
declare
  v_buckets text[]; v_start integer; v_count integer; v_per_bucket integer;
  v_offset integer; v_bucket text; v_last text; v_seen integer;
  v_result jsonb:='[]'; v_object record;
  v_bucket_att smallint; v_name_att smallint; v_has_versioned boolean; v_has_archived boolean;
  v_c_index boolean; v_null_index boolean; v_current_index boolean;
  v_name_expr text; v_page_predicate text:=''; v_page_sql text;
begin
  if p_scope not in('public','private') or p_scope is null or p_before is null
    or not isfinite(p_before) or p_before>clock_timestamp()-interval '1 hour'
    or p_limit is null or p_limit not between 1 and 100 then
    raise exception 'Invalid cleanup window' using errcode='22023';
  end if;
  select attnum into v_bucket_att from pg_catalog.pg_attribute
    where attrelid='storage.objects'::regclass and attname='bucket_id' and not attisdropped;
  select attnum into v_name_att from pg_catalog.pg_attribute
    where attrelid='storage.objects'::regclass and attname='name' and not attisdropped;
  select exists(select 1 from pg_catalog.pg_attribute where attrelid='storage.objects'::regclass and attname='is_versioned' and not attisdropped),
    exists(select 1 from pg_catalog.pg_attribute where attrelid='storage.objects'::regclass and attname='archived_at' and not attisdropped)
    into v_has_versioned,v_has_archived;
  -- indkey/indcollation are zero-based catalog vectors. Only a ready, valid
  -- btree whose first two keys are bucket/name can supply this ordering.
  select coalesce(bool_or(true),false),
    coalesce(bool_or(i.indisunique and regexp_replace(pg_catalog.pg_get_expr(i.indpred,i.indrelid),'[[:space:]()]','','g')='NOTis_versioned'),false),
    coalesce(bool_or(i.indisunique and regexp_replace(pg_catalog.pg_get_expr(i.indpred,i.indrelid),'[[:space:]()]','','g')='archived_atISNULL'),false)
    into v_c_index,v_null_index,v_current_index
    from pg_catalog.pg_index i join pg_catalog.pg_class c on c.oid=i.indexrelid
    join pg_catalog.pg_am a on a.oid=c.relam
    where i.indrelid='storage.objects'::regclass and i.indisvalid and i.indisready and a.amname='btree'
      and i.indkey[0]=v_bucket_att and i.indkey[1]=v_name_att
      and i.indcollation[1]='pg_catalog."C"'::regcollation;
  v_name_expr:=case when v_c_index then 'o.name collate "C"' else 'o.name' end;
  -- Use exactly one managed partial-index predicate before LIMIT. All other
  -- flags are checked after the bounded page, like references and age. This
  -- avoids an unbounded filtered prefix even for abnormal legacy flag rows.
  if v_c_index and v_null_index and v_has_versioned then v_page_predicate:=' and not o.is_versioned';
  elsif v_c_index and v_current_index and v_has_archived then v_page_predicate:=' and o.archived_at is null'; end if;
  v_page_sql:='select o.* from storage.objects o where o.bucket_id=$1 and '||v_name_expr||
    '>$2'||case when v_c_index then ' collate "C"' else '' end||v_page_predicate||
    ' order by '||v_name_expr||' limit $3';

  v_buckets:=case when p_scope='public' then array['avatars','answer-media','question-images']
    else array['xelay-message-media','xelay-chat-media'] end;
  v_count:=cardinality(v_buckets);
  v_per_bucket:=greatest(1,least(200,p_limit*2)/v_count);
  select next_bucket into v_start from public.media_cleanup_bucket_rotation where scope=p_scope for update;
  if not found then raise exception 'Cleanup cursor missing'; end if;
  update public.media_cleanup_bucket_rotation set next_bucket=(v_start+1)%v_count,
    updated_at=clock_timestamp() where scope=p_scope;
  for v_offset in 0..v_count-1 loop
    v_bucket:=v_buckets[1+(v_start+v_offset)%v_count];
    if not public.xelay_media_cleanup_unversioned_bucket(v_bucket) then continue; end if;
    select last_storage_path into v_last from public.media_cleanup_bucket_cursors where bucket_id=v_bucket for update;
    if not found then raise exception 'Cleanup bucket cursor missing'; end if;
    v_seen:=0;
    for v_object in execute v_page_sql using v_bucket,v_last,v_per_bucket loop
      v_seen:=v_seen+1; v_last:=v_object.name;
      if public.xelay_media_cleanup_live_object(to_jsonb(v_object))
        and v_object.created_at<p_before and coalesce(v_object.updated_at,v_object.created_at)<p_before then
        if p_scope='public' then
          if public.xelay_public_media_attributable(to_jsonb(v_object))
            and not public.xelay_public_media_referenced(v_bucket,v_object.name)
            and not exists(select 1 from public.public_media_cleanup_claims c where c.bucket_id=v_bucket
              and c.storage_path=v_object.name and c.expires_at>clock_timestamp()) then
            v_result:=v_result||jsonb_build_array(jsonb_build_object('bucket_id',v_bucket,'name',v_object.name,'object_id',v_object.id));
          end if;
        else
          if not public.xelay_private_media_attached(v_bucket,v_object.name)
            and not exists(select 1 from public.private_media_cleanup_claims c where c.bucket_id=v_bucket
              and c.storage_path=v_object.name and c.expires_at>clock_timestamp()) then
            v_result:=v_result||jsonb_build_array(jsonb_build_object('bucket_id',v_bucket,'name',v_object.name,'object_id',v_object.id));
          end if;
        end if;
      end if;
      if jsonb_array_length(v_result)>=p_limit then
        update public.media_cleanup_bucket_cursors set last_storage_path=v_last,updated_at=clock_timestamp() where bucket_id=v_bucket;
        return v_result;
      end if;
    end loop;
    update public.media_cleanup_bucket_cursors set last_storage_path=case when v_seen<v_per_bucket then '' else v_last end,
      updated_at=clock_timestamp() where bucket_id=v_bucket;
  end loop;
  return v_result;
end;
$$;
revoke all on function public.xelay_media_cleanup_scan_candidates(text,timestamptz,integer) from public,anon,authenticated,service_role;
-- A collation change must not inherit a cursor advanced in another ordering.
update public.media_cleanup_bucket_cursors set last_storage_path='',updated_at=clock_timestamp();

create or replace function public.xelay_public_media_cleanup_claim(p_bucket_id text,p_storage_path text,p_object_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_object storage.objects%rowtype;
begin
  if p_bucket_id not in('avatars','answer-media','question-images') or p_object_id is null
    or not public.xelay_media_cleanup_unversioned_bucket(p_bucket_id) then return false; end if;
  select * into v_object from storage.objects where bucket_id=p_bucket_id and name=p_storage_path and id=p_object_id for update;
  if not found or not public.xelay_media_cleanup_live_object(to_jsonb(v_object))
    or coalesce(v_object.updated_at,v_object.created_at)>clock_timestamp()-interval '1 hour'
    or not public.xelay_public_media_attributable(to_jsonb(v_object))
    or public.xelay_public_media_referenced(p_bucket_id,p_storage_path) then return false; end if;
  insert into public.public_media_cleanup_claims(bucket_id,storage_path,object_id,object_updated_at,object_metadata,object_version)
    values(p_bucket_id,p_storage_path,p_object_id,coalesce(v_object.updated_at,v_object.created_at),v_object.metadata,to_jsonb(v_object)->>'version')
    on conflict(bucket_id,storage_path) do update set object_id=excluded.object_id,object_updated_at=excluded.object_updated_at,
      object_metadata=excluded.object_metadata,object_version=excluded.object_version,expires_at=clock_timestamp()+interval '5 minutes';
  return true;
end $$;
create or replace function public.xelay_private_media_cleanup_claim(p_bucket_id text,p_storage_path text,p_object_id uuid)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_object storage.objects%rowtype;
begin
  if p_bucket_id not in('xelay-message-media','xelay-chat-media') or p_object_id is null
    or not public.xelay_media_cleanup_unversioned_bucket(p_bucket_id) then return false; end if;
  select * into v_object from storage.objects where bucket_id=p_bucket_id and name=p_storage_path and id=p_object_id for update;
  if not found or not public.xelay_media_cleanup_live_object(to_jsonb(v_object))
    or coalesce(v_object.updated_at,v_object.created_at)>clock_timestamp()-interval '1 hour'
    or public.xelay_private_media_attached(p_bucket_id,p_storage_path) then return false; end if;
  if exists(select 1 from public.private_media_cleanup_claims where bucket_id=p_bucket_id and storage_path=p_storage_path
    and expires_at>clock_timestamp() and object_id=v_object.id
    and object_updated_at is not distinct from coalesce(v_object.updated_at,v_object.created_at)
    and object_version is not distinct from to_jsonb(v_object)->>'version') then return false; end if;
  insert into public.private_media_cleanup_claims(bucket_id,storage_path,object_id,object_updated_at,object_version)
    values(p_bucket_id,p_storage_path,p_object_id,coalesce(v_object.updated_at,v_object.created_at),to_jsonb(v_object)->>'version')
    on conflict(bucket_id,storage_path) do update set object_id=excluded.object_id,object_updated_at=excluded.object_updated_at,
      object_version=excluded.object_version,expires_at=clock_timestamp()+interval '5 minutes';
  return true;
end $$;
revoke all on function public.xelay_public_media_cleanup_claim(text,text,uuid),
  public.xelay_private_media_cleanup_claim(text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_public_media_cleanup_claim(text,text,uuid),
  public.xelay_private_media_cleanup_claim(text,text,uuid) to service_role;

create or replace function public.xelay_private_guard_storage_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if old.bucket_id in('xelay-message-media','xelay-chat-media')
    and public.xelay_private_media_attached(old.bucket_id,old.name) then raise exception 'PRIVATE_MEDIA_IN_USE'; end if;
  if old.bucket_id in('xelay-message-media','xelay-chat-media') and (auth.uid() is null or auth.role()='service_role') then
    if not public.xelay_media_cleanup_live_object(to_jsonb(old))
      or not public.xelay_media_cleanup_unversioned_bucket(old.bucket_id)
      or not exists(select 1 from public.private_media_cleanup_claims c where c.bucket_id=old.bucket_id and c.storage_path=old.name
        and c.object_id=old.id and c.object_updated_at is not distinct from coalesce(old.updated_at,old.created_at)
        and c.object_version is not distinct from to_jsonb(old)->>'version' and c.expires_at>clock_timestamp()) then
      raise exception 'PRIVATE_MEDIA_CLEANUP_CLAIM_REQUIRED'; end if;
  end if;
  return old;
end $$;
create or replace function public.xelay_public_media_cleanup_guard()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_role text:=coalesce(current_setting('role',true),'none');
begin
  if tg_op='INSERT' then
    if new.bucket_id in('avatars','answer-media','question-images') then
      delete from public.public_media_cleanup_claims where bucket_id=new.bucket_id and storage_path=new.name; end if;
    return new;
  end if;
  if old.bucket_id not in('avatars','answer-media','question-images') then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='UPDATE' then
    delete from public.public_media_cleanup_claims where bucket_id=old.bucket_id and storage_path=old.name;
    return new;
  end if;
  if v_role not in('none','postgres','supabase_admin','anon','authenticated') then
    if not public.xelay_media_cleanup_live_object(to_jsonb(old))
      or not public.xelay_media_cleanup_unversioned_bucket(old.bucket_id)
      or public.xelay_public_media_referenced(old.bucket_id,old.name) or not exists(
        select 1 from public.public_media_cleanup_claims c where c.bucket_id=old.bucket_id and c.storage_path=old.name
          and c.object_id=old.id and c.object_updated_at=coalesce(old.updated_at,old.created_at)
          and c.object_metadata is not distinct from old.metadata
          and c.object_version is not distinct from to_jsonb(old)->>'version' and c.expires_at>clock_timestamp()) then
      raise exception 'Public media cleanup lease required' using errcode='42501'; end if;
  end if;
  delete from public.public_media_cleanup_claims where bucket_id=old.bucket_id and storage_path=old.name;
  return old;
end $$;
revoke all on function public.xelay_private_guard_storage_delete(),public.xelay_public_media_cleanup_guard()
  from public,anon,authenticated,service_role;
notify pgrst,'reload schema';
commit;
