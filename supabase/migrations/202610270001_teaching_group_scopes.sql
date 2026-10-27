-- Local preparation: explicit colleague audiences, independent from authorship.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

do $$ begin
  if to_regprocedure('public.xelay_teaching_has_current_access(uuid)') is null
    or to_regprocedure('public.xelay_academic_group_teachers(uuid)') is null
    or to_regprocedure('public.xelay_teaching_material_file_access(uuid,text)') is null
    or has_function_privilege('authenticated','public.xelay_teaching_seminars(uuid)','execute') then
    raise exception 'TEACHING_GROUP_SCOPE_PREREQUISITES_MISSING';
  end if;
end $$;

alter table public.teaching_course_teachers
  add column group_scope text not null default 'all',
  add column group_ids uuid[] not null default '{}'::uuid[],
  add constraint teaching_colleague_group_scope_valid check(
    (group_scope='all' and cardinality(group_ids)=0)
    or(group_scope='selected' and cardinality(group_ids) between 1 and 100 and array_position(group_ids,null) is null));

create function public.xelay_teaching_group_permissions(p_course_id uuid,p_group_id uuid,p_user_id uuid)
returns text[] language sql stable security definer set search_path='' as $$
  select case when exists(select 1 from public.teaching_courses c where c.id=p_course_id and c.owner_id=p_user_id)
    then public.xelay_teaching_permissions(p_course_id,p_user_id)
    when exists(select 1 from public.teaching_course_teachers t
      join public.teaching_course_groups g on g.course_id=t.course_id and g.group_id=p_group_id and g.status='accepted'
      where t.course_id=p_course_id and t.user_id=p_user_id and t.status='accepted'
        and(t.group_scope='all' or p_group_id=any(t.group_ids)))
    then public.xelay_teaching_permissions(p_course_id,p_user_id) else '{}'::text[] end;
$$;
revoke all on function public.xelay_teaching_group_permissions(uuid,uuid,uuid) from public,anon,authenticated,service_role;

create function public.xelay_private_assert_teaching_group(p_course uuid,p_group uuid,p_permission text)
returns void language plpgsql volatile security definer set search_path='' as $$
begin
  perform public.xelay_teaching_lock_course(p_course,p_permission);
  if p_group is null or not p_permission=any(public.xelay_teaching_group_permissions(p_course,p_group,auth.uid()))
    or not exists(select 1 from public.teaching_course_groups where course_id=p_course and group_id=p_group and status='accepted') then
    raise exception 'TEACHING_GROUP_FORBIDDEN' using errcode='42501';
  end if;
end $$;
revoke all on function public.xelay_private_assert_teaching_group(uuid,uuid,text) from public,anon,authenticated,service_role;

