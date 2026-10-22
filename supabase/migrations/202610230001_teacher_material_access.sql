-- Author-selected original-file access for canonical teacher materials.
-- Apply the whole file after inspecting the live catalog. No public bucket,
-- signed URL, new paid service, or client table-write grant is introduced.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $$
declare v_signature text;
begin
  foreach v_signature in array array[
    'public.xelay_teaching_mutate(text,jsonb)',
    'public.xelay_teaching_assert_user()',
    'public.xelay_teaching_can_read_item(uuid,uuid)',
    'public.xelay_teaching_can_read_file(text)',
    'public.xelay_teaching_is_backend_write()',
    'public.xelay_teaching_file_course(text)',
    'public.xelay_publish_due_teaching_items()',
    'public.xelay_my_teaching_materials()',
    'public.xelay_group_teacher_materials(uuid)'
  ] loop
    if to_regprocedure(v_signature) is null then raise exception 'TEACHING_MATERIAL_ACCESS_PREREQUISITE: %',v_signature; end if;
  end loop;
  if exists(select 1 from pg_attribute where attrelid='public.teaching_items'::regclass
      and attname='allow_download' and not attisdropped)
    or to_regprocedure('public.xelay_teaching_material_file_access(uuid,text)') is not null
    or not exists(select 1 from pg_trigger where tgrelid='public.teaching_items'::regclass
      and tgname='teacher_material_author_guard' and not tgisinternal)
    or not exists(select 1 from storage.buckets where id='xelay-teaching-files' and not public) then
    raise exception 'TEACHING_MATERIAL_ACCESS_SCHEMA_DRIFT';
  end if;
end $$;

alter table public.teaching_items add column allow_download boolean not null default true,
  add constraint teaching_items_material_download_scope check(kind='material' or allow_download);

-- Keep actual old acceptance receipts valid without rewriting history. New
-- publication acceptance uses the updated explanation of original-file access.
do $$
declare v_definition text;v_old text:='rights_terms_version = ''2026-10-21.1''::text';v_count integer;
begin
  select pg_get_constraintdef(oid) into v_definition from pg_constraint
    where conrelid='public.teaching_items'::regclass and conname='teaching_material_rights_acceptance_complete' and contype='c';
  if v_definition is null then raise exception 'TEACHING_MATERIAL_RIGHTS_CONSTRAINT_MISSING'; end if;
  v_count:=(length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old);
  if v_count<>1 then raise exception 'TEACHING_MATERIAL_RIGHTS_CONSTRAINT_DRIFT'; end if;
  v_definition:=replace(v_definition,v_old,
    'rights_terms_version = ANY(ARRAY[''2026-10-21.1''::text,''2026-10-23.1''::text])');
  alter table public.teaching_items drop constraint teaching_material_rights_acceptance_complete;
  execute format('alter table public.teaching_items add constraint teaching_material_rights_acceptance_complete %s',v_definition);
end $$;

