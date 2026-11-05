-- Course modules reference existing canonical resources. They never copy or
-- replace work, attempts, answers, grades, audiences or teaching permissions.
begin;
set local lock_timeout='5s';
set local statement_timeout='90s';

create table public.teaching_course_modules(
  id uuid primary key,course_id uuid not null references public.teaching_courses(id) on delete cascade,
  title text not null check(length(btrim(title)) between 1 and 180),
  description text not null default '' check(length(description)<=5000),
  status text not null check(status in('draft','published','archived')),
  group_ids uuid[] not null,prerequisite_item_ids uuid[] not null default '{}',
  position integer not null check(position between 0 and 10000),version integer not null default 1 check(version>0),
  created_by uuid not null references public.profiles(id),created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),unique(id,course_id),
  check(cardinality(group_ids) between 1 and 100 and array_ndims(group_ids)=1 and array_position(group_ids,null) is null),
  check(cardinality(prerequisite_item_ids)<=100)
);
create index teaching_course_modules_course on public.teaching_course_modules(course_id,position,id);
create table public.teaching_course_module_items(
  id uuid primary key,module_id uuid not null,course_id uuid not null,
  resource_type text not null check(resource_type in('material','assignment','test')),resource_id uuid not null,
  required boolean not null,completion text not null check(completion in('acknowledged','submitted','graded','passed')),
  pass_percent numeric(5,2),prerequisite_item_ids uuid[] not null default '{}',
  position integer not null check(position between 0 and 10000),archived_at timestamptz,
  foreign key(module_id,course_id) references public.teaching_course_modules(id,course_id) on delete cascade,
  check((completion='passed' and pass_percent between 0 and 100) or(completion<>'passed' and pass_percent is null)),
  check((resource_type='material' and completion='acknowledged') or(resource_type in('assignment','test') and completion in('submitted','graded','passed'))),
  check(cardinality(prerequisite_item_ids)<=100)
);
create unique index teaching_course_module_resource_once on public.teaching_course_module_items(course_id,resource_type,resource_id) where archived_at is null;
create index teaching_course_module_items_parent on public.teaching_course_module_items(module_id,position,id) where archived_at is null;
create table public.teaching_course_module_acknowledgements(
  item_id uuid not null references public.teaching_course_module_items(id) on delete cascade,
  group_id uuid not null references public.study_groups(id),user_id uuid not null references public.profiles(id),
  acknowledged_at timestamptz not null default clock_timestamp(),primary key(item_id,group_id,user_id)
);
alter table public.teaching_course_modules enable row level security;
alter table public.teaching_course_module_items enable row level security;
alter table public.teaching_course_module_acknowledgements enable row level security;
revoke all on public.teaching_course_modules,public.teaching_course_module_items,public.teaching_course_module_acknowledgements
  from public,anon,authenticated,service_role;

