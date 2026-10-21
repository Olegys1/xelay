-- Read-only teacher publications in group Materials; author-controlled withdrawal.
-- Keep one canonical teaching_items row and the existing private teaching bucket.
-- Apply locally prepared SQL only after the teaching/publication/projection migrations.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$ begin
  if to_regclass('public.teaching_items') is null
    or to_regclass('public.study_group_material_subjects') is null
    or to_regprocedure('public.xelay_academic_subject_key(text)') is null
    or to_regprocedure('public.xelay_teaching_assert_user()') is null
    or to_regprocedure('public.xelay_teaching_is_backend_write()') is null
    or to_regprocedure('public.xelay_teaching_group(uuid)') is null
    or to_regprocedure('public.xelay_teaching_mutate(text,jsonb)') is null
    or not exists(select 1 from pg_attribute where attrelid='public.teaching_items'::regclass
      and attname='link_labels' and not attisdropped) then
    raise exception 'Apply teaching, classroom, schedule projection and publication editing migrations first';
  end if;
end $$;

alter table public.teaching_items
  add column if not exists withdrawn_at timestamptz,
  add column if not exists rights_accepted_by uuid references public.profiles(id) on delete restrict,
  add column if not exists rights_accepted_at timestamptz,
  add column if not exists rights_terms_version text;
-- Existing publications keep NULL consent fields. No retrospective acceptance.
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.teaching_items'::regclass
    and conname='teaching_material_withdrawal_scope') then
    alter table public.teaching_items add constraint teaching_material_withdrawal_scope
      check(withdrawn_at is null or(kind='material' and isfinite(withdrawn_at)));
  end if;
  if not exists(select 1 from pg_constraint where conrelid='public.teaching_items'::regclass
    and conname='teaching_material_rights_acceptance_complete') then
    alter table public.teaching_items add constraint teaching_material_rights_acceptance_complete check(
      (rights_accepted_by is null and rights_accepted_at is null and rights_terms_version is null)
      or(kind='material' and rights_accepted_by is not null and rights_accepted_by=created_by
        and rights_accepted_at is not null and isfinite(rights_accepted_at)
        and rights_terms_version is not null and rights_terms_version='2026-10-21.1'));
  end if;
end $$;
create index if not exists teaching_materials_author_idx
  on public.teaching_items(created_by,created_at desc,id) where kind='material';