create function public.xelay_private_validate_colleague_scope(p_course uuid,p_payload jsonb)
returns void language plpgsql volatile security definer set search_path='' as $$
declare v_groups uuid[];
begin
  perform public.xelay_teaching_lock_course(p_course,'manage');
  if p_payload->>'group_scope' is distinct from 'selected'
    or jsonb_typeof(p_payload->'group_ids') is distinct from 'array'
    or jsonb_array_length(p_payload->'group_ids')>100 then raise exception 'TEACHING_GROUP_SCOPE_REQUIRED' using errcode='22023'; end if;
  if exists(select 1 from jsonb_array_elements(p_payload->'group_ids') g
    where jsonb_typeof(g) is distinct from 'string' or g#>>'{}' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$') then
    raise exception 'TEACHING_GROUP_SCOPE_INVALID' using errcode='22023'; end if;
  select coalesce(array_agg(value::uuid),'{}') into v_groups from jsonb_array_elements_text(p_payload->'group_ids');
  if cardinality(v_groups)<>(select count(distinct g) from unnest(v_groups) g)
    or(p_payload->>'group_scope'='all' and cardinality(v_groups)<>0)
    or(p_payload->>'group_scope'='selected' and cardinality(v_groups)=0)
    or exists(select 1 from unnest(v_groups) g where not exists(select 1 from public.teaching_course_groups l
      where l.course_id=p_course and l.group_id=g and l.status='accepted')) then
    raise exception 'TEACHING_GROUP_SCOPE_INVALID' using errcode='22023'; end if;
end $$;
revoke all on function public.xelay_private_validate_colleague_scope(uuid,jsonb) from public,anon,authenticated,service_role;

create function public.xelay_teaching_find_colleague(p_course_id uuid,p_username text)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_name text;v_result jsonb;
begin
  perform public.xelay_teaching_lock_course(p_course_id,'manage');
  v_name:=lower(regexp_replace(btrim(coalesce(p_username,'')),'^@',''));
  if v_name !~ '^[[:alnum:]][[:alnum:]_.-]{2,29}$' then raise exception 'TEACHING_COLLEAGUE_USERNAME_INVALID' using errcode='22023'; end if;
  select jsonb_build_object('user_id',p.id,'username',p.username,'full_name',p.full_name,
    'department',r.department,'position',r.position,'status',coalesce(t.status,'available')) into v_result
    from public.profiles p join public.teacher_verification_requests r on r.user_id=p.id
    join public.teaching_courses c on c.id=p_course_id and c.university_id=r.university_id
    left join public.teaching_course_teachers t on t.course_id=c.id and t.user_id=p.id
    where lower(p.username)=v_name and p.id<>c.owner_id
      and public.xelay_teaching_is_verified(p.id) and public.xelay_teaching_has_current_access(p.id);
  return v_result;
end $$;
revoke all on function public.xelay_teaching_find_colleague(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_find_colleague(uuid,text) to authenticated;

-- Check before canonical idempotency receipts, including replays after revocation.
create function public.xelay_private_teaching_mutation_scope(p_action text,p_payload jsonb)
returns void language plpgsql volatile security definer set search_path='' as $$
declare v_course uuid;v_group uuid;v_item public.teaching_items%rowtype;v_target record;v_permission text;
begin
  if p_action in('save_assignment','save_material','save_entry','save_activity') and coalesce((p_payload->>'version')::integer,0)=0 and nullif(p_payload->>'id','') is not null then
    perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-create:'||auth.uid()::text||':'||p_action||':'||(p_payload->>'id')::uuid::text,0));
  elsif p_action='cancel_scheduled_publication' then
    perform pg_advisory_xact_lock(hashtextextended('xelay:cancel-scheduled:'||auth.uid()::text||':'||(p_payload->>'request_id')::uuid::text,0));
  end if;
  if p_action='invite_teacher' then
    perform public.xelay_private_validate_colleague_scope((p_payload->>'course_id')::uuid,p_payload);
  elsif p_action='update_teacher' and(p_payload?'group_scope' or p_payload?'group_ids') then
    select course_id into v_course from public.teaching_course_teachers where id=(p_payload->>'teacher_link_id')::uuid;
    perform public.xelay_private_validate_colleague_scope(v_course,p_payload);
  elsif p_action in('save_assignment','save_material','delete_assignment','cancel_scheduled_publication') then
    select * into v_item from public.teaching_items where id=nullif(p_payload->>'id','')::uuid;
    v_course:=coalesce(v_item.course_id,nullif(p_payload->>'course_id','')::uuid);
    v_permission:=case when p_action='save_material' or v_item.kind='material' then 'materials' else 'assignments' end;
    perform public.xelay_teaching_lock_course(v_course,v_permission);
    if p_action='save_assignment' then
      for v_target in select distinct group_id from(
        select group_id from public.teaching_item_targets where item_id=v_item.id
        union all select(value->>'group_id')::uuid from jsonb_array_elements(case when jsonb_typeof(p_payload->'targets')='array' then p_payload->'targets' else '[]'::jsonb end)
      ) targets order by group_id loop
        perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:'||v_target.group_id::text,0));
      end loop;
    end if;
    for v_target in select group_id from public.teaching_item_targets where item_id=v_item.id loop
      perform public.xelay_private_assert_teaching_group(v_course,v_target.group_id,v_permission);
    end loop;
    if p_action in('save_assignment','save_material') and jsonb_typeof(p_payload->'targets')='array' then
      for v_target in select value from jsonb_array_elements(p_payload->'targets') loop
        v_group:=(v_target.value->>'group_id')::uuid;
        perform public.xelay_private_assert_teaching_group(v_course,v_group,v_permission);
        if p_action='save_assignment' and nullif(p_payload->>'max_points','') is not null then
          perform public.xelay_private_assert_teaching_group(v_course,v_group,'grades');
        end if;
      end loop;
    end if;
  elsif p_action in('sync_roster','save_entry','save_activity') then
    perform public.xelay_private_assert_teaching_group((p_payload->>'course_id')::uuid,(p_payload->>'group_id')::uuid,'grades');
  elsif p_action='request_roster_link' then
    select course_id,group_id into v_course,v_group from public.teaching_entries where id=(p_payload->>'entry_id')::uuid;
    perform public.xelay_private_assert_teaching_group(v_course,v_group,'grades');
  elsif p_action in('save_grade','publish_grades') then
    select course_id,group_id into v_course,v_group from public.teaching_activities where id=(p_payload->>'activity_id')::uuid;
    perform public.xelay_private_assert_teaching_group(v_course,v_group,'grades');
  end if;
  -- delete_material deliberately retains the installed creator-only withdrawal
  -- path, even after teaching permission, scope or verification is revoked.
end $$;
revoke all on function public.xelay_private_teaching_mutation_scope(text,jsonb) from public,anon,authenticated,service_role;

create function public.xelay_private_classroom_mutation_scope(p_action text,p_payload jsonb)
returns void language plpgsql volatile security definer set search_path='' as $$
declare v_course uuid;v_group uuid;v_source uuid;
begin
  if p_action in('copy_assignment','save_group_assignment','delete_group_assignment','review_submission','set_submission_extension') and nullif(p_payload->>'id','') is not null then
    perform pg_advisory_xact_lock(hashtextextended('xelay:classroom-request:'||auth.uid()::text||':'||p_action||':'||(p_payload->>'id')::uuid::text,0));
    if p_action='save_group_assignment' and coalesce((p_payload->>'version')::integer,0)=0 then
      perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-create:'||auth.uid()::text||':save_assignment:'||(p_payload->>'id')::uuid::text,0));
    end if;
  end if;
  if p_action='copy_assignment' then
    v_source:=(p_payload->>'source_item_id')::uuid;
    select course_id into v_course from public.teaching_items where id=v_source;
    perform public.xelay_private_assert_teaching_group(v_course,(p_payload->>'destination_group_id')::uuid,'assignments');
    if not public.xelay_teaching_can_read_item(v_source,auth.uid()) then raise exception 'TEACHING_GROUP_FORBIDDEN' using errcode='42501'; end if;
  elsif p_action in('save_group_assignment','delete_group_assignment') then
    v_course:=nullif(p_payload->>'course_id','')::uuid;
    v_group:=coalesce(nullif(p_payload->>'group_id','')::uuid,nullif(p_payload->'targets'->0->>'group_id','')::uuid);
    if v_course is null then select course_id into v_course from public.teaching_items where id=(p_payload->>'id')::uuid; end if;
    perform public.xelay_private_assert_teaching_group(v_course,v_group,'assignments');
  elsif p_action='set_submission_extension' then
    select course_id into v_course from public.teaching_items where id=(p_payload->>'item_id')::uuid;
    perform public.xelay_private_assert_teaching_group(v_course,(p_payload->>'group_id')::uuid,'assignments');
  elsif p_action='review_submission' then
    select course_id,group_id into v_course,v_group from public.teaching_submissions where id=(p_payload->>'id')::uuid;
    perform 1 from public.teaching_courses where id=v_course for update;
    if not public.xelay_classroom_staff(v_course,v_group,auth.uid()) then raise exception 'TEACHING_GROUP_FORBIDDEN' using errcode='42501'; end if;
  end if;
end $$;
revoke all on function public.xelay_private_classroom_mutation_scope(text,jsonb) from public,anon,authenticated,service_role;

create or replace function public.xelay_teaching_can_read_item(p_item_id uuid,p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.teaching_items i where i.id=p_item_id and i.withdrawn_at is null and(
    ((i.created_by=p_user_id or exists(select 1 from public.teaching_courses c where c.id=i.course_id and c.owner_id=p_user_id)) and not exists(select 1 from public.teaching_item_targets where item_id=i.id)
      and(case when i.kind='assignment' then 'assignments' else 'materials' end)=any(public.xelay_teaching_permissions(i.course_id,p_user_id)))
    or exists(select 1 from public.teaching_item_targets t where t.item_id=i.id and(
      (case when i.kind='assignment' then 'assignments' else 'materials' end)=any(public.xelay_teaching_group_permissions(i.course_id,t.group_id,p_user_id))
      or(i.kind='assignment' and i.status='published' and 'grades'=any(public.xelay_teaching_group_permissions(i.course_id,t.group_id,p_user_id)))
      or(i.status='published' and public.xelay_teaching_is_member(t.group_id,p_user_id)
        and exists(select 1 from public.teaching_course_groups g where g.course_id=i.course_id and g.group_id=t.group_id and g.status='accepted'))))));
$$;
create or replace function public.xelay_classroom_staff(p_course uuid,p_group uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_teaching_group_permissions(p_course,p_group,p_user)&&array['assignments','grades']::text[]
    and exists(select 1 from public.teaching_course_groups l where l.course_id=p_course and l.group_id=p_group and l.status='accepted');
$$;

-- Exact source patches retain the installed grading, material rights, account,
-- idempotency and student-seminar boundaries. Normalize SQL-editor line endings.
create function pg_temp.xelay_group_scope_patch(p_signature text,p_old text,p_new text,p_count integer default 1)
returns void language plpgsql as $$
declare v_body text;v_old text:=replace(p_old,chr(13),'');v_new text:=replace(p_new,chr(13),'');v_matches integer;
begin
  select replace(pg_get_functiondef(to_regprocedure(p_signature)),chr(13),'') into v_body;
  if v_body is null or v_old='' then raise exception 'TEACHING_SCOPE_PATCH_MISSING: %',p_signature; end if;
  v_matches:=(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old);
  if v_matches<>p_count then raise exception 'TEACHING_SCOPE_PATCH_DRIFT: % (%, expected %, anchor %)',p_signature,v_matches,p_count,left(v_old,100); end if;
  execute replace(v_body,v_old,v_new);
end $$;

select pg_temp.xelay_group_scope_patch('public.xelay_teaching_mutate(text,jsonb)',
  '  if p_action is null or jsonb_typeof(p_payload)',E'  perform public.xelay_private_teaching_mutation_scope(p_action,p_payload);\n  if p_action is null or jsonb_typeof(p_payload)');
select pg_temp.xelay_group_scope_patch('public.xelay_classroom_mutate(text,jsonb)',
  E'begin\n  -- teacher_seminar_boundary_contract',E'begin\n  perform public.xelay_private_classroom_mutation_scope(p_action,p_payload);\n  -- teacher_seminar_boundary_contract');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_classified_assignment(text,jsonb)',
  '  perform public.xelay_teaching_lock_course(v_course,''assignments'');',
  '  if p_action=''save_group_assignment'' and coalesce((p_payload->>''version'')::integer,0)=0 then
    perform pg_advisory_xact_lock(hashtextextended(''xelay:teaching-create:''||v_uid::text||'':save_assignment:''||v_id::text,0));end if;
  perform public.xelay_teaching_lock_course(v_course,''assignments'');');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_mutate(text,jsonb)',
  'insert into public.teaching_course_teachers(course_id,user_id,permissions,invited_by)',
  'insert into public.teaching_course_teachers(course_id,user_id,permissions,invited_by,group_scope,group_ids)');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_mutate(text,jsonb)',
  'values(v_course_id,v_user_id,v_permissions,v_uid) on conflict(course_id,user_id) do update set permissions=excluded.permissions,status=''pending'',invited_by=v_uid,updated_at=now()',
  'values(v_course_id,v_user_id,v_permissions,v_uid,p_payload->>''group_scope'',array(select value::uuid from jsonb_array_elements_text(p_payload->''group_ids''))) on conflict(course_id,user_id) do update set permissions=excluded.permissions,status=''pending'',invited_by=v_uid,updated_at=now(),group_scope=excluded.group_scope,group_ids=excluded.group_ids');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_mutate(text,jsonb)',
  'update public.teaching_course_teachers set permissions=v_permissions,status=',
  'update public.teaching_course_teachers set group_scope=case when p_payload?''group_scope'' then p_payload->>''group_scope'' else group_scope end,group_ids=case when p_payload?''group_ids'' then array(select value::uuid from jsonb_array_elements_text(p_payload->''group_ids'')) else group_ids end,permissions=v_permissions,status=');

