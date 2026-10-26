-- Recover distinct known-cohort creation beside an unresolved legacy group.
-- Consistent current academic evidence permits only a separate new group;
-- existing group identities, ownership, membership and content are never filled,
-- reassigned or copied. Ambiguous evidence still requires explicit review.
begin;
set local lock_timeout = '5s';
set local statement_timeout = '60s';

do $preflight$
begin
  if to_regclass('public.study_group_cohort_collision_resolutions') is null
    or to_regclass('public.study_group_members') is null
    or to_regclass('public.study_groups_academic_cohort_unique_idx') is null
    or to_regprocedure('public.xelay_create_study_group(uuid)') is null
    or to_regprocedure('public.xelay_private_profile_group_cohort(uuid,uuid,uuid,text)') is null then
    raise exception 'Apply study group cohort collision resolution 202610150012 first';
  end if;
end;
$preflight$;

-- Keep this RPC's owner, signature, EXECUTE grants and request-owner boundary.
create or replace function public.xelay_create_study_group(p_request_id uuid)
returns uuid language plpgsql security definer set search_path='' as $create_group$
declare
  v_request public.class_representative_requests%rowtype;
  v_existing public.study_groups%rowtype;
  v_group_id uuid;
  v_cohort integer;
  v_level text;
begin
  if auth.uid() is null then raise exception 'Authentication required'; end if;
  select * into v_request from public.class_representative_requests
    where id=p_request_id and user_id=auth.uid() and status='approved' for update;
  if not found then raise exception 'Approved class representative request not found'; end if;

  -- Preserve access through the original approved request, even if its legacy
  -- identity is unknown. Never claim another representative's legacy group.
  select id into v_group_id from public.study_groups where representative_request_id=p_request_id;
  if found then return v_group_id; end if;

  if v_request.cohort_start_year is null then
    select c.cohort_start_year,c.study_level into v_cohort,v_level
      from public.xelay_private_profile_group_cohort(
        v_request.user_id,v_request.university_id,v_request.academic_unit_id,v_request.specialty) c;
    if v_cohort is not null and v_level is not null then
      update public.class_representative_requests
        set cohort_start_year=v_cohort,study_level=v_level where id=p_request_id
        returning * into v_request;
    end if;
  end if;
  if v_request.cohort_start_year is null or v_request.study_level is null then
    raise exception 'GROUP_COHORT_REQUIRED' using errcode='P0001';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'xelay-study-group-identity:'||v_request.university_id::text||':'||v_request.academic_unit_id::text
      ||':'||lower(btrim(v_request.specialty))||':'||lower(btrim(v_request.group_name)),0));

  -- A known same-degree/cohort group always takes precedence over a legacy
  -- exception, including an existing explicit operator distinction.
  select * into v_existing from public.study_groups g
    where g.university_id=v_request.university_id and g.academic_unit_id=v_request.academic_unit_id
      and lower(btrim(g.specialty))=lower(btrim(v_request.specialty))
      and lower(btrim(g.group_name))=lower(btrim(v_request.group_name))
      and g.cohort_start_year=v_request.cohort_start_year and g.study_level=v_request.study_level;
  if found then
    if v_existing.representative_id=auth.uid() then return v_existing.id; end if;
    raise exception 'GROUP_ALREADY_EXISTS' using errcode='P0001';
  end if;

  -- Every unknown legacy collision must independently be distinguished.
  for v_existing in
    select g.* from public.study_groups g
    where g.university_id=v_request.university_id and g.academic_unit_id=v_request.academic_unit_id
      and lower(btrim(g.specialty))=lower(btrim(v_request.specialty))
      and lower(btrim(g.group_name))=lower(btrim(v_request.group_name))
      and (g.cohort_start_year is null or g.study_level is null)
    order by g.id for update
  loop
    -- Retain exact, independently reviewed exceptions. No automatic decision is
    -- recorded as an operator review or exposed through a new client endpoint.
    if exists(select 1 from public.study_group_cohort_collision_resolutions r
      where r.request_id=v_request.id and r.existing_group_id=v_existing.id
        and r.request_user_id=v_request.user_id
        and r.existing_representative_id=v_existing.representative_id
        and r.existing_representative_request_id=v_existing.representative_request_id
        and r.university_id=v_request.university_id and r.university_id=v_existing.university_id
        and r.academic_unit_id=v_request.academic_unit_id and r.academic_unit_id=v_existing.academic_unit_id
        and lower(btrim(r.specialty))=lower(btrim(v_request.specialty))
        and lower(btrim(r.specialty))=lower(btrim(v_existing.specialty))
        and lower(btrim(r.group_name))=lower(btrim(v_request.group_name))
        and lower(btrim(r.group_name))=lower(btrim(v_existing.group_name))
        and r.new_cohort_start_year=v_request.cohort_start_year and r.new_study_level=v_request.study_level
        and r.existing_cohort_start_year is not distinct from v_existing.cohort_start_year
        and r.existing_study_level is not distinct from v_existing.study_level) then
      continue;
    end if;

    -- FOR UPDATE on the group blocks new member INSERTs through their FK.
    -- Lock every existing membership, including pending/inactive rows, so a
    -- concurrent acceptance cannot add contradictory evidence mid-decision.
    perform m.id from public.study_group_members m
      where m.group_id=v_existing.id order by m.id for share;
    perform p.id from public.profiles p
      join (select v_existing.representative_id as user_id
        union select m.user_id from public.study_group_members m
          where m.group_id=v_existing.id and m.status='accepted') evidence on evidence.user_id=p.id
      order by p.id for share of p;

    -- The representative must supply a complete, matching, anchored academic
    -- identity. The anchor is stored academic year minus course, never today's
    -- year minus an unanchored course. Member majority cannot override it.
    select c.cohort_start_year,c.study_level into v_cohort,v_level
      from public.xelay_private_profile_group_cohort(
        v_existing.representative_id,v_existing.university_id,v_existing.academic_unit_id,v_existing.specialty) c;
    if v_cohort is null or v_level is null
      or exists(select 1 from public.profiles p
        where p.id=v_existing.representative_id and p.study_year_needs_review) then
      raise exception 'GROUP_IDENTITY_NEEDS_REVIEW' using errcode='P0001';
    end if;

    -- A previously captured approved-request snapshot is stronger evidence
    -- than a later profile edit; it must not be silently reinterpreted.
    perform r.id from public.class_representative_requests r
      where r.id=v_existing.representative_request_id for share;
    if not exists(select 1 from public.class_representative_requests r
      where r.id=v_existing.representative_request_id and r.user_id=v_existing.representative_id
        and r.status='approved' and r.university_id=v_existing.university_id
        and r.academic_unit_id=v_existing.academic_unit_id
        and lower(btrim(r.specialty))=lower(btrim(v_existing.specialty))
        and lower(btrim(r.group_name))=lower(btrim(v_existing.group_name))
        and (r.cohort_start_year is null
          or (r.cohort_start_year=v_cohort and r.study_level=v_level))) then
      raise exception 'GROUP_IDENTITY_NEEDS_REVIEW' using errcode='P0001';
    end if;

    -- Every known degree and every known anchored course of accepted members
    -- must agree. Partial profiles cannot conceal a contradictory known field.
    -- Members in a different/unknown academic scope make inference ambiguous.
    -- Pending, rejected and removed members do not supply academic evidence.
    if exists(select 1 from public.study_group_members m
      join public.profiles p on p.id=m.user_id
      where m.group_id=v_existing.id and m.status='accepted' and (
        p.university_id is distinct from v_existing.university_id
        or p.academic_unit_id is distinct from v_existing.academic_unit_id
        or lower(btrim(coalesce(p.specialty,'')))<>lower(btrim(v_existing.specialty))
        or p.study_year_needs_review
        or (p.experience in('bachelor','master','postgraduate') and p.experience::text<>v_level)
        or (p.study_year between 1 and 6
          and p.study_year_academic_year::integer-p.study_year::integer+1 between 1900 and 2200
          and p.study_year_academic_year::integer-p.study_year::integer+1<>v_cohort))) then
      raise exception 'GROUP_IDENTITY_NEEDS_REVIEW' using errcode='P0001';
    end if;

    if v_cohort=v_request.cohort_start_year and v_level=v_request.study_level then
      raise exception 'GROUP_ALREADY_EXISTS' using errcode='P0001';
    end if;
  end loop;

  insert into public.study_groups(
    representative_request_id,representative_id,university_id,academic_unit_id,specialty,group_name,
    cohort_start_year,study_level)
  values(v_request.id,auth.uid(),v_request.university_id,v_request.academic_unit_id,
    v_request.specialty,v_request.group_name,v_request.cohort_start_year,v_request.study_level)
  returning id into v_group_id;
  insert into public.study_group_members(group_id,user_id,invited_by,status,accepted_at)
    values(v_group_id,auth.uid(),auth.uid(),'accepted',now());
  return v_group_id;
end;
$create_group$;

notify pgrst,'reload schema';
commit;
