-- Prepared locally. Teaching subgroups are unrelated to private seminar teams.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

create table public.teaching_subgroups(
  id uuid primary key,course_id uuid not null references public.teaching_courses(id) on delete cascade,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  name text not null check(length(btrim(name)) between 1 and 100),
  user_ids uuid[] not null default '{}',version integer not null default 1,
  created_by uuid not null references public.profiles(id),created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  unique(id,course_id,group_id),foreign key(course_id,group_id) references public.teaching_course_groups(course_id,group_id) on delete cascade
);
create table public.teaching_lab_teams(
  id uuid primary key,item_id uuid not null references public.teaching_items(id) on delete cascade,
  course_id uuid not null references public.teaching_courses(id) on delete cascade,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  name text not null check(length(btrim(name)) between 1 and 100),user_ids uuid[] not null default '{}',
  version integer not null default 1,created_by uuid not null references public.profiles(id),
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),
  unique(id,item_id,group_id),foreign key(course_id,group_id) references public.teaching_course_groups(course_id,group_id) on delete cascade
);
create table public.teaching_announcements(
  id uuid primary key,course_id uuid not null references public.teaching_courses(id) on delete cascade,
  title text not null check(length(btrim(title)) between 1 and 180),body text not null check(length(btrim(body)) between 1 and 10000),
  targets jsonb not null check(jsonb_typeof(targets)='array' and jsonb_array_length(targets) between 1 and 100),
  created_by uuid not null references public.profiles(id),version integer not null default 1,
  created_at timestamptz not null default now(),updated_at timestamptz not null default now(),deleted_at timestamptz
);
create index teaching_subgroups_scope on public.teaching_subgroups(course_id,group_id);
create index teaching_lab_teams_scope on public.teaching_lab_teams(item_id,group_id);
create index teaching_announcements_course on public.teaching_announcements(course_id,created_at desc) where deleted_at is null;
alter table public.teaching_subgroups enable row level security;
alter table public.teaching_lab_teams enable row level security;
alter table public.teaching_announcements enable row level security;
revoke all on public.teaching_subgroups,public.teaching_lab_teams,public.teaching_announcements from public,anon,authenticated,service_role;

alter table public.teaching_item_targets add column audience_mode text not null default 'all' check(audience_mode in('all','subgroups','teams')),
  add column subgroup_ids uuid[] not null default '{}',add column team_ids uuid[] not null default '{}';
alter table public.teaching_items add column submission_mode text not null default 'individual' check(submission_mode in('individual','team'));

