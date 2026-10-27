-- Canonical material audiences, expiry and scheduled publication.
-- Depends on 202610270003. Existing Storage/media authorization remains the
-- authority for private bytes; only its shared item-read predicate is changed.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $$
declare v_definition text;
begin
  if to_regprocedure('public.xelay_teaching_material_permissions(uuid,uuid)') is null
    or to_regclass('public.teaching_material_grants') is null
    or not exists(select 1 from pg_attribute where attrelid='public.teaching_items'::regclass
      and attname='access_until' and not attisdropped)
    or to_regprocedure('public.xelay_teaching_group_permissions(uuid,uuid,uuid)') is null then
    raise exception 'TEACHING_MATERIAL_LIBRARY_ACCESS_PREREQUISITES';
  end if;
  -- Do not accidentally deploy this contract over an unrelated read helper.
  v_definition:=replace(pg_get_functiondef('public.xelay_teaching_can_read_item(uuid,uuid)'::regprocedure),chr(13),'');
  if position('public.xelay_teaching_group_permissions(i.course_id,t.group_id,p_user_id)' in v_definition)=0
    or position('i.withdrawn_at is null' in v_definition)=0 then
    raise exception 'TEACHING_MATERIAL_LIBRARY_ITEM_READ_DRIFT';
  end if;
  -- Both existing private-byte paths must continue to authorize against the
  -- current canonical item, rather than trusting an old client descriptor.
  v_definition:=replace(pg_get_functiondef('public.xelay_teaching_can_read_file(text)'::regprocedure),chr(13),'');
  if position('public.xelay_teaching_can_read_item(i.id,auth.uid())' in v_definition)=0
    or position('protected.kind=''material'' and not protected.allow_download' in v_definition)=0
    or position('protected.created_by is distinct from auth.uid()' in v_definition)=0 then
    raise exception 'TEACHING_MATERIAL_LIBRARY_STORAGE_READ_DRIFT';
  end if;
  v_definition:=replace(pg_get_functiondef('public.xelay_teaching_material_file_access(uuid,text)'::regprocedure),chr(13),'');
  if position('public.xelay_teaching_can_read_item(p_item_id,v_uid)' in v_definition)=0
    or position('jsonb_array_elements(v_item.attachments)' in v_definition)=0
    or position('protected.kind=''material'' and not protected.allow_download' in v_definition)=0
    or position('split_part(p_storage_path,''/'',2)' in v_definition)=0
    or position('v_object.metadata->>''size''' in v_definition)=0
    or position('v_object.metadata->>''mimetype''' in v_definition)=0 then
    raise exception 'TEACHING_MATERIAL_LIBRARY_MEDIA_READ_DRIFT';
  end if;
end $$;

create or replace function public.xelay_teaching_can_read_item(p_item_id uuid,p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.teaching_items i
    where i.id=p_item_id and i.withdrawn_at is null and case when i.kind='material' then
      -- Author/delegated library controls can preview their canonical record,
      -- including an expired record, without reopening its student audience.
      coalesce((public.xelay_teaching_material_permissions(i.id,p_user_id)->>'visible')::boolean,false)
      or(i.status='published' and(i.access_until is null or i.access_until>clock_timestamp())
        and exists(select 1 from public.teaching_item_targets t
          join public.teaching_course_groups g on g.course_id=i.course_id and g.group_id=t.group_id and g.status='accepted'
          where t.item_id=i.id and('materials'=any(public.xelay_teaching_group_permissions(i.course_id,t.group_id,p_user_id))
            or public.xelay_teaching_is_member(t.group_id,p_user_id))))
    else
      -- Preserve the pre-library scoped assignment/grading read contract.
      ((i.created_by=p_user_id or exists(select 1 from public.teaching_courses c where c.id=i.course_id and c.owner_id=p_user_id))
        and not exists(select 1 from public.teaching_item_targets where item_id=i.id)
        and 'assignments'=any(public.xelay_teaching_permissions(i.course_id,p_user_id)))
      or exists(select 1 from public.teaching_item_targets t where t.item_id=i.id and(
        'assignments'=any(public.xelay_teaching_group_permissions(i.course_id,t.group_id,p_user_id))
        or(i.status='published' and 'grades'=any(public.xelay_teaching_group_permissions(i.course_id,t.group_id,p_user_id)))
        or(i.status='published' and public.xelay_teaching_is_member(t.group_id,p_user_id)
          and exists(select 1 from public.teaching_course_groups g where g.course_id=i.course_id and g.group_id=t.group_id and g.status='accepted'))))
    end);
$$;
revoke all on function public.xelay_teaching_can_read_item(uuid,uuid) from public,anon,authenticated,service_role;

