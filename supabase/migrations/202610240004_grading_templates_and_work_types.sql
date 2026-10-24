-- Prepared locally. Do not apply before the complete teaching preview is approved.
-- Raw grades and their history are preserved. Coefficients remain multipliers
-- of category sums before caps; this adds presets and explicit group overrides.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$ begin
  if to_regprocedure('public.xelay_teaching_validate_rules(jsonb)') is null
    or to_regprocedure('public.xelay_teaching_mutate(text,jsonb)') is null
    or to_regprocedure('public.xelay_classroom_mutate(text,jsonb)') is null
    or to_regprocedure('public.xelay_teaching_group(uuid)') is null then
    raise exception 'TEACHING_GRADING_PREREQUISITES_MISSING';
  end if;
end $$;

create or replace function public.xelay_private_teaching_presets_valid(p_rules jsonb)
returns boolean language plpgsql immutable set search_path='' as $$
declare v_row jsonb;v_ids text[]:='{}';v_max numeric;
begin
  if not p_rules ? 'presets' then return true; end if;
  if jsonb_typeof(p_rules->'presets') is distinct from 'array' or jsonb_array_length(p_rules->'presets')>30 then return false; end if;
  for v_row in select value from jsonb_array_elements(p_rules->'presets') loop
    if jsonb_typeof(v_row)<>'object' or jsonb_typeof(v_row->'id') is distinct from 'string'
      or length(v_row->>'id') not between 1 and 100 or(v_row->>'id')=any(v_ids)
      or jsonb_typeof(v_row->'name') is distinct from 'string' or length(btrim(v_row->>'name')) not between 1 and 100
      or jsonb_typeof(v_row->'work_type') is distinct from 'string' or length(btrim(v_row->>'work_type')) not between 1 and 100
      or jsonb_typeof(v_row->'category') is distinct from 'string' or length(v_row->>'category')>100
      or jsonb_typeof(v_row->'max_points') is distinct from 'number' then return false; end if;
    v_max:=(v_row->>'max_points')::numeric;
    if v_max<=0 or v_max>10000 or scale(v_max)>2 then return false; end if;
    if v_row->>'category'<>'' and not exists(select 1 from jsonb_array_elements(p_rules->'categories') c where c->>'id'=v_row->>'category') then return false; end if;
    if v_row ? 'submission_format' and(jsonb_typeof(v_row->'submission_format') is distinct from 'string' or v_row->>'submission_format' not in('written','oral','defense')) then return false; end if;
    v_ids:=array_append(v_ids,v_row->>'id');
  end loop;
  return true;
exception when others then return false;
end $$;
revoke all on function public.xelay_private_teaching_presets_valid(jsonb) from public,anon,authenticated;

