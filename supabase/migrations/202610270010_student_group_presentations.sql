-- Student-to-student presentations, separate from teacher-owned materials and submissions.
-- Prepared locally; deploy only after approval of the local preview.
begin;

create or replace function public.xelay_can_read_group_presentations(p_group_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select auth.uid() is not null and (
    exists(select 1 from public.study_groups g where g.id=p_group_id and g.representative_id=auth.uid())
    or exists(select 1 from public.study_group_members m where m.group_id=p_group_id and m.user_id=auth.uid() and m.status='accepted'));
$$;
create or replace function public.xelay_can_moderate_group_presentations(p_group_id uuid)
returns boolean language sql stable security definer set search_path = '' as $$
  select public.xelay_can_read_group_presentations(p_group_id)
    and 'materials'=any(public.xelay_study_group_permissions(p_group_id));
$$;

create table if not exists public.study_group_presentations (
  id uuid primary key,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  created_by uuid not null,
  author_name text not null,
  subject text not null check(subject=btrim(subject) and length(subject) between 2 and 180 and subject !~ '[[:cntrl:]]'),
  title text not null check(title=btrim(title) and length(title) between 3 and 180 and title !~ '[[:cntrl:]]'),
  lesson_date date not null check(isfinite(lesson_date) and lesson_date between date '1900-01-01' and date '2200-12-31'),
  description text not null default '' check(length(description)<=5000),
  links jsonb not null default '[]' check(public.xelay_material_links_valid(links) and jsonb_array_length(links)<=4),
  attachments jsonb not null default '[]' check(public.xelay_material_attachments_valid(group_id,attachments) and jsonb_array_length(attachments)<=4),
  version integer not null default 1 check(version>0),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  check(jsonb_array_length(links)+jsonb_array_length(attachments)>0)
);
create index if not exists study_group_presentations_group_date_idx on public.study_group_presentations(group_id,lesson_date desc,created_at desc);
create index if not exists study_group_presentations_files_idx on public.study_group_presentations using gin(attachments jsonb_path_ops);
create table if not exists public.study_group_presentation_cleanup(
  storage_path text primary key,group_id uuid not null,owner_id uuid not null,cleanup_user_id uuid not null,
  retired_at timestamptz not null default clock_timestamp(),
  check(public.xelay_material_file_path_valid(storage_path) and split_part(storage_path,'/',1)=group_id::text and split_part(storage_path,'/',2)=owner_id::text)
);
alter table public.study_group_presentation_cleanup enable row level security;
revoke all on table public.study_group_presentation_cleanup from public,anon,authenticated,service_role;
alter table public.study_group_presentations enable row level security;
revoke all on table public.study_group_presentations from public,anon,authenticated,service_role;
grant select on table public.study_group_presentations to authenticated;
create policy "Accepted classmates read shared presentations" on public.study_group_presentations
  for select to authenticated using(public.xelay_can_read_group_presentations(group_id));

create or replace function public.xelay_group_presentations(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.xelay_can_read_group_presentations(p_group_id) then raise exception 'GROUP_PRESENTATION_ACCESS' using errcode='42501'; end if;
  return jsonb_build_object(
    'presentations',coalesce((select jsonb_agg(to_jsonb(p) order by p.lesson_date desc,p.created_at desc,p.id) from public.study_group_presentations p where p.group_id=p_group_id),'[]'::jsonb),
    'subjects',coalesce((select jsonb_agg(s.subject order by s.subject) from (
      select subject from public.study_group_schedule where group_id=p_group_id
      union select name from public.study_group_material_subjects where group_id=p_group_id
      union select subject from public.study_group_presentations where group_id=p_group_id
    ) s where length(btrim(s.subject))>=2),'[]'::jsonb),
    'can_moderate',public.xelay_can_moderate_group_presentations(p_group_id));
end;
$$;

create or replace function public.xelay_save_group_presentation(p_group_id uuid,p_id uuid,p_version integer,p_draft jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_actor uuid:=auth.uid(); v_old public.study_group_presentations%rowtype;
  v_row public.study_group_presentations%rowtype; v_file jsonb; v_object storage.objects%rowtype;
  v_subject text;v_title text;v_date date;v_description text;v_links jsonb;v_attachments jsonb;
begin
  if not public.xelay_can_read_group_presentations(p_group_id) then raise exception 'GROUP_PRESENTATION_ACCESS' using errcode='42501'; end if;
  if p_id is null or p_version is null or p_version<0 or p_draft is null or jsonb_typeof(p_draft)<>'object'
    or not(p_draft ?& array['subject','title','lesson_date','description','links','attachments'])
    or p_draft-array['subject','title','lesson_date','description','links','attachments']<>'{}'::jsonb
    or jsonb_typeof(p_draft->'subject')<>'string' or jsonb_typeof(p_draft->'title')<>'string'
    or jsonb_typeof(p_draft->'lesson_date')<>'string' or jsonb_typeof(p_draft->'description')<>'string'
    then raise exception 'GROUP_PRESENTATION_INVALID' using errcode='22023'; end if;
  v_subject:=btrim(p_draft->>'subject');v_title:=btrim(p_draft->>'title');v_description:=btrim(p_draft->>'description');
  v_links:=p_draft->'links';v_attachments:=p_draft->'attachments';
  begin v_date:=(p_draft->>'lesson_date')::date; exception when others then raise exception 'GROUP_PRESENTATION_INVALID' using errcode='22023'; end;
  if length(v_subject) not between 2 and 180 or length(v_title) not between 3 and 180 or v_subject ~ '[[:cntrl:]]' or v_title ~ '[[:cntrl:]]'
    or length(v_description)>5000 or not isfinite(v_date) or v_date not between date '1900-01-01' and date '2200-12-31'
    or not public.xelay_material_links_valid(v_links) or not public.xelay_material_attachments_valid(p_group_id,v_attachments)
    then raise exception 'GROUP_PRESENTATION_INVALID' using errcode='22023'; end if;
  if jsonb_array_length(v_links)>4 or jsonb_array_length(v_attachments)>4 or jsonb_array_length(v_links)+jsonb_array_length(v_attachments)=0
    then raise exception 'GROUP_PRESENTATION_INVALID' using errcode='22023'; end if;
  perform pg_advisory_xact_lock(hashtext('xelay-group-presentation'),hashtext(p_id::text));
  select * into v_old from public.study_group_presentations where id=p_id for update;
  if found and (v_old.group_id<>p_group_id or v_old.created_by<>v_actor) then raise exception 'GROUP_PRESENTATION_FORBIDDEN' using errcode='42501'; end if;
  -- An identical retry of initial creation returns its existing receipt.
  if v_old.id is not null and p_version=0 and v_old.version=1 and v_old.subject=v_subject and v_old.title=v_title and v_old.lesson_date=v_date
    and v_old.description=v_description and v_old.links=v_links and v_old.attachments=v_attachments then return to_jsonb(v_old); end if;
  if coalesce(v_old.version,0)<>p_version then raise exception 'GROUP_PRESENTATION_CONFLICT' using errcode='40001'; end if;
  for v_file in select value from jsonb_array_elements(v_attachments) order by value->>'path' loop
    if split_part(v_file->>'path','/',2)<>v_actor::text or (v_file->>'mime_type') not in('application/pdf','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/jpeg','image/png','image/webp')
      then raise exception 'GROUP_PRESENTATION_FILE' using errcode='42501'; end if;
    perform pg_advisory_xact_lock(hashtext('xelay-group-presentation-file'),hashtext(v_file->>'path'));
    if exists(select 1 from public.study_group_presentation_cleanup where storage_path=v_file->>'path')
      and not coalesce(v_old.attachments,'[]'::jsonb) @> jsonb_build_array(jsonb_build_object('path',v_file->>'path'))
      then raise exception 'GROUP_PRESENTATION_FILE' using errcode='42501'; end if;
    select * into v_object from storage.objects where bucket_id='xelay-group-presentations' and name=v_file->>'path' for share;
    if not found or coalesce(v_object.metadata->>'size','') !~ '^[0-9]+$'
      or (v_object.metadata->>'size')::bigint<>(v_file->>'file_size')::bigint
      or v_object.metadata->>'mimetype' is distinct from v_file->>'mime_type'
      then raise exception 'GROUP_PRESENTATION_FILE' using errcode='22023'; end if;
  end loop;
  if v_old.id is null then
    insert into public.study_group_presentations(id,group_id,created_by,author_name,subject,title,lesson_date,description,links,attachments)
      values(p_id,p_group_id,v_actor,coalesce((select nullif(btrim(full_name),'') from public.profiles where id=v_actor),'Учасник групи'),v_subject,v_title,v_date,v_description,v_links,v_attachments) returning * into v_row;
  else
    insert into public.study_group_presentation_cleanup(storage_path,group_id,owner_id,cleanup_user_id)
      select f->>'path',p_group_id,v_actor,v_actor from jsonb_array_elements(v_old.attachments) f
      where not v_attachments @> jsonb_build_array(jsonb_build_object('path',f->>'path'))
      on conflict(storage_path) do update set cleanup_user_id=excluded.cleanup_user_id;
    update public.study_group_presentations set subject=v_subject,title=v_title,lesson_date=v_date,description=v_description,links=v_links,attachments=v_attachments,version=version+1,updated_at=clock_timestamp()
      where id=p_id returning * into v_row;
  end if;
  return to_jsonb(v_row);
end;
$$;

create or replace function public.xelay_delete_group_presentation(p_group_id uuid,p_id uuid,p_version integer)
returns void language plpgsql security definer set search_path = '' as $$
declare v_row public.study_group_presentations%rowtype;
begin
  if not public.xelay_can_read_group_presentations(p_group_id) then raise exception 'GROUP_PRESENTATION_ACCESS' using errcode='42501'; end if;
  select * into v_row from public.study_group_presentations where id=p_id and group_id=p_group_id for update;
  if not found or (v_row.created_by<>auth.uid() and not public.xelay_can_moderate_group_presentations(p_group_id))
    then raise exception 'GROUP_PRESENTATION_FORBIDDEN' using errcode='42501'; end if;
  if v_row.version<>p_version then raise exception 'GROUP_PRESENTATION_CONFLICT' using errcode='40001'; end if;
  insert into public.study_group_presentation_cleanup(storage_path,group_id,owner_id,cleanup_user_id)
    select f->>'path',p_group_id,v_row.created_by,auth.uid() from jsonb_array_elements(v_row.attachments) f
    on conflict(storage_path) do update set cleanup_user_id=excluded.cleanup_user_id;
  delete from public.study_group_presentations where id=p_id;
end;
$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
  values('xelay-group-presentations','xelay-group-presentations',false,52428800,array['application/pdf','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/jpeg','image/png','image/webp'])
  on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;

create or replace function public.xelay_can_upload_group_presentation_file(p_path text,p_metadata jsonb)
returns boolean language plpgsql security definer set search_path = '' as $$
declare v_group uuid;v_count bigint;v_size bigint;
begin
  if auth.uid() is null or not public.xelay_material_file_path_valid(p_path) or split_part(p_path,'/',2)<>auth.uid()::text then return false; end if;
  v_group:=split_part(p_path,'/',1)::uuid;
  if not public.xelay_can_read_group_presentations(v_group) or coalesce(p_metadata->>'size','') !~ '^[0-9]+$' then return false; end if;
  if exists(select 1 from public.study_group_presentation_cleanup where storage_path=p_path) then return false; end if;
  if (p_metadata->>'size')::bigint not between 1 and 52428800 or public.xelay_material_file_mime(p_path) is distinct from p_metadata->>'mimetype'
    or p_metadata->>'mimetype' not in('application/pdf','application/vnd.ms-powerpoint','application/vnd.openxmlformats-officedocument.presentationml.presentation','application/msword','application/vnd.openxmlformats-officedocument.wordprocessingml.document','image/jpeg','image/png','image/webp') then return false; end if;
  perform pg_advisory_xact_lock(hashtext('xelay-group-presentation-files'),hashtext(auth.uid()::text));
  select count(*),coalesce(sum(case when coalesce(metadata->>'size','') ~ '^[0-9]+$' then (metadata->>'size')::bigint else 52428800 end),0)
    into v_count,v_size from storage.objects where bucket_id='xelay-group-presentations' and split_part(name,'/',2)=auth.uid()::text;
  if v_count>=200 or v_size+(p_metadata->>'size')::bigint>1073741824 then raise exception 'GROUP_PRESENTATION_QUOTA' using errcode='54000'; end if;
  return true;
end;
$$;
create or replace function public.xelay_can_read_group_presentation_file(p_path text)
returns boolean language plpgsql stable security definer set search_path = '' as $$
declare v_group uuid;
begin
  if auth.uid() is null or not public.xelay_material_file_path_valid(p_path) then return false; end if;
  v_group:=split_part(p_path,'/',1)::uuid;
  return public.xelay_can_read_group_presentations(v_group) and (
    split_part(p_path,'/',2)=auth.uid()::text
    or exists(select 1 from public.study_group_presentation_cleanup c where c.storage_path=p_path and c.cleanup_user_id=auth.uid())
    or exists(select 1 from public.study_group_presentations p where p.group_id=v_group and p.attachments @> jsonb_build_array(jsonb_build_object('path',p_path))));
end;
$$;
create or replace function public.xelay_can_remove_group_presentation_file(p_path text)
returns boolean language plpgsql volatile security definer set search_path = '' as $$
declare v_group uuid;
begin
  if auth.uid() is null or not public.xelay_material_file_path_valid(p_path) then return false; end if;
  v_group:=split_part(p_path,'/',1)::uuid;
  -- Serialize cleanup with publication binding; a committed attachment wins over cleanup.
  perform pg_advisory_xact_lock(hashtext('xelay-group-presentation-file'),hashtext(p_path));
  return public.xelay_can_read_group_presentations(v_group)
    and (split_part(p_path,'/',2)=auth.uid()::text or public.xelay_can_moderate_group_presentations(v_group))
    and not exists(select 1 from public.study_group_presentations p where p.attachments @> jsonb_build_array(jsonb_build_object('path',p_path)));
end;
$$;

create policy "Members upload their presentation files" on storage.objects for insert to authenticated
  with check(bucket_id='xelay-group-presentations' and public.xelay_can_upload_group_presentation_file(name,metadata));
create policy "Classmates read shared presentation files" on storage.objects for select to authenticated
  using(bucket_id='xelay-group-presentations' and public.xelay_can_read_group_presentation_file(name));
create policy "Authors clean detached presentation files" on storage.objects for delete to authenticated
  using(bucket_id='xelay-group-presentations' and public.xelay_can_remove_group_presentation_file(name));

-- Boundaries protect this new private bucket even if a permissive legacy policy exists.
create policy "Student presentation upload boundary" on storage.objects as restrictive for insert to anon,authenticated
  with check(case when bucket_id='xelay-group-presentations' then case when auth.uid() is null then false else public.xelay_can_upload_group_presentation_file(name,metadata) end else true end);
create policy "Student presentation read boundary" on storage.objects as restrictive for select to anon,authenticated
  using(case when bucket_id='xelay-group-presentations' then case when auth.uid() is null then false else public.xelay_can_read_group_presentation_file(name) end else true end);
create policy "Student presentation cleanup boundary" on storage.objects as restrictive for delete to anon,authenticated
  using(case when bucket_id='xelay-group-presentations' then case when auth.uid() is null then false else public.xelay_can_remove_group_presentation_file(name) end else true end);
create policy "Student presentation overwrite boundary" on storage.objects as restrictive for update to anon,authenticated
  using(bucket_id<>'xelay-group-presentations') with check(bucket_id<>'xelay-group-presentations');

revoke all on function public.xelay_can_read_group_presentations(uuid),public.xelay_can_moderate_group_presentations(uuid),public.xelay_group_presentations(uuid),public.xelay_save_group_presentation(uuid,uuid,integer,jsonb),public.xelay_delete_group_presentation(uuid,uuid,integer),public.xelay_can_upload_group_presentation_file(text,jsonb),public.xelay_can_read_group_presentation_file(text),public.xelay_can_remove_group_presentation_file(text) from public,anon,authenticated,service_role;
grant execute on function public.xelay_can_read_group_presentations(uuid),public.xelay_can_moderate_group_presentations(uuid),public.xelay_group_presentations(uuid),public.xelay_save_group_presentation(uuid,uuid,integer,jsonb),public.xelay_delete_group_presentation(uuid,uuid,integer),public.xelay_can_upload_group_presentation_file(text,jsonb),public.xelay_can_read_group_presentation_file(text),public.xelay_can_remove_group_presentation_file(text) to authenticated;
commit;
