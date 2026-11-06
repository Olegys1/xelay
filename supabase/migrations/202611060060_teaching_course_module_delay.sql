begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

alter table public.teaching_course_modules
  add column release_delay_days integer not null default 0 check (release_delay_days between 0 and 365);

-- Read the same student, group, and qualifying event as the completion gate.
-- A later test attempt must not move the time of the first valid submission.
create function public.xelay_private_module_completion_at(p_item uuid,p_group uuid,p_user uuid)
returns timestamptz language plpgsql stable security definer set search_path='' as $$
declare v_item public.teaching_course_module_items%rowtype;v_at timestamptz;
begin
  if not coalesce((public.xelay_private_module_item_completion(p_item,p_group,p_user)->>'completed')::boolean,false) then
    return null;
  end if;
  select * into v_item from public.teaching_course_module_items where id=p_item;
  if v_item.resource_type='material' then
    select acknowledged_at into v_at from public.teaching_course_module_acknowledgements
      where item_id=p_item and group_id=p_group and user_id=p_user;
  elsif v_item.completion='submitted' and v_item.resource_type='test' then
    select min(a.submitted_at) into v_at from public.teaching_test_attempts a
      where a.test_id=v_item.resource_id and a.group_id=p_group and a.user_id=p_user and a.status='submitted';
  elsif v_item.completion='submitted' then
    select min(s.submitted_at) into v_at from public.teaching_submissions s
      where s.item_id=v_item.resource_id and s.group_id=p_group and s.status in('submitted','reviewed','returned')
        and (s.team_id is null and s.user_id=p_user or s.team_id is not null and exists(
          select 1 from public.teaching_lab_teams team
          where team.id=s.team_id and team.item_id=s.item_id and team.group_id=s.group_id and p_user=any(team.user_ids)));
  else
    select g.published_at into v_at from public.teaching_grades g
      join public.teaching_entries e on e.id=g.entry_id
      join public.teaching_activities a on a.id=g.activity_id
      where a.course_id=v_item.course_id and a.group_id=p_group and e.user_id=p_user and e.active and g.published_at is not null
        and (v_item.resource_type='assignment' and a.item_id=v_item.resource_id or v_item.resource_type='test' and exists(
          select 1 from public.teaching_test_activities l where l.activity_id=a.id and l.test_id=v_item.resource_id and l.group_id=p_group));
  end if;
  return v_at;
end $$;

create function public.xelay_private_module_delay_until(p_module uuid,p_group uuid,p_user uuid)
returns timestamptz language plpgsql stable security definer set search_path='' as $$
declare v_delay integer;v_steps uuid[];v_step uuid;v_at timestamptz;v_last timestamptz;
begin
  select release_delay_days,prerequisite_item_ids into v_delay,v_steps from public.teaching_course_modules
    where id=p_module and status='published' and p_group=any(group_ids) and release_delay_days>0;
  if not found then return null;end if;
  foreach v_step in array v_steps loop
    v_at:=public.xelay_private_module_completion_at(v_step,p_group,p_user);
    if v_at is null then return 'infinity'::timestamptz;end if;
    v_last:=greatest(v_last,v_at);
  end loop;
  -- Hours keep the delay independent of daylight saving time and server timezone.
  return coalesce(v_last+make_interval(hours=>v_delay*24),'infinity'::timestamptz);
end $$;

-- This function is used by the signed-video policy and playback progress too.
-- Preserve its identity so every pre-existing dependency sees the delay.
create or replace function public.xelay_private_module_lecture_open(p_module uuid,p_group uuid,p_user uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.teaching_course_modules m join public.teaching_course_groups g
      on g.course_id=m.course_id and g.group_id=p_group and g.status='accepted'
    where m.id=p_module and m.status='published' and p_group=any(m.group_ids)
      and public.xelay_teaching_is_member(p_group,p_user)
      and not exists(select 1 from unnest(m.prerequisite_item_ids) d
        where not coalesce((public.xelay_private_module_item_completion(d,p_group,p_user)->>'completed')::boolean,false))
      and not coalesce(public.xelay_private_module_delay_until(m.id,p_group,p_user)>statement_timestamp(),false)
      and not exists(select 1 from public.teaching_course_modules prior
        join public.teaching_course_module_lectures lecture on lecture.module_id=prior.id
        where prior.course_id=m.course_id and prior.status='published' and p_group=any(prior.group_ids)
          and (prior.position,prior.id)<(m.position,m.id)
          and (not public.xelay_private_module_lecture_watched(prior.id,p_group,p_user)
            or not coalesce((public.xelay_private_module_item_completion(lecture.test_item_id,p_group,p_user)->>'completed')::boolean,false))));
$$;