-- created_by identifies the account that published the material. It does not
-- assert ownership of all intellectual property in the uploaded content.
create or replace function public.xelay_guard_teacher_material_author()
returns trigger language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();v_file jsonb;v_path text;v_owner text;
begin
  if public.xelay_teaching_is_backend_write() then
    if tg_op='DELETE' then return old; end if;
    return new;
  end if;
  if tg_op='INSERT' then
    if new.kind<>'material' then return new; end if;
    if v_uid is null or new.created_by is distinct from v_uid or new.withdrawn_at is not null then
      raise exception 'TEACHING_MATERIAL_AUTHOR_REQUIRED' using errcode='42501'; end if;
  else
    if old.kind<>'material' and(tg_op='DELETE' or new.kind<>'material') then
      if tg_op='DELETE' then return old; end if;
      return new;
    end if;
    if v_uid is null or old.kind<>'material' or old.created_by is distinct from v_uid then
      raise exception 'TEACHING_MATERIAL_AUTHOR_REQUIRED' using errcode='42501'; end if;
    if tg_op='DELETE' then
      raise exception 'TEACHING_MATERIAL_WITHDRAW_REQUIRED' using errcode='42501'; end if;
    if new.id is distinct from old.id or new.course_id is distinct from old.course_id
      or new.kind is distinct from old.kind or new.created_by is distinct from old.created_by
      or new.created_at is distinct from old.created_at then
      raise exception 'TEACHING_MATERIAL_IDENTITY_IMMUTABLE' using errcode='23514'; end if;
    if old.withdrawn_at is not null then raise exception 'TEACHING_MATERIAL_WITHDRAWN'; end if;
    if new.withdrawn_at is not null then
      -- The narrow withdrawal changes visibility/version only. It cannot edit
      -- coursework, assessment, targets, resources or another author's record.
      if (to_jsonb(new)-array['withdrawn_at','version','updated_at'])
        is distinct from(to_jsonb(old)-array['withdrawn_at','version','updated_at'])
        or new.version<>old.version+1 then
        raise exception 'TEACHING_INVALID_INPUT'; end if;
      return new;
    end if;
  end if;
  perform public.xelay_teaching_lock_course(new.course_id,'materials');
  if new.status='published' and(new.rights_accepted_by is distinct from v_uid
    or new.rights_accepted_at is null or new.rights_terms_version is distinct from '2026-10-21.1') then
    raise exception 'TEACHING_MATERIAL_RIGHTS_REQUIRED' using errcode='42501'; end if;
  -- Existing resource validation already checks newly attached file ownership.
  -- Repeat its ownership boundary for material writes, failing closed for an
  -- absent Storage owner. Preserve exact retained legacy descriptors only.
  for v_file in select value from jsonb_array_elements(new.attachments) order by value->>'storage_path' loop
    if tg_op='UPDATE' then
      if old.attachments @> jsonb_build_array(v_file) then continue; end if;
    end if;
    v_path:=v_file->>'storage_path';
    if public.xelay_teaching_file_course(v_path) is distinct from new.course_id
      or split_part(v_path,'/',2) is distinct from v_uid::text then
      raise exception 'TEACHING_FILE_FORBIDDEN' using errcode='42501'; end if;
    perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-file:'||v_path,0));
    select coalesce(nullif(to_jsonb(o)->>'owner_id',''),to_jsonb(o)->>'owner') into v_owner
      from storage.objects o where o.bucket_id='xelay-teaching-files' and o.name=v_path for key share;
    if not found or v_owner is distinct from v_uid::text then
      raise exception 'TEACHING_FILE_FORBIDDEN' using errcode='42501'; end if;
  end loop;
  return new;
end $$;
revoke all on function public.xelay_guard_teacher_material_author() from public,anon,authenticated,service_role;
drop trigger if exists teacher_material_author_guard on public.teaching_items;
create trigger teacher_material_author_guard before insert or update or delete on public.teaching_items
  for each row execute function public.xelay_guard_teacher_material_author();

create or replace function public.xelay_private_withdraw_teaching_material(p_item_id uuid,p_version integer)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_course uuid;v_item public.teaching_items%rowtype;
begin
  if p_item_id is null or p_version is null or p_version<1 then raise exception 'TEACHING_INVALID_INPUT'; end if;
  select course_id into v_course from public.teaching_items
    where id=p_item_id and kind='material' and created_by=v_uid;
  if not found then raise exception 'TEACHING_MATERIAL_AUTHOR_REQUIRED' using errcode='42501'; end if;
  -- Preserve the course -> item lock order of ordinary teaching writes, while
  -- deliberately not requiring course rights, verification, archive or groups.
  perform 1 from public.teaching_courses where id=v_course for update;
  select * into v_item from public.teaching_items where id=p_item_id and kind='material'
    and created_by=v_uid and course_id=v_course for update;
  if not found then raise exception 'TEACHING_MATERIAL_AUTHOR_REQUIRED' using errcode='42501'; end if;
  if v_item.withdrawn_at is not null then
    if p_version not in(v_item.version,v_item.version-1) then raise exception 'TEACHING_CONFLICT'; end if;
    return jsonb_build_object('id',v_item.id,'version',v_item.version,'status','withdrawn','withdrawn_at',v_item.withdrawn_at);
  end if;
  if p_version is distinct from v_item.version then raise exception 'TEACHING_CONFLICT'; end if;
  update public.teaching_items set withdrawn_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp()
    where id=v_item.id returning * into v_item;
  return jsonb_build_object('id',v_item.id,'version',v_item.version,'status','withdrawn','withdrawn_at',v_item.withdrawn_at);
