-- New academic uploads remain private until the content route verifies the
-- current Storage object. This supplements, and never replaces, feature ACLs.
begin;

create table public.xelay_upload_content_receipts (
  object_id uuid primary key,
  bucket_id text not null check(bucket_id in('xelay-teaching-files','xelay-submission-files','xelay-group-presentations','xelay-study-materials')),
  storage_path text not null,
  owner_marker text not null,
  object_created_at timestamptz not null,
  object_updated_at timestamptz not null,
  storage_version text not null,
  object_metadata jsonb not null,
  size bigint not null check(size between 1 and 52428800),
  mime_type text not null,
  verification_kind text not null check(verification_kind in('legacy_inventory','content_verified')),
  validation_version integer,
  content_sha256 text,
  validation_sha256 text,
  verified_at timestamptz not null default clock_timestamp(),
  check((verification_kind='legacy_inventory' and validation_version is null and content_sha256 is null and validation_sha256 is null)
    or(verification_kind='content_verified' and validation_version is not null and validation_version=1
      and content_sha256 is not null and content_sha256 ~ '^[0-9a-f]{64}$' and validation_sha256 is not null and validation_sha256 ~ '^[0-9a-f]{64}$')),
  unique(bucket_id,storage_path)
);
alter table public.xelay_upload_content_receipts enable row level security;
revoke all on public.xelay_upload_content_receipts from public,anon,authenticated,service_role;

create table public.xelay_upload_scan_budgets (
  owner_id uuid primary key,
  window_start timestamptz not null,
  attempts integer not null check(attempts between 0 and 20),
  total_bytes bigint not null check(total_bytes between 0 and 262144000)
);
alter table public.xelay_upload_scan_budgets enable row level security;
revoke all on public.xelay_upload_scan_budgets from public,anon,authenticated,service_role;

create function public.xelay_upload_format_allowed(p_bucket text,p_path text,p_mime text)
returns boolean language sql immutable set search_path='' as $$
  select case when p_bucket in('xelay-teaching-files','xelay-submission-files')
    then coalesce(public.xelay_teaching_file_allowed(p_path,p_mime),false)
    when p_bucket='xelay-group-presentations' then
      p_mime=any(array['application/pdf','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/jpeg','image/png','image/webp'])
      and public.xelay_material_file_mime(p_path)=p_mime
    when p_bucket='xelay-study-materials' then public.xelay_material_file_mime(p_path)=p_mime
    else false end;
$$;

-- Exact inventory, not a created_at cutoff: backdating a future object can never
-- manufacture grandfathered status. Any later row mutation removes this receipt.
insert into public.xelay_upload_content_receipts(object_id,bucket_id,storage_path,owner_marker,object_created_at,object_updated_at,storage_version,object_metadata,size,mime_type,verification_kind)
select o.id,o.bucket_id,o.name,coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner',''),o.created_at,o.updated_at,
  coalesce(to_jsonb(o)->>'version',''),o.metadata,(o.metadata->>'size')::bigint,o.metadata->>'mimetype','legacy_inventory'
from storage.objects o
where o.bucket_id in('xelay-teaching-files','xelay-submission-files','xelay-group-presentations','xelay-study-materials')
  and o.created_at is not null and o.updated_at is not null
  and case when jsonb_typeof(o.metadata)='object' and coalesce(o.metadata->>'size','') ~ '^[0-9]{1,9}$'
    then (o.metadata->>'size')::bigint between 1 and 52428800 else false end
  and coalesce(public.xelay_upload_format_allowed(o.bucket_id,o.name,o.metadata->>'mimetype'),false);

create function public.xelay_upload_object_verified(p_bucket text,p_path text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from storage.objects o join public.xelay_upload_content_receipts r on r.object_id=o.id
    where o.bucket_id=p_bucket and o.name=p_path and r.bucket_id=o.bucket_id and r.storage_path=o.name
      and r.owner_marker=coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner','')
      and r.object_created_at=o.created_at and r.object_updated_at=o.updated_at
      and r.storage_version=coalesce(to_jsonb(o)->>'version','') and r.object_metadata=o.metadata
      and coalesce(o.metadata->>'size','')=r.size::text and o.metadata->>'mimetype'=r.mime_type
      and coalesce(public.xelay_upload_format_allowed(o.bucket_id,o.name,r.mime_type),false));
$$;

