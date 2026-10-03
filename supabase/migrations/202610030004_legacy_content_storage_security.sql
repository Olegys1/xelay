-- SEC-01/02/03: legacy public content remains readable, but only its author
-- may edit it or attach media. Existing TEXT IDs and file paths are preserved.
begin;

lock table public.questions, public.answers, public.question_images, public.answer_images
  in share row exclusive mode;

-- Remove every legacy write policy, including PUBLIC ALL policies. A newly
-- added restrictive guard also prevents another permissive policy reopening it.
do $$
declare p record;
begin
  for p in select tablename, policyname from pg_policies
    where schemaname='public' and tablename in ('questions','answers','question_images','answer_images')
      and cmd in ('ALL','INSERT','UPDATE','DELETE')
  loop execute format('drop policy %I on public.%I',p.policyname,p.tablename); end loop;
end $$;

create policy "Authors insert questions" on public.questions for insert to authenticated
  with check (user_id::text=auth.uid()::text);
create policy "Authors update questions" on public.questions for update to authenticated
  using (user_id::text=auth.uid()::text) with check (user_id::text=auth.uid()::text);
create policy "Question author write guard" on public.questions as restrictive for all to authenticated
  using (true) with check (user_id::text=auth.uid()::text);
create policy "Authors insert answers" on public.answers for insert to authenticated
  with check (user_id::text=auth.uid()::text);
create policy "Authors update answers" on public.answers for update to authenticated
  using (user_id::text=auth.uid()::text) with check (user_id::text=auth.uid()::text);
create policy "Answer author write guard" on public.answers as restrictive for all to authenticated
  using (true) with check (user_id::text=auth.uid()::text);

-- Keep a narrow edit contract. DELETE continues through the existing owner-
-- checked RPCs, preserving their parent locks, notifications and counters.
revoke insert, update, delete, truncate, references, trigger
  on public.questions, public.answers from public, anon, authenticated;
do $$
declare t text; cols text;
begin
  foreach t in array array['questions','answers'] loop
    select string_agg(quote_ident(attname),', ') into cols from pg_attribute
      where attrelid=format('public.%I',t)::regclass and attnum>0 and not attisdropped;
    execute format('revoke insert (%s), update (%s), references (%s) on public.%I from public, anon, authenticated',cols,cols,cols,t);
  end loop;
end $$;
grant insert on public.questions, public.answers to authenticated;
grant update (title,content,category) on public.questions to authenticated;
grant update (content,media_url,media_type) on public.answers to authenticated;

create table public.public_content_creation_receipts (
  id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default clock_timestamp()
);
create index public_content_creation_receipts_user_time_idx on public.public_content_creation_receipts(user_id,created_at);
alter table public.public_content_creation_receipts enable row level security;
revoke all on public.public_content_creation_receipts from public,anon,authenticated;

create or replace function public.xelay_public_content_creation_guard()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if coalesce(current_setting('role',true),'none') not in ('anon','authenticated') then return new; end if;
  if auth.uid() is null or new.user_id::text is distinct from auth.uid()::text then
    raise exception 'Author permission required' using errcode='42501'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:public-content:'||auth.uid()::text,0));
  delete from public.public_content_creation_receipts where user_id=auth.uid() and created_at<clock_timestamp()-interval '7 days';
  if (select count(*) from public.public_content_creation_receipts where user_id=auth.uid()
    and created_at>clock_timestamp()-interval '1 minute')>=30 or
    (select count(*) from public.public_content_creation_receipts where user_id=auth.uid()
      and created_at>clock_timestamp()-interval '24 hours')>=1000 then
    raise exception 'CONTENT_RATE_LIMIT' using errcode='54000'; end if;
  insert into public.public_content_creation_receipts(user_id) values(auth.uid());
  return new;
end $$;
revoke all on function public.xelay_public_content_creation_guard() from public,anon,authenticated,service_role;
create trigger xelay_public_content_creation_guard before insert on public.questions
  for each row execute function public.xelay_public_content_creation_guard();
create trigger xelay_public_content_creation_guard before insert on public.answers
  for each row execute function public.xelay_public_content_creation_guard();

