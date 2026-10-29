-- Explicit group course identity. No guessed backfill or approval reassignment.
begin;
set local lock_timeout='5s';
set local statement_timeout='60s';

do $preflight$ begin
  if to_regprocedure('public.xelay_current_academic_year()') is null
    or to_regprocedure('public.xelay_private_representative_account_active(uuid)') is null
    or to_regprocedure('public.xelay_create_study_group(uuid)') is null
    or to_regprocedure('public.xelay_guard_study_group_cohort_snapshot()') is null
    or to_regprocedure('public.xelay_teaching_workspace()') is null
    or to_regprocedure('public.xelay_teaching_mutate(text,jsonb)') is null
    or to_regclass('public.study_groups_academic_cohort_unique_idx') is null then
    raise exception 'GROUP_COURSE_PREREQUISITES_MISSING';
  end if;
  if to_regclass('public.study_group_course_confirmations') is not null
    or to_regprocedure('public.xelay_teaching_workspace_before_group_course_20261029()') is not null then
    raise exception 'GROUP_COURSE_ALREADY_INSTALLED';
  end if;
end $preflight$;

create table public.study_group_course_confirmations(
  request_id uuid primary key,
  group_id uuid not null references public.study_groups(id) on delete cascade,
  actor_id uuid not null,
  representative_id uuid not null,
  academic_year integer not null check(academic_year between 1900 and 2199),
  course integer not null check(course between 1 and 6),
  cohort_start_year integer not null check(cohort_start_year between 1900 and 2200),
  study_level text not null check(study_level in('bachelor','master','postgraduate')),
  previous_cohort_start_year integer,
  previous_study_level text,
  repair_pending boolean not null default false,
  source text not null default 'representative' check(source in('representative','administrator')),
  confirmed_at timestamptz not null default clock_timestamp(),
  check(cohort_start_year=academic_year-course+1),
  check((previous_cohort_start_year is null)=(previous_study_level is null))
);
create index study_group_course_confirmations_group_idx on public.study_group_course_confirmations(group_id,confirmed_at desc);
alter table public.study_group_course_confirmations enable row level security;
revoke all on public.study_group_course_confirmations from public,anon,authenticated,service_role;
comment on table public.study_group_course_confirmations is
  'Closed explicit group-course receipts. Historical actor IDs add no profile-deletion barrier. A pending exact receipt permits only one previously unknown pair to be filled in its transaction; no known cohort or approved request is reinterpreted.';

create function public.xelay_private_study_group_course_confirmed(p_group_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.study_groups g where g.id=p_group_id and g.cohort_start_year is not null
    and g.study_level is not null and exists(select 1 from public.study_group_course_confirmations c
      where c.group_id=g.id and not c.repair_pending and c.cohort_start_year=g.cohort_start_year and c.study_level=g.study_level));
$$;
create function public.xelay_private_study_group_course_ready(p_group_id uuid)
returns boolean language sql stable security definer set search_path='' as $$
  select public.xelay_private_study_group_course_confirmed(p_group_id) and exists(select 1 from public.study_groups g
    where g.id=p_group_id and public.xelay_current_academic_year()::integer-g.cohort_start_year+1 between 1 and 6);
$$;
revoke all on function public.xelay_private_study_group_course_confirmed(uuid),
  public.xelay_private_study_group_course_ready(uuid) from public,anon,authenticated,service_role;

-- Existing identities remain immutable. Browser-set GUCs are never authority.
-- Only a closed, exact receipt inserted by the owner/admin RPC can fill nulls.
create or replace function public.xelay_guard_study_group_cohort_snapshot()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.cohort_start_year is not distinct from old.cohort_start_year
    and new.study_level is not distinct from old.study_level then return new;end if;
  if old.cohort_start_year is null and old.study_level is null
    and new.cohort_start_year is not null and new.study_level is not null
    and (to_jsonb(new)-'cohort_start_year'-'study_level') is not distinct from (to_jsonb(old)-'cohort_start_year'-'study_level')
    and exists(select 1 from public.study_group_course_confirmations c
      where c.group_id=old.id and c.repair_pending and c.actor_id=auth.uid()
        and c.representative_id=old.representative_id and c.previous_cohort_start_year is null and c.previous_study_level is null
        and c.cohort_start_year=new.cohort_start_year and c.study_level=new.study_level
        and ((c.source='representative' and old.representative_id=auth.uid())
          or(c.source='administrator' and public.xelay_is_platform_admin() and coalesce(auth.jwt()->>'aal','')='aal2'))) then
    return new;
  end if;
  raise exception 'GROUP_COHORT_SNAPSHOT_IMMUTABLE' using errcode='42501';
end;
$$;
revoke all on function public.xelay_guard_study_group_cohort_snapshot() from public,anon,authenticated,service_role;

