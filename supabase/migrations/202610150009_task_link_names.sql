-- Optional plain-text names for the existing homework and long-term URLs.
-- The URL arrays, legacy homework URL and private-file permissions are retained.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $task_link_names_preflight$
begin
  if to_regclass('public.study_group_homework') is null
    or to_regclass('public.study_group_long_term_tasks') is null
    or to_regprocedure('public.xelay_validate_homework_resources()') is null
    or to_regprocedure('public.xelay_guard_long_term_task_resources()') is null
    or to_regprocedure('public.xelay_lock_study_group_long_term_tasks(uuid)') is null
    or to_regprocedure('public.xelay_save_study_group_long_term_task_resources(uuid,uuid,text,text,text,date,jsonb,jsonb,timestamp with time zone,uuid)') is null then
    raise exception 'TASK_LINK_NAMES_PREREQUISITES_MISSING'
      using hint='Apply homework resources and 202610110002_long_term_task_resources first. No changes were made.';
  end if;
end;
$task_link_names_preflight$;

alter table public.study_group_homework
  add column if not exists resource_link_labels jsonb not null default '{}'::jsonb;
alter table public.study_group_long_term_tasks
  add column if not exists resource_link_labels jsonb not null default '{}'::jsonb;

-- Internal canonicalizer: validate even orphan entries before pruning them.
-- A URL removed by an older client therefore loses only its own title; titles
-- on retained URLs survive, and reordering the array cannot swap their names.
create or replace function public.xelay_normalize_task_resource_link_labels(
  p_labels jsonb,p_resource_links jsonb,p_legacy_url text
)
returns jsonb language plpgsql immutable set search_path = '' as $$
declare
  v_result jsonb:='{}'::jsonb;
  v_entry record;
  v_title text;
  v_legacy_url text:=nullif(btrim(p_legacy_url),'');