select pg_temp.xelay_group_scope_patch('public.xelay_classroom_lock_group(uuid,uuid,text)',
  'perform public.xelay_teaching_lock_course(p_course,p_permission);',
  'perform public.xelay_private_assert_teaching_group(p_course,p_group,p_permission);');
select pg_temp.xelay_group_scope_patch('public.xelay_classroom_assignment(uuid,uuid)',
  'v_permissions:=public.xelay_teaching_permissions(v_item.course_id,v_uid);',
  'v_permissions:=public.xelay_teaching_group_permissions(v_item.course_id,p_group_id,v_uid);');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_assignment_lessons(uuid,uuid,date)',
  'public.xelay_teaching_permissions(p_course_id,v_uid)', 'public.xelay_teaching_group_permissions(p_course_id,p_group_id,v_uid)');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_item_json(public.teaching_items,uuid)',
  'public.xelay_teaching_permissions(p_item.course_id,auth.uid())', 'public.xelay_teaching_group_permissions(p_item.course_id,t.group_id,auth.uid())');

-- Course snapshots are also the export source: no out-of-scope journal rows,
-- member names, claim identities, grade history or audience identifiers return.
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_course(uuid)',
  'to_jsonb(l)||jsonb_build_object(''group_name'',g.group_name',
  'to_jsonb(l)||jsonb_build_object(''permissions'',public.xelay_teaching_group_permissions(l.course_id,l.group_id,v_uid),''group_name'',g.group_name');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_course(uuid)',
  '(v_staff or(l.status=', '(cardinality(public.xelay_teaching_group_permissions(l.course_id,l.group_id,v_uid))>0 or(l.status=');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_course(uuid)',
  '(v_grader or(e.user_id=', '(''grades''=any(public.xelay_teaching_group_permissions(e.course_id,e.group_id,v_uid)) or(e.user_id=');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_course(uuid)',
  '(v_grader or exists(select 1 from public.teaching_course_groups l where l.course_id=a.course_id',
  '(''grades''=any(public.xelay_teaching_group_permissions(a.course_id,a.group_id,v_uid)) or exists(select 1 from public.teaching_course_groups l where l.course_id=a.course_id');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_course(uuid)',
  'case when v_grader then to_jsonb(s)', 'case when ''grades''=any(public.xelay_teaching_group_permissions(s.course_id,s.group_id,v_uid)) then to_jsonb(s)');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_course(uuid)',
  'where s.course_id=p_course_id and (v_grader', 'where s.course_id=p_course_id and (''grades''=any(public.xelay_teaching_group_permissions(s.course_id,s.group_id,v_uid))');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_course(uuid)',
  'where a.course_id=p_course_id),''[]''::jsonb) else',
  'where a.course_id=p_course_id and ''grades''=any(public.xelay_teaching_group_permissions(a.course_id,(select e.group_id from public.teaching_entries e where e.id=a.entry_id),v_uid))),''[]''::jsonb) else');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_course(uuid)',
  '(v_grader or q.user_id=v_uid)', '(''grades''=any(public.xelay_teaching_group_permissions(e.course_id,e.group_id,v_uid)) or q.user_id=v_uid)');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_course(uuid)',
  'where g.course_id=p_course_id and g.status=''accepted''',
  'where g.course_id=p_course_id and g.status=''accepted'' and ''grades''=any(public.xelay_teaching_group_permissions(g.course_id,g.group_id,v_uid))');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_course(uuid)',
  'to_jsonb(t)||jsonb_build_object(''full_name'',p.full_name)',
  'to_jsonb(t)||jsonb_build_object(''full_name'',p.full_name,''group_ids'',case when v_course.owner_id=v_uid or t.user_id=v_uid then to_jsonb(t.group_ids) else ''[]''::jsonb end)');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_course(uuid)',
  'where t.course_id=p_course_id and (v_staff or t.status=''accepted'')',
  'where t.course_id=p_course_id and (v_staff or t.status=''accepted'') and(v_course.owner_id=v_uid or t.user_id=v_uid or(t.status=''accepted'' and exists(select 1 from public.teaching_course_groups g where g.course_id=t.course_id and g.status=''accepted'' and cardinality(public.xelay_teaching_group_permissions(t.course_id,g.group_id,t.user_id))>0 and(cardinality(public.xelay_teaching_group_permissions(t.course_id,g.group_id,v_uid))>0 or public.xelay_teaching_is_member(g.group_id,v_uid)))))');

