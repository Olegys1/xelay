-- One canonical teacher material, explicitly delegated controls, private receipts.
-- Original author identity and author acceptance are retained when a colleague edits.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $$ begin
  if to_regprocedure('public.xelay_teaching_group_permissions(uuid,uuid,uuid)') is null
    or to_regprocedure('public.xelay_teaching_normalize_link_labels(jsonb,jsonb,boolean)') is null
    or to_regprocedure('public.xelay_private_withdraw_teaching_material(uuid,integer)') is null
    or to_regprocedure('public.xelay_guard_teaching_material_access()') is null
    or to_regprocedure('public.xelay_teaching_material_library()') is not null
    or exists(select 1 from pg_attribute where attrelid='public.teaching_items'::regclass and attname='access_until' and not attisdropped)
    or not exists(select 1 from pg_constraint where conrelid='public.teaching_items'::regclass and conname='teaching_material_rights_acceptance_complete') then
    raise exception 'TEACHING_MATERIAL_LIBRARY_PREREQUISITES';
  end if;
end $$;

alter table public.teaching_items add column access_until timestamptz,
  add constraint teaching_material_access_until_valid check(access_until is null or(kind='material' and isfinite(access_until)));
create table public.teaching_material_grants(
  item_id uuid not null references public.teaching_items(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  can_edit boolean not null default false,
  can_delete boolean not null default false,
  can_manage_groups boolean not null default false,
  granted_by uuid not null references public.profiles(id) on delete restrict,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key(item_id,user_id),
  check(can_edit or can_delete or can_manage_groups)
);
create index teaching_material_grants_user_idx on public.teaching_material_grants(user_id,item_id);
create table public.teaching_material_change_receipts(
  item_id uuid not null references public.teaching_items(id) on delete cascade,
  version integer not null check(version>0),
  actor_id uuid not null references public.profiles(id) on delete restrict,
  terms_version text not null check(terms_version='2026-10-27.1'),
  accepted_at timestamptz not null default clock_timestamp(),
  primary key(item_id,version)
);
alter table public.teaching_material_grants enable row level security;
alter table public.teaching_material_change_receipts enable row level security;
revoke all on public.teaching_material_grants,public.teaching_material_change_receipts from public,anon,authenticated,service_role;

-- Accept the new author agreement without rewriting any historical receipt.
alter table public.teaching_items drop constraint teaching_material_rights_acceptance_complete;
alter table public.teaching_items add constraint teaching_material_rights_acceptance_complete check(
  (rights_accepted_by is null and rights_accepted_at is null and rights_terms_version is null)
  or(kind='material' and rights_accepted_by is not null and rights_accepted_by=created_by
    and rights_accepted_at is not null and isfinite(rights_accepted_at)
    and rights_terms_version in('2026-10-21.1','2026-10-23.1','2026-10-27.1')));

create function public.xelay_teaching_material_permissions(p_item_id uuid,p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_item public.teaching_items%rowtype;v_course public.teaching_courses%rowtype;
  v_grant public.teaching_material_grants%rowtype;v_groups uuid[];v_own boolean;v_active boolean;v_delegate boolean;v_hidden integer;
begin
  select * into v_item from public.teaching_items where id=p_item_id and kind='material';
  if not found or p_user_id is null then return jsonb_build_object('is_owner',false,'visible',false,'can_edit',false,'can_delete',false,'can_manage_groups',false,'can_manage_collaborators',false,'group_ids','[]'::jsonb,'hidden_target_count',0); end if;
  select * into v_course from public.teaching_courses where id=v_item.course_id;
  v_own:=v_item.created_by=p_user_id;
  select coalesce(array_agg(g.group_id order by g.group_id),'{}'::uuid[]) into v_groups
    from public.teaching_course_groups g where g.course_id=v_item.course_id and g.status='accepted'
      and 'materials'=any(public.xelay_teaching_group_permissions(g.course_id,g.group_id,p_user_id));
  select * into v_grant from public.teaching_material_grants where item_id=v_item.id and user_id=p_user_id;
  v_active:=v_course.archived_at is null and 'materials'=any(public.xelay_teaching_permissions(v_item.course_id,p_user_id)) and v_item.withdrawn_at is null;
  select count(*) into v_hidden from public.teaching_item_targets where item_id=v_item.id and not(group_id=any(v_groups));
  v_delegate:=not v_own and v_active and cardinality(v_groups)>0
    and coalesce(v_grant.can_edit or v_grant.can_delete or v_grant.can_manage_groups,false)
    and(v_grant.can_manage_groups or not exists(select 1 from public.teaching_item_targets where item_id=v_item.id)
      or exists(select 1 from public.teaching_item_targets where item_id=v_item.id and group_id=any(v_groups)));
  return jsonb_build_object('is_owner',v_own,'visible',v_own or v_delegate,
    'can_edit',v_active and(v_own or(v_delegate and v_grant.can_edit and v_hidden=0)),
    'can_delete',v_item.withdrawn_at is null and(v_own or(v_active and v_delegate and v_grant.can_delete and v_hidden=0)),
    'can_manage_groups',v_active and(v_own or(v_delegate and v_grant.can_manage_groups)),
    'can_manage_collaborators',v_active and v_own,'group_ids',to_jsonb(v_groups),
    'hidden_target_count',case when v_own then 0 else v_hidden end);
end $$;
revoke all on function public.xelay_teaching_material_permissions(uuid,uuid) from public,anon,authenticated,service_role;

create function public.xelay_private_library_material_json(p_item public.teaching_items,p_user_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_access jsonb:=public.xelay_teaching_material_permissions(p_item.id,p_user_id);v_own boolean;v_groups uuid[];v_targets jsonb;
begin
  if not coalesce((v_access->>'visible')::boolean,false) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  v_own:=(v_access->>'is_owner')::boolean;
  select coalesce(array_agg(value::uuid),'{}') into v_groups from jsonb_array_elements_text(v_access->'group_ids');
  select coalesce(jsonb_agg(jsonb_build_object('group_id',t.group_id) order by t.group_id),'[]') into v_targets
    from public.teaching_item_targets t where t.item_id=p_item.id and(v_own or t.group_id=any(v_groups));
  return (to_jsonb(p_item)-case when v_own then '{}'::text[] else array['rights_accepted_by','rights_accepted_at','rights_terms_version']::text[] end)
    ||jsonb_build_object('author_name',(select full_name from public.profiles where id=p_item.created_by),
      'course_title',(select title from public.teaching_courses where id=p_item.course_id),
      'course_archived_at',(select archived_at from public.teaching_courses where id=p_item.course_id),
      'targets',v_targets,'is_owner',v_own,'can_edit',v_access->'can_edit','can_delete',v_access->'can_delete',
      'can_withdraw',v_access->'can_delete','can_manage_groups',v_access->'can_manage_groups',
      'can_manage_collaborators',v_access->'can_manage_collaborators','hidden_target_count',v_access->'hidden_target_count',
      'collaborators',coalesce((select jsonb_agg(jsonb_build_object('user_id',a.user_id,'full_name',p.full_name,
        'can_edit',a.can_edit,'can_delete',a.can_delete,'can_manage_groups',a.can_manage_groups) order by p.full_name,a.user_id)
        from public.teaching_material_grants a join public.profiles p on p.id=a.user_id
        where a.item_id=p_item.id and(v_own or a.user_id=p_user_id)),'[]'::jsonb),
      'target_group_names',coalesce((select jsonb_agg(jsonb_build_object('group_id',t.group_id,'group_name',g.group_name) order by g.group_name,g.id)
        from public.teaching_item_targets t join public.study_groups g on g.id=t.group_id
        where t.item_id=p_item.id and(v_own or t.group_id=any(v_groups))),'[]'::jsonb));
end $$;
revoke all on function public.xelay_private_library_material_json(public.teaching_items,uuid) from public,anon,authenticated,service_role;

create function public.xelay_teaching_material_library()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();
begin
  return jsonb_build_object('materials',coalesce((select jsonb_agg(public.xelay_private_library_material_json(i,v_uid) order by i.updated_at desc,i.id)
    from public.teaching_items i where i.kind='material' and coalesce((public.xelay_teaching_material_permissions(i.id,v_uid)->>'visible')::boolean,false)),'[]'::jsonb),
    'courses',coalesce((select jsonb_agg(jsonb_build_object(
      'course',to_jsonb(c)||jsonb_build_object('permissions',public.xelay_teaching_permissions(c.id,v_uid)),
      'groups',coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object('group_name',g.group_name,'specialty',g.specialty,
        'representative_id',g.representative_id,'representative_name',p.full_name,'study_level',g.study_level,'cohort_start_year',g.cohort_start_year,
        'study_year',case when public.xelay_current_academic_year()::integer-g.cohort_start_year+1 between 1 and 6 then public.xelay_current_academic_year()::integer-g.cohort_start_year+1 else null end,
        'permissions',public.xelay_teaching_group_permissions(c.id,l.group_id,v_uid)) order by g.group_name,g.id)
        from public.teaching_course_groups l join public.study_groups g on g.id=l.group_id left join public.profiles p on p.id=g.representative_id
        where l.course_id=c.id and l.status='accepted' and 'materials'=any(public.xelay_teaching_group_permissions(c.id,l.group_id,v_uid))),'[]'::jsonb),
      'colleagues',coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'course_id',c.id,'user_id',t.user_id,'full_name',p.full_name,
        'permissions',t.permissions,'status',t.status,'group_scope','selected','group_ids','[]'::jsonb) order by p.full_name,t.user_id)
        from public.teaching_course_teachers t join public.profiles p on p.id=t.user_id
        where t.course_id=c.id and t.status='accepted' and 'materials'=any(public.xelay_teaching_permissions(c.id,t.user_id))) ,'[]'::jsonb)
        ||jsonb_build_array(jsonb_build_object('id',c.owner_id,'course_id',c.id,'user_id',c.owner_id,
          'full_name',(select full_name from public.profiles where id=c.owner_id),'permissions',array['materials','assignments','grades','manage']::text[],
          'status','accepted','group_scope','all','group_ids','[]'::jsonb))) order by c.title,c.id)
      from public.teaching_courses c where 'materials'=any(public.xelay_teaching_permissions(c.id,v_uid))),'[]'::jsonb));
