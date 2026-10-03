-- Public media stays readable. Detached, attributable files can be collected
-- by a service worker through Storage's API, never by deleting metadata alone.
begin;

create table public.public_media_cleanup_claims (
  bucket_id text not null,storage_path text not null,object_id uuid not null,
  object_updated_at timestamptz not null,object_metadata jsonb,object_version text,
  expires_at timestamptz not null default clock_timestamp()+interval '5 minutes',
  primary key(bucket_id,storage_path)
);
alter table public.public_media_cleanup_claims enable row level security;
revoke all on public.public_media_cleanup_claims from public,anon,authenticated;

-- Legacy filenames may be URL-encoded or have cache query parameters. Decode
-- valid escape bytes while retaining literal '%' text, and prefer retention
-- when a URL is malformed. This helper performs no network requests.
create or replace function public.xelay_public_media_decode_url(p_text text)
returns text language plpgsql immutable set search_path=public,pg_temp as $$
declare v_pos integer:=1; v_bytes bytea:=''::bytea; v_piece text;
begin
  if p_text is null then return null; end if;
  while v_pos<=length(p_text) loop
    v_piece:=substr(p_text,v_pos,3);
    if v_piece~'^%[0-9a-fA-F]{2}$' then v_bytes:=v_bytes||decode(substr(v_piece,2),'hex'); v_pos:=v_pos+3;
    else v_bytes:=v_bytes||convert_to(substr(p_text,v_pos,1),'UTF8'); v_pos:=v_pos+1; end if;
  end loop;
  return convert_from(v_bytes,'UTF8');
exception when others then return p_text;
end $$;
revoke all on function public.xelay_public_media_decode_url(text) from public,anon,authenticated,service_role;

create or replace function public.xelay_public_media_encode_path(p_path text)
returns text language plpgsql immutable set search_path=public,pg_temp as $$
declare v_bytes bytea:=convert_to(p_path,'UTF8'); v_i integer; v_n integer; v_result text:='';
begin
  if p_path is null then return null; end if;
  for v_i in 0..length(v_bytes)-1 loop
    v_n:=get_byte(v_bytes,v_i);
    if (v_n between 48 and 57) or (v_n between 65 and 90) or (v_n between 97 and 122)
      or chr(v_n) in ('/','-','_','.','~','!','$','&',chr(39),'(',')','*','+',',',';',':','@','=') then
      v_result:=v_result||chr(v_n);
    else v_result:=v_result||'%'||upper(lpad(to_hex(v_n),2,'0')); end if;
  end loop;
  return v_result;
end $$;
revoke all on function public.xelay_public_media_encode_path(text) from public,anon,authenticated,service_role;

create or replace function public.xelay_public_media_referenced(p_bucket_id text,p_storage_path text)
returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_suffix text:='/storage/v1/object/public/'||p_bucket_id||'/'||p_storage_path;
  v_encoded text:='/storage/v1/object/public/'||p_bucket_id||'/'||public.xelay_public_media_encode_path(p_storage_path);
begin
  if p_bucket_id not in ('avatars','answer-media','question-images') then return false; end if;
  return exists(select 1 from public.profiles p where position(v_suffix in p.avatar_url)>0 or position(v_encoded in p.avatar_url)>0)
    or exists(select 1 from public.questions q where position(v_suffix in coalesce(q.author_avatar,'')||' '||coalesce(q.content,''))>0
      or position(v_encoded in coalesce(q.author_avatar,'')||' '||coalesce(q.content,''))>0)
    or exists(select 1 from public.answers a where position(v_suffix in coalesce(a.author_avatar,'')||' '||coalesce(a.media_url,'')||' '||coalesce(a.content,''))>0
      or position(v_encoded in coalesce(a.author_avatar,'')||' '||coalesce(a.media_url,'')||' '||coalesce(a.content,''))>0)
    or exists(select 1 from public.question_images i where position(v_suffix in i.image_url)>0 or position(v_encoded in i.image_url)>0)
    or exists(select 1 from public.answer_images i where position(v_suffix in i.image_url)>0 or position(v_encoded in i.image_url)>0);
end
$$;
revoke all on function public.xelay_public_media_referenced(text,text) from public,anon,authenticated,service_role;