create function public.xelay_upload_snapshot(p_object storage.objects,p_verified boolean)
returns jsonb language sql stable set search_path='' as $$
  select jsonb_build_object('object_id',(p_object).id,'bucket_id',(p_object).bucket_id,'storage_path',(p_object).name,
    'owner_id',coalesce(nullif(to_jsonb(p_object)->>'owner_id',''),to_jsonb(p_object)->>'owner',''),
    'size',((p_object).metadata->>'size')::bigint,'mime_type',(p_object).metadata->>'mimetype',
    'created_at',(p_object).created_at,'updated_at',(p_object).updated_at,
    'storage_version',coalesce(to_jsonb(p_object)->>'version',''),'already_verified',p_verified);
$$;

create function public.xelay_upload_scan_candidate(p_bucket text,p_path text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_actor uuid:=auth.uid();v_object storage.objects%rowtype;v_verified boolean;v_size bigint;
  v_window timestamptz:=to_timestamp(floor(extract(epoch from clock_timestamp())/600)*600);
  v_budget public.xelay_upload_scan_budgets%rowtype;
begin
  if v_actor is null or auth.role() is distinct from 'authenticated'
    or p_bucket not in('xelay-teaching-files','xelay-submission-files','xelay-group-presentations','xelay-study-materials')
    or p_path !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[a-z0-9]{1,5}$'
    or split_part(p_path,'/',2)<>v_actor::text then raise exception 'UPLOAD_VERIFICATION_FORBIDDEN' using errcode='42501'; end if;
  if not exists(select 1 from auth.users u where u.id=v_actor and u.email_confirmed_at is not null and u.deleted_at is null
    and coalesce(u.banned_until,'-infinity'::timestamptz)<=now()) then raise exception 'UPLOAD_VERIFICATION_FORBIDDEN' using errcode='42501'; end if;
  select * into v_object from storage.objects where bucket_id=p_bucket and name=p_path for share;
  if not found or coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),to_jsonb(v_object)->>'owner','')<>v_actor::text
    then raise exception 'UPLOAD_VERIFICATION_FORBIDDEN' using errcode='42501'; end if;
  if jsonb_typeof(v_object.metadata) is distinct from 'object' or coalesce(v_object.metadata->>'size','') !~ '^[0-9]{1,9}$'
    or v_object.created_at is null or v_object.updated_at is null
    or not coalesce(public.xelay_upload_format_allowed(p_bucket,p_path,v_object.metadata->>'mimetype'),false)
    then raise exception 'UPLOAD_VERIFICATION_INVALID' using errcode='22023'; end if;
  v_size:=(v_object.metadata->>'size')::bigint;
  if v_size not between 1 and 52428800 then raise exception 'UPLOAD_VERIFICATION_INVALID' using errcode='22023'; end if;
  v_verified:=public.xelay_upload_object_verified(p_bucket,p_path) and exists(select 1 from public.xelay_upload_content_receipts r
    where r.object_id=v_object.id and r.verification_kind='content_verified' and r.validation_version=1);
  if not v_verified then
    insert into public.xelay_upload_scan_budgets values(v_actor,v_window,0,0) on conflict(owner_id) do nothing;
    select * into v_budget from public.xelay_upload_scan_budgets where owner_id=v_actor for update;
    if v_budget.window_start<>v_window then v_budget.window_start:=v_window;v_budget.attempts:=0;v_budget.total_bytes:=0; end if;
    if v_budget.attempts>=20 or v_budget.total_bytes+v_size>262144000 then raise exception 'UPLOAD_VERIFICATION_RATE_LIMIT' using errcode='PT429'; end if;
    update public.xelay_upload_scan_budgets set window_start=v_window,attempts=v_budget.attempts+1,total_bytes=v_budget.total_bytes+v_size where owner_id=v_actor;
  end if;
  return public.xelay_upload_snapshot(v_object,v_verified);
end;
$$;