end $$;
revoke all on function public.xelay_teaching_material_library() from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_material_library() to authenticated;

-- No client-set flag authorizes delegation. The guard checks an actual private
-- server receipt at the next immutable version and fresh per-material controls.
create or replace function public.xelay_guard_teacher_material_author()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_access jsonb;v_file jsonb;v_path text;v_owner text;v_own boolean;v_narrow boolean;
begin
  if public.xelay_teaching_is_backend_write() then if tg_op='DELETE' then return old; end if;return new;end if;
  if tg_op='INSERT' then
    if new.kind<>'material' then return new;end if;
    if v_uid is null or new.created_by is distinct from v_uid or new.withdrawn_at is not null then
      raise exception 'TEACHING_MATERIAL_AUTHOR_REQUIRED' using errcode='42501';end if;
    v_own:=true;
  else
    if old.kind<>'material' and(tg_op='DELETE' or new.kind<>'material') then if tg_op='DELETE' then return old;end if;return new;end if;
    if v_uid is null or old.kind<>'material' then raise exception 'TEACHING_MATERIAL_AUTHOR_REQUIRED' using errcode='42501';end if;
    if tg_op='DELETE' then raise exception 'TEACHING_MATERIAL_WITHDRAW_REQUIRED' using errcode='42501';end if;
    if new.id is distinct from old.id or new.course_id is distinct from old.course_id or new.kind is distinct from old.kind
      or new.created_by is distinct from old.created_by or new.created_at is distinct from old.created_at then
      raise exception 'TEACHING_MATERIAL_IDENTITY_IMMUTABLE' using errcode='23514';end if;
    if old.withdrawn_at is not null then raise exception 'TEACHING_MATERIAL_WITHDRAWN';end if;
    if new.version<>old.version+1 then raise exception 'TEACHING_CONFLICT';end if;
    v_access:=public.xelay_teaching_material_permissions(old.id,v_uid);v_own:=old.created_by=v_uid;
    if new.withdrawn_at is not null then
      if not coalesce((v_access->>'can_delete')::boolean,false)
        or(to_jsonb(new)-array['withdrawn_at','version','updated_at']) is distinct from(to_jsonb(old)-array['withdrawn_at','version','updated_at']) then
        raise exception 'TEACHING_MATERIAL_AUTHOR_REQUIRED' using errcode='42501';end if;
      return new;
    end if;
    if(to_jsonb(new)-array['version','updated_at']) is not distinct from(to_jsonb(old)-array['version','updated_at']) then
      if not v_own and not coalesce((v_access->>'visible')::boolean,false) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
      return new;
    end if;
    v_narrow:=coalesce((v_access->>'can_manage_groups')::boolean,false) and new.status='draft' and new.publish_at is null and new.scheduled_by is null
      and(to_jsonb(new)-array['version','updated_at','status','publish_at','scheduled_by']) is not distinct from(to_jsonb(old)-array['version','updated_at','status','publish_at','scheduled_by']);
    if v_narrow then return new;end if;
    if not coalesce((v_access->>'can_edit')::boolean,false) then raise exception 'TEACHING_MATERIAL_AUTHOR_REQUIRED' using errcode='42501';end if;
    if not v_own and new.status in('published','scheduled') and not exists(select 1 from public.teaching_material_change_receipts r where r.item_id=old.id and r.version=new.version
      and r.actor_id=v_uid and r.terms_version='2026-10-27.1') then raise exception 'TEACHING_MATERIAL_RIGHTS_REQUIRED' using errcode='42501';end if;
  end if;
  perform public.xelay_teaching_lock_course(new.course_id,'materials');
  if new.status in('published','scheduled') and(new.rights_accepted_by is distinct from new.created_by or new.rights_accepted_at is null
    or new.rights_terms_version is null or new.rights_terms_version not in('2026-10-21.1','2026-10-23.1','2026-10-27.1')) then
    raise exception 'TEACHING_MATERIAL_RIGHTS_REQUIRED' using errcode='42501';end if;
  for v_file in select value from jsonb_array_elements(new.attachments) order by value->>'storage_path' loop
    if tg_op='UPDATE' then if old.attachments @> jsonb_build_array(v_file) then continue;end if;end if;
    v_path:=v_file->>'storage_path';
    if public.xelay_teaching_file_course(v_path) is distinct from new.course_id or split_part(v_path,'/',2) is distinct from v_uid::text then
      raise exception 'TEACHING_FILE_FORBIDDEN' using errcode='42501';end if;
    perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-file:'||v_path,0));
    select coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner') into v_owner from storage.objects o where o.bucket_id='xelay-teaching-files' and o.name=v_path for key share;
    if not found or v_owner is distinct from v_uid::text then raise exception 'TEACHING_FILE_FORBIDDEN' using errcode='42501';end if;
  end loop;
  return new;