select pg_temp.xelay_group_scope_patch('public.xelay_classroom_workspace()',
  'public.xelay_teaching_permissions(c.id,v_uid)', 'public.xelay_teaching_group_permissions(c.id,l.group_id,v_uid)');
select pg_temp.xelay_group_scope_patch('public.xelay_classroom_workspace()',
  'public.xelay_teaching_permissions(l.course_id,v_uid)', 'public.xelay_teaching_group_permissions(l.course_id,l.group_id,v_uid)');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_group_context(uuid)',
  'public.xelay_teaching_permissions(l.course_id,v_uid)', 'public.xelay_teaching_group_permissions(l.course_id,p_group_id,v_uid)');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_group_context(uuid)',
  'public.xelay_teaching_permissions(c.id,v_uid)', 'public.xelay_teaching_group_permissions(c.id,p_group_id,v_uid)',2);
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_calendar(date,date)',
  'public.xelay_teaching_permissions(c.id,v_uid)', 'public.xelay_teaching_group_permissions(c.id,l.group_id,v_uid)');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_calendar(date,date)',
  'public.xelay_teaching_permissions(o.course_id,v_uid)', 'public.xelay_teaching_group_permissions(o.course_id,o.group_id,v_uid)');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_calendar_assign(uuid,uuid,uuid,text,boolean)',
  'cardinality(public.xelay_teaching_permissions(p_course_id,v_uid))=0', 'cardinality(public.xelay_teaching_group_permissions(p_course_id,p_group_id,v_uid))=0');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_scheduled_items(uuid)',
  'and(case when i.kind=''assignment'' then ''assignments'' else ''materials'' end)=any(public.xelay_teaching_permissions(i.course_id,v_uid))',
  'and public.xelay_teaching_can_read_item(i.id,v_uid)');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_scheduled_items(uuid)',
  'and(p_group_id is null or exists(select 1 from public.teaching_item_targets t where t.item_id=i.id and t.group_id=p_group_id))',
  'and(p_group_id is null or((case when i.kind=''assignment'' then ''assignments'' else ''materials'' end)=any(public.xelay_teaching_group_permissions(i.course_id,p_group_id,v_uid)) and exists(select 1 from public.teaching_item_targets t where t.item_id=i.id and t.group_id=p_group_id)))');