-- The eligibility predicate deliberately does not call a gated projection or
-- team-submission helper: that would recurse through classroom_student.
create function public.xelay_private_module_resource_targeted(p_type text,p_resource uuid,p_course uuid,p_group uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_teaching_is_member(p_group,p_user) and exists(select 1 from public.teaching_course_groups l
    where l.course_id=p_course and l.group_id=p_group and l.status='accepted') and case when p_type='test' then
    exists(select 1 from public.teaching_tests t where t.id=p_resource and t.course_id=p_course
      and exists(select 1 from jsonb_array_elements(t.targets)x where(x->>'group_id')::uuid=p_group
        and public.xelay_private_teaching_audience_allows(p_course,p_group,x->>'audience_mode',
          array(select value::uuid from jsonb_array_elements_text(x->'subgroup_ids')),'{}'::uuid[],p_user)))
  else exists(select 1 from public.teaching_items i where i.id=p_resource and i.course_id=p_course and i.kind=p_type
    and public.xelay_private_teaching_target_allows(i.id,p_group,p_user)) end;
$$;
create function public.xelay_private_module_resource_eligible(p_type text,p_resource uuid,p_course uuid,p_group uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_private_module_resource_targeted(p_type,p_resource,p_course,p_group,p_user) and case when p_type='test' then
    exists(select 1 from public.teaching_tests t where t.id=p_resource and t.course_id=p_course and t.status<>'draft'
      and exists(select 1 from jsonb_array_elements(t.targets)x where(x->>'group_id')::uuid=p_group
        and public.xelay_private_teaching_audience_allows(p_course,p_group,x->>'audience_mode',
          array(select value::uuid from jsonb_array_elements_text(x->'subgroup_ids')),'{}'::uuid[],p_user)))
  else exists(select 1 from public.teaching_items i where i.id=p_resource and i.course_id=p_course and i.kind=p_type
    and i.status='published' and i.withdrawn_at is null and(i.kind<>'material' or i.access_until is null or i.access_until>clock_timestamp())
    and public.xelay_private_teaching_target_allows(i.id,p_group,p_user)) end;
$$;

create function public.xelay_private_module_item_completion(p_item uuid,p_group uuid,p_user uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_item public.teaching_course_module_items%rowtype;v_done boolean:=false;v_submitted boolean:=false;
  v_grade public.teaching_grades%rowtype;v_max numeric;v_percent numeric;v_at timestamptz;
begin
  select * into v_item from public.teaching_course_module_items where id=p_item and archived_at is null;
  -- A proven completion is history, not a new content grant. Expiry or
  -- withdrawal must not erase an earlier ACK, submitted work or personal grade.
  if not found or not public.xelay_teaching_is_member(p_group,p_user)
    or not exists(select 1 from public.teaching_course_groups where course_id=v_item.course_id and group_id=p_group and status='accepted')
    or not exists(select 1 from public.teaching_course_modules where id=v_item.module_id and p_group=any(group_ids)) then
    return jsonb_build_object('completed',false,'state','unavailable','published_percent',null,'score',null,'max_points',null);end if;
  if v_item.resource_type='material' then
    select acknowledged_at into v_at from public.teaching_course_module_acknowledgements
      where item_id=p_item and group_id=p_group and user_id=p_user;
    v_done:=found;
    return jsonb_build_object('completed',v_done,'state',case when v_done then 'acknowledged' else 'not_started' end,'published_percent',null,'score',null,'max_points',null);
  end if;
  if v_item.resource_type='test' then
    select exists(select 1 from public.teaching_test_attempts a where a.test_id=v_item.resource_id and a.group_id=p_group and a.user_id=p_user
      and a.status='submitted') into v_submitted;
    select g.* into v_grade from public.teaching_grades g join public.teaching_entries e on e.id=g.entry_id
      join public.teaching_activities a on a.id=g.activity_id join public.teaching_test_activities l on l.activity_id=a.id
      where l.test_id=v_item.resource_id and l.group_id=p_group and e.user_id=p_user and e.active and g.published_at is not null;
    select t.max_points into v_max from public.teaching_tests t where t.id=v_item.resource_id;
  else
    -- Teams share a submission, but the published journal value remains personal.
    select exists(select 1 from public.teaching_submissions s where s.item_id=v_item.resource_id and s.group_id=p_group
      and s.status in('submitted','reviewed','returned') and s.submitted_at is not null
      and(s.team_id is null and s.user_id=p_user or s.team_id is not null and exists(select 1 from public.teaching_lab_teams team
        where team.id=s.team_id and team.item_id=s.item_id and team.group_id=s.group_id and p_user=any(team.user_ids)))) into v_submitted;
    select g.* into v_grade from public.teaching_grades g join public.teaching_entries e on e.id=g.entry_id
      join public.teaching_activities a on a.id=g.activity_id
      where a.item_id=v_item.resource_id and a.group_id=p_group and e.user_id=p_user and e.active and g.published_at is not null;
    select max_points into v_max from public.teaching_items where id=v_item.resource_id;
  end if;
  if v_grade.published_score is not null and not coalesce(v_grade.published_absent,false) and v_max>0 then
    v_percent:=round(v_grade.published_score/v_max*100,2);end if;
  v_done:=case v_item.completion when 'submitted' then v_submitted when 'graded' then v_percent is not null
    when 'passed' then coalesce(v_percent>=v_item.pass_percent,false) else false end;
  return jsonb_build_object('completed',v_done,'state',case when v_done then v_item.completion when v_percent is not null then 'not_passed'
    when v_submitted then 'awaiting_grade' else 'not_started' end,'published_percent',v_percent,
    'score',case when v_percent is not null then v_grade.published_score else null end,'max_points',v_max);
end $$;

create function public.xelay_private_module_item_gate(p_item uuid,p_group uuid,p_user uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_item public.teaching_course_module_items%rowtype;v_module public.teaching_course_modules%rowtype;v_dependency uuid;
begin
  select * into v_item from public.teaching_course_module_items where id=p_item and archived_at is null;
  select * into v_module from public.teaching_course_modules where id=v_item.module_id;
  if v_module.status is distinct from 'published' or not(p_group=any(v_module.group_ids)) then
    return jsonb_build_object('locked',false,'reason','');end if;
  if not public.xelay_private_module_resource_eligible(v_item.resource_type,v_item.resource_id,v_item.course_id,p_group,p_user) then
    return jsonb_build_object('locked',true,'reason','Цей елемент зараз недоступний вашій групі.');end if;
  if(v_item.resource_type='assignment' and public.xelay_private_module_existing_work(v_item.resource_id,p_group,p_user))
    or(v_item.resource_type='test' and exists(select 1 from public.teaching_test_attempts where test_id=v_item.resource_id and group_id=p_group and user_id=p_user)) then
    return jsonb_build_object('locked',false,'reason','');end if;
  foreach v_dependency in array(v_module.prerequisite_item_ids||v_item.prerequisite_item_ids) loop
    if not coalesce((public.xelay_private_module_item_completion(v_dependency,p_group,p_user)->>'completed')::boolean,false) then
      return jsonb_build_object('locked',true,'reason','Спочатку виконайте попередні обов’язкові умови.');end if;
  end loop;
  return jsonb_build_object('locked',false,'reason','');
end $$;

-- True only adds a module condition; every caller must retain its original
-- audience/teacher authorization. A module never grants access by itself.
create function public.xelay_private_module_resource_gate(p_type text,p_resource uuid,p_user uuid,p_group uuid default null)
returns boolean language plpgsql stable security definer set search_path='' as $$
declare v_item public.teaching_course_module_items%rowtype;v_module public.teaching_course_modules%rowtype;v_group uuid;
begin
  select i.* into v_item from public.teaching_course_module_items i join public.teaching_course_modules m on m.id=i.module_id
    where i.resource_type=p_type and i.resource_id=p_resource and i.archived_at is null and m.status='published';
  if not found then return true;end if;
  select * into v_module from public.teaching_course_modules where id=v_item.module_id;
  foreach v_group in array v_module.group_ids loop
    if(p_group is null or v_group=p_group) and public.xelay_private_module_resource_eligible(p_type,p_resource,v_item.course_id,v_group,p_user)
      and not(public.xelay_private_module_item_gate(v_item.id,v_group,p_user)->>'locked')::boolean then return true;end if;
  end loop;
  -- The same canonical publication can target groups outside this module. Those
  -- existing audiences are unaffected by a module they were never assigned.
  if p_group is not null and not(p_group=any(v_module.group_ids)) then return true;end if;
  if p_group is null and exists(select 1 from public.teaching_course_groups l where l.course_id=v_item.course_id and l.status='accepted'
    and not(l.group_id=any(v_module.group_ids)) and public.xelay_private_module_resource_eligible(p_type,p_resource,v_item.course_id,l.group_id,p_user)) then return true;end if;
  return false;
end $$;

create function public.xelay_private_module_item_json(p_item uuid,p_user uuid,p_group uuid,p_staff boolean default false)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_item public.teaching_course_module_items%rowtype;v_title text;v_available boolean;v_gate jsonb;v_completion jsonb;
begin
  select * into v_item from public.teaching_course_module_items where id=p_item and archived_at is null;
  if not found then return null;end if;
  if v_item.resource_type='test' then select title into v_title from public.teaching_tests where id=v_item.resource_id and course_id=v_item.course_id;
  else select title into v_title from public.teaching_items where id=v_item.resource_id and course_id=v_item.course_id and kind=v_item.resource_type;end if;
  v_available:=p_staff or public.xelay_private_module_resource_eligible(v_item.resource_type,v_item.resource_id,v_item.course_id,p_group,p_user);
  v_gate:=case when p_staff then '{"locked":false,"reason":""}'::jsonb else public.xelay_private_module_item_gate(p_item,p_group,p_user) end;
  v_completion:=case when p_staff then '{}'::jsonb else public.xelay_private_module_item_completion(p_item,p_group,p_user) end;
  return jsonb_build_object('id',v_item.id,'resource_type',v_item.resource_type,'resource_id',v_item.resource_id,
    'title',case when v_available then coalesce(v_title,'Елемент недоступний') else 'Елемент готується викладачем' end,
    'required',v_item.required,'completion',v_item.completion,'pass_percent',v_item.pass_percent,
    'prerequisite_item_ids',v_item.prerequisite_item_ids,'position',v_item.position,
    'available',v_available,'locked',not v_available or coalesce((v_gate->>'locked')::boolean,false),
    'reason',case when not v_available then 'Елемент готується або поки недоступний вашій групі.' else v_gate->>'reason' end,
    'completed',coalesce((v_completion->>'completed')::boolean,false),'score',v_completion->'score','max_points',v_completion->'max_points')
    -case when p_staff then array['available','locked','reason','completed','score','max_points']::text[] else '{}'::text[] end;
end $$;

create function public.xelay_private_module_json(p_module uuid,p_user uuid,p_group uuid default null,p_staff boolean default false)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_module public.teaching_course_modules%rowtype;v_items jsonb;v_locked boolean:=false;v_dep uuid;v_complete integer;v_total integer;v_groups uuid[];
begin
  select * into v_module from public.teaching_course_modules where id=p_module;
  if not found then return null;end if;
  if not p_staff then
    foreach v_dep in array v_module.prerequisite_item_ids loop
      if not coalesce((public.xelay_private_module_item_completion(v_dep,p_group,p_user)->>'completed')::boolean,false) then v_locked:=true;exit;end if;
    end loop;
  end if;
  select coalesce(jsonb_agg(public.xelay_private_module_item_json(i.id,p_user,p_group,p_staff) order by i.position,i.id),'[]'::jsonb)
    into v_items from public.teaching_course_module_items i where i.module_id=p_module and i.archived_at is null;
  select count(*) filter(where (x->>'required')::boolean),count(*) filter(where(x->>'required')::boolean and(x->>'completed')::boolean)
    into v_total,v_complete from jsonb_array_elements(v_items)x;
  v_groups:=case when p_group is not null then array[p_group] else array(select g from unnest(v_module.group_ids)g
    where public.xelay_teaching_group_permissions(v_module.course_id,g,p_user)&&array['assignments','grades']::text[]) end;
  return jsonb_build_object('id',v_module.id,'course_id',v_module.course_id,'title',v_module.title,
    'description',case when v_locked then '' else v_module.description end,'status',v_module.status,
    'group_ids',v_groups,'position',v_module.position,'version',v_module.version,
    'prerequisite_item_ids',v_module.prerequisite_item_ids,'items',v_items,
    'locked',v_locked,'reason',case when v_locked then 'Спочатку виконайте попередні обов’язкові умови.' else '' end,
    'completed',v_complete,'total',v_total,'percent',case when v_total=0 then 0 else round(v_complete::numeric/v_total*100,2) end)
    -case when p_staff then array['locked','reason','completed','total','percent']::text[] else '{}'::text[] end;
end $$;

create function public.xelay_student_course_modules(p_course_id uuid,p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_modules jsonb;v_title text;v_total integer;v_complete integer;
begin
  select c.title into v_title from public.teaching_courses c join public.teaching_course_groups l on l.course_id=c.id
    and l.group_id=p_group_id and l.status='accepted' where c.id=p_course_id and public.xelay_teaching_is_member(p_group_id,v_uid);
  if not found then raise exception 'COURSE_MODULE_FORBIDDEN' using errcode='42501';end if;
  select coalesce(jsonb_agg(public.xelay_private_module_json(m.id,v_uid,p_group_id,false) order by m.position,m.id),'[]'::jsonb)
    into v_modules from public.teaching_course_modules m where m.course_id=p_course_id and m.status='published' and p_group_id=any(m.group_ids);
  select coalesce(sum((m->>'total')::integer),0),coalesce(sum((m->>'completed')::integer),0) into v_total,v_complete from jsonb_array_elements(v_modules)m;
  return jsonb_build_object('course_id',p_course_id,'group_id',p_group_id,'course_title',v_title,'modules',v_modules,
    'completed',v_complete,'total',v_total,'percent',case when v_total=0 then 0 else round(v_complete::numeric/v_total*100,2) end);
end $$;

create function public.xelay_teaching_course_modules(p_course_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_owner boolean;v_groups jsonb;v_modules jsonb;v_resources jsonb;v_progress jsonb;
begin
  if not public.xelay_teaching_has_current_access(v_uid) then raise exception 'COURSE_MODULE_FORBIDDEN' using errcode='42501';end if;
  select owner_id=v_uid into v_owner from public.teaching_courses where id=p_course_id;
  if not found or not(v_owner or exists(select 1 from public.teaching_course_groups l where l.course_id=p_course_id and l.status='accepted'
    and public.xelay_teaching_group_permissions(p_course_id,l.group_id,v_uid)&&array['assignments','grades']::text[])) then
    raise exception 'COURSE_MODULE_FORBIDDEN' using errcode='42501';end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',g.id,'name',g.group_name) order by g.group_name,g.id),'[]'::jsonb)
    into v_groups from public.teaching_course_groups l join public.study_groups g on g.id=l.group_id
    where l.course_id=p_course_id and l.status='accepted' and(v_owner or public.xelay_teaching_group_permissions(p_course_id,g.id,v_uid)&&array['assignments','grades']::text[]);
  select coalesce(jsonb_agg(public.xelay_private_module_json(m.id,v_uid,null,true) order by m.position,m.id),'[]'::jsonb) into v_modules
    from public.teaching_course_modules m where m.course_id=p_course_id and(v_owner or exists(select 1 from unnest(m.group_ids)g
      where public.xelay_teaching_group_permissions(p_course_id,g,v_uid)&&array['assignments','grades']::text[]));
  select coalesce(jsonb_agg(x.data order by x.title,x.id),'[]'::jsonb) into v_resources from(
    select i.id,i.title,jsonb_build_object('id',i.id,'resource_type',i.kind,'title',i.title,'status',i.status,'max_points',i.max_points,
      'group_ids',array(select t.group_id from public.teaching_item_targets t where t.item_id=i.id and(v_owner
        or public.xelay_teaching_group_permissions(p_course_id,t.group_id,v_uid)&&array['assignments','grades']::text[]))) data
      from public.teaching_items i where i.course_id=p_course_id and i.withdrawn_at is null and(v_owner or exists(select 1 from public.teaching_item_targets t
        where t.item_id=i.id and public.xelay_teaching_group_permissions(p_course_id,t.group_id,v_uid)&&array['assignments','grades']::text[]))
    union all select t.id,t.title,jsonb_build_object('id',t.id,'resource_type','test','title',t.title,'status',t.status,'max_points',t.max_points,
      'group_ids',array(select(x->>'group_id')::uuid from jsonb_array_elements(t.targets)x where v_owner
        or public.xelay_teaching_group_permissions(p_course_id,(x->>'group_id')::uuid,v_uid)&&array['assignments','grades']::text[]))
      from public.teaching_tests t where t.course_id=p_course_id and(v_owner or exists(select 1 from jsonb_array_elements(t.targets)x
        where public.xelay_teaching_group_permissions(p_course_id,(x->>'group_id')::uuid,v_uid)&&array['assignments','grades']::text[]))
  )x;
  select coalesce(jsonb_agg(x.data order by x.full_name,x.group_id,x.user_id),'[]'::jsonb) into v_progress from(
    select p.id user_id,p.full_name,g.id group_id,jsonb_build_object('user_id',p.id,'full_name',p.full_name,'group_id',g.id,'group_name',g.group_name,
      'completed',(learning.data->>'completed')::integer,'total',(learning.data->>'total')::integer,'percent',(learning.data->>'percent')::numeric,
      'items',coalesce((select jsonb_agg(jsonb_build_object('item_id',i->>'id','completed',i->'completed','locked',i->'locked','reason',i->'reason',
        'score',i->'score','max_points',i->'max_points')) from jsonb_array_elements(learning.data->'modules')m,
        jsonb_array_elements(m->'items')i),'[]'::jsonb)) data
    from public.teaching_course_groups l join public.study_groups g on g.id=l.group_id
    join public.profiles p on public.xelay_teaching_is_member(g.id,p.id)
    cross join lateral(select jsonb_build_object('modules',coalesce(jsonb_agg(public.xelay_private_module_json(m.id,p.id,g.id,false) order by m.position,m.id),'[]'::jsonb)) base
      from public.teaching_course_modules m where m.course_id=p_course_id and m.status='published' and g.id=any(m.group_ids)) raw
    cross join lateral(select raw.base||jsonb_build_object('completed',coalesce(sum((m->>'completed')::integer),0),'total',coalesce(sum((m->>'total')::integer),0),
      'percent',case when coalesce(sum((m->>'total')::integer),0)=0 then 0 else round(sum((m->>'completed')::numeric)/sum((m->>'total')::numeric)*100,2) end) data
      from jsonb_array_elements(raw.base->'modules')m) learning
    where l.course_id=p_course_id and l.status='accepted' and(v_owner or 'grades'=any(public.xelay_teaching_group_permissions(p_course_id,g.id,v_uid)))
  )x;
  return jsonb_build_object('course_id',p_course_id,'can_manage',v_owner and exists(select 1 from public.teaching_courses where id=p_course_id and archived_at is null),
    'modules',v_modules,'resources',v_resources,'groups',v_groups,'progress',v_progress);
end $$;

create function public.xelay_private_module_validate_graph(p_course uuid)
returns void language plpgsql stable security definer set search_path='' as $$
declare v_edge record;v_group uuid;v_user uuid;
begin
  -- Validate module prerequisites even while its item list is empty. They
  -- cannot disappear from validation merely because there is no graph edge yet.
  if exists(select 1 from public.teaching_course_modules m
    cross join lateral unnest(m.prerequisite_item_ids)dep(id)
    left join public.teaching_course_module_items i on i.id=dep.id and i.course_id=p_course and i.archived_at is null
    left join public.teaching_course_modules parent on parent.id=i.module_id
    where m.course_id=p_course and m.status<>'archived' and(i.id is null or parent.status='archived'
      or not(m.group_ids<@parent.group_ids) or(m.status='published' and parent.status<>'published'))) then
    raise exception 'COURSE_MODULE_TARGET_MISMATCH';end if;
  if exists(with recursive edges as(select i.id,unnest(i.prerequisite_item_ids||m.prerequisite_item_ids) dependency
      from public.teaching_course_module_items i join public.teaching_course_modules m on m.id=i.module_id
      where i.course_id=p_course and i.archived_at is null and m.status<>'archived'),
    -- UNION deduplicates reachable pairs: at most 500² states, never an
    -- exponentially expanding set of paths through a highly connected graph.
    paths as(select id,dependency from edges union
      select p.id,e.dependency from paths p join edges e on e.id=p.dependency)
    select 1 from paths where id=dependency) then raise exception 'COURSE_MODULE_CYCLE';end if;
  for v_edge in select distinct i.id,i.resource_type,i.resource_id,i.course_id,m.group_ids,m.status,dep.dependency,
      d.resource_type dep_type,d.resource_id dep_resource,d.archived_at dep_archived,dm.group_ids dep_groups,dm.status dep_status
    from public.teaching_course_module_items i join public.teaching_course_modules m on m.id=i.module_id
    cross join lateral unnest(i.prerequisite_item_ids||m.prerequisite_item_ids)dep(dependency)
    left join public.teaching_course_module_items d on d.id=dep.dependency and d.course_id=p_course
    left join public.teaching_course_modules dm on dm.id=d.module_id
    where i.course_id=p_course and i.archived_at is null and m.status<>'archived' loop
    if v_edge.dep_groups is null or v_edge.dep_archived is not null or v_edge.dep_status='archived'
      or not(v_edge.group_ids<@v_edge.dep_groups) or(v_edge.status='published' and v_edge.dep_status<>'published') then
      raise exception 'COURSE_MODULE_TARGET_MISMATCH';end if;
    foreach v_group in array v_edge.group_ids loop
      for v_user in select id from public.profiles where public.xelay_teaching_is_member(v_group,id) loop
        if public.xelay_private_module_resource_targeted(v_edge.resource_type,v_edge.resource_id,p_course,v_group,v_user)
          and not public.xelay_private_module_resource_targeted(v_edge.dep_type,v_edge.dep_resource,p_course,v_group,v_user)
          -- A draft predecessor is intentionally preparing, not a false claim of
          -- completion. Its audience will be checked dynamically on publication.
          and not exists(select 1 from public.teaching_items where id=v_edge.dep_resource and course_id=p_course and status in('draft','scheduled'))
          and not exists(select 1 from public.teaching_tests where id=v_edge.dep_resource and course_id=p_course and status='draft') then
          raise exception 'COURSE_MODULE_TARGET_MISMATCH';end if;
      end loop;
    end loop;
  end loop;
end $$;

create function public.xelay_teaching_course_module_save(p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_course uuid;v_id uuid;v_version integer;v_module public.teaching_course_modules%rowtype;
  v_groups uuid[];v_dependencies uuid[];v_items uuid[]:='{}';v_row jsonb;v_item public.teaching_course_module_items%rowtype;v_item_id uuid;
  v_item_deps uuid[];v_resource uuid;v_type text;v_completion text;v_status text;v_pass numeric;v_position integer;
begin
  if p_payload->>'expected_user_id' is distinct from v_uid::text then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501';end if;
  if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>500000
    or exists(select 1 from jsonb_object_keys(p_payload)k where k not in('id','course_id','title','description','status','group_ids','position','version','expected_user_id','prerequisite_item_ids','items'))
    or jsonb_typeof(p_payload->'group_ids') is distinct from 'array' or jsonb_array_length(p_payload->'group_ids') not between 1 and 100
    or jsonb_typeof(p_payload->'prerequisite_item_ids') is distinct from 'array' or jsonb_array_length(p_payload->'prerequisite_item_ids')>100
    or jsonb_typeof(p_payload->'items') is distinct from 'array' or jsonb_array_length(p_payload->'items')>100
    or length(btrim(coalesce(p_payload->>'title',''))) not between 1 and 180 or length(coalesce(p_payload->>'description',''))>5000
    or p_payload->>'status' not in('draft','published','archived')
    or jsonb_typeof(p_payload->'version') is distinct from 'number' or jsonb_typeof(p_payload->'position') is distinct from 'number'
    or(p_payload->>'version')::numeric<>trunc((p_payload->>'version')::numeric) or(p_payload->>'position')::numeric<>trunc((p_payload->>'position')::numeric) then
    raise exception 'COURSE_MODULE_INVALID';end if;
  v_course:=(p_payload->>'course_id')::uuid;v_id:=(p_payload->>'id')::uuid;v_version:=(p_payload->>'version')::integer;
  v_status:=p_payload->>'status';v_position:=(p_payload->>'position')::integer;
  if v_course is null or v_id is null or v_version<0 or v_version>=2147483647 or v_position not between 0 and 10000 then raise exception 'COURSE_MODULE_INVALID';end if;
  perform 1 from public.teaching_courses where id=v_course and owner_id=v_uid and archived_at is null for update;
  if not found then raise exception 'COURSE_MODULE_FORBIDDEN' using errcode='42501';end if;
  perform public.xelay_private_assert_teacher_current_access(v_uid);
  v_groups:=array(select value::uuid from jsonb_array_elements_text(p_payload->'group_ids'));
  v_dependencies:=array(select value::uuid from jsonb_array_elements_text(p_payload->'prerequisite_item_ids'));
  if array_position(v_groups,null) is not null or cardinality(v_groups)<>(select count(distinct u) from unnest(v_groups)u)
    or array_position(v_dependencies,null) is not null or cardinality(v_dependencies)<>(select count(distinct u) from unnest(v_dependencies)u)
    or exists(select 1 from unnest(v_groups)g where not exists(select 1 from public.teaching_course_groups l where l.course_id=v_course and l.group_id=g and l.status='accepted')) then
    raise exception 'COURSE_MODULE_TARGET_MISMATCH';end if;
  select * into v_module from public.teaching_course_modules where id=v_id for update;
  if found and v_module.course_id<>v_course then raise exception 'COURSE_MODULE_FORBIDDEN' using errcode='42501';end if;
  if coalesce(v_module.version,0)<>v_version then raise exception 'COURSE_MODULE_CONFLICT';end if;
  if v_module.id is null and(select count(*) from public.teaching_course_modules where course_id=v_course)>=100 then raise exception 'COURSE_MODULE_INVALID';end if;
  insert into public.teaching_course_modules(id,course_id,title,description,status,group_ids,prerequisite_item_ids,position,created_by)
    values(v_id,v_course,btrim(p_payload->>'title'),coalesce(p_payload->>'description',''),v_status,v_groups,v_dependencies,v_position,v_uid)
    on conflict(id) do update set title=excluded.title,description=excluded.description,status=excluded.status,group_ids=excluded.group_ids,
      prerequisite_item_ids=excluded.prerequisite_item_ids,position=excluded.position,version=teaching_course_modules.version+1,updated_at=clock_timestamp();
  for v_row in select value from jsonb_array_elements(p_payload->'items') loop
    if jsonb_typeof(v_row) is distinct from 'object' or exists(select 1 from jsonb_object_keys(v_row)k where k not in('id','resource_type','resource_id','required','completion','pass_percent','prerequisite_item_ids','position'))
      or jsonb_typeof(v_row->'required') is distinct from 'boolean' or jsonb_typeof(v_row->'position') is distinct from 'number'
      or(v_row->>'position')::numeric<>trunc((v_row->>'position')::numeric)
      or jsonb_typeof(v_row->'prerequisite_item_ids') is distinct from 'array' or jsonb_array_length(v_row->'prerequisite_item_ids')>100 then raise exception 'COURSE_MODULE_INVALID';end if;
    v_item_id:=(v_row->>'id')::uuid;v_resource:=(v_row->>'resource_id')::uuid;v_type:=v_row->>'resource_type';v_completion:=v_row->>'completion';
    v_pass:=(v_row->>'pass_percent')::numeric;v_item_deps:=array(select value::uuid from jsonb_array_elements_text(v_row->'prerequisite_item_ids'));
    if v_item_id is null or v_resource is null or v_item_id=any(v_items) or v_type not in('material','assignment','test')
      or v_completion not in('acknowledged','submitted','graded','passed') or array_position(v_item_deps,null) is not null
      or cardinality(v_item_deps)<>(select count(distinct u) from unnest(v_item_deps)u)
      or(v_completion='passed' and(v_pass is null or v_pass not between 0 and 100)) or(v_completion<>'passed' and v_pass is not null)
      or(v_type='material' and v_completion<>'acknowledged') or(v_type<>'material' and v_completion='acknowledged') then raise exception 'COURSE_MODULE_INVALID';end if;
    if v_type='test' then
      if not exists(select 1 from public.teaching_tests where id=v_resource and course_id=v_course) then raise exception 'COURSE_MODULE_INVALID';end if;
      if exists(select 1 from unnest(v_groups)g where not exists(select 1 from public.teaching_tests t,jsonb_array_elements(t.targets)x
        where t.id=v_resource and(x->>'group_id')::uuid=g) and not exists(select 1 from public.teaching_tests where id=v_resource and status='draft')) then raise exception 'COURSE_MODULE_TARGET_MISMATCH';end if;
    else
      if not exists(select 1 from public.teaching_items where id=v_resource and course_id=v_course and kind=v_type and withdrawn_at is null) then raise exception 'COURSE_MODULE_INVALID';end if;
      if v_type='assignment' and v_completion in('graded','passed') and not exists(select 1 from public.teaching_items
        where id=v_resource and max_points>0) then raise exception 'COURSE_MODULE_INVALID';end if;
      if exists(select 1 from unnest(v_groups)g where not exists(select 1 from public.teaching_item_targets where item_id=v_resource and group_id=g)
        and not exists(select 1 from public.teaching_items where id=v_resource and status in('draft','scheduled'))) then raise exception 'COURSE_MODULE_TARGET_MISMATCH';end if;
    end if;
    select * into v_item from public.teaching_course_module_items where id=v_item_id for update;
    if found and(v_item.module_id<>v_id or v_item.course_id<>v_course or v_item.resource_id<>v_resource or v_item.resource_type<>v_type) then
      raise exception 'COURSE_MODULE_INVALID';end if;
    if v_status<>'archived' and exists(select 1 from public.teaching_course_module_items where course_id=v_course and resource_type=v_type and resource_id=v_resource and archived_at is null and id<>v_item_id) then
      raise exception 'COURSE_MODULE_RESOURCE_USED';end if;
    insert into public.teaching_course_module_items(id,module_id,course_id,resource_type,resource_id,required,completion,pass_percent,prerequisite_item_ids,position,archived_at)
      values(v_item_id,v_id,v_course,v_type,v_resource,(v_row->>'required')::boolean,v_completion,v_pass,v_item_deps,(v_row->>'position')::integer,
        case when v_status='archived' then clock_timestamp() else null end)
      on conflict(id) do update set required=excluded.required,completion=excluded.completion,pass_percent=excluded.pass_percent,
        prerequisite_item_ids=excluded.prerequisite_item_ids,position=excluded.position,archived_at=excluded.archived_at;
    v_items:=v_items||v_item_id;
  end loop;
  update public.teaching_course_module_items set archived_at=coalesce(archived_at,clock_timestamp()) where module_id=v_id and not(id=any(v_items));
  if(select count(*) from public.teaching_course_module_items where course_id=v_course and archived_at is null)>500 then raise exception 'COURSE_MODULE_INVALID';end if;
  perform public.xelay_private_module_validate_graph(v_course);
  return public.xelay_teaching_course_modules(v_course);
exception when invalid_text_representation or numeric_value_out_of_range or check_violation or not_null_violation or invalid_parameter_value then raise exception 'COURSE_MODULE_INVALID' using errcode='22023';
end $$;

create function public.xelay_teaching_course_modules_reorder(p_course_id uuid,p_module_ids uuid[],p_versions jsonb,p_expected_user_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_id uuid;v_module public.teaching_course_modules%rowtype;v_position integer:=0;
begin
  if p_expected_user_id is distinct from v_uid then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501';end if;
  if p_module_ids is null or cardinality(p_module_ids)>100 or coalesce(array_ndims(p_module_ids),1)<>1
    or jsonb_typeof(p_versions) is distinct from 'object' then raise exception 'COURSE_MODULE_INVALID';end if;
  if array_position(p_module_ids,null) is not null or cardinality(p_module_ids)<>(select count(distinct u) from unnest(p_module_ids)u) then raise exception 'COURSE_MODULE_INVALID';end if;
  perform 1 from public.teaching_courses where id=p_course_id and owner_id=v_uid and archived_at is null for update;
  if not found then raise exception 'COURSE_MODULE_FORBIDDEN' using errcode='42501';end if;
  perform public.xelay_private_assert_teacher_current_access(v_uid);
  if cardinality(p_module_ids)<>(select count(*) from public.teaching_course_modules where course_id=p_course_id and status<>'archived')
    or exists(select 1 from public.teaching_course_modules where course_id=p_course_id and status<>'archived' and not(id=any(p_module_ids)))
    or(select count(*) from jsonb_object_keys(p_versions))<>cardinality(p_module_ids) then raise exception 'COURSE_MODULE_INVALID';end if;
  foreach v_id in array p_module_ids loop
    select * into v_module from public.teaching_course_modules where id=v_id and course_id=p_course_id and status<>'archived' for update;
    if not found or jsonb_typeof(p_versions->v_id::text) is distinct from 'number' then raise exception 'COURSE_MODULE_INVALID';end if;
    if(p_versions->>v_id::text)::numeric is distinct from v_module.version::numeric then raise exception 'COURSE_MODULE_CONFLICT';end if;
    update public.teaching_course_modules set position=v_position,version=version+1,updated_at=clock_timestamp() where id=v_id;
    v_position:=v_position+1;
  end loop;
  return public.xelay_teaching_course_modules(p_course_id);
exception when invalid_text_representation or numeric_value_out_of_range or check_violation then raise exception 'COURSE_MODULE_INVALID' using errcode='22023';
end $$;

create function public.xelay_student_module_acknowledge(p_item_id uuid,p_group_id uuid,p_expected_user_id uuid)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_item public.teaching_course_module_items%rowtype;v_course uuid;
begin
  if p_expected_user_id is distinct from v_uid then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501';end if;
  select course_id into v_course from public.teaching_course_module_items where id=p_item_id and archived_at is null;
  perform 1 from public.teaching_courses where id=v_course for share;
  select i.* into v_item from public.teaching_course_module_items i join public.teaching_course_modules m on m.id=i.module_id
    where i.id=p_item_id and i.resource_type='material' and i.archived_at is null and m.status='published' and p_group_id=any(m.group_ids) for share of i,m;
  if not found or not public.xelay_private_module_resource_eligible('material',v_item.resource_id,v_item.course_id,p_group_id,v_uid) then
    raise exception 'COURSE_MODULE_FORBIDDEN' using errcode='42501';end if;
  if(public.xelay_private_module_item_gate(p_item_id,p_group_id,v_uid)->>'locked')::boolean then raise exception 'COURSE_MODULE_LOCKED';end if;
  insert into public.teaching_course_module_acknowledgements(item_id,group_id,user_id) values(p_item_id,p_group_id,v_uid) on conflict do nothing;
  return public.xelay_student_course_modules(v_item.course_id,p_group_id);
end $$;

-- Existing resource-path guards follow below.
create function public.xelay_private_module_existing_work(p_resource uuid,p_group uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.teaching_submissions s where s.item_id=p_resource and(p_group is null or s.group_id=p_group)
    and(s.team_id is null and s.user_id=p_user or s.team_id is not null and exists(select 1 from public.teaching_lab_teams team
      where team.id=s.team_id and team.item_id=s.item_id and team.group_id=s.group_id and p_user=any(team.user_ids))));
$$;
create function public.xelay_private_module_item_staff(p_resource uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.teaching_items i where i.id=p_resource and(
    coalesce((public.xelay_teaching_material_permissions(i.id,p_user)->>'visible')::boolean,false)
    or exists(select 1 from public.teaching_item_targets t where t.item_id=i.id and(
      (case when i.kind='material' then 'materials' else 'assignments' end)=any(public.xelay_teaching_group_permissions(i.course_id,t.group_id,p_user))
      or(i.kind='assignment' and 'grades'=any(public.xelay_teaching_group_permissions(i.course_id,t.group_id,p_user)))))
    or not exists(select 1 from public.teaching_item_targets t where t.item_id=i.id)
      and(case when i.kind='material' then 'materials' else 'assignments' end)=any(public.xelay_teaching_permissions(i.course_id,p_user))));
$$;

alter function public.xelay_teaching_can_read_item(uuid,uuid) rename to xelay_private_can_read_item_before_modules_20261104;
create function public.xelay_teaching_can_read_item(p_item_id uuid,p_user_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_private_can_read_item_before_modules_20261104(p_item_id,p_user_id)
    and(public.xelay_private_module_item_staff(p_item_id,p_user_id)
      or public.xelay_private_module_existing_work(p_item_id,null,p_user_id)
      or exists(select 1 from public.teaching_items i where i.id=p_item_id
        and public.xelay_private_module_resource_gate(i.kind,i.id,p_user_id)));
$$;

alter function public.xelay_classroom_student(uuid,uuid,uuid) rename to xelay_private_classroom_student_before_modules_20261104;
create function public.xelay_classroom_student(p_item uuid,p_group uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_private_classroom_student_before_modules_20261104(p_item,p_group,p_user)
    and(public.xelay_private_module_existing_work(p_item,p_group,p_user)
      or public.xelay_private_module_resource_gate('assignment',p_item,p_user,p_group));
$$;

alter function public.xelay_private_test_allows(public.teaching_tests,uuid,uuid) rename to xelay_private_test_allows_before_modules_20261104;
create function public.xelay_private_test_allows(p_test public.teaching_tests,p_user uuid,p_group uuid default null)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_private_test_allows_before_modules_20261104(p_test,p_user,p_group)
    and(exists(select 1 from public.teaching_test_attempts a where a.test_id=p_test.id and a.user_id=p_user
      and(p_group is null or a.group_id=p_group)) or public.xelay_private_module_resource_gate('test',p_test.id,p_user,p_group));
$$;

-- Several old aggregate APIs call this shared builder without applying the
-- canonical item predicate first. Return a safe placeholder instead of content.
alter function public.xelay_teaching_item_json(public.teaching_items,uuid) rename to xelay_private_item_json_before_modules_20261104;
create function public.xelay_teaching_item_json(p_item public.teaching_items,p_group uuid default null)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_uid uuid:=auth.uid();
begin
  if public.xelay_private_module_item_staff(p_item.id,v_uid) or public.xelay_private_module_existing_work(p_item.id,p_group,v_uid)
    or public.xelay_private_module_resource_gate(p_item.kind,p_item.id,v_uid,p_group) then
    return public.xelay_private_item_json_before_modules_20261104(p_item,p_group);end if;
  return jsonb_build_object('id',p_item.id,'course_id',p_item.course_id,'kind',p_item.kind,'title',p_item.title,
    'status',p_item.status,'body','','attachments','[]'::jsonb,'links','[]'::jsonb,'link_labels','{}'::jsonb,'targets','[]'::jsonb,
    'module_locked',true,'module_lock_reason','Спочатку виконайте умови відкриття цього кроку.');
end $$;

-- Suppress new generic resource-publication messages for locked recipients.
-- Grade, review, deadline and teacher notifications retain their old behavior.
alter function public.xelay_teaching_notify(uuid,text,text,uuid,uuid,uuid) rename to xelay_private_notify_before_modules_20261104;
create function public.xelay_teaching_notify(p_recipient uuid,p_event text,p_message text,p_course uuid default null,p_group uuid default null,p_actor uuid default null)
returns void language plpgsql volatile security definer set search_path='' as $$
declare v_item uuid;
begin
  if p_event~'^teaching-item:[0-9a-f-]{36}:[0-9]+$' then
    v_item:=split_part(p_event,':',2)::uuid;
    if not public.xelay_teaching_can_read_item(v_item,p_recipient) then return;end if;
  end if;
  perform public.xelay_private_notify_before_modules_20261104(p_recipient,p_event,p_message,p_course,p_group,p_actor);
end $$;

-- Close every implementation helper, including renamed originals. Public
-- owner/student RPCs are the only new authenticated entrypoints.
do $acl$
declare v_function regprocedure;
begin
  for v_function in select p.oid::regprocedure from pg_catalog.pg_proc p where p.pronamespace='public'::regnamespace
    and(p.proname like 'xelay_private_module_%' or p.proname in(
      'xelay_private_can_read_item_before_modules_20261104','xelay_private_classroom_student_before_modules_20261104',
      'xelay_private_test_allows_before_modules_20261104','xelay_private_item_json_before_modules_20261104','xelay_private_notify_before_modules_20261104',
      'xelay_teaching_can_read_item','xelay_classroom_student','xelay_private_test_allows','xelay_teaching_item_json','xelay_teaching_notify',
      'xelay_teaching_course_modules','xelay_teaching_course_module_save','xelay_teaching_course_modules_reorder',
      'xelay_student_course_modules','xelay_student_module_acknowledge')) loop
    execute 'revoke all on function '||v_function||' from public,anon,authenticated,service_role';
  end loop;
end $acl$;
grant execute on function public.xelay_teaching_course_modules(uuid),public.xelay_teaching_course_module_save(jsonb),
  public.xelay_teaching_course_modules_reorder(uuid,uuid[],jsonb,uuid),public.xelay_student_course_modules(uuid,uuid),
  public.xelay_student_module_acknowledge(uuid,uuid,uuid) to authenticated;

-- Leased email context is installed below, with its independent service ACL.
-- Fragment for migration 050. No standalone transaction: integrate after gates.
-- The worker receives only identifiers and eligibility, never item text/files.
create function public.xelay_teaching_item_email_context(p_job_id uuid,p_lock_token uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_notice record;
  v_item public.teaching_items%rowtype;
  v_group uuid;
  v_permission text;
begin
  if auth.role() is distinct from 'service_role' then
    raise exception 'EMAIL_SERVICE_REQUIRED' using errcode='42501';
  end if;
  select n.teaching_event_key,n.teaching_course_id,n.study_group_id,q.recipient_id into v_notice
  from public.notification_email_outbox q
  join public.notifications n on n.id::text=q.notification_id
    and n.recipient_id::text=q.recipient_id::text and n.type=q.notification_type
  join public.teaching_courses c on c.id=n.teaching_course_id and c.archived_at is null
  join auth.users u on u.id=q.recipient_id and u.deleted_at is null
    and coalesce(u.banned_until,'-infinity'::timestamptz)<=statement_timestamp()
  where q.id=p_job_id and q.lock_token=p_lock_token and q.status='processing'
    and q.locked_until>clock_timestamp() and q.notification_type='teaching_update'
    and n.teaching_event_key ~ '^teaching-item:[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}:[0-9]+$';
  if not found then return jsonb_build_object('eligible',false,'reason','teaching_item_context_missing'); end if;

  select i.* into v_item from public.teaching_items i
  where i.id=split_part(v_notice.teaching_event_key,':',2)::uuid
    and i.course_id=v_notice.teaching_course_id and i.status='published' and i.withdrawn_at is null
    and i.version::text=split_part(v_notice.teaching_event_key,':',3)
    and public.xelay_teaching_can_read_item(i.id,v_notice.recipient_id);
  if not found then return jsonb_build_object('eligible',false,'reason','teaching_item_unavailable'); end if;

  v_permission:=case when v_item.kind='material' then 'materials' else 'assignments' end;
  -- Library owners/delegates and current teaching grants retain their previews.
  if coalesce((public.xelay_teaching_material_permissions(v_item.id,v_notice.recipient_id)->>'visible')::boolean,false)
    or v_permission=any(public.xelay_teaching_permissions(v_item.course_id,v_notice.recipient_id))
    or exists(select 1 from public.teaching_item_targets t where t.item_id=v_item.id and(
      v_permission=any(public.xelay_teaching_group_permissions(v_item.course_id,t.group_id,v_notice.recipient_id))
      or(v_item.kind='assignment' and 'grades'=any(public.xelay_teaching_group_permissions(v_item.course_id,t.group_id,v_notice.recipient_id))))) then
    return jsonb_build_object('eligible',true,'source_id',v_item.id,'course_id',v_item.course_id,'kind',v_item.kind,'group_id',null);
  end if;

  select t.group_id into v_group from public.teaching_item_targets t
  where t.item_id=v_item.id and(v_notice.study_group_id is null or t.group_id=v_notice.study_group_id)
    and public.xelay_private_teaching_target_allows(v_item.id,t.group_id,v_notice.recipient_id)
    and case when v_item.kind='assignment' then public.xelay_classroom_student(v_item.id,t.group_id,v_notice.recipient_id)
      else public.xelay_private_module_resource_gate('material',v_item.id,v_notice.recipient_id,t.group_id) end
  order by t.group_id limit 1;
  if v_group is null then return jsonb_build_object('eligible',false,'reason','teaching_item_unavailable'); end if;
  return jsonb_build_object('eligible',true,'source_id',v_item.id,'course_id',v_item.course_id,'kind',v_item.kind,'group_id',v_group);
end $$;
revoke all on function public.xelay_teaching_item_email_context(uuid,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_item_email_context(uuid,uuid) to service_role;


notify pgrst,'reload schema';
commit;