create function public.xelay_record_upload_content_verification(p_candidate jsonb,p_content_sha256 text,p_validation_sha256 text,p_detected_mime text,p_validation_version integer default 1)
returns boolean language plpgsql volatile security definer set search_path='' as $$
declare v_object storage.objects%rowtype;v_size bigint;v_owner text;
begin
  if auth.role() is distinct from 'service_role' then raise exception 'UPLOAD_VERIFICATION_FORBIDDEN' using errcode='42501'; end if;
  if jsonb_typeof(p_candidate) is distinct from 'object' or p_candidate->>'bucket_id' not in('xelay-teaching-files','xelay-submission-files','xelay-group-presentations','xelay-study-materials')
    or p_validation_version is distinct from 1 or p_content_sha256 is null or p_content_sha256 !~ '^[0-9a-f]{64}$'
    or p_validation_sha256 is null or p_validation_sha256 !~ '^[0-9a-f]{64}$'
    or jsonb_typeof(p_candidate->'already_verified') is distinct from 'boolean'
    then raise exception 'UPLOAD_VERIFICATION_INVALID' using errcode='22023'; end if;
  select * into v_object from storage.objects where bucket_id=p_candidate->>'bucket_id' and name=p_candidate->>'storage_path' for update;
  if not found then return false; end if;
  if coalesce(v_object.metadata->>'size','') !~ '^[0-9]{1,9}$' then return false; end if;
  v_size:=(v_object.metadata->>'size')::bigint;
  v_owner:=coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),to_jsonb(v_object)->>'owner','');
  if v_size not between 1 and 52428800 or v_owner !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    or split_part(v_object.name,'/',2)<>v_owner or v_object.created_at is null or v_object.updated_at is null
    or not coalesce(public.xelay_upload_format_allowed(v_object.bucket_id,v_object.name,v_object.metadata->>'mimetype'),false)
    or p_detected_mime is distinct from v_object.metadata->>'mimetype'
    or p_candidate is distinct from public.xelay_upload_snapshot(v_object,(p_candidate->>'already_verified')::boolean) then return false; end if;
  insert into public.xelay_upload_content_receipts(object_id,bucket_id,storage_path,owner_marker,object_created_at,object_updated_at,storage_version,object_metadata,size,mime_type,verification_kind,validation_version,content_sha256,validation_sha256)
  values(v_object.id,v_object.bucket_id,v_object.name,v_owner,v_object.created_at,v_object.updated_at,coalesce(to_jsonb(v_object)->>'version',''),v_object.metadata,v_size,p_detected_mime,'content_verified',1,p_content_sha256,p_validation_sha256)
  on conflict(object_id) do update set bucket_id=excluded.bucket_id,storage_path=excluded.storage_path,owner_marker=excluded.owner_marker,
    object_created_at=excluded.object_created_at,object_updated_at=excluded.object_updated_at,storage_version=excluded.storage_version,object_metadata=excluded.object_metadata,
    size=excluded.size,mime_type=excluded.mime_type,verification_kind='content_verified',validation_version=1,content_sha256=excluded.content_sha256,validation_sha256=excluded.validation_sha256,verified_at=clock_timestamp();
  return true;
end;
$$;

create function public.xelay_upload_receipt_invalidate()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if tg_op<>'INSERT' then delete from public.xelay_upload_content_receipts where object_id=old.id; end if;
  if tg_op<>'DELETE' then delete from public.xelay_upload_content_receipts where object_id=new.id;return new; end if;
  return old;
end;
$$;
create trigger xelay_upload_content_invalidation after insert or update or delete on storage.objects
  for each row execute function public.xelay_upload_receipt_invalidate();

create function public.xelay_upload_read_ready(p_bucket text,p_path text)
returns boolean language sql stable security definer set search_path='' as $$
  select case when p_bucket not in('xelay-teaching-files','xelay-submission-files','xelay-group-presentations','xelay-study-materials') then true
    else public.xelay_upload_object_verified(p_bucket,p_path) end;
$$;
create policy "Academic uploads require current content receipt" on storage.objects as restrictive for select to anon,authenticated
  using(public.xelay_upload_read_ready(bucket_id,name));
create policy "Academic verified objects cannot be overwritten" on storage.objects as restrictive for update to anon,authenticated
  using(bucket_id not in('xelay-teaching-files','xelay-submission-files','xelay-group-presentations','xelay-study-materials'))
  with check(bucket_id not in('xelay-teaching-files','xelay-submission-files','xelay-group-presentations','xelay-study-materials'));