-- Unknown legacy ownership is deliberately excluded even when no link is
-- found. A staff member must review those files; old content is never guessed.
create or replace function public.xelay_public_media_attributable(p_object jsonb)
returns boolean language sql stable security definer set search_path=public,pg_temp as $$
  select (p_object->>'name')~'^[A-Za-z0-9/_ .-]+$' and (
    nullif(coalesce(nullif(p_object->>'owner_id',''),p_object->>'owner'),'') is not null
    or split_part(p_object->>'name','/',1)~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or (p_object->>'bucket_id'='avatars' and p_object->>'name'~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-'));
$$;
revoke all on function public.xelay_public_media_attributable(jsonb) from public,anon,authenticated,service_role;

create table public.public_media_cleanup_scan_cursor (
  singleton boolean primary key default true check(singleton),last_created_at timestamptz not null default '-infinity',
  last_object_id uuid not null default '00000000-0000-0000-0000-000000000000'
);
alter table public.public_media_cleanup_scan_cursor enable row level security;
revoke all on public.public_media_cleanup_scan_cursor from public,anon,authenticated;
insert into public.public_media_cleanup_scan_cursor(singleton) values(true);
-- Hosted Storage owns this managed table. Its installer role may be allowed
-- policies/triggers but not CREATE INDEX; the index is a scan optimization,
-- while ACLs, bounded candidates, leases and deletion guards remain mandatory.
do $$
begin
  create index xelay_public_media_cleanup_scan_idx on storage.objects(created_at,id)
    where bucket_id in ('avatars','answer-media','question-images');
exception when insufficient_privilege then
  raise notice 'Public media cleanup scan optimization unavailable on managed Storage';
end $$;

create or replace function public.xelay_public_media_cleanup_candidates(
  p_before timestamptz default clock_timestamp()-interval '1 day',p_limit integer default 100)
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_cursor public.public_media_cleanup_scan_cursor%rowtype; v_object record; v_result jsonb:='[]'; v_scanned integer:=0;
begin
  if p_before is null or not isfinite(p_before) or p_before>clock_timestamp()-interval '1 hour'
    or p_limit is null or p_limit not between 1 and 100 then raise exception 'Invalid cleanup window' using errcode='22023'; end if;
  select * into v_cursor from public.public_media_cleanup_scan_cursor where singleton for update;
  -- Apply LIMIT before reference checks. The cursor rotates past retained files
  -- so an old referenced prefix cannot starve later detached uploads.
  for v_object in select o.* from storage.objects o where o.bucket_id in ('avatars','answer-media','question-images')
    and o.created_at<p_before and (o.created_at,o.id)>(v_cursor.last_created_at,v_cursor.last_object_id)
    order by o.created_at,o.id limit least(200,p_limit*2)
  loop
    v_scanned:=v_scanned+1;
    v_cursor.last_created_at:=v_object.created_at; v_cursor.last_object_id:=v_object.id;
    if coalesce(v_object.updated_at,v_object.created_at)<p_before
      and public.xelay_public_media_attributable(to_jsonb(v_object)) and not public.xelay_public_media_referenced(v_object.bucket_id,v_object.name)
      and not exists(select 1 from public.public_media_cleanup_claims c where c.bucket_id=v_object.bucket_id and c.storage_path=v_object.name
        and c.expires_at>clock_timestamp()) then
      v_result:=v_result||jsonb_build_array(jsonb_build_object('bucket_id',v_object.bucket_id,'name',v_object.name,'object_id',v_object.id));
      if jsonb_array_length(v_result)>=p_limit then exit; end if;
    end if;
  end loop;
  if v_scanned=0 then v_cursor.last_created_at:='-infinity';v_cursor.last_object_id:='00000000-0000-0000-0000-000000000000'; end if;
  update public.public_media_cleanup_scan_cursor set last_created_at=v_cursor.last_created_at,last_object_id=v_cursor.last_object_id where singleton;
  return v_result;
end $$;
revoke all on function public.xelay_public_media_cleanup_candidates(timestamptz,integer) from public,anon,authenticated,service_role;
grant execute on function public.xelay_public_media_cleanup_candidates(timestamptz,integer) to service_role;

create or replace function public.xelay_public_media_cleanup_claim(p_bucket_id text,p_storage_path text,p_object_id uuid)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_object storage.objects%rowtype;
begin
  if p_bucket_id not in ('avatars','answer-media','question-images') or p_object_id is null then return false; end if;
  select * into v_object from storage.objects where bucket_id=p_bucket_id and name=p_storage_path and id=p_object_id for update;
  if not found or coalesce(v_object.updated_at,v_object.created_at)>clock_timestamp()-interval '1 hour'
    or not public.xelay_public_media_attributable(to_jsonb(v_object))
    or public.xelay_public_media_referenced(p_bucket_id,p_storage_path) then return false; end if;
  insert into public.public_media_cleanup_claims(bucket_id,storage_path,object_id,object_updated_at,object_metadata,object_version)
    values(p_bucket_id,p_storage_path,p_object_id,coalesce(v_object.updated_at,v_object.created_at),v_object.metadata,to_jsonb(v_object)->>'version')
    on conflict(bucket_id,storage_path) do update set object_id=excluded.object_id,object_updated_at=excluded.object_updated_at,
      object_metadata=excluded.object_metadata,object_version=excluded.object_version,expires_at=clock_timestamp()+interval '5 minutes';
  return true;
end $$;
revoke all on function public.xelay_public_media_cleanup_claim(text,text,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_public_media_cleanup_claim(text,text,uuid) to service_role;

create or replace function public.xelay_public_media_cleanup_guard()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_role text:=coalesce(current_setting('role',true),'none');
begin
  if tg_op='INSERT' then
    if new.bucket_id in ('avatars','answer-media','question-images') then
      delete from public.public_media_cleanup_claims where bucket_id=new.bucket_id and storage_path=new.name;
    end if;
    return new;
  end if;
  if old.bucket_id not in ('avatars','answer-media','question-images') then
    if tg_op='DELETE' then return old; else return new; end if;
  end if;
  if tg_op='UPDATE' then
    -- An upsert can keep the UUID while replacing its object version. Any
    -- replacement invalidates the old lease before Storage metadata changes.
    delete from public.public_media_cleanup_claims where bucket_id=old.bucket_id and storage_path=old.name;
    return new;
  end if;
  if v_role not in ('none','postgres','supabase_admin','anon','authenticated') then
    if public.xelay_public_media_referenced(old.bucket_id,old.name) or not exists(
      select 1 from public.public_media_cleanup_claims c where c.bucket_id=old.bucket_id and c.storage_path=old.name
        and c.object_id=old.id and c.object_updated_at=coalesce(old.updated_at,old.created_at)
        and c.object_metadata is not distinct from old.metadata
        and c.object_version is not distinct from to_jsonb(old)->>'version' and c.expires_at>clock_timestamp()) then
      raise exception 'Public media cleanup lease required' using errcode='42501'; end if;
  end if;
  delete from public.public_media_cleanup_claims where bucket_id=old.bucket_id and storage_path=old.name;
  return old;
end $$;
revoke all on function public.xelay_public_media_cleanup_guard() from public,anon,authenticated,service_role;
create trigger xelay_public_media_cleanup_guard before insert or update or delete on storage.objects
  for each row execute function public.xelay_public_media_cleanup_guard();

-- Reference writes and deletes lock the same Storage row. A reference cannot
-- attach after a cleanup lease is granted, and deletion rechecks current links.
create or replace function public.xelay_public_media_reference_guard()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_text text; v_object record; v_link text[]; v_bucket text; v_path text; v_link_count integer:=0;
begin
  if tg_op='UPDATE' then
    if tg_table_name='profiles' and to_jsonb(new)->>'avatar_url' is not distinct from to_jsonb(old)->>'avatar_url' then return new;
    elsif tg_table_name in ('question_images','answer_images') and to_jsonb(new)->>'image_url' is not distinct from to_jsonb(old)->>'image_url' then return new;
    elsif tg_table_name in ('questions','answers') and to_jsonb(new)->>'content' is not distinct from to_jsonb(old)->>'content'
      and to_jsonb(new)->>'author_avatar' is not distinct from to_jsonb(old)->>'author_avatar'
      and to_jsonb(new)->>'media_url' is not distinct from to_jsonb(old)->>'media_url' then return new; end if;
  end if;
  if tg_table_name='profiles' then v_text:=new.avatar_url;
  elsif tg_table_name in ('question_images','answer_images') then v_text:=new.image_url;
  else v_text:=coalesce(to_jsonb(new)->>'author_avatar','')||' '||coalesce(to_jsonb(new)->>'media_url','')||' '||coalesce(new.content,''); end if;
  if v_text is null or position('/storage/v1/object/public/' in v_text)=0 then return new; end if;
  if length(v_text)>55000 then raise exception 'CONTENT_TOO_LONG' using errcode='22023'; end if;
  -- Resolve only URLs present in this write, using the existing bucket/name
  -- unique index. A message save never scans the entire Storage inventory.
  for v_link in select regexp_matches(v_text,'/storage/v1/object/public/(avatars|answer-media|question-images)/([^[:space:]<>"?#]+)','g') limit 101
  loop
    v_link_count:=v_link_count+1;
    if v_link_count>100 then raise exception 'CONTENT_MEDIA_LINK_LIMIT' using errcode='22023'; end if;
    v_bucket:=v_link[1];v_path:=public.xelay_public_media_decode_url(v_link[2]);
    select o.id,o.bucket_id,o.name into v_object from storage.objects o where o.bucket_id=v_bucket and o.name=v_path for key share;
    if not found then
      -- Markdown or sentence punctuation is not part of the uploaded path.
      v_path:=regexp_replace(v_path,'[)\],.!:;]+$','');
      select o.id,o.bucket_id,o.name into v_object from storage.objects o where o.bucket_id=v_bucket and o.name=v_path for key share;
    end if;
    if not found then continue; end if;
    if exists(select 1 from public.public_media_cleanup_claims c where c.bucket_id=v_object.bucket_id
      and c.storage_path=v_object.name and c.object_id=v_object.id and c.expires_at>clock_timestamp()) then
      raise exception 'Media cleanup in progress; upload a new file' using errcode='42501'; end if;
  end loop;
  return new;
end $$;
revoke all on function public.xelay_public_media_reference_guard() from public,anon,authenticated,service_role;
create trigger xelay_public_media_reference_guard before insert or update on public.profiles
  for each row execute function public.xelay_public_media_reference_guard();
create trigger xelay_public_media_reference_guard before insert or update on public.questions
  for each row execute function public.xelay_public_media_reference_guard();
create trigger xelay_public_media_reference_guard before insert or update on public.answers
  for each row execute function public.xelay_public_media_reference_guard();
create trigger xelay_public_media_reference_guard before insert or update on public.question_images
  for each row execute function public.xelay_public_media_reference_guard();
create trigger xelay_public_media_reference_guard before insert or update on public.answer_images
  for each row execute function public.xelay_public_media_reference_guard();

create or replace function public.xelay_public_media_maintenance()
returns jsonb language plpgsql security definer set search_path=public,pg_temp as $$
declare v_receipts bigint; v_content bigint; v_reservations bigint; v_claims bigint; v_views bigint;
begin
  delete from public.public_media_upload_receipts where id in (select id from public.public_media_upload_receipts
    where created_at<clock_timestamp()-interval '7 days' order by created_at limit 10000); get diagnostics v_receipts=row_count;
  delete from public.public_media_upload_reservations where (bucket_id,storage_path) in (
    select bucket_id,storage_path from public.public_media_upload_reservations where expires_at<clock_timestamp() order by expires_at limit 10000);
  get diagnostics v_reservations=row_count;
  delete from public.public_media_cleanup_claims where (bucket_id,storage_path) in (
    select bucket_id,storage_path from public.public_media_cleanup_claims where expires_at<clock_timestamp() order by expires_at limit 10000);
  get diagnostics v_claims=row_count;
  delete from public.question_view_receipts where (question_id,user_id,viewed_on) in (
    select question_id,user_id,viewed_on from public.question_view_receipts where viewed_on<current_date-7 order by viewed_on limit 10000);
  get diagnostics v_views=row_count;
  delete from public.public_content_creation_receipts where id in (select id from public.public_content_creation_receipts
    where created_at<clock_timestamp()-interval '7 days' order by created_at limit 10000); get diagnostics v_content=row_count;
  return jsonb_build_object('receipts',v_receipts,'content_receipts',v_content,'reservations',v_reservations,'claims',v_claims,'views',v_views);
end $$;
revoke all on function public.xelay_public_media_maintenance() from public,anon,authenticated,service_role;
grant execute on function public.xelay_public_media_maintenance() to service_role;
notify pgrst,'reload schema';
commit;