-- SECURITY INVOKER is intentional: trusted definer counter/deletion RPCs
-- retain their server privileges, while an ordinary PATCH cannot change IDs,
-- authorship, timestamps, pins or counters. Trigger functions aren't RPCs.
create or replace function public.xelay_guard_legacy_content_identity()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare v_name text; v_avatar text; v_rating integer; v_fields text[]; v_field text;
begin
  if current_user not in ('anon','authenticated') then return new; end if;
  if auth.uid() is null or new.user_id::text is distinct from auth.uid()::text then
    raise exception 'Author permission required' using errcode='42501';
  end if;
  if tg_op='INSERT' or new.content is distinct from old.content then
    if length(coalesce(new.content,''))>50000 then raise exception 'CONTENT_TOO_LONG' using errcode='22023'; end if;
  end if;
  if tg_table_name='questions' then
    if tg_op='INSERT' or new.title is distinct from old.title then
      if length(coalesce(new.title,''))>500 then raise exception 'CONTENT_TITLE_TOO_LONG' using errcode='22023'; end if;
    end if;
    if tg_op='INSERT' or new.category is distinct from old.category then
      if length(coalesce(new.category,''))>200 then raise exception 'CONTENT_CATEGORY_TOO_LONG' using errcode='22023'; end if;
    end if;
  end if;
  if tg_op='INSERT' then
    select full_name,avatar_url,rating into v_name,v_avatar,v_rating
      from public.profiles where id=auth.uid();
    new.author_name:=coalesce(nullif(trim(v_name),''),'Учасник Xelay');
    new.author_avatar:=coalesce(v_avatar,'');
    new.created_at:=statement_timestamp();
    new.likes:=0;
    if tg_table_name='questions' then
      new.answers_count:=0; new.views:=0; new.is_pinned:=false;
    else new.author_rating:=coalesce(v_rating,0); end if;
  else
    v_fields:=array['id','user_id','author_name','author_avatar','created_at','likes'];
    if tg_table_name='questions' then v_fields:=v_fields||array['answers_count','views','is_pinned'];
    else v_fields:=v_fields||array['question_id','author_rating']; end if;
    foreach v_field in array v_fields loop
      if to_jsonb(new)->v_field is distinct from to_jsonb(old)->v_field then
        raise exception 'System content fields cannot be changed' using errcode='42501';
      end if;
    end loop;
  end if;
  if tg_table_name='answers' then
    if new.media_url is not null and (tg_op='INSERT' or new.media_url is distinct from old.media_url) then
      perform public.xelay_owned_public_media_size(new.media_url);
    end if;
  end if;
  return new;
end $$;
revoke all on function public.xelay_guard_legacy_content_identity() from public,anon,authenticated;
create trigger xelay_content_identity_guard before insert or update on public.questions
  for each row execute function public.xelay_guard_legacy_content_identity();
create trigger xelay_content_identity_guard before insert or update on public.answers
  for each row execute function public.xelay_guard_legacy_content_identity();