-- The restricted-material proxy authorizes through this SECURITY DEFINER RPC
-- and reads bytes with a server key, so Storage SELECT alone cannot protect it.
-- Keep the complete existing authorization implementation private and unchanged;
-- its canonical item/audience/author/download checks always run before this gate.
do $install$
declare v_definition text;
begin
  if to_regprocedure('public.xelay_teaching_material_file_access(uuid,text)') is not null then
    if to_regprocedure('public.xelay_teaching_material_file_access_before_content_20261030(uuid,text)') is not null then
      raise exception 'UPLOAD_CONTENT_MATERIAL_PROXY_ALREADY_WRAPPED';
    end if;
    v_definition:=replace(pg_get_functiondef('public.xelay_teaching_material_file_access(uuid,text)'::regprocedure),chr(13),'');
    if position('public.xelay_teaching_can_read_item(p_item_id,v_uid)' in v_definition)=0
      or position('jsonb_array_elements(v_item.attachments)' in v_definition)=0
      or position('protected.kind=''material'' and not protected.allow_download' in v_definition)=0
      or position('v_object.metadata->>''size''' in v_definition)=0
      or position('v_object.metadata->>''mimetype''' in v_definition)=0 then
      raise exception 'UPLOAD_CONTENT_MATERIAL_PROXY_DRIFT';
    end if;
    alter function public.xelay_teaching_material_file_access(uuid,text) rename to xelay_teaching_material_file_access_before_content_20261030;
    revoke all on function public.xelay_teaching_material_file_access_before_content_20261030(uuid,text) from public,anon,authenticated,service_role;
    execute $wrapper$
      create function public.xelay_teaching_material_file_access(p_item_id uuid,p_storage_path text)
      returns jsonb language plpgsql stable security definer set search_path='' as $$
      declare v_result jsonb;
      begin
        v_result:=public.xelay_teaching_material_file_access_before_content_20261030(p_item_id,p_storage_path);
        if not public.xelay_upload_object_verified('xelay-teaching-files',p_storage_path) then
          raise exception 'UPLOAD_VERIFICATION_REQUIRED' using errcode='42501';
        end if;
        return v_result;
      end;
      $$;
    $wrapper$;
    revoke all on function public.xelay_teaching_material_file_access(uuid,text) from public,anon,authenticated,service_role;
    grant execute on function public.xelay_teaching_material_file_access(uuid,text) to authenticated;
  end if;
end;
$install$;

create function public.xelay_upload_descriptor_guard()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_row jsonb:=to_jsonb(new);v_files jsonb;v_file jsonb;v_key text;v_path text;v_object storage.objects%rowtype;
begin
  foreach v_key in array tg_argv[1:] loop
    v_files:=v_row->v_key;
    if jsonb_typeof(v_files) is distinct from 'array' then raise exception 'UPLOAD_VERIFICATION_REQUIRED' using errcode='22023'; end if;
    for v_file in select value from jsonb_array_elements(v_files) loop
      v_path:=v_file->>(case when tg_argv[0] in('xelay-teaching-files','xelay-submission-files') then 'storage_path' else 'path' end);
      select * into v_object from storage.objects where bucket_id=tg_argv[0] and name=v_path for share;
      if not found or not public.xelay_upload_object_verified(tg_argv[0],v_path)
        or v_file->>'mime_type' is distinct from v_object.metadata->>'mimetype'
        or v_file->>(case when tg_argv[0] in('xelay-teaching-files','xelay-submission-files') then 'size' else 'file_size' end) is distinct from v_object.metadata->>'size'
        then raise exception 'UPLOAD_VERIFICATION_REQUIRED' using errcode='42501'; end if;
    end loop;
  end loop;
  return new;
end;
$$;

-- Descriptor triggers also protect direct privileged writes and every existing
-- feature RPC without rewriting any author, colleague or group permission code.
create trigger xelay_upload_verified_teaching_item before insert or update on public.teaching_items
  for each row execute function public.xelay_upload_descriptor_guard('xelay-teaching-files','attachments');
create trigger xelay_upload_verified_submission before insert or update on public.teaching_submissions
  for each row execute function public.xelay_upload_descriptor_guard('xelay-submission-files','attachments','draft_attachments');
create trigger xelay_upload_verified_submission_history before insert or update on public.teaching_submission_history
  for each row execute function public.xelay_upload_descriptor_guard('xelay-submission-files','attachments');
create trigger xelay_upload_verified_group_material before insert or update on public.study_group_materials
  for each row execute function public.xelay_upload_descriptor_guard('xelay-study-materials','attachments');
create trigger xelay_upload_verified_presentation before insert or update on public.study_group_presentations
  for each row execute function public.xelay_upload_descriptor_guard('xelay-group-presentations','attachments');

revoke all on function public.xelay_upload_format_allowed(text,text,text),public.xelay_upload_object_verified(text,text),public.xelay_upload_snapshot(storage.objects,boolean),
  public.xelay_upload_scan_candidate(text,text),public.xelay_record_upload_content_verification(jsonb,text,text,text,integer),
  public.xelay_upload_receipt_invalidate(),public.xelay_upload_read_ready(text,text),public.xelay_upload_descriptor_guard() from public,anon,authenticated,service_role;
grant execute on function public.xelay_upload_scan_candidate(text,text),public.xelay_upload_read_ready(text,text) to authenticated;
grant execute on function public.xelay_record_upload_content_verification(jsonb,text,text,text,integer) to service_role;
-- Anonymous policies can only return the existing RLS result intersected with
-- this gate; granting this boolean predicate gives no table or object access.
grant execute on function public.xelay_upload_read_ready(text,text) to anon;
commit;