select pg_temp.xelay_group_scope_patch('public.xelay_publish_due_teaching_items()',
  'for v_target in select * from public.teaching_item_targets where item_id=v_item.id order by group_id loop',
  'for v_target in select * from public.teaching_item_targets where item_id=v_item.id order by group_id loop
        if not v_permission=any(public.xelay_teaching_group_permissions(v_item.course_id,v_target.group_id,v_actor))
          or not v_permission=any(public.xelay_teaching_group_permissions(v_item.course_id,v_target.group_id,v_item.created_by))
          or(v_item.kind=''assignment'' and v_item.max_points is not null and not ''grades''=any(public.xelay_teaching_group_permissions(v_item.course_id,v_target.group_id,v_actor))) then
          raise exception ''TEACHING_SCHEDULE_GROUP_ACCESS_CHANGED'';end if;');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_grade_requests(uuid)',
  'public.xelay_teaching_permissions(c.id,v_uid)', 'public.xelay_teaching_group_permissions(c.id,r.group_id,v_uid)',3);
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_request_grade(uuid,text,uuid)',
  'public.xelay_teaching_permissions(v_activity.course_id,v_teacher)', 'public.xelay_teaching_group_permissions(v_activity.course_id,v_activity.group_id,v_teacher)');
select pg_temp.xelay_group_scope_patch('public.xelay_teaching_resolve_grade_request(uuid,integer,text)',
  'if not exists(select 1 from public.teaching_course_groups l where l.course_id=v_course and l.group_id=v_request.group_id',
  'if not ''grades''=any(public.xelay_teaching_group_permissions(v_course,v_request.group_id,v_uid)) or not exists(select 1 from public.teaching_course_groups l where l.course_id=v_course and l.group_id=v_request.group_id');
