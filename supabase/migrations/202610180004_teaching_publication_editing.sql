-- Preserve legacy URL arrays. Names are private publication metadata under the
-- same item/course/group permissions; no new browser-callable RPC or grants.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

create or replace function public.xelay_teaching_normalize_link_labels(p_links jsonb,p_labels jsonb,p_strict boolean default true)
returns jsonb language plpgsql immutable set search_path='' as $$
declare v_key text;v_value jsonb;v_label text;v_result jsonb:='{}'::jsonb;v_count integer:=0;
begin
  if jsonb_typeof(p_links) is distinct from 'array' or jsonb_typeof(p_labels) is distinct from 'object'
    or octet_length(p_labels::text)>16000 then raise exception 'TEACHING_INVALID_INPUT'; end if;
  for v_key,v_value in select key,value from jsonb_each(p_labels) loop
    v_count:=v_count+1;
    if v_count>20 or length(v_key)>2000 or jsonb_typeof(v_value) is distinct from 'string' then
      raise exception 'TEACHING_INVALID_INPUT'; end if;
    v_label:=btrim(v_value #>> '{}');
    if length(v_label)>80 or v_label~'[[:cntrl:]]' or v_label~('['||chr(127)||'-'||chr(159)||']') then
      raise exception 'TEACHING_INVALID_INPUT'; end if;
    if not p_links ? v_key then
      if p_strict then raise exception 'TEACHING_INVALID_INPUT'; end if;
      continue;
    end if;
    if v_label<>'' then v_result:=v_result||jsonb_build_object(v_key,v_label); end if;
  end loop;
  return v_result;
end $$;
revoke all on function public.xelay_teaching_normalize_link_labels(jsonb,jsonb,boolean) from public,anon,authenticated,service_role;

alter table public.teaching_items add column if not exists link_labels jsonb not null default '{}'::jsonb;
do $$ begin
  if not exists(select 1 from pg_constraint where conrelid='public.teaching_items'::regclass and conname='teaching_item_link_labels_valid') then
    alter table public.teaching_items add constraint teaching_item_link_labels_valid
      check(link_labels=public.xelay_teaching_normalize_link_labels(links,link_labels));
  end if;
end $$;

-- Update only the existing resource/copy statements. Every expected old block
-- must match exactly, so a changed prerequisite aborts the whole migration.
-- CREATE OR REPLACE retains existing ACLs and all dispatcher/permission guards.
do $migration$
declare v_body text;v_old text;v_new text;v_expected integer;v_actual integer;v_applied integer;v_nested integer;v_patch record;
begin
  select pg_get_functiondef('public.xelay_teaching_mutate(text,jsonb)'::regprocedure) into v_body;
  for v_patch in select * from (values
    ($old$course_id,kind,title,body,links,attachments,material_date,max_points,category,status,created_by)
        values(v_id,v_source.kind,v_source.title,v_source.body,v_source.links,v_source.attachments,$old$,
     $new$course_id,kind,title,body,links,link_labels,attachments,material_date,max_points,category,status,created_by)
        values(v_id,v_source.kind,v_source.title,v_source.body,v_source.links,v_source.link_labels,v_source.attachments,$new$,1),
    ($old$id,course_id,kind,title,body,links,attachments,material_date,max_points,category,status,published_at,created_by)$old$,
     $new$id,course_id,kind,title,body,links,link_labels,attachments,material_date,max_points,category,status,published_at,created_by)$new$,1),
    ($old$coalesce(p_payload->'links','[]'::jsonb),
        coalesce(p_payload->'attachments','[]'::jsonb),nullif(p_payload->>'material_date','')::date,v_max,v_comment,v_status,$old$,
     $new$coalesce(p_payload->'links','[]'::jsonb),
        public.xelay_teaching_normalize_link_labels(coalesce(p_payload->'links','[]'::jsonb),coalesce(p_payload->'link_labels','{}'::jsonb)),
        coalesce(p_payload->'attachments','[]'::jsonb),nullif(p_payload->>'material_date','')::date,v_max,v_comment,v_status,$new$,1),
    ($old$links=coalesce(p_payload->'links','[]'::jsonb),
        attachments=$old$,
     $new$links=coalesce(p_payload->'links','[]'::jsonb),
        link_labels=public.xelay_teaching_normalize_link_labels(coalesce(p_payload->'links','[]'::jsonb),
          case when p_payload ? 'link_labels' then p_payload->'link_labels' else v_record.link_labels end,p_payload ? 'link_labels'),
        attachments=$new$,1)
  ) as patches(old_body,new_body,expected) loop
    v_old:=v_patch.old_body;v_new:=v_patch.new_body;v_expected:=v_patch.expected;
    v_actual:=(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old);
    v_applied:=(length(v_body)-length(replace(v_body,v_new,'')))/length(v_new);
    v_nested:=(length(v_new)-length(replace(v_new,v_old,'')))/length(v_old);
    if v_applied=v_expected and v_actual=v_expected*v_nested then continue; end if;
    if v_actual<>v_expected or v_applied<>0 then raise exception 'TEACHING_PUBLICATION_MIGRATION_PREREQUISITE'; end if;
    v_body:=replace(v_body,v_old,v_new);
  end loop;
  execute v_body;

  select pg_get_functiondef('public.xelay_classroom_assignment_mutate(text,jsonb)'::regprocedure) into v_body;
  for v_patch in select * from (values
    ($old$id,course_id,kind,title,body,links,attachments,material_date,max_points,category,status,created_by)$old$,
     $new$id,course_id,kind,title,body,links,link_labels,attachments,material_date,max_points,category,status,created_by)$new$,2),
    ($old$v_source.title,v_source.body,v_source.links,v_source.attachments,$old$,
     $new$v_source.title,v_source.body,v_source.links,v_source.link_labels,v_source.attachments,$new$,2),
    ($old$if(select count(*) from public.teaching_item_targets where item_id=v_id)<>1
        or not exists(select 1 from public.teaching_item_targets where item_id=v_id and group_id=v_group) then
        raise exception 'CLASSROOM_EXPLICIT_FORK_REQUIRED'; end if;$old$,
     $new$-- Fresh-semester templates are drafts with no targets. Assigning one
      -- still requires this course's assignment permission and an accepted group.
      if not(v_existing.status='draft' and not exists(select 1 from public.teaching_item_targets where item_id=v_id))
        and ((select count(*) from public.teaching_item_targets where item_id=v_id)<>1
          or not exists(select 1 from public.teaching_item_targets where item_id=v_id and group_id=v_group)) then
        raise exception 'CLASSROOM_EXPLICIT_FORK_REQUIRED'; end if;$new$,1),
    ($old$if not exists(select 1 from public.teaching_item_targets where item_id=v_id and group_id=v_group) then
      raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;$old$,
     $new$if v_existing.status='draft' and not exists(select 1 from public.teaching_item_targets where item_id=v_id) then
      return public.xelay_teaching_mutate('delete_assignment',p_payload);
    end if;
    if not exists(select 1 from public.teaching_item_targets where item_id=v_id and group_id=v_group) then
      raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;$new$,1)
  ) as patches(old_body,new_body,expected) loop
    v_old:=v_patch.old_body;v_new:=v_patch.new_body;v_expected:=v_patch.expected;
    v_actual:=(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old);
    v_applied:=(length(v_body)-length(replace(v_body,v_new,'')))/length(v_new);
    v_nested:=(length(v_new)-length(replace(v_new,v_old,'')))/length(v_old);
    if v_applied=v_expected and v_actual=v_expected*v_nested then continue; end if;
    if v_actual<>v_expected or v_applied<>0 then raise exception 'TEACHING_PUBLICATION_MIGRATION_PREREQUISITE'; end if;
    v_body:=replace(v_body,v_old,v_new);
  end loop;
  execute v_body;
end $migration$;

commit;
