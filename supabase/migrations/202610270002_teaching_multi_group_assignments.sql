-- Local implementation: shared assignment content with explicit, independent
-- per-group placements. The canonical writer retains resource validation,
-- scheduling, notifications, activities and atomic idempotent create receipts.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $$ begin
  if to_regprocedure('public.xelay_teaching_group_permissions(uuid,uuid,uuid)') is null
    or to_regprocedure('public.xelay_teaching_mutate(text,jsonb)') is null
    or to_regprocedure('public.xelay_classroom_lock_group(uuid,uuid,text)') is null
    or not exists(select 1 from pg_attribute where attrelid='public.teaching_item_targets'::regclass
      and attname='closes_at' and not attisdropped)
    or not exists(select 1 from pg_attribute where attrelid='public.teaching_items'::regclass
      and attname='work_type' and not attisdropped) then
    raise exception 'TEACHING_MULTI_ASSIGNMENT_PREREQUISITES_MISSING';
  end if;
end $$;

create function public.xelay_teaching_save_multi_assignment(p_payload jsonb)
returns jsonb language plpgsql security definer set search_path='' as $$
declare
  v_uid uuid:=public.xelay_teaching_assert_user();v_id uuid;v_course uuid;v_target jsonb;v_group uuid;
begin
  if jsonb_typeof(p_payload) is distinct from 'object' or octet_length(p_payload::text)>100000
    or jsonb_typeof(p_payload->'version') is distinct from 'number' or p_payload->>'version'<>'0'
    or jsonb_typeof(p_payload->'targets') is distinct from 'array'
    or jsonb_array_length(p_payload->'targets') not between 2 and 30
    or p_payload ? 'source_item_id' or p_payload ? 'source_version'
    or p_payload ? 'destination_group_id' then raise exception 'TEACHING_INVALID_INPUT'; end if;
  if nullif(p_payload->>'expected_user_id','')::uuid is distinct from v_uid then
    raise exception 'TEACHING_ACTOR_CHANGED' using errcode='42501'; end if;
  v_id:=nullif(p_payload->>'id','')::uuid;v_course:=nullif(p_payload->>'course_id','')::uuid;
  if v_id is null or v_course is null
    or(p_payload ? 'work_type' and(jsonb_typeof(p_payload->'work_type') is distinct from 'string'
      or length(p_payload->>'work_type')>100)) then raise exception 'TEACHING_INVALID_INPUT'; end if;
  if(select count(*) from jsonb_array_elements(p_payload->'targets'))<>
    (select count(distinct (value->>'group_id')::uuid) from jsonb_array_elements(p_payload->'targets')) then
    raise exception 'TEACHING_INVALID_INPUT'; end if;

  -- Same request -> course -> sorted group timetable/link order as the canonical
  -- create path. Recheck
  -- current scopes even for an identical receipt retry after permission changes.
  perform pg_advisory_xact_lock(hashtextextended('xelay:teaching-create:'||v_uid::text||':save_assignment:'||v_id::text,0));
  perform public.xelay_teaching_lock_course(v_course,'assignments');
  for v_target in select value from jsonb_array_elements(p_payload->'targets') order by (value->>'group_id')::uuid loop
    if jsonb_typeof(v_target) is distinct from 'object' then raise exception 'TEACHING_INVALID_INPUT'; end if;
    v_group:=nullif(v_target->>'group_id','')::uuid;
    perform pg_advisory_xact_lock(hashtextextended('xelay:seminars:'||v_group::text,0));
    perform public.xelay_classroom_lock_group(v_course,v_group,'assignments');
    if not coalesce('assignments'=any(public.xelay_teaching_group_permissions(v_course,v_group,v_uid)),false)
      or(p_payload->'max_points' is not null and p_payload->'max_points'<>'null'::jsonb
        and not coalesce('grades'=any(public.xelay_teaching_group_permissions(v_course,v_group,v_uid)),false)) then
      raise exception 'TEACHING_FORBIDDEN' using errcode='42501'; end if;
  end loop;
  -- No loops of independent writes: any invalid lesson/date/cutoff/resource or
  -- unauthorized target rolls back every target and all notification side effects.
  return public.xelay_teaching_mutate('save_assignment',p_payload);
end $$;
revoke all on function public.xelay_teaching_save_multi_assignment(jsonb) from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_save_multi_assignment(jsonb) to authenticated;
comment on function public.xelay_teaching_save_multi_assignment(jsonb) is
  'Create one shared assignment for 2–30 explicitly authorized groups; per-group placements/submissions remain isolated. Version 0 and exact canonical create receipts only.';
notify pgrst,'reload schema';
commit;