create function pg_temp.xelay_library_access_patch(p_signature text,p_old text,p_new text)
returns void language plpgsql as $$
declare v_definition text;v_old text;v_new text;v_count integer;
begin
  if to_regprocedure(p_signature) is null then raise exception 'TEACHING_MATERIAL_LIBRARY_PATCH_MISSING: %',p_signature; end if;
  v_definition:=replace(pg_get_functiondef(to_regprocedure(p_signature)),chr(13),'');
  v_old:=replace(p_old,chr(13),'');v_new:=replace(p_new,chr(13),'');
  if v_old='' then raise exception 'TEACHING_MATERIAL_LIBRARY_EMPTY_ANCHOR'; end if;
  v_count:=(length(v_definition)-length(replace(v_definition,v_old,'')))/length(v_old);
  if v_count<>1 then raise exception 'TEACHING_MATERIAL_LIBRARY_ACCESS_DRIFT: % (% matches)',p_signature,v_count; end if;
  execute replace(v_definition,v_old,v_new);
end $$;

-- Apply expiry to both Materials-tab projection and older group/homework API.
-- Keep subject matching, authorship, independent student grades and all other
-- established fields/permissions intact.
select pg_temp.xelay_library_access_patch('public.xelay_group_teacher_materials(uuid)',
$old$where i.kind='material' and i.status='published' and i.withdrawn_at is null$old$,
$new$where i.kind='material' and i.status='published' and i.withdrawn_at is null
      and(i.access_until is null or i.access_until>clock_timestamp())
      and public.xelay_teaching_can_read_item(i.id,v_uid)$new$);
select pg_temp.xelay_library_access_patch('public.xelay_teaching_group(uuid)',
$old$where i.kind='material' and i.status='published' and i.withdrawn_at is null$old$,
$new$where i.kind='material' and i.status='published' and i.withdrawn_at is null
      and(i.access_until is null or i.access_until>clock_timestamp())
      and public.xelay_teaching_can_read_item(i.id,v_uid)$new$);

-- Expired scheduled materials are not selected repeatedly by the worker. A
-- teacher can later choose a new publication/access time from their library.
select pg_temp.xelay_library_access_patch('public.xelay_publish_due_teaching_items()',
$old$where i.status='scheduled' and i.publish_at<=clock_timestamp() and i.withdrawn_at is null$old$,
$new$where i.status='scheduled' and i.publish_at<=clock_timestamp() and i.withdrawn_at is null
      and(i.kind<>'material' or i.access_until is null or i.access_until>clock_timestamp())$new$);
select pg_temp.xelay_library_access_patch('public.xelay_publish_due_teaching_items()',
$old$if v_course.archived_at is not null or v_actor is null then raise exception 'TEACHING_SCHEDULE_AUTHOR_ACCESS_CHANGED'; end if;$old$,
$new$if v_course.archived_at is not null or v_actor is null then raise exception 'TEACHING_SCHEDULE_AUTHOR_ACCESS_CHANGED'; end if;
      if v_item.kind='material' and v_item.access_until is not null and v_item.access_until<=clock_timestamp() then
        raise exception 'TEACHING_MATERIAL_ACCESS_EXPIRED'; end if;$new$);

-- Original author acceptance is never impersonated or rewritten by a
-- delegate. The save guard records the delegate's separate change receipt;
-- publication checks the original receipt and the delegate's current edit
-- permission. Group-only changes can increment version without new metadata,
-- so an exact-version change receipt is intentionally not required here.
select pg_temp.xelay_library_access_patch('public.xelay_publish_due_teaching_items()',
$old$if v_item.kind='material' and(v_item.rights_accepted_by is distinct from v_item.created_by
        or v_actor is distinct from v_item.created_by or v_item.rights_accepted_at is null
        or v_item.rights_terms_version is null
        or v_item.rights_terms_version not in('2026-10-21.1','2026-10-23.1')
        or(not v_item.allow_download and v_item.rights_terms_version<>'2026-10-23.1')) then raise exception 'TEACHING_MATERIAL_RIGHTS_REQUIRED'; end if;$old$,
$new$if v_item.kind='material' and(v_item.rights_accepted_by is distinct from v_item.created_by
        or v_item.rights_accepted_at is null or v_item.rights_terms_version is null
        or v_item.rights_terms_version not in('2026-10-21.1','2026-10-23.1','2026-10-27.1')
        or(not v_item.allow_download and v_item.rights_terms_version not in('2026-10-23.1','2026-10-27.1'))
        or(v_actor is distinct from v_item.created_by and not coalesce((public.xelay_teaching_material_permissions(v_item.id,v_actor)->>'can_edit')::boolean,false))) then
        raise exception 'TEACHING_MATERIAL_RIGHTS_REQUIRED'; end if;$new$);

-- Avoid sending a new-material notification after its access window closes
-- during a long batch; assignment recipients/behavior remain unchanged.
select pg_temp.xelay_library_access_patch('public.xelay_publish_due_teaching_items()',
$old$where t.item_id=v_item.id order by p.id loop$old$,
$new$where t.item_id=v_item.id
          and(v_item.kind<>'material' or v_item.access_until is null or v_item.access_until>clock_timestamp())
        order by p.id loop$new$);

drop function pg_temp.xelay_library_access_patch(text,text,text);
comment on column public.teaching_items.access_until is
  'Author/editor-selected material audience end time. Student/group APIs and fresh private-file authorization close at this time; author/delegated library management can retain the record.';
notify pgrst,'reload schema';
commit;