end $$;
revoke all on function public.xelay_private_withdraw_teaching_material(uuid,integer) from public,anon,authenticated,service_role;

-- Assignment/grading/student-work behavior is preserved. Only materials gain
-- withdrawal visibility checks; removed group links already stop student reads.
create or replace function public.xelay_teaching_can_read_item(p_item_id uuid,p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.teaching_items i where i.id=p_item_id and i.withdrawn_at is null and(
    (case when i.kind='assignment' then 'assignments' else 'materials' end)=any(public.xelay_teaching_permissions(i.course_id,p_user_id))
    or(i.kind='assignment' and i.status='published' and 'grades'=any(public.xelay_teaching_permissions(i.course_id,p_user_id)))
    or(i.status='published' and exists(select 1 from public.teaching_item_targets t
      join public.teaching_course_groups g on g.course_id=i.course_id and g.group_id=t.group_id and g.status='accepted'
      where t.item_id=i.id and public.xelay_teaching_is_member(t.group_id,p_user_id)))));
$$;

-- Acceptance receipts are publisher/backend metadata, not group content.
-- Keep the original attribution and audience filtering in every existing view.
create or replace function public.xelay_teaching_item_json(p_item public.teaching_items,p_group uuid default null)
returns jsonb language sql stable security definer set search_path='' as $$
  select(to_jsonb(p_item)-case when p_item.created_by is distinct from auth.uid()
      then array['rights_accepted_by','rights_accepted_at','rights_terms_version']::text[] else '{}'::text[] end)
    ||jsonb_build_object('author_name',(select full_name from public.profiles where id=p_item.created_by),
      'course_title',(select title from public.teaching_courses where id=p_item.course_id),
      'targets',coalesce((select jsonb_agg(jsonb_build_object('group_id',t.group_id,'due_at',t.due_at) order by t.group_id)
        from public.teaching_item_targets t where t.item_id=p_item.id and(p_group is null or t.group_id=p_group)
          and(cardinality(public.xelay_teaching_permissions(p_item.course_id,auth.uid()))>0
            or public.xelay_teaching_is_member(t.group_id,auth.uid()))),'[]'::jsonb));
$$;

create or replace function public.xelay_my_teaching_materials()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();
begin
  return jsonb_build_object('materials',coalesce((select jsonb_agg(
    public.xelay_teaching_item_json(i)||jsonb_build_object(
      'kind','material','source','teacher','source_item_id',i.id,'course_title',c.title,
      'course_archived_at',c.archived_at,'can_withdraw',i.withdrawn_at is null,
      'can_edit',i.withdrawn_at is null and c.archived_at is null
        and 'materials'=any(public.xelay_teaching_permissions(c.id,v_uid)))
    order by i.created_at desc,i.id)
    from public.teaching_items i join public.teaching_courses c on c.id=i.course_id
    where i.kind='material' and i.created_by=v_uid),'[]'::jsonb));
end $$;