end $$;
revoke all on function public.xelay_guard_teacher_material_author() from public,anon,authenticated,service_role;

create or replace function public.xelay_private_withdraw_teaching_material(p_item_id uuid,p_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_course uuid;v_item public.teaching_items%rowtype;v_access jsonb;
begin
  if p_item_id is null or p_version is null or p_version<1 then raise exception 'TEACHING_INVALID_INPUT';end if;
  select course_id into v_course from public.teaching_items where id=p_item_id and kind='material';
  if not found then raise exception 'TEACHING_MATERIAL_AUTHOR_REQUIRED' using errcode='42501';end if;
  perform 1 from public.teaching_courses where id=v_course for update;
  select * into v_item from public.teaching_items where id=p_item_id and course_id=v_course and kind='material' for update;
  if not found then raise exception 'TEACHING_MATERIAL_AUTHOR_REQUIRED' using errcode='42501';end if;
  if v_item.withdrawn_at is not null then
    if v_item.created_by is distinct from v_uid or p_version not in(v_item.version,v_item.version-1) then raise exception 'TEACHING_CONFLICT';end if;
    return jsonb_build_object('id',v_item.id,'version',v_item.version,'status','withdrawn','withdrawn_at',v_item.withdrawn_at);
  end if;
  v_access:=public.xelay_teaching_material_permissions(v_item.id,v_uid);
  if not coalesce((v_access->>'can_delete')::boolean,false) then raise exception 'TEACHING_MATERIAL_AUTHOR_REQUIRED' using errcode='42501';end if;
  if p_version<>v_item.version then raise exception 'TEACHING_CONFLICT';end if;
  update public.teaching_items set withdrawn_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() where id=v_item.id returning * into v_item;
  return jsonb_build_object('id',v_item.id,'version',v_item.version,'status','withdrawn','withdrawn_at',v_item.withdrawn_at);
end $$;
revoke all on function public.xelay_private_withdraw_teaching_material(uuid,integer) from public,anon,authenticated,service_role;

create function public.xelay_private_material_library_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_id uuid;v_course uuid;v_item public.teaching_items%rowtype;v_existing boolean;
  v_access jsonb;v_metadata boolean;v_groups uuid[];v_incoming uuid[];v_allowed uuid[];v_group uuid;v_grant jsonb;v_person uuid;v_seen uuid[]:='{}';
  v_title text;v_body text;v_links jsonb;v_files jsonb;v_labels jsonb;v_status text;v_allow boolean;v_publish timestamptz;v_until timestamptz;v_material_date date;
  v_own boolean;v_receipt public.teaching_create_receipts%rowtype;v_result jsonb;v_new_version integer;v_prior jsonb;v_key text;
begin
  if p_action not in('save_library_material','set_material_collaborators') or jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>240000 then raise exception 'TEACHING_INVALID_INPUT';end if;
  if nullif(p_payload->>'expected_user_id','')::uuid is distinct from v_uid then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501';end if;
  if jsonb_typeof(p_payload->'id') is distinct from 'string' or jsonb_typeof(p_payload->'version') is distinct from 'number'
    or p_payload->>'version' !~ '^[0-9]{1,9}$' then raise exception 'TEACHING_INVALID_INPUT';end if;
  v_id:=(p_payload->>'id')::uuid;
  if v_id is null then raise exception 'TEACHING_INVALID_INPUT';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:material-library:'||v_id::text,0));
  select course_id into v_course from public.teaching_items where id=v_id;
  if v_course is null then v_course:=nullif(p_payload->>'course_id','')::uuid;end if;
  if v_course is null then raise exception 'TEACHING_INVALID_INPUT';end if;
  perform public.xelay_teaching_lock_course(v_course,'materials');
  select * into v_item from public.teaching_items where id=v_id for update;v_existing:=found;
  if v_existing and(v_item.kind<>'material' or v_item.course_id<>v_course) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  if p_payload?'course_id' and nullif(p_payload->>'course_id','')::uuid is distinct from v_course then raise exception 'TEACHING_INVALID_INPUT';end if;
  if v_existing then
    if v_item.withdrawn_at is not null then raise exception 'TEACHING_MATERIAL_WITHDRAWN';end if;
    v_access:=public.xelay_teaching_material_permissions(v_item.id,v_uid);
    if not coalesce((v_access->>'visible')::boolean,false) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
    if (p_payload->>'version')::integer=0 and p_action='save_library_material' then
      select * into v_receipt from public.teaching_create_receipts where user_id=v_uid and action=p_action and request_id=v_id;
      if found and v_receipt.payload=p_payload then
        for v_group in select group_id from public.teaching_item_targets where item_id=v_id loop perform public.xelay_private_assert_teaching_group(v_course,v_group,'materials');end loop;
        return v_receipt.result;
      end if;
    end if;
    if (p_payload->>'version')::integer<>v_item.version then raise exception 'TEACHING_CONFLICT';end if;
  elsif p_action<>'save_library_material' or(p_payload->>'version')::integer<>0 then raise exception 'TEACHING_CONFLICT';end if;
  v_own:=not v_existing or v_item.created_by=v_uid;
  if p_action='set_material_collaborators' then
    if not v_own or jsonb_typeof(p_payload->'grants') is distinct from 'array' or jsonb_array_length(p_payload->'grants')>100 then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
    if exists(select 1 from jsonb_object_keys(p_payload) k where k not in('id','version','expected_user_id','course_id','grants')) then raise exception 'TEACHING_INVALID_INPUT';end if;
    for v_grant in select value from jsonb_array_elements(p_payload->'grants') loop
      if jsonb_typeof(v_grant) is distinct from 'object' or jsonb_typeof(v_grant->'user_id') is distinct from 'string'
        or jsonb_typeof(v_grant->'can_edit') is distinct from 'boolean' or jsonb_typeof(v_grant->'can_delete') is distinct from 'boolean'
        or jsonb_typeof(v_grant->'can_manage_groups') is distinct from 'boolean' then raise exception 'TEACHING_INVALID_INPUT';end if;
      v_person:=(v_grant->>'user_id')::uuid;
      if v_person=v_item.created_by or v_person=any(v_seen) then raise exception 'TEACHING_INVALID_INPUT';end if;v_seen:=array_append(v_seen,v_person);
      if not exists(select 1 from public.teaching_course_groups l where l.course_id=v_course and l.status='accepted'
        and 'materials'=any(public.xelay_teaching_group_permissions(v_course,l.group_id,v_person))) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
    end loop;
    delete from public.teaching_material_grants where item_id=v_id and not(user_id=any(v_seen));
    for v_grant in select value from jsonb_array_elements(p_payload->'grants') loop
      v_person:=(v_grant->>'user_id')::uuid;
      if not((v_grant->>'can_edit')::boolean or(v_grant->>'can_delete')::boolean or(v_grant->>'can_manage_groups')::boolean) then
        delete from public.teaching_material_grants where item_id=v_id and user_id=v_person;
      else
        insert into public.teaching_material_grants(item_id,user_id,can_edit,can_delete,can_manage_groups,granted_by)
          values(v_id,v_person,(v_grant->>'can_edit')::boolean,(v_grant->>'can_delete')::boolean,(v_grant->>'can_manage_groups')::boolean,v_uid)
          on conflict(item_id,user_id) do update set can_edit=excluded.can_edit,can_delete=excluded.can_delete,can_manage_groups=excluded.can_manage_groups,granted_by=v_uid,updated_at=clock_timestamp();
      end if;
    end loop;
    update public.teaching_items set version=version+1,updated_at=clock_timestamp() where id=v_id returning version into v_new_version;
    return jsonb_build_object('id',v_id,'version',v_new_version);
  end if;
  if exists(select 1 from jsonb_object_keys(p_payload) k where k not in('id','version','expected_user_id','course_id','target_group_ids','title','body','links','link_labels','attachments','status','publish_at','access_until','allow_download','material_date','rights_accepted','rights_terms_version')) then raise exception 'TEACHING_INVALID_INPUT';end if;
  v_metadata:=exists(select 1 from jsonb_object_keys(p_payload) k where k not in('id','version','expected_user_id','course_id','target_group_ids'));
  if v_existing and v_metadata and not coalesce((v_access->>'can_edit')::boolean,false) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  if v_existing and p_payload?'target_group_ids' and not coalesce((v_access->>'can_manage_groups')::boolean,false) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  if not v_metadata and not(p_payload?'target_group_ids') then raise exception 'TEACHING_INVALID_INPUT';end if;
  select coalesce(array_agg(group_id order by group_id),'{}'::uuid[]) into v_groups from public.teaching_item_targets where item_id=v_id;
  select coalesce(array_agg(l.group_id order by l.group_id),'{}'::uuid[]) into v_allowed from public.teaching_course_groups l where l.course_id=v_course and l.status='accepted' and 'materials'=any(public.xelay_teaching_group_permissions(v_course,l.group_id,v_uid));
  if p_payload?'target_group_ids' then
    if jsonb_typeof(p_payload->'target_group_ids') is distinct from 'array' or jsonb_array_length(p_payload->'target_group_ids')>100
      or exists(select 1 from jsonb_array_elements(p_payload->'target_group_ids') x where jsonb_typeof(x) is distinct from 'string') then raise exception 'TEACHING_INVALID_INPUT';end if;
    select coalesce(array_agg(value::uuid),'{}'::uuid[]) into v_incoming from jsonb_array_elements_text(p_payload->'target_group_ids');
    if cardinality(v_incoming)<>(select count(distinct g) from unnest(v_incoming) g) then raise exception 'TEACHING_INVALID_INPUT';end if;
    foreach v_group in array v_incoming loop perform public.xelay_private_assert_teaching_group(v_course,v_group,'materials');end loop;
    select coalesce(array_agg(g order by g),'{}') into v_groups from(
      select g from unnest(v_incoming) g union select g from unnest(v_groups) g where not v_own and not(g=any(v_allowed))) all_groups;
  end if;
  if v_metadata then
    foreach v_group in array v_groups loop
      if not exists(select 1 from public.teaching_course_groups where course_id=v_course and group_id=v_group and status='accepted') then raise exception 'TEACHING_GROUP_FORBIDDEN' using errcode='42501';end if;
    end loop;
  end if;
  foreach v_key in array array['title','body','status'] loop
    if p_payload?v_key and jsonb_typeof(p_payload->v_key) is distinct from 'string' then raise exception 'TEACHING_INVALID_INPUT';end if;
  end loop;
  v_title:=case when p_payload?'title' then btrim(p_payload->>'title') else coalesce(v_item.title,'') end;
  v_body:=case when p_payload?'body' then p_payload->>'body' else coalesce(v_item.body,'') end;
  v_links:=case when p_payload?'links' then p_payload->'links' else coalesce(v_item.links,'[]') end;
  v_files:=case when p_payload?'attachments' then p_payload->'attachments' else coalesce(v_item.attachments,'[]') end;
  v_status:=case when p_payload?'status' then p_payload->>'status' else coalesce(v_item.status,'draft') end;
  if length(v_title) not between 1 and 240 or length(v_body)>50000 or v_status not in('draft','scheduled','published') then raise exception 'TEACHING_INVALID_INPUT';end if;
  if cardinality(v_groups)=0 and v_status<>'draft' then
    if v_existing and not(p_payload?'status') then v_status:='draft';else raise exception 'TEACHING_INVALID_INPUT';end if;
  end if;
  if p_payload?'allow_download' and jsonb_typeof(p_payload->'allow_download') is distinct from 'boolean' then raise exception 'TEACHING_INVALID_INPUT';end if;
  v_allow:=case when p_payload?'allow_download' then(p_payload->>'allow_download')::boolean else coalesce(v_item.allow_download,true) end;
  v_publish:=case when v_status<>'scheduled' then null when p_payload?'publish_at' then nullif(p_payload->>'publish_at','')::timestamptz else v_item.publish_at end;
  if v_status='scheduled' and(v_publish is null or not isfinite(v_publish) or(v_metadata and v_publish<=clock_timestamp())) then raise exception 'TEACHING_INVALID_INPUT';end if;
  v_until:=case when p_payload?'access_until' then nullif(p_payload->>'access_until','')::timestamptz else v_item.access_until end;
  if v_until is not null and(not isfinite(v_until) or(v_publish is not null and v_until<=v_publish)
    or(p_payload?'access_until' and v_until<=clock_timestamp() and v_until is distinct from v_item.access_until)) then raise exception 'TEACHING_INVALID_INPUT';end if;
  v_material_date:=case when p_payload?'material_date' then nullif(p_payload->>'material_date','')::date else v_item.material_date end;
  v_labels:=public.xelay_teaching_normalize_link_labels(v_links,case when p_payload?'link_labels' then p_payload->'link_labels' else coalesce(v_item.link_labels,'{}') end,p_payload?'link_labels');
  v_prior:=coalesce(v_item.attachments,'[]');
  perform public.xelay_teaching_validate_resources(v_course,v_links,v_files,v_prior);
  if v_metadata and v_status<>'draft' and(p_payload->'rights_accepted' is distinct from 'true'::jsonb or p_payload->>'rights_terms_version' is distinct from '2026-10-27.1') then
    raise exception 'TEACHING_MATERIAL_RIGHTS_REQUIRED' using errcode='42501';end if;
  if not v_own and v_status<>'draft' and(v_item.rights_accepted_by is distinct from v_item.created_by or v_item.rights_accepted_at is null
    or v_item.rights_terms_version is null or v_item.rights_terms_version not in('2026-10-21.1','2026-10-23.1','2026-10-27.1')) then
    raise exception 'TEACHING_MATERIAL_AUTHOR_ACCEPTANCE_REQUIRED' using errcode='42501';end if;
  v_new_version:=coalesce(v_item.version,0)+1;
  if v_existing and v_metadata and not v_own and v_status<>'draft' then
    -- Record actual publication acceptance, never fabricate it for a draft.
    if p_payload->'rights_accepted' is distinct from 'true'::jsonb or p_payload->>'rights_terms_version' is distinct from '2026-10-27.1' then raise exception 'TEACHING_MATERIAL_RIGHTS_REQUIRED' using errcode='42501';end if;
    insert into public.teaching_material_change_receipts(item_id,version,actor_id,terms_version) values(v_id,v_new_version,v_uid,'2026-10-27.1');
  end if;
  if not v_existing then
    insert into public.teaching_items(id,course_id,kind,title,body,links,link_labels,attachments,status,material_date,created_by,allow_download,publish_at,scheduled_by,access_until,published_at,rights_accepted_by,rights_accepted_at,rights_terms_version)
      values(v_id,v_course,'material',v_title,v_body,v_links,v_labels,v_files,v_status,v_material_date,v_uid,v_allow,v_publish,
        case when v_status='scheduled' then v_uid end,v_until,case when v_status='published' then clock_timestamp() end,
        case when v_status<>'draft' then v_uid end,case when v_status<>'draft' then clock_timestamp() end,case when v_status<>'draft' then '2026-10-27.1' end)
      returning * into v_item;
  else
    update public.teaching_items set title=v_title,body=v_body,links=v_links,link_labels=v_labels,attachments=v_files,status=v_status,
      material_date=v_material_date,allow_download=v_allow,publish_at=v_publish,access_until=v_until,
      scheduled_by=case when v_status='scheduled' then case when v_metadata then v_uid else scheduled_by end end,
      published_at=case when v_status='published' then coalesce(published_at,clock_timestamp()) else published_at end,
      rights_accepted_by=case when v_metadata and v_status<>'draft' and v_own then v_uid else rights_accepted_by end,
      rights_accepted_at=case when v_metadata and v_status<>'draft' and v_own then clock_timestamp() else rights_accepted_at end,
      rights_terms_version=case when v_metadata and v_status<>'draft' and v_own then '2026-10-27.1' else rights_terms_version end,
      version=v_new_version,updated_at=clock_timestamp() where id=v_id returning * into v_item;
  end if;
  if v_metadata and v_own and v_status<>'draft' then
    insert into public.teaching_material_change_receipts(item_id,version,actor_id,terms_version) values(v_id,v_item.version,v_uid,'2026-10-27.1');
  end if;
  delete from public.teaching_item_targets where item_id=v_id and not(group_id=any(v_groups));
  insert into public.teaching_item_targets(item_id,group_id) select v_id,g from unnest(v_groups) g on conflict(item_id,group_id) do nothing;
  v_result:=jsonb_build_object('id',v_id,'version',v_item.version);
  if not v_existing then insert into public.teaching_create_receipts(user_id,action,request_id,payload,result) values(v_uid,p_action,v_id,p_payload,v_result);end if;
  return v_result;
end $$;
revoke all on function public.xelay_private_material_library_mutate(text,jsonb) from public,anon,authenticated,service_role;

create function pg_temp.xelay_material_library_patch(p_signature text,p_old text,p_new text,p_count integer default 1)
returns void language plpgsql as $$
declare v_body text;v_old text:=replace(p_old,chr(13),'');v_new text:=replace(p_new,chr(13),'');v_matches integer;
begin
  select replace(pg_get_functiondef(to_regprocedure(p_signature)),chr(13),'') into v_body;
  if v_body is null or v_old='' then raise exception 'TEACHING_LIBRARY_PATCH_MISSING: %',p_signature;end if;
  v_matches:=(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old);
  if v_matches<>p_count then raise exception 'TEACHING_LIBRARY_PATCH_DRIFT: % (%, expected %)',p_signature,v_matches,p_count;end if;
  execute replace(v_body,v_old,v_new);
end $$;
select pg_temp.xelay_material_library_patch('public.xelay_teaching_mutate(text,jsonb)',
  '  perform public.xelay_private_teaching_mutation_scope(p_action,p_payload);',
  '  if p_action in(''save_library_material'',''set_material_collaborators'') then return public.xelay_private_material_library_mutate(p_action,p_payload);end if;
  perform public.xelay_private_teaching_mutation_scope(p_action,p_payload);');
select pg_temp.xelay_material_library_patch('public.xelay_teaching_mutate(text,jsonb)',
  '''2026-10-23.1''','''2026-10-27.1''',3);
select pg_temp.xelay_material_library_patch('public.xelay_guard_teaching_material_access()',
  'new.rights_terms_version is distinct from ''2026-10-23.1''',
  '(new.rights_terms_version is null or new.rights_terms_version not in(''2026-10-23.1'',''2026-10-27.1''))');
select pg_temp.xelay_material_library_patch('public.xelay_guard_teaching_material_access()',
  '    v_path:=v_file->>''storage_path'';',
  '    if tg_op=''UPDATE'' then if old.kind=''material'' and old.attachments @> jsonb_build_array(v_file) then continue;end if;end if;
    v_path:=v_file->>''storage_path'';');
select pg_temp.xelay_material_library_patch('public.xelay_guard_teaching_material_access()',
  'split_part(v_path,''/'',2) is distinct from new.created_by::text',
  'split_part(v_path,''/'',2) is distinct from auth.uid()::text');
select pg_temp.xelay_material_library_patch('public.xelay_guard_teaching_material_access()',
  'v_owner is distinct from new.created_by::text','v_owner is distinct from auth.uid()::text');
drop function pg_temp.xelay_material_library_patch(text,text,text,integer);
comment on table public.teaching_material_grants is 'Author-approved per-material controls; effective rights intersect current accepted teaching group scopes. No authorship or power to redelegate is transferred.';
comment on table public.teaching_material_change_receipts is 'Private actual editor acceptance by immutable item version. Original author acceptance fields remain attributed to the author.';
notify pgrst,'reload schema';
commit;