create function public.xelay_guard_new_study_group_course()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.cohort_start_year is null or new.study_level is null then
    raise exception 'GROUP_COURSE_REQUIRED' using errcode='22023';end if;
  return new;
end;
$$;
revoke all on function public.xelay_guard_new_study_group_course() from public,anon,authenticated,service_role;
create trigger study_group_course_required before insert on public.study_groups for each row
  execute function public.xelay_guard_new_study_group_course();

create function public.xelay_study_group_course_status(p_group_id uuid)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_group public.study_groups%rowtype;
  v_year integer:=public.xelay_current_academic_year()::integer;v_course integer;v_confirmed boolean;v_archived boolean;
begin
  if v_user is null or not public.xelay_private_representative_account_active(v_user) then
    raise exception 'GROUP_COURSE_AUTH_REQUIRED' using errcode='42501';end if;
  select * into v_group from public.study_groups where id=p_group_id and representative_id=v_user;
  if not found then raise exception 'GROUP_COURSE_NOT_OWNER' using errcode='42501';end if;
  v_course:=v_year-v_group.cohort_start_year+1;
  v_archived:=v_group.cohort_start_year is not null and not(v_course between 1 and 6);
  v_confirmed:=public.xelay_private_study_group_course_confirmed(v_group.id);
  return jsonb_build_object('group_id',v_group.id,'academic_year',v_year,'cohort_start_year',v_group.cohort_start_year,
    'study_level',v_group.study_level,'current_course',case when v_course between 1 and 6 then v_course else null end,
    'archived',v_archived,'outside_current_period',v_archived,'confirmed',v_confirmed,
    'needs_confirmation',not v_archived and not v_confirmed);
end;
$$;

create function public.xelay_confirm_study_group_course(
  p_group_id uuid,p_course integer,p_study_level text,p_academic_year integer,p_request_id uuid
)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v_user uuid:=auth.uid();v_group public.study_groups%rowtype;v_receipt public.study_group_course_confirmations%rowtype;
  v_cohort integer;v_prior public.class_representative_requests%rowtype;
begin
  if v_user is null or not public.xelay_private_representative_account_active(v_user) then
    raise exception 'GROUP_COURSE_AUTH_REQUIRED' using errcode='42501';end if;
  if p_group_id is null or p_request_id is null or p_course is null or p_course not between 1 and 6
    or p_study_level is null or p_study_level not in('bachelor','master','postgraduate')
    or p_academic_year is null or p_academic_year is distinct from public.xelay_current_academic_year()::integer then
    raise exception 'GROUP_COURSE_INVALID_INPUT' using errcode='22023';end if;
  v_cohort:=p_academic_year-p_course+1;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay:group-course-command:'||p_request_id::text,0));
  select * into v_receipt from public.study_group_course_confirmations where request_id=p_request_id;
  if found then
    if v_receipt.actor_id<>v_user or v_receipt.group_id<>p_group_id or v_receipt.course<>p_course
      or v_receipt.study_level<>p_study_level or v_receipt.academic_year<>p_academic_year or v_receipt.repair_pending then
      raise exception 'GROUP_COURSE_REQUEST_REUSED' using errcode='22023';end if;
    return jsonb_build_object('group_id',p_group_id,'academic_year',v_receipt.academic_year,'course',v_receipt.course,
      'cohort_start_year',v_receipt.cohort_start_year,'study_level',v_receipt.study_level,'confirmed_at',v_receipt.confirmed_at,'replayed',true);
  end if;
  select * into v_group from public.study_groups where id=p_group_id and representative_id=v_user;
  if not found then raise exception 'GROUP_COURSE_NOT_OWNER' using errcode='42501';end if;
  -- Same base-identity namespace/order as group creation, then ownership writes.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay-study-group-identity:'||v_group.university_id::text||':'||v_group.academic_unit_id::text
    ||':'||lower(btrim(v_group.specialty))||':'||lower(btrim(v_group.group_name)),0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('xelay:seminars:'||p_group_id::text,0));
  select * into v_group from public.study_groups where id=p_group_id for update;
  if not found or v_group.representative_id<>v_user then raise exception 'GROUP_COURSE_NOT_OWNER' using errcode='42501';end if;
  if v_group.cohort_start_year is not null and (v_group.cohort_start_year<>v_cohort or v_group.study_level<>p_study_level) then
    raise exception 'GROUP_COURSE_IDENTITY_MISMATCH' using errcode='PT409';end if;
  select * into v_prior from public.class_representative_requests where id=v_group.representative_request_id;
  if v_group.cohort_start_year is null and v_prior.cohort_start_year is not null
    and(v_prior.cohort_start_year<>v_cohort or v_prior.study_level<>p_study_level) then
    raise exception 'GROUP_COURSE_APPROVAL_MISMATCH' using errcode='PT409';end if;
  if exists(select 1 from public.study_groups g where g.id<>p_group_id and g.university_id=v_group.university_id
    and g.academic_unit_id=v_group.academic_unit_id and lower(btrim(g.specialty))=lower(btrim(v_group.specialty))
    and lower(btrim(g.group_name))=lower(btrim(v_group.group_name)) and g.cohort_start_year=v_cohort and g.study_level=p_study_level) then
    raise exception 'GROUP_ALREADY_EXISTS' using errcode='PT409';end if;
  insert into public.study_group_course_confirmations(request_id,group_id,actor_id,representative_id,academic_year,course,
    cohort_start_year,study_level,previous_cohort_start_year,previous_study_level,repair_pending)
    values(p_request_id,p_group_id,v_user,v_group.representative_id,p_academic_year,p_course,v_cohort,p_study_level,
      v_group.cohort_start_year,v_group.study_level,v_group.cohort_start_year is null) returning * into v_receipt;
  if v_group.cohort_start_year is null then
    update public.study_groups set cohort_start_year=v_cohort,study_level=p_study_level where id=p_group_id;
    update public.study_group_course_confirmations set repair_pending=false where request_id=p_request_id;
  end if;
  return jsonb_build_object('group_id',p_group_id,'academic_year',p_academic_year,'course',p_course,'cohort_start_year',v_cohort,
    'study_level',p_study_level,'confirmed_at',v_receipt.confirmed_at,'replayed',false);