create or replace function public.xelay_group_teacher_materials(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();
begin
  if not public.xelay_teaching_is_member(p_group_id,v_uid) then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  return(with source_rows as(
    select i,c.title as course_title,c.archived_at as course_archived_at,
      coalesce(m.name,s.name,c.title) as subject_name,
      coalesce(m.id::text,'teacher-subject:'||coalesce(s.id,c.id)::text) as subject_id,
      m.id is null as virtual_subject
    from public.teaching_items i
    join public.teaching_item_targets t on t.item_id=i.id and t.group_id=p_group_id
    join public.teaching_course_groups l on l.course_id=i.course_id and l.group_id=p_group_id and l.status='accepted'
    join public.teaching_courses c on c.id=i.course_id
    left join public.study_group_seminar_subjects s on s.id=l.subject_id and s.group_id=p_group_id
    -- The teaching link is a seminar-subject FK, never a material-subject UUID.
    -- Reuse a materials subject only for one unambiguous canonical name match.
    left join lateral(
      select min(candidate.id::text)::uuid as id,min(candidate.name) as name
      from public.study_group_material_subjects candidate
      where candidate.group_id=p_group_id
        and public.xelay_academic_subject_key(candidate.name)=public.xelay_academic_subject_key(coalesce(s.name,c.title))
      having count(*)=1
    ) m on true
    where i.kind='material' and i.status='published' and i.withdrawn_at is null
  ), material_rows as(
    select public.xelay_teaching_item_json(r.i,p_group_id)||jsonb_build_object(
      'kind','material','source','teacher','source_item_id',(r.i).id,'group_id',p_group_id,
      'subject_id',r.subject_id,'subject_name',r.subject_name,'course_title',r.course_title,
      'course_archived_at',r.course_archived_at,'read_only',true,'can_withdraw',(r.i).created_by=v_uid
    ) as material,(r.i).created_at as created_at,(r.i).material_date as material_date,(r.i).id as item_id
    from source_rows r
  ), subject_rows as(
    select distinct r.subject_id,r.subject_name,r.virtual_subject from source_rows r
  )
  select jsonb_build_object(
    'subjects',coalesce((select jsonb_agg(jsonb_build_object(
      'id',r.subject_id,'group_id',p_group_id,'name',r.subject_name,'source','teacher',
      'read_only',r.virtual_subject,'virtual',r.virtual_subject,'created_by','','created_at','','updated_at','')
      order by r.subject_name,r.subject_id) from subject_rows r),'[]'::jsonb),
    'materials',coalesce((select jsonb_agg(r.material order by r.material_date desc nulls last,r.created_at desc,r.item_id)
      from material_rows r),'[]'::jsonb)));
end $$;
revoke all on function public.xelay_my_teaching_materials(),public.xelay_group_teacher_materials(uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_my_teaching_materials(),public.xelay_group_teacher_materials(uuid) to authenticated;

-- Preserve the installed dispatcher, including classroom/grade safeguards and
-- creation receipts. Each patch must match its prerequisite exactly once.
do $material_contract$
declare v_body text;v_old text;v_new text;v_old_count integer;v_new_count integer;v_patch record;
begin
  select pg_get_functiondef('public.xelay_teaching_mutate(text,jsonb)'::regprocedure) into v_body;
  for v_patch in select * from(values
    ($old$  v_version:=nullif(p_payload->>'version','')::integer;$old$,
     $new$  v_version:=nullif(p_payload->>'version','')::integer;
  -- teacher_material_author_withdrawal_contract
  if p_action in('withdraw_material','delete_material') then
    return public.xelay_private_withdraw_teaching_material(v_id,v_version);
  end if;
  if p_action='save_material' then
    if exists(select 1 from public.teaching_items where id=v_id and kind='material'
      and created_by<>v_uid) then raise exception 'TEACHING_MATERIAL_AUTHOR_REQUIRED' using errcode='42501'; end if;
    if exists(select 1 from public.teaching_items where id=v_id and kind='material'
      and withdrawn_at is not null) then raise exception 'TEACHING_MATERIAL_WITHDRAWN'; end if;
    if coalesce(p_payload->>'status','draft')='published'
      and(p_payload->'rights_accepted' is distinct from 'true'::jsonb
        or p_payload->>'rights_terms_version' is distinct from '2026-10-21.1') then
      raise exception 'TEACHING_MATERIAL_RIGHTS_REQUIRED' using errcode='42501'; end if;
  end if;
$new$),
    ($old$-- publication. Draft assignment/material templates retain immutable bytes.$old$,
     $new$-- publication. Only draft assignment templates retain immutable bytes.$new$),
    ($old$for v_source in select * from public.teaching_items where course_id=v_course_id loop$old$,
     $new$-- Course copies keep assignment templates; teacher materials remain one
    -- revocable publication and must never acquire a different publisher by copy.
    for v_source in select * from public.teaching_items where course_id=v_course_id and kind='assignment' loop$new$),
    ($old$id,course_id,kind,title,body,links,link_labels,attachments,material_date,max_points,category,status,published_at,created_by)$old$,
     $new$id,course_id,kind,title,body,links,link_labels,attachments,material_date,max_points,category,status,published_at,created_by,
        rights_accepted_by,rights_accepted_at,rights_terms_version)$new$),
    ($old$case when v_status='published' then now() else null end,v_uid) returning * into v_record;$old$,
     $new$case when v_status='published' then now() else null end,v_uid,
        case when v_kind='material' and v_status='published' then v_uid end,
        case when v_kind='material' and v_status='published' then clock_timestamp() end,
        case when v_kind='material' and v_status='published' then '2026-10-21.1' end) returning * into v_record;$new$),
    ($old$published_at=case when v_status='published' then coalesce(published_at,now()) else published_at end,version=version+1,updated_at=now()$old$,
     $new$published_at=case when v_status='published' then coalesce(published_at,now()) else published_at end,
        rights_accepted_by=case when v_kind='material' and v_status='published' then v_uid else rights_accepted_by end,
        rights_accepted_at=case when v_kind='material' and v_status='published' then clock_timestamp() else rights_accepted_at end,
        rights_terms_version=case when v_kind='material' and v_status='published' then '2026-10-21.1' else rights_terms_version end,
        version=version+1,updated_at=now()$new$)
  ) as patches(old_body,new_body) loop
    v_old:=v_patch.old_body;v_new:=v_patch.new_body;
    v_old_count:=(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old);
    v_new_count:=(length(v_body)-length(replace(v_body,v_new,'')))/length(v_new);
    -- The new anchor may contain the old anchor once (the dispatcher prefix).
    if v_new_count=1 and v_old_count=(length(v_new)-length(replace(v_new,v_old,'')))/length(v_old) then continue; end if;
    if v_old_count<>1 or v_new_count<>0 then raise exception 'TEACHER_MATERIAL_MUTATION_PREREQUISITE'; end if;
    v_body:=replace(v_body,v_old,v_new);
  end loop;
  execute v_body;

  select pg_get_functiondef('public.xelay_teaching_group(uuid)'::regprocedure) into v_body;
  v_old:=$old$where i.kind='material' and i.status='published')$old$;
  v_new:=$new$where i.kind='material' and i.status='published' and i.withdrawn_at is null)$new$;
  v_old_count:=(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old);
  v_new_count:=(length(v_body)-length(replace(v_body,v_new,'')))/length(v_new);
  if v_old_count=1 and v_new_count=0 then execute replace(v_body,v_old,v_new);
  elsif v_old_count<>0 or v_new_count<>1 then raise exception 'TEACHER_MATERIAL_GROUP_READ_PREREQUISITE'; end if;
end $material_contract$;

comment on column public.teaching_items.withdrawn_at is
  'Author withdrawal hides this canonical material from all course/group reads and new file signing. Original private bytes and minimum records may remain for recovery; issued signed URLs expire independently.';
comment on column public.teaching_items.rights_accepted_at is
  'Actual publisher acceptance recorded only when save_material publishes with rights_accepted=true and the current terms version; historical publications are not backfilled.';
comment on function public.xelay_group_teacher_materials(uuid) is
  'Accepted-member-only read projection of published targeted teacher materials. Uses the original teaching item/files, attribution and read-only subject grouping; no group storage or material rows are created.';
comment on function public.xelay_my_teaching_materials() is
  'The authenticated publisher can inspect their own material records and withdrawal state after course archive, group disconnection or loss of course permissions.';

notify pgrst, 'reload schema';
commit;