-- Retain the existing view-counter call without granting arbitrary UPDATE.
-- Per-user/per-question/day deduplication bounds repeated authenticated calls;
-- anonymous requests don't write counters or create unbounded tracking rows.
create table public.question_view_receipts (
  question_id text not null references public.questions(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  viewed_on date not null default current_date,
  primary key(question_id,user_id,viewed_on)
);
alter table public.question_view_receipts enable row level security;
revoke all on public.question_view_receipts from public,anon,authenticated;
create or replace function public.increment_question_views(question_id text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if auth.uid() is null then return; end if;
  perform 1 from public.questions q where q.id::text=question_id for key share;
  if not found then return; end if;
  delete from public.question_view_receipts where user_id=auth.uid() and viewed_on<current_date-7;
  insert into public.question_view_receipts(question_id,user_id,viewed_on)
    values (question_id,auth.uid(),current_date) on conflict do nothing;
  if found then update public.questions q set views=coalesce(q.views,0)+1 where q.id::text=question_id; end if;
end $$;
revoke all on function public.increment_question_views(text) from public,anon,authenticated;
grant execute on function public.increment_question_views(text) to anon,authenticated;

-- Storage owner metadata is authoritative. Only genuinely ownerless legacy
-- paths use a linked-parent fallback, and ambiguous links never grant access.
create or replace function public.xelay_owns_legacy_public_object(p_bucket text,p_name text,p_owner text)
returns boolean language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_user text:=auth.uid()::text; v_suffix text; v_own boolean; v_foreign boolean;
begin
  if v_user is null or p_bucket not in ('avatars','answer-media','question-images') then return false; end if;
  if nullif(p_owner,'') is not null then return p_owner=v_user; end if;
  if split_part(p_name,'/',1)=v_user then return true; end if;
  v_suffix:='/storage/v1/object/public/'||p_bucket||'/'||p_name;
  if p_bucket='avatars' then
    return p_name like v_user||'-%' or exists(select 1 from public.profiles
      where id=auth.uid() and right(avatar_url,length(v_suffix))=v_suffix);
  end if;
  select coalesce(bool_or(owner_id=v_user),false),coalesce(bool_or(owner_id is distinct from v_user),false)
    into v_own,v_foreign from (
      select q.user_id::text owner_id from public.question_images i join public.questions q on q.id::text=i.question_id::text
        where right(i.image_url,length(v_suffix))=v_suffix
      union all
      select a.user_id::text from public.answer_images i join public.answers a on a.id::text=i.answer_id::text
        where right(i.image_url,length(v_suffix))=v_suffix
      union all
      select a.user_id::text from public.answers a where right(a.media_url,length(v_suffix))=v_suffix
    ) links;
  return v_own and not v_foreign;
end $$;
revoke all on function public.xelay_owns_legacy_public_object(text,text,text) from public,anon,authenticated;
grant execute on function public.xelay_owns_legacy_public_object(text,text,text) to authenticated;

-- Only valid links from this deployment to an existing owned object may be
-- introduced. Existing unchanged legacy URLs are left untouched.
create or replace function public.xelay_owned_public_media_size(p_url text)
returns bigint language plpgsql security definer set search_path=public,pg_temp as $$
declare v_origin text; v_bucket text; v_name text; v_size bigint;
begin
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  v_origin:=regexp_replace(auth.jwt()->>'iss','/auth/v1/?$','');
  if p_url is null or v_origin is null or v_origin !~ '^https://[^/]+$'
    or position(v_origin||'/storage/v1/object/public/' in p_url)<>1 then
    raise exception 'Use uploaded project media' using errcode='22023'; end if;
  v_bucket:=split_part(substr(p_url,length(v_origin||'/storage/v1/object/public/')+1),'/',1);
  v_name:=substr(p_url,length(v_origin||'/storage/v1/object/public/'||v_bucket||'/')+1);
  if v_bucket not in ('answer-media','question-images') or v_name is null or v_name='' or v_name~'[?#%]' then
    raise exception 'Invalid public media path' using errcode='22023'; end if;
  select case when (o.metadata->>'size')~'^[0-9]{1,12}$' then (o.metadata->>'size')::bigint end into v_size
    from storage.objects o where o.bucket_id=v_bucket and o.name=v_name and public.xelay_owns_legacy_public_object(
      o.bucket_id,o.name,coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner')) for key share;
  if v_size is null then raise exception 'Owned uploaded media required' using errcode='42501'; end if;
  return v_size;
end $$;
revoke all on function public.xelay_owned_public_media_size(text) from public,anon,authenticated;
grant execute on function public.xelay_owned_public_media_size(text) to authenticated;

-- Restrictive bucket-scoped guards keep all unrelated private-media policies
-- intact, even if older permissive policies are still present on objects.
create policy "Legacy public upload guard" on storage.objects as restrictive for insert to authenticated
  with check (bucket_id not in ('avatars','answer-media','question-images') or
    (split_part(name,'/',1)=auth.uid()::text and name !~ '(^|/)\.\.?(/|$)' and length(name)<=512
      and coalesce(nullif(to_jsonb(objects)->>'owner_id',''),to_jsonb(objects)->>'owner')=auth.uid()::text));
create policy "Legacy public update guard" on storage.objects as restrictive for update to authenticated
  using (bucket_id not in ('avatars','answer-media','question-images') or public.xelay_owns_legacy_public_object(
    bucket_id,name,coalesce(nullif(to_jsonb(objects)->>'owner_id',''),to_jsonb(objects)->>'owner')))
  with check (bucket_id not in ('avatars','answer-media','question-images') or public.xelay_owns_legacy_public_object(
    bucket_id,name,coalesce(nullif(to_jsonb(objects)->>'owner_id',''),to_jsonb(objects)->>'owner')));
create policy "Legacy public delete guard" on storage.objects as restrictive for delete to authenticated
  using (bucket_id not in ('avatars','answer-media','question-images') or public.xelay_owns_legacy_public_object(
    bucket_id,name,coalesce(nullif(to_jsonb(objects)->>'owner_id',''),to_jsonb(objects)->>'owner')));
create policy "Authors update their public media" on storage.objects for update to authenticated
  using (bucket_id in ('answer-media','question-images') and public.xelay_owns_legacy_public_object(
    bucket_id,name,coalesce(nullif(to_jsonb(objects)->>'owner_id',''),to_jsonb(objects)->>'owner')))
  with check (bucket_id in ('answer-media','question-images') and public.xelay_owns_legacy_public_object(
    bucket_id,name,coalesce(nullif(to_jsonb(objects)->>'owner_id',''),to_jsonb(objects)->>'owner')));
create policy "Authors remove their question media" on storage.objects for delete to authenticated
  using (bucket_id='question-images' and public.xelay_owns_legacy_public_object(
    bucket_id,name,coalesce(nullif(to_jsonb(objects)->>'owner_id',''),to_jsonb(objects)->>'owner')));

-- Limits affect new uploads/replacements only; existing objects remain public
-- and readable. SVG/HTML are deliberately excluded from raster media buckets.
update storage.buckets set file_size_limit=5242880,
  allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif','image/avif'] where id='avatars';
update storage.buckets set file_size_limit=26214400,
  allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif','image/avif'] where id='question-images';
update storage.buckets set file_size_limit=26214400,
  allowed_mime_types=array['image/jpeg','image/png','image/webp','image/gif','image/avif','video/mp4','video/webm','video/quicktime']
  where id='answer-media';

create table public.public_media_upload_receipts (
  id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id) on delete cascade,
  bucket_id text not null,storage_path text not null,created_at timestamptz not null default now()
);
create index public_media_upload_receipts_user_time_idx on public.public_media_upload_receipts(user_id,created_at);
alter table public.public_media_upload_receipts enable row level security;
revoke all on public.public_media_upload_receipts from public,anon,authenticated;

-- Storage tests INSERT permissions in a transaction that is rolled back, then
-- writes real metadata as service_role after receiving the body. Reserve in a
-- separate committed RPC first: permission-test writes cannot charge a quota.
create table public.public_media_upload_reservations (
  bucket_id text not null,storage_path text not null,user_id uuid not null references auth.users(id) on delete cascade,
  byte_size bigint not null,mimetype text not null,expires_at timestamptz not null,
  primary key(bucket_id,storage_path)
);
create index public_media_upload_reservations_user_idx on public.public_media_upload_reservations(user_id,expires_at);
alter table public.public_media_upload_reservations enable row level security;
revoke all on public.public_media_upload_reservations from public,anon,authenticated;

create or replace function public.xelay_reserve_public_media_upload(
  p_bucket_id text,p_storage_path text,p_byte_size bigint,p_mimetype text)
returns boolean language plpgsql security definer set search_path=public,pg_temp as $$
declare v_user uuid:=auth.uid(); v_owner text; v_exists boolean; v_count bigint; v_bytes bigint; v_pending bigint; v_pending_bytes bigint;
begin
  if v_user is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if p_bucket_id is null or p_bucket_id not in ('avatars','answer-media','question-images') or p_storage_path is null
    or p_storage_path='' or length(p_storage_path)>512 or p_storage_path~'(^|/)\.\.?(/|$)' then
    raise exception 'Invalid public media path' using errcode='22023'; end if;
  if p_byte_size is null or p_byte_size<1 or p_byte_size>(case when p_bucket_id='avatars' then 5242880 else 26214400 end)
    or (p_mimetype not in ('image/jpeg','image/png','image/webp','image/gif','image/avif')
      and not (p_bucket_id='answer-media' and p_mimetype in ('video/mp4','video/webm','video/quicktime')))
    or p_mimetype is null then raise exception 'Invalid public media file' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:public-media:'||v_user::text,0));
  delete from public.public_media_upload_reservations where user_id=v_user and expires_at<=clock_timestamp();
  select coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner') into v_owner
    from storage.objects o where bucket_id=p_bucket_id and name=p_storage_path;
  v_exists:=found;
  if (v_exists and not public.xelay_owns_legacy_public_object(p_bucket_id,p_storage_path,v_owner))
    or (not v_exists and split_part(p_storage_path,'/',1)<>v_user::text) then
    raise exception 'Storage owner permission required' using errcode='42501'; end if;
  if exists(select 1 from public.public_media_upload_reservations where bucket_id=p_bucket_id
    and storage_path=p_storage_path and user_id=v_user and byte_size=p_byte_size and mimetype=p_mimetype
    and expires_at>clock_timestamp()) then return true; end if;
  if exists(select 1 from public.public_media_upload_reservations where bucket_id=p_bucket_id
    and storage_path=p_storage_path) then raise exception 'Upload already reserved' using errcode='42501'; end if;
  select count(*),coalesce(sum(case when (o.metadata->>'size')~'^[0-9]{1,12}$'
    then (o.metadata->>'size')::bigint else 0 end),0) into v_count,v_bytes
    from storage.objects o where o.bucket_id in ('avatars','answer-media','question-images')
      and not(o.bucket_id=p_bucket_id and o.name=p_storage_path)
      and (coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner')=v_user::text
        or split_part(o.name,'/',1)=v_user::text or (o.bucket_id='avatars' and o.name like v_user::text||'-%'));
  select count(*),coalesce(sum(byte_size),0) into v_pending,v_pending_bytes from public.public_media_upload_reservations
    where user_id=v_user and expires_at>clock_timestamp();
  if v_count+v_pending>=500 or v_bytes+v_pending_bytes+p_byte_size>524288000 then
    raise exception 'Public media account quota reached' using errcode='54000'; end if;
  delete from public.public_media_upload_receipts where user_id=v_user and created_at<clock_timestamp()-interval '7 days';
  if (select count(*) from public.public_media_upload_receipts where user_id=v_user
    and created_at>clock_timestamp()-interval '1 hour')>=50 or
    (select count(*) from public.public_media_upload_receipts where user_id=v_user
      and created_at>clock_timestamp()-interval '24 hours')>=200 then
    raise exception 'Public media upload rate exceeded' using errcode='54000'; end if;
  insert into public.public_media_upload_receipts(user_id,bucket_id,storage_path) values(v_user,p_bucket_id,p_storage_path);
  insert into public.public_media_upload_reservations(bucket_id,storage_path,user_id,byte_size,mimetype,expires_at)
    values(p_bucket_id,p_storage_path,v_user,p_byte_size,p_mimetype,clock_timestamp()+interval '15 minutes');
  return true;
end $$;
revoke all on function public.xelay_reserve_public_media_upload(text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.xelay_reserve_public_media_upload(text,text,bigint,text) to authenticated;

create or replace function public.xelay_cancel_public_media_upload(p_bucket_id text,p_storage_path text)
returns void language sql security definer set search_path=public,pg_temp as $$
  delete from public.public_media_upload_reservations where bucket_id=p_bucket_id and storage_path=p_storage_path and user_id=auth.uid();
$$;
revoke all on function public.xelay_cancel_public_media_upload(text,text) from public,anon,authenticated;
grant execute on function public.xelay_cancel_public_media_upload(text,text) to authenticated;

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
  else raise exception 'Valid file size required' using errcode='22023'; end if;
  v_type:=lower(split_part(coalesce(new.metadata->>'mimetype',''),';',1));
  if v_type not in ('image/jpeg','image/png','image/webp','image/gif','image/avif')
    and not (new.bucket_id='answer-media' and v_type in ('video/mp4','video/webm','video/quicktime')) then
    raise exception 'Unsupported public media type' using errcode='22023'; end if;
  if v_size<1 or v_size>v_reservation.byte_size or v_type<>v_reservation.mimetype then
    raise exception 'File differs from upload reservation' using errcode='22023'; end if;
  if v_size>(case when new.bucket_id='avatars' then 5242880 else 26214400 end) then
    raise exception 'Public media file is too large' using errcode='22023'; end if;
  -- A direct authenticated insert with preview metadata remains bounded too.
  if not(new.metadata ? 'size') then new.metadata:=new.metadata||jsonb_build_object('size',v_size); end if;
  return new;
end $$;
revoke all on function public.xelay_guard_legacy_public_storage() from public,anon,authenticated;
create trigger xelay_legacy_public_storage_guard before insert or update on storage.objects
  for each row execute function public.xelay_guard_legacy_public_storage();

create or replace function public.xelay_finish_public_media_upload()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if new.bucket_id in ('avatars','answer-media','question-images')
    and coalesce(current_setting('role',true),'none') not in ('none','postgres','supabase_admin') then
    delete from public.public_media_upload_reservations where bucket_id=new.bucket_id and storage_path=new.name
      and user_id::text=coalesce(nullif(to_jsonb(new)->>'owner_id',''),to_jsonb(new)->>'owner');
  end if;
  return new;
end $$;
revoke all on function public.xelay_finish_public_media_upload() from public,anon,authenticated;
create trigger xelay_finish_public_media_upload after insert or update on storage.objects
  for each row execute function public.xelay_finish_public_media_upload();

create policy "Public question media stays readable" on public.question_images for select to anon,authenticated using (true);
create policy "Public answer media stays readable" on public.answer_images for select to anon,authenticated using (true);
create policy "Question authors manage images" on public.question_images for all to authenticated
  using (exists(select 1 from public.questions q where q.id::text=question_id::text and q.user_id::text=auth.uid()::text))
  with check (exists(select 1 from public.questions q where q.id::text=question_id::text and q.user_id::text=auth.uid()::text));
create policy "Answer authors manage images" on public.answer_images for all to authenticated
  using (exists(select 1 from public.answers a where a.id::text=answer_id::text and a.user_id::text=auth.uid()::text))
  with check (exists(select 1 from public.answers a where a.id::text=answer_id::text and a.user_id::text=auth.uid()::text));
revoke all on public.question_images,public.answer_images from public,anon,authenticated;
grant select on public.question_images,public.answer_images to anon,authenticated;
grant insert,delete on public.question_images,public.answer_images to authenticated;
grant update(image_url) on public.question_images to authenticated;
grant update(image_url,media_type) on public.answer_images to authenticated;

create or replace function public.xelay_guard_legacy_image_attachment()
returns trigger language plpgsql security definer set search_path=public,pg_temp as $$
declare v_parent text; v_question text; v_owner text; v_count integer; v_size bigint; v_bytes bigint;
begin
  if current_setting('role',true) not in ('anon','authenticated') then return new; end if;
  if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
  if tg_table_name='question_images' then
    v_parent:=new.question_id::text;
    select user_id::text into v_owner from public.questions where id::text=v_parent for update;
  else
    v_parent:=new.answer_id::text;
    select question_id::text into v_question from public.answers where id::text=v_parent;
    perform 1 from public.questions where id::text=v_question for update;
    select user_id::text into v_owner from public.answers where id::text=v_parent for update;
  end if;
  if v_owner is distinct from auth.uid()::text then raise exception 'Author permission required' using errcode='42501'; end if;
  if tg_op='UPDATE' and (new.id is distinct from old.id or new.created_at is distinct from old.created_at
    or to_jsonb(new)->(case when tg_table_name='question_images' then 'question_id' else 'answer_id' end)
      is distinct from to_jsonb(old)->(case when tg_table_name='question_images' then 'question_id' else 'answer_id' end)) then
    raise exception 'Image identity cannot be changed' using errcode='42501'; end if;
  if tg_op='UPDATE' and new.image_url is not distinct from old.image_url then return new; end if;
  v_size:=public.xelay_owned_public_media_size(new.image_url);
  if tg_table_name='question_images' then
    select count(*),coalesce(sum(case when (o.metadata->>'size')~'^[0-9]{1,12}$'
      then (o.metadata->>'size')::bigint else 0 end),0) into v_count,v_bytes from public.question_images i
      left join storage.objects o on right(i.image_url,length('/storage/v1/object/public/'||o.bucket_id||'/'||o.name))=
        '/storage/v1/object/public/'||o.bucket_id||'/'||o.name and o.bucket_id in ('answer-media','question-images')
      where i.question_id::text=v_parent and i.id<>new.id;
  else
    select count(*),coalesce(sum(case when (o.metadata->>'size')~'^[0-9]{1,12}$'
      then (o.metadata->>'size')::bigint else 0 end),0) into v_count,v_bytes from public.answer_images i
      left join storage.objects o on right(i.image_url,length('/storage/v1/object/public/'||o.bucket_id||'/'||o.name))=
        '/storage/v1/object/public/'||o.bucket_id||'/'||o.name and o.bucket_id in ('answer-media','question-images')
      where i.answer_id::text=v_parent and i.id<>new.id;
  end if;
  if v_count>=5 or v_bytes+v_size>52428800 then raise exception 'Publication media limit reached' using errcode='54000'; end if;
  return new;
end $$;
revoke all on function public.xelay_guard_legacy_image_attachment() from public,anon,authenticated;
create trigger xelay_image_attachment_guard before insert or update on public.question_images
  for each row execute function public.xelay_guard_legacy_image_attachment();
create trigger xelay_image_attachment_guard before insert or update on public.answer_images
  for each row execute function public.xelay_guard_legacy_image_attachment();

commit;