-- This guard validates every write of protected resource metadata, including
-- trusted scheduled publications and future endpoints. Ordinary author, rights,
-- archive, version and resource-ownership checks remain in the installed code.
create function public.xelay_guard_teaching_material_access()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_file jsonb;v_path text;v_owner text;
begin
  if new.kind<>'material' or new.allow_download then return new; end if;
  if new.status in('published','scheduled') and new.rights_terms_version is distinct from '2026-10-23.1' then
    raise exception 'TEACHING_MATERIAL_RIGHTS_REQUIRED' using errcode='42501';
  end if;
  if jsonb_typeof(new.links) is distinct from 'array'
    or jsonb_typeof(new.attachments) is distinct from 'array' then
    raise exception 'TEACHING_INVALID_INPUT' using errcode='22023';
  end if;
  if jsonb_array_length(new.links)>0 then
    raise exception 'TEACHING_MATERIAL_PREVIEW_LINKS_UNSUPPORTED' using errcode='22023';
  end if;
  for v_file in select value from jsonb_array_elements(new.attachments) order by value->>'storage_path' loop
    if coalesce(v_file->>'mime_type','') not in (
      'application/pdf','image/jpeg','image/png','image/webp','text/plain','text/csv'
    ) and not(coalesce(v_file->>'mime_type','')='application/vnd.ms-excel' and lower(coalesce(v_file->>'storage_path',''))~'[.]csv$') then
      raise exception 'TEACHING_MATERIAL_PREVIEW_FORMAT_REQUIRED' using errcode='22023';
    end if;
    -- Restrict only the author's own original bytes. A retained legacy file
    -- from another publisher must be re-uploaded by this author before it can
    -- become restricted; otherwise its unrelated legitimate uses would break.
    v_path:=v_file->>'storage_path';
    if public.xelay_teaching_file_course(v_path) is distinct from new.course_id
      or split_part(v_path,'/',2) is distinct from new.created_by::text then
      raise exception 'TEACHING_MATERIAL_PREVIEW_OWN_FILES_REQUIRED' using errcode='42501';
    end if;
    select coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner') into v_owner
      from storage.objects o where o.bucket_id='xelay-teaching-files' and o.name=v_path for key share;
    if not found or v_owner is distinct from new.created_by::text then
      raise exception 'TEACHING_MATERIAL_PREVIEW_OWN_FILES_REQUIRED' using errcode='42501';
    end if;
  end loop;
  return new;
end $$;
revoke all on function public.xelay_guard_teaching_material_access() from public,anon,authenticated,service_role;
create trigger teaching_material_access_guard before insert or update of kind,allow_download,links,attachments,status,rights_terms_version,created_by,course_id
  on public.teaching_items for each row execute function public.xelay_guard_teaching_material_access();

-- Preserve installed function owners, ACLs, scheduling, rights, assessment,
-- receipts and version checks. Clipboard CRLFs are normalized on both sides.
create function pg_temp.xelay_material_access_patch(p_signature text,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text;v_old text;v_new text;v_count integer;
begin
  if to_regprocedure(p_signature) is null then raise exception 'Missing teaching material function: %',p_signature; end if;
  v_definition:=replace(pg_get_functiondef(to_regprocedure(p_signature)),chr(13),'');
  v_old:=replace(p_old,chr(13),'');v_new:=replace(p_new,chr(13),'');
  if v_old='' then raise exception 'Empty teaching material access anchor'; end if;
  v_count:=(length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old);
  if v_count<>1 then raise exception 'Teaching material access anchor mismatch for % (matches: %)',p_signature,v_count; end if;
  execute replace(v_definition,v_old,v_new);
end $$;

select pg_temp.xelay_material_access_patch('public.xelay_teaching_mutate(text,jsonb)',
$old$or p_payload->>'rights_terms_version' is distinct from '2026-10-21.1')$old$,
$new$or p_payload->>'rights_terms_version' is distinct from '2026-10-23.1')$new$);
select pg_temp.xelay_material_access_patch('public.xelay_teaching_mutate(text,jsonb)',
$old$case when v_kind='material' and v_status in('published','scheduled') then '2026-10-21.1' end,$old$,
$new$case when v_kind='material' and v_status in('published','scheduled') then '2026-10-23.1' end,$new$);
select pg_temp.xelay_material_access_patch('public.xelay_teaching_mutate(text,jsonb)',
$old$rights_terms_version=case when v_kind='material' and v_status in('published','scheduled') then '2026-10-21.1' else rights_terms_version end,$old$,
$new$rights_terms_version=case when v_kind='material' and v_status in('published','scheduled') then '2026-10-23.1' else rights_terms_version end,$new$);
select pg_temp.xelay_material_access_patch('public.xelay_guard_teacher_material_author()',
$old$new.rights_terms_version is distinct from '2026-10-21.1'$old$,
$new$new.rights_terms_version is distinct from '2026-10-23.1'$new$);
select pg_temp.xelay_material_access_patch('public.xelay_publish_due_teaching_items()',
$old$or v_item.rights_terms_version is distinct from '2026-10-21.1')$old$,
$new$or v_item.rights_terms_version is null
        or v_item.rights_terms_version not in('2026-10-21.1','2026-10-23.1')
        or(not v_item.allow_download and v_item.rights_terms_version<>'2026-10-23.1'))$new$);