create function public.xelay_private_teaching_audience_allows(p_course uuid,p_group uuid,p_mode text,p_subgroups uuid[],p_teams uuid[],p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_teaching_is_member(p_group,p_user) and exists(select 1 from public.teaching_course_groups l
    where l.course_id=p_course and l.group_id=p_group and l.status='accepted') and case p_mode
    when 'all' then true
    when 'subgroups' then exists(select 1 from public.teaching_subgroups s where s.id=any(p_subgroups)
      and s.course_id=p_course and s.group_id=p_group and p_user=any(s.user_ids))
    when 'teams' then exists(select 1 from public.teaching_lab_teams s where s.id=any(p_teams)
      and s.course_id=p_course and s.group_id=p_group and p_user=any(s.user_ids)) else false end;
$$;
create function public.xelay_private_teaching_target_allows(p_item uuid,p_group uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.teaching_item_targets t join public.teaching_items i on i.id=t.item_id
    where t.item_id=p_item and t.group_id=p_group and public.xelay_private_teaching_audience_allows(i.course_id,t.group_id,
      t.audience_mode,t.subgroup_ids,t.team_ids,p_user));
$$;
create function public.xelay_private_validate_teaching_audience(p_course uuid,p_item uuid,p_target jsonb)
returns void language plpgsql stable security definer set search_path='' as $$
declare v_group uuid:=(p_target->>'group_id')::uuid;v_mode text:=coalesce(p_target->>'audience_mode','all');v_ids uuid[];v_id uuid;
begin
  if v_mode not in('all','subgroups','teams') or jsonb_typeof(p_target) is distinct from 'object'
    or jsonb_typeof(coalesce(p_target->'subgroup_ids','[]')) is distinct from 'array'
    or jsonb_typeof(coalesce(p_target->'team_ids','[]')) is distinct from 'array' then raise exception 'TEACHING_AUDIENCE_INVALID';end if;
  if v_mode='subgroups' then
    v_ids:=array(select value::uuid from jsonb_array_elements_text(coalesce(p_target->'subgroup_ids','[]')));
    if cardinality(v_ids)=0 or cardinality(v_ids)>100 then raise exception 'TEACHING_AUDIENCE_INVALID';end if;
    foreach v_id in array v_ids loop
      if not exists(select 1 from public.teaching_subgroups where id=v_id and course_id=p_course and group_id=v_group) then raise exception 'TEACHING_AUDIENCE_INVALID';end if;
    end loop;
  elsif v_mode='teams' then
    v_ids:=array(select value::uuid from jsonb_array_elements_text(coalesce(p_target->'team_ids','[]')));
    if cardinality(v_ids)=0 or cardinality(v_ids)>100 then raise exception 'TEACHING_AUDIENCE_INVALID';end if;
    foreach v_id in array v_ids loop
      if not exists(select 1 from public.teaching_lab_teams where id=v_id and course_id=p_course and group_id=v_group
        and(p_item is null or item_id=p_item or exists(select 1 from public.teaching_items where id=p_item and kind='material'))) then raise exception 'TEACHING_AUDIENCE_INVALID';end if;
    end loop;
  end if;
  if(v_mode<>'subgroups' and jsonb_array_length(coalesce(p_target->'subgroup_ids','[]'))>0)
    or(v_mode<>'teams' and jsonb_array_length(coalesce(p_target->'team_ids','[]'))>0) then raise exception 'TEACHING_AUDIENCE_INVALID';end if;
end $$;

-- Every writer, including assistant and material-library writers, passes the
-- same trigger. Existing targets remain whole-group by their explicit defaults.
create function public.xelay_guard_teaching_audience_target() returns trigger language plpgsql security definer set search_path='' as $$
declare v_course uuid;
begin
  select course_id into v_course from public.teaching_items where id=new.item_id;
  perform public.xelay_private_validate_teaching_audience(v_course,new.item_id,to_jsonb(new));
  return new;
end $$;
create trigger teaching_target_audience before insert or update on public.teaching_item_targets for each row execute function public.xelay_guard_teaching_audience_target();

create function public.xelay_teaching_audience(p_course_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();
begin
  if not public.xelay_teaching_is_verified(v_uid) or not exists(select 1 from public.teaching_course_groups g where g.course_id=p_course_id
    and g.status='accepted' and public.xelay_teaching_group_permissions(p_course_id,g.group_id,v_uid)&&array['assignments','materials','grades']) then
    raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  return jsonb_build_object(
    'subgroups',coalesce((select jsonb_agg(to_jsonb(s) order by s.group_id,s.name) from public.teaching_subgroups s where s.course_id=p_course_id
      and cardinality(public.xelay_teaching_group_permissions(s.course_id,s.group_id,v_uid))>0),'[]'),
    'teams',coalesce((select jsonb_agg(to_jsonb(s) order by s.item_id,s.name) from public.teaching_lab_teams s where s.course_id=p_course_id
      and public.xelay_teaching_group_permissions(s.course_id,s.group_id,v_uid)&&array['assignments','materials','grades']),'[]'),
    'announcements',coalesce((select jsonb_agg((to_jsonb(a)||jsonb_build_object('author_name',p.full_name,
      'targets',(select jsonb_agg(t) from jsonb_array_elements(a.targets)t where cardinality(public.xelay_teaching_group_permissions(a.course_id,(t->>'group_id')::uuid,v_uid))>0))) order by a.created_at desc)
      from public.teaching_announcements a join public.profiles p on p.id=a.created_by where a.course_id=p_course_id and a.deleted_at is null
      and exists(select 1 from jsonb_array_elements(a.targets)t where cardinality(public.xelay_teaching_group_permissions(a.course_id,(t->>'group_id')::uuid,v_uid))>0)),'[]'),
    'members',coalesce((select jsonb_agg(jsonb_build_object('group_id',g.group_id,'user_id',p.id,'full_name',p.full_name) order by p.full_name)
      from public.teaching_course_groups g join public.profiles p on public.xelay_teaching_is_member(g.group_id,p.id)
      where g.course_id=p_course_id and g.status='accepted' and cardinality(public.xelay_teaching_group_permissions(p_course_id,g.group_id,v_uid))>0),'[]'));
end $$;

create function public.xelay_teaching_group_announcements(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();
begin
  if not public.xelay_teaching_is_member(p_group_id,v_uid) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  return jsonb_build_object('announcements',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'course_id',a.course_id,'course_title',c.title,
    'title',a.title,'body',a.body,'author_name',p.full_name,'created_by',a.created_by,'created_at',a.created_at,'updated_at',a.updated_at,'version',a.version,
    'targets',jsonb_build_array(jsonb_build_object('group_id',p_group_id))) order by a.created_at desc)
    from public.teaching_announcements a join public.profiles p on p.id=a.created_by join public.teaching_courses c on c.id=a.course_id
    where a.deleted_at is null and exists(select 1 from jsonb_array_elements(a.targets)t where(t->>'group_id')::uuid=p_group_id
      and public.xelay_private_teaching_audience_allows(a.course_id,p_group_id,coalesce(t->>'audience_mode','all'),
        array(select value::uuid from jsonb_array_elements_text(coalesce(t->'subgroup_ids','[]'))),
        array(select value::uuid from jsonb_array_elements_text(coalesce(t->'team_ids','[]'))),v_uid))),'[]'));