create or replace function public.xelay_private_module_item_gate(p_item uuid,p_group uuid,p_user uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_gate jsonb:=public.xelay_private_module_item_gate_before_lectures(p_item,p_group,p_user);
  v_item public.teaching_course_module_items%rowtype;v_lecture public.teaching_course_module_lectures%rowtype;
begin
  if coalesce((v_gate->>'locked')::boolean,false) then return v_gate;end if;
  select i.* into v_item from public.teaching_course_module_items i
    join public.teaching_course_modules m on m.id=i.module_id
    where i.id=p_item and i.archived_at is null and m.status='published' and p_group=any(m.group_ids);
  if not found then return v_gate;end if;
  -- Never interrupt existing work when a teacher restructures the course.
  if (v_item.resource_type='test' and exists(select 1 from public.teaching_test_attempts
      where test_id=v_item.resource_id and group_id=p_group and user_id=p_user))
    or (v_item.resource_type='assignment' and public.xelay_private_module_existing_work(v_item.resource_id,p_group,p_user)) then return v_gate;end if;
  if public.xelay_private_module_delay_until(v_item.module_id,p_group,p_user)>statement_timestamp() then
    return jsonb_build_object('locked',true,'reason','Триває час очікування після виконання попередніх кроків.');
  end if;
  select * into v_lecture from public.teaching_course_module_lectures where module_id=v_item.module_id;
  if not found then return v_gate;end if;
  if not public.xelay_private_module_lecture_open(v_item.module_id,p_group,p_user) then
    return jsonb_build_object('locked',true,'reason','Спочатку завершіть попередні лекції та їхні тести.');
  end if;
  if v_lecture.test_item_id=p_item and not public.xelay_private_module_lecture_watched(v_item.module_id,p_group,p_user) then
    return jsonb_build_object('locked',true,'reason','Перегляньте щонайменше 90% відеолекції, щоб відкрити тест.');
  end if;
  return v_gate;
end $$;

create or replace function public.xelay_private_module_json(p_module uuid,p_user uuid,p_group uuid default null,p_staff boolean default false)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_result jsonb:=public.xelay_private_module_json_before_lectures(p_module,p_user,p_group,p_staff);
  v_lecture public.teaching_course_module_lectures%rowtype;v_open boolean;v_watched integer;v_required integer;
  v_count integer;v_total integer;v_delay integer;v_available_at timestamptz;
begin
  if v_result is null then return null;end if;
  select release_delay_days into v_delay from public.teaching_course_modules where id=p_module;
  v_result:=v_result||jsonb_build_object('release_delay_days',v_delay);
  if not p_staff and v_delay>0 then
    v_available_at:=public.xelay_private_module_delay_until(p_module,p_group,p_user);
    if v_available_at>statement_timestamp() then
      v_result:=v_result||jsonb_build_object('locked',true,'description','',
        'available_at',case when isfinite(v_available_at) then v_available_at else null end,
        'reason',case when isfinite(v_available_at) then 'Триває час очікування після виконання попередніх кроків.'
          else 'Спочатку виконайте попередні обов’язкові умови.' end);
    end if;
  end if;
  select * into v_lecture from public.teaching_course_module_lectures where module_id=p_module;
  if not found then return v_result;end if;
  if p_staff then
    return v_result||jsonb_build_object('lecture',jsonb_build_object(
      'file',v_lecture.file,'duration_seconds',v_lecture.duration_seconds,'test_item_id',v_lecture.test_item_id));
  end if;
  v_open:=public.xelay_private_module_lecture_open(p_module,p_group,p_user);
  select watched_seconds into v_watched from public.teaching_course_module_lecture_progress
    where module_id=p_module and group_id=p_group and user_id=p_user and storage_path=v_lecture.storage_path;
  v_watched:=coalesce(v_watched,0);
  v_required:=ceil(v_lecture.duration_seconds*0.9);
  v_count:=(v_result->>'completed')::integer+case when v_watched>=v_required then 1 else 0 end;
  v_total:=(v_result->>'total')::integer+1;
  return v_result||jsonb_build_object('lecture',jsonb_build_object('file',case when v_open then v_lecture.file else null end,
    'duration_seconds',v_lecture.duration_seconds,'test_item_id',v_lecture.test_item_id,'watched_seconds',v_watched,
    'required_seconds',v_required,'completed',v_watched>=v_required),'locked',not v_open,
    'reason',case when v_open then '' else coalesce(nullif(v_result->>'reason',''),'Спочатку завершіть попередні лекції та їхні тести.') end,
    'description',case when v_open then v_result->>'description' else '' end,
    'completed',v_count,'total',v_total,'percent',round(v_count::numeric/v_total*100,2));
end $$;

alter function public.xelay_teaching_course_module_save(jsonb) rename to xelay_private_course_module_save_before_delay;
create function public.xelay_teaching_course_module_save(p_payload jsonb)
returns jsonb language plpgsql volatile security definer set search_path='' as $$
declare v_uid uuid:=public.xelay_teaching_assert_user();v_result jsonb;v_module public.teaching_course_modules%rowtype;v_delay integer;
begin
  if p_payload->>'expected_user_id' is distinct from v_uid::text then raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501';end if;
  if p_payload?'release_delay_days' then
    if jsonb_typeof(p_payload->'release_delay_days') is distinct from 'number'
      or coalesce(p_payload->>'release_delay_days','') !~ '^[0-9]{1,3}$' then raise exception 'COURSE_MODULE_DELAY_INVALID';end if;
    v_delay:=(p_payload->>'release_delay_days')::integer;
    if v_delay>365 then raise exception 'COURSE_MODULE_DELAY_INVALID';end if;
  end if;
  -- Existing authorization, optimistic versioning, and course lock are kept.
  v_result:=public.xelay_private_course_module_save_before_delay(p_payload-'release_delay_days');
  select * into v_module from public.teaching_course_modules where id=(p_payload->>'id')::uuid;
  if coalesce(v_delay,v_module.release_delay_days)>0 and cardinality(v_module.prerequisite_item_ids)=0 then
    raise exception 'COURSE_MODULE_DELAY_REQUIRES_STEPS';
  end if;
  if v_delay is null or v_delay=v_module.release_delay_days then return v_result;end if;
  update public.teaching_course_modules set release_delay_days=v_delay where id=v_module.id;
  return public.xelay_teaching_course_modules(v_module.course_id);
end $$;

revoke all on function public.xelay_private_module_completion_at(uuid,uuid,uuid),
  public.xelay_private_module_delay_until(uuid,uuid,uuid),public.xelay_private_course_module_save_before_delay(jsonb),
  public.xelay_teaching_course_module_save(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_course_module_save(jsonb) to authenticated;
notify pgrst,'reload schema';
commit;