select pg_temp.xelay_material_access_patch('public.xelay_teaching_mutate(text,jsonb)',
$old$v_kind:=case p_action when 'save_assignment' then 'assignment' else 'material' end;$old$,
$new$v_kind:=case p_action when 'save_assignment' then 'assignment' else 'material' end;
    if p_payload ? 'allow_download' and(jsonb_typeof(p_payload->'allow_download') is distinct from 'boolean'
      or(v_kind<>'material' and p_payload->'allow_download'='false'::jsonb)) then
      raise exception 'TEACHING_INVALID_INPUT' using errcode='22023';
    end if;$new$);
select pg_temp.xelay_material_access_patch('public.xelay_teaching_mutate(text,jsonb)',
$old$rights_accepted_by,rights_accepted_at,rights_terms_version,publish_at,scheduled_by,submission_format)$old$,
$new$rights_accepted_by,rights_accepted_at,rights_terms_version,publish_at,scheduled_by,submission_format,allow_download)$new$);
select pg_temp.xelay_material_access_patch('public.xelay_teaching_mutate(text,jsonb)',
$old$case when v_status='scheduled' then v_uid end,coalesce(p_payload->>'submission_format','written')) returning * into v_record;$old$,
$new$case when v_status='scheduled' then v_uid end,coalesce(p_payload->>'submission_format','written'),
        case when v_kind='material' then coalesce((p_payload->>'allow_download')::boolean,true) else true end) returning * into v_record;$new$);
select pg_temp.xelay_material_access_patch('public.xelay_teaching_mutate(text,jsonb)',
$old$submission_format=coalesce(p_payload->>'submission_format',submission_format),$old$,
$new$submission_format=coalesce(p_payload->>'submission_format',submission_format),
        allow_download=case when v_kind='material' then case when p_payload ? 'allow_download'
          then(p_payload->>'allow_download')::boolean else allow_download end else true end,$new$);

-- A reference through a different allowed item must never reopen original
-- bytes protected by any restricted material, including a withdrawn record.
-- Its author remains subject to all prior read/withdrawal/course checks.
select pg_temp.xelay_material_access_patch('public.xelay_teaching_can_read_file(text)',
$old$and public.xelay_teaching_file_course(p_name) is not null and ($old$,
$new$and public.xelay_teaching_file_course(p_name) is not null
    and not exists(select 1 from public.teaching_items protected
      where protected.kind='material' and not protected.allow_download
        and protected.created_by is distinct from auth.uid()
        and protected.attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_name))) and ($new$);

select pg_temp.xelay_material_access_patch('public.xelay_group_teacher_materials(uuid)',
$old$'course_archived_at',r.course_archived_at,'read_only',true,'can_withdraw',(r.i).created_by=v_uid$old$,
$new$'course_archived_at',r.course_archived_at,'read_only',true,'can_withdraw',(r.i).created_by=v_uid,
      'can_edit',(r.i).created_by=v_uid and (r.i).withdrawn_at is null and r.course_archived_at is null
        and 'materials'=any(public.xelay_teaching_permissions((r.i).course_id,v_uid))$new$);

-- The application server invokes this RPC using the viewer's JWT on every
-- request, then fetches private bytes through the backend. Never return a URL,
-- bucket credential or caller-selected content metadata from this RPC.
create function public.xelay_teaching_material_file_access(p_item_id uuid,p_storage_path text)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare
  v_uid uuid:=public.xelay_teaching_assert_user();
  v_item public.teaching_items%rowtype;
  v_object storage.objects%rowtype;
  v_file jsonb;v_size numeric;v_download boolean;v_owner text;