end $$;

create function public.xelay_teaching_audience_mutate(p_action text,p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_id uuid:=(p_payload->>'id')::uuid;v_course uuid:=(p_payload->>'course_id')::uuid;
  v_group uuid:=(p_payload->>'group_id')::uuid;v_item uuid:=(p_payload->>'item_id')::uuid;v_version integer:=coalesce((p_payload->>'version')::integer,0);
  v_users uuid[];v_user uuid;v_target jsonb;v_announcement public.teaching_announcements%rowtype;v_old record;v_count integer;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>100000 or v_id is null
    or(p_payload?'expected_user_id' and(p_payload->>'expected_user_id')::uuid is distinct from v_uid) then raise exception 'TEACHING_INVALID_INPUT';end if;
  perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-audience:'||v_id,0));
  if p_action in('save_subgroup','delete_subgroup','save_lab_team','delete_lab_team') then
    if p_action like '%subgroup' then select course_id,group_id,version into v_old from public.teaching_subgroups where id=v_id;
    else select course_id,group_id,item_id,version into v_old from public.teaching_lab_teams where id=v_id;end if;
    if v_version>0 then
      if v_old.version is null or v_old.version<>v_version then raise exception 'TEACHING_CONFLICT';end if;
      if v_course is not null and v_course<>v_old.course_id or v_group is not null and v_group<>v_old.group_id then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
      v_course:=v_old.course_id;v_group:=v_old.group_id;
      if p_action like '%lab_team' then v_item:=v_old.item_id;end if;
    elsif v_old.version is not null then raise exception 'TEACHING_CONFLICT';end if;
    perform public.xelay_classroom_lock_group(v_course,v_group,'assignments');
    -- A shared-publication fork takes the same course lock and can move a team
    -- without its editor's advisory key. Recheck after that lock, not before it.
    if p_action like '%subgroup' then select course_id,group_id,version into v_old from public.teaching_subgroups where id=v_id for update;
    else select course_id,group_id,item_id,version into v_old from public.teaching_lab_teams where id=v_id for update;end if;
    if(v_version>0 and(v_old.version is null or v_old.version<>v_version)) or(v_version=0 and v_old.version is not null) then raise exception 'TEACHING_CONFLICT';end if;
    if p_action like '%lab_team' then
      perform pg_advisory_xact_lock(hashtextextended('xelay:lab-team:'||v_item||':'||v_group,0));
      if not exists(select 1 from public.teaching_items i join public.teaching_item_targets t on t.item_id=i.id and t.group_id=v_group
        where i.id=v_item and i.course_id=v_course and i.kind='assignment') then raise exception 'TEACHING_AUDIENCE_INVALID';end if;
    end if;
    if p_action like 'delete_%' then
      if p_action='delete_subgroup' then
        if exists(select 1 from public.teaching_item_targets where v_id=any(subgroup_ids))
          or exists(select 1 from public.teaching_announcements a,jsonb_array_elements(a.targets)t where a.deleted_at is null and coalesce(t->'subgroup_ids','[]')?v_id::text) then raise exception 'TEACHING_AUDIENCE_IN_USE';end if;
        delete from public.teaching_subgroups where id=v_id and version=v_version;get diagnostics v_count=row_count;
      else
        if exists(select 1 from public.teaching_item_targets where v_id=any(team_ids))
          or exists(select 1 from public.teaching_announcements a,jsonb_array_elements(a.targets)t where a.deleted_at is null and coalesce(t->'team_ids','[]')?v_id::text) then raise exception 'TEACHING_AUDIENCE_IN_USE';end if;
        delete from public.teaching_lab_teams where id=v_id and version=v_version;get diagnostics v_count=row_count;
      end if;
      if v_count<>1 then raise exception 'TEACHING_CONFLICT';end if;
      return jsonb_build_object('id',v_id,'version',v_version+1);
    end if;
    if jsonb_typeof(p_payload->'user_ids') is distinct from 'array' or jsonb_array_length(p_payload->'user_ids') not between 1 and 200
      or length(btrim(coalesce(p_payload->>'name',''))) not between 1 and 100 then raise exception 'TEACHING_AUDIENCE_INVALID';end if;
    v_users:=array(select value::uuid from jsonb_array_elements_text(p_payload->'user_ids'));
    if cardinality(v_users)<>(select count(distinct x) from unnest(v_users)x) then raise exception 'TEACHING_AUDIENCE_INVALID';end if;
    foreach v_user in array v_users loop
      if not public.xelay_teaching_is_member(v_group,v_user) then raise exception 'TEACHING_AUDIENCE_INVALID';end if;
    end loop;
    if p_action='save_subgroup' then
      insert into public.teaching_subgroups(id,course_id,group_id,name,user_ids,created_by) values(v_id,v_course,v_group,btrim(p_payload->>'name'),v_users,v_uid)
        on conflict(id) do update set name=excluded.name,user_ids=excluded.user_ids,version=public.teaching_subgroups.version+1,updated_at=clock_timestamp();
    else
      if exists(select 1 from public.teaching_lab_teams where item_id=v_item and group_id=v_group and id<>v_id and user_ids&&v_users) then raise exception 'TEACHING_TEAM_DUPLICATE_STUDENT';end if;
      insert into public.teaching_lab_teams(id,item_id,course_id,group_id,name,user_ids,created_by) values(v_id,v_item,v_course,v_group,btrim(p_payload->>'name'),v_users,v_uid)
        on conflict(id) do update set name=excluded.name,user_ids=excluded.user_ids,version=public.teaching_lab_teams.version+1,updated_at=clock_timestamp();
    end if;
    return jsonb_build_object('id',v_id,'version',v_version+1);
  elsif p_action in('save_announcement','delete_announcement') then
    select * into v_announcement from public.teaching_announcements where id=v_id for update;
    if found then
      if v_announcement.created_by<>v_uid then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
      if v_announcement.version<>v_version or v_announcement.deleted_at is not null then raise exception 'TEACHING_CONFLICT';end if;
      if v_course is not null and v_course<>v_announcement.course_id then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
      v_course:=v_announcement.course_id;
      for v_target in select value from jsonb_array_elements(v_announcement.targets) loop
        perform public.xelay_classroom_lock_group(v_course,(v_target->>'group_id')::uuid,'assignments');
      end loop;
    elsif v_version<>0 or p_action='delete_announcement' then raise exception 'TEACHING_CONFLICT';end if;
    if p_action='delete_announcement' then
      update public.teaching_announcements set deleted_at=clock_timestamp(),version=version+1,updated_at=clock_timestamp() where id=v_id;
      return jsonb_build_object('id',v_id,'version',v_version+1);
    end if;
    if jsonb_typeof(p_payload->'targets') is distinct from 'array' or jsonb_array_length(p_payload->'targets') not between 1 and 100
      or(select count(*) from jsonb_array_elements(p_payload->'targets'))<>(select count(distinct value->>'group_id') from jsonb_array_elements(p_payload->'targets')) then raise exception 'TEACHING_AUDIENCE_INVALID';end if;
    for v_target in select value from jsonb_array_elements(p_payload->'targets') order by value->>'group_id' loop
      perform public.xelay_classroom_lock_group(v_course,(v_target->>'group_id')::uuid,'assignments');
      perform public.xelay_private_validate_teaching_audience(v_course,null,v_target);
    end loop;
    insert into public.teaching_announcements(id,course_id,title,body,targets,created_by) values(v_id,v_course,btrim(p_payload->>'title'),btrim(p_payload->>'body'),p_payload->'targets',v_uid)
      on conflict(id) do update set title=excluded.title,body=excluded.body,targets=excluded.targets,version=public.teaching_announcements.version+1,updated_at=clock_timestamp()
      returning * into v_announcement;
    for v_user,v_group in select p.id,min(t->>'group_id')::uuid from public.profiles p,jsonb_array_elements(v_announcement.targets)t where
      public.xelay_private_teaching_audience_allows(v_course,(t->>'group_id')::uuid,coalesce(t->>'audience_mode','all'),
        array(select value::uuid from jsonb_array_elements_text(coalesce(t->'subgroup_ids','[]'))),
        array(select value::uuid from jsonb_array_elements_text(coalesce(t->'team_ids','[]'))),p.id) group by p.id loop
      perform public.xelay_teaching_notify(v_user,'teaching-announcement:'||v_id||':'||v_announcement.version,'Повідомлення від викладача: '||v_announcement.title,v_course,v_group);
    end loop;
    return jsonb_build_object('id',v_id,'version',v_announcement.version);
  end if;
  raise exception 'TEACHING_INVALID_ACTION';
end $$;

-- Preserve deployed authorization and quarantine rules, adding only current
-- recipient membership. New helper ACLs are closed, even to service_role.
alter function public.xelay_teaching_can_read_item(uuid,uuid) rename to xelay_private_pre_audience_can_read_item;
create function public.xelay_teaching_can_read_item(p_item_id uuid,p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_private_pre_audience_can_read_item(p_item_id,p_user_id) and exists(select 1 from public.teaching_items i where i.id=p_item_id and(
    coalesce((public.xelay_teaching_material_permissions(i.id,p_user_id)->>'visible')::boolean,false)
    or(not exists(select 1 from public.teaching_item_targets t where t.item_id=i.id)
      and(case when i.kind='material' then 'materials' else 'assignments' end)=any(public.xelay_teaching_permissions(i.course_id,p_user_id)))
    or exists(select 1 from public.teaching_item_targets t where t.item_id=i.id and(
      (case when i.kind='material' then 'materials' else 'assignments' end)=any(public.xelay_teaching_group_permissions(i.course_id,t.group_id,p_user_id))
      or(i.kind='assignment' and i.status='published' and 'grades'=any(public.xelay_teaching_group_permissions(i.course_id,t.group_id,p_user_id)))
      or public.xelay_private_teaching_target_allows(i.id,t.group_id,p_user_id)))));
$$;
create or replace function public.xelay_classroom_student(p_item uuid,p_group uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.teaching_items i where i.id=p_item and i.kind='assignment' and i.status='published' and i.withdrawn_at is null)
    and public.xelay_private_teaching_target_allows(p_item,p_group,p_user);
$$;

create function pg_temp.xelay_audience_patch(p_signature text,p_old text,p_new text)
returns void language plpgsql as $$
declare v_body text;v_count integer;v_signature text:=p_signature;
  v_old text:=replace(p_old,chr(13),'');v_new text:=replace(p_new,chr(13),'');
begin
  if p_signature='public.xelay_teaching_mutate(text,jsonb)'
    and to_regprocedure('public.xelay_teaching_mutate_before_group_requests_20261027(text,jsonb)') is not null then
    v_signature:='public.xelay_teaching_mutate_before_group_requests_20261027(text,jsonb)';
  end if;
  v_body:=replace(pg_get_functiondef(to_regprocedure(v_signature)),chr(13),'');
  v_count:=(length(v_body)-length(replace(v_body,v_old,'')))/length(v_old);
  if v_count<>1 then raise exception 'TEACHING_AUDIENCE_DEPLOYMENT_DRIFT: % (% matches)',p_signature,v_count;end if;
  execute replace(v_body,v_old,v_new);
end $$;
-- An already-open pre-release editor does not know the audience fields. Its
-- fresh version number is not consent to widen a subgroup/team publication.
-- Reject that legacy shape before replacing any target row. Legacy whole-group
-- records remain editable; only an explicit audience_mode='all' widens access.
create function public.xelay_private_teaching_assert_audience_payload(p_item uuid,p_targets jsonb)
returns void language plpgsql stable security definer set search_path='' as $$
begin
  if exists(select 1 from public.teaching_item_targets where item_id=p_item and audience_mode<>'all')
    and jsonb_typeof(p_targets)='array' and exists(select 1 from jsonb_array_elements(p_targets)t
      where jsonb_typeof(t->'audience_mode') is distinct from 'string') then
    raise exception 'TEACHING_AUDIENCE_REFRESH_REQUIRED' using errcode='22023';
  end if;
end $$;
select pg_temp.xelay_audience_patch('public.xelay_teaching_mutate(text,jsonb)',
  'perform public.xelay_teaching_lock_course(v_course_id,v_permission);',
  'perform public.xelay_teaching_lock_course(v_course_id,v_permission);
    perform public.xelay_private_teaching_assert_audience_payload(v_id,p_payload->''targets'');');
-- A one-group edit of a shared publication creates a new canonical item ID.
-- Inspect its source before the fork moves work/targets away from that source.
select pg_temp.xelay_audience_patch('public.xelay_classroom_assignment_mutate(text,jsonb)',
  'v_payload:=p_payload-''source_item_id''-''source_version'';',
  'perform public.xelay_private_teaching_assert_audience_payload(coalesce(nullif(p_payload->>''source_item_id'','''')::uuid,v_id),p_payload->''targets'');
    v_payload:=p_payload-''source_item_id''-''source_version'';');
-- Persist audience metadata before notifications, in the canonical writer used
-- by all group, multi-group and assistant paths. Trigger rejects foreign IDs.
select pg_temp.xelay_audience_patch('public.xelay_teaching_mutate(text,jsonb)',
  'insert into public.teaching_item_targets(item_id,group_id,due_at,closes_at,lesson_date,schedule_item_id,placement_mode)',
  'insert into public.teaching_item_targets(item_id,group_id,due_at,closes_at,lesson_date,schedule_item_id,placement_mode,audience_mode,subgroup_ids,team_ids)');
select pg_temp.xelay_audience_patch('public.xelay_teaching_mutate(text,jsonb)',
  $a$case when v_kind='assignment' then nullif(value->>'placement_mode','') end$a$,
  $a$case when v_kind='assignment' then nullif(value->>'placement_mode','') end,
        coalesce(value->>'audience_mode','all'),array(select jsonb_array_elements_text(coalesce(value->'subgroup_ids','[]'))::uuid),
        array(select jsonb_array_elements_text(coalesce(value->'team_ids','[]'))::uuid)$a$);
select pg_temp.xelay_audience_patch('public.xelay_teaching_mutate(text,jsonb)',
  'if v_kind=''assignment'' then perform public.xelay_teaching_sync_assignment_activity(v_record.id); end if;',
  'update public.teaching_items set submission_mode=coalesce(p_payload->>''submission_mode'',submission_mode) where id=v_record.id;
    if v_kind=''assignment'' then perform public.xelay_teaching_sync_assignment_activity(v_record.id); end if;');
select pg_temp.xelay_audience_patch('public.xelay_teaching_mutate(text,jsonb)',
  'where t.item_id=v_record.id order by p.id loop',
  'where t.item_id=v_record.id and public.xelay_private_teaching_target_allows(v_record.id,t.group_id,p.id) order by p.id loop');
select pg_temp.xelay_audience_patch('public.xelay_publish_due_teaching_items()',
  'where t.item_id=v_item.id',
  'where t.item_id=v_item.id and public.xelay_private_teaching_target_allows(v_item.id,t.group_id,p.id)');

select pg_temp.xelay_audience_patch('public.xelay_teaching_item_json(public.teaching_items,uuid)',
  '''group_id'',t.group_id,''due_at'',t.due_at,',
  '''group_id'',t.group_id,''due_at'',t.due_at,''audience_mode'',t.audience_mode,''subgroup_ids'',t.subgroup_ids,''team_ids'',t.team_ids,');
-- Filter at the specific target, not merely at item level: a student can belong
-- to two groups targeted by one item and be excluded from one of those groups.
select pg_temp.xelay_audience_patch('public.xelay_teaching_item_json(public.teaching_items,uuid)',
  'or public.xelay_teaching_is_member(t.group_id,auth.uid()))',
  'or public.xelay_private_teaching_target_allows(p_item.id,t.group_id,auth.uid()))');
select pg_temp.xelay_audience_patch('public.xelay_group_teacher_assignments(uuid,date)',
  'where i.kind=''assignment'' and i.status=''published'' and i.withdrawn_at is null',
  'where i.kind=''assignment'' and i.status=''published'' and i.withdrawn_at is null and public.xelay_private_teaching_target_allows(i.id,p_group_id,v_uid)');
select pg_temp.xelay_audience_patch('public.xelay_group_teacher_materials(uuid)',
  'where i.kind=''material'' and i.status=''published'' and i.withdrawn_at is null',
  'where i.kind=''material'' and i.status=''published'' and i.withdrawn_at is null and public.xelay_private_teaching_target_allows(i.id,p_group_id,v_uid)');
select pg_temp.xelay_audience_patch('public.xelay_teaching_group(uuid)',
  'where i.kind=''assignment'' and i.status=''published''',
  'where i.kind=''assignment'' and i.status=''published'' and i.withdrawn_at is null and public.xelay_private_teaching_target_allows(i.id,p_group_id,v_uid)');
select pg_temp.xelay_audience_patch('public.xelay_teaching_group(uuid)',
  'where i.kind=''material'' and i.status=''published'' and i.withdrawn_at is null',
  'where i.kind=''material'' and i.status=''published'' and i.withdrawn_at is null and public.xelay_private_teaching_target_allows(i.id,p_group_id,v_uid)');

create function public.xelay_private_teaching_material_audiences(p_item uuid,p_payload jsonb)
returns void language plpgsql security definer set search_path='' as $$
declare v_course uuid;v_target jsonb;v_group uuid;v_user uuid;v_access jsonb;
begin
  if not(p_payload?'target_audiences') then return;end if;
  perform public.xelay_private_teaching_assert_audience_payload(p_item,p_payload->'target_audiences');
  v_access:=public.xelay_teaching_material_permissions(p_item,auth.uid());
  if not coalesce((v_access->>'can_manage_groups')::boolean,false) then raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
  select course_id into v_course from public.teaching_items where id=p_item;
  if jsonb_typeof(p_payload->'target_audiences') is distinct from 'array' or jsonb_array_length(p_payload->'target_audiences')>100
    or(select count(*) from jsonb_array_elements(p_payload->'target_audiences'))<>(select count(distinct value->>'group_id') from jsonb_array_elements(p_payload->'target_audiences')) then raise exception 'TEACHING_AUDIENCE_INVALID';end if;
  for v_target in select value from jsonb_array_elements(p_payload->'target_audiences') order by value->>'group_id' loop
    v_group:=(v_target->>'group_id')::uuid;
    perform public.xelay_private_assert_teaching_group(v_course,v_group,'materials');
    if not exists(select 1 from public.teaching_item_targets where item_id=p_item and group_id=v_group) then raise exception 'TEACHING_AUDIENCE_INVALID';end if;
    perform public.xelay_private_validate_teaching_audience(v_course,p_item,v_target);
    update public.teaching_item_targets set audience_mode=coalesce(v_target->>'audience_mode','all'),
      subgroup_ids=array(select value::uuid from jsonb_array_elements_text(coalesce(v_target->'subgroup_ids','[]'))),
      team_ids=array(select value::uuid from jsonb_array_elements_text(coalesce(v_target->'team_ids','[]'))) where item_id=p_item and group_id=v_group;
  end loop;
end $$;
select pg_temp.xelay_audience_patch('public.xelay_private_material_library_mutate(text,jsonb)',
  'delete from public.teaching_item_targets where item_id=v_id and not(group_id=any(v_groups));',
  'if p_payload?''target_audiences'' then perform public.xelay_private_teaching_assert_audience_payload(v_id,p_payload->''target_audiences'');end if;
  delete from public.teaching_item_targets where item_id=v_id and not(group_id=any(v_groups));');
select pg_temp.xelay_audience_patch('public.xelay_private_material_library_mutate(text,jsonb)',
  '''course_id'',''target_group_ids'',''title''', '''course_id'',''target_group_ids'',''target_audiences'',''title''');
select pg_temp.xelay_audience_patch('public.xelay_private_material_library_mutate(text,jsonb)',
  '''course_id'',''target_group_ids''));', '''course_id'',''target_group_ids'',''target_audiences''));');
select pg_temp.xelay_audience_patch('public.xelay_private_material_library_mutate(text,jsonb)',
  'if v_existing and p_payload?''target_group_ids'' and', 'if v_existing and(p_payload?''target_group_ids'' or p_payload?''target_audiences'') and');
select pg_temp.xelay_audience_patch('public.xelay_private_material_library_mutate(text,jsonb)',
  'if not v_metadata and not(p_payload?''target_group_ids'') then', 'if not v_metadata and not(p_payload?''target_group_ids'' or p_payload?''target_audiences'') then');
select pg_temp.xelay_audience_patch('public.xelay_private_material_library_mutate(text,jsonb)',
  'insert into public.teaching_item_targets(item_id,group_id) select v_id,g from unnest(v_groups) g on conflict(item_id,group_id) do nothing;',
  'insert into public.teaching_item_targets(item_id,group_id) select v_id,g from unnest(v_groups) g on conflict(item_id,group_id) do nothing;
  perform public.xelay_private_teaching_material_audiences(v_id,p_payload);');
select pg_temp.xelay_audience_patch('public.xelay_private_library_material_json(public.teaching_items,uuid)',
  'jsonb_build_object(''group_id'',t.group_id) order by t.group_id)',
  'jsonb_build_object(''group_id'',t.group_id,''audience_mode'',t.audience_mode,''subgroup_ids'',t.subgroup_ids,''team_ids'',t.team_ids) order by t.group_id)');

revoke all on function public.xelay_private_teaching_audience_allows(uuid,uuid,text,uuid[],uuid[],uuid),public.xelay_private_teaching_target_allows(uuid,uuid,uuid),
  public.xelay_private_validate_teaching_audience(uuid,uuid,jsonb),public.xelay_guard_teaching_audience_target(),public.xelay_private_teaching_material_audiences(uuid,jsonb),public.xelay_private_teaching_assert_audience_payload(uuid,jsonb),public.xelay_teaching_can_read_item(uuid,uuid),public.xelay_classroom_student(uuid,uuid,uuid)
  from public,anon,authenticated,service_role;
revoke all on function public.xelay_teaching_audience(uuid),public.xelay_teaching_group_announcements(uuid),public.xelay_teaching_audience_mutate(text,jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_audience(uuid),public.xelay_teaching_group_announcements(uuid),public.xelay_teaching_audience_mutate(text,jsonb) to authenticated;
commit;