select pg_temp.xelay_group_scope_patch('public.xelay_save_teaching_grades_batch(uuid,uuid,uuid,uuid,uuid,jsonb)',
  'perform public.xelay_teaching_lock_course(p_course_id,''grades'');',
  'perform public.xelay_private_assert_teaching_group(p_course_id,p_group_id,''grades'');');
select pg_temp.xelay_group_scope_patch('public.xelay_group_teacher_materials(uuid)',
  'public.xelay_teaching_permissions((r.i).course_id,v_uid)',
  'public.xelay_teaching_group_permissions((r.i).course_id,p_group_id,v_uid)');

-- Academic contacts/conversation rights expire for only the revoked group.
select pg_temp.xelay_group_scope_patch('public.xelay_teacher_contacts(uuid,uuid)',
  'public.xelay_teaching_permissions(c.id,p_teacher_id)', 'public.xelay_teaching_group_permissions(c.id,p_group_id,p_teacher_id)');
select pg_temp.xelay_group_scope_patch('public.xelay_academic_teacher_link(uuid,uuid,uuid)',
  'public.xelay_teaching_permissions(c.id,p_teacher_id)', 'public.xelay_teaching_group_permissions(c.id,p_group_id,p_teacher_id)');
select pg_temp.xelay_group_scope_patch('public.xelay_academic_context_active(public.academic_direct_contexts)',
  'public.xelay_teaching_permissions(c.id,p_context.teacher_id)', 'public.xelay_teaching_group_permissions(c.id,p_context.group_id,p_context.teacher_id)');
select pg_temp.xelay_group_scope_patch('public.xelay_academic_group_teachers(uuid)',
  'public.xelay_teaching_permissions(l.id,l.teacher_id)', 'public.xelay_teaching_group_permissions(l.id,p_group_id,l.teacher_id)');
select pg_temp.xelay_group_scope_patch('public.xelay_academic_open_conversation(uuid,uuid,uuid,uuid)',
  'public.xelay_teaching_permissions(c.id,p_teacher_id)', 'public.xelay_teaching_group_permissions(c.id,p_group_id,p_teacher_id)');

comment on column public.teaching_course_teachers.group_scope is 'Legacy links retain all until edited. New invitations and scope edits explicitly enumerate selected accepted groups. Future groups never expand selected access. Group scope grants no material authorship.';
notify pgrst,'reload schema';
commit;
