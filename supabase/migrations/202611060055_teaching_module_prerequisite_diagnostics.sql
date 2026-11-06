-- Keep existing progression rules, and tell the course owner which dependency failed.
begin;
set local lock_timeout='5s';

create function public.xelay_private_module_prerequisite_mismatch(p_reason text,p_module uuid,p_dependency uuid,p_group uuid default null)
returns void language plpgsql stable security definer set search_path='' as $$
declare v_details jsonb;
begin
  select jsonb_strip_nulls(jsonb_build_object('reason',p_reason,'module_title',m.title,
    'prerequisite_module_title',parent.title,'prerequisite_title',coalesce(t.title,r.title),'group_name',g.group_name))
    into v_details
  from public.teaching_course_modules m
  left join public.teaching_course_module_items d on d.id=p_dependency and d.course_id=m.course_id
  left join public.teaching_course_modules parent on parent.id=d.module_id
  left join public.teaching_tests t on d.resource_type='test' and t.id=d.resource_id and t.course_id=m.course_id
  left join public.teaching_items r on d.resource_type<>'test' and r.id=d.resource_id and r.course_id=m.course_id
  left join public.study_groups g on g.id=p_group
  where m.id=p_module;
  raise exception 'COURSE_MODULE_TARGET_MISMATCH' using detail=coalesce(v_details,jsonb_build_object('reason',p_reason))::text;
end $$;

create or replace function public.xelay_private_module_validate_graph(p_course uuid)
returns void language plpgsql stable security definer set search_path='' as $$
declare v_edge record;v_group uuid;v_user uuid;
begin
  -- Module-level dependencies still apply when the module has no steps yet.
  for v_edge in select m.id module_id,m.group_ids,m.status,dep.id dependency,
      i.id dep_item_id,parent.group_ids dep_groups,parent.status dep_status
    from public.teaching_course_modules m
    cross join lateral unnest(m.prerequisite_item_ids)dep(id)
    left join public.teaching_course_module_items i on i.id=dep.id and i.course_id=p_course and i.archived_at is null
    left join public.teaching_course_modules parent on parent.id=i.module_id
    where m.course_id=p_course and m.status<>'archived' loop
    if v_edge.dep_item_id is null or v_edge.dep_status='archived' then
      perform public.xelay_private_module_prerequisite_mismatch('missing',v_edge.module_id,v_edge.dependency);
    end if;
    if not(v_edge.group_ids<@v_edge.dep_groups) then
      select g into v_group from unnest(v_edge.group_ids) g where not(g=any(v_edge.dep_groups)) limit 1;
      perform public.xelay_private_module_prerequisite_mismatch('groups',v_edge.module_id,v_edge.dependency,v_group);
    end if;
    if v_edge.status='published' and v_edge.dep_status<>'published' then
      perform public.xelay_private_module_prerequisite_mismatch('draft',v_edge.module_id,v_edge.dependency);
    end if;
  end loop;
  if exists(with recursive edges as(select i.id,unnest(i.prerequisite_item_ids||m.prerequisite_item_ids) dependency
      from public.teaching_course_module_items i join public.teaching_course_modules m on m.id=i.module_id
      where i.course_id=p_course and i.archived_at is null and m.status<>'archived'),
    -- UNION bounds the walk by reachable pairs even for densely linked modules.
    paths as(select id,dependency from edges union
      select p.id,e.dependency from paths p join edges e on e.id=p.dependency)
    select 1 from paths where id=dependency) then raise exception 'COURSE_MODULE_CYCLE';end if;
  for v_edge in select distinct i.module_id,i.id,i.resource_type,i.resource_id,i.course_id,m.group_ids,m.status,dep.dependency,
      d.resource_type dep_type,d.resource_id dep_resource,d.archived_at dep_archived,dm.group_ids dep_groups,dm.status dep_status
    from public.teaching_course_module_items i join public.teaching_course_modules m on m.id=i.module_id
    cross join lateral unnest(i.prerequisite_item_ids||m.prerequisite_item_ids)dep(dependency)
    left join public.teaching_course_module_items d on d.id=dep.dependency and d.course_id=p_course
    left join public.teaching_course_modules dm on dm.id=d.module_id
    where i.course_id=p_course and i.archived_at is null and m.status<>'archived' loop
    if v_edge.dep_groups is null or v_edge.dep_archived is not null or v_edge.dep_status='archived' then
      perform public.xelay_private_module_prerequisite_mismatch('missing',v_edge.module_id,v_edge.dependency);
    end if;
    if not(v_edge.group_ids<@v_edge.dep_groups) then
      select g into v_group from unnest(v_edge.group_ids) g where not(g=any(v_edge.dep_groups)) limit 1;
      perform public.xelay_private_module_prerequisite_mismatch('groups',v_edge.module_id,v_edge.dependency,v_group);
    end if;
    if v_edge.status='published' and v_edge.dep_status<>'published' then
      perform public.xelay_private_module_prerequisite_mismatch('draft',v_edge.module_id,v_edge.dependency);
    end if;
    foreach v_group in array v_edge.group_ids loop
      for v_user in select id from public.profiles where public.xelay_teaching_is_member(v_group,id) loop
        if public.xelay_private_module_resource_targeted(v_edge.resource_type,v_edge.resource_id,p_course,v_group,v_user)
          and not public.xelay_private_module_resource_targeted(v_edge.dep_type,v_edge.dep_resource,p_course,v_group,v_user)
          -- A draft resource remains preparing until it is separately published.
          and not exists(select 1 from public.teaching_items where id=v_edge.dep_resource and course_id=p_course and status in('draft','scheduled'))
          and not exists(select 1 from public.teaching_tests where id=v_edge.dep_resource and course_id=p_course and status='draft') then
          perform public.xelay_private_module_prerequisite_mismatch('audience',v_edge.module_id,v_edge.dependency,v_group);
        end if;
      end loop;
    end loop;
  end loop;
end $$;

revoke all on function public.xelay_private_module_prerequisite_mismatch(text,uuid,uuid,uuid) from public,anon,authenticated,service_role;
commit;