begin
  if jsonb_typeof(p_labels) is distinct from 'object'
    or jsonb_typeof(p_resource_links) is distinct from 'array' then
    raise exception 'TASK_RESOURCE_LINK_LABELS_INVALID' using errcode='22023';
  end if;
  if octet_length(p_labels::text)>32768
    or (select count(*) from jsonb_object_keys(p_labels))>10
    or jsonb_array_length(p_resource_links)>10 then
    raise exception 'TASK_RESOURCE_LINK_LABELS_INVALID' using errcode='22023';
  end if;
  for v_entry in select key,value from jsonb_each(p_labels) loop
    if length(v_entry.key) not between 1 and 2048
      or v_entry.key !~* '^https?://[^/?#[:space:]\\@]+([/?#][^[:space:]\\]*)?$'
      or v_entry.key ~ '[[:cntrl:]]'
      or v_entry.key ~ U&'[\0001-\001F\007F-\009F]'
      or jsonb_typeof(v_entry.value) is distinct from 'string' then
      raise exception 'TASK_RESOURCE_LINK_LABELS_INVALID' using errcode='22023';
    end if;
    v_title:=btrim(v_entry.value #>> '{}');
    if length(v_title)>80 or v_title ~ '[[:cntrl:]]'
      or v_title ~ U&'[\0001-\001F\007F-\009F]' then
      raise exception 'TASK_RESOURCE_LINK_LABELS_INVALID' using errcode='22023';
    end if;
    if v_title<>'' and (p_resource_links @> jsonb_build_array(v_entry.key)
      or v_entry.key=v_legacy_url) then
      v_result:=v_result||jsonb_build_object(v_entry.key,v_title);
    end if;
  end loop;
  return v_result;
end;
$$;

-- SECURITY DEFINER is limited to the revoked internal canonicalizer. These
-- triggers change only NEW's title metadata and never query private content.
-- The zz prefix runs after the existing homework validator has mirrored url.
create or replace function public.xelay_normalize_homework_link_labels()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.resource_link_labels:=public.xelay_normalize_task_resource_link_labels(
    new.resource_link_labels,new.resource_links,new.url);
  return new;
end;
$$;
create or replace function public.xelay_normalize_long_term_task_link_labels()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  new.resource_link_labels:=public.xelay_normalize_task_resource_link_labels(
    new.resource_link_labels,new.resource_links,null);
  return new;
end;
$$;

drop trigger if exists zz_study_group_homework_link_labels on public.study_group_homework;
create trigger zz_study_group_homework_link_labels before insert or update
  on public.study_group_homework for each row
  execute function public.xelay_normalize_homework_link_labels();
drop trigger if exists zz_study_group_long_term_task_link_labels on public.study_group_long_term_tasks;
create trigger zz_study_group_long_term_task_link_labels before insert or update
  on public.study_group_long_term_tasks for each row
  execute function public.xelay_normalize_long_term_task_link_labels();

-- A separately named RPC avoids PostgREST overload ambiguity. All parameters
-- are required, including the explicit label map; the original RPC keeps its
-- signature and behavior for clients which have not refreshed yet.
create or replace function public.xelay_save_study_group_long_term_task_resources_named(
  p_group_id uuid,p_task_id uuid,p_subject text,p_title text,p_description text,p_due_date date,
  p_resource_links jsonb,p_resource_attachments jsonb,
  p_expected_updated_at timestamptz,p_create_request_id uuid,p_resource_link_labels jsonb
)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_id uuid;
  v_task public.study_group_long_term_tasks%rowtype;
  v_labels jsonb;
  v_subject text;
  v_title text:=btrim(p_title);
  v_description text:=coalesce(p_description,'');
begin
  -- The same appointment/member lock and private resource triggers as the
  -- original RPC remain authoritative, including ownership of uploaded files.
  perform public.xelay_lock_study_group_long_term_tasks(p_group_id);
  v_labels:=public.xelay_normalize_task_resource_link_labels(
    p_resource_link_labels,p_resource_links,null);
  if not public.xelay_long_term_task_resources_valid(p_group_id,p_resource_links,p_resource_attachments) then
    raise exception 'LONG_TERM_TASK_RESOURCE_INVALID_INPUT' using errcode='22023';
  end if;
  v_subject:=btrim(regexp_replace(p_subject,
    U&'[\0009-\000D\0020\0085\00A0\1680\2000-\200A\2028\2029\202F\205F\3000\FEFF]+',' ','g'));
  if p_task_id is null then
    if p_expected_updated_at is not null then
      raise exception 'LONG_TERM_TASK_RESOURCE_INVALID_INPUT' using errcode='22023';
    end if;
    if p_create_request_id is not null then
      select * into v_task from public.study_group_long_term_tasks
        where group_id=p_group_id and created_by=auth.uid() and create_request_id=p_create_request_id
        for update;
      if found then
        -- Only an identical normalized CREATE is a replay. A reused request
        -- with changed titles or resources cannot overwrite a later edit.
        if row(v_task.subject,v_task.title,v_task.description,v_task.due_date,
          v_task.resource_links,v_task.resource_attachments,v_task.resource_link_labels)
          is distinct from row(v_subject,v_title,v_description,p_due_date,
            p_resource_links,p_resource_attachments,v_labels) then
          raise exception 'LONG_TERM_TASK_CONFLICT' using errcode='40001';
        end if;
        return v_task.id;
      end if;
    end if;
    insert into public.study_group_long_term_tasks(group_id,subject,title,description,due_date,
      resource_links,resource_attachments,resource_link_labels,created_by,create_request_id)
      values(p_group_id,p_subject,p_title,p_description,p_due_date,
        p_resource_links,p_resource_attachments,v_labels,auth.uid(),p_create_request_id)
      returning id into v_id;
  else
    if p_create_request_id is not null then
      raise exception 'LONG_TERM_TASK_RESOURCE_INVALID_INPUT' using errcode='22023';
    end if;
    select * into v_task from public.study_group_long_term_tasks
      where id=p_task_id and group_id=p_group_id for update;
    if not found then raise exception 'LONG_TERM_TASK_NOT_FOUND' using errcode='22023'; end if;
    if p_expected_updated_at is not null and (not isfinite(p_expected_updated_at)
      or p_expected_updated_at is distinct from v_task.updated_at) then
      raise exception 'LONG_TERM_TASK_CONFLICT' using errcode='40001';
    end if;
    update public.study_group_long_term_tasks set subject=p_subject,title=p_title,description=p_description,
      due_date=p_due_date,resource_links=p_resource_links,resource_attachments=p_resource_attachments,
      resource_link_labels=v_labels
      where id=p_task_id and group_id=p_group_id returning id into v_id;
  end if;
  return v_id;
end;
$$;

revoke all on function public.xelay_normalize_task_resource_link_labels(jsonb,jsonb,text),
  public.xelay_normalize_homework_link_labels(),public.xelay_normalize_long_term_task_link_labels(),
  public.xelay_save_study_group_long_term_task_resources_named(uuid,uuid,text,text,text,date,jsonb,jsonb,timestamptz,uuid,jsonb)
  from public,anon,authenticated,service_role;
grant execute on function public.xelay_save_study_group_long_term_task_resources_named(
  uuid,uuid,text,text,text,date,jsonb,jsonb,timestamptz,uuid,jsonb) to authenticated;

comment on column public.study_group_homework.resource_link_labels is
  'Optional URL-to-plain-text title map, up to 10 names of 1-80 characters. Empty names use numbered fallbacks; removed URLs lose their names. Includes the existing legacy url when retained.';
comment on column public.study_group_long_term_tasks.resource_link_labels is
  'Optional URL-to-plain-text title map, up to 10 names of 1-80 characters. Keys follow existing resource_links; names are preserved by older clients for retained URLs.';

notify pgrst,'reload schema';
commit;