do $validator$
declare v_body text;v_old text:='  return true;';
begin
  select replace(pg_get_functiondef('public.xelay_teaching_validate_rules(jsonb)'::regprocedure),chr(13),'') into v_body;
  if position('teaching_grading_presets_contract' in v_body)>0 then raise exception 'TEACHING_GRADING_ALREADY_INSTALLED'; end if;
  if(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>1 then raise exception 'TEACHING_GRADING_VALIDATOR_DRIFT'; end if;
  execute replace(v_body,v_old,$new$  -- teaching_grading_presets_contract
  return public.xelay_private_teaching_presets_valid(p_rules);$new$);
end $validator$;

alter table public.teaching_course_groups add column grading_rules_override jsonb;
alter table public.teaching_course_groups add column grading_version integer not null default 0 check(grading_version>=0);
alter table public.teaching_course_groups add constraint teaching_group_rules_valid check(grading_rules_override is null or public.xelay_teaching_validate_rules(grading_rules_override));
alter table public.teaching_items add column work_type text not null default '' check(length(work_type)<=100);
alter table public.teaching_activities add column work_type text not null default '' check(length(work_type)<=100);

create or replace function public.xelay_private_teaching_group_rules(p_course uuid,p_group uuid)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(g.grading_rules_override,c.grading_rules) from public.teaching_courses c
  left join public.teaching_course_groups g on g.course_id=c.id and g.group_id=p_group
  where c.id=p_course;
$$;
revoke all on function public.xelay_private_teaching_group_rules(uuid,uuid) from public,anon,authenticated;

create or replace function public.xelay_teaching_save_group_grading(p_course_id uuid,p_group_id uuid,p_version integer,p_course_version integer,p_rules jsonb,p_expected_user_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_course public.teaching_courses%rowtype;v_group public.teaching_course_groups%rowtype;v_rules jsonb;
begin
  if p_expected_user_id is distinct from v_uid then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501'; end if;
  perform public.xelay_teaching_lock_course(p_course_id,'manage');
  select * into v_course from public.teaching_courses where id=p_course_id;
  if v_course.version is distinct from p_course_version then raise exception 'TEACHING_CONFLICT'; end if;
  select * into v_group from public.teaching_course_groups where course_id=p_course_id and group_id=p_group_id and status='accepted' for update;
  if not found then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  if v_group.grading_version is distinct from p_version then raise exception 'TEACHING_CONFLICT'; end if;
  v_rules:=coalesce(nullif(p_rules,'null'::jsonb),v_course.grading_rules);
  if not public.xelay_teaching_validate_rules(v_rules) then raise exception 'TEACHING_INVALID_INPUT'; end if;
  if exists(select 1 from public.teaching_activities a where a.course_id=p_course_id and a.group_id=p_group_id and a.category<>''
    and not exists(select 1 from jsonb_array_elements(v_rules->'categories') c where c->>'id'=a.category))
    or exists(select 1 from public.teaching_items i join public.teaching_item_targets t on t.item_id=i.id and t.group_id=p_group_id
      where i.course_id=p_course_id and i.category<>'' and not exists(select 1 from jsonb_array_elements(v_rules->'categories') c where c->>'id'=i.category)) then raise exception 'TEACHING_CATEGORY_IN_USE'; end if;
  update public.teaching_course_groups set grading_rules_override=nullif(p_rules,'null'::jsonb),grading_version=grading_version+1 where id=v_group.id returning * into v_group;
  return jsonb_build_object('id',v_group.id,'version',v_group.grading_version);
end $$;
revoke all on function public.xelay_teaching_save_group_grading(uuid,uuid,integer,integer,jsonb,uuid) from public,anon;
grant execute on function public.xelay_teaching_save_group_grading(uuid,uuid,integer,integer,jsonb,uuid) to authenticated;

-- Extend only category membership checks. Preserve all existing verification,
-- permissions, optimistic versions, lesson/date, grading and material checks.
do $patches$
declare v_row record;v_body text;v_old text;v_new text;v_count integer;
begin
  for v_row in select * from(values
    (1,$old$if v_status<>'' and not exists(select 1 from jsonb_array_elements(v_course.grading_rules->'categories') k where k->>'id'=v_status) then raise exception 'TEACHING_INVALID_INPUT'; end if;$old$,
      $new$if v_status<>'' and exists(select 1 from jsonb_array_elements(p_payload->'targets') target
        where not exists(select 1 from jsonb_array_elements(public.xelay_private_teaching_group_rules(v_course_id,(target->>'group_id')::uuid)->'categories') k where k->>'id'=v_status)) then raise exception 'TEACHING_INVALID_INPUT'; end if;$new$),
    (2,$old$if coalesce(p_payload->>'category','')<>'' and not exists(select 1 from jsonb_array_elements(v_course.grading_rules->'categories') k
      where k->>'id'=p_payload->>'category') then raise exception 'TEACHING_INVALID_INPUT'; end if;$old$,
      $new$if coalesce(p_payload->>'category','')<>'' and not exists(select 1 from jsonb_array_elements(public.xelay_private_teaching_group_rules(v_course_id,v_group_id)->'categories') k
      where k->>'id'=p_payload->>'category') then raise exception 'TEACHING_INVALID_INPUT'; end if;$new$),
    (3,$old$if exists(select 1 from public.teaching_activities a where a.course_id=v_course_id and a.category<>''
      and not exists(select 1 from jsonb_array_elements(v_rules->'categories') k where k->>'id'=a.category))
      or exists(select 1 from public.teaching_items i where i.course_id=v_course_id and i.category<>''
        and not exists(select 1 from jsonb_array_elements(v_rules->'categories') k where k->>'id'=i.category)) then raise exception 'TEACHING_CATEGORY_IN_USE'; end if;$old$,
      $new$if exists(select 1 from public.teaching_activities a left join public.teaching_course_groups link on link.course_id=a.course_id and link.group_id=a.group_id
      where a.course_id=v_course_id and a.category<>'' and not exists(select 1 from jsonb_array_elements(coalesce(link.grading_rules_override,v_rules)->'categories') k where k->>'id'=a.category))
      or exists(select 1 from public.teaching_items i join public.teaching_item_targets target on target.item_id=i.id
        left join public.teaching_course_groups link on link.course_id=i.course_id and link.group_id=target.group_id
        where i.course_id=v_course_id and i.category<>'' and not exists(select 1 from jsonb_array_elements(coalesce(link.grading_rules_override,v_rules)->'categories') k where k->>'id'=i.category)) then raise exception 'TEACHING_CATEGORY_IN_USE'; end if;$new$),
    (4,$old$    delete from public.teaching_item_targets where item_id=v_record.id;$old$,
      $new$    -- Classification is part of the canonical versioned save, before
    -- receipt storage. A receipt replay returns above without any side effects.
    if v_kind='assignment' and p_payload ? 'work_type' then
      if jsonb_typeof(p_payload->'work_type') is distinct from 'string' or length(p_payload->>'work_type')>100 then raise exception 'TEACHING_INVALID_INPUT'; end if;
      update public.teaching_items set work_type=btrim(p_payload->>'work_type') where id=v_record.id returning * into v_record;
      update public.teaching_activities set work_type=v_record.work_type where item_id=v_record.id;
    end if;
    delete from public.teaching_item_targets where item_id=v_record.id;$new$),
    (5,$old$    v_result:=jsonb_build_object('id',v_activity.id,'version',v_activity.version);$old$,
      $new$    if p_payload ? 'work_type' then
      if jsonb_typeof(p_payload->'work_type') is distinct from 'string' or length(p_payload->>'work_type')>100 then raise exception 'TEACHING_INVALID_INPUT'; end if;
      update public.teaching_activities set work_type=btrim(p_payload->>'work_type') where id=v_activity.id returning * into v_activity;
    end if;
    v_result:=jsonb_build_object('id',v_activity.id,'version',v_activity.version);$new$)
  ) patch(id,old_text,new_text) order by id loop
    select replace(pg_get_functiondef('public.xelay_teaching_mutate(text,jsonb)'::regprocedure),chr(13),'') into v_body;
    v_old:=replace(v_row.old_text,chr(13),'');v_new:=replace(v_row.new_text,chr(13),'');
    v_count:=(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old);
    if v_count<>1 then raise exception 'TEACHING_GRADING_PATCH_DRIFT_%',v_row.id; end if;
    execute replace(v_body,v_old,v_new);
  end loop;
end $patches$;

-- Copy the classification from the same locked source snapshot as content.
-- This also preserves it when a shared assignment is forked for one group.
do $copy_type$
declare v_body text;v_old text;v_new text;
begin
  select replace(pg_get_functiondef('public.xelay_classroom_assignment_mutate(text,jsonb)'::regprocedure),chr(13),'') into v_body;
  v_old:='v_source.material_date,v_source.max_points,v_source.category,''draft'',v_uid,v_source.submission_format);';
  v_new:='v_source.material_date,v_source.max_points,v_source.category,''draft'',v_uid,v_source.submission_format,v_source.work_type);';
  if(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>2 then raise exception 'TEACHING_COPY_WORK_TYPE_VALUES_DRIFT'; end if;
  v_body:=replace(v_body,v_old,v_new);
  v_old:='insert into public.teaching_items(id,course_id,kind,title,body,links,link_labels,attachments,material_date,max_points,category,status,created_by,submission_format)';
  v_new:='insert into public.teaching_items(id,course_id,kind,title,body,links,link_labels,attachments,material_date,max_points,category,status,created_by,submission_format,work_type)';
  if(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>2 then raise exception 'TEACHING_COPY_WORK_TYPE_COLUMNS_DRIFT'; end if;
  execute replace(v_body,v_old,v_new);
  select replace(pg_get_functiondef('public.xelay_teaching_mutate(text,jsonb)'::regprocedure),chr(13),'') into v_body;
  v_old:='v_source.max_points,v_source.category,''draft'',v_uid,v_source.submission_format);';
  v_new:='v_source.max_points,v_source.category,''draft'',v_uid,v_source.submission_format,v_source.work_type);';
  if(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>1 then raise exception 'TEACHING_SEMESTER_WORK_TYPE_VALUES_DRIFT'; end if;
  v_body:=replace(v_body,v_old,v_new);
  v_old:='course_id,kind,title,body,links,link_labels,attachments,material_date,max_points,category,status,created_by,submission_format)';
  v_new:='course_id,kind,title,body,links,link_labels,attachments,material_date,max_points,category,status,created_by,submission_format,work_type)';
  if(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>1 then raise exception 'TEACHING_SEMESTER_WORK_TYPE_COLUMNS_DRIFT'; end if;
  execute replace(v_body,v_old,v_new);
end $copy_type$;

create or replace function public.xelay_teaching_classified_activity(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_course uuid;v_group uuid;v_id uuid;
begin
  if nullif(p_payload->>'expected_user_id','')::uuid is distinct from v_uid then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501'; end if;
  if p_payload ? 'work_type' and(jsonb_typeof(p_payload->'work_type') is distinct from 'string' or length(p_payload->>'work_type')>100) then raise exception 'TEACHING_INVALID_INPUT'; end if;
  v_course:=nullif(p_payload->>'course_id','')::uuid;v_group:=nullif(p_payload->>'group_id','')::uuid;v_id:=nullif(p_payload->>'id','')::uuid;
  if coalesce((p_payload->>'version')::integer,0)=0 and v_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-create:'||v_uid::text||':save_activity:'||v_id::text,0));
  end if;
  perform public.xelay_teaching_lock_course(v_course,'grades');
  if not exists(select 1 from public.teaching_course_groups where course_id=v_course and group_id=v_group and status='accepted') then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  return public.xelay_teaching_mutate('save_activity',p_payload);
end $$;
revoke all on function public.xelay_teaching_classified_activity(jsonb) from public,anon;
grant execute on function public.xelay_teaching_classified_activity(jsonb) to authenticated;

create or replace function public.xelay_teaching_classified_assignment(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_course uuid;v_group uuid;v_id uuid;
begin
  if nullif(p_payload->>'expected_user_id','')::uuid is distinct from v_uid then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501'; end if;
  if p_action not in('save_group_assignment','copy_assignment') then raise exception 'TEACHING_INVALID_ACTION'; end if;
  if p_payload ? 'work_type' and(jsonb_typeof(p_payload->'work_type') is distinct from 'string' or length(p_payload->>'work_type')>100) then raise exception 'TEACHING_INVALID_INPUT'; end if;
  v_id:=nullif(p_payload->>'id','')::uuid;
  if v_id is null then raise exception 'TEACHING_INVALID_INPUT'; end if;
  -- Keep the same request -> course lock order as the canonical dispatcher.
  perform pg_advisory_xact_lock(hashtextextended('xelay:classroom-request:'||v_uid::text||':'||p_action||':'||v_id::text,0));
  if p_action='copy_assignment' then
    select course_id into v_course from public.teaching_items where id=nullif(p_payload->>'source_item_id','')::uuid and kind='assignment';
    v_group:=nullif(p_payload->>'destination_group_id','')::uuid;
  else
    v_course:=nullif(p_payload->>'course_id','')::uuid;
    v_group:=nullif(p_payload->'targets'->0->>'group_id','')::uuid;
  end if;
  perform public.xelay_teaching_lock_course(v_course,'assignments');
  if not exists(select 1 from public.teaching_course_groups where course_id=v_course and group_id=v_group and status='accepted') then raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  return public.xelay_classroom_mutate(p_action,p_payload);
end $$;
revoke all on function public.xelay_teaching_classified_assignment(text,jsonb) from public,anon;
grant execute on function public.xelay_teaching_classified_assignment(text,jsonb) to authenticated;

create or replace function public.xelay_private_teaching_activity_work_type()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.item_id is not null then select i.work_type into new.work_type from public.teaching_items i where i.id=new.item_id; end if;
  new.work_type:=coalesce(new.work_type,'');
  return new;
end $$;
revoke all on function public.xelay_private_teaching_activity_work_type() from public,anon,authenticated;
create trigger xelay_teaching_activity_work_type before insert or update of item_id on public.teaching_activities
  for each row execute function public.xelay_private_teaching_activity_work_type();

-- The group RPC's course and grade projections must agree for every client,
-- including students with no grades yet. It already checks own membership.
do $group_projection$
declare v_body text;v_old text;v_new text;
begin
  select replace(pg_get_functiondef('public.xelay_teaching_group(uuid)'::regprocedure),chr(13),'') into v_body;
  v_old:='to_jsonb(c)||jsonb_build_object(''teacher_name'',p.full_name,''link_id'',g.id,''subject_id'',g.subject_id)';
  v_new:='to_jsonb(c)||jsonb_build_object(''teacher_name'',p.full_name,''link_id'',g.id,''subject_id'',g.subject_id,''grading_rules'',coalesce(g.grading_rules_override,c.grading_rules),''grading_scope'',case when g.grading_rules_override is null then ''course'' else ''group'' end)';
  if(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>1 then raise exception 'TEACHING_GROUP_RULES_PROJECTION_DRIFT'; end if;
  v_body:=replace(v_body,v_old,v_new);
  v_old:='''course_title'',c.title,''grading_rules'',c.grading_rules';
  v_new:='''course_title'',c.title,''grading_rules'',coalesce(g.grading_rules_override,c.grading_rules)';
  if(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old)<>1 then raise exception 'TEACHING_GROUP_GRADES_PROJECTION_DRIFT'; end if;
  execute replace(v_body,v_old,v_new);
end $group_projection$;

notify pgrst,'reload schema';
commit;