exception when unique_violation then raise exception 'GROUP_ALREADY_EXISTS' using errcode='PT409';
end;
$$;
revoke all on function public.xelay_study_group_course_status(uuid),
  public.xelay_confirm_study_group_course(uuid,integer,text,integer,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_study_group_course_status(uuid),
  public.xelay_confirm_study_group_course(uuid,integer,text,integer,uuid) to authenticated;

-- Add an explicit-course creation endpoint by cloning only the exact known
-- creation body, including the shipped transfer/reclaim denial. Original RPC
-- source/metadata/approval rows remain untouched. A request is still single-use.
do $explicit_create$
declare v_source text;v_local text;v_marker text;v_injected text;v_end text;
begin
  select prosrc into v_source from pg_catalog.pg_proc where oid=to_regprocedure('public.xelay_create_study_group(uuid)');
  v_local:=replace(v_source,E'\r','');
  v_marker:='  if v_request.cohort_start_year is null then';
  v_end:='  return v_group_id;'||E'\nend;';
  if strpos(v_local,'STUDY_GROUP_REQUEST_TRANSFERRED')=0
    or strpos(v_local,'if auth.uid() is null then raise exception ''Authentication required''; end if;')=0
    or strpos(v_local,'where id=p_request_id and user_id=auth.uid() and status=''approved'' for update;')=0
    or strpos(v_local,'where representative_request_id=p_request_id;')=0
    or(length(v_local)-length(replace(v_local,v_marker,'')))/length(v_marker)<>1
    or(length(v_local)-length(replace(v_local,v_end,'')))/length(v_end)<>1
    or strpos(v_local,'GROUP_IDENTITY_NEEDS_REVIEW')=0 then raise exception 'GROUP_COURSE_CREATE_SOURCE_DRIFT';end if;
  v_injected:=$injection$  if p_course is null or p_course not between 1 and 6 or p_study_level is null
    or p_study_level not in('bachelor','master','postgraduate') or p_request_idempotency is null
    or p_academic_year is null or p_academic_year is distinct from public.xelay_current_academic_year()::integer then
    raise exception 'GROUP_COURSE_INVALID_INPUT' using errcode='22023';end if;
  if v_request.cohort_start_year is not null and(v_request.cohort_start_year<>p_academic_year-p_course+1
    or v_request.study_level<>p_study_level) then raise exception 'GROUP_COURSE_APPROVAL_MISMATCH' using errcode='PT409';end if;
  -- Ephemeral requested group identity, never rewriting the approval snapshot.
  v_request.cohort_start_year:=p_academic_year-p_course+1;
  v_request.study_level:=p_study_level;
$injection$;
  v_local:=replace(v_local,v_marker,v_injected||v_marker);
  v_local:=replace(v_local,'if auth.uid() is null then raise exception ''Authentication required''; end if;',
    'if auth.uid() is null or not public.xelay_private_representative_account_active(auth.uid()) then raise exception ''GROUP_COURSE_AUTH_REQUIRED'' using errcode=''42501'';end if;');
  v_local:=replace(v_local,v_end,'  perform public.xelay_confirm_study_group_course(v_group_id,p_course,p_study_level,p_academic_year,p_request_idempotency);'||E'\n'||v_end);
  execute 'create function public.xelay_create_study_group_with_course(p_request_id uuid,p_course integer,p_study_level text,p_academic_year integer,p_request_idempotency uuid) returns uuid language plpgsql security definer set search_path=''''
    as '||quote_literal(v_local);
end $explicit_create$;
revoke all on function public.xelay_create_study_group_with_course(uuid,integer,text,integer,uuid) from public,anon,authenticated,service_role;
grant execute on function public.xelay_create_study_group_with_course(uuid,integer,text,integer,uuid) to authenticated;

-- Keep original directory visibility and every unrelated workspace key.
alter function public.xelay_teaching_workspace() rename to xelay_teaching_workspace_before_group_course_20261029;
revoke all on function public.xelay_teaching_workspace_before_group_course_20261029() from public,anon,authenticated,service_role;
create function public.xelay_teaching_workspace()
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare v_workspace jsonb;
begin
  perform public.xelay_teaching_assert_user();
  v_workspace:=public.xelay_teaching_workspace_before_group_course_20261029();
  return jsonb_set(v_workspace,'{groups}',coalesce((select jsonb_agg(e.value||jsonb_build_object(
    'university_slug',u.slug,'academic_unit_slug',a.slug,
    'identity_confirmed',public.xelay_private_study_group_course_confirmed(g.id),
    'identity_ready',public.xelay_private_study_group_course_ready(g.id),
    'identity_needs_confirmation',not public.xelay_private_study_group_course_confirmed(g.id)
      and(g.cohort_start_year is null or public.xelay_current_academic_year()::integer-g.cohort_start_year+1 between 1 and 6)) order by e.ordinality)
    from jsonb_array_elements(coalesce(v_workspace->'groups','[]'::jsonb)) with ordinality e(value,ordinality)
    join public.study_groups g on g.id=(e.value->>'id')::uuid
    left join public.universities u on u.id=g.university_id
    left join public.academic_units a on a.id=g.academic_unit_id and a.university_id=g.university_id),'[]'::jsonb));
end;
$$;
revoke all on function public.xelay_teaching_workspace() from public,anon,authenticated,service_role;
grant execute on function public.xelay_teaching_workspace() to authenticated;

-- Guard only NEW invitations. Existing accepted/pending links, materials,
-- student submissions and teacher access continue through the original code.
do $invite_guard$
declare v_oid oid:=to_regprocedure('public.xelay_teaching_mutate(text,jsonb)');v_source text;v_definition text;v_expected text;
  v_before jsonb;v_after jsonb;v_marker text;v_new text;
begin
  select to_jsonb(p)-'prosrc',p.prosrc,pg_get_functiondef(p.oid) into v_before,v_source,v_definition from pg_proc p where p.oid=v_oid;
  v_marker:='  if p_action is distinct from ''cancel_group_invite'' then';
  if(length(v_source)-length(replace(v_source,v_marker,'')))/length(v_marker)<>1
    or strpos(v_source,'xelay_teaching_mutate_before_group_requests_20261027')=0 then raise exception 'GROUP_COURSE_TEACHING_SOURCE_DRIFT';end if;
  v_new:=$guard$  if p_action in('invite_group','invite_teacher_from_group') then
    v_uid:=public.xelay_teaching_assert_user();
    if p_action='invite_group' then
      perform public.xelay_teaching_lock_course((p_payload->>'course_id')::uuid,'manage');
      if not exists(select 1 from public.study_groups g join public.teaching_courses c on c.id=(p_payload->>'course_id')::uuid
        where g.id=(p_payload->>'group_id')::uuid and g.university_id=c.university_id) then
        raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
    elsif not exists(select 1 from public.study_groups g where g.id=(p_payload->>'group_id')::uuid and g.representative_id=v_uid) then
      raise exception 'TEACHING_FORBIDDEN' using errcode='42501';end if;
    if not public.xelay_private_study_group_course_ready((p_payload->>'group_id')::uuid) then
      raise exception 'GROUP_COURSE_CONFIRMATION_REQUIRED' using errcode='22023';end if;
  end if;
$guard$||v_marker;
  if strpos(v_source,E'\r\n')>0 then v_new:=replace(v_new,E'\n',E'\r\n');end if;
  v_expected:=replace(v_source,v_marker,v_new);
  if strpos(v_definition,v_source)=0 then raise exception 'GROUP_COURSE_TEACHING_DEFINITION_DRIFT';end if;
  execute replace(v_definition,v_source,v_expected);
  select to_jsonb(p)-'prosrc' into v_after from pg_proc p where p.oid=v_oid;
  if v_before is distinct from v_after or(select prosrc from pg_proc where oid=v_oid)is distinct from v_expected then
    raise exception 'GROUP_COURSE_TEACHING_METADATA_DRIFT';end if;
end $invite_guard$;

notify pgrst,'reload schema';
commit;