begin
  if p_item_id is null or p_storage_path is null or length(p_storage_path) not between 1 and 600 then
    raise exception 'TEACHING_INVALID_INPUT' using errcode='22023';
  end if;
  select * into v_item from public.teaching_items where id=p_item_id and kind='material' and withdrawn_at is null;
  if not found or not public.xelay_teaching_can_read_item(p_item_id,v_uid) then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501';
  end if;
  select value into v_file from jsonb_array_elements(v_item.attachments)
    where value->>'storage_path'=p_storage_path;
  -- Exact retained descriptors from older trusted copies may retain an older
  -- course directory. Their current item audience remains authoritative; the
  -- restricted-write guard above requires new owned bytes before restricting.
  if not found or public.xelay_teaching_file_course(p_storage_path) is null
    or jsonb_typeof(v_file->'size') is distinct from 'number' then
    raise exception 'TEACHING_FILE_FORBIDDEN' using errcode='42501';
  end if;
  v_size:=(v_file->>'size')::numeric;
  if v_size not between 1 and 52428800 or trunc(v_size)<>v_size then
    raise exception 'TEACHING_FILE_FORBIDDEN' using errcode='42501';
  end if;
  select * into v_object from storage.objects where bucket_id='xelay-teaching-files' and name=p_storage_path;
  if not found or coalesce(v_object.metadata->>'size','') !~ '^[0-9]{1,10}([.]0+)?$' then
    raise exception 'TEACHING_FILE_FORBIDDEN' using errcode='42501';
  end if;
  v_owner:=coalesce(nullif(to_jsonb(v_object)->>'owner_id',''),to_jsonb(v_object)->>'owner');
  if v_owner is distinct from split_part(p_storage_path,'/',2)
    or(v_object.metadata->>'size')::numeric<>v_size
    or lower(split_part(coalesce(v_object.metadata->>'mimetype',''),';',1)) is distinct from v_file->>'mime_type' then
    raise exception 'TEACHING_FILE_FORBIDDEN' using errcode='42501';
  end if;
  v_download:=(v_item.allow_download or v_item.created_by=v_uid)
    and not exists(select 1 from public.teaching_items protected
      where protected.kind='material' and not protected.allow_download and protected.created_by is distinct from v_uid
        and protected.attachments @> jsonb_build_array(jsonb_build_object('storage_path',p_storage_path)));
  return jsonb_build_object('id',v_item.id,'item_id',v_item.id,'storage_path',p_storage_path,
    'name',v_file->>'name','mime_type',v_file->>'mime_type','size',v_size,
    'allow_download',v_item.allow_download,'download_allowed',v_download,'version',v_item.version,
    'author_name',(select coalesce(nullif(full_name,''),nullif(username,''),'Викладач') from public.profiles where id=v_item.created_by),
    'viewer_name',(select coalesce(nullif(full_name,''),nullif(username,''),'Користувач Xelay') from public.profiles where id=v_uid));
end $$;
revoke all on function public.xelay_teaching_material_file_access(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_material_file_access(uuid,text) to authenticated;

drop function pg_temp.xelay_material_access_patch(text,text,text);
comment on column public.teaching_items.allow_download is
  'Author-selected access to original material files. Existing rows default true. False supports in-platform preview formats only, without external resources; ordinary assignments stay true. This is access control, not a guarantee against screenshots or copying displayed content.';
comment on function public.xelay_teaching_material_file_access(uuid,text) is
  'Authenticated canonical material-file authorization. Application server must use the viewer JWT on each request and enforce download_allowed before original-file download. Returns metadata only, never signed URLs.';
notify pgrst,'reload schema';
commit;
